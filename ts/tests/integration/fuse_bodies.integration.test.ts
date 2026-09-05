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
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { McpToolError } from '../../src/mcp/errors';
import type { PartRow, Transform3Row } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

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

  /**
   * v2 port of v1's fuse_y_contact.integration.test.ts scenario 2 (Phase 5
   * test migration, 2026-07-26): a STAGGERED shared edge — B's edge touches
   * A's edge along only PART of its length (offset 0.3mm perpendicular to
   * the shared boundary), not a full flush edge (the "touching rectangles"
   * case above) and not a footprint overlap (the "overlapping rectangles"
   * case above). A genuinely distinct touching topology, confirmed via a
   * scratch script to not already be exercised by either existing case.
   *
   * v1's own file had a THIRD scenario: a deliberate, artificial sub-mm GAP
   * (translating B by thickness+0.3mm) exercising v1's own "DXF Y-gap
   * correction" — a compensating-offset fallback in v1's separate DXF-
   * reconstruction step for panels that were "physically touching in 3D" but
   * whose independently-computed DXF outlines drifted apart. That mechanism
   * has no v2 counterpart: v2's fuseCoplanarParts operates on ONE outline
   * (constitution v2 principle III — one geometric solution), and a scratch
   * check confirmed v2 currently rejects any gap at all, even 0.01mm
   * (GE_FUSE_DISJOINT_RESULT via the underlying PolygonUnion's kMultipleLoops
   * case) — matching the existing "rejects disjoint" test below. Adding gap
   * tolerance would be exactly the "compensating offset" this rebuild's
   * constitution prohibits (principle III/VI) for a case that, unlike v1's,
   * never arises here: v2 measures a real STEP-derived panel's outline once,
   * from one ring, not via a second independently-reconstructed DXF pass —
   * so two panels genuinely touching in 3D do not drift into a fake gap. Not
   * ported.
   */
  it('fuses two coplanar rectangles along a STAGGERED (partial, offset) shared edge', () => {
    const store = new GraphStore();
    const partA = createRectPart(store, 'stagger-a', { x0: 0, y0: 0, x1: 10, y1: 5 });
    // B's left edge (x=10) touches A's right edge (x=10) but B is shifted
    // 0.3mm in Y — only 4.7mm of the 5mm edge actually coincides, and the
    // remaining 0.3mm forms an L-shaped step, not a flush line.
    const partB = createRectPart(store, 'stagger-b', { x0: 10, y0: 0.3, x1: 15, y1: 5.3 });

    fuse(store, partA.part_id, partB.part_id);

    expect(shoelaceArea(requirePart(store, partA.part_id).outline)).toBeCloseTo(10 * 5 + 5 * 5, 6);
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

/**
 * Live-app regression (2026-09): reported as "Tool error: boolean result
 * has 2 faces (expected exactly 1) — disjoint or empty result" (later:
 * "closest in-plane XY gap: 0.000000mm" yet still 2 faces) when fusing a
 * real testcube.step protrusion onto a split_part_at_bend panel, after a
 * manual "Translate Body" edit in the app.
 *
 * TRUE root cause, found by isolating the exact live ring pair down to a
 * bare `PolygonUnion(a, b)` call (no anchors, no projection): A's outline
 * is wound CCW; FuseCoplanarParts' own anchor-relative projection of B into
 * A's local frame produces a CW-wound ring whenever that projection's
 * in-plane rotation has determinant -1 — a REAL, correct fact about two
 * independently-chosen local frames (confirmed live: two testcube
 * protrusions sit on walls whose outward normals point in opposite
 * directions along the same axis), not an error. `PolygonUnion` built
 * OCCT faces directly from each input ring's own winding without ever
 * canonicalizing it, so two faces with opposite windings — even a
 * perfectly clean, verified-by-hand 0.05mm overlap, not a gap — could fail
 * `BRepAlgoAPI_Fuse` outright. Confirmed independent of `kBooleanFuzzMm`
 * (still failed at a 10,000x looser fuzz value): this was a winding/
 * orientation defect, not a numerical-tolerance one.
 *
 * Two earlier fix attempts this session were wrong:
 * 1. "Correct" the mirror by reinterpreting B's local (x,y) through a
 *    different rotation before projecting — silently substituted a
 *    different SHAPE for B while leaving its anchor translation untouched,
 *    producing a wrong (invisible, overlapping-with-A) result instead of a
 *    typed error. Reverted.
 * 2. Theorize the mirror traces back to `getPanelFrame`'s own axis
 *    convention and needs an upstream fix there — wrong per the user's own
 *    correction: the 2D↔3D round trip via each part's own anchor is
 *    self-consistent BY CONSTRUCTION regardless of which convention chose
 *    either anchor; a determinant -1 composed rotation is not an error to
 *    fix, just an accurate fact. Never implemented.
 *
 * The actual fix (`PolygonUnion`, `polygon_boolean.cc`): canonicalize BOTH
 * input rings to the same (CCW) winding before building OCCT faces — pure
 * vertex re-ordering, changes no position or shape, so neither of the two
 * traps above applies.
 */
d('[v2] fuse_bodies live regression: a real testcube.step protrusion, translated by the exact '
  + 'live recipe onto a split_part_at_bend panel, fuses correctly (root cause was PolygonUnion '
  + 'never canonicalizing input winding, not a shape/position/mirror defect)',
  () => {
  function bbox(outline: Array<{ x: number; y: number }>) {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of outline) {
      xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x);
      yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y);
    }
    return { xMin, xMax, yMin, yMax };
  }

  it('import testcube.step, split Component 1 on every bend (keep_corner_on=parent, worklist '
    + 'across every resulting part), translate Protrusion1 by -76.6mm along a world axis, fuse '
    + 'onto whichever resulting panel it reaches — at least one pairing must succeed and '
    + "genuinely grow that panel's area", () => {
    const store = new GraphStore();
    const imported = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES_DIR, 'testcube.step'),
    }) as { part_id: string; protrusion_part_ids: string[]; component_part_ids: string[] };

    // "Component 1" — the 3-bend inner-cube component, found from the
    // actual import, not assumed by index.
    let component1 = imported.component_part_ids[0];
    let maxBends = -1;
    for (const cid of imported.component_part_ids) {
      const n = store.snapshotPart(cid).bends.length;
      if (n > maxBends) { maxBends = n; component1 = cid; }
    }
    expect(maxBends).toBe(3);

    // Split by bend for ALL bends, keep edges on parent — a WORKLIST across
    // every resulting part (not just component1 itself), since a split-off
    // piece can carry its own remaining bend that component1's own bend
    // list would never re-visit.
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
    expect(allSplitParts.size).toBeGreaterThan(1);

    // Protrusion1 — the first protrusion in import order (sidebar order in
    // the live app).
    const protrusion1 = imported.protrusion_part_ids[0];

    let anySucceeded = false;
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

        const panelBefore = bbox(store.getPart(targetPanel)!.outline);
        const areaBefore = shoelaceArea(store.getPart(targetPanel)!.outline);
        try {
          const result = dispatchGraphTool(store, 'fuse_bodies', {
            part_a_id: targetPanel,
            part_b_id: protrusion1,
          }) as { part_id: string };
          const areaAfter = shoelaceArea(requirePart(store, result.part_id).outline);
          // A real success must genuinely grow the panel's area, not just
          // report ok — this is the silent-wrong-fuse check the earlier
          // (reverted) mirror-fix regression needed and lacked.
          expect(areaAfter, `axis=${axis} target=${targetPanel} panelBefore=${JSON.stringify(panelBefore)}`)
            .toBeGreaterThan(areaBefore + 1.0);
          anySucceeded = true;
        } catch {
          // A genuinely unrelated/out-of-plane (panel, axis) pairing is
          // expected to fail — only inspected via anySucceeded below.
        } finally {
          store.restoreAll(before);
        }
      }
    }

    expect(
      anySucceeded,
      'at least one (axis, panel) pairing matching the live recipe (-76.6mm translate of '
        + 'Protrusion1) must fuse successfully and grow the target panel\'s real area — '
        + 'reproduces and confirms the fix for the live "2 faces despite 0mm gap" report',
    ).toBe(true);
  });
});
