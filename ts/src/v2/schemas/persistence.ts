/**
 * Persisted-data schemas (spec 010, R-013 layer 2, as revised by R-016).
 *
 * The Dolt tables enforce types/keys/ranges (layer 1); these Zod schemas
 * validate the *assembled* PartGraphSnapshot — what SQL can't express, e.g.
 * "a part has an outline of >= 3 vertices" — on every write (before the SQL
 * transaction) and every read (before anything reaches the GraphStore).
 * Graph-structural rules (bend tree, holes inside outline, ...) are layer 3,
 * graph/invariants.ts.
 *
 * All object schemas are .strict(): an unknown key is a defect, not noise.
 * These are also the source for the cross-repo contract fixtures (T026).
 */

import { z } from 'zod';
import { Point2Schema, Transform3RowSchema } from './shared';

const Id = z.string().min(1).max(64);
const Finite = z.number().finite();
// K-factor range is [0, 1]: 0 is a real value the evaluator uses (reff = r + k*t;
// create_part defaults to it), matching the existing tool schemas.
const UnitInterval = z.number().gte(0).lte(1);

export const PolygonHoleSchema = z
  .object({ kind: z.literal('polygon'), holeId: Id, ring: z.array(Point2Schema).min(3) })
  .strict();
export const CircleHoleSchema = z
  .object({ kind: z.literal('circle'), holeId: Id, center: Point2Schema, radiusMm: z.number().gt(0) })
  .strict();
export const PersistedHoleSchema = z.discriminatedUnion('kind', [PolygonHoleSchema, CircleHoleSchema]);

export const PartRowSchema = z
  .object({
    partId: Id,
    name: z.string().min(1).max(255),
    rootRegionPanelId: Id,
    outline: z.array(Point2Schema).min(3),
    holes: z.array(PersistedHoleSchema),
    anchor: Transform3RowSchema,
    materialId: z.string().min(1).max(64),
    thicknessMm: z.number().gt(0),
    kFactor: UnitInterval,
    schemaVersion: z.string().min(1).max(16),
    mergedIntoPartId: Id.nullable(),
  })
  .strict();

export const RegionPanelRowSchema = z
  .object({
    regionPanelId: Id,
    partId: Id,
    label: z.string().max(255),
    kFactorOverride: UnitInterval.nullable(),
    mergedIntoRegionPanelId: Id.nullable(),
  })
  .strict();

export const BendRowSchema = z
  .object({
    bendId: Id,
    partId: Id,
    parentRegionPanelId: Id,
    childRegionPanelId: Id,
    hingeA: Point2Schema,
    hingeB: Point2Schema,
    angleDeg: Finite,
    radiusMm: z.number().gte(0),
    kFactorOverride: UnitInterval.nullable(),
    bottomIsConcave: z.boolean().nullable(),
    radiusMeasured: z.boolean(),
    bendProcess: z.string().max(64).nullable(),
  })
  .strict();

export const PartGraphSnapshotSchema = z
  .object({
    part: PartRowSchema,
    // No min(1): a merged-away (tombstone) part keeps its part row but its panels
    // now belong to the absorbing part. Live parts are checked by invariants.
    regionPanels: z.array(RegionPanelRowSchema),
    bends: z.array(BendRowSchema),
  })
  .strict();

// ─── Project settings (client-authored, server-validated because it uses them) ─

export const SheetSizeSchema = z
  .object({ widthMm: z.number().gt(0), heightMm: z.number().gt(0), label: z.string().max(64).optional() })
  .strict();

export const NestingSettingsSchema = z
  .object({
    sheets: z.array(SheetSizeSchema).min(1),
    safetyGapMm: z.number().gte(0),
    sheetMarginMm: z.number().gte(0),
    cuttingWidthMm: z.number().gt(0),
    rotationsDeg: z
      .array(z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]))
      .min(1)
      .refine((r) => new Set(r).size === r.length, 'rotationsDeg must not repeat'),
  })
  .strict();

/** ManufacturingDefaults.toJson() (Form·AI·tion lib/core/models/manufacturing_defaults.dart). */
export const ManufacturingDefaultsSchema = z
  .object({
    defaultMaterial: z.enum(['mildSteel', 'stainlessSteel', 'aluminum']).optional(),
    defaultThicknessMm: z.number().gt(0).optional(),
    unitSystem: z.enum(['metric', 'imperial']),
    preferredBendProcesses: z.array(z.enum(['airBend', 'bottoming', 'coining', 'hemming', 'rollBend', 'grooving'])),
  })
  .strict();

/** ManufacturingProfile.toJson() (Form·AI·tion lib/core/models/manufacturing_profile.dart). */
export const ManufacturingProfileSchema = z
  .object({
    minBendRadiusFactor: z.number().gte(0),
    maxBendAngleDeg: z.number().gt(0).lte(180),
    defaultBendRadiusMm: z.number().gte(0),
    minHoleDiameterFactor: z.number().gte(0),
    minHoleToBendClearanceMm: z.number().gte(0),
    minHoleToEdgeClearanceMm: z.number().gte(0),
    minHoleToHoleDistanceMm: z.number().gte(0),
    minFlangeWidthFactor: z.number().gte(0),
  })
  .strict();

export const ProjectSettingsSchema = z
  .object({
    manufacturing_profile: ManufacturingProfileSchema.nullable(),
    manufacturing_defaults: ManufacturingDefaultsSchema.nullable(),
    nesting: NestingSettingsSchema.nullable(),
  })
  .strict();

export const ProjectSettingsPatchSchema = ProjectSettingsSchema.partial();

// ─── Import configuration (research R-008, data-model §3) ─────────────────────

const PRESET_FACTORS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 } as const;

export const ImportConfigSchema = z
  .object({
    scale: z
      .object({ preset: z.enum(['mm', 'cm', 'm', 'in', 'ft', 'custom']), factor: z.number().gt(0) })
      .strict()
      .refine((s) => s.preset === 'custom' || Math.abs(s.factor - PRESET_FACTORS[s.preset]) < 1e-9, {
        message: 'scale.factor must equal the preset factor unless preset is custom',
      }),
    rotation: z
      .object({
        xQuarterTurns: z.number().int().min(0).max(3),
        yQuarterTurns: z.number().int().min(0).max(3),
        zQuarterTurns: z.number().int().min(0).max(3),
      })
      .strict(),
    recenter: z.object({ xy: z.boolean(), z: z.enum(['floor', 'com', 'none']) }).strict(),
    thicknessMm: z.number().gt(0).optional(),
    materialId: z.string().min(1).max(64).optional(),
  })
  .strict();

/** Import config as stored in import_source: thickness + material are required there. */
export const StoredImportConfigSchema = ImportConfigSchema.and(
  z.object({ thicknessMm: z.number().gt(0), materialId: z.string().min(1) }),
);

// ─── History / action log (contract §Versioning) ──────────────────────────────

export const ActionLogEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.string().min(1),
    actor_kind: z.enum(['human', 'agent', 'system']),
    actor_id: z.string(),
    tool: z.string().min(1),
    delta_summary: z.record(z.unknown()),
    undone: z.boolean(),
  })
  .strict();

export const HistoryCommitSchema = z
  .object({
    hash: z.string().min(1),
    parents: z.array(z.string()),
    date: z.string().min(1),
    author_name: z.string(),
    author_email: z.string(),
    message: z.string(),
    op_count: z.number().int().min(0),
    agent_op_count: z.number().int().min(0),
  })
  .strict();

// ─── Registry ─────────────────────────────────────────────────────────────────

export const PersistedSchemas = {
  part_graph_snapshot: PartGraphSnapshotSchema,
  project_settings: ProjectSettingsSchema,
  nesting_settings: NestingSettingsSchema,
  import_config: StoredImportConfigSchema,
  action_log_entry: ActionLogEntrySchema,
  history_commit: HistoryCommitSchema,
} as const;

export type PersistedKind = keyof typeof PersistedSchemas;

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; issues: string[] };

export function validatePersisted<K extends PersistedKind>(
  kind: K,
  data: unknown,
): ValidationResult<z.infer<(typeof PersistedSchemas)[K]>> {
  const r = PersistedSchemas[kind].safeParse(data);
  if (r.success) return { ok: true, data: r.data as z.infer<(typeof PersistedSchemas)[K]> };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}
