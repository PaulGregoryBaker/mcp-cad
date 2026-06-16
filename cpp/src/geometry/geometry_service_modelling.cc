/**
 * GeometryModelling — direct-edit / modelling operations.
 *
 * Contains: filletEdges, chamferEdges, simplifyBody, healGeometryEx,
 *           offsetShape, deleteFace, sewFaces, closeGap,
 *           extendFaceToTarget, offsetFace, addFlange, ripEdge.
 *
 * This is the ONLY file in the project that includes OCCT headers for these
 * operations.  All OCCT exceptions are caught here and re-thrown as
 * GeometryError.
 */

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

#include <BRepTools_History.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>

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

class GeometryModelling {
public:
  explicit GeometryModelling(GeometryState& s) : s_(s) {}

  // ── All methods acquire the state lock at entry ───────────────────────────

  FilletResult filletEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double radiusMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before filletEdges on " + partId);

    try {
      BRepFilletAPI_MakeFillet filletMaker(originalShape);
      std::set<std::string> targetEdgeIds(edgeIds.begin(), edgeIds.end());
      int edgesAdded = 0;

      TopExp_Explorer exp(originalShape, TopAbs_EDGE);
      for (; exp.More(); exp.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(exp.Current());
        if (targetEdgeIds.count(shapeId(edge))) {
          filletMaker.Add(radiusMm, edge);
          edgesAdded++;
        }
      }

      if (edgesAdded == 0) {
        throw GeometryError("GE_FILLET_TOO_LARGE", "No matching edges found to fillet", true, "rollback");
      }

      filletMaker.Build();
      if (!filletMaker.IsDone()) {
        throw GeometryError("GE_FILLET_TOO_LARGE", "Fillet failed (radius may be too large)", true, "rollback");
      }

      TopoDS_Shape resultShape = filletMaker.Shape();
      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_FILLET_TOO_LARGE", "Fillet result is invalid (radius may be too large)", true, "rollback");
      }

      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      auto history = captureHistory(filletMaker, originalShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "fillet_edges");
      return FilletResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_FILLET_TOO_LARGE",
                          std::string("OCCT exception during fillet: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  ChamferResult chamferEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double distanceMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before chamferEdges on " + partId);

    try {
      BRepFilletAPI_MakeChamfer chamferMaker(originalShape);
      std::set<std::string> targetEdgeIds(edgeIds.begin(), edgeIds.end());
      int edgesAdded = 0;

      TopExp_Explorer exp(originalShape, TopAbs_EDGE);
      for (; exp.More(); exp.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(exp.Current());
        if (targetEdgeIds.count(shapeId(edge))) {
          chamferMaker.Add(distanceMm, edge);
          edgesAdded++;
        }
      }

      if (edgesAdded == 0) {
        throw GeometryError("GE_CHAMFER_TOO_LARGE", "No matching edges found to chamfer", true, "rollback");
      }

      chamferMaker.Build();
      if (!chamferMaker.IsDone()) {
        throw GeometryError("GE_CHAMFER_TOO_LARGE", "Chamfer failed (distance may be too large)", true, "rollback");
      }

      TopoDS_Shape resultShape = chamferMaker.Shape();
      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_CHAMFER_TOO_LARGE", "Chamfer result is invalid (distance may be too large)", true, "rollback");
      }

      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      auto history = captureHistory(chamferMaker, originalShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "chamfer_edges");
      return ChamferResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_CHAMFER_TOO_LARGE",
                          std::string("OCCT exception during chamfer: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  SimplifyResult simplifyBody(const ShellId& partId, bool unifyFaces, bool unifyEdges) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before simplifyBody on " + partId);

    try {
      ShapeUpgrade_UnifySameDomain unifier(originalShape, unifyEdges, unifyFaces);
      unifier.Build();
      TopoDS_Shape resultShape = unifier.Shape();

      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Simplify result shape is invalid", true, "rollback");
      }

      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      std::vector<ShapeHistoryRecord> history;
      Handle(BRepTools_History) unifHistory = unifier.History();
      if (!unifHistory.IsNull()) {
        TopExp_Explorer faceExp(originalShape, TopAbs_FACE);
        for (; faceExp.More(); faceExp.Next()) {
          const TopoDS_Shape& face = faceExp.Current();
          std::string origId = shapeId(face);
          if (origId.empty()) continue;

          if (unifHistory->IsRemoved(face)) {
            history.push_back(ShapeHistoryRecord{"deleted", origId, "", "simplify_body"});
          } else {
            const TopTools_ListOfShape& modified = unifHistory->Modified(face);
            for (TopTools_ListIteratorOfListOfShape itM(modified); itM.More(); itM.Next()) {
              std::string newId = shapeId(itM.Value());
              if (!newId.empty()) {
                history.push_back(ShapeHistoryRecord{"modified", origId, newId, "simplify_body"});
              }
            }
            const TopTools_ListOfShape& generated = unifHistory->Generated(face);
            for (TopTools_ListIteratorOfListOfShape itG(generated); itG.More(); itG.Next()) {
              std::string newId = shapeId(itG.Value());
              if (!newId.empty()) {
                history.push_back(ShapeHistoryRecord{"generated", origId, newId, "simplify_body"});
              }
            }
          }
        }
      }

      return SimplifyResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during simplify: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  HealExResult healGeometryEx(const ShellId& partId, bool fixTolerances, bool fixWires) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before healGeometryEx on " + partId);

    try {
      ShapeFix_Shape fixer(originalShape);
      fixer.Perform();
      TopoDS_Shape resultShape = fixer.Shape();

      BRepCheck_Analyzer checker(resultShape);
      bool healComplete = checker.IsValid();
      std::vector<std::string> remainingIssues;
      if (!healComplete) {
        remainingIssues.push_back("Result shape remains invalid under BRepCheck_Analyzer");
      }

      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      std::vector<ShapeHistoryRecord> history;
      Handle(BRepTools_ReShape) shapeFixHistory = fixer.Context();
      if (!shapeFixHistory.IsNull()) {
        TopExp_Explorer faceExp(originalShape, TopAbs_FACE);
        for (; faceExp.More(); faceExp.Next()) {
          const TopoDS_Shape& face = faceExp.Current();
          std::string origId = shapeId(face);
          if (origId.empty()) continue;

          TopoDS_Shape newFace = shapeFixHistory->Value(face);
          if (newFace.IsNull()) {
            history.push_back(ShapeHistoryRecord{"deleted", origId, "", "heal_geometry_ex"});
          } else if (!newFace.IsSame(face)) {
            history.push_back(ShapeHistoryRecord{"modified", origId, shapeId(newFace), "heal_geometry_ex"});
          }
        }
      }

      return HealExResult{partId, healComplete, remainingIssues, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_HEAL_INCOMPLETE",
                          std::string("OCCT exception during heal: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  OffsetShapeResult offsetShape(const ShellId& partId, double offsetValue, double tolerance) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before offsetShape on " + partId);

    try {
      BRepOffsetAPI_MakeOffsetShape maker;
      maker.PerformByJoin(originalShape, offsetValue, tolerance, BRepOffset_Skin);
      if (!maker.IsDone()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Offset operation failed to complete", true, "rollback");
      }
      TopoDS_Shape resultShape = maker.Shape();
      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Offset result is invalid", true, "rollback");
      }

      if (isSolid) {
        s_.solids[partId].shape = resultShape;
      } else {
        s_.shells[partId].shape = resultShape;
      }

      auto history = captureHistory(maker, originalShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "offset_shape");
      return OffsetShapeResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during offset: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  DeleteFaceResult deleteFace(const ShellId& partId, const std::vector<std::string>& faceIds, bool healRemaining) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(partId);
    auto solidIt = s_.solids.find(partId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before deleteFace on " + partId);

    try {
      std::set<std::string> facesToDelete(faceIds.begin(), faceIds.end());
      std::vector<TopoDS_Face> keptFaces;

      TopExp_Explorer exp(originalShape, TopAbs_FACE);
      for (; exp.More(); exp.Next()) {
        const TopoDS_Face& face = TopoDS::Face(exp.Current());
        if (facesToDelete.count(shapeId(face)) == 0) {
          keptFaces.push_back(face);
        }
      }

      if (keptFaces.empty()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Cannot delete all faces of the shell", true, "rollback");
      }

      TopoDS_Shape resultShape;
      if (healRemaining) {
        BRepBuilderAPI_Sewing sewer;
        sewer.Init();
        for (const auto& face : keptFaces) {
          sewer.Add(face);
        }
        sewer.Perform();
        resultShape = sewer.SewedShape();

        ShapeFix_Shape fixer(resultShape);
        fixer.Perform();
        resultShape = fixer.Shape();
      } else {
        BRep_Builder builder;
        TopoDS_Shell newShell;
        builder.MakeShell(newShell);
        for (const auto& face : keptFaces) {
          builder.Add(newShell, face);
        }
        resultShape = newShell;
      }

      std::vector<TopoDS_Shape> disconnectedShapes;
      if (resultShape.ShapeType() == TopAbs_COMPOUND) {
        TopExp_Explorer shellExp(resultShape, TopAbs_SHELL);
        for (; shellExp.More(); shellExp.Next()) {
          disconnectedShapes.push_back(shellExp.Current());
        }
        if (disconnectedShapes.empty()) {
          TopExp_Explorer faceExp(resultShape, TopAbs_FACE);
          if (faceExp.More()) {
            BRep_Builder builder;
            TopoDS_Shell newShell;
            builder.MakeShell(newShell);
            for (; faceExp.More(); faceExp.Next()) {
              builder.Add(newShell, TopoDS::Face(faceExp.Current()));
            }
            disconnectedShapes.push_back(newShell);
          }
        }
      } else {
        disconnectedShapes.push_back(resultShape);
      }

      if (isSolid) {
        s_.solids.erase(partId);
      } else {
        s_.shells.erase(partId);
      }

      std::vector<ShellId> solidIds;
      for (const auto& shape : disconnectedShapes) {
        ShellId newId = generateUUID();
        s_.shells[newId] = ShellState{newId, "", shape};
        solidIds.push_back(newId);
      }

      std::vector<ShapeHistoryRecord> history;
      for (const auto& faceId : faceIds) {
        history.push_back(ShapeHistoryRecord{"deleted", faceId, "", "delete_face"});
      }
      for (const auto& face : keptFaces) {
        std::string id = shapeId(face);
        history.push_back(ShapeHistoryRecord{"modified", id, id, "delete_face"});
      }

      return DeleteFaceResult{solidIds, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during delete face: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  SewResult sewFaces(const std::vector<std::string>& entityIds, double tolerance, bool makeSolid) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    SnapshotId token = createSnapshotLocked("before sewFaces");

    try {
      BRepBuilderAPI_Sewing sewer;
      sewer.Init();
      sewer.SetTolerance(tolerance);

      std::vector<TopoDS_Shape> inputShapes;
      for (const auto& id : entityIds) {
        TopoDS_Shape shape = lookupEntityLocked(id);
        sewer.Add(shape);
        inputShapes.push_back(shape);
      }

      sewer.Perform();
      TopoDS_Shape sewedShape = sewer.SewedShape();

      Standard_Integer nbFree = sewer.NbFreeEdges();
      std::vector<std::string> freeEdges;
      for (Standard_Integer i = 1; i <= nbFree; ++i) {
        TopoDS_Edge edge = TopoDS::Edge(sewer.FreeEdge(i));
        freeEdges.push_back(shapeId(edge));
      }
      bool sewComplete = (nbFree == 0);

      TopoDS_Shape finalShape = sewedShape;
      if (makeSolid && sewComplete) {
        if (finalShape.ShapeType() == TopAbs_SHELL) {
          BRepBuilderAPI_MakeSolid solidMaker(TopoDS::Shell(finalShape));
          if (solidMaker.IsDone()) {
            finalShape = solidMaker.Solid();
          }
        } else if (finalShape.ShapeType() == TopAbs_COMPOUND) {
          TopExp_Explorer shellExp(finalShape, TopAbs_SHELL);
          if (shellExp.More()) {
            BRepBuilderAPI_MakeSolid solidMaker(TopoDS::Shell(shellExp.Current()));
            if (solidMaker.IsDone()) {
              finalShape = solidMaker.Solid();
            }
          }
        }
      }

      // Remove inputs from session
      for (const auto& id : entityIds) {
        s_.shells.erase(id);
        s_.solids.erase(id);
      }

      ShellId resultId = generateUUID();
      if (finalShape.ShapeType() == TopAbs_SOLID) {
        s_.solids[resultId] = SolidState{resultId, finalShape};
      } else {
        s_.shells[resultId] = ShellState{resultId, "", finalShape};
      }

      // Capture history
      std::vector<ShapeHistoryRecord> history;
      for (const auto& inputShape : inputShapes) {
        TopExp_Explorer faceExp(inputShape, TopAbs_FACE);
        for (; faceExp.More(); faceExp.Next()) {
          const TopoDS_Shape& face = faceExp.Current();
          std::string origId = shapeId(face);
          if (origId.empty()) continue;

          if (sewer.IsModified(face)) {
            TopoDS_Shape newFace = sewer.Modified(face);
            if (!newFace.IsNull()) {
              history.push_back(ShapeHistoryRecord{"modified", origId, shapeId(newFace), "sew_faces"});
            }
          } else {
            history.push_back(ShapeHistoryRecord{"modified", origId, origId, "sew_faces"});
          }
        }
      }

      return SewResult{resultId, sewComplete, freeEdges, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_SEW_INCOMPLETE",
                          std::string("OCCT exception during sew: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  CloseGapResult closeGap(const ShellId& partAId, const ShellId& partBId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto itA = s_.shells.find(partAId);
    if (itA == s_.shells.end())
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    auto itB = s_.shells.find(partBId);
    if (itB == s_.shells.end())
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");

    const TopoDS_Shape& shapeA = itA->second.shape;
    const TopoDS_Shape& shapeB = itB->second.shape;

    BRepExtrema_DistShapeShape distCalc(shapeA, shapeB);
    if (!distCalc.IsDone())
      throw GeometryError("GE_CLOSE_GAP_FAILED", "Could not compute gap distance.", false, "");

    double gap = distCalc.Value();
    if (gap < 1e-6) {
      // Already touching — nothing to do; return part B unchanged.
      SnapshotId token = createSnapshotLocked("closeGap (no-op) on " + partBId);
      return CloseGapResult{partBId, 0.0, token};
    }

    // Find the closest point on A and the closest point on B.
    gp_Pnt pA = distCalc.PointOnShape1(1);
    gp_Pnt pB = distCalc.PointOnShape2(1);

    // Translate part B so its closest point lands exactly on A's closest point.
    gp_Vec translation(pB, pA);

    gp_Trsf move;
    move.SetTranslation(translation);
    BRepBuilderAPI_Transform xform(shapeB, move, /*copy=*/true);
    TopoDS_Shape movedB = xform.Shape();

    SnapshotId token = createSnapshotLocked("before closeGap on " + partBId);
    itB->second.shape = movedB;
    return CloseGapResult{partBId, gap, token};
  }

  // ── Extend face to target ─────────────────────────────────────────────────

  ExtendFaceResult extendFaceToTarget(const ShellId&      partId,
                                      const std::string&  faceId,
                                      const std::string&  targetType,
                                      const std::string&  targetPartId,
                                      const std::string&  targetFaceId,
                                      const CuttingPlane& targetPlane) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.shells.find(partId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before extendFaceToTarget on " + partId);

    try {
      // ── Resolve target shape early (needed for auto face-finding) ──────────
      TopoDS_Shape targetShape;
      if (targetType == "face_id" || targetType == "part_surface") {
        auto tIt = s_.shells.find(targetPartId);
        if (tIt == s_.shells.end()) {
          throw GeometryError("GE_SHELL_NOT_FOUND",
                              "Target part not found: " + targetPartId, false, "");
        }
        targetShape = tIt->second.shape;
        if (!targetFaceId.empty()) {
          for (TopExp_Explorer tExp(tIt->second.shape, TopAbs_FACE);
               tExp.More(); tExp.Next()) {
            if (shapeId(tExp.Current()) == targetFaceId) {
              targetShape = tExp.Current();
              break;
            }
          }
        }
      }

      // ── Find the face to extend ────────────────────────────────────────────
      TopoDS_Face face;
      if (faceId.empty()) {
        // Auto-select: the face closest to and most directly facing the target.
        if (targetShape.IsNull()) {
          throw GeometryError("GE_EXTEND_FAILED",
              "face_id is required when target_type is 'plane'", false, "");
        }
        Bnd_Box tBBox;
        BRepBndLib::AddOptimal(targetShape, tBBox);
        gp_Pnt targetCenter(0.0, 0.0, 0.0);
        if (!tBBox.IsVoid()) {
          Standard_Real txMin, txMax, tyMin, tyMax, tzMin, tzMax;
          tBBox.Get(txMin, tyMin, tzMin, txMax, tyMax, tzMax);
          targetCenter = gp_Pnt((txMin + txMax) * 0.5,
                                (tyMin + tyMax) * 0.5,
                                (tzMin + tzMax) * 0.5);
        }

        double bestScore = std::numeric_limits<double>::max();
        for (TopExp_Explorer fExp(it->second.shape, TopAbs_FACE);
             fExp.More(); fExp.Next()) {
          TopoDS_Face candidate = TopoDS::Face(fExp.Current());
          Handle(Geom_Surface) s = BRep_Tool::Surface(candidate);
          if (s.IsNull()) continue;
          Standard_Real cu1, cu2, cv1, cv2;
          BRepTools::UVBounds(candidate, cu1, cu2, cv1, cv2);
          gp_Pnt cCenter;
          gp_Vec cdu, cdv;
          s->D1((cu1 + cu2) * 0.5, (cv1 + cv2) * 0.5, cCenter, cdu, cdv);
          gp_Vec cNorm = cdu.Crossed(cdv);
          if (cNorm.Magnitude() < 1e-10) continue;
          cNorm.Normalize();
          // Respect face orientation — a REVERSED face has its outward normal
          // opposite to the surface parametrization direction.
          if (candidate.Orientation() == TopAbs_REVERSED) cNorm.Reverse();

          gp_Vec toTarget(cCenter, targetCenter);
          double toTargetMag = toTarget.Magnitude();
          if (toTargetMag < 1e-10) continue;
          toTarget /= toTargetMag;

          // Skip faces not pointing toward the target
          double dotScore = cNorm.Dot(toTarget);
          if (dotScore < 0.1) continue;

          BRepExtrema_DistShapeShape d;
          d.LoadS1(candidate);
          d.LoadS2(targetShape);
          d.Perform();
          if (!d.IsDone()) continue;
          // Skip faces already in contact with the target — their score would
          // be 0 and they would always beat the actual gap face.
          if (d.Value() < 1e-4) continue;

          // Score: dist / dotScore — favour near faces that face the target
          double score = d.Value() / dotScore;
          if (score < bestScore) {
            bestScore = score;
            face = candidate;
          }
        }
        if (face.IsNull()) {
          throw GeometryError("GE_EXTEND_FAILED",
              "No face on source part is facing the target", false, "");
        }
      } else {
        // Manual: locate face by ID
        bool found = false;
        for (TopExp_Explorer fExp(it->second.shape, TopAbs_FACE);
             fExp.More(); fExp.Next()) {
          if (shapeId(fExp.Current()) == faceId) {
            face = TopoDS::Face(fExp.Current());
            found = true;
            break;
          }
        }
        if (!found) {
          throw GeometryError("GE_EXTEND_FAILED", "Face not found: " + faceId, false, "");
        }
      }

      // ── Compute face normal at centroid ────────────────────────────────────
      Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
      if (surf.IsNull()) {
        throw GeometryError("GE_EXTEND_FAILED", "Face has null surface", false, "");
      }
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(face, u1, u2, v1, v2);
      gp_Pnt faceCenter;
      gp_Vec du, dv;
      surf->D1((u1 + u2) * 0.5, (v1 + v2) * 0.5, faceCenter, du, dv);
      gp_Vec faceNormal = du.Crossed(dv);
      if (faceNormal.Magnitude() < 1e-10) {
        throw GeometryError("GE_EXTEND_FAILED", "Cannot compute face normal", false, "");
      }
      faceNormal.Normalize();
      // Apply orientation so the normal points outward from the shell.
      if (face.Orientation() == TopAbs_REVERSED) faceNormal.Reverse();

      // ── Compute extension distance ─────────────────────────────────────────
      double extDist = 0.0;
      if (targetType == "plane") {
        gp_Vec tNorm(targetPlane.normalX, targetPlane.normalY, targetPlane.normalZ);
        double tNormLen = tNorm.Magnitude();
        if (tNormLen < 1e-10) {
          throw GeometryError("GE_EXTEND_FAILED", "Target plane normal is zero", false, "");
        }
        tNorm /= tNormLen;
        gp_Pnt tOrigin(targetPlane.originX, targetPlane.originY, targetPlane.originZ);
        gp_Vec toPlane(faceCenter, tOrigin);
        double denom = faceNormal.Dot(tNorm);
        if (std::abs(denom) < 1e-10) {
          throw GeometryError("GE_EXTEND_FAILED", "Face is parallel to target plane", false, "");
        }
        extDist = toPlane.Dot(tNorm) / denom;
      } else if (targetType == "face_id" || targetType == "part_surface") {
        BRepExtrema_DistShapeShape dist;
        dist.LoadS1(face);
        dist.LoadS2(targetShape);
        dist.Perform();
        if (!dist.IsDone()) {
          throw GeometryError("GE_EXTEND_FAILED", "Cannot compute distance to target", false, "");
        }
        // Project the closest point on the target onto the face normal direction.
        // Using raw dist.Value() can give zero when shapes share a corner or edge
        // even if the gap along the face normal is non-zero.
        if (dist.Value() > 1e-4) {
          extDist = dist.Value();
        } else {
          gp_Pnt closestPt = dist.PointOnShape2(1);
          extDist = gp_Vec(faceCenter, closestPt).Dot(faceNormal);
        }
      } else {
        throw GeometryError("GE_EXTEND_FAILED",
                            "Unknown targetType: " + targetType, false, "");
      }

      if (std::abs(extDist) < 1e-6) {
        return ExtendFaceResult{partId, 0.0, token, {}};
      }

      // Extrude face toward target and fuse with shell
      gp_Vec extVec = faceNormal * extDist;
      BRepPrimAPI_MakePrism prism(face, extVec);
      prism.Build();
      if (!prism.IsDone()) {
        throw GeometryError("GE_EXTEND_FAILED", "Face extrusion failed", true, "rollback");
      }

      TopoDS_Shape inputForHistory = it->second.shape;
      BRepAlgoAPI_Fuse fuse(it->second.shape, prism.Shape());
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_EXTEND_FAILED",
                            "Failed to fuse extension with shell", true, "rollback");
      }

      it->second.shape = fuse.Shape();
      auto history = captureHistory(fuse, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "extendFaceToTarget");
      return ExtendFaceResult{partId, std::abs(extDist), token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EXTEND_FAILED",
                          std::string("OCCT exception during extend: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Offset face ───────────────────────────────────────────────────────────

  OffsetFaceResult offsetFace(const ShellId&     partId,
                               const std::string& faceId,
                               double             distanceMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.shells.find(partId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }
    if (std::abs(distanceMm) < 1e-10) {
      throw GeometryError("GE_OFFSET_FAILED", "distanceMm must not be zero", false, "");
    }

    SnapshotId token = createSnapshotLocked("before offsetFace on " + partId);

    try {
      // Find the face
      TopoDS_Face face;
      bool found = false;
      TopExp_Explorer fExp(it->second.shape, TopAbs_FACE);
      for (; fExp.More(); fExp.Next()) {
        if (shapeId(fExp.Current()) == faceId) {
          face = TopoDS::Face(fExp.Current());
          found = true;
          break;
        }
      }
      if (!found) {
        throw GeometryError("GE_OFFSET_FAILED", "Face not found: " + faceId, false, "");
      }

      // Compute face normal
      Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
      if (surf.IsNull()) {
        throw GeometryError("GE_OFFSET_FAILED", "Face has null surface", false, "");
      }
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(face, u1, u2, v1, v2);
      gp_Pnt ctr; gp_Vec du, dv;
      surf->D1((u1 + u2) * 0.5, (v1 + v2) * 0.5, ctr, du, dv);
      gp_Vec faceNormal = du.Crossed(dv);
      if (faceNormal.Magnitude() < 1e-10) {
        throw GeometryError("GE_OFFSET_FAILED", "Cannot compute face normal", false, "");
      }
      faceNormal.Normalize();

      // Extrude face by distanceMm; fuse (positive) or cut (negative) with shell
      gp_Vec offsetVec = faceNormal * distanceMm;
      BRepPrimAPI_MakePrism prism(face, offsetVec);
      prism.Build();
      if (!prism.IsDone()) {
        throw GeometryError("GE_OFFSET_FAILED", "Face prism failed", true, "rollback");
      }

      TopoDS_Shape inputForHistory = it->second.shape;
      TopoDS_Shape result;
      std::vector<ShapeHistoryRecord> history;
      if (distanceMm > 0.0) {
        BRepAlgoAPI_Fuse fuse(it->second.shape, prism.Shape());
        fuse.Build();
        if (!fuse.IsDone() || fuse.Shape().IsNull()) {
          throw GeometryError("GE_OFFSET_FAILED",
                              "Face offset fuse failed", true, "rollback");
        }
        result = fuse.Shape();
        history = captureHistory(fuse, inputForHistory,
            [](const TopoDS_Shape& s) { return shapeId(s); }, "offsetFace");
      } else {
        BRepAlgoAPI_Cut cut(it->second.shape, prism.Shape());
        cut.Build();
        if (!cut.IsDone() || cut.Shape().IsNull()) {
          throw GeometryError("GE_OFFSET_FAILED",
                              "Face offset cut failed", true, "rollback");
        }
        result = cut.Shape();
        history = captureHistory(cut, inputForHistory,
            [](const TopoDS_Shape& s) { return shapeId(s); }, "offsetFace");
      }

      it->second.shape = result;
      return OffsetFaceResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_OFFSET_FAILED",
                          std::string("OCCT exception during offset: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Add flange ────────────────────────────────────────────────────────────

  AddFlangeResult addFlange(const ShellId&     partId,
                             const std::string& edgeId,
                             double             lengthMm,
                             double             angleDeg,
                             double             bendRadiusMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.shells.find(partId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }
    if (lengthMm <= 0.0) {
      throw GeometryError("GE_FLANGE_FAILED", "lengthMm must be positive", false, "");
    }
    if (angleDeg <= 0.0 || angleDeg > 180.0) {
      throw GeometryError("GE_FLANGE_FAILED", "angleDeg must be in (0, 180]", false, "");
    }
    if (bendRadiusMm <= 0.0) {
      throw GeometryError("GE_FLANGE_FAILED", "bendRadiusMm must be positive", false, "");
    }

    SnapshotId token = createSnapshotLocked("before addFlange on " + partId);

    try {
      // Find the edge
      TopoDS_Edge edge;
      bool found = false;
      TopExp_Explorer eExp(it->second.shape, TopAbs_EDGE);
      for (; eExp.More(); eExp.Next()) {
        if (shapeId(eExp.Current()) == edgeId) {
          edge = TopoDS::Edge(eExp.Current());
          found = true;
          break;
        }
      }
      if (!found) {
        throw GeometryError("GE_FLANGE_FAILED", "Edge not found: " + edgeId, false, "");
      }

      // Verify it's a boundary (free) edge
      TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
      TopExp::MapShapesAndAncestors(it->second.shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);
      if (!edgeToFaces.Contains(edge)) {
        throw GeometryError("GE_EDGE_NOT_OPEN", "Edge not found in shell topology", false, "");
      }
      const TopTools_ListOfShape& adjFaces = edgeToFaces.FindFromKey(edge);
      if (adjFaces.Extent() != 1) {
        throw GeometryError("GE_EDGE_NOT_OPEN",
                            "Edge is not a boundary edge; it has " +
                                std::to_string(adjFaces.Extent()) + " adjacent faces",
                            false, "");
      }

      // Get adjacent face normal
      const TopoDS_Face& adjFace = TopoDS::Face(adjFaces.First());
      Handle(Geom_Surface) surf = BRep_Tool::Surface(adjFace);
      if (surf.IsNull()) {
        throw GeometryError("GE_FLANGE_FAILED", "Adjacent face has null surface", false, "");
      }
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(adjFace, u1, u2, v1, v2);
      gp_Pnt ctr; gp_Vec du, dv;
      surf->D1((u1 + u2) * 0.5, (v1 + v2) * 0.5, ctr, du, dv);
      gp_Vec faceNormal = du.Crossed(dv);
      if (faceNormal.Magnitude() < 1e-10) {
        throw GeometryError("GE_FLANGE_FAILED", "Cannot compute adjacent face normal", false, "");
      }
      faceNormal.Normalize();

      // Get edge tangent at midpoint
      Standard_Real f, l;
      Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, f, l);
      if (curve.IsNull()) {
        throw GeometryError("GE_FLANGE_FAILED", "Edge has null curve", false, "");
      }
      gp_Pnt midPt; gp_Vec tangent;
      curve->D1((f + l) * 0.5, midPt, tangent);
      if (tangent.Magnitude() < 1e-10) {
        throw GeometryError("GE_FLANGE_FAILED", "Cannot compute edge tangent", false, "");
      }
      tangent.Normalize();

      // Outward direction perpendicular to face at the edge
      gp_Vec outward = faceNormal.Crossed(tangent);
      if (outward.Magnitude() < 1e-10) {
        throw GeometryError("GE_FLANGE_FAILED",
                            "Face normal is parallel to edge direction", false, "");
      }
      outward.Normalize();

      // Flange direction: rotate face normal by (PI - angleDeg) around tangent axis
      // At 90°: flange is perpendicular to face (standard flange)
      double angleRad = angleDeg * M_PI / 180.0;
      double cosA = std::cos(M_PI - angleRad);
      double sinA = std::sin(M_PI - angleRad);
      gp_Vec flangeDir = faceNormal * cosA + outward * (-sinA);

      // Build a wire from the edge and extrude it
      BRepBuilderAPI_MakeWire wireMaker;
      wireMaker.Add(edge);
      if (!wireMaker.IsDone()) {
        throw GeometryError("GE_FLANGE_FAILED", "Cannot build wire from edge", false, "");
      }

      gp_Vec extVec = flangeDir * lengthMm;
      BRepPrimAPI_MakePrism prism(wireMaker.Wire(), extVec);
      prism.Build();
      if (!prism.IsDone()) {
        throw GeometryError("GE_FLANGE_FAILED", "Flange prism extrusion failed", true, "rollback");
      }

      // Sew the flange panel onto the shell
      BRepBuilderAPI_Sewing sewing(1e-3);
      sewing.Add(it->second.shape);
      sewing.Add(prism.Shape());
      sewing.Perform();
      TopoDS_Shape sewedShape = sewing.SewedShape();
      if (sewedShape.IsNull()) {
        throw GeometryError("GE_FLANGE_FAILED",
                            "Sewing flange to shell produced null shape", true, "rollback");
      }

      it->second.shape = sewedShape;
      std::string flangeFeatureId = generateUUID();
      return AddFlangeResult{partId, flangeFeatureId, token, {}};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_FLANGE_FAILED",
                          std::string("OCCT exception during addFlange: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Rip edge ──────────────────────────────────────────────────────────────

  RipEdgeResult ripEdge(const ShellId&     partId,
                         const std::string& edgeId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.shells.find(partId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before ripEdge on " + partId);

    try {
      // Find the edge and confirm it is interior (shared by exactly 2 faces)
      TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
      TopExp::MapShapesAndAncestors(it->second.shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

      TopoDS_Edge edgeToRip;
      TopoDS_Face faceA, faceB;
      bool found = false;
      for (int i = 1; i <= edgeToFaces.Size(); ++i) {
        const TopoDS_Shape& key = edgeToFaces.FindKey(i);
        if (key.ShapeType() != TopAbs_EDGE) continue;
        if (shapeId(key) == edgeId) {
          edgeToRip = TopoDS::Edge(key);
          const TopTools_ListOfShape& faces = edgeToFaces.FindFromIndex(i);
          if (faces.Extent() < 2) {
            throw GeometryError("GE_EDGE_NOT_INTERIOR",
                                "Edge is a boundary edge; only interior edges can be ripped",
                                false, "");
          }
          faceA = TopoDS::Face(faces.First());
          faceB = TopoDS::Face(faces.Last());
          found = true;
          break;
        }
      }
      if (!found) {
        throw GeometryError("GE_RIP_FAILED", "Edge not found: " + edgeId, false, "");
      }

      // Strategy: replace the shared edge in faceA and faceB with separate edge copies
      // that reference the same underlying geometry but have distinct TShape objects.
      // This severs the topological link between the two faces at that edge.
      TopLoc_Location edgeLoc;
      Standard_Real firstParam, lastParam;
      Handle(Geom_Curve) edgeCurve =
          BRep_Tool::Curve(edgeToRip, edgeLoc, firstParam, lastParam);
      if (edgeCurve.IsNull()) {
        throw GeometryError("GE_RIP_FAILED", "Edge has no geometry", false, "");
      }

      BRep_Builder eb;
      TopoDS_Edge newEdgeForA, newEdgeForB;
      eb.MakeEdge(newEdgeForA, edgeCurve, edgeLoc, BRep_Tool::Tolerance(edgeToRip));
      eb.Range(newEdgeForA, firstParam, lastParam);
      eb.MakeEdge(newEdgeForB, edgeCurve, edgeLoc, BRep_Tool::Tolerance(edgeToRip));
      eb.Range(newEdgeForB, firstParam, lastParam);
      // Copy vertices
      TopExp_Explorer vExp(edgeToRip, TopAbs_VERTEX);
      for (int vi = 0; vExp.More(); vExp.Next(), ++vi) {
        eb.Add(newEdgeForA, vExp.Current());
        eb.Add(newEdgeForB, vExp.Current());
      }

      // Replace edge in each face separately
      BRepTools_ReShape reshapeA;
      reshapeA.Replace(edgeToRip.Oriented(TopAbs_FORWARD),
                       newEdgeForA.Oriented(TopAbs_FORWARD));
      reshapeA.Replace(edgeToRip.Oriented(TopAbs_REVERSED),
                       newEdgeForA.Oriented(TopAbs_REVERSED));
      TopoDS_Face newFaceA = TopoDS::Face(reshapeA.Apply(faceA));

      BRepTools_ReShape reshapeB;
      reshapeB.Replace(edgeToRip.Oriented(TopAbs_FORWARD),
                       newEdgeForB.Oriented(TopAbs_FORWARD));
      reshapeB.Replace(edgeToRip.Oriented(TopAbs_REVERSED),
                       newEdgeForB.Oriented(TopAbs_REVERSED));
      TopoDS_Face newFaceB = TopoDS::Face(reshapeB.Apply(faceB));

      // Replace the two faces in the shell
      BRepTools_ReShape reshapeShell;
      reshapeShell.Replace(faceA, newFaceA);
      reshapeShell.Replace(faceB, newFaceB);
      TopoDS_Shape result = reshapeShell.Apply(it->second.shape);

      if (result.IsNull()) {
        throw GeometryError("GE_RIP_FAILED",
                            "Rip produced null shape", true, "rollback");
      }

      it->second.shape = result;
      std::vector<ShapeHistoryRecord> history;
      history.push_back({"modified", shapeId(faceA), shapeId(newFaceA), "ripEdge"});
      history.push_back({"modified", shapeId(faceB), shapeId(newFaceB), "ripEdge"});
      return RipEdgeResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_RIP_FAILED",
                          std::string("OCCT exception during ripEdge: ") + e.GetMessageString(),
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

  TopoDS_Shape lookupEntityLocked(const std::string& entityId) const {
    auto solidIt = s_.solids.find(entityId);
    if (solidIt != s_.solids.end()) {
      return solidIt->second.shape;
    }
    auto shellIt = s_.shells.find(entityId);
    if (shellIt != s_.shells.end()) {
      return shellIt->second.shape;
    }
    for (const auto& kv : s_.solids) {
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
    for (const auto& kv : s_.shells) {
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

  GeometryState& s_;
};

// ─── GeometryServiceImpl delegation stubs ─────────────────────────────────────

FilletResult GeometryServiceImpl::filletEdges(const ShellId& partId,
                                               const std::vector<std::string>& edgeIds,
                                               double radiusMm) {
  return GeometryModelling(state_).filletEdges(partId, edgeIds, radiusMm);
}

ChamferResult GeometryServiceImpl::chamferEdges(const ShellId& partId,
                                                 const std::vector<std::string>& edgeIds,
                                                 double distanceMm) {
  return GeometryModelling(state_).chamferEdges(partId, edgeIds, distanceMm);
}

SimplifyResult GeometryServiceImpl::simplifyBody(const ShellId& partId,
                                                  bool unifyFaces, bool unifyEdges) {
  return GeometryModelling(state_).simplifyBody(partId, unifyFaces, unifyEdges);
}

HealExResult GeometryServiceImpl::healGeometryEx(const ShellId& partId,
                                                  bool fixTolerances, bool fixWires) {
  return GeometryModelling(state_).healGeometryEx(partId, fixTolerances, fixWires);
}

OffsetShapeResult GeometryServiceImpl::offsetShape(const ShellId& partId,
                                                    double offsetValue, double tolerance) {
  return GeometryModelling(state_).offsetShape(partId, offsetValue, tolerance);
}

DeleteFaceResult GeometryServiceImpl::deleteFace(const ShellId& partId,
                                                  const std::vector<std::string>& faceIds,
                                                  bool healRemaining) {
  return GeometryModelling(state_).deleteFace(partId, faceIds, healRemaining);
}

SewResult GeometryServiceImpl::sewFaces(const std::vector<std::string>& entityIds,
                                         double tolerance, bool makeSolid) {
  return GeometryModelling(state_).sewFaces(entityIds, tolerance, makeSolid);
}

CloseGapResult GeometryServiceImpl::closeGap(const ShellId& partAId, const ShellId& partBId) {
  return GeometryModelling(state_).closeGap(partAId, partBId);
}

ExtendFaceResult GeometryServiceImpl::extendFaceToTarget(const ShellId& partId,
                                                          const std::string& faceId,
                                                          const std::string& targetType,
                                                          const std::string& targetPartId,
                                                          const std::string& targetFaceId,
                                                          const CuttingPlane& targetPlane) {
  return GeometryModelling(state_).extendFaceToTarget(partId, faceId, targetType,
                                                       targetPartId, targetFaceId, targetPlane);
}

OffsetFaceResult GeometryServiceImpl::offsetFace(const ShellId& partId,
                                                  const std::string& faceId,
                                                  double distanceMm) {
  return GeometryModelling(state_).offsetFace(partId, faceId, distanceMm);
}

AddFlangeResult GeometryServiceImpl::addFlange(const ShellId& partId,
                                                const std::string& edgeId,
                                                double lengthMm, double angleDeg,
                                                double bendRadiusMm) {
  return GeometryModelling(state_).addFlange(partId, edgeId, lengthMm, angleDeg, bendRadiusMm);
}

RipEdgeResult GeometryServiceImpl::ripEdge(const ShellId& partId, const std::string& edgeId) {
  return GeometryModelling(state_).ripEdge(partId, edgeId);
}

}  // namespace mcp_cad
