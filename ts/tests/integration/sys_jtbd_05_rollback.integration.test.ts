import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getInf03FixturePath } from '../helpers/fixtures';

describe('SYS-JTBD-05 Rollback Integration', () => {
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

  it('restores state correctly after rollback tool call', async () => {
    const configPath = path.resolve(__dirname, '../../config/config.yaml');
    const config = loadConfig(configPath);
    const fixturePath = getInf03FixturePath();

    // 1. Clean Geometry
    const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const initialSolidId = clean.solid_id;
    const cleanToken = clean.rollback_token;

    // Verify it exists by calling evaluate or something? 
    // Actually we can just run decompose and rollback
    
    // 2. Decompose Volume
    const decompose = await dispatchTool('decompose_volume', { solid_id: initialSolidId, strategy: 'Integrity' }, config) as any;
    const decomposeToken = decompose.rollback_token;
    const panelIds = decompose.panel_ids;

    expect(panelIds.length).toBeGreaterThan(0);

    // 3. Rollback the decompose action
    const rollbackRes = await dispatchTool('rollback', { rollback_token: decomposeToken }, config) as any;
    expect(rollbackRes.restored_solid_ids).toBeDefined();

    // 4. Assert partial state residue removed -> geometry engine should not find the panels from decompose
    try {
        await dispatchTool('evaluate_manufacturability', { panel_id: panelIds[0], material_id: config.materials[0]!.id }, config);
        expect.fail("Panel should not exist after rollback.");
    } catch(err: any) {
        expect(err.code || err.message).toContain('GE_SOLID_NOT_FOUND');
    }

    // rollback to before clean geometry
    const rollbackClean = await dispatchTool('rollback', { rollback_token: cleanToken }, config) as any;
    expect(rollbackClean.restored_solid_ids).toBeDefined();

    // Original solid should be gone
    try {
        await dispatchTool('decompose_volume', { solid_id: initialSolidId, strategy: 'Integrity' }, config);
        expect.fail("Original solid should be rolled back");
    } catch(err: any) {
        expect(err.code || err.message).toContain('GE_SOLID_NOT_FOUND');
    }

  });
});
