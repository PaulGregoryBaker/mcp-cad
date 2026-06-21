import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
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

// ────────────────────────────────────────────────────────────────────────────
// fuse_bodies on two genuinely COPLANAR panels (cube_with_flanges.stp's wall +
// its own attached flange — same face, same normal, no bend at all). This is
// the operation directly under test here, NOT merge_bodies_with_bend.
//
// Existing tests in merge_asymmetric_flat.integration.test.ts only check the
// fused panel's 2D flat-pattern width/height (from apply_unfold's DXF) before
// going on to merge_bodies_with_bend. That DXF has NO thickness/Z information
// at all, so a bug that grows (or shrinks) the fused 3D solid along its OWN
// THICKNESS axis (instead of extending the in-plane footprint) is entirely
// invisible to those assertions — exactly the class of bug being reported
// here. This test checks the fused 3D bbox directly, with an explicit,
// separate assertion on the thickness axis, in three different orientations
// (the whole fixture is rotated before splitting, so the wall/flange pair's
// normal lands on world X, Y, and Z respectively).
// ────────────────────────────────────────────────────────────────────────────
describe('[fuse-only] fuse_bodies: coplanar wall+flange stays in-plane (thickness axis must not grow)', () => {
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

  it.each(cases)('$label ($order): fused wall+flange thickness axis stays fixed, footprint grows in-plane', async ({ label, rotate, expectedAxis, order }) => {
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
    // via the Dominant Face Method) rather than defaulting to 1.0mm.
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
    const { wallId, wallBbox, flangeId, flangeBbox, thicknessAxis } = matchingPair!;
    console.log(`[${label}] thicknessAxis=${thicknessAxis}`);
    console.log(`[${label}] wall:   ${fmt(wallBbox)}`);
    console.log(`[${label}] flange: ${fmt(flangeBbox)}`);

    // The wall's bbox span along the thickness axis is NOT a reliable
    // "expected thickness" here: split_body_by_bends's thin-solid-mode
    // extraction leaves the wall panel with a small overlap sliver where the
    // flange was attached, stretching its bbox a bit past its true material
    // thickness. measurePanelThickness (Dominant Face Method) reports the
    // panel's real, uniform material thickness instead.
    const wallMeasured = getGeometryBinding().measurePanelThickness(wallId);
    expect(wallMeasured.ok, `[${label}] could not measure wall's own thickness`).toBe(true);
    const wallThickness = wallMeasured.thickness_mm;

    // Duplicate the wall and flange (translate by zero, keep_original) BEFORE
    // fusing — fuse_bodies consumes its inputs, so these copies are the only
    // way to still have "the original panel, in its original position" to
    // compare against once the fuse is done.
    const wallDup: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [wallId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const flangeDup: any = await dispatchTool('translate_body', {
      transaction_id: txId, targets: [flangeId], vector: [0, 0, 0], keep_original: true,
    }, config);
    const wallRefId: string = wallDup.solid_id;
    const flangeRefId: string = flangeDup.solid_id;

    const toolOrder = order === 'wallFirst' ? [wallId, flangeId] : [flangeId, wallId];
    const fused: any = await dispatchTool('fuse_bodies', {
      transaction_id: txId,
      tools: toolOrder,
    }, config);
    expect(fused.solid_id, `[${label}] fuse_bodies must return a solid_id`).toBeDefined();

    // GEOMETRY-LOCATION ASSERTION: the fused solid must precisely CONTAIN the
    // original wall and flange in their ORIGINAL positions — not just have a
    // bbox that happens to match. Intersecting the fused result with each
    // untouched reference copy and comparing volume against the reference's
    // OWN volume directly verifies "the final 3D geometry matches the
    // original panel locations": if either panel shifted, rotated, or was
    // reconstructed in the wrong place, the overlap (and so its volume) will
    // be measurably less than the reference panel's full volume.
    const wallRefVol: any = await dispatchTool('mass_properties', { target: wallRefId, properties: ['volume'] }, config);
    const flangeRefVol: any = await dispatchTool('mass_properties', { target: flangeRefId, properties: ['volume'] }, config);
    console.log(`[${label} ${order}] wallRefVol=${wallRefVol.volume} flangeRefVol=${flangeRefVol.volume}`);

    // intersect_bodies CONSUMES (erases) both of its inputs, same as
    // fuse_bodies — so the fused result itself needs a fresh duplicate
    // before each separate intersection check below, or the first check
    // would delete fused.solid_id out from under the second.
    let wallOverlapVol = 0;
    try {
      const fusedDup1: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [fused.solid_id], vector: [0, 0, 0], keep_original: true,
      }, config);
      const wallIntersect: any = await dispatchTool('intersect_bodies', {
        target_a: fusedDup1.solid_id, target_b: wallRefId, transaction_id: txId,
      }, config);
      const wallIntersectVol: any = await dispatchTool('mass_properties', { target: wallIntersect.solid_id, properties: ['volume'] }, config);
      wallOverlapVol = wallIntersectVol.volume;
    } catch (err) {
      console.log(`[${label} ${order}] wall intersect threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    console.log(`[${label} ${order}] wallOverlapVol=${wallOverlapVol}`);
    expect.soft(wallOverlapVol,
      `[${label} ${order}] [BUG] fused result does not contain the original WALL in its original position ` +
      `(overlap=${wallOverlapVol.toFixed(1)}mm³ vs wall volume=${wallRefVol.volume.toFixed(1)}mm³)`)
      .toBeCloseTo(wallRefVol.volume, -1);

    let flangeOverlapVol = 0;
    try {
      const fusedDup2: any = await dispatchTool('translate_body', {
        transaction_id: txId, targets: [fused.solid_id], vector: [0, 0, 0], keep_original: true,
      }, config);
      const flangeIntersect: any = await dispatchTool('intersect_bodies', {
        target_a: fusedDup2.solid_id, target_b: flangeRefId, transaction_id: txId,
      }, config);
      const flangeIntersectVol: any = await dispatchTool('mass_properties', { target: flangeIntersect.solid_id, properties: ['volume'] }, config);
      flangeOverlapVol = flangeIntersectVol.volume;
    } catch (err) {
      console.log(`[${label} ${order}] flange intersect threw: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    }
    console.log(`[${label} ${order}] flangeOverlapVol=${flangeOverlapVol}`);
    expect.soft(flangeOverlapVol,
      `[${label} ${order}] [BUG] fused result does not contain the original FLANGE in its original position ` +
      `(overlap=${flangeOverlapVol.toFixed(1)}mm³ vs flange volume=${flangeRefVol.volume.toFixed(1)}mm³)`)
      .toBeCloseTo(flangeRefVol.volume, -1);

    const fusedBbox: Bbox = await dispatchTool('bounding_box', { target: fused.solid_id }, config) as Bbox;
    const expectedUnion = unionBbox(wallBbox, flangeBbox);
    console.log(`[${label}] fused:    ${fmt(fusedBbox)}`);
    console.log(`[${label}] expected: ${fmt(expectedUnion)}`);

    // PRIMARY ASSERTION (the gap this test exists to close): the fused solid's
    // extent along the wall's OWN thickness axis must be UNCHANGED — fusing two
    // coplanar panels must never grow (or shrink) the thickness direction. Any
    // change here means the fuse reconstruction is (at least partly) extending
    // perpendicular to the panel instead of in-plane.
    const fusedThickness = ext(fusedBbox, thicknessAxis);
    expect(fusedThickness,
      `[${label}] [BUG] thickness axis (${thicknessAxis}) changed from ${wallThickness.toFixed(2)}mm to ` +
      `${fusedThickness.toFixed(2)}mm — fuse extended perpendicular to the panel instead of in-plane`)
      .toBeCloseTo(wallThickness, 0); // ±0.5mm

    // SECONDARY: precise match against the union of the two pre-fuse bboxes on
    // every IN-PLANE bound — catches in-plane placement errors (translation/
    // rotation) the primary assertion wouldn't. The thickness-axis bounds are
    // excluded here: expectedUnion is built from the raw, sliver-contaminated
    // bboxes (see wallThickness above), while the fused result correctly
    // reconstructs at the wall's true material thickness — already verified,
    // precisely, by the primary assertion above.
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
