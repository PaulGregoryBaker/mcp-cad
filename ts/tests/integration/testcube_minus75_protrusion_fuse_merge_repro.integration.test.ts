/**
 * EXACT reproduction of the user's reported steps (verbatim):
 *   1. Load testcube fixture
 *   2. Split by bends
 *   3. Move protrusion by -75mm in x or y direction (whichever aligns to the
 *      plane normal) to align with inner cube panel
 *   4. Fuse panel and protrusion that are coplanar to form a new panel
 *   5. Merge by bend with the top of the inner cube
 *
 * Differs from every earlier reproduction this session in ONE specific way:
 * uses -75mm (aligning the +X protrusion with the inner -Y wall), not +75mm
 * (inner +Y wall). The fuse step alone was already validated in both
 * directions (Bug 4's minusXProtrusion case), but the SUBSEQUENT
 * merge_bodies_with_bend step was only ever tested through the +Y-wall path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding } from '../../src/mcp/state';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';

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

describe('[repro] testcube.step: -75mm protrusion alignment (inner -Y wall), fuse, merge with inner top', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('+X protrusion moved -75mm in Y onto inner -Y wall, fused, merged with inner top — must conserve volume, preserve panel-A shape at the right coordinates, and export a real mesh', async () => {
    const fixturePath = findFixture('testcube.step');
    if (!fixturePath) { console.warn('testcube.step missing — skipping'); return; }

    // Step 1+2: load + split.
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

    // Inner -Y wall: thin in Y, y_max in [-80,-60] (mirror of the +Y wall classification).
    const innerMinusYWallEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'z') > 140 &&
      bbox.y_max > -80 && bbox.y_max < -60);
    const innerTopEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'z') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'y') > 140 &&
      bbox.z_min > 60 && bbox.z_min < 80);
    // +X protrusion: bridges the X gap, normal=Y (centered near y=0).
    const plusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_min > 70 && bbox.x_min < 80 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerMinusYWallEntry || !innerTopEntry || !plusXProtrusionEntry) {
      console.warn('[minus75-repro] could not classify required panels:', {
        innerMinusYWall: !!innerMinusYWallEntry, innerTop: !!innerTopEntry, plusXProtrusion: !!plusXProtrusionEntry,
      });
      return;
    }
    const innerMinusYWall = innerMinusYWallEntry.id, innerMinusYWallBbox = innerMinusYWallEntry.bbox;
    const innerTop = innerTopEntry.id, innerTopBbox = innerTopEntry.bbox;
    const plusXProtrusion = plusXProtrusionEntry.id, plusXProtrusionBbox = plusXProtrusionEntry.bbox;
    console.log(`[minus75-repro] innerMinusYWall: ${fmt(innerMinusYWallBbox)}`);
    console.log(`[minus75-repro] innerTop:        ${fmt(innerTopBbox)}`);
    console.log(`[minus75-repro] protrusion:      ${fmt(plusXProtrusionBbox)}`);

    const wallMass: any = await dispatchTool('mass_properties', { target: innerMinusYWall, properties: ['volume'] }, config);
    const topMass: any = await dispatchTool('mass_properties', { target: innerTop, properties: ['volume'] }, config);
    const protMass: any = await dispatchTool('mass_properties', { target: plusXProtrusion, properties: ['volume'] }, config);
    console.log(`[minus75-repro] pre-op volumes: wall=${wallMass.volume?.toFixed(1)} top=${topMass.volume?.toFixed(1)} prot=${protMass.volume?.toFixed(1)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'minus75-repro' }, config);
    const txId: string = txn.transaction_id;

    // Step 3: move protrusion by -75mm in Y (its plane-normal axis) to align with the inner -Y wall.
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [plusXProtrusion], vector: [0, -75, 0], keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[minus75-repro] shifted protrusion: ${fmt(translatedBbox)}`);

    // Step 4: fuse the wall and the now-coplanar protrusion.
    let fuseError: unknown = null;
    let fused: any = null;
    try {
      fused = await dispatchTool('fuse_bodies', { transaction_id: txId, tools: [innerMinusYWall, translatedId] }, config);
    } catch (err) {
      fuseError = err;
      console.log(`[minus75-repro] fuse_bodies threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(fuseError, '[minus75-repro] fuse_bodies must not throw').toBeNull();
    if (!fused) return;

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    const fusedMass: any = await dispatchTool('mass_properties', { target: fused.solid_id, properties: ['volume'] }, config);
    console.log(`[minus75-repro] fused panel bbox: ${fmt(fusedBbox)} volume=${fusedMass.volume?.toFixed(1)}`);

    const unfoldFused: any = await dispatchTool('apply_unfold', {
      transaction_id: txId, part_id: fused.part_id, panel_id: fused.part_id, material_id: config.materials[0]!.id,
    }, config);
    console.log(`[minus75-repro] fused flat: ${unfoldFused.flat_width_mm?.toFixed(1)} x ${unfoldFused.flat_height_mm?.toFixed(1)}mm`);

    // Step 5: merge by bend with the inner top — fused panel as part A (must not rotate).
    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: fused.part_id, part_b_id: innerTop, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[minus75-repro] merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, '[minus75-repro] merge_bodies_with_bend must not throw').toBeNull();
    if (!merged) return;

    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    console.log(`[minus75-repro] merged result bbox: ${fmt(mergedBbox)}`);

    const unfold: any = await dispatchTool('apply_unfold', {
      transaction_id: txId, part_id: merged.merged_part_id, panel_id: merged.merged_part_id, material_id: config.materials[0]!.id,
    }, config);
    console.log(`[minus75-repro] merged flat: ${unfold.flat_width_mm?.toFixed(1)} x ${unfold.flat_height_mm?.toFixed(1)}mm`);

    // Diagnostic: dump the merged DXF's actual vertices, split into
    // "low-X" (panel A's side) and "high-X" (panel B's side) groups at the
    // midpoint, to see directly whether the 2D flat pattern ALREADY shows
    // panel B with the wrong (174mm) Y-extent, or whether that's introduced
    // later by the C++ 3D reconstruction.
    if (unfold.dxf_content) {
      const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
      let xMin = Infinity, xMax = -Infinity;
      for (const [x] of ring) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
      const xMid = (xMin + xMax) / 2;
      console.log(`[minus75-repro] merged DXF vertices (xMin=${xMin.toFixed(2)} xMax=${xMax.toFixed(2)} xMid=${xMid.toFixed(2)}):`);
      for (const [x, y] of ring) {
        console.log(`  (${x.toFixed(2)}, ${y.toFixed(2)}) ${x < xMid ? '[low-X / A side]' : '[high-X / B side]'}`);
      }
      const lowXYs = ring.filter(([x]) => x < xMid).map(([, y]) => y);
      const highXYs = ring.filter(([x]) => x >= xMid).map(([, y]) => y);
      console.log(`[minus75-repro] low-X (A) Y-range: [${Math.min(...lowXYs).toFixed(2)}, ${Math.max(...lowXYs).toFixed(2)}] extent=${(Math.max(...lowXYs) - Math.min(...lowXYs)).toFixed(2)}`);
      console.log(`[minus75-repro] high-X (B) Y-range: [${Math.min(...highXYs).toFixed(2)}, ${Math.max(...highXYs).toFixed(2)}] extent=${(Math.max(...highXYs) - Math.min(...highXYs)).toFixed(2)}`);
    }

    // ── Check 1 (mesh export): must succeed on the real geometry (not
    // silently fall back to mesh/server.ts's crude topology-estimated box).
    // Run BEFORE the intersect_bodies probe below, which consumes/invalidates
    // merged.merged_shell_id as one of its boolean inputs.
    const gbEarly = getGeometryBinding();
    let glbError: unknown = null;
    try {
      const glb = gbEarly.exportGlb(merged.merged_shell_id as string);
      console.log(`[minus75-repro] exportGlb succeeded, ${glb.length} bytes`);
    } catch (err) {
      glbError = err;
      console.log(`[minus75-repro] exportGlb threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(glbError, '[minus75-repro] [BUG] exportGlb threw').toBeNull();

    // ── Check 2: whole-result volume conservation (ground truth, not estimated). ──
    const mergedMass: any = await dispatchTool('mass_properties', { target: merged.merged_shell_id, properties: ['volume'] }, config);
    const expectedTotalVolume = fusedMass.volume + topMass.volume;
    const totalRatio = mergedMass.volume / expectedTotalVolume;
    console.log(`[minus75-repro] merged volume: actual=${mergedMass.volume?.toFixed(1)} expected≈${expectedTotalVolume.toFixed(1)} ratio=${totalRatio.toFixed(3)}`);
    expect(totalRatio, `[minus75-repro] [BUG] merged volume ratio=${totalRatio.toFixed(3)} — total volume not conserved`).toBeGreaterThan(0.9);
    expect(totalRatio, `[minus75-repro] [BUG] merged volume ratio=${totalRatio.toFixed(3)} — total volume not conserved`).toBeLessThan(1.1);

    // ── Check 2: coordinate-level — panel A's (the fused panel's) own shape
    // must survive at its EXACT pre-merge world coordinates, since part A
    // never rotates in merge_bodies_with_bend. Probe with zero padding on
    // the thickness axis (where A and B are physically adjacent at the bend
    // line) to avoid legitimately capturing B's own material too.
    const gb = getGeometryBinding();
    const PAD = 3;
    const dxfRect = [
      '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
      '10', '0', '20', '0',
      '10', String(ext(fusedBbox, 'x') + 2 * PAD), '20', '0',
      '10', String(ext(fusedBbox, 'x') + 2 * PAD), '20', String(ext(fusedBbox, 'z') + 2 * PAD),
      '10', '0', '20', String(ext(fusedBbox, 'z') + 2 * PAD),
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const probeThickness = ext(fusedBbox, 'y');
    const probe = gb.buildShellFromFlatPattern(dxfRect, [], probeThickness, {
      hasFrame: true,
      originX: fusedBbox.x_min - PAD, originY: fusedBbox.y_min, originZ: fusedBbox.z_min - PAD,
      uX: 1, uY: 0, uZ: 0,
      vX: 0, vY: 0, vZ: 1,
      normalX: 0, normalY: 1, normalZ: 0,
      nCentreMm: fusedBbox.y_min + probeThickness / 2,
    });
    const probeBbox: Bbox = await dispatchTool('bounding_box', { target: probe.shellId }, config) as Bbox;
    console.log(`[minus75-repro] probe box bbox: ${fmt(probeBbox)}`);

    // Make safe copies of the merged shell AND the probe BEFORE any
    // destructive boolean op consumes the originals (confirmed:
    // intersect_bodies/cut_bodies invalidate BOTH their targets for later
    // calls — exportGlb on target_a failed, and reusing target_b in a later
    // cut_bodies call failed with GE_SHELL_NOT_FOUND).
    const mergedCopy: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [merged.merged_shell_id], vector: [0, 0, 0], keep_original: true,
    }, config);
    const probeCopy: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [probe.shellId], vector: [0, 0, 0], keep_original: true,
    }, config);

    const intersected: any = await dispatchTool('intersect_bodies', {
      transaction_id: txId, target_a: merged.merged_shell_id, target_b: probe.shellId,
    }, config);
    expect(intersected.solid_id, '[minus75-repro] [BUG] intersection with panel A\'s own probe region must not be empty').toBeDefined();
    if (!intersected.solid_id) return;
    const intersectedBbox: Bbox = await dispatchTool('bounding_box', { target: intersected.solid_id }, config) as Bbox;
    const intersectedMass: any = await dispatchTool('mass_properties', { target: intersected.solid_id, properties: ['volume'] }, config);
    console.log(`[minus75-repro] recovered panel-A-region bbox: ${fmt(intersectedBbox)} volume=${intersectedMass.volume?.toFixed(1)}`);

    const TOL_MM = 1.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(intersectedBbox[k] - fusedBbox[k]);
      expect(delta,
        `[minus75-repro] [BUG] recovered panel-A-region bbox.${k}=${intersectedBbox[k].toFixed(2)} doesn't match panel A's own pre-merge bbox.${k}=${fusedBbox[k].toFixed(2)} (Δ=${delta.toFixed(2)}mm)`)
        .toBeLessThanOrEqual(TOL_MM);
    }
    const panelARatio = intersectedMass.volume / fusedMass.volume;
    expect(panelARatio,
      `[minus75-repro] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)} doesn't match panel A's own pre-merge volume=${fusedMass.volume?.toFixed(1)} (ratio=${panelARatio.toFixed(3)})`)
      .toBeGreaterThan(0.95);
    expect(panelARatio,
      `[minus75-repro] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)} doesn't match panel A's own pre-merge volume=${fusedMass.volume?.toFixed(1)} (ratio=${panelARatio.toFixed(3)})`)
      .toBeLessThan(1.05);

    // ── Check 4 (the user's specific claim): does panel B's (innerTop's) OWN
    // region of the merged result retain its OWN 150x150 footprint, or did
    // it incorrectly inherit panel A's extra 24mm (becoming ~174x150)?
    // Isolate panel B's region by cutting panel A's probe OUT of a copy of
    // the merged shape — whatever remains is panel B's (+ bend connector's)
    // contribution.
    const cutResult: any = await dispatchTool('cut_bodies', {
      transaction_id: txId, blank: mergedCopy.solid_id, tools: [probeCopy.solid_id], keep_tools: false,
    }, config);
    expect(cutResult.solid_id, '[minus75-repro] [BUG] panel B region (merged minus panel A probe) must not be empty').toBeDefined();
    const panelBBbox: Bbox = await dispatchTool('bounding_box', { target: cutResult.solid_id }, config) as Bbox;
    const panelBMass: any = await dispatchTool('mass_properties', { target: cutResult.solid_id, properties: ['volume'] }, config);
    console.log(`[minus75-repro] panel-B-region (innerTop) bbox: ${fmt(panelBBbox)} volume=${panelBMass.volume?.toFixed(1)}`);
    console.log(`[minus75-repro] panel-B-region extents: x=${ext(panelBBbox, 'x').toFixed(2)} y=${ext(panelBBbox, 'y').toFixed(2)} z=${ext(panelBBbox, 'z').toFixed(2)}`);
    console.log(`[minus75-repro] innerTop's OWN pre-merge extents: x=${ext(innerTopBbox, 'x').toFixed(2)} y=${ext(innerTopBbox, 'y').toFixed(2)} z=${ext(innerTopBbox, 'z').toFixed(2)}`);

    // innerTop's own footprint was 150x150 (x and y extents, before folding).
    // After a 90-degree fold, ONE of its in-plane axes becomes the new
    // thickness-adjacent direction, but its OTHER in-plane extent (the one
    // unaffected by the fold, here X — the bend axis direction) must stay
    // EXACTLY 150mm — it has no reason to grow by the protrusion's 24mm.
    const panelBExtentX = ext(panelBBbox, 'x');
    expect(Math.abs(panelBExtentX - ext(innerTopBbox, 'x')),
      `[minus75-repro] [BUG] panel B's (innerTop's) region X-extent=${panelBExtentX.toFixed(2)}mm, expected≈${ext(innerTopBbox, 'x').toFixed(2)}mm (its own unchanged width) — it appears to have inherited panel A's extra width instead of keeping its own`)
      .toBeLessThanOrEqual(3.0);
  }, 60_000);
});
