/**
 * Reproduces the user's REAL workflow from Form.AI.tion (the production app):
 * a merge_bodies_with_bend call FIRST (building up a box-corner bracket from
 * two adjacent walls, bend by bend), THEN a flange/protrusion that's already
 * attached to one of those two walls gets translated and fused onto the
 * ALREADY-MERGED (chained) bracket — not a fresh split-time panel. This is a
 * code path none of this session's earlier tests exercised: fuse_bodies's
 * "dominant panel" reference frame, when that panel is itself the OUTPUT of
 * a prior bend-merge.
 *
 * User-reported symptom on this exact shape of workflow: after the fuse, the
 * footprint extends along the WRONG axis (height grows instead of width) —
 * a 90-degree-rotated placement, not just an offset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding } from '../../src/mcp/state';

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
function thinAxis(b: Bbox): { axis: 'x' | 'y' | 'z'; center: number } {
  const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
    { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
  ];
  dims.sort((a, b2) => a.extent - b2.extent);
  const axis = dims[0]!.axis;
  return { axis, center: (b[`${axis}_min`] + b[`${axis}_max`]) / 2 };
}

describe('[diagnostic] flange fused onto an ALREADY-MERGED (chained bend) bracket — rotation check', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('cube_with_flanges.stp: merge two adjacent walls (90deg bend) FIRST, then translate+fuse a flange (already on one of those walls) onto the bracket', async () => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }

    const txn: any = await dispatchTool('begin_transaction', { label: 'chained-merge-flange-fuse' }, config);
    const txId: string = txn.transaction_id;

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0, transaction_id: txId,
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
    expect(walls.length).toBeGreaterThanOrEqual(2);
    expect(flanges.length).toBeGreaterThanOrEqual(1);

    // Pick a wall (wallA) that HAS a coplanar flange, and a second wall
    // (wallB) perpendicular to it (different thin axis) to merge with.
    let wallAId = '', wallBId = '', flangeId = '';
    let wallABbox: Bbox | undefined, wallBBbox: Bbox | undefined, flangeBbox: Bbox | undefined;
    outerLoop: for (const wallA of walls) {
      const wt = thinAxis(wallA.bbox);
      const flange = flanges.find((f) => {
        const ft = thinAxis(f.bbox);
        return ft.axis === wt.axis && Math.abs(ft.center - wt.center) < 10;
      });
      if (!flange) continue;
      const wallB = walls.find((w) => w.id !== wallA.id && thinAxis(w.bbox).axis !== wt.axis);
      if (!wallB) continue;
      wallAId = wallA.id; wallBId = wallB.id; flangeId = flange.id;
      wallABbox = wallA.bbox; wallBBbox = wallB.bbox; flangeBbox = flange.bbox;
      break outerLoop;
    }
    expect(wallAId, 'expected a wall with a coplanar flange, plus a perpendicular second wall').not.toBe('');
    console.log(`[chained] wallA (has the flange): ${fmt(wallABbox!)}`);
    console.log(`[chained] wallB (perpendicular):  ${fmt(wallBBbox!)}`);
    console.log(`[chained] flange (on wallA):       ${fmt(flangeBbox!)}`);

    // ── Step 1: merge wallA + wallB via bend FIRST (wallA as part_a_id —
    // never rotates in merge_bodies_with_bend — so its own plane/position is
    // preserved unchanged in the chained result).
    const chainedMerge: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId, part_a_id: wallAId, part_b_id: wallBId, target_edges: ['all'], bend_radius: 1.0,
    }, config);
    expect(chainedMerge.merged_shell_id, 'chained merge must succeed').toBeDefined();
    const chainedBbox: Bbox = await dispatchTool('bounding_box', { target: chainedMerge.merged_shell_id }, config) as Bbox;
    console.log(`[chained] merged bracket (wallA+wallB) bbox: ${fmt(chainedBbox)}`);

    const chainedGraph: any = await dispatchTool('query_graph', { part_id: chainedMerge.merged_part_id }, config);
    for (const n of chainedGraph.nodes) {
      console.log(`[chained] graph node id=${n.id} type=${n.type} canonical=${n.canonical} panelFrame=${JSON.stringify(n.panelFrame)}`);
    }
    const chainedNode = chainedGraph.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    console.log(`[chained] STORED graph panelFrame: ${JSON.stringify(chainedNode?.panelFrame)}`);
    const flangeGraph: any = await dispatchTool('query_graph', { part_id: flangeId }, config);
    const flangeNode = flangeGraph.nodes.find((n: any) => n.type === 'PanelNode');
    console.log(`[chained] STORED flange panelFrame: ${JSON.stringify(flangeNode?.panelFrame)}`);
    const chainedFrame = getGeometryBinding().getPanelFrame(chainedMerge.merged_shell_id as string);
    console.log(`[chained] bracket frame: u=(${chainedFrame.uX.toFixed(3)},${chainedFrame.uY.toFixed(3)},${chainedFrame.uZ.toFixed(3)}) v=(${chainedFrame.vX.toFixed(3)},${chainedFrame.vY.toFixed(3)},${chainedFrame.vZ.toFixed(3)}) n=(${chainedFrame.normalX.toFixed(3)},${chainedFrame.normalY.toFixed(3)},${chainedFrame.normalZ.toFixed(3)})`);

    // ── Step 2: the flange is ALREADY coplanar with wallA (it was picked
    // that way) — wallA doesn't rotate during the merge, so the flange
    // should STILL be coplanar with the bracket's wallA-derived face, with NO
    // translate needed at all. To exercise the translate+fuse path exactly
    // like the user's report, nudge it by a small in-plane amount and back
    // (round-trip, net zero) before fusing — same technique validated
    // earlier this session for non-chained panels.
    const ft = thinAxis(flangeBbox!);
    const moveAxisIdx = ft.axis === 'x' ? 1 : 0;
    const away: [number, number, number] = [0, 0, 0];
    away[moveAxisIdx] = 31;
    const back: [number, number, number] = away.map((v) => -v) as [number, number, number];
    const moved1: any = await dispatchTool('translate_body', { transaction_id: txId, targets: [flangeId], vector: away, keep_original: false }, config);
    const moved2: any = await dispatchTool('translate_body', { transaction_id: txId, targets: [moved1.solid_id], vector: back, keep_original: false }, config);
    const flangeFinalId: string = moved2.solid_id;
    const flangeBboxAfter: Bbox = await dispatchTool('bounding_box', { target: flangeFinalId }, config) as Bbox;
    console.log(`[chained] flange after round-trip translate: ${fmt(flangeBboxAfter)}`);

    // ── Step 3: fuse the flange onto the CHAINED (already-merged) bracket —
    // the untested code path.
    let fuseError: unknown = null;
    let fused: any = null;
    try {
      fused = await dispatchTool('fuse_bodies', {
        transaction_id: txId, tools: [chainedMerge.merged_part_id, flangeFinalId],
      }, config);
    } catch (err) {
      fuseError = err;
      console.log(`[chained] fuse_bodies threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(fuseError, '[chained] fuse onto the chained bracket must not throw').toBeNull();
    if (!fused) return;

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[chained] fused (bracket+flange) bbox: ${fmt(fusedBbox)}`);
    const fusedFrame = getGeometryBinding().getPanelFrame(fused.solid_id as string);
    console.log(`[chained] fused frame: u=(${fusedFrame.uX.toFixed(3)},${fusedFrame.uY.toFixed(3)},${fusedFrame.uZ.toFixed(3)}) v=(${fusedFrame.vX.toFixed(3)},${fusedFrame.vY.toFixed(3)},${fusedFrame.vZ.toFixed(3)}) n=(${fusedFrame.normalX.toFixed(3)},${fusedFrame.normalY.toFixed(3)},${fusedFrame.normalZ.toFixed(3)})`);

    // ── The actual check: the fused bbox must equal the UNION of the
    // bracket's and the flange's own bboxes — no axis should grow MORE than
    // the union requires (that would mean the flange's footprint got rotated
    // 90° before fusing) and the bracket's untouched extents (the wallB side)
    // must survive unchanged (that would mean wallB's material got dropped).
    const expectedUnion: Bbox = {
      x_min: Math.min(chainedBbox.x_min, flangeBbox!.x_min), x_max: Math.max(chainedBbox.x_max, flangeBbox!.x_max),
      y_min: Math.min(chainedBbox.y_min, flangeBbox!.y_min), y_max: Math.max(chainedBbox.y_max, flangeBbox!.y_max),
      z_min: Math.min(chainedBbox.z_min, flangeBbox!.z_min), z_max: Math.max(chainedBbox.z_max, flangeBbox!.z_max),
    };
    console.log(`[chained] expected (union) bbox: ${fmt(expectedUnion)}`);
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(fusedBbox[k] - expectedUnion[k]);
      console.log(`  ${k}: expected=${expectedUnion[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}`);
      expect(delta,
        `[chained] [BUG] fused bbox.${k}: expected≈${expectedUnion[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm — ` +
        `wrong axis extended or wallB's material was dropped`)
        .toBeLessThanOrEqual(2.0);
    }

  }, 60_000);
});
