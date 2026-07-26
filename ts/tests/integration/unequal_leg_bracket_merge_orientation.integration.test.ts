/**
 * v2 port of v1's unequal_leg_bracket_orientation.integration.test.ts (Phase
 * 5 test migration, 2026-07-26). `unequal_leg_bracket_90deg.stp` is two
 * SIMPLE, non-composite panels at a sharp 90° dihedral with deliberately
 * UNEQUAL leg lengths (~100mm long leg, ~30mm short leg) sharing their full
 * common edge — no fuse_bodies, no protrusions, no composite-panel
 * complexity, isolating whether merge_bodies_with_bend itself preserves 3D
 * orientation correctly.
 *
 * Because the legs are clearly different sizes, an axis/U-V swap is
 * immediately visible: the long leg's ~100mm dimension and the short leg's
 * ~30mm dimension must land on the SAME world axis in the merged result.
 * Tested across 3 fold-axis orientations (the whole solid is rotated BEFORE
 * splitting, redirecting the fold axis onto world Y/X/Z) and both
 * part_a/part_b argument orders — 6 cases total, matching v1's own matrix.
 * v2's architecture (13's pure algebraic pose-chain composition, no offset
 * fields) should make hidden axis bias structurally impossible, but that's a
 * design claim, not yet a fact checked against this specific real, unequal-
 * shaped fixture — this is the check.
 *
 * Two real findings while porting this test:
 * 1. Reference bboxes must come from v2's OWN reconstruction of each
 *    independent part (constructPart), not from the raw split-time OCCT
 *    shells — those are a disposable intermediate artifact with no promised
 *    relationship to v2's own canonical thickening convention (the same
 *    pitfall v1's own fuse_bodies_coplanar_orientation.integration.test.ts
 *    already documented and avoided).
 * 2. `merge_bodies_with_bend` had no way to pass `bottom_is_concave` at
 *    creation time (only `update_node` could set it after the fact) — for
 *    this real fixture, the angle_deg-sign-derived default pivot side is
 *    wrong, producing a merged bbox off by exactly one material thickness on
 *    the fold-adjacent bound. Fixed by threading `bottom_is_concave` through
 *    `merge_bodies_with_bend`'s tool schema -> evaluate-client -> GraphStore,
 *    the same field `create_node(bend)` already exposed.
 *
 * `getPanelFrame` is not called on the merged (bent, 2-panel) composite here
 * — it measures a single dominant plane, which a genuinely bent shape
 * doesn't have; the bbox-based axis-swap check below is this test's real
 * orientation oracle.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { geometryBinding } from '../../src/geometry/binding';
import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart } from '../../src/v2/graph/evaluate-client';
import type { BoundingBoxResult } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../cpp/tests/fixtures/unequal_leg_bracket_90deg.stp',
);

type Axis = 'x' | 'y' | 'z';

function largestAxisExtent(b: BoundingBoxResult, axis: Axis): number {
  return b[`${axis}_max`] - b[`${axis}_min`];
}

function largestAxis(b: BoundingBoxResult): Axis {
  if (
    largestAxisExtent(b, 'x') >= largestAxisExtent(b, 'y') &&
    largestAxisExtent(b, 'x') >= largestAxisExtent(b, 'z')
  ) {
    return 'x';
  }
  return largestAxisExtent(b, 'y') >= largestAxisExtent(b, 'z') ? 'y' : 'z';
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

interface Piece {
  origin: { x: number; y: number; z: number };
  uAxis: { x: number; y: number; z: number };
  vAxis: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  ringLocal: { x: number; y: number }[];
  thicknessMm: number;
  shellId: string;
  uExtentMm: number;
}

function decompose(
  rotate: { axisDir: [number, number, number]; angleDeg: number } | null,
): Piece[] {
  let solidId = geometryBinding.loadStep(FIXTURE_PATH);
  geometryBinding.healGeometryEx(solidId, true, true);
  if (rotate) {
    const rotated = geometryBinding.rotateBody(
      solidId,
      0,
      0,
      0,
      rotate.axisDir[0],
      rotate.axisDir[1],
      rotate.axisDir[2],
      rotate.angleDeg,
      false,
    );
    solidId = rotated.solid_id;
  }
  const split = geometryBinding.splitBodyByBends(solidId, 45, 5.0, undefined, undefined);
  return split.panel_ids.map((shellId: string) => {
    const frame = geometryBinding.getPanelFrame(shellId);
    return {
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      thicknessMm: frame.thicknessMm,
      shellId,
      uExtentMm: frame.uExtentMm,
    };
  });
}

interface OrientationCase {
  foldAxisLabel: 'Y' | 'X' | 'Z';
  rotate: { axisDir: [number, number, number]; angleDeg: number } | null;
}

const orientationCases: OrientationCase[] = [
  { foldAxisLabel: 'Y', rotate: null },
  { foldAxisLabel: 'X', rotate: { axisDir: [0, 0, 1], angleDeg: 90 } },
  { foldAxisLabel: 'Z', rotate: { axisDir: [1, 0, 0], angleDeg: 90 } },
];
const orders: Array<'longFirst' | 'shortFirst'> = ['longFirst', 'shortFirst'];
const allCases = orientationCases.flatMap((c) => orders.map((order) => ({ ...c, order })));

d(
  '[v2] unequal_leg_bracket_90deg.stp: merge_bodies_with_bend precisely preserves 3D position',
  () => {
    it.each(allCases)(
      'fold axis $foldAxisLabel ($order)',
      ({ rotate, order }) => {
        const pieces = decompose(rotate);
        expect(pieces.length).toBe(2);

        const longLeg = pieces[0].uExtentMm >= pieces[1].uExtentMm ? pieces[0] : pieces[1];
        const shortLeg = pieces[0].uExtentMm >= pieces[1].uExtentMm ? pieces[1] : pieces[0];

        const reconciled = geometryBinding.reconcilePieces(
          [longLeg, shortLeg],
          longLeg.thicknessMm,
        );
        expect(reconciled.ok, reconciled.message).toBe(true);
        const match = reconciled.pieceEdgeMatches[0];
        const bend = reconciled.graph.bends[0];
        const longIsParent = reconciled.graph.rootRegionPanelId === 'piece0';

        // Each part needs its OWN real-world anchor (not the default identity)
        // for merge_bodies_with_bend's edge-resolution to align them in the
        // SAME real 3D frame the fixture was actually measured in — the same
        // reconcilePieces(n=1) pattern import_part's own protrusion loop uses
        // to derive a clean single-piece anchor.
        const longSolo = geometryBinding.reconcilePieces([longLeg], longLeg.thicknessMm);
        const shortSolo = geometryBinding.reconcilePieces([shortLeg], shortLeg.thicknessMm);
        expect(longSolo.ok, longSolo.message).toBe(true);
        expect(shortSolo.ok, shortSolo.message).toBe(true);

        const store = new GraphStore();
        const partLong = dispatchGraphTool(store, 'create_part', {
          name: 'long-leg',
          outline: longSolo.graph.outline.outer,
          thickness_mm: longLeg.thicknessMm,
          anchor: longSolo.graph.anchor?.transform,
        }) as { part_id: string; root_region_panel_id: string };
        const partShort = dispatchGraphTool(store, 'create_part', {
          name: 'short-leg',
          outline: shortSolo.graph.outline.outer,
          thickness_mm: shortLeg.thicknessMm,
          anchor: shortSolo.graph.anchor?.transform,
        }) as { part_id: string; root_region_panel_id: string };

        // Reference bboxes come from v2's OWN reconstruction of each
        // independent part — see this file's header comment, finding 1.
        const longRef = constructPart(store, partLong.part_id);
        const shortRef = constructPart(store, partShort.part_id);
        expect(longRef.ok).toBe(true);
        expect(shortRef.ok).toBe(true);
        const expectedUnion = unionBbox(
          geometryBinding.computeBoundingBox(longRef.shellId),
          geometryBinding.computeBoundingBox(shortRef.shellId),
        );

        const partA = order === 'longFirst' ? partLong : partShort;
        const partB = order === 'longFirst' ? partShort : partLong;
        const aIsLong = order === 'longFirst';

        // reconcilePieces resolved its OWN parent choice (longIsParent) —
        // independent of this test's part_a/part_b argument order — so the
        // right edge_index for each leg (long vs short) must be looked up by
        // WHICH LEG it is, then assigned to whichever of part_a/part_b that
        // leg currently is.
        const edgeIndexForLong = longIsParent ? match.parentEdgeIndex : match.childEdgeIndex;
        const edgeIndexForShort = longIsParent ? match.childEdgeIndex : match.parentEdgeIndex;

        const merged = dispatchGraphTool(store, 'merge_bodies_with_bend', {
          part_a_id: partA.part_id,
          part_b_id: partB.part_id,
          edge_a: {
            region_panel_id: partA.root_region_panel_id,
            edge_index: aIsLong ? edgeIndexForLong : edgeIndexForShort,
          },
          edge_b: {
            region_panel_id: partB.root_region_panel_id,
            edge_index: aIsLong ? edgeIndexForShort : edgeIndexForLong,
          },
          angle_deg: bend.angleDeg,
          // See this file's header comment, finding 2 — the sign-derived
          // default is wrong for this real fixture.
          bottom_is_concave: bend.bottomIsConcave,
        }) as { part_id: string };

        const constructed = constructPart(store, merged.part_id);
        expect(constructed.ok).toBe(true);
        const mergedBbox = geometryBinding.computeBoundingBox(constructed.shellId);

        // PRIMARY ASSERTION: two simple, non-composite panels — no excuse for
        // any residual. The merged 3D bbox must match the union of the
        // pre-merge reference bboxes to within 0.5mm (toBeCloseTo(_, 0)).
        const bounds: Array<keyof BoundingBoxResult> = [
          'x_min',
          'y_min',
          'z_min',
          'x_max',
          'y_max',
          'z_max',
        ];
        for (const k of bounds) {
          expect(mergedBbox[k]).toBeCloseTo(expectedUnion[k], 0);
        }

        // SECONDARY ASSERTION: the combined long+short leg reach must land on
        // the same world axis in both the expected union and the actual merged
        // result — not swapped with the common/seam extent.
        expect(largestAxis(mergedBbox)).toBe(largestAxis(expectedUnion));
      },
      30_000,
    );
  },
);
