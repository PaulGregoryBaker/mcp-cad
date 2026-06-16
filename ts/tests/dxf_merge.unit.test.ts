import { describe, expect, it } from 'vitest';

import { computeDxfMergePlacement, type PanelFrame } from '../src/manufacturing/dxf/orientation';
import { mergeDxfOutlines, parseFirstClosedPolyline } from '../src/manufacturing/dxf/merge';

function rectDxf(width: number, height: number): string {
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', '4',
    '70', '1',
    '10', '0', '20', '0',
    '10', String(width), '20', '0',
    '10', String(width), '20', String(height),
    '10', '0', '20', String(height),
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function lShapeDxf(): string {
  // 100x100 square with top-right 40x40 notch removed.
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', '6',
    '70', '1',
    '10', '0', '20', '0',
    '10', '100', '20', '0',
    '10', '100', '20', '60',
    '10', '60', '20', '60',
    '10', '60', '20', '100',
    '10', '0', '20', '100',
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function polygonDxf(points: Array<[number, number]>): string {
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', String(points.length),
    '70', '1',
    ...points.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function polygonArea(points: Array<[number, number]>): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) * 0.5;
}

function transformPoints(
  points: Array<[number, number]>,
  rotationMatrix: [[number, number], [number, number]],
  translation: [number, number],
): Array<[number, number]> {
  return points.map(([x, y]) => [
    rotationMatrix[0][0] * x + rotationMatrix[0][1] * y + translation[0],
    rotationMatrix[1][0] * x + rotationMatrix[1][1] * y + translation[1],
  ] as [number, number]);
}

function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const unique = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()]
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (unique.length <= 1) return unique;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper: Array<[number, number]> = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointOnSegment(p: [number, number], a: [number, number], b: [number, number], eps = 1e-6): boolean {
  const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > eps) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  if (dot < -eps) return false;
  const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot <= lenSq + eps;
}

function pointInPolygonInclusive(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    if (pointOnSegment(point, pj, pi)) return true;
    const intersects = ((pi[1] > point[1]) !== (pj[1] > point[1])) &&
      (point[0] < (pj[0] - pi[0]) * (point[1] - pi[1]) / (pj[1] - pi[1]) + pi[0]);
    if (intersects) inside = !inside;
  }
  return inside;
}

function frame(origin: [number, number, number], u: [number, number, number], v: [number, number, number]): PanelFrame {
  return { origin, u, v };
}

describe('DXF merge unit scenarios', () => {
  it('A: merge-by-bend flatten placement of two full panels yields one rectangular outline', () => {
    const a = rectDxf(100, 100);
    const b = rectDxf(100, 100);

    const placement = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [100, 0] as [number, number],
    };

    const merged = mergeDxfOutlines(a, b, placement);

    expect(merged.metrics.vertexCount).toBe(4);
    expect(merged.metrics.bbox.width).toBeCloseTo(200, 6);
    expect(merged.metrics.bbox.height).toBeCloseTo(100, 6);
    expect(merged.metrics.areaMm2).toBeCloseTo(20_000, 6);
  });

  it('B1: smaller side panel fuse preserves non-rectangular shape across within-thickness z offsets', () => {
    const base = rectDxf(100, 100);
    const small = rectDxf(40, 30);

    const refFrame = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const thickness = 1.5;
    const offsets = [0, 0.15, 0.5, 1.0, 1.35];

    for (const zOffset of offsets) {
      const movingFrame = frame([80, 35, zOffset], [1, 0, 0], [0, 1, 0]);
      const placement = computeDxfMergePlacement(refFrame, movingFrame, { contactToleranceMm: thickness });

      expect(placement.inContact).toBe(true);

      const merged = mergeDxfOutlines(base, small, {
        rotationMatrix: placement.rotationMatrix,
        translation: placement.translation,
      });

      expect(merged.metrics.vertexCount).toBeGreaterThan(4);
      // Base 100x100 + small 40x30 with a 20x30 overlap => 10_000 + 1_200 - 600 = 10_600
      expect(merged.metrics.areaMm2).toBeCloseTo(10_600, 6);
    }
  });

  it('B2: fuse with alternate base shape (L-shape) keeps non-rectangular topology', () => {
    const base = lShapeDxf();
    const small = rectDxf(25, 20);

    const merged = mergeDxfOutlines(base, small, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [55, 70],
    });

    expect(merged.metrics.vertexCount).toBeGreaterThan(6);
    // L-shape area = 8_400. Small 25x20 panel adds 400 beyond notch => 8_800 total.
    expect(merged.metrics.areaMm2).toBeCloseTo(8_800, 6);
  });

  it('B3: merge-by-bend style second merge on B2 result remains non-rectangular with larger area', () => {
    const base = lShapeDxf();
    const small = rectDxf(25, 20);
    const b2 = mergeDxfOutlines(base, small, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [55, 70],
    });

    const bendPanel = rectDxf(60, 40);

    // Simulated flatten placement from a 90deg companion panel to the right edge.
    const b3 = mergeDxfOutlines(b2.mergedDxf, bendPanel, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [100, 20],
    });

    expect(b3.metrics.vertexCount).toBeGreaterThan(6);
    expect(b3.metrics.areaMm2).toBeGreaterThan(b2.metrics.areaMm2);
  });

  it('C1: edge-sharing non-rectangular union must preserve stepped contour (no bbox rectangle fallback)', () => {
    const base = lShapeDxf();
    const touching = rectDxf(60, 20);

    // Touch base along the right boundary segment x=100, y=[20..40].
    // True union area: 8_400 + 1_200 = 9_600 mm^2 with a stepped outer ring.
    const merged = mergeDxfOutlines(base, touching, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [100, 20],
    });

    expect(merged.metrics.areaMm2).toBeCloseTo(9_600, 6);
    expect(merged.metrics.vertexCount).toBeGreaterThan(4);
  });

  it('C2: disconnected polygons must fail instead of collapsing to a bbox rectangle fallback', () => {
    const base = lShapeDxf();
    const far = rectDxf(60, 20);

    expect(() => mergeDxfOutlines(base, far, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [300, 300],
    })).toThrow(/disconnected|empty|union/i);
  });

  it('C3: two non-rectangular bend-merge inputs preserve non-rectangular merged outline', () => {
    const a = lShapeDxf();
    const b = lShapeDxf();

    // Simulate merge-by-bend flat placement: second panel shifted by the
    // fold-perpendicular width plus seam-axis offset.
    const merged = mergeDxfOutlines(a, b, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [100, 20],
    });

    // Non-rectangular topology must be preserved (not collapsed to a rectangle).
    expect(merged.metrics.vertexCount).toBeGreaterThan(4);
    const bboxArea = merged.metrics.bbox.width * merged.metrics.bbox.height;
    expect(merged.metrics.areaMm2).toBeLessThan(bboxArea - 1e-3);
  });

  it('T1: two non-uniform trapezoid DXFs merge to the convex hull of the combined shape', () => {
    const trapA: Array<[number, number]> = [[0, 0], [50, 0], [40, 30], [10, 30]];
    const trapB: Array<[number, number]> = [[0, 0], [50, 0], [40, 30], [-10, 30]];
    const placement = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [50, 0] as [number, number],
    };

    const merged = mergeDxfOutlines(polygonDxf(trapA), polygonDxf(trapB), placement);
    const mergedRing = parseFirstClosedPolyline(merged.mergedDxf);
    const mergedPoly = mergedRing.slice(0, -1);

    const movedB = transformPoints(trapB, placement.rotationMatrix, placement.translation);
    const hull = convexHull([...trapA, ...movedB]);

    expect(polygonArea(mergedPoly)).toBeCloseTo(polygonArea(hull), 5);
    expect(merged.metrics.vertexCount).toBe(hull.length);
  });

  it('T2: same trapezoids with coplanar 3D frames (fuse-style placement) match convex hull footprint', () => {
    const trapA: Array<[number, number]> = [[0, 0], [50, 0], [40, 30], [10, 30]];
    const trapB: Array<[number, number]> = [[0, 0], [50, 0], [40, 30], [-10, 30]];

    const refFrame = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const movFrame = frame([50, 0, 0], [1, 0, 0], [0, 1, 0]);
    const placement = computeDxfMergePlacement(refFrame, movFrame, { contactToleranceMm: 1.5 });

    expect(placement.inContact).toBe(true);

    const merged = mergeDxfOutlines(polygonDxf(trapA), polygonDxf(trapB), {
      rotationMatrix: placement.rotationMatrix,
      translation: placement.translation,
    });

    const mergedRing = parseFirstClosedPolyline(merged.mergedDxf);
    const mergedPoly = mergedRing.slice(0, -1);
    const movedB = transformPoints(trapB, placement.rotationMatrix, placement.translation);
    const hull = convexHull([...trapA, ...movedB]);

    expect(polygonArea(mergedPoly)).toBeCloseTo(polygonArea(hull), 5);
    expect(merged.metrics.vertexCount).toBe(hull.length);
  });

  it('T3: 30deg bend-style trapezoid merge contains both panel flats and increases area', () => {
    const trapA: Array<[number, number]> = [[0, 0], [90, 0], [62, 40], [18, 40]];
    const trapB: Array<[number, number]> = [[0, 0], [75, 0], [56, 32], [12, 32]];

    // Flattened bend merge approximation: identity rotation, shifted in X by panel width + BA,
    // and in Y by seam offset from mismatched edge lengths.
    const placement = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [79.9, 2] as [number, number],
    };

    const merged = mergeDxfOutlines(polygonDxf(trapA), polygonDxf(trapB), placement);
    const mergedRing = parseFirstClosedPolyline(merged.mergedDxf);
    const mergedPoly = mergedRing.slice(0, -1);

    const movedB = transformPoints(trapB, placement.rotationMatrix, placement.translation);
    const areaA = polygonArea(trapA);
    const areaB = polygonArea(trapB);
    const mergedArea = polygonArea(mergedPoly);

    for (const p of trapA) expect(pointInPolygonInclusive(p, mergedPoly)).toBe(true);
    for (const p of movedB) expect(pointInPolygonInclusive(p, mergedPoly)).toBe(true);

    // A merged bend flat should have area larger than each individual panel and at least
    // close to their sum (minus tiny seam overlap used for robust union).
    expect(mergedArea).toBeGreaterThan(Math.max(areaA, areaB));
    const overlapArea = areaA + areaB - mergedArea;
    expect(overlapArea).toBeGreaterThan(0);
    expect(overlapArea).toBeLessThan(120);
  });

  it('T4: combined trapezoids can produce a concave merged outline (must not be convex-hullized)', () => {
    const trapA: Array<[number, number]> = [[0, 0], [90, 0], [70, 30], [20, 30]];
    const trapB: Array<[number, number]> = [[0, 0], [80, 0], [65, 28], [15, 28]];

    // Purposefully offset to create a connected but concave union.
    const placement = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [55, 25] as [number, number],
    };

    const merged = mergeDxfOutlines(polygonDxf(trapA), polygonDxf(trapB), placement);
    const mergedPoly = parseFirstClosedPolyline(merged.mergedDxf).slice(0, -1);

    const movedB = transformPoints(trapB, placement.rotationMatrix, placement.translation);
    const hull = convexHull([...trapA, ...movedB]);
    const mergedArea = polygonArea(mergedPoly);
    const hullArea = polygonArea(hull);

    // Regression guard: merged outline should retain concavity where present,
    // not be replaced by a convex-hull approximation.
    expect(merged.metrics.vertexCount).toBeGreaterThan(hull.length);
    expect(mergedArea).toBeLessThan(hullArea - 50);
  });
});
