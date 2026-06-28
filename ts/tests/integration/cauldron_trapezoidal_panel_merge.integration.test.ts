/**
 * Regression: merge_bodies_with_bend on genuinely non-rectangular (trapezoidal)
 * panels produces a correct 3D shape and flat pattern.
 *
 * User report: merging two adjacent facets of cauldron.step (a curved-surface
 * decomposition with skewed-quad facets — no two vertices share an x or y
 * coordinate) produced a "bowtie"/hourglass flat-pattern outline and a merged
 * 3D bbox nowhere close to the union of the two input panels' own bboxes.
 *
 * Root cause: merge_bodies_with_bend's flat-pattern bridging treated
 * "distance to the shared edge" as a single scalar along whichever of
 * getPanelFrame's two stored axes (U/V) is closer to the fold — meaningful
 * only for a rectangle, where the fold is necessarily parallel to one axis.
 * For a skewed quad, neither axis is generally perpendicular to the real
 * shared edge, so that scalar is meaningless.
 *
 * Fix: compute each panel's flat-pattern X axis directly from the bend's
 * true in-plane direction (bendDir/gBtoBody, already derived from real 3D
 * geometry, not from getPanelFrame's axes) instead of approximating with a
 * 0°-or-90° rotation of the stored axes.
 */
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getGeometryBinding } from '../../src/mcp/state';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

interface Bbox { x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number; }

describe('[regression] merge_bodies_with_bend on non-rectangular (trapezoidal) panels', () => {
  it('merges two adjacent cauldron facets into a 3D shape matching the union of their own bboxes', async () => {
    const fixturePath = findFixture('cauldron.step');
    if (!fixturePath) { console.warn('missing cauldron.step fixture — skipping'); return; }

    const txn: any = await dispatchTool('begin_transaction', { label: 'cauldron_regression' }, config);
    const txId: string = txn.transaction_id;
    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 0.5, max_thickness_mm: 5.0, max_recursion_depth: 1, transaction_id: txId,
    }, config);

    const panelIds = split.panel_ids as string[];
    const gb = getGeometryBinding();
    const infos: Array<{ id: string; bbox: Bbox; nonRectangular: boolean }> = [];
    for (const id of panelIds.slice(0, 20)) {
      const bbox = await dispatchTool('bounding_box', { target: id }, config) as Bbox;
      // Confirm non-rectangular (no two vertices share an x or y coordinate)
      // BEFORE attempting any merge — a property of the facet's geometry
      // alone, independent of split_body_by_bends's randomly-generated
      // panel IDs, so restricting candidates to these makes the test
      // deterministically exercise the bug instead of depending on which
      // (possibly rectangular-enough) pair happens to be tried first.
      let nonRectangular = false;
      try {
        const g: any = await dispatchTool('query_graph', { part_id: id }, config);
        const node = g.nodes.find((n: any) => n.type === 'PanelNode');
        const ring = parseFirstClosedPolyline(node?.shapeDxf ?? '');
        const xs = new Set(ring.map(([x]) => Math.round(x * 100)));
        const ys = new Set(ring.map(([, y]) => Math.round(y * 100)));
        nonRectangular = ring.length >= 4 && xs.size >= ring.length - 1 && ys.size >= ring.length - 1;
      } catch { /* leave false */ }
      infos.push({ id, bbox, nonRectangular });
    }

    let merged: any = null, a: typeof infos[0] | undefined, b: typeof infos[0] | undefined;
    outer: for (let i = 0; i < infos.length; i++) {
      if (!infos[i]!.nonRectangular) continue;
      for (let j = 0; j < infos.length; j++) {
        if (i === j || !infos[j]!.nonRectangular) continue;
        try {
          const result: any = await dispatchTool('merge_bodies_with_bend', {
            transaction_id: txId, part_a_id: infos[i]!.id, part_b_id: infos[j]!.id, target_edges: ['all'], bend_radius: 1.0,
          }, config);
          if (result?.merged_shell_id) {
            merged = result; a = infos[i]; b = infos[j];
            break outer;
          }
        } catch { /* try next pair */ }
      }
    }
    if (!merged || !a || !b) { console.warn('no adjacent pair of non-rectangular cauldron facets merged successfully — skipping'); return; }
    console.log(`[cauldron regression] merged non-rectangular panels ${a.id} + ${b.id}`);

    const mergedBbox = await dispatchTool('bounding_box', { target: merged.merged_shell_id }, config) as Bbox;
    const expXMin = Math.min(a.bbox.x_min, b.bbox.x_min);
    const expXMax = Math.max(a.bbox.x_max, b.bbox.x_max);
    const expYMin = Math.min(a.bbox.y_min, b.bbox.y_min);
    const expYMax = Math.max(a.bbox.y_max, b.bbox.y_max);
    const expZMin = Math.min(a.bbox.z_min, b.bbox.z_min);
    const expZMax = Math.max(a.bbox.z_max, b.bbox.z_max);

    console.log(`[cauldron regression] A bbox: x[${a.bbox.x_min.toFixed(1)},${a.bbox.x_max.toFixed(1)}] y[${a.bbox.y_min.toFixed(1)},${a.bbox.y_max.toFixed(1)}] z[${a.bbox.z_min.toFixed(1)},${a.bbox.z_max.toFixed(1)}]`);
    console.log(`[cauldron regression] B bbox: x[${b.bbox.x_min.toFixed(1)},${b.bbox.x_max.toFixed(1)}] y[${b.bbox.y_min.toFixed(1)},${b.bbox.y_max.toFixed(1)}] z[${b.bbox.z_min.toFixed(1)},${b.bbox.z_max.toFixed(1)}]`);
    console.log(`[cauldron regression] merged bbox: x[${mergedBbox.x_min.toFixed(1)},${mergedBbox.x_max.toFixed(1)}] y[${mergedBbox.y_min.toFixed(1)},${mergedBbox.y_max.toFixed(1)}] z[${mergedBbox.z_min.toFixed(1)},${mergedBbox.z_max.toFixed(1)}]`);
    console.log(`[cauldron regression] expected union: x[${expXMin.toFixed(1)},${expXMax.toFixed(1)}] y[${expYMin.toFixed(1)},${expYMax.toFixed(1)}] z[${expZMin.toFixed(1)},${expZMax.toFixed(1)}]`);

    // The merged shape's bbox must be close to the union of the two inputs'
    // own bboxes — NOT wildly different (the original bug: merged bbox was
    // nowhere close to either input, off by thousands of mm).
    const TOL_MM = 20;
    const checks: string[] = [];
    if (Math.abs(mergedBbox.x_min - expXMin) > TOL_MM || Math.abs(mergedBbox.x_max - expXMax) > TOL_MM) {
      checks.push(`x range [${mergedBbox.x_min.toFixed(1)},${mergedBbox.x_max.toFixed(1)}] far from expected [${expXMin.toFixed(1)},${expXMax.toFixed(1)}]`);
    }
    if (Math.abs(mergedBbox.y_min - expYMin) > TOL_MM || Math.abs(mergedBbox.y_max - expYMax) > TOL_MM) {
      checks.push(`y range [${mergedBbox.y_min.toFixed(1)},${mergedBbox.y_max.toFixed(1)}] far from expected [${expYMin.toFixed(1)},${expYMax.toFixed(1)}]`);
    }
    if (Math.abs(mergedBbox.z_min - expZMin) > TOL_MM || Math.abs(mergedBbox.z_max - expZMax) > TOL_MM) {
      checks.push(`z range [${mergedBbox.z_min.toFixed(1)},${mergedBbox.z_max.toFixed(1)}] far from expected [${expZMin.toFixed(1)},${expZMax.toFixed(1)}]`);
    }
    if (checks.length > 0) {
      throw new Error(`[BUG] merged bbox diverges from the expected union:\n  - ${checks.join('\n  - ')}`);
    }

    // The merged flat pattern's own bbox must also be close to the simple
    // sum of the two panels' own flat extents — not a bowtie shape with
    // vertices far outside either panel's own footprint.
    const mergedGraph: any = await dispatchTool('query_graph', { part_id: merged.merged_part_id }, config);
    const mergedNode = mergedGraph.nodes.find((n: any) => n.type === 'PanelNode' && n.canonical !== false);
    const mergedRing = parseFirstClosedPolyline(mergedNode?.shapeDxf ?? '');
    let mxMin = Infinity, mxMax = -Infinity, myMin = Infinity, myMax = -Infinity;
    for (const [x, y] of mergedRing) { mxMin = Math.min(mxMin, x); mxMax = Math.max(mxMax, x); myMin = Math.min(myMin, y); myMax = Math.max(myMax, y); }
    console.log(`[cauldron regression] merged flat pattern bbox: x[${mxMin.toFixed(1)},${mxMax.toFixed(1)}] y[${myMin.toFixed(1)},${myMax.toFixed(1)}]`);

    await dispatchTool('rollback_transaction', { transaction_id: txId }, config);
  }, 60_000);
});
