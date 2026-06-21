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
#include "geometry_service_utils.hpp"

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

  PanelThicknessResult measurePanelThickness(const ShellId& shellId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    ResolvedShape resolved = resolveShellOrSolidIn(s_, shellId, "Shell or solid not found: " + shellId);
    return mcp_cad::measurePanelThickness(resolved.shape);
  }

  CurvedRebuildResult reconstructCurvedBends(const ShellId& partId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    ResolvedShape resolved = resolveShellOrSolidIn(s_, partId, "Shell or solid not found: " + partId);
    TopoDS_Shape originalShape = resolved.shape;
    bool isSolid = resolved.isSolid;

    // Validate that it's sheet metal first
    SheetMetalValidationResult val = validateSheetMetalLocked(partId);
    if (!val.isValid) {
      throw GeometryError("GE_INVALID_SHEET_METAL", "Cannot reconstruct curved bends: Invalid sheet metal geometry.", false, "");
    }

    double t = val.nominalThickness;

    SnapshotId token = s_.createSnapshot("before reconstructCurvedBends on " + partId);

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
  SheetMetalValidationResult validateSheetMetalLocked(const ShellId& partId) {
    TopoDS_Shape shape;
    if (auto sit = s_.shells.find(partId); sit != s_.shells.end()) {
      shape = sit->second.shape;
    } else if (auto it = s_.solids.find(partId); it != s_.solids.end()) {
      shape = it->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Shell not found: " + partId, false, "");
    }
    return validateSheetMetalShape(shape);
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

PanelThicknessResult GeometryServiceImpl::measurePanelThickness(const ShellId& shellId) {
  return GeometryValidation(state_).measurePanelThickness(shellId);
}

}  // namespace mcp_cad
