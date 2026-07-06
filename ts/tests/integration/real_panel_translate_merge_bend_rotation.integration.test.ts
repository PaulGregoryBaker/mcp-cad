/**
 * merge_bodies_with_bend on REAL split panels meeting at a 90deg bend, one of
 * them translated (round-trip, net zero) before the merge — checking the
 * resulting panel's ROTATION (panelFrame u/v/normal), not just volume/bbox.
 *
 * Same rationale as real_panel_translate_fuse_rotation.integration.test.ts,
 * but for the bend-merge path specifically, which has a documented history of
 * fragile transform/placement interactions this session (mechanism A/B/C in
 * [[project_seam_offset_fix]], the bHingeOffsetMm fix's interaction with a
 * stale panelFrame in [[project_fuse_bodies_translate_fix]]).
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
function fmtFrame(f: { uX: number; uY: number; uZ: number; vX: number; vY: number; vZ: number; normalX: number; normalY: number; normalZ: number }): string {
  return `u=(${f.uX.toFixed(3)},${f.uY.toFixed(3)},${f.uZ.toFixed(3)}) v=(${f.vX.toFixed(3)},${f.vY.toFixed(3)},${f.vZ.toFixed(3)}) n=(${f.normalX.toFixed(3)},${f.normalY.toFixed(3)},${f.normalZ.toFixed(3)})`;
}
function thinAxisOf(b: Bbox): 'x' | 'y' | 'z' {
  const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
    { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
  ];
  dims.sort((a, b2) => a.extent - b2.extent);
  return dims[0]!.axis;
}
function centre(b: Bbox, axis: 'x' | 'y' | 'z'): number { return (b[`${axis}_min`] + b[`${axis}_max`]) / 2; }
// Builds a thin rectangular probe shell covering exactly `bbox` for use with
// intersect_bodies, given which axis is the bbox's own thin (normal)
// direction. `pad` mm of slack is added on the two IN-PLANE axes only (so a
// "must overlap" check can't miss legitimately-present content that shifted
// slightly); the thin axis is left at the bbox's own exact extent with zero
// slack, so a probe can't spill across the bend seam into an adjacent
// panel's material. Mirrors the manual DXF-rectangle + explicit-placement
// technique already used elsewhere in this suite (e.g.
// testcube_plus75_protrusion_fuse_merge_bottom_repro) — no dedicated
// "create box" tool exists.
function buildAxisAlignedProbe(
  gb: ReturnType<typeof getGeometryBinding>, bbox: Bbox, thinAxis: 'x' | 'y' | 'z', pad: number,
): { shellId: string } {
  const thickness = ext(bbox, thinAxis);
  const rect = (w: number, h: number): string => [
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', String(w), '20', '0',
    '10', String(w), '20', String(h),
    '10', '0', '20', String(h),
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  if (thinAxis === 'x') {
    return gb.buildShellFromFlatPattern(rect(ext(bbox, 'y') + 2 * pad, ext(bbox, 'z') + 2 * pad), [], thickness, {
      hasFrame: true,
      originX: bbox.x_min, originY: bbox.y_min - pad, originZ: bbox.z_min - pad,
      uX: 0, uY: 1, uZ: 0, vX: 0, vY: 0, vZ: 1, normalX: 1, normalY: 0, normalZ: 0,
      nCentreMm: bbox.x_min + thickness / 2,
    });
  }
  if (thinAxis === 'y') {
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

describe('[diagnostic] merge_bodies_with_bend on REAL split panels, one translated first — rotation check', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  const orders: Array<'aFirst' | 'bFirst'> = ['aFirst', 'bFirst'];
  // Which of the two adjacent (90deg) walls gets round-trip translated.
  const translated: Array<'first' | 'second'> = ['first', 'second'];
  const cases = orders.flatMap((order) => translated.map((which) => ({ order, which })));

  it.each(cases)('cube_with_flanges.stp: two adjacent real walls (90deg bend), $which translated, merged ($order)', async ({ order, which }) => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }

    const tag = `${which}/${order}`;
    const txn: any = await dispatchTool('begin_transaction', { label: `real-bend-translate-${tag}` }, config);
    const txId: string = txn.transaction_id;

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0, transaction_id: txId,
    }, config);
    expect(split.panel_count).toBe(10);

    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panels.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }
    // Two LARGE walls (cube faces), mutually perpendicular normals — a real
    // 90deg bend pair, no flanges involved.
    const walls = panels.filter(({ bbox }) => {
      const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
      return dims[0]! < 5 && dims[1]! > 150 && dims[2]! > 150;
    });
    expect(walls.length).toBeGreaterThanOrEqual(2);

    const thinAxis = thinAxisOf;
    // Pick two walls with DIFFERENT thin axes (perpendicular normals = a real bend, not coplanar).
    let wallAId = '', wallBId = '';
    let wallABbox: Bbox | undefined, wallBBbox: Bbox | undefined;
    outer: for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        if (thinAxis(walls[i]!.bbox) !== thinAxis(walls[j]!.bbox)) {
          wallAId = walls[i]!.id; wallBId = walls[j]!.id;
          wallABbox = walls[i]!.bbox; wallBBbox = walls[j]!.bbox;
          break outer;
        }
      }
    }
    expect(wallAId, 'expected two mutually-perpendicular walls').not.toBe('');
    console.log(`[real-bend ${tag}] wallA ${wallAId}: ${fmt(wallABbox!)}`);
    console.log(`[real-bend ${tag}] wallB ${wallBId}: ${fmt(wallBBbox!)}`);

    const frameABefore = getGeometryBinding().getPanelFrame(wallAId);
    const frameBBefore = getGeometryBinding().getPanelFrame(wallBId);
    console.log(`[real-bend ${tag}] wallA frame before: ${fmtFrame(frameABefore)}`);
    console.log(`[real-bend ${tag}] wallB frame before: ${fmtFrame(frameBBefore)}`);

    // Round-trip translate (net zero) whichever wall the case specifies, by
    // 41mm along an axis that's in-plane for that wall (not its own thickness
    // axis), then back.
    const targetId = which === 'first' ? wallAId : wallBId;
    const targetBbox = which === 'first' ? wallABbox! : wallBBbox!;
    const targetThin = thinAxis(targetBbox);
    const moveAxisIdx = targetThin === 'x' ? 1 : 0;
    const away: [number, number, number] = [0, 0, 0];
    away[moveAxisIdx] = 41;
    const back: [number, number, number] = away.map((v) => -v) as [number, number, number];

    const moved1: any = await dispatchTool('translate_body', { transaction_id: txId, targets: [targetId], vector: away, keep_original: false }, config);
    const moved2: any = await dispatchTool('translate_body', { transaction_id: txId, targets: [moved1.solid_id], vector: back, keep_original: false }, config);
    const movedFinalId: string = moved2.solid_id;

    const movedBboxAfter: Bbox = await dispatchTool('bounding_box', { target: movedFinalId }, config) as Bbox;
    console.log(`[real-bend ${tag}] ${which} after round-trip translate: ${fmt(movedBboxAfter)}`);
    const TOL_MM = 0.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      expect(Math.abs(movedBboxAfter[k] - targetBbox[k]),
        `[real-bend ${tag}] [BUG] ${which} wall bbox.${k} changed after a net-zero round-trip translate`).toBeLessThanOrEqual(TOL_MM);
    }

    const finalWallAId = which === 'first' ? movedFinalId : wallAId;
    const finalWallBId = which === 'second' ? movedFinalId : wallBId;
    const toolOrder = order === 'aFirst' ? [finalWallAId, finalWallBId] : [finalWallBId, finalWallAId];

    let mergeError: unknown = null;
    let merged: any = null;
    try {
      merged = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: txId, part_a_id: toolOrder[0], part_b_id: toolOrder[1], target_edges: ['all'], bend_radius: 1.0,
      }, config);
    } catch (err) {
      mergeError = err;
      console.log(`[real-bend ${tag}] merge_bodies_with_bend threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    expect(mergeError, `[real-bend ${tag}] merge_bodies_with_bend must not throw`).toBeNull();
    if (!merged) return;

    const mergedBbox: Bbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    const mergedFrame = getGeometryBinding().getPanelFrame(merged.merged_shell_id as string);
    console.log(`[real-bend ${tag}] merged bbox: ${fmt(mergedBbox)}`);
    console.log(`[real-bend ${tag}] merged frame: ${fmtFrame(mergedFrame)}`);

    const expectedUnion: Bbox = {
      x_min: Math.min(wallABbox!.x_min, wallBBbox!.x_min), x_max: Math.max(wallABbox!.x_max, wallBBbox!.x_max),
      y_min: Math.min(wallABbox!.y_min, wallBBbox!.y_min), y_max: Math.max(wallABbox!.y_max, wallBBbox!.y_max),
      z_min: Math.min(wallABbox!.z_min, wallBBbox!.z_min), z_max: Math.max(wallABbox!.z_max, wallBBbox!.z_max),
    };
    console.log(`[real-bend ${tag}] expected (union) bbox: ${fmt(expectedUnion)}`);
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(mergedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[real-bend ${tag}] [BUG] merged bbox.${k}: expected≈${expectedUnion[k].toFixed(2)} got=${mergedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(5.0);
    }

    // ── Position assertions: catch "panel ends up on the OPPOSITE cube face" ─
    // A bbox-union check alone can't catch this symptom (reported by the
    // user): if one panel's content lands on the wrong (opposite) face of the
    // cube but the bend still folds toward the other panel in aggregate, the
    // merged bbox can still look like a plausible union. Isolate each panel's
    // actual recovered region from the merged shell via intersect_bodies and
    // check it lands on the TRUE wall position, never on that wall's opposite
    // cube face. intersect_bodies is destructive (consumes target_a/target_b),
    // so every probe gets a freshly-built shell and every check against the
    // merged shell uses a fresh [0,0,0] keep_original:true copy.
    const wallAThin = thinAxis(wallABbox!);
    const wallBThin = thinAxis(wallBBbox!);
    const findOppositeWall = (selfId: string, selfBbox: Bbox, selfThin: 'x' | 'y' | 'z'): Bbox | undefined => {
      let best: { bbox: Bbox; dist: number } | undefined;
      for (const w of walls) {
        if (w.id === selfId || thinAxis(w.bbox) !== selfThin) continue;
        const dist = Math.abs(centre(w.bbox, selfThin) - centre(selfBbox, selfThin));
        if (!best || dist > best.dist) best = { bbox: w.bbox, dist };
      }
      return best?.bbox;
    };
    const wallAOppositeBbox = findOppositeWall(wallAId, wallABbox!, wallAThin);
    const wallBOppositeBbox = findOppositeWall(wallBId, wallBBbox!, wallBThin);
    if (wallAOppositeBbox) console.log(`[real-bend ${tag}] wallA's opposite face: ${fmt(wallAOppositeBbox)}`);
    if (wallBOppositeBbox) console.log(`[real-bend ${tag}] wallB's opposite face: ${fmt(wallBOppositeBbox)}`);

    // Collect issues (rather than asserting immediately) so a single run
    // reports the FULL diagnostic picture — including, if a wall's true
    // position comes back empty, whether its content is actually sitting on
    // the opposite cube face instead (the user's exact reported symptom).
    const issues: string[] = [];
    const freshMergedCopy = async (): Promise<string> => {
      const copy: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [merged.merged_shell_id], vector: [0, 0, 0], keep_original: true,
      }, config);
      return copy.solid_id as string;
    };
    const overlapVolume = async (bbox: Bbox, thin: 'x' | 'y' | 'z'): Promise<number> => {
      const probe = buildAxisAlignedProbe(getGeometryBinding(), bbox, thin, 3);
      const copyId = await freshMergedCopy();
      try {
        const result: any = await dispatchTool('intersect_bodies', { transaction_id: txId, target_a: copyId, target_b: probe.shellId }, config);
        const mass: any = await dispatchTool('mass_properties', { target: result.solid_id }, config);
        return mass.volume as number;
      } catch {
        return 0;
      }
    };
    const checkAtTruePosition = async (label: string, wallBbox: Bbox, wallThin: 'x' | 'y' | 'z'): Promise<void> => {
      const volume = await overlapVolume(wallBbox, wallThin);
      const wallVolume = ext(wallBbox, 'x') * ext(wallBbox, 'y') * ext(wallBbox, 'z');
      console.log(`[real-bend ${tag}] merged∩${label} (true position) volume=${volume.toFixed(1)} (wall's own=${wallVolume.toFixed(1)})`);
      if (volume <= wallVolume * 0.3) {
        issues.push(`merged∩${label} at its TRUE position is implausibly small (${volume.toFixed(1)} vs wall's own ${wallVolume.toFixed(1)}) — content is missing from where it should be`);
      }
    };
    // Threshold scales with the wall's OWN volume rather than a fixed
    // constant: the L-shaped merged result legitimately reaches the far edge
    // of BOTH walls' true footprints (e.g. wallB's far edge sits right at
    // wallA's opposite cube face's near boundary), so a thin touching-
    // boundary sliver (a few hundred mm³ for these fixtures) is expected and
    // harmless — a genuine "wall duplicated on the wrong face" bug shows up
    // as a near-FULL-volume overlap (tens of thousands of mm³), not a sliver.
    const checkNotAtOppositeFace = async (label: string, oppositeBbox: Bbox, oppositeThin: 'x' | 'y' | 'z', selfVolume: number): Promise<void> => {
      const volume = await overlapVolume(oppositeBbox, oppositeThin);
      console.log(`[real-bend ${tag}] merged∩${label} volume=${volume.toFixed(1)} (expect a thin touching sliver at most, not a meaningful fraction of ${selfVolume.toFixed(1)})`);
      if (volume > selfVolume * 0.1) {
        issues.push(`merged result overlaps ${label} by ${volume.toFixed(1)}mm³ (wall's own volume=${selfVolume.toFixed(1)}) — panel content ended up on the WRONG (opposite) cube face`);
      }
    };

    const wallAVolume = ext(wallABbox!, 'x') * ext(wallABbox!, 'y') * ext(wallABbox!, 'z');
    const wallBVolume = ext(wallBBbox!, 'x') * ext(wallBBbox!, 'y') * ext(wallBBbox!, 'z');
    await checkAtTruePosition('wallA', wallABbox!, wallAThin);
    await checkAtTruePosition('wallB', wallBBbox!, wallBThin);
    if (wallAOppositeBbox) await checkNotAtOppositeFace("wallA's opposite cube face", wallAOppositeBbox, wallAThin, wallAVolume);
    if (wallBOppositeBbox) await checkNotAtOppositeFace("wallB's opposite cube face", wallBOppositeBbox, wallBThin, wallBVolume);
    expect(issues, `[real-bend ${tag}] [BUG] ${issues.length} orientation/position issue(s) found:\n${issues.map((s) => `  - ${s}`).join('\n')}`).toEqual([]);

    // ── Graph-driven regeneration of the bent panel ──────────────────────────
    // merge_bodies_with_bend persists the EXACT fold placement basis it
    // computed (foldNormal/bendDir/anchor, plus bHingeOffsetMm) onto the
    // BendNode — see shape-ops.ts's bendNode object — specifically so the
    // bend can be regenerated from graph data alone (get_unfold +
    // buildShellFromFlatPattern), without re-deriving it from live shells
    // that are gone by the time anything downstream runs.
    const graphResult: any = await dispatchTool('query_graph', { part_id: merged.merged_part_id }, config);
    const mergedNode = graphResult.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    const mergedBendNode = graphResult.nodes.find((n: any) => n.type === 'BendNode');
    expect(mergedNode, `[real-bend ${tag}] merged part must have a canonical PanelNode`).toBeDefined();
    expect(mergedNode.shapeDxf, `[real-bend ${tag}] merged PanelNode must have shapeDxf`).toBeTruthy();
    expect(mergedBendNode, `[real-bend ${tag}] merged part must have a BendNode`).toBeDefined();
    expect(mergedBendNode.foldNormal, `[real-bend ${tag}] BendNode must have a persisted foldNormal`).toBeTruthy();
    expect(mergedBendNode.bendDir, `[real-bend ${tag}] BendNode must have a persisted bendDir`).toBeTruthy();
    expect(mergedBendNode.anchor, `[real-bend ${tag}] BendNode must have a persisted anchor`).toBeTruthy();

    const gb = getGeometryBinding();
    const roundTrip = gb.buildShellFromFlatPattern(mergedNode.shapeDxf, [{
      offsetMm: mergedBendNode.bendZoneDxfX ?? 0,
      widthMm: mergedBendNode.bendAllowance ?? 0,
      angleDeg: mergedBendNode.angle,
      innerRadiusMm: mergedBendNode.innerRadius,
      kFactor: mergedBendNode.kFactor,
      foldNormalX: mergedBendNode.foldNormal[0], foldNormalY: mergedBendNode.foldNormal[1], foldNormalZ: mergedBendNode.foldNormal[2],
      bendDirX: mergedBendNode.bendDir[0], bendDirY: mergedBendNode.bendDir[1], bendDirZ: mergedBendNode.bendDir[2],
      bHingeOffsetMm: mergedBendNode.bHingeOffsetMm ?? 0,
      hasAnchor: true,
      anchorX: mergedBendNode.anchor[0], anchorY: mergedBendNode.anchor[1], anchorZ: mergedBendNode.anchor[2],
    }], mergedNode.nominalThickness);
    const roundTripBbox: Bbox = await dispatchTool('bounding_box', { target: roundTrip.shellId }, config) as Bbox;
    console.log(`[real-bend ${tag}] round-trip rebuild bbox: ${fmt(roundTripBbox)}`);
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(roundTripBbox[k] - mergedBbox[k]);
      expect(delta,
        `[real-bend ${tag}] [BUG] round-trip rebuild from the merged PanelNode's OWN (shapeDxf) plus the ` +
        `BendNode's persisted fold placement does not reproduce the merge's own output shell ` +
        `(merged=${mergedBbox[k].toFixed(2)} roundtrip=${roundTripBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm)`)
        .toBeLessThanOrEqual(1.0);
    }
  }, 60_000);
});
