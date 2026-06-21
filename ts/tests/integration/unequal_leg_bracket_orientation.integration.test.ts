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

function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] ` +
    `y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] ` +
    `z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}

function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number {
  return b[`${axis}_max`] - b[`${axis}_min`];
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), z_min: Math.min(a.z_min, b.z_min),
    x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max), z_max: Math.max(a.z_max, b.z_max),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// unequal_leg_bracket_90deg.stp: two SIMPLE, non-composite panels at a sharp
// 90° dihedral, with deliberately UNEQUAL leg lengths (100mm long leg, 30mm
// short leg) sharing the full 100mm common (Y) edge. No fuse_bodies, no
// protrusions, no composite-panel complexity at all — this isolates whether
// the BASE merge_bodies_with_bend mechanism itself preserves 3D orientation
// correctly, independent of every fused-panel bug already fixed.
//
// Because the legs are clearly DIFFERENT sizes (100 vs 30, not near-square),
// an axis/U-V swap is immediately visible: the long leg's ~100mm dimension
// and short leg's ~30mm dimension must land on the SAME world axis (the one
// matching the long leg's own outward direction) in the merged result — if
// orientation is wrong, that axis could show ~100mm where ~130mm-ish
// (the union, accounting for the bend-corner overlap) is expected, or the
// 100mm common/seam edge could end up on the wrong axis entirely.
//
// Tested in three orientations (the whole bracket solid is rotated BEFORE
// splitting, so the fold axis lands on world Y, X, and Z respectively), each
// with both argument orders (long-leg-first / short-leg-first).
// ────────────────────────────────────────────────────────────────────────────
describe('[orientation] unequal_leg_bracket_90deg.stp: merge_bodies_with_bend precisely preserves 3D position (two simple panels)', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  interface OrientationCase {
    foldAxisLabel: 'Y' | 'X' | 'Z';
    // Rotation applied to the WHOLE solid before splitting, to redirect the
    // fold axis (originally Y in the fixture's native pose) onto a different
    // world axis. null = no rotation (native pose, fold axis stays Y).
    rotate: { axisDirection: [number, number, number]; angleDegrees: number } | null;
  }

  const orientationCases: OrientationCase[] = [
    { foldAxisLabel: 'Y', rotate: null },
    { foldAxisLabel: 'X', rotate: { axisDirection: [0, 0, 1], angleDegrees: 90 } },
    { foldAxisLabel: 'Z', rotate: { axisDirection: [1, 0, 0], angleDegrees: 90 } },
  ];
  const orders: Array<'longFirst' | 'shortFirst'> = ['longFirst', 'shortFirst'];
  const allCases = orientationCases.flatMap((c) => orders.map((order) => ({ ...c, order })));

  it.each(allCases)('fold axis $foldAxisLabel ($order)', async ({ foldAxisLabel, rotate, order }) => {
    const fixturePath = findFixture('unequal_leg_bracket_90deg.stp');
    if (!fixturePath) { console.warn('unequal_leg_bracket_90deg.stp missing — skipping'); return; }
    const config = loadConfig(configPath);
    const tag = `${foldAxisLabel}/${order}`;

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    const txn: any = await dispatchTool('begin_transaction', { label: `unequal-leg-${tag}` }, config);
    const txId: string = txn.transaction_id;

    let solidId: string = clean.solid_id;
    if (rotate) {
      const rotated: any = await dispatchTool('rotate_body', {
        transaction_id: txId,
        targets: [solidId],
        axis_origin: [0, 0, 0],
        axis_direction: rotate.axisDirection,
        angle_degrees: rotate.angleDegrees,
        keep_original: false,
      }, config);
      solidId = rotated.solid_id;
    }

    // default_thickness_mm deliberately omitted: split_body_by_bends now
    // measures each resulting panel's actual geometric thickness (1.5mm here,
    // via the Dominant Face Method) rather than defaulting to 1.0mm.
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
      transaction_id: txId,
    }, config);
    expect(split.panel_count, `[${tag}] expected exactly 2 panels`).toBe(2);
    const [p1, p2] = split.panel_ids as [string, string];

    const bbox1: Bbox = await dispatchTool('bounding_box', { target: p1 }, config) as Bbox;
    const bbox2: Bbox = await dispatchTool('bounding_box', { target: p2 }, config) as Bbox;
    console.log(`[${tag}] panel1: ${fmt(bbox1)}`);
    console.log(`[${tag}] panel2: ${fmt(bbox2)}`);

    // Identify which split panel is the long leg (~100mm) vs short leg (~30mm)
    // by their largest in-plane extent (their own face frame's longer axis).
    const frame1: any = getGeometryBinding().getPanelFrame(p1);
    const frame2: any = getGeometryBinding().getPanelFrame(p2);
    const longLeg = frame1.uExtentMm >= frame2.uExtentMm ? { id: p1, bbox: bbox1 } : { id: p2, bbox: bbox2 };
    const shortLeg = frame1.uExtentMm >= frame2.uExtentMm ? { id: p2, bbox: bbox2 } : { id: p1, bbox: bbox1 };
    console.log(`[${tag}] longLeg uExt=${Math.max(frame1.uExtentMm, frame2.uExtentMm).toFixed(2)} shortLeg uExt=${Math.min(frame1.uExtentMm, frame2.uExtentMm).toFixed(2)}`);

    const partAId = order === 'longFirst' ? longLeg.id : shortLeg.id;
    const partBId = order === 'longFirst' ? shortLeg.id : longLeg.id;

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: partAId,
        part_b_id: partBId,
        target_edges: ['all'],
        bend_radius: 0.01,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[${tag}] merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, `[${tag}] merge_bodies_with_bend must not throw`).toBeNull();
    if (!merged) return;

    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    const expectedUnion = unionBbox(longLeg.bbox, shortLeg.bbox);
    console.log(`[${tag}] merged 3D bbox:   ${fmt(mergedBbox)}`);
    console.log(`[${tag}] expected (union): ${fmt(expectedUnion)}`);

    // PRIMARY ASSERTION (precise — these are two simple, non-composite panels,
    // so there is no excuse for any residual): the merged 3D bbox must match
    // the union of the pre-merge panel bboxes to within a tight tolerance.
    const TOL_MM = 0.5;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(mergedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[${tag}] [BUG] Bound ${k}: expected≈${expectedUnion[k].toFixed(2)} got=${mergedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm — orientation/axis-swap error`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    // SECONDARY ASSERTION (orientation sanity, independent of the above): the
    // combined long+short leg reach (~125-130mm, accounting for the
    // bend-corner overlap) must land on the SAME world axis the long leg's
    // own bbox occupies most distinctly — not swapped with the 100mm
    // common/seam (Y-extrusion) extent.
    const expectedCombinedExtent = ext(expectedUnion, 'x') >= ext(expectedUnion, 'y') && ext(expectedUnion, 'x') >= ext(expectedUnion, 'z')
      ? 'x' : ext(expectedUnion, 'y') >= ext(expectedUnion, 'z') ? 'y' : 'z';
    const mergedLargestAxis = ext(mergedBbox, 'x') >= ext(mergedBbox, 'y') && ext(mergedBbox, 'x') >= ext(mergedBbox, 'z')
      ? 'x' : ext(mergedBbox, 'y') >= ext(mergedBbox, 'z') ? 'y' : 'z';
    console.log(`[${tag}] expected largest-extent axis=${expectedCombinedExtent} (${ext(expectedUnion, expectedCombinedExtent).toFixed(1)}mm), merged largest-extent axis=${mergedLargestAxis} (${ext(mergedBbox, mergedLargestAxis).toFixed(1)}mm)`);
    expect(mergedLargestAxis, `[${tag}] [BUG] combined leg-reach landed on the wrong world axis (orientation/axis swap)`).toBe(expectedCombinedExtent);

    const pf = getGeometryBinding().getPanelFrame(merged.merged_shell_id as string);
    const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-2 || Math.abs(n) < 1e-2;
    const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
    console.log(`[${tag}] normal=(${pf.normalX.toFixed(4)},${pf.normalY.toFixed(4)},${pf.normalZ.toFixed(4)}) tilted=${isTilted}`);
    expect(isTilted, `[${tag}] [BUG] merged 3D shell is tilted`).toBe(false);
  }, 120_000);
});
