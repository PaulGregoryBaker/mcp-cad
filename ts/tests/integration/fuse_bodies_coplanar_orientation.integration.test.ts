import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding, getParts, createPart } from '../../src/mcp/state';
import { toNodeId } from '../../src/manufacturing/graph/types';
import type { PanelNode, BodyId, PanelFrame } from '../../src/manufacturing/graph/types';
import { ringToLwpolylineDxf } from '../../src/mcp/dxf-helpers';

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

type Axis = 'x' | 'y' | 'z';

function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] ` +
    `y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] ` +
    `z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}

function ext(b: Bbox, axis: Axis): number {
  return b[`${axis}_max`] - b[`${axis}_min`];
}

function unionBbox(a: Bbox, b: Bbox): Bbox {
  return {
    x_min: Math.min(a.x_min, b.x_min), y_min: Math.min(a.y_min, b.y_min), z_min: Math.min(a.z_min, b.z_min),
    x_max: Math.max(a.x_max, b.x_max), y_max: Math.max(a.y_max, b.y_max), z_max: Math.max(a.z_max, b.z_max),
  };
}

// Orientation-agnostic: the axis with the smallest extent, and that axis's
// midpoint (used to test whether two panels lie in the same plane,
// regardless of which way the whole fixture happens to be rotated).
function thinAxis(b: Bbox): { axis: Axis; extent: number; center: number } {
  const dims: Array<{ axis: Axis; extent: number }> = [
    { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
  ];
  dims.sort((a, b2) => a.extent - b2.extent);
  const thin = dims[0]!;
  const center = (b[`${thin.axis}_min`] + b[`${thin.axis}_max`]) / 2;
  return { axis: thin.axis, extent: thin.extent, center };
}

interface WallFlangePair { wallId: string; wallBbox: Bbox; flangeId: string; flangeBbox: Bbox; thicknessAxis: Axis }

// Finds coplanar wall+flange pairs from cube_with_flanges.stp's 10 split panels,
// by GEOMETRIC properties only (size + coplanarity) rather than hardcoded world
// axis ranges — so it works identically no matter how the whole solid was
// rotated before splitting.
function findWallFlangePairs(panels: Array<{ id: string; bbox: Bbox }>): WallFlangePair[] {
  const walls = panels.filter(({ bbox }) => {
    const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
    return dims[0]! < 5 && dims[1]! > 150 && dims[2]! > 150;
  });
  const flanges = panels.filter(({ bbox }) =>
    ext(bbox, 'x') < 50 && ext(bbox, 'y') < 50 && ext(bbox, 'z') < 50);

  const pairs: WallFlangePair[] = [];
  for (const wall of walls) {
    const wallThin = thinAxis(wall.bbox);
    for (const flange of flanges) {
      const flangeThin = thinAxis(flange.bbox);
      if (flangeThin.axis !== wallThin.axis) continue;
      if (Math.abs(flangeThin.center - wallThin.center) > 10) continue; // same plane
      pairs.push({ wallId: wall.id, wallBbox: wall.bbox, flangeId: flange.id, flangeBbox: flange.bbox, thicknessAxis: wallThin.axis });
    }
  }
  return pairs;
}

async function queryPanelNode(config: ReturnType<typeof loadConfig>, partId: string): Promise<PanelNode> {
  const result: any = await dispatchTool('query_graph', { part_id: partId }, config);
  const node = result.nodes.find((n: any) => n.type === 'PanelNode');
  expect(node, `part ${partId} must have a PanelNode`).toBeDefined();
  return node as PanelNode;
}

// Builds an explicit placement for buildShellFromFlatPattern straight from a
// PanelNode's own graph data — never from a live shell query.
function explicitPlacementFrom(node: PanelNode) {
  const frame = node.panelFrame!;
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  const normal = frame.normal ?? [
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ];
  return {
    hasFrame: true,
    originX: frame.origin[0], originY: frame.origin[1], originZ: frame.origin[2],
    uX: ux, uY: uy, uZ: uz,
    vX: vx, vY: vy, vZ: vz,
    normalX: normal[0], normalY: normal[1], normalZ: normal[2],
    nCentreMm: node.midplaneOffsetMm ?? node.nominalThickness / 2,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// fuse_bodies on two genuinely COPLANAR panels (cube_with_flanges.stp's wall +
// its own attached flange — same face, same normal, no bend at all). This is
// the operation directly under test here, NOT merge_bodies_with_bend.
//
// The flange's footprint is fully CONTAINED within the wall's (it's a
// reinforcement patch, not an edge extension), so this also exercises
// fuse_bodies's footprint-stacking support: the 2D outline union can't
// represent the flange's material at all, so it must be additionally 3D-fused
// onto the reconstruction.
//
// IMPORTANT: this test compares against panel geometry rebuilt independently
// from each panel's OWN manufacturing-graph data (shapeDxf, nominalThickness,
// panelFrame, midplaneOffsetMm) — never against the raw split-time 3D shell.
// The manufacturing graph is the source of truth; that raw shell is
// disposable and, for a panel boolean-fused (zero gap) to a same-thickness
// neighbour, can itself measure contaminated (see
// split_thickness_consistency.integration.test.ts) — using it as a reference
// here would just compare one disposable shell against another.
// ────────────────────────────────────────────────────────────────────────────
describe('[fuse-only] fuse_bodies: coplanar wall+flange (footprint-contained flange becomes a 3D-stacked feature)', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  interface OrientationCase {
    label: 'X-normal' | 'Y-normal' | 'Z-normal';
    rotate: { axisDirection: [number, number, number]; angleDegrees: number } | null;
    expectedAxis: Axis;
  }

  const orientationCases: OrientationCase[] = [
    { label: 'X-normal', rotate: null, expectedAxis: 'x' },
    // Rotate -90° about Z: world X -> world Y (the original +X wall's normal
    // becomes Y instead). The +Y wall (unaffected by a Z-axis rotation) also
    // still exists, so explicitly pick the pair matching expectedAxis rather
    // than just taking whichever pair comes first.
    { label: 'Y-normal', rotate: { axisDirection: [0, 0, 1], angleDegrees: -90 }, expectedAxis: 'y' },
    // Rotate -90° about Y: world X -> world Z.
    { label: 'Z-normal', rotate: { axisDirection: [0, 1, 0], angleDegrees: -90 }, expectedAxis: 'z' },
  ];
  // fuse_bodies treats tools[0] as the "preserved" part_id (handleFuseBodies's
  // preservedPartId) and tools[1] as consumed — order has driven real,
  // order-dependent bugs elsewhere in this codebase (merge_bodies_with_bend's
  // compositeFirst/simpleFirst split), so both orders are tested here too,
  // not just wall-first.
  const orders: Array<'wallFirst' | 'flangeFirst'> = ['wallFirst', 'flangeFirst'];
  const cases = orientationCases.flatMap((c) => orders.map((order) => ({ ...c, order })));

  it.each(cases)('$label ($order): fused result contains both panels\' true volumes, thickness grows only over the flange\'s footprint', async ({ label, rotate, expectedAxis, order }) => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }
    const config = loadConfig(configPath);

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);

    const txn: any = await dispatchTool('begin_transaction', { label: `fuse-only-${label}-${order}` }, config);
    const txId: string = txn.transaction_id;

    let solidId: string = clean.solid_id;
    if (rotate) {
      const rotated: any = await dispatchTool('rotate_body', {
        transaction_id: txId,
        targets: [solidId],
        axis_origin: [0, 0, 0],
        axis_direction: rotate.axisDirection,
        angle_degrees: rotate.angleDegrees,
        keep_original: false,
      }, config);
      solidId = rotated.solid_id;
    }

    // default_thickness_mm deliberately omitted: split_body_by_bends now
    // measures each resulting panel's actual geometric thickness (1mm here,
    // via the Dominant Face Method + cross-panel correction) rather than
    // defaulting to 1.0mm.
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 45,
      max_thickness_mm: 5.0,
      transaction_id: txId,
    }, config);
    expect(split.panel_count, `[${label}] cube_with_flanges must split into 10 panels`).toBe(10);

    const panelIds = split.panel_ids as string[];
    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of panelIds) {
      const bbox = await dispatchTool('bounding_box', { target: id }, config) as Bbox;
      panels.push({ id, bbox });
    }
    const pairs = findWallFlangePairs(panels);
    expect(pairs.length, `[${label}] expected at least 2 coplanar wall+flange pairs`).toBeGreaterThanOrEqual(2);
    const matchingPair = pairs.find((p) => p.thicknessAxis === expectedAxis);
    expect(matchingPair, `[${label}] expected a wall+flange pair with thickness axis ${expectedAxis}`).toBeDefined();
    const { wallId, flangeId, thicknessAxis } = matchingPair!;
    console.log(`[${label}] thicknessAxis=${thicknessAxis}`);

    // ── Clean, graph-derived reference geometry ──────────────────────────────
    // Rebuild wall and flange INDEPENDENTLY from their OWN manufacturing-graph
    // data, before fuse_bodies consumes them. This is the ground truth: each
    // panel's own shapeDxf + nominalThickness + panelFrame + midplaneOffsetMm,
    // not the disposable split-time shell.
    const wallNode = await queryPanelNode(config, wallId);
    const flangeNode = await queryPanelNode(config, flangeId);
    const gb = getGeometryBinding();
    const wallRefBuild = gb.buildShellFromFlatPattern(wallNode.shapeDxf!, [], wallNode.nominalThickness, explicitPlacementFrom(wallNode));
    const flangeRefBuild = gb.buildShellFromFlatPattern(flangeNode.shapeDxf!, [], flangeNode.nominalThickness, explicitPlacementFrom(flangeNode));
    const wallRefId: string = wallRefBuild.shellId;
    const flangeRefId: string = flangeRefBuild.shellId;

    const wallRefBbox = await dispatchTool('bounding_box', { target: wallRefId }, config) as Bbox;
    const flangeRefBbox = await dispatchTool('bounding_box', { target: flangeRefId }, config) as Bbox;
    const wallRefVol: any = await dispatchTool('mass_properties', { target: wallRefId, properties: ['volume'] }, config);
    const flangeRefVol: any = await dispatchTool('mass_properties', { target: flangeRefId, properties: ['volume'] }, config);
    console.log(`[${label}] wall (graph-rebuilt):   ${fmt(wallRefBbox)} volume=${wallRefVol.volume.toFixed(1)}mm³`);
    console.log(`[${label}] flange (graph-rebuilt): ${fmt(flangeRefBbox)} volume=${flangeRefVol.volume.toFixed(1)}mm³`);

    // These reference shells were just consumed by bounding_box/mass_properties
    // queries? No — those are non-mutating. But intersect_bodies/fuse_bodies
    // below DO consume their inputs, so duplicate the references now, before
    // running fuse_bodies, exactly as before.
    const wallDup: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [wallRefId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const flangeDup: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [flangeRefId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const wallRefIdForContainment: string = wallDup.solid_id;
    const flangeRefIdForContainment: string = flangeDup.solid_id;

    const toolOrder = order === 'wallFirst' ? [wallId, flangeId] : [flangeId, wallId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, `[${label}] fuse_bodies must return a solid_id`).toBeDefined();

    // ── CONTAINMENT: the fused solid must precisely contain BOTH panels' true,
    // graph-derived volumes — not just have a bbox that happens to match.
    let wallOverlapVol = 0;
    try {
      const fusedDup1: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [fused.solid_id], vector: [0, 0, 0], keep_original: true,
      }, config);
      const wallIntersect: any = await dispatchTool('intersect_bodies', {
        target_a: fusedDup1.solid_id, target_b: wallRefIdForContainment, transaction_id: txId,
      }, config);
      const wallIntersectVol: any = await dispatchTool('mass_properties', { target: wallIntersect.solid_id, properties: ['volume'] }, config);
      wallOverlapVol = wallIntersectVol.volume;
    } catch (err) {
      console.log(`[${label} ${order}] wall intersect threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    console.log(`[${label} ${order}] wallOverlapVol=${wallOverlapVol}`);
    expect.soft(wallOverlapVol,
      `[${label} ${order}] [BUG] fused result does not contain the wall's true (graph-derived) volume ` +
      `(overlap=${wallOverlapVol.toFixed(1)}mm³ vs wall volume=${wallRefVol.volume.toFixed(1)}mm³)`)
      .toBeCloseTo(wallRefVol.volume, -1);

    let flangeOverlapVol = 0;
    try {
      const fusedDup2: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [fused.solid_id], vector: [0, 0, 0], keep_original: true,
      }, config);
      const flangeIntersect: any = await dispatchTool('intersect_bodies', {
        target_a: fusedDup2.solid_id, target_b: flangeRefIdForContainment, transaction_id: txId,
      }, config);
      const flangeIntersectVol: any = await dispatchTool('mass_properties', { target: flangeIntersect.solid_id, properties: ['volume'] }, config);
      flangeOverlapVol = flangeIntersectVol.volume;
    } catch (err) {
      console.log(`[${label} ${order}] flange intersect threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    console.log(`[${label} ${order}] flangeOverlapVol=${flangeOverlapVol}`);
    expect.soft(flangeOverlapVol,
      `[${label} ${order}] [BUG] fused result does not contain the flange's true (graph-derived) volume ` +
      `(overlap=${flangeOverlapVol.toFixed(1)}mm³ vs flange volume=${flangeRefVol.volume.toFixed(1)}mm³)`)
      .toBeCloseTo(flangeRefVol.volume, -1);

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    // The flange sits flush against (not inside) the wall along the thickness
    // axis, so the TRUE combined extent is the union of the two CLEAN,
    // graph-rebuilt bboxes — wall_thickness + flange_thickness, not just the
    // wall's own 1mm.
    const expectedUnion = unionBbox(wallRefBbox, flangeRefBbox);
    console.log(`[${label}] fused:    ${fmt(fusedBbox)}`);
    console.log(`[${label}] expected: ${fmt(expectedUnion)}`);

    // PRIMARY ASSERTION: the fused solid's overall extent along the thickness
    // axis must equal wall+flange combined (the flange is a stacked feature
    // flush against the wall, so the whole-part bbox legitimately grows by
    // exactly the flange's own thickness) — NOT the wall's thickness alone,
    // and NOT grown by anything else (which would indicate a placement bug
    // rather than correctly-included stacked material).
    const fusedThickness = ext(fusedBbox, thicknessAxis);
    const expectedThickness = ext(expectedUnion, thicknessAxis);
    expect(fusedThickness,
      `[${label}] [BUG] thickness axis (${thicknessAxis}) is ${fusedThickness.toFixed(2)}mm, expected wall+flange ` +
      `combined ${expectedThickness.toFixed(2)}mm (wall=${ext(wallRefBbox, thicknessAxis).toFixed(2)}mm + ` +
      `flange=${ext(flangeRefBbox, thicknessAxis).toFixed(2)}mm)`)
      .toBeCloseTo(expectedThickness, 0); // ±0.5mm

    // SECONDARY: precise match against the union of the two CLEAN pre-fuse
    // bboxes on every IN-PLANE bound — catches in-plane placement errors
    // (translation/rotation) the primary assertion wouldn't.
    const TOL_MM = 0.5;
    const allBounds: Array<keyof Bbox> = ['x_min', 'y_min', 'z_min', 'x_max', 'y_max', 'z_max'];
    const bounds = allBounds.filter((k) => !k.startsWith(thicknessAxis));
    for (const k of bounds) {
      const delta = Math.abs(fusedBbox[k] - expectedUnion[k]);
      expect(delta,
        `[${label}] [BUG] Bound ${k}: expected≈${expectedUnion[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    // TERTIARY: the fused panel's face normal must match the wall's ORIGINAL
    // normal exactly, including sign — catches a mirror/flip that a bbox check
    // alone cannot see (the flange is asymmetric in two of its three
    // dimensions, but a 180° flip about the thickness axis would still pass a
    // pure bbox check since the panel's own outline doesn't change under that
    // flip — only the signed normal does).
    const wallFrame = getGeometryBinding().getPanelFrame(wallId);
    const fusedFrame = getGeometryBinding().getPanelFrame(fused.solid_id as string);
    console.log(`[${label}] wall normal=(${wallFrame.normalX.toFixed(3)},${wallFrame.normalY.toFixed(3)},${wallFrame.normalZ.toFixed(3)}) ` +
      `fused normal=(${fusedFrame.normalX.toFixed(3)},${fusedFrame.normalY.toFixed(3)},${fusedFrame.normalZ.toFixed(3)})`);
    expect(fusedFrame.normalX, `[${label}] [BUG] fused normal X flipped/changed vs original wall`).toBeCloseTo(wallFrame.normalX, 1);
    expect(fusedFrame.normalY, `[${label}] [BUG] fused normal Y flipped/changed vs original wall`).toBeCloseTo(wallFrame.normalY, 1);
    expect(fusedFrame.normalZ, `[${label}] [BUG] fused normal Z flipped/changed vs original wall`).toBeCloseTo(wallFrame.normalZ, 1);
  }, 60_000);
});

// ────────────────────────────────────────────────────────────────────────────
// fuse_bodies on two hand-specified panels with a slight (0.1mm) midplane
// offset between them — modelling two faces from a real part that aren't
// PERFECTLY coplanar (a common STEP-import tolerance artifact), where the
// flange EXTENDS the wall's footprint (not contained within it, unlike the
// suite above) along the seam axis. No STEP fixture is used: both panels are
// built directly from hand-specified DXF rectangles + explicit placement
// frames via buildShellFromFlatPattern, then registered as manufacturing-
// graph parts the same way split_body_by_bends would, so fuse_bodies can
// consume them exactly as it would any other panel pair.
// ────────────────────────────────────────────────────────────────────────────
describe('[fuse-only] fuse_bodies: footprint-extending flange with slight midplane offset', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  // Builds a panel at an EXACT, hand-specified 3D bbox and registers it as a
  // manufacturing-graph part (PanelNode + bodyId), the same shape fuse_bodies
  // expects from split_body_by_bends — without needing a STEP fixture.
  // originY/originZ + the DXF rectangle's own extent fully determine the
  // panel's world Y/Z range; nCentreMm fixes its position along the
  // thickness axis (world X here).
  //
  // notch (optional) cuts a rectangular corner out of the local-(0,0) corner
  // (i.e. nearest originY/originZ), making the panel asymmetric under both a
  // Y-flip and a Z-flip about its own centre. A plain rectangle is symmetric
  // under those flips — bbox AND volume checks alike would pass even if the
  // recreated panel were mirrored in place, since a mirrored rectangle is
  // identical to the original. The notch breaks that: any flip/swap moves it
  // to a different corner, which a containment check against a reference
  // built with the notch in the CORRECT corner will catch.
  // orientation cyclically permutes which world axis plays "normal" (the
  // thickness direction nCentreMm positions along) vs the two in-plane
  // axes (originY/widthY and originZ/heightZ) — x-normal (default) matches
  // every test above this point; y-normal/z-normal verify the same fix
  // generalizes when the panel's normal ISN'T world-X.
  type Orientation = 'x-normal' | 'y-normal' | 'z-normal';
  function orientedFrame(orientation: Orientation, originY: number, originZ: number): { origin: [number, number, number]; u: [number, number, number]; v: [number, number, number]; normal: [number, number, number] } {
    if (orientation === 'y-normal') {
      // local "Y" (width) -> world Z, local "Z" (height) -> world X, normal -> world Y
      return { origin: [originZ, 0, originY], u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0] };
    }
    if (orientation === 'z-normal') {
      // local "Y" (width) -> world X, local "Z" (height) -> world Y, normal -> world Z
      return { origin: [originY, originZ, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
    }
    return { origin: [0, originY, originZ], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] };
  }

  function buildSyntheticPanel(args: {
    originY: number; originZ: number; widthY: number; heightZ: number;
    thicknessMm: number; nCentreMm: number;
    notch?: { sizeY: number; sizeZ: number };
    orientation?: Orientation;
  }): { partId: string; shapeDxf: string; panelFrame: PanelFrame; areaMm2: number } {
    const { originY, originZ, widthY, heightZ, thicknessMm, nCentreMm, notch, orientation = 'x-normal' } = args;
    const ring: Array<[number, number]> = notch
      ? [
          [notch.sizeY, 0], [widthY, 0], [widthY, heightZ], [0, heightZ],
          [0, notch.sizeZ], [notch.sizeY, notch.sizeZ],
        ]
      : [[0, 0], [widthY, 0], [widthY, heightZ], [0, heightZ]];
    const shapeDxf = ringToLwpolylineDxf(ring);
    const areaMm2 = widthY * heightZ - (notch ? notch.sizeY * notch.sizeZ : 0);
    const panelFrame: PanelFrame = orientedFrame(orientation, originY, originZ);
    const gb = getGeometryBinding();
    const built = gb.buildShellFromFlatPattern(shapeDxf, [], thicknessMm, {
      hasFrame: true,
      originX: panelFrame.origin[0], originY: panelFrame.origin[1], originZ: panelFrame.origin[2],
      uX: panelFrame.u[0], uY: panelFrame.u[1], uZ: panelFrame.u[2],
      vX: panelFrame.v[0], vY: panelFrame.v[1], vZ: panelFrame.v[2],
      normalX: panelFrame.normal![0], normalY: panelFrame.normal![1], normalZ: panelFrame.normal![2],
      nCentreMm,
    });
    const partId = built.shellId;
    createPart(partId);
    const graph = getParts().get(partId)!;
    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(partId),
      bodyId: partId as BodyId,
      dirty: false,
      materialType: 'default',
      nominalThickness: thicknessMm,
      flatWidth: widthY,
      flatHeight: heightZ,
      canonical: true,
      shapeDxf,
      panelFrame,
      midplaneOffsetMm: nCentreMm,
    });
    return { partId, shapeDxf, panelFrame, areaMm2 };
  }

  // Rigorous post-fuse verification: rebuilds FRESH, independent wall and
  // flange reference solids directly from their known-correct specs (not the
  // ones fuse_bodies already consumed), then checks the fused result against
  // them by VOLUME — not just bbox. A bbox match can hide a flip or an
  // internal shift (a symmetric shape mirrored in place has the identical
  // bbox); intersect_bodies against a precisely-positioned, asymmetric
  // (notched) reference cannot hide that — any positional or orientation
  // error shows up as less-than-full containment.
  async function assertPrecisePlacement(args: {
    order: string;
    config: ReturnType<typeof loadConfig>;
    txId: string;
    fusedSolidId: string;
    wallSpec: { originY: number; originZ: number; widthY: number; heightZ: number; thicknessMm: number; nCentreMm: number; orientation?: Orientation };
    flangeSpec: { originY: number; originZ: number; widthY: number; heightZ: number; thicknessMm: number; nCentreMm: number; notch?: { sizeY: number; sizeZ: number }; orientation?: Orientation };
    expectedWallNormal: [number, number, number];
  }): Promise<void> {
    const { order, config, txId, fusedSolidId, wallSpec, flangeSpec, expectedWallNormal } = args;

    const wallRef = buildSyntheticPanel(wallSpec);
    // fuse_bodies places the ENTIRE fused result (wall + flange footprint
    // alike) using the dominant (largest-area) panel's own thickness
    // reference — by design (see handleFuseBodies's "Picking the
    // LARGEST-area panel as the reference" comment), not each input's own
    // original midplane. The flange's pre-fuse nCentreMm (its own, possibly
    // slightly-offset midplane) is therefore NOT where its material ends up
    // post-fuse; the correct reference for the containment check below is
    // the flange's footprint at the WALL's nCentreMm.
    const flangeRef = buildSyntheticPanel({ ...flangeSpec, nCentreMm: wallSpec.nCentreMm });
    const wallRefVol: any = await dispatchTool('mass_properties', { target: wallRef.partId, properties: ['volume'] }, config);
    const flangeRefVol: any = await dispatchTool('mass_properties', { target: flangeRef.partId, properties: ['volume'] }, config);
    console.log(`[${order}] wall ref volume=${wallRefVol.volume.toFixed(2)}mm³ (expected ${(wallSpec.widthY * wallSpec.heightZ * wallSpec.thicknessMm).toFixed(2)})`);
    console.log(`[${order}] flange ref volume=${flangeRefVol.volume.toFixed(2)}mm³ (expected ${(flangeRef.areaMm2 * flangeSpec.thicknessMm).toFixed(2)})`);

    const fusedDup1: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [fusedSolidId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const wallIntersect: any = await dispatchTool('intersect_bodies', {
      target_a: fusedDup1.solid_id, target_b: wallRef.partId, transaction_id: txId,
    }, config);
    const wallOverlapVol: any = await dispatchTool('mass_properties', { target: wallIntersect.solid_id, properties: ['volume'] }, config);
    console.log(`[${order}] wall containment overlap=${wallOverlapVol.volume.toFixed(2)}mm³`);

    const fusedDup2: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [fusedSolidId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const flangeIntersect: any = await dispatchTool('intersect_bodies', {
      target_a: fusedDup2.solid_id, target_b: flangeRef.partId, transaction_id: txId,
    }, config);
    const flangeOverlapVol: any = await dispatchTool('mass_properties', { target: flangeIntersect.solid_id, properties: ['volume'] }, config);
    console.log(`[${order}] flange containment overlap=${flangeOverlapVol.volume.toFixed(2)}mm³`);

    const fusedTotalVol: any = await dispatchTool('mass_properties', { target: fusedSolidId, properties: ['volume'] }, config);
    console.log(`[${order}] fused total volume=${fusedTotalVol.volume.toFixed(2)}mm³ (wall+flange refs=${(wallRefVol.volume + flangeRefVol.volume).toFixed(2)})`);

    const fusedFrame = getGeometryBinding().getPanelFrame(fusedSolidId);
    console.log(`[${order}] fused normal=(${fusedFrame.normalX.toFixed(3)},${fusedFrame.normalY.toFixed(3)},${fusedFrame.normalZ.toFixed(3)})`);
    console.log(`[${order}] fused u=(${fusedFrame.uX.toFixed(3)},${fusedFrame.uY.toFixed(3)},${fusedFrame.uZ.toFixed(3)}) ` +
      `v=(${fusedFrame.vX.toFixed(3)},${fusedFrame.vY.toFixed(3)},${fusedFrame.vZ.toFixed(3)})`);
    console.log(`[${order}] fused origin=(${fusedFrame.originX.toFixed(3)},${fusedFrame.originY.toFixed(3)},${fusedFrame.originZ.toFixed(3)})`);

    // The fused 3D SOLID's volume/shape doesn't care how its local axes are
    // labelled — a wrong U/V (an in-plane rotation of the panel's stored
    // frame) doesn't change the solid at all, so volume/containment checks
    // above CANNOT catch it. But the frame itself is real, stored data that
    // every later operation on this panel (another fuse, a merge_bodies_with_
    // bend, an unfold) reads — explicitPlacementForIndex(0) in handleFuseBodies
    // places the WHOLE fused result using the dominant (wall) panel's EXACT
    // stored frame, so the fused result's frame must come back IDENTICAL to
    // that frame, not just "normal points the same way."
    const wallFrame = orientedFrame(wallSpec.orientation ?? 'x-normal', wallSpec.originY, wallSpec.originZ);
    console.log(`[${order}] expected u=(${wallFrame.u[0]},${wallFrame.u[1]},${wallFrame.u[2]}) v=(${wallFrame.v[0]},${wallFrame.v[1]},${wallFrame.v[2]})`);

    expect(wallOverlapVol.volume,
      `[${order}] [BUG] fused result does not fully contain the wall's reference volume — wrong wall placement`)
      .toBeCloseTo(wallRefVol.volume, 0);
    expect(flangeOverlapVol.volume,
      `[${order}] [BUG] fused result does not fully contain the (notched, asymmetric) flange's reference volume — ` +
      `flange is mispositioned, flipped, or rotated`)
      .toBeCloseTo(flangeRefVol.volume, 0);
    expect(fusedTotalVol.volume,
      `[${order}] [BUG] fused total volume doesn't equal wall+flange combined — phantom material or missing material`)
      .toBeCloseTo(wallRefVol.volume + flangeRefVol.volume, 0);
    expect(fusedFrame.normalX, `[${order}] [BUG] fused normal X flipped vs wall`).toBeCloseTo(expectedWallNormal[0], 1);
    expect(fusedFrame.normalY, `[${order}] [BUG] fused normal Y flipped vs wall`).toBeCloseTo(expectedWallNormal[1], 1);
    expect(fusedFrame.normalZ, `[${order}] [BUG] fused normal Z flipped vs wall`).toBeCloseTo(expectedWallNormal[2], 1);

    // ── Coordinate-level orientation check (volume can't catch this) ─────────
    expect(fusedFrame.uX, `[${order}] [BUG] fused U.x rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.u[0], 1);
    expect(fusedFrame.uY, `[${order}] [BUG] fused U.y rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.u[1], 1);
    expect(fusedFrame.uZ, `[${order}] [BUG] fused U.z rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.u[2], 1);
    expect(fusedFrame.vX, `[${order}] [BUG] fused V.x rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.v[0], 1);
    expect(fusedFrame.vY, `[${order}] [BUG] fused V.y rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.v[1], 1);
    expect(fusedFrame.vZ, `[${order}] [BUG] fused V.z rotated/swapped vs wall's frame`).toBeCloseTo(wallFrame.v[2], 1);
    expect(fusedFrame.originX, `[${order}] [BUG] fused origin.x doesn't match wall's stored origin`).toBeCloseTo(wallFrame.origin[0], 0);
    expect(fusedFrame.originY, `[${order}] [BUG] fused origin.y doesn't match wall's stored origin`).toBeCloseTo(wallFrame.origin[1], 0);
    expect(fusedFrame.originZ, `[${order}] [BUG] fused origin.z doesn't match wall's stored origin`).toBeCloseTo(wallFrame.origin[2], 0);
  }

  const orders: Array<'wallFirst' | 'flangeFirst'> = ['wallFirst', 'flangeFirst'];

  it.each(orders)('wall x[0..1] y[0..200] z[0..200] + flange x[0.1..1.1] y[200..210] z[0..200] (%s): fused result is a clean 210x200x1mm panel', async (order) => {
    const config = loadConfig(configPath);
    const txn: any = await dispatchTool('begin_transaction', { label: `synthetic-offset-fuse-${order}` }, config);
    const txId: string = txn.transaction_id;

    const wallSpec = { originY: 0, originZ: 0, widthY: 200, heightZ: 200, thicknessMm: 1, nCentreMm: 0.5 };
    const flangeSpec = { originY: 200, originZ: 0, widthY: 10, heightZ: 200, thicknessMm: 1, nCentreMm: 0.6, notch: { sizeY: 2, sizeZ: 20 } };
    const wall = buildSyntheticPanel(wallSpec);
    const flange = buildSyntheticPanel(flangeSpec);

    // Sanity-check the synthetic panels themselves match the requested bboxes
    // before fusing — if these fail, the bug (if any) is in this test's setup,
    // not in fuse_bodies.
    const wallBbox: Bbox = await dispatchTool('bounding_box', { target: wall.partId }, config) as Bbox;
    const flangeBbox: Bbox = await dispatchTool('bounding_box', { target: flange.partId }, config) as Bbox;
    console.log(`[synthetic ${order}] wall:   ${fmt(wallBbox)}`);
    console.log(`[synthetic ${order}] flange: ${fmt(flangeBbox)}`);
    expect(fmt(wallBbox)).toBe('x[0.00..1.00] y[0.00..200.00] z[0.00..200.00]');
    expect(fmt(flangeBbox)).toBe('x[0.10..1.10] y[200.00..210.00] z[0.00..200.00]');

    const toolOrder = order === 'wallFirst' ? [wall.partId, flange.partId] : [flange.partId, wall.partId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();

    // ── Flat-pattern (DXF) check: should be a clean 210x200 rectangle ────────
    const graphResult: any = await dispatchTool('query_graph', { part_id: fused.part_id }, config);
    const fusedNode = graphResult.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    expect(fusedNode, 'fused part must have a canonical PanelNode').toBeDefined();
    expect(fusedNode.shapeDxf, 'fused PanelNode must have shapeDxf').toBeTruthy();

    const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
    const ring = parseFirstClosedPolyline(fusedNode.shapeDxf as string);
    let dxfXMin = Infinity, dxfXMax = -Infinity, dxfYMin = Infinity, dxfYMax = -Infinity;
    for (const [x, y] of ring) {
      dxfXMin = Math.min(dxfXMin, x); dxfXMax = Math.max(dxfXMax, x);
      dxfYMin = Math.min(dxfYMin, y); dxfYMax = Math.max(dxfYMax, y);
    }
    const dxfWidth = dxfXMax - dxfXMin;
    const dxfHeight = dxfYMax - dxfYMin;
    const dxfArea = (() => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a) / 2;
    })();
    const bboxArea = dxfWidth * dxfHeight;
    const expectedArea = wallSpec.widthY * wallSpec.heightZ + flange.areaMm2;
    console.log(`[synthetic ${order}] fused flat pattern: ${dxfWidth.toFixed(2)}mm x ${dxfHeight.toFixed(2)}mm, area=${dxfArea.toFixed(1)} (expected ${expectedArea.toFixed(1)}), fill=${((dxfArea / bboxArea) * 100).toFixed(1)}%`);
    expect(Math.max(dxfWidth, dxfHeight), `[synthetic ${order}] [BUG] fused flat pattern long dimension should be 210mm`).toBeCloseTo(210, 0);
    expect(Math.min(dxfWidth, dxfHeight), `[synthetic ${order}] [BUG] fused flat pattern short dimension should be 200mm`).toBeCloseTo(200, 0);
    expect(dxfArea, `[synthetic ${order}] [BUG] fused flat pattern area should equal wall+notched-flange combined`).toBeCloseTo(expectedArea, 0);

    // ── 3D reconstruction check (bbox — coarse) ──────────────────────────────
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[synthetic ${order}] fused 3D bbox: ${fmt(fusedBbox)}`);
    const expected: Bbox = { x_min: 0, x_max: 1, y_min: 0, y_max: 210, z_min: 0, z_max: 200 };
    const TOL_MM = 0.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(fusedBbox[k] - expected[k]);
      expect(delta,
        `[synthetic ${order}] [BUG] Bound ${k}: expected≈${expected[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    // ── 3D reconstruction check (volume + normal — precise) ──────────────────
    await assertPrecisePlacement({
      order, config, txId, fusedSolidId: fused.solid_id,
      wallSpec, flangeSpec, expectedWallNormal: [1, 0, 0],
    });
  }, 60_000);

  // Same end-state as the test above, but the flange is built 10mm away
  // (x[10.1..11.1]) and moved into position with translate_body (vector
  // [-10,0,0]) instead of being built directly at its final coordinates.
  // translate_body's post-transform bookkeeping (updatePanelBodyIdAfterTransform
  // / refreshPanelFrame in helpers.ts) re-derives panelFrame + midplaneOffsetMm
  // from the shell's NEW position via a live getPanelFrame query — this
  // exercises that path instead of buildShellFromFlatPattern's explicit
  // placement, which is how a real workflow (move a panel, then fuse it)
  // would actually reach fuse_bodies.
  it.each(orders)('flange built at x[10.1..11.1], translated -10 in X to x[0.1..1.1] (%s): fused result is a clean 210x200x1mm panel', async (order) => {
    const config = loadConfig(configPath);
    const txn: any = await dispatchTool('begin_transaction', { label: `synthetic-translate-fuse-${order}` }, config);
    const txId: string = txn.transaction_id;

    const wallSpec = { originY: 0, originZ: 0, widthY: 200, heightZ: 200, thicknessMm: 1, nCentreMm: 0.5 };
    const notch = { sizeY: 2, sizeZ: 20 };
    const flangeRawSpec = { originY: 200, originZ: 0, widthY: 10, heightZ: 200, thicknessMm: 1, nCentreMm: 10.6, notch };
    // Y/Z are unaffected by the X-only translate below, so the flange's
    // FINAL spec (used as the reference for assertPrecisePlacement) differs
    // from flangeRawSpec only in nCentreMm (10.6 -> 0.6, matching vector[-10,0,0]).
    const flangeFinalSpec = { ...flangeRawSpec, nCentreMm: 0.6 };
    const wall = buildSyntheticPanel(wallSpec);
    const flangeRaw = buildSyntheticPanel(flangeRawSpec);

    const flangeRawBbox: Bbox = await dispatchTool('bounding_box', { target: flangeRaw.partId }, config) as Bbox;
    console.log(`[translate ${order}] flange before translate: ${fmt(flangeRawBbox)}`);
    expect(fmt(flangeRawBbox)).toBe('x[10.10..11.10] y[200.00..210.00] z[0.00..200.00]');

    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId,
      targets: [flangeRaw.partId],
      vector: [-10, 0, 0],
      keep_original: false,
    }, config);
    const flangePartId: string = translated.solid_id;

    const flangeBbox: Bbox = await dispatchTool('bounding_box', { target: flangePartId }, config) as Bbox;
    console.log(`[translate ${order}] flange after translate:  ${fmt(flangeBbox)}`);
    expect(fmt(flangeBbox)).toBe('x[0.10..1.10] y[200.00..210.00] z[0.00..200.00]');

    const wallBbox: Bbox = await dispatchTool('bounding_box', { target: wall.partId }, config) as Bbox;
    expect(fmt(wallBbox)).toBe('x[0.00..1.00] y[0.00..200.00] z[0.00..200.00]');

    const toolOrder = order === 'wallFirst' ? [wall.partId, flangePartId] : [flangePartId, wall.partId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, 'fuse_bodies must return a solid_id').toBeDefined();

    const graphResult: any = await dispatchTool('query_graph', { part_id: fused.part_id }, config);
    const fusedNode = graphResult.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    expect(fusedNode, 'fused part must have a canonical PanelNode').toBeDefined();
    expect(fusedNode.shapeDxf, 'fused PanelNode must have shapeDxf').toBeTruthy();

    const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
    const ring = parseFirstClosedPolyline(fusedNode.shapeDxf as string);
    let dxfXMin = Infinity, dxfXMax = -Infinity, dxfYMin = Infinity, dxfYMax = -Infinity;
    for (const [x, y] of ring) {
      dxfXMin = Math.min(dxfXMin, x); dxfXMax = Math.max(dxfXMax, x);
      dxfYMin = Math.min(dxfYMin, y); dxfYMax = Math.max(dxfYMax, y);
    }
    const dxfWidth = dxfXMax - dxfXMin;
    const dxfHeight = dxfYMax - dxfYMin;
    const dxfArea = (() => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a) / 2;
    })();
    const bboxArea = dxfWidth * dxfHeight;
    const expectedArea = wallSpec.widthY * wallSpec.heightZ + flangeRaw.areaMm2;
    console.log(`[translate ${order}] fused flat pattern: ${dxfWidth.toFixed(2)}mm x ${dxfHeight.toFixed(2)}mm, area=${dxfArea.toFixed(1)} (expected ${expectedArea.toFixed(1)}), fill=${((dxfArea / bboxArea) * 100).toFixed(1)}%`);
    expect(Math.max(dxfWidth, dxfHeight), `[translate ${order}] [BUG] fused flat pattern long dimension should be 210mm`).toBeCloseTo(210, 0);
    expect(Math.min(dxfWidth, dxfHeight), `[translate ${order}] [BUG] fused flat pattern short dimension should be 200mm`).toBeCloseTo(200, 0);
    expect(dxfArea, `[translate ${order}] [BUG] fused flat pattern area should equal wall+notched-flange combined`).toBeCloseTo(expectedArea, 0);

    // ── 3D reconstruction check (bbox — coarse) ──────────────────────────────
    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[translate ${order}] fused 3D bbox: ${fmt(fusedBbox)}`);
    const expected: Bbox = { x_min: 0, x_max: 1, y_min: 0, y_max: 210, z_min: 0, z_max: 200 };
    const TOL_MM = 0.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(fusedBbox[k] - expected[k]);
      expect(delta,
        `[translate ${order}] [BUG] Bound ${k}: expected≈${expected[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    // ── 3D reconstruction check (volume + normal — precise) ──────────────────
    await assertPrecisePlacement({
      order, config, txId, fusedSolidId: fused.solid_id,
      wallSpec, flangeSpec: flangeFinalSpec, expectedWallNormal: [1, 0, 0],
    });
  }, 60_000);

  // Comprehensive matrix: EITHER panel (wall = dominant/reference panel, or
  // flange = the smaller one) translated along EACH world axis (x = thickness,
  // y/z = in-plane) before fusing, crossed with both argument orders. The
  // single X-axis/flange-only case above is not representative of the full
  // bug surface: refreshPanelFrame's U/V-swap fix (helpers.ts) only touches
  // panelFrame.u/v, never panelFrame.origin — an in-plane (Y or Z) translate
  // exercises origin tracking instead, a completely different path. And
  // translating the WALL (not just the flange) matters because fuse_bodies
  // always places the ENTIRE fused result using the DOMINANT (largest-area)
  // panel's frame as the reference (see assertPrecisePlacement) — if ITS
  // post-translate frame were wrong, the whole result would shift, not just
  // the flange's footprint. Both panels carry a notch at a DIFFERENT corner
  // (wall's is far from the seam, flange's is near it) so a flip/shift of
  // EITHER panel is independently detectable via volume containment.
  type Axis = 'x' | 'y' | 'z';
  type TranslatedPanel = 'wall' | 'flange';
  const SHIFT_MM = 37; // arbitrary, deliberately unrelated to any panel/notch dimension above

  const translateMatrix = (['wall', 'flange'] as TranslatedPanel[]).flatMap((panel) =>
    (['x', 'y', 'z'] as Axis[]).flatMap((axis) =>
      orders.map((order) => ({ panel, axis, order })),
    ),
  );

  it.each(translateMatrix)('translate $panel along $axis before fuse ($order)', async ({ panel, axis, order }) => {
    const config = loadConfig(configPath);
    const tag = `${panel}/${axis}/${order}`;
    const txn: any = await dispatchTool('begin_transaction', { label: `synthetic-matrix-${tag}` }, config);
    const txId: string = txn.transaction_id;

    const wallFinalSpec = { originY: 0, originZ: 0, widthY: 200, heightZ: 200, thicknessMm: 1, nCentreMm: 0.5, notch: { sizeY: 3, sizeZ: 30 } };
    const flangeFinalSpec = { originY: 200, originZ: 0, widthY: 10, heightZ: 200, thicknessMm: 1, nCentreMm: 0.6, notch: { sizeY: 2, sizeZ: 20 } };

    let wallRawSpec = wallFinalSpec;
    let flangeRawSpec = flangeFinalSpec;
    let vector: [number, number, number] = [0, 0, 0];
    const targetFinalSpec = panel === 'wall' ? wallFinalSpec : flangeFinalSpec;
    const rawSpec =
      axis === 'x' ? { ...targetFinalSpec, nCentreMm: targetFinalSpec.nCentreMm + SHIFT_MM }
      : axis === 'y' ? { ...targetFinalSpec, originY: targetFinalSpec.originY - SHIFT_MM }
      : { ...targetFinalSpec, originZ: targetFinalSpec.originZ - SHIFT_MM };
    vector = axis === 'x' ? [-SHIFT_MM, 0, 0] : axis === 'y' ? [0, SHIFT_MM, 0] : [0, 0, SHIFT_MM];
    if (panel === 'wall') wallRawSpec = rawSpec; else flangeRawSpec = rawSpec;

    const wallRaw = buildSyntheticPanel(wallRawSpec);
    const flangeRaw = buildSyntheticPanel(flangeRawSpec);

    const rawTargetPartId = panel === 'wall' ? wallRaw.partId : flangeRaw.partId;
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [rawTargetPartId], vector, keep_original: false,
    }, config);
    const movedPartId: string = translated.solid_id;

    const wallPartId = panel === 'wall' ? movedPartId : wallRaw.partId;
    const flangePartId = panel === 'flange' ? movedPartId : flangeRaw.partId;

    const wallBboxAfter: Bbox = await dispatchTool('bounding_box', { target: wallPartId }, config) as Bbox;
    const flangeBboxAfter: Bbox = await dispatchTool('bounding_box', { target: flangePartId }, config) as Bbox;
    console.log(`[matrix ${tag}] wall after translate:   ${fmt(wallBboxAfter)}`);
    console.log(`[matrix ${tag}] flange after translate: ${fmt(flangeBboxAfter)}`);
    expect(fmt(wallBboxAfter), `[matrix ${tag}] [BUG] wall bbox wrong after translate/no-op`).toBe('x[0.00..1.00] y[0.00..200.00] z[0.00..200.00]');
    expect(fmt(flangeBboxAfter), `[matrix ${tag}] [BUG] flange bbox wrong after translate/no-op`).toBe('x[0.10..1.10] y[200.00..210.00] z[0.00..200.00]');

    const toolOrder = order === 'wallFirst' ? [wallPartId, flangePartId] : [flangePartId, wallPartId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, `[matrix ${tag}] fuse_bodies must return a solid_id`).toBeDefined();

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    console.log(`[matrix ${tag}] fused 3D bbox: ${fmt(fusedBbox)}`);
    const expected: Bbox = { x_min: 0, x_max: 1, y_min: 0, y_max: 210, z_min: 0, z_max: 200 };
    const TOL_MM = 0.5;
    for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
      const delta = Math.abs(fusedBbox[k] - expected[k]);
      expect(delta,
        `[matrix ${tag}] [BUG] Bound ${k}: expected≈${expected[k].toFixed(2)} got=${fusedBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm`)
        .toBeLessThanOrEqual(TOL_MM);
    }

    await assertPrecisePlacement({
      order: tag, config, txId, fusedSolidId: fused.solid_id,
      wallSpec: wallFinalSpec, flangeSpec: flangeFinalSpec, expectedWallNormal: [1, 0, 0],
    });
  }, 60_000);

  // Same translate matrix again, but for the two orientations not covered
  // above (y-normal, z-normal) — the refreshPanelFrame fix compares extents
  // generically (expectedFlatWidth/Height vs the live query's
  // uExtentMm/vExtentMm), which SHOULD be orientation-agnostic, but every
  // case up to this point has the panel's normal fixed along world-X. This
  // verifies that's actually true rather than assumed.
  type LocalAxis = 'thickness' | 'width' | 'height';
  const orientations: Array<'y-normal' | 'z-normal'> = ['y-normal', 'z-normal'];
  const orientationMatrix = orientations.flatMap((orientation) =>
    (['wall', 'flange'] as TranslatedPanel[]).flatMap((panel) =>
      (['thickness', 'width', 'height'] as LocalAxis[]).flatMap((localAxis) =>
        orders.map((order) => ({ orientation, panel, localAxis, order })),
      ),
    ),
  );

  it.each(orientationMatrix)('$orientation: translate $panel along $localAxis before fuse ($order)', async ({ orientation, panel, localAxis, order }) => {
    const config = loadConfig(configPath);
    const tag = `${orientation}/${panel}/${localAxis}/${order}`;
    const txn: any = await dispatchTool('begin_transaction', { label: `synthetic-orient-${tag}` }, config);
    const txId: string = txn.transaction_id;

    const wallFinalSpec = { originY: 0, originZ: 0, widthY: 200, heightZ: 200, thicknessMm: 1, nCentreMm: 0.5, notch: { sizeY: 3, sizeZ: 30 }, orientation };
    const flangeFinalSpec = { originY: 200, originZ: 0, widthY: 10, heightZ: 200, thicknessMm: 1, nCentreMm: 0.6, notch: { sizeY: 2, sizeZ: 20 }, orientation };
    const expectedWallNormal: [number, number, number] =
      orientation === 'y-normal' ? [0, 1, 0] : [0, 0, 1];

    const targetFinalSpec = panel === 'wall' ? wallFinalSpec : flangeFinalSpec;
    const frame = orientedFrame(orientation, targetFinalSpec.originY, targetFinalSpec.originZ);
    const axisVec = localAxis === 'thickness' ? frame.normal : localAxis === 'width' ? frame.u : frame.v;
    // All three raw specs subtract SHIFT_MM (consistently), so the
    // correction vector is uniformly +SHIFT_MM*axisVec in every case.
    const rawSpec =
      localAxis === 'thickness' ? { ...targetFinalSpec, nCentreMm: targetFinalSpec.nCentreMm - SHIFT_MM }
      : localAxis === 'width' ? { ...targetFinalSpec, originY: targetFinalSpec.originY - SHIFT_MM }
      : { ...targetFinalSpec, originZ: targetFinalSpec.originZ - SHIFT_MM };
    const vector: [number, number, number] = [axisVec[0] * SHIFT_MM, axisVec[1] * SHIFT_MM, axisVec[2] * SHIFT_MM];

    let wallRawSpec = wallFinalSpec;
    let flangeRawSpec = flangeFinalSpec;
    if (panel === 'wall') wallRawSpec = rawSpec; else flangeRawSpec = rawSpec;

    const wallRaw = buildSyntheticPanel(wallRawSpec);
    const flangeRaw = buildSyntheticPanel(flangeRawSpec);

    const rawTargetPartId = panel === 'wall' ? wallRaw.partId : flangeRaw.partId;
    const translated: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [rawTargetPartId], vector, keep_original: false,
    }, config);
    const movedPartId: string = translated.solid_id;

    const wallPartId = panel === 'wall' ? movedPartId : wallRaw.partId;
    const flangePartId = panel === 'flange' ? movedPartId : flangeRaw.partId;

    const toolOrder = order === 'wallFirst' ? [wallPartId, flangePartId] : [flangePartId, wallPartId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, `[matrix ${tag}] fuse_bodies must return a solid_id`).toBeDefined();

    await assertPrecisePlacement({
      order: tag, config, txId, fusedSolidId: fused.solid_id,
      wallSpec: wallFinalSpec, flangeSpec: flangeFinalSpec, expectedWallNormal,
    });
  }, 60_000);
});
