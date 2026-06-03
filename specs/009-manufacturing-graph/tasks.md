# Tasks: Manufacturing Graph — Sheet Metal Intent Layer

**Branch**: `009-manufacturing-graph`
**Input**: `specs/009-manufacturing-graph/` — spec.md, plan.md, research.md, data-model.md, contracts/

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the `ts/src/manufacturing/graph/` sub-module skeleton and wire it
into the existing TypeScript project. No logic implemented yet — just files, types,
and module boundaries.

- [ ] T001 Create directory `ts/src/manufacturing/graph/` and add placeholder `index.ts` exporting an empty object
- [ ] T002 [P] Create `ts/src/manufacturing/graph/types.ts` — define all branded types and interfaces from `data-model.md`: `NodeId`, `BodyId`, `PanelNode`, `BendNode`, `JoinNode`, `CutNode`, `GraphNode`, `ManufacturingGraph`, `GeometrySolveResult`, `DrcViolation`, `PanelAccessibility`, all `*Profile` and `*Params` types
- [ ] T003 [P] Create `ts/src/manufacturing/graph/errors.ts` — define all new error codes from `contracts/mcp-tools.md` error registry (`NODE_ID_ALREADY_EXISTS`, `MANUFACTURING_GRAPH_CYCLE_DETECTED`, `REMOVE_WOULD_ORPHAN_NODES`, `JOIN_EDGE_ALREADY_BOUND`, `GRAPH_INTEGRITY_ERROR`, `BOOTSTRAP_PARTIAL`, `GRAPH_ALREADY_POPULATED`, `SOLVE_FAILED`, `GEOMETRY_STALE`, `DRC_BEND_RADIUS_VIOLATION`, `DRC_MIN_FLANGE_WIDTH_VIOLATION`, `DRC_FOLDABILITY_VIOLATION`, `DRC_FOLDABILITY_UNCERTAIN`, `DRC_CUT_IN_BEND_ZONE`, `CUT_PROFILE_OUT_OF_BOUNDS`, `CUT_OVERLAP`, `CUT_INVALID_PROFILE`); integrate with existing `ts/src/mcp/errors.ts` `ErrorCodes` registry
- [ ] T004 Create `ts/src/manufacturing/graph/graph.ts` — stub `ManufacturingGraph` class with constructor (accepts `sessionId`, `coplanarityThresholdDeg`), empty `addNode`, `updateNode`, `removeNode`, `queryNodes`, `markDirty`, `reset` method signatures matching `contracts/graph-events.md` `MutationResult` contract
- [ ] T005 Create `ts/src/manufacturing/graph/solver.ts` — stub `GeometrySolver` class with empty `solve(request: SolveRequest): SolveOutcome` method signature from `contracts/graph-events.md`
- [ ] T006 [P] Create `ts/src/manufacturing/graph/drc.ts` — stub `DrcChecker` class with empty `check(request: DrcCheckRequest): DrcCheckResult` method signature
- [ ] T007 [P] Create `ts/src/manufacturing/graph/foldability.ts` — stub `FoldabilityChecker` class with empty `check(request: FoldabilityCheckRequest): FoldabilityCheckResult` method signature
- [ ] T008 [P] Create `ts/src/manufacturing/graph/bootstrap.ts` — stub `bootstrapGraph(partId, graph, binding, options): Promise<BootstrapResult>` function signature
- [ ] T009 Update `ts/src/manufacturing/graph/index.ts` to export `ManufacturingGraph`, `GeometrySolver`, `DrcChecker`, `FoldabilityChecker`, `bootstrapGraph`, and all types from `types.ts`
- [ ] T010 Add `graph` config key to `ts/config/config.yaml` under a new `graph:` section: `coplanarityThresholdDeg: 1.0`; update the TypeScript config loader/schema in `ts/src/config/` to parse and expose it
- [ ] T011 Create `ts/tests/manufacturing/graph/` directory with empty `.gitkeep` to establish test structure

**Checkpoint**: TypeScript project builds cleanly with all stubs; no test failures from existing tests.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core graph data structure and Kahn's topological sort. MUST be complete
before any user-story implementation touches business logic.

**⚠️ CRITICAL**: All subsequent phases depend on this graph engine being correct.

- [ ] T012 Implement `ManufacturingGraph` internal storage in `ts/src/manufacturing/graph/graph.ts`: `nodes: Map<NodeId, GraphNode>`, `edges: Map<NodeId, Set<NodeId>>`, `reverseEdges: Map<NodeId, Set<NodeId>>`, `dirtyNodes: Set<NodeId>` — exactly as defined in `data-model.md`
- [ ] T013 Implement `graph.markDirty(nodeId)` in `ts/src/manufacturing/graph/graph.ts`: set `node.dirty = true`, add to `dirtyNodes`, recursively cascade to all downstream nodes via `edges` (depth-first); upstream nodes MUST NOT be marked dirty (see `contracts/graph-events.md` Dirty Cascade Contract)
- [ ] T014 Implement Kahn's topological sort in `ts/src/manufacturing/graph/graph.ts` as `topologicalSort(): NodeId[] | null` — build in-degree map from `reverseEdges`; return sorted array or `null` if cycle detected; this replaces a separate cycle-check (see `research.md` R-001)
- [ ] T015 [P] Implement `graph.addNode(node: GraphNode)` in `graph.ts`: validate `node.id` unique → `NODE_ID_ALREADY_EXISTS`; insert into `nodes`; add edges for `panelAId`/`panelBId`/`parentPanelId` references; run `topologicalSort()` → reject with `MANUFACTURING_GRAPH_CYCLE_DETECTED` if null; mark new node dirty; return `MutationResult`
- [ ] T016 Implement `graph.removeNode(nodeId)` in `graph.ts`: check no other node references this node as a structural dependency → `REMOVE_WOULD_ORPHAN_NODES`; remove from `nodes`, remove all edges; call `markDirty` on all former downstream neighbours; return `MutationResult`
- [ ] T017 Implement `graph.updateNode(nodeId, updates)` in `graph.ts`: handle node ID rename (re-key map, update all edge references); handle structural panel reference changes (remove old edges, add new, re-run `topologicalSort()`); update parameter fields; call `markDirty` on updated node and its downstream; return `MutationResult` (see `research.md` R-005)
- [ ] T018 [P] Implement `graph.queryNodes(topologicalOrder: boolean)` in `graph.ts`: when `true`, return nodes in Kahn's order; when `false`, return in insertion order
- [ ] T019 [P] Implement `graph.reset()` in `graph.ts`: clear all maps and sets; reset `rootPanelId` to null
- [ ] T020 [P] Write unit tests for graph core in `ts/tests/manufacturing/graph/graph.test.ts`: add/remove/update node; topological sort on linear chain, fan-out, and cycle; dirty cascade (only downstream marked, not upstream); rename propagates to all edge references; `REMOVE_WOULD_ORPHAN_NODES` guard; `MANUFACTURING_GRAPH_CYCLE_DETECTED` guard

**Checkpoint**: All graph.test.ts tests pass. `npm run build` succeeds.

---

## Phase 3: User Story 7 — Geometry Solve (Priority: P1)

**Goal**: Implement the Geometry Solve engine — the mechanism that traverses dirty
nodes in topological order, executes NAPI geometry calls, clears dirty flags, and
returns `GeometrySolveResult`. This is foundational for every other story that
produces geometry output.

**Independent Test**: Create a two-node graph (one `PanelNode` + one `BendNode`),
mark both dirty, call `solver.solve()`. Verify: (a) both nodes are cleared from
`dirtyNodes`, (b) `GeometrySolveResult.solvedNodes` contains both node IDs,
(c) previously issued `BodyId` values appear in `invalidatedBodyIds`.

### Implementation for User Story 7

- [ ] T021 [US7] Implement `GeometrySolver.solve(request)` in `ts/src/manufacturing/graph/solver.ts`: take snapshot token from `transactionRegistry`; filter `graph.dirtyNodes` to execution set; sort by Kahn's order; iterate dirty nodes in order, dispatching to the appropriate NAPI call per node type (see `research.md` R-003); on any node failure, restore snapshot, restore all dirty flags → return `SolveOutcome` with `ok: false`; on full success, clear all dirty flags, update `bodyId` on each `PanelNode`, populate and return `GeometrySolveResult` (see `contracts/graph-events.md` `SolveOutcome`)
- [ ] T022 [US7] Implement per-node-type dispatch in `solver.ts`: `PanelNode` → call existing `binding.splitBodyByBends` or `binding.fuseResult` as appropriate; `BendNode` → call `binding.mergeBodiesWithBend`; `JoinNode` → call appropriate geometry helper per `joinType`; `CutNode` → call `binding.booleanCut` to subtract profile from parent panel body; update `node.bodyId` on `PanelNode` after each successful call
- [ ] T023 [US7] Implement `GEOMETRY_STALE` warning injection in `ts/src/manufacturing/graph/graph.ts`: add helper `getStaleWarning(): DrcViolation | null` that returns a warning listing all dirty node IDs when `dirtyNodes.size > 0`; this is called by tool handlers before returning any response that includes body IDs or flat-pattern dimensions (FR-020)
- [ ] T024 [P] [US7] Implement auto-Solve wrapper in `ts/src/manufacturing/graph/graph.ts`: `mutateAndSolve(mutation: () => MutationResult, solver: GeometrySolver, binding: GeometryBinding): MutationResult & { geometrySolve?: GeometrySolveResult }` — runs mutation, then immediately calls `solver.solve()` if mutation succeeded; used by all single-step tool handlers (FR-019)
- [ ] T025 [P] [US7] Write unit tests in `ts/tests/manufacturing/graph/solver.test.ts`: mock `GeometryBinding`; Solve on a 3-node dirty chain completes in one pass; Solve failure on node 2 rolls back and leaves all 3 dirty; `GEOMETRY_STALE` warning emitted when querying body IDs with dirty nodes present; `GeometrySolveResult.solvedNodes` matches expected node IDs; `invalidatedBodyIds` contains old UUIDs

**Checkpoint**: Solver tests pass. Single-step Solve round-trip works end-to-end with mocked binding.

---

## Phase 4: User Story 1 — Bootstrap Graph (Priority: P1)

**Goal**: Implement `bootstrap_graph` — ingest an existing STEP solid, call
`splitBodyByBends`, infer panel/bend relationships, populate the Manufacturing Graph,
auto-Solve once for the whole graph.

**Independent Test**: Import `braai.step` or `testcube.step`, call `bootstrap_graph`.
Verify graph contains one `PanelNode` per flat section and one `BendNode` per bend
zone with thickness and bend-radius populated.

### Implementation for User Story 1

- [ ] T026 [US1] Implement `bootstrapGraph()` in `ts/src/manufacturing/graph/bootstrap.ts`: call `binding.splitBodyByBends(partId, angleThreshold, maxThicknessMm, defaultThicknessMm)`; for each returned `panelId` create a `PanelNode` with auto-generated `node_id` (`"panel-1"`, `"panel-2"`, …) and store `bodyId`; for each detected bend pair create a `BendNode` linking the two panels with detected `angle`, `innerRadius`, K-factor from material config; detect inner-wire topology → create `CutNode` entries for pre-existing holes (FR-005e); call `graph.addNode` for all nodes; run `markDirty` on all; invoke Geometry Solve once at end
- [ ] T027 [US1] Implement foldability bootstrap warnings in `bootstrap.ts`: after all nodes added, call `FoldabilityChecker.check()` for each panel; violations at bootstrap time are warnings only (not errors) per FR-016; collect into `foldability_warnings` array in response
- [ ] T028 [US1] Implement `BOOTSTRAP_PARTIAL` error handling in `bootstrap.ts`: if `splitBodyByBends` returns fewer panels than expected or any panel body is invalid, add unresolved panels as disconnected `PanelNode` entries and return `BOOTSTRAP_PARTIAL` with a list of unresolved body IDs
- [ ] T029 [US1] Register `bootstrap_graph` MCP tool in `ts/src/mcp/tools.ts`: deserialise `part_id`, `root_panel_id_prefix`, `angle_threshold_deg`, `max_thickness_mm`, `default_thickness_mm`; call `bootstrapGraph()`; return response matching `contracts/mcp-tools.md` `bootstrap_graph` schema; include `rollback_token` and `geometry_solve` fields
- [ ] T030 [P] [US1] Write unit tests in `ts/tests/manufacturing/graph/bootstrap.test.ts`: mock `binding.splitBodyByBends`; 2-panel/1-bend fixture → graph has 2 PanelNodes + 1 BendNode; 3-panel/2-bend chain; STEP with pre-existing hole → CutNode created; `BOOTSTRAP_PARTIAL` returned when splitBodyByBends yields unexpected count; foldability warning on closed-box fixture (advisory, not error)

**Checkpoint**: `bootstrap_graph` round-trip works. Graph populated correctly from a known STEP fixture. Auto-Solve runs once.

---

## Phase 5: User Story 2 — Add Bend + Flat Pattern (Priority: P1)

**Goal**: Implement `add_bend` tool. A caller with two existing `PanelNode` entries
calls `add_bend`; the system validates, adds the `BendNode`, runs DRC, auto-Solves,
and returns the updated flat-pattern dimensions and bend allowance.

**Independent Test**: Start from two disconnected `PanelNode` entries; call
`add_bend` (R=1 mm, angle=90°). Verify: BendNode in graph, flat-pattern length =
panelA_flat + BA(90°, R=1, K=0.33, T=1) + panelB_flat ± 0.5 mm.

### Implementation for User Story 2

- [ ] T031 [US2] Implement `DrcChecker.checkBend()` in `ts/src/manufacturing/graph/drc.ts`: validate `innerRadius >= material.minBendRadius` → `DRC_BEND_RADIUS_VIOLATION`; validate resulting flange width ≥ `material.minFlangeWidth` → `DRC_MIN_FLANGE_WIDTH_VIOLATION`; call `FoldabilityChecker.check()` for the proposed new bend → `DRC_FOLDABILITY_VIOLATION`; all checks run synchronously before geometry (FR-010)
- [ ] T032 [US2] Implement bend-allowance computation in `ts/src/manufacturing/graph/types.ts` as pure function `computeBendAllowance(angle: number, radius: number, kFactor: number, thickness: number): number` using formula $BA = \frac{\pi \cdot A}{180} \cdot (R + K \cdot T)$; used by `addBendNode` and by flat-pattern queries (FR-005, FR-008)
- [ ] T033 [US2] Implement `add_bend` handler in `ts/src/mcp/tools.ts`: deserialise inputs per `contracts/mcp-tools.md`; call `drc.checkBend()` → return error if violated; call `graph.addNode(bendNode)` via `mutateAndSolve`; return `node_id`, `bend_allowance_mm`, `rollback_token`, `geometry_solve` fields
- [ ] T034 [P] [US2] Write unit tests in `ts/tests/manufacturing/graph/drc.test.ts`: `DRC_BEND_RADIUS_VIOLATION` fires when R < minBendRadius; `DRC_MIN_FLANGE_WIDTH_VIOLATION` fires when flange too narrow; `DRC_FOLDABILITY_VIOLATION` fires for closed-box 6th bend; clean bend passes all checks; `computeBendAllowance` correct for 45°, 90°, 135° (tabulated expected values)

**Checkpoint**: `add_bend` tool accepts valid bends, rejects DRC violations, returns correct BA.

---

## Phase 6: User Story 2b — Union Merge / Flat Extension (Priority: P1)

**Goal**: When two coplanar panels are fused (via `fuseBodies`), the bootstrap and
graph update must classify the result as a single `PanelNode` (flat extension), not
a zero-degree `BendNode`.

**Independent Test**: Fuse two coplanar rectangles with a 0.2 mm gap; call
`bootstrap_graph` or `update_node`. Verify: one `PanelNode` in graph, no `BendNode`,
flat dimension equals outer-to-outer extent.

### Implementation for User Story 2b

- [ ] T035 [US2b] Implement coplanarity classification in `bootstrap.ts` and `solver.ts`: after `splitBodyByBends` detects panels, compute dihedral angle between adjacent panels; if angle < `graph.coplanarityThresholdDeg` (default 1°) → merge into single `PanelNode` using `fuseBodies`; if ≥ threshold → create `BendNode` with measured angle (FR-005b); sub-mm gap absorbed — no error
- [ ] T036 [US2b] Implement configurable coplanarity threshold loading: read `graph.coplanarityThresholdDeg` from config loaded in T010; pass to `ManufacturingGraph` constructor as `coplanarityThresholdDeg`; expose via `query_graph` response
- [ ] T037 [P] [US2b] Write unit tests in `ts/tests/manufacturing/graph/bootstrap.test.ts` (extend existing): 0° coplanar → single PanelNode; 0.3 mm gap absorbed → single PanelNode; 0.5° angle below threshold → flat extension; 10° angle above threshold → BendNode with 10°; threshold configurable per session

**Checkpoint**: Coplanar fusion produces correct `PanelNode` (no spurious bend allowance).

---

## Phase 7: User Story 7 (Batch Solve) — MCP Tool + Transaction Integration (Priority: P1)

**Goal**: Register the `solve_geometry` MCP tool; integrate Solve with the
`004-transaction-primitive` so batched mutations use explicit Solve; verify the
3-second performance ceiling (SC-012).

**Independent Test**: Add 5 `BendNode` entries inside a transaction; call
`solve_geometry` once; verify geometry engine invoked once (not 5×) and all
5 body IDs returned together.

### Implementation for User Story 7

- [ ] T038 [US7] Register `solve_geometry` MCP tool in `ts/src/mcp/tools.ts`: call `solver.solve()`; return full `GeometrySolveResult` as `contracts/mcp-tools.md` schema; on `SOLVE_FAILED` return structured error with `offending_node_id`
- [ ] T039 [US7] Integrate Geometry Solve with transaction flow in `ts/src/mcp/transactions.ts` + `tools.ts`: single-step tools call `mutateAndSolve` (auto-Solve); transaction-batched mutations MUST NOT auto-Solve — add assertion/guard to `mutateAndSolve` that skips Solve when an active transaction is open; caller must call `solve_geometry` before `commit_transaction` (FR-019)
- [ ] T040 [P] [US7] Write integration test in `ts/tests/integration/graph-workflow.test.ts`: 100-node batch (mock binding) → single `solve_geometry` → binding invoked once per dirty node, not once per mutation; 20-panel bootstrap → Solve invoked once total; single `add_bend` (no transaction) → auto-Solve fires and response includes `geometry_solve` field

**Checkpoint**: `solve_geometry` tool registered and working. Transaction + explicit Solve path verified.

---

## Phase 8: User Story 3 — Flat Pattern from Graph Traversal (Priority: P2)

**Goal**: DXF export uses stored graph `BendNode` parameters (not B-Rep re-inference)
for BA computation and bend-zone annotation.

**Independent Test**: Construct a graph manually (explicit K=0.33, R=1, T=1, A=60°),
call DXF export, verify DXF bend-zone width = BA(60°) = π/3 × (1 + 0.33 × 1) ±
0.5 mm; dashed centre-line marker present.

### Implementation for User Story 3

- [ ] T041 [US3] Implement flat-pattern dimension computation from graph in `ts/src/manufacturing/graph/graph.ts`: add `getFlatPatternDimensions(panelId): { width: number; height: number; bendZones: BendZone[] }` that traverses the graph from root to given panel, summing flat widths and BA values for each `BendNode` in the path, returning bend-zone offsets for DXF annotation (FR-008)
- [ ] T042 [US3] Update DXF export tool handler in `ts/src/mcp/tools.ts` to call `graph.getFlatPatternDimensions()` when a Manufacturing Graph is populated: use stored BA values for bend-zone position instead of topological re-inference; add dashed centre-line annotation at neutral-axis offset per FR-009
- [ ] T043 [P] [US3] Write unit tests in `ts/tests/manufacturing/graph/graph.test.ts` (extend): `getFlatPatternDimensions` on 2-panel/1-bend chain = panelA + BA(90°) + panelB; on 3-panel/2-bend chain = panelA + BA1 + panelB + BA2 + panelC; bend-zone offset matches formula; graph traversal independent of B-Rep topology

**Checkpoint**: DXF bend-zone positions computed from graph parameters. SC-002 passes (within 0.5 mm of existing unfold-based computation).

---

## Phase 9: User Story 3b — JoinNode / Mechanical Fastening (Priority: P2)

**Goal**: Implement `add_join` tool. Callers can add `FLANGE`, `TAB_SLOT`,
`RIVET_PATTERN`, and `WELD_PREP` joining features between panels.

**Independent Test**: Create two panels; call `add_join` with type `TAB_SLOT`.
Verify: `JoinNode` in graph; DXF for each panel includes tab/slot cutout geometry;
no `BendNode` created; rollback removes the JoinNode cleanly.

### Implementation for User Story 3b

- [ ] T044 [US3b] Implement `DrcChecker.checkJoin()` in `drc.ts`: validate `panelAId` and `panelBId` exist; validate `(panelAId, referenceEdgeA)` not already bound → `JOIN_EDGE_ALREADY_BOUND`; validate join-type-specific params (e.g. `spacing > 0` for RIVET_PATTERN)
- [ ] T045 [US3b] Implement `JoinNode` geometry dispatch in `solver.ts`: `RIVET_PATTERN` → call `binding.rivetHoles()` to add holes to both panel bodies; `TAB_SLOT` → call `binding.tabSlot()` to cut tab from one panel and slot from other; `FLANGE` → create auxiliary `PanelNode` (lip) + `BendNode` using existing bend machinery, then store `JoinNode` as the user-facing record; `WELD_PREP` → call `binding.chamfer()` or equivalent on the shared edge
- [ ] T046 [US3b] Register `add_join` MCP tool in `ts/src/mcp/tools.ts`: deserialise all join types and their `params` variants per `contracts/mcp-tools.md`; call `drc.checkJoin()` → `graph.addNode(joinNode)` via `mutateAndSolve`; return `node_id`, `rollback_token`, `geometry_solve`
- [ ] T047 [P] [US3b] Write unit tests in `ts/tests/manufacturing/graph/drc.test.ts` (extend): `JOIN_EDGE_ALREADY_BOUND` when edge already has a BendNode; clean join passes; all four join types have their params validated; write unit tests in `ts/tests/manufacturing/graph/solver.test.ts` (extend): RIVET_PATTERN Solve dispatches to `binding.rivetHoles`; FLANGE Solve creates auxiliary PanelNode + BendNode

**Checkpoint**: `add_join` tool working for all four join types. DXF includes join feature geometry.

---

## Phase 10: User Story 3c — CutNode / Cut Profiles (Priority: P2)

**Goal**: Implement `add_cut` tool. Callers add circular, rectangular, polygon, or
freeform cut profiles to panels. Profiles render as closed inner wires in the DXF.

**Independent Test**: Create a 200×150 mm panel; call `add_cut` (CIRCLE, r=5mm,
centre=(50,40)). Verify: `CutNode` in graph; DXF contains closed circle at (50,40)
inside panel outline; update_node can replace with FREEFORM profile; rollback works.

### Implementation for User Story 3c

- [ ] T048 [US3c] Implement profile validation helpers in `ts/src/manufacturing/graph/types.ts` or a new `ts/src/manufacturing/graph/profile.ts`: `validateProfile(profile, panelFlatDims): DrcViolation[]` — checks bounding box inside panel outline → `CUT_PROFILE_OUT_OF_BOUNDS`; FREEFORM/POLYGON ≥ 3 vertices, no self-intersections (cross-product sign test per `research.md` R-006) → `CUT_INVALID_PROFILE`; overlap with existing CutNodes → `CUT_OVERLAP`; bend-zone intersection → `DRC_CUT_IN_BEND_ZONE` (warning)
- [ ] T049 [US3c] Implement `CutNode` geometry dispatch in `solver.ts`: convert `CutProfile` to OCCT wire: CIRCLE → `binding.createCircleWire`; RECTANGLE → `binding.createRectWire`; POLYGON/FREEFORM → `binding.createPolyWire(vertices)`; subtract from parent panel body via `binding.booleanCut(panelBodyId, cutWire)`; update parent `PanelNode.bodyId` after cut
- [ ] T050 [US3c] Register `add_cut` MCP tool in `ts/src/mcp/tools.ts`: deserialise all profile types per `contracts/mcp-tools.md`; call `validateProfile()` → `graph.addNode(cutNode)` via `mutateAndSolve`; return schema-compliant response
- [ ] T051 [P] [US3c] Write unit tests in `ts/tests/manufacturing/graph/` (extend drc + solver tests): `CUT_PROFILE_OUT_OF_BOUNDS` on profile exceeding panel extent; `CUT_INVALID_PROFILE` on self-intersecting polygon; `CUT_OVERLAP` on two overlapping circles; FREEFORM arbitrary polygon passes validation and dispatches `createPolyWire`; `DRC_CUT_IN_BEND_ZONE` emitted as warning (not error)

**Checkpoint**: `add_cut` tool working for all four profile types. DXF inner wires correctly positioned.

---

## Phase 11: User Story 4 — DRC Blocks Invalid Bends (Priority: P2)

**Goal**: All DRC checks (minimum bend radius, minimum flange width, press-brake
accessibility) fire synchronously at mutation time, before any geometry is touched.

**Independent Test**: Configure material `minBendRadius = 1.5 × T`. Call `add_bend`
with R < 1.5×T. Verify `DRC_BEND_RADIUS_VIOLATION` returned; graph unchanged; no
NAPI call made.

### Implementation for User Story 4

- [ ] T052 [US4] Implement `DrcChecker.checkAll(request)` in `drc.ts`: compose `checkBend()`, `checkFlange()`, `checkAccessibility()` into a single synchronous gate; first violation aborts — no geometry dispatched; return `DrcCheckResult` (see `contracts/graph-events.md`); integrate material config values loaded from `config.yaml` (FR-010)
- [ ] T053 [US4] Implement press-brake accessibility DRC in `drc.ts` as `checkPressbrakeAccessibility(graph, proposedBend)`: compute `degree` of each affected panel; apply heuristic from `research.md` R-004 (degree ≥ 3 with bends distributed around > 2 sides → INACCESSIBLE); this is the graph-only pre-check; `FoldabilityChecker` is called for the full topology check
- [ ] T054 [P] [US4] Write integration test in `ts/tests/integration/graph-workflow.test.ts` (extend): full round-trip showing DRC fires before any binding call; `binding.mergeBodiesWithBend` spy is never called when DRC violation present; graph node count unchanged after rejected mutation

**Checkpoint**: SC-003 passes — zero DRC violations reach the C++ geometry engine.

---

## Phase 12: User Story 5 — Foldability Check (Priority: P2)

**Goal**: Implement `FoldabilityChecker` and the `check_foldability` MCP tool.
Prevent physically impossible assemblies (closed box, closed prism, U-channel cap).

**Independent Test**: Build a 5-sided open box graph; attempt `add_bend` to close
it. Verify `DRC_FOLDABILITY_VIOLATION` returned and graph unchanged.

### Implementation for User Story 5

- [ ] T055 [US5] Implement `FoldabilityChecker.check()` in `ts/src/manufacturing/graph/foldability.ts`: for each `PanelNode`, count connected `BendNode` degree; apply accessibility heuristic from `research.md` R-004; return `FoldabilityCheckResult` with `PanelAccessibility[]` (OPEN / CONSTRAINED / INACCESSIBLE) and locking bend IDs for INACCESSIBLE panels; mark `DRC_FOLDABILITY_UNCERTAIN` when geometry is inconclusive (acute angles < 30°)
- [ ] T056 [US5] Integrate `FoldabilityChecker` into `drc.ts` `checkBend()`: call `foldability.check()` with the proposed new `BendNode` included in a hypothetical graph; if any panel becomes INACCESSIBLE → `DRC_FOLDABILITY_VIOLATION`; reject before geometry
- [ ] T057 [US5] Register `check_foldability` MCP tool in `ts/src/mcp/tools.ts`: call `foldability.check()` on current graph; return `contracts/mcp-tools.md` `check_foldability` response schema (no graph mutation)
- [ ] T058 [P] [US5] Write unit tests in `ts/tests/manufacturing/graph/foldability.test.ts`: 5-sided open box → 6th bend → INACCESSIBLE; L-bracket → U-channel → all OPEN/CONSTRAINED (passes); closed triangle prism → INACCESSIBLE; 2-panel single bend → OPEN; rollback of locking bend clears INACCESSIBLE status; SC-007 canonical cases all covered

**Checkpoint**: SC-007 passes — zero false negatives on known-infeasible topologies. SC-008: `check_foldability` < 200 ms on 20-panel graph.

---

## Phase 13: User Story 6 & 8 — Graph Query + Fabrication Sequence (Priority: P2/P3)

**Goal**: Implement `query_graph` and `reset_graph` tools. AI agents can traverse
the full fabrication sequence in topological order.

**Independent Test**: Bootstrap a 3-panel assembly; call `query_graph`. Verify
response lists P1, B1, P2, B2, P3 in topological order with all parameters.

### Implementation for User Story 6 & 8

- [ ] T059 [US8] Register `query_graph` MCP tool in `ts/src/mcp/tools.ts`: call `graph.queryNodes(topologicalOrder: true)`; serialise each node to the response schema in `contracts/mcp-tools.md` (include `dirty` field, omit `body_id` unless `include_body_ids=true`); include `dirty_node_ids` array and `GEOMETRY_STALE` warning if applicable
- [ ] T060 [US6] Register `reset_graph` MCP tool in `ts/src/mcp/tools.ts`: call `graph.reset()`; clear session geometry registry for graph-owned bodies; return `cleared_node_count`, `cleared_body_count`
- [ ] T061 [P] [US8] Write unit tests in `ts/tests/manufacturing/graph/graph.test.ts` (extend): `queryNodes(true)` returns nodes in Kahn's topological order for P1→B1→P2→B2→P3 chain; `dirty_node_ids` populated correctly when some nodes are dirty; `reset()` clears all state

**Checkpoint**: `query_graph` and `reset_graph` tools working. AI agents can traverse full fabrication sequence.

---

## Phase 14: `update_node` and `remove_node` Tools

**Goal**: Implement the two remaining mutation tools. `update_node` supports full
mutability (all fields, including structural re-wire and node ID rename). `remove_node`
guards against orphaning.

**Independent Test**: Add a `BendNode`; call `update_node` to change R from 1 mm
to 2 mm. Verify: (a) `BendNode.innerRadius` = 2; (b) auto-Solve ran; (c) flat-pattern
length reflects new BA. Then call `remove_node`; verify graph reverts to 2 panels
only.

### Implementation

- [ ] T062 Register `update_node` MCP tool in `ts/src/mcp/tools.ts`: deserialise `node_id` and `updates` object (any subset of fields including `new_node_id`); call `graph.updateNode()` via `mutateAndSolve`; re-run DRC after update; return response with updated `node_id` (new if renamed), `rollback_token`, `geometry_solve`
- [ ] T063 Register `remove_node` MCP tool in `ts/src/mcp/tools.ts`: deserialise `node_id`; call `graph.removeNode()` → `REMOVE_WOULD_ORPHAN_NODES` if guard fires; call `mutateAndSolve`; return `removed_node_id`, `downstream_dirty_ids`, `rollback_token`, `geometry_solve`
- [ ] T064 [P] Write unit tests covering `update_node` and `remove_node` in `ts/tests/manufacturing/graph/graph.test.ts` (extend): node ID rename updates all edge references; structural re-wire of BendNode triggers acyclicity re-check; CutNode FREEFORM profile replaced by CIRCLE profile; `remove_node` on a BendNode marks both formerly-downstream panels dirty; `REMOVE_WOULD_ORPHAN_NODES` fires when PanelNode still referenced by a BendNode

**Checkpoint**: All graph mutation tools complete. Full CRUD over graph nodes.

---

## Phase 15: Polish & Cross-Cutting Concerns

**Purpose**: Integration tests, performance validation, and config schema documentation.

- [ ] T065 [P] Write end-to-end integration test `ts/tests/integration/graph-workflow.test.ts` (primary golden path): bootstrap 2-panel STEP fixture → `add_bend` (R=1, A=90°) → `query_graph` → assert BendNode present, BA = π/2 × (1 + 0.33 × 1) ± 0.5 mm → DXF export → assert bend-zone annotation present; total < 5 s (SC-004)
- [ ] T066 [P] Write SC-011 / SC-012 performance test in `ts/tests/integration/graph-workflow.test.ts`: instrument mock binding call count; 100-node batch via transaction + single `solve_geometry` → binding called exactly once per dirty node (not per mutation); wall-clock < 3 s (SC-012)
- [ ] T067 [P] Write SC-005 rollback regression test: bootstrap → `add_bend` → `rollback_transaction` → assert graph and registry identical to pre-bend state; re-run `add_bend` succeeds
- [ ] T068 Update `ts/config/config.yaml` documentation comment block with the new `graph:` section description; update `docs/CONFIG.md` to document `graph.coplanarityThresholdDeg`
- [ ] T069 [P] Update `docs/MCP Tools.md` with new tool descriptions: `bootstrap_graph`, `add_bend` (updated), `add_join`, `add_cut`, `update_node`, `remove_node`, `solve_geometry`, `check_foldability`, `query_graph`, `reset_graph`
- [ ] T070 Run `npm run build` and confirm zero TypeScript errors; run full test suite `npx vitest run` and confirm all new tests pass and no existing tests regressed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all phases 3–14
- **Phase 3 (Geometry Solve)**: Depends on Phase 2 — BLOCKS phases 4–14 (every story needs Solve)
- **Phase 4 (Bootstrap)**: Depends on Phase 3
- **Phase 5 (add_bend)**: Depends on Phase 3; can run in parallel with Phase 4
- **Phase 6 (Flat Extension)**: Depends on Phase 4 (bootstrap provides flat extension detection)
- **Phase 7 (solve_geometry tool + txn)**: Depends on Phase 3; can run in parallel with 4–6
- **Phases 8–14**: Depend on Phases 2–3; mostly independent of each other (see below)
- **Phase 15 (Polish)**: Depends on all prior phases

### User Story Dependencies

| User Story | Phase | Depends On | Independent? |
|---|---|---|---|
| US7 Geometry Solve | 3, 7 | Phase 2 | Yes — foundational |
| US1 Bootstrap | 4 | Phase 3 | Yes |
| US2 Add Bend | 5 | Phase 3 | Yes |
| US2b Flat Extension | 6 | Phase 4 | Yes |
| US3 Flat Pattern DXF | 8 | Phase 5 | Yes |
| US3b JoinNode | 9 | Phase 3 | Yes |
| US3c CutNode | 10 | Phase 3 | Yes |
| US4 DRC | 11 | Phase 5 | Yes (DRC uses bend logic) |
| US5 Foldability | 12 | Phase 11 | Yes |
| US6+US8 Query | 13 | Phase 2 | Yes |
| update_node/remove_node | 14 | Phase 2 | Yes |

### Parallel Opportunities (within phases)

- Phase 1: T002, T003, T006, T007, T008, T010, T011 all parallelisable
- Phase 2: T015, T018, T019, T020 parallelisable after T012–T014
- Phases 4–14: Once Phase 3 complete, phases 4/5/7/9/10/13/14 can start in parallel

---

## Parallel Example: Phase 3 (Geometry Solve)

```
# Can run in parallel:
Task T024: "Implement auto-Solve wrapper in ts/src/manufacturing/graph/graph.ts"
Task T025: "Write unit tests in ts/tests/manufacturing/graph/solver.test.ts"

# Must follow T021:
Task T022: "Implement per-node-type dispatch in solver.ts"
Task T023: "Implement GEOMETRY_STALE warning injection in graph.ts"
```

---

## Implementation Strategy

### MVP First (US7 + US1 + US2 only — Phases 1–5)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational graph engine
3. Complete Phase 3: Geometry Solve (core engine)
4. Complete Phase 4: Bootstrap graph from STEP
5. Complete Phase 5: `add_bend` with DRC
6. **STOP and VALIDATE**: Run golden-path test (SC-004): bootstrap → `add_bend` → `query_graph` → DXF; all assertions pass; rollback works (SC-005)

**Full delivery** then continues with Phases 6–15 (flat extension, join, cut, foldability, query, polish).

---

## Summary

| Metric | Value |
|---|---|
| Total tasks | 70 |
| Phase 1 (Setup) | 11 tasks |
| Phase 2 (Foundational) | 9 tasks |
| Phase 3 (Geometry Solve) | 5 tasks |
| Phase 4 (Bootstrap / US1) | 5 tasks |
| Phase 5 (add_bend / US2) | 4 tasks |
| Phase 6 (Flat Extension / US2b) | 3 tasks |
| Phase 7 (solve_geometry tool / US7) | 3 tasks |
| Phase 8 (DXF from graph / US3) | 3 tasks |
| Phase 9 (JoinNode / US3b) | 4 tasks |
| Phase 10 (CutNode / US3c) | 4 tasks |
| Phase 11 (DRC / US4) | 3 tasks |
| Phase 12 (Foldability / US5) | 4 tasks |
| Phase 13 (Query / US6+US8) | 3 tasks |
| Phase 14 (update_node + remove_node) | 3 tasks |
| Phase 15 (Polish) | 6 tasks |
| Parallel-eligible tasks [P] | 28 of 70 |
| MVP scope (Phases 1–5) | 34 tasks |
