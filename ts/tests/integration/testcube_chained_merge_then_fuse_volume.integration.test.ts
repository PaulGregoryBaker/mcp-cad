/**
 * testcube.step, MERGE-FIRST order (matching the user's actual op history:
 * Split -> Merge Bodies x3 -> Translate x4 -> Fuse Bodies, i.e. bend-merges
 * happen BEFORE the protrusion translate+fuse, not after). Earlier session
 * attempts at this exact order hit GE_FUSE_NOT_COPLANAR (fixed: see
 * project_fuse_chained_merge_and_undo_redo_fix Bug 1) using cube_with_flanges.stp;
 * this retries with testcube.step now that that fix is in place, and adds a
 * volume ground-truth check (bbox/normal-alignment checks can both pass for a
 * degenerate/sheared shape sharing the same bbox as a correct one).
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

describe('[diagnostic] testcube.step: merge_bodies_with_bend FIRST (chain), then translate+fuse a protrusion onto the chained bracket', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('merge(innerYWall, innerTop) -> chain; translate +X protrusion onto the chain; fuse -> volume must be conserved and exportGlb must succeed', async () => {
    const fixturePath = findFixture('testcube.step');
    if (!fixturePath) { console.warn('testcube.step missing — skipping'); return; }

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
    }, config);

    const panelBboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panelBboxes.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    const protBboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of (split.protrusion_ids ?? []) as string[]) {
      protBboxes.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }

    const innerYWallEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'z') > 140 &&
      bbox.y_min > 60 && bbox.y_min < 80);
    const innerTopEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'z') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'y') > 140 &&
      bbox.z_min > 60 && bbox.z_min < 80);
    const plusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_min > 70 && bbox.x_min < 80 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerYWallEntry || !innerTopEntry || !plusXProtrusionEntry) {
      console.warn('[chain-then-fuse] could not classify required panels — skipping');
      return;
    }
    const innerYWall = innerYWallEntry.id, innerYWallBbox = innerYWallEntry.bbox;
    const innerTop = innerTopEntry.id, innerTopBbox = innerTopEntry.bbox;
    const plusXProtrusion = plusXProtrusionEntry.id, plusXProtrusionBbox = plusXProtrusionEntry.bbox;
    console.log(`[chain-then-fuse] innerYWall: ${fmt(innerYWallBbox)}`);
    console.log(`[chain-then-fuse] innerTop:   ${fmt(innerTopBbox)}`);
    console.log(`[chain-then-fuse] protrusion: ${fmt(plusXProtrusionBbox)}`);

    // Ground-truth pre-chain volumes (measured directly).
    const wallMass: any = await dispatchTool('mass_properties', { target: innerYWall, properties: ['volume'] }, config);
    const topMass: any = await dispatchTool('mass_properties', { target: innerTop, properties: ['volume'] }, config);
    const protMass: any = await dispatchTool('mass_properties', { target: plusXProtrusion, properties: ['volume'] }, config);
    console.log(`[chain-then-fuse] pre-op volumes: wall=${wallMass.volume?.toFixed(1)} top=${topMass.volume?.toFixed(1)} prot=${protMass.volume?.toFixed(1)} sum=${(wallMass.volume + topMass.volume + protMass.volume).toFixed(1)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'chain-then-fuse' }, config);
    const txId: string = txn.transaction_id;

    // Step 1: merge_bodies_with_bend FIRST (the chain).
    const chained: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId, part_a_id: innerYWall, part_b_id: innerTop, target_edges: ['all'], bend_radius: 1.0,
    }, config);
    expect(chained.merged_shell_id, 'chained merge must succeed').toBeDefined();
    const chainedBbox: Bbox = await dispatchTool('bounding_box', { target: chained.merged_shell_id }, config) as Bbox;
    console.log(`[chain-then-fuse] chained bracket bbox: ${fmt(chainedBbox)}`);
    const chainedMass: any = await dispatchTool('mass_properties', { target: chained.merged_shell_id, properties: ['volume'] }, config);
    console.log(`[chain-then-fuse] chained bracket volume: actual=${chainedMass.volume?.toFixed(1)} expected≈${(wallMass.volume + topMass.volume).toFixed(1)}`);

    // Step 2: translate the +X protrusion +75mm in Y (same vector as the
    // working single-merge test) to land it coplanar with innerYWall's plane.
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [plusXProtrusion], vector: [0, 75, 0], keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[chain-then-fuse] shifted protrusion: ${fmt(translatedBbox)}`);

    // Step 3: fuse the protrusion onto the CHAINED bracket.
    let fuseError: unknown = null;
    let fused: any = null;
    try {
      fused = await dispatchTool('fuse_bodies', {
        transaction_id: txId, tools: [chained.merged_part_id, translatedId],
      }, config);
    } catch (err) {
      fuseError = err;
      console.log(`[chain-then-fuse] fuse_bodies threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(fuseError, '[chain-then-fuse] fuse onto the chained bracket must not throw').toBeNull();
    if (!fused) return;

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[chain-then-fuse] fused (chain+protrusion) bbox: ${fmt(fusedBbox)}`);

    // Solve the geometry to verify perfect reconstruction under graph solver.
    await dispatchTool('solve_geometry', {
      part_id: fused.part_id,
      transaction_id: txId,
    }, config);

    const graphAfterSolve: any = await dispatchTool('query_graph', {
      part_id: fused.part_id,
    }, config);
    const canonicalPanelNode = graphAfterSolve.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical === true);
    expect(canonicalPanelNode).toBeDefined();
    const solvedShellId = canonicalPanelNode.bodyId;
    expect(solvedShellId).toBeDefined();

    const fusedMass: any = await dispatchTool('mass_properties', { target: solvedShellId as string, properties: ['volume'] }, config);
    const expectedVolume = chainedMass.volume + protMass.volume;
    console.log(`[chain-then-fuse] fused volume: actual=${fusedMass.volume?.toFixed(1)} expected≈${expectedVolume.toFixed(1)}`);
    const volumeRatio = fusedMass.volume / expectedVolume;
    expect(volumeRatio, `[chain-then-fuse] [BUG] fused volume=${fusedMass.volume?.toFixed(1)}mm3 doesn't match expected≈${expectedVolume.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)})`)
      .toBeGreaterThan(0.85);
    expect(volumeRatio, `[chain-then-fuse] [BUG] fused volume=${fusedMass.volume?.toFixed(1)}mm3 doesn't match expected≈${expectedVolume.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)})`)
      .toBeLessThan(1.15);

    let glbError: unknown = null;
    try {
      const glb = getGeometryBinding().exportGlb(solvedShellId as string);
      console.log(`[chain-then-fuse] exportGlb succeeded, ${glb.length} bytes`);
    } catch (err) {
      glbError = err;
      console.log(`[chain-then-fuse] exportGlb threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(glbError, '[chain-then-fuse] [BUG] exportGlb threw — viewport would render the crude fallback box').toBeNull();
  }, 60_000);
});
