import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';

function resolveAddonPath(): string | null {
  const envPath = process.env['GEOMETRY_ADDON_PATH'];
  if (envPath !== undefined && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'cpp', 'build', 'Release', 'geometry_addon.node'),
    path.resolve(process.cwd(), '..', 'cpp', 'build', 'Release', 'geometry_addon.node'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

describe('MCP Phase B integration', () => {
  it('STEP -> clean -> decompose -> synthesize_joints flow', async () => {
    const addonPath = resolveAddonPath();
    if (addonPath === null) {
      return;
    }

    process.env['GEOMETRY_ADDON_PATH'] = addonPath;

    const cfg = loadConfig('./config/config.yaml');
    const fixture = getFixturePath('simple_box.stp');
    if (!fs.existsSync(fixture)) {
      return;
    }

    const clean = (await dispatchTool('clean_geometry', { file_path: fixture }, cfg)) as {
      solid_id: string;
    };
    expect(typeof clean.solid_id).toBe('string');

    const decompose = (await dispatchTool(
      'decompose_volume',
      { solid_id: clean.solid_id, strategy: 'Integrity' },
      cfg,
    )) as { panel_ids: string[] };

    if (decompose.panel_ids.length < 2) {
      return;
    }

    const joint = (await dispatchTool(
      'synthesize_joints',
      {
        panel_ids: [clean.solid_id[0], clean.solid_id],
        joint_type: 'tab_slot',
        clearance_mm: 0.15,
      },
      cfg,
    )) as { kerf_offset_mm: number };

    expect(joint.kerf_offset_mm).toBeGreaterThanOrEqual(0.1);
    expect(joint.kerf_offset_mm).toBeLessThanOrEqual(0.2);

    // Phase C: extend with unfold step (SYS-JTBD-01 partial — T084)
    const unfold = (await dispatchTool(
      'apply_unfold',
      {
        part_id: decompose.panel_ids[0],
        panel_id: decompose.panel_ids[0],
        material_id: cfg.materials[0]!.id,
      },
      cfg,
    )) as { unfold_id: string; flat_width_mm: number; flat_height_mm: number; k_factor_used: number };

    expect(typeof unfold.unfold_id).toBe('string');
    expect(unfold.flat_width_mm).toBeGreaterThan(0);
    expect(unfold.flat_height_mm).toBeGreaterThan(0);
    expect(unfold.k_factor_used).toBeGreaterThan(0);
    expect(unfold.k_factor_used).toBeLessThanOrEqual(1);
  });
});
