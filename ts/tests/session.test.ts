/**
 * Unit tests for SessionState — geometry ID tracking and snapshot management.
 *
 * Covers: registerNest/hasNest, applyRestore, reset, getSummary
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from '../src/geometry/session';
import type { GeometrySnapshot } from '../src/geometry/session';

describe('SessionState', () => {
  let s: SessionState;

  beforeEach(() => {
    s = new SessionState();
  });

  it('registerSolid/hasSolid round-trips', () => {
    expect(s.hasSolid('s-1')).toBe(false);
    s.registerSolid('s-1');
    expect(s.hasSolid('s-1')).toBe(true);
  });

  it('registerShell/hasShell round-trips', () => {
    expect(s.hasShell('sh-1')).toBe(false);
    s.registerShell('sh-1');
    expect(s.hasShell('sh-1')).toBe(true);
  });

  it('registerUnfold/hasUnfold round-trips', () => {
    expect(s.hasUnfold('u-1')).toBe(false);
    s.registerUnfold('u-1');
    expect(s.hasUnfold('u-1')).toBe(true);
  });

  it('registerNest/hasNest round-trips', () => {
    expect(s.hasNest('n-1')).toBe(false);
    s.registerNest('n-1');
    expect(s.hasNest('n-1')).toBe(true);
  });

  it('hasNest returns false for unknown ID after other registrations', () => {
    s.registerSolid('s-1');
    s.registerShell('sh-1');
    expect(s.hasNest('n-99')).toBe(false);
  });

  it('getSummary returns zero counts on fresh state', () => {
    const summary = s.getSummary();
    expect(summary.solids).toBe(0);
    expect(summary.shells).toBe(0);
    expect(summary.unfolds).toBe(0);
    expect(summary.nests).toBe(0);
    expect(summary.snapshots).toBe(0);
  });

  it('getSummary reflects registered IDs', () => {
    s.registerSolid('s-1');
    s.registerShell('sh-1');
    s.registerShell('sh-2');
    s.registerUnfold('u-1');
    s.registerNest('n-1');

    const snap: GeometrySnapshot = {
      snapshotId: 'snap-1',
      solidIds: ['s-1'],
      shellIds: ['sh-1', 'sh-2'],
      timestamp: Date.now(),
      operationLabel: 'test',
    };
    s.recordSnapshot(snap);

    const summary = s.getSummary();
    expect(summary.solids).toBe(1);
    expect(summary.shells).toBe(2);
    expect(summary.unfolds).toBe(1);
    expect(summary.nests).toBe(1);
    expect(summary.snapshots).toBe(1);
  });

  it('recordSnapshot/getSnapshot round-trips', () => {
    const snap: GeometrySnapshot = {
      snapshotId: 'snap-abc',
      solidIds: ['s-1'],
      shellIds: ['sh-1'],
      timestamp: 12345,
      operationLabel: 'before cut',
    };
    s.recordSnapshot(snap);
    expect(s.getSnapshot('snap-abc')).toEqual(snap);
  });

  it('getSnapshot returns undefined for unknown ID', () => {
    expect(s.getSnapshot('no-such-snap')).toBeUndefined();
  });

  it('applyRestore restores solid and shell sets from snapshot', () => {
    s.registerSolid('old-solid');
    s.registerShell('old-shell');
    s.registerUnfold('u-old');
    s.registerNest('n-old');

    const snap: GeometrySnapshot = {
      snapshotId: 'snap-restore',
      solidIds: ['s-new'],
      shellIds: ['sh-new-1', 'sh-new-2'],
      timestamp: Date.now(),
      operationLabel: 'restore point',
    };
    s.applyRestore(snap);

    expect(s.hasSolid('s-new')).toBe(true);
    expect(s.hasSolid('old-solid')).toBe(false);
    expect(s.hasShell('sh-new-1')).toBe(true);
    expect(s.hasShell('sh-new-2')).toBe(true);
    expect(s.hasShell('old-shell')).toBe(false);
    // unfolds and nests are cleared on rollback
    expect(s.hasUnfold('u-old')).toBe(false);
    expect(s.hasNest('n-old')).toBe(false);
  });

  it('reset clears all state', () => {
    s.registerSolid('s-1');
    s.registerShell('sh-1');
    s.registerUnfold('u-1');
    s.registerNest('n-1');
    const snap: GeometrySnapshot = {
      snapshotId: 'snap-1',
      solidIds: [],
      shellIds: [],
      timestamp: 0,
      operationLabel: 'x',
    };
    s.recordSnapshot(snap);

    s.reset();

    expect(s.hasSolid('s-1')).toBe(false);
    expect(s.hasShell('sh-1')).toBe(false);
    expect(s.hasUnfold('u-1')).toBe(false);
    expect(s.hasNest('n-1')).toBe(false);
    expect(s.getSnapshot('snap-1')).toBeUndefined();
    const summary = s.getSummary();
    expect(summary.solids).toBe(0);
    expect(summary.snapshots).toBe(0);
  });
});
