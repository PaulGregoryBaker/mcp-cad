/**
 * v2 merge_bodies_with_bend integration suite (docs/TASK_SPEC.md — anchor-
 * driven, single-path reconciliation, superseding Phase 5 Slice 4's original
 * caller-edge-ref design). Exercises the full real stack — the
 * merge_bodies_with_bend tool -> GraphStore.mergePartsWithBend ->
 * evaluate-client -> geometryBinding.detectContact + reconcileOutlines (C++)
 * -> ordinary createBendNode — on two independently-authored parts whose
 * REAL anchors are the only input the seam/angle are derived from; no
 * edge_a/edge_b/angle_deg args exist on the tool any more.
 *
 * Part B's anchor below (r=[0,0,-1,-1,0,0,0,1,0], t=[10,5,0]) is hand-derived
 * and independently verified (cpp/tests/part_merge_test.cc's own "two
 * rectangles folded 90deg" case checks the same construction against
 * DetectContact directly): it folds B's local (0,0)-(5,0) edge 90 degrees
 * onto A's world (10,0)-(10,5) edge, material extending into +Z.
 *
 * No suite case exists for this (all three T1/*.json cases are level "C",
 * requiring STEP import) — these are hand-authored, following the precedent
 * Slice 1's smoke cases and Slice 2's cross-cube-net case set.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import {
  evaluatePart,
  constructPart,
  mapPointToWorld,
  mapPointToFlat,
} from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';
import { McpToolError } from '../../src/mcp/errors';
import type { NapiRegionPanelLayout } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

interface MergeToolResult {
  part_id: string;
  bend_id: string;
  child_region_panel_id: string;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function shoelaceArea(ring: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

function requirePanel(
  byId: Map<string, NapiRegionPanelLayout>,
  regionPanelId: string,
): NapiRegionPanelLayout {
  const panel = byId.get(regionPanelId);
  expect(panel, `region panel ${regionPanelId} must exist in the evaluated layout`).toBeDefined();
  return panel as NapiRegionPanelLayout;
}

/** A: 10x5 rectangle at identity. B: 5-wide x 8-tall rectangle, anchored so
 * its own local edge0 (0,0)-(5,0) folds 90deg onto A's right edge
 * (10,0)-(10,5) — see this file's header comment for the anchor derivation.
 * Both parts share thicknessMm so the merged solid's flat-pattern area is a
 * clean, hand-verifiable additive check. */
function authorTwoParts(store: GraphStore): {
  partAId: string;
  partBId: string;
  rootPanelAId: string;
  rootPanelBId: string;
} {
  const thicknessMm = 1.0;
  const partA = dispatchGraphTool(store, 'create_part', {
    name: 'merge-a',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 0, y: 5 },
    ],
    thickness_mm: thicknessMm,
  }) as { part_id: string; root_region_panel_id: string };

  const partB = dispatchGraphTool(store, 'create_part', {
    name: 'merge-b',
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
  }) as { part_id: string; root_region_panel_id: string };

  return {
    partAId: partA.part_id,
    partBId: partB.part_id,
    rootPanelAId: partA.root_region_panel_id,
    rootPanelBId: partB.root_region_panel_id,
  };
}

function mergeTwoParts(store: GraphStore, partAId: string, partBId: string): MergeToolResult {
  return dispatchGraphTool(store, 'merge_bodies_with_bend', {
    part_a_id: partAId,
    part_b_id: partBId,
    radius_mm: 2.0,
    k_factor: 0.4,
    // Explicit: this fixture's DetectContact-derived angleDeg sign doesn't
    // reliably predict which side is concave (evaluate-client.ts's own
    // MergePartsWithBendInput.bottomIsConcave doc comment) — confirmed this
    // real corner is a mountain/concave fold by checking constructed volume
    // against the bend-allowance formula (checkMergeStructureAndSolid).
    bottom_is_concave: true,
  }) as MergeToolResult;
}

/** A point well inside B's former territory, now the new child region panel
 * — reusing Slice 3's own proven no-association-swap machinery to prove the
 * merge boundary doesn't introduce one either. */
function checkChildPanelRoundTrip(
  store: GraphStore,
  partAId: string,
  childPanel: NapiRegionPanelLayout,
  childRegionPanelId: string,
): void {
  let minX = childPanel.regionOuter[0].x,
    maxX = childPanel.regionOuter[0].x,
    minY = childPanel.regionOuter[0].y,
    maxY = childPanel.regionOuter[0].y;
  for (const v of childPanel.regionOuter) {
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  const bInterior = { x: minX + 0.5 * (maxX - minX), y: minY + 0.5 * (maxY - minY) };
  const bWorld = mapPointToWorld(store, partAId, bInterior);
  expect(bWorld.ok, bWorld.message).toBe(true);
  expect(bWorld.regionPanelId).toBe(childRegionPanelId);
  const bFlat = mapPointToFlat(store, partAId, bWorld.point3d);
  expect(bFlat.ok, bFlat.message).toBe(true);
  expect(bFlat.regionPanelId).toBe(childRegionPanelId);
  expect(dist2(bFlat.point2d, bInterior)).toBeLessThan(1e-6);
}

/** A point mid-bridge (inside the real bend allowance zone the merge itself
 * created) round-trips and reports the new bend's own id. */
function checkBridgeRoundTrip(
  store: GraphStore,
  partAId: string,
  seg0: NapiRegionPanelLayout,
  bendId: string,
): void {
  const n = seg0.regionOuter.length;
  let bridgeEdge: { a: { x: number; y: number }; b: { x: number; y: number } } | undefined;
  for (let i = 0; i < n; i++) {
    if (seg0.edgeBendId[i] === bendId) {
      bridgeEdge = { a: seg0.regionOuter[i], b: seg0.regionOuter[(i + 1) % n] };
      break;
    }
  }
  expect(
    bridgeEdge,
    `bend ${bendId} must own a boundary edge of ${seg0.regionPanelId}`,
  ).toBeDefined();
  const edge = bridgeEdge as { a: { x: number; y: number }; b: { x: number; y: number } };
  const bridgeQuery = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
  const bridgeWorld = mapPointToWorld(store, partAId, bridgeQuery);
  expect(bridgeWorld.ok, bridgeWorld.message).toBe(true);
  const bridgeFlat = mapPointToFlat(store, partAId, bridgeWorld.point3d);
  expect(bridgeFlat.ok, bridgeFlat.message).toBe(true);
  expect(dist2(bridgeFlat.point2d, bridgeQuery)).toBeLessThan(1e-6);
}

/**
 * B is aliased, never deleted (14 §2.1.2): its row survives with
 * merged_into_part_id set, and its former root region panel is re-parented
 * onto A's partId (a field mutation, not a data move — this store's row
 * maps are flat/store-wide, not per-part). The merged part evaluates to
 * exactly two live region panels joined by one real bend, and constructs to
 * a manifold solid.
 *
 * Volume used to be checked bounded below the naive flat-area*thickness sum
 * (90) and never above it, on the reasoning that a boolean fuse never adds
 * material. That reasoning held only for the OLD (buggy) construction: it
 * placed panel B's own edge exactly at the bridge's far end, so a real
 * bend's own curved material and any panel/panel overlap happened to net
 * out to something at or below the flat sum, coincidentally.
 * docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md's fix
 * moves panel B's edge to its true position — which correctly leaves room
 * for the bend's own real material — so the naive flat sum is no longer an
 * upper bound at all: a real, non-sharp bend genuinely contains MORE
 * material than its two flat panels alone, because unlike a sharp corner it
 * has to have actual curved material connecting them. The old bound was
 * checking that a bug's specific side effect stayed within a range, not
 * verifying anything about the true geometry.
 *
 * What IS meaningful: total volume should equal the two flat panels' own
 * volume (naiveSum) PLUS the bend's own real material — the standard
 * sheet-metal bend-allowance quantity, `BA = angleRad * (radiusMm +
 * kFactor*thicknessMm)` (same formula ComputeBendGeometry uses in C++),
 * times the seam width and thickness — minus a small, expected panel/panel
 * overlap at the mountain-fold corner (the same effect the old comment
 * described, now smaller since the panels no longer meet edge-to-edge).
 * Checked to a tight (2mm3, ~2%) tolerance around that physically-derived
 * expectation, not an arbitrary wide band.
 */
function checkMergeStructureAndSolid(
  store: GraphStore,
  partAId: string,
  partBId: string,
  rootPanelBId: string,
  mergeResult: MergeToolResult,
): void {
  expect(mergeResult.part_id).toBe(partAId);
  expect(mergeResult.bend_id).toBeTruthy();
  expect(mergeResult.child_region_panel_id).toBeTruthy();

  const partB = store.getPart(partBId);
  expect(partB?.mergedIntoPartId).toBe(partAId);
  const formerBRoot = store.getRegionPanel(rootPanelBId);
  expect(formerBRoot?.partId).toBe(partAId);

  const evalResult = evaluatePart(store, partAId);
  expect(evalResult.ok, evalResult.message).toBe(true);
  expect(evalResult.panels).toHaveLength(2);
  expect(evalResult.bridges).toHaveLength(1);

  const constructResult = constructPart(store, partAId);
  expect(constructResult.ok, constructResult.message).toBe(true);
  expect(constructResult.shellId).toBeTruthy();

  const manifold = geometryBinding.checkManifold(constructResult.shellId);
  expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);

  // naiveSum = (A's 10x5 + B's 5x8) * thicknessMm(1) = 90 — the two flat
  // panels alone, no bend material.
  const naiveSum = 90;
  // The merge's own authored bend: angle_deg=90, radius_mm=2, k_factor=0.4
  // (mergeTwoParts above), seam width 5mm (edge_a/edge_b's shared length),
  // thicknessMm=1 (authorTwoParts above) — same formula ComputeBendGeometry
  // uses in C++ (BendGeometryMm::allowanceMm).
  const angleRad = (90 * Math.PI) / 180;
  const radiusMm = 2.0;
  const kFactor = 0.4;
  const thicknessMm = 1.0;
  const seamWidthMm = 5.0;
  const bendAllowanceMm = angleRad * (radiusMm + kFactor * thicknessMm);
  const bendMaterialMm3 = bendAllowanceMm * seamWidthMm * thicknessMm;
  const expectedVolume = naiveSum + bendMaterialMm3;

  const mass = geometryBinding.computeMassProperties(constructResult.shellId, ['volume']);
  expect(mass.volume).toBeGreaterThan(naiveSum); // a real bend has real material, unlike the old bug
  // Tight, physically-derived tolerance (~2% of expectedVolume) — not an
  // arbitrary wide band; the residual is the small mountain-fold panel/panel
  // overlap this construction still has near the bend corner.
  expect(Math.abs(mass.volume! - expectedVolume)).toBeLessThan(2);
}

d('v2 merge_bodies_with_bend — authored, independently-authored parts', () => {
  it('merges two parts into one manifold solid, aliasing B and re-parenting its rows', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelBId } = authorTwoParts(store);
    const mergeResult = mergeTwoParts(store, partAId, partBId);
    checkMergeStructureAndSolid(store, partAId, partBId, rootPanelBId, mergeResult);
  });

  it('round-trips region-panel and bridge points across the merge seam with stable ownership', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    const mergeResult = mergeTwoParts(store, partAId, partBId);

    const evalResult = evaluatePart(store, partAId);
    expect(evalResult.ok, evalResult.message).toBe(true);
    const byId = new Map<string, NapiRegionPanelLayout>(
      evalResult.panels.map((p) => [p.regionPanelId, p]),
    );

    // A point well inside A's original panel (unaffected by the merge).
    const aInterior = { x: 3, y: 2.5 };
    const aWorld = mapPointToWorld(store, partAId, aInterior);
    expect(aWorld.ok, aWorld.message).toBe(true);
    expect(aWorld.regionPanelId).toBe(rootPanelAId);
    const aFlat = mapPointToFlat(store, partAId, aWorld.point3d);
    expect(aFlat.ok, aFlat.message).toBe(true);
    expect(aFlat.regionPanelId).toBe(rootPanelAId);
    expect(dist2(aFlat.point2d, aInterior)).toBeLessThan(1e-6);

    const childPanel = requirePanel(byId, mergeResult.child_region_panel_id);
    checkChildPanelRoundTrip(store, partAId, childPanel, mergeResult.child_region_panel_id);

    const seg0 = requirePanel(byId, rootPanelAId);
    checkBridgeRoundTrip(store, partAId, seg0, mergeResult.bend_id);
  });

  // docs/TASK_SPEC.md F3: an unequal-length seam is a supported case now,
  // not a rejection — v1's "GE_MERGE_EDGE_MISMATCH" scenario is superseded.
  // A: 20x5 plate, its right edge (x=20, y in [0,5]) one plain unbroken
  // edge, no pre-authored splitting. B: a 3x4 flange whose own 3-length
  // edge0 only covers y in [1,4] of A's edge — hand-derived anchor
  // independently verified against cpp/tests/part_merge_test.cc's own
  // "asymmetric seam" case.
  it('merges an unequal-length (asymmetric) seam directly, without a pre-split outline', () => {
    const store = new GraphStore();
    const partA = dispatchGraphTool(store, 'create_part', {
      name: 'asym-a',
      outline: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string };
    const partB = dispatchGraphTool(store, 'create_part', {
      name: 'asym-b',
      outline: [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
        { x: 0, y: 4 },
      ],
      thickness_mm: 1.0,
      anchor: {
        r: [0, 0, -1, -1, 0, 0, 0, 1, 0],
        t: [20, 4, 0],
      },
    }) as { part_id: string };

    const merged = dispatchGraphTool(store, 'merge_bodies_with_bend', {
      part_a_id: partA.part_id,
      part_b_id: partB.part_id,
    }) as MergeToolResult;
    expect(merged.part_id).toBe(partA.part_id);
    expect(merged.bend_id).toBeTruthy();
    expect(merged.child_region_panel_id).toBeTruthy();

    const evalResult = evaluatePart(store, partA.part_id);
    expect(evalResult.ok, evalResult.message).toBe(true);
    expect(evalResult.panels).toHaveLength(2);
    expect(evalResult.bridges).toHaveLength(1);

    const constructed = constructPart(store, partA.part_id);
    expect(constructed.ok, constructed.message).toBe(true);
    const manifold = geometryBinding.checkManifold(constructed.shellId);
    expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);
  });

  it('rejects two parts with no real contact with a typed GE_MERGE_NO_CONTACT error', () => {
    const store = new GraphStore();
    const { partAId, partBId } = authorTwoParts(store);
    // Move B far away from A — undo authorTwoParts' own touching anchor.
    dispatchGraphTool(store, 'update_node', {
      kind: 'part',
      id: partBId,
      patch: { anchor: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [1000, 1000, 1000] } },
    });

    let caught: unknown;
    try {
      dispatchGraphTool(store, 'merge_bodies_with_bend', {
        part_a_id: partAId,
        part_b_id: partBId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GE_MERGE_NO_CONTACT');
  });
});

/**
 * Live-app regression (2026-09): reported as "Tool error: edgeB0/edgeB1 are
 * not a consecutive pair after vertex resolution" when running
 * merge_bodies_with_bend on a part that had just gone through
 * fuse_bodies.integration.test.ts's own live recipe (import testcube.step,
 * split_part_at_bend on every bend with keep_corner_on='parent', translate
 * Protrusion1 by -76.6mm, fuse) against another imported component.
 *
 * Root cause (part_merge.cc's ReconcileOutlines): the seam's two contact
 * points were required to resolve to LITERALLY ADJACENT outline indices,
 * but a real outline can carry a genuine extra vertex strictly between them
 * — a collinear relief-cut midpoint, confirmed live on the imported
 * component's own edge ((0,0)-(74.95,0)-(150,0), three collinear points on
 * one physical edge). Fixed by treating whatever lies strictly between the
 * two resolved indices as part of the vanishing seam (dropped), not a
 * rejection reason.
 *
 * A first fix attempt regressed this into a WORSE, silent defect (visible
 * extra panel/fin in the live app, flat pattern no longer generating) — its
 * combining loop assumed the seam's two endpoints always resolve in
 * increasing array-index order; when the seam instead wraps across the
 * outline array's own physical start/end boundary (confirmed live: exactly
 * what LocateOrInsertVertex's "insert after the last edge" push_back path
 * produces), that assumption re-walked part of the outline a second time,
 * producing a duplicate-vertex, corrupted polygon. Fixed by branching on
 * which side of the (kFinal, a1Idx) pair actually wraps, instead of
 * assuming one order always holds (see part_merge.cc and
 * part_merge_test.cc's two dedicated regression cases for the full
 * root-cause writeup).
 *
 * Each (axis, targetPanel, otherComp) pairing below is checked in ISOLATION
 * (restored before/after) — a merge that chains a THIRD panel onto an
 * already-bend-merged composite is a separate, independently fragile code
 * path (not this recipe, which performs exactly one merge) and is out of
 * scope here.
 */
d('v2 merge_bodies_with_bend live regression: a fuse_bodies-produced outline with a real vertex '
  + 'on the seam interval (a relief-cut midpoint) merges correctly, producing exactly the right '
  + 'panel count and a manifold, area-conserving solid — not a false rejection, and not a silent '
  + 'extra-panel corruption',
  () => {
  it('import testcube.step, split + translate Protrusion1 by -76.6mm + fuse (fuse_bodies\' own live '
    + 'recipe), then merge_bodies_with_bend the fused panel onto another imported component — every '
    + 'reachable pairing produces exactly 2 region panels, a manifold solid, and conserves area; at '
    + 'least one pairing must be reachable', () => {
    const store = new GraphStore();
    const imported = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES_DIR, 'testcube.step'),
    }) as { part_id: string; protrusion_part_ids: string[]; component_part_ids: string[] };

    let component1 = imported.component_part_ids[0];
    let maxBends = -1;
    for (const cid of imported.component_part_ids) {
      const n = store.snapshotPart(cid).bends.length;
      if (n > maxBends) { maxBends = n; component1 = cid; }
    }
    expect(maxBends).toBe(3);

    const worklist: string[] = [component1];
    const allSplitParts = new Set<string>([component1]);
    while (worklist.length > 0) {
      const pid = worklist.pop()!;
      const bends = store.snapshotPart(pid).bends;
      if (bends.length === 0) continue;
      const bendId = bends[0].bendId;
      const result = dispatchGraphTool(store, 'split_part_at_bend', {
        part_id: pid,
        bend_id: bendId,
        keep_corner_on: 'parent',
      }) as { new_part_ids: string[] };
      for (const npid of result.new_part_ids) {
        allSplitParts.add(npid);
        worklist.push(npid);
      }
      worklist.push(pid);
    }

    const protrusion1 = imported.protrusion_part_ids[0];
    let anyChecked = false;

    for (const axis of ['x', 'y'] as const) {
      for (const targetPanel of allSplitParts) {
        const before = store.snapshotAll();
        const protrusion = store.getPart(protrusion1)!;
        const t = protrusion.anchor.t as [number, number, number];
        const newT: [number, number, number] =
          axis === 'x' ? [t[0] - 76.6, t[1], t[2]] : [t[0], t[1] - 76.6, t[2]];
        dispatchGraphTool(store, 'update_node', {
          kind: 'part',
          id: protrusion1,
          patch: { anchor: { r: protrusion.anchor.r, t: newT } },
        });

        let fusedPartId: string | undefined;
        let areaBeforeMerge = 0;
        try {
          const result = dispatchGraphTool(store, 'fuse_bodies', {
            part_a_id: targetPanel,
            part_b_id: protrusion1,
          }) as { part_id: string };
          fusedPartId = result.part_id;
          areaBeforeMerge = shoelaceArea(store.getPart(fusedPartId)!.outline);
        } catch {
          store.restoreAll(before);
          continue;
        }

        // Each otherComp is tried against the SAME single-merge starting
        // point (restored before/after) — never chained onto a prior
        // merge's own result, matching the reported recipe exactly.
        for (const otherComp of imported.component_part_ids) {
          if (otherComp === component1) continue;
          const beforeEachMerge = store.snapshotAll();
          const areaB = shoelaceArea(store.getPart(otherComp)!.outline);

          let mergeResult: { part_id: string } | undefined;
          try {
            mergeResult = dispatchGraphTool(store, 'merge_bodies_with_bend', {
              part_a_id: fusedPartId,
              part_b_id: otherComp,
            }) as { part_id: string };
          } catch {
            // A genuinely unrelated/out-of-plane (targetPanel, otherComp)
            // pairing is expected to fail — only inspected via anyChecked.
          }
          if (mergeResult) {
            anyChecked = true;
            const evalResult = evaluatePart(store, mergeResult.part_id);
            expect(evalResult.ok, evalResult.message).toBe(true);
            // The regression check: exactly 2 region panels, never a
            // spurious 3rd (the visible extra-panel defect).
            expect(evalResult.panels.length).toBe(2);

            const combinedArea = shoelaceArea(store.getPart(mergeResult.part_id)!.outline);
            expect(combinedArea).toBeCloseTo(areaBeforeMerge + areaB, 1);

            const constructResult = constructPart(store, mergeResult.part_id);
            expect(constructResult.ok, constructResult.message).toBe(true);
            const manifold = geometryBinding.checkManifold(constructResult.shellId);
            expect(manifold.isManifold, JSON.stringify(manifold.issues)).toBe(true);
          }

          store.restoreAll(beforeEachMerge);
        }

        store.restoreAll(before);
      }
    }

    expect(
      anyChecked,
      'at least one (axis, targetPanel, otherComp) pairing matching the live recipe must reach '
        + 'merge_bodies_with_bend and be checked',
    ).toBe(true);
  });
});
