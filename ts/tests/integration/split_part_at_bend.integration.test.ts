/**
 * v2 split_part_at_bend integration suite — the graph-level inverse of
 * merge_bodies_with_bend (part_split.hpp). Exercises the full real stack:
 * the split_part_at_bend tool -> GraphStore.splitPartAtBend ->
 * evaluate-client -> geometryBinding.splitPartAtBend (C++) -> re-parenting.
 *
 * Gated behind SUITE_V2_DRIVER=1, same convention as
 * merge_bodies_with_bend.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart } from '../../src/v2/graph/evaluate-client';
import { McpToolError } from '../../src/mcp/errors';
import type { Point2 } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface MergeToolResult {
  part_id: string;
  bend_id: string;
  child_region_panel_id: string;
}

interface SplitToolResult {
  part_id: string;
  new_part_ids: string[];
}

/** A region panel's own bottomFace — pose.Apply(rawOuter point, z=0),
 * ALREADY world-space (manufacturing_graph_evaluator.cc), built from the
 * SAME rawOuter+pose pair the actual 3D solid uses. Deliberately not
 * regionOuter (the flat-pattern/DXF-only widened view, point_mapping.cc's
 * own PanelShift derives from it): that widening resets to zero once a
 * bend is removed (a fresh, bendless part's root panel always starts
 * cumulativeShift=0), so comparing regionOuter-frame coordinates across a
 * split boundary compares two different reference frames, not real 3D
 * position — bottomFace sidesteps that by already being world-space. */
function regionPanelBottomFace(
  store: GraphStore, partId: string, regionPanelId: string,
): Array<{ x: number; y: number; z: number }> {
  const layout = evaluatePart(store, partId);
  if (!layout.ok) throw new Error(`evaluatePart(${partId}) failed: ${layout.message}`);
  const panel = layout.panels.find((p) => p.regionPanelId === regionPanelId);
  if (!panel) throw new Error(`region panel ${regionPanelId} not found on part ${partId}`);
  return panel.bottomFace;
}

/** Every vertex in `before` must still be found, unmoved, among `after` —
 * a lap-joint extension only ever ADDS vertices (part_split.hpp's own
 * header comment), never moves or removes existing ones, so this holds
 * whether or not the panel itself grew on this side of the split. */
function expectVerticesPreserved(
  before: Array<{ x: number; y: number; z: number }>,
  after: Array<{ x: number; y: number; z: number }>,
) {
  for (const vBefore of before) {
    let bestDrift = Infinity;
    for (const vAfter of after) {
      bestDrift = Math.min(bestDrift, Math.hypot(
        vAfter.x - vBefore.x, vAfter.y - vBefore.y, vAfter.z - vBefore.z,
      ));
    }
    expect(bestDrift, `vertex ${JSON.stringify(vBefore)} not found unmoved in ${JSON.stringify(after)}`)
      .toBeLessThan(1e-6);
  }
}

function shoelaceArea(poly: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

/** Same 10x5 A / 5x8 B fixture as merge_bodies_with_bend's own suite — B is
 * anchored so its own local edge0 (0,0)-(5,0) folds 90deg onto A's right
 * edge (10,0)-(10,5); see that suite's own header comment for the hand-
 * verified anchor derivation (cpp/tests/part_merge_test.cc checks the same
 * construction against DetectContact directly). docs/TASK_SPEC.md: no
 * edge_a/edge_b/angle_deg — both are derived from the two parts' own real
 * anchors. */
function authorTwoParts(store: GraphStore): {
  partAId: string;
  partBId: string;
  rootPanelAId: string;
  rootPanelBId: string;
} {
  const thicknessMm = 1.0;
  const partA = dispatchGraphTool(store, 'create_part', {
    name: 'split-a',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ],
    thickness_mm: thicknessMm,
  }) as { part_id: string; root_region_panel_id: string };

  const partB = dispatchGraphTool(store, 'create_part', {
    name: 'split-b',
    outline: [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 8 },
      { x: 0, y: 8 },
    ],
    thickness_mm: thicknessMm,
    anchor: {
      r: [0, 0, -1, -1, 0, 0, 0, 1, 0],
      t: [10, 5, 0],
    },
  }) as { part_id: string; root_region_panel_id: string };

  return {
    partAId: partA.part_id,
    partBId: partB.part_id,
    rootPanelAId: partA.root_region_panel_id,
    rootPanelBId: partB.root_region_panel_id,
  };
}

function mergeTwoParts(store: GraphStore, partAId: string, partBId: string): MergeToolResult {
  return dispatchGraphTool(store, 'merge_bodies_with_bend', {
    part_a_id: partAId,
    part_b_id: partBId,
    radius_mm: 2.0,
    k_factor: 0.4,
  }) as MergeToolResult;
}

/**
 * A LAP JOINT, not a mitered tangent-line trim (part_split.hpp's own header
 * comment has the full derivation, hand-verified against a real 3D solid).
 * keep_corner_on's chosen side EXTENDS past the raw hinge into the other
 * side's old territory to fill the corner completely; the OTHER side is cut
 * square at the raw hinge, its own full natural shape, unchanged. The two
 * sides' 2D flat-pattern footprints therefore deliberately OVERLAP near the
 * corner (they occupy different heights in the real 3D lap joint) — area is
 * NOT conserved across a split, and there is no longer a single boundary
 * vertex shared by both sides' outlines to compare — so neither invariant
 * is checked below. What IS checked: each side's own FAR (interior,
 * non-boundary) material lands at EXACTLY the same 3D position after the
 * split as it did before, while the bend was still live (live-app
 * regression, 2026-09-15: "panels shifted outward" — traced to childAnchor
 * reusing a pose whose own PanelShift, point_mapping.cc's flat-pattern-vs-
 * pose frame offset, silently changes once a region panel becomes the root
 * of a brand-new, bendless part; part_split.hpp's SplitPartAtBend doc
 * comment has the fix).
 */
d('split_part_at_bend', () => {
  it('splits a merged 2-panel part back into two parts; child extends into the corner, parent '
    + 'is cut square, and each side\'s own far material lands at its true pre-split position', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, partAId, partBId);

    const bFacesBefore = regionPanelBottomFace(store, partAId, merged.child_region_panel_id);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: partAId,
      bend_id: merged.bend_id,
      keep_corner_on: 'child',
    }) as SplitToolResult;

    expect(split.part_id).toBe(partAId);
    expect(split.new_part_ids).toHaveLength(1);
    const childId = split.new_part_ids[0];

    // The original bend is gone.
    expect(store.getBend(merged.bend_id)).toBeUndefined();

    // keep_corner_on='child' => child extends into the corner (larger than
    // its own pre-merge 40mm^2 (5x8) footprint); parent is cut square at
    // the raw hinge — its own FULL natural 50mm^2 (10x5) shape, unchanged.
    const parentArea = shoelaceArea(store.getPart(partAId)!.outline);
    const childArea = shoelaceArea(store.getPart(childId)!.outline);
    expect(childArea).toBeGreaterThan(5 * 8);
    expect(parentArea).toBeCloseTo(10 * 5, 6);

    // B's own original material (every vertex it already had, well clear
    // of the cut) lands at its exact pre-split 3D position — child's own
    // anchor is reused unchanged, not re-derived from this split.
    const bFacesAfter = regionPanelBottomFace(store, childId, merged.child_region_panel_id);
    expectVerticesPreserved(bFacesBefore, bFacesAfter);

    // Regression guard: for a real (non-zero-angle) bend, the child's own
    // anchor must NOT just be a copy of the parent's (an early bug — it
    // silently un-folds the part back to flat).
    expect(store.getPart(childId)!.anchor).not.toEqual(store.getPart(partAId)!.anchor);
  });

  it('keep_corner_on=parent gives the mirror-image extension: parent grows, child is cut '
    + 'square and stays at its own true pre-split position', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, partAId, partBId);

    const bFacesBefore = regionPanelBottomFace(store, partAId, merged.child_region_panel_id);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: partAId,
      bend_id: merged.bend_id,
      keep_corner_on: 'parent',
    }) as SplitToolResult;
    const childId = split.new_part_ids[0];

    const parentArea = shoelaceArea(store.getPart(partAId)!.outline);
    const childArea = shoelaceArea(store.getPart(childId)!.outline);
    expect(parentArea).toBeGreaterThan(10 * 5);
    // Child is cut square at the raw hinge — its own full natural shape.
    expect(childArea).toBeCloseTo(5 * 8, 6);

    const bFacesAfter = regionPanelBottomFace(store, childId, merged.child_region_panel_id);
    expectVerticesPreserved(bFacesBefore, bFacesAfter);
  });

  it('the same drift-preservation invariant also holds for a CONVEX bend', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = dispatchGraphTool(store, 'merge_bodies_with_bend', {
      part_a_id: partAId,
      part_b_id: partBId,
      radius_mm: 2.0,
      k_factor: 0.4,
      bottom_is_concave: false,
    }) as MergeToolResult;

    const bFacesBefore = regionPanelBottomFace(store, partAId, merged.child_region_panel_id);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: partAId,
      bend_id: merged.bend_id,
      keep_corner_on: 'parent',
    }) as SplitToolResult;
    const childId = split.new_part_ids[0];

    const bFacesAfter = regionPanelBottomFace(store, childId, merged.child_region_panel_id);
    expectVerticesPreserved(bFacesBefore, bFacesAfter);
  });

  it('split_part_at_bend rejects a bend that does not belong to the given part', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    mergeTwoParts(store, partAId, partBId);

    let threw: unknown;
    try {
      dispatchGraphTool(store, 'split_part_at_bend', {
        part_id: partBId, // aliased into A by the merge above — not a live part
        bend_id: 'not-a-real-bend-id',
        keep_corner_on: 'child',
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(McpToolError);
  });

  it('bend_id omitted splits every bend: an N-bend part becomes N+1 flat parts', () => {
    const store = new GraphStore();
    // A single 10x5 part with 2 chained internal bends (x=4, x=7) — 3 region
    // panels in a chain, all still one part_id.
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'split-chain',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string; root_region_panel_id: string };

    // hinge_a/hinge_b run bottom-to-top for both, so each bend's own child
    // side is the LOWER-x side (left-hand normal of (0,5) points -x) — root
    // stays parent to BOTH bends directly (siblings, not chained), so its
    // own remaining territory ends up x>7 once both are split away.
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 4, y: 0 },
      hinge_b: { x: 4, y: 5 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 7, y: 0 },
      hinge_b: { x: 7, y: 5 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: part.part_id,
      keep_corner_on: 'child',
    }) as SplitToolResult;

    expect(split.new_part_ids).toHaveLength(2);
    const allIds = [split.part_id, ...split.new_part_ids];

    // Both bends are children of the SAME root directly (siblings, not
    // chained) and keep_corner_on='child' means root is cut square at
    // every hinge — root's own territory (x in [7,10]) is never grown, so
    // its own area is unaffected; each child instead extends into the
    // corner (grows past its own natural width). Area is no longer
    // conserved across a lap-joint split (part_split.hpp's own header
    // comment) — each part's own material must simply still exist, with
    // zero bends left.
    for (const id of allIds) {
      const part = store.getPart(id);
      expect(part, `split-off part ${id} must exist`).toBeDefined();
      expect(shoelaceArea(part!.outline)).toBeGreaterThan(0);
      // Every resulting part must have zero bends of its own left.
      const bendsOnPart = store.snapshotPart(id).bends;
      expect(bendsOnPart).toHaveLength(0);
    }
  });

  it('bend_id omitted, all-or-nothing: a failed multi-bend split leaves the store untouched', () => {
    const store = new GraphStore();
    // A 20x20 base with 3 walls folded up on 3 of its 4 edges — adjacent
    // bends that share corners with each other. part_split.hpp cuts one
    // bend at a time with no knowledge of any other bend on the same ring
    // (its own header comment), so once the first wall is split away, the
    // next bend's hinge no longer grounds cleanly against the reshaped
    // remainder — this must fail cleanly (typed error), not leave a
    // partially-split, corrupted graph behind.
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'box3',
      outline: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string; root_region_panel_id: string };

    const edges: Array<[Point2, Point2]> = [
      [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      [{ x: 20, y: 0 }, { x: 20, y: 20 }],
      [{ x: 20, y: 20 }, { x: 0, y: 20 }],
    ];
    for (const [hingeA, hingeB] of edges) {
      dispatchGraphTool(store, 'create_node', {
        kind: 'bend',
        part_id: part.part_id,
        parent_region_panel_id: part.root_region_panel_id,
        hinge_a: hingeA,
        hinge_b: hingeB,
        angle_deg: 90,
        radius_mm: 1.0,
      });
    }

    // Deep-cloned (snapshotAll, not serialize) — serialize() returns live
    // row references, which a partial split would mutate in place, making
    // this baseline useless for an untouched-state comparison below.
    const before = store.snapshotAll();

    let threw: unknown;
    try {
      dispatchGraphTool(store, 'split_part_at_bend', {
        part_id: part.part_id,
        keep_corner_on: 'parent',
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(McpToolError);

    // Untouched: same parts, same bends, nothing minted or half-mutated.
    const after = store.serialize();
    expect(after.parts.map((p) => p.partId).sort()).toEqual(before.parts.map((p) => p.partId).sort());
    expect(after.bends.map((b) => b.bendId).sort()).toEqual(before.bends.map((b) => b.bendId).sort());
    const beforePart = before.parts.find((p) => p.partId === part.part_id)!;
    expect(store.getPart(part.part_id)!.outline).toEqual(beforePart.outline);
    expect(store.snapshotPart(part.part_id).bends).toHaveLength(3);
  });
});
