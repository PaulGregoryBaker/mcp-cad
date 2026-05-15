import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getInf03FixturePath } from '../helpers/fixtures';

describe('SYS-JTBD-04 Export Lifecycle Integration', () => {
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

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  it('verifies export lifecycle state transitions', async () => {
    const configPath = path.resolve(__dirname, '../../config/config.yaml');
    const config = loadConfig(configPath);
    const fixturePath = getInf03FixturePath();

    let decompose: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
      try {
        decompose = await dispatchTool(
          'decompose_volume',
          { solid_id: clean.solid_id, strategy: 'Integrity' },
          config,
        ) as any;
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'GE_SOLID_NOT_FOUND' || attempt === 2) {
          throw err;
        }
      }
    }
    
    expect(decompose.panel_ids.length).toBeGreaterThan(0);

    const unfoldIds = [];
    for (const panelId of decompose.panel_ids) {
        const unfold = await dispatchTool('apply_unfold', {
            panel_id: panelId,
            material_id: config.materials[0]!.id,
        }, config) as any;
        unfoldIds.push(unfold.unfold_id);
    }

    const firstSheet = config.materials[0]!.inventorySheets[0]!;
    const nest = await dispatchTool('simulate_nesting', {
        unfold_ids: unfoldIds,
        sheet_size: {
          width_mm: firstSheet.widthMm,
          height_mm: firstSheet.heightMm,
          label: firstSheet.label,
        },
    }, config) as any;

    expect(nest.nest_id).toBeDefined();

    // Export Phase
    const exportRes = await dispatchTool('export_production_pack', {
        nest_id: nest.nest_id,
        include_bom: true,
        include_assembly: true
    }, config) as any;

    expect(exportRes.job_id).toBeDefined();
    expect(['queued', 'running', 'succeeded']).toContain(exportRes.status);
    
    const jobId = exportRes.job_id;
    let status = exportRes.status;
    let retries = 0;

    while (status !== 'succeeded' && status !== 'failed' && retries < 10) {
        await sleep(500); // Wait bit longer for polling
        const poll = await dispatchTool('get_export_job_status', { job_id: jobId }, config) as any;
        status = poll.status;
        expect(['queued', 'running', 'succeeded', 'failed']).toContain(status);
        retries++;
    }

    expect(status).toBe('succeeded');

    const result = await dispatchTool('get_export_job_result', { job_id: jobId }, config) as any;
    expect(result.files).toBeDefined();
    expect(result.files.length).toBeGreaterThanOrEqual(1);

    const types = result.files.map((f: any) => f.type);
    expect(types).toContain('dxf');
    expect(types).toContain('bom_csv');
    expect(types).toContain('assembly_json');
  });
});
