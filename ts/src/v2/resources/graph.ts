/**
 * v2 graph resources — graph://part/{part_id}/map-2d-3d[?point=x,y] (Phase 5
 * Slice 1), graph://part/{part_id}/map-3d-2d?point=x,y,z (Phase 5 Slice 3,
 * rebuild/13-translation-module-design.md §4/§5), and
 * graph://part/{part_id}/flat-pattern (Phase 5 Slice 7, rebuild/06-plan.md
 * §4.4 — the single highest-value remaining Derive resource: a 2026-07-25
 * inventory of v1's non-v2 test files found 26 depend on unfold/DXF export
 * vs 0 on `get_drawings` and 2 on validation/findings tools, so this slice
 * scopes to flat-pattern only; drawings/findings are deferred to a later
 * slice, same "unblock the most real test-coverage migration" discipline
 * Slice 6 used).
 *
 * Read-only: evaluates the part (via evaluate-client.ts, the ONE place graph
 * rows become addon calls) and returns either the full per-region-panel 2D
 * vertex <-> 3D mapping (no `point` query — the original Slice 1 overview
 * shape, elementwise zips of already index-aligned addon arrays, no
 * geometric derivation of its own), OR, when a `point` query is given, the
 * result of the real forward/reverse point mapping (mapPointToWorld /
 * mapPointToFlat) — an ARBITRARY point within a region or bend-bridge zone,
 * not limited to the outline's own vertices the way Slice 1's original
 * exact-match-only `point` query was. That generalization is what makes this
 * resource the actual `map_2d_to_3d`/`map_3d_to_2d` resources 15-mcp-contract.md
 * §4.4 specifies, not just a Slice-1-scoped placeholder.
 */

import { throwError, ErrorCodes, type ErrorCode } from '../../mcp/errors';
import type { GraphStore } from '../graph/store';
import { evaluatePart, mapPointToWorld, mapPointToFlat } from '../graph/evaluate-client';
import { buildFlatPatternDxf } from './dxf';

const MAP_2D_3D_PATTERN = /^graph:\/\/part\/([^/]+)\/map-2d-3d$/;
const MAP_3D_2D_PATTERN = /^graph:\/\/part\/([^/]+)\/map-3d-2d$/;
const FLAT_PATTERN_PATTERN = /^graph:\/\/part\/([^/]+)\/flat-pattern$/;

export const graphResourceTemplates = [
  {
    uriTemplate: 'graph://part/{part_id}/map-2d-3d{?point}',
    name: 'part-map-2d-3d',
    description:
      "Forward mapping (13 §4): with no query, every region panel's 2D flat outline <-> 3D pose vertex mapping. With point=x,y, maps that arbitrary 2D point (in any region panel or bend-bridge zone) to its 3D world position via mapPointToWorld.",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/map-3d-2d?point={point}',
    name: 'part-map-3d-2d',
    description:
      'Reverse mapping (13 §5): maps a 3D world point (point=x,y,z) back to its owning region panel or bend-bridge zone and 2D flat-pattern position via mapPointToFlat — GE_POINT_NOT_ON_PART if no candidate chain claims it.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/flat-pattern{?resolution}',
    name: 'part-flat-pattern',
    description:
      "The part's whole flat pattern (13 §3.3): one cut boundary (the part's own outline — unlike v1, there is no per-panel DXF to reassemble, since region panels are derived clips of this one outline, not separate cut pieces), one fold-line annotation per bend, and a DXF export (LWPOLYLINE on layer '0' + one LINE per bend hinge on layer 'BEND'). `resolution` (mm) is accepted for forward compatibility with 14 §2's future bulge/arc ring segments but currently has no effect — no v2 outline can contain one yet (K2 move-edge/smooth-edge is a later slice).",
    mimeType: 'application/json',
  },
];

export function matchesGraphResource(uri: string): boolean {
  return uri.startsWith('graph://part/');
}

interface VertexMapping {
  regionPanelId: string;
  point2d: { x: number; y: number };
  bottom3d: { x: number; y: number; z: number };
  top3d: { x: number; y: number; z: number };
}

function parseNumberList(raw: string, count: number, label: string): number[] {
  const parts = raw.split(',');
  if (parts.length !== count) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Invalid point query parameter: "${raw}" (expected ${label})`,
      false,
    );
  }
  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v))) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Invalid point query parameter: "${raw}" (expected ${label})`,
      false,
    );
  }
  return values;
}

function readMap2d3d(store: GraphStore, partId: string, queryString: string | undefined): unknown {
  const params = new URLSearchParams(queryString ?? '');
  const pointParam = params.get('point');

  if (pointParam === null) {
    const result = evaluatePart(store, partId);
    if (!result.ok) {
      throwError(
        (result.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
        result.message || `evaluatePartGraph failed for part ${partId}`,
        false,
      );
    }
    const mappings: VertexMapping[] = [];
    for (const panel of result.panels) {
      for (let i = 0; i < panel.regionOuter.length; i++) {
        mappings.push({
          regionPanelId: panel.regionPanelId,
          point2d: panel.regionOuter[i],
          bottom3d: panel.bottomFace[i],
          top3d: panel.topFace[i],
        });
      }
    }
    return { partId, mappings };
  }

  const [x, y] = parseNumberList(pointParam, 2, '"x,y"');
  const result = mapPointToWorld(store, partId, { x, y });
  if (!result.ok) {
    throwError(
      (result.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      result.message || `point (${x},${y}) is not on part ${partId}`,
      true,
    );
  }
  return {
    partId,
    point2d: { x, y },
    point3d: result.point3d,
    regionPanelId: result.regionPanelId,
    bendId: result.bendId,
  };
}

function readMap3d2d(store: GraphStore, partId: string, queryString: string | undefined): unknown {
  const params = new URLSearchParams(queryString ?? '');
  const pointParam = params.get('point');
  if (pointParam === null) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      'map-3d-2d requires a point=x,y,z query parameter',
      false,
    );
  }

  const [x, y, z] = parseNumberList(pointParam, 3, '"x,y,z"');
  const result = mapPointToFlat(store, partId, { x, y, z });
  if (!result.ok) {
    throwError(
      (result.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      result.message || `point (${x},${y},${z}) is not on part ${partId}`,
      true,
    );
  }
  return {
    partId,
    point3d: { x, y, z },
    point2d: result.point2d,
    regionPanelId: result.regionPanelId,
    bendId: result.bendId,
    residualMm: result.residualMm,
  };
}

interface FlatPatternRegionPanel {
  regionPanelId: string;
  outer: Array<{ x: number; y: number }>;
}

interface FlatPatternBend {
  bendId: string;
  hingeA: { x: number; y: number };
  hingeB: { x: number; y: number };
  angleDeg: number;
  radiusMm: number;
}

function readFlatPattern(store: GraphStore, partId: string): unknown {
  const part = store.getPart(partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }

  const evaluated = evaluatePart(store, partId);
  if (!evaluated.ok) {
    throwError(
      (evaluated.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      evaluated.message || `evaluatePartGraph failed for part ${partId}`,
      false,
    );
  }
  const regionPanels: FlatPatternRegionPanel[] = evaluated.panels.map((p) => ({
    regionPanelId: p.regionPanelId,
    outer: p.regionOuter,
  }));

  const snapshot = store.snapshotPart(partId);
  const bendLines: FlatPatternBend[] = snapshot.bends.map((b) => ({
    bendId: b.bendId,
    hingeA: b.hingeA,
    hingeB: b.hingeB,
    angleDeg: b.angleDeg,
    radiusMm: b.radiusMm,
  }));

  return {
    partId,
    thicknessMm: part.thicknessMm,
    kFactor: part.kFactor,
    outline: part.outline,
    regionPanels,
    bendLines,
    dxf: buildFlatPatternDxf(part.outline, bendLines),
  };
}

export function readGraphResource(store: GraphStore, rawUri: string): unknown {
  const [uri, queryString] = rawUri.split('?', 2);

  const map2d3dMatch = MAP_2D_3D_PATTERN.exec(uri ?? '');
  if (map2d3dMatch) {
    return readMap2d3d(store, decodeURIComponent(map2d3dMatch[1]), queryString);
  }

  const map3d2dMatch = MAP_3D_2D_PATTERN.exec(uri ?? '');
  if (map3d2dMatch) {
    return readMap3d2d(store, decodeURIComponent(map3d2dMatch[1]), queryString);
  }

  const flatPatternMatch = FLAT_PATTERN_PATTERN.exec(uri ?? '');
  if (flatPatternMatch) {
    return readFlatPattern(store, decodeURIComponent(flatPatternMatch[1]));
  }

  throwError(ErrorCodes.INTERNAL_ERROR, `Unrecognized v2 graph resource URI: ${rawUri}`, false);
}
