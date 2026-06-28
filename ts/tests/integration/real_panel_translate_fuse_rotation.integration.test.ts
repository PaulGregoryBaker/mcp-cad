/**
 * fuse_bodies on REAL split panels (not hand-built synthetic ones), one of
 * them translated first — checking ROTATION (panelFrame u/v/normal) of the
 * fused result specifically, not just volume.
 *
 * Why this differs from fuse_bodies_coplanar_orientation.integration.test.ts's
 * synthetic-panel matrix (which all passed): a synthetic panel's panelFrame is
 * set BY HAND to exactly match what built its shapeDxf — they cannot disagree
 * by construction. A REAL panel from split_body_by_bends gets panelFrame from
 * an independent getPanelFrame() query and shapeDxf from an independent
 * unfoldShell+exportDxf+normalizePanelDxfOrientation pipeline — two separate
 * OCCT computations that CAN disagree on direction while agreeing on
 * magnitude (normalizePanelDxfOrientation only compares numeric width/height,
 * never direction). This test uses real fixtures specifically to let that
 * possible disagreement manifest, instead of constructing it out of existence.
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

describe('[diagnostic] fuse_bodies on REAL split panels, one translated first — rotation check', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  const orders: Array<'wallFirst' | 'flangeFirst'> = ['wallFirst', 'flangeFirst'];

  it.each(orders)('cube_with_flanges.stp: real wall + real flange, flange translated away and back, then fused (%s)', async (order) => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }

    const txn: any = await dispatchTool('begin_transaction', { label: `real-panel-translate-${order}` }, config);
    const txId: string = txn.transaction_id;

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0, transaction_id: txId,
    }, config);
    expect(split.panel_count).toBe(10);

    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panels.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    const walls = panels.filter(({ bbox }) => {
      const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
      return dims[0]! < 5 && dims[1]! > 150 && dims[2]! > 150;
    });
    const flanges = panels.filter(({ bbox }) => ext(bbox, 'x') < 50 && ext(bbox, 'y') < 50 && ext(bbox, 'z') < 50);
    expect(walls.length).toBeGreaterThanOrEqual(1);
    expect(flanges.length).toBeGreaterThanOrEqual(1);

    // Pick the FIRST coplanar wall+flange pair (same thin axis, same centre on
    // that axis) — these are genuinely coplanar real panels, no synthetic
    // construction involved.
    function thinAxis(b: Bbox): { axis: 'x' | 'y' | 'z'; center: number } {
      const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
        { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
      ];
      dims.sort((a, b2) => a.extent - b2.extent);
      const axis = dims[0]!.axis;
      return { axis, center: (b[`${axis}_min`] + b[`${axis}_max`]) / 2 };
    }
    let wallId = '', flangeId = '';
    let wallBbox: Bbox | undefined, flangeBbox: Bbox | undefined;
    outer: for (const flange of flanges) {
      const ft = thinAxis(flange.bbox);
      for (const wall of walls) {
        const wt = thinAxis(wall.bbox);
        if (wt.axis === ft.axis && Math.abs(wt.center - ft.center) < 10) {
          wallId = wall.id; flangeId = flange.id; wallBbox = wall.bbox; flangeBbox = flange.bbox;
          break outer;
        }
      }
    }
    expect(wallId, 'expected at least one coplanar wall+flange pair').not.toBe('');
    console.log(`[real ${order}] wall ${wallId}: ${fmt(wallBbox!)}`);
    console.log(`[real ${order}] flange ${flangeId}: ${fmt(flangeBbox!)}`);

    const wallFrameBefore = getGeometryBinding().getPanelFrame(wallId);
    const flangeFrameBefore = getGeometryBinding().getPanelFrame(flangeId);
    console.log(`[real ${order}] wall frame before:   u=(${wallFrameBefore.uX.toFixed(3)},${wallFrameBefore.uY.toFixed(3)},${wallFrameBefore.uZ.toFixed(3)}) v=(${wallFrameBefore.vX.toFixed(3)},${wallFrameBefore.vY.toFixed(3)},${wallFrameBefore.vZ.toFixed(3)}) n=(${wallFrameBefore.normalX.toFixed(3)},${wallFrameBefore.normalY.toFixed(3)},${wallFrameBefore.normalZ.toFixed(3)})`);
    console.log(`[real ${order}] flange frame before: u=(${flangeFrameBefore.uX.toFixed(3)},${flangeFrameBefore.uY.toFixed(3)},${flangeFrameBefore.uZ.toFixed(3)}) v=(${flangeFrameBefore.vX.toFixed(3)},${flangeFrameBefore.vY.toFixed(3)},${flangeFrameBefore.vZ.toFixed(3)}) n=(${flangeFrameBefore.normalX.toFixed(3)},${flangeFrameBefore.normalY.toFixed(3)},${flangeFrameBefore.normalZ.toFixed(3)})`);

    // Translate the flange away (50mm along an axis NOT its own thickness
    // axis, so it stays geometrically valid) and back — a true round trip,
    // net zero displacement, like the synthetic tests did.
    const ft = thinAxis(flangeBbox!);
    const moveAxisIdx = ft.axis === 'x' ? 1 : 0; // any in-plane axis works
    const away: [number, number, number] = [0, 0, 0];
    away[moveAxisIdx] = 73;
    const back: [number, number, number] = away.map((v) => -v) as [number, number, number];

    const moved1: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [flangeId], vector: away, keep_original: false,
    }, config);
    const moved2: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [moved1.solid_id], vector: back, keep_original: false,
    }, config);
    const flangeFinalId: string = moved2.solid_id;

    const flangeBboxAfter: Bbox = await dispatchTool('bounding_box', { target: flangeFinalId }, config) as Bbox;
    console.log(`[real ${order}] flange after round-trip translate: ${fmt(flangeBboxAfter)}`);
    const TOL_MM = 0.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      expect(Math.abs(flangeBboxAfter[k] - flangeBbox![k]),
        `[real ${order}] [BUG] flange bbox.${k} changed after a net-zero round-trip translate`).toBeLessThanOrEqual(TOL_MM);
    }

    const flangeFrameAfter = getGeometryBinding().getPanelFrame(flangeFinalId);
    console.log(`[real ${order}] flange frame after:  u=(${flangeFrameAfter.uX.toFixed(3)},${flangeFrameAfter.uY.toFixed(3)},${flangeFrameAfter.uZ.toFixed(3)}) v=(${flangeFrameAfter.vX.toFixed(3)},${flangeFrameAfter.vY.toFixed(3)},${flangeFrameAfter.vZ.toFixed(3)}) n=(${flangeFrameAfter.normalX.toFixed(3)},${flangeFrameAfter.normalY.toFixed(3)},${flangeFrameAfter.normalZ.toFixed(3)})`);

    const toolOrder = order === 'wallFirst' ? [wallId, flangeFinalId] : [flangeFinalId, wallId];
    const fused: any = await dispatchTool('fuse_bodies', { transaction_id: txId, tools: toolOrder }, config);
    expect(fused.solid_id, `[real ${order}] fuse_bodies must return a solid_id`).toBeDefined();

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    const fusedFrame = getGeometryBinding().getPanelFrame(fused.solid_id as string);
    console.log(`[real ${order}] fused bbox: ${fmt(fusedBbox)}`);
    console.log(`[real ${order}] fused frame: u=(${fusedFrame.uX.toFixed(3)},${fusedFrame.uY.toFixed(3)},${fusedFrame.uZ.toFixed(3)}) v=(${fusedFrame.vX.toFixed(3)},${fusedFrame.vY.toFixed(3)},${fusedFrame.vZ.toFixed(3)}) n=(${fusedFrame.normalX.toFixed(3)},${fusedFrame.normalY.toFixed(3)},${fusedFrame.normalZ.toFixed(3)})`);

    // The fused result should be the union of the (untouched) wall and the
    // (round-tripped, net-zero) flange bboxes.
    const expectedUnion: Bbox = {
      x_min: Math.min(wallBbox!.x_min, flangeBbox!.x_min), x_max: Math.max(wallBbox!.x_max, flangeBbox!.x_max),
      y_min: Math.min(wallBbox!.y_min, flangeBbox!.y_min), y_max: Math.max(wallBbox!.y_max, flangeBbox!.y_max),
      z_min: Math.min(wallBbox!.z_min, flangeBbox!.z_min), z_max: Math.max(wallBbox!.z_max, flangeBbox!.z_max),
    };
    console.log(`[real ${order}] expected union bbox: ${fmt(expectedUnion)}`);
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(fusedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[real ${order}] [BUG] fused bbox.${k}: expected≈${expectedUnion[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(2.0);
    }

    // Rotation check: fused frame's normal must match the wall's ORIGINAL
    // normal (the dominant/reference panel), including sign.
    expect(fusedFrame.normalX, `[real ${order}] [BUG] fused normal X vs wall`).toBeCloseTo(wallFrameBefore.normalX, 1);
    expect(fusedFrame.normalY, `[real ${order}] [BUG] fused normal Y vs wall`).toBeCloseTo(wallFrameBefore.normalY, 1);
    expect(fusedFrame.normalZ, `[real ${order}] [BUG] fused normal Z vs wall`).toBeCloseTo(wallFrameBefore.normalZ, 1);
  }, 60_000);
});
