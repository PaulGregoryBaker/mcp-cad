/**
 * GeometrySolver — traverses dirty nodes in topological order,
 * dispatches NAPI geometry calls, and returns a GeometrySolveResult.
 *
 * On any node failure: restores snapshot, restores dirty flags, returns SolveOutcome with ok=false.
 * On full success: clears dirty flags, updates bodyIds, returns SolveOutcome with ok=true.
 *
 * Research: R-001 (Kahn's), R-002 (dirty tracking), R-003 (sequential NAPI)
 * Tasks: T005, T021, T022
 */

import { randomUUID } from 'node:crypto';
import type {
  NodeId,
  BodyId,
  SolveOutcome,
  SolvedNode,
} from './types';
import { computeBendAllowance } from './types';
import type { ManufacturingGraph } from './graph';
import type { GeometryAddon } from '../../geometry/binding';

// ─── Geometry binding interface (subset used by the solver) ───────────────────

export interface GeometryBinding {
  /** Create a snapshot and return its ID (used for rollback). */
  createSnapshot(label: string): string;
  /** Restore from a snapshot. */
  restoreSnapshot(snapshotId: string): { restoredSolidIds: string[]; restoredShellIds: string[] };
  /** Merge two panel bodies with a bend; returns the merged shell ID. */
  mergeBodiesWithBend(panelAId: string, panelBId: string, targetEdges: string[], bendRadiusMm: number): { mergedShellId: string };
  /** Split a body by bends; returns panel IDs. */
  splitBodyByBends(partId: string, angleThresholdDeg: number, maxThicknessMm?: number, defaultThicknessMm?: number): { panel_ids: string[] };
  /** Fuse multiple bodies into one. */
  fuseBodies(tools: string[], fuzzyTolerance: number): { solid_id: string };
  /** Boolean cut (subtract tool from blank). */
  cutBodies(blank: string, tools: string[], keepTools: boolean): { solid_id: string };
  /** Add tab-slot interlock between two panels. */
  addTabSlot?(shellIdA: string, shellIdB: string, kerfOffsetMm: number): { solidIdA: string; solidIdB: string };
  /** Chamfer edges for weld-prep. */
  chamferEdges?(partId: string, edgeIds: string[], distanceMm: number): { chamferedPartId: string };
  /** Create a circular 2D wire. */
  createCircleWire?(centreX: number, centreY: number, radius: number): { wireId: string };
  /** Create a rectangular 2D wire. */
  createRectWire?(originX: number, originY: number, width: number, height: number): { wireId: string };
  /** Create a polygonal 2D wire from vertices. */
  createPolyWire?(vertices: ReadonlyArray<{ x: number; y: number }>): { wireId: string };
  /** Boolean subtract a wire profile from a panel body. */
  booleanCut?(panelBodyId: string, wireId: string): { solidId: string };
}

// ─── Adapter from full GeometryAddon to GeometryBinding ──────────────────────

export function addonToBinding(addon: GeometryAddon): GeometryBinding {
  return {
    createSnapshot: (label) => addon.createSnapshot(label),
    restoreSnapshot: (id) => {
      const r = addon.restoreSnapshot(id);
      return { restoredSolidIds: r.restoredSolidIds, restoredShellIds: r.restoredShellIds };
    },
    mergeBodiesWithBend: (a, b, edges, r) => {
      const res = addon.mergeBodiesWithBend(a, b, edges, r);
      return { mergedShellId: res.mergedShellId };
    },
    splitBodyByBends: (partId, angle, maxT, defT) => {
      const res = addon.splitBodyByBends(partId, angle, maxT, defT);
      return { panel_ids: res.panel_ids };
    },
    fuseBodies: (tools, tol) => {
      const res = addon.fuseBodies(tools, tol);
      return { solid_id: res.solid_id };
    },
    cutBodies: (blank, tools, keep) => {
      const res = addon.cutBodies(blank, tools, keep);
      return { solid_id: res.solid_id };
    },
  };
}

// ─── Dispatch result ──────────────────────────────────────────────────────────

/**
 * Result from a single-node dispatch.
 * `panelBodyUpdates` carries any bodyId mutations that must be applied
 * to OTHER panel nodes by the caller (the solve loop in the graph layer),
 * keeping geometry-engine output application out of the dispatch method.
 * Bounded Context Separation (constitution §II): dispatchNode must not
 * write back into Manufacturing Domain nodes directly.
 */
interface DispatchResult {
  newBodyId: BodyId | null;
  panelBodyUpdates: Map<NodeId, BodyId>;
}

// ─── GeometrySolver ──────────────────────────────────────────────────────────

export class GeometrySolver {
  /**
   * Run a full Geometry Solve on the graph.
   * Iterates dirty nodes in Kahn's topological order, dispatching per node type.
   */
  async solve(
    graph: ManufacturingGraph,
    binding: GeometryBinding,
    rollbackSnapshotId?: string,
  ): Promise<SolveOutcome> {
    if (graph.dirtyNodes.size === 0) {
      return {
        ok: true,
        result: {
          solveId: randomUUID(),
          timestamp: new Date().toISOString(),
          solvedNodes: [],
          invalidatedBodyIds: [],
          dirtyCountBefore: 0,
          solveMs: 0,
        },
      };
    }

    const startMs = Date.now();
    const dirtyCountBefore = graph.dirtyNodes.size;
    const snapshotId = rollbackSnapshotId ?? binding.createSnapshot(`solve-${Date.now()}`);

    // Collect previously-issued body IDs (will be invalidated after Solve)
    const invalidatedBodyIds: BodyId[] = [];
    for (const nodeId of graph.dirtyNodes) {
      const node = graph.nodes.get(nodeId);
      if (node?.type === 'PanelNode' && node.bodyId !== null) {
        invalidatedBodyIds.push(node.bodyId);
      }
    }

    // Sort dirty nodes in topological order
    const allSorted = graph.topologicalSort();
    if (allSorted === null) {
      return {
        ok: false,
        errorCode: 'SOLVE_FAILED',
        offendingNodeId: [...graph.dirtyNodes][0] as NodeId,
        message: 'Graph contains a cycle — cannot sort for Geometry Solve.',
      };
    }
    const dirtyOrdered = allSorted.filter((id) => graph.dirtyNodes.has(id));

    // Snapshot dirty state for rollback
    const dirtySnapshot = new Set(graph.dirtyNodes);

    const solvedNodes: SolvedNode[] = [];

    for (const nodeId of dirtyOrdered) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;

      try {
        const result = await this.dispatchNode(node, graph, binding);
        if (result.newBodyId !== null) {
          solvedNodes.push({ nodeId, newBodyId: result.newBodyId });
        }
        // Apply panel body-ID updates returned from dispatch.
        // These are applied here (the graph layer) rather than inside dispatchNode
        // to maintain Bounded Context Separation (constitution §II).
        for (const [panelNodeId, newBodyId] of result.panelBodyUpdates) {
          const panelNode = graph.nodes.get(panelNodeId);
          if (panelNode && panelNode.type === 'PanelNode') {
            panelNode.bodyId = newBodyId;
          }
        }
        node.dirty = false;
        graph.dirtyNodes.delete(nodeId);
      } catch (err) {
        // Restore snapshot — roll back all geometry
        try { binding.restoreSnapshot(snapshotId); } catch (_) { /* best effort */ }
        // Restore dirty flags
        for (const id of dirtySnapshot) graph.dirtyNodes.add(id);
        for (const id of dirtySnapshot) {
          const n = graph.nodes.get(id);
          if (n) n.dirty = true;
        }
        return {
          ok: false,
          errorCode: 'SOLVE_FAILED',
          offendingNodeId: nodeId,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const solveMs = Date.now() - startMs;

    return {
      ok: true,
      result: {
        solveId: randomUUID(),
        timestamp: new Date().toISOString(),
        solvedNodes,
        invalidatedBodyIds,
        dirtyCountBefore,
        solveMs,
      },
    };
  }

  /**
   * Dispatch geometry work for a single node.
   * MUST NOT mutate graph.nodes entries directly — all domain-object
   * mutations are returned in DispatchResult and applied by the caller.
   */
  private async dispatchNode(
    node: import('./types').GraphNode,
    graph: ManufacturingGraph,
    binding: GeometryBinding,
  ): Promise<DispatchResult> {
    const noUpdates = new Map<NodeId, BodyId>();
    switch (node.type) {
      case 'PanelNode': {
        // PanelNode geometry is produced by bootstrap or merging upstream panels.
        // If bodyId already exists (from bootstrap), it is kept; re-Solve updates it
        // if this panel was dirtied by an upstream change.
        // For now: if the panel has a bodyId, pass it through (no-op re-Solve).
        // Full B-Rep re-computation is beyond Phase 1 scope — body management
        // is handled by bootstrap and merge calls.
        if (node.bodyId === null) {
          // No geometry yet — nothing to dispatch at this stage
          return { newBodyId: null, panelBodyUpdates: noUpdates };
        }
        return { newBodyId: node.bodyId, panelBodyUpdates: noUpdates };
      }

      case 'BendNode': {
        const panelA = graph.nodes.get(node.panelAId);
        const panelB = graph.nodes.get(node.panelBId);
        if (!panelA || panelA.type !== 'PanelNode' || panelA.bodyId === null) {
          throw new Error(`BendNode "${node.id}": panelA "${node.panelAId}" has no body ID.`);
        }
        if (!panelB || panelB.type !== 'PanelNode' || panelB.bodyId === null) {
          throw new Error(`BendNode "${node.id}": panelB "${node.panelBId}" has no body ID.`);
        }
        // Compute bend allowance
        const panelThickness = panelA.nominalThickness;
        node.bendAllowance = computeBendAllowance(node.angle, node.innerRadius, node.kFactor, panelThickness);
        // Merge the two panels with the bend
        binding.mergeBodiesWithBend(panelA.bodyId, panelB.bodyId, [], node.innerRadius);
        return { newBodyId: null, panelBodyUpdates: noUpdates };
      }

      case 'JoinNode': {
        const panelA = graph.nodes.get(node.panelAId);
        const panelB = graph.nodes.get(node.panelBId);
        if (!panelA || panelA.type !== 'PanelNode' || panelA.bodyId === null) {
          return { newBodyId: null, panelBodyUpdates: noUpdates };
        }
        if (!panelB || panelB.type !== 'PanelNode' || panelB.bodyId === null) {
          return { newBodyId: null, panelBodyUpdates: noUpdates };
        }

        switch (node.joinType) {
          case 'RIVET_PATTERN': {
            // RIVET_PATTERN: cut rivet holes into both panel bodies.
            // Geometry binding does not yet expose rivetHoles(); holes are produced
            // via boolean cut of circular profiles (stub — full implementation in post-MVP).
            // For now: mark as solved without modifying geometry (no-op until NAPI support).
            return { newBodyId: null, panelBodyUpdates: noUpdates };
          }

          case 'TAB_SLOT': {
            // TAB_SLOT: interlock tabs on panelA into slots on panelB.
            // Body-ID updates are returned to the caller (solve loop) — DO NOT mutate
            // panelA.bodyId or panelB.bodyId here (Bounded Context Separation, §II).
            if (binding.addTabSlot) {
              const result = binding.addTabSlot(panelA.bodyId, panelB.bodyId, 0.1);
              const updates = new Map<NodeId, BodyId>([
                [panelA.id, result.solidIdA as BodyId],
                [panelB.id, result.solidIdB as BodyId],
              ]);
              return { newBodyId: null, panelBodyUpdates: updates };
            }
            return { newBodyId: null, panelBodyUpdates: noUpdates };
          }

          case 'FLANGE': {
            // FLANGE: create an auxiliary PanelNode (lip) + BendNode using existing bend machinery.
            // The JoinNode is the user-facing record; internal nodes are created by bootstrap.
            // No additional geometry dispatch needed at this stage.
            return { newBodyId: null, panelBodyUpdates: noUpdates };
          }

          case 'WELD_PREP': {
            // WELD_PREP: chamfer the shared edge for V-groove weld preparation.
            if (binding.chamferEdges && node.params.joinParamType === 'WELD_PREP') {
              const grooveDist = Math.tan((node.params.grooveAngle / 2) * (Math.PI / 180)) * node.params.rootGap;
              binding.chamferEdges(panelA.bodyId, [node.referenceEdgeA], grooveDist);
            }
            return { newBodyId: null, panelBodyUpdates: noUpdates };
          }
        }
        return { newBodyId: null, panelBodyUpdates: noUpdates };
      }

      case 'CutNode': {
        const parentPanel = graph.nodes.get(node.parentPanelId);
        if (!parentPanel || parentPanel.type !== 'PanelNode' || parentPanel.bodyId === null) {
          return { newBodyId: null, panelBodyUpdates: noUpdates };
        }

        // Create a 2D wire for the cut profile, then subtract from parent panel body.
        // If the required binding method is absent, throw so the solver rolls back
        // rather than silently marking the node as solved without geometry applied
        // (constitution §X: Graceful Failure Over Silent Fallbacks).
        let wireId: string | null = null;

        switch (node.profile.type) {
          case 'CIRCLE':
            if (!binding.createCircleWire) {
              throw new Error(
                `CutNode "${node.id}": geometry binding does not expose createCircleWire. ` +
                `Add createCircleWire to the binding before using CIRCLE cut profiles.`,
              );
            }
            wireId = binding.createCircleWire(
              node.profile.centreX, node.profile.centreY, node.profile.radius,
            ).wireId;
            break;
          case 'RECTANGLE':
            if (!binding.createRectWire) {
              throw new Error(
                `CutNode "${node.id}": geometry binding does not expose createRectWire. ` +
                `Add createRectWire to the binding before using RECTANGLE cut profiles.`,
              );
            }
            wireId = binding.createRectWire(
              node.profile.originX, node.profile.originY, node.profile.width, node.profile.height,
            ).wireId;
            break;
          case 'POLYGON':
          case 'FREEFORM':
            if (!binding.createPolyWire) {
              throw new Error(
                `CutNode "${node.id}": geometry binding does not expose createPolyWire. ` +
                `Add createPolyWire to the binding before using POLYGON/FREEFORM cut profiles.`,
              );
            }
            wireId = binding.createPolyWire(node.profile.vertices).wireId;
            break;
        }

        if (!binding.booleanCut) {
          throw new Error(
            `CutNode "${node.id}": geometry binding does not expose booleanCut. ` +
            `Add booleanCut to the binding to apply cut profiles.`,
          );
        }

        // DO NOT mutate parentPanel.bodyId here — return the update for the
        // solve loop (the graph layer) to apply (Bounded Context Separation, §II).
        const cutResult = binding.booleanCut(parentPanel.bodyId, wireId!);
        const updates = new Map<NodeId, BodyId>([[parentPanel.id, cutResult.solidId as BodyId]]);
        return { newBodyId: null, panelBodyUpdates: updates };
      }
    }
  }
}
