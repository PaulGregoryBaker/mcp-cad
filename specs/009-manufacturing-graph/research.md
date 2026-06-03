# Research: Manufacturing Graph — Sheet Metal Intent Layer

**Phase 0 output for**: `specs/009-manufacturing-graph/plan.md`
**Date**: 2026-06-03
**Branch**: `009-manufacturing-graph`

---

## R-001: DAG Topological Sort Algorithm

**Decision**: Kahn's algorithm (BFS-based) using an in-degree map.

**Rationale**: The Manufacturing Graph is a sparse DAG (typical depth 3–20, max
breadth ~100 for batch scenarios). Kahn's algorithm visits each node and edge
exactly once — O(V + E) — and detects cycles as a natural by-product: if the sorted
output length < total node count, a cycle exists. This replaces a separate
acyclicity check (FR-006) with the sort itself. DFS-based topological sort (the
alternative) requires a visited/in-stack colour map and separate cycle detection
logic; it offers no advantage here and is harder to reason about in TypeScript.

**Dirty-subgraph traversal**: For the Geometry Solve, only dirty nodes need
re-computing. After sorting the full graph, filter to dirty nodes; then re-expand
to include any node reachable from a dirty node (downstream). This avoids
re-evaluating clean upstream nodes unnecessarily.

**Implementation notes**:
- Maintain an `inDegree: Map<NodeId, number>` updated on every add/remove edge.
- The sort runs in O(V + E) where V ≤ ~200 nodes and E ≤ ~300 edges for large
  assemblies — effectively instantaneous.
- No third-party library required; implement directly in `graph.ts`.

**Alternatives considered**:
- DFS post-order: equivalent time complexity but less intuitive for streaming
  dirty-node selection.
- Third-party graph library (e.g., `graphlib`): adds a dependency for a 30-line
  function; rejected per constitution VII (MVP scope discipline).

---

## R-002: Dirty-Tracking in TypeScript In-Memory Graph

**Decision**: Per-node boolean `dirty` flag stored on the node object, plus a
session-level `Set<NodeId>` of currently dirty nodes for O(1) iteration.

**Rationale**: The Geometry Solve needs to iterate all dirty nodes quickly. A
`Set<NodeId>` maintained in parallel with the per-node flag provides O(1) add,
delete, and iteration without scanning all nodes. Marking downstream nodes dirty
on mutation is a DFS/BFS from the mutated node following outgoing edges — O(V+E)
worst case, negligible for ≤200 nodes.

**Cascade rule**: When a node is marked dirty, all nodes reachable from it in the
DAG direction (downstream, toward leaves) are also marked dirty. The Geometry Solve
processes nodes in topological order; marking upstream ancestors dirty would trigger
unnecessary re-computation of geometry that has not changed.

**Stale read contract** (FR-020): Before returning any tool response that includes
body IDs or flat-pattern dimensions, check `dirtyNodes.size > 0`. If non-empty,
attach a `GEOMETRY_STALE` warning listing the dirty node IDs.

**Alternatives considered**:
- Version counter per node (increment on mutation, compare to last-solved version):
  equivalent semantics, higher bookkeeping overhead, no benefit for this scale.
- Event-based reactive graph (RxJS observables): significant dependency and
  complexity; overkill for a single-session in-memory store.

---

## R-003: NAPI Binding Integration for the Geometry Solve

**Decision**: Call NAPI geometry operations sequentially within the Solve loop
(synchronous binding calls within async TypeScript). Do NOT introduce parallel
NAPI calls.

**Rationale**: The existing `ts/src/geometry/binding.ts` wraps the C++ addon via
synchronous NAPI calls (the addon exposes synchronous operations). The geometry
engine (`GeometryService`) is a single-instance stateful registry — concurrent
mutations would require a mutex at the C++ layer that does not currently exist.
The Geometry Solve calls operations in topological order anyway (each node's output
body ID is an input to the next); parallelisation is not possible for a chain.

**Binding calls used by the Solve** (via existing `binding.ts` wrapper):
- `splitBodyByBends` → bootstrap (panel detection)
- `mergeBodiesWithBend` → BendNode geometry (merge + fold)
- `fuseBodies` → flat extension (union merge, PanelNode update)
- `unfoldShell` → flat-pattern dimensions after a Solve
- `booleanCut` → CutNode geometry (hole/slot subtraction from panel body)

**Rollback on Solve failure**: The existing snapshot/rollback mechanism
(`createSnapshot` / `restoreSnapshot` via `ts/src/mcp/transactions.ts`) is used.
Before the Solve begins, take a snapshot token. If any node fails, call `restore`
with that token. This satisfies FR-018 atomicity at no additional implementation cost.

**Alternatives considered**:
- Worker threads (Node.js `worker_threads`): NAPI addons are not thread-safe by
  default; the geometry engine has no thread-safety guarantees. Rejected.
- Async NAPI (libuv thread pool): The addon would need to be rewritten with
  async_worker; out of scope for this feature.

---

## R-004: Foldability Check — Press-Brake Accessibility Heuristic

**Decision**: Graph-topology-only accessibility model. No B-Rep access during the
check. Model accessibility as a function of how many of a panel's edges are already
committed to completed bends.

**Rationale**: A full 3D collision simulation (sweeping a press-brake tool through
space) requires B-Rep access and is expensive. The spec (FR-013, FR-014) explicitly
defines a graph-level model: a panel is INACCESSIBLE when all approach directions
are blocked by previously completed bends. For the press-brake accessibility model,
the key insight is:

> A panel face that has a completed bend on all four cardinal edges (or more
> precisely, has no free edge that a tool can enter from above or below) cannot
> be bent. A panel with completed bends on three or more edges adjacent to the
> same side is typically INACCESSIBLE for a new bend on the remaining edge.

**Simplified graph model** (sufficient for MVP, covers all spec canonical cases):
1. Count the number of `BendNode` edges connected to a given panel (`degree`).
2. Assess whether the connected bends form a "closed ring" around the panel.
   - A panel with `degree ≥ 3` where the bends are distributed around more than
     two sides is marked INACCESSIBLE.
   - A panel with `degree = 2` on opposite sides (U-channel) is CONSTRAINED
     (tool clearance limited) but accessible.
   - A panel with `degree ≤ 1` or `degree = 2` on adjacent sides is OPEN.
3. The closed-box case (6-panel cube): the 6th panel attempt is detected because
   the remaining open edge is enclosed on all sides by previously committed panels
   — the panel has degree ≥ 4 (or the graph forms a complete ring).

**Canonical test cases** (SC-007):
- Closed box (6 faces): attempt to add the 6th bend → INACCESSIBLE.
- Closed triangle prism (5 faces): attempt to close → INACCESSIBLE.
- U-channel + cap (4 faces): attempt to add a lid to a 3-sided channel → INACCESSIBLE.
- L-bracket → U-channel: all bends accessible → OPEN / CONSTRAINED, no violation.

**Implementation**: `foldability.ts` — `assessAccessibility(graph, panelId)` returns
`AccessibilityState`. Called synchronously in `add_bend` before geometry dispatch.

**Alternatives considered**:
- Full 3D sweep simulation: accurate but requires B-Rep access and OCCT; ≥10×
  slower than a graph-only check. Deferred to a future increment if needed.
- Machine-learning classifier on panel topology features: non-deterministic; violates
  Constitution I (Deterministic Geometry Intelligence). Rejected.

---

## R-005: `update_node` Structural Reference Changes — Atomicity

**Decision**: Treat structural reference changes in `update_node` (re-wiring which
panels a `BendNode` connects, or renaming a node ID) as a remove-old-edges /
add-new-edges atomic operation within a single graph mutation, followed by a full
acyclicity re-check before DRC.

**Rationale**: The spec (FR-023, clarification A) permits full mutability of all
fields. Re-wiring a `BendNode` from panels A+B to panels A+C is semantically
equivalent to `remove_node(bend) + add_bend(A, C, same_params)`, but the caller
has chosen to express it as a single `update_node`. The implementation must:
1. Remove old edges from the adjacency list.
2. Add new edges.
3. Run `topologicalSort` — if it fails (cycle), revert edges and reject.
4. Mark all nodes downstream of the re-wired node dirty.
5. Re-run DRC.
6. Auto-invoke Solve.

Node ID rename: update the node's `id` field, re-key it in the nodes `Map`, and
update all edge references. This is the most expensive update path (O(E) edge scan)
but remains negligible for ≤300 edges.

**Alternatives considered**:
- Reject structural changes in `update_node`; require `remove_node` + `add_*`:
  simpler implementation but violates spec clarification A. Rejected.

---

## R-006: CutNode FREEFORM Profile Representation

**Decision**: Store FREEFORM profiles as an ordered `Array<{x: number, y: number}>`
in panel-local 2D coordinates. Validate: (a) ≥ 3 vertices, (b) no self-intersections
(via cross-product sign test on consecutive edges), (c) closed (first vertex ≠ last
vertex; closure is implicit). DXF rendering closes the wire automatically.

**Rationale**: The DXF export already uses OCCT `BRepBuilderAPI_MakeWire` to
construct inner wires from edge lists. A vertex array maps directly to a sequence
of `BRepBuilderAPI_MakeEdge` calls (line segments). For smooth curves (arcs, splines)
the caller approximates with a sufficient vertex count — this is standard practice
for DXF punch-press profiles where only line segments are needed.

**Self-intersection check**: Required at `add_cut` / `update_node` time (FR-005d
bounds validation). A simple O(n²) check is acceptable for profiles ≤ ~200 vertices.

**Alternatives considered**:
- SVG path string: familiar format but requires a parser dependency; no benefit for
  the C++ wire-builder path.
- OCCT wire serialised to JSON: ties the TypeScript domain model to B-Rep primitives;
  violates Constitution II (Bounded Context Separation). Rejected.

---

## Summary Table

| Research Item | Decision | Key Constraint |
|---|---|---|
| R-001: DAG sort | Kahn's algorithm (in-degree BFS) | Cycle detection is a by-product |
| R-002: Dirty tracking | Per-node flag + `Set<NodeId>` | Downstream cascade on mutation |
| R-003: NAPI calls | Sequential synchronous in Solve loop | Single-instance C++ engine; no concurrency |
| R-004: Foldability | Graph-topology-only degree model | No B-Rep access; covers all canonical cases |
| R-005: update_node | Remove-old / add-new edges atomically | Acyclicity re-check before DRC |
| R-006: FREEFORM cut | Ordered vertex array, panel-local 2D | Self-intersection validated at mutation time |
