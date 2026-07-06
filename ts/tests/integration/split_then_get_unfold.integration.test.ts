// @ts-nocheck
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(name: string) {
  const p = path.resolve(__dirname, '../../../cpp/tests/fixtures', name);
  return fs.existsSync(p) ? p : null;
}

describe('split_body_by_bends then get_unfold', () => {
  it('can call get_unfold immediately on a panel from split_body_by_bends (testcube)', async () => {
    const fp = findFixture('testcube.step');
    if (!fp) { console.warn('missing'); return; }
    const clean: any = await dispatchTool('clean_geometry', { file_path: fp }, config);
    const txn: any = await dispatchTool('begin_transaction', { label: 'test-tc' }, config);
    try {
      const split: any = await dispatchTool('split_body_by_bends', {
        part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
        transaction_id: txn.transaction_id,
      }, config);
      for (const panelId of split.panel_ids.slice(0, 3)) {
        const unfold: any = await dispatchTool('get_unfold', {
          part_id: panelId, panel_id: panelId, material_id: config.materials[0]!.id,
          transaction_id: txn.transaction_id,
        }, config);
        expect(unfold.flat_width_mm, `panel ${panelId} flat_width_mm`).toBeGreaterThan(0);
        expect(unfold.dxf_content, `panel ${panelId} dxf_content`).toBeTruthy();
      }
    } finally {
      await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
    }
  }, 30_000);

  it('can call get_unfold immediately on a panel from split_body_by_bends (cauldron)', async () => {
    const fp = findFixture('cauldron.step');
    if (!fp) { console.warn('missing'); return; }
    const clean: any = await dispatchTool('clean_geometry', { file_path: fp }, config);
    const txn: any = await dispatchTool('begin_transaction', { label: 'test-cauldron' }, config);
    try {
      const split: any = await dispatchTool('split_body_by_bends', {
        part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
        max_recursion_depth: 1, transaction_id: txn.transaction_id,
      }, config);
      for (const panelId of split.panel_ids.slice(0, 5)) {
        const unfold: any = await dispatchTool('get_unfold', {
          part_id: panelId, panel_id: panelId, material_id: config.materials[0]!.id,
          transaction_id: txn.transaction_id,
        }, config);
        expect(unfold.flat_width_mm, `panel ${panelId} flat_width_mm`).toBeGreaterThan(0);
        expect(unfold.dxf_content, `panel ${panelId} dxf_content`).toBeTruthy();
      }
    } finally {
      await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
    }
  }, 60_000);
});
