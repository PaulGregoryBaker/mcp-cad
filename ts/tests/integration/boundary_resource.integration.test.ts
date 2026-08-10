/**
 * v2 port of the "make v2 manually testable" work (2026-07-27):
 * graph://part/{id}/boundary — exact 3D point-array geometry (13 §3.3, no
 * tessellation), served as a Ref (15 §3.0) at a STABLE per-part HTTP URL
 * (not re-minted on every edit — Paul's correction to the original
 * content-hash-in-URL design: the URL should stay stable so a client never
 * has to track "which URL is current," and instead gets told to re-fetch via
 * a real MCP resource-update push, tested separately in
 * mesh_subscription.integration.test.ts).
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';
import { startV2BlobServer } from '../../src/v2/blob-server';
import { McpToolError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface CreateBendResult {
  bend_id: string;
  child_region_panel_id: string;
}

interface Ref {
  url: string;
  contentType: string;
  byteSize: number;
  expiresAt: string;
}

interface BoundaryResult {
  partId: string;
  ref: Ref;
}

function readBoundary(store: GraphStore, partId: string): BoundaryResult {
  return readGraphResource(store, `graph://part/${partId}/boundary`) as BoundaryResult;
}

function createRectPart(store: GraphStore, name: string): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name,
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ],
    thickness_mm: 1.0,
  }) as CreatePartResult;
}

d('[v2] graph://part/{id}/boundary (Ref-served exact geometry)', () => {
  let server: Server;
  const originalPort = process.env['V2_BLOB_PORT'];

  beforeAll(() => {
    server = startV2BlobServer(0);
    const port = (server.address() as AddressInfo).port;
    process.env['V2_BLOB_PORT'] = String(port);
  });

  afterAll(() => {
    // closeAllConnections forcibly destroys any sockets still open (fetch's
    // own keep-alive pooling can hold one past the last response) — without
    // it, server.close() waits indefinitely for a socket that's never
    // reused, hanging the whole worker process past test completion.
    server.closeAllConnections();
    server.close();
    if (originalPort === undefined) delete process.env['V2_BLOB_PORT'];
    else process.env['V2_BLOB_PORT'] = originalPort;
  });

  it('returns a well-formed Ref and the blob is fetchable', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'boundary-single');

    const result = readBoundary(store, part.part_id);
    expect(result.partId).toBe(part.part_id);
    expect(result.ref.contentType).toBe('application/json');
    expect(result.ref.byteSize).toBeGreaterThan(0);
    expect(new Date(result.ref.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const response = await fetch(result.ref.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.text();
    expect(Buffer.byteLength(body, 'utf8')).toBe(result.ref.byteSize);

    const parsed = JSON.parse(body) as {
      partId: string;
      regionPanels: Array<{ regionPanelId: string; bottomFace: unknown[]; topFace: unknown[] }>;
      bridges: unknown[];
    };
    expect(parsed.partId).toBe(part.part_id);
    expect(parsed.regionPanels).toHaveLength(1);
    expect(parsed.regionPanels[0]?.bottomFace.length).toBeGreaterThan(0);
    expect(parsed.regionPanels[0]?.topFace.length).toBe(parsed.regionPanels[0]?.bottomFace.length);
    expect(parsed.bridges).toEqual([]);
  });

  it('re-reading an unchanged part yields the same URL and identical bytes (cache reuse)', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'boundary-cached');

    const first = readBoundary(store, part.part_id);
    const second = readBoundary(store, part.part_id);
    expect(second.ref.url).toBe(first.ref.url);

    const [bodyA, bodyB] = await Promise.all([
      fetch(first.ref.url).then((r) => r.text()),
      fetch(second.ref.url).then((r) => r.text()),
    ]);
    expect(bodyB).toBe(bodyA);
  });

  it('mutating the part keeps the URL stable but changes the served bytes', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'boundary-mutated');

    const before = readBoundary(store, part.part_id);
    const bodyBefore = await fetch(before.ref.url).then((r) => r.text());

    dispatchGraphTool(store, 'move_edge', {
      part_id: part.part_id,
      vertex_range: { start_index: 0, end_index: 0 },
      new_points: [{ x: -3, y: -3 }],
    });

    const after = readBoundary(store, part.part_id);
    expect(after.ref.url).toBe(before.ref.url); // stable key — no new URL minted per edit

    const bodyAfter = await fetch(after.ref.url).then((r) => r.text());
    expect(bodyAfter).not.toBe(bodyBefore); // but the content behind that URL changed
  });

  // docs/BUG_REPORT_boundary_resource_disagrees_with_mesh_after_collar_fix.md:
  // a nonzero bend radius left boundary reporting the parent panel's
  // bend-adjacent corners BA/2 short of the true hinge, while the actual
  // mesh solid (this session's earlier fix) correctly reaches it. Real
  // end-to-end coverage through the addon, not a direct C++ unit test —
  // this exact bug class (a NAPI-crossing field silently not round-tripping)
  // was found only by testing this way earlier in the same session.
  it('a nonzero bend radius: the parent panel\'s bend-adjacent corners land exactly on the raw hinge, not BA/2 short', async () => {
    const store = new GraphStore();
    const part = dispatchGraphTool(store, 'create_part', {
      name: 'boundary-true-face',
      outline: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 20 },
        { x: 0, y: 20 },
      ],
      thickness_mm: 2.0,
    }) as CreatePartResult;

    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: part.part_id,
      parent_region_panel_id: part.root_region_panel_id,
      hinge_a: { x: 50, y: 0 },
      hinge_b: { x: 50, y: 20 },
      angle_deg: 90,
      radius_mm: 1.5,
      k_factor: 0.4,
    }) as CreateBendResult;

    const result = readBoundary(store, part.part_id);
    const body = await fetch(result.ref.url).then((r) => r.text());
    const parsed = JSON.parse(body) as {
      regionPanels: Array<{
        regionPanelId: string;
        bottomFace: Array<{ x: number; y: number; z: number }>;
        topFace: Array<{ x: number; y: number; z: number }>;
      }>;
    };

    const rootPanel = parsed.regionPanels.find(
      (p) => p.regionPanelId === part.root_region_panel_id,
    );
    expect(rootPanel).toBeDefined();

    // The un-fixed value would be x=50-BA/2≈48.19 (BA/2 = (pi/2)*(1.5+0.4*2)/2
    // ≈ 1.81); the fixed value lands exactly on the raw hinge, x=50.
    const nearHinge = [...rootPanel!.bottomFace, ...rootPanel!.topFace].filter(
      (p) => p.x > 40 && p.x < 55,
    );
    expect(nearHinge.length).toBeGreaterThan(0);
    for (const p of nearHinge) {
      expect(p.x).toBeCloseTo(50, 6);
    }
  });

  it('rejects a nonexistent part_id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    let caught: unknown;
    try {
      readBoundary(store, 'does-not-exist');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });
});
