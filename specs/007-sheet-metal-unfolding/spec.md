# Feature Specification: Advanced Sheet Metal Unfolding

**Feature Branch**: `007-sheet-metal-unfolding`

**Created**: 2026-05-26

**Status**: Approved

**Input**: User description:
"The apply unfold functionality in the MCP is not working an not up to the task. This is a critical piece. What we need it to do:
1. Validate that it can be flattenned; I.e. check that the 3D object is made of sheet metal; I.e. thin panels.
2. Validate that it can be unfolded; e.g. flange in the middle of a panel, I.e. there are no joints that cannot be unfolded. Or disconnects that cannot be fixed. 
3. Fix any superficial disconnects.
4. Take a 3D Object that is made of thin sheets, and onfold it to produce the flat pattern  (based on the manufacturing settings provided) that when bent will produce the 3D model. (This is likely to mean that subtilties in the object is likely to change. I.e. sharp edges become curves.)
5. Generate a replacement 3D object that has the built refold pattern.
6. Generate the DXF flat pattern that contains bends and cutout of the part."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Validate and Flatten Sheet Metal Parts (Priority: P1)

An engineer imports a custom 3D CAD design of a sheet metal enclosure. Before sending it to manufacturing, they need the system to analyze the solid geometry, verify that it adheres to standard sheet metal constraints (constant thickness, valid bend radii, absence of non-unfoldable joints), and unfold the structure to estimate the required raw sheet dimensions.

**Why this priority**:
Ensuring that a 3D model can be physically manufactured as a flat pattern is the foundational step of the sheet metal pipeline. Catching non-manifold or invalid sheet geometries early prevents downstream failures in nesting and laser cutting.

**Independent Test**:
The user runs the validation and unfolding tool on an imported STEP model of a standard bracket. The tool successfully determines if the model is made of uniform thin panels, flags any invalid topology, and outputs the bounding box of the flat blank.

**Acceptance Scenarios**:

1. **Given** a 3D solid model with uniform thickness $t = 2.0\text{ mm}$ and valid sheet geometry, **When** validation is run, **Then** the system returns `valid: true` and details the detected thickness.
2. **Given** a solid model that has varying thicknesses (e.g. $1.5\text{ mm}$ on one flange and $3.0\text{ mm}$ on another) or contains bulky 3D features, **When** validation is run, **Then** the system returns `valid: false` with specific errors identifying the non-conforming regions.
3. **Given** a 3D shell with a closed cylinder loop or an internal flange joined in the middle of a flat face (forming a T-junction), **When** unfoldability checks are run, **Then** the system identifies these as topological obstacles and reports they cannot be unfolded.

---

### User Story 2 - Automated Repair and Sharp-to-Curved Refolding (Priority: P2)

An engineer has a sheet metal CAD model with minor superficial gaps or sharp interior edges from quick drafts. They want the system to automatically repair minor disconnects and rebuild the sharp edges into realistic curved bend zones based on material and tooling parameters.

**Why this priority**:
Real-world sheet metal cannot have infinitely sharp $90^\circ$ folds without fracturing. Modeling realistic bends and healing small imports ensures that the generated 3D replacement model matches the physical part after press-brake bending.

**Independent Test**:
A STEP model with small gaps ($<0.1\text{ mm}$) and sharp corners is loaded. The system auto-heals the gaps, inserts curved bends at the fold lines, and outputs a revised 3D solid representing the finished part.

**Acceptance Scenarios**:

1. **Given** a sheet metal model with gaps along face seams less than the configured sewing tolerance, **When** the repair workflow runs, **Then** the system successfully stitches the seams and proceeds to unfold.
2. **Given** a model with sharp joint edges, **When** the refolding process is executed, **Then** the sharp joints are replaced by cylindrical bends with the correct inner bend radius and neutral axis calculations, and a high-fidelity 3D replacement solid is saved in the session.

---

### User Story 3 - DXF Export with Bends and Cutouts (Priority: P3)

The shop floor operator needs a flat pattern file to load into the laser cutter and press brake. They want the system to generate a DXF file containing the flat profile, inner cutouts, and clear bend centerlines showing the direction and angle of each fold.

**Why this priority**:
Laser cutters and bending machines require 2D vectors separated by functional layers (cutting contours vs. marking/bending lines) to automate the fabrication process.

**Independent Test**:
An unfolded sheet metal panel is exported to DXF. The DXF file is opened and checked to ensure it contains distinct layers for cut contours, bend-up lines, and bend-down lines.

**Acceptance Scenarios**:

1. **Given** a successfully unfolded part, **When** exporting to DXF, **Then** the system produces a standard DXF file containing closed polylines for the outer contour and cutouts on the cut layer, and straight line segments on the bend layers.
2. **Given** an unfolded part with both upward and downward bends, **When** DXF export is run, **Then** the DXF includes metadata or distinct layers separating bend-up and bend-down lines along with their respective bend angles.

---

### Edge Cases

- **Self-Intersecting Flat Patterns**: A part may look valid in 3D but, when flattened, its flanges overlap. The system must detect flat-pattern self-intersection and warn the user.
- **Large superficial disconnects**: Gaps that exceed the healing tolerance cannot be automatically closed. The system must report these specifically with edge IDs rather than failing silently or skewing the geometry.
- **Multi-body compound inputs**: A STEP assembly file is loaded containing multiple overlapping parts. The system must validate and process each sheet body independently.
- **Very high bend count / branching trees**: Part has complex branching flanges. The unfolding traversal must choose an optimal base face to minimize cumulative calculation errors and projection distortions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (Thin Panel Sheet Validation)**: The system MUST inspect the 3D solid shape and verify that it represents a thin-walled part of uniform thickness. It MUST verify that:
  - Planar faces are grouped in parallel/anti-parallel offset pairs.
  - The distance between each offset pair equals the nominal material thickness within a $\pm 10\%$ tolerance.
  - Non-sheet-metal shapes (e.g. solid cubes, blocks) are rejected.
- **FR-002 (Unfoldability Check)**: The system MUST check the topological connectivity graph of the sheet. It MUST identify and reject:
  - T-junctions (edges shared by more than two sheet faces).
  - Closed loops of bends that cannot be flattened without tearing (e.g. closed boxes without rip edges).
  - Bends that originate from the middle of a face rather than a boundary edge.
- **FR-003 (Superficial Disconnect Repair)**: The system MUST heal minor geometrical gaps and edges along seams.
  - The system MUST perform automatic sewing of adjacent edges along sheet metal face seams within a configurable maximum tolerance gap (defaulting to $0.1\text{ mm}$). Gaps exceeding this tolerance MUST be rejected with diagnostic edge coordinates.
- **FR-004 (Analytical Flattening & K-Factor Compensation)**: The system MUST flatten the 3D shell using a face-by-face traversal.
  - It MUST apply the K-factor and thickness to compute bend allowances (BA) according to the standard formula:
    $$BA = \frac{\pi}{180} \cdot \theta \cdot (R_i + K \cdot t)$$
    where $\theta$ is the bend angle in degrees, $R_i$ is the inner bend radius, $K$ is the K-factor, and $t$ is the material thickness.
  - Planar dimensions (width, height) of the resulting flat blank must reflect the stretched lengths.
- **FR-005 (Sharp-to-Curved Reconstruction)**: The system MUST replace sharp joint transitions in the 3D model with realistic rounded bends.
  - The system MUST automatically map sharp corners to curved cylindrical surfaces using a default radius mapping strategy where the internal bend radius equals the material thickness ($R_i = t$) and the external bend radius is twice the thickness ($R_e = 2t$).
- **FR-006 (Replacement Refold Model Generation)**: The system MUST construct a new, valid 3D solid body representing the finished physical part (with rounded bends and healed topology) and register it in the session as a replacement solid.
- **FR-007 (2D Profile & Cutout Wires)**: The system MUST extract the boundary loops of the flattened part, distinguishing between the outer contour loop and interior cutout loops (holes, slots).
- **FR-008 (DXF Layer Separation)**: The system MUST format the 2D flat geometry as a standard DXF.
  - The system MUST output the 2D geometry separated into industry-standard DXF layers: `'CUT'` for outer contours and internal cutouts, `'BEND_UP'` for upward bends, and `'BEND_DOWN'` for downward bends. Each bend centerline MUST be annotated with its bend angle and direction.

### Key Entities *(include if feature involves data)*

- **SheetMetalPart**: Represents the input 3D solid/shell component being validated and unfolded.
  - *Attributes*: `part_id` (UUID), `nominal_thickness_mm` (float), `material_id` (string), `is_valid_sheet_metal` (boolean).
- **UnfoldSessionState**: Represents the active unfolding state and the topological connectivity graph.
  - *Attributes*: `unfold_id` (UUID), `base_face_id` (string), `flat_width_mm` (float), `flat_height_mm` (float), `bend_count` (integer).
- **BendFeature**: Represents a single bend line or zone connecting two planar faces.
  - *Attributes*: `bend_id` (string), `angle_deg` (float), `direction` (enum: UP, DOWN), `inner_radius_mm` (float), `k_factor` (float), `centerline_start` (Point2D), `centerline_end` (Point2D).
- **DxfExportPack**: Represents the final production-ready DXF drawing.
  - *Attributes*: `dxf_content` (string), `cut_layer_name` (string), `bend_up_layer_name` (string), `bend_down_layer_name` (string).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001 (Validation Reliability)**: 100% of non-sheet-metal imported solid models (e.g. blocks, spheres, multi-thickness parts) are correctly flagged as invalid during validation, with zero false positives on standard uniform-thickness brackets.
- **SC-002 (Unfold Accuracy)**: The flat blank dimensions (width, height) calculated by the system must match theoretical mathematical flat calculations using the DIN 6935 K-factor standard to within a tolerance of $\pm 0.05\text{ mm}$.
- **SC-003 (Auto-Healing Effectiveness)**: The system successfully heals and unfolds 95% of imported parts that contain minor superficial gaps ($\leq 0.1\text{ mm}$) along sheet seams without manual intervention.
- **SC-004 (DXF Compatibility)**: The generated DXF flat pattern imports successfully into standard industry CAD/CAM software (such as AutoCAD, Trumpf TruTops, or Librecad) with 100% layer separation accuracy and no dangling or open loops.
- **SC-005 (Performance)**: The full validation, healing, sharp-to-curved refolding, and flat pattern generation for parts with up to 12 bends must complete in under $2.0$ seconds.

## Assumptions

- **Material & Tooling Config**: Valid material database entries (defining default K-factors and thickness parameters) are available in the system configuration.
- **Planar Face Dominated**: The input sheet metal part is primarily made of planar faces connected by straight bends. Heavily curved freeform stampings or deeply drawn parts (e.g., car body panels) are considered out of scope.
- **Rip Edges Pre-existing**: The input model already has necessary relief slots/rips modeled in corners. While the system identifies interlocking loops, automatic placement of rip lines is out of scope for the initial version of this feature.
- **Metric System**: All physical dimensions and calculations are processed in millimeters (mm).
