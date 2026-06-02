# Feature Specification: Assembly Validation and Autofix Recommendations

**Feature Branch**: `009-validate-all`

**Created**: 2026-06-02

**Status**: Draft

**Input**: User description: "I would like to extend the MCP toolset to include an efficient Validate All function. This function should make the following checks; 1. If a part identified as a sheet metal part; it needs to pass the sheet metal unfolding check; 2. If there are any overlaps/intersection of any of the parts they need to be highlighted. Note on performance. If there are N parts, I don't expect there to be N*N intersection checks, as that wouldn't scale well when N becomes very large. Checks only need to be made if they are adjacent. 3. The structure should allow extensions to this; I.e. Semantic graph errors; Manufacturing Errors; Nesting Errors. Additionally, I would like to capture the autofix details for each error. This should include the mcp tool and the parameters required to call that tool."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run Comprehensive Assembly Validation (Priority: P1) 🎯 MVP

As a CAD Designer, I want to run a single validation check across all parts in my assembly so that I can immediately identify sheet-metal unfolding failures and physical part intersections.

**Why this priority**: Core value of the feature. Users need to verify assembly integrity quickly before sending parts to manufacturing.

**Independent Test**: Load a multi-part STEP assembly containing some overlapping parts and a non-unfoldable sheet metal part, run the validation tool, and assert that the output lists the exact part IDs that fail sheet-metal checks and the exact overlapping pairs with zero false positives.

**Acceptance Scenarios**:

1. **Given** a loaded assembly with a sheet-metal part that has self-intersecting bends, **When** I call `validate_assembly`, **Then** the validation report highlights that part as failing the unfolding check and marks it as an error.
2. **Given** an assembly of 50 parts where parts A and B overlap physically, **When** I call `validate_assembly`, **Then** the validation report highlights parts A and B as intersecting and reports their overlap.

---

### User Story 2 - Get Autofix Recommendations (Priority: P2)

As an Engineer using an AI agent, I want validation errors to include detailed, structured suggestions for how to fix them (including the specific MCP tool and the parameters to call it) so that my AI agent can automatically resolve the issues.

**Why this priority**: Allows closed-loop automation of CAD editing, letting AI agents repair the models they analyze.

**Independent Test**: Create a validation error for a non-sheet-metal surface part. Assert that the validation output contains an `autofix` block recommending the `split_body_by_bends` tool with correct arguments (e.g., `part_id`, `max_thickness_mm`).

**Acceptance Scenarios**:

1. **Given** a sheet-metal unfolding error caused by missing thickness definition, **When** I run validation, **Then** the error details include an `autofix` recommendation suggesting `split_body_by_bends` with the default thickness parameter.
2. **Given** an intersection error between two adjacent panels, **When** I run validation, **Then** the error details recommend `trim_body_with_plane` specifying the target part and the cutting plane derived from the adjacent face.

---

### User Story 3 - Modular Rule Extensibility (Priority: P3)

As a Lead System Architect, I want the validation tool to have a modular rule-based structure so that I can easily plug in new validation modules (such as semantic graph rules, manufacturing constraints, and nesting layouts) without modifying the core validation engine.

**Why this priority**: Future-proofing the codebase to support advanced design-for-manufacturing (DFM) rules.

**Independent Test**: Register a mock validation rule under a new category (e.g., `nesting_errors`), verify that the validation runner executes it, and check that its results are cleanly appended to the output JSON report.

**Acceptance Scenarios**:

1. **Given** a registered custom rule for checking part distance limits, **When** I run `validate_assembly`, **Then** the custom rule is executed and its warnings appear under the designated validation category.

---

### Edge Cases

- **Part Adjacency Calculation**: Two parts are extremely close but not touching (e.g., 0.05 mm gap). To prevent $O(N^2)$ checks, the bounding boxes are checked for proximity. The system must treat close proximity (within a configurable tolerance) as adjacent for intersection testing.
- **Large Assemblies (N > 1000)**: The validation must run under 5 seconds. To achieve this, a Sweep-and-Prune or octree-based AABB filtering pass must run first to narrow down candidate intersecting pairs.
- **Part Mode Ambiguity**: A part is classified as sheet metal by the system, but the user intended it to be a machined block. The tool must check for explicit user tags before falling back to automatic classification.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a new MCP tool `validate_assembly` that evaluates all parts in the current transaction.
- **FR-002**: The `validate_assembly` tool MUST run a **Sheet Metal Unfolding Rule**:
  - For each part tagged or classified as sheet metal, it must call the unfolding library and verify that it produces a valid flat pattern without self-intersections.
  - If unfolding fails, it must emit a `SHEET_METAL_UNFOLD_FAILED` error.
- **FR-003**: The `validate_assembly` tool MUST run an **Intersection/Clash Rule**:
  - It MUST perform an initial fast AABB (Axis-Aligned Bounding Box) filtering pass to identify candidate intersecting pairs.
  - It MUST only run exact topological/B-Rep intersection checks (`BRepAlgoAPI_Section`) on pairs of parts that are topologically adjacent or whose bounding boxes overlap.
  - It MUST NOT run $O(N^2)$ exact checks for non-overlapping, distant parts.
- **FR-004**: For each validation error/warning, the system MUST return a structured `autofix` object containing:
  - `tool_name`: The name of the MCP tool to run (e.g., `split_body_by_bends`, `trim_body_with_plane`).
  - `arguments`: A JSON object containing the exact parameters to pass to that tool.
- **FR-005**: The validation engine MUST follow a registry pattern:
  - Rules must be grouped by categories: `sheet_metal`, `clash_detection`, `semantic_graph`, `manufacturing`, `nesting`.
  - It must be possible to register new rule classes dynamically without modifying the validator loop.
- **FR-006**: The system MUST identify sheet-metal parts using the metadata provided as a parameter or core part metadata. By default, the system MUST treat all parts as sheet metal unless they are explicitly flagged as non-sheet-metal.
- **FR-007**: The autofix system MUST return autofix suggestions purely as recommendation metadata (specifying the tool name and arguments), leaving execution control to the client or invoking AI agent.

### Key Entities *(include if feature involves data)*

- **ValidationReport**: The main result of a validation run, containing a list of `ValidationError` entities and general metadata (execution time, rule count).
- **ValidationError**:
  - `id`: Unique identifier of the error.
  - `category`: String representing the type of rule (e.g., `clash_detection`, `sheet_metal`).
  - `severity`: Enum (`error`, `warning`, `info`).
  - `message`: User-friendly description of the problem.
  - `affected_part_ids`: List of part IDs involved.
  - `autofix`: Optional `AutofixRecommendation` entity.
- **AutofixRecommendation**:
  - `tool_name`: String matching an active MCP tool schema.
  - `arguments`: Key-value map of parameters.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Validation on assemblies of up to 500 parts must complete in under **2.0 seconds** when no clashes exist.
- **SC-002**: The clash detection must successfully filter out at least **95% of non-adjacent part pairs** during the fast AABB pass, avoiding expensive B-Rep checks.
- **SC-003**: 100% of generated sheet metal flat pattern errors must provide at least one valid autofix suggestion.
- **SC-004**: Adding a new validation category must require modifying exactly **zero lines** of code in the core validation loop (adhering to the Open-Closed Principle).

## Assumptions

- We assume that the user's workspace contains an active database transaction or state registry representing the active parts.
- The AABB calculation is extremely fast in OpenCASCADE (using `BRepBndLib`), and we can rely on it for the pre-filtering pass.
- We assume that "adjacency" in the semantic graph includes parts that are connected via shared joints, contact faces, or adjacent nodes in the assembly tree.
