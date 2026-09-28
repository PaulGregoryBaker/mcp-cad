/**
 * Row-level compare of two revisions (spec 010 FR-014, T079): graph://diff.
 *
 * Both sides are read with AS OF and fully validated first (the same load
 * path as open_project), then compared table by table on primary key — the
 * same information DOLT_DIFF reports, grouped per part. Identity-preserving
 * persistence (R-016) is what makes this meaningful: an edited vertex keeps
 * its id, so "modified" really means changed, not deleted-and-re-added.
 */

import type { GraphRows } from './row-mapper';

export interface IdChanges {
  added: string[];
  removed: string[];
  modified: string[];
}

export interface PartDiff {
  part_id: string;
  change: 'added' | 'removed' | 'modified';
  region_panels: IdChanges;
  bends: IdChanges;
  holes: IdChanges;
  outline_vertices: { added: number; removed: number; modified: number };
  scalar_changes: Array<{ field: string; from: unknown; to: unknown }>;
}

type Row = Record<string, unknown>;

function byKey<T extends Row>(rows: T[], key: string, filter: (r: T) => boolean = () => true): Map<string, T> {
  return new Map(rows.filter(filter).map((r) => [String(r[key]), r]));
}

const same = (a: Row, b: Row) => JSON.stringify(a) === JSON.stringify(b);

function idChanges(base: Map<string, Row>, target: Map<string, Row>, modifiedExtra: Set<string> = new Set()): IdChanges {
  const out: IdChanges = { added: [], removed: [], modified: [] };
  for (const [id, t] of target) {
    const b = base.get(id);
    if (!b) out.added.push(id);
    else if (!same(b, t) || modifiedExtra.has(id)) out.modified.push(id);
  }
  for (const id of base.keys()) if (!target.has(id)) out.removed.push(id);
  for (const k of ['added', 'removed', 'modified'] as const) out[k].sort();
  return out;
}

const ANCHOR = ['anchor_r00', 'anchor_r01', 'anchor_r02', 'anchor_r10', 'anchor_r11', 'anchor_r12', 'anchor_r20', 'anchor_r21', 'anchor_r22', 'anchor_tx', 'anchor_ty', 'anchor_tz'];
const SCALARS = ['name', 'root_region_panel_id', 'material_id', 'thickness_mm', 'k_factor', 'schema_version', 'merged_into_part_id'];

function scalarChanges(b: Row, t: Row): PartDiff['scalar_changes'] {
  const out: PartDiff['scalar_changes'] = [];
  for (const f of SCALARS) if (JSON.stringify(b[f]) !== JSON.stringify(t[f])) out.push({ field: f, from: b[f] ?? null, to: t[f] ?? null });
  if (ANCHOR.some((f) => b[f] !== t[f])) {
    out.push({ field: 'anchor', from: ANCHOR.map((f) => b[f]), to: ANCHOR.map((f) => t[f]) });
  }
  return out;
}

const isEmpty = (c: IdChanges) => c.added.length + c.removed.length + c.modified.length === 0;

/** Changes from [base] to [target]; unchanged parts are omitted. */
export function diffRevisions(base: GraphRows, target: GraphRows): PartDiff[] {
  const partIds = [...new Set([...base.part.map((p) => p.part_id), ...target.part.map((p) => p.part_id)])].sort();
  const out: PartDiff[] = [];
  for (const pid of partIds) {
    const of = <T extends { part_id: string }>(rows: T[]) => rows.filter((r) => r.part_id === pid);
    const bPart = base.part.find((p) => p.part_id === pid) as Row | undefined;
    const tPart = target.part.find((p) => p.part_id === pid) as Row | undefined;

    const ringsB = byKey(of(base.part_ring) as unknown as Row[], 'ring_id');
    const ringsT = byKey(of(target.part_ring) as unknown as Row[], 'ring_id');
    const vertsIn = (rows: GraphRows, rings: Map<string, Row>, kind: string) =>
      byKey(rows.ring_vertex as unknown as Row[], 'vertex_id', (v) => rings.get(String(v['ring_id']))?.['kind'] === kind);

    const outlineB = vertsIn(base, ringsB, 'outline');
    const outlineT = vertsIn(target, ringsT, 'outline');
    const ov = idChanges(outlineB, outlineT);

    // Holes: circle features plus polygon hole rings; a hole ring whose
    // vertices changed counts as a modified hole.
    const holeVertsB = vertsIn(base, ringsB, 'hole');
    const holeVertsT = vertsIn(target, ringsT, 'hole');
    const touchedHoleRings = new Set<string>();
    for (const [id, v] of holeVertsT) {
      const b = holeVertsB.get(id);
      if (!b || !same(b, v)) touchedHoleRings.add(String(v['ring_id']));
    }
    for (const [id, v] of holeVertsB) if (!holeVertsT.has(id)) touchedHoleRings.add(String(v['ring_id']));
    const holeRing = (r: Row) => r['kind'] === 'hole';
    const holes = idChanges(
      new Map([...byKey(of(base.feature) as unknown as Row[], 'feature_id'), ...[...ringsB].filter(([, r]) => holeRing(r))]),
      new Map([...byKey(of(target.feature) as unknown as Row[], 'feature_id'), ...[...ringsT].filter(([, r]) => holeRing(r))]),
      touchedHoleRings,
    );

    const panels = idChanges(byKey(of(base.region_panel) as unknown as Row[], 'region_panel_id'), byKey(of(target.region_panel) as unknown as Row[], 'region_panel_id'));
    const bends = idChanges(byKey(of(base.bend) as unknown as Row[], 'bend_id'), byKey(of(target.bend) as unknown as Row[], 'bend_id'));
    const scalars = bPart && tPart ? scalarChanges(bPart, tPart) : [];

    const change: PartDiff['change'] = !bPart ? 'added' : !tPart ? 'removed' : 'modified';
    const unchanged =
      change === 'modified' &&
      scalars.length === 0 &&
      isEmpty(panels) &&
      isEmpty(bends) &&
      isEmpty(holes) &&
      ov.added.length + ov.removed.length + ov.modified.length === 0;
    if (unchanged) continue;
    out.push({
      part_id: pid,
      change,
      region_panels: panels,
      bends,
      holes,
      outline_vertices: { added: ov.added.length, removed: ov.removed.length, modified: ov.modified.length },
      scalar_changes: scalars,
    });
  }
  return out;
}
