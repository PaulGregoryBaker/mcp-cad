/**
 * v2 evaluate client (Phase 5 Slice 1).
 *
 * Converts a GraphStore snapshot into the C++ addon's PartGraphSpec shape and
 * calls evaluatePartGraph/constructPartSolid — the ONLY place graph rows become
 * addon calls. Pure marshaling: no geometric computation happens here
 * (constitution v2.0.0 principle IV) — every coordinate, pose, and bridge in the
 * result is exactly what ManufacturingGraphEvaluator/ConstructPartSolid computed,
 * untouched.
 */

import { geometryBinding } from '../../geometry/binding';
import { throwError, ErrorCodes, type ErrorCode } from '../../mcp/errors';
import type {
  NapiPartGraphSpec,
  EvaluatePartGraphResult,
  ConstructPartSolidResult,
} from '../../geometry/types';
import type { GraphStore, PartGraphSnapshot } from './store';

/** PartGraphSnapshot (this store's row shape) -> NapiPartGraphSpec (the addon's
 * input shape) — a direct field mapping, not a re-derivation of any fact. */
export function toNapiPartGraphSpec(snapshot: PartGraphSnapshot): NapiPartGraphSpec {
  const { part, bends } = snapshot;
  return {
    partId: part.partId,
    rootRegionPanelId: part.rootRegionPanelId,
    outline: { outer: part.outline },
    bends: bends.map((b) => ({
      id: b.bendId,
      parentRegionPanelId: b.parentRegionPanelId,
      childRegionPanelId: b.childRegionPanelId,
      hingeA: b.hingeA,
      hingeB: b.hingeB,
      angleDeg: b.angleDeg,
      radiusMm: b.radiusMm,
      kFactor: b.kFactorOverride ?? part.kFactor,
    })),
    thicknessMm: part.thicknessMm,
    anchor: { transform: part.anchor },
  };
}

/** Look up a part's rows and evaluate them — the pose/region/bridge Layout
 * every other v2 tool and resource reads (14 §3's "same Layout answers every
 * consumer" — one computation, many reads). */
export function evaluatePart(store: GraphStore, partId: string): EvaluatePartGraphResult {
  const snapshot = store.snapshotPart(partId);
  const graph = toNapiPartGraphSpec(snapshot);
  return geometryBinding.evaluatePartGraph(graph);
}

/**
 * Evaluate + construct the realized solid for a part, throwing a
 * StructuredError (never a raw addon error) on either step's failure —
 * constitution v2.0.0 principle VI, typed errors at every boundary.
 */
export function constructPart(store: GraphStore, partId: string): ConstructPartSolidResult {
  const snapshot = store.snapshotPart(partId);
  const graph = toNapiPartGraphSpec(snapshot);
  const layout = geometryBinding.evaluatePartGraph(graph);
  if (!layout.ok) {
    throwError(
      (layout.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layout.message || `evaluatePartGraph failed for part ${partId}`,
      false,
    );
  }
  const result = geometryBinding.constructPartSolid(layout, snapshot.part.thicknessMm);
  if (!result.ok) {
    throwError(
      (result.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      result.message || `constructPartSolid failed for part ${partId}`,
      false,
    );
  }
  return result;
}
