/**
 * v2 port of the "make v2 manually testable" work (2026-07-27): the push
 * half of the stable-URL geometry Ref design. A client that subscribes to
 * graph://part/{id}/mesh gets a real `notifications/resources/updated` push
 * (MCP's own resources/subscribe mechanism, verified against the installed
 * SDK @modelcontextprotocol/sdk@^1.0.0) after a mutation rebuilds the blob at
 * that part's already-known, unchanging URL — no need to re-read the MCP
 * resource to discover a new URL.
 *
 * Drives a real `Server` instance (via `createV2Server`) against a real
 * `Client`, connected over the SDK's own `InMemoryTransport` pair — no
 * process spawn, no mocking of the subscribe/notify machinery itself.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';
import { createV2Server } from '../../src/v2/server';
import { startV2BlobServer } from '../../src/v2/blob-server';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface MeshResult {
  ref: { url: string };
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

function waitForNotification(client: Client, matchUri: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for a notification on ${matchUri}`)),
      timeoutMs,
    );
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      if (n.params.uri === matchUri) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

d(
  '[v2] mesh resource subscription push (resources/subscribe + notifications/resources/updated)',
  () => {
    let blobServer: HttpServer;
    const originalPort = process.env['V2_BLOB_PORT'];

    beforeAll(() => {
      blobServer = startV2BlobServer(0);
      const port = (blobServer.address() as AddressInfo).port;
      process.env['V2_BLOB_PORT'] = String(port);
    });

    afterAll(() => {
      // See boundary_resource/mesh_resource.integration.test.ts's own
      // afterAll comment: without this, server.close() hangs waiting for a
      // socket fetch's own keep-alive pooling left open.
      blobServer.closeAllConnections();
      blobServer.close();
      if (originalPort === undefined) delete process.env['V2_BLOB_PORT'];
      else process.env['V2_BLOB_PORT'] = originalPort;
    });

    let store: GraphStore;
    let server: McpServer;
    let client: Client;

    beforeEach(async () => {
      store = new GraphStore();
      server = createV2Server(store);
      client = new Client({ name: 'test-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    afterEach(async () => {
      await client.close();
      await server.close();
    });

    it('a subscribed client is pushed an update after a mutation, and the stable URL now serves fresh geometry', async () => {
      const part = createRectPart(store, 'sub-mesh');
      const uri = `graph://part/${part.part_id}/mesh`;

      const before = readGraphResource(store, uri) as MeshResult;
      // Captured BEFORE the mutation — before.ref.url and after.ref.url are
      // the same stable URL, so fetching both only after the edit would
      // just read the post-edit blob twice and trivially "match."
      const bytesBefore = Buffer.from(await fetch(before.ref.url).then((r) => r.arrayBuffer()));

      await client.subscribeResource({ uri });
      const notified = waitForNotification(client, uri);

      await client.callTool({
        name: 'move_edge',
        arguments: {
          part_id: part.part_id,
          vertex_range: { start_index: 0, end_index: 0 },
          new_points: [{ x: -3, y: -3 }],
        },
      });

      await notified; // resolves once notifications/resources/updated arrives for this uri

      const after = readGraphResource(store, uri) as MeshResult;
      expect(after.ref.url).toBe(before.ref.url); // stable — no new URL minted

      const bytesAfter = Buffer.from(await fetch(after.ref.url).then((r) => r.arrayBuffer()));
      expect(bytesAfter.equals(bytesBefore)).toBe(false);
    });

    it('an unsubscribed client receives no notification after a mutation', async () => {
      const part = createRectPart(store, 'unsub-mesh');
      const uri = `graph://part/${part.part_id}/mesh`;
      readGraphResource(store, uri); // establish the blob so a rebuild-vs-no-rebuild distinction is meaningful

      const received: string[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        received.push(n.params.uri);
      });
      // deliberately no client.subscribeResource(...) call

      await client.callTool({
        name: 'move_edge',
        arguments: {
          part_id: part.part_id,
          vertex_range: { start_index: 0, end_index: 0 },
          new_points: [{ x: -3, y: -3 }],
        },
      });

      await sleep(300); // generous window for a notification that should never arrive
      expect(received).toEqual([]);
    });
  },
);
