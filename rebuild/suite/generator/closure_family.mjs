/**
 * Polygon closure family generator (C22, 08-case-inventory §3.1).
 *
 * A flat strip of N equal segments with N−1 parallel bends of the polygon exterior
 * angle (360°/N) closes into a regular-N-gon prism: both strip ends map to the same
 * 3D location. Zero-reference oracle — every expected value below is analytic.
 *
 * Local frame convention (panel-0 frame):
 *   - Bend lines parallel to +Y (strip width w runs along Y).
 *   - The polygon lives in the XZ plane; segment 0 heads +X from the origin.
 *   - "up" bends turn toward +Z; "down" toward −Z (mirror closure).
 *
 * After k of the N−1 bends (folds applied in strip order), segments 0..k follow the
 * polygon headings and segments k+1..N−1 continue straight with heading k:
 *   heading d_j = (cos(j·θ·s), 0, sin(j·θ·s)),  θ = 2π/N, s = ±1 (up/down)
 *   vertex  V_k = Σ_{j<k} L·d_j
 *   free end E_k = V_k + (N−k)·L·d_k
 * Closure: E_{N−1} = V_N = (0,0,0) — the end edge coincides with the start edge.
 *
 * Deterministic output: stable key order, fixed precision — re-runs are diff-clean.
 *
 * Usage: node rebuild/suite/generator/closure_family.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'T2');

const NS = [3, 4, 5, 6, 7, 8, 9];
const DIRS = ['up', 'down'];
// Pose sweep: expectations are panel-0-frame, so these change NOTHING in the oracles —
// that invariance is itself the point (schema.md rule 3).
const POSES = [
  { name: 'rot000', rotDeg: 0, offsetMm: [0, 0] },
  { name: 'rot030', rotDeg: 30, offsetMm: [0, 0] },
  { name: 'rot137', rotDeg: 137, offsetMm: [250, -80] },
];
const SEGMENT_LEN_MM = 60;
const WIDTH_MM = 40;
const THICKNESS_MM = 1;
const PRECISION = 9; // decimal places in emitted coordinates

const round = (v) => {
  const r = Number(v.toFixed(PRECISION));
  return Object.is(r, -0) ? 0 : r;
};

function checkpoints(N, dirSign, L, w) {
  const theta = (2 * Math.PI) / N;
  const d = (j) => [Math.cos(j * theta), 0, dirSign * Math.sin(j * theta)];
  const out = [];
  let vx = 0, vz = 0; // V_k accumulator
  for (let k = 1; k <= N - 1; k++) {
    const dPrev = d(k - 1);
    vx += L * dPrev[0];
    vz += L * dPrev[2];
    const dk = d(k);
    const ex = vx + (N - k) * L * dk[0];
    const ez = vz + (N - k) * L * dk[2];
    out.push({
      afterBend: k,
      endCorners: [
        [round(ex), 0, round(ez)],
        [round(ex), round(w), round(ez)],
      ],
    });
  }
  return out;
}

function makeCase(N, dir, pose) {
  const dirSign = dir === 'up' ? 1 : -1;
  const id = `c22-n${N}-${dir}-${pose.name}-sharp`;
  const bendDeg = round(360 / N);
  return {
    schemaVersion: '0.1',
    id,
    title: `Polygon closure: N=${N} (${bendDeg}° bends ${dir}), pose ${pose.name}, sharp folds`,
    level: 'A',
    tier: 'T2',
    inventory: ['C22'],
    toleranceProfile: 'default',
    expectation: 'pass',
    fixture: { kind: 'authored', path: null },
    params: {
      N,
      bendDeg,
      segmentLenMm: SEGMENT_LEN_MM,
      widthMm: WIDTH_MM,
      thicknessMm: THICKNESS_MM,
      bendDir: dir,
      variant: 'sharp',
    },
    ops: [
      {
        op: 'author_strip',
        N,
        segmentLenMm: SEGMENT_LEN_MM,
        widthMm: WIDTH_MM,
        thicknessMm: THICKNESS_MM,
        bendDir: dir,
        pose: { rotDeg: pose.rotDeg, offsetMm: pose.offsetMm },
      },
      { op: 'construct' },
      { op: 'map_strip_ends' },
    ],
    oracles: [
      {
        type: 'closure',
        budgetKey: 'closureMm',
        checkpoints: checkpoints(N, dirSign, SEGMENT_LEN_MM, WIDTH_MM),
        finalCoincidentWithStart: true,
      },
      { type: 'structure', solidCount: 1, typedError: null },
    ],
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let count = 0;
for (const N of NS) {
  for (const dir of DIRS) {
    for (const pose of POSES) {
      const c = makeCase(N, dir, pose);
      fs.writeFileSync(path.join(OUT_DIR, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
      count++;
    }
  }
}
console.log(`closure_family: wrote ${count} cases to ${OUT_DIR}`);
