---
description: "Task list for accurate coordinate mapping & graph mutation model"
---

# Tasks: Accurate Coordinate Mapping & Graph Mutation Model

**Input**: Design documents from `specs/012-accurate-coord-mapping/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [data-model.md](data-model.md), [research.md](research.md), [contracts/mcp-tools.md](contracts/mcp-tools.md)

**Organization**: Tasks are grouped by user story. US4 and US3 (P2 spec priority) are implemented before US1/US2 (P1) because they are technical prerequisites — the correct panel frame type and append-mode graph structure must exist before accurate coordinate mapping can be wired up.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files or independent concerns)
- **[Story]**: Which user story this task serves (US1–US4 maps to spec.md)

---

## Phase 1: Setup

No new project scaffolding is required — all target files already exist. This phase is intentionally empty; implementation begins at the foundational phase.

---

## Phase 2: Foundational — Type Model & Delete the Fallback

**Purpose**: Establish the new data model and remove the error-hiding fallback. All graph-creation call sites will fail to compile after T003, which forces Phases 3 onward to fix them. This phase blocks all user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T001 Add `dxfPlacement: Placement2D` (required field) to `PanelNode` interface, importing `Placement2D` from `../dxf/merge` in [ts/src/manufacturing/graph/types.ts](ts/src/manufacturing/graph/types.ts)
- [X] T002 Add `bendZoneDxfX: number` (required field) to `BendNode` interface in [ts/src/manufacturing/graph/types.ts](ts/src/manufacturing/graph/types.ts)
- [X] T003 Delete `derivePanelFrameFromBbox` function (lines ~2034–2076) from [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts) — this will create 5 compile errors that Phases 3–4 resolve
- [X] T004 Add `GE_PANEL_FRAME_FAILED` structured error code `{ code, message, recoverable: false, suggestedTool: "clean_geometry" }` to the error registry in [ts/src/mcp/errors.ts](ts/src/mcp/errors.ts)

**Checkpoint**: `npm run build` in `ts/` will now fail with exactly 5 type errors at the `derivePanelFrameFromBbox` call sites. These are intentional forcing errors.

---

## Phase 3: User Story 4 — Panel Frames from Actual Geometry (Priority: P2)

**Goal**: Every PanelNode created by any graph-creation path (split, bootstrap, unfold) uses an OCCT-derived face frame, never a bounding-box estimate. Compile errors from Phase 2 are resolved here.

**Independent Test**: Bootstrap a shell, call `map_3d_to_2d` — the returned panelFrame normal must be perpendicular to the panel face (within 0.1°), not world-axis-aligned.

- [X] T005 [US4] Write module-private `computeDxfAlignedFrame(shellId: string, isRotated: boolean): PanelFrame` in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts): call `getGeometryBinding().getPanelFrame(shellId)`; if `isRotated=true` swap/negate axes and shift origin per data-model.md §computeDxfAlignedFrame; throw `GE_PANEL_FRAME_FAILED` on exception; do NOT export
- [X] T006 [US4] Fix `handleBootstrapGraph` (~line 1864): replace `derivePanelFrameFromBbox(bbox)` with `computeDxfAlignedFrame(shellId, false)` and populate `dxfPlacement: { rotationMatrix: [[1,0],[0,1]], translation: [0,0] }` on each PanelNode in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T007 [US4] Fix `handleSplitBodyByBends` (~line 5014): replace `derivePanelFrameFromBbox` with `computeDxfAlignedFrame(panelId, false)` and populate identity `dxfPlacement` on each split PanelNode; remove bbox fallback block in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T008 [US4] Fix `handleApplyUnfold` panel node (~line 5014): replace `derivePanelFrameFromBbox` with `computeDxfAlignedFrame(shellId, false)`; propagate `GE_PANEL_FRAME_FAILED` on no planar face in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T009 [US4] Fix `handleApplyUnfold` protrusion node (~line 5114): replace `derivePanelFrameFromBbox` with `computeDxfAlignedFrame(shellId, false)` in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T010 [US4] Fix inline bbox fallback in merge handler (~line 3544): replace with `computeDxfAlignedFrame(shellId, foldAlongU_A)` using the already-computed `foldAlongU_A` boolean in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T011 [US4] Fix inline bbox fallback in unfold path (~line 3754): replace with `computeDxfAlignedFrame(shellId, false)` in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T012 [US4] Build verify: run `npm run build` in `ts/` — must produce zero TypeScript errors; run existing split/bootstrap integration tests to confirm no regressions

**Checkpoint**: `npm run build` passes. All five `derivePanelFrameFromBbox` call sites are gone. Existing split tests pass.

---

## Phase 4: User Story 3 — Graph Integrity Preserved Across Mutations (Priority: P2)

**Goal**: `merge_bodies_with_bend` extends the existing manufacturing graph (append-mode) rather than discarding and rebuilding it. After two sequential merges of panels A+B+C, the graph contains three PanelNodes and two BendNodes.

**Independent Test**: Split a part into two panels, merge them (A+B), then merge the result with a third (AB+C). Query the graph — it must contain 3 PanelNodes and 2 BendNodes. No node from the first merge is missing.

- [X] T013 [US3] Refactor graph construction in `handleMergeBodiesWithBend` (~lines 3912–3998) to append-mode: if `_parts.has(partAId)` with existing BendNodes, reuse the graph (do NOT call `createPart`); mark current canonical PanelNode(s) `canonical=false`; add new BendNode with `bendZoneDxfX = currentMergedFlatWidth`; add Panel B with `canonical=true`, correct `dxfPlacement` translation, and `computeDxfAlignedFrame(shellBId, foldAlongU_B)`; add alias node for `partBId` in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T014 [US3] Backwards-compat: for the first merge of a pristine split (Panel A has no existing BendNodes), ensure Panel A's PanelNode receives `dxfPlacement = identity` if not already set in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)
- [X] T015 [US3] Rollback path: before any mutation in `handleMergeBodiesWithBend`, snapshot the full set of existing node IDs from `partAId`'s graph; on C++ failure, restore all nodes to pre-mutation state in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)

**Checkpoint**: Run `merge_orientation_preserved` and `merge_edge_alignment` integration tests — both must pass. The graph after a double merge contains 3 PanelNodes.

---

## Phase 5: User Stories 1 & 2 — Accurate Bidirectional Coordinate Mapping (Priority: P1)

**Goal**: `map_3d_to_2d` correctly maps any 3D point on any panel (including Panel B and Panel C of a multi-bend assembly) to its master flat DXF coordinate. `map_2d_to_3d` correctly inverts the per-panel `dxfPlacement` to reconstruct the 3D position. Round-trip error ≤ 0.1 mm.

**Independent Test (US1)**: Call `map_3d_to_2d` with a known corner of a 45°-tilted panel — returned `xy` must be within 0.1 mm of the geometrically correct flat-pattern corner.

**Independent Test (US2)**: On a merged two-panel assembly, call `map_2d_to_3d` with a flat coordinate in Panel B's DXF region — returned 3D point must lie on Panel B's face within 0.1 mm.

- [X] T016 [P] [US1] [US2] Add `transpose2x2` and `matMul2x2Vec` as module-private pure helper functions in [ts/src/geometry/coordinate-map.ts](ts/src/geometry/coordinate-map.ts)
- [X] T017 [US1] Rewrite `map3dTo2d`: iterate ALL PanelNodes (not only canonical); project `point3d` onto each `panelFrame`; if `|height| ≤ 0.1 mm` and `(u_local, v_local)` in panel bounds, apply `dxfPlacement` to get master flat coord and return in [ts/src/geometry/coordinate-map.ts](ts/src/geometry/coordinate-map.ts)
- [X] T018 [US2] Rewrite `map2dTo3d`: for each PanelNode, invert `dxfPlacement` (transpose rotation + negate-then-rotate translation) to get panel-local coord; if local coord in bounds, reconstruct 3D via `origin + u_local*u + v_local*v` in [ts/src/geometry/coordinate-map.ts](ts/src/geometry/coordinate-map.ts)
- [X] T019 [US1] [US2] Remove `canonical === false` filter from both mapping functions (currently at coordinate-map.ts ~line 159) in [ts/src/geometry/coordinate-map.ts](ts/src/geometry/coordinate-map.ts)
- [X] T020 [US2] Make `panel_id` optional in the `map_2d_to_3d` tool handler: when omitted, use region lookup via `dxfPlacement`-transformed bounds; when provided, skip to that panel directly in [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts)

**Checkpoint**: US1 and US2 are both independently testable at this point. `map_3d_to_2d` and `map_2d_to_3d` produce round-trip results within 0.1 mm for single-panel and multi-panel assemblies.

---

## Phase 6: Tests & Verification

**Purpose**: Verify all four user stories. Static analysis confirms the fallback is gone.

- [X] T021 [P] Extend [ts/tests/unit/coordinate-map.unit.test.ts](ts/tests/unit/coordinate-map.unit.test.ts): add test for Panel B master-flat coordinate (non-zero translation in `dxfPlacement`); add test for `map2dTo3d` with non-identity rotation matrix; add 3-panel chain round-trip test (all three regions ≤ 0.1 mm)
- [X] T022 [P] Create [ts/tests/integration/coordinate_mapping_multibend.integration.test.ts](ts/tests/integration/coordinate_mapping_multibend.integration.test.ts): split a bracket, merge A+B, call `map_3d_to_2d` with a Panel B corner, verify `xy.x > effectiveAFlatWidth + ba`; call `map_2d_to_3d` with that coordinate, verify 3D round-trip ≤ 0.1 mm
- [X] T023 [P] Update [ts/tests/contracts/coordinate-map.contract.test.ts](ts/tests/contracts/coordinate-map.contract.test.ts): add assertion that `GE_PANEL_FRAME_FAILED` is present in the error code registry with `recoverable: false`
- [X] T024 Static verify: run `grep -r "derivePanelFrameFromBbox" ts/src/` — must return zero results; fail the task if any match is found
- [X] T025 Full test suite: run `npm test` in `ts/` — all currently-passing tests must still pass; document any pre-existing failures as known baseline

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — start immediately
- **US4 (Phase 3)**: Depends on Foundational (T001–T004 must be complete) — fixes the 5 compile errors
- **US3 (Phase 4)**: Depends on US4 (T005 must be complete to call `computeDxfAlignedFrame` in merge) — append-mode graph needs accurate frames
- **US1+US2 (Phase 5)**: Depends on US3 (T013 must be complete — nodes need `dxfPlacement`) and US4 (T005 for accurate frames)
- **Tests (Phase 6)**: Depends on US1+US2 (Phase 5) completion

### Within Each Phase

- T001 and T002 can run in parallel (different sections of the same file, non-conflicting)
- T003 and T004 can run in parallel
- T006–T011 can run in parallel after T005 (each fixes a different call site in tools.ts, but they're independent edits)
- T016 can run in parallel with T013–T015 (different file)
- T021, T022, T023 can run in parallel (different test files)

### Parallel Opportunities

```text
# Phase 2: run together
T001 (types.ts: PanelNode field)
T002 (types.ts: BendNode field)

# Phase 2: after T001/T002
T003 (delete derivePanelFrameFromBbox)
T004 (add error code)

# Phase 3: after T005
T006 (bootstrap call site)
T007 (split call site)
T008 (unfold panel call site)
T009 (unfold protrusion call site)
T010 (merge inline call site)
T011 (unfold path inline call site)

# Phase 6: all in parallel
T021 (unit test extensions)
T022 (new integration test)
T023 (contract test update)
```

---

## Implementation Strategy

### MVP: US1 + US2 (Accurate Mapping)

1. Complete Phase 2: Foundational (T001–T004)
2. Complete Phase 3: US4 (T005–T012) — accurate frames everywhere
3. Complete Phase 4: US3 (T013–T015) — append-mode graph (needed for multi-panel mapping)
4. Complete Phase 5: US1+US2 (T016–T020) — rewrite coordinate mapping
5. **STOP and VALIDATE**: Test round-trip coordinate mapping with a two-panel assembly

### Full Delivery

5. Complete Phase 6: Tests (T021–T025) — full verification and static checks

### Incremental Notes

- After T012 (end of Phase 3): all single-panel frame derivation is correct; existing test suite must pass
- After T015 (end of Phase 4): multi-panel graph structure is correct; merge tests must pass
- After T020 (end of Phase 5): bidirectional mapping is correct for all assembly sizes
- T024 and T025 are verification gates, not implementation — run them last

---

## Notes

- [P] tasks = independent files or non-conflicting edits, can be executed concurrently
- US4 and US3 are listed before US1/US2 despite lower spec priority because they are technical prerequisites
- `computeDxfAlignedFrame` (T005) must NOT be exported — enforced at compile time
- T003 is intentionally destructive: deleting `derivePanelFrameFromBbox` causes compile errors that force all call sites to be fixed
- T024 is a static analysis gate — fail the sprint if it finds any matches
- Commit after each checkpoint (T012, T015, T020, T025)
