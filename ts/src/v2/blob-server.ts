/**
 * v2 geometry blob HTTP server — serves whatever `v2BlobCache` currently
 * holds under a stable key (`mesh/{part_id}/{params}`, `boundary/{part_id}/{params}`).
 * Never re-derives geometry itself; that only happens in the resource-read
 * handlers (ts/src/v2/resources/graph.ts) via `v2BlobCache.getOrRebuild`.
 * Mirrors v1's ts/src/mesh/server.ts in shape.
 */

import * as http from 'node:http';
import { v2BlobCache } from './blob-cache';

const V2_BLOB_ROUTE = /^\/v2-blob\/(.+)$/;

export function startV2BlobServer(port: number): http.Server {
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
