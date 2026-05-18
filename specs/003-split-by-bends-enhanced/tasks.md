# Tasks: Smart Panel Decomposition for split_body_by_bends

**Input**: Design documents from `specs/003-split-by-bends-enhanced/`

**Prerequisites**: plan.md ✓, spec.md ✓

**Organization**: Four phases matching the agreed implementation order. Each phase is
independently buildable and testable before the next begins.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks in same phase)
- **[Story]**: US1–US4 from spec.md

---

## Phase 1: Mode Detection + Mode 2 Basic (Thin-Solid Cutting)

**Goal**: A hollow cube (thin-walled solid) decomposes into solid panels using cutting planes.
Validates the core cutting approach before adding extrusion, protrusions, or recursion.

**Independent Test**: Load a hollow cube STEP fixture → call `split_body_by_bends` →
verify 6 panel IDs returned, each has non-zero volume, total volume = original volume.

### C++ Layer

- [X] T001 Update `DecomposedByBendsResult` struct in `cpp/src/geometry/geometry_service.hpp`: replace `shellIds: vector<ShellId>` with `panelIds: vector<ShellId>` and `protrusionIds: vector<ShellId>`; add `detectedMode: string`
- [X] T002 Add 4 new error code strings to `cpp/src/geometry/geometry_service.hpp` constants: `GE_DECOMPOSE_THICKNESS_MISMATCH`, `GE_DECOMPOSE_EXTRUDE_FAILED`, `GE_DECOMPOSE_CUT_FAILED`, `GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED`
- [X] T003 Add `detectObjectMode(shape, maxThicknessMm)` static helper in `cpp/src/geometry/geometry_service.cc`: compute volume via `BRepGProp::VolumeProperties`; if volume < 1e-6 return "surface"; otherwise pair faces with anti-parallel normals (dot product < -0.95) and measure face-to-face distance via `BRepExtrema_DistShapeShape`; return "thin_solid" if min distance ≤ maxThicknessMm, else "surface"
- [X] T004 Add `findPrimaryPanelGroups(shape, angleThresholdDeg)` static helper in `cpp/src/geometry/geometry_service.cc`: extract outer faces via `TopExp::MapShapes(shape, TopAbs_FACE)`; BFS-group coplanar faces using existing dihedral-angle logic from current `splitBodyByBends`; return vector of `{faceIndices, plane, outwardNormal, area}`
- [X] T005 Add `findInnerFacePlane(group, shape, maxThicknessMm)` static helper in `cpp/src/geometry/geometry_service.cc`: for each face in the group, cast a ray from its centroid in direction `-N` using `IntCurvesFace_ShapeIntersector`; record the nearest hit face and distance; return the plane of the inner face (the face at min distance ≤ maxThicknessMm)
- [X] T006 [US1] Replace the Mode 2 body in `splitBodyByBends` in `cpp/src/geometry/geometry_service.cc`: call `detectObjectMode`; if "thin_solid" → call `findPrimaryPanelGroups` then for each group call `findInnerFacePlane` to get the inner-face cutting plane; use `BRepPrimAPI_MakeHalfSpace` on inner-face plane and outer-face plane to define panel slab; extract slab via `BRepAlgoAPI_Common(solid, slab_half_space)`; subtract from remainder via `BRepAlgoAPI_Cut`; register each panel solid as new ShellId in `shells_`; populate `panelIds`; set `protrusionIds` to empty; set `detectedMode`; keep existing snapshot-first logic

### C++ NAPI Layer

- [X] T007 [US1] Update `SplitBodyByBends` NAPI function in `cpp/src/napi/geometry_binding.cc`: deserialize two new optional number args `maxThicknessMm` (default 5.0) and `defaultThicknessMm` (default 1.0) after the existing `angleThreshold` arg; update result serialization to map `panelIds` → JS array `panel_ids`, `protrusionIds` → `protrusion_ids`, `detectedMode` → `detected_mode`; remove old `shellIds` mapping

### TypeScript Layer

- [X] T008 [P] [US1] Add 4 new error code constants to `ts/src/mcp/errors.ts`: `GE_DECOMPOSE_THICKNESS_MISMATCH`, `GE_DECOMPOSE_EXTRUDE_FAILED`, `GE_DECOMPOSE_CUT_FAILED`, `GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED`
- [X] T009 [P] [US1] Update `splitBodyByBends` signature in `GeometryAddon` interface in `ts/src/geometry/binding.ts`: add optional `maxThicknessMm?: number` and `defaultThicknessMm?: number` params; update return type from `{ shellIds: string[]; rollbackToken: string }` to `{ panelIds: string[]; protrusionIds: string[]; rollbackToken: string; detectedMode: string }`
- [X] T010 [US1] Update `GeometryBinding.splitBodyByBends` wrapper method in `ts/src/geometry/binding.ts` to match updated signature from T009
- [X] T011 [US1] Update `split_body_by_bends` tool definition in `getToolDefinitions()` in `ts/src/mcp/tools.ts`: add `max_thickness_mm` (number, default 5.0, description "Wall thickness above this treats the solid as a conceptual model") and `default_thickness_mm` (number, default 1.0, description "Panel thickness applied in surface/conceptual mode") to inputSchema; add `max_recursion_depth` (integer, default 0, minimum 0, maximum 10) to inputSchema
- [X] T012 [US1] Update `handleSplitBodyByBends` in `ts/src/mcp/tools.ts`: extract `max_thickness_mm`, `default_thickness_mm`, `max_recursion_depth` from args with defaults; call `getGeometryBinding().splitBodyByBends(partId, threshold, maxThicknessMm, defaultThicknessMm)`; register all `panelIds` AND `protrusionIds` in session; return `{ panel_ids, panel_count, protrusion_ids, protrusion_count, detected_mode, rollback_token, mesh_urls }` where `mesh_urls` covers both panels and protrusions
- [X] T013 [US1] Update `splitBodyByBends` mock in `ts/tests/integration/cube_box_workflow.functional.test.ts`: change mock return from `{ shellIds }` to `{ panelIds: ['panel-1',...,'panel-6'], protrusionIds: [], rollbackToken: 'tok', detectedMode: 'thin_solid' }`; update the `split_body_by_bends` test assertions to check `panel_ids`, `panel_count`, `protrusion_count: 0`, `detected_mode: 'thin_solid'`

**Checkpoint**: C++ builds cleanly. `split_body_by_bends` on a hollow-cube STEP fixture returns 6 panel IDs each with non-zero volume. Vitest suite passes.

---

## Phase 2: Mode 1 — Surface / Thick-Solid Extrusion

**Goal**: A zero-thickness surface cube decomposes into 6 solid panels using BFS + extrusion,
producing the same bounding-box positions as the Phase 1 hollow-cube result.

**Independent Test**: Pass `detectedMode: 'surface'` to mock → verify handler passes
`default_thickness_mm` through; separately verify C++ extrusion on surface STEP fixture.

### C++ Layer

- [X] T014 [US2] Implement Mode 1 body in `splitBodyByBends` in `cpp/src/geometry/geometry_service.cc`: when `detectedMode == "surface"`, call `findPrimaryPanelGroups`; for each group collect boundary edges (edges adjacent to only one face in the group) into a wire via `BRepBuilderAPI_MakeWire`; build face from wire via `BRepBuilderAPI_MakeFace`; extrude by `defaultThicknessMm` along outward normal via `BRepPrimAPI_MakePrism(face, extrusion_vector)`; throw `GE_DECOMPOSE_EXTRUDE_FAILED` if result is non-manifold; register each prism as new ShellId → `panelIds`

### TypeScript Layer

- [X] T015 [P] [US2] Update `splitBodyByBends` in `ts/src/geometry/binding.ts` to pass `maxThicknessMm` and `defaultThicknessMm` through to NAPI (no signature change needed if T009 already done)
- [X] T016 [US2] Add surface-mode test case to `ts/tests/integration/cube_box_workflow.functional.test.ts`: mock returns `detectedMode: 'surface'`, `panelIds` with 6 entries; assert handler includes `detected_mode: 'surface'` in response and all panel IDs are registered in session

**Checkpoint**: A surface-shell STEP fixture produces 6 panels with thickness equal to `default_thickness_mm`. Both mode paths produce equivalent bounding boxes.

---

## Phase 3: Protrusion Detection + Extraction

**Goal**: Before splitting, the algorithm detects thin localised features on panel faces and
returns them as separate `protrusion_ids` — they do not appear in `panel_ids`.

**Independent Test**: Pass a solid with known flanges → verify `protrusion_ids` is non-empty
and `panel_ids` contains only the clean panel shells.

### C++ Layer

- [X] T017 [US3] Add `detectProtrusions(shape, primaryGroups, maxThicknessMm)` static helper in `cpp/src/geometry/geometry_service.cc`: for each primary panel group G, find adjacent non-primary faces via `TopExp::MapShapesAndAncestors`; for each adjacent face region apply extent test (attachment edge total length / G.perimeter < 0.50) AND orientation test (cap face normal dot G.normal > 0.85) AND thickness test (cross-section width ≤ maxThicknessMm); collect connected regions passing all three tests as protrusion candidates; return list of `{faceSet, attachmentEdges}` per protrusion
- [X] T018 [US3] Add `extractProtrusion(solid, protrusion, panelPlane)` static helper in `cpp/src/geometry/geometry_service.cc`: cut the protrusion volume from the solid by applying `BRepAlgoAPI_Cut` with a half-space defined by the primary panel face plane; throw `GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED` if result is degenerate; register the protrusion solid as new ShellId; register the trimmed solid (solid minus protrusion) back to remainder
- [X] T019 [US3] Wire protrusion detection into `splitBodyByBends` in `cpp/src/geometry/geometry_service.cc`: call `detectProtrusions` after mode detection and before panel cutting; call `extractProtrusion` for each detected protrusion; update `protrusionIds` with registered IDs; pass the protrusion-free remainder to the panel-cutting step

### TypeScript Layer

- [X] T020 [US3] Add protrusion test to `ts/tests/integration/cube_box_workflow.functional.test.ts`: configure mock to return `protrusionIds: ['flange-1', 'flange-2']`; assert `protrusion_ids` in response equals `['flange-1', 'flange-2']`, `protrusion_count == 2`, and both IDs are registered in session

**Checkpoint**: A solid with two flanges returns `protrusion_count: 2` and the panel volumes sum correctly (flanges excluded). Vitest suite passes.

---

## Phase 4: Recursive Decomposition

**Goal**: When `max_recursion_depth > 0`, the algorithm recursively decomposes the remainder
solid after each pass, accumulating panels and protrusions from all layers.

**Independent Test**: Mock returns two levels of panels; verify handler returns combined flat
list of all panel IDs across both levels.

### C++ Layer

- [X] T021 Add `max_recursion_depth` parameter to `splitBodyByBends` method signature in `cpp/src/geometry/geometry_service.hpp` (int, default 0)
- [X] T022 [US4] Add recursion wrapper to `splitBodyByBends` in `cpp/src/geometry/geometry_service.cc`: after extracting protrusions and cutting panels from the solid, check if `maxRecursionDepth > 0` AND remainder volume > 1.0 mm³ AND remainder has detectable bends; if so extract connected components of remainder via `BRepTools` sub-shape iteration; call `splitBodyByBends` recursively on each component with `maxRecursionDepth - 1`; accumulate child `panelIds` and `protrusionIds` into parent result; terminate early if no primary panel groups found in component (single flat panel or blob)
- [X] T023 [US4] Update `SplitBodyByBends` NAPI in `cpp/src/napi/geometry_binding.cc`: deserialize optional `maxRecursionDepth` integer arg (default 0, maximum 10); pass to `svc().splitBodyByBends()`

### TypeScript Layer

- [X] T024 [P] [US4] Confirm `max_recursion_depth` is already in the tool definition inputSchema (added in T011); no additional tool definition change needed
- [X] T025 [US4] Update `handleSplitBodyByBends` in `ts/src/mcp/tools.ts`: extract `max_recursion_depth` integer from args (default 0, clamp to 0–10); pass to `getGeometryBinding().splitBodyByBends()` call
- [X] T026 [US4] Update `GeometryAddon` interface and `GeometryBinding.splitBodyByBends` in `ts/src/geometry/binding.ts` to add `maxRecursionDepth?: number` parameter
- [X] T027 [US4] Add recursion test to `ts/tests/integration/cube_box_workflow.functional.test.ts`: configure mock to return 12 panel IDs + 8 protrusion IDs when called with `max_recursion_depth >= 3`; assert response has `panel_count: 12`, `protrusion_count: 8`; assert all 20 IDs are registered in session

**Checkpoint**: Nested two-cube fixture with `max_recursion_depth: 5` returns 12 panels + 8 protrusions in one call. `max_recursion_depth: 0` still returns only 6 outer panels (backward compatible). Vitest suite passes.

---

## Dependencies & Execution Order

```
Phase 1 (Mode 2 basic)
  T001 → T002 → T003 → T004 → T005 → T006   [C++ sequential, same file]
  T007                                          [NAPI, depends on T006]
  T008 [P], T009 [P]                            [TS, parallel with C++ Phase 1]
  T010 → T011 → T012                            [TS sequential, same file, after T009]
  T013                                          [tests, after T012]

Phase 2 (Mode 1 extrude) — after Phase 1 checkpoint
  T014                                          [C++, extends T006 branch]
  T015 [P], T016                                [TS, after T014]

Phase 3 (Protrusions) — after Phase 2 checkpoint
  T017 → T018 → T019                            [C++ sequential]
  T020                                          [TS tests, after T019]

Phase 4 (Recursion) — after Phase 3 checkpoint
  T021 → T022 → T023                            [C++ sequential]
  T024 [P], T025, T026, T027                    [TS, T025/T026 sequential after T024]
```
