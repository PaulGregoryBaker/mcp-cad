---
description: "Tasks for 011-graph-driven-geometry feature"
---

# Tasks: Graph-Driven Geometry Pipeline (Bug Fixes & Coordinate Mapping)

**Input**: Design documents from `/specs/011-graph-driven-geometry/`

**Feature Branch**: `011-graph-driven-geometry`

**Prerequisites**: [plan.md](plan.md) | [spec.md](spec.md) | [data-model.md](data-model.md) | [research.md](research.md)

**Summary**: Fix three known bugs (BUG-01: split does not rebuild 3D geometry; BUG-02: split forces non-rectangular panels to bounding boxes; BUG-03: merge fails on offset edges) and add bidirectional 3D-to-2D coordinate mapping.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Parallelizable (no dependency on an incomplete task)
- **[Story]**: US1 = Split pipeline compliance, US2 = Merge edge alignment, US3 = Coordinate mapping, US4 = Enforcement

---

## Phase 1: Setup & Investigation

**Purpose**: Confirm root causes and establish test baselines before touching production code.

- [X] T001 Trace `handleSplitBodyByBends` in ts/src/mcp/tools.ts to confirm it never calls the solver pipeline after creating the manufacturing graph (root cause for BUG-01)
- [X] T002 [P] Trace where `shapeDxf` is written for each split panel in ts/src/manufacturing/graph/solver.ts and ts/src/mcp/tools.ts; confirm bounding-box vs true boundary extraction (root cause for BUG-02)
- [X] T003 [P] Trace `handleMergeBodiesWithBend` in ts/src/mcp/tools.ts to identify where edge position is assumed co-located with no offset measurement (root cause for BUG-03)
- [X] T004 [P] Inspect ts/src/geometry/binding.ts and cpp/src/napi/geometry_binding.cc for any existing `getFaceTransform` or placement API (answers OPEN-01 for coordinate mapping)
- [X] T005 Write a failing integration test that confirms BUG-01: execute `split_body_by_bends` on a fixture part and assert that the returned shell ID differs from the pre-split shell in ts/tests/integration/split_pipeline_compliance.integration.test.ts
- [X] T006 [P] Write a failing integration test that confirms BUG-02: execute `split_body_by_bends` on a non-rectangular panel fixture and assert the `shapeDxf` LWPOLYLINE has more than 4 vertices in ts/tests/integration/split_pipeline_compliance.integration.test.ts
- [X] T007 [P] Write a failing integration test that confirms BUG-03: call `merge_bodies_with_bend` on two offset (0.5 mm gap) panels and assert that a structured `GE_MERGE_EDGE_MISALIGNED` error is returned in ts/tests/integration/merge_edge_alignment.integration.test.ts

**Checkpoint**: Root causes confirmed; three failing regression tests establish the baseline

---

## Phase 2: Foundational (Blocking Prerequisites for All Bug Fixes)

**Purpose**: Infrastructure shared across all three bug fixes. Must complete before user story implementation.

- [X] T008 Add named constants `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM = 2` and `COORD_MAP_ACCURACY_THRESHOLD_MM = 0.1` as module-scope exports in ts/src/mcp/tools.ts (Constitution §VIII)
- [X] T009 [P] Add structured error code `GE_MERGE_EDGE_MISALIGNED` to ts/src/mcp/tools.ts error codes registry with fields: `measuredOffsetMm`, `thresholdMm`, `panelAId`, `panelBId`
- [X] T010 [P] Add structured error code `GE_POINT_NOT_ON_PANEL` to ts/src/mcp/tools.ts error codes registry with fields: `nearestPanelId`, `distanceMm`
- [X] T011 [P] Verify TypeScript build passes with no errors after constant and error code additions: run `npm run build` in ts/ and confirm exit code 0

**Checkpoint**: Constants and error codes in place; build clean — US1, US2, US3 implementation can proceed in parallel

---

## Phase 3: User Story 1 — Split-by-Bends Rebuilds 3D Geometry (Priority: P1)

**Goal**: `split_body_by_bends` creates manufacturing graphs AND rebuilds 3D geometry from them via the geometric pipeline before returning.

**Independent Test**: Execute `split_body_by_bends` on any fixture part with a bend line; confirm returned geometry was produced by `buildSheetFromDxf → thickenSheet → applyBend`; confirm the test at T005 now passes.

### Implementation for User Story 1

- [X] T012 [US1] Fix BUG-01: In `handleSplitBodyByBends` in ts/src/mcp/tools.ts, after manufacturing graphs are created for each sub-part, call `getGeometrySolver().execute(reconstructionPlan)` (or equivalent solver path) for each new part to rebuild 3D geometry before returning the result
- [X] T013 [US1] Fix BUG-02: In ts/src/manufacturing/graph/solver.ts `dispatchNode`, replace bounding-box rectangle generation with OCCT face boundary wire extraction; produce a LWPOLYLINE with the true N-vertex polygon boundary (not 4-corner rectangle) and write it to `panel.shapeDxf`
- [X] T014 [US1] If `buildSheetFromDxf` in C++ only handles 4-vertex rectangles: extend the LWPOLYLINE parser in cpp/src/geometry/geometry_service.cc to accept arbitrary N-vertex closed polylines; rebuild the NAPI addon
- [X] T015 [US1] Add `pipeline_executed: true` flag to `split_body_by_bends` result in ts/src/mcp/tools.ts so callers can verify the pipeline was invoked
- [X] T016 [US1] Verify the failing tests T005 and T006 now pass; verify existing split integration tests (11 tests in ts/tests/integration/split_by_bends.integration.test.ts) still pass

**Checkpoint**: BUG-01 and BUG-02 resolved; all 13 split-related tests green; split geometry is pipeline-derived

---

## Phase 4: User Story 2 — Merge-by-Bend Handles Edge Misalignment (Priority: P1)

**Goal**: `merge_bodies_with_bend` detects edge misalignment and either auto-corrects (≤ 2 mm) or returns a structured `GE_MERGE_EDGE_MISALIGNED` error with the measured offset.

**Independent Test**: Execute `merge_bodies_with_bend` on two parts with a 0.5 mm edge offset; confirm auto-correction succeeds and the result includes `edge_alignment_correction_mm: 0.5`. Test with a 3 mm offset; confirm `GE_MERGE_EDGE_MISALIGNED` error is returned with `measuredOffsetMm: 3.0`.

### Implementation for User Story 2

- [X] T017 [US2] In `handleMergeBodiesWithBend` in ts/src/mcp/tools.ts, before the DXF merge step, compute the minimum distance between the closest edges of `shellA` and `shellB` using `getGeometryBinding().computeGaps(shellAId, shellBId, MERGE_EDGE_ALIGNMENT_TOLERANCE_MM * 3)`
- [X] T018 [US2] If measured edge offset exceeds `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (2 mm): throw `GE_MERGE_EDGE_MISALIGNED` structured error with `measuredOffsetMm`, `thresholdMm`, `panelAId`, `panelBId`; do not mutate graph or call C++ geometry
- [X] T019 [US2] If measured edge offset is within tolerance (≤ 2 mm): auto-correct by projecting panel B's shared edge onto panel A using translation via `getGeometryBinding().closeGap(shellAId, shellBId)`; update `panelNodeB.bodyId` to the translated shell; log the correction in the result as `edge_alignment_correction_mm`
- [X] T020 [US2] Include `edge_alignment_correction_mm` (number or null) in the merge success response in ts/src/mcp/tools.ts
- [X] T021 [US2] Verify the failing test T007 now passes; verify existing merge integration tests (ts/tests/integration/merge_unfold_panel_selection_bug.test.ts, 3 tests) still pass

**Checkpoint**: BUG-03 resolved; merge handles 0-5 mm offsets; no silent failures

---

## Phase 5: User Story 3 — Bidirectional 3D-to-2D Coordinate Mapping (Priority: P1)

**Goal**: New `map_3d_to_2d` and `map_2d_to_3d` MCP tools providing bidirectional coordinate mapping between 3D world space and 2D DXF flat pattern.

**Independent Test**: For a fixture part, call `map_3d_to_2d` with the known 3D corner coordinates of a panel face; verify XY result is within 0.1 mm of expected DXF coordinate. Call `map_2d_to_3d` with that XY; verify 3D result is within 0.1 mm of the original 3D point.

### Implementation for User Story 3

- [X] T022 [US3] Create ts/src/geometry/coordinate-map.ts with `map3dTo2d(partId, point3d, parts, binding): CoordinateMapResult | CoordinateMapError` — computes panel face transform analytically from `PanelNode.panelFrame` (U/V axes + origin) and projects 3D point into 2D DXF space
- [X] T023 [P] [US3] Create `map2dTo3d(partId, panelId, point2d, parts, binding): { point3d: [number, number, number] } | CoordinateMapError` in ts/src/geometry/coordinate-map.ts — inverse mapping from 2D DXF coordinates back to 3D world space using panel frame
- [X] T024 [US3] Handle the case where a 3D point does not lie on any panel surface: return `GE_POINT_NOT_ON_PANEL` error with `nearestPanelId` and `distanceMm` in ts/src/geometry/coordinate-map.ts
- [X] T025 [US3] If OPEN-01 research (T004) shows face transforms unavailable via NAPI: add `getPanelFaceTransform(shellId)` binding in cpp/src/napi/geometry_binding.cc and register it in NAPI exports; update ts/src/geometry/binding.ts to expose it
- [X] T026 [US3] Register `map_3d_to_2d` tool definition in `getToolDefinitions()` in ts/src/mcp/tools.ts with input schema `{ part_id, point: [x, y, z] }`
- [X] T027 [P] [US3] Register `map_2d_to_3d` tool definition in `getToolDefinitions()` in ts/src/mcp/tools.ts with input schema `{ part_id, panel_id, point: [x, y] }`
- [X] T028 [US3] Implement `handleMapTo2D(args)` in ts/src/mcp/tools.ts: validate inputs, call `map3dTo2d()`, return `{ panel_id, xy, error_mm }` or structured error
- [X] T029 [P] [US3] Implement `handleMapTo3D(args)` in ts/src/mcp/tools.ts: validate inputs, call `map2dTo3d()`, return `{ point3d }` or structured error
- [X] T030 [US3] Wire `map_3d_to_2d` and `map_2d_to_3d` into `dispatchTool()` switch in ts/src/mcp/tools.ts
- [X] T031 [US3] Write round-trip accuracy unit tests in ts/tests/unit/geometry/coordinate-map.test.ts: verify ≤ 0.1 mm round-trip error for known panel corners; test `GE_POINT_NOT_ON_PANEL` error for off-panel points
- [X] T032 [US3] Write contract tests in ts/tests/contract/coordinate-map-contract.test.ts: verify error codes (`GE_POINT_NOT_ON_PANEL`) are correct; verify response shape matches spec

**Checkpoint**: Bidirectional coordinate mapping working; round-trip error ≤ 0.1 mm validated; tools registered and responding to MCP calls

---

## Phase 6: User Story 4 — Enforce Pipeline Compliance for All Supported Mutations (Priority: P2)

**Goal**: Audit and enforce that no supported mutation path on a manufacturing-graph part can return geometry without going through the pipeline. Depends on US1, US2, US3 being complete.

**Independent Test**: Invoke 10 sequential split/merge/bend-param mutations; query each result's `pipeline_executed` flag; confirm all are `true`. Attempt a non-split/merge C++ mutation on a graph-tracked part; confirm `GRAPH_INTEGRITY_ERROR` structured error is returned.

### Implementation for User Story 4

- [X] T033 [US4] Audit `handleSplitBodyByBends`, `handleMergeBodiesWithBend`, and `handleBootstrapGraph` in ts/src/mcp/tools.ts; confirm all paths that produce a manufacturing graph also invoke the solver pipeline; fix any remaining bypass paths
- [X] T034 [P] [US4] Verify the `findGraphOwner` guard in ts/src/mcp/tools.ts is applied in all raw C++ mutation handlers (`handleCutBodies`, `handleTrimBodyWithPlane`, `handleSplitBodyByPlane`, `handleOffsetFace`) to reject mutations on graph-tracked shells
- [X] T035 [US4] Write integration test in ts/tests/integration/split_pipeline_compliance.integration.test.ts for 10 sequential mutations; verify each produces a pipeline-executed result and that geometry is consistent with manufacturing graph after each
- [X] T036 [P] [US4] Update TypeScript build and run full test suite: `cd ts && npm run build && npm test`; all tests must pass (target: zero failures)

**Checkpoint**: Full pipeline compliance enforced; all mutations guarded; all tests green

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Regression safety, documentation cleanup, and final validation.

- [X] T037 Run full Vitest test suite and confirm all tests pass: `cd ts && npm test`
- [X] T038 [P] Run TypeScript type-check (strict mode): `cd ts && npx tsc --noEmit`; resolve any type errors introduced by new types (`CoordinateMapResult`, `CoordinateMapError`, `EdgeAlignmentCorrection`)
- [X] T039 [P] Verify C++ addon builds cleanly with any NAPI extensions added for T014 or T025: `cd cpp && cmake --build build --config Release`
- [X] T040 [P] Confirm the three known bugs (BUG-01, BUG-02, BUG-03) are covered by named regression tests that will catch recurrence (tests T005, T006, T007 all passing)
- [X] T041 [P] Delete or archive stale planning artifacts that were generated before the scope correction: remove ts/src/geometry/rebuild/ and ts/src/manufacturing/rules/ directories if they were created during earlier work (these were from the incorrect async-rebuild design)

**Checkpoint**: All 40 tasks complete; three bugs fixed; coordinate mapping working; no regressions ✅

---

## Dependencies

```
T001 → T012, T015
T002 → T013, T014
T003 → T017
T004 → T022, T023, T025
T005 → T016
T006 → T016
T007 → T021
T008, T009, T010, T011 → T012, T017, T022
T012 → T015, T016
T013, T014 → T015, T016
T015, T016 → T033
T017, T018, T019 → T020, T021
T020, T021 → T033
T022, T023 → T028, T029
T024 → T028, T029
T025 → T022, T023 (conditional: only if OPEN-01 requires NAPI extension)
T026, T027 → T030
T028, T029 → T030, T031, T032
T033, T034 → T035, T036
T036 → T037, T038
T037, T038, T039, T040 → T041
```

## Parallel Execution Examples

**Phase 1** (investigation, can run fully in parallel after branch setup):
- T001, T002, T003, T004 all in parallel (different code areas)
- T005, T006, T007 in parallel (different test files)

**Phase 3 + 4 + 5** (after Phase 2 completes, all three can start in parallel):
- US1 tasks (T012-T016) in one track
- US2 tasks (T017-T021) in second track
- US3 tasks (T022-T032) in third track

**Within US3** (after T022, T023 complete):
- T024, T025 can run in parallel
- T026, T027 can run in parallel
- T028, T029 can run in parallel (after T022, T023)
- T031, T032 can run in parallel (after T028, T029)

## Implementation Strategy

**MVP scope** (deliver in order):
1. **US1 (T012-T016)**: Fix the primary blocker — split must rebuild geometry. This is the most critical compliance gap.
2. **US2 (T017-T021)**: Fix merge edge alignment — enables correct merge after offset operations.
3. **US3 (T022-T032)**: Add coordinate mapping — new capability enabling interactive graph editing.
4. **US4 (T033-T036)**: System-wide enforcement — catches any remaining bypass paths.

**Do not start US4 until US1 and US2 are fully verified.** Auditing pipeline compliance before the bugs are fixed will produce misleading results.
