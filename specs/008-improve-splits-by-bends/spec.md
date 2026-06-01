# Feature Specification: Splits by Bends and Viewport Alignment Enhancements

**Feature Branch**: `008-improve-splits-by-bends`

**Created**: 2026-06-01

**Status**: Draft

**Input**: User description:
"1. Introduce more tests. I have a new fixtures object C:\Projects\atg\mcp-cad\cpp\tests\fixtures\cauldron.step This ojbect when split by bends creates multiple triangular faces. This is inexpected, as I was expecting trapezoidal shapes. (Triangles combined.)
2. This new test change has a different orientation, and it's center is not aligned; meaning tha the viewport navigations doesn't work as expected. Need a solution for this. to either:
a. Fix orientation (rotate to align what is up, and translate so that 0,0,0 is in the centre ofthe object.
b. Allow the view port controls (Which axes is up, and which cooridnatate is the centre) to be configured.
3. The merge by bend functionality don't work on the cauldron's adjacent faces. This need a test and a fix.
4. The remove protrusions (thin flanges) algorithm could be made slimpler, by trafersing the edges in the mesh to look for narrow closed loops. The objective for changing would be so that the algorithm runs faster, and the cut can be more carefully made so as to not disrupt the flat panel the protrusions are being removed from."

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cauldron Decomposition and Trapezoidal Face Merging (Priority: P1)

As a CAD engineer, I want the `split_body_by_bends` tool to decompose the `cauldron.step` fixture into clean flat trapezoidal/rectangular panel shapes instead of producing multiple unexpected, separate triangular bodies. This ensures that the segmented sheet metal panels correspond to the physical, manufacturable pieces of the cauldron assembly.

**Why this priority**: Core functional correctness. If decomposition splits a panel into multiple separate triangles, the downstream flat-pattern unfolding and nesting tools will treat them as distinct small pieces rather than unified sheets, making manufacturing planning impossible.

**Independent Test**: Decompose the `cauldron.step` model using `split_body_by_bends` and assert that adjacent coplanar/triangular face segments are combined into unified trapezoidal panels.

**Acceptance Scenarios**:

1. **Given** the `cauldron.step` solid body, **When** `split_body_by_bends` is called, **Then** co-planar or adjacent triangular face components are combined into trapezoidal panels, and no isolated triangular panels are returned in `panel_ids`.
2. **Given** any sheet metal part with segmented or faceted flat sections, **When** split by bends, **Then** adjacent facets sharing collinear edges within `angle_threshold_deg` are automatically merged into a single flat panel body.

---

### User Story 2 - Model Orientation and Viewport Alignment (Priority: P2)

As a CAD operator using a 3D interface, I want the system to handle models that are loaded with non-standard orientations or offset centroids (such as `cauldron.step`). I need a mechanism to either automatically center and align the part to standard coordinate axes or configure the viewport navigation controls to use the part's actual center and dominant normal orientation, so that camera controls (rotation, zoom) operate correctly.

**Why this priority**: UX and visual navigation. Without proper axis alignment and centering, viewport rotation pivot points are offset, causing the model to swing completely out of view during orbital rotation.

**Independent Test**: Load `cauldron.step` and verify that the model's coordinate frame is aligned (centroid at `[0,0,0]`, up axis aligned with standard global Z) or that the tool reports the correct camera center and up axis configuration.

**Acceptance Scenarios**:

1. **Given** a part with an off-center centroid, **When** loading/cleansing the geometry, **Then** the service supports automatically translating the centroid to `[0,0,0]` and rotating standard coordinate vectors.
2. **Given** the viewport camera navigation controls, **When** loading an arbitrary coordinate model, **Then** the API returns the calculated model center coordinates and dominant vertical axes so the viewport client can configure standard pivot points.

---

### User Story 3 - Merge by Bend on Complex Adjacent Panels (Priority: P3)

As a CAD engineer, I want the `merge_bodies_with_bend` tool to successfully fuse adjacent panels of the cauldron fixture that are separated by a bend.

**Why this priority**: Crucial repair capability. When automated decomposition splits adjacent sections that the user intends to keep as a single unified bent part, the operator must be able to heal and fuse them back together.

**Independent Test**: Call `merge_bodies_with_bend` on adjacent split panels from `cauldron.step` and verify that they fuse into a single watertight manifold shell with correct bend filleting.

**Acceptance Scenarios**:

1. **Given** two adjacent panels from `cauldron.step` connected by a common bend seam, **When** `merge_bodies_with_bend` is called with their shared boundary edges, **Then** the bodies are fused into a single manifold body and a `rollback_token` is generated.

---

### User Story 4 - Mesh-based Loop-Traversal Protrusion Removal (Priority: P4)

As a system developer, I want the protrusion (thin flange) removal algorithm to traverse the mesh edges looking for narrow closed loops representing the interface seam of protrusions. This will replace the complex volumetric bounding-box extraction with a faster, simpler edge-loop search, ensuring that protrusion cuts are made precisely along the interface and do not disrupt the host panel.

**Why this priority**: Performance and robustness. A simple topological loop search is computationally faster than 3D solid half-space boolean cuts and minimizes geometric disruption to flat panel boundaries.

**Independent Test**: Call `remove_protrusions` on parts with thin flanges and verify execution speed and the geometric cleanliness of the resulting flat host panel.

**Acceptance Scenarios**:

1. **Given** a solid with protruding flanges or mounting tabs, **When** `remove_protrusions` is executed, **Then** the engine identifies the narrow closed edge loops at the attachment interface, splits the shape cleanly along the loops, and isolates protrusions in `protrusion_ids` while leaving the parent panels intact.
2. **Given** a complex multi-protrusion part, **When** protrusion removal runs, **Then** the execution completes with a significant speedup compared to volumetric extraction.

---

### Edge Cases

- **Ambiguous Centroid/Up-Axis**: When a model is highly spherical or symmetrical, auto-alignment may struggle to find a dominant panel to align as the horizontal base. Standard fallback axes must be defined.
- **Open Edge Protrusions**: A flange or tab that does not form a closed loop at its boundary interface (e.g., a flange starting at an open boundary edge). The algorithm must be able to form a closed loop by projecting onto the boundary edge of the host panel.
- **Faceted Curvature**: Non-coplanar adjacent facets that approximate a curve must not be merged into flat panels if their relative angle exceeds the configured `angle_threshold_deg`.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `split_body_by_bends` MUST detect and merge adjacent coplanar/triangular face groups into single unified trapezoidal/rectangular panel bodies.
- **FR-002**: The geometry service MUST support model re-orientation and centering explicitly as separate, on-demand query and mutation functions (e.g., `center_and_align_body`). This allows the client to correct the viewport centering and dominant vertical axis specifically when the imported model is wrong, preventing unnecessary UI clutter or calculations when the model is already correct.
- **FR-003**: `merge_bodies_with_bend` MUST support merging adjacent non-planar faces on complex bodies like the cauldron model without failing or producing non-manifold structures.
- **FR-004**: The protrusion detection and removal pipeline MUST implement a mesh edge-traversal algorithm that searches for narrow closed loops. During the transition phase, the existing volumetric/bounding-box algorithm MUST be kept as a separate testing/benchmark tool to facilitate validation and direct speed/precision comparisons, and only removed when the new loop-traversal algorithm is proven superior in all test cases.
- **FR-005**: The edge-traversal protrusion removal algorithm MUST perform cuts strictly along the detected narrow loop boundaries to preserve the flat host panel shape.
- **FR-006**: The edge-traversal algorithm MUST run faster (i.e., lower time complexity) than the baseline half-space bounding-box extraction.
- **FR-007**: `split_body_by_bends` MUST generate and return structured shape lineage information (`shape_history` mapping records) that links the original face and body IDs of the parent model to the new panel and protrusion body IDs. This history MUST be recorded in the semantic database (Dolt) on transaction commit to allow automatic remapping of semantic entities (e.g., label/BOM bindings) and precise geometry difference analysis between branches.

### Key Entities *(include if feature involves data)*

- **Trapezoidal Panel**: A flat segmented sheet body formed by merging adjacent triangular or coplanar facets.
- **Viewport Center / Up Axis**: Parameters defining the camera target and vertical axis to ensure smooth 3D navigation.
- **Narrow Closed Loop**: A cycle of connected edges in the mesh representing the boundary interface where a thin flange or protrusion meets a parent panel.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Decomposing `cauldron.step` produces trapezoidal/rectangular panels with co-planar triangles merged, with no unexpected isolated triangular bodies.
- **SC-002**: Auto-centering or configured viewport coordinates locate the cauldron's center within a $0.001\text{ mm}$ tolerance of `[0,0,0]`.
- **SC-003**: `merge_bodies_with_bend` on adjacent cauldron panels completes successfully in 100% of test cases.
- **SC-004**: The edge-traversal protrusion removal algorithm execution time is at least 30% faster than the previous volumetric/bounding-box extraction.

---

## Assumptions

- The `cauldron.step` fixture is accessible at the standard path `cpp/tests/fixtures/cauldron.step`.
- Coplanar triangles have normal vectors within a configurable tolerance (e.g. 0.5 degrees).
- The narrow closed loop is defined by a ratio of loop length to cross-sectional width.
- Custom viewport properties are passed back to the UI/frontend in standard JSON formats.
