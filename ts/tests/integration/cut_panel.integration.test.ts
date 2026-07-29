/**
 * v2 cut_panel integration suite (Phase 5 Slice 9a: rebuild/06-plan.md,
 * rebuild/15-mcp-contract.md §4.2). Exercises cut_panel(kind=circle|polygon)
 * via dispatchGraphTool -> evaluate-client.cutPanel -> GraphStore.addCutHole,
 * and the resulting hole's effect on both the flat-pattern resource (DXF)
 * and the actual constructed 3D solid.
 *
 * Scope note: this slice implements kind=circle (an exact center+radius
 * primitive, never tessellated into a polygon anywhere in this pipeline —
 * containment is an exact point-to-line-distance test, and the constructed
 * solid gets a true OCCT circular wire) and kind=polygon (winding-
 * canonicalized automatically). kind=slot and kind=boolean are deferred —
 * see rebuild/06-plan.md's own deferred-scope note for this slice.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart, evaluatePart } from '../../src/v2/graph/evaluate-client';
import { readGraphResource } from '../../src/v2/resources/graph';
import { startV2BlobServer } from '../../src/v2/blob-server';
import { geometryBinding } from '../../src/geometry/binding';
import { McpToolError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface CutPanelResult {
  part_id: string;
  region_panel_id: string;
}

function createRectPart(store: GraphStore, name: string): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name,
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ],
    thickness_mm: 2.0,
  }) as CreatePartResult;
}

function cutCircle(
  store: GraphStore,
  partId: string,
  center: { x: number; y: number },
  radiusMm: number,
): CutPanelResult {
  return dispatchGraphTool(store, 'cut_panel', {
    part_id: partId,
    kind: 'circle',
    circle: { center, radius_mm: radiusMm },
  }) as CutPanelResult;
}

function cutPolygon(
  store: GraphStore,
  partId: string,
  ring: Array<{ x: number; y: number }>,
): CutPanelResult {
  return dispatchGraphTool(store, 'cut_panel', {
    part_id: partId,
    kind: 'polygon',
    polygon_ring: ring,
  }) as CutPanelResult;
}

function catchToolError(fn: () => void): McpToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(McpToolError);
    return err as McpToolError;
  }
  throw new Error('expected fn() to throw');
}

interface Ref {
  url: string;
  contentType: string;
  byteSize: number;
  expiresAt: string;
}

interface FlatPatternResult {
  outline: Array<{ x: number; y: number }>;
  holes: Array<
    | { kind: 'circle'; center: { x: number; y: number }; radiusMm: number }
    | { kind: 'polygon'; ring: Array<{ x: number; y: number }> }
  >;
  ref: Ref;
}

function readFlatPattern(store: GraphStore, partId: string): FlatPatternResult {
  return readGraphResource(store, `graph://part/${partId}/flat-pattern`) as FlatPatternResult;
}

async function fetchDxf(flat: FlatPatternResult): Promise<string> {
  const response = await fetch(flat.ref.url);
  return response.text();
}

d('[v2] cut_panel (Phase 5 Slice 9a) — success cases', () => {
  let server: Server;
  const originalPort = process.env['V2_BLOB_PORT'];

  beforeAll(() => {
    server = startV2BlobServer(0);
    const port = (server.address() as AddressInfo).port;
    process.env['V2_BLOB_PORT'] = String(port);
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
    if (originalPort === undefined) delete process.env['V2_BLOB_PORT'];
    else process.env['V2_BLOB_PORT'] = originalPort;
  });

  it('kind=circle: stores an exact center+radius hole, visible in the flat pattern as a DXF CIRCLE', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-circle');

    const result = cutCircle(store, part.part_id, { x: 20, y: 30 }, 5.0);
    expect(result.part_id).toBe(part.part_id);
    expect(result.region_panel_id).toBe(part.root_region_panel_id);

    const flat = readFlatPattern(store, part.part_id);
    expect(flat.holes).toEqual([{ kind: 'circle', center: { x: 20, y: 30 }, radiusMm: 5.0 }]);
    const dxf = await fetchDxf(flat);
    expect(dxf).toContain('CIRCLE');
    expect(dxf).toContain('CUTS');
  });

  it('kind=polygon: canonicalizes winding, visible in the flat pattern as a DXF LWPOLYLINE on CUTS', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-polygon');

    cutPolygon(store, part.part_id, [
      { x: 60, y: 20 },
      { x: 70, y: 20 },
      { x: 70, y: 30 },
      { x: 60, y: 30 },
    ]);

    const flat = readFlatPattern(store, part.part_id);
    expect(flat.holes.length).toBe(1);
    expect(flat.holes[0]?.kind).toBe('polygon');
    const dxf = await fetchDxf(flat);
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf).toContain('CUTS');
  });

  it('the constructed 3D solid has both holes actually punched out (measurably reduced volume)', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-volume');
    cutCircle(store, part.part_id, { x: 20, y: 30 }, 5.0);
    cutPolygon(store, part.part_id, [
      { x: 60, y: 20 },
      { x: 70, y: 20 },
      { x: 70, y: 30 },
      { x: 60, y: 30 },
    ]);

    const constructed = constructPart(store, part.part_id);
    expect(constructed.ok).toBe(true);
    const volume = geometryBinding.computeMassProperties(constructed.shellId, ['volume']).volume;

    const circleAreaMm2 = Math.PI * 5.0 * 5.0;
    const polygonAreaMm2 = 10.0 * 10.0;
    const expectedVolume = (100.0 * 60.0 - circleAreaMm2 - polygonAreaMm2) * 2.0;
    expect(volume).toBeCloseTo(expectedVolume, 0);
  });

  it('a hole in a bent part is assigned to the correct region panel only', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-bent');
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 60 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    // Well within the child (x>50) side.
    const result = cutCircle(store, part.part_id, { x: 70, y: 30 }, 5.0);

    const evaluated = evaluatePart(store, part.part_id);
    expect(evaluated.ok).toBe(true);
    for (const panel of evaluated.panels) {
      if (panel.regionPanelId === result.region_panel_id) {
        expect(panel.regionCircleHoles.length).toBe(1);
      } else {
        expect(panel.regionCircleHoles.length).toBe(0);
      }
    }
  });
});

d('[v2] cut_panel (Phase 5 Slice 9a) — rejection cases', () => {
  it('rejects a hole outside every region panel with GE_CUT_HOLE_NOT_CONTAINED', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-outside');

    const err = catchToolError(() => cutCircle(store, part.part_id, { x: 500, y: 500 }, 5.0));
    expect(err.structured.code).toBe('GE_CUT_HOLE_NOT_CONTAINED');
  });

  it('rejects a circle that crosses a region panel edge with GE_CUT_HOLE_NOT_CONTAINED', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-crossing');

    const err = catchToolError(() => cutCircle(store, part.part_id, { x: 2, y: 30 }, 5.0));
    expect(err.structured.code).toBe('GE_CUT_HOLE_NOT_CONTAINED');
  });

  it('rejects a non-positive circle radius with GE_DEGENERATE_OUTLINE', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-bad-radius');

    const err = catchToolError(() => cutCircle(store, part.part_id, { x: 20, y: 30 }, 0));
    expect(err.structured.code).toBe('GE_DEGENERATE_OUTLINE');
  });

  it('rejects a polygon hole not contained by any region panel with GE_CUT_HOLE_NOT_CONTAINED', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-polygon-outside');

    const err = catchToolError(() =>
      cutPolygon(store, part.part_id, [
        { x: 500, y: 500 },
        { x: 510, y: 500 },
        { x: 510, y: 510 },
        { x: 500, y: 510 },
      ]),
    );
    expect(err.structured.code).toBe('GE_CUT_HOLE_NOT_CONTAINED');
  });

  it('rejects a degenerate (<3-vertex) polygon ring with GE_DEGENERATE_OUTLINE', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'cut-degenerate-polygon');

    const err = catchToolError(() =>
      cutPolygon(store, part.part_id, [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ]),
    );
    expect(err.structured.code).toBe('GE_DEGENERATE_OUTLINE');
  });

  it('rejects a nonexistent part_id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    const err = catchToolError(() => cutCircle(store, 'does-not-exist', { x: 0, y: 0 }, 1.0));
    expect(err.structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });
});
