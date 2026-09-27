/**
 * SQL migration runner, per branch (spec 010, T018; R-016 layer 4 as revised).
 *
 * Migrations are `migrations/NNN_*.sql`, applied in order and recorded in
 * `schema_migrations` (which is itself versioned, so each branch knows its own
 * schema version). `meta.schema_version` mirrors the highest applied version.
 *
 * migrateForOpen() migrates `main` first, then the session branch:
 *  - main (always clean — it only receives merges) and any clean branch: the
 *    migration is committed as "Migrate schema N→M", authored by `system`.
 *  - a dirty branch: the migration joins the user's uncommitted work, plus a
 *    non-undoable `action_log` row (actor_kind 'system', undo_delta NULL);
 *    it is committed with the user's next commit.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { ErrorCodes, throwError } from '../../mcp/errors';
import { redactSecrets } from './accounts';

/** Migrations directory; MCPCAD_MIGRATIONS_DIR overrides it (tests add fake future migrations). */
export function migrationsDir(): string {
  return process.env['MCPCAD_MIGRATIONS_DIR'] || path.join(__dirname, 'migrations');
}
export const SYSTEM_AUTHOR = 'Form·AI·tion system <system@formaition.local>';

export interface MigrationFile {
  version: number;
  name: string;
  sql: string;
}

let cache: { dir: string; files: MigrationFile[] } | null = null;

export function loadMigrations(dir = migrationsDir()): MigrationFile[] {
  if (cache && cache.dir === dir) return cache.files;
  if (!fs.existsSync(dir)) {
    throwError(ErrorCodes.PERSIST_MIGRATION_FAILED, `migrations directory missing: ${dir} (did the build copy *.sql?)`, false);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
  files.forEach((m, i) => {
    if (m.version !== i + 1) {
      throwError(ErrorCodes.PERSIST_MIGRATION_FAILED, `migration numbering gap at ${m.name} (expected ${String(i + 1).padStart(3, '0')})`, false);
    }
  });
  cache = { dir, files };
  return files;
}

export function currentSchemaVersion(): number {
  const m = loadMigrations();
  return m.length === 0 ? 0 : m[m.length - 1]!.version;
}

/** Splits a migration into statements: strips `--` comments, splits on `;` at line end. */
export function splitStatements(sql: string): string[] {
  const noComments = sql
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function rows(conn: Connection, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await conn.query<RowDataPacket[]>(sql, params);
  return r;
}

async function useRef(conn: Connection, db: string, ref: string): Promise<void> {
  await conn.query(`USE \`${db}/${ref}\``);
}

/** Highest applied migration version on the connection's current branch. */
export async function appliedVersion(conn: Connection): Promise<number> {
  const exists = await rows(conn, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'");
  if (Number(exists[0]?.['n'] ?? 0) === 0) return 0;
  const r = await rows(conn, 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  return Number(r[0]?.['v'] ?? 0);
}

/** Schema version at any ref, without switching the writer (for compare). */
export async function schemaVersionAt(reader: Connection, db: string, ref: string): Promise<number> {
  try {
    const r = await rows(reader, `SELECT COALESCE(MAX(version), 0) AS v FROM \`${db}\`.schema_migrations AS OF ?`, [ref]);
    return Number(r[0]?.['v'] ?? 0);
  } catch {
    return 0;
  }
}

export async function isDirty(conn: Connection): Promise<boolean> {
  const r = await rows(conn, 'SELECT COUNT(*) AS n FROM dolt_status');
  return Number(r[0]?.['n'] ?? 0) > 0;
}

export interface BranchMigrationResult {
  branch: string;
  from: number;
  to: number;
  mode: 'none' | 'committed' | 'uncommitted';
}

/** Migrates one branch of `db` to the current schema. The connection is left on that branch. */
export async function migrateBranch(conn: Connection, db: string, branch: string): Promise<BranchMigrationResult> {
  await useRef(conn, db, branch);
  const latest = currentSchemaVersion();
  const from = await appliedVersion(conn);
  if (from > latest) {
    throwError(
      ErrorCodes.PERSIST_SCHEMA_UNSUPPORTED,
      `branch '${branch}' of ${db} is at schema ${from}, newer than this server supports (${latest}). Upgrade the MCP server.`,
      false,
    );
  }
  if (from === latest) return { branch, from, to: from, mode: 'none' };

  const dirtyBefore = await isDirty(conn);
  const pending = loadMigrations().filter((m) => m.version > from);
  await conn.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INT NOT NULL PRIMARY KEY, applied_at TIMESTAMP(3) NOT NULL)',
  );
  for (const m of pending) {
    try {
      for (const stmt of splitStatements(m.sql)) await conn.query(stmt);
      await conn.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, NOW(3))', [m.version]);
      await conn.query(
        "INSERT INTO meta (meta_key, meta_value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)",
        [String(m.version)],
      );
    } catch (e) {
      throwError(
        ErrorCodes.PERSIST_MIGRATION_FAILED,
        `migration ${m.name} failed on branch '${branch}' of ${db}: ${redactSecrets(String((e as Error).message ?? e))}`,
        false,
        undefined,
        { details: { file: m.name, branch, database: db } },
      );
    }
  }

  const summary = `Migrate schema ${from}→${latest}`;
  if (!dirtyBefore) {
    await conn.query("CALL DOLT_COMMIT('-A', '--author', ?, '-m', ?)", [SYSTEM_AUTHOR, summary]);
    return { branch, from, to: latest, mode: 'committed' };
  }
  await conn.query(
    `INSERT INTO action_log (at, actor_kind, actor_id, tool, params, delta_summary, undo_delta, undone)
     VALUES (NOW(3), 'system', 'system', 'migrate', ?, ?, NULL, FALSE)`,
    [JSON.stringify({}), JSON.stringify({ from, to: latest, summary })],
  );
  return { branch, from, to: latest, mode: 'uncommitted' };
}

/** main first, then the session branch (if different). Leaves the connection on the session branch. */
export async function migrateForOpen(conn: Connection, db: string, sessionBranch: string): Promise<BranchMigrationResult[]> {
  const results = [await migrateBranch(conn, db, 'main')];
  if (sessionBranch !== 'main') results.push(await migrateBranch(conn, db, sessionBranch));
  return results;
}
