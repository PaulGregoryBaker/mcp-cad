/**
 * T096 / SC-001 (spec 010): five varied projects survive close → reopen
 * exactly. For each, the committed revision read with AS OF
 * (graph://ref/<branch>/parts) and the live, reloaded store are compared
 * byte-for-byte with what they were before closing.
 */
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dispatchSessionTool } from '../../src/v2/tools/graph';
import { SessionContext } from '../../src/v2/persistence/session';
import { readSessionResource } from '../../src/v2/resources/session';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import { startDolt, withTestAccount, type DoltHarness } from '../helpers/dolt-harness';

const AUTHOR = { name: 'Pat Tester', email: 'pat@example.test' };
const FIXTURES = path.resolve(__dirname, '../../../cpp/tests/fixtures');
const rect = (x0: number, y0: number, w: number, h: number) => [
  { x: x0, y: y0 },
  { x: x0 + w, y: y0 },
  { x: x0 + w, y: y0 + h },
  { x: x0, y: y0 + h },
];

type Call = (name: string, args?: Record<string, unknown>) => Promise<Record<string, any>>;

/** Five projects, each exercising different graph content. */
const PROJECTS: Record<string, (call: Call) => Promise<void>> = {
  'plate with holes': async (call) => {
    const p = await call('create_part', { name: 'plate', outline: rect(0, 0, 300, 200), thickness_mm: 3, k_factor: 0 });
    await call('cut_panel', { part_id: p['part_id'], kind: 'circle', circle: { center: { x: 50, y: 50 }, radius_mm: 6 } });
    await call('cut_panel', { part_id: p['part_id'], kind: 'circle', circle: { center: { x: 250, y: 50 }, radius_mm: 6 } });
    await call('cut_panel', { part_id: p['part_id'], kind: 'polygon', polygon_ring: rect(120, 80, 60, 40) });
  },
  'bent channel, edited': async (call) => {
    const p = await call('create_part', { name: 'channel', outline: rect(0, 0, 200, 150), thickness_mm: 2 });
    const b = await call('create_node', {
      kind: 'bend',
      part_id: p['part_id'],
      parent_region_panel_id: p['root_region_panel_id'],
      hinge_a: { x: 0, y: 100 },
      hinge_b: { x: 200, y: 100 },
      angle_deg: 90,
      radius_mm: 2,
      label: 'flange',
    });
    await call('update_node', { kind: 'bend', id: b['bend_id'], patch: { angle_deg: 75, radius_mm: 3, k_factor_override: 0.42 } });
    await call('move_edge', {
      part_id: p['part_id'],
      vertex_range: { start_index: 1, end_index: 2 },
      new_points: [
        { x: 220, y: 0 },
        { x: 220, y: 150 },
      ],
    });
  },
  'many parts, presentation edited': async (call) => {
    for (let i = 0; i < 6; i++) {
      const p = await call('create_part', { name: `p${i}`, outline: rect(i * 120, 0, 100, 80), thickness_mm: 1.5 + i * 0.5 });
      await call('update_client_meta', {
        part_id: p['part_id'],
        doc: { v: 1, displayName: `Part ${i}`, groupId: 'g', groupName: 'Group', hidden: i % 2 === 0, excludedFromNesting: i === 5, colorOverride: 0xff0000 + i },
      });
    }
  },
  'fused (merged) parts': async (call) => {
    const a = await call('create_part', { name: 'a', outline: rect(0, 0, 100, 100), thickness_mm: 2 });
    const b = await call('create_part', { name: 'b', outline: rect(100, 0, 100, 100), thickness_mm: 2 });
    await call('fuse_bodies', { part_a_id: a['part_id'], part_b_id: b['part_id'] });
  },
  'configured import': async (call) => {
    await call('update_project_settings', {
      manufacturing_defaults: { defaultMaterial: 'mildSteel', defaultThicknessMm: 1.5, unitSystem: 'metric', preferredBendProcesses: ['airBend'] },
    });
    await call('import_part', {
      file: path.join(FIXTURES, 'tab_bracket_90deg.stp'),
      config: {
        scale: { preset: 'mm', factor: 1 },
        rotation: { xQuarterTurns: 0, yQuarterTurns: 1, zQuarterTurns: 0 },
        recenter: { xy: true, z: 'floor' },
        thicknessMm: 2.0,
        materialId: 'mildSteel',
      },
    });
  },
};

let h: DoltHarness;
let restoreEnv: () => void;
let n = 0;
const contexts: SessionContext[] = [];

describe('[persist] SC-001 fidelity: close → reopen reproduces every project exactly', () => {
  beforeAll(async () => {
    h = await startDolt();
    restoreEnv = withTestAccount(h);
    resetStorageAccountsCache();
  });
  afterEach(async () => {
    for (const c of contexts.splice(0)) await c.unbind();
  });
  afterAll(async () => {
    restoreEnv?.();
    await h?.stop();
  });

  for (const [name, build] of Object.entries(PROJECTS)) {
    it(name, async () => {
      const ctx = new SessionContext();
      contexts.push(ctx);
      const call: Call = (tool, args = {}) => dispatchSessionTool(ctx, tool, args) as Promise<Record<string, any>>;
      const db = `t_fid_${++n}`;
      await call('create_project', { account: 'test', database: db, name });
      await call('open_project', { account: 'test', database: db, author: AUTHOR });
      await call('branch_begin', { label: 'fidelity' });
      await build(call);
      await call('commit', { message: name });

      const ref = `graph://ref/${encodeURIComponent('wip/fidelity')}/parts`;
      const committedBefore = JSON.stringify(await readSessionResource(ctx, ref));
      const liveBefore = JSON.stringify(ctx.store.partIds().sort().map((id) => ctx.store.snapshotPart(id)));
      expect(ctx.store.partIds().length).toBeGreaterThan(0);

      await call('close_project');
      expect(ctx.store.partIds()).toEqual([]);
      const reopened = await call('open_project', { account: 'test', database: db, author: AUTHOR });
      expect(reopened['branch']).toBe('wip/fidelity');

      expect(JSON.stringify(await readSessionResource(ctx, ref))).toBe(committedBefore);
      expect(JSON.stringify(ctx.store.partIds().sort().map((id) => ctx.store.snapshotPart(id)))).toBe(liveBefore);
    });
  }
});
