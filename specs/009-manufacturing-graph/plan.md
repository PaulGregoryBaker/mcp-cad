# Implementation Plan: Manufacturing Graph — Sheet Metal Intent Layer

**Branch**: `009-manufacturing-graph` | **Date**: 2026-06-03 | **Spec**: [specs/009-manufacturing-graph/spec.md](spec.md)

**Input**: Feature specification from `specs/009-manufacturing-graph/spec.md`

## Summary

Introduce a Directed Acyclic Graph (DAG) — the **Manufacturing Graph** — as the first-class source of truth for sheet-metal fabrication intent. The graph persists panel topology, bend parameters, mechanical join features, and cut profiles across all MCP tool calls. The B-Rep geometry is a derivative, computed on demand by a **Geometry Solve** that traverses dirty nodes in topological order once per user action. This enables deterministic flat-pattern computation from stored graph parameters (no B-Rep re-inference), synchronous DRC before heavy geometry work, foldability validation, and structured fabrication-sequence querying by AI agents.

**Technical approach**: Pure TypeScript in the Manufacturing Domain bounded context (`ts/src/manufacturing/`). No new C++ code. The graph layer wraps existing C++ tools (`splitBodyByBends`, `mergeBodiesWithBend`, `unfoldShell`, `fuseBodies`) via the existing NAPI binding. New MCP tools are registered in `ts/src/mcp/tools.ts`.

## Technical Context

**Language/Version**: TypeScript 5.x (Manufacturing Domain + MCP Protocol Layer); C++ 17 (existing geometry engine — no new C++ code this feature)

**Primary Dependencies**: Node.js 20 LTS; NAPI geometry addon (`cpp/build/Release/geometry_addon.node`); Vitest (unit tests); existing `ts/src/geometry/binding.ts` NAPI wrapper; `004-transaction-primitive` (prerequisite, must be merged before atomic rollback stories)

**Storage**: In-memory only (TypeScript process heap). No Dolt, no file I/O. **Known limitation**: graph lost on process restart — persistence deferred to a future spec.

**Testing**: Vitest (unit + integration); existing `cpp/build/Release/geometry_tests.exe` (C++ regression — no changes required); new unit tests in `ts/tests/manufacturing/graph/`; new integration tests in `ts/tests/integration/`

**Target Platform**: Local stdio MCP server (Node.js, Claude Desktop compatible)

**Project Type**: MCP server library — new domain layer within an existing codebase

**Performance Goals**: `solve_geometry` on ≤100 dirty nodes in < 3 s; `check_foldability` on ≤20 panels in < 200 ms; bootstrap + 2 `add_bend` + DXF export in < 5 s for ≤20 panels

**Constraints**: Single-session only (no multi-session concurrency); in-memory only; all mutations atomic with rollback token (`004` integration); DRC synchronous at mutation time (never reaches C++ engine on violation)

**Scale/Scope**: Single active Manufacturing Graph per session; up to ~100 nodes targeted for batch Solve; spec defines 8 user stories, 23 FRs, 12 SCs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Deterministic Geometry Intelligence | ✅ PASS | All BA computation uses the explicit stored formula; no approximation. DRC gates geometry execution — the C++ engine never sees an invalid parameter. |
| II. Bounded Context Separation | ✅ PASS | Manufacturing Graph lives entirely in `ts/src/manufacturing/graph/`. B-Rep primitives (body IDs) cross the boundary only as opaque string references; no OCCT types leak into the domain layer. |
| III. Safety Filter Enforcement | ✅ PASS | Not directly applicable (no `fire_rated` / adhesive joints in this feature). DRC foldability + bend radius checks play the equivalent safety gate role for sheet metal. |
| IV. Rollback-First State Management | ✅ PASS | FR-007 + FR-021 + FR-023 all specify transaction primitive integration. Every mutation produces a rollback token; graph + geometry roll back together atomically. |
| V. Kerf Compensation is Mandatory | ✅ PASS | Not directly applicable to bend geometry. CutNode profiles are caller-defined dimensions; no kerf is auto-applied at this layer (cut-tool kerf is a separate manufacturing concern). |
| VI. Structured Errors Always | ✅ PASS | All error codes defined in spec (`NODE_ID_ALREADY_EXISTS`, `DRC_BEND_RADIUS_VIOLATION`, `SOLVE_FAILED`, `GEOMETRY_STALE`, `REMOVE_WOULD_ORPHAN_NODES`, etc.). Error wrapper in `ts/src/mcp/errors.ts` must be used. |
| VII. MVP Scope Discipline | ✅ PASS | In-memory only; no cloud APIs; no multi-session concurrency; no Dolt persistence; single graph per session. Persistence explicitly deferred. |
| VIII. Configuration Over Hard-Coding | ✅ PASS | K-factor, min bend radius, coplanarity threshold all loaded from `config/config.yaml`. No manufacturing parameters hard-coded. |
| IX. Async Export Contract | ✅ PASS | Not applicable — no new export jobs introduced. Existing `unfoldShell` + DXF path is unchanged. |
| X. Graceful Failure Over Silent Fallbacks | ✅ PASS | `GEOMETRY_STALE` warning required when returning stale values. `SOLVE_FAILED` + full rollback on partial Solve failure. No silent fallbacks permitted. |

**Constitution verdict: ALL GATES PASS. Phase 0 may proceed.**

## Project Structure

### Documentation (this feature)

```text
specs/009-manufacturing-graph/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── mcp-tools.md     # MCP tool schemas for all new graph tools
│   └── graph-events.md  # Internal event contracts (dirty marking, Solve result)
└── tasks.md             # Phase 2 output (generated by /speckit.tasks)
```

### Source Code (repository root)

```text
ts/src/manufacturing/
├── graph/
│   ├── types.ts          # PanelNode, BendNode, JoinNode, CutNode, ManufacturingGraph
│   ├── graph.ts          # ManufacturingGraph class — add/update/remove/query
│   ├── solver.ts         # Geometry Solve — dirty traversal, topological order, rollback
│   ├── drc.ts            # Design Rule Checks (bend radius, flange width, accessibility)
│   ├── foldability.ts    # Foldability check — accessibility state machine
│   ├── bootstrap.ts      # STEP → graph bootstrap (calls splitBodyByBends via NAPI)
│   └── index.ts          # Public exports for this sub-module
├── [existing files unchanged]
│   ├── assembly.ts
│   ├── bend_sequence.ts
│   ├── bom.ts
│   ├── material.ts
│   └── rules.ts

ts/src/mcp/
├── tools.ts              # New MCP tools registered here (add_bend, add_join, add_cut,
│                         # update_node, remove_node, solve_geometry, check_foldability,
│                         # query_graph, reset_graph, bootstrap_graph)
├── [existing files unchanged]

ts/tests/
├── manufacturing/
│   └── graph/
│       ├── graph.test.ts
│       ├── solver.test.ts
│       ├── drc.test.ts
│       ├── foldability.test.ts
│       └── bootstrap.test.ts
├── integration/
│   └── graph-workflow.test.ts   # end-to-end: bootstrap → add_bend → DXF
├── contracts/
│   └── graph-tools.test.ts      # contract tests for all new MCP tool schemas
```

**Structure Decision**: Single TypeScript project; new `ts/src/manufacturing/graph/` sub-module; no new C++ code; no new top-level directories.

## Complexity Tracking

> No constitution violations — no entries required.
