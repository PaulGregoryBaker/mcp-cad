/**
 * v2 geometry blob HTTP server — serves whatever `v2BlobCache` currently
 * holds under a stable key (`mesh/{part_id}/{params}`, `boundary/{part_id}/{params}`).
 * Never re-derives geometry itself; that only happens in the resource-read
 * handlers (ts/src/v2/resources/graph.ts) via `v2BlobCache.getOrRebuild`.
 * Mirrors v1's ts/src/mesh/server.ts in shape.
 */

import * as http from 'node:http';
import { v2BlobCache } from './blob-cache';
import type { GraphStore } from './graph/store';
import { evaluatePart, constructPart } from './graph/evaluate-client';
import { geometryBinding } from '../geometry/binding';

const V2_BLOB_ROUTE = /^\/v2-blob\/(.+)$/;
const DEBUG_CONSTRUCT_ROUTE = /^\/v2-blob\/_debug\/construct\/([^/]+)$/;
const DEBUG_EVALUATE_ROUTE = /^\/v2-blob\/_debug\/evaluate\/([^/]+)$/;
const DEBUG_MANIFOLD_ROUTE = /^\/v2-blob\/_debug\/manifold\/([^/]+)$/;

export function startV2BlobServer(port: number, store?: GraphStore): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // No keep-alive: this is a local, short-lived blob endpoint (a single
    // request per part refresh, never a stream of rapid requests on one
    // connection) — keeping sockets alive only risks leaving handles open
    // past a caller's own server.close(), with no real throughput benefit
    // for this traffic pattern.
    res.setHeader('Connection', 'close');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }

    // Debug-only introspection: lists every currently-live blob key
    // (mesh/boundary/flat-pattern per part_id) so a caller outside the
    // running process can find a part's current mesh without already
    // knowing its id — the session's own part ids change on every graph
    // mutation, and there is no other way to enumerate them from outside.
    if (req.url === '/v2-blob/_debug/keys') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: v2BlobCache.keys() }));
      return;
    }

    // Debug-only: runs evaluatePart/constructPart against the LIVE session
    // store for one part id and returns the real result (ok/errorCode/
    // message), or the caught error if the call throws — so a caller outside
    // the running process can see WHY a part's mesh failed to build (a
    // missing mesh blob alone only shows THAT it failed, not why: mesh
    // resource generation never caches a failed build).
    const debugConstructMatch = req.url?.match(DEBUG_CONSTRUCT_ROUTE);
    const debugEvaluateMatch = req.url?.match(DEBUG_EVALUATE_ROUTE);
    if (debugConstructMatch || debugEvaluateMatch) {
      if (!store) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NO_STORE_ATTACHED' }));
        return;
      }
      const partId = decodeURIComponent((debugConstructMatch ?? debugEvaluateMatch)![1]);
      try {
        const result = debugConstructMatch
          ? constructPart(store, partId)
          : evaluatePart(store, partId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          threw: true,
          message: err?.message ?? String(err),
          structured: err?.structured ?? undefined,
        }));
      }
      return;
    }

    // Debug-only: checks the REAL B-Rep solid's own topology (not the
    // tessellated mesh a viewer draws) — a manifold, non-self-intersecting
    // solid here rules out a genuine construction defect and points instead
    // at how a viewer tessellates/highlights a small feature (e.g. a small
    // bend radius's own facet edges all being drawn, making a correct small
    // fillet look tangled) as the source of a visual complaint.
    const debugManifoldMatch = req.url?.match(DEBUG_MANIFOLD_ROUTE);
    if (debugManifoldMatch) {
      if (!store) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NO_STORE_ATTACHED' }));
        return;
      }
      const partId = decodeURIComponent(debugManifoldMatch[1]);
      try {
        const constructed = constructPart(store, partId);
        if (!constructed.ok) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ constructOk: false, constructed }));
          return;
        }
        const manifold = geometryBinding.checkManifold(constructed.shellId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ constructOk: true, manifold }));
      } catch (err: any) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ threw: true, message: err?.message ?? String(err) }));
      }
      return;
    }

    const match = req.url?.match(V2_BLOB_ROUTE);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const key = decodeURIComponent(match[1]);
    const entry = v2BlobCache.get(key);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'BLOB_NOT_FOUND', key }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': entry.buffer.length,
      // The blob at this stable URL is mutable server-side (rebuilt in place
      // on the next drift check or resource read) — a browser/HTTP cache
      // must never mask a just-updated blob under the same URL.
      'Cache-Control': 'no-store',
    });
    res.end(entry.buffer);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[v2-blob-server] Port ${port} is already in use — blob server will not start. ` +
          `Kill the previous process or set V2_BLOB_PORT to a free port.`,
      );
    } else {
      console.error('[v2-blob-server] Unexpected error:', err);
    }
  });

  server.listen(port);
  return server;
}
