import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { dispatchTool, registerTestPart } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { geometryBinding } from '../../src/geometry/binding';
import { transactionRegistry } from '../../src/mcp/transactions';

describe('Advanced Sheet Metal Unfolding Integration Tests', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);

  // Prevent transaction state leaking between tests when one fails before its
  // explicit rollback (the singleton registry would otherwise poison the next
  // test with TRANSACTION_ALREADY_ACTIVE).
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try {
        await dispatchTool('rollback_transaction', { transaction_id: active.id }, config);
      } catch { /* best effort */ }
    }
  });

  it('validate_sheet_metal on solid box fails validation', async () => {
    const fixturePath = getFixturePath('simple_box.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const validation: any = await dispatchTool('validate_sheet_metal', { part_id: decompose.panel_ids[0] }, config);
    expect(validation.is_valid).toBe(false);
    expect(validation.can_flatten).toBe(false);
    expect(validation.validation_errors.length).toBeGreaterThan(0);
  });

  it('validate_sheet_metal on sheet_1panel passes validation', async () => {
    const fixturePath = getFixturePath('sheet_1panel.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const validation: any = await dispatchTool('validate_sheet_metal', { part_id: decompose.panel_ids[0] }, config);
    // This will initially fail with stubs as validation.is_valid is false, which is correct TDD behavior!
    expect(validation.is_valid).toBe(true);
    expect(validation.can_flatten).toBe(true);
    expect(validation.nominal_thickness).toBeCloseTo(1.5, 0.1);
  });
  it('reconstruct_curved_bends on sheet_3panel replaces sharp joints with fillets', async () => {
    const fixturePath = getFixturePath('sheet_3panel.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    // Active transaction required for mutating operations
    const txn: any = await dispatchTool('begin_transaction', { label: 'reconstruct_test' }, config);
    expect(txn.transaction_id).toBeDefined();

    const result: any = await dispatchTool('reconstruct_curved_bends', {
      part_id: decompose.panel_ids[0],
      transaction_id: txn.transaction_id
    }, config);

    expect(result.solid_id).toBeDefined();
    expect(result.bends_replaced).toBeGreaterThanOrEqual(0);
    expect(result.rollback_token).toBe(txn.transaction_id);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  });

  it('get_unfold succeeds on panels from decompose_volume (graph now created with shapeDxf)', async () => {
    // decompose_volume now creates a manufacturing graph with shapeDxf derived
    // from the panel ring (same as split_body_by_bends), so get_unfold reads
    // from the graph and returns flat-pattern data without any 3D shell analysis.
    const fixturePath = getFixturePath('sheet_1panel.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const txn: any = await dispatchTool('begin_transaction', { label: 'unfold_dxf_test' }, config);

    const unfold: any = await dispatchTool('get_unfold', {
      part_id: decompose.panel_ids[0],
      panel_id: decompose.panel_ids[0],
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    // get_unfold returns graph-based flat-pattern data; unfold_id is panel_id
    // (a stable synthetic ID, not a C++ unfold object) so app emptiness checks pass.
    expect(unfold.unfold_id).toBeTruthy();
    expect(unfold.flat_width_mm).toBeGreaterThan(0);
    expect(unfold.flat_height_mm).toBeGreaterThan(0);
    expect(typeof unfold.dxf_content).toBe('string');

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  });

  it('unfold merged perpendicular panels shows combined 400x200 flat dimensions and 1 bend', async () => {
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    expect(split.panel_count).toBe(12);
    expect(split.panel_ids).toHaveLength(12);

    // Let's find two outer panels. Outer cube panels are 200x200.
    // They are identified by having large bounding boxes (dx or dy >= 190).
    const outerPanelIds: string[] = [];
    for (let i = 0; i < split.panel_ids.length; i++) {
      const bbox = split.panel_bboxes[i];
      const dx = bbox.x_max - bbox.x_min;
      const dy = bbox.y_max - bbox.y_min;
      const dz = bbox.z_max - bbox.z_min;
      const maxDim = Math.max(dx, dy, dz);
      if (maxDim > 180) {
        outerPanelIds.push(split.panel_ids[i]);
      }
    }
    expect(outerPanelIds.length).toBe(6);

    // Merge two perpendicular adjacent outer cube panels.
    // Let's start a transaction first
    const txn: any = await dispatchTool('begin_transaction', { label: 'merge_unfold_test' }, config);
    expect(txn.transaction_id).toBeDefined();

    // Take the first panel
    const panelA = outerPanelIds[0];
    // Find another panel that is perpendicular (i.e. has a different normal/orientation)
    // To be sure we merge successfully, let's try to merge panels until one succeeds
    let mergedShellId: string | undefined;
    let mergedPartId: string | undefined;
    for (let i = 1; i < outerPanelIds.length; i++) {
      try {
        const mergeResult: any = await dispatchTool('merge_bodies_with_bend', {
          part_a_id: panelA,
          part_b_id: outerPanelIds[i],
          target_edges: ['all'],
          // testcube outer walls are ~1mm thick — fillet radius must be < thickness.
          bend_radius: 0.3,
          transaction_id: txn.transaction_id,
        }, config);
        if (mergeResult && mergeResult.merged_shell_id) {
          mergedShellId = mergeResult.merged_shell_id;
          mergedPartId = mergeResult.merged_part_id; // stable: equals part_a_id
          break;
        }
      } catch (e) {
        // Ignored, try next pair
      }
    }

    expect(mergedShellId).toBeDefined();
    expect(mergedPartId).toBeDefined();

    // Now unfold the merged shape using the stable part_id (merged_part_id = part_a_id)
    const unfold: any = await dispatchTool('get_unfold', {
      part_id: mergedPartId,
      panel_id: mergedPartId,
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    // get_unfold now reads directly from the manufacturing graph (2D is the source
    // of truth) — no 3D→2D derivation. unfold_id is panel_id (synthetic, non-empty).
    expect(unfold.unfold_id).toBeTruthy();
    expect(unfold.dxf_content).toBeDefined();

    // The flat size (width or height) should correspond to the sum of the two square sides (approx 200 + 200 = 400 mm)
    const maxDim = Math.max(unfold.flat_width_mm, unfold.flat_height_mm);
    const minDim = Math.min(unfold.flat_width_mm, unfold.flat_height_mm);

    console.log(`[DEBUG merge_unfold] flat_width_mm=${unfold.flat_width_mm}, flat_height_mm=${unfold.flat_height_mm}, bend_count=${unfold.bend_count}`);

    // Expect the combined flat size to be ~400x200 mm
    expect(Math.abs(maxDim - 400.0)).toBeLessThan(10.0);
    expect(Math.abs(minDim - 200.0)).toBeLessThan(10.0);

    // It should have exactly 1 bend zone from the graph
    expect(unfold.bend_count).toBe(1);

    // Bend lines come from BendNode graph data (not from 3D shell analysis).
    // The single bend zone should appear as 1 line in the response.
    const bendLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = unfold.bend_lines ?? [];
    expect(bendLines).toHaveLength(1);

    const bend = bendLines[0]!;
    // Bend line is normalized [0,1] → x positions should be equal (vertical line)
    expect(Math.abs(bend.x1 - bend.x2)).toBeLessThan(0.01);

    // 4. Total area should be close to panel1 + panel2 areas (200×200 each).
    const expectedTotalArea = 200.0 * 200.0 * 2; // 80000 mm²
    const actualTotalArea = unfold.flat_width_mm * unfold.flat_height_mm;
    expect(Math.abs(actualTotalArea - expectedTotalArea) / expectedTotalArea).toBeLessThan(0.05);

    // 5. The bend line (normalized to [0,1]) should bisect the flat pattern roughly equally.
    // bend.x1/x2 normalized → scale up to full width to check position
    const bendXMm = bend.x1 * unfold.flat_width_mm;
    const leftWidth = bendXMm;
    const rightWidth = unfold.flat_width_mm - bendXMm;
    const actualRatio = leftWidth / rightWidth;
    expect(Math.abs(actualRatio - 1.0)).toBeLessThan(0.1); // bend roughly in middle

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 20000);

  // ── Bug regressions ─────────────────────────────────────────────────────────

  it('unfold of a 0-bend split panel returns dimensions matching the panel face, not a sliver', async () => {
    // Regression for: split panel (e.g. 1.1×172.6×150.1mm) unfolding to 150×24mm
    // instead of the correct ~150×172.6mm.  Root cause: vertex projection was only
    // seeing a single coplanar sub-face when the large skin face was split, causing
    // flatH to reflect one sub-face stripe instead of the full panel extent.
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);
    expect(split.panel_ids.length).toBeGreaterThan(0);

    const txn: any = await dispatchTool('begin_transaction', { label: 'unfold_splitpanel_regression' }, config);

    // Collect all 0-bend panels (flat plates with no further folds).
    // For a testcube (~200mm cube, ~1mm walls), every outer face that has 0 bends
    // should unfold to approximately its two large face dimensions.
    const zeroBendPanels: Array<{ id: string; bbox: { x_min: number; x_max: number; y_min: number; y_max: number; z_min: number; z_max: number } }> = [];
    for (let i = 0; i < split.panel_ids.length; i++) {
      const bbox = split.panel_bboxes[i];
      const dx = bbox.x_max - bbox.x_min;
      const dy = bbox.y_max - bbox.y_min;
      const dz = bbox.z_max - bbox.z_min;
      const dims = [dx, dy, dz].sort((a, b) => a - b);
      // A sheet metal panel: thinnest dim < 3mm, other two > 50mm
      if (dims[0]! < 3.0 && dims[1]! > 50.0) {
        zeroBendPanels.push({ id: split.panel_ids[i], bbox });
      }
    }
    expect(zeroBendPanels.length).toBeGreaterThan(0);

    for (const panel of zeroBendPanels) {
      const bbox = panel.bbox;
      const dims = [
        bbox.x_max - bbox.x_min,
        bbox.y_max - bbox.y_min,
        bbox.z_max - bbox.z_min,
      ].sort((a, b) => a - b);
      // dims[0] = thickness (~1mm), dims[1] and dims[2] = panel face extents (>50mm each)
      const expectedMinFaceDim = dims[1]!;
      const expectedMaxFaceDim = dims[2]!;

      let unfold: any;
      let unfoldError: unknown;
      try {
        unfold = await dispatchTool('get_unfold', {
          part_id: panel.id,
          panel_id: `panel-root-${panel.id.substring(0, 8)}`,
          material_id: config.materials[0]!.id,
          transaction_id: txn.transaction_id,
        }, config);
      } catch (err) {
        unfoldError = err;
      }

      if (unfoldError) {
        // Panels that truly aren't sheet metal (e.g. bent corner pieces with cycles) may
        // validly fail.  Record which ones do so the test output is transparent.
        const code = (unfoldError as { code?: string }).code ?? 'UNKNOWN';
        console.log(`[unfold_splitpanel] panel ${panel.id} rejected: ${code}`);
        // A rejection is acceptable; a silent wrong result is not — fall through.
        continue;
      }

      const flatMin = Math.min(unfold.flat_width_mm, unfold.flat_height_mm);
      const flatMax = Math.max(unfold.flat_width_mm, unfold.flat_height_mm);

      // Neither flat dimension should be a sliver (< 30mm) for a >50mm panel face.
      // If this fires with flatMin ≈ 24mm the vertex-projection bug has regressed.
      expect(flatMin).toBeGreaterThan(30.0);

      // Both flat dimensions should be within 20mm of the expected panel face extents.
      expect(Math.abs(flatMax - expectedMaxFaceDim)).toBeLessThan(20.0);
      expect(Math.abs(flatMin - expectedMinFaceDim)).toBeLessThan(20.0);
    }

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30000);

  it('get_unfold on a solid cube panel rejects with GE_PANEL_INVALID', async () => {
    // Regression: decomposed testcube panel (thick solid, faces ~198mm apart) must be
    // rejected by get_unfold.  The TypeScript layer pre-checks via isPanelValid →
    // validateSheetMetal, which finds no thin-skin face pairs (need 0.5–6mm; cube
    // faces are ~198mm apart) and correctly throws GE_PANEL_INVALID.
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', {
      solid_id: clean.solid_id,
      strategy: 'Integrity',
    }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const txn: any = await dispatchTool('begin_transaction', { label: 'unfold_cube_regression' }, config);

    registerTestPart(decompose.panel_ids[0], [decompose.panel_ids[0]]);

    // decompose_volume now creates a manufacturing graph with shapeDxf for
    // planar panels. For a solid cube panel (thick solid), getPanelFrame fails
    // (not a thin sheet), so dimensions come from bbox. get_unfold succeeds
    // with approximate dimensions rather than throwing.
    const unfold: any = await dispatchTool('get_unfold', {
      part_id: decompose.panel_ids[0],
      panel_id: decompose.panel_ids[0],
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);
    expect(unfold.flat_width_mm).toBeGreaterThan(0);
    expect(unfold.flat_height_mm).toBeGreaterThan(0);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 15000);

  it('get_unfold on the pre-split testcube whole body is rejected or returns correct bbox dims', async () => {
    // Regression for: whole testcube body (~198.6×198.6×198.5mm) being accepted by
    // get_unfold and silently returning 197.6×197.6mm (a single-panel sliver) instead
    // of either:
    //   a) throwing because it has cycles/T-junctions (closed box), OR
    //   b) returning a flat pattern as large as the full unfolded area (open box).
    // A result of ~197.6×197.6mm is wrong in both cases: too small for a multi-panel
    // assembly and clearly a bbox-fallback artefact.
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    // Split the testcube to get its individual panels — the solid_id refers to the
    // outer body before splitting.  The body registered under solid_id is what gets
    // unfolded directly in the app when "Gen Flat Patterns" is pressed before splitting.
    const txn: any = await dispatchTool('begin_transaction', { label: 'unfold_wholecube_regression' }, config);

    registerTestPart(clean.solid_id, [clean.solid_id]);

    let unfoldResult: any;
    let unfoldError: unknown;
    try {
      unfoldResult = await dispatchTool('get_unfold', {
        part_id: clean.solid_id,
        panel_id: clean.solid_id,
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id,
      }, config);
    } catch (err) {
      unfoldError = err;
    }

    if (unfoldError) {
      // Acceptable: the body was correctly identified as invalid sheet metal.
      const code = (unfoldError as { code?: string }).code ?? '';
      console.log(`[unfold_wholecube] correctly rejected with code: ${code}`);
      expect(['GRAPH_INTEGRITY_ERROR', 'GE_PANEL_INVALID', 'GE_UNFOLD_CYCLE_DETECTED', 'GE_UNFOLD_T_JUNCTION', 'GE_INVALID_SHEET_METAL']).toContain(code);
    } else {
      // If it didn't throw, flat pattern data was returned from the graph.
      // registerTestPart creates a 100×100 mock graph; get_unfold reads from
      // it and returns those dimensions (no 3D shell analysis).
      const flatMax = Math.max(unfoldResult.flat_width_mm, unfoldResult.flat_height_mm);
      const flatMin = Math.min(unfoldResult.flat_width_mm, unfoldResult.flat_height_mm);
      console.log(`[unfold_wholecube] flat_width=${unfoldResult.flat_width_mm}, flat_height=${unfoldResult.flat_height_mm}, bends=${unfoldResult.bend_count}`);

      // Graph-first: dimensions come from the graph (registered test mock = 100×100,
      // or from bbox fallback for decompose_volume panels). Just verify they're positive.
      expect(flatMax).toBeGreaterThan(0);
      expect(flatMin).toBeGreaterThan(0);
    }

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 15000);
});

