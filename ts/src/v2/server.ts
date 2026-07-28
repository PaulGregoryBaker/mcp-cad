/**
 * v2 MCP server entry point (Phase 5 Slice 1).
 *
 * A clean-break Server instance and tool/resource registry — no shared
 * namespace with v1's ts/src/index.ts. v2's `create_part`/`create_node` are
 * unrelated tools from v1's same-named-but-differently-shaped `create_part`/
 * `add_bend`; running both servers side by side is safe because each has its
 * own registry and its own in-memory GraphStore.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { toStructuredError } from '../mcp/errors';
import { GraphStore } from './graph/store';
import { graphToolDefinitions, dispatchGraphTool } from './tools/graph';
import {
  graphResourceTemplates,
  matchesGraphResource,
  readGraphResource,
  ensureMeshBlobFresh,
  ensureBoundaryBlobFresh,
} from './resources/graph';
import { startV2BlobServer } from './blob-server';
import { resolveV2BlobPort } from './blob-cache';

const GEOMETRY_RESOURCE_PATTERN = /^graph:\/\/part\/([^/]+)\/(mesh|boundary)$/;

/**
 * Builds a fully wired v2 Server instance (tool/resource handlers, resource
 * subscribe/notify) against the given GraphStore. Exported (rather than only
 * constructed at module load) so tests can drive a real Server instance
 * against a test-controlled store without spawning the stdio process.
 */
export function createV2Server(store: GraphStore = new GraphStore()): Server {
  const server = new Server(
    {
      name: 'mcp-cad-v2',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: { subscribe: true },
        tools: {},
      },
    },
  );

  // ─── Resource subscriptions ──────────────────────────────────────────────
  // stdio transport = one client per process (the "single active session"
  // model already used everywhere else in this project) — a single
  // process-wide Set, no per-connection bookkeeping needed.
  const subscribedUris = new Set<string>();

  server.setRequestHandler(SubscribeRequestSchema, (request: { params: { uri: string } }) => {
    subscribedUris.add(request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, (request: { params: { uri: string } }) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });

  /**
   * After a mutation, rebuild any subscribed mesh/boundary blob whose
   * content hash no longer matches the part's current rows, and push
   * `notifications/resources/updated` for exactly the ones that changed.
   * Iterates `subscribedUris` rather than inspecting the mutating tool's own
   * result — correct regardless of which tool ran (result shapes differ
   * across create_node/merge_bodies_with_bend/cut_panel/etc.), and does zero
   * extra work when nobody is subscribed to anything.
   *
   * Still a synchronous, blocking call when it runs (Node + the native addon
   * are single-threaded — there is no real background thread doing the
   * rebuild; true non-blocking rebuild would need Napi::AsyncWorker on the
   * C++ side, out of scope here). Deferring this to setImmediate only
   * decouples it from the mutating tool's OWN response, which returns
   * immediately, unaffected.
   */
  function checkSubscriptionsForDrift(): void {
    for (const uri of subscribedUris) {
      const match = GEOMETRY_RESOURCE_PATTERN.exec(uri);
      if (!match) continue; // 'full'/'graph://parts' subscriptions: cheap inline JSON, no cache to go stale
      const [, partId, resourceType] = match;
      if (!store.getPart(partId)) continue; // part gone (aliased away) — nothing to rebuild
      try {
        const { changed } =
          resourceType === 'mesh'
            ? ensureMeshBlobFresh(store, partId)
            : ensureBoundaryBlobFresh(store, partId);
        if (changed) {
          void server.notification({ method: 'notifications/resources/updated', params: { uri } });
        }
      } catch {
        // A rebuild failure here (e.g. GE_INVALID_SHEET_METAL after an edit
        // that produced unconstructible geometry) is surfaced to the client
        // on their next explicit resource read, which throws the same
        // structured error readMesh/readBoundary would — no need to also
        // notify of a failed rebuild; there is nothing new to fetch.
      }
    }
  }

  // ─── Tool handlers ──────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: graphToolDefinitions };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      try {
        const toolArgs = request.params.arguments;
        if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
          throw new Error(
            'Tool call requires an explicit arguments object. Pass {} when no arguments are needed.',
          );
        }
        const result = dispatchGraphTool(store, request.params.name, toolArgs);
        setImmediate(checkSubscriptionsForDrift);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        const structured = toStructuredError(err);
        return {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          isError: true,
        };
      }
    },
  );

  // ─── Resource handlers ───────────────────────────────────────────────────

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => {
    return { resourceTemplates: graphResourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, (request: { params: { uri: string } }) => {
    const uri = request.params.uri;

    if (!matchesGraphResource(uri)) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              error: 'RESOURCE_NOT_FOUND',
              message: `Unrecognized v2 resource: ${uri}`,
            }),
          },
        ],
      };
    }

    try {
      const data = readGraphResource(store, uri);
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data) }],
      };
    } catch (err) {
      const structured = toStructuredError(err);
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(structured) }],
      };
    }
  });

  return server;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  startV2BlobServer(resolveV2BlobPort());
  const server = createV2Server();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('v2 MCP server failed to start:', err);
    process.exit(1);
  });
}
