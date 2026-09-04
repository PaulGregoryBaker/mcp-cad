/**
 * v2 port of v1's chained_merge_protrusion_fuse_rotation.integration.test.ts
 * (Phase 5 test migration, 2026-07-26). v1's own diagnostic reproduced a
 * REAL production symptom: fusing a flange onto a wall that had ALREADY been
 * bend-merged into a bracket (a chained/composite part_a, not a fresh
 * split-time panel) placed the flange's footprint along the WRONG axis — a
 * 90°-rotated placement, not just an offset. No existing v2 fuse_bodies test
 * exercises part_a being the OUTPUT of a prior merge_bodies_with_bend (only
 * part_b's simplicity is checked — see fuse_bodies.integration.test.ts's own
 * "rejects a part B that has its own bend" case); this is that code path.
 *
 * Hand-authored synthetic parts, following both fuse_bodies.integration
 * .test.ts's and merge_bodies_with_bend.integration.test.ts's own precedent
 * (no committed STEP fixture happens to contain a wall+flange pair that's
 * genuinely coplanar with touching footprints — see fuse_bodies.integration
 * .test.ts's header comment).
 *
 * wallA/wallB dimensions and merge params (10x5 A, 5x8 B, angle 90, radius
 * 2.0, k 0.4) are copied verbatim from merge_bodies_with_bend.integration
 * .test.ts's own authorTwoParts/mergeTwoParts — a separately-verified-good
 * bend merge, so this test's only new variable is the fuse step.
 *
 * Real oracle for "no 90° rotation": construct the bracket BEFORE fusing
 * (still just wallA+wallB, no flange) and the flange on its own, take the
 * union of their two independent 3D bboxes, then require the POST-fuse
 * bracket's 3D bbox to match that union — the same union-of-independent-
 * reconstructions pattern validated this session in
 * unequal_leg_bracket_merge_orientation.integration.test.ts.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';
import type { BoundingBoxResult } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

function unionBbox(a: BoundingBoxResult, b: BoundingBoxResult): BoundingBoxResult {
  return {
    x_min: Math.min(a.x_min, b.x_min),
    y_min: Math.min(a.y_min, b.y_min),
    z_min: Math.min(a.z_min, b.z_min),
    x_max: Math.max(a.x_max, b.x_max),
    y_max: Math.max(a.y_max, b.y_max),
    z_max: Math.max(a.z_max, b.z_max),
  };
}

/** A: 10x5 rectangle. B: 5-wide x 8-tall rectangle, anchored so its own local
 * edge0 (0,0)-(5,0) folds 90deg onto A's right edge (10,0)-(10,5) — same
 * hand-verified anchor as merge_bodies_with_bend.integration.test.ts's own
 * authorTwoParts (see that file's header comment for the derivation).
 * docs/TASK_SPEC.md: no edge_a/edge_b/angle_deg. */
function authorBracket(store: GraphStore): { partAId: string; rootPanelAId: string } {
  const thicknessMm = 1.0;
  const partA = dispatchGraphTool(store, 'create_part', {
    name: 'bracket-wallA',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ],
    thickness_mm: thicknessMm,
  }) as CreatePartResult;

  const partB = dispatchGraphTool(store, 'create_part', {
    name: 'bracket-wallB',
    outline: [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 8 },
      { x: 0, y: 8 },
    ],
    thickness_mm: thicknessMm,
    anchor: {
      r: [0, 0, -1, -1, 0, 0, 0, 1, 0],
      t: [10, 5, 0],
    },
  }) as CreatePartResult;

  dispatchGraphTool(store, 'merge_bodies_with_bend', {
    part_a_id: partA.part_id,
    part_b_id: partB.part_id,
    radius_mm: 2.0,
    k_factor: 0.4,
  });

  return { partAId: partA.part_id, rootPanelAId: partA.root_region_panel_id };
}

/** Coplanar with wallA (identity anchor, same world XY plane) and touching
 * wallA's TOP edge (y=5, x in [0,10]) along a partial segment (x in [2,8]) —
 * nowhere near the bend zone consumed on wallA's RIGHT edge (x=10). */
function authorFlange(store: GraphStore): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name: 'flange',
    outline: [
      { x: 2, y: 5 },
      { x: 8, y: 5 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ],
    thickness_mm: 1.0,
  }) as CreatePartResult;
}

d('[v2] fuse_bodies onto an already bend-merged (chained/composite) part_a', () => {
  it('flange fuses cleanly onto the bracket, landing on the correct axis (no 90° rotation)', () => {
    const store = new GraphStore();
    const { partAId } = authorBracket(store);

    const preFuseBracket = constructPart(store, partAId);
    expect(preFuseBracket.ok, preFuseBracket.message).toBe(true);
    const bracketBboxPre = geometryBinding.computeBoundingBox(preFuseBracket.shellId);

    const flange = authorFlange(store);
    const flangeSolo = constructPart(store, flange.part_id);
    expect(flangeSolo.ok, flangeSolo.message).toBe(true);
    const flangeBbox = geometryBinding.computeBoundingBox(flangeSolo.shellId);

    const expectedUnion = unionBbox(bracketBboxPre, flangeBbox);

    const fused = dispatchGraphTool(store, 'fuse_bodies', {
      part_a_id: partAId,
      part_b_id: flange.part_id,
    }) as { part_id: string };
    expect(fused.part_id).toBe(partAId);

    const postFuse = constructPart(store, partAId);
    expect(postFuse.ok, postFuse.message).toBe(true);
    const manifold = geometryBinding.checkManifold(postFuse.shellId);
    expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);

    const fusedBbox = geometryBinding.computeBoundingBox(postFuse.shellId);
    const bounds: Array<keyof BoundingBoxResult> = [
      'x_min',
      'y_min',
      'z_min',
      'x_max',
      'y_max',
      'z_max',
    ];
    for (const k of bounds) {
      expect(fusedBbox[k]).toBeCloseTo(expectedUnion[k], 0);
    }
  });

  /**
   * Regression for a real live-app symptom (2026-08-26): a protrusion
   * manually translated to align onto a panel landed a hair off — a real
   * small XY gap, not a coplanarity issue — and fuse_bodies rejected it
   * with GE_FUSE_DISJOINT_RESULT even though the two pieces were clearly
   * meant to touch. FuseCoplanarParts now closes a small real gap exactly
   * (a position correction, not a tolerance override — see
   * polygon_boolean.cc's own comment) before unioning. Same bracket/flange
   * fixture as the test above, but the flange is authored 0.3mm short of
   * true contact.
   */
  it('a flange landing a hair short of true contact still fuses cleanly (gap closed, not rejected)', () => {
    const store = new GraphStore();
    const { partAId } = authorBracket(store);

    // Independent reconstruction, BEFORE the fuse: volume is translation-
    // invariant, so the bracket's own volume plus the flange's own volume
    // (at its authored, still-gapped position) is the correct oracle for
    // the fused result — same "union of independent reconstructions"
    // pattern as the test above, applied to volume instead of bbox.
    const bracketSolo = constructPart(store, partAId);
    expect(bracketSolo.ok, bracketSolo.message).toBe(true);
    const bracketVolume = geometryBinding.computeMassProperties(bracketSolo.shellId, ['volume']).volume!;

    const flange = dispatchGraphTool(store, 'create_part', {
      name: 'flange-gapped',
      outline: [
        { x: 2, y: 5.3 },
        { x: 8, y: 5.3 },
        { x: 8, y: 8.3 },
        { x: 2, y: 8.3 },
      ],
      thickness_mm: 1.0,
    }) as CreatePartResult;
    const flangeSolo = constructPart(store, flange.part_id);
    expect(flangeSolo.ok, flangeSolo.message).toBe(true);
    const flangeVolume = geometryBinding.computeMassProperties(flangeSolo.shellId, ['volume']).volume!;

    const fused = dispatchGraphTool(store, 'fuse_bodies', {
      part_a_id: partAId,
      part_b_id: flange.part_id,
    }) as { part_id: string };
    expect(fused.part_id).toBe(partAId);

    const postFuse = constructPart(store, partAId);
    expect(postFuse.ok, postFuse.message).toBe(true);
    const manifold = geometryBinding.checkManifold(postFuse.shellId);
    expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);

    // The gap closed to exactly zero (a real position correction, not a
    // sliver or an overlap artifact) — the fused volume is exactly the sum
    // of the two independently-reconstructed volumes.
    const mass = geometryBinding.computeMassProperties(postFuse.shellId, ['volume']);
    expect(mass.volume).toBeCloseTo(bracketVolume + flangeVolume, 0);
  });
});
