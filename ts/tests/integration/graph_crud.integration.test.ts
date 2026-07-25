/**
 * v2 Graph CRUD completion integration suite (Phase 5 Slice 8:
 * rebuild/06-plan.md, rebuild/15-mcp-contract.md §4.3). Exercises
 * update_node, delete_node(kind=bend), move_edge, and the standalone
 * split_body_by_bends tool via dispatchGraphTool -> GraphStore.
 *
 * Scope note: this slice implements 4 of the 5 §4.3 tools. `smooth_edge` is
 * deliberately deferred — grep across v1's entire test suite found ZERO
 * references to smooth_edge or move_edge (both are net-new v2 capabilities,
 * not ports of existing v1 functionality, so neither carries any v1 test-
 * migration urgency), and unlike move_edge (a pure array splice),
 * smooth_edge would require extending Point2 with a stored bulge value
 * EVERYWHERE the C++ translation module represents an outline — a
 * foundational kernel data-model change, not an incremental CRUD tool. That
 * deserves its own design pass (matching how fuse_bodies got one in Slice
 * 6), not a rushed addition here.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { McpToolError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface CreateNodeResult {
  bend_id: string;
  child_region_panel_id: string;
}

function createRectPart(store: GraphStore, name: string): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name,
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ],
    thickness_mm: 1.0,
  }) as CreatePartResult;
}

function createBend(
  store: GraphStore,
  partId: string,
  parentRegionPanelId: string,
  hingeX: number,
): CreateNodeResult {
  return dispatchGraphTool(store, 'create_node', {
    kind: 'bend',
    part_id: partId,
    parent_region_panel_id: parentRegionPanelId,
    hinge_a: { x: hingeX, y: 0 },
    hinge_b: { x: hingeX, y: 5 },
    angle_deg: 90,
    radius_mm: 1.0,
  }) as CreateNodeResult;
}

function catchToolError(fn: () => void): McpToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    return err as McpToolError;
  }
  throw new Error('expected fn() to throw');
}

d('[v2] update_node (Phase 5 Slice 8)', () => {
  it('kind=part: patches name/material_id/k_factor/anchor', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'update-part');
    const anchor = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, t: [1, 2, 3] as const };

    const result = dispatchGraphTool(store, 'update_node', {
      kind: 'part',
      id: part.part_id,
      patch: { name: 'renamed', material_id: 'steel', k_factor: 0.4, anchor },
    }) as { part_id: string };
    expect(result.part_id).toBe(part.part_id);

    const row = store.getPart(part.part_id);
    expect(row?.name).toBe('renamed');
    expect(row?.materialId).toBe('steel');
    expect(row?.kFactor).toBe(0.4);
    expect(row?.anchor).toEqual(anchor);
  });

  it('kind=bend: patches angle/radius/k_factor_override/bottom_is_concave, and clears via null', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'update-bend');
    const created = createBend(store, part.part_id, part.root_region_panel_id, 5);

    dispatchGraphTool(store, 'update_node', {
      kind: 'bend',
      id: created.bend_id,
      patch: { angle_deg: 45, radius_mm: 2.5, k_factor_override: 0.33, bottom_is_concave: false },
    });
    let bend = store.getBend(created.bend_id);
    expect(bend?.angleDeg).toBe(45);
    expect(bend?.radiusMm).toBe(2.5);
    expect(bend?.kFactorOverride).toBe(0.33);
    expect(bend?.bottomIsConcave).toBe(false);

    // null explicitly clears; omitting a field leaves it untouched.
    dispatchGraphTool(store, 'update_node', {
      kind: 'bend',
      id: created.bend_id,
      patch: { k_factor_override: null },
    });
    bend = store.getBend(created.bend_id);
    expect(bend?.kFactorOverride).toBeNull();
    expect(bend?.angleDeg).toBe(45);
  });

  it('kind=region_panel: patches label and k_factor_override', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'update-panel');

    dispatchGraphTool(store, 'update_node', {
      kind: 'region_panel',
      id: part.root_region_panel_id,
      patch: { label: 'base-panel', k_factor_override: 0.5 },
    });
    const row = store.getRegionPanel(part.root_region_panel_id);
    expect(row?.label).toBe('base-panel');
    expect(row?.kFactorOverride).toBe(0.5);
  });

  it('rejects a nonexistent part id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    const err = catchToolError(() =>
      dispatchGraphTool(store, 'update_node', {
        kind: 'part',
        id: 'does-not-exist',
        patch: { name: 'x' },
      }),
    );
    expect(err.structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });

  it('rejects updating an aliased (already-fused-away) part with GRAPH_PART_ALIASED', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'alias-a');
    const partB = dispatchGraphTool(store, 'create_part', {
      name: 'alias-b',
      outline: [
        { x: 10, y: 0 },
        { x: 15, y: 0 },
        { x: 15, y: 5 },
        { x: 10, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;
    dispatchGraphTool(store, 'fuse_bodies', { part_a_id: partA.part_id, part_b_id: partB.part_id });

    const err = catchToolError(() =>
      dispatchGraphTool(store, 'update_node', {
        kind: 'part',
        id: partB.part_id,
        patch: { name: 'x' },
      }),
    );
    expect(err.structured.code).toBe('GRAPH_PART_ALIASED');
  });
});

d('[v2] delete_node(kind=bend) — panel-level merge (Phase 5 Slice 8)', () => {
  it('deletes a single bend, aliasing its child region panel onto the parent', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'delete-simple');
    const created = createBend(store, part.part_id, part.root_region_panel_id, 5);

    const result = dispatchGraphTool(store, 'delete_node', {
      kind: 'bend',
      id: created.bend_id,
    }) as { part_id: string; merged_region_panel_id: string; onto_region_panel_id: string };

    expect(result.part_id).toBe(part.part_id);
    expect(result.merged_region_panel_id).toBe(created.child_region_panel_id);
    expect(result.onto_region_panel_id).toBe(part.root_region_panel_id);
    expect(store.getBend(created.bend_id)).toBeUndefined();
    expect(store.getRegionPanel(created.child_region_panel_id)?.mergedIntoRegionPanelId).toBe(
      part.root_region_panel_id,
    );
  });

  it('re-parents a grandchild bend one level up when the middle bend is deleted', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'delete-chain');
    // root --(bendOuter)--> A --(bendInner)--> B (hinges at arbitrary, distinct x's).
    const bendOuter = createBend(store, part.part_id, part.root_region_panel_id, 3);
    const bendInner = createBend(store, part.part_id, bendOuter.child_region_panel_id, 7);

    dispatchGraphTool(store, 'delete_node', { kind: 'bend', id: bendOuter.bend_id });

    // bendInner's own parent must now be the ROOT (promoted up one level),
    // not the now-merged-away panel A.
    const promoted = store.getBend(bendInner.bend_id);
    expect(promoted?.parentRegionPanelId).toBe(part.root_region_panel_id);
    expect(store.getRegionPanel(bendOuter.child_region_panel_id)?.mergedIntoRegionPanelId).toBe(
      part.root_region_panel_id,
    );
  });

  it('rejects deleting a nonexistent bend with GRAPH_BEND_NOT_FOUND', () => {
    const store = new GraphStore();
    const err = catchToolError(() =>
      dispatchGraphTool(store, 'delete_node', { kind: 'bend', id: 'does-not-exist' }),
    );
    expect(err.structured.code).toBe('GRAPH_BEND_NOT_FOUND');
  });

  it('rejects deleting the same bend twice', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'delete-twice');
    const created = createBend(store, part.part_id, part.root_region_panel_id, 5);
    dispatchGraphTool(store, 'delete_node', { kind: 'bend', id: created.bend_id });

    const err = catchToolError(() =>
      dispatchGraphTool(store, 'delete_node', { kind: 'bend', id: created.bend_id }),
    );
    expect(err.structured.code).toBe('GRAPH_BEND_NOT_FOUND');
  });
});

d('[v2] move_edge (Phase 5 Slice 8)', () => {
  it('replaces one vertex with one new point (a translate)', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'move-single');

    const result = dispatchGraphTool(store, 'move_edge', {
      part_id: part.part_id,
      vertex_range: { start_index: 1, end_index: 1 },
      new_points: [{ x: 12, y: 0 }],
    }) as { part_id: string; outline: Array<{ x: number; y: number }> };

    expect(result.outline).toEqual([
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
  });

  it('replaces a 2-vertex range with 3 new points (an insert)', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'move-insert');

    const result = dispatchGraphTool(store, 'move_edge', {
      part_id: part.part_id,
      vertex_range: { start_index: 1, end_index: 2 },
      new_points: [
        { x: 10, y: 0 },
        { x: 11, y: 2.5 },
        { x: 10, y: 5 },
      ],
    }) as { part_id: string; outline: Array<{ x: number; y: number }> };

    expect(result.outline).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 11, y: 2.5 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
  });

  it('replaces a range with zero points (a delete), as long as >=3 vertices remain', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'move-delete');

    const result = dispatchGraphTool(store, 'move_edge', {
      part_id: part.part_id,
      vertex_range: { start_index: 1, end_index: 1 },
      new_points: [],
    }) as { part_id: string; outline: Array<{ x: number; y: number }> };

    expect(result.outline).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
  });

  it('rejects an out-of-bounds vertex_range with GRAPH_INVALID_VERTEX_RANGE', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'move-oob');

    const err = catchToolError(() =>
      dispatchGraphTool(store, 'move_edge', {
        part_id: part.part_id,
        vertex_range: { start_index: 2, end_index: 9 },
        new_points: [{ x: 0, y: 0 }],
      }),
    );
    expect(err.structured.code).toBe('GRAPH_INVALID_VERTEX_RANGE');
  });

  it('rejects a resulting outline with fewer than 3 vertices with GE_DEGENERATE_OUTLINE', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'move-degenerate');

    const err = catchToolError(() =>
      dispatchGraphTool(store, 'move_edge', {
        part_id: part.part_id,
        vertex_range: { start_index: 0, end_index: 3 },
        new_points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    );
    expect(err.structured.code).toBe('GE_DEGENERATE_OUTLINE');
  });
});

d('[v2] split_body_by_bends (standalone tool, Phase 5 Slice 8)', () => {
  it("l_bracket_corner_90deg.stp: matches import_part's own panel/protrusion counts", () => {
    const result = dispatchGraphTool(new GraphStore(), 'split_body_by_bends', {
      file: path.join(FIXTURES_DIR, 'l_bracket_corner_90deg.stp'),
    }) as { panel_count: number; protrusion_count: number; panels: unknown[] };

    expect(result.panel_count).toBe(2);
    expect(result.protrusion_count).toBe(0);
    expect(result.panels.length).toBe(2);
  });

  it('testcube.step: succeeds and reports 4 protrusions, even though import_part refuses this fixture', () => {
    const result = dispatchGraphTool(new GraphStore(), 'split_body_by_bends', {
      file: path.join(FIXTURES_DIR, 'testcube.step'),
    }) as {
      panel_count: number;
      protrusion_count: number;
      protrusions: Array<{ ring_local: Array<{ x: number; y: number }>; thickness_mm: number }>;
    };

    expect(result.protrusion_count).toBe(4);
    expect(result.protrusions.length).toBe(4);
    for (const p of result.protrusions) {
      expect(p.ring_local.length).toBeGreaterThanOrEqual(3);
      expect(p.thickness_mm).toBeGreaterThan(0);
    }
  });
});
