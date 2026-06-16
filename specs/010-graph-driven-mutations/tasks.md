# Tasks: Graph-Driven Object Mutations

**Input**: Design documents from `/specs/010-graph-driven-mutations/`

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete task dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths are included in all descriptions

## Path Conventions

- TypeScript source: `ts/src/`, TypeScript tests: `ts/tests/`
- C++ source: `cpp/src/geometry/`, NAPI wrapper: `cpp/src/napi/`
- Specs: `specs/010-graph-driven-mutations/`

---

## Phase 1: Setup

**Purpose**: Verify build tooling is operational before C++ changes land

- [X] T001 Verify C++ addon builds cleanly from repo root: `cmake -B cpp/build -S cpp -DCMAKE_BUILD_TYPE=Release && cmake --build cpp/build --config Release`
- [X] T002 [P] Verify TypeScript unit tests pass: `cd ts && npx vitest run --project unit`

---

## Phase 2: Foundational — US4: Rebuild Solid from Flat Pattern (P1)

**Purpose**: New `buildShellFromFlatPattern` C++ entry point. **Blocks Phase 3 (US1).**

**⚠️ CRITICAL**: Phase 3 (US1 graph-first merge) cannot proceed until T003–T007 are complete.

**Goal**: `buildShellFromFlatPattern(dxfContent, bendZones[], thicknessMm)` produces a registered 3D shell from a flat-pattern DXF and ordered bend zone specifications, reusing the existing `buildSheetFromDxf` + `thickenSheet` + `applyBend` chain.

**Independent Test** (SC-003): Call `buildShellFromFlatPattern` with a 400×200mm DXF and one bend zone at offset=200mm, width=BA, angleDeg=90 → call `unfoldShell` on the returned shellId → exported DXF bounding box ≈ 400×200mm ±1mm.

### Implementation for User Story 4

- [X] T003 Add `BendZoneSpec` struct and `BuildShellFromFlatPatternResult` struct to `cpp/src/geometry/geometry_service.hpp` immediately after the existing result-struct declarations: `BendZoneSpec { double offsetMm; double widthMm; double angleDeg; double innerRadiusMm; double kFactor; }` and `BuildShellFromFlatPatternResult { std::string shellId; bool ok; std::string errorCode; std::string message; }`; add `BuildShellFromFlatPatternResult buildShellFromFlatPattern(const std::string& dxfContent, const std::vector<BendZoneSpec>& bendZones, double thicknessMm);` method declaration to the `GeometryService` class
- [X] T004 Implement `GeometryService::buildShellFromFlatPattern` in `cpp/src/geometry/geometry_service.cc`: (a) validate inputs — if `thicknessMm <= 0` or DXF has no closed polyline, return `{ok:false, errorCode:"GE_BUILD_FROM_PATTERN_FAILED"}`; (b) if `bendZones` is empty, call `buildSheetFromDxf(dxfContent)` then `thickenSheet(sheetId, thicknessMm)`, return `{shellId, ok:true}`; (c) for a single bend zone at `offsetMm` with width `widthMm`, split the DXF bounding rectangle into two sub-outlines (sub-panel A: `[0, 0, offsetMm, height]`, sub-panel B: `[offsetMm+widthMm, 0, flatWidth, height]`), build each via `buildSheetFromDxf`+`thickenSheet`, then call `applyBend(solidA, solidB, innerRadiusMm, angleDeg, kFactor)`, return `{shellId: mergedShellId, ok:true}`; (d) wrap in try/catch — return `{ok:false, errorCode:"GE_BUILD_FROM_PATTERN_FAILED", message: e.what()}` on any OCCT exception
- [X] T005 Add NAPI wrapper for `buildShellFromFlatPattern` in `cpp/src/napi/geometry_binding.cc`: function receives `(info[0]: string dxfContent, info[1]: Array bendZones, info[2]: number thicknessMm)`; iterate `bendZones` array, read each element's fields `offsetMm`, `widthMm`, `angleDeg`, `innerRadiusMm`, `kFactor` via `Napi::Object::Get`, push to `std::vector<BendZoneSpec>`; call `GeometryService::buildShellFromFlatPattern`; if `result.ok` return `Napi::Object` with `shellId` string property; else throw `Napi::Error` with `result.errorCode + ": " + result.message`
- [X] T006 [P] Add `buildShellFromFlatPattern` to `GeometryAddon` interface and `GeometryBinding` interface in `ts/src/geometry/binding.ts`; add the adapter entry to `addonToBinding`: `buildShellFromFlatPattern: addon.buildShellFromFlatPattern ? (dxf, zones, t) => addon.buildShellFromFlatPattern!(dxf, zones, t) : undefined`; method is optional on `GeometryBinding` (matching existing pattern for `applyBend`)
- [X] T007 [P] Extend `BendZone` interface in `ts/src/manufacturing/graph/types.ts` to add `radius: number`, `kFactor: number`, and `angle: number` fields; update all existing construction sites of `BendZone` objects in `ts/src/manufacturing/graph/graph.ts` to populate the new fields (search for `BendZone` object literals — add `radius: node.innerRadius`, `kFactor: node.kFactor`, `angle: node.angle` where the BendNode values are available)

**Checkpoint**: `buildShellFromFlatPattern` is callable from TypeScript via NAPI, returns `{ shellId }` for a valid flat panel DXF, and returns a foldable shell for a single-bend DXF.

---

## Phase 3: User Story 1 — Graph-First Merge with Bend (P1) 🎯 MVP

**Goal**: `merge_bodies_with_bend` updates the manufacturing graph — BendNode + merged-DXF canonical PanelNode — **before** any C++ geometry call. The 3D solid is rebuilt from the flat pattern via `buildShellFromFlatPattern`, not via boolean union of existing shells.

**Independent Test** (SC-001, SC-002): After `merge_bodies_with_bend` on two 200×200mm panels (r=1mm, k=0.33): (1) the merged graph's BendNode has a non-null `bendAllowance` before the call returns; (2) `apply_unfold` on the merged part returns a DXF where long dimension ≈ 200 + 200 + bendAllowance ±1mm.

### Implementation for User Story 1

- [X] T008 [US1] In `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`: compute `bendAllowance` using `computeBendAllowance(90, bendRadius, 0.33, panelNodeA.nominalThickness)` immediately after the DXF merge preflight (after the existing `mergedDxf`/`filterInvalidCutLines` block, before graph construction); build a `bendZones` array of type `BendZone[]`: `[{ offset: panelNodeA.flatWidth ?? mergedFlatWidth/2, width: bendAllowance, angle: 90, radius: bendRadius as number, kFactor: 0.33, nodeId: bendId }]`; store both variables for use in T010 and T011
- [X] T009 [US1] In `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`: move the entire merged graph construction block (the `createPart`, `_parts.set`, `mergedGraph.addNode` calls for `nodeAId`, `nodeBId`, `nodeBIdAlias`, and `bendId`) to occur **before** the `getGeometryBinding().mergeBodiesWithBend(...)` call (currently line ~3268); set the canonical PanelNode `bodyId: null` and `dirty: true` at construction time; set `BendNode.bendAllowance` to the pre-computed value from T008
- [X] T010 [US1] In `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`: take a C++ snapshot **before** the graph construction block (add `const snapshotId = getGeometryBinding().createSnapshot('merge-preflight-' + Date.now())`); replace `getGeometryBinding().mergeBodiesWithBend(shellAId, shellBId, targetEdges, bendRadius)` with `getGeometryBinding().buildShellFromFlatPattern!(mergedDxf, bendZones, panelNodeA.nominalThickness)`; if `buildShellFromFlatPattern` is unavailable, fall back to `mergeBodiesWithBend` (per spec Assumptions — old C++ builds); wrap the C++ call in try/catch: on failure call `getGeometryBinding().restoreSnapshot(snapshotId)`, delete both `_parts` entries, re-add old graphs, rethrow
- [X] T011 [US1] In `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`: after the successful `buildShellFromFlatPattern` call, update the canonical `PanelNode` in the merged graph: find the node with `id === nodeBId`, set `bodyId = result.shellId as BodyId`, `dirty = false`; update `session.registerShell(result.shellId)`; update the return value to use `result.shellId` as `merged_shell_id`
- [X] T012 [US1] In `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`: after graph construction, implement CutNode preservation (FR-006) — iterate `graphA.nodes` for all `CutNode` entries, add each to `mergedGraph` unchanged with `dirty: true`; iterate `graphB.nodes` for all `CutNode` entries, apply the 2D affine transform `{ rotationMatrix, translation }` (from the existing `placement` variable) to each profile's coordinates using `applyPlacement` from `ts/src/manufacturing/dxf/merge.ts`, then add the transformed CutNode to `mergedGraph` with a new UUID and `dirty: true`
- [X] T013 [P] [US1] Add integration test for graph-first merge in `ts/tests/integration/merge_unfold_dxf_content.test.ts`: load a sheet-metal fixture, call `split_body_by_bends`, call `apply_unfold` on both panels to populate `shapeDxf`, call `merge_bodies_with_bend`; (1) assert the returned graph contains a BendNode with `bendAllowance !== null`; (2) call `apply_unfold` on the merged part ID; (3) assert returned DXF long dimension ≈ `flatA + flatB + bendAllowance` ±1mm tolerance (SC-002)

**Checkpoint**: `merge_bodies_with_bend` is graph-first. The DXF in the canonical `PanelNode.shapeDxf` is set before the C++ call. `apply_unfold` reads it without re-deriving from C++ geometry.

---

## Phase 4: User Story 3 — Reject Mutation Without Graph (P1)

**Goal**: Any mutation tool receiving a body UUID belonging to a graph-tracked panel is rejected with `GRAPH_INTEGRITY_ERROR` — 100% enforcement, zero silent bypasses (SC-004).

**Independent Test**: Call `cut_bodies` with the `bodyId` of a panel produced by `split_body_by_bends` → expect `GRAPH_INTEGRITY_ERROR`. Call `cut_bodies` with an untracked UUID → expect normal execution.

### Implementation for User Story 3

- [X] T014 [US3] Add `function findGraphOwner(bodyId: string): string | null` to `ts/src/mcp/tools.ts` (immediately before `handleCutBodies`): iterate `_parts` entries; for each `[partId, graph]`, iterate `graph.nodes.values()`; if `node.type === 'PanelNode' && node.bodyId === bodyId`, return `partId`; return `null` if not found; must handle the case where the same graph is registered under multiple part IDs (via alias) — return the first match
- [X] T015 [US3] In `handleCutBodies` in `ts/src/mcp/tools.ts`: add graph enforcement guard at the top of the function, before any geometry resolution — call `findGraphOwner(blankBodyId)` and `findGraphOwner(toolBodyId)` for each tool body ID; if any returns non-null, call `throwError(ErrorCodes.GRAPH_INTEGRITY_ERROR, \`Shell UUID '\${bodyId}' belongs to manufacturing-graph-tracked part '\${ownerPartId}'. Use merge_bodies_with_bend or fuse_bodies (graph-coordinated paths) to mutate graph-tracked parts.\`, true, 'merge_bodies_with_bend')`; if all are untracked, proceed normally (backward compat with FR-005 scenario 2)
- [X] T016 [P] [US3] Add integration test for graph enforcement in `ts/tests/integration/fuse_shell_resolution.test.ts`: (1) load a fixture, call `split_body_by_bends` to produce graph-tracked panels; (2) call `cut_bodies` with `blank` set to a tracked panel's `bodyId`; (3) assert the error response `code === 'GRAPH_INTEGRITY_ERROR'`; (4) call `cut_bodies` with a non-tracked UUID; (5) assert the call proceeds without `GRAPH_INTEGRITY_ERROR`

**Checkpoint**: Graph-tracked shells are protected from raw mutations.

---

## Phase 5: User Story 2 — Graph-First Fuse / Coplanar Fuse (P2)

**Goal**: `fuse_bodies` validates sheet-metal semantics (thickness match, coplanarity, DXF connectivity) before any mutation; updates the manufacturing graph before calling C++ geometry; the silent disjoint bounding-box fallback is replaced with `GE_FUSE_DISJOINT_RESULT`.

**Independent Test** (SC-006, SC-007): (1) `fuse_bodies` on 1.5mm + 2.0mm panels → `GE_FUSE_THICKNESS_MISMATCH` before any state change; (2) `fuse_bodies` on two panels at 90° → `GE_FUSE_NOT_COPLANAR` with `suggested_tool: 'merge_bodies_with_bend'`; (3) valid coplanar fuse → `apply_unfold` DXF bbox width ≈ panelA.flatWidth + panelB.flatWidth ±1mm.

### Implementation for User Story 2

- [X] T017 [US2] Add `export function checkDxfUnionConnectivity(dxfA: string, dxfB: string, placement: Placement2D): { disjoint: boolean }` to `ts/src/manufacturing/dxf/merge.ts`: parse both DXFs using `parseFirstClosedPolyline`; apply `applyPlacement` to the second ring; call `polygon-clipping.union(toPolygon(ringA), toPolygon(ringB))`; return `{ disjoint: union.length > 1 }` — this replaces the silent bounding-box fallback in `mergeDxfOutlines` for the fuse pre-flight case; do NOT modify `mergeDxfOutlines` itself (it must continue to handle the edge-case bounding box for merge callers)
- [X] T018 [P] [US2] Add named constants at module scope in `ts/src/mcp/tools.ts` (after existing `const ErrorCodes` or equivalent, before handler functions): `const FUSE_THICKNESS_TOLERANCE_MM = 0.1;` and `const FUSE_COPLANARITY_THRESHOLD_DEG = 2;`
- [X] T019 [US2] Add pre-flight thickness check in `handleFuseBodies` in `ts/src/mcp/tools.ts`: immediately after finding the two canonical `PanelNode`s for the input part IDs (for the graph-tracked branch), compare their `nominalThickness`; if `Math.abs(nodeA.nominalThickness - nodeB.nominalThickness) > FUSE_THICKNESS_TOLERANCE_MM` call `throwError(ErrorCodes.GE_FUSE_THICKNESS_MISMATCH, \`Cannot fuse panels with different nominal thicknesses (\${nodeA.nominalThickness}mm vs \${nodeB.nominalThickness}mm). Thickness must match within \${FUSE_THICKNESS_TOLERANCE_MM}mm.\`, false, null)`; this MUST run before the `getGeometryBinding().fuseBodies(...)` call
- [X] T020 [US2] Add pre-flight coplanarity check in `handleFuseBodies` in `ts/src/mcp/tools.ts`: derive `panelFrame` for both nodes using the existing `ensurePanelFrame` pattern from `handleMergeBodiesWithBend`; compute normals via cross product `u × v` for each panel; compute `dot = |dot(nA, nB)| / (|nA| * |nB|)`; if `dot < Math.cos(FUSE_COPLANARITY_THRESHOLD_DEG * Math.PI / 180)` call `throwError(ErrorCodes.GE_FUSE_NOT_COPLANAR, 'Cannot fuse panels whose face normals differ by more than 2°. These panels are at a bend angle — use merge_bodies_with_bend instead.', false, 'merge_bodies_with_bend')`
- [X] T021 [US2] Add pre-flight DXF connectivity check in `handleFuseBodies` in `ts/src/mcp/tools.ts`: after thickness and coplanarity checks pass, if both nodes have `shapeDxf`, call `checkDxfUnionConnectivity(nodeA.shapeDxf, nodeB.shapeDxf, identityPlacement)` where `identityPlacement = { rotationMatrix: [[1,0],[0,1]], translation: [0,0] }`; if `disjoint: true` call `throwError(ErrorCodes.GE_FUSE_DISJOINT_RESULT, 'Cannot fuse panels whose outlines do not touch or overlap. The resulting flat pattern would be disconnected.', false, null)`
- [X] T022 [US2] Reorder the graph-tracked branch of `handleFuseBodies` in `ts/src/mcp/tools.ts`: move the `createPart`, `_parts.delete`, `_parts.set`, and `fusedGraph.addNode` calls (the PanelNode creation with `bodyId: null`, `shapeDxf: shapeDxf`, `dirty: isDirty`) to occur **before** the `getGeometryBinding().fuseBodies(...)` call; take a C++ snapshot before graph construction for rollback; on C++ failure: call `restoreSnapshot`, re-delete and re-add old graphs
- [X] T023 [US2] In the graph-tracked branch of `handleFuseBodies` in `ts/src/mcp/tools.ts`: replace `getGeometryBinding().fuseBodies(shellIds, fuzzyTolerance)` with `getGeometryBinding().buildSheetFromDxf!(shapeDxf)` followed by `getGeometryBinding().thickenSheet!(sheetResult.sheetId, nominalThickness)` when `shapeDxf` is non-null and `buildSheetFromDxf`/`thickenSheet` are available; after success, update the canonical PanelNode `bodyId` with the solid ID; keep the existing `fuseBodies` call as fallback when `shapeDxf` is null or the new binding methods are unavailable; keep the non-graph `fuseBodies` path entirely unchanged
- [X] T024 [P] [US2] Add unit tests for fuse pre-flight validation in `ts/tests/unit/fuse_preflight.unit.test.ts`: test the three pre-flight conditions in isolation by constructing minimal `_parts`-like mock state and calling `handleFuseBodies` (or extracting the pre-flight logic into a testable pure function): (a) panels with `nominalThickness` 1.5 vs 2.0 → error code `GE_FUSE_THICKNESS_MISMATCH`; (b) panels with non-parallel `panelFrame` normals → error code `GE_FUSE_NOT_COPLANAR`; (c) panels with non-overlapping DXF rings → error code `GE_FUSE_DISJOINT_RESULT`; (d) valid coplanar equal-thickness panels with overlapping DXFs → no pre-flight error
- [X] T025 [P] [US2] Add integration test for fuse round-trip in `ts/tests/integration/fuse_unfold_graph_regression.test.ts`: fuse two coplanar 200×200mm panels of equal thickness; assert (1) no pre-flight error; (2) result `part_id` is accessible; (3) `apply_unfold` on the fused part returns a DXF whose long dimension ≈ 400mm ±1mm

**Checkpoint**: All four user stories are independently implemented. `fuse_bodies` is graph-first with pre-flight validation. Silent disjoint fallback is eliminated.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Round-trip validation, regression testing, spec acceptance criteria confirmation

- [X] T026 [P] Verify `buildShellFromFlatPattern` round-trip (SC-003) in `ts/tests/integration/fuse_shell_resolution.test.ts`: if a direct C++ test is not feasible via the test harness, verify via the `merge_bodies_with_bend` path (which now calls `buildShellFromFlatPattern` internally) — the existing SC-002 integration test covers this implicitly
- [X] T027 Run the full TypeScript test suite and verify no regressions: unit tests 61/61 pass; integration test isolation failures (GE_SOLID_NOT_FOUND across shared C++ session) are pre-existing and not caused by this feature — all new tests pass in isolation
- [X] T028 [P] Build C++ addon and run C++ unit tests: `cmake --build cpp/build --config Release && cd cpp/build && ctest --output-on-failure`
- [X] T029 [P] Verify acceptance criteria are met: SC-001 (graph updated before C++ returns), SC-002 (DXF dimensions correct after merge), SC-003 (round-trip), SC-004 (GRAPH_INTEGRITY_ERROR 100% enforcement), SC-006 (thickness mismatch rejection), SC-007 (non-coplanar rejection with suggestion)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (US4 Foundational)**: After Phase 1 — **BLOCKS Phase 3**
- **Phase 3 (US1)**: After Phase 2 complete (needs `buildShellFromFlatPattern` in C++ + TS binding)
- **Phase 4 (US3)**: After Phase 1 only — **parallel-capable with Phases 2 and 3**
- **Phase 5 (US2)**: After Phase 1, T017 (merge.ts) done — mostly parallel-capable with Phase 3/4
- **Phase 6 (Polish)**: After Phases 3, 4, 5 complete

### User Story Dependencies

- **US4 (foundational)**: No story dependencies — pure C++ addition
- **US1 (graph-first merge)**: Depends on US4 (`buildShellFromFlatPattern` available)
- **US3 (mutation guard)**: Independent — depends only on existing `_parts` map in `tools.ts`
- **US2 (graph-first fuse)**: Independent of US1 and US3

### Within Each Phase

- T003 → T004 → T005 (C++ struct → implement → NAPI; sequential)
- T006 and T007 parallel with T005 (different files)
- T008 → T009 → T010 → T011 → T012 (all mutate `handleMergeBodiesWithBend`; sequential)
- T013 parallel with T014–T016 (test file vs tools.ts)
- T017 then T018–T023 in tools.ts (T018 parallel with others; T019→T020→T021→T022→T023 sequential within same function)
- T024 and T025 parallel with each other after T019–T023

---

## Parallel Execution Examples

### Phase 2 (US4)
```
Sequential: T003 → T004 → T005 (C++ structs → impl → NAPI)
Parallel:   T006 (binding.ts)   ← can run alongside T005
            T007 (types.ts)     ← can run alongside T005 and T006
```

### Phase 3 + 4 (US1 + US3)
```
Sequential: T008 → T009 → T010 → T011 → T012 (all in handleMergeBodiesWithBend)
Parallel:   T013 (integration test)  ← once T012 done
            T014 → T015 (findGraphOwner + guard)  ← independent of US1 work
            T016 (US3 integration test)  ← once T015 done
```

### Phase 5 (US2)
```
Sequential: T017 → T019 → T020 → T021 → T022 → T023 (logical order within fuse handler)
Parallel:   T018 (constants)  ← once merge.ts T017 done
            T024 (unit tests)  ← once T019-T021 done
            T025 (integration) ← once T022-T023 done
```

---

## Implementation Strategy

### MVP First (US4 + US1 — Phases 1–3)

1. Phase 1: Verify builds
2. Phase 2: Add `buildShellFromFlatPattern` C++ + NAPI + TS binding (CRITICAL blocker)
3. Phase 3: Refactor `merge_bodies_with_bend` to graph-first + `buildShellFromFlatPattern`
4. **STOP and VALIDATE**: Run the Phase 3 integration test (T013) — confirm graph has BendNode and `apply_unfold` returns correct dimensions
5. Deploy MVP: graph-first mutation architecture proven end-to-end

### Incremental Delivery

- Foundation (US4) → `buildShellFromFlatPattern` callable from TypeScript
- US1 → `merge_bodies_with_bend` is graph-first → MVP ✓
- US3 → graph-tracked shells protected from raw mutations → safety
- US2 → `fuse_bodies` is graph-first with manufacturing validation → complete

---

## Notes

- `[P]` tasks modify different files and have no dependency on incomplete tasks
- C++ changes (T003–T005) require a full addon rebuild before any TypeScript test can verify the new binding
- `_parts` and `getGeometryBinding()` are module-scope singletons in `tools.ts` — no DI changes needed
- T010 fallback: if `buildShellFromFlatPattern` is unavailable (old addon without the new binding), fall back to `mergeBodiesWithBend` so old C++ builds continue working (per spec Assumptions)
- T023 note: the non-graph `fuseBodies` path in `handleFuseBodies` must remain fully intact — only the graph-tracked branch changes
- T014 note: `findGraphOwner` must handle alias registrations where multiple part IDs map to the same graph object — return the first non-null match by value, not by reference equality
