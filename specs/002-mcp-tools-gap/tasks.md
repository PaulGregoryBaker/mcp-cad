# Tasks: MCP Tools Gap Closure

**Input**: Design documents from `specs/002-mcp-tools-gap/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, quickstart.md ✓

**Organization**: Tasks grouped by user story. Each user story maps to an independently testable MCP tool group. No tests are generated (TDD not requested in spec); spec acceptance scenarios serve as manual verification criteria.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks in same phase)
- **[Story]**: Which user story this task belongs to (US1–US4)

---

## Phase 1: Setup

**Purpose**: No new project structure needed — extending existing files. The only setup is verifying the build system will compile new C++ methods.

- [X] T001 Verify `cpp/src/napi/addon.cc` build compiles with one new stub method added to `geometry_service.hpp` — confirms the NAPI build chain is healthy before adding all 9 new methods

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types and error codes required by every user story. Must be complete before any user story phase begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Add `CuttingPlane` struct (`normalX/Y/Z`, `originX/Y/Z` doubles) to `cpp/src/geometry/geometry_service.hpp` immediately before the `GeometryService` class declaration
- [X] T003 [P] Add `CuttingPlane` interface (`normal: {x,y,z}`, `origin: {x,y,z}`) to `ts/src/geometry/types.ts`
- [X] T004 Register 12 new error code constants in `ts/src/mcp/errors.ts`: `GE_CLASH_DETECTION_FAILED`, `GE_GAP_DETECTION_FAILED`, `GE_TRIM_FAILED`, `GE_SPLIT_FAILED`, `GE_EXTEND_FAILED`, `GE_OFFSET_FAILED`, `GE_FLANGE_FAILED`, `GE_EDGE_NOT_OPEN`, `GE_RIP_FAILED`, `GE_EDGE_NOT_INTERIOR`, `GE_MERGE_FAILED`, `MD_LOGISTICS_NOT_CONFIGURED`
- [X] T005 [P] Add the 12 new error codes from T004 to the error code table in `Engineering-Design.md §3.4` with meaning and recoverability columns matching `research.md §3`

**Checkpoint**: `CuttingPlane` exists in both C++ and TypeScript; all 12 error codes are registered and documented.

---

## Phase 3: User Story 1 — Direct Modeling: Clash/Gap Resolution (Priority: P1) 🎯 MVP

**Goal**: AI agent can detect clashes and gaps between panels and resolve them via trim, extend, and offset. Five tools delivered in two sub-increments.

**Independent Test**: Load a STEP file with two intersecting panels → call `compute_intersections` → call `trim_body_with_plane` with the suggested cutting plane → confirm no clash in second `compute_intersections` call. Separately, load panels with a 4.2 mm gap → call `compute_gaps` → call `extend_face_to_target` → confirm gap closes.

### Sub-increment A: Phase D Extension

**Tools**: `compute_intersections`, `compute_gaps`, `trim_body_with_plane`

#### C++ Layer — geometry_service.hpp / geometry_service.cc

- [X] T006 Add result structs `ClashPair` and `ClashReport` to `cpp/src/geometry/geometry_service.hpp` (per `data-model.md` definitions: `intersects` bool, `clashes` vector with volume, bounding box, suggested cutting plane)
- [X] T007 [P] Add result struct `GapReport` to `cpp/src/geometry/geometry_service.hpp` (per `data-model.md`: `hasGap`, `minimumDistanceMm`, closest face IDs, extension vector, bounding box)
- [X] T008 [P] Add result struct `TrimBodyResult` to `cpp/src/geometry/geometry_service.hpp` (`trimmedShellId`, `rollbackToken`)
- [X] T009 Add three virtual method declarations to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`: `computeIntersections(partIds)`, `computeGaps(partAId, partBId, maxDistMm)`, `trimBodyWithPlane(partId, plane, keepPositiveSide)` — use signatures from `contracts/geometry-port-extended.md`
- [X] T010 [US1] Implement `computeIntersections` in `cpp/src/geometry/geometry_service.cc`: for each pair in `partIds`, call `BRepAlgoAPI_Common`; if result is non-empty compute volume via `GProp_GProps` and bounding box via `Bnd_Box`; derive suggested cutting plane from clash centroid; wrap in `TRY_GEOMETRY`
- [X] T011 [US1] Implement `computeGaps` in `cpp/src/geometry/geometry_service.cc`: call `BRep_DistShapeShape` on the two shell shapes; extract minimum distance and closest sub-shape face IDs; compute extension vector from closest point pair; wrap in `TRY_GEOMETRY`
- [X] T012 [US1] Implement `trimBodyWithPlane` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot` first; build a half-space solid with `BRepPrimAPI_MakeHalfSpace` on the requested keep side; apply `BRepAlgoAPI_Cut` to remove the unwanted half; register resulting shell; wrap in `TRY_GEOMETRY`

#### C++ NAPI Layer — geometry_binding.cc

- [X] T013 [US1] Add `ComputeIntersections` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize JS array of strings → call `svc().computeIntersections()` → serialize `ClashReport` to Napi::Object (including nested clashes array with bounding box and cutting plane objects)
- [X] T014 [US1] Add `ComputeGaps` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize three JS args → call `svc().computeGaps()` → serialize `GapReport` to Napi::Object
- [X] T015 [US1] Add `TrimBodyWithPlane` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partId, normal object, origin object, keepPositiveSide bool → call `svc().trimBodyWithPlane()` → serialize `TrimBodyResult`
- [X] T016 [US1] Register `computeIntersections`, `computeGaps`, `trimBodyWithPlane` in `RegisterGeometryMethods` at the bottom of `cpp/src/napi/geometry_binding.cc` using the same `exports.Set(...)` pattern as existing methods

#### TypeScript Layer — types.ts / binding.ts / tools.ts

- [X] T017 [P] [US1] Add `ClashReport`, `ClashPair`, `GapReport`, `TrimBodyResult` interfaces to `ts/src/geometry/types.ts` matching definitions in `data-model.md` — include nested bounding box and cutting plane objects
- [X] T018 [P] [US1] Add `computeIntersections(partIds: string[]): ClashReport`, `computeGaps(partAId, partBId, maxDist): GapReport`, and `trimBodyWithPlane(partId, normal, origin, keepPositive): TrimBodyResult` entries to the `GeometryAddon` interface in `ts/src/geometry/binding.ts`
- [X] T019 [US1] Add `computeIntersections`, `computeGaps`, `trimBodyWithPlane` wrapper methods to `GeometryBinding` class in `ts/src/geometry/binding.ts` — each wraps the addon call in a `try/catch` that calls `toStructuredError(err)`
- [X] T020 [P] [US1] Add `compute_intersections` tool definition object to `getToolDefinitions()` array in `ts/src/mcp/tools.ts` — inputSchema: `{ part_ids: string[] (minItems: 2) }` per `contracts/mcp-tools-extended.md`
- [X] T021 [P] [US1] Add `compute_gaps` tool definition object to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: `{ part_a_id, part_b_id, max_distance_threshold: number }` per contract
- [X] T022 [P] [US1] Add `trim_body_with_plane` tool definition object to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: `{ part_id, cutting_plane: {normal,origin}, keep_side: enum }` per contract
- [X] T023 [US1] Add `handleComputeIntersections(args)` function to `ts/src/mcp/tools.ts`: validate `part_ids` array (min 2), call `getGeometryBinding().computeIntersections(partIds)`, serialize `ClashReport` to MCP output format
- [X] T024 [US1] Add `handleComputeGaps(args)` function to `ts/src/mcp/tools.ts`: validate all three args, call `getGeometryBinding().computeGaps(...)`, serialize `GapReport` to MCP output format
- [X] T025 [US1] Add `handleTrimBodyWithPlane(args)` function to `ts/src/mcp/tools.ts`: validate partId, cutting_plane object, keep_side enum; call `getGeometryBinding().trimBodyWithPlane(...)`; return `trimmed_shell_id` and `rollback_token`
- [X] T026 [US1] Add `case 'compute_intersections'`, `case 'compute_gaps'`, `case 'trim_body_with_plane'` to the `dispatchTool` switch in `ts/src/mcp/tools.ts`

**Checkpoint A**: `compute_intersections`, `compute_gaps`, and `trim_body_with_plane` are callable from MCP and return structured responses. The clash-detection and gap-detection acceptance scenarios from spec.md §US1 pass.

### Sub-increment B: MVP scope (gate removed 2026-05-17)

**Tools**: `extend_face_to_target`, `offset_face`

#### C++ Layer

- [X] T027 [US1] Add result structs `ExtendFaceResult` (`modifiedShellId`, `extensionDistanceMm`, `rollbackToken`) and `OffsetFaceResult` (`modifiedShellId`, `rollbackToken`) to `cpp/src/geometry/geometry_service.hpp`
- [X] T028 [P] [US1] Add `extendFaceToTarget(partId, faceId, targetType, targetPartId, targetFaceId, targetPlane)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T029 [P] [US1] Add `offsetFace(partId, faceId, distanceMm)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T030 [US1] Implement `extendFaceToTarget` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; resolve target geometry (plane, face, or surface); use `BRepOffsetAPI_MakeOffset` to extend the face along its normal until it intersects the target; wrap in `TRY_GEOMETRY`; error `GE_EXTEND_FAILED` if result is self-intersecting
- [X] T031 [US1] Implement `offsetFace` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; apply `BRepOffsetAPI_MakeOffset` with the signed distance on the specified face; error `GE_OFFSET_FAILED` if offset produces invalid geometry; wrap in `TRY_GEOMETRY`

#### C++ NAPI Layer

- [X] T032 [P] [US1] Add `ExtendFaceToTarget` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize 6 args (partId, faceId, targetType string, targetPartId, targetFaceId, targetPlane object) → call `svc().extendFaceToTarget()` → serialize `ExtendFaceResult`
- [X] T033 [P] [US1] Add `OffsetFace` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partId, faceId, distanceMm → call `svc().offsetFace()` → serialize `OffsetFaceResult`
- [X] T034 [US1] Register `extendFaceToTarget`, `offsetFace` in `RegisterGeometryMethods` in `cpp/src/napi/geometry_binding.cc`

#### TypeScript Layer

- [X] T035 [P] [US1] Add `ExtendFaceResult`, `OffsetFaceResult` interfaces to `ts/src/geometry/types.ts`
- [X] T036 [P] [US1] Add `extendFaceToTarget(...)` and `offsetFace(partId, faceId, distanceMm)` entries to `GeometryAddon` interface in `ts/src/geometry/binding.ts`
- [X] T037 [US1] Add `extendFaceToTarget` and `offsetFace` wrapper methods to `GeometryBinding` class in `ts/src/geometry/binding.ts`
- [X] T038 [P] [US1] Add `extend_face_to_target` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema per `contracts/mcp-tools-extended.md`: partId, faceId, targetType enum, target object (conditional fields)
- [X] T039 [P] [US1] Add `offset_face` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: partId, faceId, distance (number, non-zero)
- [X] T040 [US1] Add `handleExtendFaceToTarget(args)` function to `ts/src/mcp/tools.ts`: validate partId, faceId, targetType; validate target object has correct fields for the targetType; call binding; return modified shell and rollback token
- [X] T041 [US1] Add `handleOffsetFace(args)` function to `ts/src/mcp/tools.ts`: validate partId, faceId, distance (reject 0); call binding; return modified shell and rollback token
- [X] T042 [US1] Add `case 'extend_face_to_target'` and `case 'offset_face'` to `dispatchTool` switch in `ts/src/mcp/tools.ts`

**Checkpoint**: US1 complete — all 5 direct modeling tools callable. Acceptance scenario: panel previously failing `apply_unfold` due to geometry gap now succeeds after `extend_face_to_target` → `trim_body_with_plane` correction loop.

---

## Phase 4: User Story 2 — Body Topology: Split and Merge (Priority: P2)

**Goal**: AI agent can split a panel into two named bodies at a cutting plane, and fuse two adjacent panels into a single bent component.

**Independent Test**: Load a single panel → call `split_body_by_plane` → verify two new shell IDs exist in session → call `rollback` with returned token → verify original single shell is restored. Separately, load two adjacent panels → call `merge_bodies_with_bend` → verify single merged shell ID returned.

#### C++ Layer

- [X] T043 [US2] Add result structs `SplitBodyResult` (`positiveShellId`, `negativeShellId`, `rollbackToken`) and `MergeBodyResult` (`mergedShellId`, `rollbackToken`) to `cpp/src/geometry/geometry_service.hpp`
- [X] T044 [P] [US2] Add `splitBodyByPlane(partId, plane, positiveOutputName, negativeOutputName)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T045 [P] [US2] Add `mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadiusMm)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T046 [US2] Implement `splitBodyByPlane` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; create positive half-space via `BRepPrimAPI_MakeHalfSpace` along normal; apply `BRepAlgoAPI_Cut` for positive side (solid minus negative half-space) and negative side (solid minus positive half-space); error `GE_SPLIT_FAILED` if either result is empty; register both with caller-supplied names
- [X] T047 [US2] Implement `mergeBodiesWithBend` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; fuse both shells using `BRepAlgoAPI_Fuse`; insert cylindrical bend surface along specified junction edges; error `GE_MERGE_FAILED` if fuse produces non-manifold result; register merged shell

#### C++ NAPI Layer

- [X] T048 [P] [US2] Add `SplitBodyByPlane` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partId, normal object, origin object, positiveOutputName, negativeOutputName → call `svc().splitBodyByPlane()` → serialize `SplitBodyResult`
- [X] T049 [P] [US2] Add `MergeBodiesWithBend` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partAId, partBId, targetEdges array, bendRadiusMm → call `svc().mergeBodiesWithBend()` → serialize `MergeBodyResult`
- [X] T050 [US2] Register `splitBodyByPlane`, `mergeBodiesWithBend` in `RegisterGeometryMethods` in `cpp/src/napi/geometry_binding.cc`

#### TypeScript Layer

- [X] T051 [P] [US2] Add `SplitBodyResult`, `MergeBodyResult` interfaces to `ts/src/geometry/types.ts`
- [X] T052 [P] [US2] Add `splitBodyByPlane(...)` and `mergeBodiesWithBend(...)` entries to `GeometryAddon` interface in `ts/src/geometry/binding.ts`
- [X] T053 [US2] Add `splitBodyByPlane`, `mergeBodiesWithBend` wrapper methods to `GeometryBinding` class in `ts/src/geometry/binding.ts`
- [X] T054 [P] [US2] Add `split_body_by_plane` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: partId, cutting_plane, output_names (exactly 2 strings) per contract
- [X] T055 [P] [US2] Add `merge_bodies_with_bend` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: partAId, partBId, targetEdges array, bendRadius per contract
- [X] T056 [US2] Add `handleSplitBodyByPlane(args)` function to `ts/src/mcp/tools.ts`: validate partId, cutting_plane (normal + origin), output_names (array of exactly 2); call binding; register both shell IDs in session; return `positive_shell_id`, `negative_shell_id`, `rollback_token`
- [X] T057 [US2] Add `handleMergeBodiesWithBend(args)` function to `ts/src/mcp/tools.ts`: validate partAId, partBId, targetEdges (min 1), bendRadius (> 0); call binding; register merged shell in session; return `merged_shell_id`, `rollback_token`
- [X] T058 [US2] Add `case 'split_body_by_plane'` and `case 'merge_bodies_with_bend'` to `dispatchTool` switch in `ts/src/mcp/tools.ts`

**Checkpoint**: US2 complete. A split followed by rollback restores the original shell. `merge_bodies_with_bend` returns a single manifold shell.

---

## Phase 5: User Story 3 — Sheet Metal Detailing: Add Flange and Rip Edge (Priority: P2)

**Goal**: AI agent can add a flange to an open panel edge and rip an interior corner so `apply_unfold` succeeds.

**Independent Test**: Load a folded panel that fails `apply_unfold` → call `rip_edge` on the interior corner → call `apply_unfold` → verify it now returns an `unfold_id`. Separately, load a flat panel → call `add_flange` on an open edge → verify modified shell has one additional flat face.

#### C++ Layer

- [X] T059 [US3] Add result structs `AddFlangeResult` (`modifiedShellId`, `flangeFeatureId`, `rollbackToken`) and `RipEdgeResult` (`modifiedShellId`, `rollbackToken`) to `cpp/src/geometry/geometry_service.hpp`
- [X] T060 [P] [US3] Add `addFlange(partId, edgeId, lengthMm, angleDeg, bendRadiusMm)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T061 [P] [US3] Add `ripEdge(partId, edgeId)` virtual method to `cpp/src/geometry/geometry_service.hpp`
- [X] T062 [US3] Implement `addFlange` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; verify edge is a boundary (open) edge — error `GE_EDGE_NOT_OPEN` if not; extrude a new face by sweeping the edge normal by `lengthMm` at `angleDeg`; apply cylindrical bend surface at `bendRadiusMm`; fuse into parent shell via `BRepAlgoAPI_Fuse`; register `flangeFeatureId`; wrap in `TRY_GEOMETRY`
- [X] T063 [US3] Implement `ripEdge` in `cpp/src/geometry/geometry_service.cc`: call `createSnapshot`; verify edge is an interior (non-boundary) edge — error `GE_EDGE_NOT_INTERIOR` if boundary; remove the shared edge entry from the B-Rep using `BRep_Builder`; validate resulting topology is not degenerate — error `GE_RIP_FAILED` if invalid; wrap in `TRY_GEOMETRY`

#### C++ NAPI Layer

- [X] T064 [P] [US3] Add `AddFlange` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partId, edgeId, lengthMm, angleDeg, bendRadiusMm → call `svc().addFlange()` → serialize `AddFlangeResult`
- [X] T065 [P] [US3] Add `RipEdge` NAPI function to `cpp/src/napi/geometry_binding.cc`: deserialize partId, edgeId → call `svc().ripEdge()` → serialize `RipEdgeResult`
- [X] T066 [US3] Register `addFlange`, `ripEdge` in `RegisterGeometryMethods` in `cpp/src/napi/geometry_binding.cc`

#### TypeScript Layer

- [X] T067 [P] [US3] Add `AddFlangeResult`, `RipEdgeResult` interfaces to `ts/src/geometry/types.ts`
- [X] T068 [P] [US3] Add `addFlange(...)` and `ripEdge(partId, edgeId)` entries to `GeometryAddon` interface in `ts/src/geometry/binding.ts`
- [X] T069 [US3] Add `addFlange`, `ripEdge` wrapper methods to `GeometryBinding` class in `ts/src/geometry/binding.ts`
- [X] T070 [P] [US3] Add `add_flange` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: partId, edgeId, length (> 0), angle (0 < x ≤ 180), bendRadius (> 0) per contract
- [X] T071 [P] [US3] Add `rip_edge` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: partId, edgeId per contract
- [X] T072 [US3] Add `handleAddFlange(args)` function to `ts/src/mcp/tools.ts`: validate partId, edgeId, length (> 0), angle (0 < x ≤ 180), bend_radius (> 0); call binding; register modified shell in session; return `modified_shell_id`, `flange_feature_id`, `rollback_token`
- [X] T073 [US3] Add `handleRipEdge(args)` function to `ts/src/mcp/tools.ts`: validate partId, edgeId; call binding; return `modified_shell_id`, `rollback_token`
- [X] T074 [US3] Add `case 'add_flange'` and `case 'rip_edge'` to `dispatchTool` switch in `ts/src/mcp/tools.ts`

**Checkpoint**: US3 complete. `apply_unfold` succeeds after `rip_edge` on a panel that previously returned `GE_UNFOLD_FAILED`.

---

## Phase 6: User Story 4 — Logistics Compliance: Check Boundary Compliance (Priority: P3)

**Goal**: AI agent can validate whether a panel fits within the configured shipping, coating, or raw stock envelope before proceeding to export.

**Independent Test**: Call `check_boundary_compliance` with `envelope_type: "shipping"` on a panel whose bounding box exceeds the configured `max_length_mm` → verify response includes `compliant: false` and a violation with the correct axis and excess measurement.

**Note**: This tool is TypeScript-only — no new C++ method needed. It reads the bounding box from the existing `getTopology()` response and compares against `logistics://` config values.

- [X] T075 [US4] Add `check_boundary_compliance` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts` — inputSchema: `{ target_id: string, envelope_type: 'shipping' | 'coating' | 'raw_stock' }` per contract
- [X] T076 [US4] Implement `handleCheckBoundaryCompliance(args, config)` in `ts/src/mcp/tools.ts`:
  - Validate `target_id` and `envelope_type`
  - Call `getGeometryBinding().getTopology(targetId)` to retrieve bounding box dimensions
  - For `shipping`: read `config.logistics.shipping_envelope` (`max_length_mm`, `max_width_mm`, `max_height_mm`) and compare against topology bounding box X/Y/Z; collect axis violations (measured, limit, excess)
  - For `coating`: read `config.logistics.coating_envelope` (if present); error `MD_LOGISTICS_NOT_CONFIGURED` if not present
  - For `raw_stock`: use the smallest configured inventory sheet (`max_width_mm` / `max_height_mm` from `config.materials[0].inventory_sheets[0]`) as the envelope
  - Return `{ compliant: boolean, envelope_type, violations: AxisViolation[] }`
- [X] T077 [US4] Add `case 'check_boundary_compliance'` to `dispatchTool` switch in `ts/src/mcp/tools.ts`
- [X] T078 [P] [US4] Verify `ManufacturingConfig` type in `ts/src/config/loader.ts` exposes `logistics.coating_envelope` as optional; add field if missing (schema already allows it per `schema.ts`)

**Checkpoint**: US4 complete. A panel exceeding the shipping envelope returns `compliant: false` with the correct axis violation. A fitting panel returns `compliant: true`.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and function design matrix updates that affect all stories.

- [X] T079 [P] Update `docs/OCCT_API_USAGE.md` to document 8 new OCCT APIs used: `BRepAlgoAPI_Common`, `GProp_GProps`, `BRep_DistShapeShape`, `BRepPrimAPI_MakeHalfSpace`, `BRepOffsetAPI_MakeOffset`, `BRepAlgoAPI_Fuse`, `BRep_Builder::Remove`, and note cylindrical surface insertion for `mergeBodiesWithBend`
- [X] T080 [P] Update `Engineering-Design.md §4` (Function Design Matrix) to add layer-responsibility tables for all 10 new tools, following the existing `synthesize_joints` table pattern — document which layer (OCCT, Geometry Engine, Manufacturing Domain, MCP) owns each concern per tool

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — verify build chain immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 Sub-A (Phase 3A)**: Depends on Phase 2 — `compute_intersections`, `compute_gaps`, `trim_body_with_plane`
- **US1 Sub-B (Phase 3B)**: Depends on Phase 2 — `extend_face_to_target`, `offset_face` (gate removed 2026-05-17)
- **US2 (Phase 4)**: Depends on Phase 2 — independent of US1 Sub-B (gate removed 2026-05-17)
- **US3 (Phase 5)**: Depends on Phase 2 — independent of US1/US2 (gate removed 2026-05-17)
- **US4 (Phase 6)**: Depends on Phase 2 — no C++ dependency; can start in parallel with US1 Sub-A
- **Polish (Phase 7)**: Depends on all phases — documentation cleanup

### User Story Dependencies

- **US1 Sub-A (T006–T026)**: Unblocked after Phase 2
- **US4 (T075–T078)**: Unblocked after Phase 2 — can run in parallel with US1 Sub-A
- **US1 Sub-B (T027–T042)**: Unblocked after Phase 2 (gate removed 2026-05-17)
- **US2 (T043–T058)**: Unblocked after Phase 2; independent of US1 Sub-B (gate removed 2026-05-17)
- **US3 (T059–T074)**: Unblocked after Phase 2; independent of US1 Sub-B and US2 (gate removed 2026-05-17)

### Within Each User Story

Each user story follows this dependency chain:
1. C++ header structs + virtual method declarations (T00N) — can parallel with TS types
2. C++ OCCT implementation (depends on 1)
3. C++ NAPI function + registration (depends on 2)
4. TypeScript types (parallel with 1)
5. TypeScript `GeometryAddon` interface + `GeometryBinding` wrapper (depends on 4)
6. TypeScript tool definition (depends on 5 — same file, sequential)
7. TypeScript tool handler function (depends on 6 — same file, sequential)
8. TypeScript `dispatchTool` case (depends on 7 — same file, sequential)

### Parallel Opportunities

Within each user story phase, the C++ and TypeScript tracks are independent and can proceed in parallel:

```text
# US1 Sub-A parallel tracks:
Track C++: T006 (structs) → T009 (virtual methods) → T010/T011/T012 (impls) → T013/T014/T015 (NAPI) → T016 (register)
Track TS:  T017 (types)   → T018 (addon interface)  → T019 (binding wrapper)  → T020–T022 (defs) → T023–T025 (handlers) → T026 (dispatch)

# US4 can start immediately after Phase 2 alongside US1 Sub-A:
T075 → T076 → T077 (T078 parallel)
```

---

## Parallel Example: User Story 1 Sub-A

```text
# After Phase 2 completes, launch in parallel:
Track 1 — C++ headers:
  T006 Add ClashPair/ClashReport structs to geometry_service.hpp
  T007 Add GapReport struct to geometry_service.hpp
  T008 Add TrimBodyResult struct to geometry_service.hpp
  (T006/T007/T008 can run in parallel — different struct definitions)

Track 2 — TS types (parallel with Track 1):
  T017 Add ClashReport, GapReport, TrimBodyResult to types.ts

# After T006/T007/T008 complete:
  T009 Add 3 virtual method declarations to geometry_service.hpp

# After T009:
  T010 Implement computeIntersections in geometry_service.cc
  T011 Implement computeGaps in geometry_service.cc        ← parallel
  T012 Implement trimBodyWithPlane in geometry_service.cc  ← parallel

# After T017 complete (TS track):
  T018 Update GeometryAddon interface
  After T018: T019 Add GeometryBinding wrappers
  After T019: T020/T021/T022 tool definitions (sequential, same file)
  After T022: T023/T024/T025 handlers (sequential, same file)
  After T025: T026 dispatch cases
```

---

## Implementation Strategy

### MVP First (US1 Sub-A + US4)

1. Complete Phase 1: Build chain verification (T001)
2. Complete Phase 2: Foundational types + error codes (T002–T005)
3. Complete Phase 3A: `compute_intersections`, `compute_gaps`, `trim_body_with_plane` (T006–T026)
4. Complete Phase 6: `check_boundary_compliance` (T075–T078) ← parallel with 3A if resourced
5. **STOP AND VALIDATE**: Clash-detection → trim loop works end-to-end

### Full Delivery (all MVP — gate removed 2026-05-17)

6. Phase 3B: `extend_face_to_target`, `offset_face` (T027–T042)
7. Phase 4: `split_body_by_plane`, `merge_bodies_with_bend` (T043–T058)
8. Phase 5: `add_flange`, `rip_edge` (T059–T074)
9. Phase 7: Documentation polish (T079–T080)
10. Each phase is independently testable before proceeding to the next

---

## Notes

- `[P]` tasks target different files within the same story — no merge conflicts
- US4 (`check_boundary_compliance`) touches only `ts/src/mcp/tools.ts` and `ts/src/config/loader.ts`; it can be assigned to a separate developer track in parallel with US1 Sub-A
- C++ tasks T010, T011, T012 all modify `geometry_service.cc` — they are NOT parallel despite their logic being independent; batch them in sequence
- NAPI registration (T016, T034, T050, T066) each touch `RegisterGeometryMethods` at the bottom of `geometry_binding.cc` — sequential within each story
- `geometry_service.hpp` struct additions within a single phase (e.g., T006/T007/T008) touch the same file and are sequential despite the [P] marker on individual struct additions; combine into one editing session
