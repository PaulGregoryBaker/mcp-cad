# Implementation Plan: Graph-Driven Object Mutations

**Branch**: `main` | **Date**: 2026-06-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-graph-driven-mutations/spec.md`

## Summary

Invert the mutation architecture so the manufacturing graph (BendNode + merged DXF flat pattern) is updated **before** any C++ geometry call is made. The 3D solid is then derived from the graph description via a new `buildShellFromFlatPattern` C++ entry point, replacing the current boolean-union approach. Adds strict pre-flight validation for `fuse_bodies` (thickness match, coplanarity, DXF connectivity) and a graph-ownership enforcement guard that rejects raw C++ mutations on graph-tracked shells.

## Technical Context

**Language/Version**: TypeScript 5.4 (Node.js 22+) / C++17 (MSVC/GCC, CMake 3.26+)

**Primary Dependencies**: OpenCASCADE (OCCT) via node-addon-api v8 NAPI bridge; polygon-clipping 0.15.7 (2D DXF union); zod 3.22 (schema validation); @modelcontextprotocol/sdk 1.0.0

**Storage**: In-memory manufacturing graph (`ManufacturingGraphData`, `Map<string, ManufacturingGraph>`); file-backed BREP via OCCT snapshot registry

**Testing**: Vitest (unit / contract / integration / e2e projects, `ts/vitest.config.ts`); Catch2 + CTest for C++ tests

**Target Platform**: Windows 11 / Linux server; NAPI addon compiled to `.node`

**Performance Goals**: `buildShellFromFlatPattern` < 500ms for single-bend flat patterns (matching existing `mergeBodiesWithBend` latency); TypeScript graph mutations synchronous < 5ms

**Constraints**:
- Graph update MUST complete and be observable before any C++ call returns (FR-001, FR-002)
- Atomic rollback on any failure — no partial graph state (FR-007)
- 90° bend only in `buildShellFromFlatPattern` for this spec (per Assumptions)
- `fuse_bodies` pre-flight errors MUST fire before any graph or geometry mutation (FR-002a/b/c)

**Scale/Scope**: Single-session; 2–5 panel assemblies typical; no multi-user concurrency

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — no violations found.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Deterministic Geometry | ✅ PASS | `buildShellFromFlatPattern` is deterministic: same DXF + bend specs → same 3D solid every time |
| II. Bounded Context Separation | ⚠️ WARN | Graph construction lives in MCP Protocol Layer (`tools.ts`) — pre-existing architectural debt, not introduced by this spec. New `buildShellFromFlatPattern` correctly stays inside the Geometry Engine with no manufacturing knowledge. |
| III. Safety Filter Enforcement | N/A | No fire-rated or safety-context dependencies in this feature |
| IV. Rollback-First State Management | ✅ PASS | FR-007 mandates atomic rollback; plan integrates with existing C++ snapshot registry and adds graph-state rollback |
| V. Kerf Compensation | N/A | No joint synthesis in scope |
| VI. Structured Errors Always | ✅ PASS | All new error codes (`GE_FUSE_*`, `GE_BUILD_FROM_PATTERN_FAILED`) follow the JSON error model with `code`, `message`, `recoverable`, `suggested_tool` |
| VII. MVP Scope Discipline | ⚠️ WARN | Beyond the original STEP→DXF MVP. However, the manufacturing graph (spec 009) is merged; this spec is its required evolution. Arbitrary bend angles deferred per spec assumptions. |
| VIII. Configuration Over Hard-Coding | ⚠️ WARN | Thickness tolerance (0.1mm) and coplanarity threshold (2°) from FR-002a/b must be defined as named constants (`FUSE_THICKNESS_TOLERANCE_MM`, `FUSE_COPLANARITY_THRESHOLD_DEG`), not inline magic numbers. Not yet in `manufacturing://rules` resource — post-MVP. |
| IX. Async Export Contract | N/A | No export operations in scope |
| X. Graceful Failure Over Silent Fallbacks | ✅ PASS | FR-002a/b/c all produce structured errors before any mutation; FR-007 mandates no partial state; disjoint DXF detection replaces the current silent bounding-box fallback |

**Gate result**: No ERROR-level violations. Three WARNs — none block implementation. §VIII is satisfied by defining constants at module scope.

## Project Structure

### Documentation (this feature)

```text
specs/010-graph-driven-mutations/
├── plan.md              # This file
├── research.md          # Phase 0: OCCT re-fold strategy, fuse validation, graph enforcement
├── data-model.md        # Phase 1: modified types, new C++ structs, error codes, state transitions
├── quickstart.md        # Phase 1: build steps, test run instructions
├── contracts/
│   ├── napi-contract.md       # buildShellFromFlatPattern NAPI method signature + behaviour
│   └── mcp-tool-contract.md   # fuse_bodies error codes, merge_bodies_with_bend order change
└── tasks.md             # Phase 2 output (/speckit-tasks — not yet created)
```

### Source Code (repository root)

```text
cpp/
├── src/
│   ├── geometry/
│   │   ├── geometry_service.hpp   # + BendZoneSpec, BuildShellFromFlatPatternResult structs
│   │   │                          # + buildShellFromFlatPattern() method declaration
│   │   └── geometry_service.cc    # + buildShellFromFlatPattern() implementation
│   │                              #   (reuses buildSheetFromDxf + thickenSheet + applyBend)
│   └── napi/
│       └── geometry_binding.cc    # + NAPI wrapper for buildShellFromFlatPattern
└── tests/
    └── (existing C++ test fixtures; new Catch2 tests for buildShellFromFlatPattern)

ts/
├── src/
│   ├── geometry/
│   │   └── binding.ts             # + buildShellFromFlatPattern to GeometryAddon & GeometryBinding
│   ├── manufacturing/
│   │   ├── graph/
│   │   │   └── types.ts           # + radius, kFactor, angle to BendZone interface
│   │   └── dxf/
│   │       └── merge.ts           # + checkDxfUnionConnectivity (returns disjoint flag)
│   └── mcp/
│       └── tools.ts               # refactor handleMergeBodiesWithBend (graph-first + buildShellFromFlatPattern)
│                                  # refactor handleFuseBodies (pre-flight + graph-first + buildSheetFromDxf path)
│                                  # + findGraphOwner() enforcement guard
│                                  # + FUSE_THICKNESS_TOLERANCE_MM, FUSE_COPLANARITY_THRESHOLD_DEG constants
└── tests/
    ├── unit/                      # + fuse pre-flight unit tests (thickness, coplanarity, disjoint)
    ├── integration/               # + merge round-trip, fuse round-trip integration tests
    └── contract/                  # + GE_FUSE_* error code contract tests
```

**Structure Decision**: Single project (existing layout). No new top-level directories. C++ and TypeScript remain co-located as in the existing repository.

## Complexity Tracking

> **Two pre-existing §II violations are inherited — neither introduced by this spec.**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| §II: Graph construction in MCP Protocol Layer | `handleMergeBodiesWithBend` and `handleFuseBodies` directly manipulate `ManufacturingGraph` nodes in `tools.ts` | Extracting graph construction into a dedicated `ManufacturingDomain` service is a larger refactor outside this spec's scope |
| §VII: Beyond original MVP scope | Manufacturing graph (spec 009) is merged; graph-driven mutations are required to prevent geometry drift | Deferring leaves `merge_bodies_with_bend` and `fuse_bodies` producing inconsistent flat patterns silently — violating §X |
