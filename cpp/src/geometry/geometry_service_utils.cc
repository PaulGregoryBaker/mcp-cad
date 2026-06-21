#include "geometry_service_utils.hpp"

#include <Standard_Failure.hxx>

#include <BRep_Tool.hxx>
#include <BRepTools.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopExp_Explorer.hxx>

#include <Geom_Surface.hxx>
#include <Geom_Plane.hxx>

#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <random>
#include <set>
#include <sstream>

namespace mcp_cad {

// ─── ID / time helpers ────────────────────────────────────────────────────────

std::string generateUUID() {
  static std::random_device rd;
  static std::mt19937_64 gen(rd());
  static std::uniform_int_distribution<uint64_t> dist;

  uint64_t hi = dist(gen);
  uint64_t lo = dist(gen);

  // Set version (4) and variant bits
  hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
  lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;

  std::ostringstream oss;
  oss << std::hex << std::setfill('0')
      << std::setw(8)  << (hi >> 32) << "-"
      << std::setw(4)  << ((hi >> 16) & 0xFFFF) << "-"
      << std::setw(4)  << (hi & 0xFFFF) << "-"
      << std::setw(4)  << (lo >> 48) << "-"
      << std::setw(12) << (lo & 0x0000FFFFFFFFFFFFULL);
  return oss.str();
}

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string shapeId(const TopoDS_Shape& shape) {
  return std::to_string(std::hash<TopoDS_Shape>{}(shape));
}

// ─── Face geometry helpers ────────────────────────────────────────────────────

gp_Vec faceOutwardNormal(const TopoDS_Face& f) {
  Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
  if (surf.IsNull()) return gp_Vec(0, 0, 1);
  Standard_Real u1, u2, v1, v2;
  BRepTools::UVBounds(f, u1, u2, v1, v2);
  gp_Pnt p; gp_Vec du, dv;
  surf->D1((u1 + u2) * 0.5, (v1 + v2) * 0.5, p, du, dv);
  gp_Vec n = du.Crossed(dv);
  if (n.Magnitude() > 1e-10) n.Normalize();
  if (f.Orientation() == TopAbs_REVERSED) n.Reverse();
  return n;
}

gp_Pnt faceCenter(const TopoDS_Face& f) {
  GProp_GProps fp;
  BRepGProp::SurfaceProperties(f, fp);
  return fp.CentreOfMass();
}

double minLocalDimension(const TopoDS_Face& f) {
  Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
  if (surf.IsNull() || !surf->IsKind(STANDARD_TYPE(Geom_Plane))) return 0.0;
  Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(surf);
  gp_Pln pln = plane->Pln();
  gp_Ax3 pos = pln.Position();
  gp_Dir dirX = pos.XDirection();
  gp_Dir dirY = pos.YDirection();

  double uMin = 1e30, uMax = -1e30;
  double vMin = 1e30, vMax = -1e30;
  bool any = false;
  for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
    gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
    gp_Vec vec(pos.Location(), p);
    double u = vec.Dot(gp_Vec(dirX));
    double v = vec.Dot(gp_Vec(dirY));
    uMin = std::min(uMin, u); uMax = std::max(uMax, u);
    vMin = std::min(vMin, v); vMax = std::max(vMax, v);
    any = true;
  }
  if (!any) return 0.0;
  return std::min(uMax - uMin, vMax - vMin);
}

// ─── GeometryState ────────────────────────────────────────────────────────────

SnapshotId GeometryState::createSnapshot(const std::string& label) {
  GeometrySnapshot snap;
  snap.snapshotId     = generateUUID();
  snap.operationLabel = label;
  snap.timestampMs    = nowMs();

  for (const auto& kv : solids)  snap.solidIds.push_back(kv.first);
  for (const auto& kv : shells)  snap.shellIds.push_back(kv.first);
  for (const auto& kv : unfolds) snap.unfoldIds.push_back(kv.first);

  snapshots[snap.snapshotId]          = snap;
  snapshotSolids[snap.snapshotId]     = solids;
  snapshotShells[snap.snapshotId]     = shells;
  snapshotUnfolds[snap.snapshotId]    = unfolds;
  snapshotAssemblies[snap.snapshotId] = assemblies;
  return snap.snapshotId;
}

// ─── Graph helpers ─────────────────────────────────────────────────────────────

bool detectCycleDFS(int u, int p, const std::vector<std::vector<int>>& adj, std::vector<bool>& visited) {
  visited[u] = true;
  for (int v : adj[u]) {
    if (!visited[v]) {
      if (detectCycleDFS(v, u, adj, visited)) return true;
    } else if (v != p) {
      return true;
    }
  }
  return false;
}

// ─── Session state lookups (caller must hold state.mutex) ────────────────────

TopoDS_Shape lookupEntityIn(const GeometryState& state, const std::string& entityId) {
  auto solidIt = state.solids.find(entityId);
  if (solidIt != state.solids.end()) {
    return solidIt->second.shape;
  }
  auto shellIt = state.shells.find(entityId);
  if (shellIt != state.shells.end()) {
    return shellIt->second.shape;
  }
  for (const auto& kv : state.solids) {
    TopExp_Explorer faceExp(kv.second.shape, TopAbs_FACE);
    for (; faceExp.More(); faceExp.Next()) {
      const TopoDS_Shape& s = faceExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer edgeExp(kv.second.shape, TopAbs_EDGE);
    for (; edgeExp.More(); edgeExp.Next()) {
      const TopoDS_Shape& s = edgeExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer vertexExp(kv.second.shape, TopAbs_VERTEX);
    for (; vertexExp.More(); vertexExp.Next()) {
      const TopoDS_Shape& s = vertexExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer shellExp(kv.second.shape, TopAbs_SHELL);
    for (; shellExp.More(); shellExp.Next()) {
      const TopoDS_Shape& s = shellExp.Current();
      if (shapeId(s) == entityId) return s;
    }
  }
  for (const auto& kv : state.shells) {
    TopExp_Explorer faceExp(kv.second.shape, TopAbs_FACE);
    for (; faceExp.More(); faceExp.Next()) {
      const TopoDS_Shape& s = faceExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer edgeExp(kv.second.shape, TopAbs_EDGE);
    for (; edgeExp.More(); edgeExp.Next()) {
      const TopoDS_Shape& s = edgeExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer vertexExp(kv.second.shape, TopAbs_VERTEX);
    for (; vertexExp.More(); vertexExp.Next()) {
      const TopoDS_Shape& s = vertexExp.Current();
      if (shapeId(s) == entityId) return s;
    }
    TopExp_Explorer shellExp(kv.second.shape, TopAbs_SHELL);
    for (; shellExp.More(); shellExp.Next()) {
      const TopoDS_Shape& s = shellExp.Current();
      if (shapeId(s) == entityId) return s;
    }
  }
  throw GeometryError("GE_SOLID_NOT_FOUND", "Entity not found in session: " + entityId, false, "");
}

ShellId findParentShellIdIn(const GeometryState& state, const std::string& subShapeId) {
  for (const auto& kv : state.shells) {
    if (kv.first == subShapeId) return kv.first;
    TopExp_Explorer exp(kv.second.shape, TopAbs_FACE);
    for (; exp.More(); exp.Next()) {
      if (shapeId(exp.Current()) == subShapeId) return kv.first;
    }
    TopExp_Explorer expEdge(kv.second.shape, TopAbs_EDGE);
    for (; expEdge.More(); expEdge.Next()) {
      if (shapeId(expEdge.Current()) == subShapeId) return kv.first;
    }
  }
  for (const auto& kv : state.solids) {
    if (kv.first == subShapeId) return kv.first;
    TopExp_Explorer exp(kv.second.shape, TopAbs_FACE);
    for (; exp.More(); exp.Next()) {
      if (shapeId(exp.Current()) == subShapeId) return kv.first;
    }
    TopExp_Explorer expEdge(kv.second.shape, TopAbs_EDGE);
    for (; expEdge.More(); expEdge.Next()) {
      if (shapeId(expEdge.Current()) == subShapeId) return kv.first;
    }
  }
  throw GeometryError("GE_SOLID_NOT_FOUND", "Parent shell/solid containing face/edge not found: " + subShapeId, false, "");
}

ResolvedShape resolveShellOrSolidIn(const GeometryState& state, const std::string& id,
                                     const std::string& notFoundMessage) {
  ResolvedShape resolved;
  auto shellIt = state.shells.find(id);
  auto solidIt = state.solids.find(id);
  if (shellIt != state.shells.end()) {
    resolved.shape = shellIt->second.shape;
  } else if (solidIt != state.solids.end()) {
    resolved.shape = solidIt->second.shape;
    resolved.isSolid = true;
  } else {
    throw GeometryError("GE_SHELL_NOT_FOUND", notFoundMessage, false, "");
  }
  return resolved;
}

// ─── Sheet metal validation ────────────────────────────────────────────────────

SheetMetalValidationResult validateSheetMetalShape(const TopoDS_Shape& shape) {
  SheetMetalValidationResult result;
  result.isValid = false;
  result.canFlatten = false;

  // Helper: check if two faces share an edge
  auto facesShareEdge = [](const TopoDS_Face& f1, const TopoDS_Face& f2) -> bool {
    TopExp_Explorer e1(f1, TopAbs_EDGE);
    for (; e1.More(); e1.Next()) {
      const TopoDS_Edge& edge1 = TopoDS::Edge(e1.Current());
      TopExp_Explorer e2(f2, TopAbs_EDGE);
      for (; e2.More(); e2.Next()) {
        if (edge1.IsSame(e2.Current())) {
          return true;
        }
      }
    }
    return false;
  };

  try {
    // 0. Disconnected-body check: a valid panel is one connected solid/shell.
    //    Multiple disconnected components are caught here before any face matching.
    {
      int solidCount = 0;
      for (TopExp_Explorer ex(shape, TopAbs_SOLID); ex.More(); ex.Next()) solidCount++;
      int shellCount = 0;
      for (TopExp_Explorer ex(shape, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) shellCount++;
      int components = solidCount > 0 ? solidCount : shellCount;
      if (components > 1) {
        result.validationErrors.push_back(
          "GE_PANEL_DISCONNECTED: Shape contains " + std::to_string(components) +
          " disconnected bodies. A valid panel must be a single connected solid.");
        return result;
      }
    }

    // 1. Gather all faces and compute total surface area
    double totalArea = 0.0;
    std::vector<std::pair<TopoDS_Face, double>> planarFacesWithArea;
    double maxPlanarArea = 0.0;

    TopExp_Explorer faceExp(shape, TopAbs_FACE);
    int totalFaceCount = 0;
    for (; faceExp.More(); faceExp.Next()) {
      totalFaceCount++;
      const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(face, fp);
      double area = fp.Mass();
      totalArea += area;

      Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
      if (!surf.IsNull() && surf->IsKind(STANDARD_TYPE(Geom_Plane))) {
        planarFacesWithArea.push_back({face, area});
        if (area > maxPlanarArea) maxPlanarArea = area;
      }
    }

    if (totalFaceCount == 0 || planarFacesWithArea.empty()) {
      result.validationErrors.push_back("GE_PANEL_NO_FLAT_FACES: Shape has no planar faces — cannot be a sheet metal panel.");
      return result;
    }

    // 2. Classify plane equation parameters for planar faces
    struct PlaneFaceInfo {
      TopoDS_Face face;
      double area;
      gp_Pnt center;
      gp_Vec normal;
      double D;
      bool matched = false;
      int partnerIdx = -1;
    };

    std::vector<PlaneFaceInfo> planeInfos;
    for (const auto& pair : planarFacesWithArea) {
      PlaneFaceInfo info;
      info.face = pair.first;
      info.area = pair.second;
      info.center = faceCenter(info.face);
      info.normal = faceOutwardNormal(info.face);
      info.D = info.normal.Dot(gp_Vec(info.center.X(), info.center.Y(), info.center.Z()));
      planeInfos.push_back(info);
    }

    // Merge coplanar face infos to handle split segments robustly
    std::vector<PlaneFaceInfo> mergedPlaneInfos;
    for (const auto& info : planeInfos) {
      bool found = false;
      for (auto& mInfo : mergedPlaneInfos) {
        if (info.normal.Dot(mInfo.normal) > 0.95) {
          double dist = std::abs(gp_Vec(info.center, mInfo.center).Dot(info.normal));
          if (dist < 0.1) {
            double oldArea = mInfo.area;
            mInfo.area += info.area;
            mInfo.center = gp_Pnt(
                (mInfo.center.XYZ() * oldArea + info.center.XYZ() * info.area) / mInfo.area
            );
            found = true;
            break;
          }
        }
      }
      if (!found) {
        mergedPlaneInfos.push_back(info);
      }
    }
    planeInfos = std::move(mergedPlaneInfos);

    // Sort planeInfos in descending order of area to ensure large skins are matched first
    std::sort(planeInfos.begin(), planeInfos.end(), [](const PlaneFaceInfo& a, const PlaneFaceInfo& b) {
      return a.area > b.area;
    });

    // 3. Perform pairwise face matching to identify thin-sheet skins
    int N = static_cast<int>(planeInfos.size());
    double areaWeightedThicknessSum = 0.0;
    double matchedAreaSum = 0.0;

    for (int i = 0; i < N; ++i) {
      if (planeInfos[i].matched) continue;

      int bestPartner = -1;
      double bestDist = 0.0;
      double maxScore = -1.0;

      for (int j = 0; j < N; ++j) {
        if (i == j || planeInfos[j].matched) continue;

        // Check if normals are opposite (anti-parallel)
        double dot = planeInfos[i].normal.Dot(planeInfos[j].normal);
        if (dot < -0.95) {
          // Perpendicular thickness distance
          gp_Vec diff(planeInfos[i].center, planeInfos[j].center);
          double dist = std::abs(diff.Dot(planeInfos[i].normal));

          if (dist >= 0.5 && dist <= 6.0) {
            // Overlap projection check: centers projected onto the plane should be close
            gp_Vec proj = diff - planeInfos[i].normal * diff.Dot(planeInfos[i].normal);
            double projDist = proj.Magnitude();

            double overlapThreshold = 2.0 * std::sqrt(planeInfos[i].area + planeInfos[j].area);
            if (projDist < overlapThreshold) {
              double score = planeInfos[j].area / (1.0 + projDist);
              if (score > maxScore) {
                maxScore = score;
                bestPartner = j;
                bestDist = dist;
              }
            }
          }
        }
      }

      if (bestPartner != -1) {
        planeInfos[i].matched = true;
        planeInfos[i].partnerIdx = bestPartner;
        planeInfos[bestPartner].matched = true;
        planeInfos[bestPartner].partnerIdx = i;

        double combinedArea = planeInfos[i].area + planeInfos[bestPartner].area;
        areaWeightedThicknessSum += combinedArea * bestDist;
        matchedAreaSum += combinedArea;
      }
    }

    // If no matched panels, it's not a thin-sheet metal part
    if (matchedAreaSum < 1e-5) {
      result.validationErrors.push_back("No matching parallel thin-sheet face pairs found.");
      return result;
    }

    double nominalThickness = areaWeightedThicknessSum / matchedAreaSum;
    result.nominalThickness = nominalThickness;

    // 4. Validate thickness uniformity and overall surface area ratio
    double matchedRatio = matchedAreaSum / totalArea;
    if (matchedRatio < 0.70) { // Enforce 70% limit for complex boundaries
      std::cout << "[DEBUG VALIDATION] matchedRatio=" << matchedRatio
                << " (matchedAreaSum=" << matchedAreaSum
                << ", totalArea=" << totalArea << ")" << std::endl;
      std::cout << "  Plane infos count N=" << N << std::endl;
      for (int i = 0; i < N; ++i) {
        std::cout << "    Face " << i
                  << ": area=" << planeInfos[i].area
                  << ", center=(" << planeInfos[i].center.X() << "," << planeInfos[i].center.Y() << "," << planeInfos[i].center.Z() << ")"
                  << ", normal=(" << planeInfos[i].normal.X() << "," << planeInfos[i].normal.Y() << "," << planeInfos[i].normal.Z() << ")"
                  << ", matched=" << (planeInfos[i].matched ? "true" : "false")
                  << ", partnerIdx=" << planeInfos[i].partnerIdx << std::endl;
      }
      result.validationErrors.push_back("GE_PANEL_NOT_SHEET_METAL: Bulky or non-sheet-metal geometry — area ratio of parallel skins is below limit.");
      return result;
    }

    // Check thickness uniformity for each matched pair
    for (int i = 0; i < N; ++i) {
      if (planeInfos[i].matched && planeInfos[i].partnerIdx > i) {
        int j = planeInfos[i].partnerIdx;
        gp_Vec diff(planeInfos[i].center, planeInfos[j].center);
        double dist = std::abs(diff.Dot(planeInfos[i].normal));
        double dev = std::abs(dist - nominalThickness) / nominalThickness;
        if (dev > 0.15) { // 15% tolerance
          result.validationErrors.push_back("GE_PANEL_NON_UNIFORM_THICKNESS: Wall thickness varies from nominal by more than 15%.");
          return result;
        }
      }
    }

    // 5. Construct Face-Bend Panel Connectivity Graph and check for cycles/T-junctions
    struct Panel {
      int idxA;
      int idxB;
      std::vector<int> neighbors;
    };

    std::vector<Panel> panels;
    for (int i = 0; i < N; ++i) {
      if (planeInfos[i].matched && planeInfos[i].partnerIdx > i) {
        // Skip narrow thickness faces
        double minDim = minLocalDimension(planeInfos[i].face);
        if (minDim < 2.5 * nominalThickness) {
          continue;
        }
        // Skip extremely small matched face pairs that are actually thickness boundary faces
        // rather than real unfolding panel sheets (e.g. area < 5.0 * t * t)
        double faceArea = planeInfos[i].area;
        if (faceArea < 5.0 * nominalThickness * nominalThickness) {
          continue;
        }
        Panel p;
        p.idxA = i;
        p.idxB = planeInfos[i].partnerIdx;
        panels.push_back(p);
      }
    }

    int P = static_cast<int>(panels.size());

    // Helper to check if two panels share a curved face or an edge
    auto arePanelsConnected = [&](int p1, int p2) -> bool {
      // Check direct edge sharing (sharp joint)
      if (facesShareEdge(planeInfos[panels[p1].idxA].face, planeInfos[panels[p2].idxA].face) ||
          facesShareEdge(planeInfos[panels[p1].idxA].face, planeInfos[panels[p2].idxB].face) ||
          facesShareEdge(planeInfos[panels[p1].idxB].face, planeInfos[panels[p2].idxA].face) ||
          facesShareEdge(planeInfos[panels[p1].idxB].face, planeInfos[panels[p2].idxB].face)) {
        return true;
      }

      // Check connection via curved/cylindrical faces in the solid
      TopExp_Explorer faceExpAll(shape, TopAbs_FACE);
      for (; faceExpAll.More(); faceExpAll.Next()) {
        const TopoDS_Face& fCur = TopoDS::Face(faceExpAll.Current());
        Handle(Geom_Surface) surf = BRep_Tool::Surface(fCur);
        if (surf.IsNull() || surf->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

        // If curved face shares edge with p1 and p2
        bool connectsP1 = false;
        bool connectsP2 = false;
        TopExp_Explorer eCur(fCur, TopAbs_EDGE);
        for (; eCur.More(); eCur.Next()) {
          const TopoDS_Edge& edge = TopoDS::Edge(eCur.Current());
          // Does it share with P1
          TopExp_Explorer eP1A(planeInfos[panels[p1].idxA].face, TopAbs_EDGE);
          for (; eP1A.More(); eP1A.Next()) {
            if (edge.IsSame(eP1A.Current())) connectsP1 = true;
          }
          TopExp_Explorer eP1B(planeInfos[panels[p1].idxB].face, TopAbs_EDGE);
          for (; eP1B.More(); eP1B.Next()) {
            if (edge.IsSame(eP1B.Current())) connectsP1 = true;
          }
          // Does it share with P2
          TopExp_Explorer eP2A(planeInfos[panels[p2].idxA].face, TopAbs_EDGE);
          for (; eP2A.More(); eP2A.Next()) {
            if (edge.IsSame(eP2A.Current())) connectsP2 = true;
          }
          TopExp_Explorer eP2B(planeInfos[panels[p2].idxB].face, TopAbs_EDGE);
          for (; eP2B.More(); eP2B.Next()) {
            if (edge.IsSame(eP2B.Current())) connectsP2 = true;
          }
        }

        if (connectsP1 && connectsP2) return true;
      }

      return false;
    };

    // Populate adjacency
    for (int i = 0; i < P; ++i) {
      for (int j = i + 1; j < P; ++j) {
        if (arePanelsConnected(i, j)) {
          panels[i].neighbors.push_back(j);
          panels[j].neighbors.push_back(i);
        }
      }
    }

    // Check for T-junctions:
    // A joint/bend connections check: if any curved bend face connects 3 or more panels
    TopExp_Explorer faceExpCylinder(shape, TopAbs_FACE);
    for (; faceExpCylinder.More(); faceExpCylinder.Next()) {
      const TopoDS_Face& fCur = TopoDS::Face(faceExpCylinder.Current());
      Handle(Geom_Surface) surf = BRep_Tool::Surface(fCur);
      if (surf.IsNull() || surf->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

      std::set<int> connectedPanels;
      TopExp_Explorer eCur(fCur, TopAbs_EDGE);
      for (; eCur.More(); eCur.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(eCur.Current());
        for (int p = 0; p < P; ++p) {
          TopExp_Explorer eP_A(planeInfos[panels[p].idxA].face, TopAbs_EDGE);
          for (; eP_A.More(); eP_A.Next()) {
            if (edge.IsSame(eP_A.Current())) connectedPanels.insert(p);
          }
          TopExp_Explorer eP_B(planeInfos[panels[p].idxB].face, TopAbs_EDGE);
          for (; eP_B.More(); eP_B.Next()) {
            if (edge.IsSame(eP_B.Current())) connectedPanels.insert(p);
          }
        }
      }
      if (connectedPanels.size() >= 3) {
        result.validationErrors.push_back("GE_UNFOLD_T_JUNCTION: Un-unfoldable T-junction joint detected.");
        return result;
      }
    }

    // Check sharp edges T-junctions
    TopExp_Explorer edgeExpAll(shape, TopAbs_EDGE);
    for (; edgeExpAll.More(); edgeExpAll.Next()) {
      const TopoDS_Edge& edge = TopoDS::Edge(edgeExpAll.Current());
      std::set<int> connectedPanels;
      for (int p = 0; p < P; ++p) {
        TopExp_Explorer eP_A(planeInfos[panels[p].idxA].face, TopAbs_EDGE);
        for (; eP_A.More(); eP_A.Next()) {
          if (edge.IsSame(eP_A.Current())) connectedPanels.insert(p);
        }
        TopExp_Explorer eP_B(planeInfos[panels[p].idxB].face, TopAbs_EDGE);
        for (; eP_B.More(); eP_B.Next()) {
          if (edge.IsSame(eP_B.Current())) connectedPanels.insert(p);
        }
      }
      if (connectedPanels.size() >= 3) {
        result.validationErrors.push_back("GE_UNFOLD_T_JUNCTION: Un-unfoldable T-junction sharp edge joint detected.");
        return result;
      }
    }

    // Check for cycles using DFS cycle detection
    std::vector<bool> visited(P, false);
    std::vector<std::vector<int>> adjList(P);
    for (int i = 0; i < P; ++i) adjList[i] = panels[i].neighbors;

    for (int i = 0; i < P; ++i) {
      if (!visited[i]) {
        if (detectCycleDFS(i, -1, adjList, visited)) {
          result.validationErrors.push_back("GE_UNFOLD_CYCLE_DETECTED: A cyclical bend loop was detected.");
          return result;
        }
      }
    }

    result.isValid = true;
    result.canFlatten = true;

  } catch (const Standard_Failure& e) {
    result.validationErrors.push_back("OCCT validation exception: " + std::string(e.GetMessageString()));
  }

  return result;
}

// Dominant Face Method: the panel's thickness is the perpendicular distance
// between its single largest planar face and that face's closest anti-
// parallel, overlapping partner. Unlike validateSheetMetalShape's area-
// weighted average across EVERY matched face pair in the shape, this looks at
// exactly one pair — the dominant skin — so it can't be pulled off by a
// secondary match (e.g. a small sliver face left behind where a panel was
// split from a neighbor at a bend, which legitimately has its own much
// smaller anti-parallel pair). No assumption is made about the panel's
// orientation: the search is done in the dominant face's own normal
// direction, so a rotated part measures identically to an axis-aligned one.
//
// Scoped to a SINGLE, ISOLATED panel/protrusion shell (i.e. call this after
// splitting a part into its individual panels, not on the whole multi-panel
// assembly beforehand). The overlap check alone cannot distinguish "this
// face's own other skin" from "an unrelated internal structure that happens
// to sit directly behind it at a different depth" — e.g. a recessed internal
// plate a few mm beneath an outer wall, in an assembly with several
// panels — both are anti-parallel and equally well-overlapping, just at
// different distances. That ambiguity only disappears once each panel is its
// own isolated shell with nothing else nearby to confuse the match.
PanelThicknessResult measurePanelThickness(const TopoDS_Shape& shape) {
  PanelThicknessResult result;

  struct PlaneFaceInfo {
    TopoDS_Face face;
    double      area;
    gp_Pnt      center;
    gp_Vec      normal;
  };

  std::vector<PlaneFaceInfo> planeInfos;
  for (TopExp_Explorer faceExp(shape, TopAbs_FACE); faceExp.More(); faceExp.Next()) {
    const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
    Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
    if (surf.IsNull() || !surf->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

    GProp_GProps fp;
    BRepGProp::SurfaceProperties(face, fp);

    PlaneFaceInfo info;
    info.face   = face;
    info.area   = fp.Mass();
    info.center = faceCenter(face);
    info.normal = faceOutwardNormal(face);
    planeInfos.push_back(info);
  }

  if (planeInfos.empty()) {
    result.errorCode = "GE_PANEL_NO_FLAT_FACES";
    result.message   = "Shape has no planar faces.";
    return result;
  }

  // The dominant face anchors the search — found by largest area, not by
  // insertion order, so face-enumeration order from OCCT can't matter.
  size_t dominantIdx = 0;
  for (size_t i = 1; i < planeInfos.size(); ++i) {
    if (planeInfos[i].area > planeInfos[dominantIdx].area) dominantIdx = i;
  }
  const PlaneFaceInfo& dominant = planeInfos[dominantIdx];

  // Among anti-parallel, overlapping candidates, the TRUE thickness partner
  // is always the CLOSEST one — not the largest-area one. This matters for a
  // multi-wall assembly (e.g. a hollow box measured before being split into
  // its individual panels): the box's FAR, opposite wall is also anti-
  // parallel to the dominant face and can have a near-identical 2D footprint
  // (a box's +X and -X walls share the same Y/Z extent), so an area-based
  // score alone can't tell "this wall's own other skin" apart from "the far
  // side of the box". Thickness is by definition the smallest such gap.
  int    bestPartner = -1;
  double bestDist    = std::numeric_limits<double>::max();
  for (size_t j = 0; j < planeInfos.size(); ++j) {
    if (j == dominantIdx) continue;

    double dot = dominant.normal.Dot(planeInfos[j].normal);
    if (dot >= -0.95) continue;  // not anti-parallel to the dominant face

    gp_Vec diff(dominant.center, planeInfos[j].center);
    double dist = std::abs(diff.Dot(dominant.normal));
    if (dist < 1e-6) continue;  // degenerate/coincident

    // Overlap check: the candidate's center, projected onto the dominant
    // face's plane, must land close to the dominant face's own footprint —
    // otherwise it's some unrelated anti-parallel face elsewhere on the part.
    gp_Vec proj = diff - dominant.normal * diff.Dot(dominant.normal);
    double projDist = proj.Magnitude();
    double overlapThreshold = 2.0 * std::sqrt(dominant.area + planeInfos[j].area);
    if (projDist >= overlapThreshold) continue;

    // Area check: the TRUE other side of the dominant face's own main skin
    // has comparable area to the dominant face itself (it's the same panel,
    // viewed from the other side). A small local notch or recess — e.g. left
    // behind where an attached feature (a flange) was split away from this
    // panel — can be anti-parallel, well-overlapping, AND closer than the
    // panel's real thickness, but its area is a small fraction of the
    // dominant face's. Without this, "closest wins" picks that notch instead
    // of the real thickness.
    if (planeInfos[j].area < 0.5 * dominant.area) continue;

    if (dist < bestDist) {
      bestDist    = dist;
      bestPartner = static_cast<int>(j);
    }
  }

  if (bestPartner == -1) {
    result.errorCode = "GE_PANEL_NO_PARALLEL_PAIR";
    result.message   = "No anti-parallel partner face found for the dominant face.";
    return result;
  }

  const double dominantOffset = gp_Vec(dominant.center.XYZ()).Dot(dominant.normal);
  const double partnerOffset  = gp_Vec(planeInfos[bestPartner].center.XYZ()).Dot(dominant.normal);

  result.ok               = true;
  result.thicknessMm      = bestDist;
  result.midplaneOffsetMm = (dominantOffset + partnerOffset) / 2.0;
  result.dominantNormalX  = dominant.normal.X();
  result.dominantNormalY  = dominant.normal.Y();
  result.dominantNormalZ  = dominant.normal.Z();
  return result;
}

}  // namespace mcp_cad
