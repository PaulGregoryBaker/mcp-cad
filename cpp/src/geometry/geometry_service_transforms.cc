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

class GeometryTransforms {
public:
  explicit GeometryTransforms(GeometryState& s) : s_(s) {}

  TransformResult translateBody(const ShellId& solidId, double dx, double dy, double dz, bool keepOriginal) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    gp_Vec vec(dx, dy, dz);
    gp_Trsf trsf;
    trsf.SetTranslation(vec);
    return applyTransformLocked(solidId, trsf, keepOriginal, "translate_body");
  }

  TransformResult rotateBody(const ShellId& solidId, double axisPointX, double axisPointY, double axisPointZ, double axisDirX, double axisDirY, double axisDirZ, double angleDeg, bool keepOriginal) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    gp_Pnt pivot(axisPointX, axisPointY, axisPointZ);
    gp_Dir dir(axisDirX, axisDirY, axisDirZ);
    gp_Ax1 axis(pivot, dir);
    double angleRad = angleDeg * M_PI / 180.0;
    gp_Trsf trsf;
    trsf.SetRotation(axis, angleRad);
    return applyTransformLocked(solidId, trsf, keepOriginal, "rotate_body");
  }

  TransformResult mirrorBody(const ShellId& solidId, double planeOriginX, double planeOriginY, double planeOriginZ, double planeNormalX, double planeNormalY, double planeNormalZ, bool keepOriginal) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    gp_Pnt origin(planeOriginX, planeOriginY, planeOriginZ);
    gp_Dir normal(planeNormalX, planeNormalY, planeNormalZ);
    gp_Ax2 plane(origin, normal);
    gp_Trsf trsf;
    trsf.SetMirror(plane);
    return applyTransformLocked(solidId, trsf, keepOriginal, "mirror_body");
  }

  TransformResult scaleBody(const ShellId& solidId, double originX, double originY, double originZ, double scaleFactor, bool keepOriginal) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    if (scaleFactor <= 0.0) {
      throw GeometryError("GE_SCALE_NON_UNIFORM", "Scale factor must be greater than zero", true, "");
    }
    gp_Pnt center(originX, originY, originZ);
    gp_Trsf trsf;
    trsf.SetScale(center, scaleFactor);
    return applyTransformLocked(solidId, trsf, keepOriginal, "scale_body");
  }

  TransformResult alignToFace(const std::string& sourceFaceId, const std::string& destFaceId, bool flipNormal, bool keepOriginal) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    try {
      TopoDS_Shape srcShape = lookupEntityLocked(sourceFaceId);
      TopoDS_Shape dstShape = lookupEntityLocked(destFaceId);
      if (srcShape.ShapeType() != TopAbs_FACE || dstShape.ShapeType() != TopAbs_FACE) {
        throw GeometryError("GE_ALIGN_UNSUPPORTED", "Both inputs must be faces for alignment", true, "");
      }
      const TopoDS_Face& srcFace = TopoDS::Face(srcShape);
      const TopoDS_Face& dstFace = TopoDS::Face(dstShape);

      Handle(Geom_Surface) srcSurf = BRep_Tool::Surface(srcFace);
      Handle(Geom_Surface) dstSurf = BRep_Tool::Surface(dstFace);
      if (srcSurf.IsNull() || !srcSurf->IsKind(STANDARD_TYPE(Geom_Plane)) ||
          dstSurf.IsNull() || !dstSurf->IsKind(STANDARD_TYPE(Geom_Plane))) {
        throw GeometryError("GE_ALIGN_UNSUPPORTED", "Both faces must be planar for face alignment", true, "");
      }
      Handle(Geom_Plane) srcPlane = Handle(Geom_Plane)::DownCast(srcSurf);
      Handle(Geom_Plane) dstPlane = Handle(Geom_Plane)::DownCast(dstSurf);

      gp_Ax3 srcAx3 = srcPlane->Position();
      gp_Ax3 dstAx3 = dstPlane->Position();

      if (flipNormal) {
        dstAx3.ZReverse();
      }

      gp_Trsf trsf;
      trsf.SetTransformation(srcAx3, dstAx3);

      ShellId parentId = findParentShellIdLocked(sourceFaceId);
      return applyTransformLocked(parentId, trsf, keepOriginal, "align_to_face");

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during align: ") + e.GetMessageString(),
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

  TransformResult applyTransformLocked(const ShellId& solidId, const gp_Trsf& trsf, bool keepOriginal, const std::string& opName) {
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = s_.shells.find(solidId);
    auto solidIt = s_.solids.find(solidId);
    if (shellIt != s_.shells.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      originalShape = solidIt->second.shape;
      isSolid = true;
    } else {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell/solid not found: " + solidId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before " + opName + " on " + solidId);

    try {
      BRepBuilderAPI_Transform transformer(originalShape, trsf, Standard_True);
      transformer.Build();
      if (!transformer.IsDone()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Transform failed", true, "rollback");
      }

      TopoDS_Shape transformedShape = transformer.Shape();
      BRepCheck_Analyzer checker(transformedShape);
      if (!checker.IsValid()) {
        throw GeometryError("GE_BOOLEAN_FAILURE", "Transformed shape is invalid", true, "rollback");
      }

      auto history = captureHistory(transformer, originalShape, [](const TopoDS_Shape& s) { return shapeId(s); }, opName);

      if (!keepOriginal) {
        if (isSolid) {
          s_.solids.erase(solidId);
        } else {
          s_.shells.erase(solidId);
        }
      }

      ShellId resultId = generateUUID();
      if (isSolid) {
        s_.solids[resultId] = SolidState{resultId, transformedShape};
      } else {
        s_.shells[resultId] = ShellState{resultId, "", transformedShape};
      }

      return TransformResult{resultId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during transform: ") + e.GetMessageString(),
                          true, "rollback");
    }
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

  ShellId findParentShellIdLocked(const std::string& subShapeId) const {
    for (const auto& kv : s_.shells) {
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
    for (const auto& kv : s_.solids) {
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

  GeometryState& s_;
};

// ─── Delegation stubs ────────────────────────────────────────────────────────

TransformResult GeometryServiceImpl::translateBody(const ShellId& solidId, double dx, double dy, double dz, bool keepOriginal) {
  return GeometryTransforms(state_).translateBody(solidId, dx, dy, dz, keepOriginal);
}

TransformResult GeometryServiceImpl::rotateBody(const ShellId& solidId, double axOriginX, double axOriginY, double axOriginZ, double axDirX, double axDirY, double axDirZ, double angleDeg, bool keepOriginal) {
  return GeometryTransforms(state_).rotateBody(solidId, axOriginX, axOriginY, axOriginZ, axDirX, axDirY, axDirZ, angleDeg, keepOriginal);
}

TransformResult GeometryServiceImpl::mirrorBody(const ShellId& solidId, double plOriginX, double plOriginY, double plOriginZ, double plNormX, double plNormY, double plNormZ, bool keepOriginal) {
  return GeometryTransforms(state_).mirrorBody(solidId, plOriginX, plOriginY, plOriginZ, plNormX, plNormY, plNormZ, keepOriginal);
}

TransformResult GeometryServiceImpl::scaleBody(const ShellId& solidId, double originX, double originY, double originZ, double scaleFactor, bool keepOriginal) {
  return GeometryTransforms(state_).scaleBody(solidId, originX, originY, originZ, scaleFactor, keepOriginal);
}

TransformResult GeometryServiceImpl::alignToFace(const std::string& sourceFaceId, const std::string& destFaceId, bool flipNormal, bool keepOriginal) {
  return GeometryTransforms(state_).alignToFace(sourceFaceId, destFaceId, flipNormal, keepOriginal);
}

} // namespace mcp_cad
