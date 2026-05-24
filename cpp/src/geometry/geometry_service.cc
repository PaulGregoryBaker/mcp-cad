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
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepBuilderAPI_Copy.hxx>

#include <BRepBuilderAPI_Transform.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Location.hxx>
#include <TDF_Label.hxx>

#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>

// ─── Project includes ────────────────────────────────────────────────────────
#include "geometry_service.hpp"
#include "shape_history.hpp"

// ─── Standard library ────────────────────────────────────────────────────────
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

  // ── Compound decomposition ───────────────────────────────────────────────

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

      return TabSlotResult{{shellIdA, shellIdB}, kerf, token, {}};

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
      return RivetHoleResult{shellId, holeId, token, {}};

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
      const TopoDS_Shape& shellShape = shells_[shellId].shape;

      // Compute bounding box for flat dimensions
      Bnd_Box bbox;
      BRepBndLib::Add(shellShape, bbox);
      double xMin, yMin, zMin, xMax, yMax, zMax;
      bbox.Get(xMin, yMin, zMin, xMax, yMax, zMax);

      double flatW = xMax - xMin;
      double flatH = yMax - yMin;

      UnfoldId id = generateUUID();
      UnfoldState state{id, shellId, flatW, flatH, kFactor, 1, ""};
      unfolds_[id] = state;

      return UnfoldResult{id, flatW, flatH, kFactor, 1, token, {}};

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

    if (sheetWidthMm <= 0 || sheetHeightMm <= 0) {
      throw GeometryError("GE_INVALID_SHEET_DIMS",
                          "Sheet dimensions must be positive", false, "");
    }

    // ── Shelf-Next-Fit Decreasing (SNFD) rectangular bin packing ──────────
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

    // ── SVG preview ────────────────────────────────────────────────────────
    // Generate a compact SVG visualising the placement on sheet 0.
    // Each panel is a coloured rectangle; the sheet outline is a grey frame.
    const double svgScale = 0.2; // mm → SVG units (px)
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
      ++colIdx;
    }
    svg += "</svg>\n";

    return NestResult{nestId, placements, utilisation, sheetsRequired, svg};
  }

  // ── GLB mesh export ──────────────────────────────────────────────────────

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

        // Emit 3 independent vertices (flat shading — no vertex sharing)
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

    // ── Build binary chunk ──────────────────────────────────────────────────
    // Layout: [positions float32×3×N][normals float32×3×N], 4-byte padded

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

    // ── Build JSON chunk ────────────────────────────────────────────────────

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

    // ── Assemble GLB ────────────────────────────────────────────────────────

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

    SnapshotId token = createSnapshotLocked("before fuseBodies");

    try {
      TopoDS_Shape currentShape = toolShapes[0];
      std::vector<ShapeHistoryRecord> history;
      bool disjoint = false;

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

        if (nextShape.ShapeType() == TopAbs_COMPOUND) {
          disjoint = true;
        }

        auto h1 = captureHistory(fuser, currentShape, [](const TopoDS_Shape& s) { return shapeId(s); }, "fuse_bodies");
        auto h2 = captureHistory(fuser, toolShapes[i], [](const TopoDS_Shape& s) { return shapeId(s); }, "fuse_bodies");
        history.insert(history.end(), h1.begin(), h1.end());
        history.insert(history.end(), h2.begin(), h2.end());

        currentShape = nextShape;
      }

      for (const auto& id : tools) {
        shells_.erase(id);
      }

      ShellId resultId = generateUUID();
      shells_[resultId] = ShellState{resultId, "", currentShape};

      return FuseResult{resultId, disjoint, token, std::move(history)};

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

  void clearSnapshots() override {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshots_.clear();
    snapshotSolids_.clear();
    snapshotShells_.clear();
    snapshotUnfolds_.clear();
  }

private:
  // ── State ────────────────────────────────────────────────────────────────
  mutable std::mutex mutex_;
  std::unordered_map<SolidId,   SolidState>   solids_;
  std::unordered_map<ShellId,   ShellState>   shells_;
  std::unordered_map<UnfoldId,  UnfoldState>  unfolds_;
  std::unordered_map<SnapshotId, GeometrySnapshot> snapshots_;
  std::unordered_map<SnapshotId, std::unordered_map<SolidId, SolidState>> snapshotSolids_;
  std::unordered_map<SnapshotId, std::unordered_map<ShellId, ShellState>> snapshotShells_;
  std::unordered_map<SnapshotId, std::unordered_map<UnfoldId, UnfoldState>> snapshotUnfolds_;

  // ── Private helpers ──────────────────────────────────────────────────────

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

  // ── Split body by plane ──────────────────────────────────────────────────

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
                            "Positive side is empty — plane may not intersect the body",
                            true, "rollback");
      }
      BRepGProp::VolumeProperties(cutNeg.Shape(), props);
      if (props.Mass() < 1e-6) {
        throw GeometryError("GE_SPLIT_FAILED",
                            "Negative side is empty — plane may not intersect the body",
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

  // ── Split body by bends ──────────────────────────────────────────────────

  // ── Helpers ─────────────────────────────────────────────────────────────

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
    bool    isOuter;  // N · (centroid - solidCentroid) > 0
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
      if (std::abs(angle - 180.0) <= angleThresholdDeg) {
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

  // ── Protrusion detection ─────────────────────────────────────────────────

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
    // × tabHeight along panelNormal. This avoids the over-extraction that a half-space
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

  // T017 — Detect protrusion candidates before any panel cutting.
  // Applies three tests per connected non-primary-face region:
  //   1. Extent   : attachment edge length < 50% of primary panel perimeter
  //   2. Orientation: cap face normal · panel normal > 0.85
  //   3. Thickness: min face-pair distance in the region ≤ maxThicknessMm
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

    // ── AABB + hull-ratio classification (used by both detection passes) ──
    // Compute the solid's tight AABB and, for each face group, the fraction of
    // its vertices that touch the AABB boundary. Groups with low hullRatio are
    // "interior" — sitting inside the solid rather than on its outer hull.
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
    constexpr double kHullTol = 0.5;  // mm — vertex this close to AABB face = on hull
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

      // Map: non-primary face index → total attachment edge length from group g
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

        // Test 1: Extent — total attachment < 50% of primary panel perimeter
        double totalAttach = 0.0;
        for (int fi : component) {
          auto it = attachLen.find(fi);
          if (it != attachLen.end()) totalAttach += it->second;
        }
        double extentRatio = groupPerimeter[g] > 1e-6 ? totalAttach / groupPerimeter[g] : 0.0;
        if (extentRatio >= 0.50) continue;

        // Test 2: Orientation — cap face normal ∥ panel normal (dot > 0.85)
        int    capIdx = -1;
        double maxProj = -1e9;
        for (int fi : component) {
          gp_Vec toFace(groups[g].centroid, faceCentroid[fi]);
          double proj = pNorm.Dot(toFace);
          if (proj > maxProj) { maxProj = proj; capIdx = fi; }
        }
        if (capIdx < 0) continue;
        gp_Vec capNorm = faceOutwardNormal(TopoDS::Face(faceMap(capIdx)));

        // Test 3: Thickness — protrusion dimension along panel normal ≤ maxThicknessMm.
        // Strategy:
        //   (a) Anti-parallel pairs within the component (tab between two opposite faces)
        //   (b) Cap face vs primary panel faces — parallel (tab) or anti-parallel (plate)
        //   (c) Cap face vs any other outer group's faces — plate-style where the
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

    // ── Option-2 pass: detect tabs/bosses whose cap face is itself a primary
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

    // ── Option-3 pass: detect bridge/flange protrusions — anti-parallel
    // interior face groups that form a thin slab (e.g. connecting flanges
    // between two concentric hollow cubes). Neither BFS nor Option-2 can
    // detect these because both exposed faces are primary groups and they
    // are anti-parallel, not parallel. We pair them by:
    //   1. Both interior (hullRatio < kInteriorThreshold)
    //   2. Anti-parallel normals (dot < -0.85)
    //   3. Normal-direction offset ≤ maxThicknessMm
    //   4. Similar areas (within 3:1)
    //   5. Overlapping 2-D footprints (rules out false pairs at same Y but
    //      different X, e.g. flanges on opposite sides of the solid)
    // Helper: find all interior groups coplanar AND topologically connected
    // to group g (same normal, same plane within 0.5 mm, and reachable via
    // shared edges between member faces). A meshed/triangulated flange face
    // is often emitted as two coplanar triangles that buildFaceGroups can't
    // merge if their shared diagonal is treated as a non-coplanar edge —
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

  // T018 — Extract one protrusion from the solid by cutting at the primary
  // panel's outer face plane. Updates remainder (solid minus protrusion).
  // planeHalfSize: symmetric UV half-extent for the cutting planeFace.
  //   Must be large enough to span the entire solid cross-section at the cut plane.
  //   Computed once from the original solid's diagonal (vertex-iterated) so it is
  //   geometrically correct without ballooning to the ±200 km values that
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
      // footprint (precomputed in (tabU, tabV)) × tab height along panelNormal.
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
  // sized" candidate spans > 80% of the solid in 2+ axes — that's a wall slab
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

      // Build a planar face from the boundary wire
      BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), /*onlyPlane=*/true);
      if (!faceMaker.IsDone()) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Could not build planar face from boundary wire", true, "rollback");
      }

      // Extrude along the group's outward normal
      gp_Vec extVec(grp.normal.X() * defaultThicknessMm,
                    grp.normal.Y() * defaultThicknessMm,
                    grp.normal.Z() * defaultThicknessMm);
      BRepPrimAPI_MakePrism prism(faceMaker.Face(), extVec);
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
        auto records = captureHistory(prism, faceMaker.Face(),
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
      gp_Pln  innerPlane;   // cutting plane (inner face plane)
      gp_Pnt  outerRefPt;   // point clearly on the outer side of innerPlane
      double  distFromCenter;
    };

    std::vector<PanelCut> cuts;
    cuts.reserve(groups.size());

    for (int i = 0; i < (int)groups.size(); ++i) {
      if (!groups[i].isOuter) continue;

      double bestDist = std::numeric_limits<double>::max();
      int    bestJ    = -1;

      for (int j = 0; j < (int)groups.size(); ++j) {
        if (i == j || groups[j].isOuter) continue;
        if (groups[i].normal.Dot(groups[j].normal) > -0.95) continue;

        // Measure face-to-face distance
        const TopoDS_Face& fOut = TopoDS::Face(faceMap(groups[i].faceIndices[0]));
        const TopoDS_Face& fIn  = TopoDS::Face(faceMap(groups[j].faceIndices[0]));
        BRepExtrema_DistShapeShape d(fOut, fIn);
        if (!d.IsDone() || d.Value() > maxThicknessMm) continue;
        if (d.Value() < bestDist) { bestDist = d.Value(); bestJ = j; }
      }

      if (bestJ < 0) continue;

      // Inner face plane: use inner group's centroid and the outer normal's reverse
      gp_Dir innerNormalDir(
          -groups[i].normal.X(), -groups[i].normal.Y(), -groups[i].normal.Z());
      gp_Pln innerPln(groups[bestJ].centroid, innerNormalDir);

      // Outer reference point: clearly outside the solid on the outer face's side
      gp_Pnt outerRef(
          groups[i].centroid.X() + groups[i].normal.X() * (bestDist + 20.0),
          groups[i].centroid.Y() + groups[i].normal.Y() * (bestDist + 20.0),
          groups[i].centroid.Z() + groups[i].normal.Z() * (bestDist + 20.0));

      double distFromCenter = groups[i].normal.Dot(gp_Vec(solidCentroid, groups[i].centroid));
      cuts.push_back({innerPln, outerRef, distFromCenter});
    }

    // Process outermost panels first (minimises corner-ownership artefacts)
    std::sort(cuts.begin(), cuts.end(), [](const PanelCut& a, const PanelCut& b) {
      return a.distFromCenter > b.distFromCenter;
    });

    TopoDS_Shape remainder = solid;

    for (const auto& cut : cuts) {
      if (remainder.IsNull()) break;

      // Half-space on the outer side of the inner plane.
      // Use the precomputed planeHalfSize (diagonal of the original solid × 1.1 + 10 mm)
      // so the planeFace always spans the full solid cross-section at this plane.
      BRepBuilderAPI_MakeFace planeFaceMaker(
          cut.innerPlane,
          -planeHalfSize, planeHalfSize,
          -planeHalfSize, planeHalfSize);
      if (!planeFaceMaker.IsDone()) continue;
      TopoDS_Face planeFace = planeFaceMaker.Face();

      BRepPrimAPI_MakeHalfSpace hs(planeFace, cut.outerRefPt);
      hs.Build();
      if (!hs.IsDone()) continue;

      // Extract panel slab = remainder ∩ half-space
      BRepAlgoAPI_Common extract(remainder, hs.Solid());
      extract.Build();
      if (!extract.IsDone() || extract.Shape().IsNull()) {
        throw GeometryError(GE_DECOMPOSE_CUT_FAILED, "Panel extraction failed", true, "rollback");
      }

      GProp_GProps ep;
      BRepGProp::VolumeProperties(extract.Shape(), ep);
      if (std::abs(ep.Mass()) < 1e-6) continue;  // empty slab — skip

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

      // Remainder = remainder minus the panel slab
      BRepAlgoAPI_Cut cutRemainder(remainder, hs.Solid());
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

  // T022 — Recursive decomposition. Operates on an arbitrary solid shape
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
    if (std::abs(rp.Mass()) < 1.0) return;  // < 1 mm³ — nothing meaningful left

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
    // not BRepBndLib::Add which can report ±200 km for STEP-imported planar faces).
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
        if (isPanelSized(ps, workShape)) continue;  // false positive — leave for splitMode2
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

  // ── Main entry point ─────────────────────────────────────────────────────

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

      std::string mode = detectObjectMode(shape, maxThicknessMm);

      // Build face groups now (needed for protrusion detection).
      // For surface mode isOuter classification is irrelevant; pass dummy centroid.
      gp_Pnt solidCentroid(0, 0, 0);
      if (mode == "thin_solid") {
        GProp_GProps vp;
        BRepGProp::VolumeProperties(shape, vp);
        solidCentroid = vp.CentreOfMass();
      }
      TopTools_IndexedMapOfShape faceMapPre;
      TopExp::MapShapes(shape, TopAbs_FACE, faceMapPre);
      auto faceGroupsPre = buildFaceGroups(shape, faceMapPre, angleThresholdDeg, solidCentroid);

      // Compute the original solid's tight bounding box via vertex iteration.
      // BRepBndLib::Add is NOT used here: for STEP-imported shapes it samples the
      // underlying surface's full UV domain and can report ±200 km for a planar face
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

      // T019 — Detect and extract protrusions before panel cutting.
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
      // between the inner and outer hollow cubes — removing them leaves two
      // separate solids), splitMode2 run on the combined shape would pair
      // inner-cube and outer-cube outer faces across the void and produce
      // 25 mm-thick "panels" that wrap both walls plus the gap. OCCT may
      // keep the disconnected result as one Solid with multiple Shells, so
      // TopAbs_SOLID iteration alone misses it — run a face-level BFS via
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
        // on its own remainder — the bleed from protrusion extraction
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

      // T022 — Recursive decomposition into remainder solid(s)
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
        constexpr double kTol = 1.0;  // mm — tolerance for on-boundary vertices
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

  // ── Remove protrusions ────────────────────────────────────────────────────

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

    SnapshotId token = createSnapshotLocked("before removeProtrusions on " + partId);

    try {
      // Compute planeHalfSize from vertex bounds (same approach as splitBodyByBends).
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

      // Update the original part's geometry in-place with the cleaned shape.
      auto shellIt = shells_.find(partId);
      if (shellIt != shells_.end()) {
        shellIt->second.shape = workShape;
      }

      // Compute bboxes for extracted protrusions.
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

  // ── Merge bodies with bend ───────────────────────────────────────────────

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

    SnapshotId token = createSnapshotLocked("before mergeBodiesWithBend on " +
                                            partAId + "+" + partBId);

    try {
      TopoDS_Shape inputA = itA->second.shape;
      TopoDS_Shape inputB = itB->second.shape;
      BRepAlgoAPI_Fuse fuse(inputA, inputB);
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_MERGE_FAILED", "Boolean fuse failed", true, "rollback");
      }
      TopoDS_Shape fused = fuse.Shape();

      // Attempt fillet on matching edges. Any OCCT failure is non-fatal — fall back to
      // unfilleted fuse. The exception can be thrown from the constructor, Add(), or Build()
      // depending on OCCT version and shape topology (e.g. ChFi3d_Builder:only 2 faces when
      // the fused result is a shell rather than a solid).
      bool wantAll = std::find(targetEdges.begin(), targetEdges.end(), "all") != targetEdges.end();
      TopoDS_Shape result = fused;  // default: unfilleted
      try {
        BRepFilletAPI_MakeFillet filletMaker(fused);
        bool addedAny = false;
        TopExp_Explorer edgeExp(fused, TopAbs_EDGE);
        for (; edgeExp.More(); edgeExp.Next()) {
          const TopoDS_Edge& e = TopoDS::Edge(edgeExp.Current());
          if (wantAll ||
              std::find(targetEdges.begin(), targetEdges.end(), shapeId(e)) != targetEdges.end()) {
            filletMaker.Add(bendRadiusMm, e);
            addedAny = true;
          }
        }
        if (addedAny) {
          filletMaker.Build();
          if (filletMaker.IsDone() && !filletMaker.Shape().IsNull()) {
            result = filletMaker.Shape();
          }
        }
      } catch (const Standard_Failure&) {
        // Fillet not supported for this topology — proceed with unfilleted fuse.
        result = fused;
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

  // ── Extend face to target ────────────────────────────────────────────────

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
      // Locate the face
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
        throw GeometryError("GE_EXTEND_FAILED", "Face not found: " + faceId, false, "");
      }

      // Compute face normal at centroid
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

      // Compute extension distance
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
        auto tIt = shells_.find(targetPartId);
        if (tIt == shells_.end()) {
          throw GeometryError("GE_SHELL_NOT_FOUND",
                              "Target part not found: " + targetPartId, false, "");
        }
        TopoDS_Shape targetShape = tIt->second.shape;
        if (!targetFaceId.empty()) {
          TopExp_Explorer tExp(tIt->second.shape, TopAbs_FACE);
          for (; tExp.More(); tExp.Next()) {
            if (shapeId(tExp.Current()) == targetFaceId) {
              targetShape = tExp.Current();
              break;
            }
          }
        }
        BRepExtrema_DistShapeShape dist(face, targetShape);
        dist.Perform();
        if (!dist.IsDone()) {
          throw GeometryError("GE_EXTEND_FAILED", "Cannot compute distance to target", false, "");
        }
        extDist = dist.Value();
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

  // ── Offset face ──────────────────────────────────────────────────────────

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

  // ── Add flange ───────────────────────────────────────────────────────────

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

  // ── Rip edge ─────────────────────────────────────────────────────────────

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

  // ── Clash detection ──────────────────────────────────────────────────────

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

  // ── Gap detection ────────────────────────────────────────────────────────

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
        // Closest point pair — used to identify the faces involved
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

  // ── Trim body with plane ─────────────────────────────────────────────────

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
          ? origin.Translated(n * -100.0)   // tool on negative side → keep positive
          : origin.Translated(n * 100.0);   // tool on positive side → keep negative

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
};

// ─── Factory ──────────────────────────────────────────────────────────────────

std::unique_ptr<GeometryService> GeometryService::create() {
  return std::make_unique<GeometryServiceImpl>();
}

}  // namespace mcp_cad
