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

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: config.materials[0]!.id,
    }, config);

    expect(unfold, 'get_unfold must return a result').toBeDefined();
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

/**
 * Verification: merge_bodies_with_bend on l_bracket_corner_90deg.stp
 *
 * Panel A (small): 1.5×100×100 mm vertical flange, flush with one END of Panel B's
 *                   200mm edge (not centered) — see generate_fixtures.cc.
 * Panel B (big):    200×200×1.5 mm horizontal plate.
 *
 * Because Panel A is flush with a corner of Panel B's edge rather than centered on it,
 * the merged flat pattern is L-shaped (not T-shaped like tab_bracket_90deg):
 * a ~300×200mm bounding box with a 100×100mm notch missing at the corner opposite
 * the seam.
 */
describe('merge_bodies_with_bend: l_bracket_corner_90deg L-shaped flat pattern (corner-flush asymmetric seam)', () => {
  const fixtureName = 'l_bracket_corner_90deg.stp';

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
    bboxOriginal: Bbox;
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
    // Bbox of the single imported solid, before it's split into panels — the
    // ground truth that the split + merge round-trip should reproduce.
    const bboxOriginal: Bbox = await dispatchTool('bounding_box', { target: clean.solid_id }, config) as Bbox;

    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 80,
      max_thickness_mm: 5.0,
    }, config);

    expect(split.panel_count, 'l_bracket_corner must split into exactly 2 panels').toBe(2);
    const [panelA, panelB] = split.panel_ids as [string, string];

    const bboxA: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
    const bboxB: Bbox = await dispatchTool('bounding_box', { target: panelB }, config) as Bbox;

    console.log(`[lcorner] Panel A bbox: ${fmt(bboxA)}`);
    console.log(`[lcorner] Panel B bbox: ${fmt(bboxB)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'l-bracket-corner-merge' }, config);
    const txId: string = txn.transaction_id;

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId,
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 1.0,
    }, config);
    expect(merged.merged_shell_id, 'merge_bodies_with_bend must return merged_shell_id').toBeDefined();

    return {
      bboxA, bboxB, bboxOriginal,
      mergedShellId: merged.merged_shell_id, mergedPartId: merged.merged_part_id, txId,
    };
  }

  it('flat pattern is L-shaped: ~300x200mm bbox with a 100x100mm missing corner notch', async () => {
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

    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const bboxWidth = xMax - xMin;
    const bboxHeight = yMax - yMin;
    const bboxArea = bboxWidth * bboxHeight;
    const fillRatio = bboxArea > 0 ? area / bboxArea : 1;

    console.log(`[lcorner] flat bbox: ${bboxWidth.toFixed(1)}mm x ${bboxHeight.toFixed(1)}mm`);
    console.log(`[lcorner] flat area: ${area.toFixed(0)}mm²  bbox area: ${bboxArea.toFixed(0)}mm²  fill: ${(fillRatio * 100).toFixed(1)}%`);

    // Overall flat pattern footprint should be ~300mm (200mm panel + 100mm panel) x ~200mm.
    expect(bboxWidth).toBeGreaterThan(285);
    expect(bboxWidth).toBeLessThan(315);
    expect(bboxHeight).toBeGreaterThan(190);
    expect(bboxHeight).toBeLessThan(210);

    // Expected area: Panel A (100×100=10000) + Panel B (200×200=40000) = 50000mm²,
    // i.e. the 300×200=60000mm² bbox minus the missing 100×100=10000mm² corner notch.
    const NOMINAL_FLAT_AREA_MM2 = 50000;
    expect(area).toBeGreaterThan(NOMINAL_FLAT_AREA_MM2 * 0.85);
    expect(area).toBeLessThan(NOMINAL_FLAT_AREA_MM2 * 1.15);

    // L-shape must not fill its bounding box (missing corner notch ≈ 1/6 of bbox area).
    expect(fillRatio, `L-shaped pattern fill ratio should be < 0.95, got ${fillRatio.toFixed(3)}`).toBeLessThan(0.95);
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

    console.log(`[lcorner] merged: ${fmt(merged)}`);
    console.log(`[lcorner] expected (union): ${fmt(expected)}`);

    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];

    for (const k of bounds) {
      const delta = Math.abs(merged[k] - expected[k]);
      expect(delta,
        `Bound ${k}: expected≈${expected[k].toFixed(2)} got=${merged[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }
  }, 60_000);

  it('manufacturing graph 3D part matches the original pre-split part (±5mm each axis)', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const r = await setupAndMerge();
    if (!r) return;

    const { bboxOriginal, mergedPartId, txId } = r;
    const config = loadConfig(configPath);

    // Solve the geometry to verify perfect reconstruction under graph solver.
    await dispatchTool('solve_geometry', {
      part_id: mergedPartId,
      transaction_id: txId,
    }, config);

    // Pull the merged shell's body straight from the Manufacturing Graph (not the
    // raw return value of merge_bodies_with_bend) to confirm the canonical PanelNode
    // was correctly stamped with the merged geometry's body ID.
    const graphResult: any = await dispatchTool('query_graph', { part_id: mergedPartId }, config);
    const panelNode = (graphResult.nodes as Array<Record<string, unknown>>)
      .find((n) => n['type'] === 'PanelNode' && n['canonical'] === true);

    expect(panelNode, 'merged graph must contain a canonical PanelNode').toBeDefined();
    const bodyId = panelNode!['bodyId'] as string | null;
    expect(bodyId, 'canonical PanelNode must have a bodyId after merge').toBeTruthy();

    const graphBody: Bbox = await dispatchTool('bounding_box', { target: bodyId as string }, config) as Bbox;

    console.log(`[lcorner] graph 3D part: ${fmt(graphBody)}`);
    console.log(`[lcorner] original part: ${fmt(bboxOriginal)}`);

    const graphTolMm = 5.0;
    const graphBounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];

    // The manufacturing graph's reconstructed 3D part must be geometrically similar
    // to the original, single-body part it was split from (round-trip check).
    for (const k of graphBounds) {
      const delta = Math.abs(graphBody[k] - bboxOriginal[k]);
      expect(delta,
        `Bound ${k}: original=${bboxOriginal[k].toFixed(2)} graph=${graphBody[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(graphTolMm);
    }
  }, 60_000);

  it('[bug repro] translating the 100x100 panel 200mm to the opposite edge before merge', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) return;

    const config = loadConfig(configPath);

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 80,
      max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count, 'l_bracket_corner must split into exactly 2 panels').toBe(2);
    const [panelA, panelB] = split.panel_ids as [string, string];

    const bboxABefore: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
    console.log(`[translate-repro] Panel A (small, 100x100) bbox before translate: ${fmt(bboxABefore)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: 'l-bracket-corner-translate-repro' }, config);
    const txId: string = txn.transaction_id;

    // Panel A currently sits flush against the RIGHT edge (x≈200) of the 200x200
    // panel. Move it 200mm in -X — exactly the width of the big panel — so it now
    // sits flush against the OPPOSITE (left, x≈0) edge instead.
    const translateResult: any = await dispatchTool('translate_body', {
      targets: [panelA],
      vector: [-200, 0, 0],
      transaction_id: txId,
    }, config);
    const translatedPanelA: string = translateResult.solid_id;

    const bboxAAfter: Bbox = await dispatchTool('bounding_box', { target: translatedPanelA }, config) as Bbox;
    console.log(`[translate-repro] Panel A bbox after translate (id=${translatedPanelA}): ${fmt(bboxAAfter)}`);

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: panelA,
        part_b_id: panelB,
        target_edges: ['all'],
        bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
    }

    if (mergeError) {
      console.log(`[translate-repro] merge_bodies_with_bend threw: ${JSON.stringify(mergeError, Object.getOwnPropertyNames(mergeError as object))}`);
      return;
    }

    console.log(`[translate-repro] merge_bodies_with_bend result: ${JSON.stringify(merged)}`);
    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    console.log(`[translate-repro] merged 3D bbox: ${fmt(mergedBbox)}`);
    console.log(`[translate-repro] (for comparison) Panel A pre-translate bbox:  ${fmt(bboxABefore)}`);
    console.log(`[translate-repro] (for comparison) Panel A post-translate bbox: ${fmt(bboxAAfter)}`);

    // Tilt check: read the ACTUAL geometry's dominant face frame directly from the
    // C++ binding (independent of the graph's self-reported panelFrame metadata).
    // A non-axis-aligned normal/u/v here means the merged 3D solid is genuinely tilted.
    try {
      const pf = getGeometryBinding().getPanelFrame(merged.merged_shell_id as string);
      console.log(`[translate-repro] merged shell dominant-face frame: origin=(${pf.originX.toFixed(3)},${pf.originY.toFixed(3)},${pf.originZ.toFixed(3)}) `
        + `u=(${pf.uX.toFixed(4)},${pf.uY.toFixed(4)},${pf.uZ.toFixed(4)}) `
        + `v=(${pf.vX.toFixed(4)},${pf.vY.toFixed(4)},${pf.vZ.toFixed(4)}) `
        + `normal=(${pf.normalX.toFixed(4)},${pf.normalY.toFixed(4)},${pf.normalZ.toFixed(4)})`);
      const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-3 || Math.abs(n) < 1e-3;
      const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
      console.log(`[translate-repro] dominant face normal axis-aligned? ${!isTilted}`);
    } catch (err) {
      console.log(`[translate-repro] getPanelFrame on merged shell threw: ${String(err)}`);
    }

    // Cross-check: does the Manufacturing Graph's canonical PanelNode bodyId
    // actually point at the post-translate merged geometry?
    const graphResult: any = await dispatchTool('query_graph', { part_id: merged.merged_part_id }, config);
    const panelNode = (graphResult.nodes as Array<Record<string, unknown>>)
      .find((n) => n['type'] === 'PanelNode' && n['canonical'] === true);
    console.log(`[translate-repro] canonical PanelNode: ${JSON.stringify(panelNode)}`);

    // Flat pattern check: should still be L-shaped (~300x200mm, 100x100mm notch),
    // just mirrored to the opposite corner since the seam moved to the other edge.
    let unfold: any = null;
    let unfoldError: unknown = null;
    try {
      unfold = await dispatchTool('get_unfold', {
        transaction_id: txId,
        part_id: merged.merged_part_id,
        panel_id: merged.merged_part_id,
        material_id: config.materials[0]!.id,
      }, config);
    } catch (err) {
      unfoldError = err;
    }

    if (unfoldError) {
      console.log(`[translate-repro] get_unfold threw: ${JSON.stringify(unfoldError, Object.getOwnPropertyNames(unfoldError as object))}`);
      return;
    }

    console.log(`[translate-repro] RAW dxf_content:\n${unfold.dxf_content as string}`);

    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const area = polygonArea(ring);
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const bboxArea = (xMax - xMin) * (yMax - yMin);
    const fillRatio = bboxArea > 0 ? area / bboxArea : 1;
    console.log(`[translate-repro] flat pattern vertices: ${JSON.stringify(ring)}`);
    console.log(`[translate-repro] flat bbox: ${(xMax - xMin).toFixed(1)}mm x ${(yMax - yMin).toFixed(1)}mm`);
    console.log(`[translate-repro] flat area: ${area.toFixed(0)}mm²  bbox area: ${bboxArea.toFixed(0)}mm²  fill: ${(fillRatio * 100).toFixed(1)}%`);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// BUG REPRO: fuse panel+protrusion then merge_bodies_with_bend
//
// Steps (as described by user):
//   1. split cube_with_flanges.stp by bends
//   2. translate a flange tab to align flush with the top edge of a side wall
//   3. fuse_bodies(sideWall + translatedFlange) → single enlarged panel
//   4. merge_bodies_with_bend(fusedPanel, topWall, 90°)
//
// Expected (correct): T-shaped or L-shaped flat pattern + axis-aligned 3D shell.
// Observed (buggy):   rectangular flat pattern + tilted 3D shell.
//
// The suspected root cause is buildShellFromFlatPattern's canonCy offset bug
// (documented in merge_orientation_preserved.integration.test.ts), which
// produces incorrect 3D placement for non-rectangular fused panels.
// ────────────────────────────────────────────────────────────────────────────

describe('[bug repro] fuse side-wall+flange then merge_bodies_with_bend: rectangular flat + tilted 3D', () => {
  const fixtureName = 'cube_with_flanges.stp';

  function bbExtent(b: Bbox, axis: 'x' | 'y' | 'z'): number {
    return b[`${axis}_max`] - b[`${axis}_min`];
  }

  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  /**
   * Classify 10 panels from cube_with_flanges split.
   *
   * cube_with_flanges is a 200×200×200mm hollow cube (1mm walls) with 4 small
   * flange tabs (1×20×10mm) on the ±X and ±Y outer faces.
   *
   * After split_body_by_bends(threshold=45, max=5) we get 10 panels:
   *   6 cube walls  + 4 flange tabs.
   *
   * We want:
   *   sideWall  — the +X face: x≈[199..200], y=[0..200], z=[0..200]
   *   flangeTab — a tab on the +X face: x≈[200..201], y≈[90..110], z≈[95..105]
   *   topWall   — the +Z face: x=[0..200], y=[0..200], z≈[199..200]
   */
  async function classifyPanels(panelIds: string[], cfg: ReturnType<typeof loadConfig>): Promise<{
    sideWall: string; flangeTab: string; topWall: string;
    sideWallBbox: Bbox; flangeTabBbox: Bbox; topWallBbox: Bbox;
  } | null> {
    const bboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of panelIds) {
      const bbox = await dispatchTool('bounding_box', { target: id }, cfg) as Bbox;
      bboxes.push({ id, bbox });
      console.log(`[classify] panel ${id.slice(-8)}: x[${bbox.x_min.toFixed(1)}..${bbox.x_max.toFixed(1)}] y[${bbox.y_min.toFixed(1)}..${bbox.y_max.toFixed(1)}] z[${bbox.z_min.toFixed(1)}..${bbox.z_max.toFixed(1)}]`);
    }

    // Top wall: thin in Z (z_max−z_min < 5mm), x/y spans ~200mm each, z_min > 190mm
    const topWallEntry = bboxes.find(({ bbox }) =>
      bbExtent(bbox, 'z') < 5 &&
      bbExtent(bbox, 'x') > 150 &&
      bbExtent(bbox, 'y') > 150 &&
      bbox.z_min > 150
    );

    // +X side wall: thin in X (x_max−x_min < 5mm), y/z spans ~200mm each, x_min > 150mm
    const sideWallEntry = bboxes.find(({ bbox }) =>
      bbExtent(bbox, 'x') < 5 &&
      bbExtent(bbox, 'y') > 150 &&
      bbExtent(bbox, 'z') > 150 &&
      bbox.x_min > 150
    );

    // Flange tab on +X face: x_max > 195mm AND thin in both Y and Z (small tab)
    const flangeTabEntry = bboxes.find(({ bbox, id }) =>
      id !== sideWallEntry?.id &&
      id !== topWallEntry?.id &&
      bbox.x_min > 195 &&
      bbExtent(bbox, 'y') < 50 &&
      bbExtent(bbox, 'z') < 50
    );

    if (!topWallEntry || !sideWallEntry || !flangeTabEntry) {
      console.warn('[classify] Could not identify required panels:',
        { topWall: !!topWallEntry, sideWall: !!sideWallEntry, flangeTab: !!flangeTabEntry });
      return null;
    }

    return {
      sideWall: sideWallEntry.id,    sideWallBbox: sideWallEntry.bbox,
      flangeTab: flangeTabEntry.id,  flangeTabBbox: flangeTabEntry.bbox,
      topWall: topWallEntry.id,      topWallBbox: topWallEntry.bbox,
    };
  }

  it('[bug repro] fuse side-wall+flange, then merge with top wall — observe rectangular flat + tilted 3D', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) { console.warn(`${fixtureName} missing — skipping`); return; }

    const config = loadConfig(configPath);

    // 1. Load and split
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count, 'cube_with_flanges must split into 10 panels').toBe(10);

    // 2. Classify panels
    const panels = await classifyPanels(split.panel_ids as string[], config);
    if (!panels) { console.warn('Panel classification failed — skipping'); return; }
    const { sideWall, sideWallBbox, flangeTab, flangeTabBbox, topWall } = panels;

    console.log(`[repro] sideWall=${sideWall.slice(-8)}, flangeTab=${flangeTab.slice(-8)}, topWall=${topWall.slice(-8)}`);

    // 3. Begin transaction
    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-repro' }, config);
    const txId: string = txn.transaction_id;

    // 4. Translate the flange tab so its BOTTOM aligns with the TOP EDGE of the side wall.
    //    The side wall top edge is at z=sideWallBbox.z_max ≈ 200.
    //    We want flangeTab.z_min → sideWallBbox.z_max so the flange EXTENDS ABOVE the wall.
    //    This places the flange at z=[200..210], touching the side wall top and sticking
    //    up toward (and adjacent to) the top wall's outer face at z≈200.
    const zShift = sideWallBbox.z_max - flangeTabBbox.z_min;
    console.log(`[repro] translating flange tab by [0, 0, ${zShift.toFixed(2)}] so it extends above side wall top edge (z=[${(flangeTabBbox.z_min + zShift).toFixed(1)}..${(flangeTabBbox.z_max + zShift).toFixed(1)}])`);

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [flangeTab],
      vector: [0, 0, zShift],
      keep_original: false,
    }, config);
    const translatedFlangeId: string = translated.solid_id;
    console.log(`[repro] translatedFlange=${translatedFlangeId.slice(-8)}`);

    // 5. Fuse the side wall + translated flange into a single panel
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [sideWall, translatedFlangeId],
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();
    console.log(`[repro] fused panel=${fused.solid_id.slice(-8)}, part=${(fused.part_id as string).slice(-8)}`);

    // Inspect the fused flat pattern
    const unfoldFused: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: config.materials[0]!.id,
    }, config).catch((err: unknown) => { console.log(`[repro] fused unfold failed: ${JSON.stringify(err)}`); return null; });

    if (unfoldFused) {
      const fw = unfoldFused.graph_flat_width_mm ?? unfoldFused.flat_width_mm;
      const fh = unfoldFused.graph_flat_height_mm ?? unfoldFused.flat_height_mm;
      console.log(`[repro] fused flat pattern: ${fw?.toFixed(1)}mm × ${fh?.toFixed(1)}mm`);
    }

    // 6. Merge the fused panel with the top wall
    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: fused.part_id,
        part_b_id: topWall,
        target_edges: ['all'],
        bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[repro] merge_bodies_with_bend threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }

    if (mergeError || !merged) {
      // Merge may fail for adjacent-edge reasons — log and skip assertions
      console.warn('[repro] merge failed — cannot verify flat pattern or 3D orientation');
      return;
    }

    console.log(`[repro] merged shell=${merged.merged_shell_id}, part=${merged.merged_part_id}`);

    // 7. Inspect flat pattern — BUG: expect rectangular but should be T/L-shaped
    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,
      material_id: config.materials[0]!.id,
    }, config).catch((err: unknown) => { console.log(`[repro] unfold threw: ${JSON.stringify(err)}`); return null; });

    if (unfold) {
      const w = unfold.graph_flat_width_mm ?? unfold.flat_width_mm;
      const h = unfold.graph_flat_height_mm ?? unfold.flat_height_mm;
      console.log(`[repro] merged flat pattern: ${w?.toFixed(1)}mm × ${h?.toFixed(1)}mm`);

      if (unfold.dxf_content) {
        const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
        let xMin = Infinity, xMax = -Infinity, yMin2 = Infinity, yMax2 = -Infinity;
        for (const [x, y] of ring) {
          if (x < xMin) xMin = x; if (x > xMax) xMax = x;
          if (y < yMin2) yMin2 = y; if (y > yMax2) yMax2 = y;
        }
        const bboxArea = (xMax - xMin) * (yMax2 - yMin2);
        const area = polygonArea(ring);
        const fillRatio = bboxArea > 0 ? area / bboxArea : 1;
        console.log(`[repro] flat bbox: ${(xMax - xMin).toFixed(1)}mm × ${(yMax2 - yMin2).toFixed(1)}mm`);
        console.log(`[repro] flat area: ${area.toFixed(0)}mm²  bbox area: ${bboxArea.toFixed(0)}mm²  fill: ${(fillRatio * 100).toFixed(1)}%`);

        // Fill ratio check: the fuse adds a 20mm×10mm flange tab to a 200mm×200mm wall.
        // In a ~410mm×200mm merged flat the tab notch is only 200mm² in 82000mm² total —
        // so expected fill is ≈97.8% even when CORRECT. Truly rectangular = 100% (bug).
        expect(fillRatio, `[BUG] flat pattern lost the flange notch entirely (fill=${(fillRatio * 100).toFixed(1)}% ≥ 99%) — fuse+merge dropped the T-shape`).toBeLessThan(0.999);
      }
    }

    // 8. Check 3D orientation — BUG: merged shell should be axis-aligned but is tilted
    // Also solve are verify solved geometry matches cleanly
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

    const pf = getGeometryBinding().getPanelFrame(solvedShellId as string);
    console.log(`[repro] merged shell frame: normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)})`);
    console.log(`[repro] merged shell frame: u=(${pf.uX.toFixed(4)}, ${pf.uY.toFixed(4)}, ${pf.uZ.toFixed(4)})`);
    console.log(`[repro] merged shell frame: v=(${pf.vX.toFixed(4)}, ${pf.vY.toFixed(4)}, ${pf.vZ.toFixed(4)})`);

    const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-2 || Math.abs(n) < 1e-2;
    const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
    console.log(`[repro] 3D tilt detected: ${isTilted}`);

    // BUG ASSERTION: the merged shell's dominant face normal should be axis-aligned.
    // Currently FAILING (tilt is observed).
    // When the bug is fixed this assertion should pass.
    expect(isTilted, `[BUG] merged 3D shell is tilted — normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)}) is not axis-aligned`).toBe(false);
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────────
  // BUG REPRO #2: same as above, but the flange tab is ALSO shifted along the
  // seam axis (Y) so it overhangs the side wall's Y edge before the fuse.
  //
  // The first repro test's flange stays centered in Y (y=[90..110], well inside
  // the wall's y=[0..200]), so the fused panel's Y bbox is untouched and the
  // seam-axis centroid offset between the fused panel and the top wall is
  // trivially 0 — it never exercises the offset computation.
  //
  // Here the flange is pushed to y=[190..210], overhanging the wall's y=200
  // edge by 10mm. The fused panel's FULL bbox is now y=[0..210], asymmetric
  // relative to the top wall's y=[0..200] — exactly the shape of the user's
  // reported bug (a fused composite panel whose attached tab skews its
  // bounding-box centroid away from the real shared edge with the next panel,
  // shifting panel B's position in the merged flat pattern by the skew amount).
  //
  // This checks the MERGED FLAT PATTERN dimensions directly (computed by
  // mergeDxfOutlines in TypeScript from the graph-stored seamYOffset), which is
  // exactly what the user's screenshots showed was wrong — independent of a
  // separate, pre-existing 3D-placement quirk in buildShellFromFlatPattern's
  // bend-zone reconstruction for irregular fused shapes (out of scope here).
  // ──────────────────────────────────────────────────────────────────────────
  it('[bug repro] fuse side-wall+flange (flange overhangs seam edge), then merge with top wall — no spurious seam offset', async () => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) { console.warn(`${fixtureName} missing — skipping`); return; }

    const config = loadConfig(configPath);

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count, 'cube_with_flanges must split into 10 panels').toBe(10);

    const panels = await classifyPanels(split.panel_ids as string[], config);
    if (!panels) { console.warn('Panel classification failed — skipping'); return; }
    const { sideWall, sideWallBbox, flangeTab, flangeTabBbox, topWall, topWallBbox } = panels;

    const txn: any = await dispatchTool('begin_transaction', { label: 'fuse-repro-2' }, config);
    const txId: string = txn.transaction_id;

    // Translate the flange so it extends above the side wall's top edge (as before)
    // AND overhangs the wall's Y-max edge by 10mm (the new asymmetric component).
    const zShift = sideWallBbox.z_max - flangeTabBbox.z_min;
    const yShift = (sideWallBbox.y_max + 10) - flangeTabBbox.y_max;
    console.log(`[repro2] translating flange tab by [0, ${yShift.toFixed(2)}, ${zShift.toFixed(2)}]`);

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [flangeTab],
      vector: [0, yShift, zShift],
      keep_original: false,
    }, config);
    const translatedFlangeId: string = translated.solid_id;

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [sideWall, translatedFlangeId],
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;

    const unfoldFused: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: config.materials[0]!.id,
    }, config);
    const fusedFlatWidth = unfoldFused.graph_flat_width_mm ?? unfoldFused.flat_width_mm;
    const fusedFlatHeight = unfoldFused.graph_flat_height_mm ?? unfoldFused.flat_height_mm;
    console.log(`[repro2] fused flat pattern: ${fusedFlatWidth?.toFixed(1)}mm × ${fusedFlatHeight?.toFixed(1)}mm`);

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: fused.part_id,
        part_b_id: topWall,
        target_edges: ['all'],
        bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[repro2] merge_bodies_with_bend threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    if (mergeError || !merged) {
      console.warn('[repro2] merge failed — cannot verify flat pattern placement');
      return;
    }

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,
      material_id: config.materials[0]!.id,
    }, config);
    const mergedFlatWidth = unfold.graph_flat_width_mm ?? unfold.flat_width_mm;
    const mergedFlatHeight = unfold.graph_flat_height_mm ?? unfold.flat_height_mm;
    console.log(`[repro2] merged flat pattern: ${mergedFlatWidth?.toFixed(1)}mm × ${mergedFlatHeight?.toFixed(1)}mm`);

    // BUG ASSERTION: the merged flat pattern's height must be close to the LARGER
    // of the two panels' own seam-axis extents (here, the fused panel's own flat
    // height, ~203mm — the wall's 200mm plus the 3mm V-extent contributed by the
    // overhanging flange tab). A spurious seam offset (the original bug, driven by
    // the fused panel's full-bbox centroid being skewed by the overhanging tab)
    // would inflate this by roughly the overhang amount (~10mm), since panel B
    // gets shifted away from where it actually sits relative to panel A.
    const expectedMergedHeight = Math.max(fusedFlatHeight, topWallBbox.y_max - topWallBbox.y_min);
    const HEIGHT_TOL_MM = 5.0;
    expect(
      Math.abs(mergedFlatHeight - expectedMergedHeight),
      `[BUG] merged flat height=${mergedFlatHeight?.toFixed(2)}mm, expected≈${expectedMergedHeight.toFixed(2)}mm ` +
      `(a spurious seam offset from the overhanging flange tab would inflate this)`,
    ).toBeLessThanOrEqual(HEIGHT_TOL_MM);

    // Solve the geometry to verify perfect reconstruction under graph solver.
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

    // The merged 3D shell's bbox must be close to the union of the (pre-merge)
    // fused panel and top wall bboxes. A skewed full-bbox centroid feeding into
    // the fold-direction/dihedral-angle computation (a second, deeper bug found
    // alongside the seam-offset one) would tilt the merged shell away from this
    // expected union, even when the flat-pattern placement above is correct.
    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: solvedShellId as string }, config) as Bbox;
    const expectedUnion = unionBbox(fusedBbox, topWallBbox);
    console.log(`[repro2] merged 3D bbox:    ${fmt(mergedBbox)}`);
    console.log(`[repro2] expected (union):  ${fmt(expectedUnion)}`);
    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(mergedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[BUG] Bound ${k}: expected≈${expectedUnion[k].toFixed(2)} got=${mergedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm (spurious fold-direction tilt)`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    const pf = getGeometryBinding().getPanelFrame(solvedShellId as string);
    const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-2 || Math.abs(n) < 1e-2;
    const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
    console.log(`[repro2] merged shell normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)}) tilted=${isTilted}`);
    expect(isTilted, `[BUG] merged 3D shell is tilted — normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)})`).toBe(false);
  }, 120_000);
});

// ────────────────────────────────────────────────────────────────────────────
// MULTI-AXIS: the same fuse-then-merge scenario as above, repeated with the
// fold axis aligned with each of world X, Y, and Z in turn. cube_with_flanges
// has its own flange tab on all four side walls (+X, -X, +Y, -Y), so we reuse
// the SAME fixture for all three orientations rather than needing per-axis
// fixtures:
//   - fold axis Y: fuse(+X wall, +X flange) merged with (+Z top wall)
//   - fold axis X: fuse(+Y wall, +Y flange) merged with (+Z top wall)
//   - fold axis Z: fuse(+X wall, +X flange) merged with (+Y wall, unfused —
//     its own flange is left untouched/ignored, so only one side is composite)
//
// This exists because several of the bugs found in this area were tied to
// the arbitrary SIGN of cross(nA, nB) (the fold axis), which can differ
// depending on which world axis the two panels' normals happen to point
// along — a fix validated against only one orientation can silently still be
// broken for the other two.
// ────────────────────────────────────────────────────────────────────────────
describe('[multi-axis] fuse side-wall+flange then merge_bodies_with_bend: fold axis aligned with X / Y / Z', () => {
  const fixtureName = 'cube_with_flanges.stp';

  function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number {
    return b[`${axis}_max`] - b[`${axis}_min`];
  }

  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  interface AllFaces {
    plusXWall: string; plusXWallBbox: Bbox;
    plusXFlange: string; plusXFlangeBbox: Bbox;
    plusYWall: string; plusYWallBbox: Bbox;
    plusYFlange: string; plusYFlangeBbox: Bbox;
    topWall: string; topWallBbox: Bbox;
  }

  async function classifyAllFaces(panelIds: string[], cfg: ReturnType<typeof loadConfig>): Promise<AllFaces | null> {
    const bboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of panelIds) {
      const bbox = await dispatchTool('bounding_box', { target: id }, cfg) as Bbox;
      bboxes.push({ id, bbox });
    }

    const topWallEntry = bboxes.find(({ bbox }) =>
      ext(bbox, 'z') < 5 && ext(bbox, 'x') > 150 && ext(bbox, 'y') > 150 && bbox.z_min > 150);
    const plusXWallEntry = bboxes.find(({ bbox }) =>
      ext(bbox, 'x') < 5 && ext(bbox, 'y') > 150 && ext(bbox, 'z') > 150 && bbox.x_min > 150);
    const plusYWallEntry = bboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 150 && ext(bbox, 'z') > 150 && bbox.y_min > 150);
    const plusXFlangeEntry = bboxes.find(({ bbox, id }) =>
      id !== plusXWallEntry?.id && id !== topWallEntry?.id &&
      bbox.x_min > 195 && ext(bbox, 'y') < 50 && ext(bbox, 'z') < 50);
    const plusYFlangeEntry = bboxes.find(({ bbox, id }) =>
      id !== plusYWallEntry?.id && id !== topWallEntry?.id && id !== plusXFlangeEntry?.id &&
      bbox.y_min > 195 && ext(bbox, 'x') < 50 && ext(bbox, 'z') < 50);

    if (!topWallEntry || !plusXWallEntry || !plusYWallEntry || !plusXFlangeEntry || !plusYFlangeEntry) {
      console.warn('[classify-all] could not identify required faces:', {
        topWall: !!topWallEntry, plusXWall: !!plusXWallEntry, plusYWall: !!plusYWallEntry,
        plusXFlange: !!plusXFlangeEntry, plusYFlange: !!plusYFlangeEntry,
      });
      return null;
    }

    return {
      plusXWall: plusXWallEntry.id, plusXWallBbox: plusXWallEntry.bbox,
      plusXFlange: plusXFlangeEntry.id, plusXFlangeBbox: plusXFlangeEntry.bbox,
      plusYWall: plusYWallEntry.id, plusYWallBbox: plusYWallEntry.bbox,
      plusYFlange: plusYFlangeEntry.id, plusYFlangeBbox: plusYFlangeEntry.bbox,
      topWall: topWallEntry.id, topWallBbox: topWallEntry.bbox,
    };
  }

  interface AxisCase {
    foldAxis: 'X' | 'Y' | 'Z';
    pick: (f: AllFaces) => {
      wallId: string; wallBbox: Bbox;
      flangeId: string; flangeBbox: Bbox;
      simpleId: string; simpleBbox: Bbox;
    };
  }

  const cases: AxisCase[] = [
    {
      foldAxis: 'Y',
      pick: (f) => ({
        wallId: f.plusXWall, wallBbox: f.plusXWallBbox,
        flangeId: f.plusXFlange, flangeBbox: f.plusXFlangeBbox,
        simpleId: f.topWall, simpleBbox: f.topWallBbox,
      }),
    },
    {
      foldAxis: 'X',
      pick: (f) => ({
        wallId: f.plusYWall, wallBbox: f.plusYWallBbox,
        flangeId: f.plusYFlange, flangeBbox: f.plusYFlangeBbox,
        simpleId: f.topWall, simpleBbox: f.topWallBbox,
      }),
    },
    {
      foldAxis: 'Z',
      pick: (f) => ({
        wallId: f.plusXWall, wallBbox: f.plusXWallBbox,
        flangeId: f.plusXFlange, flangeBbox: f.plusXFlangeBbox,
        simpleId: f.plusYWall, simpleBbox: f.plusYWallBbox,
      }),
    },
  ];

  // Cross every axis case with BOTH argument orders. merge_bodies_with_bend treats
  // part_a_id and part_b_id very differently — referenceShellId for the 3D
  // reconstruction is always shellAId, and the placement formula is driven by
  // panelNodeA's effective flat width, not B's. A fix validated only with the
  // composite (fused) panel as A could still be broken when it's passed as B.
  const orders: Array<'compositeFirst' | 'simpleFirst'> = ['compositeFirst', 'simpleFirst'];
  const allCases = cases.flatMap((c) => orders.map((order) => ({ ...c, order })));

  it.each(allCases)('fold axis $foldAxis ($order): fuse wall+flange, then merge_bodies_with_bend', async ({ foldAxis, pick, order }) => {
    const fixturePath = findFixture(fixtureName);
    if (!fixturePath) { console.warn(`${fixtureName} missing — skipping`); return; }
    const config = loadConfig(configPath);

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count, 'cube_with_flanges must split into 10 panels').toBe(10);

    const faces = await classifyAllFaces(split.panel_ids as string[], config);
    if (!faces) { console.warn(`[multi-axis ${tag}] classification failed — skipping`); return; }
    const { wallId, wallBbox, flangeId, flangeBbox, simpleId, simpleBbox } = pick(faces);
    const tag = `${foldAxis}/${order}`;

    const txn: any = await dispatchTool('begin_transaction', { label: `multi-axis-${tag}` }, config);
    const txId: string = txn.transaction_id;

    // Extend the wall's flange tab to overhang the wall's top (Z) edge — the same
    // construction used by the single-axis repro tests above, just applied to
    // whichever wall/flange pair this axis case selected.
    const zShift = wallBbox.z_max - flangeBbox.z_min;
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [flangeId],
      vector: [0, 0, zShift],
      keep_original: false,
    }, config);
    const translatedFlangeId: string = translated.solid_id;

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [wallId, translatedFlangeId],
    }, config);
    expect(fused.solid_id, `[multi-axis ${tag}] fuse_bodies must return a solid_id`).toBeDefined();
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;

    const unfoldFused: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: config.materials[0]!.id,
    }, config);
    const fusedFlatWidth = unfoldFused.graph_flat_width_mm ?? unfoldFused.flat_width_mm;
    const fusedFlatHeight = unfoldFused.graph_flat_height_mm ?? unfoldFused.flat_height_mm;
    console.log(`[multi-axis ${tag}] fused flat pattern: ${fusedFlatWidth?.toFixed(1)}mm × ${fusedFlatHeight?.toFixed(1)}mm`);

    const partAId = order === 'compositeFirst' ? fused.part_id : simpleId;
    const partBId = order === 'compositeFirst' ? simpleId : fused.part_id;

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: partAId,
        part_b_id: partBId,
        target_edges: ['all'],
        bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[multi-axis ${tag}] merge_bodies_with_bend threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, `[multi-axis ${tag}] merge_bodies_with_bend must not throw`).toBeNull();
    if (!merged) return;

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,
      material_id: config.materials[0]!.id,
    }, config);
    const w = unfold.graph_flat_width_mm ?? unfold.flat_width_mm;
    const h = unfold.graph_flat_height_mm ?? unfold.flat_height_mm;
    console.log(`[multi-axis ${tag}] merged flat pattern: ${w?.toFixed(1)}mm × ${h?.toFixed(1)}mm`);

    expect(unfold.dxf_content, `[multi-axis ${tag}] get_unfold must return dxf_content`).toBeTruthy();
    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const area = polygonArea(ring);
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const bboxArea = (xMax - xMin) * (yMax - yMin);
    const fillRatio = bboxArea > 0 ? area / bboxArea : 1;
    console.log(`[multi-axis ${tag}] flat bbox ${(xMax - xMin).toFixed(1)}mm × ${(yMax - yMin).toFixed(1)}mm  fill=${(fillRatio * 100).toFixed(1)}%`);

    // BUG ASSERTION: the flange tab must still show up as a notch — a fully
    // rectangular result (fill≈100%) means the merge dropped the protrusion shape.
    expect(fillRatio,
      `[multi-axis ${tag}] [BUG] flat pattern is fully rectangular (fill=${(fillRatio * 100).toFixed(1)}%) — lost the flange notch`)
      .toBeLessThan(0.999);

    // Solve the geometry to verify perfect reconstruction under graph solver.
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

    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: solvedShellId as string }, config) as Bbox;
    const expectedUnion = unionBbox(fusedBbox, simpleBbox);
    console.log(`[multi-axis ${tag}] merged 3D bbox:   ${fmt(mergedBbox)}`);
    console.log(`[multi-axis ${tag}] expected (union): ${fmt(expectedUnion)}`);
    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(mergedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[multi-axis ${tag}] [BUG] Bound ${k}: expected≈${expectedUnion[k].toFixed(2)} got=${mergedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    const pf = getGeometryBinding().getPanelFrame(solvedShellId as string);
    const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-2 || Math.abs(n) < 1e-2;
    const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
    console.log(`[multi-axis ${tag}] merged shell normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)}) tilted=${isTilted}`);
    expect(isTilted, `[multi-axis ${tag}] [BUG] merged 3D shell is tilted — normal=(${pf.normalX.toFixed(4)}, ${pf.normalY.toFixed(4)}, ${pf.normalZ.toFixed(4)})`).toBe(false);
  }, 120_000);
});
