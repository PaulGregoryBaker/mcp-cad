/**
 * Reproduces the user's reported bug: "undo after a fuse, then redo of the
 * fuse, results in a completely different result."
 *
 * Root cause found: rollback_transaction (handlers/transactions.ts) restored
 * the GEOMETRY KERNEL's snapshot (the 3D shells) but never touched the
 * manufacturing graph (getParts(), a separate TypeScript-side Map mutated by
 * every graph-producing tool). fuse_bodies deletes its two input panels'
 * graph nodes (and creates a new fused one) as part of normal operation —
 * after a rollback restored the GEOMETRY but not the GRAPH, a second
 * ("redo") call to fuse_bodies with the same inputs found no graph data for
 * either one and silently fell through to the graph-unaware fallback path
 * (a raw OCCT boolean with no DXF/frame placement logic) — a completely
 * different code path than the original call took, producing a different
 * result.
 *
 * Fix: ManufacturingGraph.cloneDeep() (graph.ts) + snapshotParts()/
 * restorePartsSnapshot() (state.ts), wired into begin_transaction /
 * rollback_transaction (handlers/transactions.ts) alongside the existing
 * geometry-kernel snapshot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getParts } from '../../src/mcp/state';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}
function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number { return b[`${axis}_max`] - b[`${axis}_min`]; }
function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}

describe('[diagnostic] rollback_transaction must restore the manufacturing graph, not just geometry', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('cube_with_flanges.stp: fuse wall+flange, undo (rollback), redo the SAME fuse — must reproduce the SAME result', async () => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }

    // Step 0: split happens OUTSIDE the transaction under test, so wallId/
    // flangeId's graph data survives any rollback of the LATER transaction.
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count).toBe(10);

    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panels.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    const walls = panels.filter(({ bbox }) => {
      const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
      return dims[0]! < 5 && dims[1]! > 150 && dims[2]! > 150;
    });
    const flanges = panels.filter(({ bbox }) => ext(bbox, 'x') < 50 && ext(bbox, 'y') < 50 && ext(bbox, 'z') < 50);
    function thinAxis(b: Bbox): { axis: 'x' | 'y' | 'z'; center: number } {
      const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
        { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
      ];
      dims.sort((a, b2) => a.extent - b2.extent);
      const axis = dims[0]!.axis;
      return { axis, center: (b[`${axis}_min`] + b[`${axis}_max`]) / 2 };
    }
    let wallId = '', flangeId = '';
    outer: for (const flange of flanges) {
      const ft = thinAxis(flange.bbox);
      for (const wall of walls) {
        const wt = thinAxis(wall.bbox);
        if (wt.axis === ft.axis && Math.abs(wt.center - ft.center) < 10) {
          wallId = wall.id; flangeId = flange.id;
          break outer;
        }
      }
    }
    expect(wallId, 'expected at least one coplanar wall+flange pair').not.toBe('');

    // Sanity: BOTH inputs must have graph data before we even start — this
    // is what makes the original fuse take the graph-aware (DXF-merge) path.
    expect(getParts().has(wallId), 'wall must have graph data before fuse').toBe(true);
    expect(getParts().has(flangeId), 'flange must have graph data before fuse').toBe(true);

    // ── Step 1: ORIGINAL fuse, inside an explicit transaction (the same
    // primitive the app's "Operation History" / undo-redo presumably wraps
    // each step in — see resolveRollbackToken: a rollback_token returned
    // while a transaction is active IS the transaction id).
    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-undo-redo-repro' }, config);
    const txId: string = txn.transaction_id;

    const fused1: any = await dispatchTool('fuse_bodies', { transaction_id: txId, tools: [wallId, flangeId] }, config);
    expect(fused1.solid_id, 'original fuse must succeed').toBeDefined();
    const bbox1: Bbox = await dispatchTool('bounding_box', { target: fused1.solid_id }, config) as Bbox;
    console.log(`[undo-redo] ORIGINAL fuse bbox: ${fmt(bbox1)}`);
    const graph1: any = await dispatchTool('query_graph', { part_id: fused1.part_id }, config);
    const node1 = graph1.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    console.log(`[undo-redo] ORIGINAL fused node: shapeDxf=${node1?.shapeDxf ? 'present' : 'NULL'} dirty=${node1?.dirty}`);
    // The graph-aware path produces a merged shapeDxf; the graph-unaware
    // fallback (taken when an input has no graph data) never does.
    expect(node1?.shapeDxf, '[undo-redo] original fuse should have taken the graph-aware (DXF-merge) path').toBeTruthy();

    // ── Step 2: UNDO — roll back the transaction. Geometry kernel restores
    // the pre-fuse shells; with the fix, the manufacturing graph also gets
    // restored (wallId/flangeId's PanelNodes come back).
    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);

    expect(getParts().has(wallId), '[undo-redo] [BUG] wall graph data must be restored after rollback').toBe(true);
    expect(getParts().has(flangeId), '[undo-redo] [BUG] flange graph data must be restored after rollback').toBe(true);

    // ── Step 3: REDO — re-run the EXACT SAME fuse_bodies call. With the fix,
    // wallId/flangeId still have graph data, so this takes the SAME
    // graph-aware code path and reproduces the SAME result.
    const txn2: any = await dispatchTool('begin_transaction', { label: 'fuse-undo-redo-repro-2' }, config);
    const txId2: string = txn2.transaction_id;
    const fused2: any = await dispatchTool('fuse_bodies', { transaction_id: txId2, tools: [wallId, flangeId] }, config);
    expect(fused2.solid_id, 'redo fuse must succeed').toBeDefined();
    const bbox2: Bbox = await dispatchTool('bounding_box', { target: fused2.solid_id }, config) as Bbox;
    console.log(`[undo-redo] REDO fuse bbox: ${fmt(bbox2)}`);
    const graph2: any = await dispatchTool('query_graph', { part_id: fused2.part_id }, config);
    const node2 = graph2.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    console.log(`[undo-redo] REDO fused node: shapeDxf=${node2?.shapeDxf ? 'present' : 'NULL'} dirty=${node2?.dirty}`);

    expect(node2?.shapeDxf, '[undo-redo] [BUG] redo fell back to the graph-unaware path (no shapeDxf) — undo/redo non-determinism reproduced').toBeTruthy();

    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(bbox1[k] - bbox2[k]);
      expect(delta, `[undo-redo] [BUG] redo bbox.${k} differs from the original fuse (orig=${bbox1[k].toFixed(2)} redo=${bbox2[k].toFixed(2)} Δ=${delta.toFixed(2)}mm) — undo/redo non-determinism`)
        .toBeLessThanOrEqual(0.5);
    }

    await dispatchTool('rollback_transaction', { transaction_id: txId2 }, config);
  }, 60_000);
});
