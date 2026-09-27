/**
 * Structural graph invariants (spec 010, R-013 layer 3).
 *
 * Checked on every persisted write (before the SQL transaction — a violation
 * there is this server's own bug) and on every load (a violation means stored
 * data is corrupt; the load aborts, nothing reaches the GraphStore).
 *
 * STRUCTURE AND SCALARS ONLY. Constitution principle IV (NON-NEGOTIABLE): no
 * geometric computation in TypeScript — not winding, not intersection, not
 * point-in-polygon, not matrix checks. Geometric validity (outline winding
 * and self-intersection, holes inside the outline, a degenerate hinge, an
 * anchor that isn't a rotation) is the C++ evaluator's job and is already
 * reported per part when a mesh/flat pattern is built. Such a part must still
 * *load*, so the user can open the project and repair it.
 */

import type { PartGraphSnapshot } from './store';

export type InvariantCode =
  | 'INV_ROOT_PANEL_MISSING'
  | 'INV_FOREIGN_ROW'
  | 'INV_DUPLICATE_ID'
  | 'INV_BEND_DANGLING'
  | 'INV_BEND_TOPOLOGY'
  | 'INV_PARAM_RANGE'
  | 'INV_BEND_PARAM'
  | 'INV_MERGE_SELF'
  | 'INV_MERGE_TARGET_MISSING'
  | 'INV_META_ORPHAN';

export interface InvariantViolation {
  code: InvariantCode;
  partId: string;
  message: string;
}

/**
 * Documented exceptions: states a tool deliberately produces that would
 * otherwise violate an invariant. Each entry MUST name the tool and the
 * reason. Empty by policy until a real case is found (T016 sweep); never
 * loosen a rule silently instead of listing it here.
 */
export const INVARIANT_EXCEPTIONS: ReadonlyArray<{ code: InvariantCode; tool: string; reason: string }> = [];

function inRange01(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Per-part structural invariants. */
export function checkGraphInvariants(snapshot: PartGraphSnapshot): InvariantViolation[] {
  const { part, regionPanels, bends } = snapshot;
  const out: InvariantViolation[] = [];
  const v = (code: InvariantCode, message: string): void => {
    out.push({ code, partId: part.partId, message });
  };

  // ── Scalars (all parts, including merged-away tombstones) ────────────────
  if (!(Number.isFinite(part.thicknessMm) && part.thicknessMm > 0)) {
    v('INV_PARAM_RANGE', `thicknessMm must be > 0 (got ${part.thicknessMm})`);
  }
  if (!inRange01(part.kFactor)) v('INV_PARAM_RANGE', `kFactor must be in [0, 1] (got ${part.kFactor})`);
  if (part.mergedIntoPartId !== null && part.mergedIntoPartId === part.partId) {
    v('INV_MERGE_SELF', 'part is marked as merged into itself');
  }

  // ── Row ownership and identity ───────────────────────────────────────────
  const panelIds = new Set<string>();
  for (const p of regionPanels) {
    if (p.partId !== part.partId) v('INV_FOREIGN_ROW', `region panel ${p.regionPanelId} belongs to ${p.partId}`);
    if (panelIds.has(p.regionPanelId)) v('INV_DUPLICATE_ID', `duplicate region panel id ${p.regionPanelId}`);
    panelIds.add(p.regionPanelId);
    if (p.kFactorOverride !== null && !inRange01(p.kFactorOverride)) {
      v('INV_PARAM_RANGE', `region panel ${p.regionPanelId} kFactorOverride must be in [0, 1]`);
    }
    if (p.mergedIntoRegionPanelId === p.regionPanelId) {
      v('INV_MERGE_SELF', `region panel ${p.regionPanelId} is marked as merged into itself`);
    }
  }
  const bendIds = new Set<string>();
  for (const b of bends) {
    if (b.partId !== part.partId) v('INV_FOREIGN_ROW', `bend ${b.bendId} belongs to ${b.partId}`);
    if (bendIds.has(b.bendId)) v('INV_DUPLICATE_ID', `duplicate bend id ${b.bendId}`);
    bendIds.add(b.bendId);
    if (!(Number.isFinite(b.radiusMm) && b.radiusMm >= 0)) {
      v('INV_BEND_PARAM', `bend ${b.bendId} radiusMm must be >= 0`);
    }
    // Only finiteness is structural. An out-of-range angle (e.g. |a| > 180)
    // is a deliberate, storable state reported as a manufacturability finding
    // (MAX_BEND_ANGLE) — 14-graph-schema's K5 rule: findings, not write
    // blocks. Found by the T016 invariant sweep (findings_resource scenario 3).
    if (!Number.isFinite(b.angleDeg)) {
      v('INV_BEND_PARAM', `bend ${b.bendId} angleDeg must be a finite number (got ${b.angleDeg})`);
    }
    if (b.kFactorOverride !== null && !inRange01(b.kFactorOverride)) {
      v('INV_PARAM_RANGE', `bend ${b.bendId} kFactorOverride must be in [0, 1]`);
    }
  }
  const holeIds = new Set<string>();
  for (const h of part.holes) {
    if (holeIds.has(h.holeId)) v('INV_DUPLICATE_ID', `duplicate hole id ${h.holeId}`);
    holeIds.add(h.holeId);
  }

  // A merged-away part is an alias: its panels/bends now belong to the
  // absorbing part, so it has no tree of its own to check.
  if (part.mergedIntoPartId !== null) return out;

  // ── Fold tree (live parts) ──────────────────────────────────────────────
  const panelById = new Map(regionPanels.map((p) => [p.regionPanelId, p]));
  const root = panelById.get(part.rootRegionPanelId);
  if (!root) {
    v('INV_ROOT_PANEL_MISSING', `root region panel ${part.rootRegionPanelId} is not among the part's region panels`);
    return out;
  }
  if (root.mergedIntoRegionPanelId !== null) {
    v('INV_ROOT_PANEL_MISSING', `root region panel ${root.regionPanelId} is a merged alias, not live`);
  }

  const live = new Set(regionPanels.filter((p) => p.mergedIntoRegionPanelId === null).map((p) => p.regionPanelId));
  const incoming = new Map<string, number>();
  const children = new Map<string, string[]>();
  let danglingOrDead = false;
  for (const b of bends) {
    for (const [role, id] of [
      ['parent', b.parentRegionPanelId],
      ['child', b.childRegionPanelId],
    ] as const) {
      if (!panelById.has(id)) {
        v('INV_BEND_DANGLING', `bend ${b.bendId} ${role} region panel ${id} does not exist`);
        danglingOrDead = true;
      } else if (!live.has(id)) {
        v('INV_BEND_DANGLING', `bend ${b.bendId} ${role} region panel ${id} is a merged alias, not live`);
        danglingOrDead = true;
      }
    }
    if (b.parentRegionPanelId === b.childRegionPanelId) {
      v('INV_BEND_TOPOLOGY', `bend ${b.bendId} connects region panel ${b.childRegionPanelId} to itself`);
    }
    incoming.set(b.childRegionPanelId, (incoming.get(b.childRegionPanelId) ?? 0) + 1);
    const list = children.get(b.parentRegionPanelId) ?? [];
    list.push(b.childRegionPanelId);
    children.set(b.parentRegionPanelId, list);
  }
  if (danglingOrDead) return out;

  if ((incoming.get(part.rootRegionPanelId) ?? 0) > 0) {
    v('INV_BEND_TOPOLOGY', `root region panel ${part.rootRegionPanelId} has an incoming bend`);
  }
  for (const id of live) {
    if (id === part.rootRegionPanelId) continue;
    const n = incoming.get(id) ?? 0;
    if (n !== 1) v('INV_BEND_TOPOLOGY', `live region panel ${id} has ${n} incoming bends (expected exactly 1)`);
  }

  // Reachability from the root (also catches cycles detached from the root).
  const seen = new Set<string>([part.rootRegionPanelId]);
  const queue = [part.rootRegionPanelId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) {
        v('INV_BEND_TOPOLOGY', `region panel ${c} is reached twice (cycle or diamond in the fold tree)`);
        continue;
      }
      seen.add(c);
      queue.push(c);
    }
  }
  for (const id of live) {
    if (!seen.has(id)) v('INV_BEND_TOPOLOGY', `live region panel ${id} is not reachable from the root`);
  }

  return out;
}

/** Cross-row invariants over one project's whole graph (run once per load/write). */
export function checkStoreInvariants(
  snapshots: PartGraphSnapshot[],
  clientMetaPartIds: Iterable<string> = [],
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const partIds = new Set(snapshots.map((s) => s.part.partId));
  for (const s of snapshots) {
    const target = s.part.mergedIntoPartId;
    if (target !== null && !partIds.has(target)) {
      out.push({
        code: 'INV_MERGE_TARGET_MISSING',
        partId: s.part.partId,
        message: `merged into part ${target}, which does not exist`,
      });
    }
  }
  for (const id of clientMetaPartIds) {
    if (!partIds.has(id)) {
      out.push({ code: 'INV_META_ORPHAN', partId: id, message: `client_meta row for part ${id}, which does not exist` });
    }
  }
  return out;
}
