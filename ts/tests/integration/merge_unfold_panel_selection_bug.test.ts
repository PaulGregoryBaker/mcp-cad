/**
 * Reproduction test for merge_bodies_with_bend → apply_unfold panel selection bug.
 *
 * This test demonstrates:
 * 1. BROKEN: apply_unfold with wrong panel ID (stale panel A node)
 *    → returns flat pattern for panel A only, zero bends
 * 2. CORRECT: apply_unfold with canonical merged panel ID
 *    → returns combined flat pattern, one bend
 *
 * The bug occurs when UI selects a non-canonical panel node after querying
 * the post-merge manufacturing graph.
 *
 * Run: npm run test -- tests/integration/merge_unfold_panel_selection_bug.test.ts
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

describe('Bug: merge_unfold panel selection (MCP team)', () => {
  it('DEMONSTRATES BUG FIX: apply_unfold NOW REJECTS stale panel A with clear error message', async () => {
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    // 1. Split into panels
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    const [panelA, panelB] = split.panel_ids as [string, string];

    // 2. Merge panels A + B
    const txn: any = await dispatchTool('begin_transaction', { label: 'panel_bug_fix' }, config);

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 0.3,
      transaction_id: txn.transaction_id,
    }, config);

    expect(merged.merged_part_id).toBe(panelA);  // stable
    expect(merged.merged_shell_id).toBeDefined();

    // 3. Query the merged graph
    const graphQuery: any = await dispatchTool('query_graph', {
      part_id: merged.merged_part_id,
    }, config);

    // The graph has panel nodes after merge, including canonical aliases for
    // preserved and consumed part IDs.
    const panelNodes = graphQuery.nodes.filter((n: any) => n.type === 'PanelNode');
    expect(panelNodes.length).toBeGreaterThanOrEqual(2);

    console.log(`[BUG FIX] Post-merge graph has ${panelNodes.length} PanelNodes:`, 
      panelNodes.map((n: any) => ({ id: n.id, canonical: n.canonical })));

    // Verify canonical flag is set correctly
    const nonCanonicalNode = panelNodes.find((n: any) => n.canonical === false);
    const canonicalNodes = panelNodes.filter((n: any) => n.canonical === true);
    const canonicalNode = canonicalNodes.find((n: any) => n.id === merged.merged_part_id) ?? canonicalNodes[0];
    
    expect(nonCanonicalNode).toBeDefined();
    expect(canonicalNode).toBeDefined();
    expect(canonicalNode!.id).toBe(merged.merged_part_id);
    expect(canonicalNodes.some((n: any) => n.id === panelB)).toBe(true);

    // 4. TRY TO UNFOLD WITH WRONG PANEL: Now it should REJECT with clear error
    const wrongPanelNode = nonCanonicalNode!;
    console.log(`[BUG FIX] Attempting unfold with NON-CANONICAL panel: id=${wrongPanelNode.id} (canonical=${wrongPanelNode.canonical})`);

    let unfoldError: any;
    try {
      await dispatchTool('apply_unfold', {
        part_id: merged.merged_part_id,
        panel_id: wrongPanelNode.id,  // ← Non-canonical panel
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id,
      }, config);
      // Should not reach here
      throw new Error('apply_unfold should have rejected the non-canonical panel');
    } catch (e) {
      unfoldError = e as { code?: string; message?: string };
    }

    // Verify the error is clear and actionable
    expect(unfoldError).toBeDefined();
    expect(unfoldError.code).toMatch(/GRAPH|INTEGRITY/);
    expect(unfoldError.message).toMatch(/non-canonical|upstream panel|merged/i);
    console.log(`[BUG FIX] ✓ Correctly rejected: ${unfoldError.message}`);

    // 5. UNFOLD WITH CANONICAL PANEL: Should succeed
    const unfoldCorrect: any = await dispatchTool('apply_unfold', {
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,  // ← Canonical merged node
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    expect(unfoldCorrect.bend_count).toBe(1);
    expect(unfoldCorrect.flat_width_mm).toBeGreaterThan(350);
    console.log(`[BUG FIX] ✓ Canonical panel unfolds correctly: ${unfoldCorrect.flat_width_mm.toFixed(1)}×${unfoldCorrect.flat_height_mm.toFixed(1)}mm, bends=${unfoldCorrect.bend_count}`);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);

  it('CORRECT BEHAVIOR: apply_unfold with canonical merged_part_id produces combined geometry', async () => {
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    const [panelA, panelB] = split.panel_ids as [string, string];

    const txn: any = await dispatchTool('begin_transaction', { label: 'panel_correct' }, config);

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 0.3,
      transaction_id: txn.transaction_id,
    }, config);

    // CORRECT: use merged_part_id for both part_id and panel_id
    const unfoldCorrect: any = await dispatchTool('apply_unfold', {
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,  // ← CORRECT: canonical merged node
      material_id: config.materials[0]!.id,
      transaction_id: txn.transaction_id,
    }, config);

    const maxDimCorrect = Math.max(unfoldCorrect.flat_width_mm, unfoldCorrect.flat_height_mm);
    const minDimCorrect = Math.min(unfoldCorrect.flat_width_mm, unfoldCorrect.flat_height_mm);

    console.log(`[CORRECT] flat=${unfoldCorrect.flat_width_mm}×${unfoldCorrect.flat_height_mm}mm ` +
      `bends=${unfoldCorrect.bend_count} thickness=${unfoldCorrect.nominal_thickness_mm}`);

    // CORRECT: combined dimensions for two perpendicular panels
    expect(maxDimCorrect).toBeGreaterThan(350);  // ✓ combined length
    expect(minDimCorrect).toBeGreaterThan(150);  // ✓ combined width
    expect(unfoldCorrect.bend_count).toBe(1);   // ✓ one seam
    expect(unfoldCorrect.nominal_thickness_mm).toBeGreaterThan(0.5);
    expect(Array.isArray(unfoldCorrect.bend_lines)).toBe(true);
    expect(unfoldCorrect.bend_lines.length).toBe(1);

    console.log('[CORRECT] ✓ Canonical panel_id produces correct merged geometry');

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);

  it('ACCEPTANCE: query_graph post-merge clearly identifies canonical unfold target', async () => {
    const fixturePath = getFixturePath('testcube.step');
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 2.0,
      max_recursion_depth: 2,
    }, config);

    const [panelA, panelB] = split.panel_ids as [string, string];

    const txn: any = await dispatchTool('begin_transaction', { label: 'panel_canonical' }, config);

    const merged: any = await dispatchTool('merge_bodies_with_bend', {
      part_a_id: panelA,
      part_b_id: panelB,
      target_edges: ['all'],
      bend_radius: 0.3,
      transaction_id: txn.transaction_id,
    }, config);

    const graphQuery: any = await dispatchTool('query_graph', {
      part_id: merged.merged_part_id,
    }, config);

    const panelNodes = graphQuery.nodes.filter((n: any) => n.type === 'PanelNode');

    // ACCEPTANCE: After fix, either:
    // 1. Canonical node has a canonical: true flag, OR
    // 2. Non-canonical nodes are removed from the graph, OR
    // 3. Error message from apply_unfold is clear about which ID to use

    // For now, we verify the correct behavior: using merged_part_id works
    const canonicalPanelId = merged.merged_part_id;
    const hasCanonical = panelNodes.some((n: any) => n.id === canonicalPanelId);
    expect(hasCanonical).toBe(true, 'merged_part_id should resolve to a PanelNode in query_graph');

    console.log(`[ACCEPTANCE] merged_part_id=${merged.merged_part_id} maps to PanelNode in graph`);

    // After fix: canonical node should be clearly marked or only node present
    const canonicalNode = panelNodes.find((n: any) => n.id === canonicalPanelId);
    console.log(`[ACCEPTANCE] Canonical node:`, {
      id: canonicalNode?.id,
      bodyId: canonicalNode?.bodyId,
      canonical: (canonicalNode as any)?.canonical,  // ← Expected after fix
    });

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 30_000);
});
