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
import { McpToolError } from '../../src/mcp/errors';

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

    // Both parts share the original combined part's own anchor.
    expect(store.getPart(childId)!.anchor).toEqual(store.getPart(partAId)!.anchor);
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
});
