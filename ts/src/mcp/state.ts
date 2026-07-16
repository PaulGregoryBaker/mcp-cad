/**
 * Shared MCP session state.
 *
 * All mutable singletons that were previously scattered through tools.ts live
 * here so that handler modules can import them without circular dependencies.
 */

import { GeometryBinding, GeometryAddon, geometryBinding as defaultBinding } from '../geometry/binding.js';
import { throwError, ErrorCodes } from './errors.js';
import type { SemanticStore } from '../semantic/semantic_store.js';
import { ManufacturingGraph } from '../manufacturing/graph/graph.js';
import { GeometrySolver } from '../manufacturing/graph/solver.js';
import type { GeometryBinding as SolverGeometryBinding } from '../manufacturing/graph/solver.js';
import { FoldabilityChecker } from '../manufacturing/graph/foldability.js';
import { toNodeId } from '../manufacturing/graph/types.js';
import { parseFirstClosedPolyline } from '../manufacturing/dxf/merge.js';

// ─── Geometry binding override (test seam) ────────────────────────────────────

let overrideBinding: GeometryBinding | undefined;

export function setGeometryBindingMock(mock: GeometryAddon | undefined) {
  overrideBinding = mock !== undefined ? new GeometryBinding(mock) : undefined;
}

export function getGeometryBinding() {
  return overrideBinding ?? defaultBinding;
}

// ─── Feature 011 constants (Constitution §VIII: no inline magic numbers) ──────

/** Maximum edge offset (mm) that merge_bodies_with_bend will auto-correct. */
export const MERGE_EDGE_ALIGNMENT_TOLERANCE_MM = 2;

/** Maximum round-trip error (mm) tolerated by 3D-to-2D coordinate mapping. */
export const COORD_MAP_ACCURACY_THRESHOLD_MM = 0.1;

// ─── Semantic store ───────────────────────────────────────────────────────────

let _semanticStore: SemanticStore | null = null;

export function setSemanticStore(store: SemanticStore): void {
  _semanticStore = store;
}

export function getSemanticStore(): SemanticStore {
  if (!_semanticStore) {
    throwError(
      ErrorCodes.PERSISTENCE_UNAVAILABLE,
      'Semantic store is not initialised. Ensure persistence.driver is configured.',
      false,
    );
  }
  return _semanticStore;
}

export function tryGetSemanticStore(): SemanticStore | null {
  return _semanticStore;
}

// ─── Solver geometry binding adapter ─────────────────────────────────────────
// Adapts the class-based GeometryBinding to the solver's GeometryBinding interface

export function getGraphBinding(): SolverGeometryBinding {
  const gb = getGeometryBinding();
  const hasBuildSheetFromDxf = gb.hasBuildSheetFromDxf();
  const hasThickenSheet = gb.hasThickenSheet();
  const hasApplyBend = gb.hasApplyBend();

  return {
    createSnapshot: (label) => gb.createSnapshot(label),
    restoreSnapshot: (id) => {
      const r = gb.restoreSnapshot(id);
      return { restoredSolidIds: r.restoredSolidIds, restoredShellIds: r.restoredShellIds };
    },
    mergeBodiesWithBend: (a, b, edges, radius) => {
      const r = gb.mergeBodiesWithBend(a, b, edges, radius);
      return { mergedShellId: r.mergedShellId };
    },
    splitBodyByBends: (partId, angle, maxT, defT) => {
      const r = gb.splitBodyByBends(partId, angle, maxT, defT);
      return { panel_ids: r.panel_ids };
    },
    fuseBodies: (tools, tol) => {
      const r = gb.fuseBodies(tools, tol);
      return { solid_id: r.solid_id };
    },
    cutBodies: (blank, tools, keep) => {
      const r = gb.cutBodies(blank, tools, keep);
      return { solid_id: r.solid_id };
    },
    buildSheetFromDxf: hasBuildSheetFromDxf
      ? (dxfContent) => {
          const r = gb.buildSheetFromDxf(dxfContent);
          return { sheetId: r.sheetId };
        }
      : undefined,
    thickenSheet: hasThickenSheet
      ? (sheetId, thicknessMm) => {
          const r = gb.thickenSheet(sheetId, thicknessMm);
          return { solidId: r.solidId };
        }
      : undefined,
    applyBend: hasApplyBend
      ? (panelAId, panelBId, innerRadiusMm, angleDeg, kFactor) => {
          const r = gb.applyBend(panelAId, panelBId, innerRadiusMm, angleDeg, kFactor);
          return { mergedShellId: r.mergedShellId };
        }
      : undefined,
  };
}

// ─── Manufacturing Graph per-part management ──────────────────────────────────
//
// Each part has its own Manufacturing Graph DAG. Tools that operate on a graph
// accept an explicit `part_id` parameter to select which part to work on.

const _parts: Map<string, ManufacturingGraph> = new Map();
let _activePartId: string | undefined;
let _geometrySolver: GeometrySolver | undefined;
let _foldabilityChecker: FoldabilityChecker | undefined;

export function resetMcpGraphStateForTests(): void {
  _parts.clear();
  _activePartId = undefined;
  _geometrySolver = undefined;
  _foldabilityChecker = undefined;
}

export function initializeSolvers(): void {
  if (!_geometrySolver) {
    _geometrySolver = new GeometrySolver();
    _foldabilityChecker = new FoldabilityChecker();
  }
}

export function findGraphOwner(bodyId: string): { partId: string; nodeId: import('../manufacturing/graph/types.js').NodeId } | null {
  for (const [partId, graph] of _parts) {
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode') {
        if (node.bodyId === bodyId || (node.id as string) === bodyId) {
          return { partId, nodeId: node.id };
        }
      }
    }
  }
  return null;
}

export function createPart(partId: string): ManufacturingGraph {
  if (_parts.has(partId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" already exists in this session.`,
      true,
      'reset_graph',
    );
  }
  initializeSolvers();
  const graph = new ManufacturingGraph(partId);
  _parts.set(partId, graph);
  _activePartId = partId;
  return graph;
}

export function getManufacturingGraph(partId: string): ManufacturingGraph {
  const graph = _parts.get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session. Use create_part first or call bootstrap_graph.`,
      true,
      'create_part',
    );
  }
  return graph;
}

export function setActivePart(partId: string): void {
  const graph = _parts.get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session.`,
      true,
      'create_part',
    );
  }
  _activePartId = partId;
}

export function deletePart(partId: string): void {
  if (!_parts.has(partId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session.`,
      true,
    );
  }
  _parts.delete(partId);
  if (_activePartId === partId) {
    _activePartId = _parts.keys().next().value;
  }
}

export function listParts(): Array<{ part_id: string; panel_count: number; bend_count: number }> {
  const result: Array<{ part_id: string; panel_count: number; bend_count: number }> = [];
  for (const [partId, graph] of _parts) {
    let panelCount = 0;
    let bendCount = 0;
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode') panelCount++;
      else if (node.type === 'BendNode') bendCount++;
    }
    result.push({ part_id: partId, panel_count: panelCount, bend_count: bendCount });
  }
  return result;
}

export function getGeometrySolver(): GeometrySolver {
  initializeSolvers();
  return _geometrySolver!;
}

export function getGraphFoldabilityChecker(): FoldabilityChecker {
  initializeSolvers();
  return _foldabilityChecker!;
}

export function getActivePartId(): string | undefined {
  return _activePartId;
}

export function setActivePartIdInternal(id: string | undefined): void {
  _activePartId = id;
}

export function getParts(): Map<string, ManufacturingGraph> {
  return _parts;
}

// ─── Manufacturing graph snapshot/restore (transaction support) ──────────────
//
// begin_transaction/rollback_transaction snapshot and restore the GEOMETRY
// KERNEL's state (see GeometryBinding.createSnapshot/restoreSnapshot), but
// that says nothing about the manufacturing graph above — a separate,
// TypeScript-side Map mutated by every graph-producing tool (split_body_by_bends,
// fuse_bodies, merge_bodies_with_bend, translate_body's panelFrame refresh,
// etc). Without also snapshotting THIS, rolling back a transaction restores
// the 3D shells but leaves the graph permanently stuck in its post-mutation
// state (e.g. a fused panel's source PanelNodes stay deleted) — so a
// subsequent "redo" of the same tool call sees no graph data for its inputs
// and silently falls back to a different, graph-unaware code path.

export interface PartsSnapshot {
  parts: Map<string, ManufacturingGraph>;
  activePartId: string | undefined;
}

export function snapshotParts(): PartsSnapshot {
  const cloned = new Map<string, ManufacturingGraph>();
  for (const [partId, graph] of _parts) {
    cloned.set(partId, graph.cloneDeep());
  }
  return { parts: cloned, activePartId: _activePartId };
}

export function restorePartsSnapshot(snapshot: PartsSnapshot): void {
  _parts.clear();
  for (const [partId, graph] of snapshot.parts) {
    _parts.set(partId, graph.cloneDeep());
  }
  _activePartId = snapshot.activePartId;
}

// ─── Test helper ─────────────────────────────────────────────────────────────

export function registerTestPart(partId: string, panelBodyIds: string[] = [], shapeDxf?: string): void {
  initializeSolvers();
  _parts.delete(partId);
  const graph = createPart(partId);

  let flatWidth = 100;
  let flatHeight = 100;
  if (shapeDxf) {
    try {
      const ring = parseFirstClosedPolyline(shapeDxf);
      let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
      let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
      for (const [x, y] of ring) {
        if (x < xMin) xMin = x; if (x > xMax) xMax = x;
        if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      }
      if (isFinite(xMin)) {
        flatWidth = xMax - xMin;
        flatHeight = yMax - yMin;
      }
    } catch {}
  }

  for (const bodyId of panelBodyIds) {
    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(bodyId),
      bodyId: bodyId as import('../manufacturing/graph/types.js').BodyId,
      dirty: false,
      materialType: 'default',
      nominalThickness: 1.0,
      flatWidth,
      flatHeight,
      canonical: true,
      shapeDxf: shapeDxf ?? null,
    } as any);
  }
}
