/**
 * v2 flat-pattern resource integration suite (Phase 5 Slice 7:
 * rebuild/06-plan.md, rebuild/15-mcp-contract.md §4.4, rebuild/13-translation-
 * module-design.md §3.3). Exercises graph://part/{id}/flat-pattern —
 * readGraphResource -> evaluatePart/store.snapshotPart -> buildFlatPatternDxf.
 *
 * Slice 7 scope note: a 2026-07-25 inventory of v1's non-v2 integration test
 * files found 26 depend on unfold/DXF export vs 0 on get_drawings and only 2
 * on validation/findings tools — so this slice implements flat-pattern only;
 * drawings and findings resources are deferred to a later slice (same
 * "unblock the most real test-coverage migration" discipline Slice 6 used
 * for fuse_bodies/remove_protrusions).
 *
 * Unlike v1 (per-panel get_unfold, requiring a panel_id), a v2 part's flat
 * pattern is ONE cut boundary — the part's own outline (14 §0: region panels
 * are derived clips of the one shared outline, not separate cut pieces) —
 * so there is no per-panel DXF to reassemble; this suite's oracles reflect
 * that directly rather than mirroring v1's per-panel shape.
 *
 * `dxf` is served as a `Ref` (15 §3.0/§3.3), not inline — added 2026-07-28
 * once the blob-cache infra existed (Slice 7b); mirrors
 * boundary_resource.integration.test.ts's blob-server setup for fetching it.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';
import { startV2BlobServer } from '../../src/v2/blob-server';
import { McpToolError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface Ref {
  url: string;
  contentType: string;
  byteSize: number;
  expiresAt: string;
}

interface FlatPatternResult {
  partId: string;
  thicknessMm: number;
  kFactor: number;
  outline: Array<{ x: number; y: number }>;
  regionPanels: Array<{ regionPanelId: string; outer: Array<{ x: number; y: number }> }>;
  bendLines: Array<{
    bendId: string;
    hingeA: { x: number; y: number };
    hingeB: { x: number; y: number };
    angleDeg: number;
    radiusMm: number;
  }>;
  ref: Ref;
}

function readFlatPattern(store: GraphStore, partId: string): FlatPatternResult {
  return readGraphResource(store, `graph://part/${partId}/flat-pattern`) as FlatPatternResult;
}

async function fetchDxf(flat: FlatPatternResult): Promise<string> {
  const response = await fetch(flat.ref.url);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/dxf');
  return response.text();
}

function shoelaceArea(ring: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

d('[v2] flat-pattern resource (Phase 5 Slice 7)', () => {
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

  it('single-panel part (no bends): flat pattern is exactly the part outline, no bend lines', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'flat-single',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 2.0,
    }) as CreatePartResult;

    const flat = readFlatPattern(store, part.part_id);
    expect(flat.partId).toBe(part.part_id);
    expect(flat.thicknessMm).toBe(2.0);
    expect(flat.outline).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ]);
    expect(flat.regionPanels.length).toBe(1);
    expect(flat.regionPanels[0]?.outer).toEqual(flat.outline);
    expect(flat.bendLines).toEqual([]);
    const dxf = await fetchDxf(flat);
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf).not.toContain('BEND');
  });

  it('two-panel part (one bend): bend line matches the hinge, region panels split around it', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'flat-bent',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 5, y: 0 },
      hinge_b: { x: 5, y: 5 },
      angle_deg: 90,
      radius_mm: 1.0,
    });

    const flat = readFlatPattern(store, part.part_id);
    // docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md: the net
    // now GROWS by the bend's own real allowance (BA = angleRad*(radiusMm +
    // kFactor*thicknessMm), kFactor defaults to 0 here) — the whole point of
    // the fix, and the literal cut boundary a manufacturer uses. It is no
    // longer the part's raw authored outline unchanged.
    const ba = (Math.PI / 2) * (1.0 + 0.0 * 1.0);
    expect(flat.outline).toHaveLength(4);
    const outlineXs = flat.outline.map((p) => p.x).sort((a, b) => a - b);
    expect(outlineXs[0]).toBeCloseTo(-ba, 9);
    expect(outlineXs[outlineXs.length - 1]).toBeCloseTo(10, 9);
    expect(flat.regionPanels.length).toBe(2);
    expect(flat.bendLines.length).toBe(1);
    // Bug #2: the reported bend line is the ZONE'S CENTER, not its raw
    // (start-of-zone) mark — this bend is directly off the root (zero
    // ancestor shift), so the center is exactly the raw mark minus half
    // the bend's own allowance (nLeft points toward -x here).
    expect(flat.bendLines[0]?.hingeA.x).toBeCloseTo(5 - ba / 2, 9);
    expect(flat.bendLines[0]?.hingeA.y).toBeCloseTo(0, 9);
    expect(flat.bendLines[0]?.hingeB.x).toBeCloseTo(5 - ba / 2, 9);
    expect(flat.bendLines[0]?.hingeB.y).toBeCloseTo(5, 9);
    expect(flat.bendLines[0]?.angleDeg).toBe(90);
    const dxf = await fetchDxf(flat);
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf).toContain('BEND');

    // Each region panel's own area is unaffected by translation, so their
    // combined area is still exactly the two 5x5 rectangles (50mm^2) — but
    // the outline's own area is now bigger by exactly the bend's own flat
    // allowance strip (ba * hinge length), not the old (pre-fix) "clipped
    // past the zone" shrinkage this comment used to describe.
    const outlineArea = shoelaceArea(flat.outline);
    const regionArea = flat.regionPanels.reduce((sum, p) => sum + shoelaceArea(p.outer), 0);
    expect(regionArea).toBeCloseTo(50, 9);
    expect(outlineArea - regionArea).toBeCloseTo(ba * 5, 9);
  });

  it('rejects a nonexistent part_id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    let caught: unknown;
    try {
      readFlatPattern(store, 'does-not-exist');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });

  it('l_bracket_corner_90deg.stp (real fixture): flat pattern reflects the imported bend', async () => {
    const store = new GraphStore();
    const imported = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES_DIR, 'l_bracket_corner_90deg.stp'),
    }) as { part_id: string; panel_count: number; bend_count: number };
    expect(imported.panel_count).toBe(2);
    expect(imported.bend_count).toBe(1);

    const flat = readFlatPattern(store, imported.part_id);
    expect(flat.regionPanels.length).toBe(imported.panel_count);
    expect(flat.bendLines.length).toBe(imported.bend_count);

    const outlineArea = shoelaceArea(flat.outline);
    const regionArea = flat.regionPanels.reduce((sum, p) => sum + shoelaceArea(p.outer), 0);
    expect(outlineArea).toBeGreaterThan(0);
    // A sharp (r=0) fold's bend zone has zero width, so the region panels'
    // combined area can equal the whole outline's exactly (no material is
    // excluded) — unlike the hand-authored radius_mm=1.0 case above, this is
    // <=, not a strict <. regionArea and outlineArea are each a shoelace sum
    // over a DIFFERENT ring (2 separate panel rings vs. 1 combined outline
    // ring), so exact equality lands within a few ULPs, not bit-for-bit —
    // a tiny fixed epsilon (dwarfed by both areas' own ~50000mm^2 scale)
    // absorbs that without hiding any real excess.
    expect(regionArea).toBeLessThanOrEqual(outlineArea + 1e-6);
    expect(regionArea).toBeGreaterThan(0);
    const dxf = await fetchDxf(flat);
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf).toContain('BEND');
  });
});
