# Feature Specification: Build Manufacturing Plan Tool

**Feature Branch**: `010-build-manufacturing-plan`

**Created**: 2026-06-04

**Status**: Draft

**Input**: User description: "I would like to create a new MCP tool maybe called feature extratction/build manufacturing plan; which can be run on newly imported models. The objective of this process is to recreate the exact imported parts through the manufacturing graph. This is how I think it should work: - split parts by bends - generate manufacturing graphs for each of the panels. If not a panel- flag as such - Recombine the parts in the same way they were split, by using merge by bend. - Joints that either break the manufacturing process, or are impossible e.g. protrusion in center of panel; are not merged."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Reconstruction of Sheet Metal Parts (Priority: P1)

As a CAD Designer, I want to run a single command on an imported STEP model so that it is automatically split into flat panels, analyzed, and reconstructed as a sheet metal assembly with a valid Manufacturing Graph.

**Why this priority**: This is the core workflow of the tool. It provides the MVP value of automatically translating generic 3D geometries into semantic sheet metal parts without manual tracing.

**Independent Test**: Can be fully tested by loading a simple bent bracket (e.g. L-bracket or U-bracket STEP model), invoking the tool, and verifying that the final output part is a single merged body with a complete manufacturing graph containing all panel nodes and the correct bend nodes.

**Acceptance Scenarios**:

1. **Given** a session with a newly imported 3D solid body representing a valid sheet metal part with bends, **When** `build_manufacturing_plan` is executed on the part, **Then** the system splits the part by its bends, identifies all split bodies as valid panels, creates their individual manufacturing graphs, merges them back using `merge_bodies_with_bend`, and returns a success status with a single merged body ID and a populated manufacturing graph.

---

### User Story 2 - Detection and Isolation of Non-Panel Features (Priority: P2)

As a Manufacturing Engineer, I want the system to automatically identify and isolate non-sheet-metal components or protrusions (e.g. machined blocks, bosses) that cannot be folded from flat stock, so that they are flagged and handled separately.

**Why this priority**: Real-world sheet metal parts often have welded nuts, machined bosses, or stiffening ribs. Correctly classifying these prevents manufacturing solver failures and ensures accurate nesting.

**Independent Test**: Can be tested by running the tool on a composite bracket that has a thick block protrusion. The tool should successfully split and classify the block as a non-panel and list it in the unmerged features report, while successfully merging the rest of the sheet metal brackets.

**Acceptance Scenarios**:

1. **Given** an imported body containing both thin sheet-metal-like sections and a thick machined protrusion block, **When** `build_manufacturing_plan` is executed, **Then** the sheet-metal-like sections are split into valid panels, the machined block is flagged as a non-panel, and the block is left unmerged with the panels, resulting in a report listing the block ID and its classification.

---

### User Story 3 - Prevention of Process-Breaking or Impossible Joints (Priority: P3)

As a Press Brake Operator, I want the system to detect joints that are impossible to bend or would violate manufacturing capability rules (e.g. bends that collide with existing panels or create closed loops) and keep them unmerged, so that the assembly does not fail during production.

**Why this priority**: Avoids generating a theoretically-merged model that is physically impossible to fabricate on the shop floor.

**Independent Test**: Can be tested by running the tool on a closed-loop box bracket where one of the bends is impossible due to folding collision. The tool should skip merging that specific bend joint and return a warning.

**Acceptance Scenarios**:

1. **Given** a split assembly where merging a specific bend joint would cause a collision or violate a critical manufacturing capability rule (e.g. bend clearance collision), **When** `build_manufacturing_plan` is executed, **Then** the tool merges all other valid bends, leaves the impossible joint unmerged, and returns the partially merged parts along with a warning detailing the impossible joint.

### Edge Cases

- **Self-Intersecting Flat Patterns**: What happens when the split panels would overlap when unfolded? The tool should flag this as a flat-pattern collision and warning, but may still allow merging if requested (or fail validation).
- **Extremely Short Bends/Bevels**: How does the system handle tiny radius chamfers or non-cylindrical bends? The system must classify them as non-bends and keep the adjacent panels unmerged.
- **Zero-Thickness / Non-Manifold Geometry**: If the imported STEP file has topological errors, the system must report a validation error before attempting feature extraction.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The tool MUST accept an active part/body ID from the session as input.
- **FR-002**: The tool MUST automatically detect bend regions and partition the target body into candidate panels and bend seams.
- **FR-003**: The tool MUST classify each partitioned body:
  - If it meets sheet metal panel constraints (e.g. uniform thickness, planar faces), it is flagged as a **Panel**.
  - Otherwise, it is flagged as a **Non-Panel** (e.g., protrusion, gusset, boss).
- **FR-004**: The tool MUST construct a local manufacturing graph for all identified panels.
- **FR-005**: The tool MUST evaluate each potential bend joint using the manufacturability and foldability checkers.
- **FR-006**: The tool MUST attempt to recombine the parts using the standard `merge_bodies_with_bend` logic.
- **FR-007**: The tool MUST NOT merge joints that are flagged as impossible or process-breaking (e.g. bends that result in self-intersections or violate press-brake limits).
- **FR-008**: The tool MUST return a structured JSON report containing:
  - The final merged body ID(s)
  - The generated manufacturing graph representation
  - A list of unmerged/flagged components (with reasons for each)
  - Validation/warning codes if any joints were skipped
- **FR-009**: The tool MUST run as a transaction-aware operation, allowing rollback of all intermediate splits and merges if a failure occurs or if requested by the user.
- **FR-010**: System MUST execute the entire plan-building process in under 10.0 seconds.
- **FR-011**: The tool MUST support keeping non-panel components as separate bodies and registering them as unmerged auxiliary parts.
- **FR-012**: The decomposition process MUST track and return the topological adjacency pairs (split_pairs) of panels that were separated.
- **FR-013**: The tool MUST score and prioritize candidate merges (e.g., standard 90-degree bends first) to ensure a robust reconstruction sequence.

### Key Entities *(include if feature involves data)*

- **ManufacturingPlan**: The overall result of the feature extraction, including the target part, generated graph, and merge status.
- **PanelClassification**: metadata describing whether a split body is a valid sheet metal panel or a non-panel protrusion.
- **MergeDecision**: An analysis record for each joint/bend indicating whether it can be safely merged, or if it must remain unmerged due to manufacturing constraints.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of valid single-part sheet metal STEP files (with less than 10 bends) are successfully reconstructed into a single merged body with a valid manufacturing graph.
- **SC-002**: The system correctly identifies and flags at least 95% of non-panel protrusions (such as welded bosses or machined inserts) in test assemblies.
- **SC-003**: Reconstruction processes for parts with up to 10 panels complete in under 3 seconds.
- **SC-004**: No process-breaking joints (as defined by the DRC/Foldability checkers) are ever merged.

## Assumptions

- The input STEP model has already been loaded and validated via `clean_geometry`.
- The material thickness is uniform across all identified sheet metal panels.
- The standard material properties (e.g. bend radius, K-factor) are looked up from the active material store.
- Existing tools (`split_body_by_bends`, `merge_bodies_with_bend`, DRC, and Foldability checkers) will be leveraged rather than rewriting their logic.
