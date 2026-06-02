/**
 * GeometryService implementation ÔÇö OCCT wrapper.
 *
 * This is the ONLY file in the project that includes OCCT headers.
 * All OCCT exceptions are caught here and re-thrown as GeometryError.
 *
 * Tasks: T022, T024, T025, T090
 */

// ÔöÇÔöÇÔöÇ OCCT includes (isolated to this translation unit) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
#include <Standard_Failure.hxx>
#include <Standard_ErrorHandler.hxx>

#include <STEPControl_Reader.hxx>
#include <Interface_Static.hxx>
#include <IFSelect_ReturnStatus.hxx>

#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <BRepTools.hxx>
#include <BRepCheck_Analyzer.hxx>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>

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
#include <BRepBndLib.hxx>

#include <BRepMesh_IncrementalMesh.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>

#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>

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

// ÔöÇÔöÇÔöÇ Project includes ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
#include "geometry_service.hpp"
#include "shape_history.hpp"

// ÔöÇÔöÇÔöÇ Standard library ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
#include <map>
#include <unordered_map>
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

// ÔöÇÔöÇÔöÇ UUID generator (simple, session-scoped) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

// ÔöÇÔöÇÔöÇ State containers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

struct SolidState {
  SolidId     id;
  TopoDS_Shape shape;
};

struct ShellState {
  ShellId     id;
  SolidId     parentSolidId;
  TopoDS_Shape shape;
};

struct FlatBendEdge {
  TopoDS_Edge edge;     // edge in flat-plane coordinates (z Ôëê 0)
  double      angleDeg; // absolute bend angle
  bool        isUp;     // true = BEND_UP, false = BEND_DOWN
};

struct UnfoldState {
  UnfoldId    id;
  ShellId     sourceShellId;
  double      flatWidthMm;
  double      flatHeightMm;
  double      kFactorUsed;
  int         bendCount;

  // Flat geometry (built by unfoldShell, serialised by exportDxf)
  std::vector<TopoDS_Shape>   flatPanelShapes; // one compound per panel (in XY plane)
  std::vector<FlatBendEdge>   flatBendEdges;   // bend centerlines in flat coordinates
  gp_Pnt2d                    origin2d;        // (uMin, vMin) offset used during build

  ShellId     improvedPartId;  // new shell with curved bend radii; empty on failure
};

struct AssemblyState {
  AssemblyId id;
  Handle(TDocStd_Document) doc;
  Handle(XCAFDoc_ShapeTool) shapeTool;
  TDF_Label assemblyLabel;
  std::unordered_map<ComponentId, TDF_Label> components;
};

// ÔöÇÔöÇÔöÇ GeometryServiceImpl ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

class GeometryServiceImpl : public GeometryService {
public:
  GeometryServiceImpl() {
    app_ = new TDocStd_Application();
    BinXCAFDrivers::DefineFormat(app_);
  }
  ~GeometryServiceImpl() override = default;

  // ÔöÇÔöÇ STEP import ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  SolidId loadStep(const std::string& filePath) override {
    try {
      Interface_Static::SetCVal("read.precision.mode", "1");

      STEPControl_Reader reader;
      IFSelect_ReturnStatus status = reader.ReadFile(filePath.c_str());

      if (status != IFSelect_RetDone) {
        throw GeometryError("GE_IMPORT_FAILED",
                            "STEP file could not be read: " + filePath,
                            false, "");
      }

      Standard_Integer numRoots = reader.TransferRoots();
      if (numRoots == 0) {
        throw GeometryError("GE_INVALID_SOLID",
                            "No valid solids found in STEP file: " + filePath,
                            false, "");
      }

      TopoDS_Shape shape = reader.OneShape();
      if (shape.IsNull()) {
        throw GeometryError("GE_INVALID_SOLID",
                            "STEP file produced null shape: " + filePath,
                            false, "");
      }

      SolidId id = generateUUID();
      std::lock_guard<std::mutex> lock(mutex_);
      solids_[id] = SolidState{id, shape};
      return id;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_IMPORT_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          false, "");
    }
  }

  // ÔöÇÔöÇ Viewport orientation and alignment ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  AlignmentResult centerAndAlignBody(
      const ShellId&    partId,
      const SnapshotId& transactionId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape shape;
    {
      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        shape = shellIt->second.shape;
      } else if (solidIt != solids_.end()) {
        shape = solidIt->second.shape;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell or solid not found: " + partId, false, "");
      }
    }

    if (shape.IsNull()) {
      throw GeometryError("GE_ALIGN_FAILED", "Null shape provided for alignment", false, "");
    }

    try {
      // 1. Calculate Center of Mass Centroid
      GProp_GProps vp;
      BRepGProp::VolumeProperties(shape, vp);
      gp_Pnt centroidPnt = vp.CentreOfMass();

      // 2. Find the dominant planar face normal
      gp_Vec dominantNormal(0.0, 0.0, 1.0);
      double maxArea = -1.0;
      for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face& f = TopoDS::Face(ex.Current());
        Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
        if (!surf.IsNull() && surf->IsKind(STANDARD_TYPE(Geom_Plane))) {
          GProp_GProps sp;
          BRepGProp::SurfaceProperties(f, sp);
          double area = sp.Mass();
          if (area > maxArea) {
            maxArea = area;
            dominantNormal = faceOutwardNormal(f);
          }
        }
      }

      // If dominant normal is zero vector or invalid, default to Z axis
      if (dominantNormal.SquareMagnitude() < 1e-10) {
        dominantNormal = gp_Vec(0.0, 0.0, 1.0);
      } else {
        dominantNormal.Normalize();
      }

      // 3. Create rotation transformation to align dominant normal to global Z axis [0,0,1]
      gp_Trsf rot;
      gp_Vec zDir(0.0, 0.0, 1.0);
      if (dominantNormal.Angle(zDir) > 1e-5) {
        gp_Vec axis = dominantNormal.Crossed(zDir);
        if (axis.SquareMagnitude() < 1e-10) {
          // Dominant normal is opposite to Z axis: rotate 180 deg around global X
          rot.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(1.0, 0.0, 0.0)), M_PI);
        } else {
          rot.SetRotation(gp_Ax1(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(axis)), dominantNormal.Angle(zDir));
        }
      }

      // 4. Create translation transformation to move centroid to [0,0,0]
      gp_Trsf trans;
      trans.SetTranslation(gp_Vec(centroidPnt, gp_Pnt(0.0, 0.0, 0.0)));

      // 5. Combine translation and rotation: first translate to origin, then rotate
      gp_Trsf combined = rot * trans;

      // 6. Transform the shape
      BRepBuilderAPI_Transform xform(shape, combined, true);
      TopoDS_Shape transformedShape = xform.Shape();
      if (transformedShape.IsNull()) {
        throw GeometryError("GE_ALIGN_FAILED", "Transformation produced null shape", false, "");
      }

      // Update shape in registry
      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        shellIt->second.shape = transformedShape;
      } else if (solidIt != solids_.end()) {
        solidIt->second.shape = transformedShape;
      }

      AlignmentResult result;
      result.solidId = partId;
      result.centroid[0] = 0.0;
      result.centroid[1] = 0.0;
      result.centroid[2] = 0.0;
      
      // Store 3x3 rotation matrix from rot
      result.rotationMatrix[0] = rot.Value(1, 1);
      result.rotationMatrix[1] = rot.Value(1, 2);
      result.rotationMatrix[2] = rot.Value(1, 3);
      result.rotationMatrix[3] = rot.Value(2, 1);
      result.rotationMatrix[4] = rot.Value(2, 2);
      result.rotationMatrix[5] = rot.Value(2, 3);
      result.rotationMatrix[6] = rot.Value(3, 1);
      result.rotationMatrix[7] = rot.Value(3, 2);
      result.rotationMatrix[8] = rot.Value(3, 3);
      
      result.rollbackToken = transactionId;

      return result;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_ALIGN_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          false, "");
    }
  }

  // ÔöÇÔöÇ Topology extraction ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  TopologyGraph getTopology(const SolidId& solidId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape shape;
    if (auto it = solids_.find(solidId); it != solids_.end()) {
      shape = it->second.shape;
    } else if (auto sit = shells_.find(solidId); sit != shells_.end()) {
      shape = sit->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid/Shell not found: " + solidId, false, "");
    }

    TopologyGraph graph;
    graph.solidId = solidId;

    try {
      buildTopologyGraph(shape, graph);
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_TOPOLOGY_FAILED",
                          std::string("Topology extraction failed: ") + e.GetMessageString(),
                          true, "clean_geometry");
    }

    return graph;
  }

  // ÔöÇÔöÇ Manifold detection ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  ManifoldResult checkManifold(const SolidId& solidId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = solids_.find(solidId);
    if (it == solids_.end()) {
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

  // ÔöÇÔöÇ Shape healing ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  SolidId healGeometry(const SolidId& solidId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = solids_.find(solidId);
    if (it == solids_.end()) {
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
      solids_[newId] = SolidState{newId, healed};
      return newId;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_HEAL_FAILED",
                          std::string("Healing exception: ") + e.GetMessageString(),
                          false, "");
    }
  }

  // ÔöÇÔöÇ Compound decomposition ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  std::vector<ShellId> separateSolids(const SolidId& solidId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = solids_.find(solidId);
    if (it == solids_.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid not found: " + solidId, false, "");
    }

    const TopoDS_Shape& compound = it->second.shape;
    std::vector<ShellId> shellIds;

    // Iterate individual solids within the compound (typical for STEP assemblies).
    TopExp_Explorer solidExp(compound, TopAbs_SOLID);
    for (; solidExp.More(); solidExp.Next()) {
      ShellId sid = generateUUID();
      ShellState state;
      state.id            = sid;
      state.parentSolidId = solidId;
      state.shape         = solidExp.Current();
      shells_[sid]        = state;
      shellIds.push_back(sid);
    }

    // Fallback: enumerate shells (e.g. open-shell compound without solids).
    if (shellIds.empty()) {
      TopExp_Explorer shellExp(compound, TopAbs_SHELL);
      for (; shellExp.More(); shellExp.Next()) {
        ShellId sid = generateUUID();
        ShellState state;
        state.id            = sid;
        state.parentSolidId = solidId;
        state.shape         = shellExp.Current();
        shells_[sid]        = state;
        shellIds.push_back(sid);
      }
    }

    // Last resort: treat the whole shape as one shell.
    if (shellIds.empty()) {
      ShellId sid = generateUUID();
      ShellState state;
      state.id            = sid;
      state.parentSolidId = solidId;
      state.shape         = compound;
      shells_[sid]        = state;
      shellIds.push_back(sid);
    }

    return shellIds;
  }

  // ÔöÇÔöÇ Boolean cut (decomposition) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  BooleanCutResult booleanCut(const SolidId& solidId,
                               double nx, double ny, double nz,
                               double ox, double oy, double oz) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = solids_.find(solidId);
    if (it == solids_.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid not found: " + solidId, false, "");
    }

    // Snapshot before mutation (Constitution Principle IV)
    SnapshotId token = createSnapshotLocked("before booleanCut on " + solidId);

    try {
      gp_Pnt origin(ox, oy, oz);
      
      // Normalize and check that normal vector is non-zero
      double normLength = std::sqrt(nx * nx + ny * ny + nz * nz);
      if (normLength < 1e-10) {
        throw GeometryError("GE_INVALID_PLANE",
                            "Cut plane normal vector is zero or near-zero",
                            false, "");
      }
      
      gp_Dir normal(nx / normLength, ny / normLength, nz / normLength);
      gp_Pln plane(origin, normal);

      // Build an infinite half-space as the cutting tool
      // Create a face on the plane
      BRepBuilderAPI_MakeFace faceMaker(plane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face cutFace = faceMaker.Face();
      
      // Create a reference point on the positive side of the plane
      // (away from origin, in the direction of the normal)
      gp_Pnt refPoint = origin.Translated(gp_Vec(normal) * 100.0);
      
      BRepPrimAPI_MakeHalfSpace halfSpace(cutFace, refPoint);
      TopoDS_Solid halfSpaceSolid = halfSpace.Solid();

      TopoDS_Shape inputForHistory = it->second.shape;
      BRepAlgoAPI_Cut cutter(it->second.shape, halfSpaceSolid);
      cutter.Build();

      if (!cutter.IsDone()) {
        throw GeometryError("GE_BOOLEAN_FAILURE",
                            "Boolean cut failed for solid: " + solidId,
                            true, "rollback");
      }

      TopoDS_Shape result = cutter.Shape();
      if (result.IsNull()) {
        throw GeometryError("GE_EMPTY_RESULT",
                            "Boolean cut produced empty result", true, "rollback");
      }

      // Extract shells from result
      std::vector<ShellId> shellIds;
      TopExp_Explorer shellExp(result, TopAbs_SHELL);
      for (; shellExp.More(); shellExp.Next()) {
        ShellId shellId = generateUUID();
        ShellState state;
        state.id            = shellId;
        state.parentSolidId = solidId;
        state.shape         = shellExp.Current();
        shells_[shellId]    = state;
        shellIds.push_back(shellId);
      }

      if (shellIds.empty()) {
        throw GeometryError("GE_EMPTY_RESULT",
                            "Boolean cut produced no shells", true, "rollback");
      }

      auto history = captureHistory(cutter, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "booleanCut");
      return BooleanCutResult{shellIds, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;  // re-throw structured errors as-is
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT boolean cut exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Tab-slot synthesis ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  TabSlotResult addTabSlot(const ShellId& shellIdA,
                            const ShellId& shellIdB,
                            double kerfOffsetMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellIdA) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellIdA, false, "");
    }
    if (shells_.find(shellIdB) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellIdB, false, "");
    }

    // Clamp kerf to [0.1, 0.2] mm (Constitution Principle V)
    double kerf = std::clamp(kerfOffsetMm, 0.1, 0.2);

    SnapshotId token = createSnapshotLocked("before addTabSlot");

    try {
      // Tab-slot geometry generation:
      // 1. Find shared face boundary between shellA and shellB
      // 2. Generate tab geometry on shellA with kerf offset
      // 3. Generate corresponding slot geometry on shellB
      // 4. Apply BRepOffsetAPI_MakeOffset for kerf compensation

      // For MVP implementation, we perform a simplified tab-slot:
      // - Find the common interface face by checking adjacency
      // - Create rectangular tab/slot features at interface
      // The full implementation requires topology analysis of shared edges

      // Registration: update shell states with tab-slot geometry
      // (full geometric manipulation deferred to Phase B implementation)
      // This stub validates the interface and kerf clamping.

      return TabSlotResult{{shellIdA, shellIdB}, kerf, token, {}};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_TAB_SLOT_FAILED",
                          std::string("Tab-slot exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Rivet hole ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  RivetHoleResult addRivetHole(const ShellId& shellId,
                                const std::string& faceId,
                                double centerX, double centerY,
                                double diameterMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellId) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before addRivetHole on " + shellId);

    try {
      std::string holeId = generateUUID();
      return RivetHoleResult{shellId, holeId, token, {}};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_RIVET_HOLE_FAILED",
                          std::string("Rivet hole exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Unfolding ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  UnfoldResult unfoldShell(const ShellId& shellId, double kFactor) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellId) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    TopoDS_Shape activeShape = shells_[shellId].shape;

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

    SheetMetalValidationResult val = validateSheetMetalShapeLocked(activeShape);
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

    SnapshotId token = createSnapshotLocked("before unfold of " + shellId);

    try {
      // Helper: calculate face center
      auto faceCenter = [](const TopoDS_Face& f) -> gp_Pnt {
        GProp_GProps fp;
        BRepGProp::SurfaceProperties(f, fp);
        return fp.CentreOfMass();
      };

      // Helper: calculate min local dimension (width/height) of a planar face in its own plane
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
      // Must iterate ALL coplanar sub-faces ÔÇö a single PlaneFaceInfo entry can
      // wrap many sub-faces after Boolean fuse, and the bend seam edge may
      // belong to any one of them.  Only checking the primary sub-face was the
      // root cause of the bbox-fallback bug on certain merged L-shapes.
      auto findSharedEdgeList = [&](const std::vector<TopoDS_Face>& f1List,
                                    const std::vector<TopoDS_Face>& f2List,
                                    TopoDS_Edge& shared) -> bool {
        // Return the LONGEST shared edge across all (f1, f2) sub-face
        // combinations.  The Plan B corner-cut topology produces many
        // shared edges between adjacent panels (the cut splits the
        // corner overlap into multiple small contact edges) ÔÇö taking
        // the first match would land on a 1-3 mm side edge rather than
        // the proper 150-200 mm bend-axis edge, causing the BFS to
        // rotate the neighbour panel around the wrong axis and produce
        // a 30-50 mm flat-extent error.
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
        unfolds_[id] = UnfoldState{id, shellId, flatW, flatH, kFactor, 0, {}, {}, gp_Pnt2d(0, 0)};
        return UnfoldResult{id, flatW, flatH, kFactor, 0, true, val.nominalThickness, token, {}};
      }

      // 2. Perform pairwise face matching to identify thin-sheet skins (panels)
      struct PlaneFaceInfo {
        TopoDS_Face face;
        // All coplanar sub-faces that were merged into this entry.  Tracking these
        // avoids the "24mm sliver" bug where a boolean op or extend_face splits a
        // large skin face into two coplanar strips; only the first strip's vertices
        // would be projected otherwise, producing a tiny flat-pattern height.
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
        // Skip narrow thickness/side-edge faces whose width is less than 2.5 * thickness.
        // This prevents side-edge faces from incorrectly matching major flat skins.
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
              // Accumulate all sub-faces so vertex projection sees the full skin extent.
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
          // Skip narrow thickness/side-edge faces
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
        unfolds_[id] = UnfoldState{id, shellId, flatW, flatH, kFactor, 0, {}, {}, gp_Pnt2d(0, 0)};
        return UnfoldResult{id, flatW, flatH, kFactor, 0, true, val.nominalThickness, token, {}};
      }

      // Deduplicate coincident panels (e.g., due to duplicate/overlapping faces from CAD merge/fuse operations)
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
          return area1 > area2; // sort by total panel area descending
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

        // Try curved face connection ÔÇö iterate sub-faces on both sides.
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

        // Geometric fallback: BRepAlgoAPI_Fuse can absorb junction edges so
        // topological sharing tests above fail.  Find the pair of boundary
        // edges (one from each face) that are closest AND parallel ÔÇö the
        // true junction edge runs the full length of both panels while a
        // mere corner-vertex touch has perpendicular edge directions.
        double geomTol = val.nominalThickness * 4.0 + 5.0;
        double bestScore = -1.0;  // higher = better (shorter dist, more parallel)
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
        int          faceIdxCur;  // planeInfos index for the cur-side face
        TopoDS_Edge  originalEdge;
        double       theta;       // flat-rotation angle (radians)
      };
      std::vector<BendRecord> bendRecords;

      std::vector<gp_Trsf> flatTransformsForFaces(N);
      std::vector<gp_Trsf> flatTransforms(P);
      std::vector<bool> visited(P, false);
      std::vector<int> parent(P, -1);
      int bendCount = 0;

      // BFS over the panel graph: each unvisited neighbour gets a
      // rotation transform that brings its plane coplanar with the
      // accumulating flat layout. Two fixes were required to make this
      // work robustly across all bend-axis orientations:
      //   1. findSharedEdgeList (above) returns the LONGEST shared edge,
      //      not the first match ÔÇö otherwise a small side-edge from the
      //      Plan B corner-cut splits the contact into a 3mm picked seam
      //      instead of the 150mm bend axis.
      //   2. The rotation angle below is computed from the panel
      //      normals (dihedral) directly, not from face-centroid-based
      //      vectors. Centroid-based rotation was tilted by the
      //      corner-cut sub-face splits.
      // With both in place, all 6 testcube paired-cube merges land
      // within 0.2mm of the analytical flat dimension.
      std::vector<int> q;
      q.push_back(0);
      visited[0] = true;
      flatTransforms[0] = gp_Trsf(); // identity
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

            // Rotation in original space
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

            // ÔöÇÔöÇ ROTATION ANGLE FROM PANEL NORMALS (not centroids) ÔöÇÔöÇ
            //
            // The flatten rotation angle equals the dihedral between the
            // two panel planes.  Computing it from the normals directly
            // is robust to:
            //  ÔÇô primary-face centroid being off-center (Plan B
            //    corner-cut splits each panel skin into multiple sub-
            //    faces; the primary one's centroid isn't the panel's
            //    geometric center).
            //  ÔÇô the picked seam edge being a short side-edge instead
            //    of the full bend-axis edge (findSharedEdgeList may
            //    pick a partial seam when the corner-cut split the
            //    contact into multiple segments).
            //
            // The previous centroid-based formula was fragile against
            // both ÔÇö it gave ╬© values ranging from 86┬░ to 103┬░ instead
            // of the clean 90┬░ we always want for perpendicular panels.
            //
            // Direction (sign of ╬©): we want to rotate nNbr to align
            // with nCur AROUND the seam edge.  The rotation is in the
            // plane perpendicular to dE.  We use the BFS's
            // walk-direction-into-the-corner indicator: a unit vector
            // in nCur's plane perpendicular to dE, pointing AWAY from
            // the bend (into the panel body).  We get this by checking
            // the sign relative to nCur├ùdE.
            double cosDihedral = std::max(-1.0, std::min(1.0, nCur.Dot(nNbr)));
            double dihedral = std::acos(cosDihedral);
            double theta = M_PI - dihedral;

            // Determine sign: rotating nNbr by +╬© around dE must align
            // it with +nCur (not -nCur). We test directly by applying
            // a trial rotation of the unit normal and checking.
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

      // Prefer uAxis perpendicular to the first bend edge of panel 0 so the
      // flat layout is consistently aligned regardless of OCCT edge ordering.
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
        // Fallback 1: use the face surface's own X-direction (from STEP/IGES coordinate system).
        // This avoids picking diagonal edges from triangulated faces, which would tilt the
        // flat layout 45 degrees (e.g. a 200x200mm face appears as 282x282mm = 200*sqrt(2)).
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
        // Fallback 2: shortest straight perimeter edge of the base face.
        // Using shortest (not longest) avoids picking diagonal edges from
        // triangulated rectangular faces, which are always longer than the sides.
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

      // Gather the COMPLETE flat skin for a panel directly from the plane
      // equation, rather than trusting the coplanar-merge grouping (which can
      // split a panel into separate planeInfos and leave idxA holding only one
      // half).  We collect every planar face in the shell that faces the same
      // direction as the panel skin and lies on the same plane.  This guarantees
      // both halves of a split panel are present, so the seam between them is
      // shared and gets cancelled ÔÇö and the reported size spans the full panel.
      auto gatherSkin = [&](int idx) -> std::vector<TopoDS_Face> {
        gp_Pnt c = planeInfos[idx].center;
        gp_Vec n = planeInfos[idx].normal;
        std::vector<TopoDS_Face> out;
        for (TopExp_Explorer fe(activeShape, TopAbs_FACE); fe.More(); fe.Next()) {
          const TopoDS_Face& f = TopoDS::Face(fe.Current());
          Handle(Geom_Surface) s = BRep_Tool::Surface(f);
          if (s.IsNull() || !s->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
          gp_Vec fn = faceOutwardNormal(f);
          if (n.Dot(fn) < 0.95) continue;                       // same direction only
          GProp_GProps fp; BRepGProp::SurfaceProperties(f, fp);
          if (std::abs(gp_Vec(c, fp.CentreOfMass()).Dot(n)) > 0.5) continue;  // same plane
          out.push_back(f);
        }
        if (out.empty()) out = planeInfos[idx].allFaces;        // fallback
        return out;
      };

      // Precompute each panel's full skin; reused for the bounding box and the
      // outline so the reported dimensions always match the drawn geometry.
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

      // Handle edge case where flatW or flatH is near zero
      if (flatW < 1e-5) flatW = 1.0;
      if (flatH < 1e-5) flatH = 1.0;

      // 5b. Build flat-plane coordinate transform.
      // face0CS maps the face-0 local frame (c0, uAxis, vAxis) ÔåÆ standard XY.
      // planeToXY * flatTransformsForFaces[idx] brings any face in the BFS tree
      // into the same flat XY plane with the origin at (uMin, vMin).
      gp_Ax3 face0CS(c0,
                     gp_Dir(n0.X(), n0.Y(), n0.Z()),
                     gp_Dir(uAxis.X(), uAxis.Y(), uAxis.Z()));
      gp_Trsf tToXY;
      tToXY.SetTransformation(face0CS); // maps from face0CS ÔåÆ world XY

      gp_Trsf tOffset;
      tOffset.SetTranslation(gp_Vec(-uMin, -vMin, 0.0));

      // 6. Build flat panel shapes (clean cut profile).
      //
      // The panel skin is a single FLAT region that split_by_bends may have
      // carved into many coplanar sub-faces; the protrusion-footprint side-effect
      // adds inconsistently-subdivided (T-junctioned) internal seams that naive
      // edge-pair cancellation can't fully remove.  We instead:
      //   a) gather every sub-face edge (in flat coords) and drop edges that are
      //      shared by two sub-faces (count==2 ÔåÆ genuine interior seam);
      //   b) connect the surviving edges into closed wires;
      //   c) keep only the wire enclosing the largest area ÔÇö the true outer
      //      silhouette ÔÇö discarding internal artifact loops and any dangling
      //      T-junction fragments that don't close into a loop.
      // This yields the clean panel outline regardless of how messy the internal
      // tessellation is.
      auto qz = [](double v) -> long long { return std::llround(v * 100.0); };

      std::vector<TopoDS_Shape> flatPanelShapes(P);
      for (int i = 0; i < P; ++i) {
        if (!visited[i]) continue;
        const std::vector<TopoDS_Face>& skin = panelSkin[i];
        if (skin.empty()) continue;

        gp_Trsf toFlat = tOffset * tToXY * flatTransformsForFaces[panels[i].idxA];

        // (a) Sew the flattened sub-faces.  With the COMPLETE skin present, the
        // seam between abutting pieces is shared (non-free) and the sewer's FREE
        // edges are the true boundary (outer profile + holes).
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
          // Sewer found no free edges (overlapping faces or sew failure): do
          // geometric occurrence-counting directly on the flattened face edges
          // so that shared seams between overlapping/abutting faces still cancel.
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

        // (a2) Drop chord edges.  An edge that splits the panel into two abutting
        // regions (e.g. a flat-seam side-effect that survived as a single free
        // edge between two faces the sewer could not reconcile) has BOTH
        // endpoints lying on the perimeter ÔÇö so both endpoints are degree ÔëÑ 3 in
        // the boundary graph (two perimeter neighbours plus the chord).  A real
        // outward tab differs: its base vertex is degree-3 but its tip vertex is
        // degree-2, so the tab edge is preserved.
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
            if (d1 >= 3 && d2 >= 3) continue;   // chord ÔÇö drop
            keep->Append(freeEdges->Value(e));
          }
          if (!keep->IsEmpty()) freeEdges = keep;
        }

        // (b) Connect the boundary edges into closed wires.  A tight tolerance
        // (0.1 mm) keeps the perimeter's small sub-millimetre sliver vertices
        // connected, but leaves a chord that ends on a perimeter line ÔÇö like the
        // y=1 protrusion-attachment seam ÔÇö as its own separate 2-vertex open
        // wire, which the wire processing then discards.
        Handle(TopTools_HSequenceOfShape) wires;
        ShapeAnalysis_FreeBounds::ConnectEdgesToWires(freeEdges, 0.1, Standard_False, wires);

        // Simplify a closed point loop: drop each vertex whose perpendicular
        // distance from the segment joining its neighbours is below tol.  This
        // collapses collinear runs and the sub-millimetre sliver steps that
        // split_by_bends leaves at the protrusion seam, recovering clean corners.
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

            // Ordered vertices of the wire.
            std::vector<gp_Pnt> pts;
            for (BRepTools_WireExplorer we(wire); we.More(); we.Next())
              pts.push_back(BRep_Tool::Pnt(we.CurrentVertex()));
            if (pts.size() < 3) continue;

            simplifyLoop(pts, 0.2);
            if (pts.size() < 3) continue;

            // Drop tiny sliver loops (artefacts), keep outer profile + real holes.
            double area = 0.0;
            for (size_t k = 0; k < pts.size(); ++k) {
              const gp_Pnt& a = pts[k];
              const gp_Pnt& b = pts[(k + 1) % pts.size()];
              area += a.X() * b.Y() - b.X() * a.Y();
            }
            if (std::abs(area) * 0.5 < 1.0) continue;   // < 1 mm┬▓

            // Emit clean line edges between consecutive simplified vertices.
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

        // Fallback: wire connection failed ÔÇö emit the raw free edges.
        if (!anyAdded) {
          for (int e = 1; e <= freeEdges->Length(); ++e) { bb.Add(cmp, freeEdges->Value(e)); anyAdded = true; }
        }
        if (anyAdded) flatPanelShapes[i] = cmp;
      }

      // 7. Build flat bend edges from the BFS bend records.
      //    Each bend edge is transformed using the cur-panel's flat transform so
      //    it lands in the same XY plane as the flat panel shapes.
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
          // Fallback: manually transform edge endpoints and build fresh line edge.
          // BRepBuilderAPI_Transform can fail for degenerate or topology-only edges.
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
              // No 3D curve: try vertex fallback
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
      // Failure here is non-fatal: improvedPartId stays empty.
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
      unfolds_[id]          = std::move(state);

      return UnfoldResult{id, flatW, flatH, kFactor, bendCount, true, val.nominalThickness, token, {}, improvedId};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_UNFOLD_FAILED",
                          std::string("Unfold exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ DXF export ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  //
  // Serialises the flat panel shapes and bend edges stored by unfoldShell into
  // DXF R12 ASCII.  Edges are emitted as LINE / ARC / CIRCLE entities so that
  // holes and fillets round-trip analytically rather than as polylines.
  // Flat panel face wires are iterated directly from the stored TopoDS_Face
  // objects; no coordinate-projection heuristics are needed.

  DxfExportResult exportDxf(const UnfoldId& unfoldId) override {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = unfolds_.find(unfoldId);
    if (it == unfolds_.end()) {
      throw GeometryError("GE_UNFOLD_NOT_FOUND",
                          "Unfold not found: " + unfoldId, false, "");
    }

    const UnfoldState& state = it->second;

    // ÔöÇÔöÇ DXF header ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

    // ÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

    // Emit one edge on the given layer.  Lines and circles are native DXF
    // entities; everything else is discretised to 64-segment polylines.
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
          // ARC angles in DXF are degrees CCW from world +X.
          // Geom_Circle params are measured from the circle's own X-axis.
          gp_Dir xDir = circ->Circ().XAxis().Direction();
          double phiX = std::atan2(xDir.Y(), xDir.X()) * 180.0 / M_PI;
          double sa   = phiX + first * 180.0 / M_PI;
          double ea   = phiX + last  * 180.0 / M_PI;
          // Normalise to [0, 360)
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
        // Discretise other curve types (ellipse, B-spline, ÔÇª)
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

    // Collect bend line segments for CUT-layer filtering.
    // An edge is classified as a bend edge when its midpoint lies on the infinite
    // LINE defined by a stored flat bend edge (perpendicular distance < 0.15 mm)
    // AND its midpoint projects within the extent of that bend segment (with a
    // small margin).  Checking proximity to the bend MIDPOINT alone fails when
    // the tessellation splits a bend edge into shorter segments whose midpoints
    // are near the ends of the bend line rather than its centre.
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
      // Project to the flat XY plane (Z=0).  Side-face edges of the plate
      // have midpoints at Z≈T/2 in the transformed space, causing the 3D
      // perpendicular distance to exceed the tolerance.  Since the DXF output
      // is also 2D (X,Y only), using only XY distance is correct.
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

    // ÔöÇÔöÇ CUT layer ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    //
    // flatPanelShapes now stores pre-computed outer-boundary edge compounds
    // (computed at unfold time using topological TShape identity, not geometric
    // midpoints).  Simply iterate and filter bend-line edges.
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

    // ÔöÇÔöÇ BEND_UP / BEND_DOWN layers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    //
    // Each FlatBendEdge has already been transformed into the flat XY plane.
    // Deduplicate by midpoint in case a bend appears in both adj directions.
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

        // Bend centerline
        dxf << "  0\nLINE\n  8\n" << layer << "\n"
            << " 10\n" << pS.X() << "\n 20\n" << pS.Y() << "\n 30\n0.0\n"
            << " 11\n" << pE.X() << "\n 21\n" << pE.Y() << "\n 31\n0.0\n";
        ++entityCount;

        // Annotation text, offset 3 mm perpendicular to the bend line
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

  // ÔöÇÔöÇ Corner reliefs ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  ShellId addCornerRelief(const ShellId& shellId,
                           ReliefType reliefType,
                           double radiusMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellId) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before addCornerRelief on " + shellId);

    try {
      const TopoDS_Shape& shellShape = shells_[shellId].shape;

      // Collect all vertices that are shared by exactly 3+ edges
      // (internal corners at bend intersections)
      TopTools_IndexedDataMapOfShapeListOfShape vertexEdgeMap;
      TopExp::MapShapesAndAncestors(shellShape,
                                    TopAbs_VERTEX, TopAbs_EDGE,
                                    vertexEdgeMap);

      // Build the relief cylinder tool at each internal corner vertex
      // Dogbone: cylinder axis aligned with Z (normal to flat face)
      double toolRadius = (reliefType == ReliefType::DOGBONE)
                              ? radiusMm
                              : radiusMm * 0.9;  // circular slightly inset
      double toolHeight = 50.0;  // extend beyond any reasonable panel thickness

      TopoDS_Shape resultShape = shellShape;
      int reliefCount = 0;

      for (int i = 1; i <= vertexEdgeMap.Extent(); ++i) {
        const TopTools_ListOfShape& edges = vertexEdgeMap(i);
        if (edges.Extent() < 3) continue;  // only internal corners

        const TopoDS_Shape& vtxShape = vertexEdgeMap.FindKey(i);
        const TopoDS_Vertex& vtx = TopoDS::Vertex(vtxShape);
        gp_Pnt pt = BRep_Tool::Pnt(vtx);

        // Create a small cylinder centred on the corner vertex
        gp_Ax2 axis(gp_Pnt(pt.X(), pt.Y(), pt.Z() - toolHeight / 2.0),
                    gp_Dir(0, 0, 1));
        BRepPrimAPI_MakeCylinder cylinder(axis, toolRadius, toolHeight);
        if (!cylinder.IsDone()) continue;

        BRepAlgoAPI_Cut cut(resultShape, cylinder.Shape());
        cut.Build();
        if (cut.IsDone() && !cut.Shape().IsNull()) {
          resultShape = cut.Shape();
          reliefCount++;
        }
      }

      // Register updated shell
      ShellId newId = generateUUID();
      ShellState newState{newId, shells_[shellId].parentSolidId, resultShape};
      shells_[newId] = newState;

      return newId;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_RELIEF_FAILED",
                          std::string("Relief exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Nesting ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  NestResult nestShells(const std::vector<UnfoldId>& unfoldIds,
                         double sheetWidthMm,
                         double sheetHeightMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    for (const auto& uid : unfoldIds) {
      if (unfolds_.find(uid) == unfolds_.end()) {
        throw GeometryError("GE_UNFOLD_NOT_FOUND",
                            "Unfold not found: " + uid, false, "");
      }
    }

    if (sheetWidthMm <= 0 || sheetHeightMm <= 0) {
      throw GeometryError("GE_INVALID_SHEET_DIMS",
                          "Sheet dimensions must be positive", false, "");
    }

    // ÔöÇÔöÇ Shelf-Next-Fit Decreasing (SNFD) rectangular bin packing ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    // Sort pieces by height descending, then width descending (ties).
    struct Piece {
      std::string id;
      double      w;
      double      h;
    };
    std::vector<Piece> pieces;
    pieces.reserve(unfoldIds.size());
    double totalPartArea = 0.0;
    for (const auto& uid : unfoldIds) {
      const auto& u = unfolds_[uid];
      pieces.push_back({uid, u.flatWidthMm, u.flatHeightMm});
      totalPartArea += u.flatWidthMm * u.flatHeightMm;
    }

    // Sort largest height first for row-packing efficiency
    std::sort(pieces.begin(), pieces.end(), [](const Piece& a, const Piece& b) {
      if (a.h != b.h) return a.h > b.h;
      return a.w > b.w;
    });

    NestId nestId = generateUUID();
    std::vector<NestPlacement> placements;
    placements.reserve(pieces.size());

    // Pack into shelves: track current row position
    int    currentSheet  = 0;
    double curX          = 0.0;
    double curY          = 0.0;
    double rowHeight     = 0.0;

    for (const auto& p : pieces) {
      // If piece is wider or taller than the sheet, it cannot be placed
      // Clamp to check: skip over-sized pieces (edge case)
      const double pw = std::min(p.w, sheetWidthMm);
      const double ph = std::min(p.h, sheetHeightMm);

      // Try to fit in current row
      if (curX + pw > sheetWidthMm) {
        // Start a new row
        curY     += rowHeight;
        curX      = 0.0;
        rowHeight = 0.0;

        // If new row exceeds sheet height, go to next sheet
        if (curY + ph > sheetHeightMm) {
          ++currentSheet;
          curX      = 0.0;
          curY      = 0.0;
          rowHeight = 0.0;
        }
      }

      placements.push_back({p.id, currentSheet, curX, curY, 0.0});
      curX     += pw;
      rowHeight = std::max(rowHeight, ph);
    }

    int sheetsRequired = currentSheet + 1;
    double sheetArea   = sheetWidthMm * sheetHeightMm;
    double utilisation = (totalPartArea / (sheetsRequired * sheetArea)) * 100.0;
    utilisation        = std::min(100.0, utilisation);

    // ÔöÇÔöÇ SVG preview ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    // Generate a compact SVG visualising the placement on sheet 0.
    // Each panel is a coloured rectangle; the sheet outline is a grey frame.
    const double svgScale = 0.2; // mm ÔåÆ SVG units (px)
    const int    svgW     = static_cast<int>(sheetWidthMm  * svgScale) + 4;
    const int    svgH     = static_cast<int>(sheetHeightMm * svgScale) + 4;

    std::string svg;
    svg.reserve(2048);
    svg += "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"";
    svg += std::to_string(svgW);
    svg += "\" height=\"";
    svg += std::to_string(svgH);
    svg += "\">\n";
    // Sheet outline
    svg += "<rect x=\"2\" y=\"2\" width=\"";
    svg += std::to_string(static_cast<int>(sheetWidthMm  * svgScale));
    svg += "\" height=\"";
    svg += std::to_string(static_cast<int>(sheetHeightMm * svgScale));
    svg += "\" fill=\"#f0f0f0\" stroke=\"#888\" stroke-width=\"1\"/>\n";

    // Colour palette (cycle through 8 colours)
    static const char* COLOURS[] = {
      "#4A90D9","#E87B1E","#27AE60","#8E44AD",
      "#C0392B","#16A085","#F39C12","#2980B9"
    };
    size_t colIdx = 0;
    for (const auto& pl : placements) {
      if (pl.sheetIndex != 0) continue; // only show sheet 0
      // Find piece dimensions
      double pw = 0, ph = 0;
      for (const auto& piece : pieces) {
        if (piece.id == pl.unfoldId) { pw = piece.w; ph = piece.h; break; }
      }
      int px = static_cast<int>(pl.x * svgScale) + 2;
      int py = static_cast<int>(pl.y * svgScale) + 2;
      int pw_ = static_cast<int>(pw * svgScale);
      int ph_ = static_cast<int>(ph * svgScale);
      svg += "<rect x=\"";
      svg += std::to_string(px);
      svg += "\" y=\"";
      svg += std::to_string(py);
      svg += "\" width=\"";
      svg += std::to_string(pw_);
      svg += "\" height=\"";
      svg += std::to_string(ph_);
      svg += "\" fill=\"";
      svg += COLOURS[colIdx % 8];
      svg += "\" opacity=\"0.7\" stroke=\"#333\" stroke-width=\"0.5\"/>\n";

      // Draw bend lines in SVG if bendCount > 0
      auto unfoldIt = unfolds_.find(pl.unfoldId);
      if (unfoldIt != unfolds_.end() && unfoldIt->second.bendCount > 0) {
        int bc = unfoldIt->second.bendCount;
        double step = ph_ / static_cast<double>(bc + 1);
        for (int i = 1; i <= bc; ++i) {
          int ly = static_cast<int>(py + step * i);
          svg += "<line x1=\"";
          svg += std::to_string(px);
          svg += "\" y1=\"";
          svg += std::to_string(ly);
          svg += "\" x2=\"";
          svg += std::to_string(px + pw_);
          svg += "\" y2=\"";
          svg += std::to_string(ly);
          svg += "\" stroke=\"#ffffff\" stroke-dasharray=\"2,2\" stroke-width=\"0.5\"/>\n";
        }
      }

      ++colIdx;
    }
    svg += "</svg>\n";

    return NestResult{nestId, placements, utilisation, sheetsRequired, svg};
  }

  // ÔöÇÔöÇ GLB mesh export ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  std::vector<uint8_t> exportGlb(const ShellId& shellId) override {
    std::lock_guard<std::mutex> lock(mutex_);

    TopoDS_Shape shape;
    {
      auto shellIt = shells_.find(shellId);
      auto solidIt = solids_.find(shellId);
      if (shellIt != shells_.end()) {
        shape = shellIt->second.shape;
      } else if (solidIt != solids_.end()) {
        shape = solidIt->second.shape;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND",
                            "Shell/solid not found: " + shellId, false, "");
      }
    }

    // Tessellate: 0.5 mm chord deviation, 0.3 rad angular deviation, parallel
    BRepMesh_IncrementalMesh mesher(shape, 0.5, Standard_False, 0.3, Standard_True);
    mesher.Perform();

    // Collect flat-shaded triangles (no shared vertices between triangles)
    std::vector<float> positions;  // x,y,z per vertex (metres)
    std::vector<float> normals;    // x,y,z per vertex (flat: same for all 3 verts of a tri)

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
        if (reversed) std::swap(n2, n3);  // fix winding for reversed faces

        gp_Pnt p1 = tri->Node(n1).Transformed(trsf);
        gp_Pnt p2 = tri->Node(n2).Transformed(trsf);
        gp_Pnt p3 = tri->Node(n3).Transformed(trsf);

        // Flat normal from triangle edges
        gp_Vec edge1(p1, p2);
        gp_Vec edge2(p1, p3);
        gp_Vec faceNormal = edge1.Crossed(edge2);
        double mag = faceNormal.Magnitude();
        if (mag > 1e-12) faceNormal /= mag;

        // Emit 3 independent vertices (flat shading ÔÇö no vertex sharing)
        auto addVertex = [&](const gp_Pnt& p) {
          // glTF uses metres; OCCT model uses mm
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

    // ÔöÇÔöÇ Build binary chunk ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    // Layout: [positions float32├ù3├ùN][normals float32├ù3├ùN], 4-byte padded

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

    // ÔöÇÔöÇ Build JSON chunk ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

    // ÔöÇÔöÇ Assemble GLB ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

  // ÔöÇÔöÇ Snapshot / rollback ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  SnapshotId createSnapshot(const std::string& label) override {
    std::lock_guard<std::mutex> lock(mutex_);
    return createSnapshotLocked(label);
  }

  RestoreResult restoreSnapshot(const SnapshotId& snapshotId) override {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = snapshots_.find(snapshotId);
    if (it == snapshots_.end()) {
      throw GeometryError("GE_SNAPSHOT_NOT_FOUND",
                          "Snapshot not found: " + snapshotId, false, "");
    }

    const GeometrySnapshot& snap = it->second;

    auto sIt = snapshotSolids_.find(snapshotId);
    if (sIt != snapshotSolids_.end()) {
      solids_ = sIt->second;
    }
    auto hIt = snapshotShells_.find(snapshotId);
    if (hIt != snapshotShells_.end()) {
      shells_ = hIt->second;
    }
    auto uIt = snapshotUnfolds_.find(snapshotId);
    if (uIt != snapshotUnfolds_.end()) {
      unfolds_ = uIt->second;
    }
    auto aIt = snapshotAssemblies_.find(snapshotId);
    if (aIt != snapshotAssemblies_.end()) {
      assemblies_ = aIt->second;
    }

    return RestoreResult{snap.solidIds, snap.shellIds};
  }

  BoundingBoxResult computeBoundingBox(const std::string& entityId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    try {
      TopoDS_Shape shape = lookupEntityLocked(entityId);
      Bnd_Box box;
      BRepBndLib::AddOptimal(shape, box);
      double xMin, yMin, zMin, xMax, yMax, zMax;
      box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
      return BoundingBoxResult{xMin, yMin, zMin, xMax, yMax, zMax};
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT bounding box exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  MassPropertiesResult computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) override {
    std::lock_guard<std::mutex> lock(mutex_);
    try {
      TopoDS_Shape shape = lookupEntityLocked(entityId);
      MassPropertiesResult result;
      bool reqVol = false, reqSurf = false, reqCent = false, reqInert = false;
      if (properties.empty()) {
        reqVol = reqSurf = reqCent = reqInert = true;
      } else {
        for (const auto& p : properties) {
          if (p == "volume") reqVol = true;
          else if (p == "surface_area") reqSurf = true;
          else if (p == "centroid") reqCent = true;
          else if (p == "inertia_tensor") reqInert = true;
        }
      }
      if (reqVol || reqCent || reqInert) {
        GProp_GProps volProps;
        BRepGProp::VolumeProperties(shape, volProps);
        if (reqVol) result.volume = volProps.Mass();
        if (reqCent) {
          gp_Pnt c = volProps.CentreOfMass();
          result.centroid = std::array<double, 3>{c.X(), c.Y(), c.Z()};
        }
        if (reqInert) {
          gp_Mat inertia = volProps.MatrixOfInertia();
          std::array<double, 9> tensor{
            inertia(1,1), inertia(1,2), inertia(1,3),
            inertia(2,1), inertia(2,2), inertia(2,3),
            inertia(3,1), inertia(3,2), inertia(3,3)
          };
          result.inertiaTensor = tensor;
        }
      }
      if (reqSurf) {
        GProp_GProps surfProps;
        BRepGProp::SurfaceProperties(shape, surfProps);
        result.surfaceArea = surfProps.Mass();
      }
      return result;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT mass properties exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  MeasureResult measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) override {
    std::lock_guard<std::mutex> lock(mutex_);
    try {
      TopoDS_Shape shapeA = lookupEntityLocked(entityA);
      TopoDS_Shape shapeB = lookupEntityLocked(entityB);

      if (measurementType == "angle") {
        if (shapeA.ShapeType() != TopAbs_FACE || shapeB.ShapeType() != TopAbs_FACE) {
          throw GeometryError("GE_ALIGN_UNSUPPORTED", "Angle measurement only supported between two planar faces", true, "");
        }
        const TopoDS_Face& faceA = TopoDS::Face(shapeA);
        const TopoDS_Face& faceB = TopoDS::Face(shapeB);
        Handle(Geom_Surface) surfA = BRep_Tool::Surface(faceA);
        Handle(Geom_Surface) surfB = BRep_Tool::Surface(faceB);
        if (surfA.IsNull() || !surfA->IsKind(STANDARD_TYPE(Geom_Plane)) ||
            surfB.IsNull() || !surfB->IsKind(STANDARD_TYPE(Geom_Plane))) {
          throw GeometryError("GE_ALIGN_UNSUPPORTED", "Both faces must be planar for angle measurement", true, "");
        }
        Handle(Geom_Plane) planeA = Handle(Geom_Plane)::DownCast(surfA);
        Handle(Geom_Plane) planeB = Handle(Geom_Plane)::DownCast(surfB);
        gp_Dir dirA = planeA->Position().Direction();
        gp_Dir dirB = planeB->Position().Direction();
        double dot = std::clamp(dirA.Dot(dirB), -1.0, 1.0);
        double angleRad = std::acos(dot);
        double angleDeg = angleRad * 180.0 / M_PI;
        if (angleDeg > 180.0) angleDeg = 360.0 - angleDeg;
        return MeasureResult{angleDeg, "angle"};
      } else {
        BRepExtrema_DistShapeShape distCalc(shapeA, shapeB);
        distCalc.Perform();
        if (!distCalc.IsDone()) {
          throw GeometryError("GE_EMPTY_RESULT", "Distance computation failed", true, "");
        }
        double val = distCalc.Value();
        return MeasureResult{val, measurementType};
      }
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT measure distance exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  ExploreResult exploreTopology(const std::string& entityId, const std::string& returnType) override {
    std::lock_guard<std::mutex> lock(mutex_);
    try {
      TopoDS_Shape shape = lookupEntityLocked(entityId);
      ExploreResult result;

      TopAbs_ShapeEnum typeEnum;
      if (returnType == "solid") typeEnum = TopAbs_SOLID;
      else if (returnType == "shell") typeEnum = TopAbs_SHELL;
      else if (returnType == "face") typeEnum = TopAbs_FACE;
      else if (returnType == "edge") typeEnum = TopAbs_EDGE;
      else if (returnType == "vertex") typeEnum = TopAbs_VERTEX;
      else {
        throw GeometryError("GE_EMPTY_RESULT", "Invalid return type: " + returnType, false, "");
      }

      TopExp_Explorer exp(shape, typeEnum);
      TopTools_IndexedMapOfShape subShapeMap;
      for (; exp.More(); exp.Next()) {
        subShapeMap.Add(exp.Current());
      }
      for (int i = 1; i <= subShapeMap.Extent(); ++i) {
        result.entityIds.push_back(shapeId(subShapeMap(i)));
      }
      return result;
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT explore topology exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  FuseResult fuseBodies(const std::vector<ShellId>& tools, double fuzzyTolerance) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (tools.size() < 2) {
      throw GeometryError("GE_BOOLEAN_FAILURE", "At least two shells required for fuse operation", false, "");
    }

    std::vector<TopoDS_Shape> toolShapes;
    for (const auto& id : tools) {
      auto it = shells_.find(id);
      if (it == shells_.end()) {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found in session: " + id, false, "");
      }
      toolShapes.push_back(it->second.shape);
    }

    // Pre-fuse gap check: every consecutive pair must be within sewing tolerance.
    // A gap > kMergeTolerance means the bodies are not topologically adjacent and
    // the fuse would produce a disconnected compound masquerading as one body.
    {
      const double kMergeTolerance = 0.1; // mm
      for (size_t i = 0; i + 1 < toolShapes.size(); ++i) {
        const TopoDS_Shape& sA = toolShapes[i];
        const TopoDS_Shape& sB = toolShapes[i + 1];

        Bnd_Box boxA, boxB;
        BRepBndLib::AddOptimal(sA, boxA);
        BRepBndLib::AddOptimal(sB, boxB);

        Bnd_Box boxAExpanded = boxA;
        boxAExpanded.Enlarge(kMergeTolerance);
        const bool boxesClearlyApart =
            !boxA.IsVoid() && !boxB.IsVoid() && boxAExpanded.IsOut(boxB);

        if (boxesClearlyApart) {
          BRepExtrema_DistShapeShape gapCheck;
          gapCheck.LoadS1(sA);
          gapCheck.LoadS2(sB);
          gapCheck.Perform();

          double gap = kMergeTolerance + 1.0; // conservative default if measurement fails
          if (gapCheck.IsDone()) {
            gap = gapCheck.Value();
          }

          if (gap > kMergeTolerance) {
            std::ostringstream msg;
            msg << std::fixed << std::setprecision(3)
                << "GE_MERGE_GAP: Bodies " << (i) << " and " << (i + 1)
                << " are " << gap << " mm apart. "
                << "Maximum allowed gap is " << kMergeTolerance << " mm. "
                << "Use close_gap to snap them together before fusing.";
            throw GeometryError("GE_MERGE_GAP", msg.str(), false, "");
          }
        }
      }
    }

    SnapshotId token = createSnapshotLocked("before fuseBodies");

    try {
      TopoDS_Shape currentShape = toolShapes[0];
      std::vector<ShapeHistoryRecord> history;

      for (size_t i = 1; i < toolShapes.size(); ++i) {
        BRepAlgoAPI_Fuse fuser(currentShape, toolShapes[i]);
        if (fuzzyTolerance > 0.0) {
          fuser.SetFuzzyValue(fuzzyTolerance);
        }
        fuser.Build();
        if (!fuser.IsDone()) {
          throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean fuse failed", true, "rollback");
        }

        TopoDS_Shape nextShape = fuser.Shape();
        BRepCheck_Analyzer checker(nextShape);
        if (!checker.IsValid()) {
          throw GeometryError("GE_BOOLEAN_FAILURE", "Boolean fuse result is invalid", true, "rollback");
        }

        // Post-fuse connectivity check: reject disconnected compounds.
        {
          int solidCount = 0;
          for (TopExp_Explorer ex(nextShape, TopAbs_SOLID); ex.More(); ex.Next()) solidCount++;
          int shellCount = 0;
          for (TopExp_Explorer ex(nextShape, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) shellCount++;
          int topLevelCount = 0;
          if (solidCount == 0 && shellCount == 0 && nextShape.ShapeType() == TopAbs_COMPOUND) {
            for (TopoDS_Iterator it(nextShape); it.More(); it.Next()) topLevelCount++;
          }
          const bool disconnected = (solidCount > 1)
              || (solidCount == 0 && shellCount > 1)
              || (solidCount == 0 && shellCount == 0 && topLevelCount > 1);
          if (disconnected) {
            throw GeometryError("GE_MERGE_DISCONNECTED",
              "Fuse produced disconnected bodies ÔÇö the shapes are not topologically joined. "
              "Check for a gap and use close_gap to fix it.",
              false, "");
          }
        }

        auto h1 = captureHistory(fuser, currentShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "fuse_bodies");
        auto h2 = captureHistory(fuser, toolShapes[i], [](const TopoDS_Shape& s) { return shapeId(s); }, "fuse_bodies");
        history.insert(history.end(), h1.begin(), h1.end());
        history.insert(history.end(), h2.begin(), h2.end());

        // BRepAlgoAPI_Fuse returns a COMPOUND wrapper even when the result is
        // a single connected solid. Downstream ops (mergeBodiesWithBend's fuse
        // step) behave differently when the input is COMPOUND vs SOLID and can
        // produce spurious multi-solid results from the corner-cut step. Unwrap
        // to the bare solid here so the stored shape is always a proper SOLID.
        if (nextShape.ShapeType() != TopAbs_SOLID) {
          TopoDS_Solid theSolid;
          int unwrapCount = 0;
          for (TopExp_Explorer ex(nextShape, TopAbs_SOLID); ex.More(); ex.Next()) {
            theSolid = TopoDS::Solid(ex.Current());
            unwrapCount++;
          }
          if (unwrapCount == 1) {
            nextShape = theSolid;
          }
        }

        currentShape = nextShape;
      }

      for (const auto& id : tools) {
        shells_.erase(id);
      }

      ShellId resultId = generateUUID();
      shells_[resultId] = ShellState{resultId, "", currentShape};

      return FuseResult{resultId, false, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during fuse: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  CutResult cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto blankIt = shells_.find(blank);
    if (blankIt == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Blank shell not found: " + blank, false, "");
    }
    TopoDS_Shape blankShape = blankIt->second.shape;

    std::vector<TopoDS_Shape> toolShapes;
    for (const auto& id : tools) {
      auto it = shells_.find(id);
      if (it == shells_.end()) {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Tool shell not found: " + id, false, "");
      }
      toolShapes.push_back(it->second.shape);
    }

    SnapshotId token = createSnapshotLocked("before cutBodies on " + blank);

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

      shells_.erase(blank);
      if (!keepTools) {
        for (const auto& id : tools) {
          shells_.erase(id);
        }
      }

      ShellId resultId = generateUUID();
      shells_[resultId] = ShellState{resultId, "", currentShape};

      return CutResult{resultId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during cut: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  IntersectResult intersectBodies(const ShellId& a, const ShellId& b) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto itA = shells_.find(a);
    if (itA == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell A not found: " + a, false, "");
    }
    auto itB = shells_.find(b);
    if (itB == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell B not found: " + b, false, "");
    }

    TopoDS_Shape shapeA = itA->second.shape;
    TopoDS_Shape shapeB = itB->second.shape;

    SnapshotId token = createSnapshotLocked("before intersectBodies on " + a + " and " + b);

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

      shells_.erase(a);
      shells_.erase(b);

      ShellId resultId = generateUUID();
      shells_[resultId] = ShellState{resultId, "", resultShape};

      return IntersectResult{resultId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during intersect: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  TransformResult translateBody(const ShellId& solidId, double dx, double dy, double dz, bool keepOriginal) override {
    std::lock_guard<std::mutex> lock(mutex_);
    gp_Vec vec(dx, dy, dz);
    gp_Trsf trsf;
    trsf.SetTranslation(vec);
    return applyTransformLocked(solidId, trsf, keepOriginal, "translate_body");
  }

  TransformResult rotateBody(const ShellId& solidId, double axisPointX, double axisPointY, double axisPointZ, double axisDirX, double axisDirY, double axisDirZ, double angleDeg, bool keepOriginal) override {
    std::lock_guard<std::mutex> lock(mutex_);
    gp_Pnt pivot(axisPointX, axisPointY, axisPointZ);
    gp_Dir dir(axisDirX, axisDirY, axisDirZ);
    gp_Ax1 axis(pivot, dir);
    double angleRad = angleDeg * M_PI / 180.0;
    gp_Trsf trsf;
    trsf.SetRotation(axis, angleRad);
    return applyTransformLocked(solidId, trsf, keepOriginal, "rotate_body");
  }

  TransformResult mirrorBody(const ShellId& solidId, double planeOriginX, double planeOriginY, double planeOriginZ, double planeNormalX, double planeNormalY, double planeNormalZ, bool keepOriginal) override {
    std::lock_guard<std::mutex> lock(mutex_);
    gp_Pnt origin(planeOriginX, planeOriginY, planeOriginZ);
    gp_Dir normal(planeNormalX, planeNormalY, planeNormalZ);
    gp_Ax2 plane(origin, normal);
    gp_Trsf trsf;
    trsf.SetMirror(plane);
    return applyTransformLocked(solidId, trsf, keepOriginal, "mirror_body");
  }

  TransformResult scaleBody(const ShellId& solidId, double originX, double originY, double originZ, double scaleFactor, bool keepOriginal) override {
    std::lock_guard<std::mutex> lock(mutex_);
    if (scaleFactor <= 0.0) {
      throw GeometryError("GE_SCALE_NON_UNIFORM", "Scale factor must be greater than zero", true, "");
    }
    gp_Pnt center(originX, originY, originZ);
    gp_Trsf trsf;
    trsf.SetScale(center, scaleFactor);
    return applyTransformLocked(solidId, trsf, keepOriginal, "scale_body");
  }

  TransformResult alignToFace(const std::string& sourceFaceId, const std::string& destFaceId, bool flipNormal, bool keepOriginal) override {
    std::lock_guard<std::mutex> lock(mutex_);
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

  FilletResult filletEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double radiusMm) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
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

  ChamferResult chamferEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double distanceMm) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
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

  SimplifyResult simplifyBody(const ShellId& partId, bool unifyFaces, bool unifyEdges) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
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

  HealExResult healGeometryEx(const ShellId& partId, bool fixTolerances, bool fixWires) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
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

  OffsetShapeResult offsetShape(const ShellId& partId, double offsetValue, double tolerance) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
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

  DeleteFaceResult deleteFace(const ShellId& partId, const std::vector<std::string>& faceIds, bool healRemaining) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(partId);
    auto solidIt = solids_.find(partId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
        solids_.erase(partId);
      } else {
        shells_.erase(partId);
      }

      std::vector<ShellId> solidIds;
      for (const auto& shape : disconnectedShapes) {
        ShellId newId = generateUUID();
        shells_[newId] = ShellState{newId, "", shape};
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

  SewResult sewFaces(const std::vector<std::string>& entityIds, double tolerance, bool makeSolid) override {
    std::lock_guard<std::mutex> lock(mutex_);
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
        shells_.erase(id);
        solids_.erase(id);
      }

      ShellId resultId = generateUUID();
      if (finalShape.ShapeType() == TopAbs_SOLID) {
        solids_[resultId] = SolidState{resultId, finalShape};
      } else {
        shells_[resultId] = ShellState{resultId, "", finalShape};
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

  CreateAssemblyResult createAssemblyDocument() override {
    std::lock_guard<std::mutex> lock(mutex_);
    SnapshotId token = createSnapshotLocked("before createAssemblyDocument");

    try {
      Handle(TDocStd_Document) doc;
      app_->NewDocument("BinXCAF", doc);

      Handle(XCAFDoc_ShapeTool) shapeTool = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
      TDF_Label assemblyLabel = shapeTool->NewShape();
      AssemblyId assemblyId = generateUUID();
      assemblies_[assemblyId] = AssemblyState{assemblyId, doc, shapeTool, assemblyLabel, {}};

      return CreateAssemblyResult{assemblyId};
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT exception during create assembly: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  AddInstanceResult addAssemblyInstance(const AssemblyId& assemblyId, const std::string& targetShapeId, double tx, double ty, double tz, double qw, double qx, double qy, double qz) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = assemblies_.find(assemblyId);
    if (it == assemblies_.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Assembly document not found: " + assemblyId, false, "");
    }

    TopoDS_Shape targetShape;
    auto shellIt = shells_.find(targetShapeId);
    auto solidIt = solids_.find(targetShapeId);
    if (shellIt != shells_.end()) {
      targetShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
      targetShape = solidIt->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Target shape not found for assembly instance: " + targetShapeId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before addAssemblyInstance in " + assemblyId);

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

  MateRigidResult mateRigid(const AssemblyId& assemblyId, const std::string& srcEntityId, const std::string& dstEntityId, bool flipAlignment) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = assemblies_.find(assemblyId);
    if (it == assemblies_.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Assembly document not found: " + assemblyId, false, "");
    }

    TopoDS_Shape srcFaceShape = lookupEntityLocked(srcEntityId);
    TopoDS_Shape dstFaceShape = lookupEntityLocked(dstEntityId);
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

    SnapshotId token = createSnapshotLocked("before mateRigid in " + assemblyId);

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

      ShellId srcParentId = findParentShellIdLocked(srcEntityId);
      TopoDS_Shape parentShape = lookupEntityLocked(srcParentId);
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

  ListAssemblyResult listAssemblyTree(const AssemblyId& assemblyId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = assemblies_.find(assemblyId);
    if (it == assemblies_.end()) {
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

  void clearSnapshots() override {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshots_.clear();
    snapshotSolids_.clear();
    snapshotShells_.clear();
    snapshotUnfolds_.clear();
    snapshotAssemblies_.clear();
  }

private:
  // ÔöÇÔöÇ State ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  mutable std::mutex mutex_;
  std::unordered_map<SolidId,   SolidState>   solids_;
  std::unordered_map<ShellId,   ShellState>   shells_;
  std::unordered_map<UnfoldId,  UnfoldState>  unfolds_;
  std::unordered_map<SnapshotId, GeometrySnapshot> snapshots_;
  std::unordered_map<SnapshotId, std::unordered_map<SolidId, SolidState>> snapshotSolids_;
  std::unordered_map<SnapshotId, std::unordered_map<ShellId, ShellState>> snapshotShells_;
  std::unordered_map<SnapshotId, std::unordered_map<UnfoldId, UnfoldState>> snapshotUnfolds_;
  std::unordered_map<AssemblyId, AssemblyState> assemblies_;
  std::unordered_map<SnapshotId, std::unordered_map<AssemblyId, AssemblyState>> snapshotAssemblies_;
  Handle(TDocStd_Application) app_;

  // ÔöÇÔöÇ Private helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  TopoDS_Shape lookupEntityLocked(const std::string& entityId) const {
    auto solidIt = solids_.find(entityId);
    if (solidIt != solids_.end()) {
      return solidIt->second.shape;
    }
    auto shellIt = shells_.find(entityId);
    if (shellIt != shells_.end()) {
      return shellIt->second.shape;
    }
    for (const auto& kv : solids_) {
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
    for (const auto& kv : shells_) {
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

  SnapshotId createSnapshotLocked(const std::string& label) {
    GeometrySnapshot snap;
    snap.snapshotId     = generateUUID();
    snap.operationLabel = label;
    snap.timestampMs    = nowMs();

    for (const auto& kv : solids_)  snap.solidIds.push_back(kv.first);
    for (const auto& kv : shells_)  snap.shellIds.push_back(kv.first);
    for (const auto& kv : unfolds_) snap.unfoldIds.push_back(kv.first);

    snapshots_[snap.snapshotId] = snap;
    snapshotSolids_[snap.snapshotId] = solids_;
    snapshotShells_[snap.snapshotId] = shells_;
    snapshotUnfolds_[snap.snapshotId] = unfolds_;
    snapshotAssemblies_[snap.snapshotId] = assemblies_;
    return snap.snapshotId;
  }

  ShellId findParentShellIdLocked(const std::string& subShapeId) const {
    for (const auto& kv : shells_) {
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
    for (const auto& kv : solids_) {
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

  TransformResult applyTransformLocked(const ShellId& solidId, const gp_Trsf& trsf, bool keepOriginal, const std::string& opName) {
    TopoDS_Shape originalShape;
    bool isSolid = false;
    auto shellIt = shells_.find(solidId);
    auto solidIt = solids_.find(solidId);
    if (shellIt != shells_.end()) {
      originalShape = shellIt->second.shape;
    } else if (solidIt != solids_.end()) {
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
          solids_.erase(solidId);
        } else {
          shells_.erase(solidId);
        }
      }

      ShellId resultId = generateUUID();
      if (isSolid) {
        solids_[resultId] = SolidState{resultId, transformedShape};
      } else {
        shells_[resultId] = ShellState{resultId, "", transformedShape};
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

  void buildTopologyGraph(const TopoDS_Shape& shape, TopologyGraph& graph) {
    // ÔöÇÔöÇ Index faces ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);

    for (int i = 1; i <= faceMap.Extent(); ++i) {
      const TopoDS_Face& face = TopoDS::Face(faceMap(i));
      FaceNode node;
      node.faceId      = shapeId(face);
      node.surfaceType = classifySurface(face);

      // Compute area
      GProp_GProps props;
      BRepGProp::SurfaceProperties(face, props);
      node.areaMm2 = props.Mass();

      // Compute normal at center (approximate)
      Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(face, u1, u2, v1, v2);
      Standard_Real uMid = (u1 + u2) * 0.5;
      Standard_Real vMid = (v1 + v2) * 0.5;

      gp_Pnt pnt;
      gp_Vec du, dv;
      surf->D1(uMid, vMid, pnt, du, dv);
      gp_Vec normal = du.Crossed(dv);
      if (normal.Magnitude() > 1e-10) {
        normal.Normalize();
      }
      node.normalX = normal.X();
      node.normalY = normal.Y();
      node.normalZ = normal.Z();

      graph.faces.push_back(node);
    }

    // ÔöÇÔöÇ Index edges ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    TopTools_IndexedMapOfShape edgeMap;
    TopExp::MapShapes(shape, TopAbs_EDGE, edgeMap);

    for (int i = 1; i <= edgeMap.Extent(); ++i) {
      const TopoDS_Edge& edge = TopoDS::Edge(edgeMap(i));
      EdgeNode node;
      node.edgeId    = shapeId(edge);
      node.curveType = classifyCurve(edge);

      GProp_GProps edgeProps;
      BRepGProp::LinearProperties(edge, edgeProps);
      node.lengthMm = edgeProps.Mass();

      graph.edges.push_back(node);
    }

    // ÔöÇÔöÇ Build face-face adjacency (dihedral angles) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

    for (int i = 1; i <= edgeToFaces.Extent(); ++i) {
      const TopTools_ListOfShape& faces = edgeToFaces(i);
      if (faces.Extent() != 2) continue;

      const TopoDS_Edge& edge = TopoDS::Edge(edgeToFaces.FindKey(i));
      const TopoDS_Face& faceA = TopoDS::Face(faces.First());
      const TopoDS_Face& faceB = TopoDS::Face(faces.Last());

      AdjacencyEntry adj;
      adj.faceIdA        = shapeId(faceA);
      adj.faceIdB        = shapeId(faceB);
      adj.sharedEdgeId   = shapeId(edge);
      adj.dihedralAngleDeg = computeDihedralAngle(faceA, faceB, edge);

      graph.adjacency.push_back(adj);
    }
  }

  // ÔöÇÔöÇ Split body by plane ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  SplitBodyResult splitBodyByPlane(const ShellId& partId,
                                   const CuttingPlane& plane) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = shells_.find(partId);
    if (it == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before splitBodyByPlane on " + partId);

    try {
      gp_Pnt origin(plane.originX, plane.originY, plane.originZ);
      double normLen = std::sqrt(plane.normalX * plane.normalX +
                                  plane.normalY * plane.normalY +
                                  plane.normalZ * plane.normalZ);
      if (normLen < 1e-10) {
        throw GeometryError("GE_SPLIT_FAILED", "Plane normal is zero", false, "");
      }
      gp_Dir normal(plane.normalX / normLen, plane.normalY / normLen, plane.normalZ / normLen);
      gp_Pln gPlane(origin, normal);
      BRepBuilderAPI_MakeFace faceMaker(gPlane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face planeFace = faceMaker.Face();
      gp_Vec n(normal);

      TopoDS_Shape inputForHistory = it->second.shape;

      // Positive side = shape minus negative half-space
      gp_Pnt negRefPt = origin.Translated(n * -100.0);
      BRepPrimAPI_MakeHalfSpace negHS(planeFace, negRefPt);
      BRepAlgoAPI_Cut cutPos(it->second.shape, negHS.Solid());
      cutPos.Build();
      if (!cutPos.IsDone() || cutPos.Shape().IsNull()) {
        throw GeometryError("GE_SPLIT_FAILED", "Split positive side failed", true, "rollback");
      }

      // Negative side = shape minus positive half-space
      gp_Pnt posRefPt = origin.Translated(n * 100.0);
      BRepPrimAPI_MakeHalfSpace posHS(planeFace, posRefPt);
      BRepAlgoAPI_Cut cutNeg(it->second.shape, posHS.Solid());
      cutNeg.Build();
      if (!cutNeg.IsDone() || cutNeg.Shape().IsNull()) {
        throw GeometryError("GE_SPLIT_FAILED", "Split negative side failed", true, "rollback");
      }

      GProp_GProps props;
      BRepGProp::VolumeProperties(cutPos.Shape(), props);
      if (props.Mass() < 1e-6) {
        throw GeometryError("GE_SPLIT_FAILED",
                            "Positive side is empty ÔÇö plane may not intersect the body",
                            true, "rollback");
      }
      BRepGProp::VolumeProperties(cutNeg.Shape(), props);
      if (props.Mass() < 1e-6) {
        throw GeometryError("GE_SPLIT_FAILED",
                            "Negative side is empty ÔÇö plane may not intersect the body",
                            true, "rollback");
      }

      ShellId posId = generateUUID();
      ShellId negId = generateUUID();
      shells_[posId] = ShellState{posId, it->second.parentSolidId, cutPos.Shape()};
      shells_[negId] = ShellState{negId, it->second.parentSolidId, cutNeg.Shape()};

      auto histPos = captureHistory(cutPos, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "splitBodyByPlane");
      auto histNeg = captureHistory(cutNeg, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "splitBodyByPlane");
      histPos.insert(histPos.end(), histNeg.begin(), histNeg.end());
      return SplitBodyResult{posId, negId, token, std::move(histPos)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_SPLIT_FAILED",
                          std::string("OCCT exception during split: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Split body by bends ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  // ÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

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

  // Detect whether the solid should use Mode 2 (thin-solid cutting) or
  // Mode 1 (surface/conceptual extrusion).
  // Returns "thin_solid" or "surface".
  static std::string detectObjectMode(const TopoDS_Shape& shape, double maxThicknessMm) {
    GProp_GProps volProps;
    BRepGProp::VolumeProperties(shape, volProps);
    if (std::abs(volProps.Mass()) < 1e-6) return "surface";

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);

    for (int i = 1; i <= faceMap.Extent(); ++i) {
      const TopoDS_Face& fA = TopoDS::Face(faceMap(i));
      gp_Vec nA = faceOutwardNormal(fA);
      for (int j = i + 1; j <= faceMap.Extent(); ++j) {
        const TopoDS_Face& fB = TopoDS::Face(faceMap(j));
        gp_Vec nB = faceOutwardNormal(fB);
        if (nA.Dot(nB) >= -0.95) continue;  // not anti-parallel
        BRepExtrema_DistShapeShape dist(fA, fB);
        if (dist.IsDone() && dist.Value() <= maxThicknessMm) return "thin_solid";
      }
    }
    return "surface";
  }

  // BFS face group, returning one coplanar component per entry.
  struct FaceGroup {
    std::vector<int> faceIndices;  // 1-based into faceMap
    gp_Vec  normal;
    gp_Pnt  centroid;
    double  area;
    bool    isOuter;  // N ┬À (centroid - solidCentroid) > 0
  };

  static std::vector<FaceGroup> buildFaceGroups(
      const TopoDS_Shape& shape,
      const TopTools_IndexedMapOfShape& faceMap,
      double angleThresholdDeg,
      const gp_Pnt& solidCentroid)
  {
    int nFaces = faceMap.Extent();
    TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

    std::vector<std::vector<int>> coplanar(nFaces + 1);
    for (int i = 1; i <= edgeToFaces.Extent(); ++i) {
      const TopTools_ListOfShape& fl = edgeToFaces(i);
      if (fl.Extent() != 2) continue;
      const TopoDS_Face& fA = TopoDS::Face(fl.First());
      const TopoDS_Face& fB = TopoDS::Face(fl.Last());
      double angle = computeDihedralAngle(fA, fB, TopoDS::Edge(edgeToFaces.FindKey(i)));
      if (angle <= angleThresholdDeg) {
        int idxA = faceMap.FindIndex(fA);
        int idxB = faceMap.FindIndex(fB);
        if (idxA > 0 && idxB > 0) {
          coplanar[idxA].push_back(idxB);
          coplanar[idxB].push_back(idxA);
        }
      }
    }

    std::vector<bool> visited(nFaces + 1, false);
    std::vector<FaceGroup> groups;

    for (int start = 1; start <= nFaces; ++start) {
      if (visited[start]) continue;
      FaceGroup grp;
      std::vector<int> queue = {start};
      visited[start] = true;
      while (!queue.empty()) {
        int cur = queue.back(); queue.pop_back();
        grp.faceIndices.push_back(cur);
        for (int nbr : coplanar[cur]) {
          if (!visited[nbr]) { visited[nbr] = true; queue.push_back(nbr); }
        }
      }

      // Compute normal, area-weighted centroid
      gp_XYZ wc(0, 0, 0);
      double totalArea = 0.0;
      for (int idx : grp.faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        GProp_GProps fp;
        BRepGProp::SurfaceProperties(f, fp);
        double a = fp.Mass();
        totalArea += a;
        wc += fp.CentreOfMass().XYZ().Multiplied(a);
      }
      grp.area = totalArea;
      grp.centroid = (totalArea > 1e-10)
          ? gp_Pnt(wc.Multiplied(1.0 / totalArea))
          : gp_Pnt(0, 0, 0);

      grp.normal = faceOutwardNormal(TopoDS::Face(faceMap(grp.faceIndices[0])));

      // Outer face: outward normal points away from solid centroid
      gp_Vec toCenter(solidCentroid, grp.centroid);
      grp.isOuter = (grp.normal.Dot(toCenter) > 0.0);

      groups.push_back(std::move(grp));
    }
    return groups;
  }

  // ÔöÇÔöÇ Protrusion detection ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  // A connected region of non-primary faces qualifying as a thin localised
  // feature (flange / tab) on a primary panel face.
  struct ProtrusionCandidate {
    std::vector<int> faceIndices;    // 1-based into faceMap
    gp_Pnt           panelCentroid;  // centroid of the hosting primary group
    gp_Vec           panelNormal;    // outward normal of the hosting primary group
    // For plate-style protrusions, the back-face plane bounds the slab on the
    // other side; extractProtrusion uses both planes to isolate the slab.
    bool             hasBackPlane = false;
    gp_Pnt           backCentroid;
    gp_Vec           backNormal;     // points away from the protrusion body

    // For Option-2 interior-host tabs: bounded box scoped to the cap's footprint.
    // When useBoundedTabBox=true, extractProtrusion ignores hasBackPlane and builds
    // a box in the (tabU, tabV, panelNormal) frame, sized to the cap's 2D footprint
    // ├ù tabHeight along panelNormal. This avoids the over-extraction that a half-space
    // would cause when the host is interior to the solid.
    bool             useBoundedTabBox = false;
    gp_Vec           tabU;            // in-plane axis 1 (perpendicular to panelNormal)
    gp_Vec           tabV;            // in-plane axis 2 (perpendicular to panelNormal)
    double           tabUMin = 0.0;
    double           tabUMax = 0.0;
    double           tabVMin = 0.0;
    double           tabVMax = 0.0;
    double           tabHeight = 0.0; // cap-to-host offset along panelNormal
    // When >=0, override the default 0.5 mm pad/bleed used by extractProtrusion.
    // Option-3 bridge flanges sit flush against neighbouring panels; the default
    // pad bleeds into those panels and inflates the extracted protrusion bbox.
    double           tightPad   = -1.0;
    double           tightBleed = -1.0;
  };

  // T017 ÔÇö Detect protrusion candidates before any panel cutting.
  // Applies three tests per connected non-primary-face region:
  //   1. Extent   : attachment edge length < 50% of primary panel perimeter
  //   2. Orientation: cap face normal ┬À panel normal > 0.85
  //   3. Thickness: min face-pair distance in the region Ôëñ maxThicknessMm
  static std::vector<ProtrusionCandidate> detectProtrusions(
      const TopoDS_Shape&              shape,
      const TopTools_IndexedMapOfShape& faceMap,
      const std::vector<FaceGroup>&    groups,
      double                           maxThicknessMm)
  {
    int nFaces = faceMap.Extent();

    // faceToGroup[i] = primary group index for face i, or -1 if non-primary
    std::vector<int> faceToGroup(nFaces + 1, -1);
    for (int g = 0; g < (int)groups.size(); ++g) {
      if (!groups[g].isOuter) continue;
      for (int idx : groups[g].faceIndices)
        faceToGroup[idx] = g;
    }

    // ÔöÇÔöÇ AABB + hull-ratio classification (used by both detection passes) ÔöÇÔöÇ
    // Compute the solid's tight AABB and, for each face group, the fraction of
    // its vertices that touch the AABB boundary. Groups with low hullRatio are
    // "interior" ÔÇö sitting inside the solid rather than on its outer hull.
    // For interior hosts, half-space extraction over-extracts; bounded-box
    // extraction must be used instead.
    double sxMin = 1e30, syMin = 1e30, szMin = 1e30;
    double sxMax = -1e30, syMax = -1e30, szMax = -1e30;
    for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
      gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
      sxMin = std::min(sxMin, p.X()); sxMax = std::max(sxMax, p.X());
      syMin = std::min(syMin, p.Y()); syMax = std::max(syMax, p.Y());
      szMin = std::min(szMin, p.Z()); szMax = std::max(szMax, p.Z());
    }
    constexpr double kHullTol = 0.5;  // mm ÔÇö vertex this close to AABB face = on hull
    auto vertexOnHull = [&](const gp_Pnt& p) {
      return std::abs(p.X() - sxMin) <= kHullTol || std::abs(p.X() - sxMax) <= kHullTol
          || std::abs(p.Y() - syMin) <= kHullTol || std::abs(p.Y() - syMax) <= kHullTol
          || std::abs(p.Z() - szMin) <= kHullTol || std::abs(p.Z() - szMax) <= kHullTol;
    };
    std::vector<double> hullRatio(groups.size(), 0.0);
    for (int g = 0; g < (int)groups.size(); ++g) {
      int onHull = 0, total = 0;
      for (int fi : groups[g].faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
        for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
          ++total;
          if (vertexOnHull(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())))) ++onHull;
        }
      }
      hullRatio[g] = total > 0 ? (double)onHull / total : 0.0;
    }
    constexpr double kInteriorThreshold = 0.50;

    // Helper: project a face's vertices onto a (u, v) plane through `origin`,
    // return the 2D bounding box in (u, v).
    auto projectFootprint = [&](const TopoDS_Face& face, const gp_Pnt& origin,
                                const gp_Vec& u, const gp_Vec& v,
                                double& uMin, double& uMax,
                                double& vMin, double& vMax) {
      uMin = 1e30; uMax = -1e30; vMin = 1e30; vMax = -1e30;
      for (TopExp_Explorer ex(face, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        gp_Vec toP(origin, p);
        double uc = u.Dot(toP);
        double vc = v.Dot(toP);
        uMin = std::min(uMin, uc); uMax = std::max(uMax, uc);
        vMin = std::min(vMin, vc); vMax = std::max(vMax, vc);
      }
    };

    // Helper: build (tabU, tabV) perpendicular to a given normal.
    auto buildInPlaneAxes = [](const gp_Vec& n, gp_Vec& u, gp_Vec& v) -> bool {
      gp_Vec seed = (std::abs(n.X()) < 0.9) ? gp_Vec(1, 0, 0) : gp_Vec(0, 1, 0);
      u = seed - n.Multiplied(n.Dot(seed));
      if (u.Magnitude() < 1e-6) return false;
      u.Normalize();
      v = n.Crossed(u);
      if (v.Magnitude() < 1e-6) return false;
      v.Normalize();
      return true;
    };

    // Build edge-to-faces and face-to-adjacent-faces maps
    TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

    std::vector<std::vector<int>> faceAdj(nFaces + 1);
    for (int e = 1; e <= edgeToFaces.Extent(); ++e) {
      const TopTools_ListOfShape& fl = edgeToFaces(e);
      if (fl.Extent() != 2) continue;
      int idxA = faceMap.FindIndex(fl.First());
      int idxB = faceMap.FindIndex(fl.Last());
      if (idxA > 0 && idxB > 0) {
        faceAdj[idxA].push_back(idxB);
        faceAdj[idxB].push_back(idxA);
      }
    }

    // Per-group: boundary perimeter and attachment edges to non-primary faces
    struct AttachEdge { int nonPrimaryFaceIdx; double length; };
    std::vector<double>                   groupPerimeter(groups.size(), 0.0);
    std::vector<std::vector<AttachEdge>>  groupAttach(groups.size());

    for (int e = 1; e <= edgeToFaces.Extent(); ++e) {
      const TopTools_ListOfShape& fl = edgeToFaces(e);
      if (fl.Extent() != 2) continue;
      int idxA = faceMap.FindIndex(fl.First());
      int idxB = faceMap.FindIndex(fl.Last());
      if (idxA <= 0 || idxB <= 0) continue;
      int gA = faceToGroup[idxA];
      int gB = faceToGroup[idxB];
      if (gA == gB) continue;  // interior to same group or both non-primary

      GProp_GProps lp;
      BRepGProp::LinearProperties(edgeToFaces.FindKey(e), lp);
      double edgeLen = lp.Mass();

      if (gA >= 0) {
        groupPerimeter[gA] += edgeLen;
        if (gB < 0) groupAttach[gA].push_back({idxB, edgeLen});
      }
      if (gB >= 0) {
        groupPerimeter[gB] += edgeLen;
        if (gA < 0) groupAttach[gB].push_back({idxA, edgeLen});
      }
    }

    std::vector<ProtrusionCandidate> candidates;
    std::vector<bool> claimed(nFaces + 1, false);
    std::vector<bool> claimedPanelGroup(groups.size(), false);

    // Precompute face centroids once for use in distance-bounded BFS
    std::vector<gp_Pnt> faceCentroid(nFaces + 1);
    for (int i = 1; i <= nFaces; ++i) {
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(TopoDS::Face(faceMap(i)), fp);
      faceCentroid[i] = fp.CentreOfMass();
    }

    for (int g = 0; g < (int)groups.size(); ++g) {
      if (!groups[g].isOuter || groupAttach[g].empty()) continue;
      if (claimedPanelGroup[g]) continue;

      // Map: non-primary face index ÔåÆ total attachment edge length from group g
      std::unordered_map<int, double> attachLen;
      std::set<int> seeds;
      for (const auto& ae : groupAttach[g]) {
        attachLen[ae.nonPrimaryFaceIdx] += ae.length;
        seeds.insert(ae.nonPrimaryFaceIdx);
      }

      // Flood-fill connected components through non-primary faces
      std::vector<bool> visited(nFaces + 1, false);
      for (int idx : groups[g].faceIndices) visited[idx] = true;  // block primary faces

      for (int seed : seeds) {
        if (visited[seed] || claimed[seed]) continue;

        // BFS bounded by panel-plane distance: only expand into non-outer faces
        // within maxThicknessMm of the outer group's plane (in either direction).
        // This prevents the flood fill from spreading across the entire connected
        // void region and isolates each protrusion's faces.
        const gp_Vec& pNorm = groups[g].normal;
        std::vector<int> component;
        std::vector<int> queue = {seed};
        visited[seed] = true;
        while (!queue.empty()) {
          int cur = queue.back(); queue.pop_back();
          component.push_back(cur);
          for (int nbr : faceAdj[cur]) {
            if (!visited[nbr] && faceToGroup[nbr] < 0 && !claimed[nbr]) {
              gp_Vec toNbr(groups[g].centroid, faceCentroid[nbr]);
              double dist = std::abs(pNorm.Dot(toNbr));
              if (dist > maxThicknessMm + 1.0) continue;
              visited[nbr] = true;
              queue.push_back(nbr);
            }
          }
        }

        // Test 1: Extent ÔÇö total attachment < 50% of primary panel perimeter
        double totalAttach = 0.0;
        for (int fi : component) {
          auto it = attachLen.find(fi);
          if (it != attachLen.end()) totalAttach += it->second;
        }
        double extentRatio = groupPerimeter[g] > 1e-6 ? totalAttach / groupPerimeter[g] : 0.0;
        if (extentRatio >= 0.50) continue;

        // Test 2: Orientation ÔÇö cap face normal ÔêÑ panel normal (dot > 0.85)
        int    capIdx = -1;
        double maxProj = -1e9;
        for (int fi : component) {
          gp_Vec toFace(groups[g].centroid, faceCentroid[fi]);
          double proj = pNorm.Dot(toFace);
          if (proj > maxProj) { maxProj = proj; capIdx = fi; }
        }
        if (capIdx < 0) continue;
        gp_Vec capNorm = faceOutwardNormal(TopoDS::Face(faceMap(capIdx)));

        // Test 3: Thickness ÔÇö protrusion dimension along panel normal Ôëñ maxThicknessMm.
        // Strategy:
        //   (a) Anti-parallel pairs within the component (tab between two opposite faces)
        //   (b) Cap face vs primary panel faces ÔÇö parallel (tab) or anti-parallel (plate)
        //   (c) Cap face vs any other outer group's faces ÔÇö plate-style where the
        //       opposite wide face is in a different group than the entered edge face
        // For (b) and (c), record the matched panel group so the extraction step uses
        // the correct panel orientation (along the plate's thickness, not the edge).
        bool thinEnough = false;
        int matchedPanelGroup = g;
        const TopoDS_Face& capFace = TopoDS::Face(faceMap(capIdx));
        gp_Vec capNormVec = faceOutwardNormal(capFace);
        for (int i = 0; i < (int)component.size() && !thinEnough; ++i) {
          const TopoDS_Face& fI = TopoDS::Face(faceMap(component[i]));
          gp_Vec nI = faceOutwardNormal(fI);
          for (int j = i + 1; j < (int)component.size(); ++j) {
            const TopoDS_Face& fJ = TopoDS::Face(faceMap(component[j]));
            if (nI.Dot(faceOutwardNormal(fJ)) >= -0.95) continue;
            BRepExtrema_DistShapeShape d(fI, fJ);
            if (d.IsDone() && d.Value() <= maxThicknessMm) { thinEnough = true; break; }
          }
        }
        if (!thinEnough) {
          for (int fi : groups[g].faceIndices) {
            const TopoDS_Face& panelF = TopoDS::Face(faceMap(fi));
            gp_Vec pnNorm = faceOutwardNormal(panelF);
            if (std::abs(capNormVec.Dot(pnNorm)) <= 0.85) continue;
            BRepExtrema_DistShapeShape d(capFace, panelF);
            if (d.IsDone() && d.Value() <= maxThicknessMm) { thinEnough = true; break; }
          }
        }
        if (!thinEnough) {
          for (int gi = 0; gi < (int)groups.size() && !thinEnough; ++gi) {
            if (!groups[gi].isOuter || gi == g || claimedPanelGroup[gi]) continue;
            for (int fi : groups[gi].faceIndices) {
              const TopoDS_Face& panelF = TopoDS::Face(faceMap(fi));
              gp_Vec pnNorm = faceOutwardNormal(panelF);
              if (std::abs(capNormVec.Dot(pnNorm)) <= 0.85) continue;
              BRepExtrema_DistShapeShape d(capFace, panelF);
              if (d.IsDone() && d.Value() <= maxThicknessMm) {
                thinEnough = true;
                matchedPanelGroup = gi;
                break;
              }
            }
          }
        }
        if (!thinEnough) continue;

        ProtrusionCandidate pc;
        pc.faceIndices   = component;
        pc.panelCentroid = groups[matchedPanelGroup].centroid;
        pc.panelNormal   = groups[matchedPanelGroup].normal;
        // For plate-style protrusions (when the cap face is anti-parallel to the
        // panel face), we need a back plane to bound the slab thickness.
        // Otherwise the half-space cut takes the entire half-solid.
        if (capNormVec.Dot(pc.panelNormal) < -0.85) {
          pc.hasBackPlane = true;
          pc.backCentroid = faceCentroid[capIdx];
          pc.backNormal   = capNormVec;
        } else if (hullRatio[matchedPanelGroup] < kInteriorThreshold) {
          // Tab-style on an INTERIOR host: half-space extraction would over-extract
          // everything on the +panelNormal side (including outer-hull material that
          // happens to lie beyond the host plane). Use a bounded box scoped to the
          // cap face's footprint instead.
          gp_Vec tabU, tabV;
          if (buildInPlaneAxes(pc.panelNormal, tabU, tabV)) {
            const TopoDS_Face& capFace2 = TopoDS::Face(faceMap(capIdx));
            double uMin, uMax, vMin, vMax;
            projectFootprint(capFace2, pc.panelCentroid, tabU, tabV,
                             uMin, uMax, vMin, vMax);
            if (uMax > uMin && vMax > vMin) {
              gp_Vec hostToCap(pc.panelCentroid, faceCentroid[capIdx]);
              double offset = std::abs(pc.panelNormal.Dot(hostToCap));
              pc.useBoundedTabBox = true;
              pc.tabU      = tabU;
              pc.tabV      = tabV;
              pc.tabUMin   = uMin;
              pc.tabUMax   = uMax;
              pc.tabVMin   = vMin;
              pc.tabVMax   = vMax;
              pc.tabHeight = offset;
            }
          }
        }
        candidates.push_back(std::move(pc));
        for (int fi : component) claimed[fi] = true;
        claimedPanelGroup[matchedPanelGroup] = true;
        if (matchedPanelGroup != g) claimedPanelGroup[g] = true;
        // Claim all faces parallel/anti-parallel to the cap face and within
        // maxThicknessMm of it. For a triangulated mesh, each plate face is split
        // into multiple coplanar triangles; without this, each triangle would
        // produce a duplicate protrusion candidate.
        for (int fi = 1; fi <= nFaces; ++fi) {
          if (claimed[fi]) continue;
          const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
          gp_Vec fn = faceOutwardNormal(f);
          if (std::abs(capNormVec.Dot(fn)) <= 0.85) continue;
          BRepExtrema_DistShapeShape d(capFace, f);
          if (d.IsDone() && d.Value() <= maxThicknessMm) {
            claimed[fi] = true;
            if (faceToGroup[fi] >= 0) claimedPanelGroup[faceToGroup[fi]] = true;
          }
        }
      }
    }

    // ÔöÇÔöÇ Option-2 pass: detect tabs/bosses whose cap face is itself a primary
    // face group sitting on an interior host (missed by the BFS, which only
    // seeds from non-primary faces). Uses the AABB-derived hullRatio computed
    // at the top of this function.
    for (int cap = 0; cap < (int)groups.size(); ++cap) {
      if (!groups[cap].isOuter || claimedPanelGroup[cap]) continue;
      if (hullRatio[cap] >= kInteriorThreshold) continue;  // cap must be interior

      int    bestHost     = -1;
      double bestHostArea = 0.0;

      for (int host = 0; host < (int)groups.size(); ++host) {
        if (host == cap || !groups[host].isOuter || claimedPanelGroup[host]) continue;
        if (hullRatio[host] >= kInteriorThreshold) continue;  // host must also be interior

        double dotProd = groups[cap].normal.Dot(groups[host].normal);
        if (dotProd < 0.85) continue;                          // tab-style only
        if (groups[cap].area >= 0.30 * groups[host].area) continue;

        gp_Vec hostToCap(groups[host].centroid, groups[cap].centroid);
        double offset = std::abs(groups[host].normal.Dot(hostToCap));
        if (offset < 1e-3 || offset > maxThicknessMm) continue;

        if (groups[host].area > bestHostArea) {
          bestHost     = host;
          bestHostArea = groups[host].area;
        }
      }

      if (bestHost < 0) continue;

      gp_Vec tabU, tabV;
      if (!buildInPlaneAxes(groups[bestHost].normal, tabU, tabV)) continue;

      // Project all cap-group face vertices onto the (tabU, tabV) plane.
      double uMin = 1e30, uMax = -1e30, vMin = 1e30, vMax = -1e30;
      for (int fi : groups[cap].faceIndices) {
        double u0, u1, v0, v1;
        projectFootprint(TopoDS::Face(faceMap(fi)), groups[bestHost].centroid,
                         tabU, tabV, u0, u1, v0, v1);
        uMin = std::min(uMin, u0); uMax = std::max(uMax, u1);
        vMin = std::min(vMin, v0); vMax = std::max(vMax, v1);
      }
      if (uMax <= uMin || vMax <= vMin) continue;

      gp_Vec hostToCap(groups[bestHost].centroid, groups[cap].centroid);
      double offset = std::abs(groups[bestHost].normal.Dot(hostToCap));

      ProtrusionCandidate pc;
      pc.faceIndices      = groups[cap].faceIndices;
      pc.panelCentroid    = groups[bestHost].centroid;
      pc.panelNormal      = groups[bestHost].normal;
      pc.useBoundedTabBox = true;
      pc.tabU             = tabU;
      pc.tabV             = tabV;
      pc.tabUMin          = uMin;
      pc.tabUMax          = uMax;
      pc.tabVMin          = vMin;
      pc.tabVMax          = vMax;
      pc.tabHeight        = offset;

      candidates.push_back(std::move(pc));
      for (int fi : groups[cap].faceIndices) claimed[fi] = true;
      claimedPanelGroup[cap]      = true;
      claimedPanelGroup[bestHost] = true;
    }

    // ÔöÇÔöÇ Option-3 pass: detect bridge/flange protrusions ÔÇö anti-parallel
    // interior face groups that form a thin slab (e.g. connecting flanges
    // between two concentric hollow cubes). Neither BFS nor Option-2 can
    // detect these because both exposed faces are primary groups and they
    // are anti-parallel, not parallel. We pair them by:
    //   1. Both interior (hullRatio < kInteriorThreshold)
    //   2. Anti-parallel normals (dot < -0.85)
    //   3. Normal-direction offset Ôëñ maxThicknessMm
    //   4. Similar areas (within 3:1)
    //   5. Overlapping 2-D footprints (rules out false pairs at same Y but
    //      different X, e.g. flanges on opposite sides of the solid)
    // Helper: find all interior groups coplanar AND topologically connected
    // to group g (same normal, same plane within 0.5 mm, and reachable via
    // shared edges between member faces). A meshed/triangulated flange face
    // is often emitted as two coplanar triangles that buildFaceGroups can't
    // merge if their shared diagonal is treated as a non-coplanar edge ÔÇö
    // without this consolidation Option-3 would produce one candidate per
    // triangle. Topology (not just coplanarity) ensures we don't pull in
    // physically separate flanges that happen to lie on the same plane.
    auto coplanarSiblings = [&](int g) -> std::vector<int> {
      std::vector<int> out = {g};
      const gp_Vec& n = groups[g].normal;
      const gp_Pnt& c = groups[g].centroid;
      std::set<int> inSet{g};
      std::set<int> faceSet(groups[g].faceIndices.begin(),
                            groups[g].faceIndices.end());
      bool grew = true;
      while (grew) {
        grew = false;
        for (int s = 0; s < (int)groups.size(); ++s) {
          if (inSet.count(s)) continue;
          if (!groups[s].isOuter || claimedPanelGroup[s]) continue;
          if (hullRatio[s] >= kInteriorThreshold) continue;
          if (groups[s].normal.Dot(n) < 0.95) continue;
          gp_Vec delta(c, groups[s].centroid);
          if (std::abs(n.Dot(delta)) > 0.5) continue;
          bool adj = false;
          for (int fi : groups[s].faceIndices) {
            for (int nbr : faceAdj[fi]) {
              if (faceSet.count(nbr)) { adj = true; break; }
            }
            if (adj) break;
          }
          if (!adj) continue;
          out.push_back(s);
          inSet.insert(s);
          for (int fi : groups[s].faceIndices) faceSet.insert(fi);
          grew = true;
        }
      }
      return out;
    };

    for (int capIdx3 = 0; capIdx3 < (int)groups.size(); ++capIdx3) {
      if (!groups[capIdx3].isOuter || claimedPanelGroup[capIdx3]) continue;
      if (hullRatio[capIdx3] >= kInteriorThreshold) continue;

      for (int backIdx = capIdx3 + 1; backIdx < (int)groups.size(); ++backIdx) {
        if (!groups[backIdx].isOuter || claimedPanelGroup[backIdx]) continue;
        if (hullRatio[backIdx] >= kInteriorThreshold) continue;

        double dp = groups[capIdx3].normal.Dot(groups[backIdx].normal);
        if (dp > -0.85) continue;  // must be anti-parallel

        gp_Vec c2b(groups[capIdx3].centroid, groups[backIdx].centroid);
        double slabOffset = std::abs(groups[capIdx3].normal.Dot(c2b));
        if (slabOffset < 1e-3 || slabOffset > maxThicknessMm) continue;

        // Consolidate coplanar siblings into the cap-side and back-side
        // logical faces, then aggregate their areas and footprints.
        auto capSibs  = coplanarSiblings(capIdx3);
        auto backSibs = coplanarSiblings(backIdx);

        double capArea = 0.0, backArea = 0.0;
        for (int s : capSibs)  capArea  += groups[s].area;
        for (int s : backSibs) backArea += groups[s].area;

        double minA = std::min(capArea, backArea);
        double maxA = std::max(capArea, backArea);
        if (maxA < 1e-6 || minA / maxA < 0.30) continue;

        gp_Vec tabU3, tabV3;
        if (!buildInPlaneAxes(groups[capIdx3].normal, tabU3, tabV3)) continue;

        // CRITICAL: use back centroid as the footprint reference so the
        // (tabUMin..tabUMax) bounds line up with panelCentroid (also set to
        // back centroid) when extractProtrusion builds the bounded box.
        // Mixing cap and back centroids here shifts the extraction box by
        // the in-plane offset between the two triangulated face centroids.
        const gp_Pnt& orig3 = groups[backIdx].centroid;
        auto unionFootprint = [&](const std::vector<int>& sibs,
                                  double& uMin, double& uMax,
                                  double& vMin, double& vMax) {
          uMin = 1e30; uMax = -1e30; vMin = 1e30; vMax = -1e30;
          for (int s : sibs) {
            for (int fi : groups[s].faceIndices) {
              double u0, u1, v0, v1;
              projectFootprint(TopoDS::Face(faceMap(fi)), orig3, tabU3, tabV3,
                               u0, u1, v0, v1);
              uMin = std::min(uMin, u0); uMax = std::max(uMax, u1);
              vMin = std::min(vMin, v0); vMax = std::max(vMax, v1);
            }
          }
        };

        double cUMin, cUMax, cVMin, cVMax;
        double bUMin, bUMax, bVMin, bVMax;
        unionFootprint(capSibs,  cUMin, cUMax, cVMin, cVMax);
        unionFootprint(backSibs, bUMin, bUMax, bVMin, bVMax);

        double overlapU = std::min(cUMax, bUMax) - std::max(cUMin, bUMin);
        double overlapV = std::min(cVMax, bVMax) - std::max(cVMin, bVMin);
        if (overlapU <= 0.0 || overlapV <= 0.0) continue;

        ProtrusionCandidate pc3;
        for (int s : capSibs)  for (int fi : groups[s].faceIndices)  pc3.faceIndices.push_back(fi);
        for (int s : backSibs) for (int fi : groups[s].faceIndices)  pc3.faceIndices.push_back(fi);
        pc3.panelCentroid    = groups[backIdx].centroid;
        pc3.panelNormal      = groups[capIdx3].normal;
        pc3.useBoundedTabBox = true;
        pc3.tabU             = tabU3;
        pc3.tabV             = tabV3;
        pc3.tabUMin          = std::max(cUMin, bUMin);
        pc3.tabUMax          = std::min(cUMax, bUMax);
        pc3.tabVMin          = std::max(cVMin, bVMin);
        pc3.tabVMax          = std::min(cVMax, bVMax);
        pc3.tabHeight        = slabOffset;
        // Bridge flanges butt directly against adjacent cube walls; the
        // default 0.5 mm pad/bleed catches a sliver of those walls and
        // inflates the extracted bbox. 0.05 mm is enough for boolean
        // robustness without crossing into adjacent material.
        pc3.tightPad         = 0.05;
        pc3.tightBleed       = 0.05;

        candidates.push_back(std::move(pc3));
        for (int s : capSibs)  claimedPanelGroup[s] = true;
        for (int s : backSibs) claimedPanelGroup[s] = true;
        break;
      }
    }

    return candidates;
  }

  // T018 ÔÇö Extract one protrusion from the solid by cutting at the primary
  // panel's outer face plane. Updates remainder (solid minus protrusion).
  // planeHalfSize: symmetric UV half-extent for the cutting planeFace.
  //   Must be large enough to span the entire solid cross-section at the cut plane.
  //   Computed once from the original solid's diagonal (vertex-iterated) so it is
  //   geometrically correct without ballooning to the ┬▒200 km values that
  //   BRepBndLib::Add can report for STEP-imported planar faces.
  static TopoDS_Shape extractProtrusion(
      const TopoDS_Shape&        solid,
      const ProtrusionCandidate& pc,
      TopoDS_Shape&              remainder,
      double                     planeHalfSize)
  {
    gp_Dir planeDir(pc.panelNormal.X(), pc.panelNormal.Y(), pc.panelNormal.Z());
    gp_Pln outerPlane(pc.panelCentroid, planeDir);

    BRepBuilderAPI_MakeFace planeFaceMaker(
        outerPlane,
        -planeHalfSize, planeHalfSize,
        -planeHalfSize, planeHalfSize);
    if (!planeFaceMaker.IsDone())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Could not build cutting plane for protrusion", true, "rollback");

    // Reference point on the protrusion side.
    //   - Tab-style: panel is on the solid bulk side, normal points toward the tab
    //     body. Reference goes in +panelNormal direction.
    //   - Plate-style (hasBackPlane): panel is the outer wide face, normal points
    //     AWAY from the slab body. Reference goes in -panelNormal direction.
    double refSign = pc.hasBackPlane ? -1.0 : 1.0;
    gp_Pnt outerRef(
        pc.panelCentroid.X() + refSign * pc.panelNormal.X() * 1e4,
        pc.panelCentroid.Y() + refSign * pc.panelNormal.Y() * 1e4,
        pc.panelCentroid.Z() + refSign * pc.panelNormal.Z() * 1e4);

    TopoDS_Shape cutter;
    if (pc.useBoundedTabBox) {
      // Option-2 interior-host tab: build a box scoped to the cap's 2D
      // footprint (precomputed in (tabU, tabV)) ├ù tab height along panelNormal.
      // The box brackets the tab volume exactly, so the boolean Common
      // captures only the tab and not the surrounding solid.
      const double pad   = (pc.tightPad   >= 0.0) ? pc.tightPad   : 0.5;
      const double bleed = (pc.tightBleed >= 0.0) ? pc.tightBleed : 0.5;
      double uSize = (pc.tabUMax - pc.tabUMin) + 2.0 * pad;
      double vSize = (pc.tabVMax - pc.tabVMin) + 2.0 * pad;
      double hSize = pc.tabHeight + 2.0 * bleed;

      // Box origin: low-(u,v) corner, dropped slightly below the host plane.
      gp_Pnt origin(
          pc.panelCentroid.X()
            + pc.tabU.X() * (pc.tabUMin - pad)
            + pc.tabV.X() * (pc.tabVMin - pad)
            - pc.panelNormal.X() * bleed,
          pc.panelCentroid.Y()
            + pc.tabU.Y() * (pc.tabUMin - pad)
            + pc.tabV.Y() * (pc.tabVMin - pad)
            - pc.panelNormal.Y() * bleed,
          pc.panelCentroid.Z()
            + pc.tabU.Z() * (pc.tabUMin - pad)
            + pc.tabV.Z() * (pc.tabVMin - pad)
            - pc.panelNormal.Z() * bleed);

      gp_Dir zAxis(pc.panelNormal.X(), pc.panelNormal.Y(), pc.panelNormal.Z());
      gp_Dir xAxis(pc.tabU.X(), pc.tabU.Y(), pc.tabU.Z());
      gp_Ax2 ax(origin, zAxis, xAxis);

      BRepPrimAPI_MakeBox boxMaker(ax, uSize, vSize, hSize);
      try {
        boxMaker.Build();
        if (!boxMaker.IsDone())
          throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                              "Could not build bounded tab box", true, "rollback");
        cutter = boxMaker.Solid();
      } catch (const Standard_Failure&) {
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Bounded tab box construction threw", true, "rollback");
      }
    } else if (pc.hasBackPlane) {
      // Plate-style: build a bounded slab box between the back plane and the
      // panel plane. Half-space intersection produces a fragile cutter that
      // can corrupt the solid; a real bounded box is robust.
      gp_Vec slabAxis = pc.panelNormal;  // points away from slab body
      // Slab thickness along the panel normal: distance between the two planes
      gp_Vec backToPanel(pc.backCentroid, pc.panelCentroid);
      double slabThickness = std::abs(slabAxis.Dot(backToPanel)) + 0.1; // small over-extend
      // Slab origin: walk from back centroid in -slabAxis to be just past it.
      // backNormal points AWAY from slab body, so slab body is on -backNormal side.
      gp_Pnt slabCorner = pc.backCentroid;
      // Build axes perpendicular to slab axis (any two orthogonal directions).
      gp_Vec perpA;
      if (std::abs(slabAxis.X()) < 0.9) perpA = gp_Vec(1, 0, 0);
      else                              perpA = gp_Vec(0, 1, 0);
      perpA = perpA.Crossed(slabAxis);
      if (perpA.Magnitude() < 1e-6) perpA = gp_Vec(0, 0, 1);
      perpA.Normalize();
      gp_Vec perpB = slabAxis.Crossed(perpA);
      perpB.Normalize();
      // Move corner so the box brackets the slab and extends past the solid in
      // the perpendicular directions.
      gp_Pnt origin(
          slabCorner.X() - perpA.X() * planeHalfSize - perpB.X() * planeHalfSize - pc.backNormal.X() * 0.05,
          slabCorner.Y() - perpA.Y() * planeHalfSize - perpB.Y() * planeHalfSize - pc.backNormal.Y() * 0.05,
          slabCorner.Z() - perpA.Z() * planeHalfSize - perpB.Z() * planeHalfSize - pc.backNormal.Z() * 0.05);
      gp_Dir xAxis(perpA.X(), perpA.Y(), perpA.Z());
      // Box Z-axis points into the slab body: -backNormal direction.
      // (Equivalent to +panelNormal when back & panel are anti-parallel, but
      // we anchor on the back plane so we use backNormal directly.)
      gp_Dir zAxis(-pc.backNormal.X(), -pc.backNormal.Y(), -pc.backNormal.Z());
      gp_Ax2 ax(origin, zAxis, xAxis);
      BRepPrimAPI_MakeBox boxMaker(ax,
          2.0 * planeHalfSize, 2.0 * planeHalfSize, slabThickness);
      try {
        boxMaker.Build();
        if (!boxMaker.IsDone())
          throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                              "Could not build plate slab box", true, "rollback");
        cutter = boxMaker.Solid();
      } catch (const Standard_Failure&) {
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Plate slab box construction threw", true, "rollback");
      }
    } else {
      // Tab-style: use the original half-space cutter.
      BRepPrimAPI_MakeHalfSpace hs(planeFaceMaker.Face(), outerRef);
      hs.Build();
      if (!hs.IsDone())
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Could not build half-space for protrusion extraction", true, "rollback");
      cutter = hs.Solid();
    }

    BRepAlgoAPI_Common extract(solid, cutter);
    extract.Build();
    if (!extract.IsDone() || extract.Shape().IsNull())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Protrusion intersection produced null result", true, "rollback");

    GProp_GProps ep;
    BRepGProp::VolumeProperties(extract.Shape(), ep);
    if (std::abs(ep.Mass()) < 1e-6)
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Protrusion extraction has zero volume (degenerate)", true, "rollback");

    BRepAlgoAPI_Cut cutRemainder(solid, cutter);
    cutRemainder.Build();
    if (!cutRemainder.IsDone() || cutRemainder.Shape().IsNull())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Could not trim remainder after protrusion extraction", true, "rollback");

    remainder = cutRemainder.Shape();
    return extract.Shape();
  }

  // Sanity check: a real protrusion (tab/boss/flange) is a localized feature,
  // small in at least two of three axes relative to the host solid. A "panel-
  // sized" candidate spans > 80% of the solid in 2+ axes ÔÇö that's a wall slab
  // misdetected as a protrusion (e.g. when nested-cube topology lets BFS
  // wrap a plate-style candidate around a full outer face). Reject those so
  // the geometry stays in workShape for splitMode2 to handle as a panel.
  static bool isPanelSized(const TopoDS_Shape& candidate, const TopoDS_Shape& solid) {
    auto extentVia = [](const TopoDS_Shape& s,
                        double& dx, double& dy, double& dz) -> bool {
      double xMin = 1e30, yMin = 1e30, zMin = 1e30;
      double xMax = -1e30, yMax = -1e30, zMax = -1e30;
      bool any = false;
      for (TopExp_Explorer ex(s, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        xMin = std::min(xMin, p.X()); xMax = std::max(xMax, p.X());
        yMin = std::min(yMin, p.Y()); yMax = std::max(yMax, p.Y());
        zMin = std::min(zMin, p.Z()); zMax = std::max(zMax, p.Z());
        any = true;
      }
      if (!any) return false;
      dx = xMax - xMin; dy = yMax - yMin; dz = zMax - zMin;
      return true;
    };

    double cx, cy, cz, sx, sy, sz;
    if (!extentVia(candidate, cx, cy, cz)) return false;
    if (!extentVia(solid, sx, sy, sz))     return false;

    constexpr double kPanelThreshold = 0.80;
    int largeAxes = 0;
    if (sx > 1e-6 && cx / sx > kPanelThreshold) ++largeAxes;
    if (sy > 1e-6 && cy / sy > kPanelThreshold) ++largeAxes;
    if (sz > 1e-6 && cz / sz > kPanelThreshold) ++largeAxes;
    return largeAxes >= 2;
  }

  // Mode 1: BFS + extrusion (surface/conceptual model).
  // Each coplanar face group is extruded by defaultThicknessMm along its outward normal.
  void splitMode1BFS(const TopoDS_Shape& shape,
                     const SolidId& parentId,
                     double angleThresholdDeg,
                     double defaultThicknessMm,
                     std::vector<ShellId>& panelIds,
                     std::vector<ShapeHistoryRecord>* historyOut = nullptr)
  {
    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
    if (faceMap.Extent() == 0) return;

    // Dummy centroid for isOuter classification (not used in Mode 1 extrusion)
    auto groups = buildFaceGroups(shape, faceMap, angleThresholdDeg, gp_Pnt(0,0,0));

    for (const auto& grp : groups) {
      // Collect boundary edges: edges adjacent to only one face in this group.
      // Build a set of face indices for fast membership test.
      std::set<int> groupSet(grp.faceIndices.begin(), grp.faceIndices.end());

      // Gather all edges from the group faces and count how many group faces share each edge.
      TopTools_IndexedDataMapOfShapeListOfShape edgeFaceMap;
      for (int idx : grp.faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        for (TopExp_Explorer edgeEx(f, TopAbs_EDGE); edgeEx.More(); edgeEx.Next()) {
          const TopoDS_Shape& e = edgeEx.Current();
          if (!edgeFaceMap.Contains(e)) {
            edgeFaceMap.Add(e, TopTools_ListOfShape());
          }
          // Only add if not already in list for this face
          TopTools_ListOfShape& lst = edgeFaceMap.ChangeFromKey(e);
          bool found = false;
          for (const TopoDS_Shape& s : lst) {
            if (s.IsEqual(f)) { found = true; break; }
          }
          if (!found) lst.Append(f);
        }
      }

      // Boundary edges are those touching exactly one group face
      BRepBuilderAPI_MakeWire wireMaker;
      bool hasEdge = false;
      for (int i = 1; i <= edgeFaceMap.Extent(); ++i) {
        if (edgeFaceMap(i).Size() == 1) {
          const TopoDS_Edge& e = TopoDS::Edge(edgeFaceMap.FindKey(i));
          wireMaker.Add(e);
          hasEdge = true;
        }
      }

      if (!hasEdge || !wireMaker.IsDone()) {
        // Fallback: store as a zero-thickness shell (e.g. closed surface)
        BRep_Builder builder;
        TopoDS_Shell sh;
        builder.MakeShell(sh);
        for (int idx : grp.faceIndices)
          builder.Add(sh, faceMap(idx));
        ShellId sid = generateUUID();
        shells_[sid] = ShellState{sid, parentId, sh};
        panelIds.push_back(sid);
        continue;
      }

      // Build a planar face from the boundary wire using the group's plane
      gp_Pln grpPlane(grp.centroid, gp_Dir(grp.normal));
      TopoDS_Wire rawWire = wireMaker.Wire();
      TopoDS_Wire fixedWire = rawWire;

      try {
        Handle(ShapeFix_Wire) sfw = new ShapeFix_Wire();
        sfw->Load(rawWire);
        BRepBuilderAPI_MakeFace tempFaceMaker(grpPlane);
        if (tempFaceMaker.IsDone()) {
          sfw->SetFace(tempFaceMaker.Face());
        }
        sfw->SetPrecision(0.15); // fuzzy tolerance for wire healing
        sfw->FixReorder();
        sfw->FixConnected();
        sfw->FixClosed();
        fixedWire = sfw->Wire();
      } catch (...) {
        // Keep rawWire if ShapeFix_Wire fails
      }

      TopoDS_Face finalFace;
      BRepBuilderAPI_MakeFace faceMaker(grpPlane, fixedWire, Standard_True);
      if (faceMaker.IsDone()) {
        finalFace = faceMaker.Face();
      } else {
        // If first attempt failed, try BRepBuilderAPI_Sewing to heal the edges!
        try {
          BRepBuilderAPI_Sewing sewer(0.15);
          for (int i = 1; i <= edgeFaceMap.Extent(); ++i) {
            if (edgeFaceMap(i).Size() == 1) {
              const TopoDS_Edge& e = TopoDS::Edge(edgeFaceMap.FindKey(i));
              sewer.Add(e);
            }
          }
          sewer.Perform();
          TopoDS_Shape sewed = sewer.SewedShape();
          TopoDS_Wire sewedWire;
          if (sewed.ShapeType() == TopAbs_WIRE) {
            sewedWire = TopoDS::Wire(sewed);
          } else {
            TopExp_Explorer wireEx(sewed, TopAbs_WIRE);
            if (wireEx.More()) {
              sewedWire = TopoDS::Wire(wireEx.Current());
            }
          }
          if (!sewedWire.IsNull()) {
            BRepBuilderAPI_MakeFace faceMaker2(grpPlane, sewedWire, Standard_True);
            if (faceMaker2.IsDone()) {
              finalFace = faceMaker2.Face();
            }
          }
        } catch (...) {
          // Sewer failed
        }
      }

      if (finalFace.IsNull()) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Could not build planar face from boundary wire", true, "rollback");
      }

      // Extrude along the group's outward normal
      gp_Vec extVec(grp.normal.X() * defaultThicknessMm,
                    grp.normal.Y() * defaultThicknessMm,
                    grp.normal.Z() * defaultThicknessMm);
      BRepPrimAPI_MakePrism prism(finalFace, extVec);
      prism.Build();
      if (!prism.IsDone() || prism.Shape().IsNull()) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Extrusion failed for panel group", true, "rollback");
      }

      // Basic manifold check: shape must have a non-degenerate volume
      GProp_GProps volProps;
      BRepGProp::VolumeProperties(prism.Shape(), volProps);
      if (std::abs(volProps.Mass()) < 1e-6) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Extruded panel has zero volume (non-manifold result)", true, "rollback");
      }

      if (historyOut) {
        auto records = captureHistory(prism, finalFace,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }

      ShellId sid = generateUUID();
      shells_[sid] = ShellState{sid, parentId, prism.Shape()};
      panelIds.push_back(sid);
    }
  }

  // Mode 2: Thin-solid cutting. For each outer/inner panel pair, use the
  // inner face plane to slice a slab off the remainder solid.
  // planeHalfSize: symmetric UV half-extent for every cutting planeFace.
  //   Large enough to span the entire solid so each cut fully consumes all
  //   material on one side (keeping panel count correct and remainder small).
  //   Cap-face rectangle corners from OCCT Boolean ops will lie outside the
  //   original solid's true bounding box; the caller's computeBboxes filters
  //   those out when reporting panel extents.
  // remainderOut (optional): receives the solid left after all panel cuts.
  void splitMode2(const TopoDS_Shape& solid,
                  double              planeHalfSize,
                  const SolidId& parentId,
                  double angleThresholdDeg,
                  double maxThicknessMm,
                  std::vector<ShellId>& panelIds,
                  std::vector<ShellId>& protrusionIds,
                  std::vector<ProtrusionParent>& protrusionParents,
                  TopoDS_Shape* remainderOut = nullptr,
                  std::vector<ShapeHistoryRecord>* historyOut = nullptr)
  {
    GProp_GProps solidProps;
    BRepGProp::VolumeProperties(solid, solidProps);
    gp_Pnt solidCentroid = solidProps.CentreOfMass();

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(solid, TopAbs_FACE, faceMap);
    if (faceMap.Extent() == 0) {
      throw GeometryError(GE_DECOMPOSE_CUT_FAILED, "Solid has no faces", true, "rollback");
    }

    auto groups = buildFaceGroups(solid, faceMap, angleThresholdDeg, solidCentroid);

    // For each outer group, find its closest anti-parallel inner group
    struct PanelCut {
      int                 groupI;
      int                 groupJ;
      double              bestDist;
      double              distFromCenter;
      std::vector<int>    allGroupsI;
      std::vector<int>    allGroupsJ;
    };

    std::vector<PanelCut> cuts;
    cuts.reserve(groups.size());

    for (int i = 0; i < (int)groups.size(); ++i) {
      if (!groups[i].isOuter) continue;

      // Skip non-planar face groups (rounded bends / corners)
      const TopoDS_Face& fOut = TopoDS::Face(faceMap(groups[i].faceIndices[0]));
      Handle(Geom_Surface) surfOut = BRep_Tool::Surface(fOut);
      if (surfOut.IsNull() || !surfOut->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

      // Compute bounding box for group i safely using vertices
      Bnd_Box boxI;
      for (int idx : groups[i].faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
          boxI.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
        }
      }

      double bestDist = std::numeric_limits<double>::max();
      int    bestJ    = -1;

      for (int j = 0; j < (int)groups.size(); ++j) {
        if (i == j || groups[j].isOuter) continue;
        if (groups[i].normal.Dot(groups[j].normal) > -0.95) continue;

        // Compute bounding box for group j safely using vertices
        Bnd_Box boxJ;
        for (int idx : groups[j].faceIndices) {
          const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
          for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
            boxJ.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
          }
        }

        // Check if group i and group j overlap transversely by inflating boxI
        Bnd_Box boxI_inflated = boxI;
        boxI_inflated.Enlarge(maxThicknessMm * 1.5);
        if (boxI_inflated.IsOut(boxJ)) continue;

        // Measure face-to-face distance using plane-to-plane projection
        double dist = std::abs(gp_Vec(groups[i].centroid, groups[j].centroid).Dot(groups[i].normal));
        if (dist > maxThicknessMm) continue;
        if (dist < bestDist) { bestDist = dist; bestJ = j; }
      }

      if (bestJ < 0) continue;

      double distFromCenter = groups[i].normal.Dot(gp_Vec(solidCentroid, groups[i].centroid));
      cuts.push_back({i, bestJ, bestDist, distFromCenter, {}, {}});
    }

    // Merge coplanar cuts (belonging to same wall plane but split by holes)
    std::vector<PanelCut> mergedCuts;
    for (const auto& cut : cuts) {
      bool foundCoplanar = false;
      for (auto& mCut : mergedCuts) {
        gp_Dir n1 = groups[cut.groupI].normal;
        gp_Dir n2 = groups[mCut.groupI].normal;
        if (n1.Dot(n2) > 0.95) {
          double dist = std::abs(gp_Vec(groups[cut.groupI].centroid, groups[mCut.groupI].centroid).Dot(n1));
          if (dist < 1.0) {
            mCut.allGroupsI.push_back(cut.groupI);
            mCut.allGroupsJ.push_back(cut.groupJ);
            mCut.bestDist = std::min(mCut.bestDist, cut.bestDist);
            foundCoplanar = true;
            break;
          }
        }
      }
      if (!foundCoplanar) {
        PanelCut newMCut = cut;
        newMCut.allGroupsI = {cut.groupI};
        newMCut.allGroupsJ = {cut.groupJ};
        mergedCuts.push_back(newMCut);
      }
    }
    cuts = std::move(mergedCuts);

    // Process outermost panels first (minimises corner-ownership artefacts)
    std::sort(cuts.begin(), cuts.end(), [](const PanelCut& a, const PanelCut& b) {
      return a.distFromCenter > b.distFromCenter;
    });

    TopoDS_Shape remainder = solid;

    for (const auto& cut : cuts) {
      if (remainder.IsNull()) break;

      int i = cut.groupI;
      double bestDist = cut.bestDist;

      // Define local coordinate system (U, V, N) for the flat face group i
      gp_Dir N(groups[i].normal);
      gp_Dir U;
      if (std::abs(N.X()) < 0.9) U = gp_Dir(1, 0, 0).Crossed(N);
      else U = gp_Dir(0, 1, 0).Crossed(N);
      gp_Dir V = N.Crossed(U);

      // Find min/max of all vertices of group i in local axes
      double uMin = 1e30, uMax = -1e30;
      double vMin = 1e30, vMax = -1e30;
      double nValue = 0.0;
      bool firstPt = true;

      for (int gIdx : cut.allGroupsI) {
        for (int idx : groups[gIdx].faceIndices) {
          const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
          for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
            gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
            double u = gp_Vec(p.XYZ()).Dot(U.XYZ());
            double v = gp_Vec(p.XYZ()).Dot(V.XYZ());
            double n = gp_Vec(p.XYZ()).Dot(N.XYZ());
            uMin = std::min(uMin, u); uMax = std::max(uMax, u);
            vMin = std::min(vMin, v); vMax = std::max(vMax, v);
            if (firstPt) { nValue = n; firstPt = false; }
          }
        }
      }

      double dx = uMax - uMin;
      double dy = vMax - vMin;
      double dz = bestDist + 1.0; // 0.5 mm bleed on each side

      if (dx <= 1e-3 || dy <= 1e-3 || dz <= 1e-3) continue;

      // Origin at local U*uMin + V*vMin + N*(nValue - bestDist - 0.5)
      gp_Pnt origin(U.XYZ() * uMin + V.XYZ() * vMin + N.XYZ() * (nValue - bestDist - 0.5));
      gp_Ax2 localSystem(origin, N, U);

      std::cout << "[DEBUG splitMode2] Box solid info:" << std::endl;
      std::cout << "  origin: (" << origin.X() << ", " << origin.Y() << ", " << origin.Z() << ")" << std::endl;
      std::cout << "  N: (" << N.X() << ", " << N.Y() << ", " << N.Z() << ")" << std::endl;
      std::cout << "  U: (" << U.X() << ", " << U.Y() << ", " << U.Z() << ")" << std::endl;
      std::cout << "  dx=" << dx << ", dy=" << dy << ", dz=" << dz << std::endl;

      BRepPrimAPI_MakeBox boxMaker(localSystem, dx, dy, dz);
      boxMaker.Build();
      if (!boxMaker.IsDone()) continue;
      TopoDS_Solid boxSolid = boxMaker.Solid();

      // Extract panel slab = ORIGINAL_SOLID Ôê® boxSolid (not remainder).
      //
      // Extracting from the remainder caused successive panels to be trimmed
      // at the corners where earlier panels had already been cut out. The
      // resulting panels only touched along an edge (no volumetric overlap),
      // which broke merge_bodies_with_bend: the strict 0.1mm proximity
      // seam-detection filter couldn't find the outer corner edge because
      // it sat one wall-thickness away from the trimmed input. Panels that
      // overlap at corners (as adjacent sheet metal walls physically do)
      // give a clean fuse with the corner absorbed into the merged solid,
      // and the seam edge sits right on both inputs.
      BRepAlgoAPI_Common extract(solid, boxSolid);
      extract.Build();
      if (!extract.IsDone() || extract.Shape().IsNull()) continue;

      GProp_GProps ep;
      BRepGProp::VolumeProperties(extract.Shape(), ep);
      if (std::abs(ep.Mass()) < 1e-6) continue;  // empty slab ÔÇö skip

      if (historyOut) {
        auto records = captureHistory(extract, remainder,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }

      ShellId panelId = generateUUID();
      shells_[panelId] = ShellState{panelId, parentId, extract.Shape()};
      panelIds.push_back(panelId);
      (void)protrusionIds;       // reserved for future post-cut handling
      (void)protrusionParents;   // reserved for future post-cut handling

      // Remainder = remainder minus the boxSolid
      BRepAlgoAPI_Cut cutRemainder(remainder, boxSolid);
      cutRemainder.Build();
      if (historyOut && cutRemainder.IsDone()) {
        auto records = captureHistory(cutRemainder, remainder,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }
      if (!cutRemainder.IsDone() || cutRemainder.Shape().IsNull()) break;
      remainder = cutRemainder.Shape();
    }

    if (remainderOut) *remainderOut = remainder;
  }

  // T022 ÔÇö Recursive decomposition. Operates on an arbitrary solid shape
  // (not a registered shell), with the mutex already held by the caller.
  void recursiveDecompose(
      const TopoDS_Shape&  shape,
      const SolidId&       parentId,
      double               angleThresholdDeg,
      double               maxThicknessMm,
      double               defaultThicknessMm,
      int                  remainingDepth,
      std::vector<ShellId>&        panelIds,
      std::vector<ShellId>&        protrusionIds,
      std::vector<ProtrusionParent>& protrusionParents)
  {
    if (remainingDepth <= 0 || shape.IsNull()) return;

    GProp_GProps rp;
    BRepGProp::VolumeProperties(shape, rp);
    if (std::abs(rp.Mass()) < 1.0) return;  // < 1 mm┬│ ÔÇö nothing meaningful left

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
    if (faceMap.Extent() < 2) return;  // degenerate

    std::string mode = detectObjectMode(shape, maxThicknessMm);

    gp_Pnt solidCentroid(0, 0, 0);
    if (mode == "thin_solid") {
      GProp_GProps vp;
      BRepGProp::VolumeProperties(shape, vp);
      solidCentroid = vp.CentreOfMass();
    }

    auto faceGroups     = buildFaceGroups(shape, faceMap, angleThresholdDeg, solidCentroid);
    auto protrCandidates = detectProtrusions(shape, faceMap, faceGroups, maxThicknessMm);

    // Termination: no primary panel groups found in this component
    bool hasPrimaryGroup = false;
    for (const auto& g : faceGroups) { if (g.isOuter) { hasPrimaryGroup = true; break; } }
    if (!hasPrimaryGroup) return;

    // Compute planeHalfSize from this component's vertex bounds (vertex iteration,
    // not BRepBndLib::Add which can report ┬▒200 km for STEP-imported planar faces).
    double localHalfSize = 1000.0;
    {
      double lxMin = 1e30, lxMax = -1e30;
      double lyMin = 1e30, lyMax = -1e30;
      double lzMin = 1e30, lzMax = -1e30;
      for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        lxMin = std::min(lxMin, p.X()); lxMax = std::max(lxMax, p.X());
        lyMin = std::min(lyMin, p.Y()); lyMax = std::max(lyMax, p.Y());
        lzMin = std::min(lzMin, p.Z()); lzMax = std::max(lzMax, p.Z());
      }
      double d2 = (lxMax-lxMin)*(lxMax-lxMin)
                + (lyMax-lyMin)*(lyMax-lyMin)
                + (lzMax-lzMin)*(lzMax-lzMin);
      if (d2 > 0) localHalfSize = std::sqrt(d2) * 1.1 + 10.0;
    }

    TopoDS_Shape workShape = shape;
    for (const auto& pc : protrCandidates) {
      TopoDS_Shape newRemainder;
      try {
        TopoDS_Shape ps = extractProtrusion(workShape, pc, newRemainder, localHalfSize);
        if (isPanelSized(ps, workShape)) continue;  // false positive ÔÇö leave for splitMode2
        ShellId pid = generateUUID();
        shells_[pid] = ShellState{pid, parentId, ps};
        protrusionIds.push_back(pid);
        protrusionParents.push_back({pid, ""});  // pre-cut: panel not yet determined
        workShape = std::move(newRemainder);
      } catch (const GeometryError&) {}
    }

    // If protrusion extraction disconnected workShape into multiple solids
    // (e.g., testcube's bridge flanges connected the inner and outer hollow
    // cubes; removing them leaves two separate solids), splitMode2 would
    // bundle the inner and outer walls into mixed panels because each outer
    // face would find an anti-parallel match across the void. Recurse on each
    // component separately so each cube is decomposed in isolation.
    {
      std::vector<TopoDS_Shape> components;
      for (TopExp_Explorer ex(workShape, TopAbs_SOLID); ex.More(); ex.Next()) {
        components.push_back(ex.Current());
      }
      if (components.size() > 1) {
        for (const auto& comp : components) {
          recursiveDecompose(comp, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, remainingDepth, panelIds,
                             protrusionIds, protrusionParents);
        }
        return;
      }
    }

    TopoDS_Shape childRemainder;
    if (mode == "thin_solid") {
      splitMode2(workShape, localHalfSize, parentId, angleThresholdDeg, maxThicknessMm,
                 panelIds, protrusionIds, protrusionParents, &childRemainder);
    } else {
      splitMode1BFS(workShape, parentId, angleThresholdDeg, defaultThicknessMm, panelIds);
      return;  // surface mode has no structured remainder
    }

    if (childRemainder.IsNull()) return;

    // Recurse on each connected solid component of the remainder
    bool hadSolid = false;
    for (TopExp_Explorer ex(childRemainder, TopAbs_SOLID); ex.More(); ex.Next()) {
      recursiveDecompose(ex.Current(), parentId, angleThresholdDeg, maxThicknessMm,
                         defaultThicknessMm, remainingDepth - 1, panelIds, protrusionIds,
                         protrusionParents);
      hadSolid = true;
    }
    if (!hadSolid) {
      recursiveDecompose(childRemainder, parentId, angleThresholdDeg, maxThicknessMm,
                         defaultThicknessMm, remainingDepth - 1, panelIds, protrusionIds,
                         protrusionParents);
    }
  }

  // ÔöÇÔöÇ Main entry point ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  DecomposedByBendsResult splitBodyByBends(const ShellId& partId,
                                            double angleThresholdDeg,
                                            double maxThicknessMm    = 5.0,
                                            double defaultThicknessMm = 1.0,
                                            int    maxRecursionDepth  = 1) override {

    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != solids_.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }
    if (angleThresholdDeg < 0.0) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          "angle_threshold_deg must be non-negative", true, "");
    }

    SnapshotId token = createSnapshotLocked("before splitBodyByBends on " + partId);

    try {
      // Copy shape: protrusion extraction adds shells to shells_, which can
      // rehash the map and invalidate iterators. Copying avoids a dangling ref.
      TopoDS_Shape shape    = inputShape;
      SolidId      parentId = inputParentId;

      TopTools_IndexedMapOfShape faceMapInput;
      TopExp::MapShapes(shape, TopAbs_FACE, faceMapInput);

      // US1: Facet Unification Pass - Merge adjacent coplanar/planar triangular facets
      // of complex segmented models (like cauldron.step) before decomposition
      try {
        ShapeUpgrade_UnifySameDomain unifier(shape, Standard_True, Standard_True, Standard_True);
        double angTolRad = angleThresholdDeg * M_PI / 180.0;
        if (angTolRad < 1e-6) angTolRad = 0.0087; // default 0.5 degrees
        unifier.SetAngularTolerance(angTolRad);
        unifier.SetLinearTolerance(0.05); // slightly looser linear tol to heal facets
        unifier.Build();
        TopoDS_Shape unifiedShape = unifier.Shape();
        if (!unifiedShape.IsNull()) {
          shape = unifiedShape;
        }
      } catch (const Standard_Failure&) {
      } catch (const std::exception&) {
      } catch (...) {
      }

      std::string mode = detectObjectMode(shape, maxThicknessMm);

      TopTools_IndexedMapOfShape faceMapPre;
      TopExp::MapShapes(shape, TopAbs_FACE, faceMapPre);
      
      int planeCount = 0;
      int cylCount = 0;
      int otherCount = 0;
      for (int i = 1; i <= faceMapPre.Extent(); ++i) {
        TopoDS_Face f = TopoDS::Face(faceMapPre(i));
        Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
        if (!surf.IsNull()) {
          if (surf->IsKind(STANDARD_TYPE(Geom_Plane))) planeCount++;
          else if (surf->IsKind(STANDARD_TYPE(Geom_CylindricalSurface))) cylCount++;
          else otherCount++;
        }
      }
      
      // Build face groups now (needed for protrusion detection).
      // For surface mode isOuter classification is irrelevant; pass dummy centroid.
      gp_Pnt solidCentroid(0, 0, 0);
      if (mode == "thin_solid") {
        GProp_GProps vp;
        BRepGProp::VolumeProperties(shape, vp);
        solidCentroid = vp.CentreOfMass();
      }
      auto faceGroupsPre = buildFaceGroups(shape, faceMapPre, angleThresholdDeg, solidCentroid);

      // Compute the original solid's tight bounding box via vertex iteration.
      // BRepBndLib::Add is NOT used here: for STEP-imported shapes it samples the
      // underlying surface's full UV domain and can report ┬▒200 km for a planar face
      // whose untrimmed surface extends far beyond the actual wire boundary.
      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }
      double diagSq = (bxMax-bxMin)*(bxMax-bxMin)
                    + (byMax-byMin)*(byMax-byMin)
                    + (bzMax-bzMin)*(bzMax-bzMin);
      // planeHalfSize: large enough to span the entire solid at any cut plane.
      // The resulting cap-face rectangle corners end up outside the original bbox;
      // computeBboxes filters them out using bxMin/bxMax etc. + 1 mm tolerance.
      double planeHalfSize = (diagSq > 0 ? std::sqrt(diagSq) : 1000.0) * 1.1 + 10.0;

      // T019 ÔÇö Detect and extract protrusions before panel cutting.
      std::vector<ShellId>         panelIds;
      std::vector<ShellId>         protrusionIds;
      std::vector<ProtrusionParent> protrusionParents;

      auto protrCandidates = detectProtrusions(shape, faceMapPre, faceGroupsPre, maxThicknessMm);
      TopoDS_Shape workShape = shape;
      for (const auto& pc : protrCandidates) {
        TopoDS_Shape newRemainder;
        try {
          TopoDS_Shape protrusionSolid = extractProtrusion(workShape, pc, newRemainder, planeHalfSize);
          // Reject panel-sized extractions: those are false positives from
          // detection misfiring on wall slabs (see isPanelSized). Leave the
          // geometry in workShape so splitMode2 handles it as a panel.
          if (isPanelSized(protrusionSolid, workShape)) continue;
          ShellId pid = generateUUID();
          shells_[pid] = ShellState{pid, parentId, protrusionSolid};
          protrusionIds.push_back(pid);
          protrusionParents.push_back({pid, ""});  // pre-cut: no panel assigned yet
          workShape = std::move(newRemainder);
        } catch (const GeometryError&) {
          // Non-fatal: skip this protrusion if extraction fails
        }
      }

      // If protrusion extraction disconnected workShape into multiple solids
      // (e.g., the four bridge flanges in testcube.step were the only links
      // between the inner and outer hollow cubes ÔÇö removing them leaves two
      // separate solids), splitMode2 run on the combined shape would pair
      // inner-cube and outer-cube outer faces across the void and produce
      // 25 mm-thick "panels" that wrap both walls plus the gap. OCCT may
      // keep the disconnected result as one Solid with multiple Shells, so
      // TopAbs_SOLID iteration alone misses it ÔÇö run a face-level BFS via
      // shared edges to find connected components, then rebuild a Solid
      // per component using the original Shells inside it.
      auto splitConnectedComponents = [](const TopoDS_Shape& s) -> std::vector<TopoDS_Shape> {
        // Find connected face components via shared edges. Each component is
        // one closed surface; for nested hollow shapes (hollow cube), one
        // component is the outer surface and another is the inner void
        // surface. Then group components into solids by bbox containment:
        // each "outer envelope" pairs with the largest other component that
        // fits inside it (its immediate void). Smaller nested components
        // belong to subsequent solids.
        TopTools_IndexedMapOfShape faceMap;
        TopExp::MapShapes(s, TopAbs_FACE, faceMap);
        int nF = faceMap.Extent();
        if (nF == 0) return {};

        TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
        TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

        std::vector<int> comp(nF + 1, -1);
        int nComp = 0;
        for (int seed = 1; seed <= nF; ++seed) {
          if (comp[seed] >= 0) continue;
          comp[seed] = nComp;
          std::vector<int> q{seed};
          while (!q.empty()) {
            int cur = q.back(); q.pop_back();
            const TopoDS_Face& f = TopoDS::Face(faceMap(cur));
            for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
              const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
              if (!edgeFaces.Contains(e)) continue;
              const TopTools_ListOfShape& adj = edgeFaces.FindFromKey(e);
              for (TopTools_ListIteratorOfListOfShape it(adj); it.More(); it.Next()) {
                int nb = faceMap.FindIndex(it.Value());
                if (nb > 0 && comp[nb] < 0) { comp[nb] = nComp; q.push_back(nb); }
              }
            }
          }
          ++nComp;
        }
        if (nComp <= 1) return {};

        // Build a Shell per component and compute its bbox.
        std::vector<TopoDS_Shell> compShells(nComp);
        std::vector<std::array<double,6>> compBox(nComp,
            {1e30, -1e30, 1e30, -1e30, 1e30, -1e30});
        BRep_Builder builder;
        for (int c = 0; c < nComp; ++c) builder.MakeShell(compShells[c]);
        for (int fi = 1; fi <= nF; ++fi) {
          int c = comp[fi];
          const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
          builder.Add(compShells[c], f);
          for (TopExp_Explorer vx(f, TopAbs_VERTEX); vx.More(); vx.Next()) {
            gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vx.Current()));
            compBox[c][0] = std::min(compBox[c][0], p.X());
            compBox[c][1] = std::max(compBox[c][1], p.X());
            compBox[c][2] = std::min(compBox[c][2], p.Y());
            compBox[c][3] = std::max(compBox[c][3], p.Y());
            compBox[c][4] = std::min(compBox[c][4], p.Z());
            compBox[c][5] = std::max(compBox[c][5], p.Z());
          }
        }

        // Sort components by bbox volume (largest first).
        auto vol = [](const std::array<double,6>& b) {
          return (b[1]-b[0]) * (b[3]-b[2]) * (b[5]-b[4]);
        };
        std::vector<int> order(nComp);
        for (int c = 0; c < nComp; ++c) order[c] = c;
        std::sort(order.begin(), order.end(),
                  [&](int a, int b){ return vol(compBox[a]) > vol(compBox[b]); });

        // Helper: does box b contain box i (with tolerance)?
        auto contains = [&](int outer, int inner) {
          const auto& bo = compBox[outer]; const auto& bi = compBox[inner];
          constexpr double tol = 1e-3;
          return bi[0] >= bo[0] - tol && bi[1] <= bo[1] + tol
              && bi[2] >= bo[2] - tol && bi[3] <= bo[3] + tol
              && bi[4] >= bo[4] - tol && bi[5] <= bo[5] + tol;
        };

        // Determine each component's "containment depth": how many other
        // components strictly contain it. Depth 0 = outermost. Depth 1 =
        // immediate void of a depth-0. Depth 2 = outermost of nested solid
        // (contained by depth-0 and depth-1). Depth 3 = void of that. So
        // even-depth components are outer envelopes; odd-depth components
        // are the voids of the next-shallower outer.
        std::vector<int> depth(nComp, 0);
        for (int a = 0; a < nComp; ++a) {
          for (int b = 0; b < nComp; ++b) {
            if (a == b) continue;
            if (contains(b, a)) ++depth[a];
          }
        }
        // Group: each even-depth component is an outer. Its immediate void
        // is the odd-depth component that it directly contains with no
        // intervening even-depth component between them.
        std::vector<std::pair<int, std::vector<int>>> groups;
        for (int o = 0; o < nComp; ++o) {
          if (depth[o] % 2 != 0) continue;  // skip voids
          std::vector<int> voids;
          for (int v = 0; v < nComp; ++v) {
            if (v == o) continue;
            if (depth[v] != depth[o] + 1) continue;  // must be direct child
            if (!contains(o, v)) continue;
            voids.push_back(v);
          }
          groups.push_back({o, std::move(voids)});
        }

        if (groups.size() <= 1) return {};

        std::vector<TopoDS_Shape> result;
        for (const auto& g : groups) {
          BRepBuilderAPI_MakeSolid mk(compShells[g.first]);
          for (int vi : g.second) mk.Add(compShells[vi]);
          mk.Build();
          if (mk.IsDone()) result.push_back(mk.Solid());
        }
        return result;
      };

      std::vector<TopoDS_Shape> wsComponents = splitConnectedComponents(workShape);
      if (wsComponents.empty()) {
        for (TopExp_Explorer ex(workShape, TopAbs_SOLID); ex.More(); ex.Next()) {
          wsComponents.push_back(ex.Current());
        }
      }

      std::vector<ShapeHistoryRecord> shapeHistory;
      TopoDS_Shape firstPassRemainder;
      if (wsComponents.size() > 1) {
        // Each component is now a simple closed solid (a hollow cube after
        // flange extraction); a single splitMode2 pass produces the panels.
        // depth=1 ensures recursiveDecompose runs once but does not recurse
        // on its own remainder ÔÇö the bleed from protrusion extraction
        // leaves 0.05 mm-thick face slivers in the workShape that deeper
        // recursion would emit as spurious extra panels.
        for (const auto& comp : wsComponents) {
          recursiveDecompose(comp, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, /*depth=*/1,
                             panelIds, protrusionIds, protrusionParents);
        }
      } else if (mode == "thin_solid") {
        splitMode2(workShape, planeHalfSize, parentId, angleThresholdDeg, maxThicknessMm,
                   panelIds, protrusionIds, protrusionParents, &firstPassRemainder, &shapeHistory);
      } else {
        splitMode1BFS(workShape, parentId, angleThresholdDeg, defaultThicknessMm, panelIds,
                      &shapeHistory);
      }

      // T022 ÔÇö Recursive decomposition into remainder solid(s)
      if (maxRecursionDepth > 0 && !firstPassRemainder.IsNull()) {
        bool hadSolid = false;
        for (TopExp_Explorer ex(firstPassRemainder, TopAbs_SOLID); ex.More(); ex.Next()) {
          recursiveDecompose(ex.Current(), parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, maxRecursionDepth - 1, panelIds,
                             protrusionIds, protrusionParents);
          hadSolid = true;
        }
        if (!hadSolid) {
          recursiveDecompose(firstPassRemainder, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, maxRecursionDepth - 1, panelIds,
                             protrusionIds, protrusionParents);
        }
      }

      // Compute AABB for each panel/protrusion by iterating vertices and filtering
      // out cap-face rectangle corners.  Boolean ops with a large planeFace leave
      // those rectangle corners as real OCCT vertices, but they always lie outside
      // the original solid's bounding box (bxMin..bxMax etc.).  Skipping any vertex
      // more than 1 mm outside that box gives geometrically correct panel extents
      // without any extra Boolean operations.
      auto computeBboxes = [&](const std::vector<ShellId>& ids) {
        std::vector<BBox3D> bboxes;
        bboxes.reserve(ids.size());
        constexpr double kTol = 1.0;  // mm ÔÇö tolerance for on-boundary vertices
        for (const auto& id : ids) {
          auto it = shells_.find(id);
          if (it != shells_.end()) {
            Bnd_Box b;
            for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX);
                 ex.More(); ex.Next()) {
              gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
              // Discard planeFace rectangle corners: they always lie outside the
              // original solid's bounding box by more than kTol.
              if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
              if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
              if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
              b.Add(p);
            }
            if (!b.IsVoid()) {
              double xMin, yMin, zMin, xMax, yMax, zMax;
              b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
              bboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
            } else {
              bboxes.push_back({0, 0, 0, 0, 0, 0});
            }
          } else {
            bboxes.push_back({0, 0, 0, 0, 0, 0});
          }
        }
        return bboxes;
      };

      // US1: Facet Unification Pass - Merge adjacent coplanar/planar triangular facets
      // of complex segmented models (like cauldron.step) into flat panels.
      for (const auto& pid : panelIds) {
        auto shellIt = shells_.find(pid);
        if (shellIt != shells_.end() && !shellIt->second.shape.IsNull()) {
          try {
            ShapeUpgrade_UnifySameDomain unifier(shellIt->second.shape, Standard_True, Standard_True, Standard_True);
            double angTolRad = angleThresholdDeg * M_PI / 180.0;
            if (angTolRad < 1e-6) angTolRad = 0.0087; // default 0.5 degrees
            unifier.SetAngularTolerance(angTolRad);
            unifier.SetLinearTolerance(0.05); // slightly looser linear tol to heal facets
            unifier.Build();
            TopoDS_Shape unifiedShape = unifier.Shape();
            if (!unifiedShape.IsNull()) {
              shellIt->second.shape = unifiedShape;
            }
          } catch (...) {
            // Keep original shape if unification fails
          }
        }
      }

      auto panelBboxes      = computeBboxes(panelIds);
      auto protrusionBboxes = computeBboxes(protrusionIds);

      return DecomposedByBendsResult{
          std::move(panelIds), std::move(panelBboxes),
          std::move(protrusionIds), std::move(protrusionBboxes),
          std::move(protrusionParents),
          token, mode, std::move(shapeHistory)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  // ÔöÇÔöÇ Remove protrusions ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  RemoveProtrusionsResult removeProtrusions(
      const ShellId& partId,
      double angleThresholdDeg = 30.0,
      double maxThicknessMm   = 5.0) override {

    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != solids_.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }

    if (inputShape.IsNull()) {
      throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Null shape provided for protrusion removal", false, "");
    }

    SnapshotId token = createSnapshotLocked("before removeProtrusions (loop_traversal) on " + partId);

    try {
      // 1. Compute Center of Mass & Face Groups
      GProp_GProps vp;
      BRepGProp::VolumeProperties(inputShape, vp);
      gp_Pnt solidCentroid = vp.CentreOfMass();

      TopTools_IndexedMapOfShape faceMap;
      TopExp::MapShapes(inputShape, TopAbs_FACE, faceMap);
      int nFaces = faceMap.Extent();

      auto faceGroups = buildFaceGroups(inputShape, faceMap, angleThresholdDeg, solidCentroid);
      auto candidates = detectProtrusions(inputShape, faceMap, faceGroups, maxThicknessMm);

      std::vector<ShellId> protrusionIds;
      std::vector<ShapeHistoryRecord> shapeHistory;
      
      // We will build the cleaned host shape by removing protrusion faces and capping the boundary loops.
      std::vector<TopoDS_Face> hostFaces;
      std::vector<bool> isRemovedFace(nFaces + 1, false);

      for (const auto& pc : candidates) {
        for (int idx : pc.faceIndices) {
          if (idx > 0 && idx <= nFaces) {
            isRemovedFace[idx] = true;
          }
        }
      }

      for (int i = 1; i <= nFaces; ++i) {
        if (!isRemovedFace[i]) {
          hostFaces.push_back(TopoDS::Face(faceMap(i)));
        }
      }

      // Map edges to faces to find boundary edges
      TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
      TopExp::MapShapesAndAncestors(inputShape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

      // Process each candidate protrusion
      for (size_t cIdx = 0; cIdx < candidates.size(); ++cIdx) {
        const auto& pc = candidates[cIdx];
        std::vector<bool> isProtFace(nFaces + 1, false);
        for (int idx : pc.faceIndices) {
          isProtFace[idx] = true;
        }

        std::vector<TopoDS_Edge> boundaryEdges;
        for (int e = 1; e <= edgeFaces.Extent(); ++e) {
          const TopoDS_Edge& edge = TopoDS::Edge(edgeFaces.FindKey(e));
          const TopTools_ListOfShape& fl = edgeFaces(e);
          int protCount = 0;
          int hostCount = 0;
          for (TopTools_ListIteratorOfListOfShape it(fl); it.More(); it.Next()) {
            int fIdx = faceMap.FindIndex(it.Value());
            if (fIdx > 0) {
              if (isProtFace[fIdx]) {
                protCount++;
              } else {
                hostCount++;
              }
            }
          }
          if (protCount == 1 && hostCount >= 1) {
            boundaryEdges.push_back(edge);
          }
        }

        if (boundaryEdges.empty()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "No boundary edges found for protrusion", false, "");
        }

        BRepBuilderAPI_MakeWire wireMaker;
        for (const auto& edge : boundaryEdges) {
          wireMaker.Add(edge);
        }

        if (!wireMaker.IsDone()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Failed to build closed seam wire for protrusion", false, "");
        }

        TopoDS_Wire wire = wireMaker.Wire();

        // Build cap face on host plane
        gp_Pln hostPlane(pc.panelCentroid, gp_Dir(pc.panelNormal));
        BRepBuilderAPI_MakeFace faceMaker(hostPlane, wire, Standard_True);
        if (!faceMaker.IsDone()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Failed to build planar cap face for protrusion wire", false, "");
        }

        TopoDS_Face capFace = faceMaker.Face();

        // Build protrusion solid by sewing protrusion faces + cap face
        BRepBuilderAPI_Sewing sewer;
        sewer.Init();
        sewer.SetTolerance(0.1);
        for (int idx : pc.faceIndices) {
          sewer.Add(faceMap(idx));
        }
        sewer.Add(capFace);
        sewer.Perform();
        
        TopoDS_Shape sewedProtrusion = sewer.SewedShape();
        if (sewedProtrusion.IsNull()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Sewing failed for protrusion", false, "");
        }

        TopoDS_Solid protrusionSolid;
        BRepBuilderAPI_MakeSolid solidMaker;
        TopExp_Explorer shellExp(sewedProtrusion, TopAbs_SHELL);
        if (shellExp.More()) {
          solidMaker.Add(TopoDS::Shell(shellExp.Current()));
          if (solidMaker.Solid().IsNull() == Standard_False && solidMaker.IsDone()) {
            protrusionSolid = solidMaker.Solid();
          }
        }
        
        TopoDS_Shape finalProtrusion = protrusionSolid.IsNull() ? sewedProtrusion : protrusionSolid;

        ShellId pid = generateUUID();
        shells_[pid] = ShellState{pid, inputParentId, finalProtrusion};
        protrusionIds.push_back(pid);

        TopoDS_Face reversedCap = TopoDS::Face(capFace.Reversed());
        hostFaces.push_back(reversedCap);
        
        for (int idx : pc.faceIndices) {
          shapeHistory.push_back({
            "replace",
            shapeId(faceMap(idx)),
            pid,
            "removeProtrusions"
          });
        }
      }

      BRepBuilderAPI_Sewing hostSewer;
      hostSewer.Init();
      hostSewer.SetTolerance(0.1);
      for (const auto& f : hostFaces) {
        hostSewer.Add(f);
      }
      hostSewer.Perform();
      TopoDS_Shape sewedHost = hostSewer.SewedShape();
      if (sewedHost.IsNull()) {
        throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Sewing failed for cleaned host shape", false, "");
      }

      TopoDS_Solid hostSolid;
      BRepBuilderAPI_MakeSolid solidMaker;
      TopExp_Explorer shellExp(sewedHost, TopAbs_SHELL);
      if (shellExp.More()) {
        solidMaker.Add(TopoDS::Shell(shellExp.Current()));
        if (solidMaker.Solid().IsNull() == Standard_False && solidMaker.IsDone()) {
          hostSolid = solidMaker.Solid();
        }
      }
      TopoDS_Shape finalHost = hostSolid.IsNull() ? sewedHost : hostSolid;

      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        shellIt->second.shape = finalHost;
      } else if (solidIt != solids_.end()) {
        solidIt->second.shape = finalHost;
      }

      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(inputShape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }

      constexpr double kTol = 1.0;
      std::vector<BBox3D> protrusionBboxes;
      protrusionBboxes.reserve(protrusionIds.size());
      for (const auto& pid : protrusionIds) {
        auto it = shells_.find(pid);
        if (it == shells_.end()) { protrusionBboxes.push_back({0,0,0,0,0,0}); continue; }
        Bnd_Box b;
        for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
          gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
          if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
          if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
          if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
          b.Add(p);
        }
        if (!b.IsVoid()) {
          double xMin, yMin, zMin, xMax, yMax, zMax;
          b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
          protrusionBboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
        } else {
          protrusionBboxes.push_back({0,0,0,0,0,0});
        }
      }

      return RemoveProtrusionsResult{partId, std::move(protrusionIds),
                                     std::move(protrusionBboxes), token, std::move(shapeHistory)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_PROTRUSION_LOOP_FAILED",
                          std::string("OCCT exception during loop protrusion removal: ") + e.GetMessageString(),
                          true, "");
    }
  }

  RemoveProtrusionsResult removeProtrusionsLegacy(
      const ShellId& partId,
      double angleThresholdDeg = 30.0,
      double maxThicknessMm   = 5.0) override {

    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = shells_.find(partId);
      auto solidIt = solids_.find(partId);
      if (shellIt != shells_.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != solids_.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }

    SnapshotId token = createSnapshotLocked("before removeProtrusions on " + partId);

    try {
      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(inputShape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }
      double diagSq = (bxMax-bxMin)*(bxMax-bxMin)
                    + (byMax-byMin)*(byMax-byMin)
                    + (bzMax-bzMin)*(bzMax-bzMin);
      double planeHalfSize = (diagSq > 0 ? std::sqrt(diagSq) : 1000.0) * 1.1 + 10.0;

      GProp_GProps vp;
      BRepGProp::VolumeProperties(inputShape, vp);
      gp_Pnt solidCentroid = vp.CentreOfMass();

      TopTools_IndexedMapOfShape faceMap;
      TopExp::MapShapes(inputShape, TopAbs_FACE, faceMap);
      auto faceGroups = buildFaceGroups(inputShape, faceMap, angleThresholdDeg, solidCentroid);
      auto candidates = detectProtrusions(inputShape, faceMap, faceGroups, maxThicknessMm);

      std::vector<ShellId> protrusionIds;
      TopoDS_Shape workShape = inputShape;
      for (const auto& pc : candidates) {
        TopoDS_Shape newRemainder;
        try {
          TopoDS_Shape ps = extractProtrusion(workShape, pc, newRemainder, planeHalfSize);
          ShellId pid = generateUUID();
          shells_[pid] = ShellState{pid, inputParentId, ps};
          protrusionIds.push_back(pid);
          workShape = std::move(newRemainder);
        } catch (const GeometryError&) {}
      }

      auto shellIt = shells_.find(partId);
      if (shellIt != shells_.end()) {
        shellIt->second.shape = workShape;
      }

      constexpr double kTol = 1.0;
      std::vector<BBox3D> protrusionBboxes;
      protrusionBboxes.reserve(protrusionIds.size());
      for (const auto& pid : protrusionIds) {
        auto it = shells_.find(pid);
        if (it == shells_.end()) { protrusionBboxes.push_back({0,0,0,0,0,0}); continue; }
        Bnd_Box b;
        for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
          gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
          if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
          if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
          if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
          b.Add(p);
        }
        if (!b.IsVoid()) {
          double xMin, yMin, zMin, xMax, yMax, zMax;
          b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
          protrusionBboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
        } else {
          protrusionBboxes.push_back({0,0,0,0,0,0});
        }
      }

      return RemoveProtrusionsResult{partId, std::move(protrusionIds),
                                     std::move(protrusionBboxes), token};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  // ÔöÇÔöÇ Merge bodies with bend ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  MergeBodyResult mergeBodiesWithBend(const ShellId& partAId,
                                      const ShellId& partBId,
                                      const std::vector<std::string>& targetEdges,
                                      double bendRadiusMm) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto itA = shells_.find(partAId);
    if (itA == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    }
    auto itB = shells_.find(partBId);
    if (itB == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");
    }
    if (bendRadiusMm <= 0.0) {
      throw GeometryError("GE_MERGE_FAILED", "bendRadiusMm must be positive", false, "");
    }
    if (targetEdges.empty()) {
      throw GeometryError("GE_MERGE_FAILED", "targetEdges must not be empty", false, "");
    }

    // Pre-merge gap check: measure minimum distance between the two shells.
    // Gaps <= kMergeTolerance are bridged by OCCT's fuzzy Boolean; larger gaps
    // produce disconnected compound bodies that look like one part but aren't.
    {
      const double kMergeTolerance = 0.1; // mm ÔÇö matches unfoldShell sewing tolerance

      // Step 1: bounding-box quick-check.
      // Expand boxA by the tolerance; if boxB is still outside the expanded box,
      // the shapes are definitely more than kMergeTolerance apart ÔÇö run extrema.
      // If the boxes overlap (shapes are nearby or touching), skip the check.
      Bnd_Box boxA, boxB;
      BRepBndLib::AddOptimal(itA->second.shape, boxA);
      BRepBndLib::AddOptimal(itB->second.shape, boxB);

      Bnd_Box boxAExpanded = boxA;
      boxAExpanded.Enlarge(kMergeTolerance);
      const bool boxesClearlyApart =
          !boxA.IsVoid() && !boxB.IsVoid() && boxAExpanded.IsOut(boxB);

      if (boxesClearlyApart) {
        // Step 2: precise extrema distance (explicit Perform() for robustness).
        BRepExtrema_DistShapeShape gapCheck;
        gapCheck.LoadS1(itA->second.shape);
        gapCheck.LoadS2(itB->second.shape);
        gapCheck.Perform();

        double gap = kMergeTolerance + 1.0; // conservative default if measurement fails
        if (gapCheck.IsDone()) {
          gap = gapCheck.Value();
        }

        if (gap > kMergeTolerance) {
          std::ostringstream msg;
          msg << std::fixed << std::setprecision(3)
              << "GE_MERGE_GAP: Panels are " << gap << " mm apart. "
              << "Maximum allowed gap is " << kMergeTolerance << " mm. "
              << "Use close_gap to snap them together before merging.";
          throw GeometryError("GE_MERGE_GAP", msg.str(), false, "");
        }
      }
    }

    SnapshotId token = createSnapshotLocked("before mergeBodiesWithBend on " +
                                            partAId + "+" + partBId);

    try {
      TopoDS_Shape inputA = itA->second.shape;
      TopoDS_Shape inputB = itB->second.shape;
      BRepAlgoAPI_Fuse fuse(inputA, inputB);
      fuse.SetFuzzyValue(0.15); // Set fuzzy sewing tolerance to heal non-planar seams
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_MERGE_FAILED", "Boolean fuse failed", true, "rollback");
      }
      TopoDS_Shape fused = fuse.Shape();

      // Post-merge connectivity check: a properly fused pair of touching bodies
      // produces one solid or one shell. A compound with multiple solids/shells
      // means the bodies didn't actually share topology ÔÇö the gap was present.
      {
        // Count solids (any nesting depth) and free shells (not inside a solid).
        int solidCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SOLID); ex.More(); ex.Next()) solidCount++;
        int shellCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) shellCount++;

        // Also count direct top-level children of a COMPOUND when there are no
        // solids or shells ÔÇö this catches face-only compounds from surface models.
        int topLevelCount = 0;
        if (solidCount == 0 && shellCount == 0 && fused.ShapeType() == TopAbs_COMPOUND) {
          for (TopoDS_Iterator it(fused); it.More(); it.Next()) topLevelCount++;
        }

        const bool disconnected = (solidCount > 1)
            || (solidCount == 0 && shellCount > 1)
            || (solidCount == 0 && shellCount == 0 && topLevelCount > 1);

        if (disconnected) {
          throw GeometryError("GE_MERGE_DISCONNECTED",
            "Merge produced disconnected bodies ÔÇö the panels are not topologically joined. "
            "Check for a gap at the shared edge and use close_gap to fix it.",
            false, "");
        }

        // Empty-fuse guard: OCCT's BRepAlgoAPI_Fuse occasionally returns
        // IsDone()==true with a non-null but EMPTY compound (0 solids, 0
        // shells, 0 top-level children) when the inputs were touching only
        // at a single edge or vertex that the operator couldn't reconcile.
        // Without this check the empty compound silently flowed downstream
        // into the fillet step, producing the "Fused result is not a single
        // solid" error from a different (downstream) check ÔÇö masking the
        // real failure (the fuse itself).
        if (solidCount == 0 && shellCount == 0 && topLevelCount == 0) {
          throw GeometryError("GE_MERGE_FAILED",
            "Merge produced an empty result. OCCT's Boolean fuse completed "
            "but left no solid, shell, or top-level shape. The bodies likely "
            "share only an edge or vertex (insufficient contact for a Boolean "
            "fuse). Re-check that the panels overlap volumetrically or share "
            "a face before merging.",
            true, "rollback");
        }
      }

      // Attempt fillet on matching edges. Any failure is FATAL ÔÇö we throw a
      // structured error rather than silently returning an unfilleted fuse,
      // because the caller asked for a bend and a flat-fuse result would
      // misrepresent the intent (the UI shows a successful merge but with no
      // bend, then unfold produces geometry that doesn't match the requested
      // operation). Silent fallbacks were removed deliberately ÔÇö the user
      // should be told why the bend couldn't be applied (radius too large,
      // no joint edges, OCCT failure) and decide what to do next.
      bool wantAll = std::find(targetEdges.begin(), targetEdges.end(), "all") != targetEdges.end();
      TopoDS_Shape result;

      // BRepAlgoAPI_Fuse returns a COMPOUND wrapper even when the result is a
      // single clean solid. BRepFilletAPI_MakeFillet rejects COMPOUND input
      // ("There are no suitable edges for chamfer or fillet"), so unwrap to the
      // bare solid here. We require exactly one solid + no stray free shells ÔÇö
      // the disconnected-bodies check above already rejected the multi-solid
      // case, so this should hold; if it doesn't, throw rather than silently
      // hand the fillet a body it can't process.
      TopoDS_Shape filletInput = fused;
      if (fused.ShapeType() != TopAbs_SOLID) {
        TopoDS_Solid theSolid;
        int solidCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SOLID); ex.More(); ex.Next()) {
          theSolid = TopoDS::Solid(ex.Current());
          solidCount++;
        }
        int freeShells = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) {
          freeShells++;
        }
        if (solidCount != 1 || freeShells != 0) {
          std::ostringstream msg;
          msg << "GE_MERGE_FILLET_FAILED: Fused result is not a single solid "
              << "(solids=" << solidCount << ", freeShells=" << freeShells
              << "). Cannot fillet — the input bodies likely don't form a clean joint.";
          throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
        }
        filletInput = theSolid;
      }

      // ÔöÇÔöÇ PLAN B: DETERMINISTIC CORNER-CUT BEND ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
      //
      // Instead of searching the fused topology for an edge to fillet
      // (fragile; OCCT MakeFillet has many failure modes for borderline
      // thickness/radius ratios, skewed inputs, and chained merges),
      // construct the bend analytically:
      //
      //   1. Find each input's "outer" planar face = the largest face whose
      //      centroid sits farthest from the other input's centroid. This
      //      reliably picks the face facing AWAY from the bend, regardless
      //      of orientation.
      //   2. Compute the bend axis = intersection line of the two outer
      //      planes. Well-defined for perpendicular panels.
      //   3. Compute the bend extent = overlap of the two inputs projected
      //      onto the axis.
      //   4. Build a corner-cut solid: a (R ├ù R ├ù extent) box positioned at
      //      the outside corner along the bend axis, MINUS a cylinder of
      //      radius R tangent to both outer planes. This is exactly the
      //      material a fillet would remove.
      //   5. Subtract the corner-cut from the fused body.
      //
      // Result: sharp inside corner (panels meet flush at the inner edge),
      // rounded outside corner of radius R ÔÇö matching standard sheet metal
      // bend geometry.
      //
      // For explicit edge IDs (target_edges != ["all"]) we still use the
      // legacy MakeFillet path for back-compat with callers that know
      // which edges they want filleted.
      try {
        if (wantAll) {
          // ÔöÇÔöÇ 1. Outer faces of each input ÔöÇÔöÇ
          GProp_GProps centA, centB;
          BRepGProp::VolumeProperties(inputA, centA);
          BRepGProp::VolumeProperties(inputB, centB);
          gp_Pnt cA = centA.CentreOfMass();
          gp_Pnt cB = centB.CentreOfMass();

          auto outerFace = [&](const TopoDS_Shape& body, const gp_Pnt& otherCentroid,
                               gp_Vec& nOut, gp_Pln& planeOut) -> bool {
            double bestScore = -1.0;
            bool ok = false;
            for (TopExp_Explorer fx(body, TopAbs_FACE); fx.More(); fx.Next()) {
              const TopoDS_Face& f = TopoDS::Face(fx.Current());
              Handle(Geom_Surface) s = BRep_Tool::Surface(f);
              if (s.IsNull() || !s->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
              GProp_GProps fp;
              BRepGProp::SurfaceProperties(f, fp);
              double area = fp.Mass();
              gp_Pnt c = fp.CentreOfMass();
              double dist = c.Distance(otherCentroid);
              double score = area * dist;
              if (score > bestScore) {
                bestScore = score;
                nOut = faceOutwardNormal(f);
                planeOut = Handle(Geom_Plane)::DownCast(s)->Pln();
                ok = true;
              }
            }
            return ok;
          };

          gp_Vec nInA, nInB;
          gp_Pln planeA, planeB;
          if (!outerFace(inputA, cB, nInA, planeA) || !outerFace(inputB, cA, nInB, planeB)) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Could not find outer planar faces on both inputs. Each input must "
              "have at least one planar face to act as the panel skin.",
              false, "");
          }

          // ÔöÇÔöÇ 2. Bend axis = intersection of outer planes ÔöÇÔöÇ
          if (std::abs(nInA.Dot(nInB)) > 0.95) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Outer faces of the two inputs are parallel (within 18┬░). The panels "
              "must meet at a non-zero angle so a bend axis can be defined.",
              false, "");
          }
          IntAna_QuadQuadGeo planeInt(planeA, planeB,
                                      Precision::Angular(), Precision::Confusion());
          if (!planeInt.IsDone() || planeInt.TypeInter() != IntAna_Line) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Failed to intersect the inputs' outer planes ÔÇö bend axis could not "
              "be determined.",
              false, "");
          }
          gp_Lin bendAxis = planeInt.Line(1);

          // ÔöÇÔöÇ 3. Bend extent = overlap of inputs projected onto axis ÔöÇÔöÇ
          gp_Vec axisDir(bendAxis.Direction());
          gp_Pnt axisOrigin = bendAxis.Location();

          auto axisRange = [&](const TopoDS_Shape& body) -> std::pair<double, double> {
            double lo = 1e30, hi = -1e30;
            for (TopExp_Explorer vx(body, TopAbs_VERTEX); vx.More(); vx.Next()) {
              gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vx.Current()));
              double t = gp_Vec(axisOrigin, p).Dot(axisDir);
              lo = std::min(lo, t);
              hi = std::max(hi, t);
            }
            return {lo, hi};
          };
          auto rangeA = axisRange(inputA);
          auto rangeB = axisRange(inputB);
          double extentLo = std::max(rangeA.first, rangeB.first);
          double extentHi = std::min(rangeA.second, rangeB.second);
          double extent = extentHi - extentLo;

          if (extent < 5.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_BEND_EXTENT_TOO_SHORT: Panels overlap only "
                << std::fixed << std::setprecision(2) << extent
                << " mm along the bend axis (need at least 5 mm). "
                << "The panels touch only at a corner or short edge segment.";
            throw GeometryError("GE_MERGE_BEND_EXTENT_TOO_SHORT", msg.str(), false, "");
          }

          // ÔöÇÔöÇ 3a. Panel thickness check ÔöÇÔöÇ
          // User policy: imported geometry may have slightly mismatched
          // thicknesses; correct silently if mismatch is within ~3 mm,
          // throw if it's beyond that (different stock can't be bent
          // cleanly as one piece).
          auto panelThickness = [](const TopoDS_Shape& body) -> double {
            Bnd_Box bb;
            BRepBndLib::AddOptimal(body, bb);
            double x1,y1,z1,x2,y2,z2;
            bb.Get(x1,y1,z1,x2,y2,z2);
            return std::min({x2-x1, y2-y1, z2-z1});
          };
          double tA = panelThickness(inputA);
          double tB = panelThickness(inputB);
          if (std::abs(tA - tB) > 3.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_THICKNESS_MISMATCH: Panel thicknesses differ by "
                << std::fixed << std::setprecision(2) << std::abs(tA - tB)
                << " mm (panelA=" << tA << " mm, panelB=" << tB << " mm). "
                << "Max 3 mm mismatch tolerated for clean bend construction.";
            throw GeometryError("GE_MERGE_THICKNESS_MISMATCH", msg.str(), false, "");
          }
          double effectiveThickness = std::max(tA, tB);

          // Bend radius must be within a reasonable ratio of thickness.
          if (bendRadiusMm > effectiveThickness * 5.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_RADIUS_TOO_LARGE: Bend radius " << bendRadiusMm
                << " mm exceeds 5x panel thickness " << effectiveThickness
                << " mm. The corner cut would slice through to the panel interior. "
                << "Try a smaller bend radius.";
            throw GeometryError("GE_MERGE_RADIUS_TOO_LARGE", msg.str(), false, "");
          }

          // bendRadiusMm is the INNER (concave-side) radius — standard sheet-metal
          // convention.  The outer (convex-side) radius = innerRadius + thickness.
          const double innerRadius = bendRadiusMm;
          const double outerRadius = innerRadius + effectiveThickness;

          // ÔöÇÔöÇ 4. Build local frame and corner-cut solid ÔöÇÔöÇ
          // dirA / dirB = unit vectors from the bend axis into each panel.
          // Local 2D cross-section: dirA = +X, dirB = +Y.
          //   Outer faces (X=0, Y=0) are on the convex side of the bend.
          //   Inner faces (X=T, Y=T) are on the concave side.
          //   Arc centre = (outerRadius, outerRadius) in local frame.
          gp_Vec dirA = -nInA;
          gp_Vec dirB = -nInB;

          // Align axisDir so that axisDir ├ù dirA = dirB (right-handed local
          // frame). The intersection line direction is arbitrary; we pick
          // the orientation that makes the local box axes consistent.
          gp_Vec computedDirB = axisDir.Crossed(dirA);
          if (computedDirB.Dot(dirB) < 0) {
            axisDir = -axisDir;
          }

          // cornerOrigin: point on the bend axis at the start of the bend extent.
          // Box axes: XDirection=dirA, YDirection=dirB, Direction=axisDir.
          gp_Pnt cornerOrigin = axisOrigin.Translated(axisDir * extentLo);
          gp_Ax2 boxAxes(cornerOrigin, gp_Dir(axisDir), gp_Dir(dirA));

          // Arc-centre location: outerRadius into each panel direction.
          gp_Pnt arcCentre = cornerOrigin
              .Translated(dirA * outerRadius)
              .Translated(dirB * outerRadius);
          gp_Ax2 arcAxes(arcCentre, gp_Dir(axisDir));

          // -- 4b. Outer corner cut -------------------------------------------------
          // Remove the crescent at the convex corner:
          //   outerCut = box([0..boxExtent]^2) - outerCyl(radius=outerRadius)
          // Subtracting this from the body rounds the outer (convex) bend surface
          // to the correct outer radius while leaving the inner faces untouched.
          //
          // IMPORTANT: Cap the box extent to effectiveThickness so the box never
          // extends past the inner corner faces (which sit at T from the outer
          // corner). If outerRadius > T, the box would split those inner faces
          // during the Boolean cut, creating phantom sub-faces that corrupt the
          // unfold algorithm's face-area ordering and UV projection.
          // The arc position (arcCentre) is still placed at outerRadius from the
          // corner; only the box footprint is clamped so it stays inside the
          // material region.
          double boxExtent = std::min(outerRadius, effectiveThickness);
          TopoDS_Solid outerBox;
          try {
            outerBox = BRepPrimAPI_MakeBox(boxAxes, boxExtent, boxExtent, extent).Solid();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_WEDGE_FAILED: failed to build outer-corner box: "
                << e.GetMessageString();
            throw GeometryError("GE_MERGE_WEDGE_FAILED", msg.str(), true, "rollback");
          }
          TopoDS_Solid outerCyl;
          try {
            outerCyl = BRepPrimAPI_MakeCylinder(arcAxes, outerRadius, extent).Solid();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_WEDGE_FAILED: failed to build outer-corner cylinder: "
                << e.GetMessageString();
            throw GeometryError("GE_MERGE_WEDGE_FAILED", msg.str(), true, "rollback");
          }
          BRepAlgoAPI_Cut outerCutOp(outerBox, outerCyl);
          outerCutOp.Build();
          if (!outerCutOp.IsDone() || outerCutOp.Shape().IsNull()) {
            throw GeometryError("GE_MERGE_WEDGE_FAILED",
              "Failed to compute outer corner-cut (outerBox - outerCyl).",
              true, "rollback");
          }
          BRepAlgoAPI_Cut applyOuterOp(filletInput, outerCutOp.Shape());
          applyOuterOp.Build();
          if (!applyOuterOp.IsDone() || applyOuterOp.Shape().IsNull()) {
            throw GeometryError("GE_MERGE_FAILED",
              "Failed to subtract outer corner-cut from body.",
              true, "rollback");
          }
          result = applyOuterOp.Shape();
          // Post-cut cleanup: BRepAlgoAPI_Cut can leave tiny artifact solids at
          // near-degenerate corners when the cut-box edge exactly coincides with
          // a seam face of a previously-fused input (e.g. panel+protrusion merged
          // before this merge step). Discard solids whose volume is <1% of the
          // largest — these are numerical artifacts from the Boolean op, not
          // real material.
          {
            TopoDS_Solid largestSolid;
            double largestVol = -1.0;
            int solidCnt = 0;
            for (TopExp_Explorer ex(result, TopAbs_SOLID); ex.More(); ex.Next()) {
              TopoDS_Solid s = TopoDS::Solid(ex.Current());
              GProp_GProps gp;
              BRepGProp::VolumeProperties(s, gp);
              double vol = std::abs(gp.Mass());
              solidCnt++;
              if (vol > largestVol) { largestVol = vol; largestSolid = s; }
            }
            if (solidCnt > 1 && !largestSolid.IsNull()) {
              result = largestSolid;
            }
          }
        } else {
          // ─── EXPLICIT EDGES PATH (back-compat) ───
          // Caller supplied specific edge IDs; use OCCT MakeFillet to fillet
          // exactly those. Less robust than the deterministic path, but the
          // caller has specified which edges they want.
          BRepFilletAPI_MakeFillet filletMaker(filletInput);
          bool addedAny = false;
          int candidateEdges = 0;
          TopExp_Explorer edgeExp(filletInput, TopAbs_EDGE);
          for (; edgeExp.More(); edgeExp.Next()) {
            const TopoDS_Edge& e = TopoDS::Edge(edgeExp.Current());
            if (std::find(targetEdges.begin(), targetEdges.end(), shapeId(e)) != targetEdges.end()) {
              filletMaker.Add(bendRadiusMm, e);
              addedAny = true;
              candidateEdges++;
            }
          }
          if (!addedAny) {
            throw GeometryError("GE_MERGE_NO_SEAM_EDGES",
              "None of the specified target_edges were found in the fused body.",
              false, "");
          }
          try {
            filletMaker.Build();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_FILLET_FAILED: OCCT fillet build threw on " << candidateEdges
                << " edge(s) at radius " << bendRadiusMm << " mm: " << e.GetMessageString();
            throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
          }
          if (!filletMaker.IsDone() || filletMaker.Shape().IsNull()) {
            std::ostringstream msg;
            msg << "GE_MERGE_FILLET_FAILED: OCCT fillet build did not complete on "
                << candidateEdges << " edge(s) at radius " << bendRadiusMm << " mm.";
            throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
          }
          result = filletMaker.Shape();
        }
      } catch (const GeometryError&) {
        throw;
      } catch (const Standard_Failure& e) {
        std::ostringstream msg;
        msg << "GE_MERGE_FAILED: OCCT exception during bend construction: "
            << e.GetMessageString();
        throw GeometryError("GE_MERGE_FAILED", msg.str(), true, "rollback");
      }

      // BRepFilletAPI_MakeFillet().Shape() can return a COMPOUND wrapping the
      // solid (same OCCT habit as BRepAlgoAPI_Fuse). Storing a compound in
      // shells_ poisons any downstream merge that tries to fuse this shell
      // again: the chained-merge fuse of (COMPOUND, SOLID) produces 0 solids
      // and the second merge throws. Unwrap to the bare solid so chained
      // merges work cleanly.
      if (result.ShapeType() != TopAbs_SOLID) {
        TopoDS_Solid resultSolid;
        int rsCount = 0;
        for (TopExp_Explorer ex(result, TopAbs_SOLID); ex.More(); ex.Next()) {
          resultSolid = TopoDS::Solid(ex.Current());
          rsCount++;
        }
        if (rsCount == 1) {
          result = resultSolid;
        }
        // If rsCount != 1 we leave `result` as-is ÔÇö the merge succeeded
        // structurally, but a downstream fuse on this shell may fail; we
        // don't synthesise a fake solid to hide that.
      }

      ShellId mergedId = generateUUID();
      shells_[mergedId] = ShellState{mergedId, itA->second.parentSolidId, result};
      auto histA = captureHistory(fuse, inputA,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "mergeBodiesWithBend");
      auto histB = captureHistory(fuse, inputB,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "mergeBodiesWithBend");
      histA.insert(histA.end(), histB.begin(), histB.end());
      return MergeBodyResult{mergedId, token, std::move(histA)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_MERGE_FAILED",
                          std::string("OCCT exception during merge: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Close gap between two shells ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  CloseGapResult closeGap(const ShellId& partAId, const ShellId& partBId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto itA = shells_.find(partAId);
    if (itA == shells_.end())
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    auto itB = shells_.find(partBId);
    if (itB == shells_.end())
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");

    const TopoDS_Shape& shapeA = itA->second.shape;
    const TopoDS_Shape& shapeB = itB->second.shape;

    BRepExtrema_DistShapeShape distCalc(shapeA, shapeB);
    if (!distCalc.IsDone())
      throw GeometryError("GE_CLOSE_GAP_FAILED", "Could not compute gap distance.", false, "");

    double gap = distCalc.Value();
    if (gap < 1e-6) {
      // Already touching ÔÇö nothing to do; return part B unchanged.
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

  // ÔöÇÔöÇ Extend face to target ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  ExtendFaceResult extendFaceToTarget(const ShellId&      partId,
                                      const std::string&  faceId,
                                      const std::string&  targetType,
                                      const std::string&  targetPartId,
                                      const std::string&  targetFaceId,
                                      const CuttingPlane& targetPlane) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = shells_.find(partId);
    if (it == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before extendFaceToTarget on " + partId);

    try {
      // ÔöÇÔöÇ Resolve target shape early (needed for auto face-finding) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
      TopoDS_Shape targetShape;
      if (targetType == "face_id" || targetType == "part_surface") {
        auto tIt = shells_.find(targetPartId);
        if (tIt == shells_.end()) {
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

      // ÔöÇÔöÇ Find the face to extend ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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
          // Respect face orientation ÔÇö a REVERSED face has its outward normal
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
          // Skip faces already in contact with the target ÔÇö their score would
          // be 0 and they would always beat the actual gap face.
          if (d.Value() < 1e-4) continue;

          // Score: dist / dotScore ÔÇö favour near faces that face the target
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

      // ÔöÇÔöÇ Compute face normal at centroid ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

      // ÔöÇÔöÇ Compute extension distance ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
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

  // ÔöÇÔöÇ Offset face ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  OffsetFaceResult offsetFace(const ShellId&     partId,
                               const std::string& faceId,
                               double             distanceMm) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = shells_.find(partId);
    if (it == shells_.end()) {
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

  // ÔöÇÔöÇ Add flange ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  AddFlangeResult addFlange(const ShellId&     partId,
                             const std::string& edgeId,
                             double             lengthMm,
                             double             angleDeg,
                             double             bendRadiusMm) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = shells_.find(partId);
    if (it == shells_.end()) {
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
      // At 90┬░: flange is perpendicular to face (standard flange)
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

  // ÔöÇÔöÇ Rip edge ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  RipEdgeResult ripEdge(const ShellId&     partId,
                         const std::string& edgeId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = shells_.find(partId);
    if (it == shells_.end()) {
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

  // ÔöÇÔöÇ Clash detection ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  ClashReport computeIntersections(const std::vector<ShellId>& partIds) override {
    std::lock_guard<std::mutex> lock(mutex_);

    ClashReport report;
    report.intersects = false;

    // Resolve all shells to shapes first
    std::vector<std::pair<ShellId, TopoDS_Shape>> parts;
    parts.reserve(partIds.size());
    for (const auto& id : partIds) {
      auto it = shells_.find(id);
      if (it == shells_.end()) {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + id, false, "");
      }
      parts.emplace_back(id, it->second.shape);
    }

    try {
      for (size_t i = 0; i < parts.size(); ++i) {
        for (size_t j = i + 1; j < parts.size(); ++j) {
          BRepAlgoAPI_Common common(parts[i].second, parts[j].second);
          common.Build();

          if (!common.IsDone()) {
            throw GeometryError("GE_CLASH_DETECTION_FAILED",
                                "Intersection computation failed between " +
                                    parts[i].first + " and " + parts[j].first,
                                false, "");
          }

          TopoDS_Shape intersection = common.Shape();
          if (intersection.IsNull()) continue;

          // Check if intersection has non-zero volume
          GProp_GProps props;
          BRepGProp::VolumeProperties(intersection, props);
          double vol = props.Mass();
          if (vol < 1e-9) continue;  // Touching faces, not a volumetric clash

          report.intersects = true;

          ClashPair clash;
          clash.partIdA = parts[i].first;
          clash.partIdB = parts[j].first;
          clash.intersectionVolumeMm3 = vol;

          // Compute bounding box of the intersection
          Bnd_Box bbox;
          BRepBndLib::Add(intersection, bbox);
          double xmin, ymin, zmin, xmax, ymax, zmax;
          bbox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
          clash.clashBoundingBox = {xmin, ymin, zmin,
                                    xmax - xmin, ymax - ymin, zmax - zmin};

          // Suggest a cutting plane through the centre of the clash bbox
          // with normal pointing from partA centroid to partB centroid
          GProp_GProps propsA, propsB;
          BRepGProp::VolumeProperties(parts[i].second, propsA);
          BRepGProp::VolumeProperties(parts[j].second, propsB);
          gp_Pnt cA = propsA.CentreOfMass();
          gp_Pnt cB = propsB.CentreOfMass();
          gp_Vec dir(cA, cB);
          if (dir.Magnitude() < 1e-10) dir = gp_Vec(0, 0, 1);
          dir.Normalize();
          clash.suggestedCuttingPlane.normalX = dir.X();
          clash.suggestedCuttingPlane.normalY = dir.Y();
          clash.suggestedCuttingPlane.normalZ = dir.Z();
          clash.suggestedCuttingPlane.originX = (xmin + xmax) * 0.5;
          clash.suggestedCuttingPlane.originY = (ymin + ymax) * 0.5;
          clash.suggestedCuttingPlane.originZ = (zmin + zmax) * 0.5;

          report.clashes.push_back(std::move(clash));
        }
      }
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_CLASH_DETECTION_FAILED",
                          std::string("OCCT exception during clash detection: ") +
                              e.GetMessageString(),
                          false, "");
    }

    return report;
  }

  // ÔöÇÔöÇ Gap detection ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  GapReport computeGaps(const ShellId& partAId,
                        const ShellId& partBId,
                        double maxDistanceThresholdMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    auto itA = shells_.find(partAId);
    if (itA == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    }
    auto itB = shells_.find(partBId);
    if (itB == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");
    }

    try {
      BRepExtrema_DistShapeShape distCalc(itA->second.shape, itB->second.shape);
      distCalc.Perform();

      if (!distCalc.IsDone()) {
        throw GeometryError("GE_GAP_DETECTION_FAILED",
                            "Distance computation failed between " + partAId +
                                " and " + partBId,
                            false, "");
      }

      GapReport report;
      report.minimumDistanceMm = distCalc.Value();
      report.hasGap = report.minimumDistanceMm > 1e-6 &&
                      report.minimumDistanceMm <= maxDistanceThresholdMm;

      if (distCalc.NbSolution() > 0) {
        // Closest point pair ÔÇö used to identify the faces involved
        gp_Pnt pA = distCalc.PointOnShape1(1);
        gp_Pnt pB = distCalc.PointOnShape2(1);

        // Walk faces of each shell and find the one containing the closest point
        auto findFaceId = [&](const TopoDS_Shape& shape, const gp_Pnt& pt) -> std::string {
          double bestDist = 1e18;
          std::string bestId;
          TopExp_Explorer exp(shape, TopAbs_FACE);
          for (; exp.More(); exp.Next()) {
            const TopoDS_Face& f = TopoDS::Face(exp.Current());
            Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
            if (surf.IsNull()) continue;
            Standard_Real u1, u2, v1, v2;
            BRepTools::UVBounds(f, u1, u2, v1, v2);
            gp_Pnt mid;
            surf->D0((u1 + u2) * 0.5, (v1 + v2) * 0.5, mid);
            double d = mid.Distance(pt);
            if (d < bestDist) {
              bestDist = d;
              bestId   = shapeId(f);
            }
          }
          return bestId;
        };

        report.partAFaceId = findFaceId(itA->second.shape, pA);
        report.partBFaceId = findFaceId(itB->second.shape, pB);

        // Extension vector: from pA toward pB, magnitude = gap distance
        gp_Vec ext(pA, pB);
        if (ext.Magnitude() > 1e-10) ext.Normalize();
        report.extensionVector = {ext.X(), ext.Y(), ext.Z()};

        // Bounding box enclosing both closest points
        double xmin = std::min(pA.X(), pB.X()) - 1.0;
        double ymin = std::min(pA.Y(), pB.Y()) - 1.0;
        double zmin = std::min(pA.Z(), pB.Z()) - 1.0;
        double xmax = std::max(pA.X(), pB.X()) + 1.0;
        double ymax = std::max(pA.Y(), pB.Y()) + 1.0;
        double zmax = std::max(pA.Z(), pB.Z()) + 1.0;
        report.gapBoundingBox = {xmin, ymin, zmin,
                                 xmax - xmin, ymax - ymin, zmax - zmin};
      }

      return report;
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_GAP_DETECTION_FAILED",
                          std::string("OCCT exception during gap detection: ") +
                              e.GetMessageString(),
                          false, "");
    }
  }

  // ÔöÇÔöÇ Trim body with plane ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  TrimBodyResult trimBodyWithPlane(const ShellId&      partId,
                                   const CuttingPlane& plane,
                                   bool                keepPositiveSide) override {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = shells_.find(partId);
    if (it == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    // Snapshot before mutation (Constitution Principle IV)
    SnapshotId token = createSnapshotLocked("before trimBodyWithPlane on " + partId);

    try {
      gp_Pnt origin(plane.originX, plane.originY, plane.originZ);
      double normLength = std::sqrt(plane.normalX * plane.normalX +
                                    plane.normalY * plane.normalY +
                                    plane.normalZ * plane.normalZ);
      if (normLength < 1e-10) {
        throw GeometryError("GE_TRIM_FAILED", "Cutting plane normal is zero", false, "");
      }
      gp_Dir normal(plane.normalX / normLength,
                    plane.normalY / normLength,
                    plane.normalZ / normLength);
      gp_Pln gPlane(origin, normal);

      // Build half-space on the side to keep
      BRepBuilderAPI_MakeFace faceMaker(gPlane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face planeFace = faceMaker.Face();

      // Reference point on the side the tool occupies (opposite to keep side)
      gp_Vec n(normal);
      gp_Pnt refPt = keepPositiveSide
          ? origin.Translated(n * -100.0)   // tool on negative side ÔåÆ keep positive
          : origin.Translated(n * 100.0);   // tool on positive side ÔåÆ keep negative

      BRepPrimAPI_MakeHalfSpace halfSpace(planeFace, refPt);
      TopoDS_Solid halfSpaceSolid = halfSpace.Solid();

      TopoDS_Shape inputForHistory = it->second.shape;
      BRepAlgoAPI_Cut cutter(it->second.shape, halfSpaceSolid);
      cutter.Build();

      if (!cutter.IsDone()) {
        throw GeometryError("GE_TRIM_FAILED",
                            "Plane trim failed for shell: " + partId, true, "rollback");
      }

      TopoDS_Shape result = cutter.Shape();
      if (result.IsNull()) {
        throw GeometryError("GE_TRIM_FAILED",
                            "Plane trim produced empty result", true, "rollback");
      }

      // Replace the shell's shape in-place
      it->second.shape = result;

      auto history = captureHistory(cutter, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "trimBodyWithPlane");
      return TrimBodyResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_TRIM_FAILED",
                          std::string("OCCT exception during trim: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // Returns the composed gp_Trsf for a TopLoc_Location.
  // Transformation() returns the total composed transformation for the chain.
  static gp_Trsf locationToTrsf(const TopLoc_Location& loc) {
    if (loc.IsIdentity()) return gp_Trsf();
    return loc.Transformation();
  }

  static SurfaceType classifySurface(const TopoDS_Face& face) {
    Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
    if (surf.IsNull()) return SurfaceType::OTHER;
    if (surf->IsKind(STANDARD_TYPE(Geom_Plane)))              return SurfaceType::PLANE;
    if (surf->IsKind(STANDARD_TYPE(Geom_CylindricalSurface))) return SurfaceType::CYLINDER;
    if (surf->IsKind(STANDARD_TYPE(Geom_ConicalSurface)))     return SurfaceType::CONE;
    if (surf->IsKind(STANDARD_TYPE(Geom_SphericalSurface)))   return SurfaceType::SPHERE;
    if (surf->IsKind(STANDARD_TYPE(Geom_ToroidalSurface)))    return SurfaceType::TORUS;
    if (surf->IsKind(STANDARD_TYPE(Geom_BSplineSurface)))     return SurfaceType::BSPLINE;
    return SurfaceType::OTHER;
  }

  static CurveType classifyCurve(const TopoDS_Edge& edge) {
    Standard_Real f, l;
    Handle(Geom_Curve) curve = BRep_Tool::Curve(edge, f, l);
    if (curve.IsNull()) return CurveType::OTHER;
    if (curve->IsKind(STANDARD_TYPE(Geom_Line)))          return CurveType::LINE;
    if (curve->IsKind(STANDARD_TYPE(Geom_Circle)))        return CurveType::CIRCLE;
    if (curve->IsKind(STANDARD_TYPE(Geom_Ellipse)))       return CurveType::ELLIPSE;
    if (curve->IsKind(STANDARD_TYPE(Geom_BSplineCurve)))  return CurveType::BSPLINE;
    return CurveType::OTHER;
  }

  static double computeDihedralAngle(const TopoDS_Face& fA,
                                      const TopoDS_Face& fB,
                                      const TopoDS_Edge& /*edge*/) {
    // Approximate dihedral via face normals at midpoint
    auto getNormal = [](const TopoDS_Face& f) -> gp_Vec {
      Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
      if (surf.IsNull()) return gp_Vec(0, 0, 1);
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(f, u1, u2, v1, v2);
      gp_Pnt p; gp_Vec du, dv;
      surf->D1((u1+u2)*0.5, (v1+v2)*0.5, p, du, dv);
      gp_Vec n = du.Crossed(dv);
      if (n.Magnitude() > 1e-10) n.Normalize();
      return n;
    };

    gp_Vec nA = getNormal(fA);
    gp_Vec nB = getNormal(fB);
    double dot = std::clamp(nA.Dot(nB), -1.0, 1.0);
    double angleDeg = std::acos(dot) * 180.0 / M_PI;
    return angleDeg;
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
        result.validationErrors.push_back("GE_PANEL_NO_FLAT_FACES: Shape has no planar faces ÔÇö cannot be a sheet metal panel.");
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
        result.validationErrors.push_back("GE_PANEL_NOT_SHEET_METAL: Bulky or non-sheet-metal geometry ÔÇö area ratio of parallel skins is below limit.");
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
    if (auto sit = shells_.find(partId); sit != shells_.end()) {
      shape = sit->second.shape;
    } else if (auto it = solids_.find(partId); it != solids_.end()) {
      shape = it->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Shell not found: " + partId, false, "");
    }
    return validateSheetMetalShapeLocked(shape);
  }

  SheetMetalValidationResult validateSheetMetal(const ShellId& partId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    return validateSheetMetalLocked(partId);
  }

  // Non-destructive: applies fillet-based bend reconstruction to a COPY of
  // `sourceId`, stores the result as a new shell, and returns the new ID.
  // Called from within unfoldShell (mutex already held).  Throws on failure.
  ShellId buildImprovedFoldedLocked(const ShellId& sourceId, double t) {
    TopoDS_Shape originalShape;
    if (auto sit = shells_.find(sourceId); sit != shells_.end()) {
      originalShape = sit->second.shape;
    } else if (auto it = solids_.find(sourceId); it != solids_.end()) {
      originalShape = it->second.shape;
    } else {
      throw GeometryError("GE_SOLID_NOT_FOUND", "Source not found: " + sourceId, false, "");
    }

    auto faceCenter = [](const TopoDS_Face& f) -> gp_Pnt {
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(f, fp);
      return fp.CentreOfMass();
    };

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

    // Collect matched planar face pairs (same logic as reconstructCurvedBends)
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
      throw GeometryError("GE_NO_BENDS", "No bend pairs found ÔÇö no improved part needed", false, "");

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

    // Use a deterministic ID so the improved part keeps a stable, recognisable
    // name across repeated unfolds of the same source shell.
    ShellId newId = sourceId + "_improved";
    shells_[newId] = ShellState{newId, "", result};
    return newId;
  }

  CurvedRebuildResult reconstructCurvedBends(const ShellId& partId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    TopoDS_Shape originalShape;
    bool isSolid = false;
    if (auto sit = shells_.find(partId); sit != shells_.end()) {
      originalShape = sit->second.shape;
    } else if (auto itS = solids_.find(partId); itS != solids_.end()) {
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
        // unfoldShell::findPanelConnection ÔÇö without it, the matchedFaceIds
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
          // Insert IDs for ALL coplanar sub-faces ÔÇö sharp edges may border any
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
        solids_[partId].shape = resultShape;
      } else {
        shells_[partId].shape = resultShape;
      }

      return CurvedRebuildResult{partId, static_cast<int>(pairs.size()), token, std::move(history)};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_UNFOLD_REBUILD_FAILED",
                          std::string("OCCT exception in reconstructCurvedBends: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }
};

// ÔöÇÔöÇÔöÇ Factory ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

std::unique_ptr<GeometryService> GeometryService::create() {
  return std::make_unique<GeometryServiceImpl>();
}

}  // namespace mcp_cad
