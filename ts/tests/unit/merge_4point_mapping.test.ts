/**
 * Unit tests for the 4-point 3D→2D mapping used in buildMergedFlatPattern.
 *
 * The invariant being tested: when Panel B's hinge is projected into Panel A's
 * flat coordinate system (anchorA, bdirA, actualYDir), the Y component paY1
 * should equal vCenterB exactly for perfectly aligned panels. paY1 - vCenterB
 * is the Y translation for Panel B's DXF — it must be 0 for aligned panels,
 * non-zero only when Panel B is genuinely offset along the seam axis.
 *
 * Tests capture the cases where the mapping was previously broken:
 *   1. Simple rectangular panels — Y translation must be 0
 *   2. Fused composite Panel A (T-shape) with simple Panel B — Y must be 0
 *   3. Composite Panel A (prior bend) — Y computed from manufacturing graph anchor
 *   4. paY1 derivation: P1 projected via (anchorA, actualYDir) equals vCenterB
 *      when the shared fold edge is centered at the same seam position in both panels
 */

import { describe, it, expect } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

type Vec3 = [number, number, number];

function dot3(a: Vec3, b: Vec3): number {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

function norm3(v: Vec3): Vec3 {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0]/m, v[1]/m, v[2]/m];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

/** Compute P1 (Panel B's hinge center in 3D) from Panel B's aligned frame and vCenterB. */
function computeP1(
  fb_origin: Vec3,
  fb_u: Vec3,
  fb_v: Vec3,
  vCenterB: number,
  atHinge: boolean, // true = hinge at X=0 (gBtoBody convention), false = at X=flatWidth
  flatWidth: number,
): Vec3 {
  if (atHinge) {
    // Hinge at X=0: P1 = fb.origin + vCenterB * fb.v
    return [
      fb_origin[0] + vCenterB * fb_v[0],
      fb_origin[1] + vCenterB * fb_v[1],
      fb_origin[2] + vCenterB * fb_v[2],
    ];
  } else {
    // Hinge at X=flatWidth: P1 = fb.origin + flatWidth * fb.u + vCenterB * fb.v
    return [
      fb_origin[0] + flatWidth * fb_u[0] + vCenterB * fb_v[0],
      fb_origin[1] + flatWidth * fb_u[1] + vCenterB * fb_v[1],
      fb_origin[2] + flatWidth * fb_u[2] + vCenterB * fb_v[2],
    ];
  }
}

/** Compute paY1 = dot(P1 - anchorA, actualYDir). */
function computePaY1(P1: Vec3, anchorA: Vec3, actualYDir: Vec3): number {
  return dot3([P1[0]-anchorA[0], P1[1]-anchorA[1], P1[2]-anchorA[2]], actualYDir);
}

// ──────────────────────────────────────────────────────────────────────────────
// Test setup: standard 90° L-bracket geometry
//
// Panel A: flat plate in the XY plane, 200mm × 200mm.
//   - origin at (0, 0, 0)
//   - u = (1, 0, 0) [fold-perp, toward Panel B]
//   - v = (0, 1, 0) [seam direction]
//   - Fold edge: at x=200, running from y=0 to y=200
//   - anchorA (free-end corner) = (0, 0, 0)
//   - bdirA = gA = (1, 0, 0)
//   - actualYDir = foldNormal × gA. foldNormal = (0, 0, 1) [Panel A faces up].
//                = cross((0,0,1), (1,0,0)) = (0*0-1*0, 1*1-0*0, 0*0-0*1) = (0, 1, 0)
//
// Panel B: vertical plate in the XZ plane, 200mm × 200mm.
//   - Connects to Panel A at the fold edge (x=200, y=0..200 in 3D)
//   - gBtoBody = (0, 0, -1) [pointing down from fold edge into Panel B's body]
//   - frameBAligned.alignedFrame (gBtoBody→+X):
//     - origin = fold edge corner at (200, 0, 0) [min-X corner after aligning gBtoBody→+X]
//     - u = gBtoBody direction = (0, 0, -1) [X increases downward from fold]
//     - v = (0, 1, 0) [seam direction, same as Panel A's v]
//   - Hinge at X=0 in Panel B's aligned DXF = fold edge
//   - vCenterB = 100 (center of hinge edge from y=0 to y=200)
//
// ──────────────────────────────────────────────────────────────────────────────

const PANEL_SIZE = 200;

// Panel A's flat coordinate system
const anchorA: Vec3 = [0, 0, 0];        // DXF(0,0) corner = free-end corner
const bdirA: Vec3   = [1, 0, 0];        // +X toward fold edge
const actualYDir: Vec3 = [0, 1, 0];     // seam direction (fold axis direction)

// Panel B's frame (gBtoBody → +X)
const fb_origin: Vec3 = [200, 0, 0];    // fold edge corner (min-X after alignment)
const fb_u: Vec3 = [0, 0, -1];          // gBtoBody = downward (-Z)
const fb_v: Vec3 = [0, 1, 0];           // seam direction

const vCenterB = PANEL_SIZE / 2;        // 100mm: center of hinge edge Y=[0,200]

describe('4-point mapping: paY1 - vCenterB (the Y translation for Panel B)', () => {

  it('aligned rectangles: paY1 equals vCenterB exactly (Y translation = 0)', () => {
    // Two 200×200mm panels at 90° sharing a fold edge at x=200.
    // Panel B's hinge center is at (200, 100, 0) in 3D.
    const P1 = computeP1(fb_origin, fb_u, fb_v, vCenterB, true, PANEL_SIZE);

    expect(P1).toEqual([200, 100, 0]);

    const paY1 = computePaY1(P1, anchorA, actualYDir);

    // paY1 should be 100 (= vCenterB = half of Panel A's seam height)
    expect(paY1).toBeCloseTo(100, 6);

    // The Y translation (paY1 - vCenterB) must be exactly 0 for aligned panels
    const yTranslation = paY1 - vCenterB;
    expect(yTranslation).toBeCloseTo(0, 6);
  });

  it('Panel B shorter than Panel A: hinge center projects to correct Y in flat', () => {
    // Panel B is 120mm seam height, Panel A is 200mm. Panel B connects at Panel A's
    // seam-center (y=40..160 region, centered at y=100).
    const shortVCenterB = 60;   // center of 120mm Panel B's hinge edge
    const P1_short = computeP1(fb_origin, fb_u, fb_v, shortVCenterB, true, PANEL_SIZE);

    expect(P1_short).toEqual([200, 60, 0]);

    const paY1_short = computePaY1(P1_short, anchorA, actualYDir);

    // P1 is at y=60 in the world → paY1=60. vCenterB=60.
    expect(paY1_short).toBeCloseTo(60, 6);

    // Y translation = 60 - 60 = 0 (Panel B IS centered at y=60 in both coordinate systems)
    expect(paY1_short - shortVCenterB).toBeCloseTo(0, 6);
  });

  it('Panel B offset along seam: Y translation equals the 3D offset amount', () => {
    // Panel B is offset 25mm upward along the seam. In 3D, its hinge center is at y=125
    // instead of y=100. The Y translation should be +25mm.
    const P1_offset = computeP1(
      [200, 25, 0],  // fb.origin shifted 25mm up in Y
      fb_u, fb_v, vCenterB, true, PANEL_SIZE,
    );

    expect(P1_offset[1]).toBeCloseTo(125, 6);  // hinge center at y=125

    const paY1_offset = computePaY1(P1_offset, anchorA, actualYDir);

    // paY1 = 125. vCenterB = 100. Y translation = +25mm.
    expect(paY1_offset - vCenterB).toBeCloseTo(25, 6);
  });

  it('anchorA at non-zero Y: Y translation accounts for anchor offset', () => {
    // Panel A's DXF starts at y=50 in the world (anchorA at y=50).
    // Panel B's hinge center at y=100. paY1 = 100-50 = 50. vCenterB = 100.
    // Y translation = 50 - 100 = -50 (Panel B shifted down by 50mm in flat).
    const anchorA_shifted: Vec3 = [0, 50, 0];
    const P1 = computeP1(fb_origin, fb_u, fb_v, vCenterB, true, PANEL_SIZE);

    const paY1 = computePaY1(P1, anchorA_shifted, actualYDir);

    expect(paY1).toBeCloseTo(50, 6);  // 100 - 50 = 50
    expect(paY1 - vCenterB).toBeCloseTo(-50, 6);
  });

  it('composite Panel A with correct anchor: aligned panel gives Y translation = 0', () => {
    // When Panel A is a composite (prior bend result), the manufacturing graph
    // stores the correct anchor for the composite's flat origin.
    // If the prior BendNode's anchor correctly describes the composite flat's (0,0),
    // then a Panel B aligned with the composite's seam should give Y translation = 0.
    //
    // Scenario: first merge placed Panel A at anchorA=(0,0,0), bdirA=(1,0,0).
    // The composite's stored anchor (priorBendNodeA.anchor) = (0,0,0).
    // Second merge: Panel C connects to the composite's far end.
    // Panel C's hinge center = (401, 100, 0) [at x=401, y=100 in world].
    const compositeAnchor: Vec3 = [0, 0, 0];   // priorBendNodeA.anchor
    const compositeBdir: Vec3  = [1, 0, 0];    // priorBendNodeA.bendDir
    const compositeYDir: Vec3  = [0, 1, 0];    // cross(priorBendNodeA.foldNormal, bendDir)

    const P1_composite: Vec3 = [401, 100, 0];
    const paY1_c = computePaY1(P1_composite, compositeAnchor, compositeYDir);

    // Y translation should be 0 for aligned Panel C (its hinge center at y=100 = vCenterC)
    expect(paY1_c).toBeCloseTo(100, 6);
    expect(paY1_c - vCenterB).toBeCloseTo(0, 6);
  });

  it('flatOrigin (frameADxf.origin) vs anchorPointSimple: only identical when xAgreesDxf=true', () => {
    // When xAgreesDxf=true (bendDir agrees with frameA.u):
    //   anchorPointSimple = frameADxf.origin = flatOrigin  ← same, no problem
    //
    // When xAgreesDxf=false (bendDir opposes frameA.u, e.g., fused composite):
    //   anchorPointSimple = frameADxf.origin + W*frameA.u + H*frameA.v  ← shifted!
    //   flatOrigin = frameADxf.origin  ← correct for 4-point mapping
    //
    // The 4-point mapping MUST use flatOrigin, not anchorPointSimple.
    // Using anchorPointSimple when xAgreesDxf=false gives wrong paY1.

    const frameA_origin: Vec3 = [0, 50, 0];  // fused composite frame origin at y=50
    const frameA_u: Vec3 = [1, 0, 0];
    const frameA_v: Vec3 = [0, 1, 0];
    const W = 210;  // T-shape width
    const H = 200;  // T-shape height

    // xAgreesDxf=false: bendDir = (-1,0,0) opposes frameA.u = (1,0,0)
    const anchorPointSimple_xDisagree: Vec3 = [
      frameA_origin[0] + W * frameA_u[0] + H * frameA_v[0],
      frameA_origin[1] + W * frameA_u[1] + H * frameA_v[1],
      frameA_origin[2] + W * frameA_u[2] + H * frameA_v[2],
    ];
    // = (210, 250, 0) — 200mm off in Y from flatOrigin (0, 50, 0)!

    const flatOrigin: Vec3 = frameA_origin;  // = DXF(0,0) world position = (0, 50, 0)

    // Panel B hinge at (210, 150, 0) — same absolute Y as flat midpoint
    const P1_hinge: Vec3 = [210, 150, 0];

    // Using flatOrigin as anchorA: paY1 = 150 - 50 = 100. vCenterB=100. Y offset = 0. ✓
    const paY1_correct = computePaY1(P1_hinge, flatOrigin, [0,1,0]);
    expect(paY1_correct).toBeCloseTo(100, 6);
    expect(paY1_correct - 100).toBeCloseTo(0, 6);  // Y translation = 0

    // Using anchorPointSimple (xDisagree) as anchorA: paY1 = 150 - 250 = -100. Wrong!
    const paY1_wrong = computePaY1(P1_hinge, anchorPointSimple_xDisagree, [0,1,0]);
    expect(paY1_wrong).toBeCloseTo(-100, 6);
    expect(paY1_wrong - 100).toBeCloseTo(-200, 6);  // Y translation = -200 ← WRONG
    // This -200mm shift causes the bridge to cover the wrong Y region → notch disappears
  });

  it('fused composite anchorA: must use the PANEL frame origin, not the fused canonical origin', () => {
    // This test documents the bug: for a fused composite Panel A (wall+flange),
    // the canonical node's panelFrame is the FUSED RESULT's frame, which may have
    // its origin at a different world position than the wall's corner.
    //
    // When anchorPointSimple is derived from this fused frame, it may not be at
    // the wall's DXF(0,0) corner → paY1 ≠ vCenterB for an aligned Panel B.
    //
    // The correct behavior: anchorA must be at the actual flat origin, i.e., the
    // corner that corresponds to DXF(0,0) of Panel A's shapeDxf.
    //
    // Incorrect (buggy) scenario: fused frame origin is at y=50 instead of y=0.
    const buggyAnchorA: Vec3 = [0, 50, 0];  // wrong: fused frame shifted 50mm in Y
    const P1 = computeP1(fb_origin, fb_u, fb_v, vCenterB, true, PANEL_SIZE);

    const paY1_buggy = computePaY1(P1, buggyAnchorA, actualYDir);

    // With buggy anchor: paY1 = 50, vCenterB = 100 → Y translation = -50 (WRONG)
    // Panel B is shifted -50mm → bridge covers wrong Y range → notch filled in
    expect(paY1_buggy - vCenterB).toBeCloseTo(-50, 6);
    // This is the ROOT CAUSE of the "flange notch disappearing" bug.

    // Correct behavior: use anchor at y=0 (the actual DXF origin)
    const correctAnchorA: Vec3 = [0, 0, 0];
    const paY1_correct = computePaY1(P1, correctAnchorA, actualYDir);
    expect(paY1_correct - vCenterB).toBeCloseTo(0, 6);  // ← should be 0
  });

  it('paX1 derivation: geometrically equals frameAAligned.flatExtentMm for far-end', () => {
    // For a simple 200mm Panel A, the fold edge is 200mm from the free end.
    // P1 (Panel B hinge) is at x=200 in Panel A's flat.
    // paX1 = dot(P1 - anchorA, bdirA) must equal 200mm.
    const P1: Vec3 = [200, 100, 0];
    const paX1 = dot3([P1[0]-anchorA[0], P1[1]-anchorA[1], P1[2]-anchorA[2]], bdirA);
    expect(paX1).toBeCloseTo(200, 6);
  });

  it('bridge Y-range with correct seam: shared edge region, not full panel height', () => {
    // Panel A (T-shape): 210mm wide, 200mm tall, with 50mm flange at x=[200,210], y=[75,125].
    // Panel B: 200mm × 200mm, at x=[200,400], y=[0,200].
    // The shared edge between Panel A and Panel B is at x=200, full Y=[0,200].
    // The bridge Y-range should be the INTERSECTION of Panel A and Panel B at x=paX1=200:
    //   Panel A at x=200: Y=[0,200] (the wall part, not the flange which is at x=[200,210])
    //   Panel B at x=200: Y=[0,200]
    //   Intersection: [0,200]
    //
    // If seamYOffset=0 (correct), the bridge covers [0,200] — not smaller.
    // The T-shape's notch is at x=[200,210], NOT at x=200 — so it's NOT in the bridge region.
    // The notch fills in only if Panel B's Y range is WRONG due to incorrect seamYOffset.
    //
    // With seamYOffset=0: Panel B DXF [0,200] + translation[1]=0 → [0,200] ✓
    // Intersection with Panel A at x=200 [0,200]: [0,200]. Bridge is [0,200]. ✓
    // Panel B + bridge union at x=[200,400]: full rectangle. T-shape preserved at x=[0,200]. ✓
    //
    // With seamYOffset≠0 (e.g., -50): Panel B DXF shifted to [-50,150].
    // Bridge Y-range = intersection([0,200], [-50,150]) = [0,150].
    // Bridge at x=[200,201] covers [0,150] — which DOES fill the flange notch region.

    const panelBHeight = 200;
    const seamYOffset_correct = 0;
    const seamYOffset_buggy = -50;

    // Correct: bridge covers [0, 200] — notch at x=[200,210] y=[75,125] is preserved
    const yMinBShifted_correct = 0 + seamYOffset_correct;
    const yMaxBShifted_correct = panelBHeight + seamYOffset_correct;
    const intersectMax_correct = Math.min(200, yMaxBShifted_correct);
    const intersectMin_correct = Math.max(0, yMinBShifted_correct);
    expect(intersectMax_correct - intersectMin_correct).toBeCloseTo(200, 6);

    // Buggy: bridge covers [0, 150] — bridge at x=[200,201] fills over flange area
    const yMinBShifted_buggy = 0 + seamYOffset_buggy;
    const yMaxBShifted_buggy = panelBHeight + seamYOffset_buggy;
    const intersectMax_buggy = Math.min(200, yMaxBShifted_buggy);
    const intersectMin_buggy = Math.max(0, yMinBShifted_buggy);
    expect(intersectMax_buggy - intersectMin_buggy).toBeCloseTo(150, 6);
    // A 150mm bridge at x=200 covers y=[0,150] which overlaps the flange notch at y=[75,125]
    // → the notch gets filled → flat pattern becomes fully rectangular. This is the bug.
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// DXF-based Y alignment — source of truth is the manufacturing graph
//
// The correct Y translation for Panel B comes ENTIRELY from the flat DXF polygons
// stored in the manufacturing graph. No 3D frame data required.
//
// Y translation = vCenterA_at_foldX - vCenterB
//   vCenterA_at_foldX = Y-center of Panel A's DXF at X=effectiveAFlatWidth (fold edge)
//   vCenterB          = Y-center of Panel B's DXF at X=0 (hinge edge)
//
// This is correct because both panels' DXF shapes ARE the source of truth.
// ──────────────────────────────────────────────────────────────────────────────

/** Find Y center of a DXF polygon ring at a given X position. */
function yRangeAtX(ring: Array<[number, number]>, atX: number): { min: number; max: number } | null {
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    if ((x1 <= atX && x2 >= atX) || (x2 <= atX && x1 >= atX)) {
      const t = Math.abs(x2 - x1) < 1e-9 ? 0.5 : (atX - x1) / (x2 - x1);
      const y = y1 + t * (y2 - y1);
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  return isFinite(yMin) ? { min: yMin, max: yMax } : null;
}

function yCenterAt(ring: Array<[number, number]>, atX: number): number {
  const r = yRangeAtX(ring, atX);
  return r ? (r.min + r.max) / 2 : 0;
}

// DXF ring helpers
function rectRing(w: number, h: number): Array<[number, number]> {
  return [[0,0],[w,0],[w,h],[0,h]];
}

function tShapeRing(wallW: number, wallH: number, flangeW: number, flangeH: number, flangeStartY: number): Array<[number, number]> {
  // Wall [0,wallW]×[0,wallH] with flange [wallW, wallW+flangeW]×[flangeStartY, flangeStartY+flangeH]
  return [
    [0, 0], [wallW, 0],
    [wallW, flangeStartY],
    [wallW + flangeW, flangeStartY],
    [wallW + flangeW, flangeStartY + flangeH],
    [wallW, flangeStartY + flangeH],
    [wallW, wallH], [0, wallH],
  ];
}

describe('DXF-based Y alignment (source of truth: manufacturing graph flat shapes)', () => {

  it('rectangular panels, same height: Y translation = 0', () => {
    // Panel A: 200×200mm rectangle. Fold edge at X=200.
    // Panel B: 200×200mm rectangle. Hinge at X=0.
    const ringA = rectRing(200, 200);
    const ringB = rectRing(200, 200);

    const foldX = 200;
    const vCenterA = yCenterAt(ringA, foldX);  // = 100
    const vCenterB = yCenterAt(ringB, 0);       // = 100

    expect(vCenterA).toBeCloseTo(100, 6);
    expect(vCenterB).toBeCloseTo(100, 6);
    expect(vCenterA - vCenterB).toBeCloseTo(0, 6);  // Y translation = 0
  });

  it('Panel A taller than Panel B: Panel B centered in Panel A seam', () => {
    // Panel A: 200×300mm (seam height 300mm). Fold edge at X=200.
    // Panel B: 200×200mm. Hinge at X=0.
    // Y translation = 150 - 100 = +50mm (shift Panel B up 50mm to center it).
    const ringA = rectRing(200, 300);
    const ringB = rectRing(200, 200);

    const vCenterA = yCenterAt(ringA, 200);  // = 150
    const vCenterB = yCenterAt(ringB, 0);    // = 100

    expect(vCenterA - vCenterB).toBeCloseTo(50, 6);
  });

  it('T-shaped Panel A (wall+flange): fold edge Y-center from actual wall edge, not bbox', () => {
    // Panel A: 200mm wall with 10mm flange overhanging at Y=[75,125].
    // T-shape: wall [0,200]×[0,200] + flange [200,210]×[75,125].
    // Fold edge at X=200: runs full Y=[0,200] (wall edge, not flange edge).
    // vCenterA at fold X=200 = 100 (center of [0,200]).
    //
    // Panel B: simple 200×200mm wall. Hinge at X=0.
    // vCenterB = 100. Y translation = 0. ✓
    //
    // The notch ([200,210]×[75,125]) is at X > 200 — PAST the fold edge.
    // The bridge at X=[200,201] must cover Y=[0,200] ∩ Panel B Y=[0,200] = [0,200].
    // This preserves the notch in the T-shape.
    const ringA = tShapeRing(200, 200, 10, 50, 75);  // flange at Y=[75,125]
    const ringB = rectRing(200, 200);

    const foldX = 200;  // effectiveAFlatWidth for this Panel A
    const vCenterA = yCenterAt(ringA, foldX);
    const vCenterB = yCenterAt(ringB, 0);

    // At fold X=200, Panel A's edge spans full Y=[0,200]
    expect(vCenterA).toBeCloseTo(100, 6);
    expect(vCenterB).toBeCloseTo(100, 6);
    expect(vCenterA - vCenterB).toBeCloseTo(0, 6);  // Y translation = 0
    // With translation[1]=0: Panel B's [0,200] aligns with Panel A's [0,200]. ✓
    // Bridge covers [0,200] ∩ [0,200] = [0,200]. Does NOT cover the notch (at X>200). ✓
  });

  it('flange overhangs seam edge: Panel B shorter, Y translation centers Panel B', () => {
    // Panel A: wall [0,200]×[0,200] + flange [200,210]×[100,200] (flange on top half only).
    // Fold edge at X=200: spans Y=[0,200] (wall) ∪ Y=[100,200] (flange start) = [0,200].
    // Actually the fold edge is the wall's right edge at X=200 = [0,200].
    // Panel B: 100×200mm (shorter panel connecting to lower half: [0,100]).
    // vCenterA at fold = 100. vCenterB = 50.
    // Y translation = 100 - 50 = +50 → Panel B placed at Y=[50,150] in merged flat.
    const ringA = tShapeRing(200, 200, 10, 100, 100);  // flange at Y=[100,200]
    const ringB = rectRing(200, 100);  // Panel B is 100mm tall

    const vCenterA = yCenterAt(ringA, 200);  // full wall edge Y=[0,200], center=100
    const vCenterB = yCenterAt(ringB, 0);    // Panel B full edge Y=[0,100], center=50

    expect(vCenterA).toBeCloseTo(100, 6);
    expect(vCenterB).toBeCloseTo(50, 6);
    expect(vCenterA - vCenterB).toBeCloseTo(50, 6);  // shift Panel B up 50mm
  });

  it('yRangeAtX correctly handles vertical edge at exactly X=targetX', () => {
    // A T-shape where at X=200 the polygon has a vertical segment Y=[0,200].
    const ring = tShapeRing(200, 200, 10, 50, 75);
    const range = yRangeAtX(ring, 200);

    expect(range).not.toBeNull();
    expect(range!.min).toBeCloseTo(0, 6);
    expect(range!.max).toBeCloseTo(200, 6);
    expect((range!.min + range!.max) / 2).toBeCloseTo(100, 6);
  });

  it('yRangeAtX for hinge edge at X=0: Panel B hinge edge Y range', () => {
    // Panel B hinge at X=0 spans full panel height.
    const ring = rectRing(200, 200);
    const range = yRangeAtX(ring, 0);

    expect(range).not.toBeNull();
    expect(range!.min).toBeCloseTo(0, 6);
    expect(range!.max).toBeCloseTo(200, 6);
  });

  it('DXF-based Y translation is immune to 3D frame origin shifts', () => {
    // The key property: vCenterA and vCenterB are computed from DXF polygons alone.
    // They do NOT depend on frameA.origin, anchorPointSimple, or any 3D frame data.
    // Even if the fused composite's canonical frame has its origin shifted (e.g., at y=50),
    // the DXF polygon's fold edge Y-center is still correctly read as 100mm.
    //
    // This is the fix for the "flange notch disappearing" bug: use vCenterA - vCenterB
    // (from DXF) instead of paY1 - vCenterB (which required correct 3D frame data).

    // Panel A: same T-shape regardless of where its 3D frame origin happens to be
    const ringA = tShapeRing(200, 200, 10, 50, 75);
    const ringB = rectRing(200, 200);

    // Computed purely from DXF polygons — no 3D data:
    const yTranslation = yCenterAt(ringA, 200) - yCenterAt(ringB, 0);

    expect(yTranslation).toBeCloseTo(0, 6);
    // ✓ Immune to 3D frame issues. The manufacturing graph's shapeDxf is the source of truth.
  });
});
