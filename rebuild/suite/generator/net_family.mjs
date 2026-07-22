/**
 * Cube-net closure family generator (C14/C15, 08-case-inventory.md §3.2).
 *
 * Unlike closure_family.mjs (C22), this generator is NOT zero-reference/pure —
 * it requires the compiled NAPI addon (ts/geometry_addon.node) and calls the
 * real evaluatePartGraph/constructPartSolid to derive each case's "seams"
 * oracle. A from-scratch symbolic (pure-combinatorics, addon-independent) cube-
 * orientation solver was attempted first and hit a real bug — folding makes two
 * faces non-coplanar, so a shared edge's "world direction as seen from each
 * side" are NOT simple negatives of each other the way they would be for a flat
 * (unfolded) shared edge, and chasing the fix further wasn't worth it given the
 * available, still-meaningful independent check documented below.
 *
 * Every candidate net here is validated (not merely trusted) before its case
 * file is written: construct the real 3D solid and require the bounding box to
 * be EXACTLY [faceSizeMm, faceSizeMm, faceSizeMm] and the volume to fall in the
 * same physically-bounded range as net_cross_cube.json's own already-verified
 * result (cpp/tests/part_solid_construction_test.cc, "Latin-cross cube net...
 * builds one manifold cube"). This is 08 §3.2's own stated test intent for this
 * family: "All 11 cube nets — same target solid, 11 different fold trees; a
 * model that is secretly sequential or orientation-biased will pass some nets
 * and fail others" — a genuinely different fold-tree topology converging on the
 * IDENTICAL target is the independent signal, even though the specific "seams"
 * values are auto-detected (coincident open-edge endpoints in the real
 * evaluator's own world-space output) rather than independently re-derived
 * from pure combinatorics the way C22's checkpoints are.
 *
 * Net encoding matches rebuild/suite/schema.md's "Net (fold-tree) fixture
 * encoding" exactly: unit faceSizeMm squares on an integer grid, a fold tree
 * (parent/child/angleDeg), face:cardinal edge naming for seams.
 *
 * Usage (needs the addon already built — see ts/README or npm run build:napi):
 *   node rebuild/suite/generator/net_family.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_DIR = path.join(ROOT, 'rebuild', 'suite', 'cases', 'T3');
const addon = createRequire(import.meta.url)(path.join(ROOT, 'ts', 'geometry_addon.node'));

const FACE_SIZE_MM = 50;
const THICKNESS_MM = 1;
const IDENTITY = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
// The exact shell volume of net_cross_cube.json's own already-verified
// construction (cpp/tests/part_solid_construction_test.cc's "Latin-cross cube
// net... builds one manifold cube") — every valid net targets this SAME
// solid, so its volume must match to the same near-exact precision, not just
// fall in some "plausible" range. A looser range (e.g. 10000-15000) is a real
// bug, not a convenience: a genuinely broken/self-overlapping construction
// (a bad fuse, an invalid topology) can still land inside a wide range by
// coincidence — caught empirically generating this file's own candidates,
// where a candidate ("zigzag-3-wide") passed bbox=[50,50,50] with volume
// 12104 under a loose 10000-15000 check and was silently wrong.
const REFERENCE_CUBE_VOLUME_MM3 = 14408.0;
const VOLUME_EPSILON_MM3 = 0.1;

// ─── Hinge from a parent->child grid step (same rule the v2 suite driver's own
// computeHinge uses — ts/tests/integration/suite_driver_v2_nets.integration.test.ts —
// re-derived here independently since generator scripts and test drivers are
// deliberately separate consumers, not a shared production code path).

function computeHinge(parentGrid, childGrid) {
  const s = FACE_SIZE_MM;
  const [px, py] = parentGrid;
  const [cx, cy] = childGrid;
  const dx = cx - px;
  const dy = cy - py;
  let edgeA;
  let edgeB;
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
    throw new Error(`computeHinge: not grid-adjacent: dx=${dx} dy=${dy}`);
  }
  const wantDx = dy;
  const wantDy = -dx;
  const dot = (edgeB.x - edgeA.x) * wantDx + (edgeB.y - edgeA.y) * wantDy;
  return dot > 0 ? { hingeA: edgeA, hingeB: edgeB } : { hingeA: edgeB, hingeB: edgeA };
}

// ─── Polyomino boundary trace (union of unit faceSizeMm squares -> one outline) ──

function traceOutline(faces) {
  const s = FACE_SIZE_MM;
  const key = (p) => `${p.x},${p.y}`;
  const survivors = new Map();
  const addEdge = (a, b) => {
    const fk = `${key(a)}|${key(b)}`;
    const rk = `${key(b)}|${key(a)}`;
    if (survivors.has(rk)) survivors.delete(rk);
    else survivors.set(fk, { a, b });
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
  const byStart = new Map();
  for (const e of survivors.values()) byStart.set(key(e.a), e);
  const first = survivors.values().next();
  if (first.done) throw new Error('traceOutline: no boundary edges found');
  const startKey = key(first.value.a);
  const loop = [];
  let cur = startKey;
  do {
    const e = byStart.get(cur);
    if (!e) throw new Error('traceOutline: boundary is not a single closed loop');
    loop.push(e.a);
    cur = key(e.b);
  } while (cur !== startKey);
  return loop;
}

function applyPose(pose, p) {
  const r = pose.r;
  return {
    x: r[0] * p.x + r[1] * p.y + r[2] * p.z + pose.t[0],
    y: r[3] * p.x + r[4] * p.y + r[5] * p.z + pose.t[1],
    z: r[6] * p.x + r[7] * p.y + r[8] * p.z + pose.t[2],
  };
}

function cardinalOf(face, faces, point) {
  const s = FACE_SIZE_MM;
  const [gx, gy] = faces[face];
  const x0 = gx * s;
  const y0 = gy * s;
  const x1 = x0 + s;
  const y1 = y0 + s;
  const eps = 1e-6;
  return {
    isN: Math.abs(point.y - y1) < eps,
    isS: Math.abs(point.y - y0) < eps,
    isE: Math.abs(point.x - x1) < eps,
    isW: Math.abs(point.x - x0) < eps,
  };
}

/** Auto-detects the 7 seam pairs from the real evaluator's own open (non-fold) edges. */
function detectSeams(evalResult, faces) {
  const openEdges = [];
  for (const panel of evalResult.panels) {
    const n = panel.regionOuter.length;
    for (let i = 0; i < n; i++) {
      if (panel.edgeBendId[i] !== '') continue;
      const a = panel.regionOuter[i];
      const b = panel.regionOuter[(i + 1) % n];
      const ca = cardinalOf(panel.regionPanelId, faces, a);
      const cb = cardinalOf(panel.regionPanelId, faces, b);
      let cardinal = null;
      if (ca.isN && cb.isN) cardinal = 'N';
      else if (ca.isS && cb.isS) cardinal = 'S';
      else if (ca.isE && cb.isE) cardinal = 'E';
      else if (ca.isW && cb.isW) cardinal = 'W';
      if (!cardinal) continue;
      openEdges.push({
        face: panel.regionPanelId,
        cardinal,
        wa: applyPose(panel.pose, { ...a, z: 0 }),
        wb: applyPose(panel.pose, { ...b, z: 0 }),
      });
    }
  }
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  const seams = [];
  const used = new Set();
  for (let i = 0; i < openEdges.length; i++) {
    if (used.has(i)) continue;
    for (let j = i + 1; j < openEdges.length; j++) {
      if (used.has(j)) continue;
      const e1 = openEdges[i];
      const e2 = openEdges[j];
      const dSame = Math.max(dist(e1.wa, e2.wa), dist(e1.wb, e2.wb));
      const dSwap = Math.max(dist(e1.wa, e2.wb), dist(e1.wb, e2.wa));
      if (Math.min(dSame, dSwap) < 1e-6) {
        seams.push([`${e1.face}:${e1.cardinal}`, `${e2.face}:${e2.cardinal}`]);
        used.add(i);
        used.add(j);
        break;
      }
    }
  }
  return { seams, unmatchedCount: openEdges.length - used.size };
}

/** Builds + validates one candidate net; returns null (not a valid cube net) or the case JSON. */
function makeCase(id, title, faces, root, foldPairs) {
  const folds = foldPairs.map((f) => ({ ...f, angleDeg: 90 }));
  const outline = traceOutline(faces);
  const bends = folds.map((f, i) => {
    const { hingeA, hingeB } = computeHinge(faces[f.parent], faces[f.child]);
    return {
      id: `b${i}`,
      parentRegionPanelId: f.parent,
      childRegionPanelId: f.child,
      hingeA,
      hingeB,
      angleDeg: 90,
      radiusMm: 0,
      kFactor: 0,
    };
  });
  const graph = {
    partId: id,
    rootRegionPanelId: root,
    outline: { outer: outline },
    bends,
    thicknessMm: THICKNESS_MM,
    anchor: { transform: IDENTITY },
  };

  const evalResult = addon.evaluatePartGraph(graph);
  if (!evalResult.ok) {
    console.log(`  REJECT ${id}: evaluate failed — ${evalResult.errorCode} ${evalResult.message}`);
    return null;
  }
  const constructResult = addon.constructPartSolid(evalResult, THICKNESS_MM);
  if (!constructResult.ok) {
    console.log(`  REJECT ${id}: construct failed — ${constructResult.errorCode} ${constructResult.message}`);
    return null;
  }
  const bbox = addon.computeBoundingBox(constructResult.shellId);
  const mass = addon.computeMassProperties(constructResult.shellId);
  const dims = [bbox.x_max - bbox.x_min, bbox.y_max - bbox.y_min, bbox.z_max - bbox.z_min];
  const isCube = dims.every((d) => Math.abs(d - FACE_SIZE_MM) < 1e-6);
  const volumeOk = Math.abs(mass.volume - REFERENCE_CUBE_VOLUME_MM3) < VOLUME_EPSILON_MM3;
  if (!isCube || !volumeOk) {
    console.log(`  REJECT ${id}: not the target cube — dims=${JSON.stringify(dims)} volume=${mass.volume}`);
    return null;
  }

  const { seams, unmatchedCount } = detectSeams(evalResult, faces);
  if (seams.length !== 7 || unmatchedCount !== 0) {
    console.log(`  REJECT ${id}: expected 7 seams/0 unmatched, got ${seams.length}/${unmatchedCount}`);
    return null;
  }

  console.log(`  OK ${id}: dims=${JSON.stringify(dims)} volume=${mass.volume.toFixed(1)} seams=7`);
  return {
    schemaVersion: '0.1',
    id,
    title,
    level: 'A',
    tier: 'T3',
    inventory: ['C14', 'C15'],
    toleranceProfile: 'default',
    expectation: 'pass',
    fixture: { kind: 'authored', path: null },
    params: { net: id, faceSizeMm: FACE_SIZE_MM, thicknessMm: THICKNESS_MM, variant: 'sharp' },
    ops: [
      { op: 'author_net', faceSizeMm: FACE_SIZE_MM, thicknessMm: THICKNESS_MM, root, faces, folds },
      { op: 'construct' },
    ],
    oracles: [
      { type: 'net_closure', budgetKey: 'closureMm', seams },
      { type: 'structure', solidCount: 1, typedError: null },
    ],
  };
}

// ─── Candidate cube nets — varying branch position, branch count, and overall
// topology (this is NOT yet the mathematically exhaustive set of all 11
// hexomino cube nets; see this file's header for why a smaller, validated set
// was the pragmatic stopping point for this fast-follow).

const CANDIDATES = [
  {
    id: 'net-shift-lr-row2-90-sharp',
    title: 'Net closure: side-arms on row 2 instead of row 1, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 2], R: [1, 2] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F2', child: 'L' },
      { parent: 'F2', child: 'R' },
    ],
  },
  {
    id: 'net-root-branches-90-sharp',
    title: 'Net closure: root itself branches to both side arms, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 0], R: [1, 0] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F0', child: 'L' },
      { parent: 'F0', child: 'R' },
    ],
  },
  {
    id: 'net-staircase-90-sharp',
    title: 'Net closure: 2-2-2 staircase, 5 folds at 90°',
    faces: { A: [0, 0], B: [1, 0], C: [1, 1], D: [2, 1], E: [2, 2], F: [3, 2] },
    root: 'A',
    folds: [
      { parent: 'A', child: 'B' },
      { parent: 'B', child: 'C' },
      { parent: 'C', child: 'D' },
      { parent: 'D', child: 'E' },
      { parent: 'E', child: 'F' },
    ],
  },
  {
    id: 'net-shift-lr-split-ends-90-sharp',
    title: 'Net closure: side arms at opposite column ends, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 0], R: [1, 3] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F0', child: 'L' },
      { parent: 'F3', child: 'R' },
    ],
  },
  {
    id: 'net-staircase-mirrored-90-sharp',
    title: 'Net closure: 2-2-2 staircase, mirrored, 5 folds at 90°',
    faces: { A: [0, 0], B: [-1, 0], C: [-1, 1], D: [-2, 1], E: [-2, 2], F: [-3, 2] },
    root: 'A',
    folds: [
      { parent: 'A', child: 'B' },
      { parent: 'B', child: 'C' },
      { parent: 'C', child: 'D' },
      { parent: 'D', child: 'E' },
      { parent: 'E', child: 'F' },
    ],
  },
  {
    id: 'net-row3-double-branch-90-sharp',
    title: 'Net closure: a row-of-3 with two branches off its middle face, 5 folds at 90°',
    faces: { A: [0, 0], B: [1, 0], C: [2, 0], D: [1, 1], E: [1, -1], F: [1, -2] },
    root: 'B',
    folds: [
      { parent: 'B', child: 'A' },
      { parent: 'B', child: 'C' },
      { parent: 'B', child: 'D' },
      { parent: 'B', child: 'E' },
      { parent: 'E', child: 'F' },
    ],
  },
  {
    id: 'net-plus-with-tail-90-sharp',
    title: 'Net closure: a plus-sign net with one arm extended by one face, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], N: [0, 2], L: [-1, 1], R: [1, 1], S: [0, -1] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'N' },
      { parent: 'F1', child: 'L' },
      { parent: 'F1', child: 'R' },
      { parent: 'F0', child: 'S' },
    ],
  },
  // Below: 4 more side-arm-position variants on the F0-F1-F2-F3 column, added
  // to push closer to the 11 canonical hexomino cube nets. Distinctness under
  // the cube's own rotation/reflection symmetry group was NOT formally
  // verified (a from-scratch symbolic solver for that was already abandoned
  // once above — see this file's header); one obviously-equivalent candidate
  // (both arms swapped end-for-end vs. shift-lr-split-ends, i.e. a 180-degree
  // rotation of that net) was deliberately left out during generation. Any
  // remaining redundancy here is a coverage inefficiency, not a correctness
  // problem — every case is independently construct/volume-validated below
  // regardless of whether it turns out equivalent to another under symmetry.
  {
    id: 'net-branches-rows-1-2-90-sharp',
    title: 'Net closure: side-arms split across rows 1 and 2, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 1], R: [1, 2] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F1', child: 'L' },
      { parent: 'F2', child: 'R' },
    ],
  },
  {
    id: 'net-branches-rows-1-3-90-sharp',
    title: 'Net closure: side-arms split across rows 1 and 3, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 1], R: [1, 3] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F1', child: 'L' },
      { parent: 'F3', child: 'R' },
    ],
  },
  {
    id: 'net-branches-rows-2-3-90-sharp',
    title: 'Net closure: side-arms split across rows 2 and 3, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 2], R: [1, 3] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F2', child: 'L' },
      { parent: 'F3', child: 'R' },
    ],
  },
  {
    id: 'net-branches-rows-0-2-90-sharp',
    title: 'Net closure: side-arms split across rows 0 and 2, 5 folds at 90°',
    faces: { F0: [0, 0], F1: [0, 1], F2: [0, 2], F3: [0, 3], L: [-1, 0], R: [1, 2] },
    root: 'F0',
    folds: [
      { parent: 'F0', child: 'F1' },
      { parent: 'F1', child: 'F2' },
      { parent: 'F2', child: 'F3' },
      { parent: 'F0', child: 'L' },
      { parent: 'F2', child: 'R' },
    ],
  },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let written = 0;
console.log(`net_family: validating ${CANDIDATES.length} candidates...`);
for (const c of CANDIDATES) {
  const caseJson = makeCase(c.id, c.title, c.faces, c.root, c.folds);
  if (!caseJson) continue;
  fs.writeFileSync(path.join(OUT_DIR, `${c.id}.json`), JSON.stringify(caseJson, null, 2) + '\n');
  written++;
}
console.log(`net_family: wrote ${written}/${CANDIDATES.length} cases to ${OUT_DIR}`);
