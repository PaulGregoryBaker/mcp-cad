/**
 * Contract tests for coordinate-map.ts module.
 *
 * Verifies the exported function signatures and error codes meet the
 * Feature 011 specification for bidirectional 3D ↔ 2D mapping.
 *
 * Feature: 011-graph-driven-geometry (T032)
 */

import { describe, it, expect } from 'vitest';
import { map3dTo2d, map2dTo3d } from '../../src/geometry/coordinate-map';
import type { CoordinateMapResult, CoordinateMapError } from '../../src/geometry/coordinate-map';
import type { ManufacturingGraphData } from '../../src/manufacturing/graph/types';

// ─── Minimal graph builder ────────────────────────────────────────────────────

function graphWithPanel(id = 'p1'): ManufacturingGraphData {
  const nodes = new Map<any, any>();
  nodes.set(id, {
    type: 'PanelNode',
    id,
    bodyId: id,
    dirty: false,
    canonical: true,
    materialType: 'default',
    nominalThickness: 1.5,
    panelFrame: {
      origin: [0, 0, 0] as [number, number, number],
      u: [1, 0, 0] as [number, number, number],
      v: [0, 1, 0] as [number, number, number],
    },
  });
  return { nodes } as unknown as ManufacturingGraphData;
}

function emptyGraph(): ManufacturingGraphData {
  return { nodes: new Map() } as unknown as ManufacturingGraphData;
}

// ─── Contract: function signatures ───────────────────────────────────────────

describe('coordinate-map contract — function exports', () => {
  it('map3dTo2d is exported', () => {
    expect(typeof map3dTo2d).toBe('function');
  });

  it('map2dTo3d is exported', () => {
    expect(typeof map2dTo3d).toBe('function');
  });
});

// ─── Contract: CoordinateMapResult shape ─────────────────────────────────────

describe('coordinate-map contract — CoordinateMapResult shape', () => {
  it('success result has panelId (string), xy ([number, number]), errorMm (number)', () => {
    const graph = graphWithPanel('panel-1');
    const result = map3dTo2d([5, 10, 0], graph);
    expect('xy' in result).toBe(true);
    const r = result as CoordinateMapResult;
    expect(typeof r.panelId).toBe('string');
    expect(Array.isArray(r.xy)).toBe(true);
    expect(r.xy.length).toBe(2);
    expect(typeof r.xy[0]).toBe('number');
    expect(typeof r.xy[1]).toBe('number');
    expect(typeof r.errorMm).toBe('number');
  });

  it('map2dTo3d success result has point3d ([number, number, number]) and errorMm (0)', () => {
    const graph = graphWithPanel('panel-1');
    const result = map2dTo3d('panel-1', [5, 10], graph);
    expect('point3d' in result).toBe(true);
    const r = result as { point3d: [number, number, number]; errorMm: number };
    expect(Array.isArray(r.point3d)).toBe(true);
    expect(r.point3d.length).toBe(3);
    r.point3d.forEach((c) => expect(typeof c).toBe('number'));
    expect(r.errorMm).toBe(0);
  });
});

// ─── Contract: error codes ────────────────────────────────────────────────────

describe('coordinate-map contract — error codes', () => {
  it('returns code GE_POINT_NOT_ON_PANEL for points > 0.1 mm off any surface', () => {
    const graph = graphWithPanel();
    const result = map3dTo2d([0, 0, 50], graph) as CoordinateMapError;
    expect('code' in result).toBe(true);
    expect(result.code).toBe('GE_POINT_NOT_ON_PANEL');
  });

  it('GE_POINT_NOT_ON_PANEL includes nearestPanelId and distanceMm', () => {
    const graph = graphWithPanel('panel-x');
    const result = map3dTo2d([0, 0, 50], graph) as CoordinateMapError;
    expect(result.nearestPanelId).toBe('panel-x');
    expect(typeof result.distanceMm).toBe('number');
    expect((result.distanceMm ?? 0)).toBeGreaterThan(0.1);
  });

  it('returns code GE_PANEL_NO_FRAME when no panel has a panelFrame', () => {
    const nodes = new Map<any, any>();
    nodes.set('p1', { type: 'PanelNode', id: 'p1', bodyId: 'p1', dirty: false, canonical: true });
    const graph = { nodes } as unknown as ManufacturingGraphData;
    const result = map3dTo2d([0, 0, 0], graph) as CoordinateMapError;
    expect('code' in result).toBe(true);
    expect(result.code).toBe('GE_PANEL_NO_FRAME');
  });

  it('map2dTo3d returns GE_POINT_NOT_ON_PANEL for unknown panel ID', () => {
    const graph = graphWithPanel('p1');
    const result = map2dTo3d('not-a-panel', [0, 0], graph) as CoordinateMapError;
    expect('code' in result).toBe(true);
    expect(result.code).toBe('GE_POINT_NOT_ON_PANEL');
  });

  it('map2dTo3d returns GE_PANEL_NO_FRAME for panel missing panelFrame', () => {
    const nodes = new Map<any, any>();
    nodes.set('p1', { type: 'PanelNode', id: 'p1', bodyId: 'p1', dirty: false, canonical: true });
    const graph = { nodes } as unknown as ManufacturingGraphData;
    const result = map2dTo3d('p1', [0, 0], graph) as CoordinateMapError;
    expect('code' in result).toBe(true);
    expect(result.code).toBe('GE_PANEL_NO_FRAME');
  });
});

// ─── Contract: error object shape ────────────────────────────────────────────

describe('coordinate-map contract — CoordinateMapError shape', () => {
  it('error result has code (string) and message (string)', () => {
    const graph = graphWithPanel();
    const result = map3dTo2d([0, 0, 100], graph) as CoordinateMapError;
    expect(typeof result.code).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('empty graph returns error with code (not a success result)', () => {
    const result = map3dTo2d([0, 0, 0], emptyGraph());
    expect('code' in result).toBe(true);
  });
});
