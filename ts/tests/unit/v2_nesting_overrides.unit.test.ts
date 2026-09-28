/**
 * T073 (spec 010 FR-027): simulate_nesting and export_production_pack take the
 * project's nesting settings per call (sheet, kerf, gap, margin, rotations),
 * overriding config.yaml's defaults; omitted values fall back to them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { geometryBinding } from '../../src/geometry/binding';
import { getNestingConfig } from '../../src/config/loader';
import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { v2JobQueue } from '../../src/v2/jobs/queue';

const RECT = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

async function settle(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const j = v2JobQueue.getJob(jobId)!;
    if (j.status === 'succeeded' || j.status === 'failed') return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

function setup() {
  const store = new GraphStore();
  const { part_id } = dispatchGraphTool(store, 'create_part', { name: 'p', outline: RECT, thickness_mm: 2 }) as { part_id: string };
  const spy = vi.spyOn(geometryBinding, 'nestPolygons').mockReturnValue({
    ok: true,
    errorCode: '',
    message: '',
    placements: [{ id: part_id, copyIndex: 0, sheetIndex: 0, x: 0, y: 0, rotationDeg: 0, outline: RECT, holes: [], circleHoles: [] }],
    utilisationPct: 10,
    sheetsRequired: 1,
  } as never);
  return { store, part_id, spy };
}

describe('[persist] nesting overrides', () => {
  afterEach(() => vi.restoreAllMocks());

  const overrides = { sheet_width_mm: 3000, sheet_height_mm: 1500, cutting_width_mm: 0.1, safety_gap_mm: 4, sheet_margin_mm: 12, rotations_deg: [0, 180] };

  for (const tool of ['simulate_nesting', 'export_production_pack']) {
    it(`${tool}: the call's settings reach nestPolygons`, async () => {
      const { store, part_id, spy } = setup();
      const { job_id } = (await dispatchGraphTool(store, tool, { part_ids: [part_id], ...overrides })) as { job_id: string };
      expect((await settle(job_id)).status).toBe('succeeded');
      const [, w, h, opts] = spy.mock.calls[0]!;
      expect([w, h]).toEqual([3000, 1500]);
      expect(opts).toMatchObject({ cuttingWidthMm: 0.1, safetyGapMm: 4, sheetMarginMm: 12, rotationsDeg: [0, 180] });
    });

    it(`${tool}: omitted settings fall back to config.yaml`, async () => {
      const { store, part_id, spy } = setup();
      const cfg = getNestingConfig();
      const { job_id } = (await dispatchGraphTool(store, tool, { part_ids: [part_id] })) as { job_id: string };
      expect((await settle(job_id)).status).toBe('succeeded');
      const [, w, h, opts] = spy.mock.calls[0]!;
      expect([w, h]).toEqual([2440, 1220]);
      expect(opts).toMatchObject({ cuttingWidthMm: cfg.cuttingWidthMm, safetyGapMm: cfg.safetyGapMm, sheetMarginMm: cfg.sheetMarginMm, rotationsDeg: cfg.rotationsDeg });
    });

    it(`${tool}: a kerf beyond the tooling limit fails the job with NEST_INVALID_CUTTING_WIDTH`, async () => {
      const { store, part_id, spy } = setup();
      const { job_id } = (await dispatchGraphTool(store, tool, { part_ids: [part_id], cutting_width_mm: 99 })) as { job_id: string };
      const job = await settle(job_id);
      expect(job.status).toBe('failed');
      expect(JSON.stringify(job.error)).toContain('NEST_INVALID_CUTTING_WIDTH');
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it('rotations other than quarter turns are rejected up front', () => {
    const { store, part_id } = setup();
    expect(() => dispatchGraphTool(store, 'simulate_nesting', { part_ids: [part_id], rotations_deg: [45] })).toThrow();
  });
});
