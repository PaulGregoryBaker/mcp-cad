import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import mysql from 'mysql2/promise';
import { dispatchTool, setSemanticStore } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { ErrorCodes } from '../../src/mcp/errors';
import { initSemanticPersistence, session } from '../../src/geometry/session';
import { transactionRegistry } from '../../src/mcp/transactions';

const SKIP_DOLT = process.env.SKIP_DOLT === '1';
const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const DATABASE = `sew_test_${Date.now()}`;

describe('Sewing Operations Integration Tests (Feature 006 US5)', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);
  const simpleBoxPath = getFixturePath('simple_box.stp');

  let adminConn: mysql.Connection | null = null;
  let activePort: any = null;

  beforeAll(async () => {
    if (SKIP_DOLT) return;

    adminConn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
    });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);

    const { port, store } = await initSemanticPersistence({
      driver: 'dolt',
      host: HOST,
      port: PORT,
      database: DATABASE,
      data_dir: './state/dolt',
    });

    activePort = port;
    setSemanticStore(store);
  }, 30_000);

  afterAll(async () => {
    if (SKIP_DOLT) return;

    if (activePort) {
      await activePort.disconnect();
    }
    if (adminConn) {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
      await adminConn.end();
    }
  });

  beforeEach(() => {
    transactionRegistry.reset();
    session.reset();
  });

  it('sews adjacent faces together', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    
    // Get all face IDs of the box
    const facesReport = await dispatchTool('explore_topology', { target: clean.solid_id, return_type: 'face' }, config) as any;
    const faceIds = facesReport.entity_ids;
    expect(faceIds.length).toBe(6);

    const tx = await dispatchTool('begin_transaction', { label: 'sew-test' }, config) as any;
    const txId = tx.transaction_id;

    // Sew 3 adjacent faces of the box
    const sewRes = await dispatchTool('sew_faces', {
      transaction_id: txId,
      targets: [faceIds[0], faceIds[1], faceIds[2]],
      tolerance: 0.1,
      make_solid: false
    }, config) as any;

    expect(sewRes.shell_id).toBeDefined();
    expect(sewRes.sew_complete).toBeDefined();
    expect(sewRes.free_edges.length).toBeGreaterThan(0); // 3 faces cannot form a closed solid, so free edges exist
    expect(sewRes.shape_history.length).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('rolls back sewing on transaction abort', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const facesReport = await dispatchTool('explore_topology', { target: clean.solid_id, return_type: 'face' }, config) as any;
    const faceIds = facesReport.entity_ids;

    const tx = await dispatchTool('begin_transaction', { label: 'sew-rollback-test' }, config) as any;
    const txId = tx.transaction_id;

    const sewRes = await dispatchTool('sew_faces', {
      transaction_id: txId,
      targets: [faceIds[0], faceIds[1]],
      tolerance: 0.1,
      make_solid: false
    }, config) as any;

    expect(sewRes.shell_id).toBeDefined();

    // Discard transaction
    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);

    // Sewn shape should no longer exist in session
    await expect(dispatchTool('bounding_box', { target: sewRes.shell_id }, config)).rejects.toThrow();
  });
});
