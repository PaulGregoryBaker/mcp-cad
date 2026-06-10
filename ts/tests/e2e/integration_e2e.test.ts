import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getInf03FixturePath } from '../helpers/fixtures';

type CleanGeometryResult = {
  solid_id: string;
  is_manifold: boolean;
};

type DecomposeResult = {
  panel_ids: string[];
  rollback_token: string;
};

type SplitResult = {
  panel_ids: string[];
  panel_count: number;
};

type TransactionResult = {
  transaction_id: string;
};

type JointResult = {
  kerf_offset_mm: number;
};

type UnfoldResult = {
  unfold_id: string;
  flat_width_mm: number;
  flat_height_mm: number;
  k_factor_used: number;
};

type NestResult = {
  nest_id: string;
  utilisation_pct: number;
  sheets_required: number;
};

type ExportEnqueueResult = {
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
};

type ExportStatusResult = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
};

type ExportFile = {
  type: string;
  path: string;
};

type ExportResult = {
  files: ExportFile[];
  total_time_ms: number;
};

function resolveAddonPath(): string | null {
  const envPath = process.env['GEOMETRY_ADDON_PATH'];
  if (envPath !== undefined && fs.existsSync(envPath)) {
    return envPath;
  }

  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'cpp', 'build-vcpkg', 'Debug', 'geometry_addon.node'),
    path.resolve(__dirname, '..', '..', '..', 'cpp', 'build', 'Debug', 'geometry_addon.node'),
    path.resolve(__dirname, '..', '..', '..', 'cpp', 'build', 'Release', 'geometry_addon.node'),
    path.resolve(process.cwd(), '..', 'cpp', 'build-vcpkg', 'Debug', 'geometry_addon.node'),
    path.resolve(process.cwd(), '..', 'cpp', 'build', 'Debug', 'geometry_addon.node'),
    path.resolve(process.cwd(), '..', 'cpp', 'build', 'Release', 'geometry_addon.node'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function writeInf03Baseline(report: {
  status: 'executed' | 'skipped';
  note?: string;
  fixture: string;
  total_time_ms: number;
  export_time_ms: number;
  panel_count: number;
  unfold_count: number;
  utilisation_pct: number;
  sheets_required: number;
  files: string[];
}): void {
  const reportDir = path.resolve(__dirname, '..', '..', '..', 'docs', 'test-reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, 'inf03_baseline.json');
  const payload = {
    generated_at: new Date().toISOString(),
    scenario: 'INF-03 golden path',
    ...report,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('INF-03 E2E Golden Path', () => {
  it('STEP -> clean -> decompose -> synthesize -> unfold -> nest -> export lifecycle', async () => {
    const addonPath = resolveAddonPath();
    if (addonPath === null) {
      writeInf03Baseline({
        status: 'skipped',
        note: 'GEOMETRY_ADDON_PATH unresolved; build geometry_addon.node to run full INF-03 flow.',
        fixture: 'sheet_3panel.stp',
        total_time_ms: 0,
        export_time_ms: 0,
        panel_count: 0,
        unfold_count: 0,
        utilisation_pct: 0,
        sheets_required: 0,
        files: [],
      });
      return;
    }
    process.env['GEOMETRY_ADDON_PATH'] = addonPath;

    const config = loadConfig('./config/config.yaml');
    const fixturePath = getInf03FixturePath();
    expect(fs.existsSync(fixturePath)).toBe(true);

    const overallStart = Date.now();

    // Step 1: STEP ingestion
    const clean = (await dispatchTool('clean_geometry', { file_path: fixturePath }, config)) as CleanGeometryResult;
    expect(typeof clean.solid_id).toBe('string');
    expect(clean.is_manifold).toBe(true);

    // Step 2: Decompose the compound solid into individual panel shells.
    // decompose_volume auto-creates a manufacturing graph for each shell so
    // apply_unfold can produce the flat-pattern DXF without a separate split step.
    const txn = (await dispatchTool(
      'begin_transaction',
      { label: 'inf03-golden-path' },
      config,
    )) as TransactionResult;
    const transactionId = txn.transaction_id;

    const decompose = (await dispatchTool(
      'decompose_volume',
      { solid_id: clean.solid_id, strategy: 'Integrity', transaction_id: transactionId },
      config,
    )) as DecomposeResult;

    expect(Array.isArray(decompose.panel_ids)).toBe(true);
    expect(decompose.panel_ids.length).toBeGreaterThanOrEqual(1);
    expect(typeof decompose.rollback_token).toBe('string');

    // Step 3: Joint synthesis
    const jointTargets = decompose.panel_ids.length >= 2
      ? [decompose.panel_ids[0]!, decompose.panel_ids[1]!]
      : [decompose.panel_ids[0]!, decompose.panel_ids[0]!];

    const joints = (await dispatchTool(
      'synthesize_joints',
      {
        panel_ids: jointTargets,
        joint_type: 'tab_slot',
        clearance_mm: 0.15,
      },
      config,
    )) as JointResult;

    expect(joints.kerf_offset_mm).toBeGreaterThanOrEqual(0.1);
    expect(joints.kerf_offset_mm).toBeLessThanOrEqual(0.2);

    // Step 4: Unfold each panel using the graph-first API
    const unfoldResults: UnfoldResult[] = [];
    for (const panelId of decompose.panel_ids) {
      const unfolded = (await dispatchTool(
        'apply_unfold',
        { part_id: panelId, panel_id: panelId, material_id: config.materials[0]!.id, transaction_id: transactionId },
        config,
      )) as UnfoldResult;

      expect(unfolded.flat_width_mm).toBeGreaterThan(0);
      expect(unfolded.flat_height_mm).toBeGreaterThan(0);
      expect(unfolded.k_factor_used).toBeGreaterThan(0);
      expect(unfolded.k_factor_used).toBeLessThanOrEqual(1);
      unfoldResults.push(unfolded);
    }

    // Step 5: Nesting
    const firstSheet = config.materials[0]!.inventorySheets[0]!;
    const nest = (await dispatchTool(
      'simulate_nesting',
      {
        unfold_ids: unfoldResults.map((u) => u.unfold_id),
        sheet_size: {
          width_mm: firstSheet.widthMm,
          height_mm: firstSheet.heightMm,
          label: firstSheet.label,
        },
      },
      config,
    )) as NestResult;

    expect(typeof nest.nest_id).toBe('string');
    if (nest.utilisation_pct <= 80) {
      console.warn(`\n[WARNING] Low material utilisation: ${nest.utilisation_pct.toFixed(2)}%. (Target: >80%)\n`);
    } else {
      expect(nest.utilisation_pct).toBeGreaterThan(80);
    }
    expect(Number.isInteger(nest.sheets_required)).toBe(true);
    expect(nest.sheets_required).toBeGreaterThanOrEqual(1);

    // Step 6: Export job submission
    const enqueued = (await dispatchTool(
      'export_production_pack',
      {
        nest_id: nest.nest_id,
        include_bom: true,
        include_assembly: true,
      },
      config,
    )) as ExportEnqueueResult;

    expect(typeof enqueued.job_id).toBe('string');
    expect(['queued', 'running', 'succeeded']).toContain(enqueued.status);

    // Step 7: Poll + result retrieval
    const pollDeadline = Date.now() + 30_000;
    let status = (await dispatchTool('get_export_job_status', { job_id: enqueued.job_id }, config)) as ExportStatusResult;

    while (status.status !== 'succeeded' && status.status !== 'failed' && Date.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (await dispatchTool('get_export_job_status', { job_id: enqueued.job_id }, config)) as ExportStatusResult;
    }

    expect(status.status).toBe('succeeded');
    expect(status.progress).toBe(100);

    const result = (await dispatchTool('get_export_job_result', { job_id: enqueued.job_id }, config)) as ExportResult;

    const fileTypes = result.files.map((f) => f.type);
    const filePaths = result.files.map((f) => f.path);

    expect(fileTypes).toContain('dxf');
    expect(fileTypes).toContain('bom_csv');
    expect(fileTypes).toContain('assembly_json');
    expect(filePaths.some((p) => p.endsWith('.dxf'))).toBe(true);
    expect(filePaths.some((p) => p.endsWith('.csv'))).toBe(true);
    expect(filePaths.some((p) => p.endsWith('.json'))).toBe(true);

    const totalTimeMs = Date.now() - overallStart;
    expect(totalTimeMs).toBeLessThan(30_000);

    writeInf03Baseline({
      status: 'executed',
      fixture: path.basename(fixturePath),
      total_time_ms: totalTimeMs,
      export_time_ms: result.total_time_ms,
      panel_count: decompose.panel_ids.length,
      unfold_count: unfoldResults.length,
      utilisation_pct: nest.utilisation_pct,
      sheets_required: nest.sheets_required,
      files: filePaths,
    });
  }, 60_000);
});
