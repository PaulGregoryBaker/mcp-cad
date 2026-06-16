/**
 * geometry_service_assembly.cc — Assembly document operations.
 *
 * Contains: createAssemblyDocument, addAssemblyInstance, mateRigid,
 *           listAssemblyTree (delegated from GeometryServiceImpl).
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

#include <TDF_LabelSequence.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>

namespace mcp_cad {

class GeometryAssembly {
public:
  explicit GeometryAssembly(GeometryState& s) : s_(s) {}

  CreateAssemblyResult createAssemblyDocument() {
    std::lock_guard<std::mutex> lock(s_.mutex);
    SnapshotId token = s_.createSnapshot("before createAssemblyDocument");

    try {
      Handle(TDocStd_Document) doc;
      s_.app->NewDocument("BinXCAF", doc);

      Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
      TDF_Label assemblyLabel = shapeTool->NewShape();
      AssemblyId assemblyId = generateUUID();
      s_.assemblies[assemblyId] = AssemblyState{assemblyId, doc, shapeTool, assemblyLabel, {}};

      return CreateAssemblyResult{assemblyId};
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during create assembly: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  AddInstanceResult addAssemblyInstance(const AssemblyId& assemblyId, const std::string& targetShapeId, double tx, double ty, double tz, double qw, double qx, double qy, double qz) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.assemblies.find(assemblyId);
    if (it == s_.assemblies.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Assembly document not found: " + assemblyId, false, "");
    }

    TopoDS_Shape targetShape;
    auto shellIt = s_.shells.find(targetShapeId);
    auto solidIt = s_.solids.find(targetShapeId);
    if (shellIt != s_.shells.end()) {
      targetShape = shellIt->second.shape;
    } else if (solidIt != s_.solids.end()) {
      targetShape = solidIt->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Target shape not found for assembly instance: " + targetShapeId, false, "");
    }

    SnapshotId token = s_.createSnapshot("before addAssemblyInstance in " + assemblyId);

    try {
      TDF_Label defLabel = it->second.shapeTool->AddShape(targetShape, Standard_False, Standard_False);

      gp_Trsf trsf;
      gp_Quaternion q(qx, qy, qz, qw);
      gp_Vec t(tx, ty, tz);
      trsf.SetRotation(q);
      trsf.SetTranslation(t);
      TopLoc_Location loc(trsf);

      TDF_Label compLabel = it->second.shapeTool->AddComponent(it->second.assemblyLabel, defLabel, loc);
      it->second.shapeTool->UpdateAssemblies();

      ComponentId compId = generateUUID();
      it->second.components[compId] = compLabel;

      return AddInstanceResult{compId};
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during add instance: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  MateRigidResult mateRigid(const AssemblyId& assemblyId, const std::string& srcEntityId, const std::string& dstEntityId, bool flipAlignment) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.assemblies.find(assemblyId);
    if (it == s_.assemblies.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Assembly document not found: " + assemblyId, false, "");
    }

    TopoDS_Shape srcFaceShape = lookupEntityIn(s_, srcEntityId);
    TopoDS_Shape dstFaceShape = lookupEntityIn(s_, dstEntityId);
    if (srcFaceShape.ShapeType() != TopAbs_FACE || dstFaceShape.ShapeType() != TopAbs_FACE) {
      throw GeometryError("GE_ASSEMBLY_MATE_UNSUPPORTED", "Mated entities must be faces", true, "");
    }

    const TopoDS_Face& srcFace = TopoDS::Face(srcFaceShape);
    const TopoDS_Face& dstFace = TopoDS::Face(dstFaceShape);
    Handle(Geom_Surface) srcSurf = BRep_Tool::Surface(srcFace);
    Handle(Geom_Surface) dstSurf = BRep_Tool::Surface(dstFace);
    if (srcSurf.IsNull() || !srcSurf->IsKind(STANDARD_TYPE(Geom_Plane)) ||
        dstSurf.IsNull() || !dstSurf->IsKind(STANDARD_TYPE(Geom_Plane))) {
      throw GeometryError("GE_ASSEMBLY_MATE_UNSUPPORTED", "Mated faces must be planar", true, "");
    }

    SnapshotId token = s_.createSnapshot("before mateRigid in " + assemblyId);

    try {
      Handle(Geom_Plane) srcPlane = Handle(Geom_Plane)::DownCast(srcSurf);
      Handle(Geom_Plane) dstPlane = Handle(Geom_Plane)::DownCast(dstSurf);

      gp_Ax3 srcAx3 = srcPlane->Position();
      gp_Ax3 dstAx3 = dstPlane->Position();
      if (flipAlignment) {
        dstAx3.ZReverse();
      }

      gp_Trsf trsf;
      trsf.SetTransformation(srcAx3, dstAx3);

      ShellId srcParentId = findParentShellIdIn(s_, srcEntityId);
      TopoDS_Shape parentShape = lookupEntityIn(s_, srcParentId);
      TDF_Label parentDefLabel;
      TDF_Label compLabel;
      ComponentId compId = "";
      if (it->second.shapeTool->FindShape(parentShape, parentDefLabel)) {
        for (const auto& kv : it->second.components) {
          TDF_Label refLabel;
          if (XCAFDoc_ShapeTool::GetReferredShape(kv.second, refLabel)) {
            if (refLabel.IsEqual(parentDefLabel)) {
              compLabel = kv.second;
              compId = kv.first;
              break;
            }
          }
        }
      }

      if (compLabel.IsNull()) {
        throw GeometryError("GE_ASSEMBLY_MATE_UNSUPPORTED", "Mated component not found in assembly", true, "");
      }

      TopLoc_Location currentLoc;
      Handle(XCAFDoc_Location) locAttr;
      if (compLabel.FindAttribute(XCAFDoc_Location::GetID(), locAttr)) {
        currentLoc = locAttr->Get();
      }
      gp_Trsf currentTrsf = currentLoc.Transformation();
      gp_Trsf newTrsf = trsf * currentTrsf;
      XCAFDoc_Location::Set(compLabel, TopLoc_Location(newTrsf));
      it->second.shapeTool->UpdateAssemblies();

      LocationMatrix locMat;
      locMat.m = {
        newTrsf.Value(1,1), newTrsf.Value(2,1), newTrsf.Value(3,1), 0.0,
        newTrsf.Value(1,2), newTrsf.Value(2,2), newTrsf.Value(3,2), 0.0,
        newTrsf.Value(1,3), newTrsf.Value(2,3), newTrsf.Value(3,3), 0.0,
        newTrsf.Value(1,4), newTrsf.Value(2,4), newTrsf.Value(3,4), 1.0
      };

      return MateRigidResult{compId, locMat, token};
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_ASSEMBLY_MATE_UNSUPPORTED",
                          std::string("OCCT exception during mate: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  ListAssemblyResult listAssemblyTree(const AssemblyId& assemblyId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.assemblies.find(assemblyId);
    if (it == s_.assemblies.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Assembly document not found: " + assemblyId, false, "");
    }

    try {
      TDF_LabelSequence roots;
      it->second.shapeTool->GetFreeShapes(roots);

      std::function<AssemblyNode(const TDF_Label&)> buildNode = [&](const TDF_Label& label) -> AssemblyNode {
        AssemblyNode node;

        TopoDS_Shape shape;
        if (it->second.shapeTool->GetShape(label, shape)) {
          node.shapeId = shapeId(shape);
        }

        ComponentId compId = "";
        for (const auto& kv : it->second.components) {
          if (kv.second.IsEqual(label)) {
            compId = kv.first;
            break;
          }
        }
        node.componentId = compId;

        TopLoc_Location loc;
        Handle(XCAFDoc_Location) locAttr;
        if (label.FindAttribute(XCAFDoc_Location::GetID(), locAttr)) {
          loc = locAttr->Get();
        }
        gp_Trsf trsf = loc.Transformation();
        node.locationMatrix = {
          trsf.Value(1,1), trsf.Value(2,1), trsf.Value(3,1), 0.0,
          trsf.Value(1,2), trsf.Value(2,2), trsf.Value(3,2), 0.0,
          trsf.Value(1,3), trsf.Value(2,3), trsf.Value(3,3), 0.0,
          trsf.Value(1,4), trsf.Value(2,4), trsf.Value(3,4), 1.0
        };

        TDF_LabelSequence children;
        it->second.shapeTool->GetComponents(label, children);
        for (Standard_Integer i = 1; i <= children.Length(); ++i) {
          node.children.push_back(buildNode(children.Value(i)));
        }

        return node;
      };

      ListAssemblyResult result;
      result.assemblyId = assemblyId;
      result.root.componentId = "";
      result.root.shapeId = assemblyId;
      result.root.locationMatrix = {
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0
      };

      for (Standard_Integer i = 1; i <= roots.Length(); ++i) {
        TDF_Label rLabel = roots.Value(i);
        if (rLabel.IsEqual(it->second.assemblyLabel)) {
          TDF_LabelSequence children;
          it->second.shapeTool->GetComponents(rLabel, children);
          for (Standard_Integer j = 1; j <= children.Length(); ++j) {
            result.root.children.push_back(buildNode(children.Value(j)));
          }
        } else {
          result.root.children.push_back(buildNode(rLabel));
        }
      }
      return result;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during list assembly: ") + e.GetMessageString(),
                          false, "");
    }
  }

private:
  GeometryState& s_;
};

// ─── Delegation stubs ────────────────────────────────────────────────────────

CreateAssemblyResult GeometryServiceImpl::createAssemblyDocument() {
  return GeometryAssembly(state_).createAssemblyDocument();
}

AddInstanceResult GeometryServiceImpl::addAssemblyInstance(const AssemblyId& assemblyId, const std::string& shapeId, double tx, double ty, double tz, double qw, double qx, double qy, double qz) {
  return GeometryAssembly(state_).addAssemblyInstance(assemblyId, shapeId, tx, ty, tz, qw, qx, qy, qz);
}

MateRigidResult GeometryServiceImpl::mateRigid(const AssemblyId& assemblyId, const std::string& srcEntityId, const std::string& dstEntityId, bool flipAlignment) {
  return GeometryAssembly(state_).mateRigid(assemblyId, srcEntityId, dstEntityId, flipAlignment);
}

ListAssemblyResult GeometryServiceImpl::listAssemblyTree(const AssemblyId& assemblyId) {
  return GeometryAssembly(state_).listAssemblyTree(assemblyId);
}

}  // namespace mcp_cad
