/**
 * v2 geometry blob cache (Phase 5, rebuild/14-graph-schema.md §3.1 "Layer 3").
 *
 * A part's mesh/boundary blob URL is stable per (part_id, resource_type,
 * params) — NOT keyed by content hash — so a client can hold one URL for a
 * part's whole lifetime. The content hash is still computed and stored, but
 * only as an internal freshness check: `getOrRebuild` rebuilds in place under
 * the SAME key when the hash no longer matches, rather than minting a new
 * key/URL per edit. This is a deliberate deviation from 14 §3.1's literal
 * "content hash is part of the key" wording — Paul's correction: content-hash
 * keying pushes "which URL is current" bookkeeping onto the UI, which a
 * stable URL + real MCP resource-update push (see v2/server.ts) avoids.
 *
 * TTL here is a memory-bound backstop for entries nobody's watching anymore
 * (an unbounded number of parts could otherwise accumulate cache entries
 * forever) — it is NOT the staleness mechanism; the content-hash check is.
 */

import { createHash } from 'node:crypto';
import type { GraphStore } from './graph/store';

export interface BlobCacheEntry {
  buffer: Buffer;
  contentType: string;
  builtFromContentHash: string;
  expiresAt: number;
}

export class V2BlobCache {
  private readonly entries = new Map<string, BlobCacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): BlobCacheEntry | undefined {
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    if (existing.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return existing;
  }

  /** Rebuilds ONLY when no entry exists yet, or the stored hash no longer
   * matches `currentContentHash` — otherwise returns the existing entry
   * untouched (same key, same bytes, TTL not renewed just by reading it). */
  getOrRebuild(
    key: string,
    contentType: string,
    currentContentHash: string,
    build: () => Buffer,
  ): BlobCacheEntry {
    const existing = this.get(key);
    if (existing && existing.builtFromContentHash === currentContentHash) {
      return existing;
    }
    const entry: BlobCacheEntry = {
      buffer: build(),
      contentType,
      builtFromContentHash: currentContentHash,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.entries.set(key, entry);
    return entry;
  }
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export const v2BlobCache = new V2BlobCache(
  Number(process.env['V2_BLOB_TTL_MS'] ?? String(DEFAULT_TTL_MS)),
);

export function resolveV2BlobPort(): number {
  return Number(process.env['V2_BLOB_PORT'] ?? '3101');
}

/** Hashes exactly the same struct evaluate-client.ts feeds the addon
 * (`store.snapshotPart`) — "same hash" therefore provably means "same addon
 * input," so a cache hit against this hash can never be stale. */
export function computePartContentHash(store: GraphStore, partId: string): string {
  const snapshot = store.snapshotPart(partId);
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export type V2BlobResourceType = 'mesh' | 'boundary';

export function buildBlobCacheKey(
  partId: string,
  resourceType: V2BlobResourceType,
  paramsKey: string,
): string {
  return `${resourceType}/${partId}/${paramsKey}`;
}

export function buildV2BlobUrl(key: string): string {
  return `http://localhost:${resolveV2BlobPort()}/v2-blob/${key}`;
}
