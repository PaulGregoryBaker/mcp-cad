import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import mysql from 'mysql2/promise';
import { dispatchTool, setSemanticStore } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { ErrorCodes } from '../../src/mcp/errors';
import { initSemanticPersistence, session } from '../../src/geometry/session';
import { transactionRegistry } from '../../src/mcp/transactions';
import { geometryBinding } from '../../src/geometry/binding';

const SKIP_DOLT = process.env.SKIP_DOLT === '1';
const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const DATABASE = `transform_test_${Date.now()}`;

describe('Geometric Transformations Integration Tests (Feature 006 US3)', () => {
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

  const dims = (bbox: any) => ({
    dx: bbox.x_max - bbox.x_min,
    dy: bbox.y_max - bbox.y_min,
    dz: bbox.z_max - bbox.z_min,
  });

  it('translates bodies and shifts bounding box', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const originalBbox = await dispatchTool('bounding_box', { target: shell }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'translate-test' }, config) as any;
    const txId = tx.transaction_id;

    const translation = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [shell],
      vector: [100, 50, -20],
      keep_original: false
    }, config) as any;

    expect(translation.solid_id).toBeDefined();
    expect(translation.solid_ids).toContain(translation.solid_id);

    const newBbox = await dispatchTool('bounding_box', { target: translation.solid_id }, config) as any;

    expect(newBbox.x_min - originalBbox.x_min).toBeCloseTo(100, 3);
    expect(newBbox.y_min - originalBbox.y_min).toBeCloseTo(50, 3);
    expect(newBbox.z_min - originalBbox.z_min).toBeCloseTo(-20, 3);
    expect(newBbox.x_max - originalBbox.x_max).toBeCloseTo(100, 3);

    // Verify original is deleted when keep_original is false
    await expect(
      dispatchTool('bounding_box', { target: shell }, config)
    ).rejects.toThrow();

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('translate_body preserves orientation (no implicit rotation)', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const originalBbox = await dispatchTool('bounding_box', { target: shell }, config) as any;
    const originalDims = dims(originalBbox);

    const tx = await dispatchTool('begin_transaction', { label: 'translate-orientation-test' }, config) as any;
    const txId = tx.transaction_id;

    const translation = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [shell],
      vector: [37, -19, 11],
      keep_original: false,
    }, config) as any;

    const movedBbox = await dispatchTool('bounding_box', { target: translation.solid_id }, config) as any;
    const movedDims = dims(movedBbox);

    // Pure translation must preserve axis-aligned extents.
    expect(movedDims.dx).toBeCloseTo(originalDims.dx, 3);
    expect(movedDims.dy).toBeCloseTo(originalDims.dy, 3);
    expect(movedDims.dz).toBeCloseTo(originalDims.dz, 3);

    // Translation delta still must match.
    expect(movedBbox.x_min - originalBbox.x_min).toBeCloseTo(37, 3);
    expect(movedBbox.y_min - originalBbox.y_min).toBeCloseTo(-19, 3);
    expect(movedBbox.z_min - originalBbox.z_min).toBeCloseTo(11, 3);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('rotates bodies around axis', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'rotate-test' }, config) as any;
    const txId = tx.transaction_id;

    const rotation = await dispatchTool('rotate_body', {
      transaction_id: txId,
      targets: [shell],
      axis_origin: [0, 0, 0],
      axis_direction: [0, 0, 1],
      angle_degrees: 90,
      keep_original: true
    }, config) as any;

    expect(rotation.solid_id).toBeDefined();
    expect(rotation.shape_history.length).toBeGreaterThan(0);

    // Verify original is kept in session
    const originalMass = await dispatchTool('mass_properties', { target: shell }, config) as any;
    expect(originalMass.volume).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('mirrors bodies across plane', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const originalBbox = await dispatchTool('bounding_box', { target: shell }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'mirror-test' }, config) as any;
    const txId = tx.transaction_id;

    const mirror = await dispatchTool('mirror_body', {
      transaction_id: txId,
      targets: [shell],
      plane_origin: [0, 0, 0],
      plane_normal: [1, 0, 0], // mirror across YZ plane
      keep_original: false
    }, config) as any;

    expect(mirror.solid_id).toBeDefined();

    const newBbox = await dispatchTool('bounding_box', { target: mirror.solid_id }, config) as any;

    // Negated x coordinates
    expect(newBbox.x_min).toBeCloseTo(-originalBbox.x_max, 3);
    expect(newBbox.x_max).toBeCloseTo(-originalBbox.x_min, 3);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('scales bodies uniformly and rejects non-positive scale', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const originalMass = await dispatchTool('mass_properties', { target: shell }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'scale-test' }, config) as any;
    const txId = tx.transaction_id;

    const scale = await dispatchTool('scale_body', {
      transaction_id: txId,
      targets: [shell],
      origin: [0, 0, 0],
      scale_factor: 1.5,
      keep_original: false
    }, config) as any;

    expect(scale.solid_id).toBeDefined();

    const newMass = await dispatchTool('mass_properties', { target: scale.solid_id }, config) as any;
    // Volume scales by scale_factor^3
    const expectedVolume = originalMass.volume * Math.pow(1.5, 3);
    expect(newMass.volume).toBeCloseTo(expectedVolume, 2);

    // Verify non-positive scale throws GE_SCALE_NON_UNIFORM
    await expect(
      dispatchTool('scale_body', {
        transaction_id: txId,
        targets: [scale.solid_id],
        origin: [0, 0, 0],
        scale_factor: 0,
        keep_original: false
      }, config)
    ).rejects.toMatchObject({
      code: ErrorCodes.GE_SCALE_NON_UNIFORM
    });

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('aligns planar faces and rejects non-planar faces', async () => {
    // 1. Planar face alignment
    const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompA = await dispatchTool('decompose_volume', { solid_id: cleanA.solid_id, strategy: 'Integrity' }, config) as any;
    const shellA = decompA.panel_ids[0];

    const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompB = await dispatchTool('decompose_volume', { solid_id: cleanB.solid_id, strategy: 'Integrity' }, config) as any;
    const shellB = decompB.panel_ids[0];

    const facesA = await dispatchTool('explore_topology', { target: shellA, return_type: 'face' }, config) as any;
    const facesB = await dispatchTool('explore_topology', { target: shellB, return_type: 'face' }, config) as any;

    const tx = await dispatchTool('begin_transaction', { label: 'align-test' }, config) as any;
    const txId = tx.transaction_id;

    const align = await dispatchTool('align_to_face', {
      transaction_id: txId,
      source_face: facesA.entity_ids[0],
      destination_face: facesB.entity_ids[1],
      flip_normal: true,
      keep_original: false
    }, config) as any;

    expect(align.solid_id).toBeDefined();

    // 2. Reject non-planar alignment (explore topology from hollow_cube cylindrical face)
    const cleanC = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    // Explore topological faces for a cylindrical surface
    const graphC = await dispatchTool('explore_topology', { target: cleanC.solid_id, return_type: 'face' }, config) as any;
    
    // Find non-planar face
    let cylindricalFaceId = '';
    const topologyC = geometryBinding.getTopology(cleanC.solid_id);
    for (const f of topologyC.faces) {
      if (f.surfaceType !== 'plane') {
        cylindricalFaceId = f.faceId;
        break;
      }
    }

    if (cylindricalFaceId) {
      await expect(
        dispatchTool('align_to_face', {
          transaction_id: txId,
          source_face: cylindricalFaceId,
          destination_face: facesB.entity_ids[0],
          transaction_id: txId
        }, config)
      ).rejects.toMatchObject({
        code: ErrorCodes.GE_ALIGN_UNSUPPORTED
      });
    }

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('rolls back geometric transformations correctly', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decomp = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    const shell = decomp.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'rollback-transform' }, config) as any;
    const txId = tx.transaction_id;

    const translation = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [shell],
      vector: [200, -100, 300],
      keep_original: false
    }, config) as any;

    expect(translation.solid_id).toBeDefined();

    // Rollback the transaction
    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);

    // Verify original shape is restored
    const originalMass = await dispatchTool('mass_properties', { target: shell }, config) as any;
    expect(originalMass.volume).toBeGreaterThan(0);

    // Verify translated shape is deleted
    await expect(
      dispatchTool('mass_properties', { target: translation.solid_id }, config)
    ).rejects.toThrow();
  });
});
