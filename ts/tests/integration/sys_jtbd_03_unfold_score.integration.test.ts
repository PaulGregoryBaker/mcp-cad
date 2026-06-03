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
      let clean: any;
      let decompose: any;
      let panelId: any;
      let unfold: any;
      let score: any;
      // 1. Clean geometry
      try {
        clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
        // eslint-disable-next-line no-console
        console.log(`[UnfoldScoreTest] Iter ${i} clean_geometry result:`, clean);
        if (!clean || !clean.solid_id) throw new Error('clean_geometry did not return a solid_id');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[UnfoldScoreTest] Iter ${i} clean_geometry failed:`, err);
        throw err;
      }

      // 2. Decompose volume
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          decompose = await dispatchTool(
            'decompose_volume',
            { solid_id: clean.solid_id, strategy: 'Integrity' },
            config,
          ) as any;
          // eslint-disable-next-line no-console
          console.log(`[UnfoldScoreTest] Iter ${i} decompose_volume result:`, decompose);
          if (!decompose || !decompose.panel_ids || decompose.panel_ids.length === 0) {
            throw new Error('decompose_volume did not return panel_ids');
          }
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          // eslint-disable-next-line no-console
          console.error(`[UnfoldScoreTest] Iter ${i} decompose_volume failed (attempt ${attempt}):`, err);
          if (code !== 'GE_SOLID_NOT_FOUND' || attempt === 2) {
            throw err;
          }
        }
      }

      panelId = decompose.panel_ids[0];
      if (!panelId) {
        // eslint-disable-next-line no-console
        console.error(`[UnfoldScoreTest] Iter ${i} no panelId found after decompose_volume`);
        throw new Error('No panelId found after decompose_volume');
      }

      // 3. apply_unfold
      try {
        unfold = await dispatchTool('apply_unfold', {
          part_id: panelId,
          panel_id: panelId,
          material_id: config.materials[0]!.id,
        }, config) as any;
        // eslint-disable-next-line no-console
        console.log(`[UnfoldScoreTest] Iter ${i} apply_unfold result:`, unfold);
        if (!unfold || unfold.flat_width_mm === undefined || unfold.flat_height_mm === undefined) {
          throw new Error('apply_unfold did not return flat pattern dimensions');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[UnfoldScoreTest] Iter ${i} apply_unfold failed:`, err);
        throw err;
      }

      // 4. evaluate_manufacturability
      try {
        score = await dispatchTool('evaluate_manufacturability', {
          panel_id: panelId,
          material_id: config.materials[0]!.id,
        }, config) as any;
        // eslint-disable-next-line no-console
        console.log(`[UnfoldScoreTest] Iter ${i} evaluate_manufacturability result:`, score);
        if (!score || score.score === undefined) {
          throw new Error('evaluate_manufacturability did not return a score');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[UnfoldScoreTest] Iter ${i} evaluate_manufacturability failed:`, err);
        throw err;
      }

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
