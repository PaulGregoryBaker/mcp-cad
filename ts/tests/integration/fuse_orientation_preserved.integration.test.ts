/**
 * Regression test: fuse_bodies must (1) build the correct manufacturing plan
 * (flat pattern) from the panels' ACTUAL coplanar arrangement, and (2) place the
 * rebuilt 3D body back where the panels physically are.
 *
 * The manufacturing graph (the merged flat DXF) is the source of truth — the 3D
 * solid is rebuilt from it. Two bugs were fixed:
 *   - mergeInputDxfOutlines laid panels out edge-to-edge with a hardcoded offset,
 *     ignoring their real relative position/orientation → wrong flat plan.
 *   - the rebuilt 3D body was left at the canonical XY origin instead of being
 *     placed at the panels' 3D frame.
 *
 * Setup: two identical 100×10 mm coplanar panels (a simple_box side face). Panel B
 * is translated +5 mm along the panels' SHORT (Z / v) axis, so the two overlap.
 *   - Correct flat plan: 100 × 15 (NOT the 200 × 10 edge-to-edge stack).
 *   - Correct 3D placement: the fused body spans the union of the two panels'
 *     bboxes (x[-51,-50] y[0,100] z[-5,10]), at x≈−50 — NOT relocated to the origin.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { transactionRegistry } from '../../src/mcp/transactions';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), z_min: Math.min(a.z_min, b.z_min),
    x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max), z_max: Math.max(a.z_max, b.z_max),
  };
}

function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(1)}..${b.x_max.toFixed(1)}] ` +
         `y[${b.y_min.toFixed(1)}..${b.y_max.toFixed(1)}] ` +
         `z[${b.z_min.toFixed(1)}..${b.z_max.toFixed(1)}]`;
}

afterEach(async () => {
  const active = transactionRegistry.getActive();
  if (active) {
    try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, config); } catch { /* best effort */ }
  }
});

describe('fuse_bodies: manufacturing plan + 3D placement', () => {
  it('builds the correct flat plan AND places the fused body where the panels are', async () => {
    const boxPath = getFixturePath('simple_box.stp');
    const FACE = 0; // side face: y[0,100] (long=u), z[-5,5] (short=v), ~1mm thick in X

    const cleanA: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const splitA: any = await dispatchTool('split_body_by_bends', {
      part_id: cleanA.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
    }, config);
    expect(splitA.panel_ids.length).toBeGreaterThan(FACE);
    const panelA: string = splitA.panel_ids[FACE];

    const cleanB: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const splitB: any = await dispatchTool('split_body_by_bends', {
      part_id: cleanB.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
    }, config);
    expect(splitB.panel_ids.length).toBeGreaterThan(FACE);
    const panelB: string = splitB.panel_ids[FACE];

    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse_plan_and_place' }, config);
    const txId: string = txn.transaction_id;

    // Translate panel B +5mm along Z (its SHORT, v axis) so the two coplanar panels
    // overlap → correct union footprint is 100 (Y) × 15 (Z).
    const tB: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [panelB], vector: [0, 0, 5], keep_original: false,
    }, config);
    const panelBShell: string = tB.solid_id;

    // ── BEFORE: union of the two panels' 3D corners ────────────────────────────
    const bboxA: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
    const bboxB: Bbox = await dispatchTool('bounding_box', { target: panelBShell }, config) as Bbox;
    const before = unionBbox(bboxA, bboxB);
    console.log(`[fuse-plan] union (before): ${fmt(before)}`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId, tools: [panelA, panelB],
    }, config);
    expect(fused.solid_id).toBeDefined();

    // ── (1) Manufacturing plan: graph flat pattern is the source of truth ──────
    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId, part_id: fused.part_id, panel_id: fused.part_id,
      material_id: 'mild_steel_1.5mm',
    }, config);
    const w = unfold.graph_flat_width_mm ?? unfold.flat_width_mm;
    const h = unfold.graph_flat_height_mm ?? unfold.flat_height_mm;
    const [shortDim, longDim] = [w, h].sort((a: number, b: number) => a - b);
    console.log(`[fuse-plan] flat plan = ${shortDim.toFixed(1)} × ${longDim.toFixed(1)}mm`);

    expect(longDim, 'long flat dim must be the shared ~100mm length, NOT the ~200mm edge-to-edge stack').toBeLessThan(150);
    expect(longDim).toBeGreaterThan(85);
    expect(shortDim, 'short flat dim must reflect the +5mm short-axis overlap (~15mm)').toBeGreaterThan(12);
    expect(shortDim).toBeLessThan(20);

    // ── (2) 3D placement: fused body occupies the panels' union, not the origin ─
    const after: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[fuse-plan] fused (after):  ${fmt(after)}`);

    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(after[k] - before[k]);
      expect(delta, `bbox bound ${k}: before=${before[k].toFixed(2)} after=${after[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }
  }, 60_000);
});
