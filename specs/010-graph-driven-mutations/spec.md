# Feature Specification: Graph-Driven Object Mutations

**Feature Branch**: `010-graph-driven-mutations`

**Created**: 2026-06-05

**Status**: Draft

## Context

The manufacturing graph is the source of truth for all part geometry **for any part that has a manufacturing graph**. Parts without a graph (e.g. raw imported solids before `split_body_by_bends`) may still be mutated directly via the C++ engine. Currently, mutation operations (merge_bodies_with_bend, fuse_bodies, trim, etc.) call the C++ geometry engine first — passing raw shell UUIDs — and then update the manufacturing graph as a side-effect. This is architecturally inverted.

The correct architecture is:
1. **Mutate the graph** — add/update nodes (PanelNode, BendNode, CutNode) and recompute the DXF flat pattern
2. **Derive the 3D geometry from the graph** — the C++ engine receives a description (flat pattern + bend specification), not raw bodies to boolean-fuse

Once the manufacturing graph exists and is stable for a part, it becomes the **only** valid way to mutate that part. Direct C++ boolean operations on raw shells belonging to a graph-tracked part are no longer valid mutation paths.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Graph-First Merge with Bend (Priority: P1)

A user merges two adjacent sheet-metal panels at a 90° bend. The system updates the manufacturing graph — adding a BendNode and computing the merged DXF flat pattern — before generating a new 3D solid from the graph description.

**Why this priority**: This is the primary mutation operation exposed by the UI (merge_bodies_with_bend). It is the canonical case that proves the graph-first architecture end-to-end.

**Independent Test**: After merge, `apply_unfold` on the merged panel must return a DXF outline whose bounding box equals the sum of both panel footprints plus bend allowance. The 3D solid must match (same dimensions, correct bend geometry).

**Acceptance Scenarios**:

1. **Given** two 200×200mm panels with valid shapeDxf, **When** `merge_bodies_with_bend` is called, **Then** the graph is updated first (BendNode created, merged shapeDxf written), before any C++ geometry call is made
2. **Given** the graph has been updated with the merged DXF, **When** the 3D solid is generated, **Then** the C++ engine receives a flat-pattern + bend specification (not two raw shell UUIDs to boolean-fuse)
3. **Given** a merge has completed, **When** `apply_unfold` is called on the merged part, **Then** the DXF outline width ≈ flatA + flatB + bend_allowance (not a single-panel width)
4. **Given** a merge is rolled back, **Then** the graph state is fully restored and the previous 3D solid is reinstated

---

### User Story 2 — Graph-First Fuse (Coplanar / In-Line Panels) (Priority: P2)

In sheet metal, a fuse means two regions of the **same continuous sheet** are being combined — no bend between them, same material thickness, coplanar faces. The result is a single flat panel whose outline is the geometric union of both inputs. The fuse operation is **only valid** when:

- Both panels have the same nominal thickness (within manufacturing tolerance)
- Both panels are coplanar (their face normals are parallel and their faces lie in the same plane)
- The resulting union forms a single connected flat region (no disjoint islands)

If any of these conditions are not met, the fuse MUST be rejected with a structured error. A fuse between panels at a bend angle, different thicknesses, or non-coplanar faces is not a fuse — it is a merge-with-bend and must use `merge_bodies_with_bend` instead.

**Why this priority**: Fuse is the secondary mutation path. Enforcing its sheet-metal semantics prevents silent geometry corruption when the wrong operation is chosen.

**Independent Test**: After fuse, `apply_unfold` DXF outline equals the geometric union of both panel outlines. Attempting to fuse panels of different thicknesses or at a bend angle returns a structured error.

**Acceptance Scenarios**:

1. **Given** two coplanar panels of equal thickness with valid shapeDxf, **When** `fuse_bodies` is called, **Then** the graph is updated (DXF union computed) before any C++ geometry call
2. **Given** fused DXF is 400×200, **When** 3D solid is generated from the graph, **Then** the solid has the correct combined footprint and a single uniform thickness
3. **Given** two panels with different nominal thicknesses (e.g. 1.5mm and 2.0mm), **When** `fuse_bodies` is called, **Then** the call is rejected with `GE_FUSE_THICKNESS_MISMATCH` before any graph or geometry mutation
4. **Given** two panels whose faces are not coplanar (e.g. at 90°), **When** `fuse_bodies` is called, **Then** the call is rejected with `GE_FUSE_NOT_COPLANAR` and a suggestion to use `merge_bodies_with_bend`
5. **Given** two panels that are coplanar but whose union would produce two disconnected islands (non-touching), **When** `fuse_bodies` is called, **Then** the call is rejected with `GE_FUSE_DISJOINT_RESULT`

---

### User Story 3 — Reject Mutation Without Graph (Priority: P1)

If a part has a manufacturing graph, any attempt to mutate it via raw C++ boolean operations (bypassing the graph) must be rejected with a clear error.

**Why this priority**: This is the enforcement mechanism. Without it, the graph drifts out of sync with geometry silently.

**Independent Test**: Call a C++ mutation directly with a shell UUID that belongs to a graph-tracked part — expect `GRAPH_INTEGRITY_ERROR`.

**Acceptance Scenarios**:

1. **Given** a shell UUID is tracked by a manufacturing graph, **When** any mutation tool is called with that UUID and no corresponding graph operation, **Then** the call is rejected with `GRAPH_INTEGRITY_ERROR` and a suggestion to use the graph-first path
2. **Given** a shell UUID is NOT tracked by any graph, **When** a raw mutation is called, **Then** it proceeds normally (backward-compatible with untracked geometry)

---

### User Story 4 — Rebuild Solid from Flat Pattern (Priority: P1)

The C++ engine gains a new entry point: given a DXF flat pattern and an ordered list of bend specifications, produce a 3D solid. This replaces the current boolean-union approach.

**Why this priority**: This is the C++ capability that makes graph-driven geometry possible. Without it, stories 1 and 2 cannot be implemented.

**Independent Test**: `buildShellFromFlatPattern(dxf, bendZones, thickness)` produces a 3D solid whose unfolded flat pattern matches the input DXF within tolerance.

**Acceptance Scenarios**:

1. **Given** a 400×200mm DXF with one bend zone at x=200, thickness=1.5mm, radius=1.0mm, angle=90°, **When** `buildShellFromFlatPattern` is called, **Then** the resulting 3D solid unfolds back to 400×200mm ±1mm
2. **Given** a DXF with no bend zones, **When** `buildShellFromFlatPattern` is called, **Then** the result is a flat panel of the correct footprint and thickness
3. **Given** an invalid DXF (no closed polyline), **When** `buildShellFromFlatPattern` is called, **Then** a structured error `GE_BUILD_FROM_PATTERN_FAILED` is returned

---

### Edge Cases

- What happens when the two panels have different thicknesses? → Reject with `GE_FUSE_THICKNESS_MISMATCH` before any mutation
- What if the panels are coplanar but their outlines do not touch or overlap? → Reject with `GE_FUSE_DISJOINT_RESULT`
- What if `fuse_bodies` is called on panels at a bend angle? → Reject with `GE_FUSE_NOT_COPLANAR` and suggest `merge_bodies_with_bend`
- What if the DXF flat pattern has a non-rectangular outline (L-shape, etc.)? → Must still produce a valid solid; bend zones reference offsets within that outline
- What if the graph has been dirtied by a failed mutation? → The graph must remain at its last clean state; no partial updates
- What if a panel has CutNodes (holes)? → Cuts must be preserved through merge and re-applied on the merged flat pattern
- Rollback: does graph state restore correctly after a failed buildShellFromFlatPattern call?

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST update the manufacturing graph (nodes + DXF) BEFORE calling any C++ geometry operation in `merge_bodies_with_bend`
- **FR-002**: System MUST update the manufacturing graph (nodes + DXF) BEFORE calling any C++ geometry operation in `fuse_bodies`
- **FR-002a**: `fuse_bodies` MUST reject any call where the two panels do not have equal nominal thickness (within 0.1mm tolerance), returning `GE_FUSE_THICKNESS_MISMATCH`
- **FR-002b**: `fuse_bodies` MUST reject any call where the two panels are not coplanar (face normals not parallel within 2°), returning `GE_FUSE_NOT_COPLANAR` with a suggestion to use `merge_bodies_with_bend`
- **FR-002c**: `fuse_bodies` MUST reject any call where the DXF union of both panels produces a disconnected (disjoint) result, returning `GE_FUSE_DISJOINT_RESULT`
- **FR-003**: The C++ engine MUST expose a `buildShellFromFlatPattern(dxfContent, bendZones[], thickness)` entry point that produces a 3D solid from a flat-pattern description
- **FR-004**: `merge_bodies_with_bend` MUST call `buildShellFromFlatPattern` (or equivalent) instead of `mergeBodiesWithBend` to generate the output solid
- **FR-005**: Any mutation tool operating on a shell UUID that is tracked by a manufacturing graph MUST reject the call if the corresponding graph operation has not been performed first
- **FR-006**: CutNodes (holes, slots) associated with merged panels MUST be preserved and re-applied to the merged flat pattern DXF before solid generation
- **FR-007**: Rollback MUST restore both the graph state and the 3D solid to their pre-mutation state atomically
- **FR-008**: The merged DXF (written to graph before solid generation) MUST be the single source used by `apply_unfold` — no re-derivation from C++ geometry

### Key Entities

- **PanelNode**: Graph node representing one flat panel. Has `shapeDxf` (canonical 2D outline), `flatWidth`, `flatHeight`, `nominalThickness`, `bodyId` (C++ shell UUID, derived from graph)
- **BendNode**: Graph node representing a bend joining two PanelNodes. Has `panelAId`, `panelBId`, `innerRadius`, `angle`, `kFactor`, `bendAllowance`
- **CutNode**: Graph node representing a hole/slot in a panel. Has `parentPanelId`, `profile` (circle, rect, polygon)
- **FlatPattern**: The merged DXF computed from PanelNodes + BendNodes. Carries the complete 2D outline with bend zone offsets. Input to `buildShellFromFlatPattern`
- **BendZone**: A region within the flat pattern where a bend is applied. Carries `offsetMm` (x-position in flat pattern), `widthMm` (bend allowance width), `angle`, `radius`, `kFactor`

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After `merge_bodies_with_bend`, the graph is in its updated state before any C++ call returns — verifiable by inspecting graph nodes at any point after the call
- **SC-002**: `apply_unfold` on a merged panel returns a DXF outline whose long dimension equals `flatA + flatB + bend_allowance` within 1mm tolerance
- **SC-003**: `buildShellFromFlatPattern` round-trips: unfold(buildShellFromFlatPattern(dxf, bends)) == dxf within 1mm tolerance
- **SC-004**: A shell UUID that belongs to a graph-tracked panel is rejected by raw mutation tools — 100% enforcement, zero silent bypasses
- **SC-006**: `fuse_bodies` called on panels of differing thickness returns `GE_FUSE_THICKNESS_MISMATCH` — 100% of the time, before any graph or geometry mutation
- **SC-007**: `fuse_bodies` called on non-coplanar panels returns `GE_FUSE_NOT_COPLANAR` with a `merge_bodies_with_bend` suggestion

---

## Assumptions

- The current C++ `mergeBodiesWithBend` (boolean union + fillet) remains available for the transition period and is called only as a fallback when `buildShellFromFlatPattern` is not yet available
- Bend angle is always 90° in the initial implementation; arbitrary angles are a future extension
- `buildShellFromFlatPattern` is implemented in C++ (OCCT) using the existing `BRepOffsetAPI_MakePipeShell` or equivalent OCCT re-folding primitives
- The manufacturing graph is always present for parts produced via `split_body_by_bends` or `clean_geometry` in the current codebase

---

## Out of Scope

- Arbitrary bend angles (non-90°) in `buildShellFromFlatPattern` — deferred to a subsequent spec
- Mutations other than `merge_bodies_with_bend` and `fuse_bodies` in this spec (trim, offset, extend are follow-on)
- GUI changes — this spec covers the MCP tool layer and C++ engine only
