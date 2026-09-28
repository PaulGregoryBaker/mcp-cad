/**
 * Dolt capability spike (spec 010, T004).
 *
 * Proves, on the installed Dolt, every server behaviour the persistence
 * design (research R-014–R-016) relies on. If any of these fail, the design
 * — not the test — has to change (or Dolt must be upgraded).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type mysql from 'mysql2/promise';
import { startDolt, type DoltHarness } from '../helpers/dolt-harness';

const DB = 'spike';

let h: DoltHarness;
let c: mysql.Connection;

async function q<T = mysql.RowDataPacket[]>(conn: mysql.Connection, sql: string, params: unknown[] = []): Promise<T> {
  const [rows] = await conn.query(sql, params);
  return rows as T;
}

async function headHash(conn: mysql.Connection): Promise<string> {
  const rows = await q(conn, 'SELECT HASHOF(\'HEAD\') AS h');
  return String(rows[0]!['h']);
}

describe('[persist] Dolt capability spike', () => {
  beforeAll(async () => {
    h = await startDolt();
    c = await h.connect();
    await q(c, `CREATE DATABASE ${DB}`);
    await q(c, `USE ${DB}`);
    await q(
      c,
      `CREATE TABLE part (
         part_id VARCHAR(36) PRIMARY KEY,
         thickness_mm DOUBLE NOT NULL CHECK (thickness_mm > 0),
         kind ENUM('a','b') NOT NULL DEFAULT 'a')`,
    );
    await q(
      c,
      `CREATE TABLE ring (
         ring_id VARCHAR(36) PRIMARY KEY,
         part_id VARCHAR(36) NOT NULL,
         FOREIGN KEY (part_id) REFERENCES part(part_id) ON DELETE CASCADE)`,
    );
    await q(c, 'CREATE TABLE session_state (id TINYINT PRIMARY KEY CHECK (id = 1), current_branch VARCHAR(255) NOT NULL)');
    await q(c, "INSERT INTO dolt_ignore VALUES ('session_state', true)");
    await q(c, "CALL DOLT_COMMIT('-A', '-m', 'schema')");
    await q(c, "CALL DOLT_BRANCH('wip-a')");
  });

  afterAll(async () => {
    await c?.end();
    await h?.stop();
  });

  it('(a) branch-qualified USE isolates writes between branches on one connection', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    await q(c, "INSERT INTO part (part_id, thickness_mm) VALUES ('p1', 2.0)");
    await q(c, `USE \`${DB}/main\``);
    expect(await q(c, 'SELECT * FROM part')).toHaveLength(0);
    await q(c, `USE \`${DB}/wip-a\``);
    expect(await q(c, 'SELECT * FROM part')).toHaveLength(1);
  });

  it('(b) CHECK constraints and ENUM columns reject bad values', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    await expect(q(c, "INSERT INTO part (part_id, thickness_mm) VALUES ('bad', -1)")).rejects.toThrow();
    await expect(q(c, "INSERT INTO part (part_id, thickness_mm, kind) VALUES ('bad2', 1, 'zzz')")).rejects.toThrow();
  });

  it('(c) FOREIGN KEY ON DELETE CASCADE works inside a transaction', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    await q(c, 'START TRANSACTION');
    await q(c, "INSERT INTO part (part_id, thickness_mm) VALUES ('p2', 1.5)");
    await q(c, "INSERT INTO ring (ring_id, part_id) VALUES ('r2', 'p2')");
    await q(c, "DELETE FROM part WHERE part_id = 'p2'");
    await q(c, 'COMMIT');
    expect(await q(c, "SELECT * FROM ring WHERE ring_id = 'r2'")).toHaveLength(0);
    await expect(q(c, "INSERT INTO ring (ring_id, part_id) VALUES ('r3', 'nope')")).rejects.toThrow();
  });

  it('(e) dolt_status reports dirty/clean per branch-qualified session', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    const dirty = await q(c, 'SELECT COUNT(*) AS n FROM dolt_status');
    expect(Number(dirty[0]!['n'])).toBeGreaterThan(0);
    await q(c, `USE \`${DB}/main\``);
    const clean = await q(c, 'SELECT COUNT(*) AS n FROM dolt_status');
    expect(Number(clean[0]!['n'])).toBe(0);
  });

  it('(d) an uncommitted working-set write survives a server restart', async () => {
    await c.end();
    await h.restart();
    c = await h.connect();
    await q(c, `USE \`${DB}/wip-a\``);
    const rows = await q(c, "SELECT * FROM part WHERE part_id = 'p1'");
    expect(rows).toHaveLength(1);
  });

  it('(h) dolt_ignore: session_state lives only in main\'s working set, never committed, invisible to dolt_status', async () => {
    // Created on main's working set in beforeAll; the ignored table never
    // reaches a commit, so branches forked from main don't have it. This is
    // exactly why the design reads/writes it via `<db>/main` (data-model §3).
    await q(c, `USE \`${DB}/main\``);
    await q(c, "INSERT INTO session_state VALUES (1, 'wip-a')");
    expect(await q(c, "SELECT * FROM dolt_status WHERE table_name = 'session_state'")).toHaveLength(0);
    await expect(q(c, "SELECT * FROM session_state AS OF 'HEAD'")).rejects.toThrow();
    await q(c, `USE \`${DB}/wip-a\``);
    await expect(q(c, 'SELECT * FROM session_state')).rejects.toThrow();

    // Committing on the branch with an explicit author works without a global identity.
    await q(c, "CALL DOLT_COMMIT('-A', '--author', 'Tester <t@x.local>', '-m', 'c1')");
    const log = await q(c, 'SELECT committer, message FROM dolt_log LIMIT 1');
    expect(String(log[0]!['message'])).toBe('c1');
    expect(String(log[0]!['committer'])).toBe('Tester');
  });

  it('(f) DOLT_DIFF table function returns row-level changes between commits', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    const c1 = await headHash(c);
    await q(c, "UPDATE part SET thickness_mm = 3.0 WHERE part_id = 'p1'");
    await q(c, "INSERT INTO part (part_id, thickness_mm) VALUES ('p9', 4.0)");
    await q(c, "CALL DOLT_COMMIT('-A', '-m', 'c2')");
    const c2 = await headHash(c);
    const diff = await q(c, `SELECT diff_type, to_part_id FROM DOLT_DIFF(?, ?, 'part') ORDER BY to_part_id`, [c1, c2]);
    const types = diff.map((r) => `${r['diff_type']}:${r['to_part_id']}`);
    expect(types).toEqual(['modified:p1', 'added:p9']);
  });

  it('(g) AS OF works on a second connection while the first holds a branch session', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    const log = await q(c, "SELECT commit_hash FROM dolt_log WHERE message = 'c1'");
    const firstBranchCommit = String(log[0]!['commit_hash']);
    const reader = await h.connect(DB);
    try {
      const rows = await q(reader, `SELECT thickness_mm FROM part AS OF '${firstBranchCommit}' WHERE part_id = 'p1'`);
      expect(Number(rows[0]!['thickness_mm'])).toBe(2);
    } finally {
      await reader.end();
    }
    // the writer's session is untouched
    const now = await q(c, "SELECT thickness_mm FROM part WHERE part_id = 'p1'");
    expect(Number(now[0]!['thickness_mm'])).toBe(3);
  });

  it('(i) DOLT_RESET --hard on a branch-qualified session drops the working set', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    await q(c, "INSERT INTO part (part_id, thickness_mm) VALUES ('tmp', 1.0)");
    await q(c, "CALL DOLT_RESET('--hard')");
    expect(await q(c, "SELECT * FROM part WHERE part_id = 'tmp'")).toHaveLength(0);
  });

  it('(j) STORED generated column from JSON + index (R-013 layer 1 fallback check)', async () => {
    await q(c, `USE \`${DB}/wip-a\``);
    await q(
      c,
      `CREATE TABLE gen_t (id INT PRIMARY KEY, doc JSON NOT NULL CHECK (JSON_VALID(doc)),
         v VARCHAR(16) AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.v'))) STORED, INDEX (v))`,
    );
    await q(c, `INSERT INTO gen_t (id, doc) VALUES (1, '{"v":"0.1"}')`);
    const rows = await q(c, 'SELECT v FROM gen_t WHERE v = ?', ['0.1']);
    expect(rows).toHaveLength(1);
  });
});
