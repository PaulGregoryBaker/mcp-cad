import * as fs from 'fs';
import * as path from 'path';
import type { Connection, RowDataPacket } from 'mysql2/promise';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _schema_migrations (
    filename    VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at  DATETIME(3) NOT NULL
  )
`;

interface MigrationRow extends RowDataPacket {
  filename: string;
}

/**
 * Applies all *.sql files in the migrations/ directory in lexical order.
 * Skips files already recorded in _schema_migrations (idempotent).
 */
export async function applyMigrations(connection: Connection): Promise<void> {
  await connection.query(CREATE_MIGRATIONS_TABLE);

  const [applied] = await connection.query<MigrationRow[]>(
    'SELECT filename FROM _schema_migrations ORDER BY filename',
  );
  const appliedSet = new Set((applied as MigrationRow[]).map((r) => r.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Execute each statement individually to avoid multi-statement driver issues.
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await connection.query(stmt);
    }

    await connection.query(
      'INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, NOW(3))',
      [file],
    );
  }
}
