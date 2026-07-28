/**
 * v2 port of the "make v2 manually testable" work (2026-07-27):
 * graph://part/{id}/mesh — a tessellated GLB of the part's constructed 3D
 * solid, served as a Ref (15 §3.0) at a STABLE per-part HTTP URL. Uses the
 * already-working constructPart (ts/src/v2/graph/evaluate-client.ts) +
 * geometryBinding.exportGlb (real C++, cpp/src/geometry/geometry_service_export.cc)
 * — no new C++ needed.
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

const GLB_MAGIC = 0x46546c67; // 'glTF'

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

interface MeshResult {
  partId: string;
  ref: Ref;
}

function readMesh(store: GraphStore, partId: string): MeshResult {
  return readGraphResource(store, `graph://part/${partId}/mesh`) as MeshResult;
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

d('[v2] graph://part/{id}/mesh (Ref-served GLB)', () => {
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

  it('returns a well-formed Ref pointing at a real, fetchable GLB', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'mesh-single');

    const result = readMesh(store, part.part_id);
    expect(result.partId).toBe(part.part_id);
    expect(result.ref.contentType).toBe('model/gltf-binary');
    expect(result.ref.byteSize).toBeGreaterThan(0);

    const response = await fetch(result.ref.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('model/gltf-binary');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(result.ref.byteSize);
    expect(bytes.readUInt32LE(0)).toBe(GLB_MAGIC);
  });

  it('re-reading an unchanged part yields the same URL (cache reuse, no rebuild)', () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'mesh-cached');

    const first = readMesh(store, part.part_id);
    const second = readMesh(store, part.part_id);
    expect(second.ref.url).toBe(first.ref.url);
  });

  it('mutating the part keeps the URL stable but changes the served bytes', async () => {
    const store = new GraphStore();
    const part = createRectPart(store, 'mesh-mutated');

    const before = readMesh(store, part.part_id);
    const bytesBefore = Buffer.from(await fetch(before.ref.url).then((r) => r.arrayBuffer()));

    dispatchGraphTool(store, 'move_edge', {
      part_id: part.part_id,
      vertex_range: { start_index: 0, end_index: 0 },
      new_points: [{ x: -3, y: -3 }],
    });

    const after = readMesh(store, part.part_id);
    expect(after.ref.url).toBe(before.ref.url);

    const bytesAfter = Buffer.from(await fetch(after.ref.url).then((r) => r.arrayBuffer()));
    expect(bytesAfter.equals(bytesBefore)).toBe(false);
  });

  it('rejects a nonexistent part_id with GRAPH_PART_NOT_FOUND', () => {
    const store = new GraphStore();
    let caught: unknown;
    try {
      readMesh(store, 'does-not-exist');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GRAPH_PART_NOT_FOUND');
  });
});
