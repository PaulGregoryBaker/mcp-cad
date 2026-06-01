/**
 * Dolt smoke test — Phase 1 checkpoint for the Semantic Mapping Layer.
 *
 * Skipped when SKIP_DOLT=1 (PR-CI where Dolt is not installed).
 * Requires a running dolt sql-server on DOLT_HOST:DOLT_PORT (default 127.0.0.1:3306).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { applyMigrations } from '../../src/semantic/migration_runner';
import { DoltAdapter } from '../../src/semantic/dolt_adapter';

const SKIP = process.env.SKIP_DOLT === '1';

const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const DATABASE = `smoke_test_${Date.now()}`;

describe.skipIf(SKIP)('Dolt smoke test', () => {
  let adminConn: mysql.Connection;
  let adapter: DoltAdapter;

  beforeAll(async () => {
    // Create a fresh isolated database for this run.
    adminConn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
    });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);

    adapter = new DoltAdapter({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
      database: DATABASE,
    });
    await adapter.connect();

    // Apply migrations via a fresh single connection.
    const migrationConn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
      database: DATABASE,
    });
    await applyMigrations(migrationConn);
    await migrationConn.end();
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await adminConn.end();
  });

  it('inserts and reads back a semantic_entity row', async () => {
    const txId = 'txn-smoke-001';

    await adapter.insertTransaction({
      id: txId,
      label: 'smoke test',
      product: 'test',
      state: 'active',
      started_at: new Date(),
    });

    await adapter.insertEntity({
      id: 'semantic://test/smoke_panel',
      type: 'panel',
      purpose: ['smoke_test'],
      transaction_id: txId,
    });

    const entity = await adapter.findEntity('semantic://test/smoke_panel');

    expect(entity).not.toBeNull();
    expect(entity!.id).toBe('semantic://test/smoke_panel');
    expect(entity!.type).toBe('panel');
    expect(entity!.purpose).toEqual(['smoke_test']);
    expect(entity!.state).toBe('confirmed');
    expect(entity!.created_in_transaction).toBe(txId);
  });

  it('migrations are idempotent — applying twice does not error', async () => {
    const migrationConn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
      database: DATABASE,
    });
    await expect(applyMigrations(migrationConn)).resolves.not.toThrow();
    await migrationConn.end();
  });
});
