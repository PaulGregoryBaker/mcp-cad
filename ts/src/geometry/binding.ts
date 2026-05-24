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
  TopologyGraph,
  ManifoldResult,
  BooleanCutResult,
  TabSlotResult,
  RivetHoleResult,
  UnfoldResult,
  DxfExportResult,
  NestResult,
  RestoreResult,
  ClashReport,
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
  exportGlb(shellId: string): Buffer;
  nestShells(
    unfoldIds: string[],
    sheetWidthMm: number,
    sheetHeightMm: number,
  ): NestResult;
  createSnapshot(label: string): string;
  restoreSnapshot(snapshotId: string): RestoreResult;
  clearSnapshot(snapshotId: string): void;
  clearSnapshots(): void;
  computeBoundingBox(entityId: string): BoundingBoxResult;
  computeMassProperties(entityId: string, properties?: string[]): MassPropertiesResult;
  measureDistance(entityA: string, entityB: string, measurementType: string): MeasureResult;
  exploreTopology(entityId: string, returnType: string): ExploreResult;
  fuseBodies(tools: string[], fuzzyTolerance: number): FuseResult;
  cutBodies(blank: string, tools: string[], keepTools: boolean): CutResult;
  intersectBodies(a: string, b: string): IntersectResult;
  computeIntersections(partIds: string[]): ClashReport;
  computeGaps(partAId: string, partBId: string, maxDistanceThresholdMm: number): GapReport;
  trimBodyWithPlane(partId: string, plane: CuttingPlane, keepPositiveSide: boolean): TrimBodyResult;
  splitBodyByPlane(partId: string, plane: CuttingPlane): SplitBodyResult;
  mergeBodiesWithBend(partAId: string, partBId: string, targetEdges: string[], bendRadiusMm: number): MergeBodyResult;
  extendFaceToTarget(
    partId: string,
    faceId: string,
    targetType: string,
    targetPartId: string,
    targetFaceId: string,
    targetPlane: CuttingPlane,
  ): ExtendFaceResult;
  offsetFace(partId: string, faceId: string, distanceMm: number): OffsetFaceResult;
  addFlange(partId: string, edgeId: string, lengthMm: number, angleDeg: number, bendRadiusMm: number): AddFlangeResult;
  ripEdge(partId: string, edgeId: string): RipEdgeResult;
  splitBodyByBends(
    partId: string,
    angleThresholdDeg: number,
    maxThicknessMm?: number,
    defaultThicknessMm?: number,
    maxRecursionDepth?: number,
  ): {
    panel_ids: string[];
    panel_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
    protrusion_ids: string[];
    protrusion_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
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
  ): {
    cleaned_part_id: string;
    protrusion_ids: string[];
    protrusion_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
    protrusion_count: number;
    rollbackToken: string;
  };
}

export const kerfOffsetMm = {
  min: 0.1,
  max: 0.2,
} as const;

// ─── Addon loading ────────────────────────────────────────────────────────────

function resolveAddonPath(): string {
  const envPath = process.env['GEOMETRY_ADDON_PATH'];
  if (envPath !== undefined && envPath.length > 0) {
    return envPath;
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

  exportGlb(shellId: string): Buffer {
    try {
      return this.addon.exportGlb(shellId);
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  nestShells(
    unfoldIds: string[],
    sheetWidthMm: number,
    sheetHeightMm: number,
  ): NestResult {
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

  computeIntersections(partIds: string[]): ClashReport {
    try {
      return this.addon.computeIntersections(partIds);
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
        partId, faceId, targetType, targetPartId, targetFaceId, targetPlane,
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

  splitBodyByBends(
    partId: string,
    angleThresholdDeg: number,
    maxThicknessMm?: number,
    defaultThicknessMm?: number,
    maxRecursionDepth?: number,
  ): ReturnType<GeometryAddon['splitBodyByBends']> {
    try {
      return this.addon.splitBodyByBends(
        partId, angleThresholdDeg, maxThicknessMm, defaultThicknessMm, maxRecursionDepth,
      );
    } catch (err) {
      throw toStructuredError(err);
    }
  }

  removeProtrusions(
    partId: string,
    angleThresholdDeg?: number,
    maxThicknessMm?: number,
  ): ReturnType<GeometryAddon['removeProtrusions']> {
    try {
      return this.addon.removeProtrusions(partId, angleThresholdDeg, maxThicknessMm);
    } catch (err) {
      throw toStructuredError(err);
    }
  }
}

// Singleton binding instance
export const geometryBinding = new GeometryBinding();

const kerfOffsetMmBounds = kerfOffsetMm;
