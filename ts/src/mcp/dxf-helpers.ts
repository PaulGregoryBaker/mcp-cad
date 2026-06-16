/**
 * DXF processing utilities shared across multiple MCP handler modules.
 *
 * Covers flat-pattern merging, seam-line filtering, orientation normalisation,
 * and the LWPOLYLINE serialisation helper used throughout the sheet-metal pipeline.
 */

import type { BendZone, CutNode, PanelFrame } from '../manufacturing/graph/types.js';
import { computeDxfMergePlacement } from '../manufacturing/dxf/orientation.js';
import { mergeDxfOutlines, parseFirstClosedPolyline, applyPlacement } from '../manufacturing/dxf/merge.js';

// ─── LWPOLYLINE serialisation ─────────────────────────────────────────────────

export function ringToLwpolylineDxf(ring: Array<[number, number]>): string {
  const closed =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1];
  const open = closed ? ring.slice(0, -1) : ring;

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

// ─── Panel orientation normalisation ─────────────────────────────────────────

export function normalizePanelDxfOrientation(
  dxfContent: string,
  expectedWidth: number | null,
  expectedHeight: number | null,
): string {
  if (!(expectedWidth && expectedHeight && expectedWidth > 0 && expectedHeight > 0)) {
    return dxfContent;
  }

  try {
    const identity = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [0, 0] as [number, number],
    };
    const metrics = mergeDxfOutlines(dxfContent, dxfContent, identity).metrics.bbox;
    const directError = Math.abs(metrics.width - expectedWidth) + Math.abs(metrics.height - expectedHeight);
    const swappedError = Math.abs(metrics.width - expectedHeight) + Math.abs(metrics.height - expectedWidth);

    if (swappedError + 1e-6 >= directError) {
      return dxfContent;
    }

    const ring = parseFirstClosedPolyline(dxfContent);
    const rotated = applyPlacement(ring, {
      rotationMatrix: [[0, 1], [-1, 0]],
      translation: [0, 0],
    });

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    for (const [x, y] of rotated) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }

    const shifted = rotated.map(([x, y]) => [x - minX, y - minY] as [number, number]);
    return ringToLwpolylineDxf(shifted);
  } catch {
    return dxfContent;
  }
}

// ─── Seam-line filtering ──────────────────────────────────────────────────────

function isPointOnPanelEdge(
  x: number | null,
  y: number | null,
  widthMm: number,
  heightMm: number,
): boolean {
  if (x === null || y === null) return false;
  const eps = 0.01;
  if (Math.abs(y) < eps && x >= -eps && x <= widthMm + eps) return true;
  if (Math.abs(y - heightMm) < eps && x >= -eps && x <= widthMm + eps) return true;
  if (Math.abs(x) < eps && y >= -eps && y <= heightMm + eps) return true;
  if (Math.abs(x - widthMm) < eps && y >= -eps && y <= heightMm + eps) return true;
  return false;
}

export function filterInvalidCutLines(
  dxfContent: string,
  panelWidthMm: number,
  panelHeightMm: number,
): string {
  const lines = dxfContent.split('\n');
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '0' && i + 1 < lines.length && lines[i + 1] === 'LINE') {
      i += 2;

      let x1: number | null = null, y1: number | null = null;
      let x2: number | null = null, y2: number | null = null;
      const entityLines: string[] = ['0', 'LINE'];

      while (i < lines.length && lines[i] !== '0') {
        const code = lines[i];
        const value = i + 1 < lines.length ? lines[i + 1] : '';
        entityLines.push(code);
        if (i + 1 < lines.length) entityLines.push(value);
        if (code === '10') x1 = parseFloat(value);
        else if (code === '20') y1 = parseFloat(value);
        else if (code === '11') x2 = parseFloat(value);
        else if (code === '21') y2 = parseFloat(value);
        i += 2;
      }

      const isValid =
        isPointOnPanelEdge(x1, y1, panelWidthMm, panelHeightMm) ||
        isPointOnPanelEdge(x2, y2, panelWidthMm, panelHeightMm);
      if (isValid) {
        for (const line of entityLines) result.push(line);
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

// ─── Manufacturing-graph DXF generation ──────────────────────────────────────

export function generateDxfFromManufacturingGraph(
  flatWidthMm: number,
  flatHeightMm: number,
  _bendZones: BendZone[],
  cutNodes: CutNode[],
): string {
  const lines: string[] = [];

  // ─── DXF Header ───────────────────────────────────────────────────────────
  lines.push(
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1015',
    '0',
    'ENDSEC',
  );

  // ─── DXF Entities ─────────────────────────────────────────────────────────
  lines.push(
    '0',
    'SECTION',
    '2',
    'ENTITIES',
  );

  // Panel outline: rectangle from (0,0) to (width,height)
  lines.push(
    '0',
    'LWPOLYLINE',
    '8',
    '0', // layer
    '90',
    '4', // 4 vertices (closed rectangle)
    '70',
    '1', // closed polyline
  );
  // Vertex 1: (0, 0)
  lines.push('10', '0.0', '20', '0.0');
  // Vertex 2: (width, 0)
  lines.push('10', flatWidthMm.toString(), '20', '0.0');
  // Vertex 3: (width, height)
  lines.push('10', flatWidthMm.toString(), '20', flatHeightMm.toString());
  // Vertex 4: (0, height)
  lines.push('10', '0.0', '20', flatHeightMm.toString());

  // Cut profiles: circles, rectangles, polygons, freeform shapes
  for (const cutNode of cutNodes) {
    const profile = cutNode.profile;

    if (profile.type === 'CIRCLE') {
      const { centreX, centreY, radius } = profile;
      lines.push(
        '0',
        'CIRCLE',
        '8',
        'CUTS',
        '10',
        centreX.toString(),
        '20',
        centreY.toString(),
        '40',
        radius.toString(),
      );
    } else if (profile.type === 'RECTANGLE') {
      const { originX, originY, width, height } = profile;
      lines.push(
        '0',
        'LWPOLYLINE',
        '8',
        'CUTS',
        '90',
        '4', // 4 vertices
        '70',
        '1', // closed
      );
      lines.push('10', originX.toString(), '20', originY.toString());
      lines.push('10', (originX + width).toString(), '20', originY.toString());
      lines.push('10', (originX + width).toString(), '20', (originY + height).toString());
      lines.push('10', originX.toString(), '20', (originY + height).toString());
    } else if (profile.type === 'POLYGON' || profile.type === 'FREEFORM') {
      const { vertices } = profile;
      lines.push(
        '0',
        'LWPOLYLINE',
        '8',
        'CUTS',
        '90',
        vertices.length.toString(),
        '70',
        '1', // closed for POLYGON, implicit closure for FREEFORM
      );
      for (const vertex of vertices) {
        lines.push('10', vertex.x.toString(), '20', vertex.y.toString());
      }
    }
  }

  // ─── DXF Footer ───────────────────────────────────────────────────────────
  lines.push(
    '0',
    'ENDSEC',
    '0',
    'EOF',
  );

  const dxfContent = lines.join('\n');

  // VALIDATION: Remove any invalid internal cut lines (seam/corruption artifacts).
  // A LINE is invalid if both endpoints are interior (not on panel edge).
  // This permanently prevents seam lines from appearing in the DXF.
  return filterInvalidCutLines(dxfContent, flatWidthMm, flatHeightMm);
}

// ─── Multi-panel DXF merge ────────────────────────────────────────────────────

export function mergeInputDxfOutlines(
  panelDxfs: (string | null)[],
  panelFrames?: (PanelFrame | null)[],
  contactToleranceMm = 5,
): { mergedDxf: string; width: number; height: number } | null {
  const identity = {
    rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
    translation: [0, 0] as [number, number],
  };

  const items: Array<{ dxf: string; frame: PanelFrame | null }> = [];
  for (let i = 0; i < panelDxfs.length; i++) {
    const d = panelDxfs[i];
    if (d && d.trim().length > 0) items.push({ dxf: d, frame: panelFrames?.[i] ?? null });
  }
  if (items.length === 0) return null;
  if (items.length === 1) {
    const metrics = mergeDxfOutlines(items[0]!.dxf, items[0]!.dxf, identity).metrics;
    return { mergedDxf: items[0]!.dxf, width: metrics.bbox.width, height: metrics.bbox.height };
  }

  const frame0 = items[0]!.frame;
  let merged = items[0]!.dxf;
  let accumWidth = mergeDxfOutlines(merged, merged, identity).metrics.bbox.width;

  for (let i = 1; i < items.length; i++) {
    let placement: { rotationMatrix: [[number, number], [number, number]]; translation: [number, number] } = {
      rotationMatrix: identity.rotationMatrix,
      translation: [accumWidth, 0],
    };
    if (frame0 && items[i]!.frame) {
      const p = computeDxfMergePlacement(frame0, items[i]!.frame!, { contactToleranceMm });
      placement = { rotationMatrix: p.rotationMatrix, translation: p.translation };
    }
    const result = mergeDxfOutlines(merged, items[i]!.dxf, placement);
    merged = result.mergedDxf;
    accumWidth = result.metrics.bbox.width;
  }

  const finalMetrics = mergeDxfOutlines(merged, merged, identity).metrics;
  const finalWidth = finalMetrics.bbox.width;
  const finalHeight = finalMetrics.bbox.height;

  const cleanedMerged = filterInvalidCutLines(merged, finalWidth, finalHeight);
  return { mergedDxf: cleanedMerged, width: finalWidth, height: finalHeight };
}
