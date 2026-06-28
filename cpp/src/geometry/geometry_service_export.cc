// ─── OCCT includes ─────────────────────────────────────────────────────────────
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
#include "geometry_service_utils.hpp"

// ─── Standard library ─────────────────────────────────────────────────────────
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

static gp_Trsf locationToTrsf(const TopLoc_Location& loc) {
  if (loc.IsIdentity()) return gp_Trsf();
  return loc.Transformation();
}

class GeometryExport {
public:
  explicit GeometryExport(GeometryState& s) : s_(s) {}

  // ── Unfolding ─────────────────────────────────────────────────────────────

  UnfoldResult unfoldShell(const ShellId& shellId, double kFactor) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (s_.shells.find(shellId) == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    TopoDS_Shape activeShape = s_.shells[shellId].shape;

    // 1. Gap sewing: integrate BRepBuilderAPI_Sewing with tolerance 0.1 mm
    BRepBuilderAPI_Sewing sewer;
    sewer.Init();
    sewer.SetTolerance(0.1);
    sewer.Add(activeShape);
    sewer.Perform();
    TopoDS_Shape sewedShape = sewer.SewedShape();
    if (!sewedShape.IsNull()) {
      activeShape = sewedShape;
    }

    // Open edge audit: throw GE_UNFOLD_SEWING_FAILED if gaps remain open above tolerance
    Standard_Integer nbFree = sewer.NbFreeEdges();
    std::vector<TopoDS_Edge> freeEdges;
    for (Standard_Integer i = 1; i <= nbFree; ++i) {
      freeEdges.push_back(TopoDS::Edge(sewer.FreeEdge(i)));
    }
    for (size_t i = 0; i < freeEdges.size(); ++i) {
      for (size_t j = i + 1; j < freeEdges.size(); ++j) {
        BRepExtrema_DistShapeShape dist(freeEdges[i], freeEdges[j]);
        if (dist.IsDone()) {
          double d = dist.Value();
          if (d > 0.1 && d <= 1.0) {
            throw GeometryError("GE_UNFOLD_SEWING_FAILED",
                                "GE_UNFOLD_SEWING_FAILED: Gaps remain open above tolerance of 0.1 mm after sewing.",
                                false, "");
          }
        }
      }
    }

    SheetMetalValidationResult val = validateSheetMetalShape(activeShape);
    if (!val.isValid) {
      std::string code = "GE_INVALID_SHEET_METAL";
      std::string msg = "Sheet metal validation failed: ";
      if (!val.validationErrors.empty()) {
        msg += val.validationErrors[0];
        if (val.validationErrors[0].find("GE_UNFOLD_CYCLE_DETECTED") != std::string::npos) {
          code = "GE_UNFOLD_CYCLE_DETECTED";
        } else if (val.validationErrors[0].find("GE_UNFOLD_T_JUNCTION") != std::string::npos) {
          code = "GE_UNFOLD_T_JUNCTION";
        }
      }
      throw GeometryError(code, msg, false, "");
    }

    SnapshotId token = s_.createSnapshot("before unfold of " + shellId);

    try {
      // Helper: check if two edges are geometrically coincident
      auto edgesAreCoincident = [](const TopoDS_Edge& e1, const TopoDS_Edge& e2) -> bool {
        Standard_Real f1, l1, f2, l2;
        Handle(Geom_Curve) c1 = BRep_Tool::Curve(e1, f1, l1);
        Handle(Geom_Curve) c2 = BRep_Tool::Curve(e2, f2, l2);
        if (c1.IsNull() || c2.IsNull()) return false;

        gp_Pnt pMid1 = c1->Value((f1 + l1) * 0.5);
        gp_Pnt pMid2 = c2->Value((f2 + l2) * 0.5);

        double dist = pMid1.Distance(pMid2);
        if (dist > 3.0) return false;

        GProp_GProps prop1, prop2;
        BRepGProp::LinearProperties(e1, prop1);
        BRepGProp::LinearProperties(e2, prop2);
        double len1 = prop1.Mass();
        double len2 = prop2.Mass();
        if (std::abs(len1 - len2) > 10.0) return false;

        gp_Pnt p1, p2;
        gp_Vec v1, v2;
        c1->D1((f1 + l1) * 0.5, p1, v1);
        c2->D1((f2 + l2) * 0.5, p2, v2);
        if (v1.Magnitude() > 1e-10) v1.Normalize();
        if (v2.Magnitude() > 1e-10) v2.Normalize();
        return std::abs(v1.Dot(v2)) >= 0.90;
      };

      // Helper: check if any face in f1List shares an edge with any face in f2List.
      auto findSharedEdgeList = [&](const std::vector<TopoDS_Face>& f1List,
                                    const std::vector<TopoDS_Face>& f2List,
                                    TopoDS_Edge& shared) -> bool {
        TopoDS_Edge best;
        double bestLen = 0.0;
        for (const auto& f1 : f1List) {
          for (const auto& f2 : f2List) {
            TopExp_Explorer e1(f1, TopAbs_EDGE);
            for (; e1.More(); e1.Next()) {
              const TopoDS_Edge& edge1 = TopoDS::Edge(e1.Current());
              TopExp_Explorer e2(f2, TopAbs_EDGE);
              for (; e2.More(); e2.Next()) {
                const TopoDS_Edge& edge2 = TopoDS::Edge(e2.Current());
                if (edge1.IsSame(edge2) || edgesAreCoincident(edge1, edge2)) {
                  GProp_GProps prop;
                  BRepGProp::LinearProperties(edge1, prop);
                  double len = prop.Mass();
                  if (len > bestLen) {
                    bestLen = len;
                    best = edge1;
                  }
                }
              }
            }
          }
        }
        if (bestLen > 0.0) {
          shared = best;
          return true;
        }
        return false;
      };

      // Backwards-compatible single-face wrapper.
      auto findSharedEdge = [&](const TopoDS_Face& f1, const TopoDS_Face& f2, TopoDS_Edge& shared) -> bool {
        return findSharedEdgeList({f1}, {f2}, shared);
      };

      // 1. Gather all planar faces and compute their areas
      std::vector<std::pair<TopoDS_Face, double>> planarFacesWithArea;
      TopExp_Explorer faceExp(activeShape, TopAbs_FACE);
      for (; faceExp.More(); faceExp.Next()) {
        const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
        Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
        if (!surf.IsNull() && surf->IsKind(STANDARD_TYPE(Geom_Plane))) {
          GProp_GProps fp;
          BRepGProp::SurfaceProperties(face, fp);
          double area = fp.Mass();
          planarFacesWithArea.push_back({face, area});
        }
      }

      // If no planar faces, fall back to simple bounding box
      if (planarFacesWithArea.empty()) {
        Bnd_Box bbox;
        BRepBndLib::AddOptimal(activeShape, bbox);
        double xMin, yMin, zMin, xMax, yMax, zMax;
        bbox.Get(xMin, yMin, zMin, xMax, yMax, zMax);
        double flatW = xMax - xMin;
        double flatH = yMax - yMin;
        UnfoldId id = generateUUID();
        s_.unfolds[id] = UnfoldState{id, shellId, flatW, flatH, kFactor, 0, {}, {}, gp_Pnt2d(0, 0)};
        return UnfoldResult{id, flatW, flatH, kFactor, 0, true, val.nominalThickness, token, {}};
      }

      // 2. Perform pairwise face matching to identify thin-sheet skins (panels)
      struct PlaneFaceInfo {
        TopoDS_Face face;
        std::vector<TopoDS_Face> allFaces;
        double area;
        gp_Pnt center;
        gp_Vec normal;
        double D;
        bool matched = false;
        int partnerIdx = -1;
      };

      std::vector<PlaneFaceInfo> planeInfos;
      for (const auto& pair : planarFacesWithArea) {
        if (minLocalDimension(pair.first) < 2.5 * val.nominalThickness) {
          continue;
        }
        PlaneFaceInfo info;
        info.face = pair.first;
        info.allFaces = {pair.first};
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
              mInfo.allFaces.insert(mInfo.allFaces.end(),
                                    info.allFaces.begin(), info.allFaces.end());
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

      int N = static_cast<int>(planeInfos.size());
      for (int i = 0; i < N; ++i) {
        if (planeInfos[i].matched) continue;

        int bestPartner = -1;
        double bestDist = 0.0;
        double maxScore = -1.0;

        for (int j = 0; j < N; ++j) {
          if (i == j || planeInfos[j].matched) continue;

          double dot = planeInfos[i].normal.Dot(planeInfos[j].normal);
          if (dot < -0.95) {
            gp_Vec diff(planeInfos[i].center, planeInfos[j].center);
            double dist = std::abs(diff.Dot(planeInfos[i].normal));

            if (dist >= 0.5 && dist <= 6.0) {
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
        }
      }

      struct Panel {
        int idxA;
        int idxB;
      };

      std::vector<Panel> panels;
      for (int i = 0; i < N; ++i) {
        if (planeInfos[i].matched && planeInfos[i].partnerIdx > i) {
          double minDimA = minLocalDimension(planeInfos[i].face);
          if (minDimA < 2.5 * val.nominalThickness) {
            continue;
          }
          Panel p;
          p.idxA = i;
          p.idxB = planeInfos[i].partnerIdx;
          panels.push_back(p);
        }
      }

      // If no valid broad panels, fall back
      if (panels.empty()) {
        Bnd_Box bbox;
        BRepBndLib::AddOptimal(activeShape, bbox);
        double xMin, yMin, zMin, xMax, yMax, zMax;
        bbox.Get(xMin, yMin, zMin, xMax, yMax, zMax);
        double flatW = xMax - xMin;
        double flatH = yMax - yMin;
        UnfoldId id = generateUUID();
        s_.unfolds[id] = UnfoldState{id, shellId, flatW, flatH, kFactor, 0, {}, {}, gp_Pnt2d(0, 0)};
        return UnfoldResult{id, flatW, flatH, kFactor, 0, true, val.nominalThickness, token, {}};
      }

      // Deduplicate coincident panels
      std::vector<Panel> uniquePanels;

      for (const auto& p : panels) {
        gp_Pnt cA = planeInfos[p.idxA].center;
        gp_Pnt cB = planeInfos[p.idxB].center;
        gp_Pnt pCenter((cA.X() + cB.X()) * 0.5, (cA.Y() + cB.Y()) * 0.5, (cA.Z() + cB.Z()) * 0.5);
        gp_Vec pNorm = planeInfos[p.idxA].normal;

        bool isDuplicate = false;
        for (const auto& existing : uniquePanels) {
          gp_Pnt ecA = planeInfos[existing.idxA].center;
          gp_Pnt ecB = planeInfos[existing.idxB].center;
          gp_Pnt eCenter((ecA.X() + ecB.X()) * 0.5, (ecA.Y() + ecB.Y()) * 0.5, (ecA.Z() + ecB.Z()) * 0.5);
          gp_Vec eNorm = planeInfos[existing.idxA].normal;

          double dist = pCenter.Distance(eCenter);
          double dot = std::abs(pNorm.Dot(eNorm));

          if (dist < 1.0 && dot > 0.95) {
            isDuplicate = true;
            break;
          }
        }

        if (!isDuplicate) {
          uniquePanels.push_back(p);
        }
      }
      panels = uniquePanels;

      // Sort panels to be completely rotation-invariant by using total panel area as the primary key
      std::sort(panels.begin(), panels.end(), [&](const Panel& p1, const Panel& p2) {
        double area1 = planeInfos[p1.idxA].area + planeInfos[p1.idxB].area;
        double area2 = planeInfos[p2.idxA].area + planeInfos[p2.idxB].area;
        if (std::abs(area1 - area2) > 1e-3) {
          return area1 > area2;
        }
        double a1 = planeInfos[p1.idxA].area;
        double a2 = planeInfos[p2.idxA].area;
        if (std::abs(a1 - a2) > 1e-3) {
          return a1 > a2;
        }
        TopTools_IndexedMapOfShape edges1, edges2;
        TopExp::MapShapes(planeInfos[p1.idxA].face, TopAbs_EDGE, edges1);
        TopExp::MapShapes(planeInfos[p2.idxA].face, TopAbs_EDGE, edges2);
        return edges1.Extent() > edges2.Extent();
      });

      int P = static_cast<int>(panels.size());
      std::vector<TopoDS_Face> uniqueFaces(P);
      for (int i = 0; i < P; ++i) {
        uniqueFaces[i] = planeInfos[panels[i].idxA].face;
      }

      // Helper to check panel connections
      auto findPanelConnection = [&](int p1, int p2, int& faceIdx1, int& faceIdx2, TopoDS_Edge& connEdge) -> bool {
        std::pair<int, int> pairs[4] = {
          {panels[p1].idxA, panels[p2].idxA},
          {panels[p1].idxA, panels[p2].idxB},
          {panels[p1].idxB, panels[p2].idxA},
          {panels[p1].idxB, panels[p2].idxB}
        };

        for (const auto& pair : pairs) {
          if (findSharedEdgeList(planeInfos[pair.first].allFaces,
                                 planeInfos[pair.second].allFaces, connEdge)) {
            faceIdx1 = pair.first;
            faceIdx2 = pair.second;
            return true;
          }
        }

        // Try curved face connection
        TopExp_Explorer faceExpAll(activeShape, TopAbs_FACE);
        for (; faceExpAll.More(); faceExpAll.Next()) {
          const TopoDS_Face& fCur = TopoDS::Face(faceExpAll.Current());
          Handle(Geom_Surface) surf = BRep_Tool::Surface(fCur);
          if (surf.IsNull() || surf->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

          for (const auto& pair : pairs) {
            bool sharesI = false;
            TopoDS_Edge edgeI;
            for (const auto& subA : planeInfos[pair.first].allFaces) {
              TopExp_Explorer expI(subA, TopAbs_EDGE);
              for (; expI.More(); expI.Next()) {
                TopExp_Explorer eC1(fCur, TopAbs_EDGE);
                for (; eC1.More(); eC1.Next()) {
                  const TopoDS_Edge& eCurved = TopoDS::Edge(eC1.Current());
                  if (eCurved.IsSame(expI.Current())) { sharesI = true; edgeI = eCurved; break; }
                }
                if (sharesI) break;
              }
              if (sharesI) break;
            }

            bool sharesJ = false;
            for (const auto& subB : planeInfos[pair.second].allFaces) {
              TopExp_Explorer expJ(subB, TopAbs_EDGE);
              for (; expJ.More(); expJ.Next()) {
                TopExp_Explorer eC2(fCur, TopAbs_EDGE);
                for (; eC2.More(); eC2.Next()) {
                  const TopoDS_Edge& eCurved = TopoDS::Edge(eC2.Current());
                  if (eCurved.IsSame(expJ.Current())) { sharesJ = true; break; }
                }
                if (sharesJ) break;
              }
              if (sharesJ) break;
            }

            if (sharesI && sharesJ) {
              faceIdx1 = pair.first;
              faceIdx2 = pair.second;
              connEdge = edgeI;
              return true;
            }
          }
        }

        // Geometric fallback
        double geomTol = val.nominalThickness * 4.0 + 5.0;
        double bestScore = -1.0;
        TopoDS_Edge bestEdge;
        int bestF1 = -1, bestF2 = -1;

        for (const auto& pair : pairs) {
          for (const auto& f1 : planeInfos[pair.first].allFaces) {
            for (const auto& f2 : planeInfos[pair.second].allFaces) {
              TopExp_Explorer eExp1(f1, TopAbs_EDGE);
              for (; eExp1.More(); eExp1.Next()) {
                const TopoDS_Edge& e1 = TopoDS::Edge(eExp1.Current());
                GProp_GProps ep1;
                BRepGProp::LinearProperties(e1, ep1);
                if (ep1.Mass() < 1.0) continue;

                Standard_Real f1p, l1p;
                Handle(Geom_Curve) c1 = BRep_Tool::Curve(e1, f1p, l1p);
                if (c1.IsNull() || !c1->IsKind(STANDARD_TYPE(Geom_Line))) continue;
                gp_Pnt pa; gp_Vec d1;
                c1->D1((f1p + l1p) * 0.5, pa, d1);
                if (d1.Magnitude() < 1e-10) continue;
                d1.Normalize();

                TopExp_Explorer eExp2(f2, TopAbs_EDGE);
                for (; eExp2.More(); eExp2.Next()) {
                  const TopoDS_Edge& e2 = TopoDS::Edge(eExp2.Current());
                  GProp_GProps ep2;
                  BRepGProp::LinearProperties(e2, ep2);
                  if (ep2.Mass() < 1.0) continue;

                  Standard_Real f2p, l2p;
                  Handle(Geom_Curve) c2 = BRep_Tool::Curve(e2, f2p, l2p);
                  if (c2.IsNull() || !c2->IsKind(STANDARD_TYPE(Geom_Line))) continue;
                  gp_Pnt pb; gp_Vec d2;
                  c2->D1((f2p + l2p) * 0.5, pb, d2);
                  if (d2.Magnitude() < 1e-10) continue;
                  d2.Normalize();

                  double parallelism = std::abs(d1.Dot(d2));
                  if (parallelism < 0.9) continue;

                  BRepExtrema_DistShapeShape dist(e1, e2);
                  if (!dist.IsDone() || dist.Value() >= geomTol) continue;

                  double score = parallelism / (1.0 + dist.Value()) * std::min(ep1.Mass(), ep2.Mass());
                  if (score > bestScore) {
                    bestScore = score;
                    bestEdge = e1;
                    bestF1 = pair.first;
                    bestF2 = pair.second;
                  }
                }
              }
            }
          }
        }

        if (!bestEdge.IsNull()) {
          faceIdx1 = bestF1;
          faceIdx2 = bestF2;
          connEdge = bestEdge;
          return true;
        }
        return false;
      };

      // 3. Build connectivity graph
      struct PanelEdge {
        int nbrPanelIdx;
        int faceIdxCur;
        int faceIdxNbr;
        TopoDS_Edge edge;
      };

      std::vector<std::vector<PanelEdge>> panelAdj(P);
      std::vector<std::vector<std::pair<int, TopoDS_Edge>>> adj(P);

      for (int i = 0; i < P; ++i) {
        for (int j = i + 1; j < P; ++j) {
          int f1, f2;
          TopoDS_Edge conn;
          if (findPanelConnection(i, j, f1, f2, conn)) {
            panelAdj[i].push_back({j, f1, f2, conn});
            panelAdj[j].push_back({i, f2, f1, conn});

            adj[i].push_back({j, conn});
            adj[j].push_back({i, conn});
          }
        }
      }

      // 4. BFS over Panel nodes
      struct BendRecord {
        int          panelCur;
        int          faceIdxCur;
        TopoDS_Edge  originalEdge;
        double       theta;
      };
      std::vector<BendRecord> bendRecords;

      std::vector<gp_Trsf> flatTransformsForFaces(N);
      std::vector<gp_Trsf> flatTransforms(P);
      std::vector<bool> visited(P, false);
      std::vector<int> parent(P, -1);
      int bendCount = 0;

      std::vector<int> q;
      q.push_back(0);
      visited[0] = true;
      flatTransforms[0] = gp_Trsf();
      flatTransformsForFaces[panels[0].idxA] = gp_Trsf();
      flatTransformsForFaces[panels[0].idxB] = gp_Trsf();

      size_t head = 0;
      while (head < q.size()) {
        int cur = q[head++];
        for (const auto& conn : panelAdj[cur]) {
          int nbr = conn.nbrPanelIdx;
          if (!visited[nbr]) {
            visited[nbr] = true;
            parent[nbr] = cur;
            bendCount++;

            int fCur = conn.faceIdxCur;
            int fNbr = conn.faceIdxNbr;
            const TopoDS_Edge& originalEdge = conn.edge;

            Standard_Real firstParam, lastParam;
            Handle(Geom_Curve) curve = BRep_Tool::Curve(originalEdge, firstParam, lastParam);
            gp_Pnt pMid;
            gp_Vec dE;
            if (!curve.IsNull()) {
              double midParam = (firstParam + lastParam) * 0.5;
              gp_Pnt p;
              gp_Vec v;
              curve->D1(midParam, p, v);
              pMid = p;
              dE = v;
            } else {
              TopExp_Explorer vExp(originalEdge, TopAbs_VERTEX);
              if (vExp.More()) {
                pMid = BRep_Tool::Pnt(TopoDS::Vertex(vExp.Current()));
              } else {
                pMid = gp_Pnt(0, 0, 0);
              }
              dE = gp_Vec(0, 0, 1);
            }
            if (dE.Magnitude() > 1e-10) dE.Normalize();
            else dE = gp_Vec(0, 0, 1);

            gp_Vec nCur = planeInfos[fCur].normal;
            gp_Vec nNbr = planeInfos[fNbr].normal;

            double cosDihedral = std::max(-1.0, std::min(1.0, nCur.Dot(nNbr)));
            double dihedral = std::acos(cosDihedral);
            double theta = M_PI - dihedral;

            {
              gp_Trsf trial;
              trial.SetRotation(gp_Ax1(pMid, gp_Dir(dE.X(), dE.Y(), dE.Z())), theta);
              gp_Vec rotated = nNbr.Transformed(trial);
              if (rotated.Dot(nCur) < 0) {
                theta = -theta;
              }
            }

            gp_Pnt pMidTransformed = pMid.Transformed(flatTransformsForFaces[fCur]);
            gp_Vec dETransformed = dE.Transformed(flatTransformsForFaces[fCur]);

            gp_Ax1 rotationAxis(pMidTransformed, gp_Dir(dETransformed.X(), dETransformed.Y(), dETransformed.Z()));
            gp_Trsf localRotation;
            localRotation.SetRotation(rotationAxis, theta);

            gp_Trsf cumulative = localRotation * flatTransformsForFaces[fCur];
            flatTransformsForFaces[panels[nbr].idxA] = cumulative;
            flatTransformsForFaces[panels[nbr].idxB] = cumulative;
            flatTransforms[nbr] = cumulative;

            bendRecords.push_back({cur, fCur, originalEdge, theta});

            q.push_back(nbr);
          }
        }
      }

      // 5. Transform all vertices of all panel skins and project to local 2D plane of Face 0
      int baseFace = panels[0].idxA;
      gp_Pnt c0;
      GProp_GProps fp0;
      BRepGProp::SurfaceProperties(planeInfos[baseFace].face, fp0);
      c0 = fp0.CentreOfMass();
      gp_Vec n0 = planeInfos[baseFace].normal;

      gp_Vec uAxis;
      bool foundEdge = false;

      if (!adj[0].empty()) {
        const TopoDS_Edge& bendEdge = adj[0][0].second;
        Standard_Real first, last;
        Handle(Geom_Curve) curve = BRep_Tool::Curve(bendEdge, first, last);
        if (!curve.IsNull()) {
          gp_Pnt pa, pb;
          gp_Vec dE;
          curve->D1((first + last) * 0.5, pa, dE);
          if (dE.Magnitude() > 1e-10) {
            dE.Normalize();
            uAxis = n0.Crossed(dE);
            if (uAxis.Magnitude() > 1e-10) {
              uAxis.Normalize();
              foundEdge = true;
            }
          }
        }
      }

      if (!foundEdge) {
        Handle(Geom_Surface) baseSurf = BRep_Tool::Surface(planeInfos[baseFace].face);
        Handle(Geom_Plane) basePlane = Handle(Geom_Plane)::DownCast(baseSurf);
        if (!basePlane.IsNull()) {
          gp_Vec xDir(basePlane->Position().XDirection());
          if (std::abs(xDir.Dot(n0)) < 0.9 && xDir.Magnitude() > 1e-10) {
            uAxis = xDir;
            uAxis.Normalize();
            foundEdge = true;
          }
        }
      }

      if (!foundEdge) {
        double bestLen = 1e30;
        TopExp_Explorer edgeExp(planeInfos[baseFace].face, TopAbs_EDGE);
        for (; edgeExp.More(); edgeExp.Next()) {
          const TopoDS_Edge& edge = TopoDS::Edge(edgeExp.Current());
          Standard_Real first, last;
          Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, first, last);
          if (!curve.IsNull() && curve->IsKind(STANDARD_TYPE(Geom_Line))) {
            gp_Pnt p1 = curve->Value(first);
            gp_Pnt p2 = curve->Value(last);
            gp_Vec edgeVec(p1, p2);
            double len = edgeVec.Magnitude();
            if (len > 1.0 && len < bestLen) {
              bestLen = len;
              uAxis = edgeVec;
              uAxis.Normalize();
              foundEdge = true;
            }
          }
        }
      }

      if (!foundEdge) {
        if (std::abs(n0.X()) < 0.9) {
          uAxis = gp_Vec(0, -n0.Z(), n0.Y());
        } else {
          uAxis = gp_Vec(-n0.Y(), n0.X(), 0);
        }
        uAxis.Normalize();
      }

      gp_Vec vAxis = n0.Crossed(uAxis);
      vAxis.Normalize();

      // Helper: project a point into the flat (u,v) frame for panel `idx`.
      auto flatUV = [&](const gp_Pnt& p, int idx) -> gp_Pnt2d {
        gp_Pnt pt = p.Transformed(flatTransformsForFaces[idx]);
        gp_Vec toPt(c0, pt);
        return gp_Pnt2d(toPt.Dot(uAxis), toPt.Dot(vAxis));
      };

      auto gatherSkin = [&](int idx) -> std::vector<TopoDS_Face> {
        gp_Pnt c = planeInfos[idx].center;
        gp_Vec n = planeInfos[idx].normal;
        std::vector<TopoDS_Face> out;
        for (TopExp_Explorer fe(activeShape, TopAbs_FACE); fe.More(); fe.Next()) {
          const TopoDS_Face& f = TopoDS::Face(fe.Current());
          Handle(Geom_Surface) s = BRep_Tool::Surface(f);
          if (s.IsNull() || !s->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
          gp_Vec fn = faceOutwardNormal(f);
          if (n.Dot(fn) < 0.95) continue;
          GProp_GProps fp; BRepGProp::SurfaceProperties(f, fp);
          if (std::abs(gp_Vec(c, fp.CentreOfMass()).Dot(n)) > 0.5) continue;
          out.push_back(f);
        }
        if (out.empty()) out = planeInfos[idx].allFaces;
        return out;
      };

      std::vector<std::vector<TopoDS_Face>> panelSkin(P);
      for (int i = 0; i < P; ++i) {
        if (!visited[i]) continue;
        panelSkin[i] = gatherSkin(panels[i].idxA);
      }

      double uMin = 1e30, uMax = -1e30;
      double vMin = 1e30, vMax = -1e30;

      for (int i = 0; i < P; ++i) {
        if (!visited[i]) continue;
        double iuMin=1e30, iuMax=-1e30;
        for (const TopoDS_Face& subFace : panelSkin[i]) {
          for (TopExp_Explorer ve(subFace, TopAbs_VERTEX); ve.More(); ve.Next()) {
            gp_Pnt2d uv = flatUV(BRep_Tool::Pnt(TopoDS::Vertex(ve.Current())), panels[i].idxA);
            uMin = std::min(uMin, uv.X()); uMax = std::max(uMax, uv.X());
            vMin = std::min(vMin, uv.Y()); vMax = std::max(vMax, uv.Y());
            iuMin = std::min(iuMin, uv.X()); iuMax = std::max(iuMax, uv.X());
          }
        }
      }

      double flatW = uMax - uMin;
      double flatH = vMax - vMin;

      if (flatW < 1e-5) flatW = 1.0;
      if (flatH < 1e-5) flatH = 1.0;

      // 5b. Build flat-plane coordinate transform.
      gp_Ax3 face0CS(c0,
                     gp_Dir(n0.X(), n0.Y(), n0.Z()),
                     gp_Dir(uAxis.X(), uAxis.Y(), uAxis.Z()));
      gp_Trsf tToXY;
      tToXY.SetTransformation(face0CS);

      gp_Trsf tOffset;
      tOffset.SetTranslation(gp_Vec(-uMin, -vMin, 0.0));

      // 6. Build flat panel shapes (clean cut profile).
      auto qz = [](double v) -> long long { return std::llround(v * 100.0); };

      std::vector<TopoDS_Shape> flatPanelShapes(P);
      for (int i = 0; i < P; ++i) {
        if (!visited[i]) continue;
        const std::vector<TopoDS_Face>& skin = panelSkin[i];
        if (skin.empty()) continue;

        gp_Trsf toFlat = tOffset * tToXY * flatTransformsForFaces[panels[i].idxA];

        BRepBuilderAPI_Sewing sewer;
        sewer.SetTolerance(0.3);
        bool anySewn = false;
        for (const TopoDS_Face& f : skin) {
          try {
            BRepBuilderAPI_Transform xfm(f, toFlat, /*copy=*/true);
            if (xfm.IsDone()) { sewer.Add(xfm.Shape()); anySewn = true; }
          } catch (...) {}
        }
        if (!anySewn) continue;
        sewer.Perform();

        Handle(TopTools_HSequenceOfShape) freeEdges = new TopTools_HSequenceOfShape();
        for (Standard_Integer fe = 1, n = sewer.NbFreeEdges(); fe <= n; ++fe)
          freeEdges->Append(sewer.FreeEdge(fe));
        if (freeEdges->IsEmpty()) {
          typedef std::tuple<long long,long long,long long,long long,long long,long long> GKey;
          std::map<GKey, std::pair<TopoDS_Edge,int>> edgeCnt;
          for (const TopoDS_Face& f : skin) {
            try {
              BRepBuilderAPI_Transform xfm(f, toFlat, /*copy=*/true);
              if (!xfm.IsDone()) continue;
              for (TopExp_Explorer eEx(xfm.Shape(), TopAbs_EDGE); eEx.More(); eEx.Next()) {
                const TopoDS_Edge& e = TopoDS::Edge(eEx.Current());
                Standard_Real ef, el;
                Handle(Geom_Curve) ec = BRep_Tool::Curve(e, ef, el);
                if (ec.IsNull() || std::abs(el - ef) < 1e-12) continue;
                gp_Pnt mid = ec->Value((ef + el) * 0.5);
                gp_Vec dir; gp_Pnt tmp; ec->D1((ef + el) * 0.5, tmp, dir);
                if (dir.Magnitude() > 1e-10) dir.Normalize();
                if (dir.X() < -1e-9 ||
                    (std::abs(dir.X()) < 1e-9 && dir.Y() < -1e-9) ||
                    (std::abs(dir.X()) < 1e-9 && std::abs(dir.Y()) < 1e-9 && dir.Z() < 0))
                  dir.Reverse();
                GKey key(qz(mid.X()), qz(mid.Y()), qz(mid.Z()), qz(dir.X()), qz(dir.Y()), qz(dir.Z()));
                auto it2 = edgeCnt.find(key);
                if (it2 == edgeCnt.end()) edgeCnt[key] = {e, 1};
                else it2->second.second++;
              }
            } catch (...) {}
          }
          for (auto it2 = edgeCnt.begin(); it2 != edgeCnt.end(); ++it2)
            if (it2->second.second == 1) freeEdges->Append(it2->second.first);
        }
        if (freeEdges->IsEmpty()) continue;

        // (a2) Drop chord edges.
        {
          typedef std::tuple<long long,long long,long long> VKey;
          auto vkeyOf = [&](const gp_Pnt& p) { return VKey(qz(p.X()), qz(p.Y()), qz(p.Z())); };

          std::vector<std::pair<gp_Pnt, gp_Pnt>> ends(freeEdges->Length());
          std::map<VKey, int> degree;
          for (int e = 1; e <= freeEdges->Length(); ++e) {
            const TopoDS_Edge& ed = TopoDS::Edge(freeEdges->Value(e));
            Standard_Real ef, el;
            Handle(Geom_Curve) ec = BRep_Tool::Curve(ed, ef, el);
            if (ec.IsNull()) { ends[e-1] = {gp_Pnt(), gp_Pnt()}; continue; }
            gp_Pnt p1 = ec->Value(ef), p2 = ec->Value(el);
            ends[e-1] = {p1, p2};
            degree[vkeyOf(p1)]++;
            degree[vkeyOf(p2)]++;
          }

          Handle(TopTools_HSequenceOfShape) keep = new TopTools_HSequenceOfShape();
          for (int e = 1; e <= freeEdges->Length(); ++e) {
            int d1 = degree[vkeyOf(ends[e-1].first)];
            int d2 = degree[vkeyOf(ends[e-1].second)];
            if (d1 >= 3 && d2 >= 3) continue;
            keep->Append(freeEdges->Value(e));
          }
          if (!keep->IsEmpty()) freeEdges = keep;
        }

        // (b) Connect the boundary edges into closed wires.
        Handle(TopTools_HSequenceOfShape) wires;
        ShapeAnalysis_FreeBounds::ConnectEdgesToWires(freeEdges, 0.1, Standard_False, wires);

        auto simplifyLoop = [](std::vector<gp_Pnt>& p, double tol) {
          bool changed = true;
          while (changed && p.size() > 3) {
            changed = false;
            for (size_t k = 0; k < p.size() && p.size() > 3; ) {
              const gp_Pnt& a = p[(k + p.size() - 1) % p.size()];
              const gp_Pnt& b = p[k];
              const gp_Pnt& c = p[(k + 1) % p.size()];
              gp_Vec ac(a, c); double L = ac.Magnitude();
              double d = (L < 1e-9) ? gp_Vec(a, b).Magnitude()
                                    : gp_Vec(a, b).Crossed(ac).Magnitude() / L;
              if (d < tol) { p.erase(p.begin() + k); changed = true; }
              else ++k;
            }
          }
        };

        BRep_Builder bb;
        TopoDS_Compound cmp;
        bb.MakeCompound(cmp);
        bool anyAdded = false;
        std::map<std::tuple<long long,long long,long long>, TopoDS_Edge> outEdges;

        if (!wires.IsNull() && wires->Length() > 0) {
          for (int w = 1; w <= wires->Length(); ++w) {
            TopoDS_Wire wire = TopoDS::Wire(wires->Value(w));

            std::vector<gp_Pnt> pts;
            for (BRepTools_WireExplorer we(wire); we.More(); we.Next())
              pts.push_back(BRep_Tool::Pnt(we.CurrentVertex()));
            if (pts.size() < 3) continue;

            simplifyLoop(pts, 0.2);
            if (pts.size() < 3) continue;

            double area = 0.0;
            for (size_t k = 0; k < pts.size(); ++k) {
              const gp_Pnt& a = pts[k];
              const gp_Pnt& b = pts[(k + 1) % pts.size()];
              area += a.X() * b.Y() - b.X() * a.Y();
            }
            if (std::abs(area) * 0.5 < 1.0) continue;

            for (size_t k = 0; k < pts.size(); ++k) {
              const gp_Pnt& a = pts[k];
              const gp_Pnt& b = pts[(k + 1) % pts.size()];
              if (a.Distance(b) < 1e-7) continue;
              try {
                TopoDS_Edge e = BRepBuilderAPI_MakeEdge(a, b).Edge();
                gp_Pnt mid((a.X()+b.X())*0.5, (a.Y()+b.Y())*0.5, 0.0);
                outEdges.emplace(std::make_tuple(qz(mid.X()), qz(mid.Y()), qz(mid.Z())), e);
              } catch (...) {}
            }
          }
          for (auto it2 = outEdges.begin(); it2 != outEdges.end(); ++it2) {
            bb.Add(cmp, it2->second);
            anyAdded = true;
          }
        }

        // Fallback: wire connection failed — emit the raw free edges.
        if (!anyAdded) {
          for (int e = 1; e <= freeEdges->Length(); ++e) { bb.Add(cmp, freeEdges->Value(e)); anyAdded = true; }
        }
        if (anyAdded) flatPanelShapes[i] = cmp;
      }

      // 7. Build flat bend edges from the BFS bend records.
      std::vector<FlatBendEdge> flatBendEdges;
      for (const auto& rec : bendRecords) {
        gp_Trsf toFlat = tOffset * tToXY * flatTransformsForFaces[rec.faceIdxCur];
        bool added = false;
        try {
          BRepBuilderAPI_Transform xfm(rec.originalEdge, toFlat, /*copy=*/true);
          if (xfm.IsDone()) {
            FlatBendEdge fbe;
            fbe.edge     = TopoDS::Edge(xfm.Shape());
            fbe.angleDeg = std::abs(rec.theta) * 180.0 / M_PI;
            fbe.isUp     = (rec.theta >= 0.0);
            flatBendEdges.push_back(std::move(fbe));
            added = true;
          }
        } catch (...) {}
        if (!added) {
          try {
            Standard_Real first, last;
            Handle(Geom_Curve) curve = BRep_Tool::Curve(rec.originalEdge, first, last);
            if (!curve.IsNull()) {
              gp_Pnt p1 = curve->Value(first).Transformed(toFlat);
              gp_Pnt p2 = curve->Value(last).Transformed(toFlat);
              if (p1.Distance(p2) > 1e-6) {
                BRepBuilderAPI_MakeEdge edgeMaker(p1, p2);
                if (edgeMaker.IsDone()) {
                  FlatBendEdge fbe;
                  fbe.edge     = edgeMaker.Edge();
                  fbe.angleDeg = std::abs(rec.theta) * 180.0 / M_PI;
                  fbe.isUp     = (rec.theta >= 0.0);
                  flatBendEdges.push_back(std::move(fbe));
                }
              }
            } else {
              std::vector<gp_Pnt> verts;
              for (TopExp_Explorer vx(rec.originalEdge, TopAbs_VERTEX); vx.More(); vx.Next()) {
                verts.push_back(BRep_Tool::Pnt(TopoDS::Vertex(vx.Current())).Transformed(toFlat));
              }
              if (verts.size() >= 2 && verts[0].Distance(verts[1]) > 1e-6) {
                BRepBuilderAPI_MakeEdge edgeMaker(verts[0], verts[1]);
                if (edgeMaker.IsDone()) {
                  FlatBendEdge fbe;
                  fbe.edge     = edgeMaker.Edge();
                  fbe.angleDeg = std::abs(rec.theta) * 180.0 / M_PI;
                  fbe.isUp     = (rec.theta >= 0.0);
                  flatBendEdges.push_back(std::move(fbe));
                }
              }
            }
          } catch (...) {}
        }
      }

      // Attempt non-destructive curved-bend reconstruction for preview.
      std::string improvedId;
      try {
        improvedId = buildImprovedFoldedLocked(shellId, val.nominalThickness);
      } catch (...) {}

      UnfoldId id = generateUUID();
      UnfoldState state;
      state.id              = id;
      state.sourceShellId   = shellId;
      state.flatWidthMm     = flatW;
      state.flatHeightMm    = flatH;
      state.kFactorUsed     = kFactor;
      state.bendCount       = bendCount;
      state.flatPanelShapes = std::move(flatPanelShapes);
      state.flatBendEdges   = std::move(flatBendEdges);
      state.origin2d        = gp_Pnt2d(uMin, vMin);
      state.improvedPartId  = improvedId;
      s_.unfolds[id]        = std::move(state);

      return UnfoldResult{id, flatW, flatH, kFactor, bendCount, true, val.nominalThickness, token, {}, improvedId};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_UNFOLD_FAILED",
                          std::string("Unfold exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  DxfExportResult exportDxf(const UnfoldId& unfoldId) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    auto it = s_.unfolds.find(unfoldId);
    if (it == s_.unfolds.end()) {
      throw GeometryError("GE_UNFOLD_NOT_FOUND",
                          "Unfold not found: " + unfoldId, false, "");
    }

    const UnfoldState& state = it->second;

    // ── DXF header ─────────────────────────────────────────────────────────────
    std::ostringstream dxf;
    dxf << "  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n"
        << "  0\nSECTION\n  2\nTABLES\n"
        << "  0\nTABLE\n  2\nLTYPE\n 70\n1\n"
        << "  0\nLTYPE\n  2\nCONTINUOUS\n 70\n0\n  3\nSolid line\n"
        <<   " 72\n65\n 73\n0\n 40\n0.0\n"
        << "  0\nLTYPE\n  2\nDASHED\n 70\n0\n"
        <<   "  3\nDashed line __ __ __ __ __\n 72\n65\n 73\n2\n 40\n6.35\n"
        <<   " 49\n3.175\n 49\n-3.175\n"
        << "  0\nENDTAB\n"
        << "  0\nTABLE\n  2\nLAYER\n 70\n4\n"
        << "  0\nLAYER\n  2\n0\n 70\n0\n 62\n7\n  6\nCONTINUOUS\n"
        << "  0\nLAYER\n  2\nCUT\n 70\n0\n 62\n1\n  6\nCONTINUOUS\n"
        << "  0\nLAYER\n  2\nBEND_UP\n 70\n0\n 62\n3\n  6\nDASHED\n"
        << "  0\nLAYER\n  2\nBEND_DOWN\n 70\n0\n 62\n4\n  6\nDASHED\n"
        << "  0\nENDTAB\n"
        << "  0\nENDSEC\n"
        << "  0\nSECTION\n  2\nENTITIES\n";

    int entityCount = 0;

    // ── Helpers ────────────────────────────────────────────────────────────────
    auto emitEdge = [&](const TopoDS_Edge& edge, const std::string& layer) {
      Standard_Real first, last;
      Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, first, last);
      if (curve.IsNull() || std::abs(last - first) < 1e-12) return;

      if (curve->IsKind(STANDARD_TYPE(Geom_Line))) {
        gp_Pnt p1 = curve->Value(first);
        gp_Pnt p2 = curve->Value(last);
        dxf << "  0\nLINE\n  8\n" << layer << "\n"
            << " 10\n" << p1.X() << "\n 20\n" << p1.Y() << "\n 30\n0.0\n"
            << " 11\n" << p2.X() << "\n 21\n" << p2.Y() << "\n 31\n0.0\n";
        ++entityCount;

      } else if (curve->IsKind(STANDARD_TYPE(Geom_Circle))) {
        Handle(Geom_Circle) circ = Handle(Geom_Circle)::DownCast(curve);
        gp_Pnt   center = circ->Location();
        double   radius = circ->Radius();
        double   span   = std::abs(last - first);
        bool     full   = (span >= 2.0 * M_PI - 1e-6);

        if (full) {
          dxf << "  0\nCIRCLE\n  8\n" << layer << "\n"
              << " 10\n" << center.X() << "\n 20\n" << center.Y() << "\n 30\n0.0\n"
              << " 40\n" << radius << "\n";
          ++entityCount;
        } else {
          gp_Dir xDir = circ->Circ().XAxis().Direction();
          double phiX = std::atan2(xDir.Y(), xDir.X()) * 180.0 / M_PI;
          double sa   = phiX + first * 180.0 / M_PI;
          double ea   = phiX + last  * 180.0 / M_PI;
          auto norm360 = [](double a) {
            while (a <   0.0) a += 360.0;
            while (a >= 360.0) a -= 360.0;
            return a;
          };
          sa = norm360(sa); ea = norm360(ea);
          dxf << "  0\nARC\n  8\n" << layer << "\n"
              << " 10\n" << center.X() << "\n 20\n" << center.Y() << "\n 30\n0.0\n"
              << " 40\n" << radius << "\n 50\n" << sa << "\n 51\n" << ea << "\n";
          ++entityCount;
        }

      } else {
        const int kSeg = 64;
        gp_Pnt2d prev;
        for (int s = 0; s <= kSeg; ++s) {
          double   t = first + (last - first) * s / kSeg;
          gp_Pnt   p = curve->Value(t);
          if (s > 0) {
            dxf << "  0\nLINE\n  8\n" << layer << "\n"
                << " 10\n" << prev.X() << "\n 20\n" << prev.Y() << "\n 30\n0.0\n"
                << " 11\n" << p.X()    << "\n 21\n" << p.Y()    << "\n 31\n0.0\n";
            ++entityCount;
          }
          prev = gp_Pnt2d(p.X(), p.Y());
        }
      }
    };

    struct BendLine { gp_Pnt start; gp_Pnt end; gp_Vec dir; double len; };
    std::vector<BendLine> bendLines;
    for (const auto& fbe : state.flatBendEdges) {
      Standard_Real bf, bl;
      Handle(Geom_Curve) bc = BRep_Tool::Curve(fbe.edge, bf, bl);
      if (bc.IsNull()) continue;
      gp_Pnt bStart = bc->Value(bf);
      gp_Pnt bEnd   = bc->Value(bl);
      gp_Vec bDir(bStart, bEnd);
      double bLen = bDir.Magnitude();
      if (bLen < 1e-10) continue;
      bDir /= bLen;
      bendLines.push_back({bStart, bEnd, bDir, bLen});
    }

    auto isBendEdge = [&](const TopoDS_Edge& e) -> bool {
      Standard_Real ef, el;
      Handle(Geom_Curve) ec = BRep_Tool::Curve(e, ef, el);
      if (ec.IsNull()) return false;
      gp_Pnt mid3d = ec->Value((ef + el) * 0.5);
      gp_Pnt mid(mid3d.X(), mid3d.Y(), 0.0);
      for (const auto& bl : bendLines) {
        gp_Vec toMid(bl.start, mid);
        double proj = toMid.Dot(bl.dir);
        if (proj < -1.0 || proj > bl.len + 1.0) continue;
        gp_Vec perp = toMid - bl.dir * proj;
        if (perp.Magnitude() < 1.0) return true;
      }
      return false;
    };

    // ── CUT layer ──────────────────────────────────────────────────────────────
    {
      for (const auto& panelShape : state.flatPanelShapes) {
        if (panelShape.IsNull()) continue;
        TopExp_Explorer eExp(panelShape, TopAbs_EDGE);
        for (; eExp.More(); eExp.Next()) {
          const TopoDS_Edge& edge = TopoDS::Edge(eExp.Current());
          if (isBendEdge(edge)) continue;
          emitEdge(edge, "CUT");
        }
      }
    }

    // ── BEND_UP / BEND_DOWN layers ─────────────────────────────────────────────
    {
      auto quantize = [](double v) -> int { return static_cast<int>(std::round(v * 100.0)); };
      std::set<std::tuple<int,int,int>> emittedBends;

      for (const auto& fbe : state.flatBendEdges) {
        Standard_Real bf, bl;
        Handle(Geom_Curve) bc = BRep_Tool::Curve(fbe.edge, bf, bl);
        if (bc.IsNull()) continue;

        gp_Pnt pS = bc->Value(bf);
        gp_Pnt pE = bc->Value(bl);

        double mx = (pS.X() + pE.X()) * 0.5;
        double my = (pS.Y() + pE.Y()) * 0.5;
        auto   key = std::make_tuple(
            static_cast<int>(std::round(mx * 100.0)),
            static_cast<int>(std::round(my * 100.0)), 0);
        if (!emittedBends.insert(key).second) continue;

        const std::string& layer = fbe.isUp ? "BEND_UP" : "BEND_DOWN";

        dxf << "  0\nLINE\n  8\n" << layer << "\n"
            << " 10\n" << pS.X() << "\n 20\n" << pS.Y() << "\n 30\n0.0\n"
            << " 11\n" << pE.X() << "\n 21\n" << pE.Y() << "\n 31\n0.0\n";
        ++entityCount;

        double dx  = pE.X() - pS.X();
        double dy  = pE.Y() - pS.Y();
        double len = std::hypot(dx, dy);
        if (len > 1e-5) { dx /= len; dy /= len; } else { dx = 1.0; dy = 0.0; }
        double tx = mx - dy * 3.0;
        double ty = my + dx * 3.0;

        std::string label = (std::ostringstream()
            << std::fixed << std::setprecision(1)
            << fbe.angleDeg << "%%d " << (fbe.isUp ? "UP" : "DOWN")).str();

        dxf << "  0\nTEXT\n  8\n" << layer << "\n"
            << " 10\n" << tx << "\n 20\n" << ty << "\n 30\n0.0\n"
            << " 40\n2.5\n  1\n" << label << "\n";
        ++entityCount;
      }
    }

    dxf << "  0\nENDSEC\n  0\nEOF\n";

    return DxfExportResult{dxf.str(), entityCount,
                           state.flatWidthMm, state.flatHeightMm};
  }

  DxfSheetResult buildSheetFromDxf(const std::string& dxfContent) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (dxfContent.empty()) {
      throw GeometryError("GE_INVALID_DXF", "DXF content is empty.", false, "");
    }

    std::vector<std::string> lines;
    {
      std::istringstream in(dxfContent);
      std::string line;
      while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
      }
    }

    std::vector<std::pair<double, double>> vertices;
    bool inPolyline = false;
    bool isLayer0 = false;
    bool hasPendingX = false;
    double pendingX = 0.0;

    for (size_t i = 0; i + 1 < lines.size(); i += 2) {
      int code = 0;
      try {
        code = std::stoi(lines[i]);
      } catch (...) {
        continue;
      }
      const std::string& value = lines[i + 1];

      if (code == 0) {
        if (inPolyline && value != "LWPOLYLINE") {
          if (isLayer0 && vertices.size() >= 3) break;
          vertices.clear();
        }
        inPolyline = (value == "LWPOLYLINE");
        isLayer0 = false;
        hasPendingX = false;
        continue;
      }

      if (!inPolyline) continue;

      if (code == 8) {
        isLayer0 = (value == "0");
      } else if (code == 10) {
        try {
          pendingX = std::stod(value);
          hasPendingX = true;
        } catch (...) {
          hasPendingX = false;
        }
      } else if (code == 20 && hasPendingX) {
        try {
          double y = std::stod(value);
          vertices.push_back({pendingX, y});
        } catch (...) {
          // Ignore malformed vertex pair
        }
        hasPendingX = false;
      }
    }

    if (vertices.size() < 3) {
      throw GeometryError(
          "GE_INVALID_DXF",
          "DXF must contain a layer-0 LWPOLYLINE with at least 3 vertices.",
          false,
          "");
    }

    try {
      BRepBuilderAPI_MakeWire wireMaker;

      for (size_t i = 0; i < vertices.size(); ++i) {
        const auto& a = vertices[i];
        const auto& b = vertices[(i + 1) % vertices.size()];
        if (std::abs(a.first - b.first) < 1e-9 && std::abs(a.second - b.second) < 1e-9) continue;
        TopoDS_Edge edge = BRepBuilderAPI_MakeEdge(
            gp_Pnt(a.first, a.second, 0.0),
            gp_Pnt(b.first, b.second, 0.0));
        wireMaker.Add(edge);
      }

      if (!wireMaker.IsDone()) {
        throw GeometryError("GE_INVALID_DXF", "Failed to build wire from DXF polyline.", false, "");
      }

      TopoDS_Wire wire = wireMaker.Wire();
      BRepBuilderAPI_MakeFace faceMaker(wire);
      if (!faceMaker.IsDone()) {
        throw GeometryError("GE_INVALID_DXF", "Failed to build planar face from DXF wire.", false, "");
      }

      TopoDS_Face face = faceMaker.Face();
      BRep_Builder builder;
      TopoDS_Shell shell;
      builder.MakeShell(shell);
      builder.Add(shell, face);

      ShellId sheetId = generateUUID();
      s_.shells[sheetId] = ShellState{sheetId, "", shell};
      return DxfSheetResult{sheetId};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_INVALID_DXF",
                          std::string("DXF build failed: ") + e.GetMessageString(),
                          false,
                          "");
    }
  }

  std::vector<uint8_t> exportGlb(const ShellId& shellId) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    TopoDS_Shape shape;
    {
      auto shellIt = s_.shells.find(shellId);
      auto solidIt = s_.solids.find(shellId);
      if (shellIt != s_.shells.end()) {
        shape = shellIt->second.shape;
      } else if (solidIt != s_.solids.end()) {
        shape = solidIt->second.shape;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND",
                            "Shell/solid not found: " + shellId, false, "");
      }
    }

    // Tessellate: 0.5 mm chord deviation, 0.3 rad angular deviation, parallel
    BRepMesh_IncrementalMesh mesher(shape, 0.5, Standard_False, 0.3, Standard_True);
    mesher.Perform();

    std::vector<float> positions;
    std::vector<float> normals;

    float minX =  std::numeric_limits<float>::max();
    float minY =  std::numeric_limits<float>::max();
    float minZ =  std::numeric_limits<float>::max();
    float maxX = -std::numeric_limits<float>::max();
    float maxY = -std::numeric_limits<float>::max();
    float maxZ = -std::numeric_limits<float>::max();

    TopExp_Explorer faceExp(shape, TopAbs_FACE);
    for (; faceExp.More(); faceExp.Next()) {
      const TopoDS_Face& face = TopoDS::Face(faceExp.Current());
      bool reversed = (face.Orientation() == TopAbs_REVERSED);

      TopLoc_Location loc;
      Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
      if (tri.IsNull() || tri->NbTriangles() == 0) continue;

      gp_Trsf trsf = locationToTrsf(loc);

      for (int t = 1; t <= tri->NbTriangles(); ++t) {
        int n1, n2, n3;
        tri->Triangle(t).Get(n1, n2, n3);
        if (reversed) std::swap(n2, n3);

        gp_Pnt p1 = tri->Node(n1).Transformed(trsf);
        gp_Pnt p2 = tri->Node(n2).Transformed(trsf);
        gp_Pnt p3 = tri->Node(n3).Transformed(trsf);

        gp_Vec edge1(p1, p2);
        gp_Vec edge2(p1, p3);
        gp_Vec faceNormal = edge1.Crossed(edge2);
        double mag = faceNormal.Magnitude();
        if (mag > 1e-12) faceNormal /= mag;

        auto addVertex = [&](const gp_Pnt& p) {
          float x = static_cast<float>(p.X() * 0.001);
          float y = static_cast<float>(p.Y() * 0.001);
          float z = static_cast<float>(p.Z() * 0.001);
          positions.push_back(x); positions.push_back(y); positions.push_back(z);
          normals.push_back(static_cast<float>(faceNormal.X()));
          normals.push_back(static_cast<float>(faceNormal.Y()));
          normals.push_back(static_cast<float>(faceNormal.Z()));
          minX = std::min(minX, x); maxX = std::max(maxX, x);
          minY = std::min(minY, y); maxY = std::max(maxY, y);
          minZ = std::min(minZ, z); maxZ = std::max(maxZ, z);
        };

        addVertex(p1); addVertex(p2); addVertex(p3);
      }
    }

    if (positions.empty()) {
      throw GeometryError("GE_MESH_EMPTY",
                          "No triangles produced for shell: " + shellId,
                          true, "clean_geometry");
    }

    int vertexCount = static_cast<int>(positions.size()) / 3;

    // ── Build binary chunk ──────────────────────────────────────────────────────
    auto floatsToBytes = [](const std::vector<float>& v) -> std::vector<uint8_t> {
      std::vector<uint8_t> b(v.size() * sizeof(float));
      std::memcpy(b.data(), v.data(), b.size());
      return b;
    };
    auto pad4 = [](std::vector<uint8_t>& v, uint8_t fill = 0) {
      while (v.size() % 4) v.push_back(fill);
    };

    std::vector<uint8_t> posBytes = floatsToBytes(positions);
    std::vector<uint8_t> norBytes = floatsToBytes(normals);
    pad4(posBytes); pad4(norBytes);

    size_t posOffset = 0;
    size_t norOffset = posBytes.size();

    std::vector<uint8_t> binChunk;
    binChunk.insert(binChunk.end(), posBytes.begin(), posBytes.end());
    binChunk.insert(binChunk.end(), norBytes.begin(), norBytes.end());
    pad4(binChunk);

    // ── Build JSON chunk ────────────────────────────────────────────────────────

    std::ostringstream json;
    json << std::fixed << std::setprecision(8);
    json << "{"
         << "\"asset\":{\"version\":\"2.0\",\"generator\":\"mcp-cad\"},"
         << "\"scene\":0,"
         << "\"scenes\":[{\"nodes\":[0]}],"
         << "\"nodes\":[{\"mesh\":0}],"
         << "\"meshes\":[{\"primitives\":[{"
         <<   "\"attributes\":{\"POSITION\":0,\"NORMAL\":1},"
         <<   "\"mode\":4"
         << "}]}],"
         << "\"accessors\":["
         <<   "{\"bufferView\":0,\"componentType\":5126,\"count\":" << vertexCount
         <<    ",\"type\":\"VEC3\","
         <<    "\"min\":[" << minX << "," << minY << "," << minZ << "],"
         <<    "\"max\":[" << maxX << "," << maxY << "," << maxZ << "]},"
         <<   "{\"bufferView\":1,\"componentType\":5126,\"count\":" << vertexCount
         <<    ",\"type\":\"VEC3\"}"
         << "],"
         << "\"bufferViews\":["
         <<   "{\"buffer\":0,\"byteOffset\":" << posOffset
         <<    ",\"byteLength\":" << posBytes.size() << ",\"target\":34962},"
         <<   "{\"buffer\":0,\"byteOffset\":" << norOffset
         <<    ",\"byteLength\":" << norBytes.size() << ",\"target\":34962}"
         << "],"
         << "\"buffers\":[{\"byteLength\":" << binChunk.size() << "}]"
         << "}";

    std::string jsonStr = json.str();
    std::vector<uint8_t> jsonBytes(jsonStr.begin(), jsonStr.end());
    pad4(jsonBytes, 0x20);  // GLB spec: pad JSON chunk with spaces (0x20)

    // ── Assemble GLB ────────────────────────────────────────────────────────────

    uint32_t totalLen = 12u
                      + 8u + static_cast<uint32_t>(jsonBytes.size())
                      + 8u + static_cast<uint32_t>(binChunk.size());

    std::vector<uint8_t> glb;
    glb.reserve(totalLen);

    auto writeU32 = [&](uint32_t v) {
      glb.push_back( v        & 0xFF);
      glb.push_back((v >>  8) & 0xFF);
      glb.push_back((v >> 16) & 0xFF);
      glb.push_back((v >> 24) & 0xFF);
    };

    writeU32(0x46546C67u);  // magic 'glTF'
    writeU32(2u);            // version
    writeU32(totalLen);

    writeU32(static_cast<uint32_t>(jsonBytes.size()));
    writeU32(0x4E4F534Au);  // chunk type 'JSON'
    glb.insert(glb.end(), jsonBytes.begin(), jsonBytes.end());

    writeU32(static_cast<uint32_t>(binChunk.size()));
    writeU32(0x004E4942u);  // chunk type 'BIN\0'
    glb.insert(glb.end(), binChunk.begin(), binChunk.end());

    return glb;
  }

private:
  ShellId buildImprovedFoldedLocked(const ShellId& sourceId, double t) {
    TopoDS_Shape originalShape;
    if (auto sit = s_.shells.find(sourceId); sit != s_.shells.end()) {
      originalShape = sit->second.shape;
    } else if (auto it = s_.solids.find(sourceId); it != s_.solids.end()) {
      originalShape = it->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Source not found: " + sourceId, false, "");
    }

    auto edgesAreParallel = [](const TopoDS_Edge& e1, const TopoDS_Edge& e2) -> bool {
      Standard_Real f1, l1, f2, l2;
      Handle(Geom_Curve) c1 = BRep_Tool::Curve(e1, f1, l1);
      Handle(Geom_Curve) c2 = BRep_Tool::Curve(e2, f2, l2);
      if (!c1.IsNull() && !c2.IsNull()) {
        gp_Pnt p1, p2; gp_Vec v1, v2;
        c1->D1((f1+l1)*0.5, p1, v1);
        c2->D1((f2+l2)*0.5, p2, v2);
        if (v1.Magnitude() > 1e-10) v1.Normalize();
        if (v2.Magnitude() > 1e-10) v2.Normalize();
        return std::abs(v1.Dot(v2)) >= 0.95;
      }
      return true;
    };

    auto edgeMidpoint = [](const TopoDS_Edge& edge) -> gp_Pnt {
      Standard_Real f, l;
      Handle(Geom_Curve) c = BRep_Tool::Curve(edge, f, l);
      if (!c.IsNull()) return c->Value((f + l) * 0.5);
      TopExp_Explorer ve(edge, TopAbs_VERTEX);
      if (ve.More()) return BRep_Tool::Pnt(TopoDS::Vertex(ve.Current()));
      return gp_Pnt(0, 0, 0);
    };

    auto averageNormal = [](const TopoDS_Face& f1, const TopoDS_Face& f2) -> gp_Vec {
      gp_Vec n1 = faceOutwardNormal(f1);
      gp_Vec n2 = faceOutwardNormal(f2);
      gp_Vec nSum = n1 + n2;
      if (nSum.Magnitude() > 1e-10) nSum.Normalize();
      return nSum;
    };

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

    struct PFI { TopoDS_Face face; gp_Pnt center; gp_Vec normal; bool matched = false; };
    std::vector<PFI> pfis;
    for (const auto& pair : planarFacesWithArea) {
      pfis.push_back({pair.first, faceCenter(pair.first), faceOutwardNormal(pair.first), false});
    }

    int N = static_cast<int>(pfis.size());
    for (int i = 0; i < N; ++i) {
      if (pfis[i].matched) continue;
      int bestJ = -1; double minDist = 1e30;
      for (int j = i + 1; j < N; ++j) {
        if (pfis[j].matched) continue;
        if (pfis[i].normal.Dot(pfis[j].normal) >= -0.95) continue;
        gp_Vec diff(pfis[i].center, pfis[j].center);
        double d = std::abs(diff.Dot(pfis[i].normal));
        double projDist = (diff - pfis[i].normal * diff.Dot(pfis[i].normal)).Magnitude();
        if (d >= 0.7 * t && d <= 1.3 * t && projDist < minDist) {
          minDist = projDist; bestJ = j;
        }
      }
      if (bestJ != -1) { pfis[i].matched = true; pfis[bestJ].matched = true; }
    }

    auto minLocalDim = [](const TopoDS_Face& f, double thickness) -> bool {
      Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
      if (surf.IsNull() || !surf->IsKind(STANDARD_TYPE(Geom_Plane))) return false;
      Handle(Geom_Plane) plane = Handle(Geom_Plane)::DownCast(surf);
      gp_Ax3 pos = plane->Pln().Position();
      gp_Dir dX = pos.XDirection(), dY = pos.YDirection();
      double uMin=1e30, uMax=-1e30, vMin=1e30, vMax=-1e30; bool any=false;
      for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        gp_Vec v(pos.Location(), p);
        double u = v.Dot(gp_Vec(dX)), vv = v.Dot(gp_Vec(dY));
        uMin=std::min(uMin,u); uMax=std::max(uMax,u);
        vMin=std::min(vMin,vv); vMax=std::max(vMax,vv); any=true;
      }
      return any && std::min(uMax-uMin, vMax-vMin) >= 2.5 * thickness;
    };

    std::set<std::string> matchedIds;
    for (const auto& p : pfis)
      if (p.matched && minLocalDim(p.face, t)) matchedIds.insert(shapeId(p.face));

    struct SharpEdge { TopoDS_Edge edge; gp_Pnt mid; gp_Vec avgNormal; TopoDS_Face f1, f2; };
    std::vector<SharpEdge> sharpEdges;
    TopTools_IndexedDataMapOfShapeListOfShape efMap;
    TopExp::MapShapesAndAncestors(originalShape, TopAbs_EDGE, TopAbs_FACE, efMap);
    for (int i = 1; i <= efMap.Extent(); ++i) {
      const TopoDS_Edge& edge = TopoDS::Edge(efMap.FindKey(i));
      const TopTools_ListOfShape& faces = efMap(i);
      if (faces.Extent() != 2) continue;
      TopoDS_Face f1 = TopoDS::Face(faces.First()), f2 = TopoDS::Face(faces.Last());
      if (!matchedIds.count(shapeId(f1)) || !matchedIds.count(shapeId(f2))) continue;
      Handle(Geom_Surface) s1 = BRep_Tool::Surface(f1), s2 = BRep_Tool::Surface(f2);
      if (s1.IsNull() || !s1->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
      if (s2.IsNull() || !s2->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
      gp_Vec n1 = faceOutwardNormal(f1), n2 = faceOutwardNormal(f2);
      double angle = std::acos(std::clamp(n1.Dot(n2), -1.0, 1.0)) * 180.0 / M_PI;
      if (angle >= 30.0 && angle <= 150.0) {
        sharpEdges.push_back({edge, edgeMidpoint(edge), averageNormal(f1, f2), f1, f2});
      }
    }

    int S = static_cast<int>(sharpEdges.size());
    std::vector<bool> matched(S, false);
    std::vector<std::pair<int,int>> pairs;
    for (int i = 0; i < S; ++i) {
      if (matched[i]) continue;
      for (int j = i+1; j < S; ++j) {
        if (matched[j]) continue;
        double d = sharpEdges[i].mid.Distance(sharpEdges[j].mid);
        if (d >= 0.7*t && d <= 1.3*t && edgesAreParallel(sharpEdges[i].edge, sharpEdges[j].edge)) {
          pairs.push_back({i, j}); matched[i] = true; matched[j] = true; break;
        }
      }
    }

    if (pairs.empty())
      throw GeometryError("GE_NO_BENDS", "No bend pairs found — no improved part needed", false, "");

    BRepFilletAPI_MakeFillet filletMaker(originalShape);
    for (const auto& pr : pairs) {
      int idxI = pr.first, idxE = pr.second;
      gp_Vec diff(sharpEdges[idxI].mid, sharpEdges[idxE].mid);
      if (diff.Dot(sharpEdges[idxI].avgNormal) <= 0) std::swap(idxI, idxE);
      filletMaker.Add(t,       sharpEdges[idxI].edge);
      filletMaker.Add(2.0 * t, sharpEdges[idxE].edge);
    }

    filletMaker.Build();
    if (!filletMaker.IsDone())
      throw GeometryError("GE_UNFOLD_REBUILD_FAILED", "Fillet failed for improved part", true, "");

    TopoDS_Shape result = filletMaker.Shape();
    BRepCheck_Analyzer checker(result);
    if (!checker.IsValid())
      throw GeometryError("GE_UNFOLD_REBUILD_FAILED", "Fillet output invalid for improved part", true, "");

    ShellId newId = sourceId + "_improved";
    s_.shells[newId] = ShellState{newId, "", result};
    return newId;
  }

  GeometryState& s_;
};

// ─── GeometryServiceImpl delegation stubs ─────────────────────────────────────

UnfoldResult GeometryServiceImpl::unfoldShell(const ShellId& shellId, double kFactor) {
  return GeometryExport(state_).unfoldShell(shellId, kFactor);
}
DxfExportResult GeometryServiceImpl::exportDxf(const UnfoldId& unfoldId) {
  return GeometryExport(state_).exportDxf(unfoldId);
}
DxfSheetResult GeometryServiceImpl::buildSheetFromDxf(const std::string& dxfContent) {
  return GeometryExport(state_).buildSheetFromDxf(dxfContent);
}
std::vector<uint8_t> GeometryServiceImpl::exportGlb(const ShellId& shellId) {
  return GeometryExport(state_).exportGlb(shellId);
}

} // namespace mcp_cad
