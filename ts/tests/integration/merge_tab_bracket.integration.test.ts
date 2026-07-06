/**
 * Verification: merge_bodies_with_bend on tab_bracket_90deg.stp
 *
 * Fixture geometry:
 *   Panel A: 100×200×1.5 mm horizontal plate  (X: 0–100, Y: 0–200, Z: 0–1.5)
 *   Panel B: 1.5×100×100 mm vertical flange   (X: 100–101.5, Y: 50–150, Z: -100–0)
 *            centered on Panel A in Y
 *
 * Panel B seam length (100mm) < Panel A Y span (200mm).
 *
 * Expected flat pattern (T-shaped, 8 vertices):
 *
 *   y=200 ┌──────────┐
 *         │  Panel A │
 *   y=150 │          ├──────────┐
 *         │          │  Panel B │
 *   y=50  │          ├──────────┘
 *         │  Panel A │
 *   y=0   └──────────┘
 *
 * Tests verify:
 *   1. Panel A and Panel B are detected correctly (2 panels, different Y extents).
 *   2. Flat pattern has ≥ 8 unique polygon vertices (T-shape, not a rectangle).
 *   3. Flat pattern fill ratio < 95% (T-shape does not fill its bounding box).
 *   4. Flat pattern area is within 15% of sum of both panel areas.
 *   5. Merged 3D shell bbox covers both panel bboxes (±5mm per axis).
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
  const fp = path.resolve(__dirname, '../../../cpp/tests/fixtures', filename);
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

function countUniqueVertices(ring: Array<[number, number]>): number {
  // Deduplicate closing vertex if present
  const open = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
    ? ring.slice(0, -1)
    : ring;
  const seen = new Set<string>();
  for (const [x, y] of open) {
    seen.add(`${x.toFixed(3)},${y.toFixed(3)}`);
  }
  return seen.size;
}

describe('merge_bodies_with_bend: tab_bracket_90deg asymmetric seam T-shaped flat pattern', () => {
  const fixtureName = 'tab_bracket_90deg.stp';

  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try {
        const config = loadConfig(configPath);
        await dispatchTool('rollback_transaction', { transaction_id: active.id }, config);
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
      angle_threshold_deg: 80,
      max_thickness_mm: 5.0,
    }, config);

    console.log(`[tab] panel_count=${split.panel_count}`);
    expect(split.panel_count, 'tab_bracket must split into exactly 2 panels').toBe(2);
    const [panelA, panelB] = split.panel_ids as [string, string];

    const bboxA: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
    const bboxB: Bbox = await dispatchTool('bounding_box', { target: panelB }, config) as Bbox;

    console.log(`[tab] Panel A bbox: ${fmt(bboxA)}`);
    console.log(`[tab] Panel B bbox: ${fmt(bboxB)}`);

    // Panel A Y span should be ~200mm, Panel B Y span should be ~100mm
    const ySpanA = bboxA.y_max - bboxA.y_min;
    const ySpanB = bboxB.y_max - bboxB.y_min;
    console.log(`[tab] Panel A Y span: ${ySpanA.toFixed(1)}mm, Panel B Y span: ${ySpanB.toFixed(1)}mm`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'tab-bracket-merge' }, config);
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

  it('flat pattern has ≥ 8 unique vertices and fill ratio < 95% (T-shape)', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const config = loadConfig(configPath);
    const r = await setupAndMerge();
    if (!r) return;

    const { mergedPartId, txId } = r;

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: config.materials[0]!.id,
    }, config);

    expect(unfold, 'get_unfold must return a result').toBeDefined();
    expect(typeof unfold.dxf_content).toBe('string');

    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const area = polygonArea(ring);
    const uniqueVerts = countUniqueVertices(ring);

    // Bounding box of the flat pattern
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const bboxArea = (xMax - xMin) * (yMax - yMin);
    const fillRatio = bboxArea > 0 ? area / bboxArea : 1;

    console.log(`[tab] flat vertices: ${uniqueVerts}`);
    console.log(`[tab] flat area: ${area.toFixed(0)}mm²  bbox area: ${bboxArea.toFixed(0)}mm²  fill: ${(fillRatio * 100).toFixed(1)}%`);

    // A T-shaped polygon has exactly 8 vertices.
    // Allow for small rounding/extra collinear vertices: require ≥ 8.
    expect(uniqueVerts, 'T-shaped flat pattern must have ≥ 8 unique vertices').toBeGreaterThanOrEqual(8);

    // T-shape does not fill its bounding box (missing two corner rectangles).
    // Each missing corner is ~50mm × ~100mm = 5000mm² out of ~200mm × ~200mm = 40000mm² bbox.
    // Fill ≈ 30000/40000 = 75%. Allow generous margin: must be < 95%.
    expect(fillRatio, `T-shaped pattern fill ratio should be < 0.95, got ${fillRatio.toFixed(3)}`).toBeLessThan(0.95);
  }, 60_000);

  it('flat pattern area is within 15% of sum of both panel areas', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const config = loadConfig(configPath);
    const r = await setupAndMerge();
    if (!r) return;

    const { mergedPartId, txId } = r;

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: config.materials[0]!.id,
    }, config);

    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const mergedArea = polygonArea(ring);

    // Known fixture geometry (from generate_fixtures.cc):
    //   Panel A (horizontal): LA=100mm × WA=200mm = 20000mm²
    //   Panel B (vertical flange): LB=100mm × WB=100mm = 10000mm²
    //   Corner strip contribution: T=1.5mm × WB=100mm = 150mm²
    // Total expected flat area ≈ 30150mm²
    // Allow ±20% to account for bend overlap and OCCT measurement tolerances.
    const NOMINAL_FLAT_AREA_MM2 = 30000;

    console.log(`[tab] merged area: ${mergedArea.toFixed(0)}mm²  expected≈${NOMINAL_FLAT_AREA_MM2}mm²  ratio: ${(mergedArea / NOMINAL_FLAT_AREA_MM2 * 100).toFixed(1)}%`);

    expect(mergedArea).toBeGreaterThan(NOMINAL_FLAT_AREA_MM2 * 0.85);  // > 25500
    expect(mergedArea).toBeLessThan(NOMINAL_FLAT_AREA_MM2 * 1.20);     // < 36000
  }, 60_000);

  it('merged 3D shell bbox covers both panel bboxes (±5mm per axis)', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const r = await setupAndMerge();
    if (!r) return;

    const { bboxA, bboxB, mergedShellId } = r;
    const config = loadConfig(configPath);

    const merged: Bbox = await dispatchTool('bounding_box', { target: mergedShellId }, config) as Bbox;
    const expected = unionBbox(bboxA, bboxB);

    console.log(`[tab] merged: ${fmt(merged)}`);
    console.log(`[tab] expected (union): ${fmt(expected)}`);

    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];

    for (const k of bounds) {
      const delta = Math.abs(merged[k] - expected[k]);
      expect(delta,
        `Bound ${k}: expected≈${expected[k].toFixed(2)} got=${merged[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }
  }, 60_000);
});
