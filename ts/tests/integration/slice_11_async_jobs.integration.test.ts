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

    const nestJob = dispatchGraphTool(store, 'simulate_nesting', {
      part_ids: [part2.part_id],
      sheet_width_mm: 1000,
      sheet_height_mm: 500,
    }) as { job_id: string };

    expect(nestJob.job_id).toBeTruthy();

    // Poll the job — it may or may not have completed yet
    const status = dispatchGraphTool(store, 'get_job', {
      job_id: nestJob.job_id,
    }) as { job_id: string; status: string; progress: number };

    expect(status.job_id).toBe(nestJob.job_id);
    expect(['queued', 'running', 'succeeded', 'failed']).toContain(status.status);
  });

  it('get_job on unknown job throws', () => {
    const store = new GraphStore();
    expect(() =>
      dispatchGraphTool(store, 'get_job', { job_id: 'nonexistent' }),
    ).toThrow();
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

    const job = dispatchGraphTool(store, 'export_production_pack', {
      part_ids: [part.part_id],
    }) as { job_id: string };

    expect(job.job_id).toBeTruthy();

    // Wait a moment for the job to fail
    await new Promise((r) => setTimeout(r, 100));

    const status = dispatchGraphTool(store, 'get_job', {
      job_id: job.job_id,
    }) as { job_id: string; status: string };

    expect(status.status).toBe('failed');
  });
});
