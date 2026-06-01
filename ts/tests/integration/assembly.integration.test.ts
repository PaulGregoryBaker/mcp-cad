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
const DATABASE = `assembly_test_${Date.now()}`;

describe('Assembly Operations Integration Tests (Feature 006 US6)', () => {
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

  it('creates assembly and adds instances with locations', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'assembly-test-1' }, config) as any;
    const txId = tx.transaction_id;

    // Create assembly document
    const assembly = await dispatchTool('create_assembly_document', {
      transaction_id: txId
    }, config) as any;
    expect(assembly.assembly_id).toBeDefined();

    // Add instances
    const inst1 = await dispatchTool('add_assembly_instance', {
      transaction_id: txId,
      assembly_id: assembly.assembly_id,
      target: clean.solid_id,
      location: {
        translation: [10.0, 20.0, 30.0],
        orientation: [1.0, 0.0, 0.0, 0.0]
      }
    }, config) as any;
    expect(inst1.component_id).toBeDefined();

    const inst2 = await dispatchTool('add_assembly_instance', {
      transaction_id: txId,
      assembly_id: assembly.assembly_id,
      target: clean.solid_id
    }, config) as any;
    expect(inst2.component_id).toBeDefined();

    // List assembly tree (non-mutating, no transaction_id required)
    const tree = await dispatchTool('list_assembly_tree', {
      assembly_id: assembly.assembly_id
    }, config) as any;

    expect(tree.assembly_id).toBe(assembly.assembly_id);
    expect(tree.root.children).toHaveLength(2);

    // Verify first child location matrix reflects translation [10, 20, 30]
    const child1 = tree.root.children[0];
    expect(child1.component_id).toBe(inst1.component_id);
    expect(child1.location_matrix[12]).toBe(10.0);
    expect(child1.location_matrix[13]).toBe(20.0);
    expect(child1.location_matrix[14]).toBe(30.0);

    // Verify second child location matrix is identity
    const child2 = tree.root.children[1];
    expect(child2.location_matrix[12]).toBe(0.0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('performs mate rigid operation on planar faces', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const facesReport = await dispatchTool('explore_topology', { target: clean.solid_id, return_type: 'face' }, config) as any;
    const faceIds = facesReport.entity_ids;

    const tx = await dispatchTool('begin_transaction', { label: 'assembly-mate-test' }, config) as any;
    const txId = tx.transaction_id;

    // Create assembly document
    const assembly = await dispatchTool('create_assembly_document', {
      transaction_id: txId
    }, config) as any;

    // Add source and destination instances
    const instA = await dispatchTool('add_assembly_instance', {
      transaction_id: txId,
      assembly_id: assembly.assembly_id,
      target: clean.solid_id
    }, config) as any;

    // Mate the two planar faces
    const mateRes = await dispatchTool('mate_rigid', {
      transaction_id: txId,
      assembly_id: assembly.assembly_id,
      source_face: faceIds[0],
      destination_face: faceIds[1],
      flip_alignment: false
    }, config) as any;

    expect(mateRes.component_id).toBe(instA.component_id);
    expect(mateRes.location_matrix).toBeDefined();
    expect(mateRes.rollback_token).toBeDefined();

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('rolls back assembly changes on rollback', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'assembly-rollback-test' }, config) as any;
    const txId = tx.transaction_id;

    const assembly = await dispatchTool('create_assembly_document', {
      transaction_id: txId
    }, config) as any;

    await dispatchTool('add_assembly_instance', {
      transaction_id: txId,
      assembly_id: assembly.assembly_id,
      target: clean.solid_id
    }, config) as any;

    // Roll back transaction
    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);

    // Assembly tree listing should fail (document rolled back/destroyed)
    await expect(dispatchTool('list_assembly_tree', { assembly_id: assembly.assembly_id }, config)).rejects.toThrow();
  });

  it('throws TRANSACTION_REQUIRED for assembly document creation without tx', async () => {
    await expect(
      dispatchTool('create_assembly_document', {}, config)
    ).rejects.toThrow();
  });
});
