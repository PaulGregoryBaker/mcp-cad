import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { geometryBinding } from '../../src/geometry/binding';

describe('Advanced Sheet Metal Unfolding Integration Tests', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);

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

  it('apply_unfold and export_dxf produces layered DXF with CUT, BEND_UP/DOWN and text annotations', async () => {
    const fixturePath = getFixturePath('sheet_1panel.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    expect(clean.solid_id).toBeDefined();

    const decompose: any = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config);
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const txn: any = await dispatchTool('begin_transaction', { label: 'unfold_dxf_test' }, config);
    expect(txn.transaction_id).toBeDefined();

    const unfold: any = await dispatchTool('apply_unfold', {
      panel_id: decompose.panel_ids[0],
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id
    }, config);
    expect(unfold.unfold_id).toBeDefined();

    const dxf: any = geometryBinding.exportDxf(unfold.unfold_id);
    console.log(`[DEBUG sheet_1panel] DXF Content:\n${dxf.dxfContent}`);
    expect(dxf.dxfContent).toBeDefined();
    expect(dxf.wireCount).toBeGreaterThan(0);
    expect(dxf.bboxWidthMm).toBeGreaterThan(0);
    expect(dxf.bboxHeightMm).toBeGreaterThan(0);

    // Verify layer definitions exist in header section
    expect(dxf.dxfContent).toContain('CUT');
    expect(dxf.dxfContent).toContain('BEND_UP');
    expect(dxf.dxfContent).toContain('BEND_DOWN');

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
    for (let i = 1; i < outerPanelIds.length; i++) {
      try {
        const mergeResult: any = await dispatchTool('merge_bodies_with_bend', {
          part_a_id: panelA,
          part_b_id: outerPanelIds[i],
          target_edges: ['all'],
          bend_radius: 2.0,
          transaction_id: txn.transaction_id,
        }, config);
        if (mergeResult && mergeResult.merged_shell_id) {
          mergedShellId = mergeResult.merged_shell_id;
          break;
        }
      } catch (e) {
        // Ignored, try next pair
      }
    }

    expect(mergedShellId).toBeDefined();

    // Now unfold the merged shape
    const unfold: any = await dispatchTool('apply_unfold', {
      panel_id: mergedShellId,
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    expect(unfold.unfold_id).toBeDefined();
    
    // The flat size (width or height) should correspond to the sum of the two square sides (approx 200 + 200 = 400 mm)
    const maxDim = Math.max(unfold.flat_width_mm, unfold.flat_height_mm);
    const minDim = Math.min(unfold.flat_width_mm, unfold.flat_height_mm);

    console.log(`[DEBUG merge_unfold] flat_width_mm=${unfold.flat_width_mm}, flat_height_mm=${unfold.flat_height_mm}, bend_count=${unfold.bend_count}`);

    // Expect the combined unfolded flat size to be ~400x200 mm
    expect(Math.abs(maxDim - 400.0)).toBeLessThan(10.0);
    expect(Math.abs(minDim - 200.0)).toBeLessThan(10.0);

    // It should have exactly 1 bend line in the middle
    expect(unfold.bend_count).toBe(1);

    const dxf = geometryBinding.exportDxf(unfold.unfold_id);
    console.log(`[DEBUG merge_unfold] DXF Content:\n${dxf.dxfContent}`);

    // Parse the DXF content to extract LINE entities on BEND_UP/BEND_DOWN layers
    const dxfLines = dxf.dxfContent.split(/\r?\n/).map((l: string) => l.trim());
    const lines: Array<{ layer: string; x1: number; y1: number; x2: number; y2: number }> = [];

    for (let i = 0; i < dxfLines.length; i++) {
      if (dxfLines[i] === 'LINE') {
        let layer = '';
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        let j = i + 1;
        while (j < dxfLines.length && dxfLines[j] !== '0') {
          const code = dxfLines[j];
          const val = dxfLines[j + 1];
          if (code === '8') {
            layer = val!;
          } else if (code === '10') {
            x1 = parseFloat(val!);
          } else if (code === '20') {
            y1 = parseFloat(val!);
          } else if (code === '11') {
            x2 = parseFloat(val!);
          } else if (code === '21') {
            y2 = parseFloat(val!);
          }
          j += 2;
        }
        lines.push({ layer, x1, y1, x2, y2 });
      }
    }

    const bendLines = lines.filter(l => l.layer === 'BEND_UP' || l.layer === 'BEND_DOWN');
    
    // 1. Assert exactly 1 bend line exists
    expect(bendLines).toHaveLength(1);

    const bend = bendLines[0]!;
    
    // 2. Assert the bend line is vertical (X coordinates of the endpoints must be approximately equal)
    expect(Math.abs(bend.x1 - bend.x2)).toBeLessThan(1.0);

    // 3. Assert the bend line length is exactly ~200 mm (Y coordinates delta must be ~200 mm)
    const bendLength = Math.abs(bend.y1 - bend.y2);
    expect(Math.abs(bendLength - 200.0)).toBeLessThan(5.0);

    // 4. Test for area (should be close to panel 1 area + panel 2 area)
    const expectedPanel1Area = 200.0 * 200.0;
    const expectedPanel2Area = 200.0 * 200.0;
    const expectedTotalArea = expectedPanel1Area + expectedPanel2Area; // 80000 mm^2
    const actualTotalArea = unfold.flat_width_mm * unfold.flat_height_mm;
    
    // The total area should be within 5% of the sum of the individual panel areas
    expect(Math.abs(actualTotalArea - expectedTotalArea) / expectedTotalArea).toBeLessThan(0.05);

    // 5. Test that cut areas correspond to original panel areas and proportions
    // First, compute bounding box of the CUT boundary lines
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const line of lines) {
      if (line.layer === 'CUT') {
        minX = Math.min(minX, line.x1, line.x2);
        maxX = Math.max(maxX, line.x1, line.x2);
        minY = Math.min(minY, line.y1, line.y2);
        maxY = Math.max(maxY, line.y1, line.y2);
      }
    }

    const cutWidth = maxX - minX;
    const cutHeight = maxY - minY;

    // Verify CUT bounding box matches the reported flat width and height
    expect(Math.abs(cutWidth - unfold.flat_width_mm)).toBeLessThan(1.0);
    expect(Math.abs(cutHeight - unfold.flat_height_mm)).toBeLessThan(1.0);

    // The bend line splits the flat sheet into two rectangular parts: left of bend and right of bend
    const leftWidth = bend.x1 - minX;
    const rightWidth = maxX - bend.x1;

    const leftArea = leftWidth * cutHeight;
    const rightArea = rightWidth * cutHeight;

    // Verify individual cut sub-panel areas are close to original panel areas (200x200 = 40000)
    expect(Math.abs(leftArea - expectedPanel1Area) / expectedPanel1Area).toBeLessThan(0.05);
    expect(Math.abs(rightArea - expectedPanel2Area) / expectedPanel2Area).toBeLessThan(0.10); // slightly more tolerance for bend deduction side

    // Verify the proportions: the ratio of widths/areas should be close to 1.0 (since original panels are 1:1 ratio)
    const actualRatio = leftWidth / rightWidth;
    expect(Math.abs(actualRatio - 1.0)).toBeLessThan(0.05);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 20000);
});

