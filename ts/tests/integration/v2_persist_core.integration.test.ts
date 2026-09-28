/**
 * Persistence core against a real Dolt (spec 010, T025 + T100).
 * Everything goes through dispatchSessionTool — the MCP server's own path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { dispatchSessionTool } from '../../src/v2/tools/graph';
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

let h: DoltHarness;
let restoreEnv: () => void;
let dbCounter = 0;

function call<T = Record<string, any>>(ctx: SessionContext, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return dispatchSessionTool(ctx, name, args) as Promise<T>;
}

async function newProject(ctx: SessionContext): Promise<string> {
  const database = `t_core_${++dbCounter}`;
  await call(ctx, 'create_project', { account: 'test', database, name: `Core ${dbCounter}` });
  await call(ctx, 'open_project', { account: 'test', database, author: AUTHOR });
  return database;
}

async function sql(database: string, branch: string, q: string): Promise<RowDataPacket[]> {
  const c = await h.connect();
  try {
    await c.query(`USE \`${database}/${branch}\``);
    const [r] = await c.query<RowDataPacket[]>(q);
    return r;
  } finally {
    await c.end();
  }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { structured?: { code: string } }).structured?.code ?? String(e);
  }
}

describe('[persist] core: bind, write-through, reload, isolation', () => {
  const contexts: SessionContext[] = [];
  const ctxFor = (): SessionContext => {
    const c = new SessionContext();
    contexts.push(c);
    return c;
  };

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

  it('unbound: mutating tools → PERSIST_NOT_BOUND; nothing happens in memory', async () => {
    const ctx = ctxFor();
    expect(await codeOf(call(ctx, 'create_part', { name: 'x', outline: RECT, thickness_mm: 2 }))).toBe('PERSIST_NOT_BOUND');
    expect(ctx.store.partIds()).toEqual([]);
  });

  it('create → open → empty; on main edits are refused', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    const state = ctx.requireBound();
    expect(state.database).toBe(db);
    expect(ctx.store.partIds()).toEqual([]);
    expect(await codeOf(call(ctx, 'create_part', { name: 'x', outline: RECT, thickness_mm: 2 }))).toBe('PERSIST_ON_MAIN');
  });

  it('branch_begin → create_part writes rows + one action_log row, no new commit', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    const commitsBefore = (await sql(db, 'main', 'SELECT COUNT(*) AS n FROM dolt_log'))[0]!['n'];
    await call(ctx, 'branch_begin', { label: 'edit-1' });
    const r = await call(ctx, 'create_part', { name: 'plate', outline: RECT, thickness_mm: 2, actor: { kind: 'agent', id: 'claude' } });
    expect(r['action_seq']).toBeGreaterThan(0);

    const parts = await sql(db, 'wip/edit-1', 'SELECT name, thickness_mm FROM part');
    expect(parts).toEqual([{ name: 'plate', thickness_mm: 2 }]);
    expect(await sql(db, 'wip/edit-1', 'SELECT COUNT(*) AS n FROM ring_vertex')).toEqual([{ n: 4 }]);
    const actions = await sql(db, 'wip/edit-1', 'SELECT actor_kind, actor_id, tool FROM action_log');
    expect(actions).toEqual([{ actor_kind: 'agent', actor_id: 'claude', tool: 'create_part' }]);
    const meta = await sql(db, 'wip/edit-1', 'SELECT doc FROM client_meta');
    expect(meta).toHaveLength(1); // default presentation doc for the new part
    const commitsAfter = (await sql(db, 'wip/edit-1', 'SELECT COUNT(*) AS n FROM dolt_log'))[0]!['n'];
    expect(commitsAfter).toBe(commitsBefore); // edits never commit by themselves
  });

  it('close + reopen restores the part exactly, on the same branch, still uncommitted', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'reopen' });
    const created = await call(ctx, 'create_part', { name: 'plate', outline: RECT, thickness_mm: 2, k_factor: 0.4 });
    const bend = await call(ctx, 'create_node', {
      kind: 'bend',
      part_id: created['part_id'],
      parent_region_panel_id: created['root_region_panel_id'],
      hinge_a: { x: 0, y: 40 },
      hinge_b: { x: 100, y: 40 },
      angle_deg: 90,
      radius_mm: 2,
    });
    expect(bend['action_seq']).toBeGreaterThan(0);
    const before = structuredClone(ctx.store.snapshotPart(created['part_id']));

    await call(ctx, 'close_project');
    expect(ctx.store.partIds()).toEqual([]);

    const reopened = await call(ctx, 'open_project', { account: 'test', database: db, author: AUTHOR });
    expect(reopened['branch']).toBe('wip/reopen');
    expect(reopened['dirty']).toBe(true);
    expect(reopened['uncommitted_ops']).toBe(2);
    expect(ctx.store.snapshotPart(created['part_id'])).toEqual(before);
  });

  it('uncommitted work survives a Dolt server restart (SC-003)', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'crash' });
    const created = await call(ctx, 'create_part', { name: 'survivor', outline: RECT, thickness_mm: 3 });
    await ctx.unbind();
    await h.restart();
    const ctx2 = ctxFor();
    await call(ctx2, 'open_project', { account: 'test', database: db, author: AUTHOR });
    expect(ctx2.store.getPart(created['part_id'])?.name).toBe('survivor');
  });

  it('a failed write rolls memory back and leaves no action row', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'fail' });
    const p = ctx.requireBound().persistence;
    const original = p.applyChange.bind(p);
    (p as { applyChange: typeof p.applyChange }).applyChange = async () => {
      throw Object.assign(new Error('boom'), { structured: { code: 'PERSIST_WRITE_FAILED' } });
    };
    expect(await codeOf(call(ctx, 'create_part', { name: 'ghost', outline: RECT, thickness_mm: 2 }))).toBe('PERSIST_WRITE_FAILED');
    (p as { applyChange: typeof p.applyChange }).applyChange = original;
    expect(ctx.store.partIds()).toEqual([]);
    expect(await sql(db, 'wip/fail', 'SELECT COUNT(*) AS n FROM action_log')).toEqual([{ n: 0 }]);
  });

  it('corrupt stored rows are rejected on open, and nothing is loaded', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'corrupt' });
    const created = await call(ctx, 'create_part', { name: 'victim', outline: RECT, thickness_mm: 2 });
    await ctx.unbind();

    const c = await h.connect();
    await c.query(`USE \`${db}/wip/corrupt\``);
    await c.query('UPDATE part SET root_region_panel_id = ? WHERE part_id = ?', ['nope', created['part_id']]);
    await c.end();

    const ctx2 = ctxFor();
    expect(await codeOf(call(ctx2, 'open_project', { account: 'test', database: db, author: AUTHOR }))).toBe('PERSIST_INVARIANT_VIOLATION');
    expect(ctx2.store.partIds()).toEqual([]);
    expect(ctx2.bound).toBeNull();

    const c2 = await h.connect();
    await c2.query(`USE \`${db}/wip/corrupt\``);
    await c2.query("UPDATE part SET root_region_panel_id = (SELECT region_panel_id FROM region_panel LIMIT 1)");
    await c2.query("DELETE FROM part_ring WHERE kind = 'outline'");
    await c2.end();
    expect(await codeOf(call(ctx2, 'open_project', { account: 'test', database: db, author: AUTHOR }))).toBe('PERSIST_CORRUPT_ROW');
    expect(ctx2.store.partIds()).toEqual([]);
  });

  it('opening project B after A leaves no A parts (FR-005)', async () => {
    const ctx = ctxFor();
    await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'a' });
    await call(ctx, 'create_part', { name: 'from-A', outline: RECT, thickness_mm: 2 });
    await newProject(ctx);
    expect(ctx.store.partIds()).toEqual([]);
  });

  it('refresh_project while dirty returns the uncommitted state', async () => {
    const ctx = ctxFor();
    await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'refresh' });
    const created = await call(ctx, 'create_part', { name: 'r', outline: RECT, thickness_mm: 2 });
    const r = await call(ctx, 'refresh_project');
    expect(r['dirty']).toBe(true);
    expect(r['parts']).toEqual([{ part_id: created['part_id'], merged_into_part_id: null }]);
  });

  it('update_project_settings (T100) is validated, saved as one undoable action, and survives refresh', async () => {
    const ctx = ctxFor();
    await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'settings' });
    expect(await codeOf(call(ctx, 'update_project_settings', { nesting: { sheets: [] } }))).toBe('SETTINGS_INVALID');
    const nesting = { sheets: [{ widthMm: 3000, heightMm: 1500 }], safetyGapMm: 5, sheetMarginMm: 5, cuttingWidthMm: 0.2, rotationsDeg: [0, 90] };
    const r = await call(ctx, 'update_project_settings', { nesting });
    expect(r['action_seq']).toBeGreaterThan(0);
    const refreshed = await call(ctx, 'refresh_project');
    expect(refreshed['settings']['nesting']).toEqual(nesting);
    expect(refreshed['uncommitted_ops']).toBe(1);
  });

  it('branch_begin: forks from a viewed commit; refuses to replace a dirty branch; replaces a clean one on request', async () => {
    const ctx = ctxFor();
    const db = await newProject(ctx);
    await call(ctx, 'branch_begin', { label: 'first' });
    await call(ctx, 'create_part', { name: 'p1', outline: RECT, thickness_mm: 2 });
    // dirty wip exists → a new branch never replaces it
    expect(await codeOf(call(ctx, 'branch_begin', { label: 'second', replace_existing: true }))).toBe('COMMIT_UNCOMMITTED_CHANGES');
    await call(ctx, 'commit', { message: 'p1 added' });
    const head = (await sql(db, 'wip/first', "SELECT HASHOF('HEAD') AS h"))[0]!['h'] as string;
    // clean wip exists → BRANCH_ALREADY_OPEN unless replace_existing
    expect(await codeOf(call(ctx, 'branch_begin', { label: 'second' }))).toBe('BRANCH_ALREADY_OPEN');
    const r = await call(ctx, 'branch_begin', { label: 'second', replace_existing: true });
    expect(r).toMatchObject({ branch: 'wip/second', forked_from: 'wip/first' });
    expect((await sql(db, 'wip/second', "SELECT HASHOF('HEAD') AS h"))[0]!['h']).toBe(head);
  });
});
