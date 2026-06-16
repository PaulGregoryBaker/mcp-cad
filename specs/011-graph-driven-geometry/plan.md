# Implementation Plan: Graph-Driven Geometry Pipeline

**Branch**: `011-graph-driven-geometry` | **Date**: 2026-06-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/011-graph-driven-geometry/spec.md`

## Summary

Fix three known bugs in the geometric pipeline and add bidirectional 3D-to-2D coordinate mapping.

| ID | Type | Description |
|----|------|-------------|
| **BUG-01** | Bug / P1 blocker | `split_body_by_bends` creates manufacturing graphs but never invokes the geometric pipeline to rebuild 3D geometry |
| **BUG-02** | Bug / P1 | `split_body_by_bends` forces non-rectangular panels into axis-aligned bounding-box outlines, losing shape fidelity |
| **BUG-03** | Bug / P1 | `merge_bodies_with_bend` fails when the shared edges of the two input parts are offset in world space |
| **NEW** | Feature | Bidirectional `map_3d_to_2d` / `map_2d_to_3d` operations for interactive manufacturing-graph editing |

**Out of scope**: kerf compensation, fuse bodies, async rebuild queue infrastructure — all already working or not required for this spec.

## Technical Context

**Language/Version**: TypeScript 5.4 (Node.js 22+) / C++17 (MSVC/GCC, CMake 3.26+)

**Primary Dependencies**: OpenCASCADE (OCCT) via node-addon-api v8 NAPI bridge; existing `buildSheetFromDxf`, `thickenSheet`, `applyBend` NAPI bindings; `ManufacturingGraph`, `PanelNode`, `BendNode` types; polygon-clipping 0.15.7; zod 3.22

**Storage**: In-memory manufacturing graph (`Map<string, ManufacturingGraph>`); panel face transform matrices for coordinate mapping (derived analytically from graph state or surfaced from NAPI)

**Testing**: Vitest (unit / integration / contract); existing fixture parts in `cpp/tests/fixtures/`; new fixtures needed for non-rectangular panels (BUG-02) and offset-edge merge cases (BUG-03)

**Target Platform**: Windows 11 / Linux server; Node.js MCP server with NAPI addon

**Project Type**: Bug-fix + feature addition on existing MCP server

**Performance Goals**:
- `split_body_by_bends` total time: prior latency + max 500 ms pipeline overhead
- `merge_bodies_with_bend` total time: prior latency + max 500 ms
- `map_3d_to_2d` / `map_2d_to_3d`: <= 10 ms per call (analytical computation, no geometry engine round-trip)
- Full rebuild: <= 2 seconds for 100-panel parts

**Constraints**:
- Edge-alignment tolerance: default 2 mm; MUST be `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` constant, not an inline literal
- Coordinate mapping accuracy: <= 0.1 mm round-trip error; MUST be `COORD_MAP_ACCURACY_THRESHOLD_MM` constant
- No changes to kerf compensation, fuse bodies, or geometric pipeline primitives
- Coordinate mappings re-computed on demand after any geometry rebuild; not cached between mutations

**Scale/Scope**: Single-session; 2-5 panel assemblies typical; up to 100 panels for stress testing

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Geometry | PASS | Pipeline rebuilds are deterministic: same graph + parameters = same geometry |
| II. Bounded Context Separation | PASS | Coordinate mapping lives in MCP Protocol Layer as a query operation; pipeline stays in Geometry Engine; no new boundary violations |
| III. Safety Filter Enforcement | N/A | No fire-rated or safety-context dependencies in scope |
| IV. Rollback-First State Management | PASS | Existing rollback tokens apply; failed rebuilds do not corrupt graph state |
| V. Kerf Compensation | N/A | Already implemented and working; no changes in this spec |
| VI. Structured Errors Always | PASS | BUG-03 alignment errors, mapping failures, and rebuild failures all return structured JSON errors with code/message/recoverable/suggested_tool |
| VII. MVP Scope Discipline | PASS | Scope is tightly bounded to three bug fixes and one new query capability |
| VIII. Configuration Over Hard-Coding | WARN | `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` and `COORD_MAP_ACCURACY_THRESHOLD_MM` must be named module-scope constants; post-MVP: move to `manufacturing://rules` resource |
| IX. Async Export Contract | N/A | No export operations in scope |
| X. Graceful Failure Over Silent Fallbacks | PASS | BUG-01 fix enforces pipeline call (no cached geometry bypass); BUG-03 fix replaces silent failure with structured error; mapping errors explicit |

**Gate result**: PASS - One non-blocking WARN on config constants.

## Project Structure

### Documentation (this feature)

```text
specs/011-graph-driven-geometry/
├── plan.md                          # This file
├── research.md                      # Phase 0: root-cause analysis for each bug + mapping approach
├── data-model.md                    # Phase 1: CoordinateMap types, alignment error types, DXF outline flow
├── quickstart.md                    # Phase 1: build, reproduce each bug, verify fix
├── contracts/
│   ├── split-fix-contract.md        # BUG-01 + BUG-02: split pipeline compliance + outline capture
│   ├── merge-fix-contract.md        # BUG-03: edge alignment detection and correction contract
│   └── coordinate-map-contract.md   # map_3d_to_2d / map_2d_to_3d API contract
└── tasks.md                         # Phase 2 output (/speckit.tasks)
```

### Source Code Changes (repository root)

```text
ts/
├── src/
│   ├── mcp/
│   │   └── tools.ts
│   │       # BUG-01 fix: after graph creation in handleSplitBodyByBends,
│   │       #   call solver.buildReconstructionPlan() + execute() to rebuild shells
│   │       # BUG-03 fix: in handleMergeBodiesWithBend, measure edge offset before
│   │       #   graph mutation; auto-correct if <= MERGE_EDGE_ALIGNMENT_TOLERANCE_MM,
│   │       #   else return GE_MERGE_EDGE_MISALIGNED structured error
│   │       # NEW: handleMapTo2D / handleMapTo3D tool handlers
│   │
│   ├── manufacturing/
│   │   └── graph/
│   │       └── solver.ts
│   │           # BUG-02 fix: in dispatchNode for PanelNode, extract true polygon outline
│   │           #   from OCCT face boundary wires into shapeDxf (not bounding-box rectangle)
│   │
│   └── geometry/
│       ├── binding.ts               # Possibly extend: getPanelFaceTransform() if OPEN-01
│       │                            #   determines NAPI extension is needed
│       └── coordinate-map.ts        # NEW: map3dTo2d(), map2dTo3d()
│           #   Input: 3D world point + graph context
│           #   Output: panelId + 2D XY in DXF flat pattern (and reverse)
│           #   Uses panel transform matrix from graph or NAPI
│
└── tests/
    ├── unit/
    │   └── geometry/
    │       └── coordinate-map.test.ts     # NEW: round-trip accuracy, error cases
    ├── integration/
    │   ├── split_pipeline_compliance.integration.test.ts  # NEW: regression BUG-01 + BUG-02
    │   └── merge_edge_alignment.integration.test.ts       # NEW: regression BUG-03
    └── contract/
        └── coordinate-map-contract.test.ts  # NEW: error codes, tolerance assertions

cpp/
└── src/napi/geometry_binding.cc
    # Possibly add: getPanelFaceTransform() NAPI binding (only if OPEN-01 requires it)
    # All existing bindings unchanged
```

**Structure Decision**: Minimal footprint. Three touch points in existing files (tools.ts, solver.ts, and optionally binding.cc) plus one new TypeScript module (coordinate-map.ts) and three new test files.

---

## Phase 0: Research & Open Questions

### OPEN-01 -- Face Transform Data for Coordinate Mapping

**Question**: Is the 3D-to-2D transform matrix for each panel face available through the existing NAPI layer, or must it be computed analytically from the fold sequence in the manufacturing graph?

**Research approach**:
1. Inspect `ts/src/geometry/binding.ts` for any `getFaceTransform` or placement-related export
2. Inspect `cpp/src/napi/geometry_binding.cc` for any transform-related binding
3. If absent, determine whether the transform can be recovered from: panel order in graph + bend angles + K-factor + thickness (fold sequence = unambiguous placement)

**Decision criteria**:
- If transform available via NAPI: use directly
- If not: implement analytical computation from graph fold sequence
- If analytical is insufficient for complex geometries: add minimal NAPI binding `getPanelFaceTransform(shellId, panelIndex)`

---

### OPEN-02 -- Root Cause of BUG-02 (Bounding-Box DXF Outline)

**Question**: Which specific code path in `solver.ts` or `tools.ts` writes the bounding-box rectangle into `shapeDxf` instead of the true polygon boundary?

**Research approach**:
1. Trace `dispatchNode` in `solver.ts` for a PanelNode
2. Find where `panel.shapeDxf` is written; confirm whether it uses face boundary extraction or bounding box
3. Check `buildSheetFromDxf` in C++ -- does it support N-vertex LWPOLYLINE, or only 4-corner rectangles?

**Decision criteria**:
- If `shapeDxf` is written from bounding box: fix write path to use OCCT face boundary wires
- If `buildSheetFromDxf` only parses 4-vertex polygons: extend its LWPOLYLINE parser to handle arbitrary N-vertex outlines

---

### OPEN-03 -- BUG-03 Edge Identification in Merge

**Question**: How are the "shared edges" of two parts currently identified in `handleMergeBodiesWithBend`? Is there an explicit edge-matching step, or are part positions assumed to be co-located?

**Research approach**:
1. Read `handleMergeBodiesWithBend` in `ts/src/mcp/tools.ts`
2. Identify how the two shells are positioned relative to each other before the NAPI call
3. Find whether any edge proximity check exists; if so, what its failure mode is

**Decision criteria**:
- If positions assumed co-located with no check: add edge-detection + offset measurement step before merge call
- If partial check exists: extend with configurable tolerance threshold and structured error output

---

## Phase 1: Design & Contracts

### 1. Data Model (data-model.md)

**New types**:
- `CoordinateMapResult`: `{ panelId: string; xy: [number, number]; errorMm: number }`
- `CoordinateMapError`: `{ code: 'GE_POINT_NOT_ON_PANEL'; nearestPanelId: string; distanceMm: number }`
- `EdgeAlignmentError`: `{ code: 'GE_MERGE_EDGE_MISALIGNED'; measuredOffsetMm: number; thresholdMm: number; panelAId: string; panelBId: string }`
- `EdgeAlignmentCorrection`: `{ applied: boolean; correctionMm: number }` (included in merge success result)

**Updated flow**:
- `shapeDxf` write path in `dispatchNode`: OCCT face boundary wires -> LWPOLYLINE with all N vertices
- Split result: includes `pipelineExecuted: true` flag confirming rebuild happened

### 2. Interface Contracts (contracts/)

**split-fix-contract.md**:
- Post-condition: `handleSplitBodyByBends` returns only after pipeline rebuild completes (or fails explicitly)
- Post-condition: `shapeDxf` for each panel contains a LWPOLYLINE with the true boundary polygon
- Error: if pipeline rebuild fails, return `GE_REBUILD_FAILED` structured error; graph state is reverted
- Regression anchor: existing split integration tests (11 tests) must continue passing

**merge-fix-contract.md**:
- Pre-condition check: measure offset between shared edges; if > `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM`: return `GE_MERGE_EDGE_MISALIGNED` with measured value
- Correction: if within tolerance, project and correct; include `EdgeAlignmentCorrection` in result
- Error codes: `GE_MERGE_EDGE_MISALIGNED`, `GE_MERGE_INCOMPATIBLE_MATERIALS`, `GE_MERGE_INCOMPATIBLE_THICKNESS`
- Regression anchor: existing merge/unfold regression tests (3 tests) must continue passing

**coordinate-map-contract.md**:
- `map_3d_to_2d(partId, point3d: [x,y,z])` -> `CoordinateMapResult | CoordinateMapError`
- `map_2d_to_3d(partId, panelId, point2d: [x,y])` -> `{ point3d: [x,y,z] } | CoordinateMapError`
- Round-trip guarantee: `map_2d_to_3d(map_3d_to_2d(p).xy)` within 0.1 mm of `p`
- Both operations require part to have a manufacturing graph; otherwise `GE_NO_MANUFACTURING_GRAPH`

### 3. Quick-Start Guide (quickstart.md)

- How to reproduce BUG-01, BUG-02, BUG-03 with the existing codebase (before fix)
- How to verify each fix is working
- How to test coordinate mapping round-trip with a known fixture part
- Build and test commands

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| OPEN-01: face transform not in NAPI layer | Medium | Analytical computation from fold sequence is fallback; add minimal NAPI binding only if needed |
| BUG-02 fix requires LWPOLYLINE parser extension in C++ | Medium | `buildSheetFromDxf` already reads LWPOLYLINE; extend vertex count; not a rewrite |
| BUG-03 fix causes regressions in existing merge tests | Low | Alignment check is additive; existing well-aligned test cases pass through unchanged |
| Coordinate mapping accuracy degrades on curved edges | Medium | Document limitation; curved edges deferred to Phase 2+; test only with straight-edge panels in Phase 1 |
| Pipeline rebuild in split adds unacceptable latency | Low | Research Task 2 (from research.md) confirmed rebuild latency is well within 500 ms overhead |

---

## Next Steps

1. Complete Phase 0 research (OPEN-01, OPEN-02, OPEN-03) -- update research.md with findings
2. Confirm Phase 1 contract designs -- review with team
3. Run `/speckit.tasks` for implementation task breakdown
