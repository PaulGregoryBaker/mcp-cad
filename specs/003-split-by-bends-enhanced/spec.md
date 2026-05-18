# Feature Specification: Smart Panel Decomposition for split_body_by_bends

**Feature Branch**: `003-split-by-bends-enhanced`

**Created**: 2026-05-18

**Status**: Draft

---

## Background

The `split_body_by_bends` tool currently decomposes a shell body into flat panels by grouping
coplanar faces. This works for surface models but produces zero-thickness, non-manufacturable
panels, and handles thin-walled solids poorly. This feature makes the tool useful for both
major real-world geometry types.

---

## User Scenarios & Testing

### User Story 1 — Thin-solid decomposition (Priority: P1)

An engineer works with a CAD model where sheet metal panels are modelled with actual wall
thickness (e.g. a 200 mm hollow cube with 1 mm walls). When they call `split_body_by_bends`,
they expect to receive six separate solid panels that each retain the correct wall thickness and
world-space position — ready for individual unfolding or export.

**Why this priority**: The most common real-world CAD scenario. Hollow sheet metal assemblies
are routinely modelled with actual material thickness. The existing tool cannot handle these at all.

**Independent Test**: Can be fully tested with a hollow cube STEP file; no protrusions or
nesting required.

**Acceptance Scenarios**:

1. **Given** a hollow cube (200 mm outer / 198 mm inner, 1 mm walls), **When** `split_body_by_bends`
   is called with default parameters, **Then** six solid panels are returned, each 1 mm thick,
   and each positioned correctly in world space.

2. **Given** a 90° L-bracket (two panels joined at a right angle, 1.5 mm walls), **When**
   `split_body_by_bends` is called, **Then** two solid panels are returned and the sum of their
   volumes equals the volume of the original solid.

3. **Given** a solid whose wall thickness exceeds `max_thickness_mm`, **When** `split_body_by_bends`
   is called, **Then** the tool falls back to Mode 1 (surface) behaviour and applies
   `default_thickness_mm` to each panel.

---

### User Story 2 — Surface model panel creation (Priority: P2)

An engineer works with a lightweight conceptual model where sheet metal is represented as a
zero-thickness surface shell (e.g. a 200 mm cube modelled as six flat faces with no material
thickness). When they call `split_body_by_bends`, they expect six solid panels with the
configured default thickness applied, so the result is the same as the thin-solid case.

**Why this priority**: Important for interoperability with conceptual CAD tools that do not
model thickness. Both the surface cube and the hollow cube should produce identical output.

**Independent Test**: Can be fully tested with a surface shell STEP file independently of US1.

**Acceptance Scenarios**:

1. **Given** a zero-thickness surface cube (six flat faces, no volume), **When**
   `split_body_by_bends` is called with `default_thickness_mm: 1`, **Then** six solid panels
   are returned, each 1 mm thick — the same result as US1 Scenario 1.

2. **Given** a zero-thickness L-bracket surface, **When** `split_body_by_bends` is called,
   **Then** two solid panels are returned with `default_thickness_mm` applied.

---

### User Story 3 — Protrusion / flange separation (Priority: P3)

An engineer works with a solid that has flanges or tabs protruding from its panel faces (e.g. a
box with eight mounting flanges on its inner walls). When they call `split_body_by_bends`, they
expect the flanges to be detected and returned as separate pieces, leaving the main panels clean,
rather than being merged into the panel geometry.

**Why this priority**: Required for nested assemblies and any model that combines flat panels with
connecting features. Without this, the panel decomposition produces distorted panels.

**Independent Test**: Can be tested with a single hollow box that has two flanges on one face.

**Acceptance Scenarios**:

1. **Given** a hollow box with two 1 mm thick flanges protruding from one inner face, **When**
   `split_body_by_bends` is called, **Then** the response includes the main panel IDs separately
   from the flange IDs; the flange geometry is not merged into any panel.

2. **Given** a panel with a full-width reinforcing rib (same thickness, runs the full edge),
   **When** `split_body_by_bends` is called, **Then** the rib is NOT classified as a protrusion
   — it is treated as a standard bend and split as a panel.

---

### User Story 4 — Recursive nested decomposition (Priority: P4)

An engineer works with a complex nested assembly modelled as a single solid: an outer hollow cube,
an inner hollow cube, and eight flanges connecting them. When they call `split_body_by_bends`
with recursion enabled, they expect all layers to be fully decomposed into individual panels and
flanges in a single call, without manual iteration.

**Why this priority**: The highest complexity case. Builds directly on US1–US3 being correct.

**Independent Test**: Can be tested with a nested two-cube STEP file.

**Acceptance Scenarios**:

1. **Given** the nested assembly (outer 200 mm / 198 mm + inner 180 mm / 178 mm + 8 flanges),
   **When** `split_body_by_bends` is called with `max_recursion_depth: 5`, **Then** twelve
   panel IDs (6 outer + 6 inner) and eight flange IDs are returned.

2. **Given** the same assembly, **When** `split_body_by_bends` is called with
   `max_recursion_depth: 0` (default), **Then** only the six outer panels and no inner panels
   are returned (single-pass behaviour, same as US1).

---

### Edge Cases

- What if the solid has no bend angles at all (a single flat panel)? → Return one panel, no split.
- What if `angle_threshold_deg` is so large that all faces are considered coplanar? → Return one panel.
- What if a protrusion's attachment spans more than 50% of the panel edge? → Not classified as a
  protrusion; treated as a bend/panel continuation.
- What if wall thickness cannot be reliably measured (non-uniform walls)? → Use the minimum
  measured thickness across all sampled face pairs.

---

## Requirements

### Functional Requirements

- **FR-001**: The tool MUST detect whether the input is a surface shell or a solid, and apply the
  appropriate decomposition mode automatically.
- **FR-002**: For thin-solid inputs (wall thickness ≤ `max_thickness_mm`), the tool MUST cut the
  solid into panels using the actual solid geometry, so each panel retains its original material
  thickness and world-space position.
- **FR-003**: For surface or thick-solid inputs, the tool MUST extrude each flat panel patch by
  `default_thickness_mm` to produce manufacturable solid panels.
- **FR-004**: Before splitting, the tool MUST detect protrusions on panel faces and return them
  as separate pieces in `protrusion_ids`, distinct from `panel_ids`.
- **FR-005**: A protrusion MUST be detected by geometry alone: thin cross-section
  (≤ `max_thickness_mm`) and localised attachment (< 50% of the primary panel edge length it
  connects to).
- **FR-006**: When `max_recursion_depth > 0`, the tool MUST recursively decompose the remainder
  solid after each panel-extraction pass, up to the configured depth.
- **FR-007**: All mutating operations MUST snapshot before executing; the `rollback_token` in
  the response MUST restore the full pre-call state.
- **FR-008**: The response MUST indicate which detection mode was applied (`detected_mode`:
  `"surface"` or `"thin_solid"`).

### Key Entities

- **Panel**: A flat solid piece produced by decomposition. Has a shell ID, world-space position,
  and uniform thickness.
- **Protrusion**: A thin feature (flange, tab, boss) attached to a panel face at a localised
  point. Returned separately from panels.
- **Detection mode**: Whether the input was treated as a surface model (`"surface"`) or a
  thin-walled solid (`"thin_solid"`).

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: A 200 mm hollow cube (1 mm walls) decomposes into exactly 6 panels whose combined
  volume equals the original solid's volume (within floating-point tolerance).
- **SC-002**: A 200 mm surface cube decomposes into 6 panels with the same bounding box
  positions as the hollow cube case — both inputs produce geometrically equivalent output.
- **SC-003**: A solid with flanges returns flanges in `protrusion_ids`; no flange geometry
  appears in any panel returned in `panel_ids`.
- **SC-004**: The nested two-cube assembly (12 panels + 8 flanges) is fully decomposed in a
  single `split_body_by_bends` call with `max_recursion_depth ≥ 3`.
- **SC-005**: Tool execution completes in under 2 seconds for a solid with up to 100 faces.

---

## Assumptions

- Each panel within a thin-walled solid has uniform wall thickness (no tapered walls).
- Corner material (where two panels meet at a right angle) is assigned to one panel; the
  adjacent panel fits between. Which panel owns the corner is an implementation detail that
  users can correct with `merge_bodies_with_bend`.
- The `max_recursion_depth` default of 0 preserves backward compatibility with the current
  single-pass behaviour.
- Protrusion detection uses a 50% attachment-length threshold; this is not configurable in v1.
- A solid whose measured wall thickness exceeds `max_thickness_mm` is treated as a conceptual
  model and falls back to Mode 1 (extrude) behaviour.
