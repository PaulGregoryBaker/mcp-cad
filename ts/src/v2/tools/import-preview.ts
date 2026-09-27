/**
 * Configured STEP import (spec 010 US3, research R-008/R-009, T062).
 *
 * preview_import loads + heals a STEP file ONCE and caches it under a
 * preview_id for PREVIEW_TTL_MS. Sheet thickness is measured once per applied
 * SCALE (not per config): the kernel only treats a body as sheet metal
 * ("thin_solid") below its max-thickness limit, so whether a thickness is
 * measurable at all depends on scale — rotation/recenter never change it. Each call then applies an ImportConfig transform to a
 * copy of the cached solid and returns a GLB of it, plus its bounding box and
 * centre of mass. Nothing is written and the graph store is not touched.
 *
 * Units: OCCT's STEP reader already converts the file's declared length unit
 * to mm. `config.scale.factor` is "mm per file unit as the user reads the
 * file", so the scale actually applied is factor / (mm per DECLARED unit):
 * choosing the detected preset is a no-op, choosing `in` for a file that
 * claims mm multiplies by 25.4. An undeclared unit is treated as mm (what
 * OCCT assumes).
 *
 * Transform order (data-model §3): scale about the origin → rotate in
 * quarter-turns about X, then Y, then Z (through the origin) → recenter
 * (centre of mass over X/Y = 0; Z: floor / com / none). Every geometric step
 * runs in the kernel (constitution IV); this file only sequences calls.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { geometryBinding } from '../../geometry/binding';
import type { BoundingBoxResult } from '../../geometry/types';
import { ErrorCodes, McpToolError, throwError } from '../../mcp/errors';
import { buildV2BlobUrl, v2BlobCache } from '../blob-cache';
import { ImportConfigSchema } from '../schemas/persistence';

export type DetectedUnits = 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'unknown';

const MM_PER_UNIT: Record<Exclude<DetectedUnits, 'unknown'>, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export type ImportTransformConfig = Pick<z.infer<typeof ImportConfigSchema>, 'scale' | 'rotation' | 'recenter'>;

export const IDENTITY_CONFIG: ImportTransformConfig = {
  scale: { preset: 'mm', factor: 1 },
  rotation: { xQuarterTurns: 0, yQuarterTurns: 0, zQuarterTurns: 0 },
  recenter: { xy: false, z: 'none' },
};

/**
 * The file's declared length unit, read from the STEP text. A conversion-based
 * length unit (INCH/FOOT) always refers to an SI base unit that is present in
 * the file too, so it wins when present; otherwise the SI length unit's prefix
 * decides. Anything else → unknown.
 */
export function detectStepUnits(stepText: string): DetectedUnits {
  const lengthUnits = stepText
    .replace(/\r?\n/g, ' ')
    .split(';')
    .filter((e) => /LENGTH_UNIT\s*\(/i.test(e));
  for (const e of lengthUnits) {
    const conv = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/i.exec(e);
    if (!conv) continue;
    const name = conv[1]!.trim().toUpperCase();
    if (name === 'INCH' || name === 'INCHES' || name === 'IN') return 'in';
    if (name === 'FOOT' || name === 'FEET' || name === 'FT') return 'ft';
    return 'unknown';
  }
  for (const e of lengthUnits) {
    const si = /SI_UNIT\s*\(\s*([^,]*),\s*\.METRE\.\s*\)/i.exec(e);
    if (!si) continue;
    const prefix = si[1]!.trim().toUpperCase();
    if (prefix === '.MILLI.') return 'mm';
    if (prefix === '.CENTI.') return 'cm';
    if (prefix === '$') return 'm';
  }
  return 'unknown';
}

interface TransformedSolid {
  solidId: string;
  bbox: BoundingBoxResult;
  com: { x: number; y: number; z: number };
}

export interface PreviewEntry {
  previewId: string;
  filePath: string;
  sha256: string;
  baseSolidId: string;
  detectedUnits: DetectedUnits;
  /** Per applied scale: the scaled copy and its measured sheet thickness
   * (null when the kernel does not see a thin solid at that scale). */
  scaled: Map<number, { solidId: string; measuredMm: number | null }>;
  expiresAt: number;
  transformed: Map<string, TransformedSolid>;
}

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
let previewTtlMs = Number(process.env['MCPCAD_PREVIEW_TTL_MS'] ?? DEFAULT_PREVIEW_TTL_MS);
const previews = new Map<string, PreviewEntry>();

/** Tests only. */
export function setPreviewTtlForTests(ms: number | null): void {
  previewTtlMs = ms ?? DEFAULT_PREVIEW_TTL_MS;
}

function sweepExpired(now = Date.now()): void {
  for (const [id, e] of previews) if (e.expiresAt <= now) previews.delete(id);
}

export function fileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Load + heal + measure once; the result is cached under a new preview_id. */
export function createPreview(filePath: string): PreviewEntry {
  sweepExpired();
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throwError(ErrorCodes.IMPORT_FILE_NOT_FOUND, `STEP file not found: ${filePath}`, true);
  }
  let text: string;
  let sha256: string;
  try {
    const bytes = fs.readFileSync(filePath);
    sha256 = createHash('sha256').update(bytes).digest('hex');
    text = bytes.toString('latin1');
  } catch (e) {
    throwError(ErrorCodes.IMPORT_READ_FAILED, `could not read ${filePath}: ${(e as Error).message}`, true);
  }
  let baseSolidId: string;
  try {
    baseSolidId = geometryBinding.loadStep(filePath);
    geometryBinding.healGeometryEx(baseSolidId, true, true);
  } catch (e) {
    const msg = e instanceof McpToolError ? e.structured.message : String((e as Error)?.message ?? e);
    throwError(ErrorCodes.IMPORT_READ_FAILED, `could not load STEP geometry from ${filePath}: ${msg}`, true);
  }

  const entry: PreviewEntry = {
    previewId: randomUUID(),
    filePath,
    sha256,
    baseSolidId,
    detectedUnits: detectStepUnits(text),
    scaled: new Map(),
    expiresAt: Date.now() + previewTtlMs,
    transformed: new Map(),
  };
  previews.set(entry.previewId, entry);
  return entry;
}

export function getPreview(previewId: string): PreviewEntry {
  const e = previews.get(previewId);
  if (!e || e.expiresAt <= Date.now()) {
    previews.delete(previewId);
    throwError(ErrorCodes.PREVIEW_EXPIRED, `preview ${previewId} has expired; call preview_import again with the file`, true, 'preview_import');
  }
  e.expiresAt = Date.now() + previewTtlMs;
  return e;
}

/** Scale actually applied to the (already mm-converted) loaded solid. */
export function appliedScale(entry: Pick<PreviewEntry, 'detectedUnits'>, config: ImportTransformConfig): number {
  const declared = entry.detectedUnits === 'unknown' ? 1 : MM_PER_UNIT[entry.detectedUnits];
  return config.scale.factor / declared;
}

function configKey(config: ImportTransformConfig): string {
  return JSON.stringify([config.scale.factor, config.rotation, config.recenter]);
}

function centreOfMass(solidId: string): { x: number; y: number; z: number } {
  const c = geometryBinding.computeMassProperties(solidId, ['centroid']).centroid;
  if (!c) throwError(ErrorCodes.INTERNAL_ERROR, 'computeMassProperties returned no centroid', false);
  return { x: c[0], y: c[1], z: c[2] };
}

/** The base solid scaled for `config` (cached per scale), with its sheet
 * thickness measured by the kernel's own panel decomposition. A thickness is
 * reported only when the kernel classifies the body as a thin solid: outside
 * that it substitutes a default, which is not a measurement (§IX). */
function scaledSolid(entry: PreviewEntry, config: ImportTransformConfig): { solidId: string; measuredMm: number | null } {
  const s = appliedScale(entry, config);
  const hit = entry.scaled.get(s);
  if (hit) return hit;
  const solidId = Math.abs(s - 1) > 1e-12 ? geometryBinding.scaleBody(entry.baseSolidId, 0, 0, 0, s, true).solid_id : entry.baseSolidId;
  let measuredMm: number | null = null;
  try {
    const split = geometryBinding.splitBodyByBends(disposableCopy(solidId), 35);
    if (split.detected_mode === 'thin_solid' && split.panel_thickness_mm.length > 0) {
      measuredMm = Math.min(...split.panel_thickness_mm);
    }
  } catch {
    // Not decomposable as sheet metal at this scale: no thickness hint (the
    // dialog then defaults to the project thickness); import_part reports
    // the real failure, if any.
    measuredMm = null;
  }
  const out = { solidId, measuredMm };
  entry.scaled.set(s, out);
  return out;
}

/**
 * splitBodyByBends consumes the solid it decomposes (a second split of the
 * same id finds no panels), so every decomposition of a cached solid runs on
 * a throwaway copy — the preview cache must survive any number of measures
 * and imports.
 */
export function disposableCopy(solidId: string): string {
  return geometryBinding.translateBody(solidId, 0, 0, 0, true).solid_id;
}

export function measuredThicknessMm(entry: PreviewEntry, config: ImportTransformConfig): number | null {
  return scaledSolid(entry, config).measuredMm;
}

/** scale → rotate X, Y, Z → recenter, each on a copy (the cached base stays). */
export function applyImportTransform(entry: PreviewEntry, config: ImportTransformConfig): TransformedSolid {
  const key = configKey(config);
  const cached = entry.transformed.get(key);
  if (cached) return cached;

  let id = scaledSolid(entry, config).solidId;
  const copyOf = (next: string) => (id = next);
  const axes: Array<[number, [number, number, number]]> = [
    [config.rotation.xQuarterTurns, [1, 0, 0]],
    [config.rotation.yQuarterTurns, [0, 1, 0]],
    [config.rotation.zQuarterTurns, [0, 0, 1]],
  ];
  for (const [turns, [ax, ay, az]] of axes) {
    if (turns % 4 !== 0) copyOf(geometryBinding.rotateBody(id, 0, 0, 0, ax, ay, az, 90 * (turns % 4), true).solid_id);
  }

  const com0 = centreOfMass(id);
  const bbox0 = geometryBinding.computeBoundingBox(id);
  const dx = config.recenter.xy ? -com0.x : 0;
  const dy = config.recenter.xy ? -com0.y : 0;
  const dz = config.recenter.z === 'floor' ? -bbox0.z_min : config.recenter.z === 'com' ? -com0.z : 0;
  if (dx !== 0 || dy !== 0 || dz !== 0) copyOf(geometryBinding.translateBody(id, dx, dy, dz, true).solid_id);

  const result: TransformedSolid = { solidId: id, bbox: geometryBinding.computeBoundingBox(id), com: centreOfMass(id) };
  entry.transformed.set(key, result);
  return result;
}

export interface PreviewImportOutput {
  preview_id: string;
  glb_url: string;
  detected_units: DetectedUnits;
  bbox_mm: BoundingBoxResult;
  center_of_mass_mm: { x: number; y: number; z: number };
  measured_thickness_mm: number | null;
}

const PreviewArgs = z
  .object({
    file: z.string().min(1).optional(),
    preview_id: z.string().min(1).optional(),
    config: ImportConfigSchema.optional(),
  })
  .refine((a) => Boolean(a.file) !== Boolean(a.preview_id), { message: 'exactly one of file or preview_id is required' });

/** Resolve `{preview_id}` or `{file}` to a cache entry (shared with import_part). */
export function resolvePreviewSource(args: { file?: string; preview_id?: string }): PreviewEntry {
  if (args.preview_id) return getPreview(args.preview_id);
  return createPreview(args.file!);
}

export function handlePreviewImport(args: Record<string, unknown>): PreviewImportOutput {
  const parsed = PreviewArgs.safeParse(args);
  if (!parsed.success) {
    throwError(ErrorCodes.INTERNAL_ERROR, `preview_import: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, false);
  }
  const entry = resolvePreviewSource(parsed.data);
  const config: ImportTransformConfig = parsed.data.config ?? IDENTITY_CONFIG;
  const t = applyImportTransform(entry, config);

  const key = `preview/${entry.previewId}/${createHash('sha1').update(configKey(config)).digest('hex').slice(0, 16)}`;
  v2BlobCache.getOrRebuild(key, 'model/gltf-binary', key, () => geometryBinding.exportGlb(t.solidId));

  return {
    preview_id: entry.previewId,
    glb_url: buildV2BlobUrl(key),
    detected_units: entry.detectedUnits,
    bbox_mm: t.bbox,
    center_of_mass_mm: t.com,
    measured_thickness_mm: measuredThicknessMm(entry, config),
  };
}

export const importPreviewToolDefinitions = [
  {
    name: 'preview_import',
    description:
      'Preview a STEP import without creating anything (spec 010): loads and heals the file once (cached under preview_id for 10 minutes), applies an optional ImportConfig transform (scale → 90° rotations about X, Y, Z → recenter) to a copy, and returns a GLB URL, bounding box, centre of mass, the declared length units and the measured sheet thickness after scale. Call again with preview_id + a new config to update the preview cheaply. PREVIEW_EXPIRED → call again with file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a STEP file (first call).' },
        preview_id: { type: 'string', description: 'From a previous preview_import (later calls).' },
        config: {
          type: 'object',
          description:
            '{scale:{preset:mm|cm|m|in|ft|custom, factor}, rotation:{xQuarterTurns,yQuarterTurns,zQuarterTurns (0-3)}, recenter:{xy:bool, z:floor|com|none}}. factor = mm per file unit as the user reads the file.',
        },
      },
    },
  },
];
