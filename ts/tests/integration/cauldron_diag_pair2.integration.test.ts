/**
 * Diagnostic: investigate pair 2's 138mm y_min bbox error.
 *
 * Pair 2: A[2178,-2383,-895|2007,-3191,-824|836,-3191,-2002|908,-2383,-2173]
 *         ↔ B[-895,-2383,-2178|908,-2382,-2173|837,-3190,-2002|-824,-3191,-2007]
 *
 * These share 2 vertices: (908,-2383,-2173)≈(908,-2382,-2173) and (836,-3191,-2002)≈(837,-3190,-2002).
 * Expected union y_min = -3191.0, got y_min = -3329.1 (Δ138mm).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getGeometryBinding } from '../../src/mcp/state';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

type Vec3 = [number, number, number];
type Bbox = { x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number };

function dot3(a: Vec3, b: Vec3): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function sub3(a: Vec3, b: Vec3): Vec3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }

describe('[diag] pair 2 bbox error investigation', () => {
  it('captures full debug data for pair 2 and a passing reference pair', async () => {
    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) { console.warn('missing cauldron.step — skipping'); return; }

    const txn: any = await dispatchTool('begin_transaction', { label: 'diag_pair2' }, config);
    const txId = txn.transaction_id;

    // Split
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
      max_recursion_depth: 1, transaction_id: txId,
    }, config);
    const panelIds: string[] = split.panel_ids;

    // Get 3D vertices and identify panels
    const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
    const panelData = new Map<string, { verts: Vec3[]; frame: any; dxf: string }>();
    for (const id of panelIds) {
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        const node = g.nodes.find((n: any) => n.type === 'PanelNode');
        if (!node?.panelFrame || !node?.shapeDxf) continue;
        const f = node.panelFrame;
        const ring = parseFirstClosedPolyline(node.shapeDxf);
        const pts = ring.slice(0, -1);
        const pts3d = pts.map(([x, y]: [number, number]) => [
          f.origin[0] + x*f.u[0] + y*f.v[0],
          f.origin[1] + x*f.u[1] + y*f.v[1],
          f.origin[2] + x*f.u[2] + y*f.v[2],
        ] as Vec3);
        panelData.set(id, { verts: pts3d, frame: f, dxf: node.shapeDxf });
      } catch { /* */ }
    }

    // Target vertices for pair 2
    const targetAVerts: Vec3[] = [
      [2178, -2383, -895], [2007, -3191, -824], [836, -3191, -2002], [908, -2383, -2173],
    ];
    const targetBVerts: Vec3[] = [
      [-895, -2383, -2178], [908, -2382, -2173], [837, -3190, -2002], [-824, -3191, -2007],
    ];

    // Match panels by vertex proximity — reuse the same logic as the main test.
    const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
    const matchPanel = (target: Vec3[]): string | null => {
      let bestId: string | null = null, bestDist = Infinity;
      for (const [id, data] of panelData) {
        if (data.verts.length !== target.length) continue;
        let maxDist = 0;
        for (const tv of target) {
          let minD = Infinity;
          for (const dv of data.verts) { const d = dist3(tv, dv); if (d < minD) minD = d; }
          if (minD > maxDist) maxDist = minD;
        }
        if (maxDist < bestDist) { bestDist = maxDist; bestId = id; }
      }
      return bestId && bestDist < 5 ? bestId : null;
    };

    const idA = matchPanel(targetAVerts);
    const idB = matchPanel(targetBVerts);
    if (!idA || !idB) {
      // Fallback: find by iterating pairs — the first few pairs are deterministic.
      console.log('Direct match failed, finding by pair enumeration...');
      // Build adjacency from vertex proximity
      type PInfo = { id: string; verts: Vec3[] };
      const infos: PInfo[] = [...panelData.entries()].map(([id, d]) => ({ id, verts: d.verts }));
      const adj: Array<[PInfo, PInfo]> = [];
      for (let i = 0; i < infos.length; i++) {
        if (infos[i]!.verts.length !== 4) continue;
        for (let j = i + 1; j < infos.length; j++) {
          if (infos[j]!.verts.length !== 4) continue;
          let mc = 0; const used = new Set<number>();
          for (const av of infos[i]!.verts) {
            for (let k = 0; k < infos[j]!.verts.length; k++) {
              if (used.has(k)) continue;
              if (dist3(av, infos[j]!.verts[k]!) < 5) { mc++; used.add(k); break; }
            }
            if (mc >= 2) break;
          }
          if (mc >= 2) adj.push([infos[i]!, infos[j]!]);
        }
      }
      console.log(`Found ${adj.length} vertex-proximity pairs`);
      // Take pair at index 2 (0-indexed: pair 2)
      if (adj.length > 2) {
        return; // We'll use adj[2] below
      }
    }

    if (!idA || !idB) {
      console.warn('Could not match pair 2 panels by either method');
      return;
    }
    console.log(`Pair 2 panels: A=${idA.slice(0,8)} B=${idB.slice(0,8)}`);

    // Also find a passing reference pair (pair 0)
    const refAVerts: Vec3[] = [
      [1902, -1502, 794], [1905, -1500, -782], [1059, -562, -432], [1057, -563, 444],
    ];
    const refBVerts: Vec3[] = [
      [2173, -2384, 908], [2178, -2383, -895], [1905, -1500, -782], [1901, -1502, 795],
    ];
    const refA = matchPanel(refAVerts);
    const refB = matchPanel(refBVerts);

    // Merge pair 2 and capture results
    console.log('\n=== PAIR 2 (failing) ===');
    const pt2: any = await dispatchTool('begin_transaction', { label: 'diag_p2' }, config);
    try {
      const res: any = await dispatchTool('merge_bodies_with_bend', {
        transaction_id: pt2.transaction_id,
        part_a_id: idA, part_b_id: idB,
        target_edges: ['all'], bend_radius: 1.0,
      }, config);

      const g: any = await dispatchTool('query_graph', { part_id: res.merged_part_id }, config);
      const bendNode = g.nodes.find((n: any) => n.type === 'BendNode');
      const mergedNode = g.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);

      console.log('BendNode:', JSON.stringify({
        angle: bendNode?.angle,
        bendZoneDxfX: bendNode?.bendZoneDxfX,
        bendAllowance: bendNode?.bendAllowance,
        bHingeOffsetMm: bendNode?.bHingeOffsetMm,
        foldDirection: bendNode?.foldDirection,
        anchor: bendNode?.anchor?.map((x: number) => x.toFixed(1)),
        bendDir: bendNode?.bendDir?.map((x: number) => x.toFixed(4)),
        foldNormal: bendNode?.foldNormal?.map((x: number) => x.toFixed(4)),
      }));

      const bbox: any = await dispatchTool('bounding_box', { target: mergedNode.bodyId }, config);
      const bboxA: any = await dispatchTool('bounding_box', { target: idA }, config);
      const bboxB: any = await dispatchTool('bounding_box', { target: idB }, config);
      console.log('bbox A:', JSON.stringify(bboxA));
      console.log('bbox B:', JSON.stringify(bboxB));
      console.log('bbox merged:', JSON.stringify(bbox));
      console.log('expected union:', JSON.stringify({
        x_min: Math.min(bboxA.x_min, bboxB.x_min),
        y_min: Math.min(bboxA.y_min, bboxB.y_min),
        z_min: Math.min(bboxA.z_min, bboxB.z_min),
        x_max: Math.max(bboxA.x_max, bboxB.x_max),
        y_max: Math.max(bboxA.y_max, bboxB.y_max),
        z_max: Math.max(bboxA.z_max, bboxB.z_max),
      }));

      // Manual reconstruction: project merged DXF into 3D
      if (mergedNode?.shapeDxf && bendNode) {
        const anc = bendNode.anchor as number[];
        const bd = bendNode.bendDir as number[];
        const fn = bendNode.foldNormal as number[];
        const angleDeg = bendNode.angle as number;
        const bzx = bendNode.bendZoneDxfX as number;
        const ba2 = bendNode.bendAllowance as number;
        const ydirA: Vec3 = [fn[1]*bd[2]-fn[2]*bd[1], fn[2]*bd[0]-fn[0]*bd[2], fn[0]*bd[1]-fn[1]*bd[0]];
        const ring = parseFirstClosedPolyline(mergedNode.shapeDxf);
        const rotR = (v: Vec3, k: Vec3, deg: number): Vec3 => {
          const th = deg*Math.PI/180, c = Math.cos(th), s = Math.sin(th);
          const d = dot3(v, k);
          const cr: Vec3 = [k[1]*v[2]-k[2]*v[1], k[2]*v[0]-k[0]*v[2], k[0]*v[1]-k[1]*v[0]];
          return [v[0]*c+cr[0]*s+k[0]*d*(1-c), v[1]*c+cr[1]*s+k[1]*d*(1-c), v[2]*c+cr[2]*s+k[2]*d*(1-c)];
        };
        const foldPt: Vec3 = [anc[0]+bzx*bd[0], anc[1]+bzx*bd[1], anc[2]+bzx*bd[2]];
        const bdF = rotR(bd as Vec3, ydirA, -angleDeg);
        const corners3d = ring.map(([x, y]: [number,number]) => {
          if (x <= bzx) return [anc[0]+x*bd[0]+y*ydirA[0], anc[1]+x*bd[1]+y*ydirA[1], anc[2]+x*bd[2]+y*ydirA[2]] as Vec3;
          const xB = x-bzx-ba2;
          return [foldPt[0]+xB*bdF[0]+y*ydirA[0], foldPt[1]+xB*bdF[1]+y*ydirA[1], foldPt[2]+xB*bdF[2]+y*ydirA[2]] as Vec3;
        });
        let xMin=Infinity,yMin=Infinity,zMin=Infinity,xMax=-Infinity,yMax=-Infinity,zMax=-Infinity;
        for (const c of corners3d) {
          if (c[0]<xMin)xMin=c[0];if(c[1]<yMin)yMin=c[1];if(c[2]<zMin)zMin=c[2];
          if (c[0]>xMax)xMax=c[0];if(c[1]>yMax)yMax=c[1];if(c[2]>zMax)zMax=c[2];
        }
        console.log('manual recon bbox:', JSON.stringify({x_min:xMin,y_min:yMin,z_min:zMin,x_max:xMax,y_max:yMax,z_max:zMax}));
      }
    } finally {
      await dispatchTool('rollback_transaction', { transaction_id: pt2.transaction_id }, config);
    }

    // Merge reference pair 0 and capture results
    if (refA && refB) {
      console.log('\n=== PAIR 0 (passing reference) ===');
      const pt0: any = await dispatchTool('begin_transaction', { label: 'diag_p0' }, config);
      try {
        const res: any = await dispatchTool('merge_bodies_with_bend', {
          transaction_id: pt0.transaction_id,
          part_a_id: refA, part_b_id: refB,
          target_edges: ['all'], bend_radius: 1.0,
        }, config);

        const g: any = await dispatchTool('query_graph', { part_id: res.merged_part_id }, config);
        const bendNode = g.nodes.find((n: any) => n.type === 'BendNode');
        const mergedNode = g.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);

        console.log('BendNode:', JSON.stringify({
          angle: bendNode?.angle,
          bendZoneDxfX: bendNode?.bendZoneDxfX,
          bendAllowance: bendNode?.bendAllowance,
          bHingeOffsetMm: bendNode?.bHingeOffsetMm,
          foldDirection: bendNode?.foldDirection,
        }));

        const bbox: any = await dispatchTool('bounding_box', { target: mergedNode.bodyId }, config);
        const bboxA: any = await dispatchTool('bounding_box', { target: refA }, config);
        const bboxB: any = await dispatchTool('bounding_box', { target: refB }, config);
        console.log('bbox A:', JSON.stringify(bboxA));
        console.log('bbox B:', JSON.stringify(bboxB));
        console.log('bbox merged:', JSON.stringify(bbox));
      } finally {
        await dispatchTool('rollback_transaction', { transaction_id: pt0.transaction_id }, config);
      }
    }

    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
  }, 120_000);
});
