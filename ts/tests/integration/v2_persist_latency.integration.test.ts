/**
 * T093 (spec 010, plan performance goals): write-through must not make edits
 * feel slow. 100 update_node calls through persistMutation vs the same calls
 * in memory → the added p95 is ≤ 100 ms; one undo on a 20-part project
 * takes ≤ 1 s. Results are printed for plan.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchGraphTool, dispatchSessionTool } from '../../src/v2/tools/graph';
import { GraphStore } from '../../src/v2/graph/store';
import { SessionContext } from '../../src/v2/persistence/session';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import { startDolt, withTestAccount, type DoltHarness } from '../helpers/dolt-harness';

const AUTHOR = { name: 'Pat Tester', email: 'pat@example.test' };
const RECT = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];
const BEND = (partId: string, root: string) => ({
  kind: 'bend',
  part_id: partId,
  parent_region_panel_id: root,
  hinge_a: { x: 0, y: 40 },
  hinge_b: { x: 100, y: 40 },
  angle_deg: 90,
  radius_mm: 2,
});

let h: DoltHarness;
let restoreEnv: () => void;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

async function timed(fn: () => unknown): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

describe('[persist] write latency', () => {
  beforeAll(async () => {
    h = await startDolt();
    restoreEnv = withTestAccount(h);
    resetStorageAccountsCache();
  });
  afterAll(async () => {
    restoreEnv?.();
    await h?.stop();
  });

  it('100 update_node: added p95 ≤ 100 ms; undo on 20 parts ≤ 1 s', async () => {
    const ctx = new SessionContext();
    const call = (name: string, args: Record<string, unknown>) => dispatchSessionTool(ctx, name, args) as Promise<Record<string, any>>;
    await call('create_project', { account: 'test', database: 't_latency', name: 'Latency' });
    await call('open_project', { account: 'test', database: 't_latency', author: AUTHOR });
    await call('branch_begin', { label: 'perf' });

    // A 20-part project, each with one bend.
    const parts: string[] = [];
    for (let i = 0; i < 20; i++) {
      const p = await call('create_part', { name: `p${i}`, outline: RECT, thickness_mm: 2 });
      await call('create_node', BEND(p['part_id'], p['root_region_panel_id']));
      parts.push(p['part_id']);
    }

    // The same edits in memory only (the engine's own cost).
    const mem = new GraphStore();
    const mp = dispatchGraphTool(mem, 'create_part', { name: 'm', outline: RECT, thickness_mm: 2 }) as Record<string, any>;
    const memMs: number[] = [];
    const persistMs: number[] = [];
    for (let i = 0; i < 100; i++) {
      // A distinct value every call, so every call is a real write.
      const patch = { thickness_mm: 2 + (i + 1) * 0.01 };
      memMs.push(await timed(() => dispatchGraphTool(mem, 'update_node', { kind: 'part', id: mp['part_id'], patch })));
      let r: Record<string, any> = {};
      persistMs.push(await timed(async () => (r = await call('update_node', { kind: 'part', id: parts[i % 20]!, patch }))));
      expect(r['action_seq']).toBeGreaterThan(0);
    }
    const added = persistMs.map((t, i) => t - memMs[i]!);
    const undoMs = await timed(() => call('undo', {}));

    const report = {
      persisted_p50_ms: +pct(persistMs, 50).toFixed(1),
      persisted_p95_ms: +pct(persistMs, 95).toFixed(1),
      in_memory_p95_ms: +pct(memMs, 95).toFixed(2),
      added_p95_ms: +pct(added, 95).toFixed(1),
      undo_20_parts_ms: +undoMs.toFixed(1),
    };
    console.log(`[T093] ${JSON.stringify(report)}`);
    expect(report.added_p95_ms).toBeLessThanOrEqual(100);
    expect(report.undo_20_parts_ms).toBeLessThanOrEqual(1000);
    await ctx.unbind();
  }, 180_000);
});
