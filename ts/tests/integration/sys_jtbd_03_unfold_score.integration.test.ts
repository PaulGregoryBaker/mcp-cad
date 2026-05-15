import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getInf03FixturePath } from '../helpers/fixtures';

describe('SYS-JTBD-03 Unfold and Score Integration', () => {
  let addonPath: string;

  beforeAll(() => {
    // Basic addon resolution
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

  it('runs unfold + evaluate deterministically across 3 iterations', async () => {
    const configPath = path.resolve(__dirname, '../../config/config.yaml');
    const config = loadConfig(configPath);
    const fixturePath = getInf03FixturePath();

    // Do the operations 3 times to assert determinism
    const results: any[] = [];

    for (let i = 0; i < 3; i++) {
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

      const panelId = decompose.panel_ids[0]; // just take first panel

      // 3. apply_unfold
      const unfold = await dispatchTool('apply_unfold', {
        panel_id: panelId,
        material_id: config.materials[0]!.id,
      }, config) as any;

      // 4. evaluate_manufacturability
      const score = await dispatchTool('evaluate_manufacturability', {
        panel_id: panelId,
        material_id: config.materials[0]!.id,
      }, config) as any;

      results.push({
        unfold_width: unfold.flat_width_mm,
        unfold_height: unfold.flat_height_mm,
        score_value: score.score,
        violations_count: score.violations?.length ?? 0,
      });
    }

    const first = results[0];
    
    // Asserts that score/violation run
    expect(first.score_value).toBeGreaterThanOrEqual(0);
    expect(first.score_value).toBeLessThanOrEqual(1.0);
    expect(first.unfold_width).toBeGreaterThan(0);
    expect(first.unfold_height).toBeGreaterThan(0);

    // Asserts determinism
    for (let i = 1; i < 3; i++) {
        expect(results[i].unfold_width).toBe(first.unfold_width);
        expect(results[i].unfold_height).toBe(first.unfold_height);
        expect(results[i].score_value).toBe(first.score_value);
        expect(results[i].violations_count).toBe(first.violations_count);
    }
  });
});
