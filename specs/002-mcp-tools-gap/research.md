# Research: MCP Tools Gap Closure

**Phase**: Phase 0 | **Feature**: 002-mcp-tools-gap | **Date**: 2026-05-17

---

## Summary

All technical decisions are pre-resolved by the constitution and engineering design. No external research was required. This document consolidates the OCCT API surface for the ten new tools and records the MVP scope gate decision.

---

## 1. OCCT API Mapping

### Non-Mutating Diagnostics (no snapshot required)

| Tool | OCCT API | Notes |
|---|---|---|
| `compute_intersections` | `BRepAlgoAPI_Common` on each pair; `Bnd_Box` for bounding box | If common shape is non-empty → clash. Volume from `GProp_GProps`. |
| `compute_gaps` | `BRep_DistShapeShape` | Returns minimum distance and closest sub-shape references. Non-mutating, no snapshot. |
| `check_boundary_compliance` | `getTopology()` bounding box vs. `logistics://` config | Entirely TypeScript layer — no new C++ method needed. |

### Direct Modeling Mutations (snapshot required)

| Tool | OCCT API | Notes |
|---|---|---|
| `trim_body_with_plane` | `BRepAlgoAPI_Cut` with `BRepPrimAPI_MakeHalfSpace` cutter | Half-space = infinite solid on one side of the plane. Reuses existing `booleanCut` path. |
| `split_body_by_plane` | Two `BRepAlgoAPI_Cut` calls (positive + negative half-space) | Register both children with caller-supplied names. |
| `extend_face_to_target` | `BRepOffsetAPI_MakeOffset` on target face + `BRepAlgoAPI_Common` | Moves face along its normal until it intersects the target. |
| `offset_face` | `BRepOffsetAPI_MakeOffset` on single face | Positive = add material; negative = remove material. |
| `add_flange` | Extrude along open edge normal at given angle + `BRepAlgoAPI_Fuse` | New face created from edge sweep; fused into parent shell. |
| `rip_edge` | `BRep_Builder::Remove` on shared edge | Removes the topological link between adjacent faces to permit unfolding. |
| `merge_bodies_with_bend` | `BRepAlgoAPI_Fuse` + cylindrical surface insertion at junction | Complex: fuse both shells then replace sharp junction with cylindrical bend surface. |

---

## 2. MVP Scope Gate (Constitution Principle VII)

**Decision**: Phase the implementation in two increments.

**Phase D Extension (unblocked — proceed after INF-03 passes):**
- `compute_intersections`
- `compute_gaps`
- `check_boundary_compliance`
- `trim_body_with_plane` (reuses existing `booleanCut` infrastructure)

**Post-INF-03 (gated until MVP integration test passes):**
- `split_body_by_plane`
- `extend_face_to_target`
- `offset_face`
- `add_flange`
- `rip_edge`
- `merge_bodies_with_bend`

**Rationale**: The constitution (Principle VII) prohibits scope expansion before INF-03 passes. Diagnostic tools and `trim_body_with_plane` are non-breaking additions that extend, not change, the existing tool registry. The remaining six are complex new geometry mutations that belong in a dedicated post-MVP increment.

---

## 3. New Error Codes

These codes extend the error registry in `Engineering-Design.md §3.4`:

| Code | Meaning | Recoverable |
|---|---|---|
| `GE_CLASH_DETECTION_FAILED` | `BRepAlgoAPI_Common` raised an exception | No |
| `GE_GAP_DETECTION_FAILED` | `BRep_DistShapeShape` raised an exception | No |
| `GE_TRIM_FAILED` | Half-space cut produced empty result | Maybe |
| `GE_SPLIT_FAILED` | One or both halves of a split are empty | Maybe |
| `GE_EXTEND_FAILED` | Face extension produced self-intersection | Maybe |
| `GE_OFFSET_FAILED` | Face offset produced invalid geometry | Maybe |
| `GE_FLANGE_FAILED` | Flange extrusion failed | Maybe |
| `GE_EDGE_NOT_OPEN` | `add_flange` called on a non-boundary edge | No — fix input |
| `GE_RIP_FAILED` | Edge removal produced invalid topology | No |
| `GE_EDGE_NOT_INTERIOR` | `rip_edge` called on a boundary edge | No — fix input |
| `GE_MERGE_FAILED` | Body fusion produced non-manifold result | Maybe |
| `MD_LOGISTICS_NOT_CONFIGURED` | `check_boundary_compliance` requested but envelope not in config | No — fix config |

---

## 4. Alternatives Considered

| Decision | Alternative | Rejected Because |
|---|---|---|
| `check_boundary_compliance` in C++ | Read bounding box in C++, compare there | Logistics config lives in TypeScript Manufacturing Domain; adding a config dependency to C++ would violate Principle II (bounded context separation). |
| `trim_body_with_plane` as new C++ method | Wrap entirely in a new `trimBody` method | The existing `booleanCut` already accepts a cutting plane; a TypeScript-layer adapter that constructs the half-space cutter is sufficient and avoids C++ code duplication. |
| `compute_intersections` without volume | Return boolean only | The MCP Tools spec v5.0 requires intersection volume and bounding box for the AI agent to decide the correct cutting plane; omitting them would force additional tool calls. |
