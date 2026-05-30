// Round-trip harness for the unfold pipeline.
//
// Each test composes a known-good folded shape from cube panels via
// merge_bodies_with_bend, then runs apply_unfold and asserts the flat
// dimensions match what we put in.  Cases progress from the existing
// passing baseline (one merge) to the screenshot failure shape
// (chained merges, translated panels, multi-bend bodies).
//
// The screenshot bug shows three panels (c0178c8c, 8ec3f2e0, c56466af)
// all coming back with Thickness N/A and broken flat patterns after a
// pipeline of 3× merge_bodies_with_bend + 6× translate_body.  These
// tests probe each compounding step in isolation so the first failure
// localises the breaking interaction.

import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { transactionRegistry } from '../../src/mcp/transactions';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

// Ensure no transaction leaks between cases — a thrown expect() before
// the explicit rollback would otherwise leave the singleton registry
// holding an active transaction and poison subsequent tests.
afterEach(async () => {
  const active = transactionRegistry.getActive();
  if (active) {
    try {
      await dispatchTool('rollback_transaction', { transaction_id: active.id }, config);
    } catch { /* best effort */ }
  }
});

interface Bbox {
  x_min: number; x_max: number;
  y_min: number; y_max: number;
  z_min: number; z_max: number;
}

interface PanelInfo {
  id: string;
  bbox: Bbox;
  dx: number;
  dy: number;
  dz: number;
  // Sorted ascending: [thickness, midDim, maxDim]
  sorted: [number, number, number];
  // Normal direction that "thickness" runs along: "X" | "Y" | "Z"
  thicknessAxis: 'X' | 'Y' | 'Z';
  centre: { x: number; y: number; z: number };
}

function dims(bbox: Bbox): { dx: number; dy: number; dz: number } {
  return {
    dx: bbox.x_max - bbox.x_min,
    dy: bbox.y_max - bbox.y_min,
    dz: bbox.z_max - bbox.z_min,
  };
}

function classify(id: string, bbox: Bbox): PanelInfo {
  const { dx, dy, dz } = dims(bbox);
  const triples: Array<[number, 'X' | 'Y' | 'Z']> = [
    [dx, 'X'],
    [dy, 'Y'],
    [dz, 'Z'],
  ];
  triples.sort((a, b) => a[0] - b[0]);
  const cx = (bbox.x_min + bbox.x_max) / 2;
  const cy = (bbox.y_min + bbox.y_max) / 2;
  const cz = (bbox.z_min + bbox.z_max) / 2;
  return {
    id,
    bbox,
    dx, dy, dz,
    sorted: [triples[0]![0], triples[1]![0], triples[2]![0]],
    thicknessAxis: triples[0]![1],
    centre: { x: cx, y: cy, z: cz },
  };
}

function side(p: PanelInfo): string {
  // Encode which side of the cube the panel sits on, e.g. "+X" or "-Z".
  const axis = p.thicknessAxis;
  const val = axis === 'X' ? p.centre.x : axis === 'Y' ? p.centre.y : p.centre.z;
  return `${val >= 0 ? '+' : '-'}${axis}`;
}

async function splitTestcube(): Promise<{ panels: PanelInfo[]; cleanId: string }> {
  const fixturePath = getFixturePath('testcube.step');
  const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
  const split: any = await dispatchTool('split_body_by_bends', {
    part_id: clean.solid_id,
    angle_threshold_deg: 45,
    max_thickness_mm: 2.0,
    max_recursion_depth: 2,
  }, config);
  const panels: PanelInfo[] = split.panel_ids.map((id: string, i: number) =>
    classify(id, split.panel_bboxes[i]));
  return { panels, cleanId: clean.solid_id };
}

// Outer cube wall panels: ~200mm × ~200mm × ~1mm thickness.
function outerPanels(panels: PanelInfo[]): PanelInfo[] {
  return panels.filter(p => p.sorted[0]! < 3.0 && p.sorted[1]! > 180 && p.sorted[2]! > 180);
}

// Inner cube wall panels: ~150mm × ~150mm × ~1mm thickness.
function innerPanels(panels: PanelInfo[]): PanelInfo[] {
  return panels.filter(p =>
    p.sorted[0]! < 3.0 &&
    p.sorted[1]! > 140 && p.sorted[1]! < 160 &&
    p.sorted[2]! > 140 && p.sorted[2]! < 160);
}

// Partition 6 cube faces into 3 perpendicular adjacent pairs.
// A cube has 2 faces perpendicular to each axis (the +axis and -axis side).
// We pair faces of differing thickness axes so each pair shares a corner edge.
// Example pairing: (Xa, Ya), (Xb, Za), (Yb, Zb).
function pairCubeFaces(six: PanelInfo[]): Array<[PanelInfo, PanelInfo]> {
  const xs = six.filter(p => p.thicknessAxis === 'X');
  const ys = six.filter(p => p.thicknessAxis === 'Y');
  const zs = six.filter(p => p.thicknessAxis === 'Z');
  if (xs.length !== 2 || ys.length !== 2 || zs.length !== 2) {
    throw new Error(`Cube face partition expected 2/2/2 by axis, got ${xs.length}/${ys.length}/${zs.length}`);
  }
  return [
    [xs[0]!, ys[0]!],
    [xs[1]!, zs[0]!],
    [ys[1]!, zs[1]!],
  ];
}

describe('Unfold round-trip harness', () => {
  // ── BASELINE (must always pass — matches the existing regression) ──

  it('CASE 1: one merge of two perpendicular outer panels unfolds to 400×200 / 1 bend', async () => {
    const { panels } = await splitTestcube();
    const outer = outerPanels(panels);
    expect(outer.length).toBe(6);

    const txn: any = await dispatchTool('begin_transaction', { label: 'roundtrip_case1' }, config);

    let mergedId: string | undefined;
    let pickedPair: [PanelInfo, PanelInfo] | undefined;
    for (let i = 1; i < outer.length; i++) {
      if (outer[i]!.thicknessAxis === outer[0]!.thicknessAxis) continue;  // need perpendicular
      try {
        const m: any = await dispatchTool('merge_bodies_with_bend', {
          part_a_id: outer[0]!.id,
          part_b_id: outer[i]!.id,
          target_edges: ['all'],
          bend_radius: 2.0,
          transaction_id: txn.transaction_id,
        }, config);
        if (m?.merged_shell_id) {
          mergedId = m.merged_shell_id;
          pickedPair = [outer[0]!, outer[i]!];
          break;
        }
      } catch { /* try next */ }
    }
    expect(mergedId).toBeDefined();
    expect(pickedPair).toBeDefined();

    const unfold: any = await dispatchTool('apply_unfold', {
      panel_id: mergedId,
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    const maxDim = Math.max(unfold.flat_width_mm, unfold.flat_height_mm);
    const minDim = Math.min(unfold.flat_width_mm, unfold.flat_height_mm);
    console.log(`[CASE 1] flat=${unfold.flat_width_mm}×${unfold.flat_height_mm}mm bends=${unfold.bend_count} thickness=${unfold.nominal_thickness_mm}`);

    expect(unfold.bend_count).toBe(1);
    expect(Math.abs(maxDim - 400.0)).toBeLessThan(10.0);
    expect(Math.abs(minDim - 200.0)).toBeLessThan(10.0);
    // Regression for the "Thickness N/A" UI symptom — handleApplyUnfold must
    // expose detectedThickness from the C++ engine.
    expect(unfold.nominal_thickness_mm).toBeGreaterThan(0.5);
    expect(unfold.nominal_thickness_mm).toBeLessThan(3.0);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);

  // ── CASE 2: chained merge (the suspected screenshot breaker) ──
  // The app's history showed 3× merge_bodies_with_bend on the same shape.
  // After the first merge the body is a folded L-shape; merging another
  // panel onto it joins to a 90°-rotated face of an existing skin, which
  // is exactly when validateSheetMetal starts producing Thickness N/A.

  it('CASE 2: chained merge (A+B) + C unfolds to 600×200 / 2 bends — known suspect', async () => {
    const { panels } = await splitTestcube();
    const outer = outerPanels(panels);

    const txn: any = await dispatchTool('begin_transaction', { label: 'roundtrip_case2' }, config);

    // Pick three mutually perpendicular outer panels (different thicknessAxis values).
    const byAxis = new Map<string, PanelInfo>();
    for (const p of outer) if (!byAxis.has(p.thicknessAxis)) byAxis.set(p.thicknessAxis, p);
    expect(byAxis.size).toBe(3);
    const [pA, pB, pC] = Array.from(byAxis.values()) as [PanelInfo, PanelInfo, PanelInfo];

    let abShell: string | undefined;
    try {
      const ab: any = await dispatchTool('merge_bodies_with_bend', {
        part_a_id: pA.id, part_b_id: pB.id,
        target_edges: ['all'], bend_radius: 2.0,
        transaction_id: txn.transaction_id,
      }, config);
      abShell = ab?.merged_shell_id;
    } catch (e) {
      console.log('[CASE 2] first merge A+B threw:', (e as { code?: string }).code);
    }
    expect(abShell).toBeDefined();

    let abcShell: string | undefined;
    let abcError: unknown;
    try {
      const abc: any = await dispatchTool('merge_bodies_with_bend', {
        part_a_id: abShell, part_b_id: pC.id,
        target_edges: ['all'], bend_radius: 2.0,
        transaction_id: txn.transaction_id,
      }, config);
      abcShell = abc?.merged_shell_id;
    } catch (e) {
      abcError = e;
      console.log('[CASE 2] chained merge (A+B)+C threw:', (e as { code?: string }).code);
    }

    if (!abcShell) {
      console.log('[CASE 2] chained merge failed before unfold — root cause is merge_bodies_with_bend on already-merged shell');
      await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
      // We want the test to *fail loudly* if the merge step is what's broken,
      // because that is the screenshot's symptom — propagate the original error.
      throw abcError ?? new Error('CASE 2: chained merge produced no shell');
    }

    let unfold: any;
    let unfoldError: unknown;
    try {
      unfold = await dispatchTool('apply_unfold', {
        panel_id: abcShell,
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id,
      }, config);
    } catch (e) {
      unfoldError = e;
    }

    if (unfoldError) {
      console.log('[CASE 2] unfold of chained shell rejected:', (unfoldError as { code?: string; message?: string }));
      // Either it's a legitimate "this is not sheet metal" (e.g. closed corner) OR
      // it's the screenshot symptom. Capture which.
      throw unfoldError;
    }

    console.log(`[CASE 2] flat=${unfold.flat_width_mm}×${unfold.flat_height_mm}mm bends=${unfold.bend_count} thickness=${unfold.nominal_thickness_mm}`);
    // Three 200×200 panels joined in a hairpin would be 600×200 with 2 bends.
    // Three meeting at a corner is a closed pocket and should be rejected.
    // We accept either, but Thickness N/A (== 0) is what we're hunting.
    expect(unfold.nominal_thickness_mm).toBeGreaterThan(0);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);

  // ── CASE 3: translate-then-merge ──
  // The app history had 6× translate_body before the merges.  Translating a
  // panel slightly (creating a known gap/overlap) probes whether the sewing
  // tolerance in unfoldShell (0.1 mm) is wide enough for what merge produces.

  it('CASE 3: translate one panel by 0.05mm then merge — sewing tolerance probe', async () => {
    const { panels } = await splitTestcube();
    const outer = outerPanels(panels);
    const byAxis = new Map<string, PanelInfo>();
    for (const p of outer) if (!byAxis.has(p.thicknessAxis)) byAxis.set(p.thicknessAxis, p);
    const [pA, pB] = Array.from(byAxis.values()) as [PanelInfo, PanelInfo];

    const txn: any = await dispatchTool('begin_transaction', { label: 'roundtrip_case3' }, config);

    // Nudge panel B by 0.05mm along its thickness axis (well within the 0.1mm
    // sewing tolerance in unfoldShell). If the merge step doesn't re-sew, this
    // will surface as a phantom seam.
    const vec: [number, number, number] = [
      pB.thicknessAxis === 'X' ? 0.05 : 0,
      pB.thicknessAxis === 'Y' ? 0.05 : 0,
      pB.thicknessAxis === 'Z' ? 0.05 : 0,
    ];
    const translated: any = await dispatchTool('translate_body', {
      targets: [pB.id],
      vector: vec,
      transaction_id: txn.transaction_id,
    }, config);
    const movedB = translated?.solid_ids?.[0] ?? translated?.solid_id ?? pB.id;
    console.log(`[CASE 3] panel B ${pB.id} → translated ${movedB}`);

    let mergedId: string | undefined;
    let mergeError: unknown;
    try {
      const m: any = await dispatchTool('merge_bodies_with_bend', {
        part_a_id: pA.id, part_b_id: movedB,
        target_edges: ['all'], bend_radius: 2.0,
        transaction_id: txn.transaction_id,
      }, config);
      mergedId = m?.merged_shell_id;
    } catch (e) {
      mergeError = e;
    }

    if (!mergedId) {
      console.log('[CASE 3] merge after 0.05mm translate failed:', (mergeError as { code?: string }));
      await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
      throw mergeError ?? new Error('merge after translate produced no shell');
    }

    let unfold: any;
    try {
      unfold = await dispatchTool('apply_unfold', {
        panel_id: mergedId,
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id,
      }, config);
    } catch (e) {
      console.log('[CASE 3] unfold after translate-then-merge rejected:', (e as { code?: string }));
      throw e;
    }

    console.log(`[CASE 3] flat=${unfold.flat_width_mm}×${unfold.flat_height_mm}mm bends=${unfold.bend_count} thickness=${unfold.nominal_thickness_mm}`);
    expect(unfold.nominal_thickness_mm).toBeGreaterThan(0);
    expect(unfold.bend_count).toBe(1);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);

  // ── CASE 4: user's manual test (the screenshot scenario) ──
  //
  // For each of the two nested cubes:
  //   – take its 6 wall panels
  //   – partition into 3 perpendicular adjacent pairs (each pair shares a corner edge)
  //   – merge each pair via merge_bodies_with_bend
  //   – unfold each merged shell
  // Every resulting flat panel must be the same 2:1 rectangle with a single
  // central bend dividing the long side in half:
  //   – outer cube → 400×200 mm, 1 bend at x≈200
  //   – inner cube → 300×150 mm, 1 bend at x≈150
  // Any deviation reproduces the broken flat patterns from the UI screenshots.

  it('CASE 4: all six paired-cube unfolds are 2:1 rectangles with central bend', async () => {
    const { panels } = await splitTestcube();
    const outer = outerPanels(panels);
    const inner = innerPanels(panels);
    expect(outer.length).toBe(6);
    expect(inner.length).toBe(6);

    const txn: any = await dispatchTool('begin_transaction', { label: 'roundtrip_case4' }, config);

    interface CubeExpect {
      label: string;
      pairs: Array<[PanelInfo, PanelInfo]>;
      longMm: number;
      shortMm: number;
    }
    const cubes: CubeExpect[] = [
      { label: 'OUTER', pairs: pairCubeFaces(outer), longMm: 400, shortMm: 200 },
      { label: 'INNER', pairs: pairCubeFaces(inner), longMm: 300, shortMm: 150 },
    ];

    interface Failure { cube: string; pairIdx: number; reason: string; got?: unknown }
    const failures: Failure[] = [];

    for (const cube of cubes) {
      for (let i = 0; i < cube.pairs.length; i++) {
        const [pA, pB] = cube.pairs[i]!;
        let mergedId: string | undefined;
        try {
          const m: any = await dispatchTool('merge_bodies_with_bend', {
            part_a_id: pA.id, part_b_id: pB.id,
            target_edges: ['all'], bend_radius: 2.0,
            transaction_id: txn.transaction_id,
          }, config);
          mergedId = m?.merged_shell_id;
        } catch (e) {
          failures.push({ cube: cube.label, pairIdx: i, reason: 'merge_threw', got: (e as { code?: string; message?: string }) });
          continue;
        }
        if (!mergedId) {
          failures.push({ cube: cube.label, pairIdx: i, reason: 'merge_returned_no_shell' });
          continue;
        }

        let unfold: any;
        try {
          unfold = await dispatchTool('apply_unfold', {
            panel_id: mergedId,
            material_id: config.materials[0]!.id,
            transaction_id: txn.transaction_id,
          }, config);
        } catch (e) {
          failures.push({ cube: cube.label, pairIdx: i, reason: 'unfold_rejected', got: (e as { code?: string; message?: string }) });
          continue;
        }

        const flatMax = Math.max(unfold.flat_width_mm, unfold.flat_height_mm);
        const flatMin = Math.min(unfold.flat_width_mm, unfold.flat_height_mm);
        console.log(
          `[CASE 4 ${cube.label} pair ${i}] ` +
          `pA(${side(pA)}) + pB(${side(pB)}) → ` +
          `${unfold.flat_width_mm.toFixed(1)}×${unfold.flat_height_mm.toFixed(1)}mm ` +
          `bends=${unfold.bend_count} thickness=${unfold.nominal_thickness_mm?.toFixed(3)}`,
        );

        const longTol  = 15.0;  // mm: K-factor + bend-deduction can shave several mm
        const shortTol = 10.0;
        if (Math.abs(flatMax - cube.longMm) > longTol) {
          failures.push({ cube: cube.label, pairIdx: i, reason: `long_dim_off`,
            got: { expected: cube.longMm, actual: flatMax }});
        }
        if (Math.abs(flatMin - cube.shortMm) > shortTol) {
          failures.push({ cube: cube.label, pairIdx: i, reason: `short_dim_off`,
            got: { expected: cube.shortMm, actual: flatMin }});
        }
        if (unfold.bend_count !== 1) {
          failures.push({ cube: cube.label, pairIdx: i, reason: `bend_count_wrong`,
            got: { expected: 1, actual: unfold.bend_count }});
        }
        if (!(unfold.nominal_thickness_mm > 0.5 && unfold.nominal_thickness_mm < 3.0)) {
          failures.push({ cube: cube.label, pairIdx: i, reason: `thickness_out_of_range`,
            got: unfold.nominal_thickness_mm });
        }

        // Verify the bend line splits the rectangle in half along the long axis.
        // bend_lines are returned as NORMALISED coordinates (0..1) by
        // parseDxfBendLines in tools.ts, so the center is 0.5.
        if (Array.isArray(unfold.bend_lines) && unfold.bend_lines.length === 1) {
          const bl = unfold.bend_lines[0] as { x1: number; y1: number; x2: number; y2: number };
          const isVertical   = Math.abs(bl.x1 - bl.x2) < 0.02;
          const isHorizontal = Math.abs(bl.y1 - bl.y2) < 0.02;
          if (isVertical) {
            const offCentre = Math.abs(bl.x1 - 0.5);
            if (offCentre > 0.05) {
              failures.push({ cube: cube.label, pairIdx: i, reason: 'bend_not_central',
                got: { x_normalised: bl.x1, expected_normalised: 0.5 } });
            }
          } else if (isHorizontal) {
            const offCentre = Math.abs(bl.y1 - 0.5);
            if (offCentre > 0.05) {
              failures.push({ cube: cube.label, pairIdx: i, reason: 'bend_not_central',
                got: { y_normalised: bl.y1, expected_normalised: 0.5 } });
            }
          } else {
            failures.push({ cube: cube.label, pairIdx: i, reason: 'bend_not_axis_aligned',
              got: bl });
          }
        } else if (unfold.bend_count === 1) {
          failures.push({ cube: cube.label, pairIdx: i, reason: 'bend_line_missing_from_response' });
        }
      }
    }

    if (failures.length > 0) {
      console.log('[CASE 4] failures:', JSON.stringify(failures, null, 2));
    }
    expect(failures).toEqual([]);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 60_000);
});
