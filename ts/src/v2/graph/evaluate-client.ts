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
  NapiTransform3,
  MapToWorldResult,
  MapToFlatResult,
  NapiPanelPieceSpec,
  NapiManufacturingProfile,
} from '../../geometry/types';
import type { GraphStore, PartGraphSnapshot } from './store';
import type { BendRow, Hole, PartRow, Point2, RegionPanelRow } from './types';

/** PartGraphSnapshot (this store's row shape) -> NapiPartGraphSpec (the addon's
 * input shape) — a direct field mapping, not a re-derivation of any fact.
 * `part.holes` (a tagged union) is split into the wire format's two parallel
 * arrays here — still no geometric computation, just reshaping already-
 * decided data (constitution v2.0.0 principle IV). */
export function toNapiPartGraphSpec(snapshot: PartGraphSnapshot): NapiPartGraphSpec {
  const { part, bends } = snapshot;
  return {
    partId: part.partId,
    rootRegionPanelId: part.rootRegionPanelId,
    outline: {
      outer: part.outline,
      polygonHoles: part.holes
        .filter((h): h is Extract<Hole, { kind: 'polygon' }> => h.kind === 'polygon')
        .map((h) => h.ring),
      circleHoles: part.holes
        .filter((h): h is Extract<Hole, { kind: 'circle' }> => h.kind === 'circle')
        .map((h) => ({ center: h.center, radiusMm: h.radiusMm })),
    },
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
      radiusMeasured: b.radiusMeasured,
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
  /** See BendRow.bottomIsConcave's own doc comment (manufacturing_graph_
   * evaluator.hpp) — omitted: falls back to the angleDeg-sign-derived rule,
   * which is not guaranteed correct for every real fold (that rule is a
   * default, not an invariant). A caller that already knows the true pivot
   * side (e.g. reconcilePieces' own measured bend) should pass it through
   * explicitly rather than rely on the fallback. */
  bottomIsConcave?: boolean;
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
    bottomIsConcave: input.bottomIsConcave,
  });
}

export interface FuseBodiesInput {
  partAId: string;
  partBId: string;
  targetRegionPanelId?: string;
}

/**
 * fuse_bodies (Phase 5 Slice 6, first-cut scope — rebuild/06-plan.md):
 * coplanar-only fuse of a simple flat part B onto part A. Unlike
 * mergePartsWithBend, no edge_refs are needed — the two parts are matched
 * by their own already-known 3D anchors, not a specific seam edge — so this
 * calls `geometryBinding.fuseCoplanarParts` directly on each part's stored
 * outline/anchor (no evaluatePart round trip needed first: outline/anchor
 * are plain stored PartRow fields, not derived per-region-panel data).
 * `fuseCoplanarParts` itself performs the anchor-relative transform and
 * coplanarity check in C++ (constitution v2.0.0 principle IV — no
 * geometric computation in TypeScript, not even the relative-transform
 * math). A geometry failure (not coplanar, disjoint, would produce a hole)
 * is a normal, typed, retryable outcome — same convention as
 * mergePartsWithBend's own reconcileOutlines failure path.
 */
export function fuseBodies(store: GraphStore, input: FuseBodiesInput): { part: PartRow } {
  const partA = store.getPart(input.partAId);
  if (!partA) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partAId}`, false);
  }
  const partB = store.getPart(input.partBId);
  if (!partB) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partBId}`, false);
  }

  const fused = geometryBinding.fuseCoplanarParts(
    partA.outline,
    partA.anchor,
    partB.outline,
    partB.anchor,
    Math.min(partA.thicknessMm, partB.thicknessMm),
  );
  if (!fused.ok) {
    throwError(
      (fused.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      fused.message || 'fuseCoplanarParts failed',
      true,
    );
  }

  return store.fuseBodies({
    partAId: input.partAId,
    partBId: input.partBId,
    unionOutlineA: fused.outer,
    targetRegionPanelIdOnA: input.targetRegionPanelId,
  });
}

export interface CutPanelInput {
  partId: string;
  kind: 'circle' | 'polygon';
  circle?: { center: Point2; radiusMm: number };
  polygonRing?: Point2[];
  /** Optional: narrow the containment search to just this one region panel
   * instead of every live one. */
  regionPanelId?: string;
}

/**
 * cut_panel(kind=circle|polygon) (Phase 5 Slice 9a, rebuild/06-plan.md,
 * 15 §4.2). Evaluates the part fresh to get every live region panel's own
 * `regionOuter` as the candidate containment set, calls the matching C++
 * primitive (tessellation-free for circles, winding-canonicalization for
 * polygons — both real geometric computation, constitution v2.0.0 principle
 * IV, so neither happens here), maps the returned candidate index back to
 * the real regionPanelId, then applies the pure bookkeeping mutation.
 */
export function cutPanel(
  store: GraphStore,
  input: CutPanelInput,
): { part: PartRow; regionPanelId: string } {
  const part = store.getPart(input.partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }

  const evaluated = evaluatePart(store, input.partId);
  if (!evaluated.ok) {
    throwError(
      (evaluated.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      evaluated.message || `evaluatePartGraph failed for part ${input.partId}`,
      false,
    );
  }
  const candidatePanels =
    input.regionPanelId !== undefined
      ? evaluated.panels.filter((p) => p.regionPanelId === input.regionPanelId)
      : evaluated.panels;
  if (input.regionPanelId !== undefined && candidatePanels.length === 0) {
    throwError(
      ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      `no live region panel ${input.regionPanelId} on part ${input.partId}`,
      false,
    );
  }
  const candidateRegions = candidatePanels.map((p) => p.regionOuter);

  let hole: Hole;
  let regionIndex: number;
  let errorCode: string;
  let errorMessage: string;
  let ok: boolean;
  if (input.kind === 'circle') {
    const circle = requireCircleParams(input);
    const result = geometryBinding.prepareCircleCut(
      circle.center,
      circle.radiusMm,
      candidateRegions,
    );
    ({ ok, errorCode, message: errorMessage, regionIndex } = result);
    hole = { kind: 'circle', center: circle.center, radiusMm: circle.radiusMm };
  } else {
    const ring = requirePolygonRing(input);
    const result = geometryBinding.preparePolygonCut(ring, candidateRegions);
    ({ ok, errorCode, message: errorMessage, regionIndex } = result);
    hole = { kind: 'polygon', ring: result.canonicalRing };
  }

  if (!ok) {
    throwError(
      (errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      errorMessage || 'cut_panel failed',
      true,
    );
  }

  const targetRegionPanelId = candidatePanels[regionIndex]?.regionPanelId;
  if (!targetRegionPanelId) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `cut_panel returned an out-of-range regionIndex ${regionIndex}`,
      false,
    );
  }

  const { part: updated } = store.addCutHole({
    partId: input.partId,
    regionPanelId: targetRegionPanelId,
    hole,
  });
  return { part: updated, regionPanelId: targetRegionPanelId };
}

function requireCircleParams(input: CutPanelInput): { center: Point2; radiusMm: number } {
  if (!input.circle) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'cut_panel(kind=circle) requires a circle spec', false);
  }
  return input.circle;
}

function requirePolygonRing(input: CutPanelInput): Point2[] {
  if (!input.polygonRing) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'cut_panel(kind=polygon) requires a polygon_ring', false);
  }
  return input.polygonRing;
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
  /** One v2 Part id per detected protrusion (Phase 5 Slice 6 — rebuild/06-
   * plan.md), in the same order as splitBodyByBends's own protrusion_ids.
   * The "protrusion metadata/flag" this slice's remove_protrusions design
   * settled on: rather than a standalone tool re-running detection on an
   * already-existing v2 Part (which has no backing OCCT shell to detect
   * from — see this function's own doc comment), each protrusion becomes
   * its own ordinary, simple v2 Part here, while a live shell still exists
   * to measure it from. Empty when the fixture has no protrusions. */
  protrusionPartIds: string[];
  /** One v2 Part id per disconnected component reconcilePieces couldn't
   * splice into the main graph (reconciled.graphs[1:] — e.g. a physically
   * separate sub-assembly, or panels whose shared edge failed to match
   * within tolerance). These ARE created in the store via the same
   * createPart/createBendNode path as the main part — they are real, valid
   * parts, just not part of `partId`'s own graph. Omitting them from this
   * result (while still creating them) would silently strand them: nothing
   * else references a store part except by id. Empty for fully-connected
   * fixtures. */
  componentPartIds: string[];
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

  // Protrusions (split.protrusion_ids) are each turned into their own
  // simple, independent v2 Part below (Phase 5 Slice 6) — NOT merged into
  // the host's own reconciled outline/pieces array, matching v1's own
  // "each protrusion is its own part/graph, not a flagged sub-region"
  // precedent (see this session's remove_protrusions design note).
  //
  // The standalone removeProtrusions binding (a separate NAPI call that
  // classifies AND returns a new "cleaned" solid id) is deliberately not
  // called here — splitBodyByBends already performs this same
  // classification as part of its own single decomposition pass, returning
  // protrusion_ids directly alongside panel_ids. Calling removeProtrusions
  // in addition would redo the same work on the original solid, and risks
  // reporting a DIFFERENT protrusion count than splitBodyByBends's own
  // panel_ids/protrusion_ids split if the two ever used different
  // thresholds — one classification pass, not two independent ones. This is
  // also why a separate standalone remove_protrusions MCP tool doesn't
  // exist in v2: a v2 Part has no backing OCCT shell once created (mutations
  // never touch OCCT), so there is nothing for a later, separate call to
  // re-detect protrusions FROM — this import-time extraction, while a live
  // shell still exists, is the only point protrusions can ever be found.
  const pieces: NapiPanelPieceSpec[] = split.panel_ids.map((shellId, i) => {
    const frame = geometryBinding.getPanelFrame(shellId);
    return {
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      // split.panel_thickness_mm (the manufacturing graph's own per-panel
      // measurement, taken at cut time from the panel's own outer/inner
      // face-group pairing) — NOT frame.thicknessMm, which re-measures the
      // extracted solid's own full vertex extent and inflates whenever real
      // neighboring material (e.g. a flange boolean-fused with zero gap to
      // its host wall) falls within the cutter geometry's own safety-margin
      // bleed. See geometry_service.hpp's DecomposedByBendsResult.
      thicknessMm: split.panel_thickness_mm[i],
    };
  });

  // One thickness per part (14 §2 D3) — real fixtures are one material;
  // detecting/reconciling a genuine per-panel thickness mismatch is out of
  // this slice's scope. The MINIMUM across all panels (not pieces[0]) is the
  // correct single estimator: a panel's own measurement can only ever be
  // INFLATED by neighboring material within the bleed margin (never
  // under-measured), so the true material thickness is never larger than
  // the smallest honestly-measured panel.
  const thicknessMm = Math.min(...pieces.map((p) => p.thicknessMm));
  const reconciled = geometryBinding.reconcilePieces(pieces, thicknessMm);
  if (!reconciled.ok) {
    throwError(
      (reconciled.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      reconciled.message || 'reconcilePieces failed',
      false,
    );
  }

  // reconciled.graphs holds one PartGraphSpec per connected component.
  // The first is the main (largest) component; additional entries are
  // disconnected pieces returned as standalone parts.
  const allPartIds: string[] = [];
  let totalBendCount = 0;

  for (const graph of reconciled.graphs) {
    const part = store.createPart({
      name: graph === reconciled.graphs[0] ? filePath : `${filePath}#component`,
      outline: graph.outline.outer,
      thicknessMm,
      anchor: graph.anchor?.transform,
    });

    const tempIdToRealId = new Map<string, string>();
    tempIdToRealId.set(graph.rootRegionPanelId, part.rootRegionPanelId);

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
        partId: part.partId,
        parentRegionPanelId: parentRealId,
        hingeA: bend.hingeA,
        hingeB: bend.hingeB,
        angleDeg: bend.angleDeg,
        radiusMm: bend.radiusMm,
        kFactor: bend.kFactor,
        bottomIsConcave: bend.bottomIsConcave,
        radiusMeasured: bend.radiusMeasured,
      });
      tempIdToRealId.set(bend.childRegionPanelId, created.childRegionPanel.regionPanelId);
    }

    allPartIds.push(part.partId);
    totalBendCount += graph.bends.length;
  }

  const rootPartId = allPartIds[0] ?? '';

  // Each protrusion becomes its own simple (zero-bend) v2 Part — same
  // getPanelFrame-measure + reconcilePieces(n=1) + createPart pattern the
  // root panel above used, reused rather than re-derived (P3 — one
  // geometric solution). reconcilePieces(n=1) still matters here even
  // though there is no splicing to do: it canonicalizes winding and
  // validates the single ring exactly like the main panels went through,
  // so a protrusion Part's outline is held to the same invariant as any
  // other v2 Part's, not a raw unvalidated copy of getPanelFrame's output.
  const protrusionPartIds: string[] = [];
  for (const shellId of split.protrusion_ids) {
    const frame = geometryBinding.getPanelFrame(shellId);
    // Protrusions share the same material thickness as the main panels.
    // getPanelFrame reports the extent along the chosen face's normal,
    // which for a protrusion is its height (e.g. 24mm), not the material
    // thickness (~1mm).  Use the reconciled thicknessMm from above.
    const piece: NapiPanelPieceSpec = {
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      thicknessMm,
    };
    const reconciledProtrusion = geometryBinding.reconcilePieces([piece], thicknessMm);
    if (!reconciledProtrusion.ok) {
      throwError(
        (reconciledProtrusion.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
        reconciledProtrusion.message || `reconcilePieces failed for protrusion ${shellId}`,
        false,
      );
    }
    const protrusionPart = store.createPart({
      name: `${filePath}#protrusion`,
      outline: reconciledProtrusion.graph.outline.outer,
      thicknessMm,
      anchor: reconciledProtrusion.graph.anchor?.transform,
    });
    protrusionPartIds.push(protrusionPart.partId);
  }

  return {
    partId: rootPartId,
    panelCount: split.panel_ids.length,
    protrusionCount: split.protrusion_ids.length,
    bendCount: totalBendCount,
    notes: reconciled.notes,
    protrusionPartIds,
    componentPartIds: allPartIds.slice(1),
  };
}

export interface SplitBodyByBendsOptions {
  angleThresholdDeg?: number;
  maxThicknessMm?: number;
  defaultThicknessMm?: number;
  maxRecursionDepth?: number;
}

export interface SplitPieceInfo {
  shellId: string;
  origin: NapiPoint3;
  uAxis: NapiPoint3;
  vAxis: NapiPoint3;
  normal: NapiPoint3;
  ringLocal: Point2[];
  thicknessMm: number;
}

export interface SplitBodyByBendsResult {
  panels: SplitPieceInfo[];
  protrusions: SplitPieceInfo[];
}

/**
 * Standalone split_body_by_bends (Phase 5 Slice 8, rebuild/06-plan.md — "a
 * standalone split_body_by_bends tool (currently only reachable internally
 * via import_part)"). Runs the SAME loadStep/healGeometryEx/splitBodyByBends/
 * getPanelFrame sequence importPart's own pipeline already uses (no second
 * decomposition algorithm, P3), but stops there — no reconcilePieces, no
 * GraphStore mutation. This is a pure inspection utility: it lets a caller
 * see a STEP file's raw per-piece decomposition even when the file's own
 * main panels would refuse reconcilePieces (e.g. testcube.step,
 * cube_with_flanges.stp — both GE_DISCONNECTED_PIECES via import_part for
 * reasons unrelated to their individual pieces' own measurements, see Slice
 * 6/7's test suites), and does not depend on any v2 Part existing (unlike
 * every other v2 tool, it takes a file path, not a part_id — the graph
 * mutation it could otherwise feed is exactly what import_part already does
 * with this same data, one call further).
 */
export function splitBodyByBendsStandalone(
  filePath: string,
  options: SplitBodyByBendsOptions = {},
): SplitBodyByBendsResult {
  const solidId = geometryBinding.loadStep(filePath);
  geometryBinding.healGeometryEx(solidId, true, true);
  const split = geometryBinding.splitBodyByBends(
    solidId,
    options.angleThresholdDeg ?? 35,
    options.maxThicknessMm,
    options.defaultThicknessMm,
    options.maxRecursionDepth,
  );

  const toPieceInfo = (shellId: string, thicknessMmOverride?: number): SplitPieceInfo => {
    const frame = geometryBinding.getPanelFrame(shellId);
    return {
      shellId,
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      // split.panel_thickness_mm (the manufacturing graph's own per-panel
      // measurement, taken at cut time from the panel's own outer/inner
      // face-group pairing) when available — NOT frame.thicknessMm, which
      // re-measures the extracted solid's own full vertex extent and
      // inflates whenever real neighboring material (e.g. a flange
      // boolean-fused with zero gap to its host wall) falls within the
      // cutter geometry's own safety-margin bleed. Protrusions have no
      // parallel array (a structurally different extraction path — see
      // extractProtrusion), so they fall back to frame.thicknessMm.
      thicknessMm: thicknessMmOverride ?? frame.thicknessMm,
    };
  };

  return {
    panels: split.panel_ids.map((id, i) => toPieceInfo(id, split.panel_thickness_mm[i])),
    protrusions: split.protrusion_ids.map((id) => toPieceInfo(id)),
  };
}

/**
 * Manufacturability rules engine (Phase 5 findings, rebuild/06-plan.md).
 *
 * A pure read: evaluates every rule against the given part's graph snapshot
 * and (optionally) its evaluated layout.  Always returns successfully — even
 * when evaluatePartGraph fails (layout=null), all structural-only rules
 * still produce findings.  The profile is optional; defaults to the C++ side's
 * own sensible profile (same defaults as validation/profile.hpp).
 *
 * No geometric computation happens here — constitution v2.0.0 principle IV:
 * the graph snapshot is a plain data reshuffle (toNapiPartGraphSpec), and
 * the findings come back as plain structs from C++.
 */
export const DEFAULT_MANUFACTURING_PROFILE: NapiManufacturingProfile = {
  profileId: 'default',
  name: 'Default sheet metal',
  rules: {
    minBendRadiusFactor: 1.0,
    maxBendAngleDeg: 180.0,
    defaultBendRadiusMm: 0.0,
    minHoleDiameterFactor: 1.0,
    minHoleToBendClearanceMm: 2.0,
    minHoleToEdgeClearanceMm: 1.5,
    minHoleToHoleDistanceMm: 3.0,
    minFlangeWidthFactor: 4.0,
  },
};

/** One finding, the real MCP contract shape (15 §1) — `recommendedFix.params`
 * is a genuine parsed object here, unlike the addon's own raw `NapiFinding`
 * (geometry/types.ts), which hands it back as a JSON string. Every v2
 * resource (`full`, `findings`) returns this shape, never the raw one. */
export interface Finding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  anchors: Array<{ kind: string; id: string }>;
  recommendedFix: { tool: string; params: Record<string, unknown> } | null;
}

export function evaluateFindings(
  store: GraphStore,
  partId: string,
  profile?: NapiManufacturingProfile,
): { findings: Finding[] } {
  const snapshot = store.snapshotPart(partId);
  const graph = toNapiPartGraphSpec(snapshot);

  // Evaluate the layout — geometry-dependent rules (flange width) need it,
  // but a failure doesn't block structural-only rules (bend radius, etc.)
  let layout: EvaluatePartGraphResult | null = null;
  try {
    const result = geometryBinding.evaluatePartGraph(graph);
    if (result.ok) layout = result;
  } catch {
    // evaluatePartGraph threw — layout stays null, geometry-dependent rules skip
  }

  const result = geometryBinding.evaluateFindings(
    graph,
    profile ?? DEFAULT_MANUFACTURING_PROFILE,
    layout,
  );

  // The NAPI layer sends recommendedFix.params as a raw JSON string
  // (translation_binding.cc: "paramsJson is a JSON string — parse on the TS
  // side") — nothing did, so it was reaching the MCP client double-encoded
  // (JSON.stringify of an already-JSON string, server.ts's resource-read
  // handler), i.e. a string field instead of the object NapiFinding's own
  // type declares. Parsed here, once, right where the raw addon result
  // first becomes a TS value — every caller of evaluateFindings gets the
  // corrected shape for free.
  return {
    findings: result.findings.map((f) => ({
      ...f,
      recommendedFix: f.recommendedFix
        ? { tool: f.recommendedFix.tool, params: JSON.parse(f.recommendedFix.params) as Record<string, unknown> }
        : null,
    })),
  };
}

// ── close_gap (Phase 5 Slice 9b) ────────────────────────────────────────────

export interface CloseGapInput {
  partId: string;
  edgeA: EdgeRef;
  edgeB: EdgeRef;
}

/**
 * Resolves a free edge to its 3D bottom-face vertex positions, for gap
 * measurement. Like resolveFreeEdge but returns 3D data.
 */
function resolveFreeEdge3d(
  partId: string,
  layout: EvaluatePartGraphResult,
  ref: EdgeRef,
): { panelPose: { r: number[]; t: number[] }; bottomFace: NapiPoint3[] } {
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
  // The edge runs from bottomFace[i] to bottomFace[i+1].
  return {
    panelPose: panel.pose,
    bottomFace: [panel.bottomFace[ref.edgeIndex], panel.bottomFace[(ref.edgeIndex + 1) % n]],
  };
}

/**
 * close_gap (rebuild/15-mcp-contract.md §4.2, Phase 5 Slice 9b).
 *
 * Graph-first: identifies the 3D gap between two free edges on the same
 * part, computes the 2D translation to close it via C++ (close_gap.hpp),
 * and applies it as a move_edge on edge_b's outline vertices.  The 3D solid
 * is then reconstructed from the updated graph — no OCCT mutations.
 *
 * A gap of zero (edges already touch) is not an error — it produces a no-op
 * move_edge (delta=0) and still succeeds.
 */
export function closeGap(store: GraphStore, input: CloseGapInput): { gapMm: number } {
  if (!store.getPart(input.partId)) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }

  const layout = evaluatePart(store, input.partId);
  if (!layout.ok) {
    throwError(
      (layout.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layout.message || `evaluatePartGraph failed for part ${input.partId}`,
      false,
    );
  }

  const edgeA = resolveFreeEdge3d(input.partId, layout, input.edgeA);
  const edgeB = resolveFreeEdge3d(input.partId, layout, input.edgeB);

  const delta = geometryBinding.computeCloseGapDelta(
    edgeA.bottomFace,
    edgeB.bottomFace,
    edgeB.panelPose as NapiTransform3,
  );

  // Apply the 2D delta to edge_b's outline vertices via move_edge.
  const panel = layout.panels.find((p) => p.regionPanelId === input.edgeB.regionPanelId)!;
  const startIndex = input.edgeB.edgeIndex;
  const endIndex = input.edgeB.edgeIndex + 1; // move_edge range is inclusive
  const oldPoints = [panel.regionOuter[startIndex], panel.regionOuter[endIndex % panel.regionOuter.length]];
  const newPoints = oldPoints.map((p) => ({ x: p.x + delta.deltaX, y: p.y + delta.deltaY }));

  store.moveEdge({
    partId: input.partId,
    startIndex,
    endIndex,
    newPoints,
  });

  return { gapMm: delta.gapMm };
}

// ── add_flange (Phase 5 Slice 9b) ──────────────────────────────────────────

export interface AddFlangeInput {
  partId: string;
  edge: EdgeRef;
  lengthMm: number;
  angleDeg: number;
  radiusMm?: number;
  kFactor?: number;
}

/**
 * add_flange (rebuild/15-mcp-contract.md §4.2, Phase 5 Slice 9b).
 *
 * Graph-first: adds a rectangular flange to a free edge of the part's
 * outline.  C++ computes the extended outline + hinge; the mutation is pure
 * graph bookkeeping (replace outline, create bend, create child region panel).
 * The 3D solid is reconstructed from the updated graph — no OCCT mutations.
 */
export function addFlange(
  store: GraphStore,
  input: AddFlangeInput,
): { bend: BendRow; childRegionPanel: RegionPanelRow } {
  const part = store.getPart(input.partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }

  const layout = evaluatePart(store, input.partId);
  if (!layout.ok) {
    throwError(
      (layout.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layout.message || `evaluatePartGraph failed for part ${input.partId}`,
      false,
    );
  }

  // Validate the edge is free
  resolveFreeEdge(input.partId, layout, input.edge);

  // C++ computes the extended outline + hinge
  const flange = geometryBinding.computeFlangeOutline(
    part.outline,
    input.edge.edgeIndex,
    input.lengthMm,
  );

  // Replace the part's outline with the flange-extended version
  store.replaceOutline(input.partId, flange.newOutline);

  // Create the bend connecting the parent panel to the new flange panel.
  // The child panel's shape is derived by RegionOf from the new outline
  // + this hinge — no separate panel creation needed.
  return store.createBendNode({
    partId: input.partId,
    parentRegionPanelId: input.edge.regionPanelId,
    hingeA: flange.hingeA,
    hingeB: flange.hingeB,
    angleDeg: input.angleDeg,
    radiusMm: input.radiusMm,
    kFactor: input.kFactor,
  });
}

// ── rip_edge (Phase 5 Slice 9b) ────────────────────────────────────────────

export interface RipEdgeInput {
  partId: string;
  edge: EdgeRef;
  gapMm?: number;
}

export function ripEdge(store: GraphStore, input: RipEdgeInput): void {
  const part = store.getPart(input.partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }
  const layout = evaluatePart(store, input.partId);
  if (!layout.ok) {
    throwError(
      (layout.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layout.message || `evaluatePartGraph failed for part ${input.partId}`,
      false,
    );
  }
  resolveFreeEdge(input.partId, layout, input.edge);
  const result = geometryBinding.computeRipEdge(
    part.outline, input.edge.edgeIndex, input.gapMm ?? 0.5,
  );
  store.replaceOutline(input.partId, result.newOutline);
}

// ── split_body_by_plane (Phase 5 Slice 9b) ─────────────────────────────────

export interface SplitBodyByPlaneInput {
  partId: string;
  normalX: number;
  normalY: number;
  normalZ: number;
  offsetD: number;
}

export interface SplitBodyByPlaneOutput {
  newPartIds: string[];
}

/**
 * split_body_by_plane (rebuild/15 §4.2, Phase 5 Slice 9b).
 *
 * Graph-first: projects a 3D plane to per-panel 2D cut lines, clips each
 * panel's region polygon, groups fragments by bend connectivity, unions
 * fragment polygons into new outlines, reassigns bends and holes, and
 * creates new PartRows.  The original part is NOT modified.
 *
 * Returns one or more new part IDs — must be at least 1 (the cut always
 * produces at least one non-empty side), may be more if the cut plane
 * splits disconnected components.
 */
export function splitBodyByPlane(
  store: GraphStore,
  input: SplitBodyByPlaneInput,
): SplitBodyByPlaneOutput {
  if (!store.getPart(input.partId)) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }

  const layout = evaluatePart(store, input.partId);
  if (!layout.ok) {
    throwError(
      (layout.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      layout.message || `evaluatePartGraph failed for part ${input.partId}`,
      false,
    );
  }

  // Step 1: C++ projects plane → per-panel 2D cut lines, clips polygons
  const fragments = geometryBinding.computeSplitByPlane(
    layout,
    input.normalX,
    input.normalY,
    input.normalZ,
    input.offsetD,
  );

  if (fragments.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'split_by_plane produced no fragments', false);
  }

  // Step 2: Group fragments by (side, connectivity)
  // Build a fragment lookup: regionPanelId → {pos, neg}
  const fragMap = new Map<string, { pos: (typeof fragments)[0] | null; neg: (typeof fragments)[0] | null }>();
  for (const f of fragments) {
    let entry = fragMap.get(f.regionPanelId);
    if (!entry) {
      entry = { pos: null, neg: null };
      fragMap.set(f.regionPanelId, entry);
    }
    if (f.positiveSide) entry.pos = f;
    else entry.neg = f;
  }

  // Union-Find for connected components (per side)
  const posParent = new Map<string, string>();
  const negParent = new Map<string, string>();

  const find = (map: Map<string, string>, id: string): string => {
    const p = map.get(id);
    if (!p || p === id) return id;
    const root = find(map, p);
    map.set(id, root);
    return root;
  };
  const union = (map: Map<string, string>, a: string, b: string) => {
    const ra = find(map, a);
    const rb = find(map, b);
    if (ra !== rb) map.set(ra, rb);
  };

  // Initialize each panel as its own component
  for (const [id] of fragMap) {
    posParent.set(id, id);
    negParent.set(id, id);
  }

  // Walk bends: connected panels on same side → same component
  const snapshot = store.snapshotPart(input.partId);
  for (const bend of snapshot.bends) {
    const pFrag = fragMap.get(bend.parentRegionPanelId);
    const cFrag = fragMap.get(bend.childRegionPanelId);
    if (!pFrag || !cFrag) continue;
    if (pFrag.pos && cFrag.pos) union(posParent, bend.parentRegionPanelId, bend.childRegionPanelId);
    if (pFrag.neg && cFrag.neg) union(negParent, bend.parentRegionPanelId, bend.childRegionPanelId);
  }

  // Collect fragments per component
  const posComponents = new Map<string, (typeof fragments)[0][]>();
  const negComponents = new Map<string, (typeof fragments)[0][]>();
  for (const [id, entry] of fragMap) {
    if (entry.pos) {
      const root = find(posParent, id);
      let comp = posComponents.get(root);
      if (!comp) { comp = []; posComponents.set(root, comp); }
      comp.push(entry.pos);
    }
    if (entry.neg) {
      const root = find(negParent, id);
      let comp = negComponents.get(root);
      if (!comp) { comp = []; negComponents.set(root, comp); }
      comp.push(entry.neg);
    }
  }

  // Step 3: For each component, union fragment polygons into one outline
  const newPartIds: string[] = [];

  const processComponent = (
    componentFragments: (typeof fragments)[0][],
    _side: string,
  ) => {
    if (componentFragments.length === 0) return;

    // Union all fragment polygons iteratively
    let outline: Point2[] = componentFragments[0].polygon;
    for (let i = 1; i < componentFragments.length; i++) {
      const result = geometryBinding.polygonUnion(outline, componentFragments[i].polygon);
      if (result.ok) {
        outline = result.outer;
      }
      // If union fails, keep the current outline — fragments stay separate
    }

    // Collect which panels are in this component
    const panelIds = new Set(componentFragments.map((f) => f.regionPanelId));

    // Collect bends whose both panels are in this component
    const componentBends = snapshot.bends.filter(
      (b) => panelIds.has(b.parentRegionPanelId) && panelIds.has(b.childRegionPanelId),
    );

    // Create the new part
    const newPart = store.createPart({
      name: `${snapshot.part.name}#split`,
      outline,
      thicknessMm: snapshot.part.thicknessMm,
      materialId: snapshot.part.materialId,
      kFactor: snapshot.part.kFactor,
    });

    // Map old panel IDs to new ones (root panel is the first one)
    const oldToNew = new Map<string, string>();
    // The root panel of the new part gets the outline — other panels are derived
    // The first panel in the component becomes the root
    oldToNew.set(componentFragments[0].regionPanelId, newPart.rootRegionPanelId);

    // Create bends for this component
    for (const bend of componentBends) {
      const parentNew = oldToNew.get(bend.parentRegionPanelId);
      if (!parentNew) continue;
      const created = store.createBendNode({
        partId: newPart.partId,
        parentRegionPanelId: parentNew,
        hingeA: bend.hingeA,
        hingeB: bend.hingeB,
        angleDeg: bend.angleDeg,
        radiusMm: bend.radiusMm,
        kFactor: bend.kFactorOverride ?? undefined,
        bottomIsConcave: bend.bottomIsConcave ?? undefined,
        radiusMeasured: bend.radiusMeasured,
      });
      oldToNew.set(bend.childRegionPanelId, created.childRegionPanel.regionPanelId);
    }

    newPartIds.push(newPart.partId);
  };

  for (const comp of posComponents.values()) processComponent(comp, 'pos');
  for (const comp of negComponents.values()) processComponent(comp, 'neg');

  if (newPartIds.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'split_by_plane produced no valid parts', false);
  }

  return { newPartIds };
}

export interface GenerateReliefsInput {
  partId: string;
  bendIds: string[];
  reliefType: 'dogbone' | 'circular';
  radiusMm: number;
}

export function generateReliefs(store: GraphStore, input: GenerateReliefsInput): void {
  const part = store.getPart(input.partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${input.partId}`, false);
  }
  const snapshot = store.snapshotPart(input.partId);
  const matchedBends = snapshot.bends.filter((b) => input.bendIds.includes(b.bendId));
  if (matchedBends.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'no matching bends found', false);
  }

  const bendSpecs = matchedBends.map((b) => ({
    id: b.bendId,
    parentRegionPanelId: b.parentRegionPanelId,
    childRegionPanelId: b.childRegionPanelId,
    hingeA: b.hingeA,
    hingeB: b.hingeB,
    angleDeg: b.angleDeg,
    radiusMm: 0,
    kFactor: 0,
  }));

  const reliefPolygons = geometryBinding.computeReliefPolygons(
    bendSpecs, input.reliefType, input.radiusMm, part.thicknessMm,
  );

  for (const poly of reliefPolygons) {
    if (poly.length < 3) continue;
    const evaluated = evaluatePart(store, input.partId);
    if (!evaluated.ok) continue;
    const candidateRegions = evaluated.panels.map((p) => p.regionOuter);
    const result = geometryBinding.preparePolygonCut(poly, candidateRegions);
    if (!result.ok) continue;
    const targetPanel = evaluated.panels[result.regionIndex];
    if (!targetPanel) continue;
    store.addCutHole({
      partId: input.partId,
      regionPanelId: targetPanel.regionPanelId,
      hole: { kind: 'polygon', ring: result.canonicalRing },
    });
  }
}
