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

#include "topology_graph.hpp"
#include "snapshot.hpp"

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
  std::vector<ShellId> shellIds;
  SnapshotId           rollbackToken;
};

struct TabSlotResult {
  std::vector<ShellId> modifiedShellIds;
  double               kerfOffsetApplied;  // mm; always in [0.1, 0.2]
  SnapshotId           rollbackToken;
};

struct RivetHoleResult {
  ShellId    modifiedShellId;
  std::string holeFeatureId;
  SnapshotId rollbackToken;
};

struct UnfoldResult {
  UnfoldId   unfoldId;
  double     flatWidthMm;
  double     flatHeightMm;
  double     kFactorUsed;
  int        bendCount;
  SnapshotId rollbackToken;
};

struct DxfExportResult {
  std::string dxfContent;   // DXF file as UTF-8 string
  int         wireCount;
  double      bboxWidthMm;
  double      bboxHeightMm;
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
  ShellId    trimmedShellId;
  SnapshotId rollbackToken;
};

struct SplitBodyResult {
  ShellId    positiveShellId;
  ShellId    negativeShellId;
  SnapshotId rollbackToken;
};

struct ExtendFaceResult {
  ShellId    modifiedShellId;
  double     extensionDistanceMm;
  SnapshotId rollbackToken;
};

struct OffsetFaceResult {
  ShellId    modifiedShellId;
  SnapshotId rollbackToken;
};

struct AddFlangeResult {
  ShellId     modifiedShellId;
  std::string flangeFeatureId;
  SnapshotId  rollbackToken;
};

struct RipEdgeResult {
  ShellId    modifiedShellId;
  SnapshotId rollbackToken;
};

struct MergeBodyResult {
  ShellId    mergedShellId;
  SnapshotId rollbackToken;
};

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

  // ── Snapshot / rollback ────────────────────────────────────────────────────
  virtual SnapshotId    createSnapshot(const std::string& label)            = 0;
  virtual RestoreResult restoreSnapshot(const SnapshotId& snapshotId)       = 0;
  virtual void          clearSnapshots()                                     = 0;
};

}  // namespace mcp_cad
