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
import type { BendRow, PartRow, Point2, RegionPanelRow, Transform3Row } from './types';
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
