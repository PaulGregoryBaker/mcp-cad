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
import { mapPointToWorld } from '../../src/v2/graph/evaluate-client';
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

d('split_part_at_bend', () => {
  it('splits a merged 2-panel part back into two parts whose areas partition the combined outline', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, partAId, partBId);

    const combinedArea = shoelaceArea(store.getPart(partAId)!.outline);
    expect(combinedArea).toBeCloseTo(10 * 5 + 5 * 8, 6);

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

    // The split-off part no longer has a live bend to fold it. Removing a
    // real (non-zero-radius) bend means its child's ENTIRE body legitimately
    // moves to a new, flat-cut position — a fixed, whole-body offset from
    // where the same material sat under the real curved fold (two different
    // rotation axes for the same angle differ by a CONSTANT vector, the
    // same at every point, not just near the hinge) — so "the same frame-F
    // point lands at the same 3D position as before" is not the right
    // invariant to check post-fix. What must hold is internal consistency:
    // the new shared boundary this split introduces lands at the SAME 3D
    // position whether queried via the parent's own (unchanged) anchor or
    // the child's own new one — see split_part_at_bend.integration.test.ts's
    // own "KNOWN BUG" regression test for the full derivation of why.
    const sharedVertices = childOutline.filter((cv) =>
      parentOutline.some((pv) => Math.abs(pv.x - cv.x) < 1e-6 && Math.abs(pv.y - cv.y) < 1e-6));
    expect(sharedVertices.length).toBeGreaterThan(0);
    for (const v of sharedVertices) {
      const fromParent = mapPointToWorld(store, partAId, v);
      const fromChild = mapPointToWorld(store, childId, v);
      expect(fromParent.ok, fromParent.message).toBe(true);
      expect(fromChild.ok, fromChild.message).toBe(true);
      expect(fromChild.point3d.x).toBeCloseTo(fromParent.point3d.x, 6);
      expect(fromChild.point3d.y).toBeCloseTo(fromParent.point3d.y, 6);
      expect(fromChild.point3d.z).toBeCloseTo(fromParent.point3d.z, 6);
    }

    // Regression guard: for a real (non-zero-angle) bend, the child's own
    // anchor must NOT just be a copy of the parent's (that was the bug —
    // it silently un-folds the part back to flat).
    expect(store.getPart(childId)!.anchor).not.toEqual(store.getPart(partAId)!.anchor);
  });

  it('keep_corner_on=parent gives the mirror-image partition', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, partAId, partBId);

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

  /**
   * Live-app regression (2026-09-15): "gaps between panels" reported after
   * split_part_at_bend on every bend of a real multi-bend imported part.
   *
   * Root cause: the new child part's outline (part_split.hpp, C++) is
   * trimmed/grown at the bend's TRUE TANGENT LINE (sb = |radius *
   * tan(angle/2)| from the raw hinge — real material for a non-zero-radius
   * bend), but its anchor used to be built from Evaluate()'s own
   * childRegionPanelId pose — a rotation about a DIFFERENT axis
   * (Evaluate()'s pose-walk uses one axis for the flat panel and a
   * separate, offset TRUE axis for the bend's own curved bridge; the two
   * only reconcile when both are present together and fused, which
   * split_part_at_bend's whole point is to remove). Reusing that pose for
   * an outline trimmed at the true tangent line left a real, measurable
   * gap — not a unit-conversion or float-noise scale issue.
   *
   * A tangent-line offset is a physical distance and can never be
   * negative; an attempted fix that added `fabs()` to Evaluate()'s own
   * axisInPlaneOffset formula (to match ComputeBendGeometry's own always-
   * non-negative setbackMm) broke 19 other, already-passing tests — other
   * code already depends on that value's current signed behavior. Fixed
   * instead by having SplitPartAtBend (part_split.cc) build the child's
   * own anchor directly from THIS split's own cut point (already
   * correctly signed, magnitude-only per keepCornerOn) composed with the
   * caller-supplied parentPose — never Evaluate()'s axisInPlaneOffset-
   * based axis at all, so childAnchor and childOutline are self-
   * consistent by construction (SplitAtBendResult::childAnchor's own doc
   * comment).
   *
   * The pinned regression: the actual NEW boundary vertex the split
   * introduces (not the invariant raw hinge, which the other tests above
   * already cover and which this bug never affected) must map to the SAME
   * world position whether queried via the parent's own remaining
   * outline+anchor or the child's own new outline+anchor — it is the same
   * physical edge, shared by construction.
   */
  it('the new tangent-line boundary vertex a real (non-zero-radius) split introduces '
    + 'lands at the same world position on both sides of the cut', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    const merged = mergeTwoParts(store, partAId, partBId);

    const split = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: partAId,
      bend_id: merged.bend_id,
      keep_corner_on: 'parent',
    }) as SplitToolResult;
    const childId = split.new_part_ids[0];

    const parentOutline = store.getPart(partAId)!.outline;
    const childOutline = store.getPart(childId)!.outline;
    const sharedVertices = childOutline.filter((cv) =>
      parentOutline.some((pv) => Math.abs(pv.x - cv.x) < 1e-6 && Math.abs(pv.y - cv.y) < 1e-6));
    // The split must actually introduce at least one new, real boundary
    // vertex shared by both sides — otherwise this test isn't exercising
    // the bug at all (radius=2 on a 90deg bend always does).
    expect(sharedVertices.length).toBeGreaterThan(0);

    for (const v of sharedVertices) {
      const fromParent = mapPointToWorld(store, partAId, v);
      const fromChild = mapPointToWorld(store, childId, v);
      expect(fromParent.ok, fromParent.message).toBe(true);
      expect(fromChild.ok, fromChild.message).toBe(true);
      const gap = Math.hypot(
        fromParent.point3d.x - fromChild.point3d.x,
        fromParent.point3d.y - fromChild.point3d.y,
        fromParent.point3d.z - fromChild.point3d.z,
      );
      expect(gap, `shared vertex (${v.x},${v.y}) must land at the same world position ` +
        `from both parent and child`).toBeLessThan(1e-6);
    }
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
