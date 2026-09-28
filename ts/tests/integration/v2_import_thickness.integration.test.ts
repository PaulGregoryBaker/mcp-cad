/**
 * T064 (spec 010, research R-009): building an import at a chosen thickness
 * that differs from the measured one keeps the sheet's mid-surface in place —
 * the material grows/shrinks symmetrically about it — and the part carries the
 * chosen thickness. Reconciliation itself still runs at the measured
 * thickness (C++ ReconcilePieces targetThicknessMm).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { GraphStore } from '../../src/v2/graph/store';
import { constructPart, importPart, mapPointToWorld } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';
import type { Point2 } from '../../src/v2/graph/types';

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

function build(file: string, thicknessMm?: number) {
  const store = new GraphStore();
  const r = importPart(store, path.join(FIXTURES_DIR, file), { thicknessMm });
  const snap = store.snapshotPart(r.partId);
  return { r, store, snap };
}

/** A flat point that lies on the root region panel (not a bend or child). */
function rootPoint(b: ReturnType<typeof build>): Point2 {
  const xs = b.snap.part.outline.map((p) => p.x);
  const ys = b.snap.part.outline.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let i = 1; i < 10; i++) {
    for (let j = 1; j < 10; j++) {
      const p = { x: x0 + ((x1 - x0) * i) / 10, y: y0 + ((y1 - y0) * j) / 10 };
      const m = mapPointToWorld(b.store, b.r.partId, p, 0);
      if (m.ok && m.regionPanelId === b.snap.part.rootRegionPanelId) return p;
    }
  }
  throw new Error('no root-panel point found');
}

function midPlane(b: ReturnType<typeof build>, p: Point2) {
  const t = b.snap.part.thicknessMm;
  const m = mapPointToWorld(b.store, b.r.partId, p, t / 2);
  expect(m.ok).toBe(true);
  return m.point3d;
}

describe('import at a chosen thickness keeps the mid-surface (R-009)', () => {
  for (const delta of [+1.5, -0.5]) {
    it(`l_bracket_corner_90deg: measured → measured ${delta > 0 ? '+' : ''}${delta} mm`, () => {
      const measured = build('l_bracket_corner_90deg.stp');
      const t0 = measured.r.measuredThicknessMm;
      expect(t0).toBeCloseTo(1.5, 3);
      const chosen = build('l_bracket_corner_90deg.stp', t0 + delta);

      expect(chosen.r.measuredThicknessMm).toBeCloseTo(t0, 9);
      expect(chosen.snap.part.thicknessMm).toBeCloseTo(t0 + delta, 9);
      expect(chosen.snap.bends.length).toBe(measured.snap.bends.length);

      // Same flat point on the root panel → same world mid-plane position.
      const p = rootPoint(measured);
      const a = midPlane(measured, p);
      const b = midPlane(chosen, p);
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.01);

      // The constructed solid is really thicker/thinner: along the root's
      // normal the root panel's two skins are exactly the chosen thickness apart.
      const bottom = mapPointToWorld(chosen.store, chosen.r.partId, p, 0).point3d;
      const top = mapPointToWorld(chosen.store, chosen.r.partId, p, t0 + delta).point3d;
      expect(Math.hypot(top.x - bottom.x, top.y - bottom.y, top.z - bottom.z)).toBeCloseTo(t0 + delta, 6);

      // Independent of the mapping's z convention: this fixture's root panel
      // is horizontal with its top skin at the solid's z_max, so the top skin
      // moves by delta/2 (symmetric growth), not delta (one-sided).
      const bbox = (x: ReturnType<typeof build>) => geometryBinding.computeBoundingBox(constructPart(x.store, x.r.partId).shellId);
      expect(bbox(chosen).z_max - bbox(measured).z_max).toBeCloseTo(delta / 2, 3);
    });
  }

  it('same thickness as measured is a no-op (anchor unchanged)', () => {
    const a = build('l_bracket_corner_90deg.stp');
    const b = build('l_bracket_corner_90deg.stp', a.r.measuredThicknessMm);
    expect(b.snap.part.anchor).toEqual(a.snap.part.anchor);
    expect(geometryBinding.computeBoundingBox(constructPart(b.store, b.r.partId).shellId)).toEqual(
      geometryBinding.computeBoundingBox(constructPart(a.store, a.r.partId).shellId),
    );
  });
});
