/**
 * PartGraphSnapshot <-> normalised rows (spec 010, R-016, T019).
 *
 * Identity is the point: the same vertex/hole/panel/bend keeps the same row
 * id and order key across saves, so Dolt diffs read as engineering changes
 * (14 §4, D2.1) and a one-vertex edit writes one vertex row.
 *
 *  - Holes carry a persistent holeId (polygon → part_ring.ring_id, circle →
 *    feature.feature_id); their interleaved order is `hole_order_key`.
 *  - Outline/hole vertices are plain Point2[] in memory. A per-ring
 *    VertexShadow (ids + keys + coordinates from the last load/save) is aligned
 *    against the new coordinates by longest-common-subsequence on EXACT
 *    coordinate equality (identity bookkeeping, not geometry — constitution
 *    principle IV). Matched vertices keep id + key; inserted ones get
 *    fractional keys between their neighbours.
 *
 * Pure: no I/O. DoltPersistence owns the shadows and the SQL.
 */

import { randomUUID } from 'crypto';
import type { PartGraphSnapshot } from '../graph/store';
import type { BendRow, Hole, PartRow, Point2, RegionPanelRow } from '../graph/types';

// ─── Fractional order keys ────────────────────────────────────────────────────
// Keys are fractional digit strings over base-62 in ASCII order (so SQL
// binary collation and JS `<` agree). '' stands for 0 and null for 1 as
// bounds; real keys are never empty and never end in '0'.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const digit = (c: string | undefined): number => (c === undefined ? 0 : ALPHABET.indexOf(c));

/** A key strictly between `a` ('' = 0) and `b` (null = 1). */
export function keyBetween(a: string, b: string | null): string {
  if (b !== null && !(a < b)) throw new Error(`keyBetween: '${a}' is not < '${b}'`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + keyBetween(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const db = b !== null ? digit(b[0]) : BASE;
  if (db - da > 1) return ALPHABET[Math.round((da + db) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return ALPHABET[da]! + keyBetween(a.slice(1), null);
}

/** `n` increasing keys strictly between `a` and `b`, spread evenly (balanced split). */
export function keysBetween(a: string, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const midIndex = Math.floor(n / 2);
  const mid = keyBetween(a, b);
  return [...keysBetween(a, mid, midIndex), mid, ...keysBetween(mid, b, n - midIndex - 1)];
}

// ─── Row shapes (snake_case = SQL columns) ───────────────────────────────────

export interface PartDbRow {
  part_id: string;
  name: string;
  root_region_panel_id: string;
  anchor_r00: number; anchor_r01: number; anchor_r02: number;
  anchor_r10: number; anchor_r11: number; anchor_r12: number;
  anchor_r20: number; anchor_r21: number; anchor_r22: number;
  anchor_tx: number; anchor_ty: number; anchor_tz: number;
  material_id: string;
  thickness_mm: number;
  k_factor: number;
  schema_version: string;
  merged_into_part_id: string | null;
}
export interface RingDbRow {
  ring_id: string;
  part_id: string;
  kind: 'outline' | 'hole';
  hole_order_key: string | null;
}
export interface VertexDbRow {
  vertex_id: string;
  ring_id: string;
  order_key: string;
  x: number;
  y: number;
  bulge: number;
}
export interface FeatureDbRow {
  feature_id: string;
  part_id: string;
  kind: 'hole_circle';
  cx: number;
  cy: number;
  r: number;
  poly_ring_id: null;
  process: null;
  hole_order_key: string;
}
export interface PanelDbRow {
  region_panel_id: string;
  part_id: string;
  label: string;
  k_factor_override: number | null;
  merged_into_region_panel_id: string | null;
  order_key: string;
}
export interface BendDbRow {
  bend_id: string;
  part_id: string;
  parent_region_panel_id: string;
  child_region_panel_id: string;
  hinge_ax: number; hinge_ay: number; hinge_bx: number; hinge_by: number;
  angle_deg: number;
  radius_mm: number;
  k_factor_override: number | null;
  bottom_is_concave: boolean | null;
  radius_measured: boolean;
  bend_process: string | null;
  order_key: string;
}

export interface GraphRows {
  part: PartDbRow[];
  part_ring: RingDbRow[];
  ring_vertex: VertexDbRow[];
  feature: FeatureDbRow[];
  region_panel: PanelDbRow[];
  bend: BendDbRow[];
}

export type GraphTable = keyof GraphRows;

export const PRIMARY_KEY: Record<GraphTable, string> = {
  part: 'part_id',
  part_ring: 'ring_id',
  ring_vertex: 'vertex_id',
  feature: 'feature_id',
  region_panel: 'region_panel_id',
  bend: 'bend_id',
};

/** Parents before children (upserts); reversed for deletes. */
export const TABLE_ORDER: GraphTable[] = ['part', 'region_panel', 'part_ring', 'ring_vertex', 'feature', 'bend'];

export function emptyRows(): GraphRows {
  return { part: [], part_ring: [], ring_vertex: [], feature: [], region_panel: [], bend: [] };
}

// ─── Shadows ────────────────────────────────────────────────────────────────

export interface VertexShadow {
  ids: string[];
  keys: string[];
  pts: Point2[];
}

/** Everything identity-related remembered per part between saves. */
export interface PartShadow {
  outlineRingId: string;
  rings: Map<string, VertexShadow>; // ring_id -> vertices
  holeKeys: Map<string, string>; // holeId -> hole_order_key
  panelKeys: Map<string, string>; // region_panel_id -> order_key
  bendKeys: Map<string, string>; // bend_id -> order_key
}

export type ShadowStore = Map<string, PartShadow>; // part_id -> shadow

const LCS_CELL_LIMIT = 4_000_000;

function samePoint(a: Point2, b: Point2): boolean {
  return a.x === b.x && a.y === b.y; // exact identity, not a geometric tolerance
}

/**
 * Aligns a ring's new coordinates against its shadow. Returns ids and keys
 * for every new vertex (matched → reused; inserted → fresh id, key between
 * neighbours). Falls back to a full rewrite when the unmatched middle is too
 * large for the DP table (logged by the caller via the returned flag).
 */
export function alignRing(shadow: VertexShadow | undefined, pts: Point2[]): { shadow: VertexShadow; fullRewrite: boolean } {
  const fresh = (): VertexShadow => ({ ids: pts.map(() => randomUUID()), keys: keysBetween('', null, pts.length), pts: pts.map((p) => ({ ...p })) });
  if (!shadow || shadow.pts.length === 0) return { shadow: fresh(), fullRewrite: false };

  const old = shadow.pts;
  const n = old.length;
  const m = pts.length;
  // Common prefix/suffix first: most edits are local.
  let pre = 0;
  while (pre < n && pre < m && samePoint(old[pre]!, pts[pre]!)) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && samePoint(old[n - 1 - suf]!, pts[m - 1 - suf]!)) suf++;

  const oldMid = n - pre - suf;
  const newMid = m - pre - suf;
  const match: Array<number | -1> = new Array(m).fill(-1); // new index -> old index
  for (let i = 0; i < pre; i++) match[i] = i;
  for (let i = 0; i < suf; i++) match[m - 1 - i] = n - 1 - i;

  let fullRewrite = false;
  if (oldMid > 0 && newMid > 0) {
    if ((oldMid + 1) * (newMid + 1) > LCS_CELL_LIMIT) {
      fullRewrite = true;
    } else {
      const w = newMid + 1;
      const dp = new Uint32Array((oldMid + 1) * w);
      for (let i = oldMid - 1; i >= 0; i--) {
        for (let j = newMid - 1; j >= 0; j--) {
          dp[i * w + j] = samePoint(old[pre + i]!, pts[pre + j]!)
            ? dp[(i + 1) * w + j + 1]! + 1
            : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
        }
      }
      let i = 0;
      let j = 0;
      while (i < oldMid && j < newMid) {
        if (samePoint(old[pre + i]!, pts[pre + j]!)) {
          match[pre + j] = pre + i;
          i++;
          j++;
        } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
        else j++;
      }
    }
  }
  if (fullRewrite) return { shadow: fresh(), fullRewrite: true };

  const ids: string[] = new Array(m);
  const keys: string[] = new Array(m);
  let k = 0;
  while (k < m) {
    const oi = match[k]!;
    if (oi !== -1) {
      ids[k] = shadow.ids[oi]!;
      keys[k] = shadow.keys[oi]!;
      k++;
      continue;
    }
    let end = k;
    while (end < m && match[end] === -1) end++;
    const lo = k > 0 ? keys[k - 1]! : '';
    const hi = end < m ? shadow.keys[match[end] as number]! : null;
    const gen = keysBetween(lo, hi, end - k);
    for (let t = k; t < end; t++) {
      ids[t] = randomUUID();
      keys[t] = gen[t - k]!;
    }
    k = end;
  }
  return { shadow: { ids, keys, pts: pts.map((p) => ({ ...p })) }, fullRewrite: false };
}

/**
 * Order keys for an ordered list of ids, reusing each surviving id's previous
 * key while the survivors are still in increasing key order (so appends and
 * deletes touch only the rows they must); otherwise renumbers all.
 */
export function orderKeys(ids: string[], previous: Map<string, string> | undefined): Map<string, string> {
  return holeOrderKeys(ids.map((id) => ({ holeId: id }) as Hole), previous);
}

function holeOrderKeys(holes: Array<Pick<Hole, 'holeId'>>, previous: Map<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  // Reuse previous keys if the surviving holes are still in increasing key order.
  let lastKey = '';
  let reusable = true;
  for (const h of holes) {
    const k = previous?.get(h.holeId);
    if (k === undefined) continue;
    if (!(k > lastKey)) {
      reusable = false;
      break;
    }
    lastKey = k;
  }
  if (!reusable || !previous) {
    const keys = keysBetween('', null, holes.length);
    holes.forEach((h, i) => out.set(h.holeId, keys[i]!));
    return out;
  }
  let i = 0;
  while (i < holes.length) {
    const k = previous.get(holes[i]!.holeId);
    if (k !== undefined) {
      out.set(holes[i]!.holeId, k);
      i++;
      continue;
    }
    let end = i;
    while (end < holes.length && previous.get(holes[end]!.holeId) === undefined) end++;
    const lo = i > 0 ? out.get(holes[i - 1]!.holeId)! : '';
    const hi = end < holes.length ? previous.get(holes[end]!.holeId)! : null;
    const gen = keysBetween(lo, hi, end - i);
    for (let t = i; t < end; t++) out.set(holes[t]!.holeId, gen[t - i]!);
    i = end;
  }
  return out;
}

// ─── snapshot -> rows ────────────────────────────────────────────────────────

export interface SnapshotRowsResult {
  rows: GraphRows;
  shadow: PartShadow;
  fullRewriteRings: string[];
}

export function snapshotToRows(snapshot: PartGraphSnapshot, previous: PartShadow | undefined): SnapshotRowsResult {
  const { part, regionPanels, bends } = snapshot;
  const rows = emptyRows();
  const fullRewriteRings: string[] = [];
  const r = part.anchor.r;
  const t = part.anchor.t;
  rows.part.push({
    part_id: part.partId,
    name: part.name,
    root_region_panel_id: part.rootRegionPanelId,
    anchor_r00: r[0], anchor_r01: r[1], anchor_r02: r[2],
    anchor_r10: r[3], anchor_r11: r[4], anchor_r12: r[5],
    anchor_r20: r[6], anchor_r21: r[7], anchor_r22: r[8],
    anchor_tx: t[0], anchor_ty: t[1], anchor_tz: t[2],
    material_id: part.materialId,
    thickness_mm: part.thicknessMm,
    k_factor: part.kFactor,
    schema_version: part.schemaVersion,
    merged_into_part_id: part.mergedIntoPartId,
  });

  const shadow: PartShadow = {
    outlineRingId: previous?.outlineRingId ?? randomUUID(),
    rings: new Map(),
    holeKeys: new Map(),
    panelKeys: orderKeys(regionPanels.map((p) => p.regionPanelId), previous?.panelKeys),
    bendKeys: orderKeys(bends.map((b) => b.bendId), previous?.bendKeys),
  };

  const addRing = (ringId: string, kind: 'outline' | 'hole', pts: Point2[], holeKey: string | null): void => {
    rows.part_ring.push({ ring_id: ringId, part_id: part.partId, kind, hole_order_key: holeKey });
    const aligned = alignRing(previous?.rings.get(ringId), pts);
    if (aligned.fullRewrite) fullRewriteRings.push(ringId);
    shadow.rings.set(ringId, aligned.shadow);
    aligned.shadow.ids.forEach((id, i) => {
      rows.ring_vertex.push({ vertex_id: id, ring_id: ringId, order_key: aligned.shadow.keys[i]!, x: pts[i]!.x, y: pts[i]!.y, bulge: 0 });
    });
  };

  addRing(shadow.outlineRingId, 'outline', part.outline, null);
  shadow.holeKeys = holeOrderKeys(part.holes, previous?.holeKeys);
  for (const h of part.holes) {
    const key = shadow.holeKeys.get(h.holeId)!;
    if (h.kind === 'polygon') {
      addRing(h.holeId, 'hole', h.ring, key);
    } else {
      rows.feature.push({
        feature_id: h.holeId,
        part_id: part.partId,
        kind: 'hole_circle',
        cx: h.center.x,
        cy: h.center.y,
        r: h.radiusMm,
        poly_ring_id: null,
        process: null,
        hole_order_key: key,
      });
    }
  }

  for (const p of regionPanels) {
    rows.region_panel.push({
      region_panel_id: p.regionPanelId,
      part_id: p.partId,
      label: p.label,
      k_factor_override: p.kFactorOverride,
      merged_into_region_panel_id: p.mergedIntoRegionPanelId,
      order_key: shadow.panelKeys.get(p.regionPanelId)!,
    });
  }
  for (const b of bends) {
    rows.bend.push({
      bend_id: b.bendId,
      part_id: b.partId,
      parent_region_panel_id: b.parentRegionPanelId,
      child_region_panel_id: b.childRegionPanelId,
      hinge_ax: b.hingeA.x, hinge_ay: b.hingeA.y, hinge_bx: b.hingeB.x, hinge_by: b.hingeB.y,
      angle_deg: b.angleDeg,
      radius_mm: b.radiusMm,
      k_factor_override: b.kFactorOverride,
      bottom_is_concave: b.bottomIsConcave,
      radius_measured: b.radiusMeasured,
      bend_process: b.bendProcess,
      order_key: shadow.bendKeys.get(b.bendId)!,
    });
  }
  return { rows, shadow, fullRewriteRings };
}

// ─── rows -> snapshots ───────────────────────────────────────────────────────

const toBool = (v: unknown): boolean => v === true || v === 1 || v === '1';
const toBoolOrNull = (v: unknown): boolean | null => (v === null || v === undefined ? null : toBool(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

/** Normalises driver output (tinyint booleans, numeric strings) into typed rows. */
export function normaliseRows(raw: Record<GraphTable, Record<string, unknown>[]>): GraphRows {
  return {
    part: raw.part.map((r) => ({
      ...(r as unknown as PartDbRow),
      anchor_r00: num(r['anchor_r00']), anchor_r01: num(r['anchor_r01']), anchor_r02: num(r['anchor_r02']),
      anchor_r10: num(r['anchor_r10']), anchor_r11: num(r['anchor_r11']), anchor_r12: num(r['anchor_r12']),
      anchor_r20: num(r['anchor_r20']), anchor_r21: num(r['anchor_r21']), anchor_r22: num(r['anchor_r22']),
      anchor_tx: num(r['anchor_tx']), anchor_ty: num(r['anchor_ty']), anchor_tz: num(r['anchor_tz']),
      thickness_mm: num(r['thickness_mm']),
      k_factor: num(r['k_factor']),
      merged_into_part_id: (r['merged_into_part_id'] as string | null) ?? null,
    })),
    part_ring: raw.part_ring.map((r) => ({ ...(r as unknown as RingDbRow), hole_order_key: (r['hole_order_key'] as string | null) ?? null })),
    ring_vertex: raw.ring_vertex.map((r) => ({ ...(r as unknown as VertexDbRow), x: num(r['x']), y: num(r['y']), bulge: num(r['bulge']) })),
    feature: raw.feature.map((r) => ({ ...(r as unknown as FeatureDbRow), cx: num(r['cx']), cy: num(r['cy']), r: num(r['r']) })),
    region_panel: raw.region_panel.map((r) => ({
      ...(r as unknown as PanelDbRow),
      k_factor_override: numOrNull(r['k_factor_override']),
      merged_into_region_panel_id: (r['merged_into_region_panel_id'] as string | null) ?? null,
    })),
    bend: raw.bend.map((r) => ({
      ...(r as unknown as BendDbRow),
      hinge_ax: num(r['hinge_ax']), hinge_ay: num(r['hinge_ay']), hinge_bx: num(r['hinge_bx']), hinge_by: num(r['hinge_by']),
      angle_deg: num(r['angle_deg']),
      radius_mm: num(r['radius_mm']),
      k_factor_override: numOrNull(r['k_factor_override']),
      bottom_is_concave: toBoolOrNull(r['bottom_is_concave']),
      radius_measured: toBool(r['radius_measured']),
      bend_process: (r['bend_process'] as string | null) ?? null,
    })),
  };
}

export interface RowsToSnapshotsResult {
  snapshots: PartGraphSnapshot[];
  shadows: ShadowStore;
  /** Structural problems assembling rows (e.g. a part with no outline ring). */
  problems: Array<{ table: GraphTable; key: string; issue: string }>;
}

export function rowsToSnapshots(rows: GraphRows): RowsToSnapshotsResult {
  const problems: RowsToSnapshotsResult['problems'] = [];
  const shadows: ShadowStore = new Map();
  const verticesByRing = new Map<string, VertexDbRow[]>();
  for (const v of rows.ring_vertex) {
    const list = verticesByRing.get(v.ring_id) ?? [];
    list.push(v);
    verticesByRing.set(v.ring_id, list);
  }
  for (const list of verticesByRing.values()) list.sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0));

  const byPart = <T extends { part_id: string }>(list: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const l = m.get(x.part_id) ?? [];
      l.push(x);
      m.set(x.part_id, l);
    }
    return m;
  };
  const ringsByPart = byPart(rows.part_ring);
  const featuresByPart = byPart(rows.feature);
  const panelsByPart = byPart(rows.region_panel);
  const bendsByPart = byPart(rows.bend);

  const snapshots: PartGraphSnapshot[] = [];
  for (const p of rows.part) {
    const rings = ringsByPart.get(p.part_id) ?? [];
    const outlineRings = rings.filter((r) => r.kind === 'outline');
    if (outlineRings.length !== 1) {
      problems.push({ table: 'part_ring', key: p.part_id, issue: `part has ${outlineRings.length} outline rings (expected 1)` });
      continue;
    }
    const shadow: PartShadow = {
      outlineRingId: outlineRings[0]!.ring_id,
      rings: new Map(),
      holeKeys: new Map(),
      panelKeys: new Map(),
      bendKeys: new Map(),
    };
    const ringPoints = (ringId: string): Point2[] => {
      const vs = verticesByRing.get(ringId) ?? [];
      shadow.rings.set(ringId, { ids: vs.map((v) => v.vertex_id), keys: vs.map((v) => v.order_key), pts: vs.map((v) => ({ x: v.x, y: v.y })) });
      return vs.map((v) => ({ x: v.x, y: v.y }));
    };

    const holeEntries: Array<{ key: string; hole: Hole }> = [];
    for (const r of rings) {
      if (r.kind !== 'hole') continue;
      holeEntries.push({ key: r.hole_order_key ?? '', hole: { kind: 'polygon', holeId: r.ring_id, ring: ringPoints(r.ring_id) } });
    }
    for (const f of featuresByPart.get(p.part_id) ?? []) {
      holeEntries.push({ key: f.hole_order_key, hole: { kind: 'circle', holeId: f.feature_id, center: { x: f.cx, y: f.cy }, radiusMm: f.r } });
    }
    holeEntries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const e of holeEntries) shadow.holeKeys.set(e.hole.holeId, e.key);

    const part: PartRow = {
      partId: p.part_id,
      name: p.name,
      rootRegionPanelId: p.root_region_panel_id,
      outline: ringPoints(outlineRings[0]!.ring_id),
      holes: holeEntries.map((e) => e.hole),
      anchor: {
        r: [p.anchor_r00, p.anchor_r01, p.anchor_r02, p.anchor_r10, p.anchor_r11, p.anchor_r12, p.anchor_r20, p.anchor_r21, p.anchor_r22],
        t: [p.anchor_tx, p.anchor_ty, p.anchor_tz],
      },
      materialId: p.material_id,
      thicknessMm: p.thickness_mm,
      kFactor: p.k_factor,
      schemaVersion: p.schema_version,
      mergedIntoPartId: p.merged_into_part_id,
    };
    const byKey = <T extends { order_key: string }>(a: T, b: T): number => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : 0);
    const panelRows = [...(panelsByPart.get(p.part_id) ?? [])].sort(byKey);
    const bendRows = [...(bendsByPart.get(p.part_id) ?? [])].sort(byKey);
    for (const r of panelRows) shadow.panelKeys.set(r.region_panel_id, r.order_key);
    for (const b of bendRows) shadow.bendKeys.set(b.bend_id, b.order_key);
    const regionPanels: RegionPanelRow[] = panelRows.map((r) => ({
      regionPanelId: r.region_panel_id,
      partId: r.part_id,
      label: r.label,
      kFactorOverride: r.k_factor_override,
      mergedIntoRegionPanelId: r.merged_into_region_panel_id,
    }));
    const bends: BendRow[] = bendRows.map((b) => ({
      bendId: b.bend_id,
      partId: b.part_id,
      parentRegionPanelId: b.parent_region_panel_id,
      childRegionPanelId: b.child_region_panel_id,
      hingeA: { x: b.hinge_ax, y: b.hinge_ay },
      hingeB: { x: b.hinge_bx, y: b.hinge_by },
      angleDeg: b.angle_deg,
      radiusMm: b.radius_mm,
      kFactorOverride: b.k_factor_override,
      bottomIsConcave: b.bottom_is_concave,
      radiusMeasured: b.radius_measured,
      bendProcess: b.bend_process,
    }));
    shadows.set(p.part_id, shadow);
    snapshots.push({ part, regionPanels, bends });
  }
  return { snapshots, shadows, problems };
}

// ─── Row diff ────────────────────────────────────────────────────────────────

export interface RowDiff {
  upserts: GraphRows;
  deletes: Record<GraphTable, string[]>;
  /** Before-images: rows as they were, for changed + deleted keys (undo). */
  before: GraphRows;
  /** Keys that did not exist before (undo deletes them). */
  inserted: Record<GraphTable, string[]>;
}

function rowEquals(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function emptyKeyMap(): Record<GraphTable, string[]> {
  return { part: [], part_ring: [], ring_vertex: [], feature: [], region_panel: [], bend: [] };
}

/** Diffs the rows of the parts in `scope` (every part touched by a mutation). */
export function diffRows(before: GraphRows, after: GraphRows): RowDiff {
  const diff: RowDiff = { upserts: emptyRows(), deletes: emptyKeyMap(), before: emptyRows(), inserted: emptyKeyMap() };
  for (const table of TABLE_ORDER) {
    const pk = PRIMARY_KEY[table];
    const oldByKey = new Map<string, object>((before[table] as object[]).map((r) => [String((r as Record<string, unknown>)[pk]), r]));
    const newByKey = new Map<string, object>((after[table] as object[]).map((r) => [String((r as Record<string, unknown>)[pk]), r]));
    for (const [key, row] of newByKey) {
      const old = oldByKey.get(key);
      if (!old) {
        (diff.upserts[table] as object[]).push(row);
        diff.inserted[table].push(key);
      } else if (!rowEquals(old, row)) {
        (diff.upserts[table] as object[]).push(row);
        (diff.before[table] as object[]).push(old);
      }
    }
    for (const [key, row] of oldByKey) {
      if (!newByKey.has(key)) {
        diff.deletes[table].push(key);
        (diff.before[table] as object[]).push(row);
      }
    }
  }
  return diff;
}

export function isEmptyDiff(d: RowDiff): boolean {
  return TABLE_ORDER.every((t) => d.upserts[t].length === 0 && d.deletes[t].length === 0);
}

export function mergeRows(into: GraphRows, from: GraphRows): void {
  for (const t of TABLE_ORDER) (into[t] as object[]).push(...(from[t] as object[]));
}
