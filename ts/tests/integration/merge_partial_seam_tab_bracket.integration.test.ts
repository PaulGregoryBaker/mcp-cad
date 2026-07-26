/**
 * v2 port of v1's merge_tab_bracket.integration.test.ts (Phase 5 test
 * migration, 2026-07-26). v1's fixture (tab_bracket_90deg.stp) merges a
 * 100mm-wide flange onto a 200mm-tall plate's edge, where the flange's own
 * seam (100mm) is NARROWER than the full straight run of the plate's edge it
 * sits on (200mm) — a T-shaped, asymmetric-seam merge. v1 detected this via
 * `target_edges: ['all']` (implicit adjacency auto-detection); v2's
 * merge_bodies_with_bend instead takes explicit `edge_a`/`edge_b` index refs
 * that must match in LENGTH exactly (GE_MERGE_EDGE_MISMATCH otherwise — see
 * merge_bodies_with_bend.integration.test.ts's own rejection case), which
 * looked at first glance like a real missing capability (no direct "partial
 * seam" tool parameter exists).
 *
 * Investigated and confirmed via a scratch script that this is NOT a v2 gap:
 * the SAME real part is representable today by authoring the plate's own
 * outline with the seam pre-split into three COLLINEAR sub-edges (0-50,
 * 50-150, 150-200mm along the shared boundary) and merging onto just the
 * matching 100mm middle edge by index — ordinary polygon vertices, no new
 * primitive needed. This is arguably a more explicit, more topologically
 * honest representation than v1's implicit auto-detection (constitution v2
 * principle III — one geometric solution, no implicit/derived matching).
 * Confirmed empirically (not just by construction-succeeds): the merge
 * produces exactly 2 region panels + 1 bridge, a manifold solid, and an
 * EXACT (not approximate, unlike v1's own ±20%-tolerance check) flat-pattern
 * area of 100×200 + 100×100 = 30000mm² — sharp bends (no radius/k_factor)
 * add zero bend-allowance area, so v2's additive check can be exact.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart, constructPart } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';
import type { PartRow } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface MergeToolResult {
  part_id: string;
  bend_id: string;
  child_region_panel_id: string;
}

function shoelaceArea(ring: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

/** Plate: 100mm wide (x) x 200mm tall (y), thickness 1.5mm. Its RIGHT edge
 * (x=100) is pre-split at y=50 and y=150 into three collinear sub-edges so
 * the flange (below) can attach to just the 100mm MIDDLE segment — the
 * T-shaped, asymmetric-seam scenario. Edge indices: e0=(0,0)-(100,0) bottom,
 * e1=(100,0)-(100,50) right-lower, e2=(100,50)-(100,150) right-middle (the
 * seam), e3=(100,150)-(100,200) right-upper, e4=(100,200)-(0,200) top,
 * e5=(0,200)-(0,0) left. */
function authorPlate(store: GraphStore): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name: 'tab-plate',
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 150 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
    ],
    thickness_mm: 1.5,
  }) as CreatePartResult;
}

/** Flange: 100mm wide x 100mm deep, thickness 1.5mm — its own edge 0 is
 * exactly 100mm, matching the plate's pre-split middle seam length. */
function authorFlange(store: GraphStore): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name: 'tab-flange',
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    thickness_mm: 1.5,
  }) as CreatePartResult;
}

d('[v2] merge_bodies_with_bend — T-shaped, asymmetric (partial-run) seam', () => {
  it('flange seam narrower than the plate edge it sits on: exact T-shaped flat pattern + manifold 3D solid', () => {
    const store = new GraphStore();
    const plate = authorPlate(store);
    const flange = authorFlange(store);

    const merged = dispatchGraphTool(store, 'merge_bodies_with_bend', {
      part_a_id: plate.part_id,
      part_b_id: flange.part_id,
      edge_a: { region_panel_id: plate.root_region_panel_id, edge_index: 2 },
      edge_b: { region_panel_id: flange.root_region_panel_id, edge_index: 0 },
      angle_deg: 90,
    }) as MergeToolResult;
    expect(merged.part_id).toBe(plate.part_id);
    expect(merged.bend_id).toBeTruthy();
    expect(merged.child_region_panel_id).toBeTruthy();

    // Flat pattern: exactly the T-shape's 8 corners, no extra/dropped
    // vertices, and an EXACTLY additive area (sharp bend, no allowance zone).
    const mergedPart = store.getPart(plate.part_id) as PartRow;
    expect(mergedPart.outline).toHaveLength(8);
    expect(shoelaceArea(mergedPart.outline)).toBeCloseTo(100 * 200 + 100 * 100, 6);

    // T-shape does not fill its own flat-pattern bbox (200x200=40000) —
    // fill ratio 30000/40000 = 0.75, well under 1.0.
    const xs = mergedPart.outline.map((p) => p.x);
    const ys = mergedPart.outline.map((p) => p.y);
    const bboxArea = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    expect(shoelaceArea(mergedPart.outline) / bboxArea).toBeCloseTo(0.75, 6);

    const evalResult = evaluatePart(store, plate.part_id);
    expect(evalResult.ok, evalResult.message).toBe(true);
    expect(evalResult.panels).toHaveLength(2);
    expect(evalResult.bridges).toHaveLength(1);

    const constructed = constructPart(store, plate.part_id);
    expect(constructed.ok, constructed.message).toBe(true);
    const manifold = geometryBinding.checkManifold(constructed.shellId);
    expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);

    // The flange (100mm deep) folds 90° off the plate's middle seam
    // (y=[50,150]) without extending past the plate's own x/y footprint —
    // its full depth lands entirely on the Z axis.
    const bbox = geometryBinding.computeBoundingBox(constructed.shellId);
    expect(bbox.x_min).toBeCloseTo(0, 6);
    expect(bbox.x_max).toBeCloseTo(100, 6);
    expect(bbox.y_min).toBeCloseTo(0, 6);
    expect(bbox.y_max).toBeCloseTo(200, 6);
    expect(bbox.z_min).toBeCloseTo(0, 6);
    expect(bbox.z_max).toBeCloseTo(100, 6);
  });
});
