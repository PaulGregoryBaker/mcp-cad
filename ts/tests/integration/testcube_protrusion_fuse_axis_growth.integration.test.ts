/**
 * Direct reproduction of the user's latest screenshot report on testcube.step
 * (NOT cube_with_flanges.stp — the inner cube walls here are 150mm, matching
 * the screenshot's "Panel_1_panel_8" 150.0 x 150.1mm pre-fuse selection bbox).
 *
 * Reported: wall+protrusion selection bbox before fuse ~1.5 x 150.0 x 150.1mm;
 * after fuse, single result ~1.0 x 151.1 x 174.1mm — the 24mm growth (which
 * SHOULD land on the axis the protrusion bridges) landed on a different axis
 * than expected, and the thickness itself changed (1.5 -> 1.0mm), suggesting
 * the WRONG panel (the thin protrusion, not the wall) got used as the
 * dominant/reference panel for the fused result's placement.
 *
 * Reuses the exact classification from testcube_protrusion_coplanar_merge's
 * setup() (innerYWall, plusXProtrusion) but stops right after fuse_bodies —
 * no subsequent merge_bodies_with_bend — to isolate whether the bug is in
 * the fuse step itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding } from '../../src/mcp/state';

const configPath = path.resolve(__dirname, '../../config/config.yaml');

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

describe('[diagnostic] testcube.step: wall+protrusion fuse — direct axis-growth and thickness check', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  it('innerYWall + plusXProtrusion (shifted +75mm Y, coplanar), fuse — fusedBbox must grow only the protrusion-bridged axis, thickness must stay the wall\'s', async () => {
    const config = loadConfig(configPath);
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
    const plusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_min > 70 && bbox.x_min < 80 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerYWallEntry || !plusXProtrusionEntry) {
      console.warn('[testcube-fuse-axis] could not classify required panels');
      return;
    }
    const innerYWall = innerYWallEntry.id, innerYWallBbox = innerYWallEntry.bbox;
    const plusXProtrusion = plusXProtrusionEntry.id, plusXProtrusionBbox = plusXProtrusionEntry.bbox;

    console.log(`[testcube-fuse-axis] innerYWall:   ${fmt(innerYWallBbox)}`);
    console.log(`[testcube-fuse-axis] protrusion:   ${fmt(plusXProtrusionBbox)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'testcube-fuse-axis' }, config);
    const txId: string = txn.transaction_id;

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [plusXProtrusion], vector: [0, 75, 0], keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[testcube-fuse-axis] shifted protrusion: ${fmt(translatedBbox)}`);

    const graphBefore: any = await dispatchTool('query_graph', { part_id: innerYWall }, config);
    const wallNode = graphBefore.nodes.find((n: any) => n.type === 'PanelNode');
    console.log(`[testcube-fuse-axis] wall nominalThickness=${wallNode?.nominalThickness} flatWidth=${wallNode?.flatWidth} flatHeight=${wallNode?.flatHeight}`);
    const graphProtBefore: any = await dispatchTool('query_graph', { part_id: translatedId }, config);
    const protNode = graphProtBefore.nodes.find((n: any) => n.type === 'PanelNode');
    console.log(`[testcube-fuse-axis] prot nominalThickness=${protNode?.nominalThickness} flatWidth=${protNode?.flatWidth} flatHeight=${protNode?.flatHeight}`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId, tools: [innerYWall, translatedId],
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[testcube-fuse-axis] fused panel bbox: ${fmt(fusedBbox)}`);

    const graphAfter: any = await dispatchTool('query_graph', { part_id: fused.part_id }, config);
    const fusedNode = graphAfter.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    console.log(`[testcube-fuse-axis] fused nominalThickness=${fusedNode?.nominalThickness} flatWidth=${fusedNode?.flatWidth} flatHeight=${fusedNode?.flatHeight}`);

    // Thickness must match the WALL's (the dominant/larger-area panel), not the protrusion's.
    expect(fusedNode?.nominalThickness,
      `[testcube-fuse-axis] [BUG] fused nominalThickness should be the WALL's (${wallNode?.nominalThickness}), got ${fusedNode?.nominalThickness} — wrong panel used as reference`)
      .toBeCloseTo(wallNode?.nominalThickness, 1);

    // Per-axis growth: wall -> fused. Only X (the axis the protrusion bridges,
    // x grows from the wall's own x_max=75 out to the protrusion's x_max=99,
    // i.e. ~24mm) should grow; Y (thickness) and Z (the wall's other in-plane
    // axis) should not.
    console.log('[testcube-fuse-axis] extent comparison (wall -> fused):');
    for (const axis of ['x', 'y', 'z'] as const) {
      const before = ext(innerYWallBbox, axis);
      const after = ext(fusedBbox, axis);
      console.log(`  ${axis}: ${before.toFixed(2)} -> ${after.toFixed(2)} (Δ=${(after - before).toFixed(2)})`);
    }
    const growthX = ext(fusedBbox, 'x') - ext(innerYWallBbox, 'x');
    const growthZ = ext(fusedBbox, 'z') - ext(innerYWallBbox, 'z');
    expect(growthX, `[testcube-fuse-axis] [BUG] expected X to grow by ~24mm (the protrusion-bridged axis), got Δ=${growthX.toFixed(2)}`).toBeGreaterThan(15);
    expect(Math.abs(growthZ), `[testcube-fuse-axis] [BUG] Z should not grow (wrong axis extended), got Δ=${growthZ.toFixed(2)}`).toBeLessThanOrEqual(2.0);

    const pf = getGeometryBinding().getPanelFrame(fused.solid_id as string);
    console.log(`[testcube-fuse-axis] fused frame: normal=(${pf.normalX.toFixed(3)},${pf.normalY.toFixed(3)},${pf.normalZ.toFixed(3)}) u=(${pf.uX.toFixed(3)},${pf.uY.toFixed(3)},${pf.uZ.toFixed(3)}) v=(${pf.vX.toFixed(3)},${pf.vY.toFixed(3)},${pf.vZ.toFixed(3)})`);
  }, 60_000);

  // User report (follow-up): "tested 4 orientations of a cube, 2 worked, 2
  // didn't — when wrong, the panel's starting point is shifted by the width
  // of the protrusion, maybe because the first panel's starting point is in
  // the reverse direction." This is the OTHER side: the previous case attaches
  // the protrusion on the wall's "high"/positive edge (x=75); this one uses
  // the MINUS-X protrusion, attaching on the wall's "low"/negative edge
  // (x=-75) instead — exactly the "reverse direction" scenario.
  it('innerYWall + minusXProtrusion (shifted +75mm Y, coplanar, attaches on the wall\'s NEGATIVE edge), fuse — must not shift the wall\'s own starting corner', async () => {
    const config = loadConfig(configPath);
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
    for (const { id, bbox } of protBboxes) {
      console.log(`[testcube-fuse-axis-reverse] protrusion candidate ${id}: ${fmt(bbox)}`);
    }

    const innerYWallEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'z') > 140 &&
      bbox.y_min > 60 && bbox.y_min < 80);
    // Minus-X protrusion: bridges the X gap on the NEGATIVE side, x_max in [-80,-70], thin in y (centered near 0).
    const minusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_max > -80 && bbox.x_max < -70 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerYWallEntry || !minusXProtrusionEntry) {
      console.warn('[testcube-fuse-axis-reverse] could not classify required panels (no -X protrusion in this fixture) — skipping');
      return;
    }
    const innerYWall = innerYWallEntry.id, innerYWallBbox = innerYWallEntry.bbox;
    const minusXProtrusion = minusXProtrusionEntry.id, minusXProtrusionBbox = minusXProtrusionEntry.bbox;

    console.log(`[testcube-fuse-axis-reverse] innerYWall:   ${fmt(innerYWallBbox)}`);
    console.log(`[testcube-fuse-axis-reverse] protrusion:   ${fmt(minusXProtrusionBbox)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'testcube-fuse-axis-reverse' }, config);
    const txId: string = txn.transaction_id;

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [minusXProtrusion], vector: [0, 75, 0], keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[testcube-fuse-axis-reverse] shifted protrusion: ${fmt(translatedBbox)}`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId, tools: [innerYWall, translatedId],
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[testcube-fuse-axis-reverse] fused panel bbox: ${fmt(fusedBbox)}`);

    // Expected union: the wall's own footprint must be FULLY PRESERVED
    // (not shifted), with growth extending out to the protrusion's x_min.
    const expectedXMin = Math.min(innerYWallBbox.x_min, minusXProtrusionBbox.x_min);
    const expectedXMax = innerYWallBbox.x_max; // wall's own +X edge must not move
    console.log(`[testcube-fuse-axis-reverse] expected x: [${expectedXMin.toFixed(2)}..${expectedXMax.toFixed(2)}]`);
    console.log(`[testcube-fuse-axis-reverse] actual   x: [${fusedBbox.x_min.toFixed(2)}..${fusedBbox.x_max.toFixed(2)}]`);

    expect(Math.abs(fusedBbox.x_min - expectedXMin),
      `[testcube-fuse-axis-reverse] [BUG] fused x_min should extend to the protrusion's x_min=${expectedXMin.toFixed(2)}, got ${fusedBbox.x_min.toFixed(2)} — the wall's own starting corner appears to have shifted instead of the footprint growing`)
      .toBeLessThanOrEqual(2.0);
    expect(Math.abs(fusedBbox.x_max - expectedXMax),
      `[testcube-fuse-axis-reverse] [BUG] fused x_max should stay at the wall's own edge=${expectedXMax.toFixed(2)}, got ${fusedBbox.x_max.toFixed(2)} — shifted by ~the protrusion's width, suggesting the reference frame's origin correction is wrong for this (reverse-direction) orientation`)
      .toBeLessThanOrEqual(2.0);

    const growthZ = ext(fusedBbox, 'z') - ext(innerYWallBbox, 'z');
    expect(Math.abs(growthZ), `[testcube-fuse-axis-reverse] [BUG] Z should not grow (wrong axis extended), got Δ=${growthZ.toFixed(2)}`).toBeLessThanOrEqual(2.0);
  }, 60_000);
});
