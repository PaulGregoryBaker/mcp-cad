/**
 * Verification: merge_bodies_with_bend on angle_bracket_45deg.stp
 *
 * Panel A: flat face, x[0..102.1] y[0..200] z[-0.5..0.1] (102.1mm × 200mm)
 * Panel B: 45° tilted face, x[101..171.8] y[0..200] z[-70.7..0.1] (~100mm × 200mm when flat)
 *
 * Both panels share the full 200mm Y extent, so the merged flat pattern
 * IS correctly a rectangle (not stepped). Tests verify:
 *   1. Flat pattern area is close to the sum of both panel areas (minus bend overlap).
 *   2. Merged 3D shell bbox is close to the union of both panel bboxes (±5mm).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';

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

function polygonArea(ring: Array<[number, number]>): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

describe('merge_bodies_with_bend: angle_bracket_45deg flat pattern + 3D placement', () => {
  const fixtureName = 'angle_bracket_45deg.stp';

  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try {
        await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath));
      } catch { /* best effort */ }
    }
  });

  async function setupAndMerge(): Promise<{
    bboxA: Bbox;
    bboxB: Bbox;
    mergedShellId: string;
    mergedPartId: string;
    txId: string;
  } | null> {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) {
      console.warn(`${fixtureName} not found — run generate_fixtures first; skipping`);
      return null;
    }
    const config = loadConfig(configPath);

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 35,
      max_thickness_mm: 5.0,
    }, config);

    expect(split.panel_count).toBe(2);
    const [panelA, panelB] = split.panel_ids as [string, string];

    const bboxA: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
    const bboxB: Bbox = await dispatchTool('bounding_box', { target: panelB }, config) as Bbox;

    console.log(`[bracket] Panel A bbox: ${fmt(bboxA)}`);
    console.log(`[bracket] Panel B bbox: ${fmt(bboxB)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'bracket-merge' }, config);
    const txId: string = txn.transaction_id;

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId,
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 1.0,
    }, config);
    expect(merged.merged_shell_id, 'merge_bodies_with_bend must return merged_shell_id').toBeDefined();

    return { bboxA, bboxB, mergedShellId: merged.merged_shell_id, mergedPartId: merged.merged_part_id, txId };
  }

  it('flat pattern area is close to sum of both panel areas (within 15%)', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const config = loadConfig(configPath);
    const r = await setupAndMerge();
    if (!r) return;

    const { bboxA, bboxB, mergedPartId, txId } = r;

    const unfold: any = await dispatchTool('apply_unfold', {
      transaction_id: txId,
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: config.materials[0]!.id,
    }, config);

    expect(unfold, 'apply_unfold must return a result').toBeDefined();
    expect(typeof unfold.dxf_content).toBe('string');

    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const mergedArea = polygonArea(ring);

    // Each panel area is approximately its longest × 200mm face projected flat.
    // Panel A: ~102mm wide × 200mm = ~20400mm²
    // Panel B (unfolded ~100mm wide × 200mm): ~20000mm²
    // Total expected: ~40400mm² (minus small bend overlap)
    const panelAApproxArea = (bboxA.x_max - bboxA.x_min) * (bboxA.y_max - bboxA.y_min);
    // Panel B is tilted 45°: flat length ≈ √(ΔX² + ΔZ²)
    const panelBDeltaX = bboxB.x_max - bboxB.x_min;
    const panelBDeltaZ = bboxB.z_max - bboxB.z_min;
    const panelBFlatWidth = Math.sqrt(panelBDeltaX * panelBDeltaX + panelBDeltaZ * panelBDeltaZ);
    const panelBApproxArea = panelBFlatWidth * (bboxB.y_max - bboxB.y_min);
    const expectedArea = panelAApproxArea + panelBApproxArea;

    console.log(`[bracket] flat area: merged=${mergedArea.toFixed(0)}mm² expected≈${expectedArea.toFixed(0)}mm²`);
    console.log(`[bracket] flat area ratio: ${(mergedArea / expectedArea * 100).toFixed(1)}%`);

    // Merged area should be within 15% of sum of both panels' approximate areas
    // (allowing for bend overlap and approximation of panel B flat width).
    expect(mergedArea).toBeGreaterThan(expectedArea * 0.85);
    expect(mergedArea).toBeLessThan(expectedArea * 1.15);
  }, 60_000);

  it('merged 3D shell bbox must be close to pre-merge panel union bbox (±5mm each axis)', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const r = await setupAndMerge();
    if (!r) return;

    const { bboxA, bboxB, mergedShellId } = r;
    const config = loadConfig(configPath);

    const merged: Bbox = await dispatchTool('bounding_box', { target: mergedShellId }, config) as Bbox;
    const expected = unionBbox(bboxA, bboxB);

    console.log(`[bracket] merged: ${fmt(merged)}`);
    console.log(`[bracket] expected (union): ${fmt(expected)}`);

    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];

    // The merged shell bbox must be close to the union bbox of both panels.
    for (const k of bounds) {
      const delta = Math.abs(merged[k] - expected[k]);
      expect(delta,
        `Bound ${k}: expected≈${expected[k].toFixed(2)} got=${merged[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }
  }, 60_000);
});
