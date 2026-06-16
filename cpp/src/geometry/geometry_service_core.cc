/**
 * geometry_service_core.cc — Core geometry operations (STEP import, topology,
 * boolean cut, tab/slot, snapshot helpers).
 *
 * This translation unit owns the OCCT include block and implements
 * GeometryCoreOps, which is delegated to by GeometryServiceImpl.
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
#include "shape_history.hpp"

// ─── Standard library ────────────────────────────────────────────────────────
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

// ─── UUID generator (simple, session-scoped) ─────────────────────────────────

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

// ─── faceOutwardNormal ────────────────────────────────────────────────────────

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

// ─── Static classification helpers ───────────────────────────────────────────

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

// ─── GeometryCoreOps ─────────────────────────────────────────────────────────

class GeometryCoreOps {
public:
  explicit GeometryCoreOps(GeometryState& s) : s_(s) {}

  // ── STEP import ──────────────────────────────────────────────────────────

  SolidId loadStep(const std::string& filePath) {
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
      std::lock_guard<std::mutex> lock(s_.mutex);
      s_.solids[id] = SolidState{id, shape};
      return id;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_IMPORT_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          false, "");
    }
  }

  // ── Viewport orientation and alignment ───────────────────────────────────

  AlignmentResult centerAndAlignBody(
      const ShellId&    partId,
      const SnapshotId& transactionId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape shape;
    {
      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        shape = shellIt->second.shape;
      } else if (solidIt != s_.solids.end()) {
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
      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        shellIt->second.shape = transformedShape;
      } else if (solidIt != s_.solids.end()) {
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

  // ── Topology extraction ───────────────────────────────────────────────────

  TopologyGraph getTopology(const SolidId& solidId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape shape;
    if (auto it = s_.solids.find(solidId); it != s_.solids.end()) {
      shape = it->second.shape;
    } else if (auto sit = s_.shells.find(solidId); sit != s_.shells.end()) {
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

  // ── Compound decomposition ────────────────────────────────────────────────

  std::vector<ShellId> separateSolids(const SolidId& solidId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.solids.find(solidId);
    if (it == s_.solids.end()) {
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
      s_.shells[sid]      = state;
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
        s_.shells[sid]      = state;
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
      s_.shells[sid]      = state;
      shellIds.push_back(sid);
    }

    return shellIds;
  }

  // ── Boolean cut (decomposition) ───────────────────────────────────────────

  BooleanCutResult booleanCut(const SolidId& solidId,
                               double nx, double ny, double nz,
                               double ox, double oy, double oz) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.solids.find(solidId);
    if (it == s_.solids.end()) {
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
        s_.shells[shellId]  = state;
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

  // ── Tab-slot synthesis ────────────────────────────────────────────────────

  TabSlotResult addTabSlot(const ShellId& shellIdA,
                            const ShellId& shellIdB,
                            double kerfOffsetMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (s_.shells.find(shellIdA) == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellIdA, false, "");
    }
    if (s_.shells.find(shellIdB) == s_.shells.end()) {
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

  // ── Rivet hole ────────────────────────────────────────────────────────────

  RivetHoleResult addRivetHole(const ShellId& shellId,
                                const std::string& faceId,
                                double centerX, double centerY,
                                double diameterMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (s_.shells.find(shellId) == s_.shells.end()) {
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

  // ── Snapshot / rollback ───────────────────────────────────────────────────

  SnapshotId createSnapshot(const std::string& label) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    return createSnapshotLocked(label);
  }

  RestoreResult restoreSnapshot(const SnapshotId& snapshotId) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    auto it = s_.snapshots.find(snapshotId);
    if (it == s_.snapshots.end()) {
      throw GeometryError("GE_SNAPSHOT_NOT_FOUND",
                          "Snapshot not found: " + snapshotId, false, "");
    }

    const GeometrySnapshot& snap = it->second;

    auto sIt = s_.snapshotSolids.find(snapshotId);
    if (sIt != s_.snapshotSolids.end()) {
      s_.solids = sIt->second;
    }
    auto hIt = s_.snapshotShells.find(snapshotId);
    if (hIt != s_.snapshotShells.end()) {
      s_.shells = hIt->second;
    }
    auto uIt = s_.snapshotUnfolds.find(snapshotId);
    if (uIt != s_.snapshotUnfolds.end()) {
      s_.unfolds = uIt->second;
    }
    auto aIt = s_.snapshotAssemblies.find(snapshotId);
    if (aIt != s_.snapshotAssemblies.end()) {
      s_.assemblies = aIt->second;
    }

    return RestoreResult{snap.solidIds, snap.shellIds};
  }

  void clearSnapshots() {
    std::lock_guard<std::mutex> lock(s_.mutex);
    s_.snapshots.clear();
    s_.snapshotSolids.clear();
    s_.snapshotShells.clear();
    s_.snapshotUnfolds.clear();
    s_.snapshotAssemblies.clear();
  }

  void clearState() {
    std::lock_guard<std::mutex> lock(s_.mutex);
    s_.solids.clear();
    s_.shells.clear();
    s_.unfolds.clear();
    s_.snapshots.clear();
    s_.snapshotSolids.clear();
    s_.snapshotShells.clear();
    s_.snapshotUnfolds.clear();
    s_.assemblies.clear();
    s_.snapshotAssemblies.clear();
  }

private:
  GeometryState& s_;

  // ── Private helpers ───────────────────────────────────────────────────────

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

  SnapshotId createSnapshotLocked(const std::string& label) {
    GeometrySnapshot snap;
    snap.snapshotId     = generateUUID();
    snap.operationLabel = label;
    snap.timestampMs    = nowMs();

    for (const auto& kv : s_.solids)  snap.solidIds.push_back(kv.first);
    for (const auto& kv : s_.shells)  snap.shellIds.push_back(kv.first);
    for (const auto& kv : s_.unfolds) snap.unfoldIds.push_back(kv.first);

    s_.snapshots[snap.snapshotId]          = snap;
    s_.snapshotSolids[snap.snapshotId]     = s_.solids;
    s_.snapshotShells[snap.snapshotId]     = s_.shells;
    s_.snapshotUnfolds[snap.snapshotId]    = s_.unfolds;
    s_.snapshotAssemblies[snap.snapshotId] = s_.assemblies;
    return snap.snapshotId;
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

  void buildTopologyGraph(const TopoDS_Shape& shape, TopologyGraph& graph) {
    // ── Index faces ────────────────────────────────────────────────────────
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

    // ── Index edges ────────────────────────────────────────────────────────
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

    // ── Build face-face adjacency (dihedral angles) ────────────────────────
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

  // Returns the composed gp_Trsf for a TopLoc_Location.
  // Transformation() returns the total composed transformation for the chain.
  static gp_Trsf locationToTrsf(const TopLoc_Location& loc) {
    if (loc.IsIdentity()) return gp_Trsf();
    return loc.Transformation();
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
};

// ─── GeometryServiceImpl constructor ─────────────────────────────────────────

GeometryServiceImpl::GeometryServiceImpl() {
  state_.app = new TDocStd_Application();
  BinXCAFDrivers::DefineFormat(state_.app);
}

// ─── GeometryServiceImpl delegation stubs ────────────────────────────────────

SolidId GeometryServiceImpl::loadStep(const std::string& fp) {
  return GeometryCoreOps(state_).loadStep(fp);
}

AlignmentResult GeometryServiceImpl::centerAndAlignBody(
    const ShellId& partId, const SnapshotId& transactionId) {
  return GeometryCoreOps(state_).centerAndAlignBody(partId, transactionId);
}

TopologyGraph GeometryServiceImpl::getTopology(const SolidId& solidId) {
  return GeometryCoreOps(state_).getTopology(solidId);
}

std::vector<ShellId> GeometryServiceImpl::separateSolids(const SolidId& solidId) {
  return GeometryCoreOps(state_).separateSolids(solidId);
}

BooleanCutResult GeometryServiceImpl::booleanCut(const SolidId& solidId,
                                                   double nx, double ny, double nz,
                                                   double ox, double oy, double oz) {
  return GeometryCoreOps(state_).booleanCut(solidId, nx, ny, nz, ox, oy, oz);
}

TabSlotResult GeometryServiceImpl::addTabSlot(const ShellId& shellIdA,
                                               const ShellId& shellIdB,
                                               double kerfOffsetMm) {
  return GeometryCoreOps(state_).addTabSlot(shellIdA, shellIdB, kerfOffsetMm);
}

RivetHoleResult GeometryServiceImpl::addRivetHole(const ShellId& shellId,
                                                    const std::string& faceId,
                                                    double centerX, double centerY,
                                                    double diameterMm) {
  return GeometryCoreOps(state_).addRivetHole(shellId, faceId, centerX, centerY, diameterMm);
}

SnapshotId GeometryServiceImpl::createSnapshot(const std::string& label) {
  return GeometryCoreOps(state_).createSnapshot(label);
}

RestoreResult GeometryServiceImpl::restoreSnapshot(const SnapshotId& snapshotId) {
  return GeometryCoreOps(state_).restoreSnapshot(snapshotId);
}

void GeometryServiceImpl::clearSnapshots() {
  GeometryCoreOps(state_).clearSnapshots();
}

void GeometryServiceImpl::clearState() {
  GeometryCoreOps(state_).clearState();
}

// ─── Factory ─────────────────────────────────────────────────────────────────

std::unique_ptr<GeometryService> GeometryService::create() {
  return std::make_unique<GeometryServiceImpl>();
}

}  // namespace mcp_cad
