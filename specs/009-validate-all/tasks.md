# Tasks: Assembly Validation and Autofix Recommendations (009)

**Input**: Design documents from `/specs/009-validate-all/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test-driven development tasks are included for each user story phase to ensure rigorous validation of OCCT calculations and remapping logic.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Exact file paths are included in descriptions.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure.

- [x] T001 Register the new tool name schema in [specs/009-validate-all/contracts/validate_assembly.contract.json](../../specs/009-validate-all/contracts/validate_assembly.contract.json).
- [x] T002 Create the placeholder integration test file in [ts/tests/integration/validate_assembly.integration.test.ts](../../ts/tests/integration/validate_assembly.integration.test.ts).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core type and error definitions that must be completed before any user story can be implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 [P] Define `ValidationError`, `ValidationReport`, and `AutofixRecommendation` structures in [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts).
- [ ] T004 [P] Register the native C++ `checkAssemblyClashes` method bindings and TypeScript interfaces in [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts).
- [ ] T005 [P] Declare `ClashPair` and `BBox3D` structures and `checkAssemblyClashes` method signature in [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp).
- [ ] T006 [P] Expose `checkAssemblyClashes` wrapper inside NAPI binding layer in [cpp/src/napi/geometry_binding.cc](../../cpp/src/napi/geometry_binding.cc).

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Run Comprehensive Assembly Validation (Priority: P1) 🎯 MVP

**Goal**: Detect clashing parts using AABB + B-Rep checks, and verify sheet metal parts unfold successfully.

**Independent Test**: Load a multi-part STEP assembly containing some overlapping parts and a non-unfoldable sheet metal part, run the validation tool, and assert that the output lists the exact part IDs that fail sheet-metal checks and the exact overlapping pairs with zero false positives.

### Tests for User Story 1

- [ ] T007 [P] [US1] Write Catch2 unit tests in [cpp/tests/geometry_test.cc](../../cpp/tests/geometry_test.cc) to verify the C++ `checkAssemblyClashes` method.
- [ ] T008 [P] [US1] Write Vitest integration test cases in [ts/tests/integration/validate_assembly.integration.test.ts](../../ts/tests/integration/validate_assembly.integration.test.ts) asserting that `validate_assembly` catches clashes and unfold failures.

### Implementation for User Story 1

- [ ] T009 [US1] Implement native AABB calculation, Sweep-and-Prune AABB filtering, and exact B-Rep intersection checks in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) under `checkAssemblyClashes`.
- [ ] T010 [US1] Implement core `ValidationEngine` and rule interfaces in [ts/src/validation/validator.ts](../../ts/src/validation/validator.ts) to manage rule execution.
- [ ] T011 [US1] Implement the `UnfoldRule` in [ts/src/validation/rules/unfold.ts](../../ts/src/validation/rules/unfold.ts) executing the unfolding check on all parts by default.
- [ ] T012 [US1] Implement the `ClashRule` in [ts/src/validation/rules/clash.ts](../../ts/src/validation/rules/clash.ts) invoking the native `checkAssemblyClashes` binding.
- [ ] T013 [US1] Register the `validate_assembly` tool and link the command handler to `ValidationEngine.validate` in [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts).

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently.

---

## Phase 4: User Story 2 - Get Autofix Recommendations (Priority: P2)

**Goal**: Validation errors return structured autofix suggestions.

**Independent Test**: Create a validation error for a non-sheet-metal surface part. Assert that the validation output contains an `autofix` block recommending the `split_body_by_bends` tool with correct arguments.

### Tests for User Story 2

- [ ] T014 [P] [US2] Add integration test cases in [ts/tests/integration/validate_assembly.integration.test.ts](../../ts/tests/integration/validate_assembly.integration.test.ts) to verify suggested tool names and parameters for unfolding and clash errors.

### Implementation for User Story 2

- [ ] T015 [US2] Add autofix recommendation generation to `UnfoldRule` in [ts/src/validation/rules/unfold.ts](../../ts/src/validation/rules/unfold.ts) suggesting `split_body_by_bends` with default or computed thickness.
- [ ] T016 [US2] Add autofix recommendation generation to `ClashRule` in [ts/src/validation/rules/clash.ts](../../ts/src/validation/rules/clash.ts) suggesting `trim_body_with_plane` and correct arguments.

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently.

---

## Phase 5: User Story 3 - Modular Rule Extensibility (Priority: P3)

**Goal**: Registry pattern allows registering third-party/custom rules.

**Independent Test**: Register a mock validation rule under a new category (e.g., `nesting_errors`), verify that the validation runner executes it, and check that its results are cleanly appended to the output JSON report.

### Tests for User Story 3

- [ ] T017 [P] [US3] Add integration tests in [ts/tests/integration/validate_assembly.integration.test.ts](../../ts/tests/integration/validate_assembly.integration.test.ts) verifying that dynamic registration of a mock custom rule compiles, runs, and populates the report under the `nesting` category.

### Implementation for User Story 3

- [ ] T018 [US3] Refactor `ValidationEngine` registry to expose `registerRule()` and ensure rules are categorized properly in [ts/src/validation/validator.ts](../../ts/src/validation/validator.ts).

**Checkpoint**: All user stories should now be independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories.

- [ ] T019 [P] Clean up any compiler/linter warnings in C++ and TypeScript.
- [ ] T020 Run final verification smoke test sequence defined in [specs/009-validate-all/quickstart.md](../../specs/009-validate-all/quickstart.md).
- [ ] T021 [P] Write a comprehensive end-to-end integration test in [ts/tests/integration/validate_assembly.integration.test.ts](../../ts/tests/integration/validate_assembly.integration.test.ts) that loads a multi-error assembly, asserts that all error categories are reported, applies the recommended autofixes sequentially, and verifies the assembly resolves to a clean (valid) state.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories.
- **User Stories (Phase 3+)**: All depend on Foundational phase completion.
  - User stories can then proceed in parallel (if staffed) or sequentially in priority order (P1 → P2 → P3).
- **Polish (Final Phase)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories.
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable.
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable.
