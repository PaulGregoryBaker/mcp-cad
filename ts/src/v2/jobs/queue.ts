/**
 * v2 async job queue — in-process Promise queue (Slice 11).
 *
 * Reuses the existing InProcessJobQueue pattern from ts/src/geometry/jobs.ts
 * but with v2-specific job types.  A future BullMQ migration would replace
 * only the implementation, not the interface.
 */

import { randomUUID } from 'node:crypto';
import type { Point2 } from '../graph/types';
import { toStructuredError } from '../../mcp/errors';

// ─── Job types ───────────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface V2Job {
  jobId: string;
  status: JobStatus;
  progress: number;       // 0–100
  createdAt: number;
  completedAt?: number;
  result?: unknown;       // job-type-specific result
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestedTool?: string;
  };
}

export interface NestingResult {
  placements: Array<{
    partId: string;
    copyIndex: number;
    sheetIndex: number;
    x: number;
    y: number;
    rotationDeg: number;
    outline: Point2[];
    holes: Point2[][];
    circleHoles: Array<{ cx: number; cy: number; radiusMm: number }>;
  }>;
  utilisationPct: number;
  sheetsRequired: number;
}

// ─── Queue ──────────────────────────────────────────────────────────────────

class V2JobQueue {
  private readonly jobs: Map<string, V2Job> = new Map();

  enqueue(executor: () => Promise<unknown>): string {
    const jobId = randomUUID();
    const job: V2Job = {
      jobId,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    void this.processJob(jobId, executor);
    return jobId;
  }

  getJob(jobId: string): V2Job | null {
    return this.jobs.get(jobId) ?? null;
  }

  private async processJob(jobId: string, executor: () => Promise<unknown>): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    try {
      job.status = 'running';
      job.progress = 10;
      job.result = await executor();
      job.status = 'succeeded';
      job.progress = 100;
      job.completedAt = Date.now();
    } catch (err) {
      job.status = 'failed';
      job.progress = 0;
      job.completedAt = Date.now();
      // Preserve the structured error (typed code, e.g. NEST_INVALID_CUTTING_WIDTH)
      // instead of collapsing every failure to INTERNAL_ERROR — get_job forwards
      // job.error opaquely, so the wire must already carry the right code.
      job.error = toStructuredError(err);
    }
  }
}

export const v2JobQueue = new V2JobQueue();
