# Feature Specification: Graph-Driven Geometry Pipeline

**Feature Branch**: `011-graph-driven-geometry`

**Created**: 2026-06-08

**Status**: Draft

**Input**: User description: "The geometric pipeline is not correctly in place. All geometry displayed in the viewport must be constructions from the manufacturing plan. This is fundamental to creating trust in the platform and defines the manufacturing graph as the source of truth."

## Current Implementation State

**Already complete and working** ✅:
- Kerf compensation (Principle V) — joint synthesis with 0.1–0.2 mm offsets
- Fuse bodies — Boolean union with manufacturing graph integration
- Merge-by-bend — graph stitching (has edge-alignment bug, see BUG-02)
- Geometric pipeline primitives — `buildSheetFromDxf`, `thickenSheet`, `applyBend`
- Manufacturing graph structure — `PanelNode`, `BendNode`, `shapeDxf`

**Broken / non-compliant** ❌:
- **BUG-01**: `split_body_by_bends` creates the manufacturing graph but does NOT rebuild 3D geometry through the geometric pipeline
- **BUG-02**: `split_body_by_bends` cannot decompose non-rectangular flat patterns — panels are forced into axis-aligned rectangles
- **BUG-03**: `merge_bodies_with_bend` fails when the edges of the two 3D parts are offset or misaligned in world space

**Missing** 🔲:
- Bidirectional 3D-to-2D coordinate mapping: 3D viewport point ↔ XY position in DXF flat pattern

## Clarifications

### Session 2026-06-08

- Q: How should the system handle manufacturing graph corruption or desynchronisation with the DXF? → A: Fail-fast with detailed diagnostics — detect during geometry rebuild, reject the operation, and surface inconsistency to the user with repair options (recompute graph from DXF, or revert last mutation).
- Q: Should geometry rebuild be synchronous (blocking) or asynchronous? → A: Asynchronous with optimistic updates — operation returns immediately; rebuild runs in background; viewport updates when complete. Users may briefly see cached (pre-mutation) geometry.
- Q: Which mutation types are in Phase 1 scope? → A: Split-by-bends, merge-by-bend, modify bend parameters only. Fuse, trim, and flange additions are already working or explicitly deferred; no new work needed on those.
- Q: How does coordinate mapping support manufacturing graph editing? → A: Bidirectional — a 3D click maps to a DXF coordinate so the UI can identify which panel/edge/region the user is acting on; a DXF coordinate maps back to 3D so changes to the flat pattern can be reflected in the viewport. Both directions are required.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Split-by-Bends Rebuilds 3D Geometry (Priority: P1)

An engineer splits a sheet metal part at its bend lines. They see the resulting sub-parts in the viewport immediately. The geometry is reconstructed from the manufacturing graph that was just created — not left over from the original solid. For an L-shaped or T-shaped part, the individual flat panels are complex polygons, not simplified rectangles.

**Why this priority**: This is the primary compliance gap. Until split rebuilds from the graph, the platform cannot claim the graph is the source of truth.

**Independent Test**: Execute `split_body_by_bends` on a sample part; confirm each sub-part's 3D geometry is produced by the pipeline from its `shapeDxf`; confirm a non-rectangular panel (e.g., trapezoidal flange) is correctly shaped, not forced into a bounding rectangle.

**Acceptance Scenarios**:

1. **Given** a sheet metal part with at least one bend line, **When** `split_body_by_bends` executes, **Then** each sub-part has a manufacturing graph with `shapeDxf` seeded, AND 3D geometry is rebuilt via `buildSheetFromDxf → thickenSheet → applyBend` before the tool returns its result.
2. **Given** a part whose flat pattern contains a non-rectangular panel (L-shape, trapezoidal, polygon), **When** split executes, **Then** the resulting `shapeDxf` captures the true outline of that panel, not a bounding-box approximation.
3. **Given** the split has completed, **When** an MCP client queries the part geometry, **Then** the returned shell is derived from the manufacturing graph and is geometrically consistent with it.

---

### User Story 2 — Merge-by-Bend Handles Edge Misalignment (Priority: P1)

An engineer merges two sub-parts by specifying a bend between them. The edges of the two 3D parts are not perfectly co-located in world space (they have an offset, perhaps from prior operations or snapping tolerances). The system detects the misalignment, auto-corrects the alignment if it is within a configurable tolerance, or reports a clear error with the measured offset so the engineer can adjust.

**Why this priority**: Merge-by-bend fails silently or produces broken geometry today. Engineers encounter this whenever they work with parts that have been moved or snapped imprecisely.

**Independent Test**: Execute `merge_bodies_with_bend` on two parts whose shared edge is offset by 0.5 mm; confirm either successful auto-correction and a valid rebuilt shell, or a structured error that names the panels and measures the gap.

**Acceptance Scenarios**:

1. **Given** two sub-parts whose shared edge is offset by ≤ 2 mm, **When** `merge_bodies_with_bend` is called, **Then** the system projects one edge onto the other, merges the manufacturing graphs, and rebuilds the combined 3D shell through the pipeline.
2. **Given** two sub-parts whose shared edge offset exceeds the correction threshold, **When** merge is attempted, **Then** the operation is rejected with a structured error stating the measured offset, the threshold, and the suggested correction.
3. **Given** a successful merge, **When** the combined shell is returned, **Then** the geometry is continuous at the join — no gaps, overlaps, or T-intersections.

---

### User Story 3 — Bidirectional 3D-to-2D Coordinate Mapping (Priority: P1)

An engineer works in a 3D viewport and clicks on a face or edge of a sheet metal part. The system resolves that 3D point to the corresponding XY position in the part's 2D DXF flat pattern, identifying which panel the point belongs to and its local 2D coordinates. Conversely, when the engineer selects a region in the flat pattern, the system returns the 3D bounding region on the folded shell. This mapping is used by MCP tools and UI clients to direct manufacturing graph edits from spatial user actions.

**Why this priority**: Without this mapping, interactive editing of the manufacturing graph is blind — users cannot tell which part of the graph corresponds to a 3D selection, and changes to the flat pattern cannot be previewed in 3D.

**Independent Test**: For a known part, map a 3D point (e.g., corner of a panel face) to 2D; verify the result is within 0.1 mm of the expected DXF coordinate. Then map that 2D point back; verify the returned 3D point is within 0.1 mm of the original.

**Acceptance Scenarios**:

1. **Given** a part with a manufacturing graph, **When** a 3D world-space point on a panel face is provided, **Then** the system returns the panel ID, the 2D XY coordinate in the DXF flat pattern, and the mapping error estimate.
2. **Given** a 2D DXF coordinate and a panel ID, **When** the reverse mapping is requested, **Then** the system returns the 3D world-space point on the folded shell corresponding to that flat-pattern location.
3. **Given** a part with multiple panels and complex non-rectangular shapes, **When** 3D-to-2D mapping is requested for a point on a non-rectangular panel, **Then** the mapping is accurate to ≤ 0.1 mm.
4. **Given** a 3D point that does not lie on any panel surface, **When** mapping is attempted, **Then** the system returns a structured error naming the nearest panel and its distance from the point.

---

### User Story 4 — Full Pipeline Compliance Enforced (Priority: P2)

After the bugs above are fixed, every supported mutation on a manufacturing-graph part (split, merge, bend-param modify) rebuilds the 3D geometry through the pipeline before returning. No mutation path bypasses the pipeline. Mutations on parts without a manufacturing graph behave as before.

**Why this priority**: This is the systemic constraint that ensures the bugs cannot regress and that future mutations inherit the correct behaviour.

**Independent Test**: Execute 10 sequential supported mutations; verify via graph inspection that each result derives from the pipeline, with no stale or cached geometry carried forward.

**Acceptance Scenarios**:

1. **Given** any supported mutation on a part with a manufacturing graph, **When** the mutation completes, **Then** the shell returned is provably derived from the pipeline (pipeline call recorded in operation log).
2. **Given** an unsupported mutation (e.g., arbitrary boolean subtraction) on a manufacturing-graph part, **When** attempted, **Then** the system returns a structured error and the graph is not mutated.
3. **Given** 10+ sequential mutations, **When** engineer inspects parts after each, **Then** geometry is consistent with manufacturing graph throughout — no intermediate corrupt states.

---

### Edge Cases

- Non-planar faces in split input → reject operation with a structured error naming the offending face.
- Incompatible materials in merge → reject before graph mutation with a structured error.
- 3D mapping point lies on a bend zone (between two panels) → return both panel candidates with their respective distances and 2D coordinates.
- Graph/DXF divergence detected during rebuild → fail-fast; surface repair options (recompute DXF from graph, or revert mutation).
- Merge edge offset exactly at threshold → apply correction; log the adjustment in the operation result.

## Requirements *(mandatory)*

### Functional Requirements

**Bug Fixes**

- **FR-001**: `split_body_by_bends` MUST rebuild 3D geometry for each sub-part via the geometric pipeline (`buildSheetFromDxf → thickenSheet → applyBend`) before returning its result. (Fixes BUG-01.)
- **FR-002**: `split_body_by_bends` MUST capture the true outline of each split panel in `shapeDxf`, including non-rectangular and complex polygon shapes. (Fixes BUG-02.)
- **FR-003**: `merge_bodies_with_bend` MUST detect edge misalignment between the two input parts and either auto-correct if the offset is within a configurable tolerance (default: 2 mm), or return a structured error with the measured offset. (Fixes BUG-03.)

**Coordinate Mapping**

- **FR-004**: System MUST provide a `map_3d_to_2d` operation that accepts a 3D world-space point and returns: the panel ID, the XY coordinate in the DXF flat pattern, and the mapping error.
- **FR-005**: System MUST provide a `map_2d_to_3d` operation that accepts a panel ID and a 2D DXF coordinate and returns the corresponding 3D world-space point on the folded shell.
- **FR-006**: Both mapping operations MUST be accurate to ≤ 0.1 mm for planar panels of any shape.
- **FR-007**: `map_3d_to_2d` MUST return a structured error when the input point does not lie on any panel surface, including the nearest panel and its distance.
- **FR-008**: Coordinate mappings MUST remain valid (or be re-computed) after any geometry rebuild triggered by a mutation.

**Pipeline Compliance**

- **FR-009**: Every supported mutation on a manufacturing-graph part (split, merge, bend-param modify) MUST invoke the geometric pipeline and return the rebuilt shell. No mutation may return geometry derived from a pre-mutation cache.
- **FR-010**: Graph/DXF consistency MUST be validated at the end of each rebuild. Divergence MUST fail the operation with repair options, not produce silently incorrect geometry.
- **FR-011**: Unsupported mutations on manufacturing-graph parts MUST be rejected with a structured error identifying the unsupported operation and listing supported alternatives.

**Error Handling**

- **FR-012**: All error responses MUST follow the structured JSON model (`code`, `message`, `recoverable`, `suggested_tool`).
- **FR-013**: Rebuild failures MUST present user-actionable repair options (recompute DXF from graph; revert mutation).

### Key Entities

- **Manufacturing Graph**: Authoritative structure for a sheet metal part — `PanelNode` (with `shapeDxf`), `BendNode` (with angle, radius, K-factor), relationships.
- **DXF Representation (`shapeDxf`)**: The 2D flat-pattern outline stored on a `PanelNode`; source for 3D reconstruction via pipeline.
- **Geometric Pipeline**: `buildSheetFromDxf → thickenSheet → applyBend` — the only permitted path for constructing 3D geometry from a manufacturing-graph part.
- **3D-to-2D Coordinate Map**: A computed bijection between 3D world-space points on a folded panel surface and XY coordinates in its DXF flat pattern.
- **Edge Alignment**: The condition where the shared edges of two panels to be merged lie at the same 3D position within tolerance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `split_body_by_bends` produces pipeline-derived geometry for 100% of operations, including non-rectangular panels. Zero cases of bounding-box approximation.
- **SC-002**: `merge_bodies_with_bend` succeeds (or reports a structured error) for all test cases with edge offsets from 0 to 5 mm. Zero silent failures.
- **SC-003**: `map_3d_to_2d` and `map_2d_to_3d` achieve ≤ 0.1 mm round-trip error for all panel shapes present in the test fixture library.
- **SC-004**: 100% of supported mutations on manufacturing-graph parts return pipeline-derived geometry (verifiable via operation log).
- **SC-005**: All known bugs (BUG-01, BUG-02, BUG-03) are resolved and covered by regression tests that will catch recurrence.
- **SC-006**: Geometry rebuild completes within 2 seconds for parts with up to 100 panels on standard hardware.
- **SC-007**: All error conditions surface structured JSON errors within 500 ms; no unhandled exceptions propagate to MCP clients.

## Assumptions

- Kerf compensation, fuse bodies, and the core geometric pipeline primitives are implemented and working; no changes to those are required.
- `shapeDxf` already exists on `PanelNode`; the fix for BUG-02 is to ensure the correct polygon outline is written into it, not to add a new field.
- The edge-alignment tolerance for merge (default 2 mm) can be tuned via a configuration constant; hard-coding for MVP is acceptable, but the constant must be named and not an inline magic number.
- Coordinate mapping is computed analytically from the manufacturing graph (panel transform matrices and bend geometry); no additional C++ NAPI extension is required if the data is already available in TypeScript.
- If the mapping requires data not yet surfaced through the NAPI layer (e.g., face transform matrices), a minimal NAPI extension is acceptable.
- Async rebuild (operations return immediately; rebuild in background) applies to all three bug-fix scenarios; the rebuild queue design from the clarification session holds.
- Coordinate mappings are re-computed on demand after a rebuild; they are not cached between mutations.
