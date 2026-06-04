# Tasks: Build Manufacturing Plan Tool

**Input**: Design documents from `/specs/010-build-manufacturing-plan/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Setup directory structure for orchestrator in `ts/src/manufacturing/reconstruction/`
- [x] T002 Define Typescript interfaces for reconstruction report in `ts/src/manufacturing/reconstruction/types.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core C++ and NAPI changes that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 [P] Update `DecomposedByBendsResult` to include `splitPairs` in `cpp/src/geometry/geometry_service.hpp`
- [x] T004 [P] Implement `splitPairs` tracking in `splitBodyByBends` inside `cpp/src/geometry/geometry_service.cc`
- [x] T005 Export `split_pairs` from C++ to NAPI inside `cpp/src/napi/geometry_binding.cc`
- [x] T006 Update TS geometry bindings for `splitBodyByBends` to capture `split_pairs` in `ts/src/geometry/binding.ts`

**Checkpoint**: Foundation ready - C++ splits now return adjacency topology.

---

## Phase 3: User Story 1 - Automatic Reconstruction of Sheet Metal Parts (Priority: P1) 🎯 MVP

**Goal**: Automatically partition a solid body, validate panels, and reconstruct them using `mergeBodiesWithBend` along adjacent split pairs.

**Independent Test**: Load a simple bracket STEP file, run `build_manufacturing_plan`, verify that a single merged body ID and a valid manufacturing graph with 2 panels and 1 bend is returned.

### Tests for User Story 1

- [x] T007 [P] [US1] Create integration test structure in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

### Implementation for User Story 1

- [x] T008 [US1] Implement core orchestrator skeleton and split-handling in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T009 [US1] Implement panel validation and graph bootstrapping from `split_pairs` in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T010 [US1] Implement standard merge reconstruction loop in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T011 [US1] Register `build_manufacturing_plan` MCP tool in `ts/src/mcp/tools.ts`
- [x] T012 [P] [US1] Verify User Story 1 using Vitest integration tests in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

**Checkpoint**: MVP works - simple parts are split, validated, and reconstructed.

---

## Phase 4: User Story 2 - Detection and Isolation of Non-Panel Features (Priority: P2)

**Goal**: Isolate non-panel components (protrusions) and register them as unmerged auxiliary parts in the output.

**Independent Test**: Run orchestrator on a part with a welded boss protrusion, check that the protrusion is kept separate and returned in the `unmerged_parts` list.

### Tests for User Story 2

- [x] T013 [P] [US2] Add test cases for protrusion classification in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

### Implementation for User Story 2

- [x] T014 [US2] Update orchestrator to isolate `protrusion_ids` and add them to `unmerged_parts` in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T015 [P] [US2] Verify User Story 2 using Vitest integration tests in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

**Checkpoint**: Protrusion isolation complete - auxiliary components are flagged and unmerged.

---

## Phase 5: User Story 3 - Prevention of Process-Breaking or Impossible Joints (Priority: P3)

**Goal**: Score and prioritize merges, and perform trial merges checking foldability and DRC, leaving violating joints unmerged.

**Independent Test**: Run orchestrator on a closed-loop box where a bend collides, check that the colliding joint is skipped and returned in `skipped_joints`.

### Tests for User Story 3

- [x] T016 [P] [US3] Add test cases for impossible joints (collision/foldability check) in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

### Implementation for User Story 3

- [x] T017 [US3] Implement scoring and prioritization of merges in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T018 [US3] Implement trial merge, DRC verification, and rollback logic for impossible joints in `ts/src/manufacturing/reconstruction/orchestrator.ts`
- [x] T019 [P] [US3] Verify User Story 3 using Vitest integration tests in `ts/tests/integration/build_manufacturing_plan.integration.test.ts`

**Checkpoint**: Intelligent merge logic complete - impossible/violating joints are skipped.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, cleanup, and validation

- [x] T020 [P] Update quickstart documentation in `specs/010-build-manufacturing-plan/quickstart.md`
- [x] T021 Run end-to-end local validation of `build_manufacturing_plan` tool using a workspace simulator
- [x] T022 [P] Clean up unused debug logs and refactor orchestrator code for final review

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User Story 1 (P1): Can start after Phase 2 is complete.
  - User Story 2 (P2): Extends User Story 1. Starts after US1 base checkpoint.
  - User Story 3 (P3): Extends US1/US2. Starts after US2 base checkpoint.
- **Polish (Phase 6)**: Depends on all user stories being complete.

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel.
- Foundational tasks marked [P] (T003, T004) can run in parallel.
- Story-specific test setup and file structures can be drafted in parallel with code development.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (C++ and NAPI changes)
3. Complete Phase 3: User Story 1 (core orchestrator skeleton, split-handling, merge loop, tool registry)
4. **STOP and VALIDATE**: Verify simple sheet metal reconstruction works end-to-end.
