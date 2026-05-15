import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadConfig } from '../../src/config/loader';
import { dispatchTool, setGeometryBindingMock } from '../../src/mcp/tools';
import { session } from '../../src/geometry/session';
import { jobQueue } from '../../src/geometry/jobs';
import type { GeometryAddon } from '../../src/geometry/binding';
import type { TopologyBend, TopologyFlange, TopologyHole } from '../../src/geometry/types';

type PanelTopology = {
  bends: TopologyBend[];
  holes: TopologyHole[];
  flanges: TopologyFlange[];
};

function fixturePath(): string {
  return path.resolve(__dirname, 'fixtures', 'Braai.stl');
}

describe('SYS-JTBD-07 Braai STL (Post-MVP)', () => {
  const config = loadConfig('./config/config.yaml');
  const panelTopologies = new Map<string, PanelTopology>([
    [
      'panel-a',
      {
        bends: [
          {
            featureId: 'bend-a',
            angleDeg: 90,
            radiusMm: 2,
            lengthMm: 120,
            kFactor: 0.33,
            bendAllowanceMm: 2.5,
            faceIds: ['fa-1', 'fa-2'],
          },
        ],
        holes: [
          {
            featureId: 'hole-a',
            centerX: 10,
            centerY: 20,
            diameterMm: 5,
            throughHole: true,
            faceId: 'fa-1',
          },
        ],
        flanges: [
          {
            featureId: 'flange-a',
            widthMm: 20,
            lengthMm: 120,
            adjacentBendId: 'bend-a',
            faceId: 'fa-1',
          },
        ],
      },
    ],
    [
      'panel-b',
      {
        bends: [
          {
            featureId: 'bend-b',
            angleDeg: 45,
            radiusMm: 2,
            lengthMm: 95,
            kFactor: 0.33,
            bendAllowanceMm: 1.2,
            faceIds: ['fb-1', 'fb-2'],
          },
        ],
        holes: [],
        flanges: [
          {
            featureId: 'flange-b',
            widthMm: 18,
            lengthMm: 90,
            adjacentBendId: 'bend-b',
            faceId: 'fb-1',
          },
        ],
      },
    ],
  ]);

  let snapshotCounter = 0;

  const mockAddon: GeometryAddon = {
    loadStep: () => 'solid-braai-raw',
    checkManifold: (solidId) => {
      if (solidId === 'solid-braai-raw') {
        return {
          isManifold: false,
          issues: [{ type: 'non_manifold_edge', description: 'mesh seam edge' }],
        };
      }
      return { isManifold: true, issues: [] };
    },
    healGeometry: () => 'solid-braai-healed',
    getTopology: (solidId) => {
      const panel = panelTopologies.get(solidId);
      return {
        solidId,
        faces: [
          {
            faceId: 'f-1',
            surfaceType: 'plane',
            areaMm2: 1000,
            normalX: 0,
            normalY: 0,
            normalZ: 1,
          },
        ],
        edges: [{ edgeId: 'e-1', curveType: 'line', lengthMm: 25 }],
        adjacency: [{ faceIdA: 'f-1', faceIdB: 'f-2', sharedEdgeId: 'e-1', dihedralAngleDeg: 90 }],
        bends: panel?.bends ?? [],
        holes: panel?.holes ?? [],
        flanges: panel?.flanges ?? [],
      };
    },
    booleanCut: () => ({ shellIds: ['panel-a', 'panel-b'], rollbackToken: 'rb-cut' }),
    addTabSlot: (shellIdA, shellIdB, kerfOffsetMm) => ({
      modifiedShellIds: [shellIdA, shellIdB],
      kerfOffsetApplied: kerfOffsetMm,
      rollbackToken: 'rb-tabslot',
    }),
    addRivetHole: (shellId) => ({
      modifiedShellId: shellId,
      holeFeatureId: 'hole-1',
      rollbackToken: 'rb-rivet',
    }),
    unfoldShell: (shellId, kFactor) => ({
      unfoldId: `unfold-${shellId}`,
      flatWidthMm: 320,
      flatHeightMm: 140,
      kFactorUsed: kFactor,
      bendCount: 1,
      rollbackToken: 'rb-unfold',
    }),
    exportDxf: () => ({
      dxfContent: '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n',
      wireCount: 1,
      bboxWidthMm: 320,
      bboxHeightMm: 140,
    }),
    nestShells: (unfoldIds) => ({
      nestId: 'nest-braai',
      placements: unfoldIds.map((id, i) => ({
        unfoldId: id,
        sheetIndex: 0,
        x: i * 25,
        y: i * 10,
        rotationDeg: 0,
      })),
      utilisationPct: 82.5,
      sheetsRequired: 1,
    }),
    createSnapshot: (label) => `${label}-${++snapshotCounter}`,
    restoreSnapshot: () => ({
      restoredSolidIds: ['solid-braai-healed'],
      restoredShellIds: ['panel-a', 'panel-b'],
    }),
    clearSnapshots: () => undefined,
  };

  beforeEach(() => {
    snapshotCounter = 0;
    session.reset();
    setGeometryBindingMock(undefined);
  });

  it('T003/T004/T005/T006/T007: scaffolds and executes Braai phases 1-3', async () => {
    expect(fs.existsSync(fixturePath())).toBe(true);

    setGeometryBindingMock({
      ...mockAddon,
      loadStep: (inputPath: string) => {
        if (!inputPath.toLowerCase().endsWith('.stl')) {
          throw new Error('Expected STL input for post-MVP Braai test');
        }
        return 'solid-braai-raw';
      },
    });

    const clean = (await dispatchTool(
      'clean_geometry',
      { file_path: fixturePath() },
      config,
    )) as Record<string, unknown>;
    expect(clean['solid_id']).toBe('solid-braai-healed');
    expect(clean['healed']).toBe(true);

    const decompose = (await dispatchTool(
      'decompose_volume',
      { solid_id: clean['solid_id'], strategy: 'Logistics' },
      config,
    )) as Record<string, unknown>;

    const panelIds = decompose['panel_ids'] as string[];
    expect(panelIds).toEqual(['panel-a', 'panel-b']);
    expect(session.hasShell('panel-a')).toBe(true);
    expect(session.hasShell('panel-b')).toBe(true);
  });

  it('T008/T009/T010/T021/T023: validates safety, kerf, manufacturability, bend sequence, and deterministic replay', async () => {
    setGeometryBindingMock(mockAddon);
    const firstMaterial = config.materials[0];
    if (firstMaterial === undefined) {
      throw new Error('Expected at least one material in config');
    }

    const fireRatedConfig = {
      ...config,
      environmental: {
        ...config.environmental,
        fireRated: true,
      },
    };

    await expect(
      dispatchTool(
        'synthesize_joints',
        { panel_ids: ['panel-a', 'panel-b'], joint_type: 'adhesive' },
        fireRatedConfig,
      ),
    ).rejects.toMatchObject({ code: 'MD_SAFETY_VIOLATION' });

    const tabSlot = (await dispatchTool(
      'synthesize_joints',
      { panel_ids: ['panel-a', 'panel-b'], joint_type: 'tab_slot', clearance_mm: 0.15 },
      config,
    )) as Record<string, unknown>;

    expect(tabSlot['kerf_offset_mm']).toBeGreaterThanOrEqual(0.1);
    expect(tabSlot['kerf_offset_mm']).toBeLessThanOrEqual(0.2);

    const manuA = await dispatchTool(
      'evaluate_manufacturability',
      { panel_id: 'panel-a', material_id: firstMaterial.id },
      config,
    );

    const manuB = await dispatchTool(
      'evaluate_manufacturability',
      { panel_id: 'panel-a', material_id: firstMaterial.id },
      config,
    );

    expect(manuA).toEqual(manuB);

    const bendSequence = (await dispatchTool(
      'validate_bend_sequence',
      { panel_id: 'panel-a' },
      config,
    )) as Record<string, unknown>;

    expect(bendSequence['feasible']).toBe(true);
    const suggested = bendSequence['suggested_sequence'] as Array<Record<string, unknown>>;
    expect(Array.isArray(suggested)).toBe(true);
    expect(suggested.length).toBeGreaterThan(0);
  });

  it('T011/T017: validates async export lifecycle success, not-found, not-complete, and failed state contract', async () => {
    setGeometryBindingMock(mockAddon);

    const statusSpy = vi.spyOn(jobQueue, 'getStatus').mockReturnValue({
      jobId: 'job-failed-sim',
      status: 'failed',
      progress: 100,
      createdAt: Date.now() - 100,
      completedAt: Date.now(),
      error: {
        code: 'INTERNAL_ERROR',
        message: 'simulated failure',
        recoverable: false,
      },
    });

    const failed = (await dispatchTool(
      'get_export_job_status',
      { job_id: 'job-failed-sim' },
      config,
    )) as Record<string, unknown>;
    expect(failed['status']).toBe('failed');
    statusSpy.mockRestore();

    await expect(
      dispatchTool('get_export_job_status', { job_id: 'missing-job-id' }, config),
    ).rejects.toMatchObject({ code: 'EXPORT_JOB_NOT_FOUND' });

    const queued = (await dispatchTool(
      'export_production_pack',
      { nest_id: 'nest-braai', include_bom: true, include_assembly: true },
      config,
    )) as Record<string, unknown>;

    await expect(
      dispatchTool('get_export_job_result', { job_id: queued['job_id'] }, config),
    ).rejects.toMatchObject({ code: 'EXPORT_JOB_NOT_COMPLETE' });

    let status = (await dispatchTool(
      'get_export_job_status',
      { job_id: queued['job_id'] },
      config,
    )) as Record<string, unknown>;
    const deadline = Date.now() + 5000;

    while (status['status'] !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await dispatchTool(
        'get_export_job_status',
        { job_id: queued['job_id'] },
        config,
      )) as Record<string, unknown>;
    }

    expect(status['status']).toBe('succeeded');

    const result = (await dispatchTool(
      'get_export_job_result',
      { job_id: queued['job_id'] },
      config,
    )) as Record<string, unknown>;
    const files = result['files'] as Array<Record<string, unknown>>;
    expect(files.some((f) => f['type'] === 'dxf')).toBe(true);
  });

  it('T016/T018: validates config initialization and single-session boundaries', async () => {
    expect(config.materials.length).toBeGreaterThan(0);
    expect(config.tooling.pressBrake.maxTonnage).toBeGreaterThan(0);

    setGeometryBindingMock(mockAddon);

    await dispatchTool('clean_geometry', { file_path: fixturePath() }, config);
    await dispatchTool(
      'decompose_volume',
      { solid_id: 'solid-braai-healed', strategy: 'Integrity' },
      config,
    );

    const summary = session.getSummary();
    expect(summary.solids).toBeGreaterThanOrEqual(1);
    expect(summary.shells).toBeGreaterThanOrEqual(2);

    session.reset();
    const resetSummary = session.getSummary();
    expect(resetSummary.solids).toBe(0);
    expect(resetSummary.shells).toBe(0);
    expect(resetSummary.unfolds).toBe(0);
    expect(resetSummary.nests).toBe(0);
  });
});
