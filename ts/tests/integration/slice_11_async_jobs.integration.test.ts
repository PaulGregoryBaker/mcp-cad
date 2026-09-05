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

  it('export_production_pack returns a job that fails (stub)', async () => {
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

    // Wait a moment for the job to fail
    await new Promise((r) => setTimeout(r, 100));

    const status = (await dispatchGraphTool(store, 'get_job', {
      job_id: job.job_id,
    })) as { job_id: string; status: string };

    expect(status.status).toBe('failed');
  });
});
