/**
 * Regression test for merge_bodies_with_bend flat-pattern orientation.
 *
 * Bug: when merging panels where the fold runs along their longer (U) axis,
 * the flat pattern used flatWidth (fold-parallel, long dim) instead of
 * flatHeight (fold-perpendicular, short dim) for the Panel A section width.
 *
 * Fix: detect foldAlongU_A/B using cross(N_A, N_B) and use flatHeight as
 * effectiveAFlatWidth when foldAlongU is true. Also re-orient both DXFs.
 *
 * Example (angle_bracket_45deg): two 100×200×1.5mm panels, fold along 200mm axis.
 *   - flatWidth = 200mm (fold-PARALLEL, U axis), flatHeight = 100mm (fold-PERP, V axis)
 *   - Correct merged width = 100 + ba + 100 ≈ 202mm
 *   - Old (buggy) merged width = 200 + ba + 200 ≈ 402mm  (2× too wide)
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(name: string): string | null {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : null;
}

describe('merge_bodies_with_bend: protrusion flat-pattern layout', () => {
  it('uses fold-perpendicular (flatHeight) not fold-parallel (flatWidth) for each panel section', async () => {
    const fixturePath = findFixture('angle_bracket_45deg.stp');
    if (!fixturePath) {
      console.warn('angle_bracket_45deg.stp not found — skipping');
      return;
    }

    // angle_bracket_45deg: two 100×200×1.5mm panels joined at 45° dihedral.
    // Each panel has flatWidth=200mm (fold-parallel) and flatHeight=100mm (fold-perp).
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 35,
      max_thickness_mm: 5.0,
    }, config);

    expect(split.panel_count).toBe(2);
    const [panelA, panelB] = split.panel_ids as [string, string];
    const bboxA = split.panel_bboxes[0];
    const bboxB = split.panel_bboxes[1];

    // Compute flatWidth/flatHeight from bboxes (sorted ascending: [thickness, short, long])
    const dimsA = [bboxA.x_max - bboxA.x_min, bboxA.y_max - bboxA.y_min, bboxA.z_max - bboxA.z_min]
      .sort((a: number, b: number) => a - b);
    const dimsB = [bboxB.x_max - bboxB.x_min, bboxB.y_max - bboxB.y_min, bboxB.z_max - bboxB.z_min]
      .sort((a: number, b: number) => a - b);
    // dims[0]=thickness ≈1.5, dims[1]=flatHeight ≈100, dims[2]=flatWidth ≈200
    const flatHeightA = dimsA[1] as number;  // fold-perpendicular ≈ 100mm
    const flatWidthA  = dimsA[2] as number;  // fold-parallel ≈ 200mm
    const flatHeightB = dimsB[1] as number;
    const flatWidthB  = dimsB[2] as number;

    // Sanity: verify the fixture dimensions are in the expected ballpark.
    // The exact bbox dims include fold-corner geometry so ~100mm and ~200mm are approximate.
    expect(flatHeightA).toBeGreaterThan(90);
    expect(flatHeightA).toBeLessThan(120);
    expect(flatWidthA).toBeGreaterThan(190);
    expect(flatWidthA).toBeLessThan(210);

    // Merge and unfold within a transaction
    const txn: any = await dispatchTool('begin_transaction', { label: 'protrusion_flat_test' }, config);
    const txId: string = txn.transaction_id;

    // Merge panels — panelA as the protrusion side (part_a_id)
    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 1.0,
      transaction_id: txId,
    }, config);

    expect(merged.graphs_merged).toBe(true);
    expect(merged.merged_part_id).toBe(panelA);

    // Apply unfold to get the merged flat-pattern dimensions
    const unfold: any = await dispatchTool('apply_unfold', {
      part_id: merged.preserved_part_id,
      panel_id: merged.preserved_part_id,
      material_id: config.materials[0]!.id,
      transaction_id: txId,
    }, config);

    expect(unfold.bend_count).toBe(1);

    const mergedWidth: number = unfold.graph_flat_width_mm;
    const mergedHeight: number = unfold.graph_flat_height_mm;

    // The merge uses each panel's TRUE fold-perpendicular extent (from the oriented
    // panel frame), not the axis-aligned bbox. Both bracket legs are ~100mm, so the
    // merged flat width = legA + bendAllowance + legB ≈ 100 + ~1 + 100 ≈ 200mm.
    //
    // NOTE: flatHeightB from the axis-aligned bbox UNDER-measures Panel B (~71mm)
    // because that panel is tilted 45° in world space — which is exactly why the
    // merge must use the true oriented frame instead. So the expectation here is the
    // physical leg length (~100mm each), not the bbox-derived flatHeightB.
    const oldBugWidth = flatWidthA + flatWidthB;          // ≈ 400mm (fold-PARALLEL, the bug)

    // Correct: merged width ≈ 200mm (two ~100mm fold-perpendicular legs + bend allowance).
    expect(mergedWidth).toBeGreaterThan(190);
    expect(mergedWidth).toBeLessThan(215);

    // Must NOT be the old fold-parallel value (~400mm), nor the bbox-skewed ~174mm.
    expect(mergedWidth).toBeLessThan(oldBugWidth - 100);
    expect(mergedWidth).toBeGreaterThan(flatHeightA + flatHeightB + 5); // > bbox-skewed ~173mm

    // Flat height should match the fold-parallel dimension (the shared edge, ~200mm).
    expect(mergedHeight).toBeCloseTo(Math.max(flatWidthA, flatWidthB), 0);

    console.log(`[merge-protrusion-flat] mergedWidth=${mergedWidth.toFixed(1)} (≈200mm true fold-perp sum)`);
    console.log(`[merge-protrusion-flat] mergedHeight=${mergedHeight.toFixed(1)}, fold-parallel≈${flatWidthA}mm`);
  }, 60_000);
});
