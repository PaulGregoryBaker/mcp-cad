/**
 * User manual-testing report (Form.AI.tion app, "testCube" project): after
 * merge_bodies_with_bend(wallA, wallB) succeeds (producing a chained/
 * composite panel), a SECOND merge_bodies_with_bend(chained, wallC) — adding
 * a third inner-cube wall to the bracket via another bend — failed with
 * "DXF union produced disconnected geometry (2 regions); refusing fallback
 * approximation." The user also flagged a suspect extra cut line right at
 * the bend boundary in the flat pattern of the merge that DID succeed,
 * suspecting the two are related.
 *
 * This file covers TWO 3-panel chain shapes with testcube.step's inner cube:
 *
 * 1. A "U-channel" (wall + bottom + the OPPOSITE wall) — all 3 panels'
 *    bend lines run PARALLEL to each other (a linear chain, like a real
 *    hat-channel/U-bracket). The union-disconnect fix (anchor W/H matching
 *    effectiveAFlatWidth's isChainedMerge override) plus generalizing
 *    buildShellFromFlatPattern's bend rebuild to N sequential bend zones
 *    (instead of exactly 1) together fix this case correctly — both the
 *    union AND the resulting 3D position of all three walls.
 *
 * 2. A "tray corner" (wall + ADJACENT wall + bottom, all 3 meeting at one
 *    cube vertex) — the second merge's fold line ends up PERPENDICULAR to
 *    the first merge's, not parallel. Rather than trying to re-derive the
 *    prior composite's 3D placement from a flat-pattern rebuild (which
 *    cannot represent a bend-layout where fold axes are non-parallel —
 *    the two constituent planes are literally perpendicular, making any
 *    single-anchor flat-pattern placement wrong for at least one of them),
 *    this case now uses a live-3D BRepAlgoAPI_Fuse of the EXISTING, already-
 *    correctly-placed 3D shells — preserving ALL panels' true 3D positions
 *    at the cost of the new joint having a planar (not rounded) seam.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding } from '../../src/mcp/state';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}
function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number { return b[`${axis}_max`] - b[`${axis}_min`]; }
function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}
function thinAxis(b: Bbox): 'x' | 'y' | 'z' {
  const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
    { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
  ];
  dims.sort((a, b2) => a.extent - b2.extent);
  return dims[0]!.axis;
}
function buildAxisAlignedProbe(
  gb: ReturnType<typeof getGeometryBinding>, bbox: Bbox, thin: 'x' | 'y' | 'z', pad: number,
): { shellId: string } {
  const thickness = ext(bbox, thin);
  const rect = (w: number, h: number): string => [
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', String(w), '20', '0',
    '10', String(w), '20', String(h),
    '10', '0', '20', String(h),
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  if (thin === 'x') {
    return gb.buildShellFromFlatPattern(rect(ext(bbox, 'y') + 2 * pad, ext(bbox, 'z') + 2 * pad), [], thickness, {
      hasFrame: true,
      originX: bbox.x_min, originY: bbox.y_min - pad, originZ: bbox.z_min - pad,
      uX: 0, uY: 1, uZ: 0, vX: 0, vY: 0, vZ: 1, normalX: 1, normalY: 0, normalZ: 0,
      nCentreMm: bbox.x_min + thickness / 2,
    });
  }
  if (thin === 'y') {
    return gb.buildShellFromFlatPattern(rect(ext(bbox, 'x') + 2 * pad, ext(bbox, 'z') + 2 * pad), [], thickness, {
      hasFrame: true,
      originX: bbox.x_min - pad, originY: bbox.y_min, originZ: bbox.z_min - pad,
      uX: 1, uY: 0, uZ: 0, vX: 0, vY: 0, vZ: 1, normalX: 0, normalY: 1, normalZ: 0,
      nCentreMm: bbox.y_min + thickness / 2,
    });
  }
  return gb.buildShellFromFlatPattern(rect(ext(bbox, 'x') + 2 * pad, ext(bbox, 'y') + 2 * pad), [], thickness, {
    hasFrame: true,
    originX: bbox.x_min - pad, originY: bbox.y_min - pad, originZ: bbox.z_min,
    uX: 1, uY: 0, uZ: 0, vX: 0, vY: 1, vZ: 0, normalX: 0, normalY: 0, normalZ: 1,
    nCentreMm: bbox.z_min + thickness / 2,
  });
}

describe('[diagnostic] testcube.step: 3-panel chained merge_bodies_with_bend', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  async function splitAndClassifyInnerWalls(txId: string): Promise<Array<{ id: string; bbox: Bbox }>> {
    const fixturePath = findFixture('testcube.step');
    if (!fixturePath) return [];
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0, transaction_id: txId,
    }, config);
    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panels.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    return panels.filter(({ bbox }) => {
      const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
      return dims[0]! < 5 && dims[1]! > 140 && dims[1]! < 160 && dims[2]! > 140 && dims[2]! < 160;
    });
  }

  async function positionCheck(
    tag: string, mergedShellId: string, walls: Array<{ label: string; bbox: Bbox }>, txId: string,
    // Bug 11's own single-bend test used 30% — a 2-bend chain compounds the
    // same per-bend rounding (bend-allowance/radius accounting; confirmed
    // present and accepted even for a single bend — see e.g.
    // real_panel_translate_merge_bend_rotation's own ~1mm edge effect) into
    // a thinner zero-padding-on-the-thin-axis probe's overlap twice over,
    // so a chained 3-panel check needs a looser bar to avoid flagging that
    // same already-accepted tolerance as a fresh bug.
    minFraction = 0.3,
  ): Promise<string[]> {
    const gb = getGeometryBinding();
    const issues: string[] = [];
    for (const { label, bbox } of walls) {
      const thin = thinAxis(bbox);
      const probe = buildAxisAlignedProbe(gb, bbox, thin, 3);
      const copy: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [mergedShellId], vector: [0, 0, 0], keep_original: true,
      }, config);
      let volume = 0;
      try {
        const result: any = await dispatchTool('intersect_bodies', { transaction_id: txId, target_a: copy.solid_id, target_b: probe.shellId }, config);
        const mass: any = await dispatchTool('mass_properties', { target: result.solid_id }, config);
        volume = mass.volume as number;
      } catch { /* empty overlap -> 0 */ }
      const wallVolume = ext(bbox, 'x') * ext(bbox, 'y') * ext(bbox, 'z');
      console.log(`[${tag}] merged∩${label} (true position) volume=${volume.toFixed(1)} (wall's own=${wallVolume.toFixed(1)})`);
      if (volume <= wallVolume * minFraction) {
        issues.push(`merged∩${label} at its TRUE position is implausibly small (${volume.toFixed(1)} vs wall's own ${wallVolume.toFixed(1)})`);
      }
    }
    return issues;
  }

  it('U-channel: merge(+Y wall, bottom) -> chain; merge(chain, -Y wall) — all 3 bends parallel, must produce a correct 3D shape', async () => {
    const txn: any = await dispatchTool('begin_transaction', { label: 'u-channel-chain' }, config);
    const txId: string = txn.transaction_id;
    const innerWalls = await splitAndClassifyInnerWalls(txId);
    if (innerWalls.length === 0) { console.warn('testcube.step missing — skipping'); return; }
    expect(innerWalls.length).toBe(6);

    const plusYEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'y' && bbox.y_min > 0);
    const minusYEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'y' && bbox.y_min < 0);
    const bottomEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'z' && bbox.z_min < 0);
    expect(plusYEntry, '+Y inner wall').toBeDefined();
    expect(minusYEntry, '-Y inner wall').toBeDefined();
    expect(bottomEntry, '-Z inner wall (bottom)').toBeDefined();
    const plusY = plusYEntry!, minusY = minusYEntry!, bottom = bottomEntry!;
    console.log(`[u-channel] +Y wall: ${fmt(plusY.bbox)}`);
    console.log(`[u-channel] bottom:  ${fmt(bottom.bbox)}`);
    console.log(`[u-channel] -Y wall: ${fmt(minusY.bbox)}`);

    let chained: any = null, chainError: unknown = null;
    try {
      chained = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: plusY.id, part_b_id: bottom.id, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) { chainError = err; console.log(`[u-channel] step 1 merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`); }
    expect(chainError, '[u-channel] step 1 (+Y wall + bottom) merge must not throw').toBeNull();
    if (!chained) return;
    console.log(`[u-channel] chained bbox: ${fmt(await dispatchTool('bounding_box', { target: chained.merged_shell_id }, config) as Bbox)}`);

    let triple: any = null, tripleError: unknown = null;
    try {
      triple = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: chained.merged_part_id, part_b_id: minusY.id, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) { tripleError = err; console.log(`[u-channel] step 2 merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`); }
    expect(tripleError, '[u-channel] [BUG] step 2 (chain + -Y wall) merge must not throw').toBeNull();
    if (!triple) return;
    console.log(`[u-channel] triple-merged bbox: ${fmt(await dispatchTool('bounding_box', { target: triple.merged_shell_id }, config) as Bbox)}`);

    const issues = await positionCheck('u-channel', triple.merged_shell_id, [
      { label: 'plusYWall', bbox: plusY.bbox }, { label: 'bottom', bbox: bottom.bbox }, { label: 'minusYWall', bbox: minusY.bbox },
    ], txId, 0.15);
    expect(issues, `[u-channel] [BUG] ${issues.length} position issue(s):\n${issues.map((s) => `  - ${s}`).join('\n')}`).toEqual([]);
  }, 60_000);

  it('Tray corner: merge(innerXWall, innerYWall) -> chain; merge(chain, innerBottom) — bends perpendicular, correct 3D result via live-fuse path', async () => {
    const txn: any = await dispatchTool('begin_transaction', { label: 'corner-chain' }, config);
    const txId: string = txn.transaction_id;
    const innerWalls = await splitAndClassifyInnerWalls(txId);
    if (innerWalls.length === 0) { console.warn('testcube.step missing — skipping'); return; }

    const innerXWallEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'x' && bbox.x_min > 0);
    const innerYWallEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'y' && bbox.y_min > 0);
    const innerBottomEntry = innerWalls.find(({ bbox }) => thinAxis(bbox) === 'z' && bbox.z_min < 0);
    expect(innerXWallEntry, '+X inner wall').toBeDefined();
    expect(innerYWallEntry, '+Y inner wall').toBeDefined();
    expect(innerBottomEntry, '-Z inner wall (bottom)').toBeDefined();
    const innerXWall = innerXWallEntry!, innerYWall = innerYWallEntry!, innerBottom = innerBottomEntry!;

    let chained: any = null, chainError: unknown = null;
    try {
      chained = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: innerXWall.id, part_b_id: innerYWall.id, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) { chainError = err; console.log(`[corner] step 1 merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`); }
    expect(chainError, '[corner] step 1 (X+Y) merge must not throw').toBeNull();
    if (!chained) return;

    // Corner chain (fold axis perpendicular to the prior merge's): routes
    // to the live-3D-fuse path (BRepAlgoAPI_Fuse on already-correctly-
    // placed shells) rather than attempting a flat-pattern rebuild whose
    // single-anchor placement cannot simultaneously represent both planes
    // of a non-coplanar composite. All three panels' true 3D positions
    // are now verified via a positionCheck assert below.
    let triple: any = null, tripleError: unknown = null;
    try {
      triple = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: chained.merged_part_id, part_b_id: innerBottom.id, target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) { tripleError = err; console.log(`[corner] step 2 merge threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`); }
    expect(tripleError, '[corner] step 2 (chain + bottom) merge must not throw').toBeNull();
    if (!triple) return;
    console.log(`[corner] triple-merged bbox: ${fmt(await dispatchTool('bounding_box', { target: triple.merged_shell_id }, config) as Bbox)}`);
    // Corner chains now use a live-3D-fuse path (BRepAlgoAPI_Fuse on the
    // already-correctly-placed 3D shells) instead of the flat-pattern
    // rebuild — giving correct positions for all three panels.
    const cornerIssues = await positionCheck('corner', triple.merged_shell_id, [
      { label: 'innerXWall', bbox: innerXWall.bbox }, { label: 'innerYWall', bbox: innerYWall.bbox }, { label: 'innerBottom', bbox: innerBottom.bbox },
    ], txId, 0.25);
    expect(cornerIssues, `[corner] [BUG] ${cornerIssues.length} position issue(s):\n${cornerIssues.map((s) => `  - ${s}`).join('\n')}`).toEqual([]);

    // Unfold must succeed on the merged result — the live-fuse path currently
    // leaves non-uniform thickness at the joint (BRepAlgoAPI_Fuse without a
    // corner-cut step), causing GE_PANEL_NON_UNIFORM_THICKNESS and "Unfold
    // skipped" in the app. Reproduced via live testing on Cauldron2; this
    // assert ensures any fix is verifiable without a manual app test.
    let unfoldError: unknown = null;
    try {
      await dispatchTool('get_unfold', {
        transaction_id: txId,
        part_id: triple.merged_part_id,
        panel_id: triple.merged_part_id,
        material_id: 'mild_steel_1.5mm',
      }, config);
    } catch (err) { unfoldError = err; }
    expect(unfoldError, `[corner] [BUG] get_unfold must not throw after a corner-chain merge: ${JSON.stringify(unfoldError)}`).toBeNull();
  }, 60_000);
});
