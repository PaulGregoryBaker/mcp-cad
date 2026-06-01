# Tasks: Splits by Bends and Viewport Alignment Enhancements (008)

**Input**: Design documents from `/specs/008-improve-splits-by-bends/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test-driven development tasks are included for each phase to ensure rigorous validation of OCCT calculations and remapping logic.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Exact file paths are included in descriptions.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure.

- [ ] T001 Copy testing STEP fixture `cauldron.step` into [cpp/tests/fixtures/cauldron.step](../../cpp/tests/fixtures/cauldron.step) to establish the baseline test target.
- [ ] T002 Update C++ and NAPI CMake structures in [cpp/src/napi/CMakeLists.txt](../../cpp/src/napi/CMakeLists.txt) to verify standard native compile compatibility.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core type and error definitions that must be completed before any user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Register the new error codes (`GE_ALIGN_FAILED`, `GE_MERGE_NON_MANIFOLD`, `GE_PROTRUSION_LOOP_FAILED`) in [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp).
- [ ] T004 [P] Expose new error definitions in TypeScript layer in [ts/src/mcp/errors.ts](../../ts/src/mcp/errors.ts).
- [ ] T005 [P] Expose `AlignmentResult` and update `SplitBodyByBendsResult` in [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts).
- [ ] T006 [P] Expose NAPI addon method wrappers for coordinate centering and new protrusion algorithm inputs in [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts).

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Cauldron Decomposition and Trapezoidal Face Merging (Priority: P1) 🎯 MVP

**Goal**: Integrate adjacent coplanar triangular facets into unified flat trapezoidal panels.

**Independent Test**: Decompose the cauldron step fixture using `split_body_by_bends` and assert that adjacent coplanar triangles are combined into trapezoidal panels, returning exactly flat panel bodies without isolated triangles.

### Tests for User Story 1

- [ ] T007 [P] [US1] Write GTest unit cases for B-Rep facet merging and angle tolerance checks in [cpp/tests/geometry_test.cc](../../cpp/tests/geometry_test.cc).
- [ ] T008 [P] [US1] Write vitest integration cases verifying cauldron decomposition into flat trapezoidal panel count in [ts/tests/integration/split_by_bends.integration.test.ts](../../ts/tests/integration/split_by_bends.integration.test.ts).

### Implementation for User Story 1

- [ ] T009 [US1] Implement **Facet Unification Pass** logic in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) inside `splitBodyByBends` to unify adjacent planar facets sharing collinear seams where the dihedral angle deviation is within `angle_threshold_deg` (default 0.5°).
- [ ] T010 [US1] Map the C++ facet merging to Node Addon bindings in [cpp/src/napi/geometry_binding.cc](../../cpp/src/napi/geometry_binding.cc).
- [ ] T011 [US1] Verify that `split_body_by_bends` returns clean panel bodies on `cauldron.step` without isolated triangular facets.

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently.

---

## Phase 4: User Story 2 - Model Orientation and Viewport Alignment (Priority: P2)

**Goal**: Expose explicit on-demand functions to translate centroids and align vertical normal axes.

**Independent Test**: Call `center_and_align_body` on `cauldron.step` and verify it relocates its Center of Mass to `[0,0,0]` and rotates standard coordinate vectors.

### Tests for User Story 2

- [ ] T012 [P] [US2] Write unit tests in [cpp/tests/geometry_test.cc](../../cpp/tests/geometry_test.cc) verifying principal inertia axes alignment calculations.
- [ ] T013 [P] [US2] Write integration tests in [ts/tests/integration/split_by_bends.integration.test.ts](../../ts/tests/integration/split_by_bends.integration.test.ts) for on-demand alignment tool calls and centroid offsets verification.

### Implementation for User Story 2

- [ ] T014 [US2] Define the `centerAndAlignBody` method signatures in [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp).
- [ ] T015 [US2] Implement the Center of Mass centroid translation (`BRepGProp`) and principal inertia axes rotation calculation in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) inside `centerAndAlignBody`.
- [ ] T016 [US2] Bind the alignment method to NAPI bindings in [cpp/src/napi/geometry_binding.cc](../../cpp/src/napi/geometry_binding.cc).
- [ ] T017 [US2] Register the `center_and_align_body` tool schema and handler in [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts).

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently.

---

## Phase 5: User Story 3 - Merge by Bend on Complex Adjacent Panels (Priority: P3)

**Goal**: Support stitching adjacent curved cauldron panel faces with dynamic fuzzy sewing tolerance.

**Independent Test**: Call `merge_bodies_with_bend` on adjacent split panels from `cauldron.step` and verify they successfully fuse into a watertight manifold body.

### Tests for User Story 3

- [ ] T018 [P] [US3] Add complex adjacent faces stitching integration test cases in [ts/tests/integration/split_by_bends.integration.test.ts](../../ts/tests/integration/split_by_bends.integration.test.ts).

### Implementation for User Story 3

- [ ] T019 [US3] Update C++ seam validation in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) inside `mergeBodiesWithBend` to perform a preliminary `BRepBuilderAPI_Sewing` pass with a dynamic thickness-based fuzzy sewing tolerance ($0.05\text{ mm} - 0.2\text{ mm}$) to close minute coordinates gaps on cauldron non-planar seams.

**Checkpoint**: User Stories 1, 2, and 3 should now be independently functional.

---

## Phase 6: User Story 4 - Mesh-based Loop-Traversal Protrusion Removal (Priority: P4)

**Goal**: Implement the mesh edge cycle search to cleanly slice flanges without disrupting flat panel hosts.

**Independent Test**: Call `remove_protrusions` using the new mesh loop algorithm, comparing execution time and panel boundary preservation.

### Tests for User Story 4

- [ ] T020 [P] [US4] Add loop cycle tests and performance benchmark cases in [ts/tests/integration/split_by_bends.integration.test.ts](../../ts/tests/integration/split_by_bends.integration.test.ts).

### Implementation for User Story 4

- [ ] T021 [US4] Implement the **Mesh Edge-Traversal Loop Algorithm** in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) within `removeProtrusions` to identify localized narrow closed edge loop cycles and slice protrusions along the loop boundary.
- [ ] T022 [US4] Retain the legacy volumetric method as `remove_protrusions_legacy` in C++ and NAPI layers for comparative benchmark execution.
- [ ] T023 [US4] Expose `algorithm` choice parameter schema and handle dispatch options in [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts).

**Checkpoint**: All user stories should now be independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories.

- [ ] T024 [P] Ensure full `shape_history` is successfully returned from `splitBodyByBends` and registered on transaction commit to verify Dolt branch and PR diffing semantic remappings in [ts/src/semantic/mapping_layer.ts](../../ts/src/semantic/mapping_layer.ts).
- [ ] T025 [P] Clean up unused debug variables and native compiler warnings in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc).
- [ ] T026 Run final E2E verification smoke test sequence defined in [specs/008-improve-splits-by-bends/quickstart.md](../../specs/008-improve-splits-by-bends/quickstart.md).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational phase completion.
  - User stories can then proceed in parallel (if staffed) or sequentially in priority order (P1 → P2 → P3 → P4).
- **Polish (Final Phase)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories.
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - No dependencies on other stories.
- **User Story 3 (P3)**: Can start after US1 is complete (depends on split panels being generated correctly).
- **User Story 4 (P4)**: Can start after Foundational (Phase 2) - No dependencies on other stories.

---

## Parallel Example: User Story 1

```bash
# Launch models and test suites in parallel:
Task: "Write GTest unit cases for B-Rep facet merging in cpp/tests/geometry_test.cc"
Task: "Write vitest integration cases in ts/tests/integration/split_by_bends.integration.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Test User Story 1 independently on `cauldron.step` to ensure trapezoids are merged.
5. Commit and deliver MVP increment.

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready.
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!).
3. Add User Story 2 → Test independently → Deploy/Demo.
4. Add User Story 3 → Test independently → Deploy/Demo.
5. Add User Story 4 → Test independently → Deploy/Demo.
