/**
 * v2 tool argument helpers — self-contained, no import from
 * ts/src/mcp/helpers.ts. v2's tool surface has zero runtime coupling to v1's
 * session/state modules (the plan's "clean break" applies to the whole tool
 * layer, not just the registry).
 */

import { throwError, ErrorCodes } from '../../mcp/errors';
import type { Point2, Transform3Row } from '../graph/types';
import type { EdgeRef } from '../graph/evaluate-client';

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required parameter: ${key}`, false);
  }
  return val;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required numeric parameter: ${key}`, false);
  }
  return val;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  return typeof val === 'string' ? val : undefined;
}

export function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  return typeof val === 'boolean' ? val : undefined;
}

function isPoint2Like(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>)['x'] === 'number' &&
    typeof (val as Record<string, unknown>)['y'] === 'number'
  );
}

export function requirePoint2(args: Record<string, unknown>, key: string): Point2 {
  const val = args[key];
  if (!isPoint2Like(val)) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required 2D point parameter: ${key}`, false);
  }
  return { x: val['x'] as number, y: val['y'] as number };
}

function isTransform3Like(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const r = (val as Record<string, unknown>)['r'];
  const t = (val as Record<string, unknown>)['t'];
  return (
    Array.isArray(r) &&
    r.length === 9 &&
    r.every((v) => typeof v === 'number') &&
    Array.isArray(t) &&
    t.length === 3 &&
    t.every((v) => typeof v === 'number')
  );
}

export function optTransform(
  args: Record<string, unknown>,
  key: string,
): Transform3Row | undefined {
  const val = args[key];
  if (val === undefined) return undefined;
  if (!isTransform3Like(val)) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `${key} must be a {r: number[9], t: number[3]} transform`,
      false,
    );
  }
  const obj = val as { r: number[]; t: number[] };
  return {
    r: obj.r as Transform3Row['r'],
    t: obj.t as Transform3Row['t'],
  };
}

function isEdgeRefLike(val: unknown): val is Record<string, unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    typeof (val as Record<string, unknown>)['region_panel_id'] === 'string' &&
    typeof (val as Record<string, unknown>)['edge_index'] === 'number'
  );
}

export function requireEdgeRef(args: Record<string, unknown>, key: string): EdgeRef {
  const val = args[key];
  if (!isEdgeRefLike(val)) {
    throwError(
      ErrorCodes.GE_INVALID_EDGE_REF,
      `${key} must be a {region_panel_id: string, edge_index: number} edge reference`,
      false,
    );
  }
  return {
    regionPanelId: val['region_panel_id'] as string,
    edgeIndex: val['edge_index'] as number,
  };
}

export function requirePoint2Array(args: Record<string, unknown>, key: string): Point2[] {
  const val = args[key];
  if (!Array.isArray(val) || val.length < 3) {
    throwError(
      ErrorCodes.GE_DEGENERATE_OUTLINE,
      `${key} must be an array of at least 3 {x,y} points`,
      false,
    );
  }
  return val.map((item, i) => {
    if (!isPoint2Like(item)) {
      throwError(ErrorCodes.GE_DEGENERATE_OUTLINE, `${key}[${i}] must be an {x,y} point`, false);
    }
    return { x: item['x'] as number, y: item['y'] as number };
  });
}

/** Like requirePoint2Array, but with no minimum length — move_edge (14 §2.2
 * K2) may replace a vertex range with FEWER points than it removes (or even
 * zero, deleting them outright); the resulting outline's own >=3-vertex
 * floor is GraphStore.moveEdge's concern, not this parser's. */
export function requirePoint2ArrayAllowEmpty(args: Record<string, unknown>, key: string): Point2[] {
  const val = args[key];
  if (!Array.isArray(val)) {
    throwError(ErrorCodes.INTERNAL_ERROR, `${key} must be an array of {x,y} points`, false);
  }
  return val.map((item, i) => {
    if (!isPoint2Like(item)) {
      throwError(ErrorCodes.INTERNAL_ERROR, `${key}[${i}] must be an {x,y} point`, false);
    }
    return { x: item['x'] as number, y: item['y'] as number };
  });
}

/** move_edge's vertex_range param — {start_index, end_index}, both inclusive
 * integer indices into the part's one outline array. */
export function requireVertexRange(
  args: Record<string, unknown>,
  key: string,
): { startIndex: number; endIndex: number } {
  const val = args[key];
  if (typeof val !== 'object' || val === null) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `${key} must be a {start_index, end_index} vertex range`,
      false,
    );
  }
  const obj = val as Record<string, unknown>;
  const startIndex = obj['start_index'];
  const endIndex = obj['end_index'];
  if (typeof startIndex !== 'number' || typeof endIndex !== 'number') {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `${key} must be a {start_index: number, end_index: number} vertex range`,
      false,
    );
  }
  return { startIndex, endIndex };
}

/** A patch field that may be omitted (unchanged), explicitly `null` (clear
 * the override), or a finite number — distinguishes "not in the patch" from
 * "clear this value" the way a plain optNumber (undefined-only) can't. */
export function optNullableNumber(
  args: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in args)) return undefined;
  const val = args[key];
  if (val === null) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  throwError(ErrorCodes.INTERNAL_ERROR, `${key} must be a number or null`, false);
}

/** Same distinction as optNullableNumber, for boolean patch fields. */
export function optNullableBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | null | undefined {
  if (!(key in args)) return undefined;
  const val = args[key];
  if (val === null) return null;
  if (typeof val === 'boolean') return val;
  throwError(ErrorCodes.INTERNAL_ERROR, `${key} must be a boolean or null`, false);
}
