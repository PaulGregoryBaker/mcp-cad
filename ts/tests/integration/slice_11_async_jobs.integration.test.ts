/**
 * v2 async job queue tests (Slice 11).
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { v2JobQueue } from '../../src/v2/jobs/queue';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface JobStatus {
  status: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function waitForJob(store: GraphStore, jobId: string): Promise<JobStatus> {
  let status: JobStatus | undefined;
  for (let i = 0; i < 200 && status?.status !== 'succeeded' && status?.status !== 'failed'; i++) {
    status = (await dispatchGraphTool(store, 'get_job', { job_id: jobId })) as JobStatus;
    if (status.status === 'succeeded' || status.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!status) throw new Error(`job ${jobId} never reached a terminal state`);
  return status;
}

d('[v2] Slice 11: async jobs', () => {
  it('get_job returns status for a simulate_nesting job', async () => {
    const store = new GraphStore();

    // Create two parts for nesting
    dispatchGraphTool(store, 'create_part', {
      name: 'nest-1',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;
    const part2 = dispatchGraphTool(store, 'create_part', {
      name: 'nest-2',
      outline: [
        { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 40 }, { x: 0, y: 40 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const nestJob = (await dispatchGraphTool(store, 'simulate_nesting', {
      part_ids: [part2.part_id],
      sheet_width_mm: 1000,
      sheet_height_mm: 500,
    })) as { job_id: string };

    expect(nestJob.job_id).toBeTruthy();

    // Poll the job — it may or may not have completed yet
    const status = (await dispatchGraphTool(store, 'get_job', {
      job_id: nestJob.job_id,
    })) as { job_id: string; status: string; progress: number };

    expect(status.job_id).toBe(nestJob.job_id);
    expect(['queued', 'running', 'succeeded', 'failed']).toContain(status.status);
  });

  // Regression: the completed job's own result was returned in the
  // internal NestingResult TS interface's camelCase field names verbatim
  // (jobs/queue.ts), never hand-converted to the snake_case every other v2
  // tool response uses — `get_job` forwards `job.result` completely
  // opaquely (`result?: unknown`), so nothing upstream did this
  // conversion. The Dart client's SimulateNestingResult.fromJson/
  // NestPlacement.fromJson read `utilisation_pct`/`sheets_required`/
  // `part_id`/`rotation_deg`, found none of them present, and silently
  // defaulted every placement's part id to '' and width/height to 0 — the
  // Sheet Nesting view's own painter skips any placement with zero width/
  // height, so real, non-empty nesting results rendered as an empty sheet.
  it("a completed simulate_nesting job's result uses snake_case field names (Dart client wire contract)", async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'nest-snake-case',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const nestJob = (await dispatchGraphTool(store, 'simulate_nesting', {
      part_ids: [part.part_id],
      sheet_width_mm: 1000,
      sheet_height_mm: 500,
    })) as { job_id: string };

    let status: { status: string; result?: Record<string, unknown> } | undefined;
    for (let i = 0; i < 20 && status?.status !== 'succeeded'; i++) {
      status = (await dispatchGraphTool(store, 'get_job', {
        job_id: nestJob.job_id,
      })) as { status: string; result?: Record<string, unknown> };
      if (status.status === 'succeeded' || status.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(status?.status).toBe('succeeded');
    const result = status!.result!;
    expect(result).toHaveProperty('utilisation_pct');
    expect(result).toHaveProperty('sheets_required');
    expect(result).not.toHaveProperty('utilisationPct');
    expect(result).not.toHaveProperty('sheetsRequired');

    const placements = result.placements as Array<Record<string, unknown>>;
    expect(placements.length).toBeGreaterThan(0);
    expect(placements[0]).toHaveProperty('part_id', part.part_id);
    expect(placements[0]).toHaveProperty('rotation_deg');
    expect(placements[0]).not.toHaveProperty('partId');
    expect(placements[0]).not.toHaveProperty('rotationDeg');
  });

  // get_job is an async handler (docs/BUG_REPORT_get_job_empty_job_id_crashes_server.md
  // — dispatchGraphTool returns a Promise for it, never throwing
  // synchronously even on a bad job_id) — the rejection must be awaited,
  // not probed with a synchronous expect(() => ...).toThrow().
  it('get_job on unknown job throws', async () => {
    const store = new GraphStore();
    await expect(
      dispatchGraphTool(store, 'get_job', { job_id: 'nonexistent' }),
    ).rejects.toThrow();
  });

  it('export_production_pack (dxf) returns per-sheet DXF strings', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'export-test',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const job = (await dispatchGraphTool(store, 'export_production_pack', {
      part_ids: [part.part_id],
    })) as { job_id: string };

    expect(job.job_id).toBeTruthy();

    const status = await waitForJob(store, job.job_id);
    expect(status.status).toBe('succeeded');
    const result = status.result as { dxfs: string[]; sheets_required: number };
    expect(result.sheets_required).toBeGreaterThanOrEqual(1);
    expect(result.dxfs).toHaveLength(result.sheets_required);
    expect(result.dxfs[0]).toContain('LWPOLYLINE');
    expect(result.dxfs[0]).toContain(`${part.part_id}#0`);
  });

  it('export_production_pack (pdf) fails: drawings resource not built', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'export-pdf-test',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const job = (await dispatchGraphTool(store, 'export_production_pack', {
      part_ids: [part.part_id],
      format: 'pdf',
    })) as { job_id: string };

    const status = await waitForJob(store, job.job_id);
    expect(status.status).toBe('failed');
    expect(status.error?.code).toBe('INTERNAL_ERROR');
  });

  it('simulate_nesting copies:3 produces 3 placements with copy_index 0..2', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'nest-copies',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const job = (await dispatchGraphTool(store, 'simulate_nesting', {
      part_ids: [part.part_id],
      sheet_width_mm: 1000,
      sheet_height_mm: 500,
      copies: 3,
    })) as { job_id: string };

    const status = await waitForJob(store, job.job_id);
    expect(status.status).toBe('succeeded');
    const placements = (status.result as { placements: Array<Record<string, unknown>> }).placements;
    expect(placements).toHaveLength(3);
    const indices = placements.map((p) => p.copy_index).sort((a, b) => Number(a) - Number(b));
    expect(indices).toEqual([0, 1, 2]);
  });

  it('simulate_nesting fill mode is deterministic', async () => {
    const run = async () => {
      const store = new GraphStore();
      const part = dispatchGraphTool(store, 'create_part', {
        name: 'nest-fill',
        outline: [
          { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 },
          { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 },
        ],
        thickness_mm: 1.0,
      }) as CreatePartResult;
      const job = (await dispatchGraphTool(store, 'simulate_nesting', {
        part_ids: [part.part_id],
        sheet_width_mm: 120,
        sheet_height_mm: 120,
        copies: 'fill',
      })) as { job_id: string };
      const status = await waitForJob(store, job.job_id);
      expect(status.status).toBe('succeeded');
      return status.result as { placements: unknown[]; sheets_required: number };
    };

    const r1 = await run();
    const r2 = await run();
    expect(r1.placements.length).toBeGreaterThan(1);
    expect(r1.placements.length).toBe(r2.placements.length);
    expect(r1.sheets_required).toBe(r2.sheets_required);
  });

  it('simulate_nesting invalid cutting_width_mm fails the job with NEST_INVALID_CUTTING_WIDTH', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'nest-bad-kerf',
      outline: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;

    const job = (await dispatchGraphTool(store, 'simulate_nesting', {
      part_ids: [part.part_id],
      cutting_width_mm: 5.0, // > tooling.laser.max_kerf_width_mm (0.15)
    })) as { job_id: string };

    const status = await waitForJob(store, job.job_id);
    expect(status.status).toBe('failed');
    expect(status.error?.code).toBe('NEST_INVALID_CUTTING_WIDTH');
  });
});
