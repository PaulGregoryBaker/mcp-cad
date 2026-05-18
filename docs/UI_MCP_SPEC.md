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

Derived shell IDs created by split, merge, extend, offset, add_flange, and rip_edge are session-scoped and must be tracked alongside `panels`. The UI must invalidate downstream state (unfolds, nest, compliance) whenever any mutating body-topology or direct-modeling tool executes.

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
