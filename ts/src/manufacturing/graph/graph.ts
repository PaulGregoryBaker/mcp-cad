/**
 * ManufacturingGraph — the core DAG data structure for sheet-metal fabrication intent.
 *
 * Implements:
 *   - Node add / update / remove with edge management
 *   - Kahn's topological sort (cycle detection is a by-product, research.md R-001)
 *   - Downstream dirty cascade (research.md R-002)
 *   - GEOMETRY_STALE warning helper
 *   - auto-Solve wrapper (mutateAndSolve) for single-step MCP tools
 *
 * Tasks: T004, T012–T019, T023, T024
 */

import {
  type NodeId,
  type GraphNode,
  type BendNode,
  type MutationResult,
  type GeometrySolveResult,
  type DrcViolation,
  type FlatPatternDimensions,
  type BendZone,
  computeBendAllowance,
} from './types';
import { ErrorCodes, throwError } from '../../mcp/errors';
import { transactionRegistry } from '../../mcp/transactions';

// ─── ManufacturingGraph ───────────────────────────────────────────────────────

export class ManufacturingGraph {
  readonly sessionId: string;
  rootPanelId: NodeId | null = null;
  readonly nodes: Map<NodeId, GraphNode> = new Map();
  /** Outgoing edges: node → Set<downstream node> */
  readonly edges: Map<NodeId, Set<NodeId>> = new Map();
  /** Incoming edges: node → Set<upstream node> (for Kahn's in-degree) */
  readonly reverseEdges: Map<NodeId, Set<NodeId>> = new Map();
  readonly dirtyNodes: Set<NodeId> = new Set();
  coplanarityThresholdDeg: number;

  /** Insertion-order tracking for non-topological queries */
  private insertionOrder: NodeId[] = [];

  constructor(sessionId: string, coplanarityThresholdDeg = 1.0) {
    this.sessionId = sessionId;
    this.coplanarityThresholdDeg = coplanarityThresholdDeg;
  }

  /**
   * Deep copy, independent of `this` — every node, edge set, and the
   * insertion-order list are cloned, not shared, so mutating either copy
   * afterwards never affects the other. Used to snapshot graph state
   * alongside the geometry kernel's own snapshot (see begin_transaction /
   * rollback_transaction) — without this, rolling back a transaction
   * restores the 3D shells but leaves the manufacturing graph (this class)
   * stuck in its post-mutation state, silently desyncing the two.
   */
  cloneDeep(): ManufacturingGraph {
    const clone = new ManufacturingGraph(this.sessionId, this.coplanarityThresholdDeg);
    clone.rootPanelId = this.rootPanelId;
    for (const [id, node] of this.nodes) {
      clone.nodes.set(id, structuredClone(node));
    }
    for (const [id, set] of this.edges) {
      clone.edges.set(id, new Set(set));
    }
    for (const [id, set] of this.reverseEdges) {
      clone.reverseEdges.set(id, new Set(set));
    }
    for (const id of this.dirtyNodes) {
      clone.dirtyNodes.add(id);
    }
    clone.insertionOrder = [...this.insertionOrder];
    return clone;
  }

  // ─── Topological sort (Kahn's algorithm) ───────────────────────────────────

  /**
   * Returns nodes in topological order, or null if the graph contains a cycle.
   * Uses in-degree BFS (Kahn's algorithm).
   */
  topologicalSort(): NodeId[] | null {
    const inDegree = new Map<NodeId, number>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }
    for (const [, upstreams] of this.reverseEdges) {
      for (const upstream of upstreams) {
        void upstream; // used below via downstreams
      }
    }
    // Build in-degree from reverseEdges: reverseEdges[node] = set of nodes that point TO node
    for (const id of this.nodes.keys()) {
      inDegree.set(id, this.reverseEdges.get(id)?.size ?? 0);
    }

    const queue: NodeId[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: NodeId[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const downstream of this.edges.get(current) ?? []) {
        const newDeg = (inDegree.get(downstream) ?? 0) - 1;
        inDegree.set(downstream, newDeg);
        if (newDeg === 0) queue.push(downstream);
      }
    }

    return sorted.length === this.nodes.size ? sorted : null;
  }

  // ─── Edge helpers ─────────────────────────────────────────────────────────

  private addEdge(from: NodeId, to: NodeId): void {
    if (!this.edges.has(from)) this.edges.set(from, new Set());
    this.edges.get(from)!.add(to);
    if (!this.reverseEdges.has(to)) this.reverseEdges.set(to, new Set());
    this.reverseEdges.get(to)!.add(from);
  }

  private removeEdge(from: NodeId, to: NodeId): void {
    this.edges.get(from)?.delete(to);
    this.reverseEdges.get(to)?.delete(from);
  }

  private removeAllEdgesFor(nodeId: NodeId): void {
    // Remove all outgoing edges
    for (const downstream of this.edges.get(nodeId) ?? []) {
      this.reverseEdges.get(downstream)?.delete(nodeId);
    }
    this.edges.delete(nodeId);
    // Remove all incoming edges
    for (const upstream of this.reverseEdges.get(nodeId) ?? []) {
      this.edges.get(upstream)?.delete(nodeId);
    }
    this.reverseEdges.delete(nodeId);
  }

  /** Collect all structural predecessor node IDs from a node's reference fields. */
  private nodeUpstreams(node: GraphNode): NodeId[] {
    switch (node.type) {
      case 'PanelNode':
        return [];
      case 'BendNode':
        return [node.panelAId, node.panelBId];
      case 'JoinNode':
        return [node.panelAId, node.panelBId];
      case 'CutNode':
        return [node.parentPanelId];
    }
  }

  // ─── Dirty cascade (research.md R-002) ───────────────────────────────────

  /**
   * Mark a node dirty and cascade to all downstream dependents.
   * Upstream nodes are NOT marked (downstream-only BFS per contracts/graph-events.md).
   */
  markDirty(nodeId: NodeId): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    if (this.dirtyNodes.has(nodeId)) return; // avoid infinite loop on cycles (safety guard)
    node.dirty = true;
    this.dirtyNodes.add(nodeId);
    for (const downstream of this.edges.get(nodeId) ?? []) {
      this.markDirty(downstream);
    }
  }

  // ─── addNode ─────────────────────────────────────────────────────────────

  addNode(node: GraphNode, rollbackToken = ''): MutationResult {
    if (this.nodes.has(node.id)) {
      throwError(
        ErrorCodes.NODE_ID_ALREADY_EXISTS,
        `Node ID "${node.id}" already exists in the manufacturing graph.`,
        true,
        'query_graph',
      );
    }

    // Insert node + initialise edge sets
    this.nodes.set(node.id, node);
    this.edges.set(node.id, new Set());
    this.reverseEdges.set(node.id, new Set());
    this.insertionOrder.push(node.id);

    // Wire edges: this node depends on its upstreams
    for (const upstreamId of this.nodeUpstreams(node)) {
      this.addEdge(upstreamId, node.id);
    }

    // Acyclicity check
    if (this.topologicalSort() === null) {
      // Roll back
      this.removeAllEdgesFor(node.id);
      this.nodes.delete(node.id);
      this.insertionOrder.pop();
      throwError(
        ErrorCodes.MANUFACTURING_GRAPH_CYCLE_DETECTED,
        `Adding node "${node.id}" would create a cycle in the manufacturing graph.`,
        true,
        'query_graph',
      );
    }

    // Set rootPanelId if this is the first PanelNode
    if (node.type === 'PanelNode' && this.rootPanelId === null) {
      this.rootPanelId = node.id;
    }

    // Mark dirty cascade (just the new node; it has no downstream yet)
    this.markDirty(node.id);

    return {
      success: true,
      dirtiedNodeIds: [node.id],
      drcViolations: [],
      rollbackToken,
    };
  }

  // ─── removeNode ──────────────────────────────────────────────────────────

  removeNode(nodeId: NodeId, rollbackToken = ''): MutationResult {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throwError(
        ErrorCodes.NODE_NOT_FOUND,
        `Node "${nodeId}" not found in the manufacturing graph.`,
        false,
      );
    }

    // Orphan guard: any node that lists nodeId as a structural upstream
    const orphanedRefs: NodeId[] = [];
    for (const [candidateId, candidate] of this.nodes) {
      if (candidateId === nodeId) continue;
      if (this.nodeUpstreams(candidate).includes(nodeId)) {
        orphanedRefs.push(candidateId);
      }
    }
    if (orphanedRefs.length > 0) {
      throwError(
        ErrorCodes.REMOVE_WOULD_ORPHAN_NODES,
        `Removing node "${nodeId}" would orphan: ${orphanedRefs.join(', ')}.`,
        true,
        'query_graph',
      );
    }

    // Collect downstream nodes to mark dirty
    const downstream = [...(this.edges.get(nodeId) ?? [])];

    this.removeAllEdgesFor(nodeId);
    this.nodes.delete(nodeId);
    this.dirtyNodes.delete(nodeId);
    this.insertionOrder = this.insertionOrder.filter((id) => id !== nodeId);

    if (this.rootPanelId === nodeId) {
      // Re-elect root: first remaining PanelNode in insertion order
      this.rootPanelId =
        (this.insertionOrder.find((id) => this.nodes.get(id)?.type === 'PanelNode') as NodeId | undefined) ??
        null;
    }

    // Mark downstream dirty
    const dirtied: NodeId[] = [];
    for (const downstreamId of downstream) {
      this.markDirty(downstreamId);
      dirtied.push(downstreamId);
    }

    return {
      success: true,
      dirtiedNodeIds: dirtied,
      drcViolations: [],
      rollbackToken,
    };
  }

  // ─── updateNode ──────────────────────────────────────────────────────────

  /**
   * Update any fields of an existing node.
   * Supports node ID rename, structural edge re-wiring, and parameter updates.
   * Re-runs acyclicity check when structural references change.
   * Research: R-005
   */
  updateNode(
    nodeId: NodeId,
    updates: Partial<GraphNode> & { newNodeId?: string },
    rollbackToken = '',
  ): MutationResult & { newNodeId?: NodeId } {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throwError(
        ErrorCodes.NODE_NOT_FOUND,
        `Node "${nodeId}" not found.`,
        false,
      );
      throw new Error('unreachable');
    }

    const newNodeIdRaw = updates.newNodeId;
    const targetId: NodeId = newNodeIdRaw ? (newNodeIdRaw as NodeId) : nodeId;

    // Validate new ID uniqueness if renaming
    if (newNodeIdRaw && targetId !== nodeId && this.nodes.has(targetId)) {
      throwError(
        ErrorCodes.NODE_ID_ALREADY_EXISTS,
        `Cannot rename "${nodeId}" to "${targetId}": ID already exists.`,
        true,
      );
    }

    // Snapshot old upstreams to detect structural changes
    const oldUpstreams = this.nodeUpstreams(node);

    // Apply field updates (mutate in place — snapshot must be taken externally by caller)
    Object.assign(node, updates);
    // newNodeId is not a real field on GraphNode; don't leak it onto the node
    if ('newNodeId' in node) {
      delete (node as Record<string, unknown>)['newNodeId'];
    }

    // Handle node ID rename
    if (newNodeIdRaw && targetId !== nodeId) {
      node.id = targetId;
      // Re-key the nodes map
      this.nodes.delete(nodeId);
      this.nodes.set(targetId, node);

      // Update insertion order
      const idx = this.insertionOrder.indexOf(nodeId);
      if (idx >= 0) this.insertionOrder[idx] = targetId;

      // Re-wire edges: update all edge sets that referenced the old ID
      const outgoing = this.edges.get(nodeId) ?? new Set<NodeId>();
      this.edges.delete(nodeId);
      this.edges.set(targetId, outgoing);

      const incoming = this.reverseEdges.get(nodeId) ?? new Set<NodeId>();
      this.reverseEdges.delete(nodeId);
      this.reverseEdges.set(targetId, incoming);

      // Update all neighbour references to the old ID
      for (const downstream of outgoing) {
        this.reverseEdges.get(downstream)?.delete(nodeId);
        this.reverseEdges.get(downstream)?.add(targetId);
      }
      for (const upstream of incoming) {
        this.edges.get(upstream)?.delete(nodeId);
        this.edges.get(upstream)?.add(targetId);
      }

      if (this.rootPanelId === nodeId) this.rootPanelId = targetId;
      this.dirtyNodes.delete(nodeId);
      this.insertionOrder = this.insertionOrder.map((id) => (id === nodeId ? targetId : id));
    }

    // Handle structural reference changes (re-wire edges)
    const newUpstreams = this.nodeUpstreams(node);
    const addedUpstreams = newUpstreams.filter((u) => !oldUpstreams.includes(u));
    const removedUpstreams = oldUpstreams.filter((u) => !newUpstreams.includes(u));

    for (const removed of removedUpstreams) {
      this.removeEdge(removed, targetId);
    }
    for (const added of addedUpstreams) {
      this.addEdge(added, targetId);
    }

    if (addedUpstreams.length > 0 || removedUpstreams.length > 0) {
      // Re-run acyclicity check after structural changes
      if (this.topologicalSort() === null) {
        // Roll back structural changes
        for (const added of addedUpstreams) {
          this.removeEdge(added, targetId);
        }
        for (const removed of removedUpstreams) {
          this.addEdge(removed, targetId);
        }
        throwError(
          ErrorCodes.MANUFACTURING_GRAPH_CYCLE_DETECTED,
          `Updating node "${targetId}" would create a cycle in the manufacturing graph.`,
          true,
        );
      }
    }

    // Mark dirty (the updated node + its downstream)
    this.markDirty(targetId);

    return {
      success: true,
      dirtiedNodeIds: [targetId, ...(this.edges.get(targetId) ?? [])],
      drcViolations: [],
      rollbackToken,
      ...(newNodeIdRaw && targetId !== nodeId ? { newNodeId: targetId } : {}),
    };
  }

  // ─── queryNodes ──────────────────────────────────────────────────────────

  /**
   * Return nodes in topological order (Kahn's) or insertion order.
   */
  queryNodes(topologicalOrder = true): GraphNode[] {
    if (!topologicalOrder) {
      return this.insertionOrder
        .map((id) => this.nodes.get(id))
        .filter((n): n is GraphNode => n !== undefined);
    }
    const sorted = this.topologicalSort();
    if (sorted === null) {
      // Graph has a cycle — return insertion order as fallback (should not happen in practice)
      return this.queryNodes(false);
    }
    return sorted.map((id) => this.nodes.get(id)!);
  }

  // ─── reset ───────────────────────────────────────────────────────────────

  reset(): void {
    this.nodes.clear();
    this.edges.clear();
    this.reverseEdges.clear();
    this.dirtyNodes.clear();
    this.insertionOrder = [];
    this.rootPanelId = null;
  }

  // ─── GEOMETRY_STALE helper (FR-020) ─────────────────────────────────────

  /**
   * Returns a DrcViolation warning when there are dirty nodes in the graph
   * (i.e. geometry is stale). Tool handlers must include this in responses
   * that contain body IDs or flat-pattern dimensions.
   */
  getStaleWarning(): DrcViolation | null {
    if (this.dirtyNodes.size === 0) return null;
    const dirtyList = [...this.dirtyNodes].join(', ');
    return {
      ruleId: 'GEOMETRY_STALE',
      errorCode: 'GEOMETRY_STALE',
      message: `Geometry is stale. The following nodes are dirty and have not been re-solved: ${dirtyList}. Call solve_geometry to update body IDs and flat-pattern dimensions.`,
      severity: 'WARNING',
      affectedNodeId: [...this.dirtyNodes][0] as NodeId,
    };
  }

  // ─── Flat pattern dimensions from graph traversal (FR-008) ───────────────

  /**
   * Compute flat-pattern dimensions for a panel by traversing the graph from
   * the root to the given panel, summing flat widths and bend allowances.
   *
   * Returns null if the panel cannot be reached from the root or if dimensions
   * are not yet available (dirty nodes present).
   */
  getFlatPatternDimensions(panelId: NodeId): FlatPatternDimensions | null {
    const panel = this.nodes.get(panelId);
    if (!panel || panel.type !== 'PanelNode') return null;
    if (panel.flatWidth === null || panel.flatHeight === null) return null;

    // Walk the chain from this panel back to the root via BendNode.panelBId → BendNode.panelAId links.
    // For each BendNode where this panel is panelBId, accumulate the upstream panels and bends.
    const bendZones: BendZone[] = [];
    let cumulativeWidth = panel.flatWidth;

    // Build a lookup: panelBId → BendNode (for chain traversal)
    const bendByPanelB = new Map<NodeId, BendNode>();
    for (const node of this.nodes.values()) {
      if (node.type === 'BendNode') {
        bendByPanelB.set(node.panelBId, node);
      }
    }

    // Walk up the chain
    const visited = new Set<NodeId>();
    let currentPanelId: NodeId | undefined = panelId;
    while (currentPanelId !== undefined) {
      if (visited.has(currentPanelId)) break; // cycle guard
      visited.add(currentPanelId);

      const bend = bendByPanelB.get(currentPanelId);
      if (!bend) break; // reached the root panel

      const ba = bend.bendAllowance ?? computeBendAllowance(
        bend.angle, bend.innerRadius, bend.kFactor, 0,
      );

      const upstreamPanel = this.nodes.get(bend.panelAId);
      const upstreamWidth = (upstreamPanel?.type === 'PanelNode' ? upstreamPanel.flatWidth : null) ?? 0;

      cumulativeWidth += ba + upstreamWidth;
      bendZones.push({ offset: cumulativeWidth - panel.flatWidth - ba, width: ba, nodeId: bend.id });

      currentPanelId = bend.panelAId;
    }

    // bendZones are ordered from closest-to-panelId outward; reverse for root-to-panel order
    bendZones.reverse();

    return {
      width: cumulativeWidth,
      height: panel.flatHeight,
      bendZones,
    };
  }

  // ─── auto-Solve wrapper for single-step MCP tools (FR-019) ───────────────

  /**
   * Runs a mutation, then immediately calls solve() if no active transaction.
   * The solver and binding are passed by the tool handler to allow DI for testing.
   */
  async mutateAndSolve<T extends MutationResult>(
    mutation: () => T,
    solve: (() => Promise<{ ok: true; result: GeometrySolveResult } | { ok: false; errorCode: string; offendingNodeId: NodeId; message: string }>) | null,
  ): Promise<T & { geometrySolve?: GeometrySolveResult }> {
    const mutResult = mutation();

    // FR-019: Skip auto-Solve when a transaction is active
    // The caller must explicitly call solve_geometry before commit_transaction
    const activeTransaction = transactionRegistry.getActive();
    if (activeTransaction !== undefined) {
      // Transaction is open — skip auto-Solve
      return mutResult;
    }

    if (solve !== null) {
      const solveOutcome = await solve();
      if (!solveOutcome.ok) {
        throwError(
          ErrorCodes.SOLVE_FAILED,
          `Geometry Solve failed at node "${solveOutcome.offendingNodeId}": ${solveOutcome.message}`,
          true,
          'solve_geometry',
        );
      }
      const okOutcome = solveOutcome as { ok: true; result: GeometrySolveResult };
      return { ...mutResult, geometrySolve: okOutcome.result };
    }

    return mutResult;
  }
}
