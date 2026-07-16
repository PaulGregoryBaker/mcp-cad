/**
 * Coordinate-level check (not just bbox/volume of the WHOLE result): does
 * merge_bodies_with_bend's 3D reconstruction correctly preserve panel A's
 * OWN shape (the "step" visible in the flat pattern, where a composite/fused
 * panel's flat-pattern outline isn't a plain rectangle), at the CORRECT
 * world-space location?
 *
 * geometry_service_shell.cc's bend reconstruction builds dxfA/dxfB via
 * makeDxfRect — a bounding-box RECTANGLE over each side's vertices, even
 * when the true panel shape is non-rectangular (documented, partially-fixed
 * issue — see project_seam_offset_fix memory's "ROOT CAUSE FOUND" section).
 * Panel A here is itself a composite (wall fused with a protrusion in an
 * EARLIER step) — its flat pattern can have an internal notch/step that a
 * pure bounding-box rectangle would erase. Whole-shape bbox and total-volume
 * checks (see testcube_protrusion_coplanar_merge) can BOTH pass even if this
 * happens, because the missing/added material is a small fraction of the
 * total and the overall bbox only cares about the extreme corners.
 *
 * This test isolates panel A specifically: merge_bodies_with_bend's contract
 * is that "part A never rotates" — so panel A's PRE-merge shape, queried at
 * its own (unchanged) world coordinates, should be EXACTLY recoverable from
 * the merged result via a boolean intersection with a probe box covering
 * panel A's own pre-merge bbox.
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

describe('[diagnostic] merge_bodies_with_bend: does panel A\'s own (composite/notched) shape survive intact at the correct world position?', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('fuse(innerYWall, +X protrusion) -> A; merge_bodies_with_bend(A, innerTop) compositeFirst (A doesn\'t rotate) -> A\'s pre-merge shape must be exactly recoverable at the SAME world coordinates', async () => {
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
      console.warn('[panelA-shape] could not classify required panels — skipping');
      return;
    }
    const innerYWall = innerYWallEntry.id;
    const innerTop = innerTopEntry.id;
    const plusXProtrusion = plusXProtrusionEntry.id;

    const txn: any = await dispatchTool('begin_transaction', { label: 'panelA-shape' }, config);
    const txId: string = txn.transaction_id;

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [plusXProtrusion], vector: [0, 75, 0], keep_original: false,
    }, config);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId, tools: [innerYWall, translated.solid_id],
    }, config);
    expect(fused.solid_id, 'fuse must succeed').toBeDefined();

    // Panel A's PRE-merge ground truth: its own bbox and volume, queried
    // directly on the actual fused shell before it goes anywhere near the
    // bend-merge reconstruction.
    const preMergeBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    const preMergeMass: any = await dispatchTool('mass_properties', { target: fused.solid_id, properties: ['volume'] }, config);
    console.log(`[panelA-shape] panel A (fused) PRE-merge: bbox=${fmt(preMergeBbox)} volume=${preMergeMass.volume?.toFixed(1)}mm3`);

    // compositeFirst: A=fused (must not rotate), B=innerTop.
    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId, part_a_id: fused.part_id, part_b_id: innerTop, target_edges: ['all'], bend_radius: 1.0,
    }, config);
    expect(merged.merged_shell_id, 'merge must succeed').toBeDefined();

    // Run solve_geometry to verify that graph-driven geometry reconstruction preserves Panel A shape.
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
    console.log(`[panelA-shape] merged result bbox: ${fmt(mergedBbox)}`);

    // Build a probe box covering panel A's PRE-merge bbox. Pad generously in
    // X/Z (no adjacent panel exists there to bleed into), but use ZERO
    // padding on Y (panel A's thickness axis, where it meets panel B at the
    // bend line) — any Y padding would legitimately capture a slice of
    // panel B's own (correctly positioned, post-rotation) material too,
    // since the two panels are physically adjacent right at that boundary.
    // That's not a bug; it would just make this probe non-discriminating.
    const PAD = 3;
    const gb = getGeometryBinding();
    const dxfRect = [
      '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
      '10', '0', '20', '0',
      '10', String(ext(preMergeBbox, 'x') + 2 * PAD), '20', '0',
      '10', String(ext(preMergeBbox, 'x') + 2 * PAD), '20', String(ext(preMergeBbox, 'z') + 2 * PAD),
      '10', '0', '20', String(ext(preMergeBbox, 'z') + 2 * PAD),
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const probeThickness = ext(preMergeBbox, 'y');
    const probe = gb.buildShellFromFlatPattern(dxfRect, [], probeThickness, {
      hasFrame: true,
      originX: preMergeBbox.x_min - PAD, originY: preMergeBbox.y_min, originZ: preMergeBbox.z_min - PAD,
      uX: 1, uY: 0, uZ: 0,
      vX: 0, vY: 0, vZ: 1,
      normalX: 0, normalY: 1, normalZ: 0,
      // nCentreMm is the world-space offset of the sheet's midplane ALONG
      // the normal, measured from the world origin (0,0,0) — NOT relative
      // to originY. World midplane Y must be y_min + probeThickness/2.
      nCentreMm: preMergeBbox.y_min + probeThickness / 2,
    });
    const probeBbox: Bbox = await dispatchTool('bounding_box', { target: probe.shellId }, config) as Bbox;
    console.log(`[panelA-shape] probe box bbox: ${fmt(probeBbox)}`);

    const intersected: any = await dispatchTool('intersect_bodies', {
      transaction_id: txId, target_a: solvedShellId as string, target_b: probe.shellId,
    }, config);
    expect(intersected.solid_id, '[panelA-shape] intersection with panel A\'s own probe region must not be empty').toBeDefined();
    const intersectedBbox: Bbox = await dispatchTool('bounding_box', { target: intersected.solid_id }, config) as Bbox;
    const intersectedMass: any = await dispatchTool('mass_properties', { target: intersected.solid_id, properties: ['volume'] }, config);
    console.log(`[panelA-shape] recovered panel-A-region bbox: ${fmt(intersectedBbox)} volume=${intersectedMass.volume?.toFixed(1)}mm3`);

    // The recovered region should be EXACTLY panel A's pre-merge shape —
    // same bbox, same volume — since part A never rotates and the probe
    // fully contains (with margin) only panel A's own world-space region.
    // 1.0mm is the intended tolerance; +1e-6 absorbs pure floating-point
    // noise from the underlying OCCT boolean ops (confirmed: this delta sits
    // exactly at the 1.0mm boundary by construction, and can land a few
    // ulps on either side depending on unrelated upstream computation order
    // — observed 1.0000000000000284 after an unrelated change reordered an
    // input polygon's vertices).
    const TOL_MM = 1.0 + 1e-6;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(intersectedBbox[k] - preMergeBbox[k]);
      expect(delta,
        `[panelA-shape] [BUG] recovered panel-A-region bbox.${k}=${intersectedBbox[k].toFixed(2)} doesn't match panel A's own pre-merge bbox.${k}=${preMergeBbox[k].toFixed(2)} (Δ=${delta.toFixed(2)}mm) — panel A's shape/step was altered by the bend reconstruction`)
        .toBeLessThanOrEqual(TOL_MM);
    }
    const volumeRatio = intersectedMass.volume / preMergeMass.volume;
    expect(volumeRatio,
      `[panelA-shape] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)}mm3 doesn't match panel A's own pre-merge volume=${preMergeMass.volume?.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)}) — panel A's internal notch/step was filled in or eroded by the bend reconstruction's rectangle-only (makeDxfRect) side panels`)
      .toBeGreaterThan(0.95);
    expect(volumeRatio,
      `[panelA-shape] [BUG] recovered panel-A-region volume=${intersectedMass.volume?.toFixed(1)}mm3 doesn't match panel A's own pre-merge volume=${preMergeMass.volume?.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)}) — panel A's internal notch/step was filled in or eroded by the bend reconstruction's rectangle-only (makeDxfRect) side panels`)
      .toBeLessThan(1.05);
  }, 60_000);
});
