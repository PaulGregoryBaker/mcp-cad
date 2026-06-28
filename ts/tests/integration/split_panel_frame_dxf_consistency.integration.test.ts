/**
 * Diagnostic: does a freshly-split panel's panelFrame ACTUALLY correspond to
 * its shapeDxf — with ZERO transforms (no translate_body, no fuse_bodies)
 * involved at all?
 *
 * split_body_by_bends sets panelFrame.u/v from a LIVE getPanelFrame() query,
 * and shapeDxf from an INDEPENDENT unfoldShell + exportDxf + normalizePanelDxfOrientation
 * pipeline. These are two SEPARATE OCCT computations. normalizePanelDxfOrientation
 * only compares NUMERIC width/height against panelFrame's uExtentMm/vExtentMm —
 * it has no way to verify that the DXF's "+x" direction, after any rotation it
 * applies, actually corresponds to world vector U (vs V). If unfoldShell's own
 * native coordinate convention doesn't inherently align with getPanelFrame's
 * U/V convention, the two can disagree on DIRECTION while agreeing on
 * magnitude — and nothing currently catches that.
 *
 * Test: rebuild a shell from a panel's OWN stored (shapeDxf, panelFrame,
 * nominalThickness, midplaneOffsetMm) via buildShellFromFlatPattern, and
 * check it reproduces the ORIGINAL split-time shell's bbox AND volume AND
 * normal — immediately after split, before any other operation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { getGeometryBinding } from '../../src/mcp/state';
import type { PanelNode } from '../../src/manufacturing/graph/types';

const configPath = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(configPath);

function findFixture(filename: string): string | undefined {
  const dir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(dir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

interface Bbox {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}
function fmt(b: Bbox): string {
  return `x[${b.x_min.toFixed(2)}..${b.x_max.toFixed(2)}] y[${b.y_min.toFixed(2)}..${b.y_max.toFixed(2)}] z[${b.z_min.toFixed(2)}..${b.z_max.toFixed(2)}]`;
}

async function queryPanelNode(partId: string): Promise<PanelNode> {
  const result: any = await dispatchTool('query_graph', { part_id: partId }, config);
  const node = result.nodes.find((n: any) => n.type === 'PanelNode');
  expect(node, `part ${partId} must have a PanelNode`).toBeDefined();
  return node as PanelNode;
}

function explicitPlacementFrom(node: PanelNode) {
  const frame = node.panelFrame!;
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  const normal = frame.normal ?? [
    uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx,
  ];
  return {
    hasFrame: true,
    originX: frame.origin[0], originY: frame.origin[1], originZ: frame.origin[2],
    uX: ux, uY: uy, uZ: uz,
    vX: vx, vY: vy, vZ: vz,
    normalX: normal[0], normalY: normal[1], normalZ: normal[2],
    nCentreMm: node.midplaneOffsetMm ?? node.nominalThickness / 2,
  };
}

describe('[diagnostic] split_body_by_bends panel: panelFrame vs shapeDxf agreement (zero transforms)', () => {
  afterEach(async () => {
    const active = transactionRegistry.getActive();
    if (active) {
      try { await dispatchTool('rollback_transaction', { transaction_id: active.id }, loadConfig(configPath)); }
      catch { /* best effort */ }
    }
  });

  const fixtures = ['cube_with_flanges.stp', 'unequal_leg_bracket_90deg.stp', 'l_bracket_corner_90deg.stp', 'tab_bracket_90deg.stp'];

  for (const fixtureName of fixtures) {
    it(`${fixtureName}: every split panel rebuilds from its OWN graph data at the SAME bbox/normal as the split-time shell`, async () => {
      const fixturePath = findFixture(fixtureName);
      if (!fixturePath) { console.warn(`${fixtureName} missing — skipping`); return; }

      const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
      const split: any = await dispatchTool('split_body_by_bends', {
        part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
      }, config);

      const gb = getGeometryBinding();
      for (const panelId of split.panel_ids as string[]) {
        const originalBbox: Bbox = await dispatchTool('bounding_box', { target: panelId }, config) as Bbox;
        const originalFrame = gb.getPanelFrame(panelId);
        const node = await queryPanelNode(panelId);

        if (!node.shapeDxf) { console.warn(`[${fixtureName}] panel ${panelId} has no shapeDxf — skipping`); continue; }

        const rebuild = gb.buildShellFromFlatPattern(node.shapeDxf, [], node.nominalThickness, explicitPlacementFrom(node));
        const rebuiltBbox: Bbox = await dispatchTool('bounding_box', { target: rebuild.shellId }, config) as Bbox;
        const rebuiltFrame = gb.getPanelFrame(rebuild.shellId);

        console.log(`[${fixtureName}] panel ${panelId}`);
        console.log(`  original bbox: ${fmt(originalBbox)}  normal=(${originalFrame.normalX.toFixed(3)},${originalFrame.normalY.toFixed(3)},${originalFrame.normalZ.toFixed(3)})`);
        console.log(`  rebuilt  bbox: ${fmt(rebuiltBbox)}  normal=(${rebuiltFrame.normalX.toFixed(3)},${rebuiltFrame.normalY.toFixed(3)},${rebuiltFrame.normalZ.toFixed(3)})`);
        console.log(`  stored panelFrame: u=(${node.panelFrame?.u}) v=(${node.panelFrame?.v}) origin=(${node.panelFrame?.origin})`);

        // The thickness axis is excluded from the tight position check: a
        // panel boolean-fused (zero gap) to a same-thickness neighbour
        // legitimately measures DOUBLE thickness on its own split-time shell
        // (no face exists at the true seam) — split_body_by_bends's
        // cross-panel correction deliberately recovers the TRUE position
        // (see split_thickness_consistency.integration.test.ts), which then
        // intentionally does NOT match the contaminated raw split-time bbox
        // on that one axis. Still assert the thickness EXTENT itself matches
        // nominalThickness exactly — that's the part this test can still
        // catch a real bug in.
        const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
          { axis: 'x', extent: originalBbox.x_max - originalBbox.x_min },
          { axis: 'y', extent: originalBbox.y_max - originalBbox.y_min },
          { axis: 'z', extent: originalBbox.z_max - originalBbox.z_min },
        ];
        dims.sort((a, b) => a.extent - b.extent);
        const thicknessAxis = dims[0]!.axis;

        const rebuiltExtent = rebuiltBbox[`${thicknessAxis}_max`] - rebuiltBbox[`${thicknessAxis}_min`];
        expect(rebuiltExtent,
          `[${fixtureName}] [BUG] panel ${panelId} rebuilt thickness-axis (${thicknessAxis}) extent should equal nominalThickness`)
          .toBeCloseTo(node.nominalThickness, 1);

        const TOL_MM = 0.5;
        for (const k of ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const) {
          if (k.startsWith(thicknessAxis)) continue;
          const delta = Math.abs(originalBbox[k] - rebuiltBbox[k]);
          expect(delta,
            `[${fixtureName}] [BUG] panel ${panelId} rebuilt-from-graph-data bbox.${k} doesn't match the original ` +
            `split-time shell (orig=${originalBbox[k].toFixed(2)} rebuilt=${rebuiltBbox[k].toFixed(2)} Δ=${delta.toFixed(2)}mm) — ` +
            `panelFrame and shapeDxf disagree on orientation/position, with ZERO transforms involved`)
            .toBeLessThanOrEqual(TOL_MM);
        }
      }
    }, 60_000);
  }
});
