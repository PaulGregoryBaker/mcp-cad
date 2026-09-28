/**
 * Versioning against a real Dolt (spec 010, T052; research R-015):
 * user-selected commits, action-log undo, discard, merge, checkout.
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

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { structured?: { code: string } }).structured?.code ?? String(e);
  }
}

async function bound(): Promise<{ ctx: SessionContext; db: string }> {
  const ctx = new SessionContext();
  contexts.push(ctx);
  const db = `t_ver_${++n}`;
  await call(ctx, 'create_project', { account: 'test', database: db, name: `V${n}` });
  await call(ctx, 'open_project', { account: 'test', database: db, author: AUTHOR });
  await call(ctx, 'branch_begin', { label: 'work' });
  return { ctx, db };
}

async function commitCount(db: string, branch: string): Promise<number> {
  const c = await h.connect();
  try {
    const [r] = await c.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${db}/${branch}\`.dolt_log`);
    return Number(r[0]!['n']);
  } finally {
    await c.end();
  }
}

const part = (ctx: SessionContext, name: string, actor?: Record<string, unknown>) =>
  call(ctx, 'create_part', { name, outline: RECT, thickness_mm: 2, ...(actor ? { actor } : {}) });

describe('[persist] versioning', () => {
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

  it('edits never commit; undo walks back and survives a restart; never past the last commit', async () => {
    const { ctx, db } = await bound();
    const commits = await commitCount(db, 'wip/work');
    await part(ctx, 'a');
    await part(ctx, 'b');
    await part(ctx, 'c');
    expect(await commitCount(db, 'wip/work')).toBe(commits);

    const u1 = await call(ctx, 'undo');
    expect(u1['uncommitted_ops']).toBe(2);
    await call(ctx, 'undo');
    expect(ctx.store.partIds()).toHaveLength(1);

    await ctx.unbind();
    await h.restart();
    const ctx2 = new SessionContext();
    contexts.push(ctx2);
    const reopened = await call(ctx2, 'open_project', { account: 'test', database: db, author: AUTHOR });
    expect(reopened['uncommitted_ops']).toBe(1);
    expect(ctx2.store.partIds()).toHaveLength(1);

    await call(ctx2, 'undo');
    expect(ctx2.store.partIds()).toHaveLength(0);
    expect(await codeOf(call(ctx2, 'undo'))).toBe('UNDO_NOTHING_UNCOMMITTED');
  });

  it('a new edit after undo drops the undone operation (linear history)', async () => {
    const { ctx } = await bound();
    await part(ctx, 'a');
    await part(ctx, 'b');
    await call(ctx, 'undo');
    await part(ctx, 'c');
    const working = (await readSessionResource(ctx, 'graph://ref/WORKING/actions')) as { actions: Array<{ undone: boolean }> };
    expect(working.actions).toHaveLength(2);
    expect(working.actions.every((a) => !a.undone)).toBe(true);
  });

  it('commit creates exactly one revision containing its operations; nothing-to-commit is an error', async () => {
    const { ctx, db } = await bound();
    const before = await commitCount(db, 'wip/work');
    await part(ctx, 'a');
    await part(ctx, 'b', { kind: 'agent', id: 'claude' });
    const r = await call(ctx, 'commit', { message: 'Two parts' });
    expect(r['ops']).toBe(2);
    expect((await call(ctx, 'refresh_project'))['unmerged_commits']).toBe(1);
    expect(await commitCount(db, 'wip/work')).toBe(before + 1);

    const history = (await readSessionResource(ctx, 'graph://history')) as {
      dirty: boolean;
      commits: Array<{ hash: string; message: string; op_count: number; agent_op_count: number; author_name: string }>;
    };
    expect(history.dirty).toBe(false);
    expect(history.commits[0]).toMatchObject({ message: 'Two parts', op_count: 2, agent_op_count: 1, author_name: 'Pat Tester' });

    const actions = (await readSessionResource(ctx, `graph://ref/${history.commits[0]!.hash}/actions`)) as {
      actions: Array<{ tool: string; actor_kind: string }>;
    };
    expect(actions.actions.map((a) => a.actor_kind)).toEqual(['human', 'agent']);
    expect(await codeOf(call(ctx, 'commit', { message: 'empty' }))).toBe('COMMIT_NOTHING_TO_COMMIT');

    // A later commit lists only its own operations — by hash and by branch name.
    await part(ctx, 'c');
    await call(ctx, 'commit', { message: 'Third part' });
    const h2 = (await readSessionResource(ctx, 'graph://history')) as { commits: Array<{ hash: string }> };
    for (const ref of [h2.commits[0]!.hash, encodeURIComponent('wip/work')]) {
      const later = (await readSessionResource(ctx, `graph://ref/${ref}/actions`)) as { actions: Array<{ tool: string }> };
      expect(later.actions).toHaveLength(1);
    }
    const earlier = (await readSessionResource(ctx, `graph://ref/${h2.commits[1]!.hash}/actions`)) as { actions: unknown[] };
    expect(earlier.actions).toHaveLength(2);
  });

  it('discard_changes returns to the last commit (including removing new tables/rows)', async () => {
    const { ctx } = await bound();
    await part(ctx, 'kept');
    await call(ctx, 'commit', { message: 'kept' });
    await part(ctx, 'dropped');
    const r = await call(ctx, 'discard_changes');
    expect(r['dirty']).toBe(false);
    expect([...ctx.store.partIds()].map((id) => ctx.store.getPart(id)!.name)).toEqual(['kept']);
  });

  it('merge requires a clean branch, merges --no-ff into main and closes the branch', async () => {
    const { ctx, db } = await bound();
    await part(ctx, 'x');
    expect(await codeOf(call(ctx, 'branch_merge', { message: 'm' }))).toBe('COMMIT_UNCOMMITTED_CHANGES');
    await call(ctx, 'commit', { message: 'x' });
    await call(ctx, 'branch_merge', { message: 'Accept x' });
    expect(ctx.requireBound().persistence.branch).toBe('main');
    const history = (await readSessionResource(ctx, 'graph://history')) as {
      branches: Array<{ name: string }>;
      commits: Array<{ message: string; parents: string[] }>;
    };
    expect(history.branches.map((b) => b.name)).toEqual(['main']);
    expect(history.commits[0]!.message).toBe('Accept x');
    expect(history.commits[0]!.parents).toHaveLength(2);
    expect(await commitCount(db, 'main')).toBeGreaterThan(2);
    expect(ctx.store.partIds()).toHaveLength(1);
  });

  it('checkout: refused while dirty; a commit hash is read-only; branch_discard returns to main', async () => {
    const { ctx } = await bound();
    await part(ctx, 'first');
    await call(ctx, 'commit', { message: 'first' });
    const history = (await readSessionResource(ctx, 'graph://history')) as { commits: Array<{ hash: string }> };
    const firstCommit = history.commits[0]!.hash;
    await part(ctx, 'second');
    expect(await codeOf(call(ctx, 'checkout', { ref: firstCommit }))).toBe('COMMIT_UNCOMMITTED_CHANGES');
    await call(ctx, 'commit', { message: 'second' });

    const viewed = await call(ctx, 'checkout', { ref: firstCommit });
    expect(viewed['read_only_ref']).toBe(firstCommit);
    expect(ctx.store.partIds()).toHaveLength(1);
    expect(await codeOf(part(ctx, 'nope'))).toBe('PERSIST_READ_ONLY_REF');

    const back = await call(ctx, 'checkout', { ref: 'wip/work' });
    expect(back['read_only_ref']).toBeNull();
    expect(ctx.store.partIds()).toHaveLength(2);

    await call(ctx, 'branch_discard');
    expect(ctx.requireBound().persistence.branch).toBe('main');
    expect(ctx.store.partIds()).toHaveLength(0);
  });

  it('undo also reverses settings writes', async () => {
    const { ctx } = await bound();
    const nesting = { sheets: [{ widthMm: 3000, heightMm: 1500 }], safetyGapMm: 5, sheetMarginMm: 5, cuttingWidthMm: 0.2, rotationsDeg: [0] };
    await call(ctx, 'update_project_settings', { nesting });
    const u = await call(ctx, 'undo');
    expect(u['settings']['nesting']).toBeNull();
  });
});
