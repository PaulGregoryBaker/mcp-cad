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
const DATABASE = `direct_edits_test_${Date.now()}`;

describe('Direct Edit Operations Integration Tests (Feature 006 US4)', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);
  const simpleBoxPath = getFixturePath('simple_box.stp');
  const hollowCubePath = getFixturePath('hollow_cube.stp');

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

  it('fillets and chamfers edges of a body', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    // Find edges
    const edgesReport = await dispatchTool('explore_topology', { target: shell, return_type: 'edge' }, config) as any;
    expect(edgesReport.entity_ids.length).toBeGreaterThan(0);
    const targetEdge = edgesReport.entity_ids[0];

    // Begin transaction
    const tx = await dispatchTool('begin_transaction', { label: 'fillet-chamfer-test' }, config) as any;
    const txId = tx.transaction_id;

    // Fillet edge
    const filletRes = await dispatchTool('fillet_edges', {
      transaction_id: txId,
      part_id: shell,
      targets: [targetEdge],
      radius: 2.0
    }, config) as any;

    expect(filletRes.solid_id).toBeDefined();
    expect(filletRes.shape_history.length).toBeGreaterThan(0);

    // Chamfer edge on the filleted result
    const edgesReport2 = await dispatchTool('explore_topology', { target: filletRes.solid_id, return_type: 'edge' }, config) as any;
    const targetEdge2 = edgesReport2.entity_ids[edgesReport2.entity_ids.length - 1];

    const chamferRes = await dispatchTool('chamfer_edges', {
      transaction_id: txId,
      part_id: filletRes.solid_id,
      targets: [targetEdge2],
      distance: 1.5
    }, config) as any;

    expect(chamferRes.solid_id).toBeDefined();
    expect(chamferRes.shape_history.length).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('throws GE_FILLET_TOO_LARGE for overly large fillet radius', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const edgesReport = await dispatchTool('explore_topology', { target: shell, return_type: 'edge' }, config) as any;
    const targetEdge = edgesReport.entity_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'large-fillet-test' }, config) as any;
    const txId = tx.transaction_id;

    await expect(
      dispatchTool('fillet_edges', {
        transaction_id: txId,
        part_id: shell,
        targets: [targetEdge],
        radius: 500.0 // ridiculously large for the fixture
      }, config)
    ).rejects.toThrow();

    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
  });

  it('simplifies same domain topology', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'simplify-test' }, config) as any;
    const txId = tx.transaction_id;

    const simplifyRes = await dispatchTool('simplify_body', {
      transaction_id: txId,
      part_id: shell,
      unify_faces: true,
      unify_edges: true
    }, config) as any;

    expect(simplifyRes.solid_id).toBeDefined();
    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('heals advanced geometry', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'heal-test' }, config) as any;
    const txId = tx.transaction_id;

    const healRes = await dispatchTool('heal_geometry_ex', {
      transaction_id: txId,
      part_id: clean.solid_id,
      fix_tolerances: true,
      fix_wires: true
    }, config) as any;

    expect(healRes.solid_id).toBeDefined();
    expect(healRes.heal_complete).toBe(true);
    expect(healRes.remaining_issues).toHaveLength(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('offsets boundary of a solid', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const originalBbox = await dispatchTool('bounding_box', { target: shell }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'offset-test' }, config) as any;
    const txId = tx.transaction_id;

    const offsetRes = await dispatchTool('offset_shape', {
      transaction_id: txId,
      part_id: shell,
      offset_value: 5.0
    }, config) as any;

    expect(offsetRes.solid_id).toBeDefined();

    const newBbox = await dispatchTool('bounding_box', { target: offsetRes.solid_id }, config) as any;

    // Outward offset increases bounding box size
    expect(newBbox.x_max - originalBbox.x_max).toBeGreaterThan(0);
    expect(originalBbox.x_min - newBbox.x_min).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('deletes faces from a shell', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const facesReport = await dispatchTool('explore_topology', { target: shell, return_type: 'face' }, config) as any;
    expect(facesReport.entity_ids.length).toBeGreaterThan(0);
    const targetFace = facesReport.entity_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'delete-face-test' }, config) as any;
    const txId = tx.transaction_id;

    const deleteRes = await dispatchTool('delete_face', {
      transaction_id: txId,
      part_id: shell,
      targets: [targetFace],
      heal_remaining: true
    }, config) as any;

    expect(deleteRes.solid_ids).toBeDefined();
    expect(deleteRes.solid_ids.length).toBeGreaterThan(0);
    expect(deleteRes.shape_history.length).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });
});
