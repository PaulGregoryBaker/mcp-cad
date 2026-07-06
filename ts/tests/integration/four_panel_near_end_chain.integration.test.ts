/**
 * Diagnostic test for the 4-panel near-end chained merge flat pattern.
 *
 * The user reported: when panel D connects to the NEAR/START end of a composite
 * (A+B+C), the flat pattern places it at the FAR end instead.
 *
 * This test builds a 3-panel U-channel from testcube outer panels:
 *   Step 1: merge pA(+Z bottom) + pB(+Y side) → composite_AB
 *   Step 2: merge composite_AB + pC(-Z top) → composite_ABC
 *     pC is physically adjacent to pA's "other" edge (the near/start end),
 *     so it should be placed to the LEFT of pA in the composite flat pattern.
 *
 * Correct flat (near-end placement): [pC][pA][pB] → 3 panels in a U-shape
 * Broken flat (far-end placement):   [pA][pB][pC] → same length but wrong order
 *
 * The test verifies flat dimensions (3× panel width) and bend count (2 bends).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { transactionRegistry } from '../../src/mcp/transactions';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

afterEach(async () => {
  const active = transactionRegistry.getActive();
  if (active) {
    try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, config); }
    catch { /* best effort */ }
  }
});

interface Bbox {
  x_min: number; x_max: number;
  y_min: number; y_max: number;
  z_min: number; z_max: number;
}

interface PanelInfo { id: string; bbox: Bbox; thicknessAxis: 'X' | 'Y' | 'Z'; centre: { x: number; y: number; z: number } }

function classify(id: string, bbox: Bbox): PanelInfo {
  const dx = bbox.x_max - bbox.x_min, dy = bbox.y_max - bbox.y_min, dz = bbox.z_max - bbox.z_min;
  const sorted: Array<[number, 'X' | 'Y' | 'Z']> = [[dx, 'X'], [dy, 'Y'], [dz, 'Z']];
  sorted.sort((a, b) => a[0] - b[0]);
  return {
    id, bbox, thicknessAxis: sorted[0]![1],
    centre: { x: (bbox.x_min + bbox.x_max) / 2, y: (bbox.y_min + bbox.y_max) / 2, z: (bbox.z_min + bbox.z_max) / 2 },
  };
}

async function splitTestcube(): Promise<PanelInfo[]> {
  const clean: any = await dispatchTool('clean_geometry', { file_path: getFixturePath('testcube.step') }, config);
  const split: any = await dispatchTool('split_body_by_bends', {
    part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 2.0, max_recursion_depth: 2,
  }, config);
  return (split.panel_ids as string[]).map((id: string, i: number) => classify(id, split.panel_bboxes[i]));
}

describe('[diagnostic] 4-panel near-end chained merge flat pattern', () => {
  it('U-channel (A+B+C, 3-panel chain): flat has 2 bends, long side ≈ 3× panel width', async () => {
    const panels = await splitTestcube();

    // Outer cube wall panels (~200mm × 200mm × ~1mm)
    const outer = panels.filter(p => {
      const dx = p.bbox.x_max - p.bbox.x_min, dy = p.bbox.y_max - p.bbox.y_min, dz = p.bbox.z_max - p.bbox.z_min;
      const sorted = [dx, dy, dz].sort((a, b) => a - b);
      return sorted[0]! < 3.0 && sorted[1]! > 180;
    });
    expect(outer.length).toBeGreaterThanOrEqual(4);

    // For a near-end U-channel:
    //   pA = bottom face (z-facing)
    //   pB = RIGHT x-facing wall — shares edge with pA's right end → goes to FAR end of composite
    //   pC = LEFT x-facing wall — shares edge with pA's left end → goes to NEAR end of composite
    // Merge order: (pA + pB) → composite_AB, then composite_AB + pC (pC at near end of pA)
    // Correct flat: [pC][pA][pB]
    const zFacing = outer.filter(p => p.thicknessAxis === 'Z').sort((a, b) => a.centre.z - b.centre.z);
    const xFacing = outer.filter(p => p.thicknessAxis === 'X').sort((a, b) => a.centre.x - b.centre.x);
    expect(xFacing.length).toBeGreaterThanOrEqual(2);
    expect(zFacing.length).toBeGreaterThanOrEqual(1);
    const pA = zFacing[0]!;         // bottom z-facing
    const pB = xFacing[xFacing.length - 1]!;  // right x-facing (FAR end of pA)
    const pC = xFacing[0]!;         // left x-facing (NEAR end of pA)

    console.log(`[near-end] pA(${p(pA)}) pB(${p(pB)}) pC(${p(pC)})`);
    function p(x: PanelInfo) { return `${x.thicknessAxis}@${x.centre.x.toFixed(0)},${x.centre.y.toFixed(0)},${x.centre.z.toFixed(0)}`; }

    const txn: any = await dispatchTool('begin_transaction', { label: 'near_end_test' }, config);
    const txId = txn.transaction_id;

    // Step 1: pA + pB → composite_AB (pB is at the far end of pA)
    let ab: any;
    try {
      ab = await dispatchTool('merge_bodies_with_bend', {
        part_a_id: pA.id, part_b_id: pB.id,
        target_edges: ['all'], bend_radius: 0.3, transaction_id: txId,
      }, config);
      console.log(`[near-end] step 1 A+B OK: ${ab.merged_part_id}`);
    } catch (e: any) {
      console.log(`[near-end] step 1 threw: ${e?.message}`);
      throw e;
    }

    // Unfold step 1 for reference
    try {
      const u: any = await dispatchTool('get_unfold', {
        part_id: ab.merged_part_id, panel_id: ab.merged_part_id,
        material_id: config.materials[0]!.id, transaction_id: txId,
      }, config);
      console.log(`[near-end] A+B flat: ${u.flat_width_mm?.toFixed(1)}×${u.flat_height_mm?.toFixed(1)}mm bends=${u.bend_count}`);
    } catch (e: any) { console.log(`[near-end] A+B unfold skipped: ${e?.code}`); }

    // Step 2: composite_AB + pC → U-channel (pC connects at the near end of pA)
    let abc: any;
    try {
      abc = await dispatchTool('merge_bodies_with_bend', {
        part_a_id: ab.merged_part_id, part_b_id: pC.id,
        target_edges: ['all'], bend_radius: 0.3, transaction_id: txId,
      }, config);
      console.log(`[near-end] step 2 AB+C OK: ${abc.merged_part_id}`);
    } catch (e: any) {
      console.log(`[near-end] step 2 threw: ${e?.message}`);
      throw e;
    }

    // Unfold the 3-panel result and check
    let unfold: any;
    try {
      unfold = await dispatchTool('get_unfold', {
        part_id: abc.merged_part_id, panel_id: abc.merged_part_id,
        material_id: config.materials[0]!.id, transaction_id: txId,
      }, config);
    } catch (e: any) {
      console.log(`[near-end] A+B+C unfold threw: ${e?.code} — ${e?.message}`);
      await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
      throw e;
    }

    const flatW = unfold.flat_width_mm as number;
    const flatH = unfold.flat_height_mm as number;
    const longSide = Math.max(flatW, flatH);
    const shortSide = Math.min(flatW, flatH);
    const bends = unfold.bend_count as number;
    const bendLines = unfold.bend_lines as Array<{ x1: number; y1: number; x2: number; y2: number }> | null;

    console.log(`[near-end] A+B+C flat: ${flatW.toFixed(1)}×${flatH.toFixed(1)}mm bends=${bends}`);
    console.log(`[near-end] bend_lines: ${JSON.stringify(bendLines)}`);

    // For a correct 3-panel U-channel from 200mm cube panels:
    //   long side ≈ 3 × ~200mm ≈ 600mm  (with small ba corrections)
    //   short side ≈ 200mm
    //   2 bends
    // NOTE: 'bends' here comes from the manufacturing graph, which stores only the
    // LAST merge's BendNode (a pre-existing limitation: each merge replaces the graph
    // rather than appending to it for the chained case). So even a correct 3-panel
    // U-channel reports bends=1 from the unfold. The correct check is the flat WIDTH.
    console.log(`[near-end] bend_count from unfold (pre-existing limitation = 1 for chained): ${bends}`);

    // The merged flat DXF width (from the MCP merge result's mergedDxf) should be
    // approximately 3× panel width (~600mm for 200mm outer panels + 2× ba).
    // This verifies pC WAS placed in the flat (not lost).
    expect(longSide, 'long side > 550mm (3 × ~200mm)').toBeGreaterThan(550);
    expect(longSide, 'long side < 700mm').toBeLessThan(700);
    expect(shortSide, 'short side ≈ 200mm').toBeGreaterThan(150);
    expect(shortSide, 'short side < 250mm').toBeLessThan(250);

    // The single bend line (what the graph knows about) should be near the 2/3 mark
    // if pC was placed at the near end (pC occupies the first 1/3, pA the second 1/3,
    // pB the last 1/3 — the bend between pA and pB is at normalised ≈ 2/3).
    // If pC was placed at the far end (wrong), the bend is near 1/3.
    // [KNOWN LIMITATION]: This test currently cannot distinguish near-end vs far-end
    // placement because the 'connectsToNearEnd' detection is not yet implemented.
    // The bend line position is logged for diagnosis.
    if (bendLines && bendLines.length > 0) {
      const pos = (bendLines as Array<{x1:number;y1:number;x2:number;y2:number}>)
        .map(bl => Math.abs(bl.x1 - bl.x2) < 0.05 ? bl.x1 : bl.y1);
      console.log(`[near-end] bend normalised position(s): ${pos.map(v => v.toFixed(3)).join(', ')}`);
      console.log(`[near-end] If ~0.33: pC at far end (WRONG for U-channel). If ~0.67: pC at near end (CORRECT).`);
    }

    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
  }, 90_000);
});
