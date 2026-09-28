/**
 * T080 (spec 010 US4): reading revisions without checking them out —
 * graph://ref/{ref}/parts, graph://ref/{ref}/part/{id}/mesh and
 * graph://diff/{base}/{target} — against a real Dolt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { dispatchSessionTool } from '../../src/v2/tools/graph';
import { SessionContext } from '../../src/v2/persistence/session';
import { readSessionResource } from '../../src/v2/resources/session';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import { startDolt, withTestAccount, type DoltHarness } from '../helpers/dolt-harness';

const AUTHOR = { name: 'Pat Tester', email: 'pat@example.test' };
const RECT = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

let h: DoltHarness;
let restoreEnv: () => void;
let n = 0;
const contexts: SessionContext[] = [];

function call<T = Record<string, any>>(ctx: SessionContext, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return dispatchSessionTool(ctx, name, args) as Promise<T>;
}
const read = <T = Record<string, any>>(ctx: SessionContext, uri: string) => readSessionResource(ctx, uri) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { structured?: { code: string } }).structured?.code ?? String(e);
  }
}

async function sqlOn(db: string, branch: string, ...stmts: string[]): Promise<RowDataPacket[]> {
  const c = await h.connect();
  try {
    await c.query(`USE \`${db}/${branch}\``);
    let last: RowDataPacket[] = [];
    for (const s of stmts) [last] = (await c.query(s)) as [RowDataPacket[], unknown];
    return last;
  } finally {
    await c.end();
  }
}

/** Three commits on wip/work: c1 plate, c2 + bend, c3 moved outline edge. */
async function threeCommits() {
  const ctx = new SessionContext();
  contexts.push(ctx);
  const db = `t_refs_${++n}`;
  await call(ctx, 'create_project', { account: 'test', database: db, name: `R${n}` });
  await call(ctx, 'open_project', { account: 'test', database: db, author: AUTHOR });
  await call(ctx, 'branch_begin', { label: 'work' });
  const part = await call(ctx, 'create_part', { name: 'plate', outline: RECT, thickness_mm: 2 });
  const c1 = (await call(ctx, 'commit', { message: 'plate' }))['commit_hash'] as string;
  const bend = await call(ctx, 'create_node', {
    kind: 'bend',
    part_id: part['part_id'],
    parent_region_panel_id: part['root_region_panel_id'],
    hinge_a: { x: 0, y: 40 },
    hinge_b: { x: 100, y: 40 },
    angle_deg: 90,
    radius_mm: 2,
  });
  const c2 = (await call(ctx, 'commit', { message: 'bend' }))['commit_hash'] as string;
  await call(ctx, 'move_edge', {
    part_id: part['part_id'],
    vertex_range: { start_index: 1, end_index: 2 },
    new_points: [
      { x: 120, y: 0 },
      { x: 120, y: 60 },
    ],
  });
  const c3 = (await call(ctx, 'commit', { message: 'longer' }))['commit_hash'] as string;
  return { ctx, db, partId: part['part_id'] as string, bendId: bend['bend_id'] as string, c1, c2, c3 };
}

describe('[persist] revision reads', () => {
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

  it('ref/<c1>/parts is c1, while the writer stays on the working branch', async () => {
    const { ctx, partId, c1, c3 } = await threeCommits();
    const at1 = await read(ctx, `graph://ref/${c1}/parts`);
    const snap1 = at1['parts'].find((p: any) => p.part_id === partId).snapshot;
    expect(snap1.bends).toHaveLength(0);
    expect(snap1.part.outline).toEqual(RECT);
    expect(at1['client_meta']).toHaveLength(1);

    const at3 = await read(ctx, `graph://ref/${c3}/parts`);
    expect(at3['parts'][0].snapshot).toEqual(ctx.store.snapshotPart(partId));
    const status = await read(ctx, 'graph://history');
    expect(status['current_branch']).toBe('wip/work');
    expect(ctx.store.snapshotPart(partId).bends).toHaveLength(1); // live store untouched

    // Branch names are refs too (URL-encoded).
    const onBranch = await read(ctx, `graph://ref/${encodeURIComponent('wip/work')}/parts`);
    expect(onBranch['parts'][0].snapshot).toEqual(ctx.store.snapshotPart(partId));
  });

  it('a historical mesh differs from HEAD and is stable per content', async () => {
    const { ctx, partId, c1, c3 } = await threeCommits();
    const m1 = await read(ctx, `graph://ref/${c1}/part/${partId}/mesh`);
    const m3 = await read(ctx, `graph://ref/${c3}/part/${partId}/mesh`);
    const m1again = await read(ctx, `graph://ref/${c1}/part/${partId}/mesh`);
    expect(m1['ref'].url).toMatch(/\/v2-blob\/ref-mesh\/[0-9a-f]{64}$/);
    expect(m1['ref'].url).not.toBe(m3['ref'].url);
    expect(m1['ref'].byteSize).not.toBe(m3['ref'].byteSize);
    expect(m1again['ref'].url).toBe(m1['ref'].url);
    expect(await codeOf(read(ctx, `graph://ref/${c1}/part/nope/mesh`))).toBe('GRAPH_PART_NOT_FOUND');
  });

  it('diff: one added bend (c1→c2); an outline change for move_edge (c2→c3); nothing for c3→c3', async () => {
    const { ctx, partId, bendId, c1, c2, c3 } = await threeCommits();
    const d12 = await read(ctx, `graph://diff/${c1}/${c2}`);
    expect(d12['parts']).toHaveLength(1);
    const p12 = d12['parts'][0];
    expect(p12.part_id).toBe(partId);
    expect(p12.change).toBe('modified');
    expect(p12.bends).toEqual({ added: [bendId], removed: [], modified: [] });
    expect(p12.region_panels.added).toHaveLength(1);

    const d23 = await read(ctx, `graph://diff/${c2}/${c3}`);
    const p23 = d23['parts'][0];
    expect(p23.outline_vertices.added + p23.outline_vertices.modified).toBeGreaterThan(0);
    expect(p23.bends.added).toEqual([]);

    expect((await read(ctx, `graph://diff/${c3}/${c3}`))['parts']).toEqual([]);

    const back = await read(ctx, `graph://diff/${c2}/${c1}`);
    expect(back['parts'][0].bends.removed).toEqual([bendId]);
  });

  it('a corrupt historical row → PERSIST_CORRUPT_ROW; the live project still reads', async () => {
    const { ctx, db, partId } = await threeCommits();
    const [row] = await sqlOn(
      db,
      'wip/work',
      "DELETE FROM part_ring WHERE kind = 'outline'",
      "CALL DOLT_COMMIT('-Am', 'corrupt')",
      'SELECT commit_hash AS hash FROM dolt_log LIMIT 1',
    );
    const bad = String(row!['hash']);
    expect(await codeOf(read(ctx, `graph://ref/${bad}/parts`))).toBe('PERSIST_CORRUPT_ROW');
    expect(await codeOf(read(ctx, `graph://ref/${bad}/part/${partId}/mesh`))).toBe('PERSIST_CORRUPT_ROW');
    expect(ctx.store.snapshotPart(partId).part.name).toBe('plate');
  });

  it('a ref at another schema version → PERSIST_SCHEMA_MISMATCH (for reads and diffs)', async () => {
    const { ctx, db, c3 } = await threeCommits();
    const [row] = await sqlOn(
      db,
      'wip/work',
      'DELETE FROM schema_migrations WHERE version = (SELECT v FROM (SELECT MAX(version) AS v FROM schema_migrations) t)',
      "CALL DOLT_COMMIT('-Am', 'older schema')",
      'SELECT commit_hash AS hash FROM dolt_log LIMIT 1',
    );
    const old = String(row!['hash']);
    expect(await codeOf(read(ctx, `graph://ref/${old}/parts`))).toBe('PERSIST_SCHEMA_MISMATCH');
    expect(await codeOf(read(ctx, `graph://diff/${old}/${c3}`))).toBe('PERSIST_SCHEMA_MISMATCH');
  });
});
