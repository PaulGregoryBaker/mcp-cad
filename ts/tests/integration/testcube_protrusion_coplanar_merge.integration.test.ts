import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';
import { getGeometryBinding } from '../../src/mcp/state';

const configPath = path.resolve(__dirname, '../../config/config.yaml');

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}

function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] ` +
    `y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] ` +
    `z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}

function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number {
  return b[`${axis}_max`] - b[`${axis}_min`];
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), z_min: Math.min(a.z_min, b.z_min),
    x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max), z_max: Math.max(a.z_max, b.z_max),
  };
}

function polygonArea(ring: Array<[number, number]>): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

// ────────────────────────────────────────────────────────────────────────────
// testcube.step: a nested double-wall cube — outer 200mm hollow cube + inner
// 150mm hollow cube (25mm gap). split_body_by_bends returns 12 panels (6 outer
// + 6 inner faces) PLUS 4 separate "protrusions": thin (1.1mm) ribs bridging
// the X/Y gap between inner and outer walls. Each protrusion's OWN normal
// matches the in-plane axis it's centered on, not the axis it bridges: the
// "+X protrusion" (bridging the X gap, x=[75..99]) has normal=Y (its largest
// face is 150mm(Z) x 24mm(X), centered at y≈0 — i.e. it's a rib lying roughly
// in a Y≈0 plane, NOT coplanar with either X-normal wall it touches in X).
//
// This is the user's real reported workflow (the protrusion fuses with a wall
// sharing its OWN normal, not the wall whose gap it happens to bridge in the
// other axis):
//   1. split testcube.step by bends
//   2. shift the +X protrusion +75mm in Y — moves its OWN plane from y≈0 to
//      y≈75, into (near-)coincidence with the inner +Y wall's plane
//      (y=[73.55..75]); the small residual offset (~1mm, less than the
//      wall's ~1.45mm thickness) is exactly the "misalignment less than
//      panel thickness" the fuse step is expected to resolve.
//   3. fuse the shifted protrusion with the inner +Y wall (now coplanar) —
//      this extends the wall's footprint past its +X edge by 24mm.
//   4. merge_bodies_with_bend(fused panel, inner TOP wall)
//   5. expect: flat pattern is L-shaped; merged 3D shell occupies the same
//      footprint as the (fused panel ∪ inner top wall) before the merge.
//
// FIXED (012-accurate-coord-mapping): both orderings used to show a small
// (~1-1.33mm) 3D placement residual. Root cause turned out to be in
// fuse_bodies itself (step 3, not the later merge_bodies_with_bend): the
// inner wall here is a perfect 148x148 square, so normalizePanelDxfOrientation
// rotates the merged DXF 90 degrees to keep its longer dimension on DXF+X —
// and the reference placement frame used to rebuild the 3D shape from that
// (rotated) DXF was derived assuming the merged outline's bbox starts at
// (0, 0), which doesn't hold whenever the other input's footprint extends in
// the reference panel's negative direction. See booleans.ts's `merged.height
// > merged.width` branch and project_fuse_chained_merge_and_undo_redo_fix
// memory for the full derivation. Fixing that incidentally resolved this
// test's residual too — both orderings now pass with zero KNOWN ISSUE gap.
// ────────────────────────────────────────────────────────────────────────────
describe('[repro] testcube.step: protrusion shifted to coplanar wall edge, fused, merged with inner top', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  interface Classified {
    innerYWall: string; innerYWallBbox: Bbox;
    innerTop: string; innerTopBbox: Bbox;
    plusXProtrusion: string; plusXProtrusionBbox: Bbox;
  }

  async function setup(config: ReturnType<typeof loadConfig>): Promise<Classified | null> {
    const fixturePath = findFixture('testcube.step');
    if (!fixturePath) { console.warn('testcube.step missing — skipping'); return null; }

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
    }, config);

    const panelBboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panelBboxes.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    const protBboxes: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of (split.protrusion_ids ?? []) as string[]) {
      protBboxes.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }

    // Inner +Y wall: thin in Y (~1.45mm), y_min in [60,80] (inner shell, not outer), full 150mm in x/z.
    const innerYWallEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'y') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'z') > 140 &&
      bbox.y_min > 60 && bbox.y_min < 80);
    // Inner top wall: thin in Z, z_min in [60,80], full 150mm in x/y.
    const innerTopEntry = panelBboxes.find(({ bbox }) =>
      ext(bbox, 'z') < 5 && ext(bbox, 'x') > 140 && ext(bbox, 'y') > 140 &&
      bbox.z_min > 60 && bbox.z_min < 80);
    // +X protrusion: bridges the X gap, x_min in [70,80] (touches inner +X wall), thin in y (centered near 0).
    const plusXProtrusionEntry = protBboxes.find(({ bbox }) =>
      bbox.x_min > 70 && bbox.x_min < 80 && ext(bbox, 'y') < 5 && Math.abs((bbox.y_min + bbox.y_max) / 2) < 5);

    if (!innerYWallEntry || !innerTopEntry || !plusXProtrusionEntry) {
      console.warn('[testcube] could not classify required panels:', {
        innerYWall: !!innerYWallEntry, innerTop: !!innerTopEntry, plusXProtrusion: !!plusXProtrusionEntry,
      });
      return null;
    }

    return {
      innerYWall: innerYWallEntry.id, innerYWallBbox: innerYWallEntry.bbox,
      innerTop: innerTopEntry.id, innerTopBbox: innerTopEntry.bbox,
      plusXProtrusion: plusXProtrusionEntry.id, plusXProtrusionBbox: plusXProtrusionEntry.bbox,
    };
  }

  it.each(['compositeFirst', 'simpleFirst'] as const)('order=%s: shift protrusion +75mm in Y onto inner +Y wall (coplanar), fuse, merge with inner top', async (order) => {
    const config = loadConfig(configPath);
    const c = await setup(config);
    if (!c) return;
    const { innerYWall, innerYWallBbox, innerTop, innerTopBbox, plusXProtrusion, plusXProtrusionBbox } = c;

    console.log(`[testcube ${order}] innerYWall:   ${fmt(innerYWallBbox)}`);
    console.log(`[testcube ${order}] innerTop:     ${fmt(innerTopBbox)}`);
    console.log(`[testcube ${order}] protrusion:   ${fmt(plusXProtrusionBbox)}`);

    const txn: any = await dispatchTool('begin_transaction', { label: `testcube-${order}` }, config);
    const txId: string = txn.transaction_id;

    // Shift the protrusion +75mm in Y: moves its own plane from y≈0 to y≈75,
    // landing it (near-)coplanar with the inner +Y wall (y=[73.55..75]) — a
    // residual misalignment of ~1mm, less than the wall's own thickness.
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [plusXProtrusion],
      vector: [0, 75, 0],
      keep_original: false,
    }, config);
    const translatedId: string = translated.solid_id;
    const translatedBbox: Bbox = await dispatchTool('bounding_box', { target: translatedId }, config) as Bbox;
    console.log(`[testcube ${order}] shifted protrusion: ${fmt(translatedBbox)}`);

    const wallFrame: any = getGeometryBinding().getPanelFrame(innerYWall);
    const protFrame: any = getGeometryBinding().getPanelFrame(translatedId);
    console.log(`[testcube ${order}] wall frame: normal=(${wallFrame.normalX.toFixed(3)},${wallFrame.normalY.toFixed(3)},${wallFrame.normalZ.toFixed(3)}) u=(${wallFrame.uX.toFixed(3)},${wallFrame.uY.toFixed(3)},${wallFrame.uZ.toFixed(3)}) v=(${wallFrame.vX.toFixed(3)},${wallFrame.vY.toFixed(3)},${wallFrame.vZ.toFixed(3)}) uExt=${wallFrame.uExtentMm.toFixed(2)} vExt=${wallFrame.vExtentMm.toFixed(2)} thick=${wallFrame.thicknessMm.toFixed(2)}`);
    console.log(`[testcube ${order}] protrusion frame: normal=(${protFrame.normalX.toFixed(3)},${protFrame.normalY.toFixed(3)},${protFrame.normalZ.toFixed(3)}) u=(${protFrame.uX.toFixed(3)},${protFrame.uY.toFixed(3)},${protFrame.uZ.toFixed(3)}) v=(${protFrame.vX.toFixed(3)},${protFrame.vY.toFixed(3)},${protFrame.vZ.toFixed(3)}) uExt=${protFrame.uExtentMm.toFixed(2)} vExt=${protFrame.vExtentMm.toFixed(2)} thick=${protFrame.thicknessMm.toFixed(2)}`);

    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: [innerYWall, translatedId],
    }, config);
    expect(fused.solid_id, `[testcube ${order}] fuse_bodies must return a solid_id`).toBeDefined();
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[testcube ${order}] fused panel bbox: ${fmt(fusedBbox)}`);

    const unfoldFused: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: fused.part_id,
      panel_id: fused.part_id,
      material_id: config.materials[0]!.id,
    }, config);
    console.log(`[testcube ${order}] fused flat: ${unfoldFused.flat_width_mm?.toFixed(1)} x ${unfoldFused.flat_height_mm?.toFixed(1)}mm`);

    // Ground-truth pre-merge volumes (measured directly on the already-built
    // 3D shells, not estimated from flat-pattern area) — sheet-metal volume
    // is conserved through bending, so fusedVolume + innerTopVolume should
    // closely match the merged shell's own volume.
    const fusedMassProps: any = await dispatchTool('mass_properties', { target: fused.solid_id, properties: ['volume'] }, config);
    const innerTopMassProps: any = await dispatchTool('mass_properties', { target: innerTop, properties: ['volume'] }, config);
    console.log(`[testcube ${order}] pre-merge volumes: fused=${fusedMassProps.volume?.toFixed(1)}mm3 innerTop=${innerTopMassProps.volume?.toFixed(1)}mm3 sum=${(fusedMassProps.volume + innerTopMassProps.volume).toFixed(1)}mm3`);

    const partAId = order === 'compositeFirst' ? fused.part_id : innerTop;
    const partBId = order === 'compositeFirst' ? innerTop : fused.part_id;

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId,
        part_a_id: partAId,
        part_b_id: partBId,
        target_edges: ['all'],
        bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[testcube ${order}] merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, `[testcube ${order}] merge_bodies_with_bend must not throw`).toBeNull();
    if (!merged) return;

    // Volume check: bbox + axis-aligned-normal can both pass for a DEGENERATE
    // (e.g. sheared) shape that happens to share the same bbox as a proper
    // two-face bent bracket — neither check verifies actual shape topology.
    // Ground truth: sheet-metal volume is conserved through bending, so the
    // merged shell's volume should match the SUM of the two inputs' own
    // (already-measured, not estimated) volumes.
    const massProps: any = await dispatchTool('mass_properties', {
      target: merged.merged_shell_id, properties: ['volume'],
    }, config);
    const expectedVolume = fusedMassProps.volume + innerTopMassProps.volume;
    console.log(`[testcube ${order}] merged volume: actual=${massProps.volume?.toFixed(1)}mm3 expected≈${expectedVolume.toFixed(1)}mm3`);
    const volumeRatio = massProps.volume / expectedVolume;
    expect(volumeRatio, `[testcube ${order}] [BUG] merged shell volume=${massProps.volume?.toFixed(1)}mm3 doesn't match expected≈${expectedVolume.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)}) — shape may be degenerate/sheared despite matching bbox`)
      .toBeGreaterThan(0.9);
    expect(volumeRatio, `[testcube ${order}] [BUG] merged shell volume=${massProps.volume?.toFixed(1)}mm3 doesn't match expected≈${expectedVolume.toFixed(1)}mm3 (ratio=${volumeRatio.toFixed(3)}) — shape may be degenerate/sheared despite matching bbox`)
      .toBeLessThan(1.1);

    // Does the GLB mesh export (what the Form.AI.tion viewport actually
    // renders) succeed on the REAL geometry, or silently fall back to the
    // crude topology-estimated box in mesh/server.ts's synthesizeShellGlb?
    let glbError: unknown = null;
    let glb: Buffer | null = null;
    try {
      glb = getGeometryBinding().exportGlb(merged.merged_shell_id as string);
    } catch (err) {
      glbError = err;
      console.log(`[testcube ${order}] exportGlb threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    console.log(`[testcube ${order}] exportGlb: ${glbError ? 'THREW (would fall back to crude box approximation)' : `succeeded, ${glb?.length} bytes`}`);
    expect(glbError, `[testcube ${order}] [BUG] exportGlb threw for the merged shape — the viewport would silently render the crude topology-estimated box fallback instead of the real geometry`).toBeNull();

    const unfold: any = await dispatchTool('get_unfold', {
      transaction_id: txId,
      part_id: merged.merged_part_id,
      panel_id: merged.merged_part_id,
      material_id: config.materials[0]!.id,
    }, config);
    console.log(`[testcube ${order}] merged flat: ${unfold.flat_width_mm?.toFixed(1)} x ${unfold.flat_height_mm?.toFixed(1)}mm`);

    expect(unfold.dxf_content, `[testcube ${order}] get_unfold must return dxf_content`).toBeTruthy();
    const ring = parseFirstClosedPolyline(unfold.dxf_content as string);
    const area = polygonArea(ring);
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const bboxArea = (xMax - xMin) * (yMax - yMin);
    const fillRatio = bboxArea > 0 ? area / bboxArea : 1;
    console.log(`[testcube ${order}] flat bbox ${(xMax - xMin).toFixed(1)} x ${(yMax - yMin).toFixed(1)}mm  fill=${(fillRatio * 100).toFixed(1)}%  verts=${ring.length}`);

    // ASSERTION 1 (user): flat pattern must be L-shaped, not a plain rectangle.
    expect(fillRatio,
      `[testcube ${order}] [BUG] flat pattern is fully rectangular (fill=${(fillRatio * 100).toFixed(1)}%) — should be L-shaped`)
      .toBeLessThan(0.999);

    // ASSERTION 2 (user): merged 3D part occupies the same footprint as the
    // pre-merge (fused panel ∪ inner top wall) — i.e. nothing shifted/tilted.
    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    const expectedUnion = unionBbox(fusedBbox, innerTopBbox);
    console.log(`[testcube ${order}] merged 3D bbox:   ${fmt(mergedBbox)}`);
    console.log(`[testcube ${order}] expected (union): ${fmt(expectedUnion)}`);
    const TOL_MM = 0.5;
    const bounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    for (const k of bounds) {
      const delta = Math.abs(mergedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[testcube ${order}] [BUG] Bound ${k}: expected≈${expectedUnion[k].toFixed(2)} got=${mergedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    const pf = getGeometryBinding().getPanelFrame(merged.merged_shell_id as string);
    const axisAligned = (n: number) => Math.abs(Math.abs(n) - 1) < 1e-2 || Math.abs(n) < 1e-2;
    const isTilted = ![pf.normalX, pf.normalY, pf.normalZ].every(axisAligned);
    console.log(`[testcube ${order}] normal=(${pf.normalX.toFixed(4)},${pf.normalY.toFixed(4)},${pf.normalZ.toFixed(4)}) tilted=${isTilted}`);
    expect(isTilted, `[testcube ${order}] [BUG] merged 3D shell is tilted`).toBe(false);
  }, 120_000);
});
