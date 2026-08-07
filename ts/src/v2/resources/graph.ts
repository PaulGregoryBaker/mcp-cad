/**
 * v2 graph resources — graph://part/{part_id}/map-2d-3d[?point=x,y] (Phase 5
 * Slice 1), graph://part/{part_id}/map-3d-2d?point=x,y,z (Phase 5 Slice 3,
 * rebuild/13-translation-module-design.md §4/§5),
 * graph://part/{part_id}/flat-pattern (Phase 5 Slice 7),
 * graph://part/{part_id}/findings (Phase 5 — manufacturability rules engine,
 * rebuild/06-plan.md), and viewport geometry resources (boundary, mesh).
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
 * resource the actual `map_2d_to_3d`/`map_3d_to_3d` resources 15-mcp-contract.md
 * §4.4 specifies, not just a Slice-1-scoped placeholder.
 */

import { throwError, ErrorCodes, type ErrorCode } from '../../mcp/errors';
import type { GraphStore } from '../graph/store';
import {
  evaluatePart,
  constructPart,
  mapPointToWorld,
  mapPointToFlat,
  evaluateFindings,
} from '../graph/evaluate-client';
import { geometryBinding } from '../../geometry/binding';
import { buildFlatPatternDxf } from './dxf';
import {
  v2BlobCache,
  computePartContentHash,
  buildBlobCacheKey,
  buildV2BlobUrl,
  type BlobCacheEntry,
} from '../blob-cache';
import type { z } from 'zod';
import { RefSchema } from '../schemas/shared';
import {
  RESOURCE_SCHEMAS,
  type ResourceKind,
  type PartsListResponse,
  type Map2d3dResponse,
  type Map3d2dResponse,
  type FlatPatternResponse,
  type FullResponse,
  type FindingsResponse,
  type BoundaryEnvelopeResponse,
  type MeshEnvelopeResponse,
} from '../schemas/resources';

/** Validates a resource's return value against its own declared schema
 * (schemas/resources.ts) before it ever reaches a client — "sending
 * evaluates against the schema." A mismatch here is this server's own bug
 * (the code produced a shape its own schema says is wrong), never the
 * caller's, so it fails loud as INTERNAL_ERROR rather than silently
 * shipping something malformed (the exact class of bug that prompted this:
 * recommendedFix.params reaching the client double-JSON-encoded). */
function validateResource(kind: ResourceKind, data: unknown): unknown {
  const result = RESOURCE_SCHEMAS[kind].safeParse(data);
  if (!result.success) {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `graph://.../${kind} produced a response that doesn't match its own schema: ${result.error.message}`,
      false,
    );
  }
  return result.data;
}

const PARTS_LIST_PATTERN = /^graph:\/\/parts$/;
const MAP_2D_3D_PATTERN = /^graph:\/\/part\/([^/]+)\/map-2d-3d$/;
const MAP_3D_2D_PATTERN = /^graph:\/\/part\/([^/]+)\/map-3d-2d$/;
const FLAT_PATTERN_PATTERN = /^graph:\/\/part\/([^/]+)\/flat-pattern$/;
const FULL_PATTERN = /^graph:\/\/part\/([^/]+)\/full$/;
const BOUNDARY_PATTERN = /^graph:\/\/part\/([^/]+)\/boundary$/;
const MESH_PATTERN = /^graph:\/\/part\/([^/]+)\/mesh$/;
const FINDINGS_PATTERN = /^graph:\/\/part\/([^/]+)\/findings$/;

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
      "The part's whole flat pattern (13 §3.3): one cut boundary (the part's own outline — unlike v1, there is no per-panel DXF to reassemble, since region panels are derived clips of this one outline, not separate cut pieces), every hole cut into it (cut_panel, Phase 5 Slice 9a — circle holes stay exact center+radius, never tessellated), one fold-line annotation per bend, and a DXF export (LWPOLYLINE on layer '0', holes and cuts on layer 'CUTS' — a native CIRCLE entity for round holes, matching v1's own convention — bend hinges as LINE entities on layer 'BEND'). `resolution` (mm) is accepted for forward compatibility with 14 §2's future bulge/arc OUTER-ring segments but currently has no effect — no v2 outline can contain one yet (K2 move-edge/smooth-edge is a later slice).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://parts',
    name: 'parts-list',
    description:
      'List every live part in the store (id, name, material, root region). `commit` is accepted for forward compatibility with future persistence (Slice 10, unbuilt) but currently has no effect — GraphStore is in-memory-per-process only today.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/full',
    name: 'part-full',
    description:
      "The complete graph for one part (14 B3a): every node (part/region-panel/bend row) plus current validation findings — no geometry (§3.0). Same computation backs graph://part/{id}/findings (15 §3.2: one computation, two projections).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/boundary',
    name: 'part-boundary',
    description:
      "The part's exact 3D boundary (13 §3.3, no tessellation): per-region bottomFace/topFace point arrays, hole rings, and per-bridge pivot/radius/hinge parametric data. Served as a Ref (15 §3.0) — a stable HTTP URL per part_id, not re-minted on every edit; the underlying blob is rebuilt in place when the part's own rows change.",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/findings',
    name: 'part-findings',
    description:
      'Every current manufacturability finding for this part (15 §3.2): rule violations, K5 3D conflicts, I3e stale anchors, seam residual violations — one aggregated, always-current list. Same shape as full\'s embedded findings (one computation, two projections — per 15 §3.2). An empty findings array means everything passes at the current profile.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://part/{part_id}/mesh{?resolution}',
    name: 'part-mesh',
    description:
      "A tessellated GLB of the part's constructed 3D solid, served as a Ref (15 §3.0) at a stable HTTP URL per part_id. `resolution` (mm) is accepted for forward compatibility but currently has no effect — exportGlb has no resolution parameter yet.",
    mimeType: 'application/json',
  },
];

export function matchesGraphResource(uri: string): boolean {
  // Covers both graph://part/{id}/... (per-part resources) and the
  // project-level graph://parts list (no trailing part id).
  return uri.startsWith('graph://part');
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

function readMap2d3d(store: GraphStore, partId: string, queryString: string | undefined): Map2d3dResponse {
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

function readMap3d2d(store: GraphStore, partId: string, queryString: string | undefined): Map3d2dResponse {
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
  /** See BendRow.radiusMeasured's own doc comment — false means radiusMm is
   * import_part's unmeasured placeholder, not a real value. */
  radiusMeasured: boolean;
}

function readFlatPattern(store: GraphStore, partId: string): FlatPatternResponse {
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
    radiusMeasured: b.radiusMeasured,
  }));

  const { entry } = ensureFlatPatternDxfBlobFresh(store, partId);
  const key = buildBlobCacheKey(partId, 'flat-pattern', 'default');

  return {
    partId,
    thicknessMm: part.thicknessMm,
    kFactor: part.kFactor,
    outline: part.outline,
    holes: part.holes,
    regionPanels,
    bendLines,
    ref: toRef(entry, buildV2BlobUrl(key)),
  };
}

/** Builds the flat-pattern DXF blob's bytes (15 §3.0/§3.3 — geometry
 * payloads, including flat-pattern point/DXF data, are always a `Ref`, never
 * inline). Same role as `ensureBoundaryBlobFresh`/`ensureMeshBlobFresh`, and
 * shared with `checkSubscriptionsForDrift` the same way (server.ts's
 * `GEOMETRY_RESOURCE_PATTERN` includes `flat-pattern` alongside mesh/boundary).
 *
 * Added 2026-07-28: flat-pattern (Slice 7) predates the blob-cache
 * infrastructure (Slice 7b) — this was the one geometry resource still
 * returning its payload inline, an implementation gap against 15 §3.3, not a
 * deliberate deviation (unlike mesh/boundary's documented stable-URL choice,
 * see the file header comment). `outline`/`holes`/`regionPanels`/`bendLines`
 * stay inline: they're the same small structural-metadata scale as
 * `bendLines` always was, not the unbounded-size concern `dxf` text is for a
 * real multi-entity drawing. */
export function ensureFlatPatternDxfBlobFresh(
  store: GraphStore,
  partId: string,
): { entry: BlobCacheEntry; changed: boolean } {
  const part = store.getPart(partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }
  const snapshot = store.snapshotPart(partId);
  const bendLines: FlatPatternBend[] = snapshot.bends.map((b) => ({
    bendId: b.bendId,
    hingeA: b.hingeA,
    hingeB: b.hingeB,
    angleDeg: b.angleDeg,
    radiusMm: b.radiusMm,
    radiusMeasured: b.radiusMeasured,
  }));
  const key = buildBlobCacheKey(partId, 'flat-pattern', 'default');
  const currentHash = computePartContentHash(store, partId);
  const before = v2BlobCache.get(key);
  const entry = v2BlobCache.getOrRebuild(key, 'application/dxf', currentHash, () =>
    Buffer.from(buildFlatPatternDxf(part.outline, bendLines, part.holes), 'utf8'),
  );
  const changed = !before || before.builtFromContentHash !== entry.builtFromContentHash;
  return { entry, changed };
}

interface PartsListEntry {
  partId: string;
  name: string;
  materialId: string;
  rootRegionPanelId: string;
}

function readPartsList(store: GraphStore): PartsListResponse {
  const { parts } = store.serialize();
  // mergedIntoPartId is always null today (no cross-part merge/fuse tool
  // aliases a part away permanently from this list's own point of view —
  // filtered defensively so this list stays correct if that ever changes).
  const entries: PartsListEntry[] = parts
    .filter((p) => p.mergedIntoPartId === null)
    .map((p) => ({
      partId: p.partId,
      name: p.name,
      materialId: p.materialId,
      rootRegionPanelId: p.rootRegionPanelId,
    }));
  return { parts: entries };
}

function readFull(store: GraphStore, partId: string): FullResponse {
  const part = store.getPart(partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }
  const snapshot = store.snapshotPart(partId);
  const findingsResult = evaluateFindings(store, partId);
  return {
    partId,
    part: snapshot.part,
    regionPanels: snapshot.regionPanels,
    bends: snapshot.bends,
    findings: findingsResult.findings,
  };
}

/** Dedicated findings resource — same computation as full's embedded
 * findings (15 §3.2's "one computation, two projections" rule), fetched
 * directly without the rest of the graph structure. */
function readFindings(store: GraphStore, partId: string): FindingsResponse {
  if (!store.getPart(partId)) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }
  const result = evaluateFindings(store, partId);
  return { partId, findings: result.findings };
}

interface BoundaryRegionPanel {
  regionPanelId: string;
  bottomFace: Array<{ x: number; y: number; z: number }>;
  topFace: Array<{ x: number; y: number; z: number }>;
  regionPolygonHoles: Array<Array<{ x: number; y: number }>>;
  regionCircleHoles: Array<{ center: { x: number; y: number }; radiusMm: number }>;
}

interface BoundaryBridge {
  bendId: string;
  parentRegionPanelId: string;
  childRegionPanelId: string;
  pivotOriginWorld: { x: number; y: number; z: number };
  pivotAxisWorld: { x: number; y: number; z: number };
  angleDeg: number;
  radiusMm: number;
  hingeA: { x: number; y: number };
  hingeB: { x: number; y: number };
}

/** Builds the boundary JSON blob's bytes and returns whether the cache entry
 * changed as a result (no prior entry, or the hash actually differed) —
 * `changed` lets a caller (e.g. a subscription drift check) decide whether a
 * `notifications/resources/updated` push is warranted. Shared by the
 * `graph://part/{id}/boundary` resource read AND server.ts's own
 * subscription drift check — one computation, not two independently
 * maintained ones. */
export function ensureBoundaryBlobFresh(
  store: GraphStore,
  partId: string,
): { entry: BlobCacheEntry; changed: boolean } {
  const evaluated = evaluatePart(store, partId);
  if (!evaluated.ok) {
    throwError(
      (evaluated.errorCode || ErrorCodes.INTERNAL_ERROR) as ErrorCode,
      evaluated.message || `evaluatePartGraph failed for part ${partId}`,
      false,
    );
  }
  const snapshot = store.snapshotPart(partId);
  const bendsById = new Map(snapshot.bends.map((b) => [b.bendId, b]));

  const regionPanels: BoundaryRegionPanel[] = evaluated.panels.map((p) => ({
    regionPanelId: p.regionPanelId,
    bottomFace: p.bottomFace,
    topFace: p.topFace,
    regionPolygonHoles: p.regionPolygonHoles,
    regionCircleHoles: p.regionCircleHoles,
  }));
  const bridges: BoundaryBridge[] = evaluated.bridges.map((br) => {
    const bend = bendsById.get(br.bendId);
    if (!bend) {
      throwError(ErrorCodes.INTERNAL_ERROR, `bridge references unknown bend ${br.bendId}`, false);
    }
    return {
      bendId: br.bendId,
      parentRegionPanelId: br.parentRegionPanelId,
      childRegionPanelId: br.childRegionPanelId,
      pivotOriginWorld: br.pivotOriginWorld,
      pivotAxisWorld: br.pivotAxisWorld,
      angleDeg: br.angleDeg,
      radiusMm: bend.radiusMm,
      hingeA: bend.hingeA,
      hingeB: bend.hingeB,
    };
  });

  const key = buildBlobCacheKey(partId, 'boundary', 'default');
  const currentHash = computePartContentHash(store, partId);
  const before = v2BlobCache.get(key);
  const entry = v2BlobCache.getOrRebuild(key, 'application/json', currentHash, () =>
    Buffer.from(JSON.stringify({ partId, regionPanels, bridges }), 'utf8'),
  );
  const changed = !before || before.builtFromContentHash !== entry.builtFromContentHash;
  return { entry, changed };
}

/** Same role as `ensureBoundaryBlobFresh`, for the tessellated GLB. */
export function ensureMeshBlobFresh(
  store: GraphStore,
  partId: string,
): { entry: BlobCacheEntry; changed: boolean } {
  const key = buildBlobCacheKey(partId, 'mesh', 'default');
  const currentHash = computePartContentHash(store, partId);
  const before = v2BlobCache.get(key);
  const entry = v2BlobCache.getOrRebuild(key, 'model/gltf-binary', currentHash, () => {
    const constructed = constructPart(store, partId);
    return geometryBinding.exportGlb(constructed.shellId);
  });
  const changed = !before || before.builtFromContentHash !== entry.builtFromContentHash;
  return { entry, changed };
}

function toRef(entry: BlobCacheEntry, url: string): z.infer<typeof RefSchema> {
  return {
    url,
    contentType: entry.contentType,
    byteSize: entry.buffer.length,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

function readBoundary(store: GraphStore, partId: string): BoundaryEnvelopeResponse {
  const part = store.getPart(partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }
  const { entry } = ensureBoundaryBlobFresh(store, partId);
  const key = buildBlobCacheKey(partId, 'boundary', 'default');
  return { partId, ref: toRef(entry, buildV2BlobUrl(key)) };
}

function readMesh(store: GraphStore, partId: string): MeshEnvelopeResponse {
  const part = store.getPart(partId);
  if (!part) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }
  const { entry } = ensureMeshBlobFresh(store, partId);
  const key = buildBlobCacheKey(partId, 'mesh', 'default');
  return { partId, ref: toRef(entry, buildV2BlobUrl(key)) };
}

export function readGraphResource(store: GraphStore, rawUri: string): unknown {
  const [uri, queryString] = rawUri.split('?', 2);

  if (PARTS_LIST_PATTERN.exec(uri ?? '')) {
    return validateResource('parts', readPartsList(store));
  }

  const map2d3dMatch = MAP_2D_3D_PATTERN.exec(uri ?? '');
  if (map2d3dMatch) {
    return validateResource(
      'map-2d-3d',
      readMap2d3d(store, decodeURIComponent(map2d3dMatch[1]), queryString),
    );
  }

  const map3d2dMatch = MAP_3D_2D_PATTERN.exec(uri ?? '');
  if (map3d2dMatch) {
    return validateResource(
      'map-3d-2d',
      readMap3d2d(store, decodeURIComponent(map3d2dMatch[1]), queryString),
    );
  }

  const flatPatternMatch = FLAT_PATTERN_PATTERN.exec(uri ?? '');
  if (flatPatternMatch) {
    return validateResource('flat-pattern', readFlatPattern(store, decodeURIComponent(flatPatternMatch[1])));
  }

  const fullMatch = FULL_PATTERN.exec(uri ?? '');
  if (fullMatch) {
    return validateResource('full', readFull(store, decodeURIComponent(fullMatch[1])));
  }

  const boundaryMatch = BOUNDARY_PATTERN.exec(uri ?? '');
  if (boundaryMatch) {
    return validateResource('boundary', readBoundary(store, decodeURIComponent(boundaryMatch[1])));
  }

  const meshMatch = MESH_PATTERN.exec(uri ?? '');
  if (meshMatch) {
    return validateResource('mesh', readMesh(store, decodeURIComponent(meshMatch[1])));
  }

  const findingsMatch = FINDINGS_PATTERN.exec(uri ?? '');
  if (findingsMatch) {
    return validateResource('findings', readFindings(store, decodeURIComponent(findingsMatch[1])));
  }

  throwError(ErrorCodes.INTERNAL_ERROR, `Unrecognized v2 graph resource URI: ${rawUri}`, false);
}
