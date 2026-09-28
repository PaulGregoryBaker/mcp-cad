/**
 * v2 port of the "make v2 manually testable" work (2026-07-27):
 * graph://part/{id}/full — one part's complete graph structure (14 B3a), no
 * geometry (15 §3.0). `findings` is always [] today — no manufacturability
 * rules engine exists anywhere in v2 yet.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';
import { McpToolError } from '../../src/mcp/errors';
import type { PartRow, RegionPanelRow, BendRow } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface FullResult {
  partId: string;
  part: PartRow;
  regionPanels: RegionPanelRow[];
  bends: BendRow[];
  findings: unknown[];
}

function readFull(store: GraphStore, partId: string): FullResult {
  return readGraphResource(store, `graph://part/${partId}/full`) as FullResult;
}

d('[v2] graph://part/{id}/full (structural resource)', () => {
  it('single-panel part (no bends): one region panel, no bends, empty findings', () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'full-single',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const full = readFull(store, part.part_id);
    expect(full.partId).toBe(part.part_id);
    expect(full.part.partId).toBe(part.part_id);
    expect(full.regionPanels).toHaveLength(1);
    expect(full.regionPanels[0]?.regionPanelId).toBe(part.root_region_panel_id);
    expect(full.bends).toEqual([]);
    expect(full.findings).toEqual([]);
  });

  it('two-panel part (one bend): reflects the bend and its two region panels', () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'full-bent',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;
    const bend = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 5, y: 0 },
      hinge_b: { x: 5, y: 5 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string };

    const full = readFull(store, part.part_id);
    expect(full.regionPanels).toHaveLength(2);
    expect(full.bends).toHaveLength(1);
    expect(full.bends[0]?.bendId).toBe(bend.bend_id);
    expect(full.findings).toEqual([]);
  });

  it('rejects a nonexistent part_id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    let caught: unknown;
    try {
      readFull(store, 'does-not-exist');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });
});
