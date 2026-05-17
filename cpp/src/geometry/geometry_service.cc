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
#include <BRep_DistShapeShape.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepBuilderAPI_Copy.hxx>

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

      return SplitBodyResult{posId, negId, token};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_SPLIT_FAILED",
                          std::string("OCCT exception during split: ") + e.GetMessageString(),
                          true, "rollback");
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
      BRepAlgoAPI_Fuse fuse(itA->second.shape, itB->second.shape);
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_MERGE_FAILED", "Boolean fuse failed", true, "rollback");
      }
      TopoDS_Shape fused = fuse.Shape();

      // Attempt fillet on matching edges. Failure is non-fatal — fall back to unfilleted fuse.
      bool wantAll = std::find(targetEdges.begin(), targetEdges.end(), "all") != targetEdges.end();
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

      TopoDS_Shape result;
      if (addedAny) {
        filletMaker.Build();
        if (filletMaker.IsDone() && !filletMaker.Shape().IsNull()) {
          result = filletMaker.Shape();
        } else {
          result = fused;  // fillet failed gracefully — use unfilleted fuse
        }
      } else {
        result = fused;
      }

      ShellId mergedId = generateUUID();
      shells_[mergedId] = ShellState{mergedId, itA->second.parentSolidId, result};
      return MergeBodyResult{mergedId, token};

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
        BRep_DistShapeShape dist(face, targetShape);
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
        return ExtendFaceResult{partId, 0.0, token};
      }

      // Extrude face toward target and fuse with shell
      gp_Vec extVec = faceNormal * extDist;
      BRepPrimAPI_MakePrism prism(face, extVec);
      prism.Build();
      if (!prism.IsDone()) {
        throw GeometryError("GE_EXTEND_FAILED", "Face extrusion failed", true, "rollback");
      }

      BRepAlgoAPI_Fuse fuse(it->second.shape, prism.Shape());
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_EXTEND_FAILED",
                            "Failed to fuse extension with shell", true, "rollback");
      }

      it->second.shape = fuse.Shape();
      return ExtendFaceResult{partId, std::abs(extDist), token};

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

      TopoDS_Shape result;
      if (distanceMm > 0.0) {
        BRepAlgoAPI_Fuse fuse(it->second.shape, prism.Shape());
        fuse.Build();
        if (!fuse.IsDone() || fuse.Shape().IsNull()) {
          throw GeometryError("GE_OFFSET_FAILED",
                              "Face offset fuse failed", true, "rollback");
        }
        result = fuse.Shape();
      } else {
        BRepAlgoAPI_Cut cut(it->second.shape, prism.Shape());
        cut.Build();
        if (!cut.IsDone() || cut.Shape().IsNull()) {
          throw GeometryError("GE_OFFSET_FAILED",
                              "Face offset cut failed", true, "rollback");
        }
        result = cut.Shape();
      }

      it->second.shape = result;
      return OffsetFaceResult{partId, token};

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
      return AddFlangeResult{partId, flangeFeatureId, token};

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
      return RipEdgeResult{partId, token};

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
      BRep_DistShapeShape distCalc(itA->second.shape, itB->second.shape);
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

      return TrimBodyResult{partId, token};

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
