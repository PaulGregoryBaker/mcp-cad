/**
 * split_body_by_bends: manufacturing-graph thickness/position consistency.
 *
 * The manufacturing graph is the source of truth — the split-time 3D shell is
 * disposable. So the only checks that matter are on the GRAPH data itself
 * (PanelNode.nominalThickness, midplaneOffsetMm) and on whether rebuilding a
 * shell FROM that graph data is faithful — never on the raw, disposable shell.
 *
 * cube_with_flanges.stp has 4 flanges, each boolean-fused (zero gap) onto a
 * wall of the same 1mm thickness. That fuse erases the seam between wall and
 * flange, so a flange's OWN split-time shell measures 2mm thick (no face
 * exists at the true 1mm boundary) — this test asserts split_body_by_bends's
 * cross-panel correction recovers the true 1mm/position anyway, for every
 * wall+flange pair, not just one.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { parseFirstClosedPolyline } from '../../src/manufacturing/dxf/merge';
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

function ext(b: Bbox, axis: 'x' | 'y' | 'z'): number {
  return b[`${axis}_max`] - b[`${axis}_min`];
}

function outlineDims(dxf: string): { width: number; height: number } {
  const ring = parseFirstClosedPolyline(dxf);
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const [x, y] of ring) {
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  return { width: xMax - xMin, height: yMax - yMin };
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
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
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

describe('[graph] split_body_by_bends: thickness + midplane-offset consistency', () => {
  it('every panel reports nominalThickness=1mm, and every wall+flange pair rebuilds adjacent (not overlapping)', async () => {
    const fixturePath = findFixture('cube_with_flanges.stp');
    if (!fixturePath) { console.warn('cube_with_flanges.stp missing — skipping'); return; }

    const clean: any = await dispatchTool('clean_geometry', { file_path: fixturePath }, config);
    const split: any = await dispatchTool('split_body_by_bends', {
      part_id: clean.solid_id, angle_threshold_deg: 45, max_thickness_mm: 5.0,
    }, config);
    expect(split.panel_count).toBe(10);

    const panels: Array<{ id: string; bbox: Bbox }> = [];
    for (const id of split.panel_ids as string[]) {
      panels.push({ id, bbox: await dispatchTool('bounding_box', { target: id }, config) as Bbox });
    }

    const walls = panels.filter(({ bbox }) => {
      const dims = [ext(bbox, 'x'), ext(bbox, 'y'), ext(bbox, 'z')].sort((a, b) => a - b);
      return dims[1]! > 150 && dims[2]! > 150;
    });
    const flanges = panels.filter(({ bbox }) =>
      ext(bbox, 'x') < 50 && ext(bbox, 'y') < 50 && ext(bbox, 'z') < 50);
    expect(walls.length, 'expected 6 cube walls').toBe(6);
    expect(flanges.length, 'expected 4 flanges').toBe(4);

    // ── (1) Graph data: every panel's nominalThickness must be exactly 1mm —
    // including the flanges, whose OWN split-time shell measures 2mm (the
    // boolean fuse erases the seam to its host wall).
    for (const { id } of [...walls, ...flanges]) {
      const node = await queryPanelNode(id);
      expect(node.nominalThickness, `[BUG] panel ${id} nominalThickness should resolve to 1mm`).toBeCloseTo(1, 1);
    }

    // ── (2) Pair each flange with its coplanar host wall (same thin axis,
    // same centre on that axis — i.e. same plane) and verify their graph data
    // independently reconstructs them flush, not overlapping.
    function thinAxis(b: Bbox): { axis: 'x' | 'y' | 'z'; center: number } {
      const dims: Array<{ axis: 'x' | 'y' | 'z'; extent: number }> = [
        { axis: 'x', extent: ext(b, 'x') }, { axis: 'y', extent: ext(b, 'y') }, { axis: 'z', extent: ext(b, 'z') },
      ];
      dims.sort((a, b2) => a.extent - b2.extent);
      const axis = dims[0]!.axis;
      return { axis, center: (b[`${axis}_min`] + b[`${axis}_max`]) / 2 };
    }

    const gb = getGeometryBinding();
    let pairsChecked = 0;

    for (const flange of flanges) {
      const flangeThin = thinAxis(flange.bbox);
      const hostWall = walls.find((w) => {
        const wallThin = thinAxis(w.bbox);
        return wallThin.axis === flangeThin.axis && Math.abs(wallThin.center - flangeThin.center) < 10;
      });
      expect(hostWall, `expected a coplanar host wall for flange ${flange.id}`).toBeDefined();
      pairsChecked++;

      const wallNode = await queryPanelNode(hostWall!.id);
      const flangeNode = await queryPanelNode(flange.id);

      const wallDims = outlineDims(wallNode.shapeDxf!);
      const flangeDims = outlineDims(flangeNode.shapeDxf!);
      expect(Math.max(wallDims.width, wallDims.height), `[BUG] wall ${hostWall!.id} outline should be 200mm`).toBeCloseTo(200, 0);
      expect(Math.max(flangeDims.width, flangeDims.height), `[BUG] flange ${flange.id} outline long dim should be 20mm`).toBeCloseTo(20, 0);
      expect(Math.min(flangeDims.width, flangeDims.height), `[BUG] flange ${flange.id} outline short dim should be 10mm`).toBeCloseTo(10, 0);

      const wallRebuild = gb.buildShellFromFlatPattern(wallNode.shapeDxf!, [], wallNode.nominalThickness, explicitPlacementFrom(wallNode));
      const flangeRebuild = gb.buildShellFromFlatPattern(flangeNode.shapeDxf!, [], flangeNode.nominalThickness, explicitPlacementFrom(flangeNode));

      const wallBbox = await dispatchTool('bounding_box', { target: wallRebuild.shellId }, config) as Bbox;
      const flangeBbox = await dispatchTool('bounding_box', { target: flangeRebuild.shellId }, config) as Bbox;

      const axis = flangeThin.axis;
      expect(ext(wallBbox, axis), `[BUG] rebuilt wall ${hostWall!.id} thickness-axis extent should be 1mm`).toBeCloseTo(1, 1);
      expect(ext(flangeBbox, axis), `[BUG] rebuilt flange ${flange.id} thickness-axis extent should be 1mm`).toBeCloseTo(1, 1);

      const wLo = wallBbox[`${axis}_min`], wHi = wallBbox[`${axis}_max`];
      const fLo = flangeBbox[`${axis}_min`], fHi = flangeBbox[`${axis}_max`];
      const overlap = Math.min(wHi, fHi) - Math.max(wLo, fLo);
      console.log(`[split-thickness] flange ${flange.id} axis=${axis} wall=[${wLo.toFixed(2)},${wHi.toFixed(2)}] flange=[${fLo.toFixed(2)},${fHi.toFixed(2)}] overlap=${overlap.toFixed(2)}`);
      expect(overlap, `[BUG] rebuilt wall ${hostWall!.id} and flange ${flange.id} must be adjacent, not overlapping`).toBeLessThanOrEqual(0.5);
    }

    expect(pairsChecked).toBe(4);
  }, 60_000);
});
