# Implementation Plan: MCP Tools Gap Closure

**Branch**: `002-mcp-tools-gap` | **Date**: 2026-05-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-mcp-tools-gap/spec.md`

---

## Summary

Adds ten new MCP tools to align the implementation with the MCP Tools specification v5.0. Tools span four categories: diagnostics (`compute_intersections`, `compute_gaps`, `check_boundary_compliance`), direct modeling (`trim_body_with_plane`, `extend_face_to_target`, `offset_face`), topology (`split_body_by_plane`, `merge_bodies_with_bend`), and sheet metal detailing (`add_flange`, `rip_edge`). Work is phased: four tools are unblocked (post-INF-03 gate), six are deferred to a second increment after the MVP integration test passes.

---

## Technical Context

**Language/Version**: C++ (Geometry Engine, OCCT facade), TypeScript (MCP Protocol Layer, Manufacturing Domain), Node.js LTS 22.x

**Primary Dependencies**: OCCT 7.8.x (via vcpkg), NAPI via cmake-js, @modelcontextprotocol/sdk, Vitest, Catch2

**Storage**: In-memory, session-scoped only (D3-A — no change)

**Testing**: Vitest (TypeScript), Catch2 (C++), integration tests against real STEP fixtures

**Target Platform**: Node.js LTS 22.x + Ubuntu 22.04 Docker (no change)

**Project Type**: MCP server exposing a deterministic Geometry Intelligence Layer

**Performance Goals**: Non-mutating diagnostics < 100 ms; geometry mutations < 1 s (single-session, in-process)

**Constraints**: Every mutating tool must snapshot before executing (Constitution Principle IV); structured errors always (Principle VI); logistics config via MCP resources, not hardcoded (Principle VIII)

**Scale/Scope**: Single-session, 10 new tools, ~9 new C++ virtual methods, ~130 new lines in TypeScript dispatch layer

---

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Deterministic | PASS | All new ops are OCCT kernel calls |
| II. Bounded Contexts | PASS | C++ ops in GeometryService; compliance check in MCP/Manufacturing layer |
| III. Safety Filter | PASS | No new joint types |
| IV. Rollback-First | PASS | FR-111 mandates snapshot for all mutating tools |
| V. Kerf | PASS | No new joint geometry |
| VI. Structured Errors | PASS | New error codes follow existing pattern |
| VII. MVP Scope | PASS — gate removed | All 10 tools are MVP scope per user decision 2026-05-17; INF-03 gate no longer applies |
| VIII. Config | PASS | Logistics envelope read from config |
| IX. Async Export | PASS | No changes to export pipeline |

---

## Project Structure

### Documentation (this feature)

```text
specs/002-mcp-tools-gap/
├── plan.md                         # This file
├── spec.md                         # Feature specification
├── research.md                     # Phase 0: OCCT API mapping + scope gate
├── data-model.md                   # Phase 1: New types (ClashReport, GapReport, etc.)
├── quickstart.md                   # Phase 1: Summary of files and testing
├── contracts/
│   ├── mcp-tools-extended.md       # Phase 1: Input/output schemas for 10 new tools
│   └── geometry-port-extended.md   # Phase 1: C++ and TypeScript interface additions
├── checklists/
│   └── requirements.md             # Spec quality checklist
└── tasks.md                        # Phase 2 output (/speckit-tasks — NOT yet created)
```

### Source Code (additions only)

```text
cpp/src/geometry/
├── geometry_service.hpp            # +9 new virtual methods
└── geometry_service.cc             # +9 new OCCT implementations

ts/src/geometry/
├── types.ts                        # +ClashReport, GapReport, TrimBodyResult,
│                                   #  SplitBodyResult, ExtendFaceResult,
│                                   #  OffsetFaceResult, AddFlangeResult,
│                                   #  RipEdgeResult, MergeBodyResult, CuttingPlane
└── binding.ts                      # +9 GeometryAddon interface entries
                                    # +9 GeometryBinding wrapper methods

ts/src/mcp/
└── tools.ts                        # +10 tool definitions, +10 handler functions

Engineering-Design.md               # §3.4 error codes: +12 new codes
```

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| 9 new C++ virtual methods | Each geometry operation is a distinct OCCT API call requiring its own result type | Bundling operations would violate the MCP spec v5.0 tool surface and prevent the AI agent from using granular rollback tokens |
| Phase D / post-INF-03 split | Constitution Principle VII prohibits scope expansion before INF-03 passes | Deferring all 10 tools to post-INF-03 would leave the AI agent unable to detect clashes or gaps in the current MVP phase |
