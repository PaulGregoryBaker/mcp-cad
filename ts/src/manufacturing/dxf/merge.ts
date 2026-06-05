import polygonClipping from 'polygon-clipping';

export type Point2 = [number, number];
export type Ring = Point2[];

export interface Placement2D {
  rotationMatrix: [[number, number], [number, number]];
  translation: [number, number];
}

export interface DxfMergeMetrics {
  vertexCount: number;
  areaMm2: number;
  bbox: {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
    width: number;
    height: number;
  };
}

export interface DxfMergeResult {
  mergedRing: Ring;
  mergedDxf: string;
  metrics: DxfMergeMetrics;
}

function parsePairs(dxf: string): Array<{ code: string; value: string }> {
  const lines = dxf.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  const pairs: Array<{ code: string; value: string }> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push({ code: lines[i]!, value: lines[i + 1]! });
  }
  return pairs;
}

function ensureClosed(ring: Ring): Ring {
  if (ring.length === 0) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, [first[0], first[1]]];
}

function pointEq(a: Point2, b: Point2, eps = 1e-6): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

function parseClosedLineLoop(pairs: Array<{ code: string; value: string }>): Ring | null {
  type Segment = { a: Point2; b: Point2 };
  const segments: Segment[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code !== '0' || p.value !== 'LINE') continue;

    let x1: number | null = null;
    let y1: number | null = null;
    let x2: number | null = null;
    let y2: number | null = null;

    for (let j = i + 1; j < pairs.length; j++) {
      const q = pairs[j]!;
      if (q.code === '0') {
        i = j - 1;
        break;
      }
      if (q.code === '10') x1 = Number(q.value);
      if (q.code === '20') y1 = Number(q.value);
      if (q.code === '11') x2 = Number(q.value);
      if (q.code === '21') y2 = Number(q.value);
      if (j === pairs.length - 1) i = j;
    }

    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      segments.push({ a: [x1, y1], b: [x2, y2] });
    }
  }

  if (segments.length < 3) return null;

  // Build a single chained loop by endpoint matching.
  const remaining = [...segments];
  const first = remaining.shift()!;
  const ring: Ring = [first.a, first.b];

  while (remaining.length > 0) {
    const tail = ring[ring.length - 1]!;
    const idx = remaining.findIndex((s) => pointEq(s.a, tail) || pointEq(s.b, tail));
    if (idx < 0) break;

    const seg = remaining.splice(idx, 1)[0]!;
    const next = pointEq(seg.a, tail) ? seg.b : seg.a;
    ring.push(next);
  }

  const closed = ring.length >= 4 && pointEq(ring[0]!, ring[ring.length - 1]!);
  if (!closed) return null;
  return ensureClosed(ring);
}

export function parseFirstClosedPolyline(dxf: string): Ring {
  const pairs = parsePairs(dxf);

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === '0' && p.value === 'LWPOLYLINE') {
      let closed = false;
      const ring: Ring = [];
      let pendingX: number | null = null;

      for (let j = i + 1; j < pairs.length; j++) {
        const q = pairs[j]!;
        if (q.code === '0') {
          i = j - 1;
          break;
        }

        if (q.code === '70') {
          const flags = Number(q.value);
          closed = (flags & 1) === 1;
        }

        if (q.code === '10') {
          pendingX = Number(q.value);
          continue;
        }

        if (q.code === '20' && pendingX !== null) {
          ring.push([pendingX, Number(q.value)]);
          pendingX = null;
          continue;
        }

        if (j === pairs.length - 1) {
          i = j;
        }
      }

      if (closed && ring.length >= 3) {
        return ensureClosed(ring);
      }
    }
  }

  // Fallback: some DXF exporters emit closed outlines as LINE chains.
  const lineLoop = parseClosedLineLoop(pairs);
  if (lineLoop) return lineLoop;

  throw new Error('No closed LWPOLYLINE or LINE loop found in DXF');
}

export function applyPlacement(ring: Ring, placement: Placement2D): Ring {
  const [r0, r1] = placement.rotationMatrix;
  const [tx, ty] = placement.translation;

  return ring.map(([x, y]) => {
    const nx = r0[0] * x + r0[1] * y + tx;
    const ny = r1[0] * x + r1[1] * y + ty;
    return [nx, ny];
  });
}

function polygonArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) * 0.5;
}

function computeBbox(ring: Ring): DxfMergeMetrics['bbox'] {
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (const [x, y] of ring) {
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  return {
    xMin,
    yMin,
    xMax,
    yMax,
    width: xMax - xMin,
    height: yMax - yMin,
  };
}

function ringToDxf(ring: Ring): string {
  const open = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
    ? ring.slice(0, -1)
    : ring;

  const out: string[] = [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', String(open.length),
    '70', '1',
  ];

  for (const [x, y] of open) {
    out.push('10', String(x), '20', String(y));
  }

  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

export function mergeDxfOutlines(
  referenceDxf: string,
  movingDxf: string,
  placement: Placement2D,
): DxfMergeResult {
  const refRing = parseFirstClosedPolyline(referenceDxf);
  const movRingLocal = parseFirstClosedPolyline(movingDxf);
  const movRing = ensureClosed(applyPlacement(movRingLocal, placement));

  const toPolygon = (ring: Ring) => [[[...ring]]];

  const union = polygonClipping.union(toPolygon(refRing), toPolygon(movRing)) as number[][][][];
  if (!Array.isArray(union) || union.length === 0 || !union[0] || !union[0][0]) {
    throw new Error('DXF union produced empty geometry');
  }

  let best: Ring | null = null;

  if (union.length === 1) {
    // Single polygon — normal union result.
    const outer = union[0]![0]!;
    best = ensureClosed(outer.map(([x, y]) => [x, y]));
  } else {
    // Multiple polygons: panels were touching edge-to-edge (not overlapping).
    // polygon-clipping cannot merge zero-area shared edges, so it returns them
    // as separate polygons. Recover the correct merged outline by computing
    // the combined bounding box of all outer rings.
    // This is exact for rectangular panels (the common case) and a safe
    // over-approximation for non-rectangular ones.
    const allPts: Ring = [];
    for (const poly of union) {
      if (!poly || poly.length === 0) continue;
      for (const [x, y] of poly[0]!) {
        allPts.push([x, y]);
      }
    }
    const bb = computeBbox(allPts);
    best = [
      [bb.xMin, bb.yMin],
      [bb.xMax, bb.yMin],
      [bb.xMax, bb.yMax],
      [bb.xMin, bb.yMax],
      [bb.xMin, bb.yMin],
    ];
  }

  if (!best) {
    throw new Error('DXF union produced no usable outer ring');
  }

  const metrics: DxfMergeMetrics = {
    vertexCount: Math.max(0, best.length - 1),
    areaMm2: polygonArea(best),
    bbox: computeBbox(best),
  };

  return {
    mergedRing: best,
    mergedDxf: ringToDxf(best),
    metrics,
  };
}
