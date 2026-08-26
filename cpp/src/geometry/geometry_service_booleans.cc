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

class GeometryBooleans {
public:
  explicit GeometryBooleans(GeometryState& s) : s_(s) {}

  // fuseBodies (ShellId-based whole-solid fuse) was removed 2026-08-26 —
  // see geometry_service.hpp's own removal note.

  CutResult cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto blankIt = s_.shells.find(blank);
    if (blankIt == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Blank shell not found: " + blank, false, "");
    }
    TopoDS_Shape blankShape = blankIt->second.shape;

    std::vector<TopoDS_Shape> toolShapes;
    for (const auto& id : tools) {
      auto it = s_.shells.find(id);
      if (it == s_.shells.end()) {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Tool shell not found: " + id, false, "");
      }
      toolShapes.push_back(it->second.shape);
    }

    SnapshotId token = s_.createSnapshot("before cutBodies on " + blank);

    try {
      TopoDS_Shape currentShape = blankShape;
      std::vector<ShapeHistoryRecord> history;

      for (const auto& toolShape : toolShapes) {
        BRepAlgoAPI_Cut cutter(currentShape, toolShape);
        cutter.Build();
        if (!cutter.IsDone()) {
          throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean cut failed", true, "rollback");
        }

        TopoDS_Shape nextShape = cutter.Shape();
        BRepCheck_Analyzer checker(nextShape);
        if (!checker.IsValid()) {
          throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean cut result is invalid", true, "rollback");
        }

        auto h1 = captureHistory(cutter, currentShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "cut_bodies");
        auto h2 = captureHistory(cutter, toolShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "cut_bodies");
        history.insert(history.end(), h1.begin(), h1.end());
        history.insert(history.end(), h2.begin(), h2.end());

        currentShape = nextShape;
      }

      s_.shells.erase(blank);
      if (!keepTools) {
        for (const auto& id : tools) {
          s_.shells.erase(id);
        }
      }

      ShellId resultId = generateUUID();
      s_.shells[resultId] = ShellState{resultId, "", currentShape};

      return CutResult{resultId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during cut: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  IntersectResult intersectBodies(const ShellId& a, const ShellId& b) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto itA = s_.shells.find(a);
    if (itA == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell A not found: " + a, false, "");
    }
    auto itB = s_.shells.find(b);
    if (itB == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell B not found: " + b, false, "");
    }

    TopoDS_Shape shapeA = itA->second.shape;
    TopoDS_Shape shapeB = itB->second.shape;

    SnapshotId token = s_.createSnapshot("before intersectBodies on " + a + " and " + b);

    try {
      BRepAlgoAPI_Common common(shapeA, shapeB);
      common.Build();
      if (!common.IsDone()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean intersection failed", true, "rollback");
      }

      TopoDS_Shape resultShape = common.Shape();
      BRepCheck_Analyzer checker(resultShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean intersection result is invalid", true, "rollback");
      }

      GProp_GProps volProps;
      BRepGProp::VolumeProperties(resultShape, volProps);
      if (std::abs(volProps.Mass()) < 1e-6) {
        throw GeometryError("GE_BOOLEAN_EMPTY_RESULT", "Boolean intersection result is empty", true, "rollback");
      }

      auto h1 = captureHistory(common, shapeA, [](const TopoDS_Shape& s) { return shapeId(s); }, "intersect_bodies");
      auto h2 = captureHistory(common, shapeB, [](const TopoDS_Shape& s) { return shapeId(s); }, "intersect_bodies");
      std::vector<ShapeHistoryRecord> history;
      history.insert(history.end(), h1.begin(), h1.end());
      history.insert(history.end(), h2.begin(), h2.end());

      s_.shells.erase(a);
      s_.shells.erase(b);

      ShellId resultId = generateUUID();
      s_.shells[resultId] = ShellState{resultId, "", resultShape};

      return IntersectResult{resultId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during intersect: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

private:
  GeometryState& s_;
};

// ─── Delegation stubs ────────────────────────────────────────────────────────

CutResult GeometryServiceImpl::cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools) {
  return GeometryBooleans(state_).cutBodies(blank, tools, keepTools);
}

IntersectResult GeometryServiceImpl::intersectBodies(const ShellId& a, const ShellId& b) {
  return GeometryBooleans(state_).intersectBodies(a, b);
}

} // namespace mcp_cad
