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
  clearSnapshots(): void;
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

  clearSnapshots(): void {
    this.addon.clearSnapshots();
  }
}

// Singleton binding instance
export const geometryBinding = new GeometryBinding();

const kerfOffsetMmBounds = kerfOffsetMm;
