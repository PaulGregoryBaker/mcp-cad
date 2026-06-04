import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool, registerTestPart } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getInf03FixturePath } from '../helpers/fixtures';

describe('SYS-JTBD-01 Full Decompose System Integration', () => {
  let addonPath: string;

  beforeAll(() => {
    const candidates = [
      path.resolve(__dirname, '../../../cpp/build-vcpkg/Debug/geometry_addon.node'),
      path.resolve(__dirname, '../../../cpp/build/Debug/geometry_addon.node'),
      path.resolve(__dirname, '../../../cpp/build/Release/geometry_addon.node'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        addonPath = candidate;
        break;
      }
    }
  });

  it('runs STEP -> clean -> decompose -> joints -> unfold end-to-end', async () => {
    const configPath = path.resolve(__dirname, '../../config/config.yaml');
    const config = loadConfig(configPath);
    const fixturePath = getInf03FixturePath();

    // 1. clean_geometry
    const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    expect(clean.solid_id).toBeDefined();

    // 2. decompose_volume
    const decompose = await dispatchTool('decompose_volume', { solid_id: clean.solid_id, strategy: 'Integrity' }, config) as any;
    expect(decompose.panel_ids.length).toBeGreaterThanOrEqual(1);
    
    // Start explicit transaction for mutating steps
    const txn = await dispatchTool('begin_transaction', { label: 'sys-jtbd-01' }, config) as any;
    expect(txn.transaction_id).toBeDefined();

    // 3. synthesize_joints
    const joints = await dispatchTool('synthesize_joints', {
        panel_ids: [decompose.panel_ids[0], decompose.panel_ids[0]],
        joint_type: 'tab_slot',
        clearance_mm: 0.15,
        transaction_id: txn.transaction_id
    }, config) as any;
    expect(joints.kerf_offset_mm).toBeDefined();
    expect(joints.kerf_offset_mm).toBeGreaterThanOrEqual(0.1);
    expect(joints.kerf_offset_mm).toBeLessThanOrEqual(0.2);

    registerTestPart(decompose.panel_ids[0], [decompose.panel_ids[0]]);

    // 4. apply_unfold
    const unfold1 = await dispatchTool('apply_unfold', {
      part_id: decompose.panel_ids[0],
        panel_id: decompose.panel_ids[0],
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id
    }, config) as any;
    expect(unfold1.flat_width_mm).toBeGreaterThan(0);
    expect(unfold1.flat_height_mm).toBeGreaterThan(0);

    const unfold2 = await dispatchTool('apply_unfold', {
      part_id: decompose.panel_ids[0],
        panel_id: decompose.panel_ids[0],
        material_id: config.materials[0]!.id,
        transaction_id: txn.transaction_id
    }, config) as any;
    expect(unfold2.flat_width_mm).toBeGreaterThan(0);
    expect(unfold2.flat_height_mm).toBeGreaterThan(0);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  });
});
