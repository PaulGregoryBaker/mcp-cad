# Feature Specification: MCP Tools Gap Closure

**Feature Branch**: `002-mcp-tools-gap`

**Created**: 2026-05-17

**Status**: Draft

**Input**: Align the MCP Tools specification (v5.0) with the current contract and implementation by adding the ten missing tools: `split_body_by_plane`, `merge_bodies_with_bend`, `extend_face_to_target`, `trim_body_with_plane`, `offset_face`, `add_flange`, `rip_edge`, `compute_intersections`, `compute_gaps`, and `check_boundary_compliance`.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Direct Modeling: Resolve Clashes and Gaps (Priority: P1)

An AI agent decomposing a multi-panel sheet metal assembly detects that two panels physically intersect (a clash) and two others fall short of a common edge (a gap). The agent calls `compute_intersections` to locate the exact clash volume, then calls `trim_body_with_plane` to remove the overlapping material. It then calls `compute_gaps` to measure the open distance, and calls `extend_face_to_target` to close it. Finally it calls `offset_face` to fine-tune a wall thickness.

**Why this priority**: These three diagnostic-plus-correction pairs (`compute_intersections`/`trim_body_with_plane`, `compute_gaps`/`extend_face_to_target`, `offset_face`) form the core clash-resolution loop referenced in the Operational Execution Loop (Step 4A/4B of the spec). Without them the AI cannot self-correct geometry errors, which blocks all downstream work.

**Independent Test**: A STEP file with two known intersecting panels and one known gap can be ingested, the clash detected, trimmed, the gap measured, extended, and manufacturability re-evaluated — fully end-to-end without any other new tool.

**Acceptance Scenarios**:

1. **Given** two panels with a 5 mm interference volume, **When** `compute_intersections` is called with both panel IDs, **Then** the response includes `intersects: true`, the bounding box of the clash volume, and a suggested cutting plane.
2. **Given** a clash bounding box returned by `compute_intersections`, **When** `trim_body_with_plane` is called with the suggested cutting plane and `keep_side: "negative"`, **Then** the offending material is removed and a `rollback_token` is returned.
3. **Given** two panels separated by 4.2 mm, **When** `compute_gaps` is called with `max_distance_threshold: 25.0`, **Then** the response includes `has_gap: true`, the gap distance, closest face IDs, and the extension vector.
4. **Given** a gap report from `compute_gaps`, **When** `extend_face_to_target` is called with the closest face and the target face as target, **Then** the panel face is extended to touch the target and a `rollback_token` is returned.
5. **Given** a panel face that needs a 0.5 mm inward shift to achieve clearance fit, **When** `offset_face` is called with `distance: -0.5`, **Then** the face moves and a `rollback_token` is returned.

---

### User Story 2 — Body Topology: Split and Merge Panels (Priority: P2)

An AI agent needs to divide a large panel into two independent parts along a cutting plane (e.g., to respect a shipping envelope limit), and in a separate flow, fuse two adjacent flat sheets into a single component connected by a physical bend.

**Why this priority**: `split_body_by_plane` and `merge_bodies_with_bend` are topology-level operations that enable the AI to reconfigure the part count and assembly structure. They are referenced in the Macro-Topology workflow (Category B) and are prerequisites for advanced multi-panel designs.

**Independent Test**: A single-panel STEP can be split into two named bodies via `split_body_by_plane`; separately, two adjacent panels can be merged with a defined bend radius via `merge_bodies_with_bend` and the result verified to be a single manifold shell.

**Acceptance Scenarios**:

1. **Given** a loaded panel, **When** `split_body_by_plane` is called with a cutting plane and two output names, **Then** the system returns two new part IDs matching the provided names, both registered in the geometry session.
2. **Given** two panels sharing adjacent edges, **When** `merge_bodies_with_bend` is called with those panels, the target edge IDs, and a bend radius, **Then** the system returns a single merged shell ID with a rollback token.
3. **Given** a split operation, **When** `rollback` is called with the returned token, **Then** the original single panel is restored.

---

### User Story 3 — Sheet Metal Detailing: Add Flange and Rip Edge (Priority: P2)

An AI agent needs to add a 90° hem flange to an open raw edge of a sheet panel (to stiffen it or close a seam), and to rip an interior corner seam so the panel can unfold without self-intersection.

**Why this priority**: `add_flange` and `rip_edge` are standard sheet metal detailing operations in Category D of the spec. They are required before `apply_unfold` can produce a valid flat pattern for many common panel shapes.

**Independent Test**: A flat panel can have a flange added to one of its open edges; separately, a folded corner can have its seam ripped so `apply_unfold` succeeds where it previously failed.

**Acceptance Scenarios**:

1. **Given** a panel with an open straight edge, **When** `add_flange` is called with that edge ID, length 15 mm, angle 90°, and bend radius 1.5 mm, **Then** the panel is modified to include the new flange and a rollback token is returned.
2. **Given** a panel with a sharp interior corner, **When** `rip_edge` is called with that edge ID, **Then** the corner seam is opened and a rollback token is returned.
3. **Given** a panel after `rip_edge`, **When** `apply_unfold` is called, **Then** it succeeds where it previously would have returned `GE_UNFOLD_FAILED`.

---

### User Story 4 — Logistics Compliance: Check Boundary Compliance (Priority: P3)

An AI agent checks whether a panel or sub-assembly fits within the shipping crate envelope, the powder-coat oven dimensions, or the raw stock sheet constraints before proceeding to export.

**Why this priority**: `check_boundary_compliance` is a validation gate in the operational loop (Step 7). Without it the AI cannot autonomously determine whether a part needs to be re-split to meet logistics limits, but it can be added after the higher-priority geometry tools are in place.

**Independent Test**: A panel with known dimensions can be validated against a shipping envelope; a panel that exceeds limits returns `compliant: false` with specific axis violations.

**Acceptance Scenarios**:

1. **Given** a panel whose bounding box is 1200 × 800 × 50 mm and a shipping envelope of 1000 × 1000 × 100 mm, **When** `check_boundary_compliance` is called with `envelope_type: "shipping"`, **Then** the response includes `compliant: false` and the violated dimension.
2. **Given** a panel within all envelope limits, **When** `check_boundary_compliance` is called, **Then** the response includes `compliant: true`.

---

### Edge Cases

- What happens when `split_body_by_plane` produces an empty body on one side (cutting plane misses the solid)?
- What happens when `merge_bodies_with_bend` is called with non-adjacent edge IDs?
- What happens when `extend_face_to_target` would create a self-intersecting solid?
- What happens when `add_flange` is called on an interior (non-open) edge?
- What happens when `rip_edge` is called on an edge that is already ripped?
- What happens when `compute_intersections` is called with only one part ID?
- What happens when `check_boundary_compliance` references an envelope type that has no configured dimensions in `logistics://`?

---

## Requirements *(mandatory)*

### Functional Requirements

**Diagnostic Tools**

- **FR-101**: The system MUST expose `compute_intersections`, accepting an array of part IDs, and return a structured clash report including intersection volume, bounding box, and a suggested cutting plane for each clash pair found.
- **FR-102**: The system MUST expose `compute_gaps`, accepting two part IDs and a max distance threshold, and return the minimum gap distance, closest face references, and extension vector when a gap exists within the threshold.
- **FR-103**: The system MUST expose `check_boundary_compliance`, accepting a part or assembly ID and an envelope type (`shipping`, `coating`, `raw_stock`), and return a compliance flag plus per-axis violation details sourced from `logistics://` configuration.

**Direct Modeling Tools**

- **FR-104**: The system MUST expose `trim_body_with_plane`, accepting a part ID, a cutting plane (normal + origin), and a keep side, and must return a rollback token after removing the discarded half.
- **FR-105**: The system MUST expose `extend_face_to_target`, accepting a part ID, a face ID, a target type (`plane`, `face_id`, `part_surface`), and target parameters, and must return a rollback token after extending the face.
- **FR-106**: The system MUST expose `offset_face`, accepting a part ID, a face ID, and a signed distance, and must return a rollback token; positive distance adds material, negative removes it.

**Topology Tools**

- **FR-107**: The system MUST expose `split_body_by_plane`, accepting a part ID, a cutting plane, and exactly two output names, producing two independently addressable part IDs registered in the session.
- **FR-108**: The system MUST expose `merge_bodies_with_bend`, accepting two part IDs, an array of target edge IDs, and a bend radius, producing a single merged shell ID registered in the session.

**Sheet Metal Detailing Tools**

- **FR-109**: The system MUST expose `add_flange`, accepting a part ID, an open edge ID, a length, an angle, and a bend radius, and modifying the panel geometry to include the extruded flange.
- **FR-110**: The system MUST expose `rip_edge`, accepting a part ID and an interior corner edge ID, opening the seam to permit flat unfolding.

**Safety and Consistency**

- **FR-111**: All ten new tools MUST return a `rollback_token` for every successful geometry-mutating operation, consistent with the existing mutation contract.
- **FR-112**: All ten new tools MUST return structured errors using the existing error code schema (`GE_*`, `MD_*`) rather than unstructured exceptions.
- **FR-113**: The contract document (`specs/002-mcp-tools-gap/contracts/mcp-tools-extended.md`) MUST define the TypeScript input/output schemas for all ten tools, following the same pattern as the existing `specs/001-align-specification/contracts/mcp-tools.md`.
- **FR-114**: The MCP tool registry (tool definitions list) MUST be updated to advertise all ten new tools so AI agents can discover and call them.

### Key Entities

- **CuttingPlane**: A vector object with `normal: [x, y, z]` and `origin: [x, y, z]` used as a geometric operator across split, trim, and extend operations.
- **ClashReport**: Structured result of `compute_intersections` — intersection volume (mm³), bounding box, and suggested cutting plane per clash pair.
- **GapReport**: Structured result of `compute_gaps` — minimum distance (mm), closest face IDs on each body, extension vector, and gap bounding box.
- **ComplianceReport**: Structured result of `check_boundary_compliance` — boolean compliant flag, envelope type, and per-axis violation list.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-101**: All ten new tools are discoverable by an AI agent through the MCP tool registry and callable with valid inputs without configuration changes.
- **SC-102**: Every new mutating tool returns a `rollback_token` that, when passed to `rollback`, fully restores the prior geometry state — verified by a round-trip test for each tool.
- **SC-103**: The clash-detection and correction flow (`compute_intersections` → `trim_body_with_plane`) resolves a known two-panel interference in a single round-trip, with no manual geometry editing required.
- **SC-104**: The gap-detection and correction flow (`compute_gaps` → `extend_face_to_target`) closes a known 4.2 mm gap to within 0.01 mm tolerance in a single round-trip.
- **SC-105**: A panel that previously failed `apply_unfold` due to a sharp interior corner succeeds after a `rip_edge` call on that corner.
- **SC-106**: `check_boundary_compliance` correctly rejects a panel that exceeds a configured shipping dimension and approves one that fits, with zero false positives in the test suite.
- **SC-107**: The contract document for the ten new tools is complete, consistent with the existing contract style, and has no missing required fields (input schema, output schema, error codes).

---

## Assumptions

- The existing geometry binding (`ts/src/geometry/binding.ts`) will expose native C++ addon methods for each new operation; stub implementations are acceptable for the initial contract and tool-dispatch layer.
- `logistics://` resource configuration (shipping envelope, coating window) is already loadable from the manufacturing config; `check_boundary_compliance` reads those values at call time rather than caching them.
- `add_flange` operates only on open (boundary) edges; calling it on an interior edge is an error (`GE_EDGE_NOT_OPEN`).
- `rip_edge` operates only on interior sharp corner edges where two faces meet at an angle; calling it on a boundary edge is an error (`GE_EDGE_NOT_INTERIOR`).
- `split_body_by_plane` must produce exactly two non-empty bodies; if the plane does not intersect the solid, a `GE_BOOLEAN_FAILURE` error is returned.
- `merge_bodies_with_bend` requires the specified edges to be geometrically adjacent within a configurable tolerance (default 0.01 mm).
- All new tool schemas follow the existing TypeScript/Zod pattern already established in the project's MCP protocol layer.
- Mobile or web-facing UI changes are out of scope; this feature is exclusively server-side MCP tooling.
