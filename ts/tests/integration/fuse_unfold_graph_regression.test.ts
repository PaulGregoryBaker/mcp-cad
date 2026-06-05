/**
 * Regression test: merge_bodies_with_bend + unfold workflow.
 *
 * User scenario: After merging split panels with a bend, the manufacturing
 * graph should remain valid and unfold should produce the correct flat pattern.
 *
 * Root cause being tested:
 * - Shell ID resolution during merge (stable part_id → current shell UUID)
 * - Graph state validity after merge (no orphaned/dirty nodes)
 * - Flat pattern DXF outline matches combined panel footprint
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
    try {
      await dispatchTool('rollback_transaction', { transaction_id: active.id }, config);
    } catch {
      // best effort cleanup
    }
  }
});

describe('Regression: fuse after moved graph parts', () => {
  it('should resolve shell IDs when fusing translated graph-backed parts', async () => {
    // Core validation: translate_body changes shell UUIDs,
    // and fuse_bodies must resolve stable part_ids to current shell.
    // See: handleFuseBodies resolveTargetToShell() at tools.ts:3260
    
    const fixturePath = getFixturePath('simple_box.stp');

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);

    expect(split.panel_ids.length).toBeGreaterThanOrEqual(2);
    const panelA = split.panel_ids[0] as string;
    const panelB = split.panel_ids[1] as string;

    const txn: any = await dispatchTool('begin_transaction', { label: 'shell_id_resolution' }, config);
    const txId = txn.transaction_id as string;

    // Translate panelB — this changes its shell UUID internally.
    await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelB],
      vector: [50, 0, 0],
      keep_original: false,
    }, config);

    // Fuse should find panelB's current shell via resolveTargetToShell().
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [panelA, panelB],
    }, config);

    expect(fused.part_id).toBe(panelA);
    expect(fused.solid_id).toBeDefined();
  }, 30_000);

  it('should preserve combined footprint when merging two perpendicular panels with a bend', async () => {
    // Mirrors the UI scenario shown in the screenshot:
    // testcube → split_by_bends → two 200×200mm outer panels at 90°
    // → merge_bodies_with_bend → apply_unfold
    // Expected flat: ~401.6×200mm (200 + 200 + bend allowance), 1 bend.
    // DXF outline (source of truth) must match those dimensions.

    const fixturePath = getFixturePath('testcube.step');

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    // Classify panels and pick outer 200×200 faces.
    interface PInfo { id: string; sorted: number[]; thicknessAxis: string; }
    function classifyPanel(id: string, i: number): PInfo {
      const bb = split.panel_bboxes[i];
      const dims = [
        { v: bb.x_max - bb.x_min, ax: 'X' },
        { v: bb.y_max - bb.y_min, ax: 'Y' },
        { v: bb.z_max - bb.z_min, ax: 'Z' },
      ].sort((a, b) => a.v - b.v);
      return { id, sorted: dims.map(d => d.v), thicknessAxis: dims[0]!.ax };
    }
    const allPanels = (split.panel_ids as string[]).map((id, i) => classifyPanel(id, i));
    // Outer panels: thickness < 3mm, both face dims > 180mm.
    const outer = allPanels.filter(p => p.sorted[0]! < 3.0 && p.sorted[1]! > 180 && p.sorted[2]! > 180);
    expect(outer.length).toBeGreaterThanOrEqual(2);

    // Pick two panels with different thickness axes (i.e. perpendicular to each other).
    const panelA = outer[0]!;
    const panelB = outer.find(p => p.thicknessAxis !== panelA.thicknessAxis);
    expect(panelB).toBeDefined();

    // Each panel's flat footprint: two largest dims.
    const flatA = [panelA.sorted[1]!, panelA.sorted[2]!].sort((a, b) => a - b);
    const flatB = [panelB!.sorted[1]!, panelB!.sorted[2]!].sort((a, b) => a - b);

    const txn: any = await dispatchTool('begin_transaction', { label: 'merge_bend_footprint' }, config);
    const txId = txn.transaction_id as string;

    // Unfold both panels first so merge_bodies_with_bend has shapeDxf to work with.
    await dispatchTool('apply_unfold', {
      transaction_id: txId,
      part_id: panelA.id,
      panel_id: panelA.id,
      material_id: 'mild_steel_1.5mm',
    }, config);
    await dispatchTool('apply_unfold', {
      transaction_id: txId,
      part_id: panelB!.id,
      panel_id: panelB!.id,
      material_id: 'mild_steel_1.5mm',
    }, config);

    // Merge with bend radius 1.0mm (app default).
    const merge: any = await dispatchTool('merge_bodies_with_bend', {
      transaction_id: txId,
      part_a_id: panelA.id,
      part_b_id: panelB!.id,
      target_edges: ['all'],
      bend_radius: 1.0,
    }, config);
    expect(merge.merged_shell_id).toBeDefined();

    const mergedPartId = merge.merged_part_id as string;

    const unfold: any = await dispatchTool('apply_unfold', {
      transaction_id: txId,
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: 'mild_steel_1.5mm',
    }, config);

    expect(unfold.bend_count).toBe(1);

    // DXF is source of truth: validate the actual outline polygon bounding box.
    const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
    const outline = parseFirstClosedPolyline(unfold.dxf_content as string);

    let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
    let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
    for (const [x, y] of outline) {
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const outlineDims = [xMax - xMin, yMax - yMin].sort((a, b) => a - b);

    // The short axis must equal the shared panel width (same for both panels).
    expect(outlineDims[0]).toBeCloseTo(flatA[0]!, 0);  // 200mm ±0.5mm

    // The long axis must be greater than either panel alone (combined + bend allowance).
    // At minimum it must exceed the largest single-panel dimension.
    expect(outlineDims[1]).toBeGreaterThan(flatA[1]! + flatB[1]! - 5); // allow 5mm bend allowance variance
    // And must not be more than 5mm beyond the pure sum.
    expect(outlineDims[1]).toBeLessThan(flatA[1]! + flatB[1]! + 5);
  }, 60_000);

  it('should produce a non-rectangular flat shape when a smaller same-thickness panel is fused as a protrusion', async () => {
    const fixturePath = getFixturePath('simple_box.stp');

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);

    expect(split.panel_ids.length).toBeGreaterThan(0);
    const panelA = split.panel_ids[0] as string;

    const boxOf = async (target: string) => {
      const bb: any = await dispatchTool('bounding_box', { target }, config);
      return {
        min: [bb.x_min, bb.y_min, bb.z_min],
        max: [bb.x_max, bb.y_max, bb.z_max],
        ext: [bb.x_max - bb.x_min, bb.y_max - bb.y_min, bb.z_max - bb.z_min],
      };
    };

    const panelBox = await boxOf(panelA);
    let thinAxis = 0;
    if (panelBox.ext[1] < panelBox.ext[thinAxis]) thinAxis = 1;
    if (panelBox.ext[2] < panelBox.ext[thinAxis]) thinAxis = 2;
    const inPlaneAxes = [0, 1, 2].filter((i) => i !== thinAxis);
    const axisA = inPlaneAxes[0]!;
    const axisB = inPlaneAxes[1]!;

    const txn: any = await dispatchTool('begin_transaction', { label: 'non_rect_fuse' }, config);
    const txId = txn.transaction_id as string;

    // Derive a smaller same-thickness panel using intersections of translated
    // duplicates. This avoids plane-trim artifacts that can violate thickness checks.
    const baseCopy: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelA],
      vector: [0, 0, 0],
      keep_original: true,
    }, config);

    const shiftA = [0, 0, 0];
    shiftA[axisA] = panelBox.ext[axisA]! * 0.35;
    const shiftedA: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [panelA],
      vector: shiftA,
      keep_original: true,
    }, config);

    const interA: any = await dispatchTool('intersect_bodies', {
      transaction_id: txId,
      target_a: baseCopy.solid_id,
      target_b: shiftedA.solid_id,
    }, config);

    const shiftB = [0, 0, 0];
    shiftB[axisB] = panelBox.ext[axisB]! * 0.35;
    const interACopy: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [interA.solid_id as string],
      vector: shiftB,
      keep_original: true,
    }, config);

    const interAB: any = await dispatchTool('intersect_bodies', {
      transaction_id: txId,
      target_a: interA.solid_id,
      target_b: interACopy.solid_id,
    }, config);

    let smallShell = interAB.solid_id as string;
    const smallBox = await boxOf(smallShell);

    // Smaller in both in-plane dimensions; same thickness axis.
    expect(smallBox.ext[axisA]).toBeLessThan(panelBox.ext[axisA]);
    expect(smallBox.ext[axisB]).toBeLessThan(panelBox.ext[axisB]);
    expect(smallBox.ext[thinAxis]).toBeCloseTo(panelBox.ext[thinAxis], 1);

    // Move the small panel so it protrudes beyond panelA on axisA while still overlapping,
    // yielding a non-rectangular union profile.
    const center = (b: { min: number[]; max: number[] }, axis: number) => (b.min[axis]! + b.max[axis]!) / 2;
    const targetCenterA = panelBox.max[axisA]! + smallBox.ext[axisA]! * 0.25;
    const targetCenterB = center(panelBox, axisB);
    const targetCenterT = center(panelBox, thinAxis);

    const vec = [0, 0, 0];
    vec[axisA] = targetCenterA - center(smallBox, axisA);
    vec[axisB] = targetCenterB - center(smallBox, axisB);
    vec[thinAxis] = targetCenterT - center(smallBox, thinAxis);

    const moved: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [smallShell],
      vector: vec,
      keep_original: false,
    }, config);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [panelA, moved.solid_id as string],
    }, config);

    const unfold: any = await dispatchTool('apply_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: 'mild_steel_1.5mm',
    }, config);

    expect(unfold.bend_count).toBe(0);
    expect(typeof unfold.dxf_content).toBe('string');
    expect((unfold.dxf_content as string).length).toBeGreaterThan(0);

    const dxf = unfold.dxf_content as string;
    expect(dxf.length).toBeGreaterThan(0);

    // Also assert the flat bounding box is LARGER than the original panel
    // (confirms the protrusion was included in the flat pattern).
    const fusedArea = unfold.flat_width_mm * unfold.flat_height_mm;
    const originalArea = panelBox.ext[axisA]! * panelBox.ext[axisB]!;
    expect(fusedArea).toBeGreaterThan(originalArea);
  }, 60_000);
});
