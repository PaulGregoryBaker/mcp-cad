# Internal Event Contracts: Manufacturing Graph

**Phase 1 output for**: `specs/009-manufacturing-graph/plan.md`
**Date**: 2026-06-03
**Branch**: `009-manufacturing-graph`

These contracts govern the internal communication within the `ts/src/manufacturing/graph/`
sub-module. They are not exposed over MCP; they define the interfaces between
`graph.ts`, `solver.ts`, `drc.ts`, and `foldability.ts`.

---

## `MutationResult`

Returned by every graph mutation method (`addNode`, `updateNode`, `removeNode`) in
`graph.ts`.

```typescript
interface MutationResult {
  success: true;
  dirtiedNodeIds: NodeId[];     // nodes marked dirty by this mutation (the changed
                                // node + all its downstream dependents)
  drcViolations: DrcViolation[]; // violations detected synchronously; if non-empty,
                                // the mutation has been rejected and the graph is unchanged
  rollbackToken: string;        // snapshot token (from transactions.ts)
}
```

---

## `SolveRequest`

Passed from tool handlers to `solver.ts` to trigger a Geometry Solve.

```typescript
interface SolveRequest {
  graph: ManufacturingGraph;
  binding: GeometryBinding;     // NAPI wrapper (injected for testability)
  rollbackToken: string;        // snapshot taken before mutations; used on failure
}
```

---

## `SolveOutcome`

Returned by `solver.ts`. On failure, the registry is already restored before this
is returned to the caller.

```typescript
type SolveOutcome =
  | { ok: true; result: GeometrySolveResult }
  | { ok: false; errorCode: 'SOLVE_FAILED'; offendingNodeId: NodeId; message: string };
```

---

## `DrcCheckRequest`

Passed to `drc.ts` before geometry dispatch.

```typescript
interface DrcCheckRequest {
  graph: ManufacturingGraph;
  candidateNode: GraphNode;       // the node being added/updated
  materialConfig: MaterialConfig; // loaded from config/config.yaml
}

interface DrcCheckResult {
  violations: DrcViolation[];     // empty = pass; non-empty = reject before geometry
}
```

---

## `FoldabilityCheckRequest`

Passed to `foldability.ts` from `drc.ts` when a `BendNode` is being added.

```typescript
interface FoldabilityCheckRequest {
  graph: ManufacturingGraph;
  proposedBend: BendNode;         // the bend being tested (not yet added to graph)
}

interface FoldabilityCheckResult {
  violations: DrcViolation[];       // DRC_FOLDABILITY_VIOLATION or DRC_FOLDABILITY_UNCERTAIN
  panelAccessibility: PanelAccessibility[]; // full accessibility map (for check_foldability tool)
}
```

---

## Dirty Cascade Contract

When `graph.markDirty(nodeId)` is called:

1. Set `node.dirty = true` and add `nodeId` to `graph.dirtyNodes`.
2. For each outgoing edge from `nodeId` (downstream nodes): recursively call
   `graph.markDirty(downstreamId)`.
3. Upstream (ancestor) nodes are **not** marked dirty.

This is a depth-first traversal of the downstream sub-tree. Called once per
mutation before DRC runs.
