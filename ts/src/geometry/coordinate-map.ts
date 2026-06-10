/**
 * Bidirectional 3D-to-2D coordinate mapping for manufacturing graph panels.
 *
 * Given a panel's PanelFrame (origin + u/v axes stored on PanelNode), we can
 * project any 3D world-space point into the panel's local 2D flat-pattern
 * coordinate system and vice-versa.
 *
 * Accuracy: ≤ COORD_MAP_ACCURACY_THRESHOLD_MM (0.1 mm) round-trip error
 * for planar panels. Curved edges are not supported in Phase 1.
 *
 * Feature: 011-graph-driven-geometry (US3 — Coordinate Mapping)
 */

import type { ManufacturingGraphData } from '../manufacturing/graph/types';
import type { PanelFrame } from '../manufacturing/dxf/orientation';

/** Maximum acceptable projection error (mm) to consider a point "on" a panel surface. */
const COORD_MAP_ACCURACY_THRESHOLD_MM = 0.1;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface CoordinateMapResult {
  /** The panel whose surface contains the projected point. */
  panelId: string;
  /** XY position in the panel's DXF flat-pattern coordinate space (mm). */
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Subtract two 3-vectors.
 */
function sub3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/**
 * Dot product of two 3-vectors.
 */
function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Scale a 3-vector.
 */
function scale3(v: [number, number, number], s: number): [number, number, number] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/**
 * Add two 3-vectors.
 */
function add3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Compute the normal to a PanelFrame as cross(u, v).
 */
function frameNormal(frame: PanelFrame): [number, number, number] {
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  return [
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ];
}

/**
 * Project a 3D world-space point onto the panel's local 2D (U, V) axes.
 *
 * Steps:
 *   1. Translate to panel origin: d = p - origin
 *   2. Project onto U axis: u_coord = dot(d, u)
 *   3. Project onto V axis: v_coord = dot(d, v)
 *   4. Project onto normal: height = dot(d, n)  (distance above panel surface)
 *
 * Returns: { u, v, height } where u,v are 2D flat-pattern coordinates and
 * height is the signed distance from the panel surface (0 = on surface).
 */
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

/**
 * Reconstruct a 3D world-space point from panel-local (U, V) coordinates.
 *
 * Inverse of projectOntoPanel (with height = 0, i.e. the point lies on the
 * panel surface).
 *
 *   p = origin + u * u_coord + v * v_coord
 */
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Map a 3D world-space point to its 2D DXF flat-pattern coordinates.
 *
 * The function iterates all canonical PanelNodes in the manufacturing graph,
 * projects the point onto each panel's face plane, and returns the one with
 * the smallest perpendicular distance (|height|).
 *
 * If the smallest |height| exceeds COORD_MAP_ACCURACY_THRESHOLD_MM the point
 * is not on any panel surface and GE_POINT_NOT_ON_PANEL is returned.
 *
 * @param point3d  3D world-space point [x, y, z] in mm.
 * @param graph    ManufacturingGraph for the part.
 * @returns CoordinateMapResult on success, CoordinateMapError otherwise.
 */
export function map3dTo2d(
  point3d: [number, number, number],
  graph: ManufacturingGraphData,
): CoordinateMapResult | CoordinateMapError {
  let bestPanelId: string | null = null;
  let bestU = 0;
  let bestV = 0;
  let bestHeight = Infinity;

  for (const node of graph.nodes.values()) {
    if (node.type !== 'PanelNode' || node.canonical === false) continue;
    const panelNode = node;
    if (!panelNode.panelFrame) continue;

    const { u, v, height } = projectOntoPanel(point3d, panelNode.panelFrame);
    const absHeight = Math.abs(height);
    if (absHeight < bestHeight) {
      bestHeight = absHeight;
      bestPanelId = panelNode.id as string;
      bestU = u;
      bestV = v;
    }
  }

  if (bestPanelId === null) {
    return {
      code: 'GE_PANEL_NO_FRAME',
      message: 'No panel in the manufacturing graph has a panelFrame. ' +
               'Run split_body_by_bends or apply_unfold first to populate panel frames.',
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
    xy: [bestU, bestV],
    errorMm: bestHeight,
  };
}

/**
 * Map a 2D DXF flat-pattern coordinate back to a 3D world-space point.
 *
 * Uses the PanelFrame stored on the specified PanelNode to reconstruct the
 * 3D position that corresponds to the given (X, Y) flat-pattern coordinates.
 *
 * @param panelId  Node ID of the target PanelNode.
 * @param point2d  2D DXF coordinate [x, y] in mm.
 * @param graph    ManufacturingGraph for the part.
 * @returns { point3d } on success, CoordinateMapError otherwise.
 */
export function map2dTo3d(
  panelId: string,
  point2d: [number, number],
  graph: ManufacturingGraphData,
): { point3d: [number, number, number]; errorMm: number } | CoordinateMapError {
  const node = graph.nodes.get(panelId as any);
  if (!node || node.type !== 'PanelNode') {
    return {
      code: 'GE_POINT_NOT_ON_PANEL',
      message: `Panel "${panelId}" not found in manufacturing graph.`,
    };
  }

  const panelNode = node;
  if (!panelNode.panelFrame) {
    return {
      code: 'GE_PANEL_NO_FRAME',
      message: `Panel "${panelId}" has no panelFrame. ` +
               'Run split_body_by_bends or apply_unfold first.',
    };
  }

  const point3d = unprojectFromPanel(point2d[0], point2d[1], panelNode.panelFrame);
  return { point3d, errorMm: 0 };
}
