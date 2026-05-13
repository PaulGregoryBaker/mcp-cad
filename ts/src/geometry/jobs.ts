/**
 * Async export job queue — in-process Promise queue.
 * Designed for future BullMQ migration (Constitution Principle IX).
 *
 * Tasks: T099, T100
 */

import { randomUUID } from 'crypto';
import type { ManufacturingConfig } from '../config/loader';
import { ErrorCodes, throwError } from '../mcp/errors';

// ─── Export types ─────────────────────────────────────────────────────────────

export interface ExportFile {
  type: 'dxf' | 'step' | 'bom_csv' | 'assembly_json' | 'svg_preview';
  path: string;
  sizeBytes: number;
}

export interface ExportResult {
  jobId: string;
  files: ExportFile[];
  totalTimeMs: number;
}

export interface ExportJob {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  createdAt: number;
  completedAt?: number;
  result?: ExportResult;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggestedTool?: string;
  };
}

export interface ExportParams {
  nestId: string;
  includeBom: boolean;
  includeAssembly: boolean;
  config: ManufacturingConfig;
}

// ─── Job queue ────────────────────────────────────────────────────────────────

class InProcessJobQueue {
  private readonly jobs: Map<string, ExportJob> = new Map();

  /**
   * Enqueues an export job and begins processing asynchronously.
   * Returns job_id immediately (Constitution Principle IX).
   */
  enqueue(params: ExportParams): string {
    const jobId = randomUUID();
    const job: ExportJob = {
      jobId,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };

    this.jobs.set(jobId, job);

    // Start processing asynchronously — do not await
    void this.processJob(jobId, params);

    return jobId;
  }

  getStatus(jobId: string): ExportJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throwError(
        ErrorCodes.EXPORT_JOB_NOT_FOUND,
        `Export job not found: ${jobId}`,
        false,
      );
    }
    return job;
  }

  getResult(jobId: string): ExportResult {
    const job = this.getStatus(jobId);
    if (job.status !== 'succeeded') {
      throwError(
        ErrorCodes.EXPORT_JOB_NOT_COMPLETE,
        `Export job ${jobId} is not yet complete (status: ${job.status}). Call get_export_job_status first.`,
        true,
        'get_export_job_status',
      );
    }
    if (job.result === undefined) {
      throwError(ErrorCodes.INTERNAL_ERROR, `Job ${jobId} succeeded but has no result`, false);
    }
    return job.result!;
  }

  private async processJob(jobId: string, params: ExportParams): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;

    try {
      job.status = 'running';
      job.progress = 10;

      const startTime = Date.now();

      // Simulate DXF generation phases
      await this.sleep(50);  // Phase: DXF wire generation
      job.progress = 30;

      await this.sleep(50);  // Phase: STEP assembly
      job.progress = 50;

      const files: ExportFile[] = [
        { type: 'dxf', path: `exports/${jobId}/sheet_01.dxf`, sizeBytes: 48_000 },
      ];

      if (params.includeBom) {
        await this.sleep(20);
        job.progress = 70;
        files.push({ type: 'bom_csv', path: `exports/${jobId}/bom.csv`, sizeBytes: 1_200 });
      }

      if (params.includeAssembly) {
        await this.sleep(20);
        job.progress = 85;
        files.push({
          type: 'assembly_json',
          path: `exports/${jobId}/assembly.json`,
          sizeBytes: 3_400,
        });
      }

      // SVG preview always included
      files.push({ type: 'svg_preview', path: `exports/${jobId}/nest_preview.svg`, sizeBytes: 8_200 });

      job.progress = 100;
      job.status = 'succeeded';
      job.completedAt = Date.now();
      job.result = {
        jobId,
        files,
        totalTimeMs: Date.now() - startTime,
      };

    } catch (err) {
      job.status = 'failed';
      job.completedAt = Date.now();
      job.error = {
        code: ErrorCodes.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton job queue
export const jobQueue = new InProcessJobQueue();
