/**
 * NAPI addon loader and geometry operation wrapper.
 * Bridges TypeScript MCP server to the C++ Geometry Engine.
 *
 * Task: T038
 */

import * as path from 'path';
import * as fs from 'fs';
import { toStructuredError, throwError, ErrorCodes } from '../mcp/errors';
import type {
  AlignmentResult,
  SplitBodyByBendsResult,
  RemoveProtrusionsResult,
  TopologyGraph,
  ManifoldResult,
  BooleanCutResult,
  TabSlotResult,
  RivetHoleResult,
  UnfoldResult,
  DxfExportResult,
  DxfSheetResult,
  ThickenSheetResult,
  ApplyBendResult,
  NapiBendZoneSpec,
  FlatPanelPlacement,
  BuildShellFromFlatPatternResult,
  PanelFrameResult,
  NestResult,
  RestoreResult,
  ClashReport,
  ClashPair,
  GapReport,
  TrimBodyResult,
  SplitBodyResult,
  ExtendFaceResult,
  OffsetFaceResult,
  AddFlangeResult,
  RipEdgeResult,
  MergeBodyResult,
  CuttingPlane,
  BoundingBoxResult,
  MassPropertiesResult,
  MeasureResult,
  ExploreResult,
  FuseResult,
  CutResult,
  IntersectResult,
  TransformResult,
  FilletResult,
  ChamferResult,
  SimplifyResult,
  HealExResult,
  OffsetShapeResult,
  DeleteFaceResult,
  SewResult,
  CreateAssemblyResult,
  AddInstanceResult,
  MateRigidResult,
  ListAssemblyResult,
  SheetMetalValidationResult,
  CurvedRebuildResult,
  CloseGapResult,
  PanelValidationResult,
  PanelThicknessResult,
  NapiPartGraphSpec,
  EvaluatePartGraphResult,
  ConstructPartSolidResult,
  NapiPoint2,
  NapiPoint3,
  MapToWorldResult,
  MapToFlatResult,
  ReconcileOutlinesResult,
  NapiPanelPieceSpec,
  ReconcilePiecesResult,
  PolygonBooleanResult,
  CutPanelResult,
  NapiTransform3,
  EvaluateFindingsResult,
  NapiManufacturingProfile,
  CloseGapDeltaResult,
  FlangeOutlineResult,
  NapiRipEdgeResult,
  NapiBendSpec,
  NapiPanelFragment,
} from './types';

// ─── Addon interface ──────────────────────────────────────────────────────────

export interface GeometryAddon {
  loadStep(filePath: string): string;
  getTopology(solidId: string): TopologyGraph;
  checkManifold(solidId: string): ManifoldResult;
  healGeometry(solidId: string): string;
  separateSolids(solidId: string): string[];
  booleanCut(
    solidId: string,
    normal: { x: number; y: number; z: number },
    origin: { x: number; y: number; z: number },
  ): BooleanCutResult;
  addTabSlot(shellIdA: string, shellIdB: string, kerfOffsetMm: number): TabSlotResult;
  addRivetHole(
    shellId: string,
    faceId: string,
    centerX: number,
    centerY: number,
    diameterMm: number,
  ): RivetHoleResult;
  unfoldShell(shellId: string, kFactor: number): UnfoldResult;
  exportDxf(unfoldId: string): DxfExportResult;
  buildSheetFromDxf?(dxfContent: string): DxfSheetResult;
  thickenSheet?(sheetId: string, thicknessMm: number): ThickenSheetResult;
  applyBend?(
    panelAId: string,
    panelBId: string,
    innerRadiusMm: number,
    angleDeg: number,
    kFactor: number,
  ): ApplyBendResult;
  buildShellFromFlatPattern?(
    dxfContent: string,
    bendZones: NapiBendZoneSpec[],
    thicknessMm: number,
    explicitPlacement?: FlatPanelPlacement,
  ): BuildShellFromFlatPatternResult;
  getPanelFrame?(shellId: string): PanelFrameResult;
  exportGlb(shellId: string): Buffer;
  nestShells(unfoldIds: string[], sheetWidthMm: number, sheetHeightMm: number): NestResult;
  createSnapshot(label: string): string;
  restoreSnapshot(snapshotId: string): RestoreResult;
  clearSnapshot(snapshotId: string): void;
  clearSnapshots(): void;
  clearState(): void;
  computeBoundingBox(entityId: string): BoundingBoxResult;
  computeMassProperties(entityId: string, properties?: string[]): MassPropertiesResult;
  measureDistance(entityA: string, entityB: string, measurementType: string): MeasureResult;
  exploreTopology(entityId: string, returnType: string): ExploreResult;
  fuseBodies(tools: string[], fuzzyTolerance: number): FuseResult;
  cutBodies(blank: string, tools: string[], keepTools: boolean): CutResult;
  intersectBodies(a: string, b: string): IntersectResult;
  translateBody(
    solidId: string,
    dx: number,
    dy: number,
    dz: number,
    keepOriginal: boolean,
  ): TransformResult;
  rotateBody(
    solidId: string,
    axisPointX: number,
    axisPointY: number,
    axisPointZ: number,
    axisDirX: number,
    axisDirY: number,
    axisDirZ: number,
    angleDeg: number,
    keepOriginal: boolean,
  ): TransformResult;
  mirrorBody(
    solidId: string,
    planeOriginX: number,
    planeOriginY: number,
    planeOriginZ: number,
    planeNormalX: number,
    planeNormalY: number,
    planeNormalZ: number,
    keepOriginal: boolean,
  ): TransformResult;
  scaleBody(
    solidId: string,
    originX: number,
    originY: number,
    originZ: number,
    scaleFactor: number,
    keepOriginal: boolean,
  ): TransformResult;
  alignToFace(
    srcFaceId: string,
    dstFaceId: string,
    flipNormal: boolean,
    keepOriginal: boolean,
  ): TransformResult;
  filletEdges(partId: string, edgeIds: string[], radiusMm: number): FilletResult;
  chamferEdges(partId: string, edgeIds: string[], distanceMm: number): ChamferResult;
  simplifyBody(partId: string, unifyFaces: boolean, unifyEdges: boolean): SimplifyResult;
  healGeometryEx(partId: string, fixTolerances: boolean, fixWires: boolean): HealExResult;
  offsetShape(partId: string, offsetValue: number, tolerance: number): OffsetShapeResult;
  deleteFace(partId: string, faceIds: string[], healRemaining: boolean): DeleteFaceResult;
  computeIntersections(partIds: string[]): ClashReport;
  checkAssemblyClashes(partIds: string[], adjacentPairs: [string, string][]): ClashPair[];
  computeGaps(partAId: string, partBId: string, maxDistanceThresholdMm: number): GapReport;
  trimBodyWithPlane(partId: string, plane: CuttingPlane, keepPositiveSide: boolean): TrimBodyResult;
  splitBodyByPlane(partId: string, plane: CuttingPlane): SplitBodyResult;
  mergeBodiesWithBend(
    partAId: string,
    partBId: string,
    targetEdges: string[],
    bendRadiusMm: number,
  ): MergeBodyResult;
  closeGap(partAId: string, partBId: string): CloseGapResult;
  isPanelValid(partId: string): PanelValidationResult;
  extendFaceToTarget(
    partId: string,
    faceId: string,
    targetType: string,
    targetPartId: string,
    targetFaceId: string,
    targetPlane: CuttingPlane,
  ): ExtendFaceResult;
  offsetFace(partId: string, faceId: string, distanceMm: number): OffsetFaceResult;
  addFlange(
    partId: string,
    edgeId: string,
    lengthMm: number,
    angleDeg: number,
    bendRadiusMm: number,
  ): AddFlangeResult;
  ripEdge(partId: string, edgeId: string): RipEdgeResult;
  centerAndAlignBody(
    partId: string,
    transactionId: string,
  ): {
    solid_id: string;
    centroid: [number, number, number];
    rotation_matrix: [number, number, number, number, number, number, number, number, number];
    rollbackToken: string;
    shape_history?: Array<{
      verdict: 'modified' | 'generated' | 'deleted';
      original_id: string;
      new_id: string;
      operation_label: string;
    }>;
  };
  splitBodyByBends(
    partId: string,
    angleThresholdDeg: number,
    maxThicknessMm?: number,
    defaultThicknessMm?: number,
    maxRecursionDepth?: number,
  ): {
    panel_ids: string[];
    panel_thickness_mm: number[];
    panel_bboxes: Array<{
      x_min: number;
      y_min: number;
      z_min: number;
      x_max: number;
      y_max: number;
      z_max: number;
    }>;
    protrusion_ids: string[];
    protrusion_bboxes: Array<{
      x_min: number;
      y_min: number;
      z_min: number;
      x_max: number;
      y_max: number;
      z_max: number;
    }>;
    protrusion_parents: Array<{ protrusion_id: string; parent_panel_id: string | null }>;
    rollbackToken: string;
    detected_mode: string;
    shape_history?: Array<{
      verdict: 'modified' | 'generated' | 'deleted';
      original_id: string;
      new_id: string;
      operation_label: string;
    }>;
  };
  removeProtrusions(
    partId: string,
    angleThresholdDeg?: number,
    maxThicknessMm?: number,
    algorithm?: string,
  ): {
    cleaned_part_id: string;
    protrusion_ids: string[];
    protrusion_bboxes: Array<{
      x_min: number;
      y_min: number;
      z_min: number;
      x_max: number;
      y_max: number;
      z_max: number;
    }>;
    protrusion_count: number;
    rollbackToken: string;
    shape_history?: Array<{
      verdict: 'modified' | 'generated' | 'deleted';
      original_id: string;
      new_id: string;
      operation_label: string;
    }>;
  };
  sewFaces(entityIds: string[], tolerance: number, makeSolid: boolean): SewResult;
  createAssemblyDocument(): CreateAssemblyResult;
  addAssemblyInstance(
    assemblyId: string,
    shapeId: string,
    tx: number,
    ty: number,
    tz: number,
    qw: number,
    qx: number,
    qy: number,
    qz: number,
  ): AddInstanceResult;
  mateRigid(
    assemblyId: string,
    srcEntityId: string,
    dstEntityId: string,
    flipAlignment: boolean,
  ): MateRigidResult;
  listAssemblyTree(assemblyId: string): ListAssemblyResult;
  validateSheetMetal(partId: string): SheetMetalValidationResult;
  reconstructCurvedBends(partId: string): CurvedRebuildResult;
  measurePanelThickness(shellId: string): PanelThicknessResult;

  // ── Phase 5 Slice 1: graph-authored construction ──────────────────────────
  evaluatePartGraph?(graph: NapiPartGraphSpec): EvaluatePartGraphResult;
  constructPartSolid?(
    layout: EvaluatePartGraphResult,
    thicknessMm: number,
  ): ConstructPartSolidResult;

  // ── Phase 5 Slice 3: forward/reverse point mapping ────────────────────────
  mapPointToWorld?(
    graph: NapiPartGraphSpec,
    layout: EvaluatePartGraphResult,
    point2d: NapiPoint2,
    zMm?: number,
  ): MapToWorldResult;
  mapPointToFlat?(
    graph: NapiPartGraphSpec,
    layout: EvaluatePartGraphResult,
    point3d: NapiPoint3,
  ): MapToFlatResult;

  // ── Phase 5 Slice 4: merge_bodies_with_bend outline reconciliation ────────
  reconcileOutlines?(
    outlineA: NapiPoint2[],
    edgeA0: NapiPoint2,
    edgeA1: NapiPoint2,
    outlineB: NapiPoint2[],
    edgeB0: NapiPoint2,
    edgeB1: NapiPoint2,
  ): ReconcileOutlinesResult;

  // ── Phase 5 Slice 5: ingest STEP -> graph piece reconciliation ────────────
  // profile is optional; only its rules.defaultBendRadiusMm is read (the
  // assumed radius stamped onto every reconciled bend after reconciliation's
  // own self-consistency replay passes) — see step_reconciliation.hpp's own
  // header comment for why that's safe.
  reconcilePieces?(
    pieces: NapiPanelPieceSpec[],
    thicknessMm: number,
    profile?: NapiManufacturingProfile,
  ): ReconcilePiecesResult;

  // ── Phase 5 Slice 6: fuse_bodies / remove_protrusions polygon boolean ─────
  polygonUnion?(ringA: NapiPoint2[], ringB: NapiPoint2[]): PolygonBooleanResult;
  // The part's single combined flat-pattern outline (docs/BUG_REPORT_
  // outline_never_grows_for_bend_allowance.md) — computed entirely in C++
  // from an already-evaluated layout, same "layout: EvaluateResult passed
  // back in" convention as constructPartSolid/mapPointToWorld.
  buildFlatOutline?(graph: NapiPartGraphSpec, layout: EvaluatePartGraphResult): PolygonBooleanResult;
  polygonDifference?(ringA: NapiPoint2[], ringB: NapiPoint2[]): PolygonBooleanResult;
  fuseCoplanarParts?(
    outlineA: NapiPoint2[],
    anchorA: NapiTransform3,
    outlineB: NapiPoint2[],
    anchorB: NapiTransform3,
    thicknessMm: number,
  ): PolygonBooleanResult;

  // ── Phase 5 Slice 9a: cut_panel(kind=circle|polygon) ──────────────────────
  prepareCircleCut?(
    center: NapiPoint2,
    radiusMm: number,
    candidateRegions: NapiPoint2[][],
  ): CutPanelResult;
  preparePolygonCut?(ring: NapiPoint2[], candidateRegions: NapiPoint2[][]): CutPanelResult;

  // ── Phase 5 findings: manufacturability rules engine ────────────────────
  evaluateFindings?(
    graph: NapiPartGraphSpec,
    profile: NapiManufacturingProfile,
    layout: EvaluatePartGraphResult | null,
  ): EvaluateFindingsResult;

  // ── Phase 5 Slice 9b: close_gap ───────────────────────────────────────
  computeCloseGapDelta?(
    edgeA3d: NapiPoint3[],
    edgeB3d: NapiPoint3[],
    panelBPose: NapiTransform3,
  ): CloseGapDeltaResult;

  // ── Phase 5 Slice 9b: add_flange ───────────────────────────────────────
  computeFlangeOutline?(
    outline: NapiPoint2[],
    edgeIndex: number,
    flangeLengthMm: number,
  ): FlangeOutlineResult;

  // ── Phase 5 Slice 9b: rip_edge ────────────────────────────────────────
  computeRipEdge?(
    outline: NapiPoint2[],
    edgeIndex: number,
    gapMm: number,
  ): NapiRipEdgeResult;

  // ── Phase 5 Slice 9b: generate_reliefs ──────────────────────────────────
  computeReliefPolygons?(
    bends: NapiBendSpec[],
    reliefType: string,
    radiusMm: number,
    thicknessMm: number,
  ): NapiPoint2[][];

  // ── Phase 5 Slice 9b: split_body_by_plane ──────────────────────────────
  computeSplitByPlane?(
    layout: EvaluatePartGraphResult,
    nx: number,
    ny: number,
    nz: number,
    d: number,
  ): NapiPanelFragment[];
}

export const kerfOffsetMm = {
  min: 0.1,
  max: 0.2,
} as const;

// ─── Addon loading ────────────────────────────────────────────────────────────

function resolveAddonPath(): string {
  const envPath = process.env['GEOMETRY_ADDON_PATH'];
  if (envPath !== undefined && envPath.length > 0) {
    // resolve() handles absolute paths (preserved) and relative paths
    // (resolved against CWD).  Env vars set by CI / VS Code tasks are
    // often workspace-relative, and require() resolves relative paths
    // from the calling module, not CWD — so we must absolutify first.
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    // If CWD differs from the project root (e.g. forked vitest workers),
    // also try resolving relative to __dirname as a fallback.
    const fromDirname = path.resolve(__dirname, envPath);
    if (fs.existsSync(fromDirname)) {
      return fromDirname;
    }
  }

  // Default locations (relative to dist/ or project root)
  const candidates = [
    path.resolve(__dirname, '..', '..', 'geometry_addon.node'),
    path.resolve(__dirname, '..', '..', '..', 'cpp', 'build', 'Release', 'geometry_addon.node'),
    path.resolve(process.cwd(), 'geometry_addon.node'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'geometry_addon.node not found. Set GEOMETRY_ADDON_PATH or build the C++ addon first.',
  );
}

let addonInstance: GeometryAddon | null = null;

function getAddon(): GeometryAddon {
  if (addonInstance !== null) {
    return addonInstance;
  }

  const addonPath = resolveAddonPath();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  addonInstance = require(addonPath) as GeometryAddon;
  return addonInstance;
}

// ─── GeometryBinding — wraps addon with error conversion ─────────────────────

/**
 * GeometryBinding wraps all C++ NAPI addon calls and converts any
 * thrown errors to StructuredError (Constitution Principle VI).
 */
export class GeometryBinding {
  private _addon?: GeometryAddon;

  constructor(mockAddon?: GeometryAddon) {
    this._addon = mockAddon;
  }

  private get addon(): GeometryAddon {
    return this._addon ?? getAddon();
  }

  hasBuildSheetFromDxf(): boolean {
    return typeof this.addon.buildSheetFromDxf === 'function';
  }

  hasThickenSheet(): boolean {
    return typeof this.addon.thickenSheet === 'function';
  }

  hasApplyBend(): boolean {
    return typeof this.addon.applyBend === 'function';
  }

  hasBuildShellFromFlatPattern(): boolean {
    return typeof this.addon.buildShellFromFlatPattern === 'function';
  }

  hasGetPanelFrame(): boolean {
    return typeof this.addon.getPanelFrame === 'function';
  }

  hasEvaluatePartGraph(): boolean {
    return typeof this.addon.evaluatePartGraph === 'function';
  }

  hasConstructPartSolid(): boolean {
    return typeof this.addon.constructPartSolid === 'function';
  }

  hasMapPointToWorld(): boolean {
    return typeof this.addon.mapPointToWorld === 'function';
  }

  hasMapPointToFlat(): boolean {
    return typeof this.addon.mapPointToFlat === 'function';
  }

  hasReconcileOutlines(): boolean {
    return typeof this.addon.reconcileOutlines === 'function';
  }

  hasReconcilePieces(): boolean {
    return typeof this.addon.reconcilePieces === 'function';
  }

  hasPolygonUnion(): boolean {
    return typeof this.addon.polygonUnion === 'function';
  }

  hasPolygonDifference(): boolean {
    return typeof this.addon.polygonDifference === 'function';
  }

  hasFuseCoplanarParts(): boolean {
    return typeof this.addon.fuseCoplanarParts === 'function';
  }

  hasPrepareCircleCut(): boolean {
    return typeof this.addon.prepareCircleCut === 'function';
  }

  hasPreparePolygonCut(): boolean {
    return typeof this.addon.preparePolygonCut === 'function';
  }

  hasEvaluateFindings(): boolean {
    return typeof this.addon.evaluateFindings === 'function';
  }

  hasComputeCloseGapDelta(): boolean {
    return typeof this.addon.computeCloseGapDelta === 'function';
  }

  hasComputeFlangeOutline(): boolean {
    return typeof this.addon.computeFlangeOutline === 'function';
  }

  hasComputeRipEdge(): boolean {
    return typeof this.addon.computeRipEdge === 'function';
  }

  hasComputeReliefPolygons(): boolean {
    return typeof this.addon.computeReliefPolygons === 'function';
  }

  hasComputeSplitByPlane(): boolean {
    return typeof this.addon.computeSplitByPlane === 'function';
  }

  loadStep(filePath: string): string {
    try {
      return this.addon.loadStep(filePath);
    } catch (err) {
      const structured = toStructuredError(err);
      throw structured;
    }
  }

  getTopology(solidId: string): TopologyGraph {
    try {
      return this.addon.getTopology(solidId);
    } catch (err) {
      const structured = toStructuredError(err);
      throw structured;
    }
  }

  checkManifold(solidId: string): ManifoldResult {
    try {
      return this.addon.checkManifold(solidId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  healGeometry(solidId: string): string {
    try {
      return this.addon.healGeometry(solidId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  separateSolids(solidId: string): string[] {
    try {
      return this.addon.separateSolids(solidId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  booleanCut(
    solidId: string,
    normal: { x: number; y: number; z: number },
    origin: { x: number; y: number; z: number },
  ): BooleanCutResult {
    try {
      return this.addon.booleanCut(solidId, normal, origin);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  addTabSlot(shellIdA: string, shellIdB: string, kerfOffsetMm: number): TabSlotResult {
    if (kerfOffsetMm < kerfOffsetMmBounds.min || kerfOffsetMm > kerfOffsetMmBounds.max) {
      throwError(
        ErrorCodes.GE_TAB_SLOT_FAILED,
        `kerfOffsetMm must be in [${kerfOffsetMmBounds.min}, ${kerfOffsetMmBounds.max}]; got ${kerfOffsetMm}`,
        false,
      );
    }
    try {
      return this.addon.addTabSlot(shellIdA, shellIdB, kerfOffsetMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  addRivetHole(
    shellId: string,
    faceId: string,
    centerX: number,
    centerY: number,
    diameterMm: number,
  ): RivetHoleResult {
    try {
      return this.addon.addRivetHole(shellId, faceId, centerX, centerY, diameterMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  unfoldShell(shellId: string, kFactor: number): UnfoldResult {
    try {
      return this.addon.unfoldShell(shellId, kFactor);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  exportDxf(unfoldId: string): DxfExportResult {
    try {
      return this.addon.exportDxf(unfoldId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  buildSheetFromDxf(dxfContent: string): DxfSheetResult {
    if (!this.addon.buildSheetFromDxf) {
      throw new Error('Geometry addon does not expose buildSheetFromDxf');
    }
    try {
      return this.addon.buildSheetFromDxf(dxfContent);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  thickenSheet(sheetId: string, thicknessMm: number): ThickenSheetResult {
    if (!this.addon.thickenSheet) {
      throw new Error('Geometry addon does not expose thickenSheet');
    }
    try {
      return this.addon.thickenSheet(sheetId, thicknessMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  applyBend(
    panelAId: string,
    panelBId: string,
    innerRadiusMm: number,
    angleDeg: number,
    kFactor: number,
  ): ApplyBendResult {
    if (!this.addon.applyBend) {
      throw new Error('Geometry addon does not expose applyBend');
    }
    try {
      return this.addon.applyBend(panelAId, panelBId, innerRadiusMm, angleDeg, kFactor);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  buildShellFromFlatPattern(
    dxfContent: string,
    bendZones: NapiBendZoneSpec[],
    thicknessMm: number,
    explicitPlacement?: FlatPanelPlacement,
  ): BuildShellFromFlatPatternResult {
    if (!this.addon.buildShellFromFlatPattern) {
      throw new Error('Geometry addon does not expose buildShellFromFlatPattern');
    }
    try {
      return this.addon.buildShellFromFlatPattern(
        dxfContent,
        bendZones,
        thicknessMm,
        explicitPlacement,
      );
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  getPanelFrame(shellId: string): PanelFrameResult {
    if (!this.addon.getPanelFrame) {
      throw new Error('Geometry addon does not expose getPanelFrame');
    }
    try {
      return this.addon.getPanelFrame(shellId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  exportGlb(shellId: string): Buffer {
    try {
      return this.addon.exportGlb(shellId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  nestShells(unfoldIds: string[], sheetWidthMm: number, sheetHeightMm: number): NestResult {
    try {
      return this.addon.nestShells(unfoldIds, sheetWidthMm, sheetHeightMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  createSnapshot(label: string): string {
    try {
      return this.addon.createSnapshot(label);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  restoreSnapshot(snapshotId: string): RestoreResult {
    try {
      return this.addon.restoreSnapshot(snapshotId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  clearSnapshot(snapshotId: string): void {
    this.addon.clearSnapshot(snapshotId);
  }

  clearSnapshots(): void {
    this.addon.clearSnapshots();
  }

  clearState(): void {
    this.addon.clearState();
  }

  computeBoundingBox(entityId: string): BoundingBoxResult {
    try {
      return this.addon.computeBoundingBox(entityId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeMassProperties(entityId: string, properties?: string[]): MassPropertiesResult {
    try {
      return this.addon.computeMassProperties(entityId, properties);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  measureDistance(entityA: string, entityB: string, measurementType: string): MeasureResult {
    try {
      return this.addon.measureDistance(entityA, entityB, measurementType);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  exploreTopology(entityId: string, returnType: string): ExploreResult {
    try {
      return this.addon.exploreTopology(entityId, returnType);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  fuseBodies(tools: string[], fuzzyTolerance: number): FuseResult {
    try {
      return this.addon.fuseBodies(tools, fuzzyTolerance);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  cutBodies(blank: string, tools: string[], keepTools: boolean): CutResult {
    try {
      return this.addon.cutBodies(blank, tools, keepTools);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  intersectBodies(a: string, b: string): IntersectResult {
    try {
      return this.addon.intersectBodies(a, b);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  translateBody(
    solidId: string,
    dx: number,
    dy: number,
    dz: number,
    keepOriginal: boolean,
  ): TransformResult {
    try {
      return this.addon.translateBody(solidId, dx, dy, dz, keepOriginal);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  rotateBody(
    solidId: string,
    axisPointX: number,
    axisPointY: number,
    axisPointZ: number,
    axisDirX: number,
    axisDirY: number,
    axisDirZ: number,
    angleDeg: number,
    keepOriginal: boolean,
  ): TransformResult {
    try {
      return this.addon.rotateBody(
        solidId,
        axisPointX,
        axisPointY,
        axisPointZ,
        axisDirX,
        axisDirY,
        axisDirZ,
        angleDeg,
        keepOriginal,
      );
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  mirrorBody(
    solidId: string,
    planeOriginX: number,
    planeOriginY: number,
    planeOriginZ: number,
    planeNormalX: number,
    planeNormalY: number,
    planeNormalZ: number,
    keepOriginal: boolean,
  ): TransformResult {
    try {
      return this.addon.mirrorBody(
        solidId,
        planeOriginX,
        planeOriginY,
        planeOriginZ,
        planeNormalX,
        planeNormalY,
        planeNormalZ,
        keepOriginal,
      );
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  scaleBody(
    solidId: string,
    originX: number,
    originY: number,
    originZ: number,
    scaleFactor: number,
    keepOriginal: boolean,
  ): TransformResult {
    try {
      return this.addon.scaleBody(solidId, originX, originY, originZ, scaleFactor, keepOriginal);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  alignToFace(
    srcFaceId: string,
    dstFaceId: string,
    flipNormal: boolean,
    keepOriginal: boolean,
  ): TransformResult {
    try {
      return this.addon.alignToFace(srcFaceId, dstFaceId, flipNormal, keepOriginal);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  filletEdges(partId: string, edgeIds: string[], radiusMm: number): FilletResult {
    try {
      return this.addon.filletEdges(partId, edgeIds, radiusMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  chamferEdges(partId: string, edgeIds: string[], distanceMm: number): ChamferResult {
    try {
      return this.addon.chamferEdges(partId, edgeIds, distanceMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  simplifyBody(partId: string, unifyFaces: boolean, unifyEdges: boolean): SimplifyResult {
    try {
      return this.addon.simplifyBody(partId, unifyFaces, unifyEdges);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  healGeometryEx(partId: string, fixTolerances: boolean, fixWires: boolean): HealExResult {
    try {
      return this.addon.healGeometryEx(partId, fixTolerances, fixWires);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  offsetShape(partId: string, offsetValue: number, tolerance: number): OffsetShapeResult {
    try {
      return this.addon.offsetShape(partId, offsetValue, tolerance);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  deleteFace(partId: string, faceIds: string[], healRemaining: boolean): DeleteFaceResult {
    try {
      return this.addon.deleteFace(partId, faceIds, healRemaining);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeIntersections(partIds: string[]): ClashReport {
    try {
      return this.addon.computeIntersections(partIds);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  checkAssemblyClashes(partIds: string[], adjacentPairs: [string, string][]): ClashPair[] {
    try {
      return this.addon.checkAssemblyClashes(partIds, adjacentPairs);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeGaps(partAId: string, partBId: string, maxDistanceThresholdMm: number): GapReport {
    try {
      return this.addon.computeGaps(partAId, partBId, maxDistanceThresholdMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  trimBodyWithPlane(
    partId: string,
    plane: CuttingPlane,
    keepPositiveSide: boolean,
  ): TrimBodyResult {
    try {
      return this.addon.trimBodyWithPlane(partId, plane, keepPositiveSide);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  splitBodyByPlane(partId: string, plane: CuttingPlane): SplitBodyResult {
    try {
      return this.addon.splitBodyByPlane(partId, plane);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  mergeBodiesWithBend(
    partAId: string,
    partBId: string,
    targetEdges: string[],
    bendRadiusMm: number,
  ): MergeBodyResult {
    try {
      return this.addon.mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadiusMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  closeGap(partAId: string, partBId: string): CloseGapResult {
    try {
      return this.addon.closeGap(partAId, partBId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  isPanelValid(partId: string): PanelValidationResult {
    try {
      const raw = this.addon.validateSheetMetal(partId);
      const errors = (raw.validation_errors ?? []).map((msg: string) => {
        const colonIdx = msg.indexOf(':');
        const code = colonIdx > 0 ? msg.substring(0, colonIdx).trim() : 'GE_PANEL_INVALID';
        const message = colonIdx > 0 ? msg.substring(colonIdx + 1).trim() : msg;
        return { code, message };
      });
      return {
        isValid: raw.is_valid,
        canFlatten: raw.can_flatten,
        nominalThicknessMm: raw.nominal_thickness ?? 0,
        errors,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  extendFaceToTarget(
    partId: string,
    faceId: string,
    targetType: string,
    targetPartId: string,
    targetFaceId: string,
    targetPlane: CuttingPlane,
  ): ExtendFaceResult {
    try {
      return this.addon.extendFaceToTarget(
        partId,
        faceId,
        targetType,
        targetPartId,
        targetFaceId,
        targetPlane,
      );
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  offsetFace(partId: string, faceId: string, distanceMm: number): OffsetFaceResult {
    try {
      return this.addon.offsetFace(partId, faceId, distanceMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  addFlange(
    partId: string,
    edgeId: string,
    lengthMm: number,
    angleDeg: number,
    bendRadiusMm: number,
  ): AddFlangeResult {
    try {
      return this.addon.addFlange(partId, edgeId, lengthMm, angleDeg, bendRadiusMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  ripEdge(partId: string, edgeId: string): RipEdgeResult {
    try {
      return this.addon.ripEdge(partId, edgeId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  centerAndAlignBody(
    partId: string,
    transactionId: string,
  ): AlignmentResult & { rollbackToken: string } {
    try {
      const res = this.addon.centerAndAlignBody(partId, transactionId);
      return {
        solid_id: res.solid_id,
        centroid: res.centroid,
        rotation_matrix: res.rotation_matrix,
        rollback_token: res.rollbackToken,
        rollbackToken: res.rollbackToken,
        shape_history: res.shape_history,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  splitBodyByBends(
    partId: string,
    angleThresholdDeg: number,
    maxThicknessMm?: number,
    defaultThicknessMm?: number,
    maxRecursionDepth?: number,
  ): SplitBodyByBendsResult & { rollbackToken: string } {
    try {
      const res = this.addon.splitBodyByBends(
        partId,
        angleThresholdDeg,
        maxThicknessMm,
        defaultThicknessMm,
        maxRecursionDepth,
      );
      return {
        panel_ids: res.panel_ids,
        panel_count: res.panel_ids.length,
        panel_thickness_mm: res.panel_thickness_mm,
        panel_bboxes: res.panel_bboxes,
        protrusion_ids: res.protrusion_ids,
        protrusion_count: res.protrusion_ids.length,
        protrusion_bboxes: res.protrusion_bboxes,
        protrusion_parents: res.protrusion_parents,
        detected_mode: res.detected_mode,
        rollback_token: res.rollbackToken,
        rollbackToken: res.rollbackToken,
        shape_history: res.shape_history,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  removeProtrusions(
    partId: string,
    angleThresholdDeg?: number,
    maxThicknessMm?: number,
    algorithm?: 'loop_traversal' | 'legacy_volumetric',
  ): RemoveProtrusionsResult & { rollbackToken: string } {
    try {
      const res = this.addon.removeProtrusions(
        partId,
        angleThresholdDeg,
        maxThicknessMm,
        algorithm,
      );
      return {
        cleaned_part_id: res.cleaned_part_id,
        protrusion_ids: res.protrusion_ids,
        protrusion_bboxes: res.protrusion_bboxes,
        protrusion_count: res.protrusion_count,
        rollback_token: res.rollbackToken,
        rollbackToken: res.rollbackToken,
        shape_history: res.shape_history,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  sewFaces(entityIds: string[], tolerance: number, makeSolid: boolean): SewResult {
    try {
      const res = this.addon.sewFaces(entityIds, tolerance, makeSolid);
      return {
        solid_id: (res as any).shell_id,
        sew_complete: res.sew_complete,
        free_edges: res.free_edges,
        rollback_token: res.rollback_token,
        shape_history: res.shape_history,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  createAssemblyDocument(): CreateAssemblyResult {
    try {
      return this.addon.createAssemblyDocument();
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  addAssemblyInstance(
    assemblyId: string,
    shapeId: string,
    tx: number,
    ty: number,
    tz: number,
    qw: number,
    qx: number,
    qy: number,
    qz: number,
  ): AddInstanceResult {
    try {
      return this.addon.addAssemblyInstance(assemblyId, shapeId, tx, ty, tz, qw, qx, qy, qz);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  mateRigid(
    assemblyId: string,
    srcEntityId: string,
    dstEntityId: string,
    flipAlignment: boolean,
  ): MateRigidResult {
    try {
      return this.addon.mateRigid(assemblyId, srcEntityId, dstEntityId, flipAlignment);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  listAssemblyTree(assemblyId: string): ListAssemblyResult {
    try {
      return this.addon.listAssemblyTree(assemblyId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  validateSheetMetal(partId: string): SheetMetalValidationResult {
    try {
      return this.addon.validateSheetMetal(partId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  measurePanelThickness(shellId: string): PanelThicknessResult {
    try {
      return this.addon.measurePanelThickness(shellId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  reconstructCurvedBends(partId: string): CurvedRebuildResult {
    try {
      const res = this.addon.reconstructCurvedBends(partId);
      return {
        solid_id: (res as any).solidId,
        bends_replaced: (res as any).bendsReplaced,
        rollback_token: (res as any).rollbackToken,
        shape_history: (res as any).shape_history,
      };
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  evaluatePartGraph(graph: NapiPartGraphSpec): EvaluatePartGraphResult {
    if (!this.addon.evaluatePartGraph) {
      throw new Error('Geometry addon does not expose evaluatePartGraph');
    }
    try {
      return this.addon.evaluatePartGraph(graph);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  constructPartSolid(
    layout: EvaluatePartGraphResult,
    thicknessMm: number,
  ): ConstructPartSolidResult {
    if (!this.addon.constructPartSolid) {
      throw new Error('Geometry addon does not expose constructPartSolid');
    }
    try {
      return this.addon.constructPartSolid(layout, thicknessMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  mapPointToWorld(
    graph: NapiPartGraphSpec,
    layout: EvaluatePartGraphResult,
    point2d: NapiPoint2,
    zMm?: number,
  ): MapToWorldResult {
    if (!this.addon.mapPointToWorld) {
      throw new Error('Geometry addon does not expose mapPointToWorld');
    }
    try {
      return this.addon.mapPointToWorld(graph, layout, point2d, zMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  mapPointToFlat(
    graph: NapiPartGraphSpec,
    layout: EvaluatePartGraphResult,
    point3d: NapiPoint3,
  ): MapToFlatResult {
    if (!this.addon.mapPointToFlat) {
      throw new Error('Geometry addon does not expose mapPointToFlat');
    }
    try {
      return this.addon.mapPointToFlat(graph, layout, point3d);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  reconcileOutlines(
    outlineA: NapiPoint2[],
    edgeA0: NapiPoint2,
    edgeA1: NapiPoint2,
    outlineB: NapiPoint2[],
    edgeB0: NapiPoint2,
    edgeB1: NapiPoint2,
  ): ReconcileOutlinesResult {
    if (!this.addon.reconcileOutlines) {
      throw new Error('Geometry addon does not expose reconcileOutlines');
    }
    try {
      return this.addon.reconcileOutlines(outlineA, edgeA0, edgeA1, outlineB, edgeB0, edgeB1);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  reconcilePieces(
    pieces: NapiPanelPieceSpec[],
    thicknessMm: number,
    profile?: NapiManufacturingProfile,
  ): ReconcilePiecesResult {
    if (!this.addon.reconcilePieces) {
      throw new Error('Geometry addon does not expose reconcilePieces');
    }
    try {
      return this.addon.reconcilePieces(pieces, thicknessMm, profile);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  polygonUnion(ringA: NapiPoint2[], ringB: NapiPoint2[]): PolygonBooleanResult {
    if (!this.addon.polygonUnion) {
      throw new Error('Geometry addon does not expose polygonUnion');
    }
    try {
      return this.addon.polygonUnion(ringA, ringB);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  buildFlatOutline(graph: NapiPartGraphSpec, layout: EvaluatePartGraphResult): PolygonBooleanResult {
    if (!this.addon.buildFlatOutline) {
      throw new Error('Geometry addon does not expose buildFlatOutline');
    }
    try {
      return this.addon.buildFlatOutline(graph, layout);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  polygonDifference(ringA: NapiPoint2[], ringB: NapiPoint2[]): PolygonBooleanResult {
    if (!this.addon.polygonDifference) {
      throw new Error('Geometry addon does not expose polygonDifference');
    }
    try {
      return this.addon.polygonDifference(ringA, ringB);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  fuseCoplanarParts(
    outlineA: NapiPoint2[],
    anchorA: NapiTransform3,
    outlineB: NapiPoint2[],
    anchorB: NapiTransform3,
    thicknessMm: number,
  ): PolygonBooleanResult {
    if (!this.addon.fuseCoplanarParts) {
      throw new Error('Geometry addon does not expose fuseCoplanarParts');
    }
    try {
      return this.addon.fuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, thicknessMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  prepareCircleCut(
    center: NapiPoint2,
    radiusMm: number,
    candidateRegions: NapiPoint2[][],
  ): CutPanelResult {
    if (!this.addon.prepareCircleCut) {
      throw new Error('Geometry addon does not expose prepareCircleCut');
    }
    try {
      return this.addon.prepareCircleCut(center, radiusMm, candidateRegions);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  preparePolygonCut(ring: NapiPoint2[], candidateRegions: NapiPoint2[][]): CutPanelResult {
    if (!this.addon.preparePolygonCut) {
      throw new Error('Geometry addon does not expose preparePolygonCut');
    }
    try {
      return this.addon.preparePolygonCut(ring, candidateRegions);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  evaluateFindings(
    graph: NapiPartGraphSpec,
    profile: NapiManufacturingProfile,
    layout: EvaluatePartGraphResult | null,
  ): EvaluateFindingsResult {
    if (!this.addon.evaluateFindings) {
      throw new Error('Geometry addon does not expose evaluateFindings');
    }
    try {
      return this.addon.evaluateFindings(graph, profile, layout);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeCloseGapDelta(
    edgeA3d: NapiPoint3[],
    edgeB3d: NapiPoint3[],
    panelBPose: NapiTransform3,
  ): CloseGapDeltaResult {
    if (!this.addon.computeCloseGapDelta) {
      throw new Error('Geometry addon does not expose computeCloseGapDelta');
    }
    try {
      return this.addon.computeCloseGapDelta(edgeA3d, edgeB3d, panelBPose);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeFlangeOutline(
    outline: NapiPoint2[],
    edgeIndex: number,
    flangeLengthMm: number,
  ): FlangeOutlineResult {
    if (!this.addon.computeFlangeOutline) {
      throw new Error('Geometry addon does not expose computeFlangeOutline');
    }
    try {
      return this.addon.computeFlangeOutline(outline, edgeIndex, flangeLengthMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeRipEdge(
    outline: NapiPoint2[],
    edgeIndex: number,
    gapMm: number,
  ): NapiRipEdgeResult {
    if (!this.addon.computeRipEdge) {
      throw new Error('Geometry addon does not expose computeRipEdge');
    }
    try {
      return this.addon.computeRipEdge(outline, edgeIndex, gapMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeReliefPolygons(
    bends: NapiBendSpec[],
    reliefType: string,
    radiusMm: number,
    thicknessMm: number,
  ): NapiPoint2[][] {
    if (!this.addon.computeReliefPolygons) {
      throw new Error('Geometry addon does not expose computeReliefPolygons');
    }
    try {
      return this.addon.computeReliefPolygons(bends, reliefType, radiusMm, thicknessMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  computeSplitByPlane(
    layout: EvaluatePartGraphResult,
    nx: number,
    ny: number,
    nz: number,
    d: number,
  ): NapiPanelFragment[] {
    if (!this.addon.computeSplitByPlane) {
      throw new Error('Geometry addon does not expose computeSplitByPlane');
    }
    try {
      return this.addon.computeSplitByPlane(layout, nx, ny, nz, d);
    } catch (err) {
      throw toStructuredError(err);
    }
  }
}

// Singleton binding instance
export const geometryBinding = new GeometryBinding();

const kerfOffsetMmBounds = kerfOffsetMm;
