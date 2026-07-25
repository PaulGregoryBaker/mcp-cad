/**
 * v2 manufacturing graph — in-memory row types (Phase 5 Slice 1).
 *
 * Mirrors rebuild/14-graph-schema.md §2's authoritative tables — `part`,
 * `region_panel`, `bend` — kept to the Slice 1 subset only: no holes, features,
 * semantics, dimension curation, or action log (all explicitly out of scope for
 * this slice, see the approved plan). Dolt persistence is also deferred (§2's
 * `part_ring`/`ring_vertex` row-per-vertex granularity exists specifically for
 * Dolt's row-level diffing — with no Dolt store yet and no ring-editing verbs in
 * this slice (K2 move-edge/smooth-edge), that granularity buys nothing yet, so
 * a part's one outline is simply `Point2[]` here rather than two ceremonial row
 * tables. When Dolt-backed persistence and ring editing land, this is exactly
 * where `part_ring`/`ring_vertex` rows replace the plain array — the row shape
 * this module exposes elsewhere (RegionPanelRow, BendRow) is already row-per-
 * entity, ready for that migration.
 *
 * A `region_panel` row's own SHAPE is never stored here either (14 §2.1 — "only
 * region panel geometry is derived"): it is computed by the C++ translation
 * module's `Evaluate()`, never by this store or any TypeScript code
 * (constitution v2.0.0 principle IV — no geometric computation in TypeScript).
 */

export interface Point2 {
  x: number;
  y: number;
}

/** Row-major 3x3 rotation (r) + translation (t) — matches Transform3 exactly. */
export interface Transform3Row {
  r: [number, number, number, number, number, number, number, number, number];
  t: [number, number, number];
}

export function identityTransform(): Transform3Row {
  return { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
}

/** Phase 5 Slice 9a (cut_panel) — a hole cut into the part's outline. `circle`
 * is an exact center+radius primitive, never tessellated into a polygon
 * anywhere in this pipeline (a hole is a wholly separate, self-contained
 * closed loop, unlike K2 smooth_edge's still-deferred bulge segments, which
 * are spliced into the outer ring's own boundary chain). `polygon`'s `ring`
 * is winding-canonicalized (CW, opposite the outer ring's CCW) by
 * cut_panel.hpp before it's ever stored here. */
export interface PolygonHole {
  kind: 'polygon';
  ring: Point2[];
}
export interface CircleHole {
  kind: 'circle';
  center: Point2;
  radiusMm: number;
}
export type Hole = PolygonHole | CircleHole;

/** `part` (14 §2) — owns the one flat outline, in one shared flat frame F. */
export interface PartRow {
  partId: string;
  name: string;
  rootRegionPanelId: string;
  /** The part's one flat outline (its cut profile), in F. CCW winding. */
  outline: Point2[];
  /** Phase 5 Slice 9a: holes cut into that same outline (default []) —
   * cut_panel is the only writer; every other v2 tool leaves this untouched. */
  holes: Hole[];
  /** R: embeds F into world (13 §3.1). Defaults to identity. */
  anchor: Transform3Row;
  materialId: string;
  /** One thickness per part (14 §2 D3). */
  thicknessMm: number;
  kFactor: number;
  schemaVersion: string;
  /** §2.1.2: set when this part was absorbed by merge_bodies_with_bend. Slice 1
   * never sets this (no cross-part merge tool yet) — carried for forward
   * compatibility with the full schema. */
  mergedIntoPartId: string | null;
}

/**
 * `region_panel` (14 §2/§2.1) — a named, derived region of the part's outline.
 * This row is ordinary stored identity (a UUID minted once, like any other row)
 * — what's NEVER stored is its shape, which is computed fresh by
 * ManufacturingGraphEvaluator from the part's outline and its own touching
 * bends every time (14 §2.1's boundingBends/regionOf).
 */
export interface RegionPanelRow {
  regionPanelId: string;
  partId: string;
  label: string;
  kFactorOverride: number | null;
  /** §2.1.1: set when this region panel's bounding bend is removed (a MERGE,
   * not a delete). NULL = live, eligible as a bend parent/child. Slice 1 has no
   * delete_node(bend) yet, so this is always null for now — carried for forward
   * compatibility. */
  mergedIntoRegionPanelId: string | null;
}

/**
 * `bend` (14 §2) — a fold-tree edge over region panels. The hinge segment is in
 * F (the part's one shared flat frame) — T_pc (a separate placement transform)
 * does not exist (14 §0): there is nothing to place once every region panel
 * shares one frame.
 */
export interface BendRow {
  bendId: string;
  partId: string;
  parentRegionPanelId: string;
  childRegionPanelId: string;
  hingeA: Point2;
  hingeB: Point2;
  /** Signed; positive = mountain (bottom = inner/concave), negative = valley
   * (bottom = outer/convex) — manufacturing_graph_evaluator.hpp's convention,
   * used as the pivot-side fallback whenever bottomIsConcave is null. */
  angleDeg: number;
  radiusMm: number;
  kFactorOverride: number | null;
  /** Explicit override of the angleDeg-sign-derived pivot-side
   * classification above — see BendSpec::bottomIsConcave's own doc comment
   * (manufacturing_graph_evaluator.hpp) for why these are independent
   * facts. null: falls back to the angleDeg-sign rule. */
  bottomIsConcave: boolean | null;
}
