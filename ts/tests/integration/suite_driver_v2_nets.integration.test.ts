/**
 * v2 driver for the core correctness suite's net-closure family (rebuild/suite/
 * cases/T3, 08-case-inventory.md §3.2) — Phase 5 Slice 2 (fold trees & perpendicular
 * folds).
 *
 * Authors each case's fold TREE (not a linear chain — a region panel may have
 * multiple children, e.g. the Latin-cross cube net's F1 branches to F2/L/R) via
 * the real v2 tool surface (create_part, create_node), exactly as
 * suite_driver_v2.integration.test.ts does for the C22 chain family.
 *
 * Construction is calibrated against a direct Evaluate()/ConstructPartSolid()-level
 * investigation test (cpp/tests/part_solid_construction_test.cc, "Latin-cross cube
 * net... closes at all 7 seams exactly" / "...builds one manifold cube"), confirmed
 * with zero NAPI/TS involved:
 *   - Every fold in a convex-polyhedron net is authored as a MOUNTAIN fold
 *     (angleDeg taken directly from the case's own fold.angleDeg, always positive
 *     for these cases) — never valley, for the same zero-pivot-offset reason as
 *     the C22 driver.
 *   - The DIRECTION a fold curls is carried entirely by hinge ENDPOINT ORDER, not
 *     by angleDeg sign: for a parent-to-child grid step (dx,dy) (one of the 4 unit
 *     axis directions), the hinge must run in direction (dy,-dx) — a fixed 90°
 *     clockwise rotation of the grid step. Verified by deriving this formula from
 *     hand-calibrated values for 3 of the 4 directions (north/east/west; south
 *     unverified but follows the same consistent rule) and cross-checking it
 *     reproduces the calibrated values exactly.
 *   - This session ALSO found and fixed a real bug in ClipHalfPlane (the region
 *     half-plane clip every case — including all 42 already-passing C22 cases —
 *     depends on): a region bounded by only one touching bend could clip to a
 *     degenerate polygon that bridges out to a SIBLING branch's far corners, when
 *     that sibling's own base edge happens to graze the clip line without crossing
 *     it (impossible for C22's simple rectangles; routine for branching nets). Not
 *     re-derived here — see manufacturing_graph_evaluator.cc's IsInside comment.
 *
 * Gated behind SUITE_V2_DRIVER=1 — needs the native binding built:
 *
 *   SUITE_V2_DRIVER=1 npx vitest run tests/integration/suite_driver_v2_nets
 *
 * Scope note: 12 cube-net cases exist today — net_cross_cube.json (Paul's
 * anchor case) plus 11 more (rebuild/suite/generator/net_family.mjs's own
 * comment has the full derivation), varying branch position, branch count,
 * and topology (staircases, multi-branch roots, a mirrored staircase, several
 * side-arm-row-position variants). This meets 08-case-inventory.md §3.2's
 * literal "cross->cube and the other 10 cube nets" bar in raw count, though
 * distinctness under the cube's own rotation/reflection symmetry group was
 * NOT formally verified — some of the 11 may be equivalent to another under
 * that symmetry (the generator's own header documents one case deliberately
 * left out for exactly this reason); any such redundancy is a coverage
 * inefficiency, not a correctness problem, since every case is independently
 * validated regardless. Each case's own "seams" oracle was derived
 * NUMERICALLY (auto-detected coincident open edges from the real evaluator's
 * own output, not independently re-derived from pure combinatorics the way
 * C22's checkpoints are) — a from-scratch symbolic cube-orientation solver
 * was attempted first and hit a real bug (edge tangent vs. face-normal
 * direction aren't simply negatives once faces are non-coplanar) that wasn't
 * worth chasing further given the available, still-meaningful independent
 * check: every one of these 12 different fold-tree topologies must construct
 * to the IDENTICAL 50x50x50 cube (bbox/volume) already independently
 * verified for net_cross_cube — exactly the property 08-case-inventory.md
 * §3.2 states this family exists to catch ("a model that is secretly
 * sequential or orientation-biased will pass some nets and fail others").
 * This check itself had a real bug found and fixed while generating these
 * cases: an initial loose volume range (10000-15000mm³) let one genuinely
 * invalid candidate ("zigzag-3-wide") pass with volume 12104 — tightened to
 * an exact-match epsilon against net_cross_cube's own verified 14408mm³,
 * which then correctly rejected it (see net_family.mjs's own comment).
 * Tetrahedron/pyramid/prism nets (non-square faces)
 * are a separate, larger follow-up — they need a schema/authoring extension
 * beyond the unit-square grid this driver's traceNetOutline assumes, not
 * just more case files.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart, constructPart } from '../../src/v2/graph/evaluate-client';
import type { NapiRegionPanelLayout } from '../../src/geometry/types';
import type { Point2 } from '../../src/v2/graph/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const SUITE_DIR = path.resolve(__dirname, '../../../rebuild/suite');

interface Profile {
  closureMm: number;
}
const profiles: Record<string, Profile> = JSON.parse(
  fs.readFileSync(path.join(SUITE_DIR, 'profiles.json'), 'utf8'),
) as Record<string, Profile>;

interface NetFold {
  parent: string;
  child: string;
  angleDeg: number;
}

interface AuthorNetOp {
  op: 'author_net';
  faceSizeMm: number;
  thicknessMm: number;
  root: string;
  faces: Record<string, [number, number]>;
  folds: NetFold[];
}

interface NetCase {
  id: string;
  toleranceProfile: string;
  ops: Array<AuthorNetOp | { op: string }>;
  oracles: [
    { type: 'net_closure'; budgetKey: string; seams: [string, string][] },
    { type: 'structure'; solidCount: number; typedError: string | null },
  ];
}

function loadT3NetCases(): NetCase[] {
  const dir = path.join(SUITE_DIR, 'cases', 'T3');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as NetCase)
    .filter((c) => c.ops.some((o) => o.op === 'author_net'));
}

function requirePanel(
  byId: Map<string, NapiRegionPanelLayout>,
  regionPanelId: string,
): NapiRegionPanelLayout {
  const panel = byId.get(regionPanelId);
  expect(panel, `region panel ${regionPanelId} must exist in the evaluated layout`).toBeDefined();
  return panel as NapiRegionPanelLayout;
}

function applyPose(
  pose: { r: number[]; t: number[] },
  p: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const r = pose.r;
  return {
    x: r[0] * p.x + r[1] * p.y + r[2] * p.z + pose.t[0],
    y: r[3] * p.x + r[4] * p.y + r[5] * p.z + pose.t[1],
    z: r[6] * p.x + r[7] * p.y + r[8] * p.z + pose.t[2],
  };
}

function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ─── Polyomino boundary trace: union of unit faceSizeMm squares at their grid ──
// positions -> the flat pattern's one shared outline. Each square contributes 4
// CCW directed edges; an edge shared by two adjacent squares is traversed in
// OPPOSITE directions by each, so it cancels — the survivors chain into the
// outer boundary. Standard technique, general for any simply-connected
// polyomino (any net this schema can express), not special-cased to the cross.

function traceNetOutline(faces: Record<string, [number, number]>, faceSizeMm: number): Point2[] {
  const s = faceSizeMm;
  const pointKey = (p: Point2): string => `${p.x},${p.y}`;
  const survivors = new Map<string, { a: Point2; b: Point2 }>();

  const addEdge = (a: Point2, b: Point2): void => {
    const forwardKey = `${pointKey(a)}|${pointKey(b)}`;
    const reverseKey = `${pointKey(b)}|${pointKey(a)}`;
    if (survivors.has(reverseKey)) {
      survivors.delete(reverseKey);
    } else {
      survivors.set(forwardKey, { a, b });
    }
  };

  for (const [gx, gy] of Object.values(faces)) {
    const x0 = gx * s;
    const y0 = gy * s;
    const x1 = x0 + s;
    const y1 = y0 + s;
    addEdge({ x: x0, y: y0 }, { x: x1, y: y0 });
    addEdge({ x: x1, y: y0 }, { x: x1, y: y1 });
    addEdge({ x: x1, y: y1 }, { x: x0, y: y1 });
    addEdge({ x: x0, y: y1 }, { x: x0, y: y0 });
  }

  const byStart = new Map<string, { a: Point2; b: Point2 }>();
  for (const edge of survivors.values()) byStart.set(pointKey(edge.a), edge);

  const first = survivors.values().next();
  expect(first.done, 'traceNetOutline: no boundary edges found').toBe(false);
  const startKey = pointKey((first.value as { a: Point2; b: Point2 }).a);

  const loop: Point2[] = [];
  let currentKey = startKey;
  do {
    const edge = byStart.get(currentKey);
    expect(edge, 'traceNetOutline: boundary is not a single closed loop').toBeDefined();
    const e = edge as { a: Point2; b: Point2 };
    loop.push(e.a);
    currentKey = pointKey(e.b);
  } while (currentKey !== startKey);

  return loop;
}

// ─── Hinge from a parent->child grid step (schema.md's net encoding) ────────

function computeHinge(
  parentGrid: [number, number],
  childGrid: [number, number],
  faceSizeMm: number,
): { hingeA: Point2; hingeB: Point2 } {
  const s = faceSizeMm;
  const [px, py] = parentGrid;
  const dx = childGrid[0] - px;
  const dy = childGrid[1] - py;

  let edgeA: Point2;
  let edgeB: Point2;
  if (dx === 0 && dy === 1) {
    edgeA = { x: px * s, y: (py + 1) * s };
    edgeB = { x: (px + 1) * s, y: (py + 1) * s };
  } else if (dx === 0 && dy === -1) {
    edgeA = { x: px * s, y: py * s };
    edgeB = { x: (px + 1) * s, y: py * s };
  } else if (dx === 1 && dy === 0) {
    edgeA = { x: (px + 1) * s, y: py * s };
    edgeB = { x: (px + 1) * s, y: (py + 1) * s };
  } else if (dx === -1 && dy === 0) {
    edgeA = { x: px * s, y: py * s };
    edgeB = { x: px * s, y: (py + 1) * s };
  } else {
    throw new Error(`computeHinge: parent/child must be grid-adjacent, got dx=${dx} dy=${dy}`);
  }

  // Required hinge direction (hingeB - hingeA) = rotate((dx,dy), -90deg) = (dy,-dx).
  const wantDx = dy;
  const wantDy = -dx;
  const actualDx = edgeB.x - edgeA.x;
  const actualDy = edgeB.y - edgeA.y;
  const dot = actualDx * wantDx + actualDy * wantDy;
  return dot > 0 ? { hingeA: edgeA, hingeB: edgeB } : { hingeA: edgeB, hingeB: edgeA };
}

/** Authors one case's fold tree via the real v2 tool surface (BFS, parent before child). */
function authorNet(
  store: GraphStore,
  op: AuthorNetOp,
): { partId: string; regionPanelIdByFace: Map<string, string> } {
  const outline = traceNetOutline(op.faces, op.faceSizeMm);
  const createPartResult = dispatchGraphTool(store, 'create_part', {
    name: `net-${op.root}`,
    outline,
    thickness_mm: op.thicknessMm,
  }) as { part_id: string; root_region_panel_id: string };

  const partId = createPartResult.part_id;
  const regionPanelIdByFace = new Map<string, string>([
    [op.root, createPartResult.root_region_panel_id],
  ]);

  const foldsByParent = new Map<string, NetFold[]>();
  for (const fold of op.folds) {
    const list = foldsByParent.get(fold.parent) ?? [];
    list.push(fold);
    foldsByParent.set(fold.parent, list);
  }

  const queue = [op.root];
  while (queue.length > 0) {
    const parentFace = queue.shift() as string;
    for (const fold of foldsByParent.get(parentFace) ?? []) {
      const { hingeA, hingeB } = computeHinge(
        op.faces[fold.parent],
        op.faces[fold.child],
        op.faceSizeMm,
      );
      const createNodeResult = dispatchGraphTool(store, 'create_node', {
        kind: 'bend',
        part_id: partId,
        parent_region_panel_id: regionPanelIdByFace.get(fold.parent),
        hinge_a: hingeA,
        hinge_b: hingeB,
        angle_deg: fold.angleDeg,
        radius_mm: 0,
        k_factor: 0,
      }) as { bend_id: string; child_region_panel_id: string };
      regionPanelIdByFace.set(fold.child, createNodeResult.child_region_panel_id);
      queue.push(fold.child);
    }
  }

  return { partId, regionPanelIdByFace };
}

/** face:cardinal (schema.md's net edge naming) -> that edge's LOCAL 2D endpoints. */
function edgeRefPoints(
  ref: string,
  faces: Record<string, [number, number]>,
  faceSizeMm: number,
): { face: string; a: Point2; b: Point2 } {
  const [face, cardinal] = ref.split(':');
  const [gx, gy] = faces[face];
  const s = faceSizeMm;
  const x0 = gx * s;
  const y0 = gy * s;
  const x1 = x0 + s;
  const y1 = y0 + s;
  switch (cardinal) {
    case 'N':
      return { face, a: { x: x0, y: y1 }, b: { x: x1, y: y1 } };
    case 'S':
      return { face, a: { x: x0, y: y0 }, b: { x: x1, y: y0 } };
    case 'E':
      return { face, a: { x: x1, y: y0 }, b: { x: x1, y: y1 } };
    case 'W':
      return { face, a: { x: x0, y: y0 }, b: { x: x0, y: y1 } };
    default:
      throw new Error(`edgeRefPoints: unknown cardinal "${cardinal}" in "${ref}"`);
  }
}

d('core correctness suite — v2 driver (net closure, fold trees + perpendicular folds)', () => {
  const cases = loadT3NetCases();
  expect(cases.length).toBeGreaterThan(0);

  for (const c of cases) {
    it(c.id, () => {
      const budget = profiles[c.toleranceProfile].closureMm;
      const authorOp = c.ops.find((o) => o.op === 'author_net') as AuthorNetOp;

      const store = new GraphStore();
      const { partId, regionPanelIdByFace } = authorNet(store, authorOp);

      // "construct" op — proxy for the structure oracle (solidCount:1,
      // typedError:null), same convention as suite_driver_v2's C22 driver.
      const constructResult = constructPart(store, partId);
      expect(constructResult.ok, constructResult.message).toBe(true);
      expect(constructResult.shellId).toBeTruthy();

      const evalResult = evaluatePart(store, partId);
      expect(evalResult.ok, evalResult.message).toBe(true);
      const byId = new Map<string, NapiRegionPanelLayout>(
        evalResult.panels.map((p) => [p.regionPanelId, p]),
      );

      let worst = 0;
      for (const [ref1, ref2] of c.oracles[0].seams) {
        const e1 = edgeRefPoints(ref1, authorOp.faces, authorOp.faceSizeMm);
        const e2 = edgeRefPoints(ref2, authorOp.faces, authorOp.faceSizeMm);
        const panel1 = requirePanel(byId, regionPanelIdByFace.get(e1.face) as string);
        const panel2 = requirePanel(byId, regionPanelIdByFace.get(e2.face) as string);
        const w1a = applyPose(panel1.pose, { x: e1.a.x, y: e1.a.y, z: 0 });
        const w1b = applyPose(panel1.pose, { x: e1.b.x, y: e1.b.y, z: 0 });
        const w2a = applyPose(panel2.pose, { x: e2.a.x, y: e2.a.y, z: 0 });
        const w2b = applyPose(panel2.pose, { x: e2.b.x, y: e2.b.y, z: 0 });
        const dSame = Math.max(dist3(w1a, w2a), dist3(w1b, w2b));
        const dSwap = Math.max(dist3(w1a, w2b), dist3(w1b, w2a));
        worst = Math.max(worst, Math.min(dSame, dSwap));
      }

      console.log(`[suite:${c.id}] worst seam residual ${worst.toFixed(6)} mm (budget ${budget})`);
      expect(worst).toBeLessThanOrEqual(budget);
    });
  }
});
