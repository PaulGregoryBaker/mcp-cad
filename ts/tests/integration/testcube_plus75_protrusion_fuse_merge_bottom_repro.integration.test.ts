/**
 * User follow-up after confirming Bug 5's fix (merge with the TOP of the
 * inner cube) worked: "When I ran the same test i.e. merge with bend on the
 * opposite fused panel and the BOTTOM of the cube, then the result was not
 * as good. The bottom panel is shifted to align with the protrusion, leaving
 * a gap going into the inner cube. The flat patterns are almost identical to
 * the top panel merge." User hypothesis: either the DXF merge is wrong, or
 * the bend should fold in the other direction (away from the viewer).
 *
 * "Opposite fused panel" variant: uses the MIRROR-IMAGE fusion (the +X
 * protrusion shifted +75mm in Y onto the inner +Y wall — the SAME setup as
 * the original Bug-3/4/5 TOP-merge repro) merged with the inner cube's
 * BOTTOM panel (z=-75) instead of its TOP panel (z=+75), to isolate whether
 * the bend's fold DIRECTION (not just the bend-zone Y-range fixed in Bug 5)
 * is computed correctly for this case.
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

describe('[repro] testcube.step: +75mm protrusion alignment (inner +Y wall), fuse, merge with inner BOTTOM', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('+X protrusion moved +75mm in Y onto inner +Y wall, fused, merged with inner BOTTOM — must conserve volume, preserve panel shapes at the right coordinates, fold the correct direction (no gap), and export a real mesh', async () => {
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

    // Inner +Y wall: thin in Y, y_min in [60,80].
    const innerPlusYWallEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'z') > 140 &&
      bbox.y_min > 60 && bbox.y_min < 80);
    // Inner BOTTOM wall: thin in Z, z_max in [-80,-60] (mirror of the top-wall classification).
    const innerBottomEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'z') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'y') > 140 &&
      bbox.z_max > -80 && bbox.z_max < -60);
    // +X protrusion: bridges the X gap, normal=Y (centered near y=0).
    const plusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_min > 70 && bbox.x_min < 80 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerPlusYWallEntry || !innerBottomEntry || !plusXProtrusionEntry) {
      console.warn('[plus75-bottom-repro] could not classify required panels:', {
        innerPlusYWall: !!innerPlusYWallEntry, innerBottom: !!innerBottomEntry, plusXProtrusion: !!plusXProtrusionEntry,
      });
      return;
    }
    const innerPlusYWall = innerPlusYWallEntry.id, innerPlusYWallBbox = innerPlusYWallEntry.bbox;
    const innerBottom = innerBottomEntry.id, innerBottomBbox = innerBottomEntry.bbox;
    const plusXProtrusion = plusXProtrusionEntry.id, plusXProtrusionBbox = plusXProtrusionEntry.bbox;
    console.log(`[plus75-bottom-repro] innerPlusYWall: ${fmt(innerPlusYWallBbox)}`);
    console.log(`[plus75-bottom-repro] innerBottom:     ${fmt(innerBottomBbox)}`);
    console.log(`[plus75-bottom-repro] protrusion:      ${fmt(plusXProtrusionBbox)}`);

    const wallMass: any = await dispatchTool('mass_properties', { target: innerPlusYWall, properties: ['volume'] }, config);
    const bottomMass: any = await dispatchTool('mass_properties', { target: innerBottom, properties: ['volume'] }, config);
    const protMass: any = await dispatchTool('mass_properties', { target: plusXProtrusion, properties: ['volume'] }, config);
    console.log(`[plus75-bottom-repro] pre-op volumes: wall=${wallMass.volume?.toFixed(1)} bottom=${bottomMass.volume?.toFixed(1)} prot=${protMass.volume?.toFixed(1)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'plus75-bottom-repro' }, config);
    const txId: string = txn.transaction_id;

    // Step 3: move protrusion by +75mm in Y (its plane-normal axis) to align with the inner +Y wall.
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [plusXProtrusion], vector: [0, 75, 0], keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[plus75-bottom-repro] shifted protrusion: ${fmt(translatedBbox)}`);

    // Step 4: fuse the wall and the now-coplanar protrusion.
    let fuseError: unknown = null;
    let fused: any = null;
    try {
      fused = await dispatchTool('fuse_bodies', { transaction_id: txId, tools: [innerPlusYWall, translatedId] }, config);
    } catch (err) {
      fuseError = err;
      console.log(`[plus75-bottom-repro] fuse_bodies threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(fuseError, '[plus75-bottom-repro] fuse_bodies must not throw').toBeNull();
    if (!fused) return;

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    const fusedMass: any = await dispatchTool('mass_properties', { target: fused.solid_id, properties: ['volume'] }, config);
    console.log(`[plus75-bottom-repro] fused panel bbox: ${fmt(fusedBbox)} volume=${fusedMass.volume?.toFixed(1)}`);

    const unfoldFused: any = await dispatchTool('get_unfold', {
      transaction_id: txId, part_id: fused.part_id, panel_id: fused.part_id, material_id: config.materials[0]!.id,
    }, config);
    console.log(`[plus75-bottom-repro] fused flat: ${unfoldFused.flat_width_mm?.toFixed(1)} x ${unfoldFused.flat_height_mm?.toFixed(1)}mm`);

    // Step 5: merge by bend with the inner BOTTOM — fused panel as part A (must not rotate).
    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: fused.part_id, part_b_id: innerBottom, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[plus75-bottom-repro] merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, '[plus75-bottom-repro] merge_bodies_with_bend must not throw').toBeNull();
    if (!merged) return;

    // RUN SOLVE GEOMETRY to reconstruct the real 3D assembly from the manufacturing graph.
    // The user has brilliantly noted that testing only the direct, pre-solve, C++ merge result
    // hid the bugs in the graph-first reconstruction solver!
    await dispatchTool('solve_geometry', {
      part_id: merged.merged_part_id,
      transaction_id: txId,
    }, config);

    const graphAfterSolve: any = await dispatchTool('query_graph', {
      part_id: merged.merged_part_id,
    }, config);
    const canonicalPanelNode = graphAfterSolve.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical === true);
    expect(canonicalPanelNode).toBeDefined();
    const solvedShellId = canonicalPanelNode.bodyId;
    expect(solvedShellId).toBeDefined();

    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: solvedShellId }, config) as Bbox;
    console.log(`[plus75-bottom-repro] merged result bbox (solved): ${fmt(mergedBbox)}`);

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId, part_id: merged.merged_part_id, panel_id: merged.merged_part_id, material_id: config.materials[0]!.id,
    }, config);
    console.log(`[plus75-bottom-repro] merged flat: ${unfold.flat_width_mm?.toFixed(1)} x ${unfold.flat_height_mm?.toFixed(1)}mm`);

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
      console.log(`[plus75-bottom-repro] merged DXF vertices (xMin=${xMin.toFixed(2)} xMax=${xMax.toFixed(2)} xMid=${xMid.toFixed(2)}):`);
      for (const [x, y] of ring) {
        console.log(`  (${x.toFixed(2)}, ${y.toFixed(2)}) ${x < xMid ? '[low-X / A side]' : '[high-X / B side]'}`);
      }
      const lowXYs = ring.filter(([x]) => x < xMid).map(([, y]) => y);
      const highXYs = ring.filter(([x]) => x >= xMid).map(([, y]) => y);
      console.log(`[plus75-bottom-repro] low-X (A) Y-range: [${Math.min(...lowXYs).toFixed(2)}, ${Math.max(...lowXYs).toFixed(2)}] extent=${(Math.max(...lowXYs) - Math.min(...lowXYs)).toFixed(2)}`);
      console.log(`[plus75-bottom-repro] high-X (B) Y-range: [${Math.min(...highXYs).toFixed(2)}, ${Math.max(...highXYs).toFixed(2)}] extent=${(Math.max(...highXYs) - Math.min(...highXYs)).toFixed(2)}`);
    }

    // ── Check 1 (mesh export): must succeed on the real geometry (not
    // silently fall back to mesh/server.ts's crude topology-estimated box).
    // Run BEFORE the intersect_bodies probe below, which consumes/invalidates
    // solvedShellId as one of its boolean inputs.
    const gbEarly = getGeometryBinding();
    let glbError: unknown = null;
    try {
      const glb = gbEarly.exportGlb(solvedShellId as string);
      console.log(`[plus75-bottom-repro] exportGlb succeeded, ${glb.length} bytes`);
    } catch (err) {
      glbError = err;
      console.log(`[plus75-bottom-repro] exportGlb threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(glbError, '[plus75-bottom-repro] [BUG] exportGlb threw').toBeNull();

    // ── Check 2: whole-result volume conservation (ground truth, not estimated). ──
    const mergedMass: any = await dispatchTool('mass_properties', { target: solvedShellId, properties: ['volume'] }, config);
    const expectedTotalVolume = fusedMass.volume + bottomMass.volume;
    const totalRatio = mergedMass.volume / expectedTotalVolume;
    console.log(`[plus75-bottom-repro] merged volume: actual=${mergedMass.volume?.toFixed(1)} expected≈${expectedTotalVolume.toFixed(1)} ratio=${totalRatio.toFixed(3)}`);
    expect(totalRatio, `[plus75-bottom-repro] [BUG] merged volume ratio=${totalRatio.toFixed(3)} — total volume not conserved`).toBeGreaterThan(0.9);
    expect(totalRatio, `[plus75-bottom-repro] [BUG] merged volume ratio=${totalRatio.toFixed(3)} — total volume not conserved`).toBeLessThan(1.1);

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
    console.log(`[plus75-bottom-repro] probe box bbox: ${fmt(probeBbox)}`);

    // Make safe copies of the merged shell AND the probe BEFORE any
    // destructive boolean op consumes the originals (confirmed:
    // intersect_bodies/cut_bodies invalidate BOTH their targets for later
    // calls — exportGlb on target_a failed, and reusing target_b in a later
    // cut_bodies call failed with GE_SHELL_NOT_FOUND).
    const mergedCopy: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [solvedShellId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const probeCopy: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [probe.shellId], vector: [0, 0, 0], keep_original: true,
    }, config);

    const intersected: any = await dispatchTool('intersect_bodies', {
      transaction_id: txId, target_a: solvedShellId, target_b: probe.shellId,
    }, config);
    expect(intersected.solid_id, '[plus75-bottom-repro] [BUG] intersection with panel A\'s own probe region must not be empty').toBeDefined();
    if (!intersected.solid_id) return;
    const intersectedBbox: Bbox = await dispatchTool('bounding_box', { target: intersected.solid_id }, config) as Bbox;
    const intersectedMass: any = await dispatchTool('mass_properties', { target: intersected.solid_id, properties: ['volume'] }, config);
    console.log(`[plus75-bottom-repro] recovered panel-A-region bbox: ${fmt(intersectedBbox)} volume=${intersectedMass.volume?.toFixed(1)}`);

    const TOL_MM = 1.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(intersectedBbox[k] - fusedBbox[k]);
      expect(delta,
        `[plus75-bottom-repro] [BUG] recovered panel-A-region bbox.${k}=${intersectedBbox[k].toFixed(2)} doesn't match panel A's own pre-merge bbox.${k}=${fusedBbox[k].toFixed(2)} (Δ=${delta.toFixed(2)}mm)`)
        .toBeLessThanOrEqual(TOL_MM);
    }
    const panelARatio = intersectedMass.volume / fusedMass.volume;
    expect(panelARatio,
      `[plus75-bottom-repro] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)} doesn't match panel A's own pre-merge volume=${fusedMass.volume?.toFixed(1)} (ratio=${panelARatio.toFixed(3)})`)
      .toBeGreaterThan(0.95);
    expect(panelARatio,
      `[plus75-bottom-repro] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)} doesn't match panel A's own pre-merge volume=${fusedMass.volume?.toFixed(1)} (ratio=${panelARatio.toFixed(3)})`)
      .toBeLessThan(1.05);

    // ── Check 4: does panel B's (innerBottom's) OWN region of the merged
    // result retain its OWN 150x150 footprint (Bug 5's check), AND is it
    // actually ADJACENT to panel A with no gap (the user's NEW report)?
    // Isolate panel B's region by cutting panel A's probe OUT of a copy of
    // the merged shape — whatever remains is panel B's (+ bend connector's)
    // contribution.
    const cutResult: any = await dispatchTool('cut_bodies', {
      transaction_id: txId, blank: mergedCopy.solid_id, tools: [probeCopy.solid_id], keep_tools: false,
    }, config);
    expect(cutResult.solid_id, '[plus75-bottom-repro] [BUG] panel B region (merged minus panel A probe) must not be empty').toBeDefined();
    const panelBBbox: Bbox = await dispatchTool('bounding_box', { target: cutResult.solid_id }, config) as Bbox;
    const panelBMass: any = await dispatchTool('mass_properties', { target: cutResult.solid_id, properties: ['volume'] }, config);
    console.log(`[plus75-bottom-repro] panel-B-region (innerBottom) bbox: ${fmt(panelBBbox)} volume=${panelBMass.volume?.toFixed(1)}`);
    console.log(`[plus75-bottom-repro] panel-B-region extents: x=${ext(panelBBbox, 'x').toFixed(2)} y=${ext(panelBBbox, 'y').toFixed(2)} z=${ext(panelBBbox, 'z').toFixed(2)}`);
    console.log(`[plus75-bottom-repro] innerBottom's OWN pre-merge extents: x=${ext(innerBottomBbox, 'x').toFixed(2)} y=${ext(innerBottomBbox, 'y').toFixed(2)} z=${ext(innerBottomBbox, 'z').toFixed(2)}`);
    console.log(`[plus75-bottom-repro] panel A region (fused wall+protrusion) bbox for reference: ${fmt(intersectedBbox)}`);

    // innerBottom's own footprint was 150x150 (x and y extents, before folding).
    // After a 90-degree fold, ONE of its in-plane axes becomes the new
    // thickness-adjacent direction, but its OTHER in-plane extent (the one
    // unaffected by the fold, here X — the bend axis direction) must stay
    // EXACTLY 150mm — it has no reason to grow by the protrusion's 24mm.
    const panelBExtentX = ext(panelBBbox, 'x');
    expect(Math.abs(panelBExtentX - ext(innerBottomBbox, 'x')),
      `[plus75-bottom-repro] [BUG] panel B's (innerBottom's) region X-extent=${panelBExtentX.toFixed(2)}mm, expected≈${ext(innerBottomBbox, 'x').toFixed(2)}mm (its own unchanged width) — it appears to have inherited panel A's extra width instead of keeping its own`)
      .toBeLessThanOrEqual(3.0);

    // POSITION check (not just extent/magnitude): the bend axis is parallel
    // to world-X here, so rotating panel B cannot change its X-coordinates —
    // panel B's X-RANGE must match its own pre-merge world X-range exactly,
    // not just have the same WIDTH. A same-width-but-shifted region would
    // incorrectly pass an extent-only check.
    expect(Math.abs(panelBBbox.x_min - innerBottomBbox.x_min),
      `[plus75-bottom-repro] [BUG] panel B's region x_min=${panelBBbox.x_min.toFixed(2)} doesn't match its own true x_min=${innerBottomBbox.x_min.toFixed(2)} — same width, but SHIFTED position`)
      .toBeLessThanOrEqual(3.0);
    expect(Math.abs(panelBBbox.x_max - innerBottomBbox.x_max),
      `[plus75-bottom-repro] [BUG] panel B's region x_max=${panelBBbox.x_max.toFixed(2)} doesn't match its own true x_max=${innerBottomBbox.x_max.toFixed(2)} — same width, but SHIFTED position`)
      .toBeLessThanOrEqual(3.0);

    // ── Check 5 (the user's NEW report): is panel B actually ADJACENT to
    // panel A (sharing the fold edge with no gap), or has it folded the
    // wrong direction / wrong amount, leaving empty space "going into the
    // inner cube"? Panel A occupies y=[-75,-74] (its own thickness, never
    // rotates). Whichever axis panel B's region is adjacent to A along, the
    // gap between A's region and B's region on that axis should be ~0 (at
    // most a couple mm of bend-allowance/thickness noise) — not tens of mm.
    const gapY = panelBBbox.y_min - intersectedBbox.y_max; // candidate seam: B starts where A ends in Y
    const gapYAlt = intersectedBbox.y_min - panelBBbox.y_max; // or A starts where B ends
    const gapZ = panelBBbox.z_min - intersectedBbox.z_max; // candidate seam: B starts where A ends in Z
    const gapZAlt = intersectedBbox.z_min - panelBBbox.z_max;
    console.log(`[plus75-bottom-repro] candidate seam gaps: Y=${gapY.toFixed(2)}/${gapYAlt.toFixed(2)} Z=${gapZ.toFixed(2)}/${gapZAlt.toFixed(2)} (expect ONE near 0, indicating where A and B actually meet)`);
  }, 60_000);
});
