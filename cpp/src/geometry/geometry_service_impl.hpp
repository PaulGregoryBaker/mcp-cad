#pragma once

/**
 * geometry_service_impl.hpp — shared internal header for the geometry service.
 *
 * Declares GeometryState (the shared mutable state) and GeometryServiceImpl
 * (the facade class). All OCCT types are forward-declared or kept in .cc files.
 * This header is included by every geometry_service_*.cc translation unit.
 */

#include "geometry_service.hpp"
#include "shape_history.hpp"

// OCCT forward declarations needed for state container types only.
// The actual OCCT includes live in every .cc that uses them.
#include <Standard_Handle.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Edge.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Application.hxx>
#include <gp_Pnt2d.hxx>

#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include <memory>

namespace mcp_cad {

// ─── State containers ────────────────────────────────────────────────────────

struct SolidState {
  SolidId      id;
  TopoDS_Shape shape;
};

struct ShellState {
  ShellId      id;
  SolidId      parentSolidId;
  TopoDS_Shape shape;
};

struct FlatBendEdge {
  TopoDS_Edge edge;      // edge in flat-plane coordinates (z ≈ 0)
  double      angleDeg;  // absolute bend angle
  bool        isUp;      // true = BEND_UP, false = BEND_DOWN
};

struct UnfoldState {
  UnfoldId    id;
  ShellId     sourceShellId;
  double      flatWidthMm;
  double      flatHeightMm;
  double      kFactorUsed;
  int         bendCount;

  // Flat geometry (built by unfoldShell, serialised by exportDxf)
  std::vector<TopoDS_Shape>   flatPanelShapes;  // one compound per panel (in XY plane)
  std::vector<FlatBendEdge>   flatBendEdges;    // bend centerlines in flat coordinates
  gp_Pnt2d                    origin2d;         // (uMin, vMin) offset used during build

  ShellId     improvedPartId;  // new shell with curved bend radii; empty on failure
};

struct AssemblyState {
  AssemblyId id;
  Handle(TDocStd_Document) doc;
  Handle(XCAFDoc_ShapeTool) shapeTool;
  TDF_Label assemblyLabel;
  std::unordered_map<ComponentId, TDF_Label> components;
};

// ─── GeometryState ────────────────────────────────────────────────────────────
//
// All mutable session state. Passed by reference to every domain class.

struct GeometryState {
  mutable std::mutex                                                          mutex;
  std::unordered_map<SolidId,    SolidState>                                 solids;
  std::unordered_map<ShellId,    ShellState>                                 shells;
  std::unordered_map<UnfoldId,   UnfoldState>                                unfolds;
  std::unordered_map<AssemblyId, AssemblyState>                              assemblies;
  std::unordered_map<SnapshotId, GeometrySnapshot>                           snapshots;
  std::unordered_map<SnapshotId, std::unordered_map<SolidId,    SolidState>> snapshotSolids;
  std::unordered_map<SnapshotId, std::unordered_map<ShellId,    ShellState>> snapshotShells;
  std::unordered_map<SnapshotId, std::unordered_map<UnfoldId,   UnfoldState>> snapshotUnfolds;
  std::unordered_map<SnapshotId, std::unordered_map<AssemblyId, AssemblyState>> snapshotAssemblies;
  Handle(TDocStd_Application) app;
};

// ─── GeometryServiceImpl (facade) ─────────────────────────────────────────────
//
// Owns the GeometryState and delegates each virtual method to the appropriate
// domain class (instantiated on the stack per call).

class GeometryServiceImpl : public GeometryService {
public:
  GeometryServiceImpl();
  ~GeometryServiceImpl() override = default;

  // ── STEP import ──────────────────────────────────────────────────────────
  SolidId loadStep(const std::string& filePath) override;

  // ── Viewport orientation and alignment ───────────────────────────────────
  AlignmentResult centerAndAlignBody(const ShellId& partId,
                                      const SnapshotId& transactionId) override;

  // ── Topology ─────────────────────────────────────────────────────────────
  TopologyGraph getTopology(const SolidId& solidId) override;

  // ── Manifold detection & healing ─────────────────────────────────────────
  ManifoldResult checkManifold(const SolidId& solidId) override;
  SolidId        healGeometry(const SolidId& solidId) override;

  // ── Decomposition ────────────────────────────────────────────────────────
  std::vector<ShellId> separateSolids(const SolidId& solidId) override;

  BooleanCutResult booleanCut(const SolidId& solidId,
                               double nx, double ny, double nz,
                               double ox, double oy, double oz) override;

  // ── Clash and gap detection ───────────────────────────────────────────────
  ClashReport    computeIntersections(const std::vector<ShellId>& partIds) override;
  std::vector<ClashPair> checkAssemblyClashes(
      const std::vector<ShellId>& partIds,
      const std::vector<std::pair<ShellId,ShellId>>& adjacentPairs) override;
  GapReport      computeGaps(const ShellId& partAId, const ShellId& partBId,
                              double maxDistanceThresholdMm) override;

  // ── Direct modeling mutations ─────────────────────────────────────────────
  TrimBodyResult trimBodyWithPlane(const ShellId& partId, const CuttingPlane& plane,
                                    bool keepPositiveSide) override;

  // ── Joint synthesis ──────────────────────────────────────────────────────
  TabSlotResult  addTabSlot(const ShellId& shellIdA, const ShellId& shellIdB,
                              double kerfOffsetMm) override;
  RivetHoleResult addRivetHole(const ShellId& shellId, const std::string& faceId,
                                double centerX, double centerY, double diameterMm) override;

  // ── Sheet metal operations ────────────────────────────────────────────────
  UnfoldResult    unfoldShell(const ShellId& shellId, double kFactor) override;
  DxfExportResult exportDxf(const UnfoldId& unfoldId) override;
  DxfSheetResult  buildSheetFromDxf(const std::string& dxfContent) override;
  ThickenSheetResult thickenSheet(const ShellId& sheetId, double thicknessMm) override;
  ApplyBendResult applyBend(const ShellId& panelAId, const ShellId& panelBId,
                             double innerRadiusMm, double angleDeg, double kFactor) override;

  BuildShellFromFlatPatternResult buildShellFromFlatPattern(
      const std::string& dxfContent,
      const std::vector<BendZoneSpec>& bendZones,
      double thicknessMm,
      const std::string& referenceShellId = "") override;

  PanelFrameResult getPanelFrame(const std::string& shellId) override;

  ShellId addCornerRelief(const ShellId& shellId, ReliefType reliefType,
                           double radiusMm) override;

  NestResult nestShells(const std::vector<UnfoldId>& unfoldIds,
                         double sheetWidthMm, double sheetHeightMm) override;

  // ── Mesh export ───────────────────────────────────────────────────────────
  std::vector<uint8_t> exportGlb(const ShellId& shellId) override;

  // ── Body topology ─────────────────────────────────────────────────────────
  SplitBodyResult  splitBodyByPlane(const ShellId& partId,
                                     const CuttingPlane& plane) override;
  MergeBodyResult  mergeBodiesWithBend(const ShellId& partAId,
                                        const ShellId& partBId,
                                        const std::vector<std::string>& targetEdges,
                                        double bendRadiusMm) override;
  CloseGapResult   closeGap(const ShellId& partAId, const ShellId& partBId) override;

  // ── Extended direct modeling ───────────────────────────────────────────────
  ExtendFaceResult extendFaceToTarget(const ShellId& partId, const std::string& faceId,
                                       const std::string& targetType,
                                       const std::string& targetPartId,
                                       const std::string& targetFaceId,
                                       const CuttingPlane& targetPlane) override;
  OffsetFaceResult offsetFace(const ShellId& partId, const std::string& faceId,
                               double distanceMm) override;

  // ── Sheet metal detailing ─────────────────────────────────────────────────
  AddFlangeResult addFlange(const ShellId& partId, const std::string& edgeId,
                             double lengthMm, double angleDeg, double bendRadiusMm) override;
  RipEdgeResult   ripEdge(const ShellId& partId, const std::string& edgeId) override;

  // ── Sheet metal decomposition ─────────────────────────────────────────────
  DecomposedByBendsResult splitBodyByBends(const ShellId& partId,
                                            double angleThresholdDeg,
                                            double maxThicknessMm    = 5.0,
                                            double defaultThicknessMm = 1.0,
                                            int    maxRecursionDepth  = 1) override;
  RemoveProtrusionsResult removeProtrusions(const ShellId& partId,
                                             double angleThresholdDeg = 30.0,
                                             double maxThicknessMm    = 5.0) override;
  RemoveProtrusionsResult removeProtrusionsLegacy(const ShellId& partId,
                                                    double angleThresholdDeg = 30.0,
                                                    double maxThicknessMm    = 5.0) override;

  // ── Snapshot / rollback ───────────────────────────────────────────────────
  SnapshotId    createSnapshot(const std::string& label) override;
  RestoreResult restoreSnapshot(const SnapshotId& snapshotId) override;
  void          clearSnapshots() override;
  void          clearState() override;

  // ── Interrogation ─────────────────────────────────────────────────────────
  BoundingBoxResult    computeBoundingBox(const std::string& entityId) override;
  MassPropertiesResult computeMassProperties(const std::string& entityId,
                                              const std::vector<std::string>& properties) override;
  MeasureResult        measureDistance(const std::string& entityA,
                                       const std::string& entityB,
                                       const std::string& measurementType) override;
  ExploreResult        exploreTopology(const std::string& entityId,
                                        const std::string& returnType) override;

  // ── Boolean operations ────────────────────────────────────────────────────
  FuseResult      fuseBodies(const std::vector<ShellId>& tools,
                              double fuzzyTolerance) override;
  CutResult       cutBodies(const ShellId& blank, const std::vector<ShellId>& tools,
                             bool keepTools) override;
  IntersectResult intersectBodies(const ShellId& a, const ShellId& b) override;

  // ── Geometric transformations ─────────────────────────────────────────────
  TransformResult translateBody(const ShellId& solidId, double dx, double dy, double dz,
                                 bool keepOriginal) override;
  TransformResult rotateBody(const ShellId& solidId,
                              double axOriginX, double axOriginY, double axOriginZ,
                              double axDirX,    double axDirY,    double axDirZ,
                              double angleDeg,  bool keepOriginal) override;
  TransformResult mirrorBody(const ShellId& solidId,
                              double plOriginX, double plOriginY, double plOriginZ,
                              double plNormX,   double plNormY,   double plNormZ,
                              bool keepOriginal) override;
  TransformResult scaleBody(const ShellId& solidId,
                             double originX, double originY, double originZ,
                             double scaleFactor, bool keepOriginal) override;
  TransformResult alignToFace(const std::string& sourceFaceId,
                               const std::string& destFaceId,
                               bool flipNormal, bool keepOriginal) override;

  // ── Direct edit operations ────────────────────────────────────────────────
  FilletResult      filletEdges(const ShellId& partId,
                                 const std::vector<std::string>& edgeIds,
                                 double radiusMm) override;
  ChamferResult     chamferEdges(const ShellId& partId,
                                  const std::vector<std::string>& edgeIds,
                                  double distanceMm) override;
  SimplifyResult    simplifyBody(const ShellId& partId,
                                  bool unifyFaces, bool unifyEdges) override;
  HealExResult      healGeometryEx(const ShellId& partId,
                                    bool fixTolerances, bool fixWires) override;
  OffsetShapeResult offsetShape(const ShellId& partId, double offsetValue,
                                 double tolerance) override;
  DeleteFaceResult  deleteFace(const ShellId& partId,
                                const std::vector<std::string>& faceIds,
                                bool healRemaining) override;

  // ── Sewing ────────────────────────────────────────────────────────────────
  SewResult sewFaces(const std::vector<std::string>& entityIds,
                      double tolerance, bool makeSolid) override;

  // ── Assembly ─────────────────────────────────────────────────────────────
  CreateAssemblyResult createAssemblyDocument() override;
  AddInstanceResult    addAssemblyInstance(const AssemblyId& assemblyId,
                                            const std::string& shapeId,
                                            double tx, double ty, double tz,
                                            double qw, double qx, double qy, double qz) override;
  MateRigidResult      mateRigid(const AssemblyId& assemblyId,
                                  const std::string& srcEntityId,
                                  const std::string& dstEntityId,
                                  bool flipAlignment) override;
  ListAssemblyResult   listAssemblyTree(const AssemblyId& assemblyId) override;

  // ── Sheet metal validation ────────────────────────────────────────────────
  SheetMetalValidationResult validateSheetMetal(const ShellId& partId) override;
  CurvedRebuildResult        reconstructCurvedBends(const ShellId& partId) override;

private:
  GeometryState state_;
};

}  // namespace mcp_cad
