# UI Integration Specification for MCP-CAD

Status: Draft
Date: 2026-05-18
Scope: Frontend product UI consuming the existing MCP server contract

## 1. Purpose

Define the MCP contract and UI-facing behavior needed to build a production UI that drives the CAD workflow end-to-end.

This specification is UI-oriented and assumes the backend follows the current bounded-context design:
- Geometry Engine (C++ via NAPI)
- Manufacturing Domain (TypeScript)
- Feature Extractor (ACL)
- MCP Protocol Layer (TypeScript)

## 2. UX Goals

The UI must support three operator goals:
1. Load and validate a part.
2. Transform geometry into manufacturable outputs with visible checks.
3. Export production artifacts with async progress and recoverable errors.

## 3. Transport and Session Model

### 3.1 MVP Transport
- Primary: MCP over stdio (local tool host).
- Optional UI-host bridge: local service that proxies MCP calls over HTTP/WebSocket for browser clients.

### 3.2 Session Behavior
- Single active session per running MCP process (MVP rule).
- UI must treat all part IDs, panel IDs, unfold IDs, nest IDs, and rollback tokens as session-scoped.
- UI must reset local state when session/process restarts.

### 3.3 Session State in UI
UI state model should include:
- activePart: { solidId, isManifold }
- panels: ShellId[]
- unfolds: UnfoldId[]
- nest: { nestId, utilisationPct, sheetsRequired }
- exportJob: { jobId, status, progress }
- snapshots: RollbackToken[] (timeline)
- clashReport: { intersects, clashes[] } | null
- gapReport: { hasGap, minimumDistanceMm, closestElements, extensionVector } | null
- complianceResult: { compliant, violations[], envelopeType } | null
- assemblies: AssemblyId[] (active assemblies in the session)
- assemblyTrees: Record<AssemblyId, ListAssemblyResult> (hierarchical trees keyed by assembly ID)
- activeTransaction: { transactionId, label, product } | null
- transactionHistory: ShapeHistoryRecord[] (accumulated topology operations)
- semanticCatalog: SemanticEntity[] (declared engineering concepts)
- semanticLineage: Record<SemanticId, LineageRecord[]> (history of bindings in the session)

Derived shell IDs created by split, merge, extend, offset, add_flange, rip_edge, transforms, booleans, sewing, decomposition, and assembly components are session-scoped and must be tracked alongside `panels`. The UI must invalidate downstream state (unfolds, nest, compliance) whenever any mutating body-topology, direct-modeling, boolean, transform, sewing, or decomposition tool executes.

## 4. Required MCP Resources (Read Models)

The UI must be able to render and refresh these resources:
- context://intent/environmental
- context://intent/assembly
- logistics://envelope/shipping
- logistics://envelope/coating
- manufacturing://tooling/press_brake
- manufacturing://material/inventory
- manufacturing://rules
- geometry://part/{id}/topology
- geometry://part/{id}/features
- geometry://part/{id}/nest

UI requirements:
- Resource fetches should be idempotent and safe to refresh.
- UI should cache immutable session snapshots for timeline/compare views.

## 5. Required MCP Tools (Write/Action Model)

The UI must support invoking all production tools, grouped by category:

### 5.1 Core Pipeline
1. clean_geometry
2. decompose_volume
3. synthesize_joints
4. generate_reliefs
5. apply_unfold
6. simulate_nesting
7. evaluate_manufacturability
8. validate_bend_sequence
9. export_production_pack
10. get_export_job_status
11. get_export_job_result
12. rollback

### 5.2 Diagnostics (Non-Mutating)
These tools read geometry state without modifying it. They do not produce a rollback token and are safe to call at any workflow stage.

13. `compute_intersections` — Detects volumetric clashes between a set of shell bodies. Returns a `ClashReport` with per-pair intersection volumes and suggested cutting planes.
14. `compute_gaps` — Measures the minimum distance between two shell bodies. Returns gap distance, closest face pair, and extension vector.
15. `check_boundary_compliance` — Validates whether a shell body fits within the configured shipping or coating logistics envelope. Returns `compliant` flag and axis-level violations.

### 5.3 Direct Modeling (Mutating)
Each tool creates a rollback token. The UI must capture and store it before allowing further mutations. All mutating tools invalidate any existing unfolds, nesting results, or compliance checks derived from the affected shell.

16. `trim_body_with_plane` — Trims a shell to one side of a cutting plane. Inputs: `part_id`, `plane` (normal + origin), `keep_positive_side`.
17. `split_body_by_plane` — Splits a shell into two named bodies along a cutting plane. Inputs: `part_id`, `cutting_plane`, `output_names[2]`. Outputs: `positive_shell_id`, `negative_shell_id`.
18. `merge_bodies_with_bend` — Fuses two adjacent shells into one, optionally filleting the seam. Inputs: `part_a_id`, `part_b_id`, `target_edges[]`, `bend_radius`. Output: `merged_shell_id`.
19. `extend_face_to_target` — Extends a face until it reaches a target plane, face, or surface. Inputs: `part_id`, `face_id`, `target_type`, `target`. Output: `modified_shell_id`, `extension_distance_mm`.
20. `offset_face` — Offsets a single face along its normal (positive = add material, negative = remove). Inputs: `part_id`, `face_id`, `distance`. Output: `modified_shell_id`.

### 5.4 Sheet Metal Detailing (Mutating)
21. `add_flange` — Adds a return flange to an open (boundary) edge. Inputs: `part_id`, `edge_id`, `length`, `angle`, `bend_radius`. Outputs: `modified_shell_id`, `flange_feature_id`.
22. `rip_edge` — Severs an interior edge, creating a topological seam so `apply_unfold` can flatten the body. Inputs: `part_id`, `edge_id`. Output: `modified_shell_id`.

### 5.5 Boolean Operations (Mutating)
These tools fuse, cut, or intersect solid bodies and shells. They require a transaction and return shape history records for semantic remapping.

23. `fuse_bodies` — Fuses two or more solid/shell bodies. Inputs: `tools` (array of shell IDs), `fuzzy_tolerance` (optional, default 1e-5). Outputs: `solid_id`, `disjoint` flag, `rollback_token`, `shape_history`.
24. `cut_bodies` — Subtracts tool bodies from a blank body. Inputs: `blank` (shell ID), `tools` (array of shell IDs), `keep_tools` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`.
25. `intersect_bodies` — Computes the volumetric intersection of two bodies. Inputs: `a` (shell ID), `b` (shell ID). Outputs: `solid_id`, `rollback_token`, `shape_history`. Throws `GE_BOOLEAN_EMPTY_RESULT` if disjoint.

### 5.6 Topological Interrogation (Non-Mutating)
These read-only tools retrieve structural and geometric metrics. They require no transaction.

26. `bounding_box` — Computes the axis-aligned bounding box (AABB) of a shell/solid. Inputs: `target` (shell ID). Outputs: `x_min`, `y_min`, `z_min`, `x_max`, `y_max`, `z_max`.
27. `mass_properties` — Computes mass, volume, surface area, centroid, and inertia tensor. Inputs: `target` (shell ID), `properties` (array of properties, optional). Outputs: `volume`, `surface_area`, `centroid` (array of 3), `inertia_tensor` (array of 9).
28. `measure_distance` — Measures minimum/maximum distance or angle between two entities. Inputs: `entity_a` (ID), `entity_b` (ID), `measurement_type` (min_distance, max_distance, angle). Outputs: `value` (number). Throws `GE_ALIGN_UNSUPPORTED` for angle measurement on non-planar surfaces.
29. `explore_topology` — Lists sub-shapes (faces, edges, wires) of a parent shape in standard iteration order to resolve entity IDs for subsequent operations. Inputs: `target` (shell ID), `return_type` (face, edge, wire). Outputs: `entity_ids` (array of strings).

### 5.7 Geometric Transformations (Mutating)
These tools perform rigid body and scaling transformations. They require a transaction and support keeping the original shell.

30. `translate_body` — Shifts target bodies along a translation vector. Inputs: `targets` (array of shell IDs), `translation` (array of 3 numbers), `keep_original` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`.
31. `rotate_body` — Rotates target bodies around a specified 3D axis. Inputs: `targets` (array of shell IDs), `axis_origin` (array of 3), `axis_direction` (array of 3), `angle_deg` (number), `keep_original` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`.
32. `mirror_body` — Mirrors target bodies across a 3D plane. Inputs: `targets` (array of shell IDs), `plane_origin` (array of 3), `plane_normal` (array of 3), `keep_original` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`.
33. `scale_body` — Scales target bodies uniformly from an origin. Inputs: `targets` (array of shell IDs), `origin` (array of 3), `scale_factor` (number), `keep_original` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`. Throws `GE_SCALE_NON_UNIFORM` if scaling factors are non-uniform or negative.
34. `align_to_face` — Snaps a source body to align planar faces. Inputs: `source_face` (string), `destination_face` (string), `flip_normal` (boolean), `keep_original` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`. Throws `GE_ALIGN_UNSUPPORTED` if either face is non-planar.

### 5.8 Advanced Direct Editing (Mutating)
These tools perform direct face and edge modifications. They require a transaction and emit semantic remapping histories.

35. `fillet_edges` — Blends sharp interior or exterior edges with a cylindrical radius. Inputs: `part_id` (shell ID), `edge_ids` (array of strings), `radius` (number). Outputs: `solid_id`, `rollback_token`, `shape_history`. Throws `GE_FILLET_TOO_LARGE` if the radius exceeds geometric limits.
36. `chamfer_edges` — Bevels sharp edges. Inputs: `part_id` (shell ID), `edge_ids` (array of strings), `distance` (number). Outputs: `solid_id`, `rollback_token`, `shape_history`. Throws `GE_CHAMFER_TOO_LARGE` if the distance exceeds bounds.
37. `simplify_body` — Merges redundant co-planar faces and co-linear edges to clean up the topology. Inputs: `part_id` (shell ID), `unify_faces` (boolean), `unify_edges` (boolean). Outputs: `solid_id`, `rollback_token`, `shape_history`.
38. `heal_geometry_ex` — Heals complex boundary defects (bad wires, untoleranced edges) and reports remaining issues. Inputs: `part_id` (shell ID), `fix_tolerances` (boolean), `fix_wires` (boolean). Outputs: `solid_id`, `heal_complete` (boolean), `remaining_issues` (array of strings), `rollback_token`, `shape_history`.
39. `offset_shape` — Offsets all faces of a solid body inward or outward (thickening/thinning). Inputs: `part_id` (shell ID), `offset_value` (number), `tolerance` (number, optional). Outputs: `solid_id`, `rollback_token`, `shape_history`.
40. `delete_face` — Removes specified faces and heals the boundary, or separates the shape into multiple independent solid parts. Inputs: `part_id` (shell ID), `face_ids` (array of strings), `heal_remaining` (boolean). Outputs: `solid_ids` (array of strings), `rollback_token`, `shape_history`.

### 5.9 Topology Sewing (Mutating)
Stitches a set of loose/open adjacent faces into a watertight shell or solid.

41. `sew_faces` — Stitches faces with a defined search tolerance. Inputs: `entity_ids` (array of strings), `tolerance` (number), `make_solid` (boolean). Outputs: `solid_id`, `sew_complete` (boolean), `free_edges` (array of strings), `rollback_token`, `shape_history`.

### 5.10 Hierarchical Assembly (Mutating & Non-Mutating)
Provides tools for creating multi-part hierarchical assemblies using XCAF.

42. `create_assembly_document` — Initializes a new empty hierarchical assembly document. Inputs: none (requires transaction). Outputs: `assembly_id`.
43. `add_assembly_instance` — Adds an instance of a part shape or sub-assembly to an assembly with an optional 3D location. Inputs: `assembly_id` (string), `target` (part or sub-assembly ID), `location` (optional object containing translation `[x,y,z]` and orientation `[w,x,y,z]`). Outputs: `component_id`, `rollback_token`.
44. `mate_rigid` — Snaps two planar component faces together to establish a rigid connection, computing the relative transformation matrix. Inputs: `assembly_id` (string), `source_face` (string), `destination_face` (string), `flip_alignment` (boolean). Outputs: `component_id`, `location_matrix` (column-major array of 16), `rollback_token`. Throws `GE_ASSEMBLY_MATE_UNSUPPORTED` if faces are non-planar.
45. `list_assembly_tree` — Non-mutating tool to retrieve the recursive hierarchical assembly node tree. Inputs: `assembly_id` (string). Outputs: `assembly_id`, `root` (AssemblyNode tree containing `component_id`, `shape_id`, `location_matrix`, and `children[]`).

### 5.11 Transaction Lifecycle (Mutating & Non-Mutating)
Manages explicit multivariant transaction contexts for atomically committing or reverting complex sequences of operations.

46. `begin_transaction` — Opens an explicit transaction to capture a history of geometry updates. Inputs: `label` (string, required), `product` (string, optional). Outputs: `transaction_id`.
47. `commit_transaction` — Commits the specified transaction. Discards the pre-transaction snapshot, making all changes permanent. Inputs: `transaction_id` (string). Outputs: `success` (boolean).
48. `rollback_transaction` — Reverts all operations executed during the transaction to their pre-transaction state. Inputs: `transaction_id` (string). Outputs: `success` (boolean).
49. `get_transaction_history` — Retrieves the topological history (shape replacements/deletions) accumulated in the active or committed transaction. Inputs: `transaction_id` (string). Outputs: `history` (array of `ShapeHistoryRecord` containing `verdict`, `original_id`, `new_id`, and `operation_label`).

### 5.12 Semantic Entity Mapping (Mutating & Non-Mutating)
Provides long-lived associations between conceptual design features and evolving, volatile topological entities (faces/bodies).

50. `declare_semantic_entity` — Registers a unique conceptual identity using a semantic URI. Inputs: `id` (string, e.g. `semantic://<product>/<slug>`), `type` (string, enum: `panel`, `panel_group`, `joint_interface`, `functional_system`, `spatial_region`), `purpose` (array of strings, optional), `relationships` (array of objects containing `relationship` and `target`, optional), `transaction_id` (string). Outputs: `success` (boolean).
51. `bind_semantic_entity` — Maps a declared semantic entity to specific geometric entities. Inputs: `semantic_id` (string), `binding` (object containing `kind` e.g., `face_group` with `face_ids`, `body` with `body_id`, or `spatial_region` with `between`), `transaction_id` (string). Outputs: `success` (boolean).
52. `resolve_geometry` — Retrieves the concrete geometry boundaries mapped to a semantic entity at the current state or a specific revision. Inputs: `semantic_id` (string), `at_revision` (integer, optional). Outputs: `binding` (object containing geometric references).
53. `semantic_lineage` — Retrieves the chronological binding history and remapping explanations for a semantic entity. Inputs: `semantic_id` (string). Outputs: `lineage` (array of objects showing `transaction_id`, `binding`, and `remap_reason`).

### 5.13 Advanced Decomposition and Protrusion Removal (Mutating)
Accelerates the flat-pattern modeling preparation workflow by automatically segmenting thin-walled parts and extracting non-panel geometry.

54. `split_body_by_bends` — Segments a thin-walled solid shell into planar panel bodies by cutting along automatically detected bend regions. Inputs: `part_id` (string), `angle_threshold_deg` (number, optional), `max_thickness_mm` (number, optional), `default_thickness_mm` (number, optional), `max_recursion_depth` (integer, optional), `transaction_id` (string, optional). Outputs: `panel_ids` (array of strings), `protrusion_ids` (array of strings), `detected_mode` (enum: `thin-solid`, `surface`), `rollback_token`.
55. `remove_protrusions` — Extracts structural protrusions (flanges, bosses, tabs) from a shell body without performing full panel splitting. Inputs: `part_id` (string), `angle_threshold_deg` (number, optional), `max_thickness_mm` (number, optional), `transaction_id` (string, optional). Outputs: `cleaned_part_id` (string), `protrusion_ids` (array of strings), `rollback_token`.

## 6. UI Workflow Contract

### 6.1 Primary Flow
1. clean_geometry(file_path)
2. decompose_volume(solid_id, strategy)
3. synthesize_joints(panel_ids, joint_type, clearance_mm)
4. apply_unfold(panel_id, material_id[, k_factor])
5. simulate_nesting(unfold_ids, sheet_size)
6. export_production_pack(nest_id, include_bom, include_assembly)
7. poll get_export_job_status(job_id)
8. retrieve get_export_job_result(job_id)

### 6.2 Validation Side Flows
- evaluate_manufacturability(panel_id, material_id) at panel checkpoints.
- validate_bend_sequence(panel_id) before export.
- check_boundary_compliance(part_id, envelope_type) after decompose or any mutating operation.
- rollback(rollback_token) from timeline.

### 6.3 Clash and Gap Resolution Flow
When `evaluate_manufacturability` or manual inspection reveals geometry problems, the UI must support the following repair loop. The UI should make this discoverable from the diagnostics panel.

1. **Detect** — `compute_intersections(part_ids[])` to find overlapping panels. Display each `ClashPair` with the intersection volume and suggested cutting plane.
2. **Trim** — For each clash, offer `trim_body_with_plane` pre-populated with `suggested_cutting_plane` from the clash report.
3. **Detect gaps** — `compute_gaps(part_a_id, part_b_id, threshold_mm)` between adjacent panels. Display gap distance and the extension vector.
4. **Close** — Offer `extend_face_to_target` pre-populated from the gap report, or `offset_face` for thickness adjustments.
5. **Verify** — Re-run `compute_intersections` to confirm clean geometry before proceeding.

### 6.4 Direct Modeling Flow
For panels that require structural adjustment before joints or unfold:

1. **Split** — `split_body_by_plane` to divide a panel at a cutting plane. Both output shells are added to the panel list.
2. **Merge** — `merge_bodies_with_bend` to join two adjacent panels into a single bent component. The merged shell replaces both inputs.
3. **Flange** — `add_flange` on a boundary edge. `flange_feature_id` is stored for downstream BOM reference.
4. **Rip** — `rip_edge` on interior corners before `apply_unfold` when the unfolder reports a topology error.

All mutating steps in this flow produce rollback tokens. The UI must push each token onto the snapshot timeline before the next operation.

### 6.5 Evaluation Flow
- Braai STL stress scenario is non-gating.
- UI can expose this in an "Advanced/Stress" section, clearly labeled non-standard.

### 6.6 Transaction Management Flow
Operators use explicit transaction contexts to group high-risk, compound direct-modeling sequences (e.g. performing multiple splits, merges, and detailing steps) to allow atomic rollback or commit:
1. **Begin Transaction** — UI calls `begin_transaction` with a custom label (e.g. "Stitching firebox panels"). The returned `transaction_id` is registered as the active transaction context.
2. **Execute Operations** — Every mutating tool call initiated by the user is passed the active `transaction_id`.
3. **Inspect History** — The UI polls `get_transaction_history` to display a live diff/history of changed topological entities to the operator.
4. **Finalize** — The operator either approves the compound change (UI calls `commit_transaction`) or aborts the session (UI calls `rollback_transaction`), restoring the exact pre-transaction state.

### 6.7 Semantic Mapping Flow
To ensure stable downstream engineering annotations (e.g., custom coatings, tooling warnings, or weld labels) when geometries undergo topological modification, the UI implements semantic binding:
1. **Declare Entity** — The UI registers conceptual objects by calling `declare_semantic_entity` (e.g. `semantic://grill/firebox-bottom`).
2. **Establish Binding** — The operator selects a set of faces or a body in the 3D viewport, and the UI invokes `bind_semantic_entity` to link the conceptual URI to those exact IDs.
3. **Automatic Remapping** — If a face is split (via `split_body_by_plane` or `split_body_by_bends`), the backend mapping layer automatically intercepts the operation and remaps the semantic entity to the newly created sub-shapes.
4. **Query & Trace** — The UI uses `resolve_geometry` to keep annotations correctly aligned in the viewport, and exposes a "Lineage" tab showing how a face evolved through mutating transactions using `semantic_lineage`.

### 6.8 Advanced Decomposition Flow
For rapid sheet-metal preparation of closed solids or conceptual surface representations:
1. **Analyze and Split** — The UI invokes `split_body_by_bends` on the imported part solid.
2. **Mode Detection** — The UI inspects `detected_mode` (`thin-solid` for sheet metal walls, or `surface` for conceptual surfaces) to configure subsequent press-brake or tooling rules.
3. **Isolate Protrusions** — Extracted boss/flange geometries are separated into `protrusion_ids` and rendered as distinctive visual layers, preventing noise in flat-pattern unfolding.

## 7. Error and Recovery Contract

All errors must be handled as structured objects:
- code: string
- message: string
- recoverable: boolean
- suggested_tool?: string

UI requirements:
- Show user-friendly copy by error code mapping.
- For recoverable=true, surface next-action CTA (for example "Run clean_geometry").
- For recoverable=false, preserve raw diagnostics panel for support/debug.

### 7.1 Core Pipeline Errors
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `EXPORT_JOB_NOT_FOUND` | "Export job not found" | false | Re-submit export |
| `EXPORT_JOB_NOT_COMPLETE` | "Export still processing" | true | Poll again |
| `INTERNAL_ERROR` | "An unexpected error occurred" | false | Contact support |
| `MD_SAFETY_VIOLATION` | "Joint type not allowed in this environment" | true | Change joint type |

### 7.2 Geometry Engine Errors (existing)
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `GE_IMPORT_FAILED` | "Could not read STEP file" | false | Check file format |
| `GE_HEAL_FAILED` | "Geometry healing failed" | false | Inspect model in source CAD |
| `GE_BOOLEAN_FAILURE` | "Boolean operation failed" | false | Use a different cutting plane |
| `GE_UNFOLD_FAILED` | "Unfold failed" | true | Run rip_edge, then retry |
| `GE_TAB_SLOT_FAILED` | "Joint generation failed" | true | Adjust clearance or joint type |

### 7.3 New Tool Errors
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `GE_CLASH_DETECTION_FAILED` | "Clash detection failed" | true | Reduce number of parts checked |
| `GE_GAP_DETECTION_FAILED` | "Gap measurement failed" | true | Check both part IDs are valid |
| `GE_TRIM_FAILED` | "Trim operation failed" | true | Adjust cutting plane position |
| `GE_SPLIT_FAILED` | "Split produced an empty body" | true | Move cutting plane away from edge |
| `GE_EXTEND_FAILED` | "Face extension failed — self-intersection" | true | Choose a closer target |
| `GE_OFFSET_FAILED` | "Face offset failed — invalid geometry" | true | Reduce offset distance |
| `GE_FLANGE_FAILED` | "Flange could not be added" | true | Check edge is a boundary edge |
| `GE_EDGE_NOT_OPEN` | "Edge is not a boundary edge" | true | Select an open edge for flanging |
| `GE_RIP_FAILED` | "Edge rip failed — degenerate topology" | false | Inspect part in topology view |
| `GE_EDGE_NOT_INTERIOR` | "Edge is already a boundary — cannot rip" | true | Select an interior corner edge |
| `GE_MERGE_FAILED` | "Merge produced a non-manifold body" | true | Check parts are truly adjacent |
| `MD_LOGISTICS_NOT_CONFIGURED` | "Logistics envelope not set in config" | false | Update manufacturing config |
| `GE_BOOLEAN_EMPTY_RESULT` | "Boolean operation produced an empty intersection" | true | Adjust overlapping geometries |
| `GE_ALIGN_UNSUPPORTED` | "Alignment/mate only supported on planar faces" | true | Select a flat face |
| `GE_SCALE_NON_UNIFORM` | "Scaling must be uniform and positive" | true | Specify a uniform positive scaling factor |
| `GE_FILLET_TOO_LARGE` | "Fillet radius exceeds geometric face boundary" | true | Reduce fillet radius |
| `GE_CHAMFER_TOO_LARGE` | "Chamfer distance exceeds face boundaries" | true | Reduce chamfer distance |
| `GE_HEAL_INCOMPLETE` | "Some boundary healing issues remain" | true | Inspect the remaining issues list |
| `GE_SEW_INCOMPLETE` | "Sewing could not close the shell" | true | Increase tolerance or inspect free edges |
| `GE_ASSEMBLY_MATE_UNSUPPORTED` | "Mated components must have planar faces" | true | Select flat mating faces |
| `GE_ASSEMBLY_CROSS_DOCUMENT` | "Cross-document mating is unsupported" | false | Ensure both components are in the same assembly |

### 7.4 Transaction Lifecycle Errors
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `TRANSACTION_NOT_FOUND` | "The requested transaction does not exist or was rolled back" | false | Restart modeling sequence |
| `TRANSACTION_NOT_ACTIVE` | "No active transaction was found for this operation" | true | Begin a new transaction first |
| `TRANSACTION_ALREADY_ACTIVE` | "A transaction is already active in this session" | true | Commit or rollback current transaction |
| `TRANSACTION_MISMATCH` | "The transaction ID does not match the active session context" | false | Use correct active transaction ID |

### 7.5 Semantic Mapping Errors
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `PERSISTENCE_UNAVAILABLE` | "Semantic database storage is offline" | false | Verify server configuration |
| `PERSISTENCE_COMMIT_FAILED` | "Could not commit semantic mapping changes" | false | Retry operation or check logs |
| `SEMANTIC_ID_EXISTS` | "This semantic entity ID is already registered" | true | Use a unique semantic URI |
| `SEMANTIC_ID_NOT_FOUND` | "The specified semantic entity was not found" | true | Ensure entity has been declared |
| `SEMANTIC_ID_INVALID` | "The semantic URI format is invalid" | true | Use `semantic://<product>/<slug>` format |
| `SEMANTIC_TYPE_NOT_SUPPORTED` | "The semantic entity type is unsupported" | true | Select a valid entity type |
| `SEMANTIC_RELATIONSHIP_NOT_SUPPORTED` | "The specified relationship is not supported" | true | Use standard relationship types |
| `BINDING_FACE_ALREADY_BOUND` | "This geometric face is already bound to another concept" | true | Unbind face or use a multi-binding region |
| `BINDING_KIND_NOT_SUPPORTED` | "The geometric binding type is unsupported" | true | Choose a supported binding kind |
| `SEMANTIC_CONSTITUENT_NOT_FOUND` | "One or more constituents of the spatial region are missing" | true | Verify target entities are declared |
| `REVISION_NOT_FOUND` | "The requested geometry revision does not exist" | true | Select a valid revision index |

### 7.6 Advanced Decomposition Errors
| Code | User message | Recoverable | Suggested action |
|---|---|---|---|
| `GE_DECOMPOSE_BY_BENDS_FAILED` | "Automated bend decomposition failed" | true | Check STEP file model integrity |
| `GE_DECOMPOSE_THICKNESS_MISMATCH` | "Varying shell wall thicknesses detected" | true | Specify uniform max_thickness limits |
| `GE_DECOMPOSE_EXTRUDE_FAILED` | "Extrusion failed in surface conceptual mode" | true | Heal geometry or use thin-solid mode |
| `GE_DECOMPOSE_CUT_FAILED` | "Decomposition cut failed due to degenerate edges" | true | Simplify the input body |
| `GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED` | "Could not separate protrusion geometry" | true | Isolate flanges before splitting |

## 8. Async Export UX Requirements

For export_production_pack:
- UI must return immediately to a job tracking state after submit.
- Poll interval: 500 ms to 1500 ms with exponential backoff.
- Terminal states: succeeded, failed.
- On succeeded: enable download/view links for dxf, bom_csv, assembly_json, svg_preview.

## 9. Determinism and Reproducibility Requirements

UI-integrated acceptance must verify:
- Re-running identical input in same config returns stable manufacturability and bend-sequence outputs.
- Session reset clears stale references.
- Rollback restores prior geometry IDs and invalidates later derived views.

## 10. Performance and Timeouts

- Standard STEP UI flow target: under 30 seconds end-to-end.
- Post-MVP Tier-3 Braai STL flow timeout budget: 120 seconds.
- UI must display progressive stage feedback for operations exceeding 1 second.

## 11. Security and Safety Constraints

- No UI override for safety filter enforcement.
- Unsafe joint types must be blocked by backend and reflected in UI controls.
- UI must not hard-code material/tooling limits; it must read from manufacturing resources.

## 12. Minimum UI Feature Set (MVP)

### 12.1 Core Pipeline
1. File ingest + validation panel
2. Decomposition strategy selector
3. Joint synthesis configurator
4. Unfold + nesting view with utilization metric
5. Manufacturability diagnostics panel
6. Async export job monitor
7. Rollback timeline
8. Structured error inspector

### 12.2 Geometry Repair (Direct Modeling)
9. Clash inspector — renders `ClashReport` per panel pair; surfaces suggested cutting plane as a pre-filled `trim_body_with_plane` action.
10. Gap inspector — renders `GapReport`; surfaces extension vector as a pre-filled `extend_face_to_target` action.
11. Compliance badge — shows pass/fail per envelope type with dimension breakdown; links to the logistics config resource.
12. Body operations panel — exposes `split_body_by_plane`, `merge_bodies_with_bend`, `offset_face`, `trim_body_with_plane` as guided forms. Each form pre-validates required fields before submitting.
13. Sheet metal detailing panel — exposes `add_flange` (with edge picker) and `rip_edge` (with interior-edge hint). Surfaces `GE_EDGE_NOT_OPEN` and `GE_EDGE_NOT_INTERIOR` inline on the edge selector.

### 12.3 Topology View
14. Topology explorer — read from `geometry://part/{id}/topology`; renders face list, edge list, and adjacency graph. Used to select `face_id` and `edge_id` inputs for direct modeling tools.

### 12.4 Transaction Control Panel
15. Transaction workspace manager — displays transaction details (label, transaction_id), state (active/committed), and lists accumulated shape topology history records.
16. Commit & Rollback triggers — prominent CTA buttons enabling users to atomically save changes or discard the entire sequence.

### 12.5 Semantic Entity Browser
17. Concept catalog — displays declared semantic entities mapped to their respective URIs, enabling creation, modification, and direct search.
18. Viewport highlight overlays — renders distinct color overlays in the 3D viewport for faces or bodies associated with the selected conceptual entity.
19. Lineage inspector — displays step-by-step history logs explaining when and why bindings evolved or were remapped.

### 12.6 Advanced Decomposition Control
20. Bend splitting wizard — guided interface allowing operators to choose decomposition modes (thin-solid vs. surface conceptual) with intuitive parameters (angle thresholds, max thickness, default extrusion limits).
21. Protrusion overlay manager — presents a separate sub-panel list for extracted protrusions, enabling toggling their visibility, exporting them independently, or ignoring them during unfold.

## 13. Acceptance Criteria (UI + MCP Contract)

### 13.1 Core Pipeline
1. UI can execute the full STEP → export flow without manual backend intervention.
2. UI correctly handles async export lifecycle (submit, poll, result).
3. UI displays and acts on structured recoverable errors.
4. UI enforces session scoping and clears invalid IDs after reset/rollback.
5. UI reads dynamic config constraints from MCP resources (no hard-coded limits).
6. UI handles safety-filter rejection with deterministic user messaging.

### 13.2 Clash and Gap Resolution
7. UI runs `compute_intersections` after decompose and surfaces any `ClashPair` entries with their suggested cutting planes.
8. UI runs `compute_gaps` between adjacent panels and surfaces gap distance; extension vector is shown as a directional hint.
9. A `trim_body_with_plane` triggered from a `ClashPair` suggestion completes without error; a subsequent `compute_intersections` returns `intersects: false`.
10. An `extend_face_to_target` triggered from a gap report returns `extension_distance_mm > 0`; the gap inspector refreshes automatically.

### 13.3 Compliance
11. `check_boundary_compliance` with `envelope_type: "shipping"` returns the correct `compliant` flag against the configured `shipping_envelope` limits.
12. UI surfaces per-axis violation details when `compliant: false` (length, width, height each shown separately).
13. `check_boundary_compliance` with `envelope_type: "coating"` throws `MD_LOGISTICS_NOT_CONFIGURED` when the coating envelope is absent; UI shows the correct error message.

### 13.4 Direct Modeling
14. `split_body_by_plane` produces two non-empty shell IDs; both appear in the panel list; rollback restores the original.
15. `merge_bodies_with_bend` returns a single manifold shell; the two source shells are removed from the panel list.
16. `add_flange` on a boundary edge succeeds; `flange_feature_id` is captured; the panel's topology view refreshes.
17. `add_flange` on an interior edge returns `GE_EDGE_NOT_OPEN`; UI displays the inline edge-selector error.
18. `rip_edge` on an interior corner enables a subsequent `apply_unfold` that previously returned `GE_UNFOLD_FAILED`.
19. `offset_face` with `distance: 0` is blocked by UI validation before the tool call is made.
20. Every mutating tool call appends its `rollback_token` to the snapshot timeline; rollback from any point restores the correct prior geometry.

### 13.5 Transaction Lifecycle
21. UI successfully starts an explicit transaction with `begin_transaction` and maps the active transaction context.
22. Multiple sequential mutating operations executed within a transaction accrue shape history records, retrievable via `get_transaction_history`.
23. `rollback_transaction` returns a success status and reverts the entire compound sequence of operations atomically.
24. `commit_transaction` saves the state permanently; subsequent operations on the transaction ID throw `TRANSACTION_NOT_FOUND`.

### 13.6 Semantic Mapping
25. Conceptual engineering terms can be declared as unique URIs and bound to face groups or bodies, surviving active session cycles.
26. Performing a topological split (e.g. via `split_body_by_plane` or `split_body_by_bends`) automatically remaps face-group bound semantic entities to their new matching sub-shape IDs in the mapping layer.
27. Viewport annotations and geometry highlights update automatically, reflecting the concrete resolved geometry returned by `resolve_geometry`.
28. Chronological lineage logs returned by `semantic_lineage` contain clear remapping explanations for each transaction checkpoint.

### 13.7 Advanced Decomposition
29. Calling `split_body_by_bends` decomposes a closed 3D solid part model into individual planar bodies and lists them in the UI panel inventory.
30. Extracted protrusions are successfully separated from primary panels and returned as independent visual layers in the UI.

## 14. Implementation Notes for Frontend Team

Recommended architecture:
- UI app (React/Vue/Svelte)
- MCP client adapter service
- State machine for workflow stages
- Typed contracts generated from tool/resource schemas

Recommended state machine stages:
- idle → cleaned → decomposed → jointed → unfolded → nested → exporting → exported
- cleaned | decomposed → repairing (clash/gap resolution and direct modeling loop)
- repairing → decomposed (on completion or rollback)
- any stage → error
- any mutable stage → rollback → prior stage

The `repairing` super-state covers all calls to `compute_intersections`, `compute_gaps`, `trim_body_with_plane`, `split_body_by_plane`, `merge_bodies_with_bend`, `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, and `check_boundary_compliance`. The UI returns to `decomposed` when the operator is satisfied with geometry or explicitly dismisses the repair panel.

## 15. Out of Scope

- Multi-session collaboration
- Tenant-level configuration overlays
- OAuth/remote auth
- Full 3D bend collision simulation
- Braai STL as release gate
- Tight bounding-box computation via `BRepBndLib` (compliance check uses face-area approximation; exact bbox is a future enhancement)
