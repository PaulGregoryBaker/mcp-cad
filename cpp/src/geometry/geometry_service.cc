/**
 * GeometryService implementation — OCCT wrapper.
 *
 * This is the ONLY file in the project that includes OCCT headers.
 * All OCCT exceptions are caught here and re-thrown as GeometryError.
 *
 * Tasks: T022, T024, T025, T090
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
#include <BRepPrimAPI_MakeHalfSpace.hxx>

#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>

#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Edge.hxx>
#include <ShapeFix_Face.hxx>

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

#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>

// ─── Project includes ────────────────────────────────────────────────────────
#include "geometry_service.hpp"

// ─── Standard library ────────────────────────────────────────────────────────
#include <unordered_map>
#include <memory>
#include <mutex>
#include <sstream>
#include <cmath>
#include <chrono>
#include <random>
#include <algorithm>
#include <iomanip>
#include <functional>

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

// ─── State containers ────────────────────────────────────────────────────────

struct SolidState {
  SolidId     id;
  TopoDS_Shape shape;
};

struct ShellState {
  ShellId     id;
  SolidId     parentSolidId;
  TopoDS_Shape shape;
};

struct UnfoldState {
  UnfoldId    id;
  ShellId     sourceShellId;
  double      flatWidthMm;
  double      flatHeightMm;
  double      kFactorUsed;
  int         bendCount;
  std::string dxfContent;
};

// ─── GeometryServiceImpl ─────────────────────────────────────────────────────

class GeometryServiceImpl : public GeometryService {
public:
  GeometryServiceImpl() = default;
  ~GeometryServiceImpl() override = default;

  // ── STEP import ──────────────────────────────────────────────────────────

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

  // ── Topology extraction ──────────────────────────────────────────────────

  TopologyGraph getTopology(const SolidId& solidId) override {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = solids_.find(solidId);
    if (it == solids_.end()) {
      throw GeometryError("GE_SOLID_NOT_FOUND",
                          "Solid not found: " + solidId, false, "");
    }

    const TopoDS_Shape& shape = it->second.shape;
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

  // ── Manifold detection ───────────────────────────────────────────────────

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

  // ── Shape healing ────────────────────────────────────────────────────────

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

  // ── Boolean cut (decomposition) ──────────────────────────────────────────

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
      gp_Dir normal(nx, ny, nz);
      gp_Pln plane(origin, normal);

      // Build half-spaces for cut
      BRepBuilderAPI_MakeFace faceMaker(plane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face cutFace = faceMaker.Face();

      BRepAlgoAPI_Cut cutter(it->second.shape, cutFace);
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

      return BooleanCutResult{shellIds, token};

    } catch (const GeometryError&) {
      throw;  // re-throw structured errors as-is
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_BOOLEAN_FAILURE",
                          std::string("OCCT boolean cut exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Tab-slot synthesis ───────────────────────────────────────────────────

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

      return TabSlotResult{
          {shellIdA, shellIdB},
          kerf,
          token
      };

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_TAB_SLOT_FAILED",
                          std::string("Tab-slot exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Rivet hole ───────────────────────────────────────────────────────────

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
      return RivetHoleResult{shellId, holeId, token};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_RIVET_HOLE_FAILED",
                          std::string("Rivet hole exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Unfolding ────────────────────────────────────────────────────────────

  UnfoldResult unfoldShell(const ShellId& shellId, double kFactor) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellId) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    SnapshotId token = createSnapshotLocked("before unfold of " + shellId);

    try {
      // Phase A stub: full CadQuery unfold implemented in Phase C (T070)
      // Returns placeholder dimensions derived from bounding box
      const TopoDS_Shape& shape = shells_[shellId].shape;

      // Compute bounding box
      double xMin, yMin, zMin, xMax, yMax, zMax;
      BRep_Builder builder;
      // Use BRepBndLib for proper bbox computation
      // For stub, use unit dimensions
      double flatW = 100.0;  // placeholder
      double flatH = 100.0;  // placeholder

      UnfoldId id = generateUUID();
      UnfoldState state{id, shellId, flatW, flatH, kFactor, 1, ""};
      unfolds_[id] = state;

      return UnfoldResult{id, flatW, flatH, kFactor, 1, token};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_UNFOLD_FAILED",
                          std::string("Unfold exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── DXF export ───────────────────────────────────────────────────────────

  DxfExportResult exportDxf(const UnfoldId& unfoldId) override {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = unfolds_.find(unfoldId);
    if (it == unfolds_.end()) {
      throw GeometryError("GE_UNFOLD_NOT_FOUND",
                          "Unfold not found: " + unfoldId, false, "");
    }

    // Phase A stub: full DXF export implemented in Phase C (T072)
    const UnfoldState& state = it->second;
    std::ostringstream dxf;
    dxf << "  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n"
        << "  0\nSECTION\n  2\nENTITIES\n"
        << "  0\nLINE\n  8\n0\n"
        << " 10\n0.0\n 20\n0.0\n 30\n0.0\n"
        << " 11\n" << state.flatWidthMm << "\n 21\n0.0\n 31\n0.0\n"
        << "  0\nENDSEC\n  0\nEOF\n";

    return DxfExportResult{dxf.str(), 4,
                           state.flatWidthMm, state.flatHeightMm};
  }

  // ── Corner reliefs ───────────────────────────────────────────────────────

  ShellId addCornerRelief(const ShellId& shellId,
                           ReliefType reliefType,
                           double radiusMm) override {
    std::lock_guard<std::mutex> lock(mutex_);

    if (shells_.find(shellId) == shells_.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    // Phase A stub: full relief generation in Phase C (T068)
    return shellId;
  }

  // ── Nesting ──────────────────────────────────────────────────────────────

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

    // Phase A stub: full libnest2d nesting in Phase D (T086)
    NestId nestId = generateUUID();
    std::vector<NestPlacement> placements;
    double x = 10.0;
    for (const auto& uid : unfoldIds) {
      placements.push_back({uid, 0, x, 10.0, 0.0});
      x += unfolds_[uid].flatWidthMm + 5.0;
    }

    double totalArea = 0;
    for (const auto& uid : unfoldIds) {
      totalArea += unfolds_[uid].flatWidthMm * unfolds_[uid].flatHeightMm;
    }
    double sheetArea   = sheetWidthMm * sheetHeightMm;
    double utilisation = std::min(100.0, (totalArea / sheetArea) * 100.0);

    return NestResult{nestId, placements, utilisation, 1};
  }

  // ── Snapshot / rollback ──────────────────────────────────────────────────

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

    // Restore solid and shell registries to snapshot state
    // Keep only entries that existed at snapshot time
    auto filterMap = [](auto& map, const std::vector<std::string>& keepIds) {
      std::unordered_map<std::string, typename std::decay_t<decltype(map)>::mapped_type> kept;
      for (const auto& id : keepIds) {
        auto it = map.find(id);
        if (it != map.end()) {
          kept[id] = it->second;
        }
      }
      map = std::move(kept);
    };

    filterMap(solids_,  snap.solidIds);
    filterMap(shells_,  snap.shellIds);
    filterMap(unfolds_, snap.unfoldIds);

    return RestoreResult{snap.solidIds, snap.shellIds};
  }

  void clearSnapshots() override {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshots_.clear();
  }

private:
  // ── State ────────────────────────────────────────────────────────────────
  mutable std::mutex mutex_;
  std::unordered_map<SolidId,   SolidState>   solids_;
  std::unordered_map<ShellId,   ShellState>   shells_;
  std::unordered_map<UnfoldId,  UnfoldState>  unfolds_;
  std::unordered_map<SnapshotId, GeometrySnapshot> snapshots_;

  // ── Private helpers ──────────────────────────────────────────────────────

  SnapshotId createSnapshotLocked(const std::string& label) {
    GeometrySnapshot snap;
    snap.snapshotId     = generateUUID();
    snap.operationLabel = label;
    snap.timestampMs    = nowMs();

    for (const auto& kv : solids_)  snap.solidIds.push_back(kv.first);
    for (const auto& kv : shells_)  snap.shellIds.push_back(kv.first);
    for (const auto& kv : unfolds_) snap.unfoldIds.push_back(kv.first);

    snapshots_[snap.snapshotId] = snap;
    return snap.snapshotId;
  }

  void buildTopologyGraph(const TopoDS_Shape& shape, TopologyGraph& graph) {
    // ── Index faces ─────────────────────────────────────────────────────
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

    // ── Index edges ──────────────────────────────────────────────────────
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

    // ── Build face-face adjacency (dihedral angles) ───────────────────────
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
};

// ─── Factory ──────────────────────────────────────────────────────────────────

std::unique_ptr<GeometryService> GeometryService::create() {
  return std::make_unique<GeometryServiceImpl>();
}

}  // namespace mcp_cad
