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
  NapiPoint3,
  MapToWorldResult,
  MapToFlatResult,
  NapiPanelPieceSpec,
} from '../../geometry/types';
import type { GraphStore, PartGraphSnapshot } from './store';
import type { BendRow, Point2, RegionPanelRow } from './types';

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
      bottomIsConcave: b.bottomIsConcave ?? undefined,
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

/**
 * Forward mapping (2D->3D, rebuild/13-translation-module-design.md §4) — a
 * genuine "not on any region panel or bridge" (GE_POINT_NOT_ON_PART) is a
 * normal read outcome, not thrown; only evaluate() itself failing (a bad
 * graph) throws, matching constructPart's own convention above.
 */
export function mapPointToWorld(
  store: GraphStore,
  partId: string,
  point2d: Point2,
  zMm?: number,
): MapToWorldResult {
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
  return geometryBinding.mapPointToWorld(graph, layout, point2d, zMm);
}

/** Reverse mapping (3D->2D, §5) — same "GE_POINT_NOT_ON_PART is a normal
 * outcome, not thrown" convention as mapPointToWorld above. */
export function mapPointToFlat(
  store: GraphStore,
  partId: string,
  point3d: NapiPoint3,
): MapToFlatResult {
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
  return geometryBinding.mapPointToFlat(graph, layout, point3d);
}

/** A free (non-hinge) boundary edge reference (Phase 5 Slice 4): edge
 * `edgeIndex` of `regionPanelId`'s own already-computed boundary — the exact
 * same (regionOuter, edgeBendId) pair every other v2 reader already uses
 * (e.g. the map-2d-3d resource, Slice 3's own test code), never a re-derived
 * raw-outline index. */
export interface EdgeRef {
  regionPanelId: string;
  edgeIndex: number;
}

function resolveFreeEdge(
  partId: string,
  layout: EvaluatePartGraphResult,
  ref: EdgeRef,
): { p0: Point2; p1: Point2 } {
  const panel = layout.panels.find((p) => p.regionPanelId === ref.regionPanelId);
  if (!panel) {
    throwError(
      ErrorCodes.GE_INVALID_EDGE_REF,
      `no live region panel ${ref.regionPanelId} on part ${partId}`,
      false,
    );
  }
  const n = panel.regionOuter.length;
  if (!Number.isInteger(ref.edgeIndex) || ref.edgeIndex < 0 || ref.edgeIndex >= n) {
    throwError(
      ErrorCodes.GE_INVALID_EDGE_REF,
      `edgeIndex ${ref.edgeIndex} out of range for region panel ${ref.regionPanelId} (${n} edges)`,
      false,
    );
  }
  if (panel.edgeBendId[ref.edgeIndex] !== '') {
    throwError(
      ErrorCodes.GE_INVALID_EDGE_REF,
      `edge ${ref.edgeIndex} of region panel ${ref.regionPanelId} is a bend zone boundary, not a free edge`,
      false,
    );
  }
  return { p0: panel.regionOuter[ref.edgeIndex], p1: panel.regionOuter[(ref.edgeIndex + 1) % n] };
}

export interface MergePartsWithBendInput {
  partAId: string;
  partBId: string;
  edgeA: EdgeRef;
  edgeB: EdgeRef;
  angleDeg: number;
  radiusMm?: number;
  kFactor?: number;
}

/**
 * merge_bodies_with_bend (14 §2.1.2): resolves each caller-given edge_ref to
 * its live 2D endpoints (via evaluatePartGraph — never re-derived), calls the
 * ONE place this reconciliation is computed (part_merge.hpp's
 * reconcileOutlines, pure C++), and — only on success — applies the result as
 * an ordinary GraphStore mutation (re-parent B's rows, alias B, create the
 * connecting bend via the existing createBendNode path). A reconciliation
 * failure (mismatched edge lengths, a self-intersecting splice) is a normal,
 * typed outcome, not a bad-graph exception — thrown with the addon's own
 * errorCode, same convention as constructPart's addon-failure path above.
 */
export function mergePartsWithBend(
  store: GraphStore,
  input: MergePartsWithBendInput,
): { bend: BendRow; childRegionPanel: RegionPanelRow } {
  const partA = store.getPart(input.partAId);
  if (!partA) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partAId}`, false);
  }
  const partB = store.getPart(input.partBId);
  if (!partB) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partBId}`, false);
  }

  const layoutA = evaluatePart(store, input.partAId);
  if (!layoutA.ok) {
    throwError(
      (layoutA.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layoutA.message || `evaluatePartGraph failed for part ${input.partAId}`,
      false,
    );
  }
  const layoutB = evaluatePart(store, input.partBId);
  if (!layoutB.ok) {
    throwError(
      (layoutB.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layoutB.message || `evaluatePartGraph failed for part ${input.partBId}`,
      false,
    );
  }

  const edgeA = resolveFreeEdge(input.partAId, layoutA, input.edgeA);
  const edgeB = resolveFreeEdge(input.partBId, layoutB, input.edgeB);

  const reconciled = geometryBinding.reconcileOutlines(
    partA.outline,
    edgeA.p0,
    edgeA.p1,
    partB.outline,
    edgeB.p0,
    edgeB.p1,
  );
  if (!reconciled.ok) {
    throwError(
      (reconciled.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      reconciled.message || 'reconcileOutlines failed',
      true,
    );
  }

  return store.mergePartsWithBend({
    partAId: input.partAId,
    partBId: input.partBId,
    combinedOutlineA: reconciled.combinedOutline,
    hingeA: reconciled.hingeA,
    hingeB: reconciled.hingeB,
    parentRegionPanelIdOnA: input.edgeA.regionPanelId,
    angleDeg: input.angleDeg,
    radiusMm: input.radiusMm,
    kFactor: input.kFactor,
  });
}

export interface ImportPartOptions {
  angleThresholdDeg?: number;
  maxThicknessMm?: number;
  defaultThicknessMm?: number;
  maxRecursionDepth?: number;
}

export interface ImportPartResult {
  partId: string;
  panelCount: number;
  protrusionCount: number;
  bendCount: number;
  notes: string[];
}

/**
 * import_part (rebuild/15-mcp-contract.md §4.1; synchronous this slice, per
 * the approved plan's own scope decision — the async job/progress protocol
 * is a UX layer addable later without touching this logic). Orchestrates
 * already-existing kernel operations (Port A/B, zero new NAPI surface:
 * loadStep, healGeometryEx, splitBodyByBends, getPanelFrame per resulting
 * panel shell) then the one genuinely new step — reconcilePieces (pure C++,
 * 13 §6) — then materializes the result through the SAME createPart/
 * createBendNode path every other v2 tool uses (no privileged bulk-insert
 * route that could drift from createBendNode's own invariants), walking
 * `graph.bends` in the returned parent-before-child order and remapping
 * reconcilePieces' temporary "piece{N}" correlation ids onto the real UUIDs
 * GraphStore mints.
 */
export function importPart(
  store: GraphStore,
  filePath: string,
  options: ImportPartOptions = {},
): ImportPartResult {
  const solidId = geometryBinding.loadStep(filePath);
  geometryBinding.healGeometryEx(solidId, true, true);

  const split = geometryBinding.splitBodyByBends(
    solidId,
    options.angleThresholdDeg ?? 35,
    options.maxThicknessMm,
    options.defaultThicknessMm,
    options.maxRecursionDepth,
  );

  if (split.panel_ids.length === 0) {
    throwError(
      ErrorCodes.GE_IMPORT_NO_PANELS_FOUND,
      `splitBodyByBends found no panels for ${filePath}`,
      false,
    );
  }

  // Protrusions (split.protrusion_ids) are detected and excluded, not
  // represented in the graph — an explicit, documented deferral (matching
  // Slices 1-4's own "flagged, not silently dropped" convention), not a
  // scope decision hidden inside the code.
  //
  // The standalone removeProtrusions binding (a separate NAPI call that
  // classifies AND returns a new "cleaned" solid id) is deliberately not
  // called here — splitBodyByBends already performs this same
  // classification as part of its own single decomposition pass, returning
  // protrusion_ids directly alongside panel_ids. Calling removeProtrusions
  // in addition would redo the same work on the original solid, and risks
  // reporting a DIFFERENT protrusion count than splitBodyByBends's own
  // panel_ids/protrusion_ids split if the two ever used different
  // thresholds — one classification pass, not two independent ones.
  const pieces: NapiPanelPieceSpec[] = split.panel_ids.map((shellId) => {
    const frame = geometryBinding.getPanelFrame(shellId);
    return {
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      thicknessMm: frame.thicknessMm,
    };
  });

  // One thickness per part (14 §2 D3) — real fixtures are one material;
  // detecting/reconciling a genuine per-panel thickness mismatch is out of
  // this slice's scope.
  const thicknessMm = pieces[0].thicknessMm;
  const reconciled = geometryBinding.reconcilePieces(pieces, thicknessMm);
  if (!reconciled.ok) {
    throwError(
      (reconciled.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      reconciled.message || 'reconcilePieces failed',
      false,
    );
  }

  const graph = reconciled.graph;
  const rootPart = store.createPart({
    name: filePath,
    outline: graph.outline.outer,
    thicknessMm,
    anchor: graph.anchor?.transform,
  });

  const tempIdToRealId = new Map<string, string>();
  tempIdToRealId.set(graph.rootRegionPanelId, rootPart.rootRegionPanelId);

  for (const bend of graph.bends) {
    const parentRealId = tempIdToRealId.get(bend.parentRegionPanelId);
    if (parentRealId === undefined) {
      throwError(
        ErrorCodes.INTERNAL_ERROR,
        `reconcilePieces returned bend ${bend.id} referencing an unknown parent ${bend.parentRegionPanelId}`,
        false,
      );
    }
    const created = store.createBendNode({
      partId: rootPart.partId,
      parentRegionPanelId: parentRealId,
      hingeA: bend.hingeA,
      hingeB: bend.hingeB,
      angleDeg: bend.angleDeg,
      radiusMm: bend.radiusMm,
      kFactor: bend.kFactor,
      bottomIsConcave: bend.bottomIsConcave,
    });
    tempIdToRealId.set(bend.childRegionPanelId, created.childRegionPanel.regionPanelId);
  }

  return {
    partId: rootPart.partId,
    panelCount: split.panel_ids.length,
    protrusionCount: split.protrusion_ids.length,
    bendCount: graph.bends.length,
    notes: reconciled.notes,
  };
}
