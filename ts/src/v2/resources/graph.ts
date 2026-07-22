/**
 * v2 graph resources (Phase 5 Slice 1) — graph://part/{part_id}/map-2d-3d[?point=x,y].
 *
 * Read-only: evaluates the part (via evaluate-client.ts, the ONE place graph
 * rows become addon calls) and returns its region-panel 2D<->3D vertex
 * mapping as inline JSON (the full `Ref`/blob-store resource pattern is
 * deferred past this slice). Every 3D coordinate here is exactly what
 * ManufacturingGraphEvaluator computed — this module does no geometric
 * derivation of its own, only elementwise zips of already index-aligned
 * addon arrays (regionOuter[i] with bottomFace[i]/topFace[i]) and, when
 * `point` is given, an exact-match lookup via numerical-policy's
 * pointsNearlyEqual (a same-point comparison, not a geometric derivation —
 * constitution v2.0.0 principle IV).
 */

import { throwError, ErrorCodes, type ErrorCode } from '../../mcp/errors';
import { pointsNearlyEqual } from '../../geometry/numerical-policy';
import type { GraphStore } from '../graph/store';
import { evaluatePart } from '../graph/evaluate-client';

const URI_PATTERN = /^graph:\/\/part\/([^/]+)\/map-2d-3d$/;

export const graphResourceTemplates = [
  {
    uriTemplate: 'graph://part/{part_id}/map-2d-3d{?point}',
    name: 'part-map-2d-3d',
    description:
      'Per-region-panel 2D flat outline <-> 3D pose vertex mapping for a v2 graph part, as computed by ManufacturingGraphEvaluator. Optional point=x,y query filters to region-panel vertices matching that 2D point.',
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

export function readGraphResource(store: GraphStore, rawUri: string): unknown {
  const [uri, queryString] = rawUri.split('?', 2);
  const match = URI_PATTERN.exec(uri ?? '');
  if (!match) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Unrecognized v2 graph resource URI: ${rawUri}`, false);
  }
  const partId = decodeURIComponent(match[1]);

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

  const params = new URLSearchParams(queryString ?? '');
  const pointParam = params.get('point');
  if (pointParam === null) {
    return { partId, mappings };
  }

  const parts = pointParam.split(',');
  if (parts.length !== 2) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Invalid point query parameter: "${pointParam}" (expected "x,y")`,
      false,
    );
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Invalid point query parameter: "${pointParam}" (expected "x,y")`,
      false,
    );
  }

  const matches = mappings.filter((m) =>
    pointsNearlyEqual({ x: m.point2d.x, y: m.point2d.y, z: 0 }, { x, y, z: 0 }),
  );
  return { partId, point: { x, y }, matches };
}
