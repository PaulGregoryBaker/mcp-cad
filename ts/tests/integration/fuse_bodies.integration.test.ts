/**
 * v2 fuse_bodies integration suite (Phase 5 Slice 6: rebuild/06-plan.md,
 * rebuild/15-mcp-contract.md §4.2). Exercises the full real stack — the
 * fuse_bodies tool -> GraphStore.fuseBodies -> evaluate-client.fuseBodies ->
 * geometryBinding.fuseCoplanarParts (C++, anchor-relative transform +
 * coplanarity check + polygon_boolean::PolygonUnion) -> part-B aliasing.
 *
 * Hand-authored synthetic parts, following merge_bodies_with_bend.integration
 * .test.ts's own precedent, rather than a STEP fixture. cube_with_flanges.stp
 * (the only committed fixture with wall+flange pairs) was checked directly
 * against fuseCoplanarParts first: every one of its 45 candidate pairs fails
 * GE_FUSE_NOT_COPLANAR, because that fixture's flanges are v1's OTHER,
 * out-of-scope case — a footprint-CONTAINED patch stacked at a different
 * position along the wall's own thickness axis (see v1's
 * fuse_bodies_coplanar_orientation.integration.test.ts, first describe
 * block) — not the true-coplanar, footprint-touching-or-overlapping case
 * this slice's fuse_bodies implements (rebuild/06-plan.md Slice 6's own
 * "Deferred" note: "the non-coplanar 'stacked patch' case v1 also
 * supports"). v1's OWN test for the in-scope case (second describe block,
 * "footprint-extending flange with slight midplane offset") also uses
 * hand-built synthetic panels, not a STEP fixture, for the same reason: no
 * committed fixture happens to contain two panels genuinely coplanar (same
 * plane) with touching or overlapping footprints.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { McpToolError } from '../../src/mcp/errors';
import type { PartRow, Transform3Row } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function rectRing(r: Rect): Array<{ x: number; y: number }> {
  return [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
}

function createRectPart(
  store: GraphStore,
  name: string,
  rect: Rect,
  anchor?: Transform3Row,
): CreatePartResult {
  return dispatchGraphTool(store, 'create_part', {
    name,
    outline: rectRing(rect),
    thickness_mm: 1.0,
    ...(anchor ? { anchor } : {}),
  }) as CreatePartResult;
}

function requirePart(store: GraphStore, partId: string): PartRow {
  const part = store.getPart(partId);
  expect(part, `part ${partId} must exist in the store`).toBeDefined();
  return part as PartRow;
}

function fuse(store: GraphStore, partAId: string, partBId: string): { part_id: string } {
  return dispatchGraphTool(store, 'fuse_bodies', {
    part_a_id: partAId,
    part_b_id: partBId,
  }) as { part_id: string };
}

function catchFuse(store: GraphStore, partAId: string, partBId: string): unknown {
  try {
    fuse(store, partAId, partBId);
  } catch (err) {
    return err;
  }
  return undefined;
}

function expectFuseError(store: GraphStore, partAId: string, partBId: string, code: string): void {
  const caught = catchFuse(store, partAId, partBId);
  expect(caught).toBeInstanceOf(McpToolError);
  expect((caught as McpToolError).structured.code).toBe(code);
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

/** X-normal plane anchor (v1's own orientedFrame convention: u->world Y,
 * v->world Z, normal->world X), offset along its own normal by nOffset —
 * proves fuseCoplanarParts checks REAL 3D anchors, not just the identity
 * (world-XY) trivial case. */
function xNormalAnchor(nOffset: number): Transform3Row {
  return {
    // r columns are [uAxis | vAxis | normal] = [(0,1,0) | (0,0,1) | (1,0,0)]
    r: [0, 0, 1, 1, 0, 0, 0, 1, 0],
    t: [nOffset, 0, 0],
  };
}

const identityOffZ = (z: number): Transform3Row => ({
  r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  t: [0, 0, z],
});

d('[v2] fuse_bodies (Phase 5 Slice 6) — success cases', () => {
  it('fuses two touching coplanar rectangles (identity anchor) into one union outline', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'fuse-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    const partB = createRectPart(store, 'fuse-b', { x0: 10, y0: 0, x1: 15, y1: 5 });

    const result = fuse(store, partA.part_id, partB.part_id);
    expect(result.part_id).toBe(partA.part_id);

    expect(shoelaceArea(requirePart(store, partA.part_id).outline)).toBeCloseTo(10 * 5 + 5 * 5, 6);
    expect(requirePart(store, partB.part_id).mergedIntoPartId).toBe(partA.part_id);
  });

  it('fuses two overlapping coplanar rectangles, union area accounts for the overlap', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'overlap-a', { x0: 0, y0: 0, x1: 10, y1: 10 });
    const partB = createRectPart(store, 'overlap-b', { x0: 5, y0: 5, x1: 15, y1: 15 });

    fuse(store, partA.part_id, partB.part_id);

    // Two 10x10 squares overlapping in a 5x5 corner: union = 100 + 100 - 25.
    expect(shoelaceArea(requirePart(store, partA.part_id).outline)).toBeCloseTo(175, 6);
  });

  it('fuses two coplanar rectangles anchored on a tilted (X-normal) plane', () => {
    const store = new GraphStore();
    const partA = createRectPart(
      store,
      'tilted-a',
      { x0: 0, y0: 0, x1: 10, y1: 5 },
      xNormalAnchor(3.0),
    );
    // Same plane as A (both offset 3.0mm along the shared X-normal), but a
    // DIFFERENT anchor object than A's — proves the check is a real
    // anchor-relative transform, not a reference-equality shortcut.
    const partB = createRectPart(
      store,
      'tilted-b',
      { x0: 10, y0: 0, x1: 15, y1: 5 },
      xNormalAnchor(3.0),
    );

    fuse(store, partA.part_id, partB.part_id);

    expect(shoelaceArea(requirePart(store, partA.part_id).outline)).toBeCloseTo(10 * 5 + 5 * 5, 6);
  });
});

d('[v2] fuse_bodies (Phase 5 Slice 6) — rejection cases', () => {
  it('rejects non-coplanar parts with GE_FUSE_NOT_COPLANAR', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'noncoplanar-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    // B's plane sits 5mm off A's along A's own normal (world Z, since both
    // use the default identity anchor) — same footprint, different plane.
    const partB = createRectPart(
      store,
      'noncoplanar-b',
      { x0: 10, y0: 0, x1: 15, y1: 5 },
      identityOffZ(5),
    );

    expectFuseError(store, partA.part_id, partB.part_id, 'GE_FUSE_NOT_COPLANAR');
  });

  it('rejects disjoint (non-touching) coplanar parts with GE_FUSE_DISJOINT_RESULT', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'disjoint-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    // A 5mm gap from A's right edge (x=10) to B's left edge (x=15).
    const partB = createRectPart(store, 'disjoint-b', { x0: 15, y0: 0, x1: 20, y1: 5 });

    expectFuseError(store, partA.part_id, partB.part_id, 'GE_FUSE_DISJOINT_RESULT');
  });

  it('rejects a part B that has its own bend with GRAPH_FUSE_PART_B_NOT_SIMPLE', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'notsimple-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    const partB = createRectPart(store, 'notsimple-b', { x0: 10, y0: 0, x1: 15, y1: 5 });

    // Give B its own bend before attempting to fuse it into A.
    dispatchGraphTool(store, 'create_node', {
      kind: 'bend',
      part_id: partB.part_id,
      parent_region_panel_id: partB.root_region_panel_id,
      hinge_a: { x: 11, y: 0 },
      hinge_b: { x: 11, y: 5 },
      angle_deg: 45,
    });

    expectFuseError(store, partA.part_id, partB.part_id, 'GRAPH_FUSE_PART_B_NOT_SIMPLE');
  });

  it('rejects fusing an already-consumed (aliased) part B with GRAPH_PART_ALIASED', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'alias-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    const partB = createRectPart(store, 'alias-b', { x0: 10, y0: 0, x1: 15, y1: 5 });
    // Touches B's own outline directly (B spans x=[10,15]) so the geometry
    // step (which runs before the store's alias check) succeeds regardless —
    // isolating the alias check as the actual reason this must fail.
    const partC = createRectPart(store, 'alias-c', { x0: 15, y0: 0, x1: 20, y1: 5 });

    fuse(store, partA.part_id, partB.part_id);

    // B is now an alias of A — fusing it again (even into a fresh part C it
    // geometrically touches) must be rejected, not silently no-op or
    // double-count its material.
    expectFuseError(store, partC.part_id, partB.part_id, 'GRAPH_PART_ALIASED');
  });
});
