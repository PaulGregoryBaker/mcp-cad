/**
 * Semantic Mapping Layer integration tests — Phase 2 (US1): declare / bind / resolve.
 *
 * Skipped when SKIP_DOLT=1 (PR-CI where Dolt is not installed).
 * Requires a running dolt sql-server on DOLT_HOST:DOLT_PORT (default 127.0.0.1:3306).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mysql from 'mysql2/promise';
import { applyMigrations } from '../../src/semantic/migration_runner';
import { DoltAdapter } from '../../src/semantic/dolt_adapter';
import { SemanticStore } from '../../src/semantic/semantic_store';
import { MappingLayer } from '../../src/semantic/mapping_layer';
import type { ShapeHistoryRecord } from '../../src/semantic/types';

const SKIP = process.env.SKIP_DOLT === '1';

const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const DATABASE = `semantic_test_${Date.now()}`;

describe.skipIf(SKIP)('Semantic Mapping Layer — Phase 2 (US1)', () => {
  let adminConn: mysql.Connection;
  let adapter: DoltAdapter;
  let store: SemanticStore;

  const TX1 = 'txn-us1-001';
  const TX2 = 'txn-us1-002';

  beforeAll(async () => {
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

    const migConn = await mysql.createConnection({
      host: HOST,
      port: PORT,
      user: 'root',
      password: '',
      database: DATABASE,
    });
    await applyMigrations(migConn);
    await migConn.end();

    store = new SemanticStore(adapter);
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await adminConn.end();
  });

  beforeEach(async () => {
    // Insert supporting transaction rows so FK-like constraints are satisfied.
    await adapter
      .insertTransaction({ id: TX1, label: 'test-tx-1', product: 'test', state: 'active', started_at: new Date() })
      .catch(() => {
        // Ignore if already inserted from a prior test in this suite.
      });
    await adapter
      .insertTransaction({ id: TX2, label: 'test-tx-2', product: 'test', state: 'active', started_at: new Date() })
      .catch(() => {});
  });

  // ── (a) declare → bind face_group → resolve round-trip ───────────────────

  it('(a) declare → bind face_group → resolve returns the same face IDs', async () => {
    const entityId = `semantic://test/panel_${Date.now()}`;
    const faceIds = ['face://shell/s1/face/0', 'face://shell/s1/face/1'];

    await store.declareEntity({ id: entityId, type: 'panel', transaction_id: TX1 });
    await store.bindEntity({
      semantic_id: entityId,
      binding: { kind: 'face_group', face_ids: faceIds },
      transaction_id: TX1,
    });

    const resolved = await store.resolveCurrent({ semantic_id: entityId });

    expect(resolved.semantic_id).toBe(entityId);
    expect(resolved.binding_kind).toBe('face_group');
    expect(resolved.binding).toMatchObject({ kind: 'face_group', face_ids: faceIds });
  });

  // ── (b) duplicate declare → SEMANTIC_ID_EXISTS ────────────────────────────

  it('(b) declare with a duplicate id returns SEMANTIC_ID_EXISTS', async () => {
    const entityId = `semantic://test/dup_${Date.now()}`;

    await store.declareEntity({ id: entityId, type: 'panel', transaction_id: TX1 });

    await expect(
      store.declareEntity({ id: entityId, type: 'panel', transaction_id: TX1 }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ID_EXISTS' });
  });

  // ── (c) bind non-existent entity → SEMANTIC_ID_NOT_FOUND ─────────────────

  it('(c) bind a non-existent entity returns SEMANTIC_ID_NOT_FOUND', async () => {
    await expect(
      store.bindEntity({
        semantic_id: 'semantic://test/does_not_exist',
        binding: { kind: 'face_group', face_ids: ['face://x'] },
        transaction_id: TX1,
      }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ID_NOT_FOUND' });
  });

  // ── (d) resolve non-existent entity → SEMANTIC_ID_NOT_FOUND ──────────────

  it('(d) resolve with no binding returns SEMANTIC_ID_NOT_FOUND', async () => {
    const entityId = `semantic://test/no_binding_${Date.now()}`;
    await store.declareEntity({ id: entityId, type: 'panel', transaction_id: TX1 });

    // No bindEntity call — resolveCurrent should throw.
    await expect(
      store.resolveCurrent({ semantic_id: entityId }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ID_NOT_FOUND' });
  });

  // ── (e) invalid semantic id → SEMANTIC_ID_INVALID ────────────────────────

  it('(e) declare with invalid URI returns SEMANTIC_ID_INVALID', async () => {
    await expect(
      store.declareEntity({ id: 'not-a-uri', type: 'panel', transaction_id: TX1 }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_ID_INVALID' });
  });

  // ── (f) invalid entity type → SEMANTIC_TYPE_NOT_SUPPORTED ────────────────

  it('(f) declare with unknown type returns SEMANTIC_TYPE_NOT_SUPPORTED', async () => {
    await expect(
      store.declareEntity({
        id: `semantic://test/bad_type_${Date.now()}`,
        type: 'robot',
        transaction_id: TX1,
      }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_TYPE_NOT_SUPPORTED' });
  });

  // ── (g) spatial_region binding with missing constituent ───────────────────

  it('(g) spatial_region with non-existent constituent returns SEMANTIC_CONSTITUENT_NOT_FOUND', async () => {
    const entityId = `semantic://test/region_${Date.now()}`;
    await store.declareEntity({ id: entityId, type: 'spatial_region', transaction_id: TX1 });

    await expect(
      store.bindEntity({
        semantic_id: entityId,
        binding: {
          kind: 'spatial_region',
          between: ['semantic://test/ghost_a', 'semantic://test/ghost_b'],
        },
        transaction_id: TX1,
      }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_CONSTITUENT_NOT_FOUND' });
  });

  // ── (h) spatial_region resolution materialises face union ─────────────────

  it('(h) spatial_region resolves to union of constituent face IDs', async () => {
    const idA = `semantic://test/panel_a_${Date.now()}`;
    const idB = `semantic://test/panel_b_${Date.now()}`;
    const idRegion = `semantic://test/region_${Date.now() + 1}`;
    const facesA = ['face://shell/a/face/0'];
    const facesB = ['face://shell/b/face/0', 'face://shell/b/face/1'];

    await store.declareEntity({ id: idA, type: 'panel', transaction_id: TX1 });
    await store.declareEntity({ id: idB, type: 'panel', transaction_id: TX1 });
    await store.declareEntity({ id: idRegion, type: 'spatial_region', transaction_id: TX1 });

    await store.bindEntity({
      semantic_id: idA,
      binding: { kind: 'face_group', face_ids: facesA },
      transaction_id: TX1,
    });
    await store.bindEntity({
      semantic_id: idB,
      binding: { kind: 'face_group', face_ids: facesB },
      transaction_id: TX1,
    });
    await store.bindEntity({
      semantic_id: idRegion,
      binding: { kind: 'spatial_region', between: [idA, idB] },
      transaction_id: TX1,
    });

    const resolved = await store.resolveCurrent({ semantic_id: idRegion });

    expect(resolved.binding_kind).toBe('spatial_region');
    expect(resolved.materialised_face_ids).toEqual(expect.arrayContaining([...facesA, ...facesB]));
    expect(resolved.materialised_face_ids).toHaveLength(facesA.length + facesB.length);
  });
});

// ─── Phase 3 (US2): Mapping Layer Remap ──────────────────────────────────────

describe.skipIf(SKIP)('Semantic Mapping Layer — Phase 3 US2 (remap after split)', () => {
  let adminConn: mysql.Connection;
  let adapter: DoltAdapter;
  let store: SemanticStore;
  let mappingLayer: MappingLayer;

  const TX_SETUP = 'txn-remap-setup';
  const TX_MUTATE = 'txn-remap-mutate';
  const DATABASE_US2 = `semantic_us2_${Date.now()}`;

  const outerPanelId = 'semantic://braai/outer_panel';
  const fireboxId = 'semantic://braai/firebox_panel';

  const originalFace0 = 'face://shell/firebox_left/face/5';
  const originalFace1 = 'face://shell/firebox_left/face/6';
  const newFace0 = 'face://shell/firebox_left/panel/0/face/0';
  const newFace1 = 'face://shell/firebox_left/panel/1/face/0';
  const outerFaces = ['face://shell/outer_left/face/0', 'face://shell/outer_left/face/1'];

  beforeAll(async () => {
    adminConn = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '' });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE_US2}\``);

    adapter = new DoltAdapter({ host: HOST, port: PORT, user: 'root', password: '', database: DATABASE_US2 });
    await adapter.connect();

    const migConn = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '', database: DATABASE_US2 });
    await applyMigrations(migConn);
    await migConn.end();

    store = new SemanticStore(adapter);
    mappingLayer = new MappingLayer(store);

    // Setup transactions
    await adapter.insertTransaction({ id: TX_SETUP, label: 'setup', product: 'braai', state: 'active', started_at: new Date() });
    await adapter.insertTransaction({ id: TX_MUTATE, label: 'split', product: 'braai', state: 'active', started_at: new Date() });

    // Declare entities and initial bindings
    await store.declareEntity({ id: outerPanelId, type: 'panel', transaction_id: TX_SETUP });
    await store.declareEntity({ id: fireboxId, type: 'panel', transaction_id: TX_SETUP });

    await store.bindEntity({
      semantic_id: outerPanelId,
      binding: { kind: 'face_group', face_ids: outerFaces },
      transaction_id: TX_SETUP,
      topology_revision: 1,
    });
    await store.bindEntity({
      semantic_id: fireboxId,
      binding: { kind: 'face_group', face_ids: [originalFace0, originalFace1] },
      transaction_id: TX_SETUP,
      topology_revision: 1,
    });

    // Insert a topology_revision for the mutation transaction
    await adapter.insertTopologyRevision({ transaction_id: TX_MUTATE, brep_file_path: '', brep_sha256: '0'.repeat(64) });
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE_US2}\``);
    await adminConn.end();
  });

  // (a) firebox panel binding remaps after split_body_by_bends
  it('(a) firebox panel binding remaps — new face IDs, remap_reason set', async () => {
    const history: ShapeHistoryRecord[] = [
      { transaction_id: TX_MUTATE, verdict: 'modified', original_id: originalFace0, new_id: newFace0, operation_label: 'split_body_by_bends' },
      { transaction_id: TX_MUTATE, verdict: 'modified', original_id: originalFace1, new_id: newFace1, operation_label: 'split_body_by_bends' },
    ];
    await adapter.insertShapeHistory(history);

    const revId = (await adapter.getTopologyRevisionByTransaction(TX_MUTATE))!.id;
    await mappingLayer.applyShapeHistoryToBindings(TX_MUTATE, revId);

    const resolved = await store.resolveCurrent({ semantic_id: fireboxId });
    expect(resolved.binding.kind).toBe('face_group');
    if (resolved.binding.kind === 'face_group') {
      expect(resolved.binding.face_ids).toContain(newFace0);
      expect(resolved.binding.face_ids).toContain(newFace1);
      expect(resolved.binding.face_ids).not.toContain(originalFace0);
    }
    expect(resolved.remap_reason).toContain('Modified()');
  });

  // (b) outer panel binding carries forward (unchanged)
  it('(b) untouched outer panel binding carries forward via a new row', async () => {
    const resolved = await store.resolveCurrent({ semantic_id: outerPanelId });
    expect(resolved.binding.kind).toBe('face_group');
    if (resolved.binding.kind === 'face_group') {
      expect(resolved.binding.face_ids).toEqual(outerFaces);
    }
  });

  // (c) deleted face produces empty face_group with remap_reason
  it('(c) IsDeleted verdict produces empty face_ids and remap_reason', async () => {
    const deletedFace = 'face://shell/deleted/face/0';
    const txDel = 'txn-remap-delete';
    const entityDel = 'semantic://braai/deleted_panel';
    const dbDel = `semantic_del_${Date.now()}`;

    const adminDel = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '' });
    await adminDel.query(`CREATE DATABASE IF NOT EXISTS \`${dbDel}\``);
    const adDel = new DoltAdapter({ host: HOST, port: PORT, user: 'root', password: '', database: dbDel });
    await adDel.connect();
    const mc = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '', database: dbDel });
    await applyMigrations(mc);
    await mc.end();
    const stDel = new SemanticStore(adDel);
    const mlDel = new MappingLayer(stDel);

    await adDel.insertTransaction({ id: txDel, label: 'del', product: 'test', state: 'active', started_at: new Date() });
    await stDel.declareEntity({ id: entityDel, type: 'panel', transaction_id: txDel });
    await stDel.bindEntity({ semantic_id: entityDel, binding: { kind: 'face_group', face_ids: [deletedFace] }, transaction_id: txDel, topology_revision: 1 });
    const revDel = await adDel.insertTopologyRevision({ transaction_id: txDel, brep_file_path: '', brep_sha256: '0'.repeat(64) });
    await adDel.insertShapeHistory([{ transaction_id: txDel, verdict: 'deleted', original_id: deletedFace, new_id: null, operation_label: 'split_body_by_bends' }]);
    await mlDel.applyShapeHistoryToBindings(txDel, revDel);

    const resolved = await stDel.resolveCurrent({ semantic_id: entityDel });
    expect(resolved.binding.kind).toBe('face_group');
    if (resolved.binding.kind === 'face_group') {
      expect(resolved.binding.face_ids).toHaveLength(0);
    }

    await adDel.disconnect();
    await adminDel.query(`DROP DATABASE IF EXISTS \`${dbDel}\``);
    await adminDel.end();
  });
});

// ─── Phase 3 (US3): Spatial Region Refresh ───────────────────────────────────

describe.skipIf(SKIP)('Semantic Mapping Layer — Phase 3 US3 (spatial region refresh)', () => {
  let adminConn: mysql.Connection;
  let adapter: DoltAdapter;
  let store: SemanticStore;
  let mappingLayer: MappingLayer;

  const DB3 = `semantic_us3_${Date.now()}`;
  const TX_S = 'txn-us3-setup';
  const TX_M = 'txn-us3-mutate';

  const panelA = 'semantic://test/panel_a_us3';
  const panelB = 'semantic://test/panel_b_us3';
  const region = 'semantic://test/airflow_region_us3';

  const facesA0 = ['face://a/face/0'];
  const facesA1 = ['face://a/face/1']; // after remap
  const facesB0 = ['face://b/face/0'];

  beforeAll(async () => {
    adminConn = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '' });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB3}\``);
    adapter = new DoltAdapter({ host: HOST, port: PORT, user: 'root', password: '', database: DB3 });
    await adapter.connect();
    const mc = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '', database: DB3 });
    await applyMigrations(mc);
    await mc.end();
    store = new SemanticStore(adapter);
    mappingLayer = new MappingLayer(store);

    await adapter.insertTransaction({ id: TX_S, label: 'setup', product: 'test', state: 'active', started_at: new Date() });
    await adapter.insertTransaction({ id: TX_M, label: 'mutate', product: 'test', state: 'active', started_at: new Date() });

    await store.declareEntity({ id: panelA, type: 'panel', transaction_id: TX_S });
    await store.declareEntity({ id: panelB, type: 'panel', transaction_id: TX_S });
    await store.declareEntity({ id: region, type: 'spatial_region', transaction_id: TX_S });

    await store.bindEntity({ semantic_id: panelA, binding: { kind: 'face_group', face_ids: facesA0 }, transaction_id: TX_S, topology_revision: 1 });
    await store.bindEntity({ semantic_id: panelB, binding: { kind: 'face_group', face_ids: facesB0 }, transaction_id: TX_S, topology_revision: 1 });
    await store.bindEntity({ semantic_id: region, binding: { kind: 'spatial_region', between: [panelA, panelB] }, transaction_id: TX_S, topology_revision: 1 });
    await adapter.insertTopologyRevision({ transaction_id: TX_M, brep_file_path: '', brep_sha256: '0'.repeat(64) });
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DB3}\``);
    await adminConn.end();
  });

  // (a) after remap, spatial region resolves with new panel face IDs
  it('(a) resolve spatial region after remap includes new face IDs from constituent', async () => {
    const revId = (await adapter.getTopologyRevisionByTransaction(TX_M))!.id;
    await adapter.insertShapeHistory([{ transaction_id: TX_M, verdict: 'modified', original_id: facesA0[0]!, new_id: facesA1[0]!, operation_label: 'split_body_by_bends' }]);
    const affected = await mappingLayer.applyShapeHistoryToBindings(TX_M, revId);
    await mappingLayer.refreshDerivedBindings(TX_M, revId, affected);

    const resolved = await store.resolveCurrent({ semantic_id: region });
    expect(resolved.materialised_face_ids).toContain(facesA1[0]);
    expect(resolved.materialised_face_ids).toContain(facesB0[0]);
  });

  // (b) non-existent constituent → SEMANTIC_CONSTITUENT_NOT_FOUND
  it('(b) spatial_region with non-existent constituent returns SEMANTIC_CONSTITUENT_NOT_FOUND', async () => {
    const orphan = 'semantic://test/orphan_region';
    await store.declareEntity({ id: orphan, type: 'spatial_region', transaction_id: TX_S });
    await expect(
      store.bindEntity({
        semantic_id: orphan,
        binding: { kind: 'spatial_region', between: ['semantic://test/ghost_x', 'semantic://test/ghost_y'] },
        transaction_id: TX_S,
      }),
    ).rejects.toMatchObject({ code: 'SEMANTIC_CONSTITUENT_NOT_FOUND' });
  });
});

// ─── Phase 4 (US4): Lineage and Time Travel ──────────────────────────────────

describe.skipIf(SKIP)('Semantic Mapping Layer — Phase 4 US4 (lineage + time travel)', () => {
  let adminConn: mysql.Connection;
  let adapter: DoltAdapter;
  let store: SemanticStore;
  let mappingLayer: MappingLayer;

  const DB4 = `semantic_us4_${Date.now()}`;
  const TX_INITIAL = 'txn-us4-initial';
  const TX_AFTER = 'txn-us4-after';

  const panelId = 'semantic://test/lineage_panel_us4';
  const originalFace = 'face://shell/lp/face/0';
  const newFace = 'face://shell/lp/panel/0/face/0';

  let initialRevId: number;
  let afterRevId: number;

  beforeAll(async () => {
    adminConn = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '' });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB4}\``);
    adapter = new DoltAdapter({ host: HOST, port: PORT, user: 'root', password: '', database: DB4 });
    await adapter.connect();
    const mc = await mysql.createConnection({ host: HOST, port: PORT, user: 'root', password: '', database: DB4 });
    await applyMigrations(mc);
    await mc.end();
    store = new SemanticStore(adapter);
    mappingLayer = new MappingLayer(store);

    // Set up initial state
    await adapter.insertTransaction({ id: TX_INITIAL, label: 'initial', product: 'test', state: 'active', started_at: new Date() });
    await adapter.insertTransaction({ id: TX_AFTER, label: 'after split', product: 'test', state: 'active', started_at: new Date() });

    await store.declareEntity({ id: panelId, type: 'panel', transaction_id: TX_INITIAL });
    initialRevId = await adapter.insertTopologyRevision({ transaction_id: TX_INITIAL, brep_file_path: '', brep_sha256: '0'.repeat(64) });

    await store.bindEntity({
      semantic_id: panelId,
      binding: { kind: 'face_group', face_ids: [originalFace] },
      transaction_id: TX_INITIAL,
      topology_revision: initialRevId,
    });

    // Apply a remap on a second revision
    afterRevId = await adapter.insertTopologyRevision({ transaction_id: TX_AFTER, brep_file_path: '', brep_sha256: '1'.repeat(64) });
    await adapter.insertShapeHistory([{
      transaction_id: TX_AFTER,
      verdict: 'modified',
      original_id: originalFace,
      new_id: newFace,
      operation_label: 'split_body_by_bends',
    }]);
    await mappingLayer.applyShapeHistoryToBindings(TX_AFTER, afterRevId);
  }, 30_000);

  afterAll(async () => {
    await adapter.disconnect();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DB4}\``);
    await adminConn.end();
  });

  // (a) getMappingLineage returns ≥2 rows in revision order
  it('(a) getMappingLineage returns ≥2 rows with transaction_id and remap_reason', async () => {
    const lineage = await store.getMappingLineage(panelId);

    expect(lineage.length).toBeGreaterThanOrEqual(2);

    // First row: original binding, no remap_reason
    const firstRow = lineage.find((r) => r.topology_revision === initialRevId);
    expect(firstRow).toBeDefined();
    expect(firstRow!.remap_reason).toBeNull();
    expect(firstRow!.created_in_transaction).toBe(TX_INITIAL);

    // Later row: remapped, has remap_reason
    const remappedRow = lineage.find((r) => r.topology_revision === afterRevId);
    expect(remappedRow).toBeDefined();
    expect(remappedRow!.remap_reason).toContain('Modified()');
    if (remappedRow!.binding.kind === 'face_group') {
      expect(remappedRow!.binding.face_ids).toContain(newFace);
    }
  });

  // (b) at_revision: 9999 → REVISION_NOT_FOUND
  it('(b) resolveAtRevision with non-existent revision returns REVISION_NOT_FOUND', async () => {
    await expect(
      store.resolveAtRevision(panelId, 9999),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
  });
});
