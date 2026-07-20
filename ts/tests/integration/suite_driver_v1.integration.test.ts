/**
 * v1 driver for the core correctness suite (rebuild/suite/) — Phase 1.3 skeleton.
 *
 * Purpose (09-core-correctness-suite.md §2): validate the SUITE, not v1 — cases whose
 * inventory rows are 🩹 must pass here; red cases (expectation: "known-fail-v1") must
 * fail here. A suite that cannot detect v1's known bugs is not a valid oracle set.
 *
 * Gated behind SUITE_V1_DRIVER=1 — the driver needs the native binding and a
 * calibration pass (see CALIBRATION notes) before it joins normal runs:
 *
 *   SUITE_V1_DRIVER=1 npx vitest run tests/integration/suite_driver_v1
 *
 * Level A emulation on v1 (v1 has no graph-authoring path): "author_strip" imports
 * sheet_1panel.stp once per segment, poses each copy on the target polygon via
 * transaction-scoped translate/rotate, chain-merges them (v1 derives bend angles from
 * the actual dihedrals), then "map_strip_ends" asserts closure via get_unfold +
 * map_2d_to_3d — so the oracle exercises exactly the 2D→3D mapping chain (C22's
 * intent), not the placement we constructed ourselves.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool, registerTestPart } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

const ENABLED = process.env.SUITE_V1_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const SUITE_DIR = path.resolve(__dirname, '../../../rebuild/suite');
const config = loadConfig(path.resolve(__dirname, '../../config/config.yaml'));

interface Profile { closureMm: number; probeMm: number; outlineMm: number; lenMm: number; angleDeg: number }
const profiles: Record<string, Profile> = JSON.parse(
  fs.readFileSync(path.join(SUITE_DIR, 'profiles.json'), 'utf8'),
);

interface SuiteCase {
  id: string;
  level: 'A' | 'B' | 'C';
  tier: string;
  toleranceProfile: string;
  expectation: 'pass' | 'known-fail-v1';
  ops: Array<Record<string, unknown>>;
  oracles: Array<Record<string, unknown>>;
  params: Record<string, unknown>;
}

function loadCases(tier: string): SuiteCase[] {
  const dir = path.join(SUITE_DIR, 'cases', tier);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SuiteCase);
}

// CALIBRATION: sheet_1panel.stp dimensions must be read on first run and recorded
// here (the strip emulation scales/orients per-panel placement from them). The first
// executed test logs the imported panel's bbox for exactly this purpose.
const FIXTURE = path.resolve(__dirname, '../../../cpp/tests/fixtures/l_bracket_corner_90deg.stp');

const dist = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Minimal closed-LWPOLYLINE rectangle DXF (w × h), origin at (0,0). */
function rectDxf(w: number, h: number): string {
  return [
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0.0', '20', '0.0',
    '10', `${w.toFixed(1)}`, '20', '0.0',
    '10', `${w.toFixed(1)}`, '20', `${h.toFixed(1)}`,
    '10', '0.0', '20', `${h.toFixed(1)}`,
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
}

interface Bb { x_min: number; x_max: number; y_min: number; y_max: number; z_min: number; z_max: number }
const bbox = async (id: string): Promise<Bb> =>
  (await dispatchTool('bounding_box', { target: id }, config)) as Bb;

/**
 * Import one strip segment and pose it on the polygon (segment index k of N).
 * CALIBRATION FINDINGS encoded here:
 *  - v1's frame derivation rejects raw transformed solids ("no planar faces") — the
 *    merge pipeline is built for SHELL panels from split_body_by_bends. So each
 *    segment = the FLAT panel of a split l_bracket fixture.
 *  - The panel is not at a canonical pose; normalize (min corner → origin, flat in
 *    z) before applying the polygon pose. Its measured length replaces the case's
 *    nominal segment length (driver scales expectations linearly).
 */
async function importAndPoseSegment(
  txId: string,
  k: number,
  N: number,
  dirSign: number,
): Promise<{ id: string; lenX: number; widthY: number }> {
  const clean: any = await dispatchTool('clean_geometry', { file_path: FIXTURE }, config);
  const solidId: string = clean.solid_id ?? clean.body_id;
  const split: any = await dispatchTool(
    'split_body_by_bends',
    { part_id: solidId, angle_threshold_deg: 35, max_thickness_mm: 5.0 },
    config,
  );
  expect(split.panel_count, 'bracket must split into panels').toBeGreaterThanOrEqual(2);

  // Pick the FLAT panel: thin axis = z.
  let bodyId: string | undefined;
  let bb: Bb | undefined;
  for (const pid of split.panel_ids as string[]) {
    const b = await bbox(pid);
    const ext = [b.x_max - b.x_min, b.y_max - b.y_min, b.z_max - b.z_min];
    if (ext[2] <= Math.min(ext[0], ext[1])) { bodyId = pid; bb = b; break; }
  }
  expect(bodyId, 'a flat (z-thin) panel must exist in the split').toBeDefined();
  const lenX = bb!.x_max - bb!.x_min;
  const widthY = bb!.y_max - bb!.y_min;

  // Polygon pose in exactly TWO transforms (a 3-transform chain was observed to lose
  // graph membership — see README calibration notes):
  //  1. rotate about the Y axis through the panel's OWN start edge (min corner —
  //     on-axis points stay fixed);
  //  2. one translate carrying that corner to vertex V_k (and the flat face to z=0).
  const theta = (2 * Math.PI) / N;
  const headingDeg = (k * 360 * dirSign) / N;
  let vx = 0, vz = 0;
  for (let j = 0; j < k; j++) {
    vx += lenX * Math.cos(j * theta);
    vz += lenX * dirSign * Math.sin(j * theta);
  }
  // rotate_body is right-handed: +angle about +Y maps +X→−Z. Our polygon headings
  // are (cosθ, +sinθ) in XZ, so negate the angle to make +X→+Z for positive θ.
  const rotated: any = await dispatchTool(
    'rotate_body',
    { targets: [bodyId!], axis_origin: [bb!.x_min, 0, bb!.z_min], axis_direction: [0, 1, 0], angle_degrees: -headingDeg, keep_original: false, transaction_id: txId },
    config,
  );
  const rotId: string = rotated.solid_id ?? rotated.solid_ids?.[0] ?? bodyId!;
  const moved: any = await dispatchTool(
    'translate_body',
    { targets: [rotId], vector: [vx - bb!.x_min, -bb!.y_min, vz - bb!.z_min], keep_original: false, transaction_id: txId },
    config,
  );
  const posedId: string = moved.solid_id ?? moved.solid_ids?.[0] ?? rotId;

  // Transforms do NOT rebind graph membership in v1 — register the posed shell as a
  // fresh single-panel part (flat outline = measured rectangle).
  registerTestPart(posedId, [posedId], rectDxf(lenX, widthY));

  const pb = await bbox(posedId);
  console.log(
    `[suite:calib] segment ${k} posed (len ${lenX.toFixed(1)}): ` +
      `x[${pb.x_min.toFixed(1)}..${pb.x_max.toFixed(1)}] y[${pb.y_min.toFixed(1)}..${pb.y_max.toFixed(1)}] z[${pb.z_min.toFixed(1)}..${pb.z_max.toFixed(1)}]`,
  );
  return { id: posedId, lenX, widthY };
}

async function runClosureCase(
  c: SuiteCase,
): Promise<{ residualsMm: number[]; v1Gap: string | null; mergesDone: number }> {
  const author = c.ops.find((o) => o.op === 'author_strip')!;
  const N = author.N as number;
  const segLen = author.segmentLenMm as number;
  const dirSign = (author.bendDir as string) === 'up' ? 1 : -1;

  const tx: any = await dispatchTool('begin_transaction', { label: `suite-${c.id}` }, config);
  const txId: string = tx.transaction_id;

  // 1. author_strip (emulated): N posed segments (measured length replaces nominal).
  const segs: Array<{ id: string; lenX: number; widthY: number }> = [];
  for (let k = 0; k < N; k++) {
    segs.push(await importAndPoseSegment(txId, k, N, dirSign));
  }
  const L = segs[0].lenX;
  const W = segs[0].widthY;

  // 2. chain merge — v1 reads the bend angle off the actual dihedral.
  // Chain via merged_part_id (the graph-carrying id) — merged_shell_id is the
  // geometry handle for unfold/bbox (pattern from testcube_three_panel test).
  // KNOWN v1 GAP: buildShellFromFlatPattern's hinge-line splitting is N==1-only
  // (geometry_service_shell.cc: "Multi-zone hinge-line splitting not yet
  // implemented"), so chaining a 3rd independently-authored panel fails. We record
  // how far the chain got and validate the closure oracle on what v1 CAN build.
  let compositePart = segs[0].id;
  let mergesDone = 0;
  let v1Gap: string | null = null;
  for (let k = 1; k < N; k++) {
    try {
      const merged: any = await dispatchTool(
        'merge_bodies_with_bend',
        { transaction_id: txId, part_a_id: compositePart, part_b_id: segs[k].id, target_edges: ['all'], bend_radius: 1.0 },
        config,
      );
      expect(merged.merged_shell_id, `merge ${k} of case ${c.id}`).toBeDefined();
      compositePart = merged.merged_part_id ?? merged.merged_shell_id;
      mergesDone = k;
    } catch (e: any) {
      if (String(e?.message ?? e).includes('Multi-zone hinge-line splitting')) {
        v1Gap = `v1 gap at merge ${k}/${N - 1}: ${e.message}`;
        break;
      }
      throw e;
    }
  }

  // map_strip_ends: unfold the composite, then map flat end-edge midpoints to 3D.
  const unfold: any = await dispatchTool(
    'get_unfold',
    { part_id: compositePart, material_id: (config as any).materials[0].id, transaction_id: txId },
    config,
  );
  const flatLen = (unfold.flat_width_mm as number) ?? (mergesDone + 1) * L;

  const mapPoint = async (p: [number, number], panelId?: string): Promise<number[]> => {
    const r: any = await dispatchTool(
      'map_2d_to_3d',
      panelId ? { part_id: compositePart, panel_id: panelId, point: p } : { part_id: compositePart, point: p },
      config,
    );
    const pt = r.point3d ?? r.point ?? r.xyz ?? [r.x, r.y, r.z];
    return pt as number[];
  };
  // 1 mm inset from the extreme edges (v1's region lookup excludes the exact
  // boundary). CALIBRATION: the merged-DXF global lookup does not find panel B's
  // region ("No panel region contains point") — map via explicit panel_id with
  // panel-LOCAL coordinates instead; the ends are x≈0 on the first panel and x≈L on
  // the last merged panel.
  const p0 = await mapPoint([1.0, W / 2], segs[0].id);
  const p1 = await mapPoint([L - 1.0, W / 2], segs[mergesDone].id);
  console.log(
    `[suite:calib] mapped p0=[${p0.map((v) => v.toFixed(2))}] p1=[${p1.map((v) => v.toFixed(2))}] (L=${L.toFixed(1)}, mergesDone=${mergesDone})`,
  );

  const residualsMm: number[] = [];
  if (v1Gap === null) {
    residualsMm.push(dist(p0, p1)); // final closure: both ends → same 3D point
  } else {
    // Partial-loop checkpoint for the merges that DID complete (k = mergesDone):
    // E_k = V_k + (N−k)·L·d_k, scaled to the measured L (case checkpoints are for
    // the nominal segment length; the family is linear in L).
    const closure = c.oracles.find((o) => o.type === 'closure') as any;
    const cp = closure.checkpoints.find((x: any) => x.afterBend === mergesDone);
    const scale = L / (author.segmentLenMm as number);
    const expected = (cp.endCorners as number[][]).map((v) => v.map((x) => x * scale));
    const expMid = [
      (expected[0][0] + expected[1][0]) / 2,
      W / 2,
      (expected[0][2] + expected[1][2]) / 2,
    ];
    residualsMm.push(dist(p1, expMid));
  }

  await dispatchTool('rollback_transaction', { transaction_id: txId }, config).catch(() => {});
  return { residualsMm, v1Gap, mergesDone };
}

d('core correctness suite — v1 driver (validation of the suite itself)', () => {
  const t2 = loadCases('T2').filter((c) => c.level === 'A');
  expect(t2.length).toBeGreaterThan(0);

  for (const c of t2) {
    it(`${c.id} [expect: ${c.expectation}]`, async () => {
      const profile = profiles[c.toleranceProfile];
      const { residualsMm, v1Gap, mergesDone } = await runClosureCase(c);
      const worst = Math.max(...residualsMm);

      // C22 is a KNOWN-v1-red family (08-case-inventory row ❌ 2026-07-19: multi-zone
      // gap + region lookup + association swap). The v1 driver asserts these cases DO
      // fail — a consistent ledger where green means "v1 behaves exactly as
      // characterized". If v1 were ever fixed, these asserts flip and alert us.
      const v1KnownRed = c.inventory.includes('C22');
      console.log(
        `[suite:${c.id}] ${v1Gap ? v1Gap + '; checkpoint' : 'closure'} residual ` +
          `${worst.toFixed(3)} mm (budget ${profile.closureMm}${v1KnownRed ? '; v1-known-red' : ''})`,
      );
      if (v1KnownRed || c.expectation === 'known-fail-v1') {
        expect(worst).toBeGreaterThan(profile.closureMm);
      } else {
        expect(worst).toBeLessThanOrEqual(profile.closureMm);
      }
    }, 300_000);
  }

  // Net closure cases are NOT expressible through v1's tool surface (authored
  // fold-tree route: the closure family probes already established v1 cannot chain
  // authored panels, and nets need branching merges on top). v2-driver only.
  it('net closure cases are marked v2-only for the v1 driver', () => {
    const t3 = loadCases('T3').filter((c) => c.ops.some((o) => o.op === 'author_net'));
    expect(t3.length).toBeGreaterThan(0);
    for (const c of t3) console.log(`[suite:${c.id}] SKIPPED on v1 driver: authored fold-tree route not expressible (see suite README)`);
  });
});

// ─── Level C runners (import → decompose → …) ────────────────────────────────

const SWEEP_LIMIT = Number(process.env.SUITE_SWEEP_LIMIT ?? 40);

async function importAndSplit(fixtureRel: string): Promise<{ partId: string; panelIds: string[]; importBbox: Bb }> {
  const fp = path.resolve(__dirname, '../../../', fixtureRel);
  expect(fs.existsSync(fp), `fixture ${fixtureRel}`).toBe(true);
  const clean: any = await dispatchTool('clean_geometry', { file_path: fp }, config);
  const partId: string = clean.solid_id ?? clean.body_id;
  const importBbox = await bbox(partId);
  const split: any = await dispatchTool(
    'split_body_by_bends',
    { part_id: partId, angle_threshold_deg: 35, max_thickness_mm: 5.0 },
    config,
  );
  expect(split.panel_count, `split of ${fixtureRel}`).toBeGreaterThanOrEqual(1);
  console.log(`[suite:calib] split ${fixtureRel}: panels=${split.panel_count} created_parts=${JSON.stringify(split.created_parts)} hidden=${JSON.stringify(split.hidden_source_part_ids)}`);
  return { partId, panelIds: split.panel_ids as string[], importBbox };
}

/** 2D grid points on a panel's flat pattern (inset from the outline). */
async function panelGrid(
  partId: string,
  panelId: string,
  txId: string,
  gridN: number,
  insetMm: number,
): Promise<Array<[number, number]>> {
  const unfold: any = await dispatchTool(
    'get_unfold',
    { part_id: partId, panel_id: panelId, material_id: (config as any).materials[0].id, transaction_id: txId },
    config,
  );
  const w = unfold.flat_width_mm as number;
  const h = unfold.flat_height_mm as number;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      pts.push([
        insetMm + (i * (w - 2 * insetMm)) / (gridN - 1),
        insetMm + (j * (h - 2 * insetMm)) / (gridN - 1),
      ]);
    }
  }
  return pts;
}

const map23 = async (partId: string, panelId: string | undefined, p: [number, number]): Promise<number[]> => {
  const r: any = await dispatchTool(
    'map_2d_to_3d',
    panelId ? { part_id: partId, panel_id: panelId, point: p } : { part_id: partId, point: p },
    config,
  );
  return r.point3d as number[];
};
const map32 = async (partId: string, p: number[]): Promise<{ panelId: string; xy: [number, number]; errMm: number }> => {
  const r: any = await dispatchTool('map_3d_to_2d', { part_id: partId, point: p }, config);
  return { panelId: r.panel_id, xy: r.xy, errMm: r.error_mm ?? 0 };
};

/** T0: per-panel 2D→3D→2D roundtrip; identity mismatch scores a huge residual. */
async function runRoundtripCase(c: SuiteCase): Promise<number> {
  const imp = c.ops.find((o) => o.op === 'import') as any;
  const grid = c.ops.find((o) => o.op === 'map_roundtrip_grid') as any;
  const tx: any = await dispatchTool('begin_transaction', { label: `suite-${c.id}` }, config);
  const { partId, panelIds } = await importAndSplit(imp.path);
  let worst = 0;
  void partId; // split creates one part PER PANEL (part_id == panel_id); source part is hidden
  for (const panelId of panelIds) {
    const pts = await panelGrid(panelId, panelId, tx.transaction_id, grid.gridN, grid.insetMm);
    for (const p of pts) {
      const p3 = await map23(panelId, panelId, p);
      const back = await map32(panelId, p3);
      const residual =
        back.panelId === panelId
          ? Math.hypot(back.xy[0] - p[0], back.xy[1] - p[1]) + back.errMm
          : 1e6; // association swap
      worst = Math.max(worst, residual);
    }
  }
  await dispatchTool('rollback_transaction', { transaction_id: tx.transaction_id }, config).catch(() => {});
  return worst;
}

/** Shared position-preserved check: pre-merge mapped 3D points must survive a merge. */
async function positionPreservedResidual(
  partId: string,
  aId: string,
  bId: string,
  txId: string,
): Promise<number> {
  void partId; // pre-merge, each panel is its own part (see importAndSplit calib log)
  const pre: Array<{ p3: number[] }> = [];
  for (const panelId of [aId, bId]) {
    const pts = await panelGrid(panelId, panelId, txId, 2, 3.0);
    for (const p of pts) pre.push({ p3: await map23(panelId, panelId, p) });
  }
  const merged: any = await dispatchTool(
    'merge_bodies_with_bend',
    { transaction_id: txId, part_a_id: aId, part_b_id: bId, target_edges: ['all'], bend_radius: 1.0 },
    config,
  );
  const postPart: string = merged.merged_part_id ?? aId;
  let worst = 0;
  for (const { p3 } of pre) {
    const back = await map32(postPart, p3);
    const p3b = await map23(postPart, back.panelId, back.xy);
    worst = Math.max(worst, back.errMm + dist(p3, p3b));
  }
  return worst;
}

d('core correctness suite — v1 driver: Level C (T0/T1 + red sweeps)', () => {
  const levelC = [...loadCases('T0'), ...loadCases('T1'), ...loadCases('T3')].filter((c) => c.level === 'C');

  for (const c of levelC.filter((x) => x.ops.some((o) => o.op === 'map_roundtrip_grid'))) {
    it(`${c.id} [expect: ${c.expectation}]`, async () => {
      const budget = profiles[c.toleranceProfile].probeMm;
      const worst = await runRoundtripCase(c);
      console.log(`[suite:${c.id}] worst roundtrip residual ${worst.toFixed(4)} mm (budget ${budget})`);
      if (c.expectation === 'known-fail-v1') expect(worst).toBeGreaterThan(budget);
      else expect(worst).toBeLessThanOrEqual(budget);
    }, 600_000);
  }

  for (const c of levelC.filter((x) => x.ops.some((o) => o.op === 'merge_pair') && !x.ops.some((o) => String(o.op).startsWith('sweep')))) {
    it(`${c.id} [expect: ${c.expectation}]`, async () => {
      const budget = profiles[c.toleranceProfile].probeMm;
      const imp = c.ops.find((o) => o.op === 'import') as any;
      const tx: any = await dispatchTool('begin_transaction', { label: `suite-${c.id}` }, config);
      const { partId, panelIds } = await importAndSplit(imp.path);
      expect(panelIds.length).toBeGreaterThanOrEqual(2);
      const worst = await positionPreservedResidual(partId, panelIds[0], panelIds[1], tx.transaction_id);
      await dispatchTool('rollback_transaction', { transaction_id: tx.transaction_id }, config).catch(() => {});
      console.log(`[suite:${c.id}] worst position residual ${worst.toFixed(4)} mm (budget ${budget})`);
      if (c.expectation === 'known-fail-v1') expect(worst).toBeGreaterThan(budget);
      else expect(worst).toBeLessThanOrEqual(budget);
    }, 600_000);
  }

  for (const c of levelC.filter((x) => x.ops.some((o) => o.op === 'sweep_adjacent_pairs'))) {
    it(`${c.id} [expect: ${c.expectation}] (sweep, limit ${SWEEP_LIMIT})`, async () => {
      const budget = profiles[c.toleranceProfile].probeMm;
      const imp = c.ops.find((o) => o.op === 'import') as any;
      const { partId, panelIds } = await importAndSplit(imp.path);
      let failures = 0, tried = 0;
      outer: for (let i = 0; i < panelIds.length; i++) {
        for (let j = 0; j < panelIds.length; j++) {
          if (i === j || tried >= SWEEP_LIMIT) { if (tried >= SWEEP_LIMIT) break outer; continue; }
          const tx: any = await dispatchTool('begin_transaction', { label: `sweep-${i}-${j}` }, config);
          try {
            const worst = await positionPreservedResidual(partId, panelIds[i], panelIds[j], tx.transaction_id);
            tried++;
            if (worst > budget) { failures++; console.log(`[suite:${c.id}] pair (${i},${j}) FAILED: residual ${worst.toFixed(3)} mm`); }
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (msg.includes('not close enough')) { /* non-adjacent — skip */ }
            else { tried++; failures++; console.log(`[suite:${c.id}] pair (${i},${j}) FAILED: ${msg.slice(0, 120)}`); }
          } finally {
            await dispatchTool('rollback_transaction', { transaction_id: tx.transaction_id }, config).catch(() => {});
          }
          if (failures > 0 && c.expectation === 'known-fail-v1') break outer; // early exit: red confirmed
        }
      }
      console.log(`[suite:${c.id}] sweep: ${tried} adjacent pairs tried, ${failures} failures`);
      expect(tried).toBeGreaterThan(0);
      if (c.expectation === 'known-fail-v1') expect(failures).toBeGreaterThan(0);
      else expect(failures).toBe(0);
    }, 600_000);
  }

  for (const c of levelC.filter((x) => x.ops.some((o) => o.op === 'sweep_adjacent_triples'))) {
    it(`${c.id} [expect: ${c.expectation}] (triple sweep, limit ${SWEEP_LIMIT})`, async () => {
      const imp = c.ops.find((o) => o.op === 'import') as any;
      const { panelIds } = await importAndSplit(imp.path);
      let failures = 0, tried = 0;
      outer: for (let i = 0; i < panelIds.length; i++) {
        for (let j = 0; j < panelIds.length; j++) {
          if (i === j) continue;
          for (let k = 0; k < panelIds.length; k++) {
            if (k === i || k === j) continue;
            if (tried >= SWEEP_LIMIT) break outer;
            const tx: any = await dispatchTool('begin_transaction', { label: `triple-${i}-${j}-${k}` }, config);
            try {
              const m1: any = await dispatchTool(
                'merge_bodies_with_bend',
                { transaction_id: tx.transaction_id, part_a_id: panelIds[i], part_b_id: panelIds[j], target_edges: ['all'], bend_radius: 1.0 },
                config,
              );
              const compositePart = m1.merged_part_id ?? panelIds[i];
              try {
                await dispatchTool(
                  'merge_bodies_with_bend',
                  { transaction_id: tx.transaction_id, part_a_id: compositePart, part_b_id: panelIds[k], target_edges: ['all'], bend_radius: 1.0 },
                  config,
                );
                tried++;
              } catch (e2: any) {
                const msg = String(e2?.message ?? e2);
                if (!msg.includes('not close enough')) {
                  tried++; failures++;
                  console.log(`[suite:${c.id}] triple (${i},${j},${k}) FAILED: ${msg.slice(0, 120)}`);
                }
              }
            } catch (e1: any) {
              // pair (i,j) not adjacent or failed — pair failures are C05's concern
            } finally {
              await dispatchTool('rollback_transaction', { transaction_id: tx.transaction_id }, config).catch(() => {});
            }
            if (failures > 0 && c.expectation === 'known-fail-v1') break outer;
          }
        }
      }
      console.log(`[suite:${c.id}] triple sweep: ${tried} chains tried, ${failures} failures`);
      expect(tried).toBeGreaterThan(0);
      if (c.expectation === 'known-fail-v1') expect(failures).toBeGreaterThan(0);
      else expect(failures).toBe(0);
    }, 600_000);
  }

  for (const c of levelC.filter((x) => x.ops.some((o) => o.op === 'merge_all_adjacent'))) {
    it(`${c.id} [expect: ${c.expectation}] (full reassembly)`, async () => {
      const budget = profiles[c.toleranceProfile].probeMm;
      const imp = c.ops.find((o) => o.op === 'import') as any;
      const { panelIds, importBbox } = await importAndSplit(imp.path);
      const tx: any = await dispatchTool('begin_transaction', { label: 'reassemble' }, config);
      let compositePart = panelIds[0];
      let compositeShell = panelIds[0];
      const remaining = new Set(panelIds.slice(1));
      let mergeFailures = 0;
      let progress = true;
      while (progress && remaining.size > 0) {
        progress = false;
        for (const p of [...remaining]) {
          try {
            const m: any = await dispatchTool(
              'merge_bodies_with_bend',
              { transaction_id: tx.transaction_id, part_a_id: compositePart, part_b_id: p, target_edges: ['all'], bend_radius: 1.0 },
              config,
            );
            compositePart = m.merged_part_id ?? compositePart;
            compositeShell = m.merged_shell_id ?? compositeShell;
            remaining.delete(p);
            progress = true;
          } catch (e: any) {
            const msg = String(e?.message ?? e);
            if (!msg.includes('not close enough')) {
              mergeFailures++;
              remaining.delete(p); // count and move on — reassembly is best-effort
              console.log(`[suite:${c.id}] merge of ${p.slice(0, 8)} FAILED: ${msg.slice(0, 110)}`);
            }
          }
        }
      }
      const finalBbox = await bbox(compositeShell);
      const deltas = [
        Math.abs(finalBbox.x_min - importBbox.x_min), Math.abs(finalBbox.x_max - importBbox.x_max),
        Math.abs(finalBbox.y_min - importBbox.y_min), Math.abs(finalBbox.y_max - importBbox.y_max),
        Math.abs(finalBbox.z_min - importBbox.z_min), Math.abs(finalBbox.z_max - importBbox.z_max),
      ];
      const worstBound = Math.max(...deltas);
      const unmerged = remaining.size;
      console.log(
        `[suite:${c.id}] reassembly: ${panelIds.length} panels, ${mergeFailures} merge failures, ` +
          `${unmerged} unmerged, worst bound delta ${worstBound.toFixed(2)} mm (budget ${budget})`,
      );
      await dispatchTool('rollback_transaction', { transaction_id: tx.transaction_id }, config).catch(() => {});
      const failed = mergeFailures > 0 || unmerged > 0 || worstBound > budget;
      if (c.expectation === 'known-fail-v1') expect(failed).toBe(true);
      else expect(failed).toBe(false);
    }, 600_000);
  }
});
