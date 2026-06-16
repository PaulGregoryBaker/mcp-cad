# Feature Specification: Accurate Coordinate Mapping & Graph Mutation Model

**Feature Branch**: `012-accurate-coord-mapping`

**Created**: 2026-06-11

**Status**: Draft

**Input**: Fix coordinate mapping and manufacturing graph mutation model: (1) delete derivePanelFrameFromBbox, replace with computeDxfAlignedFrame (OCCT getPanelFrame + DXF rotation aware) restricted to graph creation paths only; (2) fix merge_bodies_with_bend to use append-mode graph building (not graph rebuild) — apply same append principle to all graph-mutating operations; (3) add a 2D placement transform (rotation + translation) to PanelNode to describe where the panel sits in the master merged flat DXF — a scalar offset alone is insufficient because panels may be rotated before placement; (4) rewrite map3dTo2d/map2dTo3d with region traversal across all PanelNodes using the 2D placement transform + accurate panelFrame

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Accurate 3D-to-2D coordinate lookup on any panel (Priority: P1)

A downstream tool (e.g. a hole-placement assistant) sends a 3D world-space point on a panel surface and expects the system to return the correct flat-pattern DXF coordinate. Today the system uses an axis-aligned bounding-box approximation for the panel frame, which breaks silently for tilted or rotated panels and returns incorrect coordinates without any error signal.

**Why this priority**: Coordinate mapping is the foundation for all downstream DXF annotation, cut-profile placement, and manufacturing output. An incorrect frame poisons every operation built on top of it.

**Independent Test**: Call `map_3d_to_2d` with a known corner point of a panel that is tilted 45° in world space. Verify the returned DXF coordinate matches the expected flat-pattern corner within 0.1 mm.

**Acceptance Scenarios**:

1. **Given** a panel whose largest face is not axis-aligned, **When** `map_3d_to_2d` is called with a point on that face, **Then** the returned DXF coordinate is within 0.1 mm of the geometrically correct flat-pattern position.
2. **Given** a panel that is axis-aligned (standard case), **When** `map_3d_to_2d` is called, **Then** results are identical to the previous implementation (no regression).
3. **Given** a point that does not lie on any panel surface, **When** `map_3d_to_2d` is called, **Then** a `GE_POINT_NOT_ON_PANEL` error is returned with the distance to the nearest panel.

---

### User Story 2 — Correct 2D-to-3D mapping across a bent assembly (Priority: P1)

A user has merged two panels at 90° and wants to know the 3D world position of a point in the merged flat DXF — for example, a hole centre that is on Panel B's side of the bend line. Today the system only knows Panel A's 3D frame; points on Panel B are either incorrectly mapped using Panel A's frame or not found at all.

**Why this priority**: Without this, any annotation or cut placed on Panel B of a merged assembly is placed in the wrong physical location, making the manufacturing output unusable.

**Independent Test**: Split a known bracket into two panels, merge them, then call `map_2d_to_3d` with a DXF coordinate clearly in Panel B's region. Verify the returned 3D point lies on Panel B's face within 0.1 mm.

**Acceptance Scenarios**:

1. **Given** a merged two-panel assembly (90° bend), **When** `map_2d_to_3d` is called with a flat coordinate in Panel B's DXF region, **Then** the returned 3D point lies on Panel B's face within 0.1 mm.
2. **Given** a three-panel assembly (two sequential bends), **When** `map_2d_to_3d` is called for each panel's region, **Then** the correct 3D point is returned for each region.
3. **Given** a flat coordinate that falls in the bend zone (between panels), **Then** the system returns the nearest panel's mapping rather than an error.

---

### User Story 3 — Graph integrity is preserved across all mutations (Priority: P2)

A user performs a sequence of operations — split, merge, second merge — and expects each step to add to the manufacturing graph rather than replace it. Today `merge_bodies_with_bend` discards the individual panel nodes from prior merges, creating a new graph from scratch. This destroys traceability and forces downstream operations to treat the assembled part as an opaque blob.

**Why this priority**: The manufacturing graph is the system's source of truth. Rebuilding it on every mutation is architecturally unsound: it breaks audit trails, makes undo difficult, and is the root cause of the coordinate mapping failures for multi-bend assemblies.

**Independent Test**: Split a part into two panels, merge them (A+B), then merge the result with a third panel (AB+C). Verify the final graph contains three `PanelNode` entries (one per original panel) plus two `BendNode` entries, each `PanelNode` carrying a correct 2D placement transform describing its position and orientation within the master merged flat.

**Acceptance Scenarios**:

1. **Given** a two-panel merged assembly, **When** `merge_bodies_with_bend` is called with a third panel, **Then** the graph contains three `PanelNode` entries and two `BendNode` entries rather than two nodes.
2. **Given** any graph-mutating operation (split, merge, unfold), **When** the operation completes, **Then** all prior `PanelNode` and `BendNode` entries from previous operations are preserved in the graph.
3. **Given** a panel that was rotated 90° during DXF normalization before placement in the merged flat, **When** coordinate mapping is performed, **Then** the stored 2D placement transform correctly inverts that rotation so the panel-local coordinates map to the right 3D position.
4. **Given** a multi-bend assembly, **When** a rollback is requested, **Then** the graph is restored to its pre-mutation state with all nodes intact.

---

### User Story 4 — Panel frames are derived from actual geometry, never from bounding boxes (Priority: P2)

Any tool that creates or registers a panel (split, bootstrap_graph, unfold) must derive the panel's orientation frame from the actual face geometry rather than from the axis-aligned bounding box. The bounding-box fallback must be removed entirely so that incorrect frame data cannot silently enter the system.

**Why this priority**: The bounding-box fallback is an error-hiding mechanism — it produces plausible-looking but wrong frames for any non-axis-aligned panel, and it does so silently. Removing it forces failures to surface at panel creation time, where they can be diagnosed.

**Independent Test**: Register a panel whose body is tilted 30° in world space via `bootstrap_graph`. Verify that the stored `panelFrame` normal is perpendicular to the panel face (within 0.1°), not aligned with a world axis.

**Acceptance Scenarios**:

1. **Given** a panel with a non-axis-aligned face, **When** the manufacturing graph is created for it (via split, bootstrap, or unfold), **Then** the stored `panelFrame` origin, `u`, and `v` axes match the actual face geometry within 0.1°.
2. **Given** no planar face is detectable on a shell (e.g. a sphere), **When** graph creation is attempted, **Then** an explicit `GE_PANEL_FRAME_FAILED` error is returned — no silent fallback to a bounding-box estimate.
3. **Given** a valid flat panel, **When** `computeDxfAlignedFrame` is called from outside a graph-creation path (e.g. directly from a tool handler), **Then** the call is rejected at compile time (the function is not exported).

---

### Edge Cases

- A panel that has been translated or rotated after split must use a freshly computed frame (not the stale stored one) when that panel is subsequently merged.
- A panel with non-rectangular boundary (e.g. a trapezoid) must still produce a correct frame — the frame describes the face plane, not the outline shape.
- A DXF coordinate that falls exactly on a bend-zone boundary must be assigned to one of the adjacent panels deterministically (convention: assign to the upstream/Panel-A side).
- A merged assembly where both panels have the same `partId` alias pointing to the graph must correctly resolve region queries from either alias.
- When `dxfPlacement` is queried for a root panel (never merged), it must be the identity transform (no rotation, zero translation).
- A panel rotated 180° during normalization (degenerate case) must still produce an invertible `dxfPlacement` and correct round-trip coordinates.

---

## Requirements *(mandatory)*

### Functional Requirements

**Graph mutation model**

- **FR-001**: `merge_bodies_with_bend` MUST extend the existing manufacturing graph (append-mode) rather than discard it and create a new one. All prior `PanelNode` and `BendNode` entries MUST be preserved.
- **FR-002**: All graph-mutating operations (`split_body_by_bends`, `merge_bodies_with_bend`, `apply_unfold`) MUST follow the append principle: new nodes are added; existing nodes are never silently removed.
- **FR-003**: On graph-creation (split, bootstrap, unfold), panel frames MUST be computed via `computeDxfAlignedFrame`, which internally calls the geometry engine's face-normal extraction. No other path for creating panel frames is permitted.
- **FR-004**: `computeDxfAlignedFrame` MUST NOT be exported from the module that defines it. It MAY only be called by the three graph-creation paths listed in FR-003.
- **FR-005**: The `derivePanelFrameFromBbox` function MUST be deleted. Any call site that relied on it MUST either call `computeDxfAlignedFrame` (if in a graph-creation path) or fail explicitly.

**Panel frame accuracy**

- **FR-006**: `computeDxfAlignedFrame` MUST derive the panel's face normal and in-plane axes from the geometry engine's largest-planar-face analysis, not from world-axis bounding-box measurements.
- **FR-007**: The frame MUST reflect the DXF axis convention: `u` corresponds to DXF +X (fold-perpendicular direction, shorter in-plane extent); `v` corresponds to DXF +Y (fold-parallel direction, longer in-plane extent).
- **FR-008**: The frame `origin` MUST be the 3D world-space point that corresponds to DXF coordinate (0, 0) in that panel's own flat DXF — accounting for any normalization rotation applied during DXF creation.
- **FR-009**: If the geometry engine cannot find a planar face on the shell, `computeDxfAlignedFrame` MUST return a `GE_PANEL_FRAME_FAILED` error. No silent fallback is permitted.

**DXF placement transform**

- **FR-010**: Each `PanelNode` MUST carry a `dxfPlacement` field: a 2D rigid transform (2×2 rotation matrix + 2D translation vector) that maps from the panel's own local flat DXF coordinate system into the master merged flat DXF coordinate system.
- **FR-011**: For a root panel (never merged), `dxfPlacement` MUST be the identity rotation with zero translation.
- **FR-012**: For each downstream panel, `dxfPlacement` MUST encode both the rotation applied during DXF normalization (e.g. a 90° rotation when the panel was reoriented before placement) and the translation to the panel's origin in the merged flat: `translation_x = upstream_width + bend_allowance`, `translation_y = 0` for standard strip layouts.
- **FR-013**: The `BendNode` MUST record the X coordinate (in the merged flat) where its bend zone starts, enabling DRC cut-in-bend-zone validation. This value equals the upstream panel's translated X-max.

**Coordinate mapping**

- **FR-014**: `map_3d_to_2d` MUST iterate ALL `PanelNode` entries in the manufacturing graph (not only canonical nodes) and project the query point onto each panel's frame.
- **FR-015**: When a match is found (perpendicular distance ≤ 0.1 mm), `map_3d_to_2d` MUST apply the panel's `dxfPlacement` transform to the panel-local coordinate `(u_local, v_local)` to produce the master flat coordinate: `xy = R * [u_local, v_local] + t` where `R` and `t` are the rotation and translation of `dxfPlacement`.
- **FR-016**: `map_2d_to_3d` MUST invert each panel's `dxfPlacement` transform to convert the master flat coordinate to a panel-local coordinate, then reconstruct the 3D point via `frame.origin + local_u * frame.u + local_v * frame.v`. The correct panel is the one whose `dxfPlacement`-transformed bounding region contains the query point.
- **FR-017**: Both mapping functions MUST produce a round-trip error ≤ 0.1 mm for any point on any panel surface in a single-panel or multi-panel merged assembly.

### Key Entities

- **PanelNode**: A single flat panel in the manufacturing graph. Gains a `dxfPlacement` field: a 2D rigid transform (2×2 rotation matrix + 2D translation vector) that maps panel-local flat coordinates into the master merged flat DXF. `panelFrame` is always OCCT-derived (never bbox-derived). `canonical` flag marks the node whose `shapeDxf` contains the full assembled flat pattern.
- **BendNode**: A fold operation linking two `PanelNode` entries. Gains a `bendZoneDxfX: number` field recording the X coordinate where the bend zone begins in the master merged flat (used for DRC). Existing `bendAllowance`, `innerRadius`, `angle`, `kFactor` fields are unchanged.
- **DxfPlacement2D**: A value type `{ rotationMatrix: [[a,b],[c,d]], translation: [tx, ty] }` expressing a 2D rigid transform. The identity (no rotation, no translation) represents a panel at the origin of its own DXF. Rotation encodes any normalization rotation applied during DXF creation (e.g. 90° CCW). Translation encodes the panel's position in the master merged flat.
- **PanelFrame**: Three-field structure `{origin, u, v}` where all three are 3D world-space vectors. `u` = DXF +X direction, `v` = DXF +Y direction, `origin` = 3D point at DXF (0,0). Unchanged interface; only the derivation path changes.
- **computeDxfAlignedFrame**: Internal function (not exported). Accepts a shell ID and a boolean indicating whether the DXF was rotated 90° during normalization. Returns a `PanelFrame` with axes matching the final DXF orientation. Hard-fails if no planar face is found.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `map_3d_to_2d` returns the correct flat-pattern coordinate (within 0.1 mm) for any point on any panel of a merged assembly, regardless of how many bends the assembly contains.
- **SC-002**: `map_2d_to_3d` returns the correct 3D world position (within 0.1 mm) for any DXF coordinate in the merged flat, including coordinates in Panel B's region and Panel C's region of a three-panel chain.
- **SC-003**: After three sequential split/merge operations, the manufacturing graph contains exactly as many `PanelNode` entries as there are physical panels (no nodes discarded by intermediate merges), each with a correct `dxfPlacement` transform.
- **SC-004**: No call to `derivePanelFrameFromBbox` exists anywhere in the codebase after implementation — verified by static search.
- **SC-005**: `computeDxfAlignedFrame` is not importable from any file outside the graph-creation module — verified by compilation.
- **SC-006**: A panel tilted 45° in world space produces a `panelFrame` whose normal is perpendicular to the face within 0.1° — verified by unit test.
- **SC-007**: All existing tests that currently pass continue to pass after implementation (no regressions).

---

## Assumptions

- The geometry engine's `getPanelFrame` function is already implemented in C++ and exposed via the NAPI binding — no new C++ work is required to derive accurate panel frames.
- The "fold-perpendicular = DXF X, fold-parallel = DXF Y" axis convention is adopted uniformly for all panels and merged assemblies. Existing callers of the coordinate mapping API accept this convention without interface changes.
- A panel that has been translated or rotated after split has its frame recomputed at the time it participates in a merge, using its current body geometry. The stale stored frame is not used for placement calculations.
- Multi-body assemblies (more than one root panel) are out of scope for this feature. Each `_parts` entry corresponds to a single linear bend chain.
- Coordinates that fall within a bend zone (between two panels in the merged flat) are not separately mapped — they return the nearest panel's mapping as the defined behavior.
- Rollback behavior for the append-mode graph (restoring all nodes on C++ failure) is included in scope; cross-transaction undo is out of scope.
