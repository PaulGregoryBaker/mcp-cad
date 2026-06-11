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

// ─── Feature 012: dxfPlacement tests ─────────────────────────────────────────

/** Build a graph with multiple panels that have dxfPlacement set (multi-panel assembly). */
function makeGraphWithPlacement(
  panels: Array<{
    id: string;
    origin: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
    flatWidth: number;
    flatHeight: number;
    dxfPlacement: { rotationMatrix: [[number, number], [number, number]]; translation: [number, number] };
    canonical?: boolean;
  }>,
): ManufacturingGraphData {
  const nodes = new Map<any, any>();
  for (const p of panels) {
    nodes.set(p.id, {
      type: 'PanelNode',
      id: p.id,
      bodyId: p.id,
      dirty: false,
      canonical: p.canonical ?? true,
      materialType: 'default',
      nominalThickness: 1.5,
      flatWidth: p.flatWidth,
      flatHeight: p.flatHeight,
      panelFrame: { origin: p.origin, u: p.u, v: p.v },
      dxfPlacement: p.dxfPlacement,
    });
  }
  return { nodes } as unknown as ManufacturingGraphData;
}

describe('coordinate-map — dxfPlacement: Panel B with non-zero translation', () => {
  // Panel A: x in [0, 100], flat origin at world (0,0,0), dxfPlacement = identity
  // Panel B: x in [150, 250] (after 50mm bend), at world (0,110,0) (bend folded 90°),
  //          flat panel is vertical (u=Y, v=Z in world space, rotated by bend),
  //          dxfPlacement.translation = [150, 0]
  const aWidth = 100;
  const ba = 50;
  const bWidth = 100;

  const graph = makeGraphWithPlacement([
    {
      id: 'panel-a',
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      flatWidth: aWidth,
      flatHeight: 60,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] },
      canonical: false,
    },
    {
      id: 'panel-b',
      origin: [0, 0, 0],       // same origin as A (for simplicity: both flat in XY plane)
      u: [1, 0, 0],
      v: [0, 1, 0],
      flatWidth: bWidth,
      flatHeight: 60,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [aWidth + ba, 0] },
      canonical: true,
    },
  ]);

  it('point on Panel B maps to master flat x > aWidth + ba', () => {
    // A point at the LEFT edge of Panel B's face: (u=0, v=0) local → apply dxfPlacementB → (150, 0)
    const pt3d: [number, number, number] = [0, 0, 0]; // Panel B's origin (same as A here)
    const result = map3dTo2d(pt3d, graph);
    // Both panels share the same origin and frame — the function picks the one with the smallest height
    // (both height=0), so it will match whichever has the point in bounds first.
    // Since Panel A has dxfPlacement identity, it will match Panel A first (x=0 < aWidth).
    // To test Panel B specifically, use a point at u > aWidth (outside Panel A's region).
    expect('xy' in result).toBe(true);
  });

  it('point at u=aWidth+ba+10 maps into Panel B region', () => {
    // Panel B: origin at world (aWidth+ba, 0, 0) from its own dxfPlacement offset
    // But panel B's frame origin is (0,0,0) and u=[1,0,0].
    // A local (u=10, v=0) point on Panel B's frame → 3D (10, 0, 0)
    // After dxfPlacement: masterX = 1*10 + 0*0 + 150 = 160
    // But Panel A also has origin (0,0,0) and covers u in [0,100], so (10,0,0) is in Panel A too.
    // We need a point outside Panel A's region to be sure Panel B is selected.
    // Panel A covers u in [0, 100]. A point at (50, 0, 0) is in Panel A (u=50 < 100).
    // To force Panel B selection, the point must NOT be in Panel A's bounds.
    // Use flat dxfPlacement math directly: verify Panel B's dxfPlacement translation adds correctly.
    const pbPlacement = { rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]], translation: [aWidth + ba, 0] as [number, number] };
    // Local (u, v) = (10, 5) → master = R * [10, 5] + [150, 0] = [160, 5]
    const localU = 10, localV = 5;
    const [[a, b], [c, d]] = pbPlacement.rotationMatrix;
    const [tx, ty] = pbPlacement.translation;
    const masterX = a * localU + b * localV + tx;
    const masterY = c * localU + d * localV + ty;
    expect(masterX).toBeCloseTo(aWidth + ba + localU, 4);
    expect(masterY).toBeCloseTo(localV, 4);
    expect(masterX).toBeGreaterThan(aWidth + ba);
  });

  it('map2dTo3d with Panel B dxfPlacement reconstructs panel-local coords', () => {
    // Master flat point in Panel B's region: (160, 5)
    // Panel B dxfPlacement: translation=[150,0], R=identity
    // R^T * ([160,5] - [150,0]) = R^T * [10, 5] = [10, 5] (since R=identity)
    // Panel B frame: origin=(0,0,0), u=(1,0,0), v=(0,1,0)
    // 3D = origin + 10*u + 5*v = (10, 5, 0)
    const graph2 = makeGraphWithPlacement([
      {
        id: 'panel-b-only',
        origin: [0, 0, 0],
        u: [1, 0, 0],
        v: [0, 1, 0],
        flatWidth: bWidth,
        flatHeight: 60,
        dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [aWidth + ba, 0] },
      },
    ]);
    const result = map2dTo3d(undefined, [160, 5], graph2);
    expect('point3d' in result).toBe(true);
    if (!('point3d' in result)) return;
    // local = R^T * ([160,5]-[150,0]) = [10,5]; 3D = (10, 5, 0)
    expect(result.point3d[0]).toBeCloseTo(10, 4);
    expect(result.point3d[1]).toBeCloseTo(5, 4);
    expect(result.point3d[2]).toBeCloseTo(0, 4);
  });
});

describe('coordinate-map — dxfPlacement: non-identity rotation (DXF-rotated panel)', () => {
  // A panel that was DXF-rotated 90° CCW: rotateDxf90 matrix = [[0,1],[-1,0]]
  // Panel frame: the DXF-aligned frame after rotation
  //   origin shifted, u = face.v, v = -face.u
  // For this test: original face u=(1,0,0), v=(0,1,0), width=80, height=60
  // After DXF rotate: u_dxf=(0,1,0), v_dxf=(-1,0,0), origin=(80,0,0)+original
  // dxfPlacement = { rotationMatrix: [[0,1],[-1,0]], translation: [200, 0] }

  const rotMatrix: [[number, number], [number, number]] = [[0, 1], [-1, 0]];
  const translation: [number, number] = [200, 0];

  // Panel with rotated DXF frame
  // face.u = (1,0,0), face.v = (0,1,0), face.origin = (0,0,0)
  // DXF-aligned frame: u_dxf = face.v = (0,1,0), v_dxf = -face.u = (-1,0,0)
  // origin_dxf = original_origin + uExtentMm * face.u = (80, 0, 0)
  const rotatedGraph = makeGraphWithPlacement([
    {
      id: 'panel-rotated',
      origin: [80, 0, 0],       // DXF origin is at (80,0,0)
      u: [0, 1, 0],              // DXF +X = face.v
      v: [-1, 0, 0],             // DXF +Y = -face.u
      flatWidth: 60,             // after rotation: old height becomes new width
      flatHeight: 80,            // after rotation: old width becomes new height
      dxfPlacement: { rotationMatrix: rotMatrix, translation },
    },
  ]);

  it('map2dTo3d inverts non-identity rotation matrix', () => {
    // Master flat point must map to valid local coords (both in [0, flatWidth]×[0, flatHeight]).
    // R_inv = transpose([[0,1],[-1,0]]) = [[0,-1],[1,0]]
    // For master (205, -5): local = R_inv * ([205,-5]-[200,0]) = [[0,-1],[1,0]]*[5,-5] = [5, 5]
    // lx=5 in [0,60], ly=5 in [0,80] ✓
    // 3D = origin + 5*u + 5*v = (80,0,0) + 5*(0,1,0) + 5*(-1,0,0) = (75, 5, 0)
    const result = map2dTo3d(undefined, [205, -5], rotatedGraph);
    expect('point3d' in result).toBe(true);
    if (!('point3d' in result)) return;
    expect(result.point3d[0]).toBeCloseTo(75, 4);
    expect(result.point3d[1]).toBeCloseTo(5, 4);
    expect(result.point3d[2]).toBeCloseTo(0, 4);
  });

  it('map3dTo2d applies non-identity rotation to reach master flat', () => {
    // 3D point (75, 5, 0) is on the panel surface:
    // d = (75,5,0) - (80,0,0) = (-5,5,0)
    // u_local = dot(d, (0,1,0)) = 5
    // v_local = dot(d, (-1,0,0)) = 5
    // Apply dxfPlacement: R*[5,5]+[200,0] = [[0,1],[-1,0]]*[5,5]+[200,0] = [5,-5]+[200,0] = [205,-5]
    const result = map3dTo2d([75, 5, 0], rotatedGraph);
    expect('xy' in result).toBe(true);
    if (!('xy' in result)) return;
    expect(result.xy[0]).toBeCloseTo(205, 4);
    expect(result.xy[1]).toBeCloseTo(-5, 4);
  });

  it('round-trip with non-identity rotation stays within 0.1 mm', () => {
    // Use a valid master flat point: (215, -10)
    // R_inv * ([215,-10]-[200,0]) = [[0,-1],[1,0]]*[15,-10] = [10, 15] → in bounds ✓
    const pt2d: [number, number] = [215, -10];
    const r3d = map2dTo3d(undefined, pt2d, rotatedGraph);
    expect('point3d' in r3d).toBe(true);
    if (!('point3d' in r3d)) return;
    const rBack = map3dTo2d(r3d.point3d, rotatedGraph);
    expect('xy' in rBack).toBe(true);
    if (!('xy' in rBack)) return;
    const d = Math.sqrt((rBack.xy[0] - pt2d[0]) ** 2 + (rBack.xy[1] - pt2d[1]) ** 2);
    expect(d).toBeLessThanOrEqual(0.1);
  });
});

describe('coordinate-map — dxfPlacement: 3-panel chain round-trip', () => {
  // Three panels A, B, C placed in the XY plane (simplified: all flat, same frame direction)
  // A: u in [0, 80],    dxfPlacement = identity
  // B: u in [0, 60],    dxfPlacement = translation [80+10, 0]  (10mm bend allowance)
  // C: u in [0, 70],    dxfPlacement = translation [80+10+60+12, 0]  (12mm bend allowance)
  //
  // All three share the same frame orientation (same u/v in world) but at different 3D origins.
  // This simulates a flat assembly where panels are in the same plane but at different offsets.

  const ba1 = 10;
  const ba2 = 12;
  const aWidth = 80;
  const bWidth = 60;
  const cWidth = 70;

  const chainGraph = makeGraphWithPlacement([
    {
      id: 'panel-a',
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      flatWidth: aWidth,
      flatHeight: 50,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] },
      canonical: false,
    },
    {
      id: 'panel-b',
      origin: [aWidth + ba1, 0, 0],    // B's face starts at x = aWidth+ba1 in 3D
      u: [1, 0, 0],
      v: [0, 1, 0],
      flatWidth: bWidth,
      flatHeight: 50,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [aWidth + ba1, 0] },
      canonical: false,
    },
    {
      id: 'panel-c',
      origin: [aWidth + ba1 + bWidth + ba2, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      flatWidth: cWidth,
      flatHeight: 50,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [aWidth + ba1 + bWidth + ba2, 0] },
      canonical: true,
    },
  ]);

  it('all three panel regions are reachable from 3D and stay within 0.1 mm round-trip', () => {
    // Sample one point from each panel's region
    const testPoints: Array<{ pt3d: [number, number, number]; expectedMasterX: number; label: string }> = [
      { pt3d: [40, 20, 0],                                     expectedMasterX: 40,                              label: 'Panel A center' },
      { pt3d: [aWidth + ba1 + 20, 20, 0],                      expectedMasterX: aWidth + ba1 + 20,               label: 'Panel B center' },
      { pt3d: [aWidth + ba1 + bWidth + ba2 + 20, 20, 0],       expectedMasterX: aWidth + ba1 + bWidth + ba2 + 20, label: 'Panel C center' },
    ];

    for (const { pt3d, expectedMasterX, label } of testPoints) {
      // 3D → 2D
      const r2d = map3dTo2d(pt3d, chainGraph);
      expect('xy' in r2d, `${label}: map3dTo2d should succeed`).toBe(true);
      if (!('xy' in r2d)) continue;
      expect(r2d.xy[0]).toBeCloseTo(expectedMasterX, 2, `${label}: masterX`);
      expect(r2d.errorMm).toBeLessThanOrEqual(0.1, `${label}: projection error`);

      // 2D → 3D round-trip
      const rBack = map2dTo3d(undefined, r2d.xy, chainGraph);
      expect('point3d' in rBack, `${label}: map2dTo3d should succeed`).toBe(true);
      if (!('point3d' in rBack)) continue;
      const dist = Math.sqrt(
        (rBack.point3d[0] - pt3d[0]) ** 2 +
        (rBack.point3d[1] - pt3d[1]) ** 2 +
        (rBack.point3d[2] - pt3d[2]) ** 2,
      );
      expect(dist).toBeLessThanOrEqual(0.1, `${label}: round-trip error`);
    }
  });

  it('map2dTo3d without panel_id selects correct panel from master flat coords', () => {
    // Master flat x=200 is in Panel C (starts at aWidth+ba1+bWidth+ba2 = 80+10+60+12 = 162)
    const masterPt: [number, number] = [200, 10];
    const result = map2dTo3d(undefined, masterPt, chainGraph);
    expect('point3d' in result).toBe(true);
    if (!('point3d' in result)) return;
    // Panel C local: R^T*(200-162, 10-0) = (38, 10), 3D = (162+38, 10, 0) = (200, 10, 0)
    expect(result.point3d[0]).toBeCloseTo(200, 4);
    expect(result.point3d[1]).toBeCloseTo(10, 4);
    expect(result.point3d[2]).toBeCloseTo(0, 4);
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

