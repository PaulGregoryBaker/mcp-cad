# Data Model: Manufacturing Graph — Sheet Metal Intent Layer

**Phase 1 output for**: `specs/009-manufacturing-graph/plan.md`
**Date**: 2026-06-03
**Branch**: `009-manufacturing-graph`

---

## Overview

All types live in `ts/src/manufacturing/graph/types.ts`. The Manufacturing Graph is
the authoritative in-memory store for fabrication intent. B-Rep body IDs (UUIDs)
are stored as opaque references only — they are volatile across Geometry Solves and
never used as primary identifiers in tool call arguments.

---

## Core Types

### `NodeId` (branded string)

```typescript
type NodeId = string & { readonly __brand: 'NodeId' };
```

Caller-supplied, human-readable (e.g. `"panel-top"`, `"bend-flange-left"`). Unique
within a session's Manufacturing Graph. Never changes once created (except via an
explicit `update_node` rename). Validated: non-empty, no whitespace-only strings.

---

### `BodyId` (branded string)

```typescript
type BodyId = string & { readonly __brand: 'BodyId' };
```

Server-generated UUID. Volatile — replaced on every Geometry Solve that regenerates
the owning node. Not surfaced in MCP tool response UIs; returned in a dedicated
`body_id` field for callers that need to call downstream geometry tools.

---

### `PanelNode`

```typescript
interface PanelNode {
  readonly type: 'PanelNode';
  id: NodeId;
  bodyId: BodyId | null;       // null before first Geometry Solve
  dirty: boolean;
  materialType: string;         // loaded from config/config.yaml material table
  nominalThickness: number;     // mm
  flatWidth: number | null;     // mm — null before first Solve
  flatHeight: number | null;    // mm — null before first Solve
}
```

**Validation rules**:
- `nominalThickness` > 0
- `materialType` must be a key in the loaded material table
- `flatWidth` and `flatHeight` are set by the Geometry Solve; never written directly

---

### `BendNode`

```typescript
interface BendNode {
  readonly type: 'BendNode';
  id: NodeId;
  dirty: boolean;
  panelAId: NodeId;             // upstream panel
  panelBId: NodeId;             // downstream panel
  innerRadius: number;          // mm, > 0
  angle: number;                // degrees, 1–179 (inclusive)
  kFactor: number;              // 0 < k ≤ 1 (typically 0.33–0.5)
  bendAllowance: number | null; // mm — computed: π*A/180 * (R + K*T); null before first Solve
}
```

**Validation rules**:
- `innerRadius` > 0
- `angle` ∈ [1, 179]
- `kFactor` ∈ (0, 1]
- `panelAId` and `panelBId` must reference existing `PanelNode` entries
- Adding this node must not create a cycle (Kahn's sort check)
- DRC: `innerRadius` ≥ `material.minBendRadius` (loaded from config)
- DRC: foldability check passes for the new bend (FR-013)

**State transitions**:

```
CREATED (dirty=true, bendAllowance=null)
  → [Geometry Solve succeeds] → SOLVED (dirty=false, bendAllowance=computed)
  → [parameter updated] → DIRTY (dirty=true)
  → [Solve succeeds again] → SOLVED
  → [remove_node] → removed (all downstream marked dirty)
```

---

### `JoinNode`

```typescript
type JoinType = 'FLANGE' | 'TAB_SLOT' | 'RIVET_PATTERN' | 'WELD_PREP';

interface RivetPatternParams {
  spacing: number;              // mm, centre-to-centre
  diameter: number;             // mm, rivet hole diameter
  edgeOffset: number;           // mm, distance from panel edge
}

interface FlangeParams {
  width: number;                // mm, flange lip width
  bendAngle: number;            // degrees, 1–179
}

interface TabSlotParams {
  tabWidth: number;             // mm
  tabDepth: number;             // mm
  count: number;                // number of tab-slot pairs along the edge
}

interface WeldPrepParams {
  grooveAngle: number;          // degrees (e.g. 60 for V-groove)
  rootGap: number;              // mm
}

type JoinParams = RivetPatternParams | FlangeParams | TabSlotParams | WeldPrepParams;

interface JoinNode {
  readonly type: 'JoinNode';
  id: NodeId;
  dirty: boolean;
  panelAId: NodeId;
  panelBId: NodeId;
  referenceEdgeA: string;       // edge identifier in panel A's local frame
  referenceEdgeB: string;       // edge identifier in panel B's local frame
  joinType: JoinType;
  params: JoinParams;
}
```

**Validation rules**:
- `panelAId` and `panelBId` must reference existing `PanelNode` entries
- The `(panelAId, referenceEdgeA)` pair must not already be bound to another
  `BendNode` or `JoinNode` → `JOIN_EDGE_ALREADY_BOUND`
- `joinType` determines which `params` variant is required
- FLANGE type: internally modelled as an additional `PanelNode` (lip) + `BendNode`
  (reuses bend machinery); the `JoinNode` is the user-facing record

---

### `CutNode`

```typescript
type CutType = 'CIRCLE' | 'RECTANGLE' | 'POLYGON' | 'FREEFORM';

interface CircleProfile {
  type: 'CIRCLE';
  centreX: number;              // mm, panel-local
  centreY: number;              // mm, panel-local
  radius: number;               // mm, > 0
}

interface RectangleProfile {
  type: 'RECTANGLE';
  originX: number;              // mm, panel-local (bottom-left corner)
  originY: number;              // mm, panel-local
  width: number;                // mm, > 0
  height: number;               // mm, > 0
}

interface PolygonProfile {
  type: 'POLYGON';
  vertices: Array<{ x: number; y: number }>;  // ≥ 3 vertices, panel-local
}

interface FreeformProfile {
  type: 'FREEFORM';
  vertices: Array<{ x: number; y: number }>;  // ≥ 3 vertices, panel-local
  // Closure is implicit (last vertex connects to first)
  // No self-intersections permitted (validated at mutation time)
}

type CutProfile = CircleProfile | RectangleProfile | PolygonProfile | FreeformProfile;

interface CutNode {
  readonly type: 'CutNode';
  id: NodeId;
  dirty: boolean;
  parentPanelId: NodeId;
  profile: CutProfile;
  label?: string;               // optional human-readable label for DXF annotation
}
```

**Validation rules**:
- `parentPanelId` must reference an existing `PanelNode`
- Profile bounding box must lie fully within the parent panel's flat outline →
  `CUT_PROFILE_OUT_OF_BOUNDS`
- FREEFORM/POLYGON: ≥ 3 vertices, no self-intersections
- Profile must not overlap another `CutNode` on the same panel → `CUT_OVERLAP`
- Profile intersecting the bend-allowance setback zone → `DRC_CUT_IN_BEND_ZONE`
  (warning, not error)
- Profile validated at `add_cut` and re-validated at `update_node`

---

### `GraphNode` (discriminated union)

```typescript
type GraphNode = PanelNode | BendNode | JoinNode | CutNode;
```

---

### `ManufacturingGraph`

```typescript
interface ManufacturingGraph {
  sessionId: string;
  rootPanelId: NodeId | null;     // null until first PanelNode added
  nodes: Map<NodeId, GraphNode>;
  // Adjacency: outgoing edges (A → downstream)
  edges: Map<NodeId, Set<NodeId>>;
  // Reverse adjacency: incoming edges (used for in-degree in Kahn's)
  reverseEdges: Map<NodeId, Set<NodeId>>;
  // Dirty tracking
  dirtyNodes: Set<NodeId>;
  // Coplanarity threshold for flat-extension classification (default 1°, configurable)
  coplanarityThresholdDeg: number;
}
```

---

### `GeometrySolveResult`

```typescript
interface SolvedNode {
  nodeId: NodeId;
  newBodyId: BodyId;
}

interface GeometrySolveResult {
  solveId: string;              // UUID
  timestamp: string;            // ISO 8601
  solvedNodes: SolvedNode[];    // all nodes that were re-computed
  invalidatedBodyIds: BodyId[]; // body IDs no longer valid after this Solve
  dirtyCountBefore: number;
  solveMs: number;              // wall-clock duration in milliseconds
}
```

---

### `DrcRule`

```typescript
type DrcSeverity = 'ERROR' | 'WARNING';

interface DrcViolation {
  ruleId: string;
  errorCode: string;            // e.g. 'DRC_BEND_RADIUS_VIOLATION'
  message: string;
  severity: DrcSeverity;
  affectedNodeId: NodeId;
}
```

---

### `AccessibilityState`

```typescript
type AccessibilityState = 'OPEN' | 'CONSTRAINED' | 'INACCESSIBLE';

interface PanelAccessibility {
  panelId: NodeId;
  state: AccessibilityState;
  lockingBendIds: NodeId[];     // populated when state = 'INACCESSIBLE'
}
```

---

## State Transitions (Manufacturing Graph lifecycle)

```
Session starts
  → ManufacturingGraph created (empty, dirtyNodes = {})
  → bootstrap_graph called:
      splitBodyByBends → panels detected
      PanelNode + BendNode entries created (dirty=true)
      Geometry Solve auto-invoked
      → all nodes solved (dirty=false), bodyIds populated
  → add_bend / add_join / add_cut called (single-step):
      new node created (dirty=true)
      downstream nodes marked dirty
      DRC checked
      Geometry Solve auto-invoked
      → dirty nodes solved, bodyIds updated
  → update_node called:
      edges updated if structural change
      acyclicity re-checked
      downstream marked dirty
      DRC re-run
      Geometry Solve auto-invoked
  → remove_node called:
      dangling reference check
      downstream marked dirty
      DRC re-run
      Geometry Solve auto-invoked
  → batch transaction (004-transaction-primitive):
      multiple mutations without auto-Solve
      caller calls solve_geometry explicitly
      commit_transaction
  → Solve failure:
      all dirty flags restored
      snapshot restored via transactions.ts rollback
  → reset_graph:
      graph cleared, session registry cleared
```

---

## Relationships Diagram

```
ManufacturingGraph
│
├── nodes: Map<NodeId, GraphNode>
│   ├── PanelNode [body_id → BodyId (volatile UUID)]
│   ├── BendNode  [panelA_id, panelB_id → NodeId (stable)]
│   ├── JoinNode  [panelA_id, panelB_id, params]
│   └── CutNode   [parentPanel_id, profile]
│
├── edges: Map<NodeId, Set<NodeId>>   (topological order: upstream → downstream)
├── reverseEdges: Map<NodeId, Set<NodeId>>
└── dirtyNodes: Set<NodeId>
```

---

## Configuration-Sourced Values (not hard-coded)

Loaded from `ts/config/config.yaml` at startup via existing config loader:

| Field | Config key | Default |
|---|---|---|
| Material K-factor | `materials[name].kFactor` | 0.33 |
| Min bend radius | `materials[name].minBendRadius` | `1.5 * thickness` |
| Min flange width | `materials[name].minFlangeWidth` | `3.0 * thickness` |
| Coplanarity threshold | `graph.coplanarityThresholdDeg` | 1.0° |
