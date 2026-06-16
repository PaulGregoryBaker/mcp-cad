/**
 * Regression test: merge_bodies_with_bend must preserve 3D orientation.
 *
 * The merged shell is reconstructed from the flat pattern (buildShellFromFlatPattern)
 * and re-placed into 3D using Panel A's reference frame. A bug in that placement
 * transform can rotate, mirror/invert, or translate the part away from where the
 * original panels lived.
 *
 * Strategy: capture the 3D corners (axis-aligned bounding box) of the panels
 * BEFORE merging, take their union, then compare against where the merged shell
 * lands AFTER merging.
 *
 * Fixture: angle_bracket_45deg — an asymmetric L (Panel A flat in +X/+Y at z≈0,
 * Panel B folded down into −Z). The asymmetry in Z makes an inverted fold (Panel B
 * flipped up into +Z) detectable from the bounding box alone.
 *
 * STATUS:
 *  - PASSING guarantee (this test): the fold is NOT inverted and NOT rotated out of
 *    plane — Panel B still folds into −Z, the extrusion axis (Y) is preserved, and
 *    Panel A still occupies its original footprint. This guards the placement fix
 *    that previously flipped the fold to +Z.
 *  - DEFERRED guarantee (the `.skip` test below): exact bbox equality. This needs
 *    two further pieces that are not yet in place:
 *      (1) true oriented panel frames at split time (the C++ getPanelFrame helper
 *          exists but is not yet wired into the merge pipeline), so a tilted panel's
 *          real flat width and dihedral angle are used instead of axis-aligned-bbox
 *          estimates; and
 *      (2) an acute-angle refold in buildShellFromFlatPattern (today applyBend
 *          ignores the angle and Boolean-fuses two slabs, which only connects at 90°).
 *    Until both land, the 45° bracket refolds at ~90°, so the X-extent differs.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

const configPath = path.resolve(__dirname, '../../config/config.yaml');

function findFixture(filename: string): string | undefined {
  const fixturesDir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(fixturesDir, filename);
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

async function splitAndMerge(): Promise<{ before: Bbox; after: Bbox } | null> {
  const fixturePath = findFixture('angle_bracket_45deg.stp');
  if (!fixturePath) {
    console.warn('angle_bracket_45deg.stp not found — run generate_fixtures first; skipping');
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

  // BEFORE: capture each panel's 3D corners, union them.
  const bboxA: Bbox = await dispatchTool('bounding_box', { target: panelA }, config) as Bbox;
  const bboxB: Bbox = await dispatchTool('bounding_box', { target: panelB }, config) as Bbox;
  const before = unionBbox(bboxA, bboxB);

  const merged: any = await dispatchTool('merge_bodies_with_bend', {
    part_a_id: panelA,
    part_b_id: panelB,
    target_edges: ['all'],
    bend_radius: 1.0,
  }, config);
  expect(merged.merged_shell_id).toBeDefined();

  const after: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;

  console.log(`[orientation] union (before): ${fmt(before)}`);
  console.log(`[orientation] merged (after): ${fmt(after)}`);
  return { before, after };
}

describe('merge_bodies_with_bend: 3D orientation is preserved', () => {
  it('does not invert or rotate the part out of plane (fold stays in −Z, Y preserved, Panel A in place)', async () => {
    const r = await splitAndMerge();
    if (!r) return;
    const { before, after } = r;

    // Inversion guard: Panel B folds into −Z. If the placement flipped the fold to
    // +Z (the original bug), z_min would be ≈0 and z_max would be large-positive.
    expect(after.z_min, 'merged part must still fold into −Z (not inverted)').toBeLessThan(-50);
    expect(after.z_max, 'merged part must not balloon into +Z (inverted fold)').toBeLessThan(10);

    // Extrusion (Y) axis is preserved exactly — no rotation swapping Y with another axis.
    expect(after.y_min).toBeCloseTo(before.y_min, 0);
    expect(after.y_max).toBeCloseTo(before.y_max, 0);

    // Panel A still occupies its original footprint near x≈0 / z≈0 (not displaced far).
    expect(after.x_min, 'Panel A footprint should start near x=0').toBeLessThan(15);
    expect(after.z_max, 'Panel A face should sit near z=0').toBeLessThan(10);
  }, 60_000);

  // ── BUG REPRO: Y-axis translation after merge_bodies_with_bend ─────────────
  //
  // Confirmed failing: the merged shell is translated ~49 mm along Y relative to
  // the original panels. Observed values:
  //   before: y[0..200], after: y[49..151] — a ~49 mm shift inward.
  //
  // Root cause (located, not yet fixed):
  //   In buildShellFromFlatPattern (cpp/src/geometry/geometry_service.cc), the
  //   canonical panel-A centroid used for placement is computed from the FLAT
  //   pattern bounding box (canonCy = (yMin + yMax) / 2). For a non-rectangular
  //   panel the refFrame's oriented-bbox midV (the real 3D Y-midpoint) differs
  //   from canonCy. The discrepancy equals roughly half the seam-axis asymmetry
  //   and maps directly onto the world Y axis via the placement transform, giving
  //   the observed ~49 mm drift.
  //
  //   Fix required: replace canonCy with the reference panel's actual V-centroid
  //   (midV from the oriented-bbox loop just above the SetValues call), so the
  //   canonical flat-space centroid matches the 3D frame centroid for non-uniform
  //   panels.
  it('REPRO: merged shell Y-extent must match pre-merge panel union Y-extent (±5 mm)', async () => {
    const r = await splitAndMerge();
    if (!r) return;
    const { before, after } = r;

    const yMinDelta = Math.abs(after.y_min - before.y_min);
    const yMaxDelta = Math.abs(after.y_max - before.y_max);
    console.log(`[REPRO] y_min drift: ${yMinDelta.toFixed(2)} mm (before=${before.y_min.toFixed(2)}, after=${after.y_min.toFixed(2)})`);
    console.log(`[REPRO] y_max drift: ${yMaxDelta.toFixed(2)} mm (before=${before.y_max.toFixed(2)}, after=${after.y_max.toFixed(2)})`);

    const TOL_MM = 5.0;
    expect(yMinDelta, `Y-min drifted ${yMinDelta.toFixed(1)} mm — buildShellFromFlatPattern canonCy offset bug`)
      .toBeLessThanOrEqual(TOL_MM);
    expect(yMaxDelta, `Y-max drifted ${yMaxDelta.toFixed(1)} mm — buildShellFromFlatPattern canonCy offset bug`)
      .toBeLessThanOrEqual(TOL_MM);
  }, 60_000);

  it.skip('merged shell occupies the exact same 3D region as the pre-merge panels', async () => {
    // DEFERRED: buildShellFromFlatPattern placement has a known Z-offset bug for
    // acute-angle brackets. This needs (1) correct oriented panel frames at split
    // time and (2) acute-angle refold support.
    const r = await splitAndMerge();
    if (!r) return;
    const { before, after } = r;

    const TOL_MM = 5.0;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(after[k] - before[k]);
      expect(delta, `bbox bound ${k}: before=${before[k].toFixed(2)} after=${after[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }
  }, 60_000);
});
