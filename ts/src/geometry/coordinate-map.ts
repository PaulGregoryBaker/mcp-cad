/**
 * Bidirectional 3D-to-2D coordinate mapping for manufacturing graph panels.
 *
 * Uses each PanelNode's DXF-aligned frame (origin + u/v axes) and dxfPlacement
 * (2D rigid transform: panel-local DXF coords → master merged flat coords) to
 * correctly map across multi-panel assemblies with any number of bends.
 *
 * Accuracy: ≤ COORD_MAP_ACCURACY_THRESHOLD_MM (0.1 mm) round-trip error.
 *
 * Feature: 012-accurate-coord-mapping
 */

import type { ManufacturingGraphData } from '../manufacturing/graph/types';
import type { PanelFrame } from '../manufacturing/dxf/orientation';
import type { Placement2D } from '../manufacturing/dxf/merge';

/** Maximum acceptable projection error (mm) to consider a point "on" a panel surface. */
const COORD_MAP_ACCURACY_THRESHOLD_MM = 0.1;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface CoordinateMapResult {
  /** The panel whose surface contains the projected point. */
  panelId: string;
  /** XY position in the master merged flat DXF coordinate space (mm). */
  xy: [number, number];
  /** Estimated projection error (distance from point to panel surface, mm). */
  errorMm: number;
}

export interface CoordinateMapError {
  code: 'GE_POINT_NOT_ON_PANEL' | 'GE_NO_MANUFACTURING_GRAPH' | 'GE_PANEL_NO_FRAME';
  message: string;
  /** ID of the panel closest to the input point (for GE_POINT_NOT_ON_PANEL). */
  nearestPanelId?: string;
  /** Distance from the input point to the nearest panel surface (mm). */
  distanceMm?: number;
}

// ─── Internal 3D vector helpers ───────────────────────────────────────────────

function sub3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale3(v: [number, number, number], s: number): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function frameNormal(frame: PanelFrame): [number, number, number] {
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  return [
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ];
}

function projectOntoPanel(
  point3d: [number, number, number],
  frame: PanelFrame,
): { u: number; v: number; height: number } {
  const d = sub3(point3d, frame.origin as [number, number, number]);
  const normal = frameNormal(frame);
  return {
    u: dot3(d, frame.u as [number, number, number]),
    v: dot3(d, frame.v as [number, number, number]),
    height: dot3(d, normal),
  };
}

function unprojectFromPanel(
  uCoord: number,
  vCoord: number,
  frame: PanelFrame,
): [number, number, number] {
  const origin = frame.origin as [number, number, number];
  const uAxis  = frame.u as [number, number, number];
  const vAxis  = frame.v as [number, number, number];
  return add3(origin, add3(scale3(uAxis, uCoord), scale3(vAxis, vCoord)));
}

// ─── 2D placement helpers ─────────────────────────────────────────────────────

/** Apply a 2D rigid transform: [mx, my] = R * [x, y] + t */
function applyPlacement2D(p: Placement2D, x: number, y: number): [number, number] {
  const [[a, b], [c, d]] = p.rotationMatrix;
  const [tx, ty] = p.translation;
  return [a * x + b * y + tx, c * x + d * y + ty];
}

/** Transpose a 2×2 matrix (inverse of orthogonal rotation matrix). */
function transpose2x2(m: [[number, number], [number, number]]): [[number, number], [number, number]] {
  return [[m[0][0], m[1][0]], [m[0][1], m[1][1]]];
}

/** Multiply transposed rotation by a 2D vector: R^T * [x, y] */
function matMul2x2Vec(m: [[number, number], [number, number]], x: number, y: number): [number, number] {
  return [m[0][0] * x + m[0][1] * y, m[1][0] * x + m[1][1] * y];
}

/** Invert a dxfPlacement: master flat coords → this panel's own local (lx, ly). */
function invertDxfPlacement(dxfPlacement: Placement2D | undefined, point2d: [number, number]): [number, number] {
  if (!dxfPlacement) return point2d;
  const R_inv = transpose2x2(dxfPlacement.rotationMatrix);
  const [tx, ty] = dxfPlacement.translation;
  return matMul2x2Vec(R_inv, point2d[0] - tx, point2d[1] - ty);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Map a 3D world-space point to its master merged flat DXF coordinate.
 *
 * Iterates ALL PanelNodes (canonical and non-canonical). Projects the point
 * onto each panel's DXF-aligned frame and, when the panel matches (|height| ≤
 * threshold and local coords within bounds), applies the panel's dxfPlacement
 * to convert panel-local coords to master flat coords.
 *
 * Falls back to closest panel when no match within threshold.
 */
export function map3dTo2d(
  point3d: [number, number, number],
  graph: ManufacturingGraphData,
): CoordinateMapResult | CoordinateMapError {
  let bestPanelId: string | null = null;
  let bestXy: [number, number] = [0, 0];
  let bestHeight = Infinity;
  let bestInBounds = false;
  let anyFrameFound = false;

  for (const node of graph.nodes.values()) {
    if (node.type !== 'PanelNode') continue;
    const panelNode = node;
    if (!panelNode.panelFrame) continue;
    anyFrameFound = true;

    const { u, v, height } = projectOntoPanel(point3d, panelNode.panelFrame);
    const absHeight = Math.abs(height);

    // Region bounds check: u in [0, flatWidth], v in [0, flatHeight]
    const inBounds =
      u >= -COORD_MAP_ACCURACY_THRESHOLD_MM &&
      v >= -COORD_MAP_ACCURACY_THRESHOLD_MM &&
      (panelNode.flatWidth  === null || u <= (panelNode.flatWidth  + COORD_MAP_ACCURACY_THRESHOLD_MM)) &&
      (panelNode.flatHeight === null || v <= (panelNode.flatHeight + COORD_MAP_ACCURACY_THRESHOLD_MM));

    const candidateXy: [number, number] = panelNode.dxfPlacement
      ? applyPlacement2D(panelNode.dxfPlacement, u, v)
      : [u, v];

    if (inBounds) {
      // In-bounds panels always beat out-of-bounds. Among in-bounds, pick lowest height.
      if (absHeight < bestHeight || (absHeight <= bestHeight && !bestInBounds)) {
        bestHeight = absHeight;
        bestPanelId = panelNode.id as string;
        bestInBounds = true;
        bestXy = candidateXy;
      }
    } else if (!bestInBounds && bestPanelId === null) {
      // No in-bounds panel found yet — track first out-of-bounds panel for error reporting.
      bestHeight = absHeight;
      bestPanelId = panelNode.id as string;
      bestXy = candidateXy;
    }
  }

  if (!anyFrameFound) {
    return {
      code: 'GE_PANEL_NO_FRAME',
      message: 'No panel in the manufacturing graph has a panelFrame. ' +
               'Run split_body_by_bends or get_unfold first to populate panel frames.',
    };
  }

  if (bestPanelId === null) {
    return {
      code: 'GE_PANEL_NO_FRAME',
      message: 'No panel in the manufacturing graph has a panelFrame. ' +
               'Run split_body_by_bends or get_unfold first to populate panel frames.',
    };
  }

  if (bestHeight > COORD_MAP_ACCURACY_THRESHOLD_MM) {
    return {
      code: 'GE_POINT_NOT_ON_PANEL',
      message: `Point [${point3d.join(', ')}] does not lie on any panel surface. ` +
               `Nearest panel: ${bestPanelId}, distance: ${bestHeight.toFixed(4)} mm.`,
      nearestPanelId: bestPanelId,
      distanceMm: bestHeight,
    };
  }

  return {
    panelId: bestPanelId,
    xy: bestXy,
    errorMm: bestHeight,
  };
}

/**
 * Map a 2D master merged flat DXF coordinate back to a 3D world-space point.
 *
 * When panelId is provided, only that panel is checked.
 * When panelId is omitted, iterates all PanelNodes and uses the one whose
 * dxfPlacement-transformed region contains the query point.
 */
export function map2dTo3d(
  panelId: string | undefined,
  point2d: [number, number],
  graph: ManufacturingGraphData,
): { point3d: [number, number, number]; errorMm: number } | CoordinateMapError {
  for (const node of graph.nodes.values()) {
    if (node.type !== 'PanelNode') continue;
    if (panelId !== undefined && node.id !== panelId) continue;

    const panelNode = node;
    if (!panelNode.panelFrame) continue;

    const [lx, ly] = invertDxfPlacement(panelNode.dxfPlacement, point2d);

    // Region bounds check: local (lx, ly) in [0, flatWidth] × [0, flatHeight]
    const inBounds =
      lx >= -COORD_MAP_ACCURACY_THRESHOLD_MM &&
      ly >= -COORD_MAP_ACCURACY_THRESHOLD_MM &&
      (panelNode.flatWidth  === null || lx <= (panelNode.flatWidth  + COORD_MAP_ACCURACY_THRESHOLD_MM)) &&
      (panelNode.flatHeight === null || ly <= (panelNode.flatHeight + COORD_MAP_ACCURACY_THRESHOLD_MM));

    if (inBounds) {
      const point3d = unprojectFromPanel(lx, ly, panelNode.panelFrame);
      return { point3d, errorMm: 0 };
    }
  }

  if (panelId !== undefined) {
    const node = graph.nodes.get(panelId as any);
    if (!node || node.type !== 'PanelNode') {
      return {
        code: 'GE_POINT_NOT_ON_PANEL',
        message: `Panel "${panelId}" not found in manufacturing graph.`,
      };
    }
    if (!node.panelFrame) {
      return {
        code: 'GE_PANEL_NO_FRAME',
        message: `Panel "${panelId}" has no panelFrame. ` +
                 'Run split_body_by_bends or get_unfold first.',
      };
    }
    // Panel found but point not in region — still reconstruct (legacy behaviour)
    const [lx, ly] = invertDxfPlacement(node.dxfPlacement, point2d);
    const point3d = unprojectFromPanel(lx, ly, node.panelFrame);
    return { point3d, errorMm: 0 };
  }

  return {
    code: 'GE_POINT_NOT_ON_PANEL',
    message: `No panel region contains point [${point2d.join(', ')}] in the manufacturing graph.`,
  };
}
