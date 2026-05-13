/**
 * Vitest tests for the async export job queue.
 *
 * Tasks: T107
 */

import { describe, it, expect } from 'vitest';
import { jobQueue } from '../src/geometry/jobs';
import type { ExportParams } from '../src/geometry/jobs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<ExportParams> = {}): ExportParams {
  return {
    nestId: 'nest-001',
    includeBom: true,
    includeAssembly: true,
    config: {
      materials: [],
      tooling: {
        pressBrake: { maxTonnage: 100, maxBendLengthMm: 3000 },
        laser: { maxKerfWidthMm: 0.2, maxThicknessMm: 20 },
      },
      logistics: { shippingRegions: [], maxWeightKg: 500 },
      environmental: { fireRated: false, marineGrade: false, outdoorExposed: false },
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InProcessJobQueue', () => {
  it('EXP-01: enqueue returns a non-empty job ID immediately', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const jobId = jobQueue.enqueue(makeParams());

    expect(jobId).toBeTruthy();
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(8);
  });

  it('EXP-02: job status is queued or running immediately after enqueue', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const jobId = jobQueue.enqueue(makeParams());
    const status = jobQueue.getStatus(jobId);

    expect(['queued', 'running']).toContain(status.status);
  });

  it('EXP-03: job eventually reaches succeeded status', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const jobId = jobQueue.enqueue(makeParams());

    // Poll until succeeded or timeout (2 seconds)
    const deadline = Date.now() + 2000;
    let job = jobQueue.getStatus(jobId);
    while (job.status !== 'succeeded' && job.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = jobQueue.getStatus(jobId);
    }

    expect(job.status).toBe('succeeded');
    expect(job.progress).toBe(100);
    expect(job.completedAt).toBeDefined();
  });

  it('EXP-04: getResult returns files list including DXF', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const jobId = jobQueue.enqueue(makeParams({ includeBom: true, includeAssembly: true }));

    // Wait for completion
    const deadline = Date.now() + 2000;
    let job = jobQueue.getStatus(jobId);
    while (job.status !== 'succeeded' && job.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = jobQueue.getStatus(jobId);
    }

    const result = jobQueue.getResult(jobId);

    expect(result.jobId).toBe(jobId);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some((f) => f.type === 'dxf')).toBe(true);
    expect(result.files.some((f) => f.type === 'bom_csv')).toBe(true);
    expect(result.files.some((f) => f.type === 'assembly_json')).toBe(true);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('EXP-05: getResult throws EXPORT_JOB_NOT_COMPLETE if job is still running', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    // Enqueue and immediately try to get result
    const jobId = jobQueue.enqueue(makeParams());

    // Might be queued or running — either way, not succeeded yet
    const status = jobQueue.getStatus(jobId);
    if (status.status !== 'succeeded') {
      expect(() => jobQueue.getResult(jobId)).toThrow();
    }
  });

  it('EXP-06: getStatus throws for unknown job ID', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    expect(() => jobQueue.getStatus('nonexistent-job-id')).toThrow();
  });

  it('EXP-07: 20 concurrent jobs all complete successfully', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const JOB_COUNT = 20;

    // Enqueue all jobs
    const jobIds = Array.from({ length: JOB_COUNT }, (_, i) =>
      jobQueue.enqueue(makeParams({ nestId: `nest-load-${i}` })),
    );

    // Wait for all to complete (up to 5 seconds)
    const deadline = Date.now() + 5000;
    let allDone = false;
    while (!allDone && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      allDone = jobIds.every((id) => {
        const s = jobQueue.getStatus(id).status;
        return s === 'succeeded' || s === 'failed';
      });
    }

    const results = jobIds.map((id) => jobQueue.getStatus(id));
    const succeeded = results.filter((j) => j.status === 'succeeded');
    expect(succeeded.length).toBe(JOB_COUNT);
  }, 10000); // 10 second timeout for load test

  it('EXP-08: BOM-only job returns bom_csv but no assembly_json', async () => {
    const { jobQueue } = await import('../src/geometry/jobs');
    const jobId = jobQueue.enqueue(makeParams({ includeBom: true, includeAssembly: false }));

    const deadline = Date.now() + 2000;
    let job = jobQueue.getStatus(jobId);
    while (job.status !== 'succeeded' && job.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = jobQueue.getStatus(jobId);
    }

    const result = jobQueue.getResult(jobId);
    expect(result.files.some((f) => f.type === 'bom_csv')).toBe(true);
    expect(result.files.some((f) => f.type === 'assembly_json')).toBe(false);
  });
});
