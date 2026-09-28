/**
 * Unit tests for ts/src/v2/blob-cache.ts's V2BlobCache — pure logic, no
 * native addon or GraphStore instance involved. Verifies the two mechanisms
 * that matter for correctness: content-hash-driven rebuild-in-place under a
 * STABLE key (not a new key per edit), and the TTL backstop as an
 * independent, secondary eviction path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2BlobCache } from '../../src/v2/blob-cache';

describe('V2BlobCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getOrRebuild returns the existing entry without calling build when the hash matches', () => {
    const cache = new V2BlobCache(10_000);
    const build = vi.fn(() => Buffer.from('v1'));

    const first = cache.getOrRebuild('k', 'text/plain', 'hash-a', build);
    const second = cache.getOrRebuild('k', 'text/plain', 'hash-a', build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second.buffer.toString()).toBe('v1');
    expect(second).toBe(first);
  });

  it('rebuilds under the SAME key when the hash changes, not a new key', () => {
    const cache = new V2BlobCache(10_000);
    let n = 0;
    const build = vi.fn(() => Buffer.from(`v${++n}`));

    const first = cache.getOrRebuild('k', 'text/plain', 'hash-a', build);
    const second = cache.getOrRebuild('k', 'text/plain', 'hash-b', build);

    expect(build).toHaveBeenCalledTimes(2);
    expect(first.buffer.toString()).toBe('v1');
    expect(second.buffer.toString()).toBe('v2');
    // Same key throughout — verified by fetching 'k' directly and getting
    // the LATEST entry, not a stale one under some other identity.
    expect(cache.get('k')?.buffer.toString()).toBe('v2');
    expect(second.builtFromContentHash).toBe('hash-b');
  });

  it('TTL backstop evicts an entry nobody has touched, independent of the hash check', () => {
    vi.useFakeTimers();
    const cache = new V2BlobCache(10);
    const build = vi.fn(() => Buffer.from('v1'));

    cache.getOrRebuild('k', 'text/plain', 'hash-a', build);
    expect(cache.get('k')).toBeDefined();

    vi.advanceTimersByTime(11);
    expect(cache.get('k')).toBeUndefined();

    // A later getOrRebuild call with the SAME hash still rebuilds, since the
    // entry expired — this is the TTL backstop acting independently of
    // content-hash freshness (the hash never changed, only time did).
    cache.getOrRebuild('k', 'text/plain', 'hash-a', build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('get returns undefined for a key that was never built', () => {
    const cache = new V2BlobCache(10_000);
    expect(cache.get('never-built')).toBeUndefined();
  });
});
