/**
 * v2 manufacturing graph — in-memory store (Phase 5 Slice 1).
 *
 * Pure bookkeeping: mints stable row IDs (14 §2 principle 3 — UUIDs, minted
 * once, never reused), holds rows in memory, never calls the geometry addon.
 * `create_node(kind=bend)` creates the bend row + new child region panel
 * atomically (14 §2.1.1), matching the approved plan's tool contract. Dolt
 * persistence (branch/commit/merge, 14 §6) is explicitly deferred — this store
 * is the one thing Slice 2+ will need to swap out, everything reading FROM it
 * (evaluate-client, resources, tools) should not need to change when that
 * happens.
 */

import { randomUUID } from 'node:crypto';
import type { BendRow, Hole, PartRow, Point2, RegionPanelRow, Transform3Row } from './types';
import { identityTransform } from './types';
import { ErrorCodes, type ErrorCode } from '../../mcp/errors';

export interface CreatePartInput {
  name: string;
  outline: Point2[];
  thicknessMm: number;
  materialId?: string;
  kFactor?: number;
  anchor?: Transform3Row;
}

export interface CreateBendNodeInput {
  partId: string;
  parentRegionPanelId: string;
  hingeA: Point2;
  hingeB: Point2;
  angleDeg: number;
  radiusMm?: number;
  kFactor?: number;
  label?: string;
  /** See BendRow.bottomIsConcave's own doc comment. Omitted: falls back to
   * the angleDeg-sign rule (matches every caller before this field existed). */
  bottomIsConcave?: boolean;
  /** See BendRow.radiusMeasured's own doc comment. Omitted: defaults true
   * (every caller here is an explicit, authored bend). */
  radiusMeasured?: boolean;
}

/**
 * merge_bodies_with_bend's graph bookkeeping (14 §2.1.2), given an ALREADY-
 * COMPUTED combined outline + hinge segment — the pure 2D reconciliation
 * itself (aligning B's edge to A's edge, splicing the outlines) is real
 * geometry and lives in C++ (part_merge.hpp); this store never derives it,
 * only applies the result. `combinedOutlineA` replaces A's one stored
 * outline; `parentRegionPanelIdOnA` is the live region panel of A that owned
 * the matched seam edge (the new bend's parent, exactly like an ordinary
 * within-part split).
 */
export interface MergePartsWithBendInput {
  partAId: string;
  partBId: string;
  combinedOutlineA: Point2[];
  hingeA: Point2;
  hingeB: Point2;
  parentRegionPanelIdOnA: string;
  angleDeg: number;
  radiusMm?: number;
  kFactor?: number;
  /** See BendRow.bottomIsConcave's own doc comment. Omitted: falls back to
   * the angleDeg-sign rule (matches every caller before this field existed). */
  bottomIsConcave?: boolean;
  /** See BendRow.radiusMeasured's own doc comment. Omitted: defaults true. */
  radiusMeasured?: boolean;
}

/**
 * fuse_bodies (Phase 5 Slice 6, first-cut scope — rebuild/06-plan.md):
 * absorbs a simple flat part B into part A by replacing A's outline with the
 * ALREADY-COMPUTED 2D union (real geometry, computed once in C++ via
 * `geometryBinding.fuseCoplanarParts` — this store never derives it, only
 * applies the result, same discipline as `mergePartsWithBend`). Unlike a
 * bend-join, no new bend row is created (there is no fold — B's material
 * becomes part of A's SAME shared flat frame): B's own root region panel is
 * aliased directly onto A's target region panel instead.
 */
export interface FuseBodiesInput {
  partAId: string;
  partBId: string;
  unionOutlineA: Point2[];
  /** Which of A's (possibly several, if A has its own bends) region panels
   * the fused material logically belongs to. Defaults to A's root region
   * panel. */
  targetRegionPanelIdOnA?: string;
}

/** update_node(kind=part) (15 §4.3) — a plain field patch, no re-derivation:
 * only fields actually present (`!== undefined`) are applied, so a patch can
 * still explicitly clear a nullable field without touching the others. */
export interface UpdatePartInput {
  partId: string;
  name?: string;
  materialId?: string;
  kFactor?: number;
  anchor?: Transform3Row;
}

/** update_node(kind=bend) (15 §4.3) — bend angle/radius/k-factor-override/
 * pivot-side edits. `kFactorOverride`/`bottomIsConcave` accept `null`
 * (explicit clear) distinctly from `undefined` (field omitted, unchanged). */
export interface UpdateBendInput {
  bendId: string;
  angleDeg?: number;
  radiusMm?: number;
  kFactorOverride?: number | null;
  bottomIsConcave?: boolean | null;
  /** See BendRow.radiusMeasured's own doc comment. Omitted: left as-is,
   * UNLESS radiusMm is provided in this same patch, in which case it's set
   * true automatically — an explicit radius edit is by definition no longer
   * reconciliation's unmeasured placeholder. */
  radiusMeasured?: boolean;
}

/** update_node(kind=region_panel) (15 §4.3) — label/k-factor-override edits. */
export interface UpdateRegionPanelInput {
  regionPanelId: string;
  label?: string;
  kFactorOverride?: number | null;
}

/** move_edge (15 §4.3, 14 §2.2 K2) — replaces vertices [startIndex, endIndex]
 * (inclusive) of the part's ONE shared outline with `newPoints` (which may
 * be a different length than the replaced range, so this also covers
 * inserting/removing vertices, not just translating existing ones). A pure
 * array splice — no geometric computation (constitution v2.0.0 principle
 * IV); a resulting self-intersecting or mis-wound outline is NOT pre-
 * validated here, it surfaces as a typed error the next time evaluatePart/
 * constructPart actually walks it (same "no silent fallback" discipline as
 * every other mutation — the geometry engine is the one place that check
 * belongs, not a second copy of it in TypeScript). */
export interface MoveEdgeInput {
  partId: string;
  startIndex: number;
  endIndex: number;
  newPoints: Point2[];
}

/** cut_panel (Phase 5 Slice 9a, 15 §4.2/§4.3) — the hole itself has already
 * been validated (containment check, winding canonicalization for polygons)
 * by geometryBinding.prepareCircleCut/preparePolygonCut; this is pure
 * bookkeeping, appending it to the part's own holes list. `regionPanelId` is
 * accepted for the same alias-liveness check every other mutation makes, but
 * — unlike a bend's parent/child region panels — is NOT stored per-hole
 * (14 D2's own feature table, which WOULD track that, is still a future
 * slice; RegionOf's own containment check re-derives which panel a hole
 * belongs to on every read, so no stored back-reference is needed yet). */
export interface AddCutHoleInput {
  partId: string;
  regionPanelId: string;
  hole: Hole;
}

export class GraphStoreError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
  ) {
    super(message);
    this.name = 'GraphStoreError';
  }
}

/**
 * A snapshot of every row for one part — what evaluate-client.ts converts into
 * the C++ addon's PartGraphSpec, and what the replay-invariant harness
 * serializes/re-reads (14 §6 — "the replay harness serializes -> re-reads ->
 * compares layouts").
 */
export interface PartGraphSnapshot {
  part: PartRow;
  regionPanels: RegionPanelRow[];
  bends: BendRow[];
}

export class GraphStore {
  private readonly parts = new Map<string, PartRow>();
  private readonly regionPanels = new Map<string, RegionPanelRow>();
  private readonly bends = new Map<string, BendRow>();

  createPart(input: CreatePartInput): PartRow {
    if (input.outline.length < 3) {
      throw new GraphStoreError(
        `part outline must have at least 3 vertices, got ${input.outline.length}`,
        ErrorCodes.GE_DEGENERATE_OUTLINE,
      );
    }
    const partId = randomUUID();
    const rootRegionPanelId = randomUUID();

    const part: PartRow = {
      partId,
      name: input.name,
      rootRegionPanelId,
      outline: input.outline,
      holes: [],
      anchor: input.anchor ?? identityTransform(),
      materialId: input.materialId ?? 'default',
      thicknessMm: input.thicknessMm,
      kFactor: input.kFactor ?? 0.0,
      schemaVersion: '0.1',
      mergedIntoPartId: null,
    };
    const root: RegionPanelRow = {
      regionPanelId: rootRegionPanelId,
      partId,
      label: 'root',
      kFactorOverride: null,
      mergedIntoRegionPanelId: null,
    };

    this.parts.set(partId, part);
    this.regionPanels.set(rootRegionPanelId, root);
    return part;
  }

  createBendNode(input: CreateBendNodeInput): { bend: BendRow; childRegionPanel: RegionPanelRow } {
    const part = this.parts.get(input.partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${input.partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    const parent = this.regionPanels.get(input.parentRegionPanelId);
    if (!parent || parent.partId !== input.partId) {
      throw new GraphStoreError(
        `no live region panel ${input.parentRegionPanelId} on part ${input.partId}`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }
    if (parent.mergedIntoRegionPanelId !== null) {
      throw new GraphStoreError(
        `region panel ${input.parentRegionPanelId} is an alias (merged), not a live tree member`,
        ErrorCodes.GRAPH_REGION_PANEL_ALIASED,
      );
    }

    const bendId = randomUUID();
    const childRegionPanelId = randomUUID();

    const bend: BendRow = {
      bendId,
      partId: input.partId,
      parentRegionPanelId: input.parentRegionPanelId,
      childRegionPanelId,
      hingeA: input.hingeA,
      hingeB: input.hingeB,
      angleDeg: input.angleDeg,
      radiusMm: input.radiusMm ?? 0.0,
      kFactorOverride: input.kFactor ?? null,
      bottomIsConcave: input.bottomIsConcave ?? null,
      radiusMeasured: input.radiusMeasured ?? true,
    };
    const child: RegionPanelRow = {
      regionPanelId: childRegionPanelId,
      partId: input.partId,
      label: input.label ?? `region-${childRegionPanelId.slice(0, 8)}`,
      kFactorOverride: null,
      mergedIntoRegionPanelId: null,
    };

    this.bends.set(bendId, bend);
    this.regionPanels.set(childRegionPanelId, child);
    return { bend, childRegionPanel: child };
  }

  /**
   * merge_bodies_with_bend (14 §2.1.2): (1) replace A's outline with the
   * already-spliced combined outline, (2) re-parent every B region-panel/bend
   * row onto A's partId — mutated in place, since this store's row maps are
   * flat/store-wide rather than per-part, so re-parenting is a field
   * assignment, not a data move — (3) alias B via mergedIntoPartId, (4)
   * create the connecting bend via the ordinary createBendNode path (the
   * exact same operation a within-part split uses — not a distinct join
   * primitive). B is never deleted.
   */
  mergePartsWithBend(input: MergePartsWithBendInput): {
    bend: BendRow;
    childRegionPanel: RegionPanelRow;
  } {
    const partA = this.parts.get(input.partAId);
    if (!partA) {
      throw new GraphStoreError(
        `no part with id ${input.partAId}`,
        ErrorCodes.GRAPH_PART_NOT_FOUND,
      );
    }
    const partB = this.parts.get(input.partBId);
    if (!partB) {
      throw new GraphStoreError(
        `no part with id ${input.partBId}`,
        ErrorCodes.GRAPH_PART_NOT_FOUND,
      );
    }
    if (partA.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partAId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }
    if (partB.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partBId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }

    partA.outline = input.combinedOutlineA;

    for (const panel of this.regionPanels.values()) {
      if (panel.partId === input.partBId) panel.partId = input.partAId;
    }
    for (const bend of this.bends.values()) {
      if (bend.partId === input.partBId) bend.partId = input.partAId;
    }
    partB.mergedIntoPartId = input.partAId;

    return this.createBendNode({
      partId: input.partAId,
      parentRegionPanelId: input.parentRegionPanelIdOnA,
      hingeA: input.hingeA,
      hingeB: input.hingeB,
      angleDeg: input.angleDeg,
      radiusMm: input.radiusMm,
      kFactor: input.kFactor,
      bottomIsConcave: input.bottomIsConcave,
      radiusMeasured: input.radiusMeasured,
    });
  }

  /**
   * fuse_bodies (Phase 5 Slice 6): (1) replace A's outline with the
   * already-unioned outline, (2) alias B's part row AND its root region
   * panel row directly onto A / A's target region panel — no re-parenting
   * loop and no new bend, since B (first-cut scope: guaranteed bend-free,
   * checked below) contributes no rows into A's tree beyond its own now-
   * absorbed outline material. B is never deleted.
   */
  fuseBodies(input: FuseBodiesInput): { part: PartRow } {
    const partA = this.parts.get(input.partAId);
    if (!partA) {
      throw new GraphStoreError(
        `no part with id ${input.partAId}`,
        ErrorCodes.GRAPH_PART_NOT_FOUND,
      );
    }
    const partB = this.parts.get(input.partBId);
    if (!partB) {
      throw new GraphStoreError(
        `no part with id ${input.partBId}`,
        ErrorCodes.GRAPH_PART_NOT_FOUND,
      );
    }
    if (partA.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partAId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }
    if (partB.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partBId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }

    const bHasBends = [...this.bends.values()].some((b) => b.partId === input.partBId);
    if (bHasBends) {
      throw new GraphStoreError(
        `part ${input.partBId} has its own bends — fuse_bodies' first-cut scope only ` +
          `supports fusing a simple flat part (see rebuild/06-plan.md Slice 6)`,
        ErrorCodes.GRAPH_FUSE_PART_B_NOT_SIMPLE,
      );
    }

    const targetRegionPanelId = input.targetRegionPanelIdOnA ?? partA.rootRegionPanelId;
    const targetPanel = this.regionPanels.get(targetRegionPanelId);
    if (!targetPanel || targetPanel.partId !== input.partAId) {
      throw new GraphStoreError(
        `no live region panel ${targetRegionPanelId} on part ${input.partAId}`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }
    if (targetPanel.mergedIntoRegionPanelId !== null) {
      throw new GraphStoreError(
        `region panel ${targetRegionPanelId} is an alias (merged), not a live tree member`,
        ErrorCodes.GRAPH_REGION_PANEL_ALIASED,
      );
    }

    partA.outline = input.unionOutlineA;

    const bRoot = this.regionPanels.get(partB.rootRegionPanelId);
    if (!bRoot) {
      throw new GraphStoreError(
        `part ${input.partBId}'s own root region panel ${partB.rootRegionPanelId} is missing`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }
    bRoot.mergedIntoRegionPanelId = targetRegionPanelId;
    partB.mergedIntoPartId = input.partAId;

    return { part: partA };
  }

  /** update_node(kind=part) (Phase 5 Slice 8, 15 §4.3). */
  updatePart(input: UpdatePartInput): PartRow {
    const part = this.parts.get(input.partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${input.partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    if (part.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }
    if (input.name !== undefined) part.name = input.name;
    if (input.materialId !== undefined) part.materialId = input.materialId;
    if (input.kFactor !== undefined) part.kFactor = input.kFactor;
    if (input.anchor !== undefined) part.anchor = input.anchor;
    return part;
  }

  /** update_node(kind=bend) (Phase 5 Slice 8, 15 §4.3). */
  updateBendNode(input: UpdateBendInput): BendRow {
    const bend = this.bends.get(input.bendId);
    if (!bend) {
      throw new GraphStoreError(`no bend with id ${input.bendId}`, ErrorCodes.GRAPH_BEND_NOT_FOUND);
    }
    if (input.angleDeg !== undefined) bend.angleDeg = input.angleDeg;
    if (input.radiusMm !== undefined) {
      bend.radiusMm = input.radiusMm;
      // An explicit radius edit is by definition no longer reconciliation's
      // unmeasured placeholder — see BendRow.radiusMeasured's own doc comment.
      bend.radiusMeasured = true;
    }
    if (input.kFactorOverride !== undefined) bend.kFactorOverride = input.kFactorOverride;
    if (input.bottomIsConcave !== undefined) bend.bottomIsConcave = input.bottomIsConcave;
    if (input.radiusMeasured !== undefined) bend.radiusMeasured = input.radiusMeasured;
    return bend;
  }

  /** update_node(kind=region_panel) (Phase 5 Slice 8, 15 §4.3). */
  updateRegionPanel(input: UpdateRegionPanelInput): RegionPanelRow {
    const panel = this.regionPanels.get(input.regionPanelId);
    if (!panel) {
      throw new GraphStoreError(
        `no region panel with id ${input.regionPanelId}`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }
    if (panel.mergedIntoRegionPanelId !== null) {
      throw new GraphStoreError(
        `region panel ${input.regionPanelId} is an alias (merged), not a live tree member`,
        ErrorCodes.GRAPH_REGION_PANEL_ALIASED,
      );
    }
    if (input.label !== undefined) panel.label = input.label;
    if (input.kFactorOverride !== undefined) panel.kFactorOverride = input.kFactorOverride;
    return panel;
  }

  /**
   * delete_node(kind=bend) (Phase 5 Slice 8, 14 §2.1.1) — the PANEL-level
   * merge: the inverse of createBendNode, entirely within one part (unlike
   * mergePartsWithBend/fuseBodies's PART-level merge, no part aliasing is
   * involved here). Deletes the bend row outright (not aliased — unlike a
   * part or region panel, nothing else in the current schema references a
   * bend by id once it's gone), re-parents any bends that hung directly off
   * the removed bend's child region panel onto the removed bend's OWN
   * parent (promoted one level up — exactly mergePartsWithBend's re-
   * parenting pattern, applied to one edge instead of a whole part's rows),
   * and aliases the child region panel onto that same parent so any
   * existing reference to it keeps resolving.
   */
  deleteBendNode(bendId: string): {
    partId: string;
    mergedRegionPanelId: string;
    ontoRegionPanelId: string;
  } {
    const bend = this.bends.get(bendId);
    if (!bend) {
      throw new GraphStoreError(`no bend with id ${bendId}`, ErrorCodes.GRAPH_BEND_NOT_FOUND);
    }
    const childPanel = this.regionPanels.get(bend.childRegionPanelId);
    if (!childPanel) {
      throw new GraphStoreError(
        `bend ${bendId}'s own child region panel ${bend.childRegionPanelId} is missing`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }

    for (const child of this.bends.values()) {
      if (child.parentRegionPanelId === bend.childRegionPanelId) {
        child.parentRegionPanelId = bend.parentRegionPanelId;
      }
    }

    childPanel.mergedIntoRegionPanelId = bend.parentRegionPanelId;
    this.bends.delete(bendId);

    return {
      partId: bend.partId,
      mergedRegionPanelId: bend.childRegionPanelId,
      ontoRegionPanelId: bend.parentRegionPanelId,
    };
  }

  /** move_edge (Phase 5 Slice 8, 15 §4.3, 14 §2.2 K2). */
  moveEdge(input: MoveEdgeInput): { part: PartRow } {
    const part = this.parts.get(input.partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${input.partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    if (part.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }
    const n = part.outline.length;
    if (
      input.startIndex < 0 ||
      input.endIndex < input.startIndex ||
      input.endIndex >= n ||
      !Number.isInteger(input.startIndex) ||
      !Number.isInteger(input.endIndex)
    ) {
      throw new GraphStoreError(
        `vertex_range [${input.startIndex}, ${input.endIndex}] is out of bounds for a ` +
          `${n}-vertex outline`,
        ErrorCodes.GRAPH_INVALID_VERTEX_RANGE,
      );
    }

    const newOutline = [
      ...part.outline.slice(0, input.startIndex),
      ...input.newPoints,
      ...part.outline.slice(input.endIndex + 1),
    ];
    if (newOutline.length < 3) {
      throw new GraphStoreError(
        `resulting outline would have only ${newOutline.length} vertices (minimum 3)`,
        ErrorCodes.GE_DEGENERATE_OUTLINE,
      );
    }
    part.outline = newOutline;
    return { part };
  }

  /** cut_panel (Phase 5 Slice 9a, 15 §4.2/§4.3). */
  addCutHole(input: AddCutHoleInput): { part: PartRow } {
    const part = this.parts.get(input.partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${input.partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    if (part.mergedIntoPartId !== null) {
      throw new GraphStoreError(
        `part ${input.partId} is an alias (already merged), not a live part`,
        ErrorCodes.GRAPH_PART_ALIASED,
      );
    }
    const regionPanel = this.regionPanels.get(input.regionPanelId);
    if (!regionPanel || regionPanel.partId !== input.partId) {
      throw new GraphStoreError(
        `no live region panel ${input.regionPanelId} on part ${input.partId}`,
        ErrorCodes.GRAPH_REGION_PANEL_NOT_FOUND,
      );
    }
    if (regionPanel.mergedIntoRegionPanelId !== null) {
      throw new GraphStoreError(
        `region panel ${input.regionPanelId} is an alias (merged), not a live tree member`,
        ErrorCodes.GRAPH_REGION_PANEL_ALIASED,
      );
    }

    part.holes.push(input.hole);
    return { part };
  }

  getPart(partId: string): PartRow | undefined {
    return this.parts.get(partId);
  }

  getRegionPanel(regionPanelId: string): RegionPanelRow | undefined {
    return this.regionPanels.get(regionPanelId);
  }

  getBend(bendId: string): BendRow | undefined {
    return this.bends.get(bendId);
  }

  /** Every row belonging to one part — the unit evaluate-client.ts consumes. */
  snapshotPart(partId: string): PartGraphSnapshot {
    const part = this.parts.get(partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    const regionPanels = [...this.regionPanels.values()].filter((p) => p.partId === partId);
    const bends = [...this.bends.values()].filter((b) => b.partId === partId);
    return { part, regionPanels, bends };
  }

  /** Every row in the store — 14 §6's replay path: serialize -> re-read -> compare. */
  /**
   * Replace a part's outline (e.g. when adding a flange).  The new outline
   * must have at least 3 vertices and be CCW.  Holes are preserved — only
   * the outer ring is replaced.
   */
  replaceOutline(partId: string, newOutline: Point2[]): PartRow {
    const part = this.parts.get(partId);
    if (!part) {
      throw new GraphStoreError(`no part with id ${partId}`, ErrorCodes.GRAPH_PART_NOT_FOUND);
    }
    if (newOutline.length < 3) {
      throw new GraphStoreError(
        `new outline must have at least 3 vertices, got ${newOutline.length}`,
        ErrorCodes.GE_DEGENERATE_OUTLINE,
      );
    }
    part.outline = newOutline;
    return part;
  }

  /**
   * Reset one part's live working state in place to a prior snapshot (same
   * partId — no new part is created). This is the rollback/discard
   * operation (B5d, rebuild/02-requirements.md): removes every region panel
   * and bend currently belonging to this part and replaces them with the
   * snapshot's rows under their original stored IDs.
   */
  restorePart(snapshot: PartGraphSnapshot): PartRow {
    const partId = snapshot.part.partId;
    for (const [id, panel] of this.regionPanels) {
      if (panel.partId === partId) this.regionPanels.delete(id);
    }
    for (const [id, bend] of this.bends) {
      if (bend.partId === partId) this.bends.delete(id);
    }
    this.parts.set(partId, snapshot.part);
    for (const panel of snapshot.regionPanels) this.regionPanels.set(panel.regionPanelId, panel);
    for (const bend of snapshot.bends) this.bends.set(bend.bendId, bend);
    return snapshot.part;
  }

  serialize(): { parts: PartRow[]; regionPanels: RegionPanelRow[]; bends: BendRow[] } {
    return {
      parts: [...this.parts.values()],
      regionPanels: [...this.regionPanels.values()],
      bends: [...this.bends.values()],
    };
  }

  static deserialize(data: {
    parts: PartRow[];
    regionPanels: RegionPanelRow[];
    bends: BendRow[];
  }): GraphStore {
    const store = new GraphStore();
    for (const part of data.parts) store.parts.set(part.partId, part);
    for (const panel of data.regionPanels) store.regionPanels.set(panel.regionPanelId, panel);
    for (const bend of data.bends) store.bends.set(bend.bendId, bend);
    return store;
  }
}
