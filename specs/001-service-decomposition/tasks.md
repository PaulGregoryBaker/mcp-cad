# Tasks: Service Decomposition Refactor

**Input**: Design documents from `specs/001-service-decomposition/`

**Prerequisites**: plan.md ✅ · spec.md ✅ · research.md ✅ · data-model.md ✅

**Tests**: Existing test suite is used as the regression gate throughout. No new test tasks — the spec requirement is that all existing tests continue to pass.

**Organization**: Tasks are grouped by user story. US1 (navigation) and US2 (isolation) are served by the same decomposition work; US1 labels mark TypeScript decomposition, US2 labels mark C++ decomposition. US3 = deduplication. US4 = dead code. US5 (test regression) is the acceptance gate at every checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks in same phase)
- **[US1]**: Navigation — developer can find a capability by filename
- **[US2]**: Isolation — new operations added without touching unrelated files
- **[US3]**: Deduplication — each logical operation exists in exactly one place
- **[US4]**: Dead code removed — unused functions and commented blocks deleted

---

## Phase 1: Setup — Baseline Safety Net

**Purpose**: Capture the pass/fail baseline and inventory all dead code *before* any file is changed. Nothing may be moved or deleted until this phase is complete.

- [ ] T001 Run full integration test suite (`cd ts && npx jest --runInBand`) and save pass/fail counts to `specs/001-service-decomposition/baseline-results.txt`
- [ ] T002 Compile C++ with unused-function warnings (`cmake --build` with `-DCMAKE_CXX_FLAGS="-Wunused-function"`) and pipe output to `specs/001-service-decomposition/dead-code.md` under a "C++ Unused Symbols" section
- [ ] T003 Temporarily add `"noUnusedLocals": true, "noUnusedParameters": true` to `ts/tsconfig.json`, run `npx tsc --noEmit`, append TypeScript unused-symbol warnings to `specs/001-service-decomposition/dead-code.md` under a "TypeScript Unused Symbols" section, then revert `ts/tsconfig.json`
- [ ] T004 Manual sweep of `cpp/src/geometry/geometry_service.cc` and `ts/src/mcp/tools.ts` for commented-out blocks, `// LEGACY`, `// OLD`, `// TODO remove` markers; append findings to `specs/001-service-decomposition/dead-code.md` under "Commented-Out / Legacy Blocks"

**Checkpoint**: `baseline-results.txt` and `dead-code.md` committed. No source files changed.

---

## Phase 2: Foundational — TypeScript State Extraction

**Purpose**: All TypeScript handler modules need shared state. Extracting it first prevents circular imports and avoids rework.

**⚠️ CRITICAL**: No handler extraction (Phase 3) can begin until this phase is complete and tests pass.

- [ ] T005 Create `ts/src/mcp/state.ts` and move into it from `ts/src/mcp/tools.ts`: `geometryBindingOverride`, `setGeometryBindingMock`, `getGeometryBinding`, `semanticStoreInstance`, `setSemanticStore`, `getSemanticStore`, `mcpManufacturingGraphs`, `mcpActivePart`, `mcpSolvers`, `initializeSolvers`, `findGraphOwner`, `createPart`, `getManufacturingGraph`, `setActivePart`, `deletePart`, `listParts`, `getGeometrySolver`, `getGraphFoldabilityChecker`, `resetMcpGraphStateForTests`, `registerTestPart` — all with their original export signatures
- [ ] T006 Replace all moved declarations in `ts/src/mcp/tools.ts` with `import` statements from `./state.js`; confirm no remaining references to moved symbols exist inside `tools.ts` itself
- [ ] T007 Run full test suite; confirm zero regressions against `baseline-results.txt` before proceeding

**Checkpoint**: `state.ts` exists, `tools.ts` imports from it, tests green.

---

## Phase 3: User Story 1 — TypeScript Handler Extraction

**Goal**: Move every handler function and its corresponding tool definition schema out of `tools.ts` into purpose-specific modules under `ts/src/mcp/handlers/`. After this phase, navigating to any tool's logic takes one filename lookup.

**Independent Test**: Given the refactored `ts/src/mcp/` directory listing, a developer can locate the file responsible for any named MCP tool within 60 seconds without opening `tools.ts`.

### Implementation for User Story 1

- [ ] T008 Create directory `ts/src/mcp/handlers/` (add empty `.gitkeep` to track it)
- [ ] T009 [US1] Create `ts/src/mcp/handlers/booleans.ts`: export `booleanDefinitions` array (schemas for `fuse_bodies`, `cut_bodies`, `intersect_bodies`) and handler functions `handleFuseBodies`, `handleCutBodies`, `handleIntersectBodies` moved from `tools.ts`
- [ ] T010 [US1] Remove the three boolean handlers and their schemas from `tools.ts`; add `import` from `./handlers/booleans.js` in the `dispatchTool` switch; run tests
- [ ] T011 [P] [US1] Create `ts/src/mcp/handlers/body-ops.ts`: export `bodyOpsDefinitions` (schemas for `clean_geometry`, `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology`, `translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face`, `fillet_edges`, `chamfer_edges`, `simplify_body`, `heal_geometry_ex`, `offset_shape`, `delete_face`, `sew_faces`, `center_and_align_body`) and corresponding handler functions moved from `tools.ts`
- [ ] T012 [US1] Remove body-ops handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T013 [P] [US1] Create `ts/src/mcp/handlers/shape-ops.ts`: export `shapeOpsDefinitions` (schemas for `split_body_by_plane`, `merge_bodies_with_bend`, `close_gap`, `is_panel_valid`, `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, `compute_intersections`, `compute_gaps`, `trim_body_with_plane`, `check_boundary_compliance`, `split_body_by_bends`, `remove_protrusions`) and corresponding handler functions moved from `tools.ts`
- [ ] T014 [US1] Remove shape-ops handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T015 [P] [US1] Create `ts/src/mcp/handlers/manufacturing.ts`: export `manufacturingDefinitions` (schemas for `decompose_volume`, `synthesize_joints`, `generate_reliefs`, `validate_sheet_metal`, `reconstruct_curved_bends`, `evaluate_manufacturability`, `validate_bend_sequence`, `simulate_nesting`) and corresponding handler functions moved from `tools.ts`
- [ ] T016 [US1] Remove manufacturing handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T017 [P] [US1] Create `ts/src/mcp/handlers/unfold-export.ts`: export `unfoldExportDefinitions` (schemas for `apply_unfold`, `export_production_pack`, `get_export_job_status`, `get_export_job_result`) and corresponding handler functions moved from `tools.ts`
- [ ] T018 [US1] Remove unfold-export handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T019 [P] [US1] Create `ts/src/mcp/handlers/assembly.ts`: export `assemblyDefinitions` (schemas for `create_assembly_document`, `add_assembly_instance`, `mate_rigid`, `list_assembly_tree`, `validate_assembly`) and corresponding handler functions moved from `tools.ts`
- [ ] T020 [US1] Remove assembly handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T021 [P] [US1] Create `ts/src/mcp/handlers/transactions.ts`: export `transactionDefinitions` (schemas for `rollback`, `begin_transaction`, `commit_transaction`, `rollback_transaction`, `get_transaction_history`) and corresponding handler functions moved from `tools.ts`
- [ ] T022 [US1] Remove transaction handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T023 [P] [US1] Create `ts/src/mcp/handlers/semantic.ts`: export `semanticDefinitions` (schemas for `declare_semantic_entity`, `bind_semantic_entity`, `resolve_geometry`, `semantic_lineage`) and corresponding handler functions moved from `tools.ts`
- [ ] T024 [US1] Remove semantic handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T025 [P] [US1] Create `ts/src/mcp/handlers/graph.ts`: export `graphDefinitions` (schemas for `create_part`, `set_active_part`, `list_parts`, `delete_part`, `bootstrap_graph`, `add_bend`, `solve_geometry`, `check_foldability`, `query_graph`, `reset_graph`, `update_node`, `remove_node`, `add_join`, `add_cut`) and corresponding handler functions moved from `tools.ts`
- [ ] T026 [US1] Remove graph handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T027 [P] [US1] Create `ts/src/mcp/handlers/mapping.ts`: export `mappingDefinitions` (schemas for `map_3d_to_2d`, `map_2d_to_3d`) and handler functions `handleMapTo2D`, `handleMapTo3D` moved from `tools.ts`
- [ ] T028 [US1] Remove mapping handlers and schemas from `tools.ts`; wire imports in dispatch switch; run tests
- [ ] T029 [US1] Create `ts/src/mcp/registry.ts`: import all `*Definitions` arrays from every handler module and export `getToolDefinitions(): object[]` that spreads them all into one array — replace the monolithic `getToolDefinitions()` block in `tools.ts` with an import from `./registry.js`
- [ ] T030 [US1] Create `ts/src/mcp/dispatch.ts`: move `dispatchTool()` switch body into this file, importing handler functions from their respective `handlers/*.js` modules; update `tools.ts` to re-export `dispatchTool` from `./dispatch.js`
- [ ] T031 [US1] Thin `ts/src/mcp/tools.ts` to a pure barrel: it should only re-export `getToolDefinitions` from `./registry.js`, `dispatchTool` from `./dispatch.js`, and test helpers from `./state.js`; the file must have no function implementations
- [ ] T032 [US1] Verify: run full test suite; confirm `tools.ts` has fewer than 30 lines; confirm all baseline tests pass

**Checkpoint**: `tools.ts` is a 30-line barrel. Every MCP tool's handler and schema live in a named module. Tests green.

---

## Phase 4: User Story 2 — C++ Method Extraction

**Goal**: Move all methods of `GeometryServiceImpl` from the 9,242-line monolith into per-domain `.cc` files. After this phase, the C++ geometry directory lists files whose names describe a single geometric concern.

**Independent Test**: Given the `cpp/src/geometry/` directory listing, a developer can identify the file responsible for any named C++ operation (e.g., "boolean union", "unfold shell") within 60 seconds.

### Implementation for User Story 2

- [X] T033 [US2] Create `cpp/src/geometry/geometry_service_impl.hpp`: move all OCCT `#include` directives, `SolidState`, `ShellState`, `FlatBendEdge`, `UnfoldState`, `AssemblyState` struct definitions, and `static` helper declarations (`generateUUID`, `nowMs`, `shapeId`) from `geometry_service.cc` into this internal header; the file must not be included by `geometry_service.hpp` or by any file outside the geometry layer
- [X] T034 [US2] Create `cpp/src/geometry/geometry_service_core.cc`: include `geometry_service_impl.hpp`; move the `GeometryServiceImpl` constructor, `GeometryService::create()` factory function, `clearState()`, `clearSnapshots()`, `restoreSnapshot()`, and the definitions of `generateUUID`, `nowMs`, `shapeId`; confirm build
- [X] T035 [P] [US2] Create `cpp/src/geometry/geometry_service_booleans.cc`: move `fuseBodies`, `cutBodies`, `intersectBodies` implementations; include `geometry_service_impl.hpp`; confirm build after adding to CMakeLists.txt temporarily
- [X] T036 [P] [US2] Create `cpp/src/geometry/geometry_service_transforms.cc`: move `translateBody`, `rotateBody`, `mirrorBody`, `scaleBody`, `alignToFace`; include `geometry_service_impl.hpp`
- [X] T037 [P] [US2] Create `cpp/src/geometry/geometry_service_modelling.cc`: move `filletEdges`, `chamferEdges`, `offsetShape`, `deleteFace`, `sewFaces`, `closeGap`; include `geometry_service_impl.hpp`
- [X] T038 [P] [US2] Create `cpp/src/geometry/geometry_service_shell.cc`: move `separateSolids`, `unfoldShell`, `thickenSheet`, `reconstructCurvedBends`, `getPanelFrame`; include `geometry_service_impl.hpp`
- [X] T039 [P] [US2] Create `cpp/src/geometry/geometry_service_export.cc`: move `exportDxf`, `buildSheetFromDxf`, `exportGlb`; include `geometry_service_impl.hpp`
- [X] T040 [P] [US2] Create `cpp/src/geometry/geometry_service_measurement.cc`: move `computeBoundingBox`, `computeMassProperties`, `measureDistance`, `exploreTopology`; include `geometry_service_impl.hpp`
- [X] T041 [P] [US2] Create `cpp/src/geometry/geometry_service_assembly.cc`: move `createAssemblyDocument`, `addAssemblyInstance`, `mateRigid`, `listAssemblyTree`; include `geometry_service_impl.hpp`
- [X] T042 [P] [US2] Create `cpp/src/geometry/geometry_service_validation.cc`: move `checkManifold`, `healGeometryEx`, `simplifyBody`; include `geometry_service_impl.hpp`
- [X] T043 [P] [US2] Create `cpp/src/geometry/geometry_service_sheet_metal.cc`: move `splitBodyByBends`, `validateSheetMetal`; include `geometry_service_impl.hpp`
- [X] T044 [US2] Update `cpp/CMakeLists.txt`: replace the `geometry_service.cc` entry in `target_sources(...)` with all ten new `.cc` files (`geometry_service_core.cc`, `geometry_service_booleans.cc`, `geometry_service_transforms.cc`, `geometry_service_modelling.cc`, `geometry_service_shell.cc`, `geometry_service_export.cc`, `geometry_service_measurement.cc`, `geometry_service_assembly.cc`, `geometry_service_validation.cc`, `geometry_service_sheet_metal.cc`)
- [X] T045 [US2] Verify `cmake --build` succeeds with all new source files and zero linker errors (confirms all methods are implemented and no method is double-defined)
- [X] T046 [US2] Delete `cpp/src/geometry/geometry_service.cc` (the original monolith); confirm build still passes
- [X] T047 [US2] Run full test suite; confirm zero regressions against `baseline-results.txt`

**Checkpoint**: `geometry_service.cc` is gone. `cpp/src/geometry/` lists 10 purpose-named `.cc` files. C++ build and all tests green.

---

## Phase 5: User Story 3 — Deduplication Sweep

**Goal**: Each logical operation exists in exactly one location across the refactored codebase. Any helper that was duplicated across the old monolith is now shared.

**Independent Test**: Given two callers of the same logical operation in the refactored code, both call the same shared function. No inline copy exists alongside a named function performing the same work.

### Implementation for User Story 3

- [ ] T048 [US3] Audit all new C++ `.cc` files for duplicated `static` helper functions or repeated inline patterns (e.g., shape-to-string conversions, tolerance checks, error formatting); document each duplication in `specs/001-service-decomposition/dedup-report.md`
- [ ] T049 [US3] Audit all TypeScript `handlers/*.ts` files for repeated argument-extraction patterns, repeated null-checks, repeated error-wrapping patterns; document in `specs/001-service-decomposition/dedup-report.md`
- [ ] T050 [US3] For each C++ duplication in the report: move the shared helper into `geometry_service_core.cc` (or create `cpp/src/geometry/geometry_service_utils.cc` if helpers span more than 3 files) and update all callers; build and test after each consolidation
- [ ] T051 [US3] For each TypeScript duplication in the report: extract the shared pattern into `ts/src/mcp/handlers/utils.ts` and update all callers; run tests after each consolidation
- [ ] T052 [US3] Verify: run full test suite; confirm `dedup-report.md` shows zero remaining duplicates

**Checkpoint**: All identified duplicates consolidated. `dedup-report.md` closed. Tests green.

---

## Phase 6: User Story 4 — Dead Code Deletion

**Goal**: Every function, class, variable, and comment block identified in `dead-code.md` (Phase 1) is permanently deleted from the codebase.

**Independent Test**: Search the codebase for each function name listed in `dead-code.md`; none of them exist.

### Implementation for User Story 4

- [ ] T053 [US4] Delete each C++ unused static function listed in `dead-code.md` from its new `.cc` home; build after each deletion to confirm nothing relied on it
- [ ] T054 [P] [US4] Delete each TypeScript unused function listed in `dead-code.md` from its handler module; run `tsc --noEmit` after each deletion to confirm no callers exist
- [ ] T055 [US4] Delete all commented-out code blocks from all new C++ `.cc` files (cross-reference "Commented-Out / Legacy Blocks" section in `dead-code.md`); build after each file
- [ ] T056 [P] [US4] Delete all commented-out code blocks from all TypeScript handler modules; run `tsc --noEmit` after each file
- [ ] T057 [US4] Run full test suite; confirm zero regressions; mark `dead-code.md` as resolved

**Checkpoint**: `dead-code.md` fully resolved. Zero unused symbols remain in the geometry and MCP layers. Build and tests green.

---

## Phase 7: Polish & Final Validation

**Purpose**: Confirm all success criteria from the spec are met.

- [ ] T058 [P] Run full integration test suite and confirm every test that passed at baseline still passes (SC-003: 100% parity); update `baseline-results.txt` with final run
- [ ] T059 [P] Line-count audit: run `wc -l cpp/src/geometry/geometry_service_*.cc ts/src/mcp/handlers/*.ts ts/src/mcp/state.ts ts/src/mcp/registry.ts ts/src/mcp/dispatch.ts`; flag any file exceeding 1,000 lines for further review (target ceiling is 400 per SC-001)
- [ ] T060 Discoverability check: for each operation name in the spec's SC-004 list ("boolean union", "unfold", "shell query", "assembly", "semantic", "graph"), verify by filename alone that the correct module can be identified within 60 seconds
- [ ] T061 Count distinct source files added: confirm the geometry layer has at least 10 new `.cc` files and the MCP layer has at least 10 new modules (SC-005: at least 4 new files above current state — easily exceeded)
- [ ] T062 Update `CLAUDE.md` speckit pointer to reflect that this refactor is complete; if a follow-on feature is active, point to its plan instead

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 completion — blocks Phase 3
- **Phase 3 (US1 / TS)**: Depends on Phase 2 — can be worked task-by-task; each T0XX+T0(XX+1) pair is independent of other pairs
- **Phase 4 (US2 / C++)**: Independent of Phase 3 — can run in parallel with Phase 3 once Phase 2 is done
- **Phase 5 (US3)**: Depends on Phase 3 and Phase 4 completion (need final files to audit)
- **Phase 6 (US4)**: Depends on Phase 5 completion (dead code audit was done in Phase 1 but deletion happens here)
- **Phase 7 (Polish)**: Depends on all prior phases complete

### User Story Dependencies

- **US1 (P1)**: Phases 2 → 3 → 7
- **US2 (P1)**: Phase 4 → 7 (parallel to US1 once Phase 2 done)
- **US3 (P2)**: Phases 3 + 4 must complete → Phase 5 → 7
- **US4 (P2)**: Phase 1 inventory done → Phase 6 → 7
- **US5 (P1/constraint)**: Tests run at every checkpoint; blocking gate throughout

### Within Each Phase

- Pairs marked `[P]` (e.g., T011, T013, T015...) can be implemented in parallel — they touch different files
- Each extraction pair (`T0XX create module` → `T0(XX+1) remove from tools.ts + wire dispatch`) must be sequential within that pair
- All handler extractions in Phase 3 are independent of each other (different files); their `wire dispatch` steps can interleave freely

---

## Parallel Opportunities

### Phase 3: Handler Extraction (can parallelize across these clusters)

```
Cluster A: T009 → T010  (booleans)
Cluster B: T011 → T012  (body-ops)
Cluster C: T013 → T014  (shape-ops)
Cluster D: T015 → T016  (manufacturing)
Cluster E: T017 → T018  (unfold-export)
Cluster F: T019 → T020  (assembly)
Cluster G: T021 → T022  (transactions)
Cluster H: T023 → T024  (semantic)
Cluster I: T025 → T026  (graph)
Cluster J: T027 → T028  (mapping)
→ T029 registry (waits for all clusters)
→ T030 dispatch (waits for all clusters)
→ T031 barrel (waits for T029 + T030)
```

### Phase 4: C++ File Creation (can all start in parallel after T034)

```
T035, T036, T037, T038, T039, T040, T041, T042, T043  (all parallel)
→ T044 CMakeLists (waits for all)
→ T045 build verify → T046 delete monolith → T047 tests
```

---

## Implementation Strategy

### MVP Scope (User Stories 1 + 2 only — navigation and isolation)

1. Complete Phase 1: Baseline (T001–T004)
2. Complete Phase 2: State extraction (T005–T007)
3. Complete Phase 3: TS handler extraction (T008–T032)
4. Complete Phase 4: C++ extraction (T033–T047)
5. **VALIDATE**: Developer can navigate the directory listing to any capability
6. Stop here if deduplication and dead code can be deferred

### Full Scope (all user stories)

Add Phase 5 (US3 deduplication) → Phase 6 (US4 dead code) → Phase 7 (validation)

### Suggested commit points

- After T007 (state extraction green)
- After each T0(XX+1) pair in Phase 3 (after wiring each handler module)
- After T032 (TS fully decomposed)
- After T047 (C++ fully decomposed)
- After T052 (deduplication complete)
- After T057 (dead code clean)
- After T062 (final validation)

---

## Notes

- `[P]` tasks touch different files — they can be assigned to different agents or worked concurrently
- Run tests after every `wire dispatch` step (T010, T012, T014, T016, T018, T020, T022, T024, T026, T028) — catching a breakage early is far cheaper than untangling it later
- The C++ internal header `geometry_service_impl.hpp` (T033) is the key enabler for Phase 4; nothing in Phase 4 can proceed until T033 is correct
- `geometry_service.hpp` (the public facade) must not be modified during this refactor — the NAPI binding layer depends on it unchanged
- `tools.ts` re-exports must preserve the exact same exported symbol names to avoid breaking the `napi/geometry_binding.cc` and any integration test imports
