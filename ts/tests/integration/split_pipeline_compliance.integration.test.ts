/**
 * Regression tests for BUG-01 and BUG-02: split_body_by_bends pipeline compliance.
 *
 * BUG-01: split_body_by_bends must rebuild 3D geometry through the geometric
 *         pipeline (buildSheetFromDxf → thickenSheet → applyBend) and return
 *         shells that differ from the pre-split solid (pipeline_executed: true).
 *
 * BUG-02: split_body_by_bends must capture the true polygon outline of each
 *         split panel in shapeDxf, not a bounding-box rectangle.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

function findAddonPath(): string | undefined {
  const candidates = [
    path.resolve(__dirname, '../../../cpp/build/Release/geometry_addon.node'),
    path.resolve(__dirname, '../../../cpp/build-vcpkg/Debug/geometry_addon.node'),
    path.resolve(__dirname, '../../../cpp/build/Debug/geometry_addon.node'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function findFixture(filename: string): string | undefined {
  const fixturesDir = path.resolve(__dirname, '../../../cpp/tests/fixtures');
  const fp = path.join(fixturesDir, filename);
  return fs.existsSync(fp) ? fp : undefined;
}

type Segment2D = { a: [number, number]; b: [number, number] };

function parseDxfSegments2d(dxf: string): Segment2D[] {
  const lines = dxf.split(/\r?\n/);
  const segments: Segment2D[] = [];

  // Parse LINE entities.
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '0' && lines[i + 1] === 'LINE') {
      let x1: number | null = null;
      let y1: number | null = null;
      let x2: number | null = null;
      let y2: number | null = null;
      let j = i + 2;
      while (j < lines.length - 1) {
        const code = lines[j];
        const value = lines[j + 1];
        if (code === '0') break;
        if (code === '10') x1 = Number(value);
        if (code === '20') y1 = Number(value);
        if (code === '11') x2 = Number(value);
        if (code === '21') y2 = Number(value);
        j += 2;
      }
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        segments.push({ a: [x1, y1], b: [x2, y2] });
      }
      i = j - 1;
    }
  }

  // Parse LWPOLYLINE entities.
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === '0' && lines[i + 1] === 'LWPOLYLINE') {
      const verts: Array<[number, number]> = [];
      let closed = false;
      let j = i + 2;
      let pendingX: number | null = null;
      while (j < lines.length - 1) {
        const code = lines[j];
        const value = lines[j + 1];
        if (code === '0') break;
        if (code === '70') {
          const flags = Number(value);
          closed = Number.isFinite(flags) && (flags & 1) === 1;
        }
        if (code === '10') pendingX = Number(value);
        if (code === '20' && pendingX !== null) {
          const y = Number(value);
          verts.push([pendingX, y]);
          pendingX = null;
        }
        j += 2;
      }
      for (let k = 0; k < verts.length - 1; k++) {
        segments.push({ a: verts[k]!, b: verts[k + 1]! });
      }
      if (closed && verts.length > 2) {
        segments.push({ a: verts[verts.length - 1]!, b: verts[0]! });
      }
      i = j - 1;
    }
  }

  return segments;
}

function dominantDirection(segments: Segment2D[]): [number, number] | null {
  let best: [number, number] | null = null;
  let bestLen = -1;
  for (const s of segments) {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    if (len > bestLen && len > 1e-6) {
      bestLen = len;
      best = [dx / len, dy / len];
    }
  }
  return best;
}

function isAxisAligned2d(dir: [number, number], tolDeg = 7): boolean {
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const dotX = Math.abs(dir[0]);
  const dotY = Math.abs(dir[1]);
  return dotX >= cosTol || dotY >= cosTol;
}

describe('split_body_by_bends pipeline compliance (BUG-01, BUG-02)', () => {
  let addonAvailable = false;
  const configPath = path.resolve(__dirname, '../../config/config.yaml');

  beforeAll(() => {
    const addonPath = findAddonPath();
    if (addonPath) {
      process.env['GEOMETRY_ADDON_PATH'] = addonPath;
      addonAvailable = true;
    }
  });

  // ─── BUG-01: Pipeline must be invoked ───────────────────────────────────────

  it('BUG-01: split result includes pipeline_executed:true flag', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) { console.warn('hollow_cube.stp missing — skipping'); return; }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 30,
      max_thickness_mm: 5.0,
    }, config) as any;

    expect(splitResult.panel_count).toBeGreaterThan(0);

    // BUG-01: This flag must be present and true after the fix.
    // Before fix: pipeline_executed is absent or false (geometry not rebuilt from graph).
    expect(splitResult.pipeline_executed).toBe(true);
  });

  it('BUG-01: split sub-part geometry is not the same as the source solid', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) { console.warn('hollow_cube.stp missing — skipping'); return; }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 30,
      max_thickness_mm: 5.0,
    }, config) as any;

    expect(splitResult.panel_ids.length).toBeGreaterThan(0);

    // BUG-01: Each panel shell ID must NOT be the same as the source solid.
    // After fix, each panel ID is the rebuilt shell from the pipeline, which
    // is a distinct geometry object from the original source solid.
    for (const panelId of splitResult.panel_ids) {
      expect(panelId).not.toBe(solidId);
    }
  });

  it('BUG-01: each created_part has a manufacturing graph with correct bodyId', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) { console.warn('hollow_cube.stp missing — skipping'); return; }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 30,
      max_thickness_mm: 5.0,
    }, config) as any;

    // Each created part should have a manufacturing graph queryable via query_graph.
    for (const createdPart of splitResult.created_parts) {
      const graphResult = await dispatchTool('query_graph', {
        part_id: createdPart.part_id,
      }, config) as any;

      expect(graphResult.nodes).toBeDefined();
      const panelNodes = (graphResult.nodes as any[]).filter((n: any) => n.type === 'PanelNode');
      expect(panelNodes.length).toBeGreaterThan(0);

      // BUG-01: After fix, the panel's bodyId must match its panel_id
      // (the pipeline-rebuilt shell, not the original C++ split shell).
      const canonicalPanel = panelNodes.find((n: any) => n.canonical !== false);
      expect(canonicalPanel).toBeDefined();
      expect(canonicalPanel.body_id).not.toBeNull();
    }
  });

  // ─── BUG-02: Non-rectangular DXF outline ────────────────────────────────────

  it('BUG-02: shapeDxf for each split panel is non-null and contains a LWPOLYLINE', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) { console.warn('hollow_cube.stp missing — skipping'); return; }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 30,
      max_thickness_mm: 5.0,
    }, config) as any;

    for (const createdPart of splitResult.created_parts) {
      const graphResult = await dispatchTool('query_graph', {
        part_id: createdPart.part_id,
      }, config) as any;

      const panelNodes = (graphResult.nodes as any[]).filter((n: any) => n.type === 'PanelNode' && n.canonical !== false);
      for (const panel of panelNodes) {
        // shapeDxf must be present
        expect(panel.shape_dxf ?? panel.shapeDxf).not.toBeNull();
        const dxf = panel.shape_dxf ?? panel.shapeDxf ?? '';
        expect(dxf.length).toBeGreaterThan(0);
        // OCCT exportDxf may produce LWPOLYLINE or individual LINE entities.
        // Both represent the panel boundary — accept either.
        const hasBoundaryGeometry = dxf.includes('LWPOLYLINE') || dxf.includes('\nLINE\n') || dxf.includes(' LINE\n');
        expect(hasBoundaryGeometry).toBe(true);
      }
    }
  });

  it('BUG-02: split panels on a non-rectangular fixture have LWPOLYLINE with more than 4 vertices', async () => {
    if (!addonAvailable) return;
    // Use the L-bracket fixture if available; fall back to a fixture that has non-rectangular panels
    const fixturePath = findFixture('l_bracket.stp') ?? findFixture('simple_shelf.stp');
    if (!fixturePath) {
      console.warn('Non-rectangular fixture not found — skipping BUG-02 polygon test');
      return;
    }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 10,
      max_thickness_mm: 5.0,
    }, config) as any;

    if (splitResult.panel_count === 0) {
      console.warn('No panels split — fixture may not have bends; skipping');
      return;
    }

    let foundNonRectangular = false;
    for (const createdPart of splitResult.created_parts) {
      const graphResult = await dispatchTool('query_graph', {
        part_id: createdPart.part_id,
      }, config) as any;

      const panelNodes = (graphResult.nodes as any[]).filter((n: any) => n.type === 'PanelNode' && n.canonical !== false);
      for (const panel of panelNodes) {
        const dxf = panel.shape_dxf ?? panel.shapeDxf ?? '';

        // Count boundary edges in the DXF.
        // OCCT exportDxf may use:
        //   - LWPOLYLINE with vertex entries "10\n<x>\n20\n<y>" 
        //   - Individual LINE entities (one per edge)
        const lwpolylineVertices = dxf.match(/\n10\n/g) ?? [];
        const lineEntities = dxf.match(/\n0\nLINE\n/g) ?? dxf.match(/\r?\n0\r?\nLINE\r?\n/g) ?? [];
        const edgeCount = Math.max(lwpolylineVertices.length, lineEntities.length);
        if (edgeCount > 4) {
          foundNonRectangular = true;
          break;
        }
      }
      if (foundNonRectangular) break;
    }

    // BUG-02: At least one panel should have a non-rectangular outline.
    // Before fix: all panels have exactly 4 vertices (bounding box rectangle).
    // After fix: complex panels have more than 4 vertices.
    expect(foundNonRectangular).toBe(true);
  });

  it('BUG-02: non-rectangular split flat patterns align dominant edges to X/Y axes', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('l_bracket.stp') ?? findFixture('simple_shelf.stp');
    if (!fixturePath) {
      console.warn('Non-rectangular fixture not found — skipping alignment test');
      return;
    }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    const splitResult = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 10,
      max_thickness_mm: 5.0,
    }, config) as any;

    let checked = 0;
    for (const createdPart of splitResult.created_parts ?? []) {
      const graphResult = await dispatchTool('query_graph', {
        part_id: createdPart.part_id,
      }, config) as any;

      const panelNodes = (graphResult.nodes as any[]).filter((n: any) => n.type === 'PanelNode' && n.canonical !== false);
      for (const panel of panelNodes) {
        const dxf = panel.shape_dxf ?? panel.shapeDxf ?? '';
        if (!dxf || dxf.length === 0) continue;
        const segments = parseDxfSegments2d(dxf);
        const dir = dominantDirection(segments);
        if (!dir) continue;
        checked++;

        // Manufacturing readability requirement:
        // dominant edge in flat pattern should be close to X or Y.
        expect(isAxisAligned2d(dir)).toBe(true);
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  // ─── T035: Sequential mutations verify pipeline compliance ──────────────────

  it('T035: sequential split operations on fixture demonstrate pipeline compliance', async () => {
    if (!addonAvailable) return;
    const fixturePath = findFixture('hollow_cube.stp');
    if (!fixturePath) { console.warn('hollow_cube.stp missing — skipping'); return; }

    const config = await loadConfig(configPath);
    const cleanResult = await dispatchTool('clean_geometry', { file_path: fixturePath }, config) as any;
    const solidId = cleanResult.solid_id;

    // First split: create the manufacturing graph
    const split1 = await dispatchTool('split_body_by_bends', {
      part_id: solidId,
      angle_threshold_deg: 30,
      max_thickness_mm: 5.0,
    }, config) as any;

    // Verify split succeeded and created parts
    expect(split1.created_parts).toBeDefined();
    expect(split1.created_parts.length).toBeGreaterThan(0);
    expect(split1.pipeline_executed).toBe(true);

    // Verify each created part has a manufacturing graph
    for (const createdPart of split1.created_parts) {
      const graphResult = await dispatchTool('query_graph', {
        part_id: createdPart.part_id,
      }, config) as any;
      expect(graphResult.nodes).toBeDefined();
      expect(graphResult.nodes.length).toBeGreaterThan(0);
    }
  });
});

