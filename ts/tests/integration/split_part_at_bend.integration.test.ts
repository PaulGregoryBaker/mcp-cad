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
import type { NapiTransform3 } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

/** p' = R*p + t (row-major 3x3 r), z=0 — mirrors Transform3::Apply
 * (manufacturing_graph_evaluator.hpp) so the test can independently verify
 * a `pose` bakes a flat-frame point to the SAME 3D position on both sides
 * of a split, without depending on any internal helper under test. */
function applyPose(pose: NapiTransform3, p: Point2): { x: number; y: number; z: number } {
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = pose.r;
  const [tx, ty, tz] = pose.t;
  return {
    x: r0 * p.x + r1 * p.y + r2 * 0 + tx,
    y: r3 * p.x + r4 * p.y + r5 * 0 + ty,
    z: r6 * p.x + r7 * p.y + r8 * 0 + tz,
  };
}

interface MergeToolResult {
  part_id: string;
  bend_id: string;
  child_region_panel_id: string;
}

interface SplitToolResult {
  part_id: string;
  new_part_ids: string[];
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

/** Same 10x5 A / 5x8 B fixture as merge_bodies_with_bend's own suite —
 * A's right edge (length 5) is the seam. */
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
  }) as { part_id: string; root_region_panel_id: string };

  return {
    partAId: partA.part_id,
    partBId: partB.part_id,
    rootPanelAId: partA.root_region_panel_id,
    rootPanelBId: partB.root_region_panel_id,
  };
}

function mergeTwoParts(
  store: GraphStore,
  rootPanelAId: string,
  partAId: string,
  rootPanelBId: string,
  partBId: string,
): MergeToolResult {
  return dispatchGraphTool(store, 'merge_bodies_with_bend', {
    part_a_id: partAId,
    part_b_id: partBId,
    edge_a: { region_panel_id: rootPanelAId, edge_index: 1 },
    edge_b: { region_panel_id: rootPanelBId, edge_index: 0 },
    angle_deg: 90,
    radius_mm: 2.0,
    k_factor: 0.4,
  }) as MergeToolResult;
}

d('split_part_at_bend', () => {
  it('splits a merged 2-panel part back into two parts whose areas partition the combined outline', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);

    const combinedArea = shoelaceArea(store.getPart(partAId)!.outline);
    expect(combinedArea).toBeCloseTo(10 * 5 + 5 * 8, 6);

    // Capture the bend's own hinge (frame F) and the pose it folds that
    // hinge to in 3D WHILE the merge is still intact — the ground truth
    // "where this material actually is" the split must not disturb.
    const bendRow = store.getBend(merged.bend_id)!;
    const layoutBefore = evaluatePart(store, partAId);
    expect(layoutBefore.ok).toBe(true);
    const childPanelBefore = layoutBefore.panels.find(
      (p) => p.regionPanelId === merged.child_region_panel_id,
    )!;
    expect(childPanelBefore).toBeDefined();
    const hingeA3dBefore = applyPose(childPanelBefore.pose, bendRow.hingeA);
    const hingeB3dBefore = applyPose(childPanelBefore.pose, bendRow.hingeB);

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

    const parentOutline = store.getPart(partAId)!.outline;
    const childOutline = store.getPart(childId)!.outline;
    const parentArea = shoelaceArea(parentOutline);
    const childArea = shoelaceArea(childOutline);
    // A strict partition of the same original combined outline.
    expect(parentArea + childArea).toBeCloseTo(combinedArea, 6);
    // keep_corner_on='child' => child absorbs the allowance band, so it's
    // larger than its own pre-merge 40mm^2 (5x8) footprint.
    expect(childArea).toBeGreaterThan(5 * 8);
    expect(parentArea).toBeLessThan(10 * 5);

    // The split-off part no longer has a live bend to fold it — its own
    // anchor must already bake in the fold, so the SAME frame-F hinge
    // points land at the SAME 3D position as they did while still merged.
    const layoutAfter = evaluatePart(store, childId);
    expect(layoutAfter.ok).toBe(true);
    const childPanelAfter = layoutAfter.panels.find(
      (p) => p.regionPanelId === merged.child_region_panel_id,
    )!;
    expect(childPanelAfter).toBeDefined();
    const hingeA3dAfter = applyPose(childPanelAfter.pose, bendRow.hingeA);
    const hingeB3dAfter = applyPose(childPanelAfter.pose, bendRow.hingeB);
    expect(hingeA3dAfter.x).toBeCloseTo(hingeA3dBefore.x, 6);
    expect(hingeA3dAfter.y).toBeCloseTo(hingeA3dBefore.y, 6);
    expect(hingeA3dAfter.z).toBeCloseTo(hingeA3dBefore.z, 6);
    expect(hingeB3dAfter.x).toBeCloseTo(hingeB3dBefore.x, 6);
    expect(hingeB3dAfter.y).toBeCloseTo(hingeB3dBefore.y, 6);
    expect(hingeB3dAfter.z).toBeCloseTo(hingeB3dBefore.z, 6);

    // Regression guard: for a real (non-zero-angle) bend, the child's own
    // anchor must NOT just be a copy of the parent's (that was the bug —
    // it silently un-folds the part back to flat).
    expect(store.getPart(childId)!.anchor).not.toEqual(store.getPart(partAId)!.anchor);
  });

  it('keep_corner_on=parent gives the mirror-image partition', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: partAId,
      bend_id: merged.bend_id,
      keep_corner_on: 'parent',
    }) as SplitToolResult;

    const parentArea = shoelaceArea(store.getPart(partAId)!.outline);
    const childArea = shoelaceArea(store.getPart(split.new_part_ids[0])!.outline);
    expect(parentArea).toBeGreaterThan(10 * 5);
    expect(childArea).toBeLessThan(5 * 8);
  });

  it('split_part_at_bend rejects a bend that does not belong to the given part', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);

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

    const totalAreaBefore = shoelaceArea(store.getPart(part.part_id)!.outline);
    expect(totalAreaBefore).toBeCloseTo(10 * 5, 6);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: part.part_id,
      keep_corner_on: 'child',
    }) as SplitToolResult;

    expect(split.new_part_ids).toHaveLength(2);
    const allIds = [split.part_id, ...split.new_part_ids];

    let totalAreaAfter = 0;
    for (const id of allIds) {
      const part = store.getPart(id);
      expect(part, `split-off part ${id} must exist`).toBeDefined();
      totalAreaAfter += shoelaceArea(part!.outline);
      // Every resulting part must have zero bends of its own left.
      const bendsOnPart = store.snapshotPart(id).bends;
      expect(bendsOnPart).toHaveLength(0);
    }
    expect(totalAreaAfter).toBeCloseTo(totalAreaBefore, 6);
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
