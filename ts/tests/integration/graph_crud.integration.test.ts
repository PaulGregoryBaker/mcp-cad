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
import { geometryBinding } from '../../src/geometry/binding';
import type { BoundingBoxResult } from '../../src/geometry/types';

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

  // Ported from v1's own split_by_bends.integration.test.ts — a real
  // regression guard against half-space extraction over-capturing an entire
  // panel slab as a "protrusion" (a real protrusion is a localized feature:
  // a tab, boss, or bridge flange, never panel-sized).
  it('testcube.step: protrusion bboxes are localized features, not panel-sized', () => {
    const result = dispatchGraphTool(new GraphStore(), 'split_body_by_bends', {
      file: path.join(FIXTURES_DIR, 'testcube.step'),
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }) as {
      panel_count: number;
      protrusion_count: number;
      panels: Array<{ shell_id: string }>;
      protrusions: Array<{ shell_id: string }>;
    };
    expect(result.panel_count).toBe(12);
    expect(result.protrusion_count).toBe(4);

    const bboxVolume = (b: BoundingBoxResult): number =>
      (b.x_max - b.x_min) * (b.y_max - b.y_min) * (b.z_max - b.z_min);
    const maxDim = (b: BoundingBoxResult): number =>
      Math.max(b.x_max - b.x_min, b.y_max - b.y_min, b.z_max - b.z_min);

    const panelBboxes = result.panels.map((p) => geometryBinding.computeBoundingBox(p.shell_id));
    const protrusionBboxes = result.protrusions.map((p) =>
      geometryBinding.computeBoundingBox(p.shell_id),
    );
    const largestPanelVolume = Math.max(...panelBboxes.map(bboxVolume));
    const largestPanelMaxDim = Math.max(...panelBboxes.map(maxDim));

    // Volume cap (25%) catches plate-style misdetections where a half-space
    // cut over-extracts an entire wall slab. The max-dimension cap (85%)
    // accommodates bridge flanges that legitimately span most of the inner
    // cube's own height.
    for (const bbox of protrusionBboxes) {
      expect(bboxVolume(bbox)).toBeLessThan(largestPanelVolume * 0.25);
      expect(maxDim(bbox)).toBeLessThan(largestPanelMaxDim * 0.85);
    }
  });

  it('cube_with_flanges.stp: 10 clean isolated panels (6 walls + 4 flanges), 0 protrusions', () => {
    const result = dispatchGraphTool(new GraphStore(), 'split_body_by_bends', {
      file: path.join(FIXTURES_DIR, 'cube_with_flanges.stp'),
    }) as { panel_count: number; protrusion_count: number };

    expect(result.panel_count).toBe(10);
    expect(result.protrusion_count).toBe(0);
  });

  /**
   * v2 port of v1's split_thickness_consistency.integration.test.ts's real
   * claim (Phase 5 test migration, 2026-07-26) — but investigated and fixed
   * at its actual root cause rather than ported as-is: v1's own fix was a
   * post-hoc "cross-panel midplane-offset correction" pass
   * (shape-ops.ts:2504) that re-derives a panel's thickness by comparing it
   * against a NEIGHBORING panel after the fact — exactly the kind of
   * cross-panel heuristic/case-arbitration this rebuild's constitution
   * restricts (principle VI). Investigation found the REAL root cause: every
   * panel splitMode2 extracts is deliberately cut 1mm larger than its own
   * correctly-measured true thickness ("0.5mm bleed on each side" — see
   * geometry_service_sheet_metal.cc's splitMode2 comment, a safety margin
   * for the boolean extraction itself) — for cube_with_flanges.stp, each
   * flange sits close enough to its host wall that this bleed margin
   * captures real neighboring material, and getPanelFrame's own
   * thicknessMm (which re-measures the EXTRACTED, already-bled solid's own
   * full vertex extent) reports the inflated result. The true per-panel
   * thickness (`bestDist`, the outer/inner face-group pairing distance) was
   * ALREADY being computed correctly upstream in splitMode2 — it just
   * wasn't propagated anywhere. Fixed by threading it through as
   * `DecomposedByBendsResult.panelThicknessMm` (parallel to panelIds) ->
   * NAPI `panel_thickness_mm` -> this tool's own `thickness_mm` field,
   * bypassing getPanelFrame's re-derivation entirely — the manufacturing
   * graph now reports each panel's own correctly-measured thickness
   * directly, no cross-panel comparison needed.
   *
   * cube_with_flanges.stp's 6 walls now all correctly measure 1mm (matching
   * generate_fixtures.cc's exact ground truth: a 200mm outer cube with a
   * 198mm hollow, 1mm wall on every side) — previously 1.5mm/2mm depending
   * on which neighboring feature fell within the bleed margin. The 4
   * flanges still honestly report 2mm: unlike the walls, a flange's own
   * natural inner face genuinely no longer exists once boolean-fused with
   * zero gap to its host wall (BRepAlgoAPI_Fuse erases that seam), so its
   * own outer/inner pairing correctly matches against the host wall's own
   * far face instead — a real, information-theoretic ambiguity (not a bug)
   * that only cross-panel inference could resolve, which is deliberately
   * out of scope here (see this comment's opening paragraph).
   */
  it('cube_with_flanges.stp: every wall panel measures the true 1mm thickness (not the bled/inflated slab extent)', () => {
    const result = dispatchGraphTool(new GraphStore(), 'split_body_by_bends', {
      file: path.join(FIXTURES_DIR, 'cube_with_flanges.stp'),
    }) as {
      panels: Array<{ shell_id: string; thickness_mm: number }>;
    };
    expect(result.panels).toHaveLength(10);

    const walls = result.panels.filter((p) => {
      const bbox = geometryBinding.computeBoundingBox(p.shell_id);
      const dims = [bbox.x_max - bbox.x_min, bbox.y_max - bbox.y_min, bbox.z_max - bbox.z_min].sort(
        (a, b) => a - b,
      );
      return dims[1] > 150 && dims[2] > 150;
    });
    expect(walls).toHaveLength(6);
    for (const wall of walls) {
      expect(wall.thickness_mm).toBeCloseTo(1, 6);
    }
  });
});
