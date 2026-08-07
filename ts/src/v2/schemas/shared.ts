/**
 * v2 MCP-boundary schema validation — shared sub-shapes (rebuild's "sending/
 * receiving evaluate against the schema" pass, 2026-08-07).
 *
 * Only genuinely-identical shapes live here. Bend-shaped and region-panel-
 * shaped data appear as 3 and 4 distinct, non-identical projections across
 * different resources (see resources.ts's own header comment) — those are
 * NOT collapsed into a shared schema; each resource defines its own
 * projection explicitly.
 */

import { z } from 'zod';

export const Point2Schema = z.object({
  x: z.number(),
  y: z.number(),
});

export const Point3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** Row-major 3x3 rotation (r) + translation (t) — matches Transform3Row
 * (v2/graph/types.ts) / Transform3 (C++) exactly. */
export const Transform3RowSchema = z.object({
  r: z.tuple([
    z.number(), z.number(), z.number(),
    z.number(), z.number(), z.number(),
    z.number(), z.number(), z.number(),
  ]),
  t: z.tuple([z.number(), z.number(), z.number()]),
});

/** A caller-specified boundary-edge reference — {region_panel_id, edge_index}
 * on the wire. edge_index is a real array index: non-negative integer.
 * Today's shared `requireEdgeRef` helper (mcp/tools/helpers.ts) only checks
 * `typeof === 'number'`, silently accepting -1/2.5 — this schema is the
 * actual enforcement point for the constraint several tool inputSchemas
 * already (correctly) declare but never got checked. */
export const EdgeRefSchema = z.object({
  region_panel_id: z.string(),
  edge_index: z.number().int().min(0),
});

/** graph://.../{flat-pattern,boundary,mesh}'s Ref envelope (resources/
 * graph.ts's toRef()) — a stable URL to fetch the actual blob from, never
 * inline. */
export const RefSchema = z.object({
  url: z.string(),
  contentType: z.string(),
  byteSize: z.number(),
  expiresAt: z.string(),
});

/** One manufacturability finding — the real MCP contract shape (15 §1),
 * matching v2/graph/evaluate-client.ts's own `Finding` type exactly.
 * `recommendedFix.params` is a genuine object here (evaluateFindings parses
 * the addon's raw JSON-string `paramsJson` before this shape ever exists —
 * see that function's own comment for the bug this fixed). */
export const FindingSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  anchors: z.array(z.object({ kind: z.string(), id: z.string() })),
  recommendedFix: z
    .object({
      tool: z.string(),
      params: z.record(z.unknown()),
    })
    .nullable(),
});

/** A hole cut into a part's outline (v2/graph/types.ts's `Hole` union) —
 * kind=circle is an exact center+radius primitive, never tessellated;
 * kind=polygon's ring is winding-canonicalized before storage. */
export const HoleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('polygon'), ring: z.array(Point2Schema) }),
  z.object({ kind: z.literal('circle'), center: Point2Schema, radiusMm: z.number() }),
]);
