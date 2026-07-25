/**
 * Minimal DXF (ASCII, ENTITIES-only) serialization for the flat-pattern
 * resource — pure string formatting of already-computed point arrays, no
 * geometric computation (constitution v2.0.0 principle IV). Deliberately NOT
 * shared with v1's own ts/src/mcp/dxf-helpers.ts: v1 is being decommissioned
 * (rebuild/06-plan.md), so v2 should not grow a dependency on it.
 */
import type { Hole, Point2 } from '../graph/types';

function point2dxf(p: Point2, xCode: string, yCode: string): string[] {
  return [xCode, String(p.x), yCode, String(p.y)];
}

/** The part's one cut boundary — always closed, so DXF group 70 (closed
 * polyline flag) is always 1 (14 §0: a part has exactly one flat outline). */
function ringToDxfLwpolyline(ring: Point2[], layer: string): string[] {
  const out: string[] = ['0', 'LWPOLYLINE', '8', layer, '90', String(ring.length), '70', '1'];
  for (const p of ring) out.push(...point2dxf(p, '10', '20'));
  return out;
}

/** One bend's fold line, drawn as an ordinary DXF LINE entity on its own
 * layer — matches v1's convention of keeping bend annotations off the cut
 * layer (dxf-helpers.ts's own '0'/'CUTS' layer split), generalized to 'BEND'
 * here since v2 has no separate cut-profile layer yet (14 D2's feature table
 * is a future slice). */
function hingeToDxfLine(hingeA: Point2, hingeB: Point2, layer: string): string[] {
  return [
    '0',
    'LINE',
    '8',
    layer,
    ...point2dxf(hingeA, '10', '20'),
    ...point2dxf(hingeB, '11', '21'),
  ];
}

export interface FlatPatternBendLine {
  hingeA: Point2;
  hingeB: Point2;
}

/** A circular hole as a native DXF CIRCLE entity (group codes 10/20 centre +
 * 40 radius) — matches v1's own dxf-helpers.ts convention exactly (never a
 * tessellated polygon: a hole never needs one anywhere in v2's pipeline, see
 * cut_panel.hpp's own header comment). */
function circleHoleToDxfCircle(center: Point2, radiusMm: number, layer: string): string[] {
  return [
    '0',
    'CIRCLE',
    '8',
    layer,
    '10',
    String(center.x),
    '20',
    String(center.y),
    '40',
    String(radiusMm),
  ];
}

/** One hole, on the 'CUTS' layer — v1's own convention for cut/hole entities
 * distinct from the outer boundary's default layer. */
function holeToDxf(hole: Hole): string[] {
  if (hole.kind === 'circle') return circleHoleToDxfCircle(hole.center, hole.radiusMm, 'CUTS');
  return ringToDxfLwpolyline(hole.ring, 'CUTS');
}

/** A part's whole flat pattern is ONE cut boundary (14 §0 — a part has
 * exactly one outline, in the one shared frame F; region panels are derived
 * clips of it, not separate cut pieces) plus one fold-line annotation per
 * bend, plus every hole cut into it — unlike v1, there is no per-panel DXF
 * to reassemble here. */
export function buildFlatPatternDxf(
  outline: Point2[],
  bendLines: FlatPatternBendLine[],
  holes: Hole[] = [],
): string {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  lines.push(...ringToDxfLwpolyline(outline, '0'));
  for (const bendLine of bendLines) {
    lines.push(...hingeToDxfLine(bendLine.hingeA, bendLine.hingeB, 'BEND'));
  }
  for (const hole of holes) {
    lines.push(...holeToDxf(hole));
  }
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}
