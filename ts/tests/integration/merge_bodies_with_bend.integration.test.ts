/**
 * v2 merge_bodies_with_bend integration suite (Phase 5 Slice 4:
 * rebuild/14-graph-schema.md §2.1.2). Exercises the full real stack — the
 * merge_bodies_with_bend tool -> GraphStore.mergePartsWithBend ->
 * evaluate-client -> geometryBinding.reconcileOutlines (C++) -> ordinary
 * createBendNode — on two independently-authored parts with no prior 3D
 * relationship, the exact case the design docs left unspecified (13 §6's own
 * reconciliation pattern presupposes edges that are already identical "by
 * measurement," which does not hold here).
 *
 * No suite case exists for this (all three T1/*.json cases are level "C",
 * requiring STEP import) — these are hand-authored, following the precedent
 * Slice 1's smoke cases and Slice 2's cross-cube-net case set.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

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

interface MergeToolResult {
  part_id: string;
  bend_id: string;
  child_region_panel_id: string;
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function requirePanel(
  byId: Map<string, NapiRegionPanelLayout>,
  regionPanelId: string,
): NapiRegionPanelLayout {
  const panel = byId.get(regionPanelId);
  expect(panel, `region panel ${regionPanelId} must exist in the evaluated layout`).toBeDefined();
  return panel as NapiRegionPanelLayout;
}

/** A: 10x5 rectangle. B: 5-wide x 8-tall rectangle — B's 5-length edge is the
 * seam, matching A's right edge exactly. Both parts share thicknessMm so the
 * merged solid's flat-pattern area is a clean, hand-verifiable additive
 * check. */
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
  }) as { part_id: string; root_region_panel_id: string };

  return {
    partAId: partA.part_id,
    partBId: partB.part_id,
    rootPanelAId: partA.root_region_panel_id,
    rootPanelBId: partB.root_region_panel_id,
  };
}

function mergeTwoParts(
  store: GraphStore,
  rootPanelAId: string,
  partAId: string,
  rootPanelBId: string,
  partBId: string,
): MergeToolResult {
  return dispatchGraphTool(store, 'merge_bodies_with_bend', {
    part_a_id: partAId,
    part_b_id: partBId,
    // A's root outline is [(0,0),(10,0),(10,5),(0,5)] — edge 1 is the right
    // edge (10,0)-(10,5), length 5.
    edge_a: { region_panel_id: rootPanelAId, edge_index: 1 },
    // B's root outline is [(0,0),(5,0),(5,8),(0,8)] — edge 0 is (0,0)-(5,0),
    // length 5, matching A's seam.
    edge_b: { region_panel_id: rootPanelBId, edge_index: 0 },
    angle_deg: 90,
    radius_mm: 2.0,
    k_factor: 0.4,
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
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    const mergeResult = mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);
    checkMergeStructureAndSolid(store, partAId, partBId, rootPanelBId, mergeResult);
  });

  it('round-trips region-panel and bridge points across the merge seam with stable ownership', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);
    const mergeResult = mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);

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

  it('rejects a mismatched seam edge length with a typed GE_MERGE_EDGE_MISMATCH error', () => {
    const store = new GraphStore();
    const partA = dispatchGraphTool(store, 'create_part', {
      name: 'mismatch-a',
      outline: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string; root_region_panel_id: string };
    const partB = dispatchGraphTool(store, 'create_part', {
      name: 'mismatch-b',
      outline: [
        { x: 0, y: 0 },
        { x: 40, y: 0 }, // length 40, does not match A's seam length 5
        { x: 40, y: 8 },
        { x: 0, y: 8 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string; root_region_panel_id: string };

    let caught: unknown;
    try {
      dispatchGraphTool(store, 'merge_bodies_with_bend', {
        part_a_id: partA.part_id,
        part_b_id: partB.part_id,
        edge_a: { region_panel_id: partA.root_region_panel_id, edge_index: 1 },
        edge_b: { region_panel_id: partB.root_region_panel_id, edge_index: 0 },
        angle_deg: 90,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GE_MERGE_EDGE_MISMATCH');
  });

  it('rejects a bend-zone (non-free) edge_ref with GE_INVALID_EDGE_REF', () => {
    const store = new GraphStore();
    const { partAId, partBId, rootPanelAId, rootPanelBId } = authorTwoParts(store);

    // First merge succeeds, consuming A's edge 1 into a bend zone boundary —
    // a second merge attempt reusing that SAME edge_ref must be rejected,
    // not silently misinterpreted.
    mergeTwoParts(store, rootPanelAId, partAId, rootPanelBId, partBId);

    const partC = dispatchGraphTool(store, 'create_part', {
      name: 'merge-c',
      outline: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 3 },
        { x: 0, y: 3 },
      ],
      thickness_mm: 1.0,
    }) as { part_id: string; root_region_panel_id: string };

    // Find the bend-zone edge's OWN index on A's (now re-clipped) root panel
    // dynamically — never assume it's still index 1, since regionOf's clip
    // may reorder/resize the boundary array.
    const evalResult = evaluatePart(store, partAId);
    expect(evalResult.ok, evalResult.message).toBe(true);
    const rootPanel = requirePanel(
      new Map(evalResult.panels.map((p) => [p.regionPanelId, p])),
      rootPanelAId,
    );
    const bendZoneIndex = rootPanel.edgeBendId.findIndex((id) => id !== '');
    expect(bendZoneIndex).toBeGreaterThanOrEqual(0);

    let caught: unknown;
    try {
      dispatchGraphTool(store, 'merge_bodies_with_bend', {
        part_a_id: partAId,
        part_b_id: partC.part_id,
        edge_a: { region_panel_id: rootPanelAId, edge_index: bendZoneIndex },
        edge_b: { region_panel_id: partC.root_region_panel_id, edge_index: 0 },
        angle_deg: 90,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpToolError);
    expect((caught as McpToolError).structured.code).toBe('GE_INVALID_EDGE_REF');
  });
});
