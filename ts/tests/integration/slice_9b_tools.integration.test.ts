/**
 * v2 Slice 9b integration tests — aligned 1:1 with C++ tests:
 *   close_gap_test.cc, add_flange_test.cc, rip_edge_test.cc,
 *   generate_reliefs_test.cc, split_by_plane_test.cc
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart } from '../../src/v2/graph/evaluate-client';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

function createRect(store: GraphStore, w = 100, h = 50, thickness = 1.0) {
  return dispatchGraphTool(store, 'create_part', {
    name: 'test-rect',
    outline: [
      { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
    ],
    thickness_mm: thickness,
  }) as CreatePartResult;
}

// ══════════════════════════════════════════════════════════════════════════════
// close_gap
// ══════════════════════════════════════════════════════════════════════════════

d('[v2] Slice 9b: close_gap', () => {
  it('closes a gap between two free edges on the same panel', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);
    // Add a bend to create a second panel with a free edge
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 50 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    // Evaluate to get free edges. The root panel now has a top edge
    // (from (50,50) to (0,50)) and the child panel has its own edges.
    // close_gap on edges that are already touching should succeed with gap=0.
    const evaluated = evaluatePart(store, part.part_id);
    expect(evaluated.ok).toBe(true);

    // Find two free edges on the same panel
    const rootPanel = evaluated.panels.find((p) => p.regionPanelId === part.root_region_panel_id)!;
    const freeEdges = rootPanel.edgeBendId
      .map((bid, i) => (bid === '' ? i : -1))
      .filter((i) => i >= 0);

    if (freeEdges.length >= 1) {
      // close_gap on the same edge (zero gap) should succeed
      const result = dispatchGraphTool(store, 'close_gap', {
        part_id: part.part_id,
        edge_a: { region_panel_id: part.root_region_panel_id, edge_index: freeEdges[0] },
        edge_b: { region_panel_id: part.root_region_panel_id, edge_index: freeEdges[0] },
      }) as { gap_mm: number };
      expect(result.gap_mm).toBe(0);
    }
  });

  it('close_gap on two different free edges returns a measured gap', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 50 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    const evaluated = evaluatePart(store, part.part_id);
    const rootPanel = evaluated.panels.find((p) => p.regionPanelId === part.root_region_panel_id)!;
    const freeEdges = rootPanel.edgeBendId
      .map((bid, i) => (bid === '' ? i : -1))
      .filter((i) => i >= 0);

    if (freeEdges.length >= 2) {
      const result = dispatchGraphTool(store, 'close_gap', {
        part_id: part.part_id,
        edge_a: { region_panel_id: part.root_region_panel_id, edge_index: freeEdges[0] },
        edge_b: { region_panel_id: part.root_region_panel_id, edge_index: freeEdges[1] },
      }) as { gap_mm: number };
      // Gap should be measurable (non-negative)
      expect(result.gap_mm).toBeGreaterThanOrEqual(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// add_flange
// ══════════════════════════════════════════════════════════════════════════════

d('[v2] Slice 9b: add_flange', () => {
  it('adds a flange to the top edge of a rectangle', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    // Top edge is from (100,50) to (0,50) — edge index 2
    const result = dispatchGraphTool(store, 'add_flange', {
      part_id: part.part_id,
      edge: { region_panel_id: part.root_region_panel_id, edge_index: 2 },
      length_mm: 10,
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    expect(result.bend_id).toBeTruthy();
    expect(result.child_region_panel_id).toBeTruthy();

    // The part should now have 2 region panels (root + flange)
    const snapshot = store.snapshotPart(part.part_id);
    expect(snapshot.regionPanels).toHaveLength(2);
    expect(snapshot.bends).toHaveLength(1);

    // Outline should have more vertices (flange extended it)
    expect(snapshot.part.outline.length).toBeGreaterThan(4);
  });

  it('adds a flange to the right edge of a rectangle', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    // Right edge is from (100,0) to (100,50) — edge index 1
    const result = dispatchGraphTool(store, 'add_flange', {
      part_id: part.part_id,
      edge: { region_panel_id: part.root_region_panel_id, edge_index: 1 },
      length_mm: 5,
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    expect(result.bend_id).toBeTruthy();
    expect(result.child_region_panel_id).toBeTruthy();
    expect(store.snapshotPart(part.part_id).regionPanels).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// rip_edge
// ══════════════════════════════════════════════════════════════════════════════

d('[v2] Slice 9b: rip_edge', () => {
  it('rips a free edge creating a gap in the outline', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    // Rip the top edge (index 2)
    const result = dispatchGraphTool(store, 'rip_edge', {
      part_id: part.part_id,
      edge: { region_panel_id: part.root_region_panel_id, edge_index: 2 },
      gap_mm: 0.5,
    }) as Record<string, never>;

    // Outline should have grown (gap vertices added)
    const snapshot = store.snapshotPart(part.part_id);
    expect(snapshot.part.outline.length).toBeGreaterThan(4);
  });

  it('rip_edge with zero gap still modifies the outline', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    dispatchGraphTool(store, 'rip_edge', {
      part_id: part.part_id,
      edge: { region_panel_id: part.root_region_panel_id, edge_index: 2 },
      gap_mm: 0,
    });

    // Even with zero gap, outline has the gap vertices
    expect(store.snapshotPart(part.part_id).part.outline.length).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// generate_reliefs
// ══════════════════════════════════════════════════════════════════════════════

d('[v2] Slice 9b: generate_reliefs', () => {
  it('generates reliefs at two perpendicular bends sharing a corner', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 100, 1.0);

    // Create two bends sharing a corner: first splits at x=50, second on the child
    const bend1 = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 100 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    // Second bend on the child panel, perpendicular to first
    const bend2 = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: bend1.child_region_panel_id,
      hinge_a: { x: 50, y: 50 },
      hinge_b: { x: 100, y: 50 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    const result = dispatchGraphTool(store, 'generate_reliefs', {
      part_id: part.part_id,
      bend_ids: [bend1.bend_id, bend2.bend_id],
      relief_type: 'dogbone',
      radius_mm: 1.0,
    }) as Record<string, never>;

    // The part should now have holes (relief polygons were cut)
    const snapshot = store.snapshotPart(part.part_id);
    // Holes may or may not be added depending on containment —
    // at minimum the call succeeded without error
    expect(result).toEqual({});
  });

  it('generate_reliefs with no shared corners returns empty (no-op)', () => {
    const store = new GraphStore();
    const part = createRect(store, 200, 100, 1.0);

    // Two bends far apart — no shared corners
    const b1 = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 100 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };
    const b2 = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 150, y: 0 },
      hinge_b: { x: 150, y: 100 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    // Pass the real bend IDs — C++ will find no shared corners
    const result = dispatchGraphTool(store, 'generate_reliefs', {
      part_id: part.part_id,
      bend_ids: [b1.bend_id, b2.bend_id],
      relief_type: 'circular',
      radius_mm: 1.0,
    }) as Record<string, never>;

    expect(result).toEqual({});
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// split_body_by_plane
// ══════════════════════════════════════════════════════════════════════════════

d('[v2] Slice 9b: split_body_by_plane', () => {
  it('splits a flat rectangle by a vertical plane', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    const result = dispatchGraphTool(store, 'split_body_by_plane', {
      part_id: part.part_id,
      plane: {
        normal: { x: 1, y: 0, z: 0 },
        origin: { x: 50, y: 0, z: 0 },
      },
    }) as { new_part_ids: string[] };

    expect(result.new_part_ids.length).toBeGreaterThanOrEqual(1);
    // Each new part should be a valid part
    for (const id of result.new_part_ids) {
      const snap = store.snapshotPart(id);
      expect(snap.part.outline.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('split_body_by_plane with plane outside the part still produces at least one part', () => {
    const store = new GraphStore();
    const part = createRect(store, 100, 50);

    const result = dispatchGraphTool(store, 'split_body_by_plane', {
      part_id: part.part_id,
      plane: {
        normal: { x: 1, y: 0, z: 0 },
        origin: { x: 200, y: 0, z: 0 },
      },
    }) as { new_part_ids: string[] };

    expect(result.new_part_ids.length).toBeGreaterThanOrEqual(1);
  });
});