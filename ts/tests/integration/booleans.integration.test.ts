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
const DATABASE = `boolean_test_${Date.now()}`;

describe('Boolean Operations Integration Tests (Feature 006 US1)', () => {
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

  it('fuses overlapping solids and detects disjoint panels', async () => {
    // 1. Overlapping solids (simple_box.stp loaded twice, same face panel from each)
    const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const splitA = await dispatchTool('split_body_by_bends', {
      part_id: cleanA.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const shellA = splitA.panel_ids[0];

    const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const splitB = await dispatchTool('split_body_by_bends', {
      part_id: cleanB.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const shellB = splitB.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'fuse-overlapping-test' }, config) as any;
    const txId = tx.transaction_id;

    // Fuse overlapping solids
    const fuseOverlap = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [shellA, shellB]
    }, config) as any;

    expect(fuseOverlap.solid_id).toBeDefined();

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);

    // 2. Disjoint detection: translate one panel far away so their DXF outlines cannot touch.
    // With DXF-tracked panels, fuse_bodies uses the live panel frame (post-translate) to place
    // outlines in 2D. A 10 000 mm gap guarantees the merged outline is disconnected →
    // GE_FUSE_DISJOINT_RESULT is thrown before any C++ mutation.
    const cleanC = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    const decompC = await dispatchTool('split_body_by_bends', {
      part_id: cleanC.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const partA = decompC.panel_ids[0];
    const partOpposite = decompC.panel_ids[5];

    // Move partOpposite 10 000 mm in X and Y so it cannot touch partA in any 2D projection.
    await dispatchTool('translate_body', {
      targets: [partOpposite],
      vector: [10000, 10000, 0],
      keep_original: false,
    }, config);

    await expect(
      dispatchTool('fuse_bodies', { tools: [partA, partOpposite] }, config)
    ).rejects.toMatchObject({ code: ErrorCodes.GE_FUSE_DISJOINT_RESULT });
  });

  it('cuts body with keep_tools false/true', async () => {
    // 1. keep_tools: false (default)
    const clean1 = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    const decomp1 = await dispatchTool('split_body_by_bends', {
      part_id: clean1.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const blank1 = decomp1.panel_ids[0];
    const tool1 = decomp1.panel_ids[1];

    const tx1 = await dispatchTool('begin_transaction', { label: 'cut-test-1' }, config) as any;
    const txId1 = tx1.transaction_id;

    const cut1 = await dispatchTool('cut_bodies', {
      transaction_id: txId1,
      blank: blank1,
      tools: [tool1],
      keep_tools: false,
    }, config) as any;

    expect(cut1.solid_id).toBeDefined();

    // Tool was consumed — mass_properties should now reject it
    await expect(
      dispatchTool('mass_properties', { target: tool1 }, config)
    ).rejects.toThrow();

    await dispatchTool('commit_transaction', { transaction_id: txId1 }, config);

    // 2. keep_tools: true
    const clean2 = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    const decomp2 = await dispatchTool('split_body_by_bends', {
      part_id: clean2.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const blank2 = decomp2.panel_ids[0];
    const tool2 = decomp2.panel_ids[1];

    const tx2 = await dispatchTool('begin_transaction', { label: 'cut-test-2' }, config) as any;
    const txId2 = tx2.transaction_id;

    const cut2 = await dispatchTool('cut_bodies', {
      transaction_id: txId2,
      blank: blank2,
      tools: [tool2],
      keep_tools: true,
    }, config) as any;

    expect(cut2.solid_id).toBeDefined();

    // Tool was preserved — mass_properties should succeed
    const mass = await dispatchTool('mass_properties', { target: tool2 }, config) as any;
    expect(mass.volume).toBeGreaterThan(0);

    await dispatchTool('commit_transaction', { transaction_id: txId2 }, config);
  });

  it('intersects overlapping and disjoint shapes', async () => {
    // Overlapping: Load the same box twice (perfect overlap)
    const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompA = await dispatchTool('split_body_by_bends', {
      part_id: cleanA.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const shellA = decompA.panel_ids[0];

    const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompB = await dispatchTool('split_body_by_bends', {
      part_id: cleanB.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const shellB = decompB.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'intersect-test' }, config) as any;
    const txId = tx.transaction_id;

    // Intersect identical shapes (known overlap)
    const intersectOverlap = await dispatchTool('intersect_bodies', {
      transaction_id: txId,
      target_a: shellA,
      target_b: shellB
    }, config) as any;

    expect(intersectOverlap.solid_id).toBeDefined();
    const mass = await dispatchTool('mass_properties', { target: intersectOverlap.solid_id }, config) as any;
    expect(mass.volume).toBeGreaterThan(0);

    // Disjoint: load hollow_cube parts that are opposite and disjoint
    const cleanC = await dispatchTool('clean_geometry', { file_path: hollowCubePath }, config) as any;
    const decompC = await dispatchTool('split_body_by_bends', {
      part_id: cleanC.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const shellC1 = decompC.panel_ids[0];
    const shellC6 = decompC.panel_ids[5];

    // Intersect disjoint should throw GE_BOOLEAN_EMPTY_RESULT
    await expect(
      dispatchTool('intersect_bodies', {
        transaction_id: txId,
        target_a: shellC1,
        target_b: shellC6
      }, config)
    ).rejects.toMatchObject({
      code: ErrorCodes.GE_BOOLEAN_EMPTY_RESULT
    });

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('rolls back transaction after fuse, restoring original shapes', async () => {
    // Use two coplanar panels (same face from two simple_box loads) — fuse_bodies requires coplanar panels.
    // hollow_cube panels[0]+[1] are at 90° to each other, causing GE_FUSE_NOT_COPLANAR.
    const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const splitA = await dispatchTool('split_body_by_bends', {
      part_id: cleanA.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const partA = splitA.panel_ids[0];

    const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const splitB = await dispatchTool('split_body_by_bends', {
      part_id: cleanB.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config) as any;
    const partB = splitB.panel_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'rollback-test' }, config) as any;
    const txId = tx.transaction_id;

    const fuse = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [partA, partB]
    }, config) as any;

    expect(fuse.solid_id).toBeDefined();

    // Rollback the transaction
    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);

    // Verify original parts are restored (mass_properties succeeds)
    const massA = await dispatchTool('mass_properties', { target: partA }, config) as any;
    expect(massA.volume).toBeGreaterThan(0);
    const massB = await dispatchTool('mass_properties', { target: partB }, config) as any;
    expect(massB.volume).toBeGreaterThan(0);

    // Verify fused shape is gone
    await expect(
      dispatchTool('mass_properties', { target: fuse.solid_id }, config)
    ).rejects.toThrow();
  });

  it.skipIf(SKIP_DOLT)('performs semantic remapping end-to-end after fuse', async () => {
    // Use decompose_volume panels (no DXF) so fuse_bodies takes the C++ fuseBodies path,
    // which produces shape_history entries needed for face-binding remapping.
    // split_body_by_bends panels have DXFs and use the DXF rebuild path, which returns
    // empty shape_history and thus cannot remap semantic face bindings.
    const cleanA = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompA = await dispatchTool('decompose_volume', {
      solid_id: cleanA.solid_id,
      strategy: 'Integrity',
    }, config) as any;
    const partA = decompA.panel_ids[0];

    const cleanB = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const decompB = await dispatchTool('decompose_volume', {
      solid_id: cleanB.solid_id,
      strategy: 'Integrity',
    }, config) as any;
    const partB = decompB.panel_ids[0];

    // Get a real face ID from partA
    const faces = await dispatchTool('explore_topology', { target: partA, return_type: 'face' }, config) as any;
    expect(faces.entity_ids.length).toBeGreaterThan(0);
    const originalFace = faces.entity_ids[0];

    const tx = await dispatchTool('begin_transaction', { label: 'semantic-remap-test' }, config) as any;
    const txId = tx.transaction_id;

    // Declare and bind semantic entity
    const semanticId = `semantic://test/panel_face_${Date.now()}`;
    await dispatchTool('declare_semantic_entity', {
      id: semanticId,
      type: 'panel',
      transaction_id: txId
    }, config);

    await dispatchTool('bind_semantic_entity', {
      semantic_id: semanticId,
      binding: { kind: 'face_group', face_ids: [originalFace] },
      transaction_id: txId
    }, config);

    // Fuse adjacent panels (partA and partB)
    const fuse = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [partA, partB]
    }, config) as any;

    expect(fuse.shape_history.length).toBeGreaterThan(0);

    // Commit the transaction
    await dispatchTool('commit_transaction', { transaction_id: txId }, config);

    // Resolve the semantic entity to check if it remapped!
    const resolved = await dispatchTool('resolve_geometry', { semantic_id: semanticId }, config) as any;
    expect(resolved.binding_kind).toBe('face_group');
    expect(resolved.binding.face_ids).not.toContain(originalFace);
    expect(resolved.binding.face_ids.length).toBeGreaterThan(0);
  });
});
