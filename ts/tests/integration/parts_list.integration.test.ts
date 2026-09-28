/**
 * v2 port of the "make v2 manually testable" work (2026-07-27):
 * graph://parts — list every live part in the store. Needed just to know
 * what parts exist at all before a human/UI can inspect or view any of them.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface PartsListResult {
  parts: Array<{ partId: string; name: string; materialId: string; rootRegionPanelId: string }>;
}

function readPartsList(store: GraphStore): PartsListResult {
  return readGraphResource(store, 'graph://parts') as PartsListResult;
}

d('[v2] graph://parts (list resource)', () => {
  it('empty store returns an empty list', () => {
    const store = new GraphStore();
    expect(readPartsList(store)).toEqual({ parts: [] });
  });

  it('lists every part created so far, with the right identifying fields', () => {
    const store = new GraphStore();
    const a = dispatchGraphTool(store, 'create_part', {
      name: 'part-a',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
      material_id: 'mild_steel_1mm',
    }) as CreatePartResult;
    const b = dispatchGraphTool(store, 'create_part', {
      name: 'part-b',
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const list = readPartsList(store);
    expect(list.parts).toHaveLength(2);

    const byId = new Map(list.parts.map((p) => [p.partId, p]));
    expect(byId.get(a.part_id)).toEqual({
      partId: a.part_id,
      name: 'part-a',
      materialId: 'mild_steel_1mm',
      rootRegionPanelId: a.root_region_panel_id,
    });
    expect(byId.get(b.part_id)?.name).toBe('part-b');
    expect(byId.get(b.part_id)?.rootRegionPanelId).toBe(b.root_region_panel_id);
  });
});
