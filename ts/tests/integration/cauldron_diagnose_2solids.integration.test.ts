/**
 * Diagnostic: capture DXF + bend zone for a cauldron pair that produces
 * "Refold produced 2 solids", then test buildShellFromFlatPattern directly.
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

describe('[diagnostic] refold 2-solids error on cauldron pairs', () => {
  it('captures DXF and bend zone for a pair that produces 2 solids', async () => {
    const binding = getGeometryBinding();
    if (!binding.hasBuildShellFromFlatPattern()) {
      console.warn('buildShellFromFlatPattern not available — skipping');
      return;
    }

    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) { console.warn('missing cauldron.step — skipping'); return; }

    // Split the cauldron.
    const txn: any = await dispatchTool('begin_transaction', { label: 'diag_2solids' }, config);
    const txId = txn.transaction_id;
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0,
      max_recursion_depth: 1, transaction_id: txId,
    }, config);
    const panelIds: string[] = split.panel_ids;
    console.log(`Split into ${panelIds.length} panels`);

    // Build 3D vertex info for all panels.
    type Vec3 = [number, number, number];
    const panelVerts = new Map<string, Vec3[]>();
    for (const id of panelIds) {
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        const node = g.nodes.find((n: any) => n.type === 'PanelNode');
        if (!node?.panelFrame || !node?.shapeDxf) continue;
        const f = node.panelFrame;
        // Parse DXF ring
        const dxf = node.shapeDxf as string;
        const lines = dxf.split('\n').filter((l: string) => l.trim());
        const verts: Vec3[] = [];
        let inVertices = false;
        for (const line of lines) {
          const t = line.trim();
          if (t === '10' || t === '20') continue;
          if (t === '0') { inVertices = false; continue; }
          if (t === 'LWPOLYLINE' || t === 'POLYLINE') { inVertices = true; continue; }
          if (t === 'SEQEND' || t === 'VERTEX') continue;
          if (inVertices && t === 'AcDbEntity') continue;
          if (inVertices && t === 'AcDbPolyline' || t === 'AcDb2dPolyline') continue;
          // Simple approach: just look for coordinate pairs
        }
        // Use the parseFirstClosedPolyline helper
        const { parseFirstClosedPolyline } = await import('../../src/manufacturing/dxf/merge');
        const ring = parseFirstClosedPolyline(node.shapeDxf);
        const closed = ring.length > 1 && ring[0]![0] === ring[ring.length-1]![0] && ring[0]![1] === ring[ring.length-1]![1];
        const pts = closed ? ring.slice(0, -1) : ring;
        const pts3d: Vec3[] = pts.map(([x, y]: [number, number]) => [
          f.origin[0] + x * f.u[0] + y * f.v[0],
          f.origin[1] + x * f.u[1] + y * f.v[1],
          f.origin[2] + x * f.u[2] + y * f.v[2],
        ] as Vec3);
        if (pts3d.length >= 3) panelVerts.set(id, pts3d);
      } catch { /* skip */ }
    }
    console.log(`Panels with vertex data: ${panelVerts.size}`);

    // Graph-based adjacency: find BendNodes in the merged graph of the first panel.
    // We'll use query_graph on the original body's merged part to see all bend connections.
    const vertArr = [...panelVerts.entries()];
    const adjacentByGraph = new Set<string>();
    for (const [id] of vertArr) {
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        // Look for BendNodes connected to this panel's graph
        const bendNodes = g.nodes.filter((n: any) => n.type === 'BendNode');
        for (const bn of bendNodes) {
          // Find connected panels via edges
          const edges = g.edges?.filter((e: any) =>
            (e.source === bn.id || e.target === bn.id));
          if (edges) {
            const connected = edges.map((e: any) =>
              e.source === bn.id ? e.target : e.source).filter((nid: string) => nid !== id);
            for (const cid of connected) {
              if (panelVerts.has(cid)) {
                adjacentByGraph.add(`${id}::${cid}`);
                adjacentByGraph.add(`${cid}::${id}`);
              }
            }
          }
        }
      } catch { /* skip */ }
    }
    console.log(`Graph-based adjacent pairs: ${adjacentByGraph.size / 2}`);

    // Compare: vertex-proximity pairs (5mm) vs graph-based pairs.
    const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const EDGE_TOL_MM = 5.0;
    let vertexPairs = 0;
    let vertexOnlyPairs = 0; // pairs found by vertex but NOT by graph
    const falsePositivePairs: Array<[string, string, Vec3[], Vec3[]]> = [];
    for (let i = 0; i < vertArr.length; i++) {
      const [idA, va] = vertArr[i]!;
      if (va.length !== 4) continue;
      for (let j = i + 1; j < vertArr.length; j++) {
        const [idB, vb] = vertArr[j]!;
        if (vb.length !== 4) continue;

        // Vertex proximity check
        let matchCount = 0;
        const usedB = new Set<number>();
        for (let vi = 0; vi < va.length; vi++) {
          for (let vj = 0; vj < vb.length; vj++) {
            if (usedB.has(vj)) continue;
            if (dist(va[vi]!, vb[vj]!) < EDGE_TOL_MM) { matchCount++; usedB.add(vj); break; }
          }
          if (matchCount >= 2) break;
        }
        const vertexAdjacent = matchCount >= 2;
        const graphAdjacent = adjacentByGraph.has(`${idA}::${idB}`);

        if (vertexAdjacent) vertexPairs++;
        if (vertexAdjacent && !graphAdjacent) {
          vertexOnlyPairs++;
          falsePositivePairs.push([idA, idB, va, vb]);
        }
      }
    }
    console.log(`Vertex-proximity pairs: ${vertexPairs}, false positives (not in graph): ${vertexOnlyPairs}`);
    console.log(`Graph-based pairs would give: ${adjacentByGraph.size / 2}`);

    // For each false-positive pair, try merge_bodies_with_bend and see if it produces
    // "Refold produced 2 solids".
    let twoSolidCount = 0;
    for (const [idA, idB] of falsePositivePairs.slice(0, 3)) {
      try {
        const pairTxn: any = await dispatchTool('begin_transaction', { label: `diag_fp` }, config);
        await dispatchTool('merge_bodies_with_bend', {
          transaction_id: pairTxn.transaction_id,
          part_a_id: idA, part_b_id: idB,
          target_edges: ['all'], bend_radius: 1.0,
        }, config);
        console.log(`  False-positive pair ${idA}↔${idB}: merge SUCCEEDED (unexpected)`);
        await dispatchTool('rollback_transaction', { transaction_id: pairTxn.transaction_id }, config);
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.includes('2 solids')) {
          twoSolidCount++;
          console.log(`  False-positive pair ${idA}↔${idB}: Refold 2 solids ✓ (expected for FP)`);
        } else {
          console.log(`  False-positive pair ${idA}↔${idB}: ${msg}`);
        }
        try { await dispatchTool('rollback_transaction', { transaction_id: (e as any)?.transaction_id ?? '' }, config); } catch { /* */ }
      }
    }

    console.log(`False positives that produce "2 solids": ${twoSolidCount}/${Math.min(3, falsePositivePairs.length)}`);

    // Graph-based adjacency IS the ground truth. If graph-based pairs >> vertex pairs,
    // we should use the graph for our main test.
    expect(adjacentByGraph.size / 2, 'graph-based pairs should exist').toBeGreaterThan(0);
    console.log(`Conclusion: graph-based adjacency finds ${adjacentByGraph.size / 2} true pairs; vertex proximity finds ${vertexPairs} (${vertexOnlyPairs} false positives)`);

    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
  }, 120_000);
});
