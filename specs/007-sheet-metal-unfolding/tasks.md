# Tasks: Advanced Sheet Metal Unfolding (007)

**Input**: Design documents from `/specs/007-sheet-metal-unfolding/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/mcp-tool-schemas.md](./contracts/mcp-tool-schemas.md)

**Tests**: Test-writing tasks are included at the start of each User Story phase to ensure full coverage of C++ core math and TS integration endpoints.

**Organization**: Tasks are structured sequentially across Setup, Foundation, and 3 User Story phases to support incremental development, testing, and MVP delivery.

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- All descriptions include explicit file paths.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Register new C++ structures, virtual signatures, and TS interfaces.

- [x] T001 Create C++ structures `SheetMetalValidationResult`, `GapSewResult`, and `CurvedRebuildResult` in [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp)
- [x] T002 Declare virtual signatures `validateSheetMetal` and `reconstructCurvedBends` in [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp)
- [x] T003 [P] Add TypeScript interfaces `SheetMetalValidationResult`, `GapSewResult`, and `CurvedRebuildResult` to [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Wire the C++ native addon bindings, MCP protocol routing, and error schemas.

**⚠️ CRITICAL**: No User Story implementation work can begin until this phase is complete.

- [x] T004 Define NAPI addon bindings for `validateSheetMetal` and `reconstructCurvedBends` in [cpp/src/napi/geometry_binding.cc](../../cpp/src/napi/geometry_binding.cc)
- [x] T005 [P] Expose native addon methods `validateSheetMetal` and `reconstructCurvedBends` in [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts)
- [x] T006 [P] Add error codes `GE_INVALID_SHEET_METAL`, `GE_UNFOLD_CYCLE_DETECTED`, `GE_UNFOLD_T_JUNCTION`, `GE_UNFOLD_SEWING_FAILED`, and `GE_UNFOLD_REBUILD_FAILED` to [ts/src/mcp/errors.ts](../../ts/src/mcp/errors.ts)
- [x] T007 Register MCP tool schemas and handler switches for `validate_sheet_metal` and `reconstruct_curved_bends` in [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts)

**Checkpoint**: Foundation ready - C++/TS bridges and protocol interfaces are fully wired.

---

## Phase 3: User Story 1 - Validate and Flatten Sheet Metal Parts (Priority: P1) 🎯 MVP

**Goal**: Establish sheet validation (constant thickness, planar area ratios) and graph cycle/T-junction checks to ensure correct flat calculations.

**Independent Test**: Execute `validate_sheet_metal` on standard brackets (valid) and blocks/varying sheets (invalid) to verify true positive and negative outcomes.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, and ensure they FAIL before implementation**

- [x] T008 [P] [US1] Write C++ unit test cases for thin panel offsets, parallel faces, and cycles in [cpp/tests/geometry_test.cc](../../cpp/tests/geometry_test.cc)
- [x] T009 [P] [US1] Write TypeScript integration test suites verifying validation tool failures in `ts/tests/integration/unfold.integration.test.ts`

### Implementation for User Story 1

- [x] T010 [US1] Implement face normal grouping and parallel plane offset thickness distance logic in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) (`GeometryServiceImpl::validateSheetMetal`)
- [x] T011 [US1] Implement surface area ratio validation (ensuring $\geq 85\%$ of surface consists of flat offset sheets) in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T012 [US1] Construct the face-bend topological connectivity graph (planar face nodes, bend edges) in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T013 [US1] Implement cycle and T-junction (edge degree $> 2$) DFS/BFS graph verification checks in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T014 [US1] Integrate `validateSheetMetal` into `unfoldShell` to enforce validation before flattening in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)

**Checkpoint**: User Story 1 is fully functional. Valid sheet metal components are successfully verified and flattened; non-conforming shapes are rejected.

---

## Phase 4: User Story 2 - Automated Repair and Sharp-to-Curved Refolding (Priority: P2)

**Goal**: Stitch edge seams up to $0.1\text{ mm}$ automatically, and reconstruct infinitely sharp folding lines into high-fidelity curved bend models.

**Independent Test**: Load a bracket with sharp transitions and small gaps, apply auto-healing and curved reconstruction, and verify the resulting solid is manifold.

### Tests for User Story 2

- [x] T015 [P] [US2] Write unit tests for $0.1\text{ mm}$ gap sewing and sharp joint filleting in [cpp/tests/geometry_test.cc](../../cpp/tests/geometry_test.cc)

### Implementation for User Story 2

- [x] T016 [US2] Integrate `BRepBuilderAPI_Sewing` with a default tolerance of $0.1\text{ mm}$ within the unfold routine in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T017 [US2] Add open edge audits throwing `GE_UNFOLD_SEWING_FAILED` in C++ if seams remain open above tolerance after sewing in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T018 [US2] Implement sharp joint filleting using `BRepFilletAPI_MakeFillet` ($R_i = t, R_e = 2t$) in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) (`GeometryServiceImpl::reconstructCurvedBends`)
- [x] T019 [US2] Register reconstructed curved shapes as replacement solids in the session and capture shape histories in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)

**Checkpoint**: User Story 2 is complete. Superficial disconnects are automatically sewn, and sharp joints are reconstructed into realistic 3D cylindrical bends.

---

## Phase 5: User Story 3 - DXF Export with Bends and Cutouts (Priority: P3)

**Goal**: Generate flat 2D pattern drawings separated into `'CUT'`, `'BEND_UP'`, and `'BEND_DOWN'` layers with text annotations.

**Independent Test**: Export the flat blank to DXF and verify layer entities and annotations inside a CAD viewer.

### Tests for User Story 3

- [x] T020 [P] [US3] Write TypeScript integration test suites verifying DXF layer structures in `ts/tests/integration/unfold.integration.test.ts`

### Implementation for User Story 3

- [x] T021 [US3] Group outer boundary profiles and internal holes onto the `'CUT'` layer inside `exportDxf` in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T022 [US3] Project bend centerlines during BFS traversal and assign them to `'BEND_UP'` or `'BEND_DOWN'` based on rotation angle sign in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)
- [x] T023 [US3] Inject standard DXF TEXT entities indicating fold angle and direction next to centerlines in [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc)

**Checkpoint**: All user stories are complete. Flat pattern drawings can be exported as layered production DXFs.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verification, documentation, and performance tuning.

- [x] T024 [P] Update C++ nesting test suites in [cpp/tests/nesting_test.cc](../../cpp/tests/nesting_test.cc) to utilize the precise flat dimensions
- [x] T025 Execute the complete smoke testing playbook outlined in [quickstart.md](./quickstart.md)
- [x] T026 Update [walkthrough.md](./walkthrough.md) documenting changes and embedding verification reports

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - starts immediately.
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all User Stories.
- **User Stories (Phases 3-5)**: Depend on Foundational completion.
  - US1 (P1) is the MVP and can be implemented first.
  - US2 (P2) and US3 (P3) can proceed in parallel once the validation foundation is in place.
- **Polish (Phase 6)**: Depends on all User Story phases being completed.

### Parallel Opportunities

- C++ header setup (`T001`, `T002`) and TS type setup (`T003`) can run in parallel.
- Foundational bindings (`T004`, `T005`, `T006`) can run in parallel.
- Test suites for US1 (`T008`, `T009`) can be written in parallel.
- Reconstruct tests (`T015`) and DXF tests (`T020`) can be written in parallel by separate developers once the foundational tasks are done.

---

## Parallel Example: Setup & Foundation

```bash
# Register C++ shapes and TypeScript types in parallel:
Task: "Declare virtual signatures validateSheetMetal and reconstructCurvedBends in cpp/src/geometry/geometry_service.hpp"
Task: "Add TypeScript interfaces SheetMetalValidationResult, GapSewResult, and CurvedRebuildResult to ts/src/geometry/types.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases.
2. Complete Phase 3: User Story 1 (thickness checking, connectivity graph cycle/T-junction checks).
3. **STOP and VALIDATE**: Run `ts/tests/integration/unfold.integration.test.ts` to verify exact flat blank computations.

### Incremental Delivery

1. Setup + Foundation complete $\rightarrow$ Bridge ready.
2. Add US1 $\rightarrow$ Validation and precise flattening functional (**MVP**).
3. Add US2 $\rightarrow$ Auto-sewing and sharp-to-curved fillet reconstruction functional.
4. Add US3 $\rightarrow$ Layered DXF output functional.
