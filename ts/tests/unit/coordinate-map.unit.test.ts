/**
 * Unit tests for coordinate-map.ts bidirectional 3D-to-2D mapping.
 *
 * Verifies:
 * - Round-trip accuracy ≤ 0.1 mm for panel corners
 * - Correct handling of off-panel points (GE_POINT_NOT_ON_PANEL)
 * - GE_PANEL_NO_FRAME when no panel frames are present
 *
 * Feature: 011-graph-driven-geometry (T031)
 */

import { describe, it, expect } from 'vitest';
import { map3dTo2d, map2dTo3d } from '../../src/geometry/coordinate-map';
import type { ManufacturingGraphData } from '../../src/manufacturing/graph/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal ManufacturingGraphData mock for testing. */
function makeGraph(
  panels: Array<{
    id: string;
    origin: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
  }>,
): ManufacturingGraphData {
  const nodes = new Map<any, any>();
  for (const p of panels) {
    nodes.set(p.id, {
      type: 'PanelNode',
      id: p.id,
      bodyId: p.id,
      dirty: false,
      canonical: true,
      materialType: 'default',
      nominalThickness: 1.5,
      flatWidth: 100,
      flatHeight: 50,
      panelFrame: {
        origin: p.origin,
        u: p.u,
        v: p.v,
      },
    });
  }
  return { nodes } as unknown as ManufacturingGraphData;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('coordinate-map — map3dTo2d', () => {
  it('projects a point lying exactly on a horizontal panel to (0, 0)', () => {
    // Panel in the XY plane: origin=(0,0,0), u=(1,0,0), v=(0,1,0)
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    const result = map3dTo2d([0, 0, 0], graph);
    expect('xy' in result).toBe(true);
    if (!('xy' in result)) return;
    expect(result.panelId).toBe('p1');
    expect(result.xy[0]).toBeCloseTo(0, 4);
    expect(result.xy[1]).toBeCloseTo(0, 4);
    expect(result.errorMm).toBeCloseTo(0, 6);
  });

  it('projects an offset point on a horizontal panel correctly', () => {
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    const result = map3dTo2d([30, 45, 0], graph);
    expect('xy' in result).toBe(true);
    if (!('xy' in result)) return;
    expect(result.xy[0]).toBeCloseTo(30, 4);
    expect(result.xy[1]).toBeCloseTo(45, 4);
  });

  it('projects a point on a vertical panel (XZ plane)', () => {
    // Panel in XZ plane: origin=(0,0,0), u=(1,0,0), v=(0,0,1)
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },
    ]);
    const result = map3dTo2d([20, 0, 15], graph);
    expect('xy' in result).toBe(true);
    if (!('xy' in result)) return;
    expect(result.xy[0]).toBeCloseTo(20, 4);
    expect(result.xy[1]).toBeCloseTo(15, 4);
    expect(result.errorMm).toBeCloseTo(0, 6);
  });

  it('returns GE_POINT_NOT_ON_PANEL for a point more than 0.1 mm off-surface', () => {
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    // Point is 5 mm above the panel surface
    const result = map3dTo2d([10, 10, 5], graph);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('GE_POINT_NOT_ON_PANEL');
    expect(result.nearestPanelId).toBe('p1');
    expect(result.distanceMm).toBeGreaterThan(0.1);
  });

  it('returns GE_PANEL_NO_FRAME when no panel has a panelFrame', () => {
    const nodes = new Map<any, any>();
    nodes.set('p1', {
      type: 'PanelNode',
      id: 'p1',
      bodyId: 'p1',
      dirty: false,
      canonical: true,
      // No panelFrame
    });
    const graph = { nodes } as unknown as ManufacturingGraphData;
    const result = map3dTo2d([0, 0, 0], graph);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('GE_PANEL_NO_FRAME');
  });

  it('selects the panel whose surface is closest when multiple panels exist', () => {
    // Two panels: p1 at Z=0, p2 at Z=10
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
      { id: 'p2', origin: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    // Point at Z=0.01 is closer to p1 than p2
    const result = map3dTo2d([5, 5, 0.01], graph);
    expect('xy' in result).toBe(true);
    if (!('xy' in result)) return;
    expect(result.panelId).toBe('p1');
    expect(result.errorMm).toBeCloseTo(0.01, 4);
  });
});

describe('coordinate-map — map2dTo3d', () => {
  it('reconstructs the 3D origin for 2D (0, 0) on a horizontal panel', () => {
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    const result = map2dTo3d('p1', [0, 0], graph);
    expect('point3d' in result).toBe(true);
    if (!('point3d' in result)) return;
    expect(result.point3d[0]).toBeCloseTo(0, 4);
    expect(result.point3d[1]).toBeCloseTo(0, 4);
    expect(result.point3d[2]).toBeCloseTo(0, 4);
    expect(result.errorMm).toBe(0);
  });

  it('reconstructs an offset 3D point from 2D coordinates', () => {
    const graph = makeGraph([
      { id: 'p1', origin: [10, 20, 5], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    const result = map2dTo3d('p1', [30, 15], graph);
    expect('point3d' in result).toBe(true);
    if (!('point3d' in result)) return;
    // origin + u*30 + v*15 = (10+30, 20+15, 5) = (40, 35, 5)
    expect(result.point3d[0]).toBeCloseTo(40, 4);
    expect(result.point3d[1]).toBeCloseTo(35, 4);
    expect(result.point3d[2]).toBeCloseTo(5, 4);
  });

  it('returns GE_POINT_NOT_ON_PANEL for unknown panel ID', () => {
    const graph = makeGraph([
      { id: 'p1', origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] },
    ]);
    const result = map2dTo3d('nonexistent', [0, 0], graph);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('GE_POINT_NOT_ON_PANEL');
  });

  it('returns GE_PANEL_NO_FRAME when panel has no panelFrame', () => {
    const nodes = new Map<any, any>();
    nodes.set('p1', {
      type: 'PanelNode',
      id: 'p1',
      bodyId: 'p1',
      dirty: false,
      canonical: true,
      // No panelFrame
    });
    const graph = { nodes } as unknown as ManufacturingGraphData;
    const result = map2dTo3d('p1', [0, 0], graph);
    expect('code' in result).toBe(true);
    if (!('code' in result)) return;
    expect(result.code).toBe('GE_PANEL_NO_FRAME');
  });
});

describe('coordinate-map — round-trip accuracy', () => {
  it('round-trip 3D→2D→3D has ≤ 0.1 mm error for a panel corner', () => {
    // Panel at an offset origin with non-trivial axes
    const origin: [number, number, number] = [50, 100, 25];
    const u: [number, number, number] = [1, 0, 0];
    const v: [number, number, number] = [0, 1, 0];
    const graph = makeGraph([{ id: 'p1', origin, u, v }]);

    // A known corner at 3D (80, 130, 25)
    const corner3d: [number, number, number] = [80, 130, 25];
    const mapped = map3dTo2d(corner3d, graph);
    expect('xy' in mapped).toBe(true);
    if (!('xy' in mapped)) return;
    // Should map to 2D (30, 30) since offset from origin is (30, 30, 0)
    expect(mapped.xy[0]).toBeCloseTo(30, 4);
    expect(mapped.xy[1]).toBeCloseTo(30, 4);

    const roundTrip = map2dTo3d('p1', mapped.xy, graph);
    expect('point3d' in roundTrip).toBe(true);
    if (!('point3d' in roundTrip)) return;
    const dist = Math.sqrt(
      (roundTrip.point3d[0] - corner3d[0]) ** 2 +
      (roundTrip.point3d[1] - corner3d[1]) ** 2 +
      (roundTrip.point3d[2] - corner3d[2]) ** 2,
    );
    expect(dist).toBeLessThanOrEqual(0.1);
  });

  it('round-trip 2D→3D→2D has ≤ 0.1 mm error', () => {
    const origin: [number, number, number] = [0, 0, 0];
    const u: [number, number, number] = [1, 0, 0];
    const v: [number, number, number] = [0, 0, 1];   // XZ plane panel
    const graph = makeGraph([{ id: 'p1', origin, u, v }]);

    const pt2d: [number, number] = [42, 17];
    const r3d = map2dTo3d('p1', pt2d, graph);
    expect('point3d' in r3d).toBe(true);
    if (!('point3d' in r3d)) return;

    const r2d = map3dTo2d(r3d.point3d, graph);
    expect('xy' in r2d).toBe(true);
    if (!('xy' in r2d)) return;
    expect(r2d.xy[0]).toBeCloseTo(pt2d[0], 4);
    expect(r2d.xy[1]).toBeCloseTo(pt2d[1], 4);
  });
});

// ─── Comprehensive round-trip tests (user-requested) ─────────────────────────
// These test the four mapping scenarios across multiple reference points.

/** Helper: 3D-vector distance. */
function dist3(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Helper: 2D-vector distance. */
function dist2(a: [number, number], b: [number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

// Panel used across all comprehensive tests: tilted origin, axis-aligned u/v
const PANEL_ORIGIN: [number, number, number] = [10, 20, 5];
const PANEL_U: [number, number, number] = [1, 0, 0];
const PANEL_V: [number, number, number] = [0, 1, 0];

// Reference 3D points that lie exactly on the panel surface (z = 5)
const REF_3D_POINTS: [number, number, number][] = [
  [10, 20, 5],    // origin corner
  [60, 20, 5],    // +u 50mm
  [10, 70, 5],    // +v 50mm
  [35, 45, 5],    // center-ish
  [110, 120, 5],  // far corner
];

// Corresponding 2D flat-pattern coordinates (offset from origin)
const REF_2D_POINTS: [number, number][] = [
  [0, 0],
  [50, 0],
  [0, 50],
  [25, 25],
  [100, 100],
];

describe('coordinate-map — round-trip: multiple 3D → 2D → 3D', () => {
  it('converts each reference 3D point to 2D and back within 0.1 mm', () => {
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);

    for (let i = 0; i < REF_3D_POINTS.length; i++) {
      const pt3d = REF_3D_POINTS[i]!;
      const expected2d = REF_2D_POINTS[i]!;

      // 3D → 2D
      const r2d = map3dTo2d(pt3d, graph);
      expect('xy' in r2d).toBe(true);
      if (!('xy' in r2d)) continue;
      expect(r2d.xy[0]).toBeCloseTo(expected2d[0], 2);
      expect(r2d.xy[1]).toBeCloseTo(expected2d[1], 2);

      // 2D → 3D (round-trip)
      const rBack = map2dTo3d('p1', r2d.xy, graph);
      expect('point3d' in rBack).toBe(true);
      if (!('point3d' in rBack)) continue;
      const d = dist3(rBack.point3d, pt3d);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('coordinate-map — round-trip: multiple 2D → 3D → 2D', () => {
  it('converts each reference 2D point to 3D and back within 0.1 mm', () => {
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);

    for (let i = 0; i < REF_2D_POINTS.length; i++) {
      const pt2d = REF_2D_POINTS[i]!;
      const expected3d = REF_3D_POINTS[i]!;

      // 2D → 3D
      const r3d = map2dTo3d('p1', pt2d, graph);
      expect('point3d' in r3d).toBe(true);
      if (!('point3d' in r3d)) continue;
      expect(r3d.point3d[0]).toBeCloseTo(expected3d[0], 2);
      expect(r3d.point3d[1]).toBeCloseTo(expected3d[1], 2);
      expect(r3d.point3d[2]).toBeCloseTo(expected3d[2], 2);

      // 3D → 2D (round-trip)
      const rBack = map3dTo2d(r3d.point3d, graph);
      expect('xy' in rBack).toBe(true);
      if (!('xy' in rBack)) continue;
      const d = dist2(rBack.xy, pt2d);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('coordinate-map — round-trip: 3D → 2D, offset 10 mm in 2D, back to 3D', () => {
  it('a 10 mm 2D displacement translates to 10 mm 3D displacement in the u direction', () => {
    // Move by +10 mm in the u direction: 2D (dx=10, dy=0) → 3D (dx=10, dy=0, dz=0)
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);
    const OFFSET_MM = 10;

    for (const pt3d of REF_3D_POINTS) {
      const r2d = map3dTo2d(pt3d, graph);
      expect('xy' in r2d).toBe(true);
      if (!('xy' in r2d)) continue;

      // Move +10 mm along the u axis in 2D flat space
      const movedXy: [number, number] = [r2d.xy[0] + OFFSET_MM, r2d.xy[1]];
      const r3d = map2dTo3d('p1', movedXy, graph);
      expect('point3d' in r3d).toBe(true);
      if (!('point3d' in r3d)) continue;

      // In 3D, the movement should be exactly OFFSET_MM along PANEL_U = (1,0,0)
      const expectedMoved: [number, number, number] = [
        pt3d[0] + OFFSET_MM * PANEL_U[0],
        pt3d[1] + OFFSET_MM * PANEL_U[1],
        pt3d[2] + OFFSET_MM * PANEL_U[2],
      ];
      const d = dist3(r3d.point3d, expectedMoved);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });

  it('a 10 mm 2D displacement in the v direction also translates correctly', () => {
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);
    const OFFSET_MM = 10;

    for (const pt3d of REF_3D_POINTS) {
      const r2d = map3dTo2d(pt3d, graph);
      expect('xy' in r2d).toBe(true);
      if (!('xy' in r2d)) continue;

      // Move +10 mm along the v axis in 2D flat space
      const movedXy: [number, number] = [r2d.xy[0], r2d.xy[1] + OFFSET_MM];
      const r3d = map2dTo3d('p1', movedXy, graph);
      expect('point3d' in r3d).toBe(true);
      if (!('point3d' in r3d)) continue;

      const expectedMoved: [number, number, number] = [
        pt3d[0] + OFFSET_MM * PANEL_V[0],
        pt3d[1] + OFFSET_MM * PANEL_V[1],
        pt3d[2] + OFFSET_MM * PANEL_V[2],
      ];
      const d = dist3(r3d.point3d, expectedMoved);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('coordinate-map — round-trip: 2D → 3D, move 10 mm in 3D, back to 2D', () => {
  it('a 10 mm 3D displacement in the u direction maps to 10 mm 2D displacement', () => {
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);
    const OFFSET_MM = 10;

    for (const pt2d of REF_2D_POINTS) {
      const r3d = map2dTo3d('p1', pt2d, graph);
      expect('point3d' in r3d).toBe(true);
      if (!('point3d' in r3d)) continue;

      // Move +10 mm along the u axis in 3D world space
      const moved3d: [number, number, number] = [
        r3d.point3d[0] + OFFSET_MM * PANEL_U[0],
        r3d.point3d[1] + OFFSET_MM * PANEL_U[1],
        r3d.point3d[2] + OFFSET_MM * PANEL_U[2],
      ];
      const rBack = map3dTo2d(moved3d, graph);
      expect('xy' in rBack).toBe(true);
      if (!('xy' in rBack)) continue;

      // In 2D, the movement should be exactly OFFSET_MM along the x axis (u maps to x)
      const expectedMoved2d: [number, number] = [pt2d[0] + OFFSET_MM, pt2d[1]];
      const d = dist2(rBack.xy, expectedMoved2d);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });

  it('a 10 mm 3D displacement in the v direction maps to 10 mm 2D displacement', () => {
    const graph = makeGraph([{ id: 'p1', origin: PANEL_ORIGIN, u: PANEL_U, v: PANEL_V }]);
    const OFFSET_MM = 10;

    for (const pt2d of REF_2D_POINTS) {
      const r3d = map2dTo3d('p1', pt2d, graph);
      expect('point3d' in r3d).toBe(true);
      if (!('point3d' in r3d)) continue;

      // Move +10 mm along the v axis in 3D
      const moved3d: [number, number, number] = [
        r3d.point3d[0] + OFFSET_MM * PANEL_V[0],
        r3d.point3d[1] + OFFSET_MM * PANEL_V[1],
        r3d.point3d[2] + OFFSET_MM * PANEL_V[2],
      ];
      const rBack = map3dTo2d(moved3d, graph);
      expect('xy' in rBack).toBe(true);
      if (!('xy' in rBack)) continue;

      // In 2D, the movement should be exactly OFFSET_MM along the y axis (v maps to y)
      const expectedMoved2d: [number, number] = [pt2d[0], pt2d[1] + OFFSET_MM];
      const d = dist2(rBack.xy, expectedMoved2d);
      expect(d).toBeLessThanOrEqual(0.1);
    }
  });
});

describe('coordinate-map — round-trip: tilted panel (non-axis-aligned)', () => {
  it('handles a 45-degree rotated panel in XY plane', () => {
    // Panel with u=(1/√2, 1/√2, 0) and v=(-1/√2, 1/√2, 0) (45° CCW rotation)
    const s = Math.SQRT2 / 2;
    const origin: [number, number, number] = [0, 0, 0];
    const u: [number, number, number] = [s, s, 0];
    const v: [number, number, number] = [-s, s, 0];
    const graph = makeGraph([{ id: 'p1', origin, u, v }]);

    // A point 10mm along u and 5mm along v in panel space
    // = origin + 10*u + 5*v = (10s - 5s, 10s + 5s, 0) = (5s, 15s, 0)
    const pt2d: [number, number] = [10, 5];
    const expected3d: [number, number, number] = [5 * s, 15 * s, 0];

    const r3d = map2dTo3d('p1', pt2d, graph);
    expect('point3d' in r3d).toBe(true);
    if (!('point3d' in r3d)) return;
    expect(r3d.point3d[0]).toBeCloseTo(expected3d[0], 3);
    expect(r3d.point3d[1]).toBeCloseTo(expected3d[1], 3);
    expect(r3d.point3d[2]).toBeCloseTo(0, 4);

    // Round-trip back
    const rBack = map3dTo2d(r3d.point3d, graph);
    expect('xy' in rBack).toBe(true);
    if (!('xy' in rBack)) return;
    expect(rBack.xy[0]).toBeCloseTo(pt2d[0], 3);
    expect(rBack.xy[1]).toBeCloseTo(pt2d[1], 3);
  });
});

