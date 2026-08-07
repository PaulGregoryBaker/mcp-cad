/**
 * v2 MCP-boundary schema validation — resource response shapes
 * (rebuild's "sending evaluates against the schema" half, 2026-08-07).
 *
 * One schema per URI pattern, keyed the same way readGraphResource
 * (v2/resources/graph.ts) itself routes — see RESOURCE_SCHEMAS below. Wired
 * in there: every resource response is validated against its own schema
 * right before being returned, so a shape bug (like the recommendedFix.params
 * double-JSON-encoding this whole pass started from) fails loudly with
 * INTERNAL_ERROR instead of silently reaching the client malformed.
 *
 * IMPORTANT — bend-shaped and region-panel-shaped data are NOT one shared
 * schema. They appear as genuinely different projections in different
 * resources (confirmed by reading every resource function directly, not
 * assumed from naming):
 *   bends:         full (raw BendRow) | flat-pattern (trimmed, no partId/
 *                  parent/child/kFactorOverride/bottomIsConcave) | boundary
 *                  (adds 3D pivot data, drops kFactorOverride/bottomIsConcave/
 *                  radiusMeasured)
 *   region panels: full (raw RegionPanelRow) | map-2d-3d (one entry per
 *                  panel x vertex) | flat-pattern ({regionPanelId, outer}) |
 *                  boundary ({regionPanelId, bottomFace, topFace,
 *                  regionPolygonHoles, regionCircleHoles})
 * Each resource schema below defines its own projection explicitly.
 */

import { z } from 'zod';
import { Point2Schema, Point3Schema, Transform3RowSchema, RefSchema, FindingSchema, HoleSchema } from './shared';

// ─── graph://parts ───────────────────────────────────────────────────────────

export const PartsListSchema = z.object({
  parts: z.array(
    z.object({
      partId: z.string(),
      name: z.string(),
      materialId: z.string(),
      rootRegionPanelId: z.string(),
    }),
  ),
});

// ─── graph://part/{id}/map-2d-3d{?point} ────────────────────────────────────
// Two distinct success shapes depending on whether `?point=` was supplied —
// readMap2d3d (resources/graph.ts) branches on it internally.

const Map2d3dAllMappingsSchema = z.object({
  partId: z.string(),
  mappings: z.array(
    z.object({
      regionPanelId: z.string(),
      point2d: Point2Schema,
      bottom3d: Point3Schema,
      top3d: Point3Schema,
    }),
  ),
});

const Map2d3dSinglePointSchema = z.object({
  partId: z.string(),
  point2d: Point2Schema,
  point3d: Point3Schema,
  // Exactly one of regionPanelId/bendId is non-empty on success (the other
  // is "", per MapToWorldResult's own doc comment) — not absent/null.
  regionPanelId: z.string(),
  bendId: z.string(),
});

export const Map2d3dSchema = z.union([Map2d3dSinglePointSchema, Map2d3dAllMappingsSchema]);

// ─── graph://part/{id}/map-3d-2d?point= ─────────────────────────────────────

export const Map3d2dSchema = z.object({
  partId: z.string(),
  point3d: Point3Schema,
  point2d: Point2Schema,
  regionPanelId: z.string(),
  bendId: z.string(),
  residualMm: z.number(),
});

// ─── graph://part/{id}/flat-pattern ──────────────────────────────────────────

export const FlatPatternSchema = z.object({
  partId: z.string(),
  thicknessMm: z.number(),
  kFactor: z.number(),
  outline: z.array(Point2Schema),
  holes: z.array(HoleSchema),
  regionPanels: z.array(z.object({ regionPanelId: z.string(), outer: z.array(Point2Schema) })),
  bendLines: z.array(
    z.object({
      bendId: z.string(),
      hingeA: Point2Schema,
      hingeB: Point2Schema,
      angleDeg: z.number(),
      radiusMm: z.number(),
      radiusMeasured: z.boolean(),
    }),
  ),
  ref: RefSchema,
});

// ─── graph://part/{id}/full ───────────────────────────────────────────────────

const PartRowSchema = z.object({
  partId: z.string(),
  name: z.string(),
  rootRegionPanelId: z.string(),
  outline: z.array(Point2Schema),
  holes: z.array(HoleSchema),
  anchor: Transform3RowSchema,
  materialId: z.string(),
  thicknessMm: z.number(),
  kFactor: z.number(),
  schemaVersion: z.string(),
  mergedIntoPartId: z.string().nullable(),
});

const FullRegionPanelSchema = z.object({
  regionPanelId: z.string(),
  partId: z.string(),
  label: z.string(),
  kFactorOverride: z.number().nullable(),
  mergedIntoRegionPanelId: z.string().nullable(),
});

const FullBendSchema = z.object({
  bendId: z.string(),
  partId: z.string(),
  parentRegionPanelId: z.string(),
  childRegionPanelId: z.string(),
  hingeA: Point2Schema,
  hingeB: Point2Schema,
  angleDeg: z.number(),
  radiusMm: z.number(),
  kFactorOverride: z.number().nullable(),
  bottomIsConcave: z.boolean().nullable(),
  radiusMeasured: z.boolean(),
});

export const FullSchema = z.object({
  partId: z.string(),
  part: PartRowSchema,
  regionPanels: z.array(FullRegionPanelSchema),
  bends: z.array(FullBendSchema),
  findings: z.array(FindingSchema),
});

// ─── graph://part/{id}/findings ───────────────────────────────────────────────

export const FindingsSchema = z.object({
  partId: z.string(),
  findings: z.array(FindingSchema),
});

// ─── graph://part/{id}/boundary, graph://part/{id}/mesh ─────────────────────
// Both are Ref envelopes — the actual boundary JSON / mesh GLB bytes live at
// ref.url, fetched separately, never inline in the MCP resource response.

export const BoundaryEnvelopeSchema = z.object({
  partId: z.string(),
  ref: RefSchema,
});

export const MeshEnvelopeSchema = z.object({
  partId: z.string(),
  ref: RefSchema,
});

// ─── Registry ────────────────────────────────────────────────────────────────
// Keyed exactly like readGraphResource's own routing table (resources/
// graph.ts) — a new resource pattern needs a deliberate entry here, same
// discipline as the NAPI field-sync lint's registry (cpp/tools/check-napi-
// field-sync.mjs).

export const RESOURCE_SCHEMAS = {
  parts: PartsListSchema,
  'map-2d-3d': Map2d3dSchema,
  'map-3d-2d': Map3d2dSchema,
  'flat-pattern': FlatPatternSchema,
  full: FullSchema,
  findings: FindingsSchema,
  boundary: BoundaryEnvelopeSchema,
  mesh: MeshEnvelopeSchema,
} as const;

export type ResourceKind = keyof typeof RESOURCE_SCHEMAS;

// ─── Inferred TS types — the real return types for resources/graph.ts's
// readX functions, replacing what used to be `unknown`. ────────────────────

export type PartsListResponse = z.infer<typeof PartsListSchema>;
export type Map2d3dResponse = z.infer<typeof Map2d3dSchema>;
export type Map3d2dResponse = z.infer<typeof Map3d2dSchema>;
export type FlatPatternResponse = z.infer<typeof FlatPatternSchema>;
export type FullResponse = z.infer<typeof FullSchema>;
export type FindingsResponse = z.infer<typeof FindingsSchema>;
export type BoundaryEnvelopeResponse = z.infer<typeof BoundaryEnvelopeSchema>;
export type MeshEnvelopeResponse = z.infer<typeof MeshEnvelopeSchema>;
