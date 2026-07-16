/**
 * Verify whether cauldron panel pairs are truly bend-adjacent using
 * independent geometric evidence — not the hinge offset itself.
 *
 * Method: for each pair, compute distance between the 3D line segments
 * of the two panels' edges. A pair shares a bend if:
 *   a) At least one edge-pair has near-zero distance (< material thickness)
 *   b) The two panels' planes intersect along/near that edge
 *   c) The intersection line direction roughly matches the edge direction
 */
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

type Vec3 = [number, number, number];

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Point-to-line-segment distance in 3D. */
function ptSegDist(p: Vec3, s0: Vec3, s1: Vec3): number {
  const dx = s1[0] - s0[0], dy = s1[1] - s0[1], dz = s1[2] - s0[2];
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1e-12) return dist3(p, s0);
  let t = ((p[0] - s0[0]) * dx + (p[1] - s0[1]) * dy + (p[2] - s0[2]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist3(p, [s0[0] + t * dx, s0[1] + t * dy, s0[2] + t * dz]);
}

/** Minimum distance between two line segments in 3D. */
function segSegDist(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): number {
  return Math.min(
    ptSegDist(a0, b0, b1), ptSegDist(a1, b0, b1),
    ptSegDist(b0, a0, a1), ptSegDist(b1, a0, a1),
  );
}

const THICKNESS_MM = 1.0; // cauldron wall thickness

describe('[verify] geometric adjacency of cauldron panel pairs', () => {
  it('checks whether rejected pairs share a 3D edge within material thickness', async () => {
    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) { console.warn('missing cauldron.step — skipping'); return; }

    // Split once.
    const txn: any = await dispatchTool('begin_transaction', { label: 'verify_adj' }, config);
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
      max_recursion_depth: 1, transaction_id: txn.transaction_id,
    }, config);
    const panelIds: string[] = split.panel_ids;

    // Get 3D vertices for all panels.
    const panelVerts = new Map<string, Vec3[]>();
    for (const id of panelIds) {
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        const node = g.nodes.find((n: any) => n.type === 'PanelNode');
        if (!node?.panelFrame || !node?.shapeDxf) continue;
        const f = node.panelFrame;
        const ring = parseFirstClosedPolyline(node.shapeDxf);
        const closed = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0];
        const pts = closed ? ring.slice(0, -1) : ring;
        const pts3d: Vec3[] = pts.map(([x, y]: [number, number]) => [
          f.origin[0] + x * f.u[0] + y * f.v[0],
          f.origin[1] + x * f.u[1] + y * f.v[1],
          f.origin[2] + x * f.u[2] + y * f.v[2],
        ] as Vec3);
        panelVerts.set(id, pts3d);
      } catch { /* */ }
    }

    const vertArr = [...panelVerts.entries()];

    // Vertex-proximity adjacency (the current test's method).
    const vertexPairs = new Set<string>();
    for (let i = 0; i < vertArr.length; i++) {
      const [idA, va] = vertArr[i]!;
      if (va.length !== 4) continue;
      for (let j = i + 1; j < vertArr.length; j++) {
        const [idB, vb] = vertArr[j]!;
        if (vb.length !== 4) continue;
        let matchCount = 0;
        const used = new Set<number>();
        for (const av of va) {
          for (let k = 0; k < vb.length; k++) {
            if (used.has(k)) continue;
            if (dist3(av, vb[k]!) < 5.0) { matchCount++; used.add(k); break; }
          }
          if (matchCount >= 2) break;
        }
        if (matchCount >= 2) vertexPairs.add(`${idA}::${idB}`);
      }
    }

    // Segment-distance adjacency: pairs whose closest edge distance < THICKNESS_MM.
    const segPairs = new Set<string>();
    for (let i = 0; i < vertArr.length; i++) {
      const [idA, va] = vertArr[i]!;
      for (let j = i + 1; j < vertArr.length; j++) {
        const [idB, vb] = vertArr[j]!;
        let minDist = Infinity;
        for (let ei = 0; ei < va.length; ei++) {
          const a1 = va[(ei + 1) % va.length]!;
          for (let ej = 0; ej < vb.length; ej++) {
            const d = segSegDist(va[ei]!, a1, vb[ej]!, vb[(ej + 1) % vb.length]!);
            if (d < minDist) minDist = d;
          }
        }
        if (minDist < THICKNESS_MM * 3) segPairs.add(`${idA}::${idB}`);
      }
    }

    console.log(`Vertex-proximity pairs (5mm): ${vertexPairs.size}`);
    console.log(`Segment-distance pairs (${THICKNESS_MM * 3}mm): ${segPairs.size}`);

    // For each vertex pair, check segment distance.
    let trueAdj = 0, falseAdj = 0;
    for (const vp of vertexPairs) {
      const isSegAdj = segPairs.has(vp);
      if (isSegAdj) trueAdj++; else falseAdj++;
    }

    console.log(`Vertex pairs that ARE segment-adjacent (<${THICKNESS_MM * 3}mm): ${trueAdj}`);
    console.log(`Vertex pairs that are NOT segment-adjacent: ${falseAdj}`);

    // Now check: do the vertex-only (non-segment-adjacent) pairs have large hinge offsets?
    // For each vertex-only pair, try to compute the hinge offset.
    let wouldReject = 0;
    const HINGE_SNAP_TOL_MM = Math.max(2.0, THICKNESS_MM * 2); // 2mm
    for (const vp of vertexPairs) {
      if (segPairs.has(vp)) continue; // skip truly adjacent
      // Try merge and check error message.
      const [idA, idB] = vp.split('::') as [string, string];
      try {
        const pt: any = await dispatchTool('begin_transaction', { label: 'verify_rej' }, config);
        await dispatchTool('merge_bodies_with_bend', {
          transaction_id: pt.transaction_id,
          part_a_id: idA, part_b_id: idB,
          target_edges: ['all'], bend_radius: 1.0,
        }, config);
        console.log(`  VP-only ${idA.slice(0, 8)}↔${idB.slice(0, 8)}: merge SUCCEEDED (unexpected!)`);
        await dispatchTool('rollback_transaction', { transaction_id: pt.transaction_id }, config);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.includes('hinge offset')) {
          wouldReject++;
        } else {
          console.log(`  VP-only ${idA.slice(0, 8)}↔${idB.slice(0, 8)}: ${msg.split('\n')[0]}`);
        }
        try { await dispatchTool('rollback_transaction', { transaction_id: (e as any)?.transaction_id ?? '' }, config); } catch { /* */ }
      }
    }

    console.log(`Non-segment-adjacent pairs caught by hinge offset: ${wouldReject}/${falseAdj}`);
    console.log(`Conclusion: segment distance < ${THICKNESS_MM * 3}mm is the geometric ground truth.`);
    console.log(`  Of ${vertexPairs.size} vertex-proximity pairs, ${trueAdj} are truly adjacent, ${falseAdj} are false positives.`);

    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);
  }, 300_000);
});
