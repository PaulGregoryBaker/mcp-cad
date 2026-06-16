/**
 * Test to verify that apply_unfold returns dxf_content for canonical merged panels.
 *
 * User reported: apply_unfold for canonical merged panel returns unfold_id, bend_count,
 * graph_flat_width_mm, graph_flat_height_mm — but omits dxf_content from response.
 *
 * This test validates that dxf_content IS present in the response and contains valid DXF.
 *
 * Run: npm run test -- tests/integration/merge_unfold_dxf_content.test.ts
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
    } catch { /* best effort */ }
  }
});

describe('apply_unfold dxf_content for merged panels', () => {
  it('apply_unfold includes dxf_content in response for canonical merged panel', async () => {
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    // Split into two perpendicular panels
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    const [panelA, panelB] = split.panel_ids as [string, string];

    // Merge panels
    const txn: any = await dispatchTool('begin_transaction', { label: 'dxf_merge_test' }, config);

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 1.0,
      transaction_id: txn.transaction_id,
    }, config);

    expect(merged.merged_part_id).toBeDefined();
    expect(merged.merged_shell_id).toBeDefined();

    // Unfold the canonical merged panel
    const unfoldResult: any = await dispatchTool('apply_unfold', {
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,  // canonical panel
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    // Verify required fields
    expect(unfoldResult.unfold_id).toBeDefined();
    expect(unfoldResult.bend_count).toBe(1);
    expect(unfoldResult.graph_flat_width_mm).toBeGreaterThan(350);
    expect(unfoldResult.graph_flat_height_mm).toBeGreaterThan(150);

    // KEY VERIFICATION: dxf_content must be in response
    expect(unfoldResult).toHaveProperty('dxf_content');
    expect(typeof unfoldResult.dxf_content).toBe('string');
    expect(unfoldResult.dxf_content.length).toBeGreaterThan(0);

    // Verify dxf_content contains valid DXF format
    expect(unfoldResult.dxf_content).toContain('SECTION');
    expect(unfoldResult.dxf_content).toContain('ENDSEC');

    console.log(`✓ apply_unfold response includes dxf_content (${unfoldResult.dxf_content.length} bytes)`);
    console.log(`  Flat dimensions: ${unfoldResult.graph_flat_width_mm.toFixed(1)}×${unfoldResult.graph_flat_height_mm.toFixed(1)}mm`);
    console.log(`  Bends: ${unfoldResult.bend_count} with ${unfoldResult.bend_lines.length} bend lines`);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);
});
