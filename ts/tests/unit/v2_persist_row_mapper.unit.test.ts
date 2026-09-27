/**
 * Row mapper (spec 010, T020): round trips, identity-preserving diffs, keys.
 */
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  diffRows,
  keyBetween,
  keysBetween,
  rowsToSnapshots,
  snapshotToRows,
  type GraphRows,
  type PartShadow,
} from '../../src/v2/persistence/row-mapper';
import { GraphStore } from '../../src/v2/graph/store';
import { bentPlate, snapshotCopy } from '../helpers/v2-fixtures';

function roundTrip(store: GraphStore, partId: string) {
  const first = snapshotToRows(store.snapshotPart(partId), undefined);
  const back = rowsToSnapshots(first.rows);
  return { first, back };
}

function counts(d: ReturnType<typeof diffRows>) {
  const c = (rec: Record<string, unknown[]>) => Object.fromEntries(Object.entries(rec).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.length]));
  return { upserts: c(d.upserts as unknown as Record<string, unknown[]>), deletes: c(d.deletes) };
}

describe('[persist] fractional keys', () => {
  it('keyBetween is strictly between and never ends in 0', () => {
    let lo = '';
    const keys: string[] = [];
    for (let i = 0; i < 500; i++) {
      const k = keyBetween(lo, null);
      expect(k > lo).toBe(true);
      expect(k.endsWith('0')).toBe(false);
      keys.push(k);
      lo = k;
    }
    // repeated insertion between two neighbours
    let a = 'a';
    const b = 'b';
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(a, b);
      expect(a < k && k < b).toBe(true);
      a = k;
    }
  });

  it('keysBetween spreads n keys, sorted, unique', () => {
    const ks = keysBetween('', null, 1000);
    expect(new Set(ks).size).toBe(1000);
    expect([...ks].sort()).toEqual(ks);
    expect(Math.max(...ks.map((k) => k.length))).toBeLessThanOrEqual(3);
  });
});

describe('[persist] snapshot ⇄ rows', () => {
  it('round-trips a bent plate with both hole kinds exactly', () => {
    const f = bentPlate();
    const { back } = roundTrip(f.store, f.partId);
    expect(back.problems).toEqual([]);
    expect(back.snapshots).toHaveLength(1);
    expect(back.snapshots[0]).toEqual(f.store.snapshotPart(f.partId));
  });

  it('round-trips anchors, nulls and flags exactly', () => {
    const f = bentPlate();
    const s = snapshotCopy(f.store, f.partId);
    s.part.anchor = { r: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [12.5, -3.25, 1e-7] };
    s.bends[0]!.bottomIsConcave = false;
    s.bends[0]!.kFactorOverride = 0;
    s.bends[1]!.bendProcess = 'airBend';
    s.part.mergedIntoPartId = null;
    const back = rowsToSnapshots(snapshotToRows(s, undefined).rows);
    expect(back.snapshots[0]).toEqual(s);
  });

  it('interleaved hole order survives (polygon, circle, polygon)', () => {
    const f = bentPlate(); // circle then polygon
    const s = snapshotCopy(f.store, f.partId);
    s.part.holes.push({ kind: 'polygon', holeId: randomUUID(), ring: [{ x: 70, y: 5 }, { x: 70, y: 9 }, { x: 74, y: 9 }] });
    s.part.holes.unshift(s.part.holes.pop()!); // polygon, circle, polygon
    const back = rowsToSnapshots(snapshotToRows(s, undefined).rows);
    expect(back.snapshots[0]!.part.holes.map((h) => h.holeId)).toEqual(s.part.holes.map((h) => h.holeId));
  });

  it('a part without an outline ring is reported, not assembled', () => {
    const f = bentPlate();
    const rows = snapshotToRows(f.store.snapshotPart(f.partId), undefined).rows;
    rows.part_ring = rows.part_ring.filter((r) => r.kind !== 'outline');
    const back = rowsToSnapshots(rows);
    expect(back.snapshots).toHaveLength(0);
    expect(back.problems[0]!.issue).toContain('outline');
  });
});

describe('[persist] identity-preserving diffs', () => {
  function base() {
    const f = bentPlate();
    const s = snapshotCopy(f.store, f.partId);
    const first = snapshotToRows(s, undefined);
    // what a load would produce: shadow from rows
    const loaded = rowsToSnapshots(first.rows);
    return { f, s, rows: first.rows, shadow: loaded.shadows.get(f.partId) as PartShadow };
  }

  it('no change → empty diff', () => {
    const { s, rows, shadow } = base();
    const again = snapshotToRows(s, shadow);
    expect(counts(diffRows(rows, again.rows))).toEqual({ upserts: {}, deletes: {} });
  });

  it('inserting one outline vertex writes exactly one vertex row', () => {
    const { s, rows, shadow } = base();
    s.part.outline.splice(2, 0, { x: 100, y: 30 });
    const d = diffRows(rows, snapshotToRows(s, shadow).rows);
    expect(counts(d)).toEqual({ upserts: { ring_vertex: 1 }, deletes: {} });
    expect(d.inserted.ring_vertex).toHaveLength(1);
  });

  it('moving one vertex rewrites that vertex only (new id, old one deleted)', () => {
    const { s, rows, shadow } = base();
    s.part.outline[1] = { x: 110, y: 0 };
    const d = diffRows(rows, snapshotToRows(s, shadow).rows);
    expect(counts(d)).toEqual({ upserts: { ring_vertex: 1 }, deletes: { ring_vertex: 1 } });
  });

  it('deleting a vertex deletes one row', () => {
    const { s, rows, shadow } = base();
    s.part.outline.splice(3, 1);
    expect(counts(diffRows(rows, snapshotToRows(s, shadow).rows))).toEqual({ upserts: {}, deletes: { ring_vertex: 1 } });
  });

  it('changing a bend angle updates one bend row; before-image kept for undo', () => {
    const { s, rows, shadow } = base();
    s.bends[0]!.angleDeg = 60;
    const d = diffRows(rows, snapshotToRows(s, shadow).rows);
    expect(counts(d)).toEqual({ upserts: { bend: 1 }, deletes: {} });
    expect(d.before.bend[0]!.angle_deg).toBe(90);
  });

  it('adding a circle hole appends one feature row; existing hole keys unchanged', () => {
    const { s, rows, shadow } = base();
    s.part.holes.push({ kind: 'circle', holeId: randomUUID(), center: { x: 80, y: 20 }, radiusMm: 3 });
    const d = diffRows(rows, snapshotToRows(s, shadow).rows);
    expect(counts(d)).toEqual({ upserts: { feature: 1 }, deletes: {} });
  });

  it('merging a part away changes its part row and moves its panels', () => {
    const store = new GraphStore();
    const a = bentPlate(store, 'A');
    const b = bentPlate(store, 'B');
    const beforeRows: GraphRows = snapshotToRows(store.snapshotPart(b.partId), undefined).rows;
    const bSnap = snapshotCopy(store, b.partId);
    bSnap.part.mergedIntoPartId = a.partId;
    const d = diffRows(beforeRows, snapshotToRows(bSnap, rowsToSnapshots(beforeRows).shadows.get(b.partId)).rows);
    expect(d.upserts.part).toHaveLength(1);
    expect(d.upserts.part[0]!.merged_into_part_id).toBe(a.partId);
  });
});
