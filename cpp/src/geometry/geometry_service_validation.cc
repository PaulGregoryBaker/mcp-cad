// ─── OCCT includes (isolated to this translation unit) ───────────────────────
#include <Standard_Failure.hxx>
#include <Standard_ErrorHandler.hxx>

#include <STEPControl_Reader.hxx>
#include <Interface_Static.hxx>
#include <IFSelect_ReturnStatus.hxx>

#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <BRepTools.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepAdaptor_Surface.hxx>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Wire.hxx>

#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ShapeMapHasher.hxx>

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>

#include <Bnd_Box.hxx>
#include <Bnd_OBB.hxx>
#include <BRepBndLib.hxx>

#include <BRepMesh_IncrementalMesh.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>

#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Sewing.hxx>

#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Edge.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Wire.hxx>

#include <Geom_Surface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <Geom_BSplineSurface.hxx>

#include <Geom_Curve.hxx>
#include <Geom_Line.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_BSplineCurve.hxx>

#include <GProp_GProps.hxx>
#include <BRepGProp.hxx>

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <IntAna_QuadQuadGeo.hxx>
#include <IntAna_ResultType.hxx>
#include <Precision.hxx>
#include <gp_Circ.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <BRepOffset_Mode.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_AsciiString.hxx>

#include <BRepBuilderAPI_Transform.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Location.hxx>
#include <TDF_Label.hxx>
#include <gp_Quaternion.hxx>
#include <BinXCAFDrivers.hxx>

#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>

#include "geometry_service_impl.hpp"

#include <map>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <mutex>
#include <sstream>
#include <cmath>
#include <chrono>
#include <random>
#include <algorithm>
#include <array>
#include <set>
#include <iomanip>
#include <functional>
#include <limits>
#include <cstring>

namespace mcp_cad {

static std::string generateUUID() {
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

static long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

static std::string shapeId(const TopoDS_Shape& shape) {
  return std::to_string(std::hash<TopoDS_Shape>{}(shape));
}

// Returns outward-pointing normal of a face at its UV centre.
static gp_Vec faceOutwardNormal(const TopoDS_Face& f) {
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

static bool detectCycleDFS(int u, int p, const std::vector<std::vector<int>>& adj, std::vector<bool>& visited) {
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

class GeometryValidation {
public:
  explicit GeometryValidation(GeometryState& s) : s_(s) {}

  ManifoldResult checkManifold(const SolidId& solidId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.solids.find(solidId);
    if (it == s_.solids.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid not found: " + solidId, false, "");
    }

    try {
      BRepCheck_Analyzer analyzer(it->second.shape);
      ManifoldResult result;
      result.isManifold = analyzer.IsValid();

      if (!result.isManifold) {
        // Collect non-manifold issues from face check
        TopExp_Explorer faceExp(it->second.shape, TopAbs_FACE);
        for (; faceExp.More(); faceExp.Next()) {
          const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
          auto faceCheck = analyzer.Result(face);
          if (!faceCheck.IsNull() && faceCheck->Status().Extent() > 0) {
            ManifoldIssue issue;
            issue.type        = ManifoldIssue::Type::DEGENERATE_FACE;
            issue.faceId      = shapeId(face);
            issue.description = "Face check failed";
            result.issues.push_back(issue);
          }
        }
      }

      return result;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_MANIFOLD_CHECK_FAILED",
                          std::string("Manifold check exception: ") + e.GetMessageString(),
                          true, "clean_geometry");
    }
  }

  SolidId healGeometry(const SolidId& solidId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.solids.find(solidId);
    if (it == s_.solids.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid not found: " + solidId, false, "");
    }

    try {
      Handle(ShapeFix_Shape) fixer = new ShapeFix_Shape(it->second.shape);
      fixer->SetPrecision(0.01);
      fixer->SetMinTolerance(0.001);
      fixer->SetMaxTolerance(1.0);
      fixer->Perform();

      TopoDS_Shape healed = fixer->Shape();
      if (healed.IsNull()) {
        throw GeometryError("GE_HEAL_FAILED",
                            "Healing produced null shape for solid: " + solidId,
                            false, "");
      }

      SolidId newId = generateUUID();
      s_.solids[newId] = SolidState{newId, healed};
      return newId;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_HEAL_FAILED",
                          std::string("Healing exception: ") + e.GetMessageString(),
                          false, "");
    }
  }

  SheetMetalValidationResult validateSheetMetal(const ShellId& partId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    return validateSheetMetalLocked(partId);
  }

  CurvedRebuildResult reconstructCurvedBends(const ShellId& partId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    if (auto sit = s_.shells.find(partId); sit != s_.shells.end()) {
      originalShape = sit->second.shape;
    } else if (auto itS = s_.solids.find(partId); itS != s_.solids.end()) {
      originalShape = itS->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Shell or solid not found: " + partId, false, "");
    }

    // Validate that it's sheet metal first
    SheetMetalValidationResult val = validateSheetMetalLocked(partId);
    if (!val.isValid) {
      throw GeometryError("GE_INVALID_SHEET_METAL", "Cannot reconstruct curved bends: Invalid sheet metal geometry.", false, "");
    }

    double t = val.nominalThickness;

    SnapshotId token = createSnapshotLocked("before reconstructCurvedBends on " + partId);

    try {
      // Helper: calculate edge midpoint
      auto edgeMidpoint = [](const TopoDS_Edge& edge) -> gp_Pnt {
        Standard_Real f, l;
        Handle(Geom_Curve) c = BRep_Tool::Curve(edge, f, l);
        if (!c.IsNull()) {
          return c->Value((f + l) * 0.5);
        }
        TopExp_Explorer ve(edge, TopAbs_VERTEX);
        if (ve.More()) {
          return BRep_Tool::Pnt(TopoDS::Vertex(ve.Current()));
        }
        return gp_Pnt(0, 0, 0);
      };

      // Helper: calculate average normal vector
      auto averageNormal = [](const TopoDS_Face& f1, const TopoDS_Face& f2) -> gp_Vec {
        gp_Vec n1 = faceOutwardNormal(f1);
        gp_Vec n2 = faceOutwardNormal(f2);
        gp_Vec nSum = n1 + n2;
        if (nSum.Magnitude() > 1e-10) nSum.Normalize();
        return nSum;
      };

      // Helper: check if two edges are parallel
      auto edgesAreParallel = [](const TopoDS_Edge& e1, const TopoDS_Edge& e2) -> bool {
        Standard_Real f1, l1, f2, l2;
        Handle(Geom_Curve) c1 = BRep_Tool::Curve(e1, f1, l1);
        Handle(Geom_Curve) c2 = BRep_Tool::Curve(e2, f2, l2);
        if (!c1.IsNull() && !c2.IsNull()) {
          gp_Pnt p1, p2;
          gp_Vec v1, v2;
          c1->D1((f1+l1)*0.5, p1, v1);
          c2->D1((f2+l2)*0.5, p2, v2);
          if (v1.Magnitude() > 1e-10) v1.Normalize();
          if (v2.Magnitude() > 1e-10) v2.Normalize();
          return std::abs(v1.Dot(v2)) >= 0.95;
        }
        return true;
      };

      // Helper: calculate face center
      auto faceCenter = [](const TopoDS_Face& f) -> gp_Pnt {
        GProp_GProps fp;
        BRepGProp::SurfaceProperties(f, fp);
        return fp.CentreOfMass();
      };

      // Find all planar faces
      std::vector<std::pair<TopoDS_Face, double>> planarFacesWithArea;
      TopExp_Explorer faceExp(originalShape, TopAbs_FACE);
      for (; faceExp.More(); faceExp.Next()) {
        const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
        Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
        if (!surf.IsNull() && surf->IsKind(STANDARD_TYPE(Geom_Plane))) {
          GProp_GProps fp;
          BRepGProp::SurfaceProperties(face, fp);
          planarFacesWithArea.push_back({face, fp.Mass()});
        }
      }

      struct PlaneFaceInfo {
        TopoDS_Face face;
        // Coplanar sub-faces produced by a prior Boolean fuse all live in the
        // same panel skin.  Tracking them here is the same fix applied in
        // unfoldShell::findPanelConnection — without it, the matchedFaceIds
        // set below would only contain the primary sub-face per skin and
        // sharp edges bordering the other sub-faces would be missed.
        std::vector<TopoDS_Face> allFaces;
        double area;
        gp_Pnt center;
        gp_Vec normal;
        bool matched = false;
      };

      std::vector<PlaneFaceInfo> planeInfos;
      for (const auto& pair : planarFacesWithArea) {
        PlaneFaceInfo info;
        info.face = pair.first;
        info.allFaces = {pair.first};
        info.area = pair.second;
        info.center = faceCenter(info.face);
        info.normal = faceOutwardNormal(info.face);
        planeInfos.push_back(info);
      }

      // Merge coplanar face entries (same normal, < 0.1 mm apart along normal).
      {
        std::vector<PlaneFaceInfo> mergedInfos;
        for (const auto& info : planeInfos) {
          bool found = false;
          for (auto& mInfo : mergedInfos) {
            if (info.normal.Dot(mInfo.normal) > 0.95) {
              double dist = std::abs(gp_Vec(info.center, mInfo.center).Dot(info.normal));
              if (dist < 0.1) {
                double oldArea = mInfo.area;
                mInfo.area += info.area;
                mInfo.center = gp_Pnt(
                    (mInfo.center.XYZ() * oldArea + info.center.XYZ() * info.area) / mInfo.area);
                mInfo.allFaces.insert(mInfo.allFaces.end(),
                                      info.allFaces.begin(), info.allFaces.end());
                found = true;
                break;
              }
            }
          }
          if (!found) mergedInfos.push_back(info);
        }
        planeInfos = std::move(mergedInfos);
      }

      // Pair them up using the same thickness logic to identify matched skins
      int N = static_cast<int>(planeInfos.size());
      for (int i = 0; i < N; ++i) {
        if (planeInfos[i].matched) continue;
        int bestPartner = -1;
        double minOverlapDist = 1e30;
        for (int j = i + 1; j < N; ++j) {
          if (planeInfos[j].matched) continue;
          double dot = planeInfos[i].normal.Dot(planeInfos[j].normal);
          if (dot < -0.95) {
            gp_Vec diff(planeInfos[i].center, planeInfos[j].center);
            double dist = std::abs(diff.Dot(planeInfos[i].normal));
            gp_Vec proj = diff - planeInfos[i].normal * diff.Dot(planeInfos[i].normal);
            double projDist = proj.Magnitude();
            // Dist should be close to t
            if (dist >= 0.7 * t && dist <= 1.3 * t) {
              if (projDist < minOverlapDist) {
                minOverlapDist = projDist;
                bestPartner = j;
              }
            }
          }
        }
        if (bestPartner != -1) {
          planeInfos[i].matched = true;
          planeInfos[bestPartner].matched = true;
        }
      }

      // Keep only matched faces
      auto minLocalDimension = [](const TopoDS_Face& f) -> double {
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
      };

      std::set<std::string> matchedFaceIds;
      for (const auto& info : planeInfos) {
        if (info.matched) {
          double minDim = minLocalDimension(info.face);
          if (minDim < 2.5 * t) {
            continue;
          }
          // Insert IDs for ALL coplanar sub-faces — sharp edges may border any
          // of them, not just the primary face that survived initial filtering.
          for (const auto& sub : info.allFaces) {
            matchedFaceIds.insert(shapeId(sub));
          }
        }
      }

      struct SharpEdge {
        TopoDS_Edge edge;
        gp_Pnt mid;
        gp_Vec avgNormal;
        TopoDS_Face f1, f2;
      };
      std::vector<SharpEdge> sharpEdges;

      TopTools_IndexedDataMapOfShapeListOfShape edgeFaceMap;
      TopExp::MapShapesAndAncestors(originalShape, TopAbs_EDGE, TopAbs_FACE, edgeFaceMap);
      for (int i = 1; i <= edgeFaceMap.Extent(); ++i) {
        const TopoDS_Edge& edge = TopoDS::Edge(edgeFaceMap.FindKey(i));
        const TopTools_ListOfShape& faces = edgeFaceMap(i);
        if (faces.Extent() == 2) {
          TopoDS_Face f1 = TopoDS::Face(faces.First());
          TopoDS_Face f2 = TopoDS::Face(faces.Last());
          bool f1Match = matchedFaceIds.count(shapeId(f1));
          bool f2Match = matchedFaceIds.count(shapeId(f2));
          std::cout << "[DEBUG reconstructCurvedBends] Edge #" << i << ": Face1=" << shapeId(f1) << " (match=" << f1Match << "), Face2=" << shapeId(f2) << " (match=" << f2Match << ")" << std::endl;
          if (f1Match && f2Match) {
            Handle(Geom_Surface) s1 = BRep_Tool::Surface(f1);
            Handle(Geom_Surface) s2 = BRep_Tool::Surface(f2);
            if (!s1.IsNull() && s1->IsKind(STANDARD_TYPE(Geom_Plane)) &&
                !s2.IsNull() && s2->IsKind(STANDARD_TYPE(Geom_Plane))) {
              gp_Vec n1 = faceOutwardNormal(f1);
              gp_Vec n2 = faceOutwardNormal(f2);
              double dot = std::clamp(n1.Dot(n2), -1.0, 1.0);
              double angleDeg = std::acos(dot) * 180.0 / M_PI;
              if (angleDeg >= 30.0 && angleDeg <= 150.0) {
                SharpEdge se;
                se.edge = edge;
                se.mid = edgeMidpoint(edge);
                se.avgNormal = averageNormal(f1, f2);
                se.f1 = f1;
                se.f2 = f2;
                sharpEdges.push_back(se);
              }
            }
          }
        }
      }

      int S = static_cast<int>(sharpEdges.size());
      std::vector<bool> matched(S, false);
      std::vector<std::pair<int, int>> pairs;
      for (int i = 0; i < S; ++i) {
        if (matched[i]) continue;
        for (int j = i + 1; j < S; ++j) {
          if (matched[j]) continue;
          double dist = sharpEdges[i].mid.Distance(sharpEdges[j].mid);
          bool parallel = edgesAreParallel(sharpEdges[i].edge, sharpEdges[j].edge);
          if (dist >= 0.7 * t && dist <= 1.3 * t) {
            if (parallel) {
              pairs.push_back({i, j});
              matched[i] = true;
              matched[j] = true;
              break;
            }
          }
        }
      }

      if (pairs.empty()) {
        return CurvedRebuildResult{partId, 0, token, {}};
      }

      BRepFilletAPI_MakeFillet filletMaker(originalShape);
      for (const auto& p : pairs) {
        int idxI = p.first;
        int idxE = p.second;
        gp_Vec diff(sharpEdges[idxI].mid, sharpEdges[idxE].mid);
        if (diff.Dot(sharpEdges[idxI].avgNormal) > 0) {
          // idxE is exterior, idxI is interior
        } else {
          std::swap(idxI, idxE);
        }

        filletMaker.Add(t, sharpEdges[idxI].edge);
        filletMaker.Add(2.0 * t, sharpEdges[idxE].edge);
      }

      filletMaker.Build();
      if (!filletMaker.IsDone()) {
        throw GeometryError("GE_UNFOLD_REBUILD_FAILED", "Fillet maker failed to reconstruct curved bends.", true, "rollback");
      }

      TopoDS_Shape resultShape = filletMaker.Shape();
      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_UNFOLD_REBUILD_FAILED", "Fillet output is topologically invalid.", true, "rollback");
      }

      // Record shape history
      std::vector<ShapeHistoryRecord> history;
      TopExp_Explorer fExp(originalShape, TopAbs_FACE);
      for (; fExp.More(); fExp.Next()) {
        const TopoDS_Face& f = TopoDS::Face(fExp.Current());
        std::string origId = shapeId(f);
        const TopTools_ListOfShape& modified = filletMaker.Modified(f);
        if (!modified.IsEmpty()) {
          for (TopTools_ListIteratorOfListOfShape itM(modified); itM.More(); itM.Next()) {
            history.push_back(ShapeHistoryRecord{"modified", origId, shapeId(itM.Value()), "reconstruct_curved_bends"});
          }
        }
      }

      // Register the updated shape
      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      return CurvedRebuildResult{partId, static_cast<int>(pairs.size()), token, std::move(history)};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_UNFOLD_REBUILD_FAILED",
                          std::string("OCCT exception in reconstructCurvedBends: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

private:
  SnapshotId createSnapshotLocked(const std::string& label) {
    GeometrySnapshot snap;
    snap.snapshotId     = generateUUID();
    snap.operationLabel = label;
    snap.timestampMs    = nowMs();

    for (const auto& kv : s_.solids)  snap.solidIds.push_back(kv.first);
    for (const auto& kv : s_.shells)  snap.shellIds.push_back(kv.first);
    for (const auto& kv : s_.unfolds) snap.unfoldIds.push_back(kv.first);

    s_.snapshots[snap.snapshotId] = snap;
    s_.snapshotSolids[snap.snapshotId] = s_.solids;
    s_.snapshotShells[snap.snapshotId] = s_.shells;
    s_.snapshotUnfolds[snap.snapshotId] = s_.unfolds;
    s_.snapshotAssemblies[snap.snapshotId] = s_.assemblies;
    return snap.snapshotId;
  }

  SheetMetalValidationResult validateSheetMetalShapeLocked(const TopoDS_Shape& shape) {
    SheetMetalValidationResult result;
    result.isValid = false;
    result.canFlatten = false;

    // Helper: calculate face center
    auto faceCenter = [](const TopoDS_Face& f) -> gp_Pnt {
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(f, fp);
      return fp.CentreOfMass();
    };

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

    auto minLocalDimension = [](const TopoDS_Face& f) -> double {
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

  SheetMetalValidationResult validateSheetMetalLocked(const ShellId& partId) {
    TopoDS_Shape shape;
    if (auto sit = s_.shells.find(partId); sit != s_.shells.end()) {
      shape = sit->second.shape;
    } else if (auto it = s_.solids.find(partId); it != s_.solids.end()) {
      shape = it->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Shell not found: " + partId, false, "");
    }
    return validateSheetMetalShapeLocked(shape);
  }

  GeometryState& s_;
};

// ─── Delegation stubs ─────────────────────────────────────────────────────────

ManifoldResult GeometryServiceImpl::checkManifold(const SolidId& solidId) {
  return GeometryValidation(state_).checkManifold(solidId);
}

SolidId GeometryServiceImpl::healGeometry(const SolidId& solidId) {
  return GeometryValidation(state_).healGeometry(solidId);
}

SheetMetalValidationResult GeometryServiceImpl::validateSheetMetal(const ShellId& partId) {
  return GeometryValidation(state_).validateSheetMetal(partId);
}

CurvedRebuildResult GeometryServiceImpl::reconstructCurvedBends(const ShellId& partId) {
  return GeometryValidation(state_).reconstructCurvedBends(partId);
}

}  // namespace mcp_cad
