import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

function findAddonPath(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '../../../cpp/build/Release/geometry_addon.node'),
    path.resolve(__dirname, '../../../cpp/build-vcpkg/Debug/geometry_addon.node'),
    path.resolve(__dirname, '../../../cpp/build/Debug/geometry_addon.node'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function findFixture(filename: string): string | undefined {
  const fixturesDir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(fixturesDir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

describe('build_manufacturing_plan integration tests', () => {
  let addonAvailable = false;
  const configPath = path.resolve(__dirname, '../../config/config.yaml');

  beforeAll(() => {
    const addonPath = findAddonPath();
    if (addonPath) {
      process.env['GEOMETRY_ADDON_PATH'] = addonPath;
      addonAvailable = true;
    }
  });

  it('US1: hollow_cube.stp -> reconstructs successfully into a watertight part', async () => {
    if (!addonAvailable) return;

    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) {
      console.warn('hollow_cube.stp not found — skipping test');
      return;
    }

    const config = loadConfig(configPath);

    const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    expect(clean.solid_id).toBeDefined();

    const report = await dispatchTool('build_manufacturing_plan', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45.0,
      max_thickness_mm: 5.0,
    }, config) as any;

    console.log("HOLLOW_CUBE REPORT:", JSON.stringify(report, null, 2));

    expect(report.success).toBe(true);
    expect(report.reconstructed_parts.length).toBeGreaterThan(0);
    expect(report.unmerged_parts).toHaveLength(0);

    const firstRecon = report.reconstructed_parts[0];
    expect(firstRecon.part_id).toBeDefined();
    expect(firstRecon.graph).toBeDefined();

    const panelNodes = firstRecon.graph.nodes.filter((n: any) => n.type === 'PanelNode');
    const bendNodes = firstRecon.graph.nodes.filter((n: any) => n.type === 'BendNode');

    expect(panelNodes.length).toBe(6);
    expect(bendNodes.length).toBeGreaterThanOrEqual(5); // at least a spanning tree of bends
  });

  it('US2: testcube.step -> isolates protrusions and lists them as unmerged', async () => {
    if (!addonAvailable) return;

    const fixturePath = findFixture('testcube.step');
    if (!fixturePath) {
      console.warn('testcube.step not found — skipping test');
      return;
    }

    const config = loadConfig(configPath);

    const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    expect(clean.solid_id).toBeDefined();

    const report = await dispatchTool('build_manufacturing_plan', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45.0,
      max_thickness_mm: 2.0,
    }, config) as any;

    expect(report.success).toBe(true);
    expect(report.unmerged_parts.length).toBeGreaterThanOrEqual(4); // at least the 4 bridge flanges

    const protrusions = report.unmerged_parts.filter((p: any) => p.reason === 'protrusion');
    expect(protrusions.length).toBeGreaterThanOrEqual(4);

    for (const prot of protrusions) {
      expect(prot.part_id).toBeDefined();
      expect(prot.bbox).toBeDefined();
      expect(prot.bbox.x_min).toBeLessThan(prot.bbox.x_max);
    }
  });

  it('US3: cauldron.step -> handles skipped joints or partial merge', async () => {
    if (!addonAvailable) return;

    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) {
      console.warn('cauldron.step not found — skipping test');
      return;
    }

    const config = loadConfig(configPath);

    const clean = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    expect(clean.solid_id).toBeDefined();

    const report = await dispatchTool('build_manufacturing_plan', {
      part_id: clean.solid_id,
      angle_threshold_deg: 0.5,
      max_thickness_mm: 5.0,
    }, config) as any;

    // cauldron.step has segmentations that cannot be normally bend-merged in surface mode
    // because they don't form valid solid joints (so they fail validation or merge)
    expect(report.success).toBe(true);
    expect(report.skipped_joints.length).toBeGreaterThan(0);

    const firstSkipped = report.skipped_joints[0];
    expect(firstSkipped.part_a_id).toBeDefined();
    expect(firstSkipped.part_b_id).toBeDefined();
    expect(firstSkipped.reason).toBeDefined();
    expect(firstSkipped.violations).toBeDefined();
  });
});
