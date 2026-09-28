/**
 * Migration runner against a real Dolt (spec 010, T018/T025 migration cases).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { currentSchemaVersion, migrateBranch, migrateForOpen, migrationsDir } from '../../src/v2/persistence/migrate';
import { startDolt, type DoltHarness } from '../helpers/dolt-harness';

let h: DoltHarness;
let c: Connection;

async function q(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await c.query<RowDataPacket[]>(sql, params);
  return r;
}

describe('[persist] migrations', () => {
  beforeAll(async () => {
    h = await startDolt();
    c = await h.connect();
  });

  afterAll(async () => {
    delete process.env['MCPCAD_MIGRATIONS_DIR'];
    await c?.end();
    await h?.stop();
  });

  it('a fresh database migrates main to the current version in one system commit', async () => {
    await q('CREATE DATABASE m1');
    const [r] = await migrateForOpen(c, 'm1', 'main');
    expect(r).toMatchObject({ branch: 'main', from: 0, to: currentSchemaVersion(), mode: 'committed' });

    const log = await q('SELECT message, committer FROM dolt_log LIMIT 1');
    expect(String(log[0]!['message'])).toBe(`Migrate schema 0→${currentSchemaVersion()}`);
    expect(await q('SELECT * FROM dolt_status')).toHaveLength(0);

    const tables = (await q('SHOW TABLES')).map((row) => String(Object.values(row)[0]));
    for (const t of ['part', 'part_ring', 'ring_vertex', 'feature', 'region_panel', 'bend', 'action_log', 'meta', 'client_meta', 'project_settings', 'import_source', 'session_state', 'schema_migrations']) {
      expect(tables).toContain(t);
    }
    const meta = await q("SELECT meta_value FROM meta WHERE meta_key = 'schema_version'");
    expect(Number(meta[0]!['meta_value'])).toBe(currentSchemaVersion());
  });

  it('re-running is a no-op', async () => {
    const [r] = await migrateForOpen(c, 'm1', 'main');
    expect(r!.mode).toBe('none');
  });

  it('enforces the constraints (CHECK, ENUM, FK cascade)', async () => {
    await q('USE `m1/main`');
    const anchor = '1,0,0,0,1,0,0,0,1,0,0,0';
    await expect(
      q(`INSERT INTO part VALUES ('p','n','r',${anchor},'m', 0, 0.3, '0.1', NULL)`),
    ).rejects.toThrow(); // thickness 0
    await q(`INSERT INTO part VALUES ('p','n','r',${anchor},'m', 2, 0, '0.1', NULL)`); // kFactor 0 is valid
    await expect(q("INSERT INTO part_ring VALUES ('ring','p','hole', NULL)")).rejects.toThrow(); // hole needs order key
    await expect(q("INSERT INTO part_ring VALUES ('ring','p','spline', NULL)")).rejects.toThrow(); // enum
    await q("INSERT INTO part_ring VALUES ('ring','p','outline', NULL)");
    await q("INSERT INTO ring_vertex VALUES ('v1','ring','a0',0,0,0)");
    await expect(q("INSERT INTO ring_vertex VALUES ('v2','ring','a0',1,0,0)")).rejects.toThrow(); // unique order key
    await q("DELETE FROM part WHERE part_id = 'p'");
    expect(await q('SELECT * FROM ring_vertex')).toHaveLength(0); // cascaded
    await expect(
      q("INSERT INTO action_log (at, actor_kind, actor_id, tool, params, delta_summary, undo_delta) VALUES (NOW(3),'human','u','t','{}','{}',NULL)"),
    ).rejects.toThrow(); // human rows must be undoable
    await q("CALL DOLT_RESET('--hard')");
  });

  it('a future migration: clean branch → committed; dirty branch → uncommitted + system action row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-mig-'));
    for (const f of fs.readdirSync(migrationsDir())) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '003_fake.sql'), 'CREATE TABLE fake_003 (id INT PRIMARY KEY);\n');

    await q('USE `m1/main`');
    await q("CALL DOLT_BRANCH('wip/clean')");
    await q("CALL DOLT_BRANCH('wip/dirty')");
    await q('USE `m1/wip/dirty`');
    await q("INSERT INTO meta VALUES ('user_edit', 'x')"); // uncommitted user work

    process.env['MCPCAD_MIGRATIONS_DIR'] = dir;
    try {
      const clean = await migrateForOpen(c, 'm1', 'wip/clean');
      expect(clean.map((r) => [r.branch, r.mode])).toEqual([
        ['main', 'committed'],
        ['wip/clean', 'committed'],
      ]);
      const dirty = await migrateBranch(c, 'm1', 'wip/dirty');
      expect(dirty.mode).toBe('uncommitted');
      const sys = await q("SELECT actor_kind, tool, undo_delta FROM action_log WHERE tool = 'migrate'");
      expect(sys).toHaveLength(1);
      expect(sys[0]!['actor_kind']).toBe('system');
      expect(sys[0]!['undo_delta']).toBeNull();
      expect((await q('SELECT * FROM meta WHERE meta_key = ?', ['user_edit']))).toHaveLength(1); // user work intact

      // discard -> old schema again; next open migrates again without error.
      // DOLT_RESET --hard alone leaves new *untracked* tables (fake_003) behind;
      // discard_changes must also DOLT_CLEAN() (found here; used by T050).
      await q("CALL DOLT_RESET('--hard')");
      await q('CALL DOLT_CLEAN()');
      const again = await migrateBranch(c, 'm1', 'wip/dirty');
      expect(again.mode).toBe('committed'); // now clean -> committed
    } finally {
      delete process.env['MCPCAD_MIGRATIONS_DIR'];
    }
  });

  it('a branch newer than this server → PERSIST_SCHEMA_UNSUPPORTED', async () => {
    await q('USE `m1/main`');
    await q('INSERT INTO schema_migrations VALUES (999, NOW(3))');
    await expect(migrateBranch(c, 'm1', 'main')).rejects.toMatchObject({
      structured: { code: 'PERSIST_SCHEMA_UNSUPPORTED' },
    });
    await q("CALL DOLT_RESET('--hard')");
  });
});
