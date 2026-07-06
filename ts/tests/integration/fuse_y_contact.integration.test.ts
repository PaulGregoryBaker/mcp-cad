/**
 * Reproducer: fuse_bodies must succeed when two coplanar panels are adjacent
 * in the DXF Y direction (Z-adjacent in 3D) — including when a slight misalignment
 * (< panel thickness) creates a Y gap between their DXF outlines.
 *
 * Bug: "DXF union produced disconnected geometry (2 regions)" is thrown for
 * Y-aligned (Z-adjacent) panels even when they are physically touching/adjacent.
 * The previous gap correction only handled X-axis gaps.
 *
 * Setup: Two simple_box FACE=0 panels (y[0..100] × z[-5..5], ~1mm thick in X).
 *   - Panel A: original position
 *   - Panel B: translated to sit Z-adjacent to Panel A
 *
 * Three scenarios tested:
 *   1. Exact Z-adjacency (no gap) — should always pass
 *   2. Z-adjacency + 0.3mm Y misalignment (step, no Y gap) — should pass
 *   3. Z-adjacency with 0.3mm Z over-translation (creates Y gap in DXF < 1mm thickness threshold)
 *      — fails without Y-gap correction, passes after fix
 *
 * Success criteria:
 *   - fuse_bodies returns a valid solid_id (no GE_FUSE_DISJOINT_RESULT error)
 *   - Merged flat pattern dimensions reflect both panels (~100 × ~20mm)
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { transactionRegistry } from '../../src/mcp/transactions';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

const FACE = 0; // simple_box side face: y[0..100], z[-5..5], ~1mm thick in X

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}

afterEach(async () => {
  const active = transactionRegistry.getActive();
  if (active) {
    try {
      await dispatchTool('rollback_transaction', { transaction_id: active.id }, config);
    } catch { /* best effort */ }
  }
});

/**
 * Splits simple_box and returns the given face panel.
 */
async function getSimpleBoxPanel(): Promise<{ panelId: string; bbox: Bbox }> {
  const boxPath = getFixturePath('simple_box.stp');
  const clean: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
  const split: any = await dispatchTool('split_body_by_bends', {
    part_id: clean.solid_id,
    angle_threshold_deg: 45,
    max_thickness_mm: 5.0,
  }, config);
  expect(split.panel_ids.length).toBeGreaterThan(FACE);
  const panelId: string = split.panel_ids[FACE];
  const bbox: Bbox = await dispatchTool('bounding_box', { target: panelId }, config) as Bbox;
  return { panelId, bbox };
}

describe('fuse_bodies: Y-direction DXF adjacency (Bug 1 reproducer)', () => {
  it('1: exact Z-adjacency — Panel B sits flush against Panel A top edge (no gap)', async () => {
    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-y-exact' }, config);
    const txId: string = txn.transaction_id;

    const { panelId: panelA, bbox: bboxA } = await getSimpleBoxPanel();
    const { panelId: panelB } = await getSimpleBoxPanel();

    // Translate Panel B so its bottom edge aligns exactly with Panel A's top edge.
    const zHeight = bboxA.z_max - bboxA.z_min; // ~10mm
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelB],
      vector: [0, 0, zHeight],
      keep_original: false,
    }, config);
    const panelBMoved: string = translated.solid_id;

    console.log(`[fuse-y-1] Panel A z=[${bboxA.z_min.toFixed(2)}..${bboxA.z_max.toFixed(2)}]`);
    console.log(`[fuse-y-1] Panel B translated +${zHeight.toFixed(2)}mm in Z (exact contact)`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [panelA, panelBMoved],
    }, config);

    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: config.materials[0]!.id,
    }, config);
    const w: number = unfold.graph_flat_width_mm ?? unfold.flat_width_mm;
    const h: number = unfold.graph_flat_height_mm ?? unfold.flat_height_mm;
    console.log(`[fuse-y-1] flat: ${w.toFixed(1)} × ${h.toFixed(1)}mm`);

    const [short, long] = [w, h].sort((a: number, b: number) => a - b);
    expect(long, 'long dimension should be ~100mm (shared Y span)').toBeGreaterThan(80);
    expect(long).toBeLessThan(120);
    expect(short, 'short dimension should be ~2× face height (~20mm)').toBeGreaterThan(15);
    expect(short).toBeLessThan(25);
  }, 60_000);

  it('2: Z-adjacency + 0.3mm Y misalignment — creates a DXF step (partial shared edge, no gap)', async () => {
    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-y-step' }, config);
    const txId: string = txn.transaction_id;

    const { panelId: panelA, bbox: bboxA } = await getSimpleBoxPanel();
    const { panelId: panelB } = await getSimpleBoxPanel();

    const zHeight = bboxA.z_max - bboxA.z_min;
    const yMisalignment = 0.3; // < 1mm panel thickness → panels still physically touching
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelB],
      vector: [0, yMisalignment, zHeight],
      keep_original: false,
    }, config);
    const panelBMoved: string = translated.solid_id;

    console.log(`[fuse-y-2] Panel B offset +${yMisalignment}mm in Y (misalignment < thickness)`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [panelA, panelBMoved],
    }, config);

    expect(fused.solid_id, 'fuse_bodies must succeed — misalignment < panel thickness').toBeDefined();
  }, 60_000);

  it('3: Y-gap in DXF space (0.3mm Z over-translation creates DXF Y gap < thickness) — REPRO', async () => {
    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-y-gap' }, config);
    const txId: string = txn.transaction_id;

    const { panelId: panelA, bbox: bboxA } = await getSimpleBoxPanel();
    const { panelId: panelB } = await getSimpleBoxPanel();

    // Translate Panel B by faceHeight + 0.3mm so the DXF outlines have a 0.3mm Y gap.
    // The gap is < panel thickness (1mm), so physically still "adjacent" but not touching.
    const zHeight = bboxA.z_max - bboxA.z_min;
    const yGap = 0.3; // 0.3mm DXF Y gap < 2mm correction threshold
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelB],
      vector: [0, 0, zHeight + yGap],
      keep_original: false,
    }, config);
    const panelBMoved: string = translated.solid_id;

    console.log(`[fuse-y-3] Panel B at z+${(zHeight + yGap).toFixed(3)} (${yGap}mm Y gap in DXF)`);

    // Without Y-gap correction this throws GE_FUSE_DISJOINT_RESULT.
    // With the fix (Y-gap correction in mergeDxfOutlines) it must succeed.
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [panelA, panelBMoved],
    }, config);

    expect(fused.solid_id, 'fuse_bodies must succeed with Y-gap correction applied').toBeDefined();
  }, 60_000);
});
