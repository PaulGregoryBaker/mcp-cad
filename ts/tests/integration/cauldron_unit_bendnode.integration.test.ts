/**
 * Unit test: verify BendNode data (anchor/bendDir/foldNormal) correctly
 * describes the fold by checking that foldPt = anchor + bendZoneDxfX * bendDir
 * lands on the actual hinge line defined by the 3D shared vertices.
 *
 * If this test fails, computeBendGeometry produces wrong placement data.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

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

describe('[unit] BendNode placement data validation', () => {
  it('foldPt = anchor + bendZoneX * bendDir should lie on the hinge line defined by shared vertices', async () => {
    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) { console.warn('missing cauldron.step — skipping'); return; }

    // Split once.
    const txn: any = await dispatchTool('begin_transaction', { label: 'unit_bend' }, config);
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
      max_recursion_depth: 1, transaction_id: txn.transaction_id,
    }, config);
    const panelIds: string[] = split.panel_ids;

    // Build 3D vertex info for all panels.
    const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
    const panelVerts = new Map<string, Vec3[]>();
    for (const id of panelIds) {
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        const node = g.nodes.find((n: any) => n.type === 'PanelNode');
        if (!node?.panelFrame || !node?.shapeDxf) continue;
        const f = node.panelFrame;
        const ring = parseFirstClosedPolyline(node.shapeDxf);
        const pts = ring.slice(0, -1);
        panelVerts.set(id, pts.map(([x, y]: [number, number]) => [
          f.origin[0] + x * f.u[0] + y * f.v[0],
          f.origin[1] + x * f.u[1] + y * f.v[1],
          f.origin[2] + x * f.u[2] + y * f.v[2],
        ] as Vec3));
      } catch { /* */ }
    }

    // Find adjacent pairs and their shared vertices.
    const EDGE_TOL_MM = 5.0;
    type PairWithHinge = {
      idA: string; idB: string;
      hingeA: [Vec3, Vec3];
      hingeB: [Vec3, Vec3];
    };
    const pairs: PairWithHinge[] = [];
    const vertsArr = [...panelVerts.entries()];
    for (let i = 0; i < vertsArr.length; i++) {
      const [idA, va] = vertsArr[i]!;
      if (va.length !== 4) continue;
      for (let j = i + 1; j < vertsArr.length; j++) {
        const [idB, vb] = vertsArr[j]!;
        if (vb.length !== 4) continue;
        const sharedA: Vec3[] = [], sharedB: Vec3[] = [];
        const usedB = new Set<number>();
        for (const av of va) {
          for (let k = 0; k < vb.length; k++) {
            if (usedB.has(k)) continue;
            if (dist3(av, vb[k]!) < EDGE_TOL_MM) {
              sharedA.push(av); sharedB.push(vb[k]!); usedB.add(k); break;
            }
          }
        }
        if (sharedA.length >= 2) {
          pairs.push({ idA, idB, hingeA: [sharedA[0]!, sharedA[1]!], hingeB: [sharedB[0]!, sharedB[1]!] });
        }
      }
    }
    console.log(`Found ${pairs.length} adjacent pairs`);

    // Rollback the discovery transaction — merges need their own transactions.
    await dispatchTool('rollback_transaction', { transaction_id: txn.transaction_id }, config);

    if (pairs.length < 3) { console.warn('too few pairs — skipping'); return; }

    // Test each pair: fresh split → merge → validate BendNode.
    const results: string[] = [];
    for (let pi = 0; pi < Math.min(pairs.length, 6); pi++) {
      const pair = pairs[pi]!;
      const pt: any = await dispatchTool('begin_transaction', { label: `unit_bend_${pi}` }, config);
      try {
        // Fresh split
        const clean2: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
        const split2: any = await dispatchTool('split_body_by_bends', {
          part_id: clean2.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
          max_recursion_depth: 1, transaction_id: pt.transaction_id,
        }, config);

        // Match panels to this pair by vertex proximity
        const matchPanel = async (target: Vec3[]) => {
          for (const pid of split2.panel_ids) {
            try {
              const g2: any = await dispatchTool('query_graph', { part_id: pid }, config);
              const n2 = g2.nodes.find((n: any) => n.type === 'PanelNode');
              if (!n2?.panelFrame || !n2?.shapeDxf) continue;
              const f2 = n2.panelFrame;
              const r2 = parseFirstClosedPolyline(n2.shapeDxf);
              const pts2 = r2.slice(0, -1);
              const verts2 = pts2.map(([x2, y2]: [number,number]) => [
                f2.origin[0] + x2*f2.u[0] + y2*f2.v[0],
                f2.origin[1] + x2*f2.u[1] + y2*f2.v[1],
                f2.origin[2] + x2*f2.u[2] + y2*f2.v[2],
              ] as Vec3);
              if (verts2.length === target.length &&
                  target.every(tv => verts2.some(v2 => dist3(tv, v2) < 3.0))) {
                return pid;
              }
            } catch { /* */ }
          }
          return null;
        };

        const idA = await matchPanel(panelVerts.get(pair.idA) ?? []);
        const idB = await matchPanel(panelVerts.get(pair.idB) ?? []);
        if (!idA || !idB) { results.push(`pair ${pi}: panel re-identification failed`); continue; }

        const res: any = await dispatchTool('merge_bodies_with_bend', {
          transaction_id: pt.transaction_id,
          part_a_id: idA, part_b_id: idB,
          target_edges: ['all'], bend_radius: 1.0,
        }, config);

        const g: any = await dispatchTool('query_graph', { part_id: res.merged_part_id }, config);
        const bn = g.nodes.find((n: any) => n.type === 'BendNode');
        if (!bn?.anchor || !bn?.bendDir || bn.bendZoneDxfX === undefined) {
          results.push(`pair ${pi}: no BendNode data`);
          continue;
        }

        const anc = bn.anchor as number[];
        const bd = bn.bendDir as number[];
        const bzx = bn.bendZoneDxfX as number;

        // Compute foldPt from BendNode data
        const foldPt: Vec3 = [anc[0] + bzx * bd[0], anc[1] + bzx * bd[1], anc[2] + bzx * bd[2]];

        // Hinge line from shared vertices: passes through hingeA[0] with direction hingeA[1]-hingeA[0]
        const hingeDir: Vec3 = [
          pair.hingeA[1][0] - pair.hingeA[0][0],
          pair.hingeA[1][1] - pair.hingeA[0][1],
          pair.hingeA[1][2] - pair.hingeA[0][2],
        ];
        const hingeLen = Math.hypot(hingeDir[0], hingeDir[1], hingeDir[2]);
        if (hingeLen < 1e-6) { results.push(`pair ${pi}: degenerate hinge`); continue; }
        const hd: Vec3 = [hingeDir[0] / hingeLen, hingeDir[1] / hingeLen, hingeDir[2] / hingeLen];

        // Distance from foldPt to the hinge line
        const toFold: Vec3 = [foldPt[0] - pair.hingeA[0][0], foldPt[1] - pair.hingeA[0][1], foldPt[2] - pair.hingeA[0][2]];
        const alongHinge = toFold[0] * hd[0] + toFold[1] * hd[1] + toFold[2] * hd[2];
        const projOnLine: Vec3 = [
          pair.hingeA[0][0] + alongHinge * hd[0],
          pair.hingeA[0][1] + alongHinge * hd[1],
          pair.hingeA[0][2] + alongHinge * hd[2],
        ];
        const distToHinge = dist3(foldPt, projOnLine);

        const midHinge: Vec3 = [
          (pair.hingeA[0][0] + pair.hingeA[1][0]) / 2,
          (pair.hingeA[0][1] + pair.hingeA[1][1]) / 2,
          (pair.hingeA[0][2] + pair.hingeA[1][2]) / 2,
        ];

        if (distToHinge > 5.0) {
          results.push(`pair ${pi}: FAIL — foldPt ${distToHinge.toFixed(1)}mm from hinge line. foldPt=[${foldPt.map(x=>x.toFixed(1)).join(',')}] hingeMid=[${midHinge.map(x=>x.toFixed(1)).join(',')}]`);
        } else {
          results.push(`pair ${pi}: OK — foldPt ${distToHinge.toFixed(1)}mm from hinge line`);
        }
      } catch (e: any) {
        results.push(`pair ${pi}: merge error: ${e?.message?.split('\n')[0] ?? String(e)}`);
      } finally {
        await dispatchTool('rollback_transaction', { transaction_id: pt.transaction_id }, config);
      }
    }

    console.log(results.join('\n'));
    const failures = results.filter(r => r.includes('FAIL'));
    expect(failures.length, `BendNode data validation failures:\n${failures.join('\n')}`).toBe(0);
  }, 120_000);
});
