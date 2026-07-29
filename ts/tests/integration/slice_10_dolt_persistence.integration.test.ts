/**
 * v2 Dolt persistence integration tests (Slice 10).
 *
 * Skipped when SKIP_DOLT=1 or DOLT_HOST is not set.
 * Requires a running dolt sql-server on DOLT_HOST:DOLT_PORT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool, initDoltStore, connectDoltStore, disconnectDoltStore, getDoltStore } from '../../src/v2/tools/graph';
import type { V2DoltStoreOptions } from '../../src/v2/persistence/dolt-store';

const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const SKIP = process.env.SKIP_DOLT === '1' || !process.env.DOLT_HOST;

const DATABASE = `v2_persist_test_${Date.now()}`;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

function createRect(store: GraphStore) {
  return dispatchGraphTool(store, 'create_part', {
    name: 'persist-test',
    outline: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
    ],
    thickness_mm: 2.0,
  }) as CreatePartResult;
}

describe.skipIf(SKIP)('[v2] Slice 10: Dolt persistence', () => {
  let adminConn: mysql.Connection;
  let store: GraphStore;

  beforeAll(async () => {
    // Create a fresh isolated database
    adminConn = await mysql.createConnection({
      host: HOST, port: PORT, user: 'root', password: '',
    });
    await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);
    await adminConn.query(`USE \`${DATABASE}\``);

    // Create the v2_part table
    await adminConn.query(`
      CREATE TABLE IF NOT EXISTS v2_part (
        part_id VARCHAR(36) NOT NULL PRIMARY KEY,
        graph_json JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);

    // Initialize Dolt store and connect
    const options: V2DoltStoreOptions = {
      host: HOST, port: PORT, user: 'root', password: '', database: DATABASE,
    };
    initDoltStore(options);
    await connectDoltStore();

    store = new GraphStore();
  });

  afterAll(async () => {
    await disconnectDoltStore();
    await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await adminConn.end();
  });

  it('commit saves a part and returns a non-empty hash', async () => {
    const part = createRect(store);

    const result = await dispatchGraphTool(store, 'commit', {
      part_id: part.part_id,
      message: 'initial commit',
    }) as { commit_hash: string };

    expect(result.commit_hash).toBeTruthy();
    expect(result.commit_hash.length).toBeGreaterThan(10);

    // Verify it's in Dolt
    const dolt = getDoltStore()!;
    const saved = await dolt.loadPart(part.part_id);
    expect(saved).not.toBeNull();
    expect(saved!.part.partId).toBe(part.part_id);
  });

  it('restore loads a previously committed part', async () => {
    const part = createRect(store);

    // Commit initial state
    const commit = await dispatchGraphTool(store, 'commit', {
      part_id: part.part_id,
      message: 'before modification',
    }) as { commit_hash: string };

    // Modify the part (add a bend)
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 50 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    // Verify it has a bend now
    expect(store.snapshotPart(part.part_id).bends).toHaveLength(1);

    // Restore to the commit before the bend was added
    const restored = await dispatchGraphTool(store, 'restore', {
      part_id: part.part_id,
      commit_hash: commit.commit_hash,
    }) as { part_id: string };

    // The restored part should have no bends
    const snap = store.snapshotPart(restored.part_id);
    expect(snap.bends).toHaveLength(0);
  });

  it('restore round-trip: create → commit → modify → restore', async () => {
    const part = createRect(store);

    // Commit baseline
    const c1 = await dispatchGraphTool(store, 'commit', {
      part_id: part.part_id,
      message: 'baseline',
    }) as { commit_hash: string };

    // Add a bend + commit
    const bend = dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 50 },
      angle_deg: 90,
      radius_mm: 1.0,
    }) as { bend_id: string; child_region_panel_id: string };

    await dispatchGraphTool(store, 'commit', {
      part_id: part.part_id,
      message: 'added bend',
    });

    // Add a hole + commit
    dispatchGraphTool(store, 'cut_panel', {
      part_id: part.part_id,
      kind: 'circle',
      circle: { center: { x: 25, y: 25 }, radius_mm: 5.0 },
    });

    await dispatchGraphTool(store, 'commit', {
      part_id: part.part_id,
      message: 'added hole',
    });

    // Now the part has bends AND holes
    const current = store.snapshotPart(part.part_id);
    expect(current.bends.length).toBeGreaterThan(0);
    expect(current.part.holes.length).toBeGreaterThan(0);

    // Restore to baseline — no bends, no holes
    const restored = await dispatchGraphTool(store, 'restore', {
      part_id: part.part_id,
      commit_hash: c1.commit_hash,
    }) as { part_id: string };

    const restoredSnap = store.snapshotPart(restored.part_id);
    expect(restoredSnap.bends).toHaveLength(0);
    expect(restoredSnap.part.holes).toHaveLength(0);
  });

  it('commits are listed via Dolt log', async () => {
    const dolt = getDoltStore()!;
    const commits = await dolt.listCommits();
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].hash).toBeTruthy();
    expect(commits[0].message).toBeTruthy();
  });
});
