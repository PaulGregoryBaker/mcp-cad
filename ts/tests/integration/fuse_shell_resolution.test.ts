/**
 * Regression test: fuse_bodies correctly resolves shell IDs after translate_body.
 *
 * Bug: After translate_body changes the shell ID, fuse_bodies couldn't find
 * the geometry because it was trying to use the stable part IDs directly
 * without resolving them to current shell IDs.
 *
 * Fix: handleFuseBodies now calls resolveTargetToShell for each tool
 * to map stable part IDs to their current shell IDs.
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

describe('Regression: fuse_bodies after translate_body', () => {
  it('should resolve shell IDs correctly when fusing translated graph-backed parts', async () => {
    const boxPath = getFixturePath('simple_box.stp');

    // Create graph-backed parts by splitting, not just cleaning
    const clean1: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split1: any = await dispatchTool('split_body_by_bends', {
      part_id: clean1.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);

    expect(split1.panel_ids.length).toBeGreaterThanOrEqual(1);
    const part1 = split1.panel_ids[0];

    const clean2: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split2: any = await dispatchTool('split_body_by_bends', {
      part_id: clean2.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);

    expect(split2.panel_ids.length).toBeGreaterThanOrEqual(1);
    const part2 = split2.panel_ids[0];

    const txn: any = await dispatchTool('begin_transaction', { label: 'translate_fuse_regression' }, config);
    const txId = txn.transaction_id as string;

    // Translate both parts so they overlap
    await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [part1],
      vector: [25, 0, 0],
      keep_original: false,
    }, config);

    const trans2: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [part2],
      vector: [-25, 0, 0],
      keep_original: false,
    }, config);

    expect(trans2.solid_id).toBeDefined();

    // This fuse used to fail with GE_SHELL_NOT_FOUND because:
    // 1. translate_body registered the new shell ID in the geometry session
    // 2. fuse_bodies passed the stable part IDs (part1, part2) directly to geometry binding
    // 3. geometry binding couldn't find them because the actual shells had different IDs
    //
    // The fix: handleFuseBodies now resolves part IDs to their current shell IDs
    // via resolveTargetToShell before calling geometry binding's fuseBodies.
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [part1, part2],
    }, config);

    expect(fused.part_id).toBe(part1);
    expect(fused.preserved_part_id).toBe(part1);
    expect(fused.solid_id).toBeDefined();
  }, 30_000);

  it('should handle multiple translated parts in fuse', async () => {
    const boxPath = getFixturePath('simple_box.stp');

    // Create three graph-backed parts
    const clean1: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split1: any = await dispatchTool('split_body_by_bends', {
      part_id: clean1.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    const part1 = split1.panel_ids[0];

    const clean2: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split2: any = await dispatchTool('split_body_by_bends', {
      part_id: clean2.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    const part2 = split2.panel_ids[0];

    const clean3: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split3: any = await dispatchTool('split_body_by_bends', {
      part_id: clean3.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    const part3 = split3.panel_ids[0];

    const txn: any = await dispatchTool('begin_transaction', { label: 'multi_translate_fuse' }, config);
    const txId = txn.transaction_id as string;

    // Translate all parts to overlapping positions
    await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [part2],
      vector: [25, 0, 0],
      keep_original: false,
    }, config);

    await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [part3],
      vector: [-25, 0, 0],
      keep_original: false,
    }, config);

    // Fuse all three. The first part (part1) is preserved.
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [part1, part2, part3],
    }, config);

    expect(fused.part_id).toBe(part1);
    expect(fused.solid_id).toBeDefined();
  }, 30_000);
});

describe('T016: cut_bodies GRAPH_INTEGRITY_ERROR guard (FR-005)', () => {
  it('rejects cut_bodies when blank is a graph-tracked panel', async () => {
    const boxPath = getFixturePath('simple_box.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_ids.length).toBeGreaterThanOrEqual(1);
    const trackedPanelId = split.panel_ids[0] as string;

    // The panel ID IS the bodyId for split panels (stable part-id = initial shell-id).
    await expect(
      dispatchTool('cut_bodies', {
        blank: trackedPanelId,
        tools: ['some-untracked-shell'],
        keep_tools: false,
      }, config),
    ).rejects.toMatchObject({ code: 'GRAPH_INTEGRITY_ERROR' });
  }, 30_000);

  it('allows cut_bodies when blank is not graph-tracked', async () => {
    // A raw clean_geometry result (before split_by_bends) is not graph-tracked.
    const boxPath = getFixturePath('simple_box.stp');
    const clean: any = await dispatchTool('clean_geometry', { file_path: boxPath }, config);

    // clean.solid_id is a raw shell — not in any manufacturing graph.
    // cut_bodies should reach the C++ call and either succeed or fail with a geometry error,
    // but NOT with GRAPH_INTEGRITY_ERROR.
    try {
      await dispatchTool('cut_bodies', {
        blank: clean.solid_id,
        tools: [clean.solid_id],  // self-cut → geometry error, but not GRAPH_INTEGRITY_ERROR
        keep_tools: false,
      }, config);
    } catch (err: any) {
      expect(err.code).not.toBe('GRAPH_INTEGRITY_ERROR');
    }
  }, 30_000);
});
