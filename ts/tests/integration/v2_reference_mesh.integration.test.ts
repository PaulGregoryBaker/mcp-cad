/**
 * T086 (spec 010 US5): reference_mesh re-imports an import source with its
 * stored config — same geometry as the preview under that config — reports
 * file_changed, fails clearly when the file is gone, and never writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { dispatchSessionTool } from '../../src/v2/tools/graph';
import { SessionContext } from '../../src/v2/persistence/session';
import { readSessionResource } from '../../src/v2/resources/session';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import { v2BlobCache } from '../../src/v2/blob-cache';
import { startDolt, withTestAccount, type DoltHarness } from '../helpers/dolt-harness';

const FIXTURE = path.resolve(__dirname, '../../../cpp/tests/fixtures/l_bracket_corner_90deg.stp');
const AUTHOR = { name: 'Pat Tester', email: 'pat@example.test' };
const DEFAULTS = { defaultMaterial: 'mildSteel', defaultThicknessMm: 1.5, unitSystem: 'metric', preferredBendProcesses: ['airBend'] };
const CONFIG = {
  scale: { preset: 'mm', factor: 1 },
  rotation: { xQuarterTurns: 1, yQuarterTurns: 0, zQuarterTurns: 1 },
  recenter: { xy: true, z: 'floor' },
  thicknessMm: 1.5,
  materialId: 'mildSteel',
};

let h: DoltHarness;
let restoreEnv: () => void;
let tmp: string;
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

async function count(db: string, table: string): Promise<number> {
  const c = await h.connect();
  try {
    const [r] = await c.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${db}/wip/work\`.${table}`);
    return Number(r[0]!['n']);
  } finally {
    await c.end();
  }
}

/** A project with the fixture (copied to a temp file) imported under CONFIG. */
async function imported() {
  const ctx = new SessionContext();
  contexts.push(ctx);
  const db = `t_refmesh_${++n}`;
  const file = path.join(tmp, `bracket_${n}.stp`);
  fs.copyFileSync(FIXTURE, file);
  await call(ctx, 'create_project', { account: 'test', database: db, name: `M${n}` });
  await call(ctx, 'open_project', { account: 'test', database: db, author: AUTHOR });
  await call(ctx, 'branch_begin', { label: 'work' });
  await call(ctx, 'update_project_settings', { manufacturing_defaults: DEFAULTS });
  const r = await call(ctx, 'import_part', { file, config: CONFIG });
  return { ctx, db, file, sourceId: r['import_source_id'] as string };
}

const glbSize = (url: string) => v2BlobCache.get(url.split('/v2-blob/')[1]!)!.buffer.length;

describe('[persist] reference_mesh', () => {
  beforeAll(async () => {
    h = await startDolt();
    restoreEnv = withTestAccount(h);
    resetStorageAccountsCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-refmesh-'));
  });
  afterEach(async () => {
    for (const c of contexts.splice(0)) await c.unbind();
  });
  afterAll(async () => {
    restoreEnv?.();
    await h?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('graph://import-sources lists the import; reference_mesh equals the preview under the stored config; no writes', async () => {
    const { ctx, db, file, sourceId } = await imported();
    const sources = (await readSessionResource(ctx, 'graph://import-sources')) as { sources: Array<Record<string, unknown>> };
    expect(sources.sources).toEqual([{ import_source_id: sourceId, file_path: file, imported_at: expect.any(String) }]);

    const opsBefore = await count(db, 'action_log');
    const partsBefore = structuredClone(ctx.store.partIds().map((id) => ctx.store.snapshotPart(id)));
    const ref = await call(ctx, 'reference_mesh', { import_source_id: sourceId });
    expect(ref['file_changed']).toBe(false);
    expect(ref['glb_url']).toMatch(/\/v2-blob\/reference\//);

    // Same geometry as the preview under the stored config.
    const preview = await call(ctx, 'preview_import', { file, config: CONFIG });
    expect(glbSize(ref['glb_url'])).toBe(glbSize(preview['glb_url']));
    expect(preview['bbox_mm'].z_min).toBeCloseTo(0, 6);

    expect(await count(db, 'action_log')).toBe(opsBefore);
    expect(ctx.store.partIds().map((id) => ctx.store.snapshotPart(id))).toEqual(partsBefore);
  });

  it('file_changed when the file on disk differs from the imported one', async () => {
    const { ctx, file, sourceId } = await imported();
    fs.appendFileSync(file, '\n/* edited */\n');
    const ref = await call(ctx, 'reference_mesh', { import_source_id: sourceId });
    expect(ref['file_changed']).toBe(true);
  });

  it('a missing file → IMPORT_SOURCE_MISSING; an unknown id → IMPORT_SOURCE_NOT_FOUND', async () => {
    const { ctx, file, sourceId } = await imported();
    fs.rmSync(file);
    expect(await codeOf(call(ctx, 'reference_mesh', { import_source_id: sourceId }))).toBe('IMPORT_SOURCE_MISSING');
    expect(await codeOf(call(ctx, 'reference_mesh', { import_source_id: 'nope' }))).toBe('IMPORT_SOURCE_NOT_FOUND');
  });
});
