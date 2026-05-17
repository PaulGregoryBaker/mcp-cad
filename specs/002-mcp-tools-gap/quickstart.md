# Quickstart: MCP Tools Gap Closure

**Feature**: 002-mcp-tools-gap | **Date**: 2026-05-17

---

## What This Feature Adds

Ten new MCP tools that align the implementation with the MCP Tools specification v5.0. The tools are phased to respect the MVP scope gate (Constitution Principle VII).

---

## Phase D Extension — Unblocked (implement after INF-03 passes)

| Tool | Category | New Layer Work |
|---|---|---|
| `compute_intersections` | Diagnostics | C++ method + TypeScript binding + tool handler |
| `compute_gaps` | Diagnostics | C++ method + TypeScript binding + tool handler |
| `check_boundary_compliance` | Logistics | TypeScript only (reads topology + logistics config) |
| `trim_body_with_plane` | Direct Modeling | C++ method + TypeScript binding + tool handler |

## Post-INF-03 Increment

| Tool | Category | New Layer Work |
|---|---|---|
| `split_body_by_plane` | Topology | C++ method + TypeScript binding + tool handler |
| `extend_face_to_target` | Direct Modeling | C++ method + TypeScript binding + tool handler |
| `offset_face` | Direct Modeling | C++ method + TypeScript binding + tool handler |
| `add_flange` | Sheet Metal | C++ method + TypeScript binding + tool handler |
| `rip_edge` | Sheet Metal | C++ method + TypeScript binding + tool handler |
| `merge_bodies_with_bend` | Topology | C++ method + TypeScript binding + tool handler |

---

## Files Modified / Created Per Increment

### Phase D Extension

| File | Change |
|---|---|
| `cpp/src/geometry/geometry_service.hpp` | Add `computeIntersections`, `computeGaps`, `trimBodyWithPlane` virtual methods |
| `cpp/src/geometry/geometry_service.cc` | Implement the three new methods using OCCT |
| `ts/src/geometry/types.ts` | Add `ClashReport`, `GapReport`, `TrimBodyResult` types |
| `ts/src/geometry/binding.ts` | Add `GeometryAddon` interface entries + `GeometryBinding` wrappers |
| `ts/src/mcp/tools.ts` | Add tool definitions and handlers for 4 new tools |
| `Engineering-Design.md §3.4` | Add 4 new error codes (`GE_CLASH_DETECTION_FAILED`, `GE_GAP_DETECTION_FAILED`, `GE_TRIM_FAILED`, `MD_LOGISTICS_NOT_CONFIGURED`) |

### Post-INF-03 Increment

Same pattern for the remaining 6 tools plus their result types and error codes.

---

## Testing Requirements

### Phase D Extension

- **Unit (Vitest)**: Mock `GeometryAddon` returning a known `ClashReport`; assert tool handler serializes it correctly.
- **Integration (Catch2 + real STEP)**: Load two overlapping panels from `tests/fixtures/`; call `computeIntersections`; assert non-empty clash volume.
- **Integration**: Load two separated panels; call `computeGaps`; assert minimum distance matches known fixture gap.
- **Integration**: Call `trimBodyWithPlane` on a known panel; assert resulting shell has fewer faces.
- **TypeScript unit**: Call `check_boundary_compliance` with a panel bounding box exceeding the configured shipping envelope; assert `compliant: false` with correct axis violation.

### Post-INF-03 Increment

- **Round-trip rollback test** for each mutating tool: mutate → rollback → assert state restored.
- `add_flange` on boundary edge succeeds; on interior edge returns `GE_EDGE_NOT_OPEN`.
- `rip_edge` on interior edge succeeds; on boundary edge returns `GE_EDGE_NOT_INTERIOR`.
- `apply_unfold` succeeds after `rip_edge` where it previously failed.

---

## No-Change Surfaces

- MCP transport (stdio) — unchanged
- Session lifecycle — unchanged
- Export pipeline — unchanged
- Manufacturing rules engine — unchanged (except reading logistics config for compliance check)
- Rollback registry — no structural changes; new mutating tools call existing `createSnapshot`
