#pragma once

/**
 * GeometryService — Facade interface for all OCCT geometry operations.
 *
 * This header defines the public API of the Geometry Engine. All OCCT types
 * are confined to the .cc implementation; no OCCT headers are included here.
 * This enforces the facade pattern required by Constitution Principle II.
 *
 * Task: T021
 */

#include <string>
#include <vector>
#include <memory>
#include <optional>
#include <stdexcept>
#include <array>

#include "topology_graph.hpp"
#include "snapshot.hpp"
#include "shape_history.hpp"

namespace mcp_cad {

// ─── Identity types ──────────────────────────────────────────────────────────

using SolidId  = std::string;  // UUID v4
using ShellId  = std::string;  // UUID v4
using UnfoldId = std::string;  // UUID v4
using NestId   = std::string;  // UUID v4

// ─── Result types ────────────────────────────────────────────────────────────

struct ManifoldIssue {
  enum class Type { FREE_EDGE, NON_MANIFOLD_EDGE, DEGENERATE_FACE, SLIVER_FACE };
  Type        type;
  std::string faceId;
  std::string edgeId;
  std::string description;
};

struct ManifoldResult {
  bool                          isManifold;
  std::vector<ManifoldIssue>   issues;
};

struct BooleanCutResult {
  std::vector<ShellId>            shellIds;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct TabSlotResult {
  std::vector<ShellId>            modifiedShellIds;
  double                          kerfOffsetApplied;  // mm; always in [0.1, 0.2]
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct RivetHoleResult {
  ShellId                         modifiedShellId;
  std::string                     holeFeatureId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct UnfoldResult {
  UnfoldId                        unfoldId;
  double                          flatWidthMm;
  double                          flatHeightMm;
  double                          kFactorUsed;
  int                             bendCount;
  bool                            validated = false;
  double                          detectedThickness = 0.0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
  ShellId                         improvedPartId;   // curved-bend rebuild; empty on failure
};

struct DxfExportResult {
  std::string dxfContent;   // DXF file as UTF-8 string
  int         wireCount;
  double      bboxWidthMm;
  double      bboxHeightMm;
};

struct SheetMetalValidationResult {
  bool                     isValid          = false;
  double                   nominalThickness = 0.0;
  bool                     canFlatten       = false;
  std::vector<std::string> validationErrors;
};

struct GapSewResult {
  ShellId                         solidId;
  bool                            sewComplete      = false;
  double                          maxGapFound      = 0.0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct CurvedRebuildResult {
  ShellId                         solidId;
  int                             bendsReplaced    = 0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct NestPlacement {
  UnfoldId unfoldId;
  int      sheetIndex;
  double   x;
  double   y;
  double   rotationDeg;
};

struct NestResult {
  NestId                       nestId;
  std::vector<NestPlacement>   placements;
  double                       utilisationPct;  // 0–100
  int                          sheetsRequired;
  std::string                  svgPreview;      // SVG visualisation for debugging
};

struct RestoreResult {
  std::vector<SolidId>  restoredSolidIds;
  std::vector<ShellId>  restoredShellIds;
};

// ─── Geometry error ──────────────────────────────────────────────────────────

/**
 * Geometry operation error. All OCCT exceptions are converted to this type
 * at the facade boundary. The `code` field maps to Engineering-Design §3.4.
 */
class GeometryError : public std::runtime_error {
public:
  std::string code;
  bool        recoverable;
  std::string suggestedTool;

  GeometryError(const std::string& code,
                const std::string& message,
                bool               recoverable   = false,
                const std::string& suggestedTool = "")
      : std::runtime_error(message),
        code(code),
        recoverable(recoverable),
        suggestedTool(suggestedTool) {}
};

// ─── Shared geometric primitives ────────────────────────────────────────────

struct CuttingPlane {
  double normalX = 0.0, normalY = 0.0, normalZ = 1.0;  // unit normal
  double originX = 0.0, originY = 0.0, originZ = 0.0;  // point on plane (mm)
};

// ─── Diagnostic result types ─────────────────────────────────────────────────

struct ClashPair {
  ShellId partIdA;
  ShellId partIdB;
  double  intersectionVolumeMm3 = 0.0;
  struct BBox { double ox, oy, oz, dx, dy, dz; } clashBoundingBox{};
  CuttingPlane suggestedCuttingPlane;
};

struct ClashReport {
  bool                    intersects = false;
  std::vector<ClashPair>  clashes;
};

struct GapReport {
  bool        hasGap           = false;
  double      minimumDistanceMm = 0.0;
  std::string partAFaceId;
  std::string partBFaceId;
  struct Vec3 { double x, y, z; } extensionVector{};
  struct BBox { double ox, oy, oz, dx, dy, dz; } gapBoundingBox{};
};

// ─── Mutation result types ────────────────────────────────────────────────────

struct TrimBodyResult {
  ShellId                         trimmedShellId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct SplitBodyResult {
  ShellId                         positiveShellId;
  ShellId                         negativeShellId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct ExtendFaceResult {
  ShellId                         modifiedShellId;
  double                          extensionDistanceMm;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct OffsetFaceResult {
  ShellId                         modifiedShellId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct AddFlangeResult {
  ShellId                         modifiedShellId;
  std::string                     flangeFeatureId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct RipEdgeResult {
  ShellId                         modifiedShellId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct MergeBodyResult {
  ShellId                         mergedShellId;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct CloseGapResult {
  ShellId    partBId;       // updated shell ID (same ID, shape translated in-place)
  double     gapClosedMm;   // how much gap was closed (0 if already touching)
  SnapshotId rollbackToken;
};

struct BBox3D {
  double xMin, yMin, zMin;
  double xMax, yMax, zMax;
};

// Tracks which panel each protrusion was cut from.
// parentPanelId is empty for protrusions extracted before any panel cut (pre-cut pass).
struct ProtrusionParent {
  ShellId protrusionId;
  ShellId parentPanelId;  // empty string → no parent panel (pre-cut extraction)
};

struct DecomposedByBendsResult {
  std::vector<ShellId>          panelIds;           // flat solid panels
  std::vector<BBox3D>           panelBboxes;        // AABB for each panel (parallel to panelIds)
  std::vector<ShellId>          protrusionIds;      // flanges / tabs extracted from the solid
  std::vector<BBox3D>           protrusionBboxes;   // AABB for each protrusion
  std::vector<ProtrusionParent> protrusionParents;  // parent panel for each protrusion
  SnapshotId                    rollbackToken;
  std::string                   detectedMode;       // "surface" | "thin_solid"
  std::vector<ShapeHistoryRecord> shapeHistory;     // face-level lineage records
};

struct RemoveProtrusionsResult {
  ShellId              cleanedPartId;   // same ID as input, geometry updated in-place
  std::vector<ShellId> protrusionIds;  // each extracted protrusion as a new shell
  std::vector<BBox3D>  protrusionBboxes;
  SnapshotId           rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct AlignmentResult {
  ShellId                         solidId;
  double                          centroid[3];
  double                          rotationMatrix[9];
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

// ── Assembly IDs ──────────────────────────────────────────────────────────────
using AssemblyId  = std::string;
using ComponentId = std::string;

// ── Boolean results ───────────────────────────────────────────────────────────
struct FuseResult {
  ShellId solidId;
  bool disjoint;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct CutResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct IntersectResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

// ── Interrogation results ─────────────────────────────────────────────────────
struct BoundingBoxResult {
  double xMin, yMin, zMin;
  double xMax, yMax, zMax;
};

struct MassPropertiesResult {
  std::optional<double> volume;
  std::optional<double> surfaceArea;
  std::optional<std::array<double,3>> centroid;
  std::optional<std::array<double,9>> inertiaTensor;
};

struct MeasureResult {
  double value;
  std::string measurementType;
};

struct ExploreResult {
  std::vector<std::string> entityIds;
};

// ── Transform result ──────────────────────────────────────────────────────────
struct TransformResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

// ── Direct edit results ───────────────────────────────────────────────────────
struct FilletResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct ChamferResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct SimplifyResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct HealExResult {
  ShellId solidId;
  bool healComplete;
  std::vector<std::string> remainingIssues;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct OffsetShapeResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct DeleteFaceResult {
  std::vector<ShellId> solidIds;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

// ── Sewing result ─────────────────────────────────────────────────────────────
struct SewResult {
  ShellId solidId;
  bool sewComplete;
  std::vector<std::string> freeEdges;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

// ── Assembly results ──────────────────────────────────────────────────────────
struct CreateAssemblyResult {
  AssemblyId assemblyId;
};

struct AddInstanceResult {
  ComponentId componentId;
  SnapshotId rollbackToken;
};

struct LocationMatrix {
  std::array<double,16> m;
};

struct MateRigidResult {
  ComponentId componentId;
  LocationMatrix locationMatrix;
  SnapshotId rollbackToken;
};

struct AssemblyNode {
  ComponentId componentId;
  std::string shapeId;
  LocationMatrix locationMatrix;
  std::vector<AssemblyNode> children;
};

struct ListAssemblyResult {
  AssemblyId assemblyId;
  AssemblyNode root;
};

// ─── Error code constants (Feature 003-split-by-bends-enhanced) ─────────────

constexpr const char* GE_DECOMPOSE_THICKNESS_MISMATCH     = "GE_DECOMPOSE_THICKNESS_MISMATCH";
constexpr const char* GE_DECOMPOSE_EXTRUDE_FAILED         = "GE_DECOMPOSE_EXTRUDE_FAILED";
constexpr const char* GE_DECOMPOSE_CUT_FAILED             = "GE_DECOMPOSE_CUT_FAILED";
constexpr const char* GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED = "GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED";

// ─── Error codes — Feature 008-splits-by-bends-viewport-alignment ──────────────
constexpr const char* GE_ALIGN_FAILED             = "GE_ALIGN_FAILED";
constexpr const char* GE_MERGE_NON_MANIFOLD       = "GE_MERGE_NON_MANIFOLD";
constexpr const char* GE_PROTRUSION_LOOP_FAILED   = "GE_PROTRUSION_LOOP_FAILED";

// ─── Error codes — Feature 006-geometry-primitives ────────────────────────────
constexpr const char* GE_BOOLEAN_EMPTY_RESULT      = "GE_BOOLEAN_EMPTY_RESULT";
constexpr const char* GE_ALIGN_UNSUPPORTED         = "GE_ALIGN_UNSUPPORTED";
constexpr const char* GE_SCALE_NON_UNIFORM         = "GE_SCALE_NON_UNIFORM";
constexpr const char* GE_FILLET_TOO_LARGE          = "GE_FILLET_TOO_LARGE";
constexpr const char* GE_CHAMFER_TOO_LARGE         = "GE_CHAMFER_TOO_LARGE";
constexpr const char* GE_HEAL_INCOMPLETE           = "GE_HEAL_INCOMPLETE";
constexpr const char* GE_SEW_INCOMPLETE            = "GE_SEW_INCOMPLETE";
constexpr const char* GE_ASSEMBLY_MATE_UNSUPPORTED = "GE_ASSEMBLY_MATE_UNSUPPORTED";
constexpr const char* GE_ASSEMBLY_CROSS_DOCUMENT   = "GE_ASSEMBLY_CROSS_DOCUMENT";

// ─── Error codes — Feature 007-sheet-metal-unfolding ──────────────────────────
constexpr const char* GE_INVALID_SHEET_METAL      = "GE_INVALID_SHEET_METAL";
constexpr const char* GE_UNFOLD_CYCLE_DETECTED    = "GE_UNFOLD_CYCLE_DETECTED";
constexpr const char* GE_UNFOLD_T_JUNCTION        = "GE_UNFOLD_T_JUNCTION";
constexpr const char* GE_UNFOLD_SEWING_FAILED      = "GE_UNFOLD_SEWING_FAILED";
constexpr const char* GE_UNFOLD_REBUILD_FAILED     = "GE_UNFOLD_REBUILD_FAILED";

// ─── GeometryService interface ───────────────────────────────────────────────

/**
 * GeometryService is the primary facade for geometry operations.
 * All callers (NAPI binding, tests) interact through this interface.
 * The implementation (geometry_service.cc) is the only file that includes OCCT headers.
 */
class GeometryService {
public:
  static std::unique_ptr<GeometryService> create();
  virtual ~GeometryService() = default;

  // ── STEP import ─────────────────────────────────────────────────────────
  virtual SolidId loadStep(const std::string& filePath) = 0;

  // ── Viewport orientation and alignment ───────────────────────────────────
  virtual AlignmentResult centerAndAlignBody(
      const ShellId&    partId,
      const SnapshotId& transactionId) = 0;

  // ── Topology ─────────────────────────────────────────────────────────────
  virtual TopologyGraph getTopology(const SolidId& solidId) = 0;

  // ── Manifold detection & healing ─────────────────────────────────────────
  virtual ManifoldResult checkManifold(const SolidId& solidId) = 0;
  virtual SolidId        healGeometry(const SolidId& solidId)  = 0;

  // ── Decomposition ─────────────────────────────────────────────────────────
  // Enumerates the individual solid bodies within a compound shape and
  // registers each as a shell. For a STEP assembly this returns one shell
  // per panel; for a single-body solid it returns one shell.
  virtual std::vector<ShellId> separateSolids(const SolidId& solidId) = 0;

  virtual BooleanCutResult booleanCut(const SolidId&    solidId,
                                       double            normalX,
                                       double            normalY,
                                       double            normalZ,
                                       double            originX,
                                       double            originY,
                                       double            originZ) = 0;

  // ── Clash and gap detection (non-mutating) ────────────────────────────────
  virtual ClashReport computeIntersections(
      const std::vector<ShellId>& partIds) = 0;

  virtual GapReport computeGaps(
      const ShellId& partAId,
      const ShellId& partBId,
      double         maxDistanceThresholdMm) = 0;

  // ── Direct modeling mutations ─────────────────────────────────────────────
  virtual TrimBodyResult trimBodyWithPlane(
      const ShellId&      partId,
      const CuttingPlane& plane,
      bool                keepPositiveSide) = 0;

  // ── Joint synthesis ────────────────────────────────────────────────────────
  virtual TabSlotResult  addTabSlot(const ShellId& shellIdA,
                                     const ShellId& shellIdB,
                                     double         kerfOffsetMm) = 0;
  virtual RivetHoleResult addRivetHole(const ShellId& shellId,
                                        const std::string& faceId,
                                        double centerX,
                                        double centerY,
                                        double diameterMm) = 0;

  // ── Sheet metal operations ─────────────────────────────────────────────────
  virtual UnfoldResult    unfoldShell(const ShellId& shellId, double kFactor)   = 0;
  virtual DxfExportResult exportDxf(const UnfoldId& unfoldId)                   = 0;

  // ── Corner reliefs ─────────────────────────────────────────────────────────
  enum class ReliefType { DOGBONE, CIRCULAR };
  virtual ShellId addCornerRelief(const ShellId& shellId,
                                   ReliefType     reliefType,
                                   double         radiusMm) = 0;

  // ── Nesting ────────────────────────────────────────────────────────────────
  virtual NestResult nestShells(const std::vector<UnfoldId>& unfoldIds,
                                 double sheetWidthMm,
                                 double sheetHeightMm) = 0;

  // ── Mesh export ────────────────────────────────────────────────────────────
  // Returns a GLB (glTF 2.0 binary) byte buffer for the shell's tessellated mesh.
  // Coordinates are in metres (glTF convention). Flat per-triangle normals.
  virtual std::vector<uint8_t> exportGlb(const ShellId& shellId) = 0;

  // ── Body topology ──────────────────────────────────────────────────────────
  virtual SplitBodyResult splitBodyByPlane(
      const ShellId&      partId,
      const CuttingPlane& plane) = 0;

  virtual MergeBodyResult mergeBodiesWithBend(
      const ShellId&                  partAId,
      const ShellId&                  partBId,
      const std::vector<std::string>& targetEdges,
      double                          bendRadiusMm) = 0;

  virtual CloseGapResult closeGap(
      const ShellId& partAId,
      const ShellId& partBId) = 0;

  // ── Extended direct modeling ───────────────────────────────────────────────
  virtual ExtendFaceResult extendFaceToTarget(
      const ShellId&      partId,
      const std::string&  faceId,
      const std::string&  targetType,
      const std::string&  targetPartId,
      const std::string&  targetFaceId,
      const CuttingPlane& targetPlane) = 0;

  virtual OffsetFaceResult offsetFace(
      const ShellId&     partId,
      const std::string& faceId,
      double             distanceMm) = 0;

  // ── Sheet metal detailing ──────────────────────────────────────────────────
  virtual AddFlangeResult addFlange(
      const ShellId&     partId,
      const std::string& edgeId,
      double             lengthMm,
      double             angleDeg,
      double             bendRadiusMm) = 0;

  virtual RipEdgeResult ripEdge(
      const ShellId&     partId,
      const std::string& edgeId) = 0;

  // Decomposes a shell into planar panels by splitting at every bend edge.
  // Mode is auto-detected: thin-solid (wall ≤ maxThicknessMm) uses cutting planes
  // to preserve original wall thickness; surface/thick models extrude each face
  // group by defaultThicknessMm. Protrusions are returned separately with parent tracking.
  virtual DecomposedByBendsResult splitBodyByBends(
      const ShellId& partId,
      double         angleThresholdDeg,
      double         maxThicknessMm    = 5.0,
      double         defaultThicknessMm = 1.0,
      int            maxRecursionDepth  = 1) = 0;

  // Detects and extracts all protrusions/flanges from a shell without splitting
  // into panels. The shell geometry is updated in-place (cleaned); extracted
  // protrusions are returned as new shells. Mutating — creates a rollback token.
  virtual RemoveProtrusionsResult removeProtrusions(
      const ShellId& partId,
      double         angleThresholdDeg = 30.0,
      double         maxThicknessMm    = 5.0) = 0;

  virtual RemoveProtrusionsResult removeProtrusionsLegacy(
      const ShellId& partId,
      double         angleThresholdDeg = 30.0,
      double         maxThicknessMm    = 5.0) = 0;

  // ── Snapshot / rollback ────────────────────────────────────────────────────
  virtual SnapshotId    createSnapshot(const std::string& label)            = 0;
  virtual RestoreResult restoreSnapshot(const SnapshotId& snapshotId)       = 0;
  virtual void          clearSnapshots()                                     = 0;

  // ── Feature 006-geometry-primitives US2 (Interrogation) ────────────────────
  virtual BoundingBoxResult    computeBoundingBox(const std::string& entityId) = 0;
  virtual MassPropertiesResult computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) = 0;
  virtual MeasureResult        measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) = 0;
  virtual ExploreResult        exploreTopology(const std::string& entityId, const std::string& returnType) = 0;

  // ── Feature 006-geometry-primitives US1 (Boolean Operations) ────────────────
  virtual FuseResult           fuseBodies(const std::vector<ShellId>& tools, double fuzzyTolerance) = 0;
  virtual CutResult            cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools) = 0;
  virtual IntersectResult      intersectBodies(const ShellId& a, const ShellId& b) = 0;

  // ── Feature 006-geometry-primitives US3 (Geometric Transformations) ─────────
  virtual TransformResult      translateBody(const ShellId& solidId, double dx, double dy, double dz, bool keepOriginal) = 0;
  virtual TransformResult      rotateBody(const ShellId& solidId, double axOriginX, double axOriginY, double axOriginZ, double axDirX, double axDirY, double axDirZ, double angleDeg, bool keepOriginal) = 0;
  virtual TransformResult      mirrorBody(const ShellId& solidId, double plOriginX, double plOriginY, double plOriginZ, double plNormX, double plNormY, double plNormZ, bool keepOriginal) = 0;
  virtual TransformResult      scaleBody(const ShellId& solidId, double originX, double originY, double originZ, double scaleFactor, bool keepOriginal) = 0;
  virtual TransformResult      alignToFace(const std::string& sourceFaceId, const std::string& destFaceId, bool flipNormal, bool keepOriginal) = 0;

  // ── Feature 006-geometry-primitives US4 (Direct Edit Operations) ────────────
  virtual FilletResult         filletEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double radiusMm) = 0;
  virtual ChamferResult        chamferEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double distanceMm) = 0;
  virtual SimplifyResult       simplifyBody(const ShellId& partId, bool unifyFaces, bool unifyEdges) = 0;
  virtual HealExResult         healGeometryEx(const ShellId& partId, bool fixTolerances, bool fixWires) = 0;
  virtual OffsetShapeResult    offsetShape(const ShellId& partId, double offsetValue, double tolerance) = 0;
  virtual DeleteFaceResult     deleteFace(const ShellId& partId, const std::vector<std::string>& faceIds, bool healRemaining) = 0;

  // ── Feature 006-geometry-primitives US5 (Sewing) ────────────────────────────
  virtual SewResult            sewFaces(const std::vector<std::string>& entityIds, double tolerance, bool makeSolid) = 0;

  // ── Feature 006-geometry-primitives US6 (Assembly) ──────────────────────────
  virtual CreateAssemblyResult createAssemblyDocument() = 0;
  virtual AddInstanceResult    addAssemblyInstance(const AssemblyId& assemblyId, const std::string& shapeId, double tx, double ty, double tz, double qw, double qx, double qy, double qz) = 0;
  virtual MateRigidResult      mateRigid(const AssemblyId& assemblyId, const std::string& srcEntityId, const std::string& dstEntityId, bool flipAlignment) = 0;
  virtual ListAssemblyResult   listAssemblyTree(const AssemblyId& assemblyId) = 0;

  // ── Feature 007-sheet-metal-unfolding ───────────────────────────────────────
  virtual SheetMetalValidationResult validateSheetMetal(const ShellId& partId) = 0;
  virtual CurvedRebuildResult        reconstructCurvedBends(const ShellId& partId) = 0;
};

}  // namespace mcp_cad
