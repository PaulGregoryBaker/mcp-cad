# MCP Specification: AI-Driven Sheet Metal Manufacturing Orchestrator
**Version:** 5.0  
**Domain:** CAD/CAM & Automated Production Engineering  
**Target Environments:** Docker (Local/Edge Deployment) & Kubernetes (Cloud Scale Deployment)

---

## 1. Executive Summary & Design Philosophy

This Model Context Protocol (MCP) server acts as a deterministic **Geometry Intelligence and Orchestration Layer** for manufacturing. It bridges the gap between high-level AI reasoning agents and low-level programmatic CAD kernels (such as OpenCASCADE, CadQuery, or cloud-based enterprise CAD APIs).

### Core Principles
*   **CAD Orchestration, Not Generation:** The AI Agent never creates or edits raw geometry directly. It operates solely on structured boundary representation (B-Rep) state provided by the MCP, executing deterministic modification tools.
*   **Semantic Features Over Primitive Meshes:** The AI reasons using manufacturing vocabulary—such as **bends, loops, flanges, tabs, slots, and clearances**—rather than processing un-annotated STL triangle meshes or brittle scripts.
*   **The Source of Truth Remains Flat:** The exact geometric math, tolerances, unfolding calculations, and tooling checks are hardcoded inside the MCP/CAD engine. This completely eliminates "geometric hallucinations" like un-foldable bodies or self-intersecting loops.

---

## 2. Hybrid Deployment Architecture

The system abstracts the underlying CAD engine via a unified **Backend Abstraction Layer**. This enables identical tool-calling semantics whether deployed on a shop floor server or scaled horizontally across a cloud infrastructure.

```
+---------------------------------------------------------------------------------+
|                                   AI HARNESS                                    |
|              (Dialogue, User Intent Context, Strategic Reasoning)               |
+---------------------------------------------------------------------------------+
|
v  [Model Context Protocol]
+---------------------------------------------------------------------------------+
|                                   MCP SERVER                                    |
|               (Structured Resources, Tool Registry, Version Control)            |
+---------------------------------------------------------------------------------+
|
v  [Backend Abstraction Layer]
+---------------------------------------------------------------------------------+
|                               GEOMETRY SERVICES                                 |
|                                                                                 |
|   +----------------------------------+     +--------------------------------+   |
|   |          LOCAL ENGINE            |     |          CLOUD ENGINE          |   |
|   |  (Docker Pod: OCP / CadQuery)    |  OR |  (Kubernetes Pods: Web OCC /   |   |
|   |                                  |     |   Onshape API / Fusion API)    |   |
|   +----------------------------------+     +--------------------------------+   |
+---------------------------------------------------------------------------------+
```

### Infrastructure Implementation
*   **Local Instance (Docker):** Wrapped inside a standard python-slim container exposing a FastAPI/MCP gateway. Ideal for low-latency, offline edge computation on the factory floor.
*   **Cloud Instance (Kubernetes):** The MCP frontend pods route heavy geometric mutations (such as 2D nesting or shelling) asynchronously to a dedicated cluster of horizontal geometry-workers, leveraging distributed object storage for intermediate step tracking.

---

## 3. Structured Resource Hierarchy (The State Provider)

Resources expose the current physical, logistical, and environmental reality to the AI Harness. All resources use URI schemes to let the agent query specific states on demand.

### A. Project Context (`context://`)
*   `context://intent/environmental`: Functional parameters supplied by the engineer (e.g., operating temperature, vibration profiles, marine/corrosive environment, fire-rating).
*   `context://intent/assembly`: Strategic intent (e.g., "Field flat-pack assembly required" vs. "Permanent factory weldment").

### B. Logistics & Material Limits (`logistics://`)
*   `logistics://envelope/shipping`: Maximum bounded box dimensions (**L × W × H**) for crating, pallet allocation, or container shipping.
*   `logistics://handling/max_weight`: Maximum safe part weight before requiring automated cranes or dual-operator lifts (typically hardcoded to **23kg** / **50lbs**).
*   `logistics://envelope/coating`: Physical window limits of shop post-processing systems (e.g., powder-coating ovens, anodizing tanks).

### C. Manufacturing Capability (`manufacturing://`)
*   `manufacturing://tooling/press_brake`: Live catalog of physical punches, available V-die widths, bed lengths, and maximum tonnage ratings.
*   `manufacturing://material/inventory`: Active sheet metal inventory detailing available material gauges (thicknesses), grain directions, and documented K-factors.
*   `manufacturing://joints/available`: Allowed mechanical bonding techniques based on shop certs (e.g., `["tab_slot", "spot_weld", "pop_rivet", "pem_nut"]`).

### D. Live Geometry State (`geometry://`)
*   `geometry://part/{id}/topology`: The active Boundary Representation graph detailing faces, edges, vertex loops, and face adjacency.
*   `geometry://part/{id}/features`: Semantic groupings of recognized sheet metal elements (e.g., holes, countersinks, louvers, flat zones, existing folds).
*   `geometry://part/{id}/nest`: Production efficiency scores indicating nesting orientation optimization on a standard raw sheet.

---

## 4. MCP Tool Registry (The Action Layer)

Tools provide the AI Agent with deterministic operations to clean, decompose, modify, inspect, and export the design.

### Category A: Ingestion, Repair & Analysis
clean_geometry ──> evaluate_manufacturability

#### `clean_geometry`
*   **Description:** Validates and heals imported primitive STEP/IGES structures. Corrects non-manifold boundaries, closes open hulls, and eliminates sliver faces to pass a watertight B-Rep to the engine.
*   **Parameters:**
    *   `file_path` (string): Absolute location or object storage URI of the raw file.

#### `evaluate_manufacturability`
*   **Description:** Parses a target part against rules found in `manufacturing://`. Flags structural issues like features located too close to bend lines, narrow flanges below minimum tooling widths, or holes breaking the thickness constraint ($d < t$).
*   **Parameters:**
    *   `part_id` (string): Identifier of the part.

---

### Category B: Macro-Topology & Decomposition
decompose_volume ──> split_body_by_plane ──> merge_bodies_with_bend

#### `decompose_volume`
*   **Description:** Core volumetric segmentation engine. Automatically divides a solid 3D envelope into individual, uniform-thickness flat panel regions.
*   **Parameters:**
    *   `envelope_id` (string): Target solid envelope body.
    *   `strategy` (enum): `["integrity", "simplicity", "logistics"]`
        *   `integrity`: Prioritizes minimum total part counts, creating large "origami" structures with complex multi-axis folding requirements.
        *   `simplicity`: Prioritizes flat or single-bend components to eliminate complex folding steps, increasing overall part counts.
        *   `logistics`: Forces segments to fall within limits set by `logistics://envelope/shipping`.

#### `split_body_by_plane`
*   **Description:** Slices a panel into two separate independent entities using an infinite cutting plane.
*   **Parameters:**
    *   `part_id` (string): Target part to cut.
    *   `cutting_plane` (object): Vector configuration (`normal: [x, y, z]`, `origin: [x, y, z]`).
    *   `output_names` (array of strings): Labels assigned to the newly created bodies.

#### `merge_bodies_with_bend`
*   **Description:** Fuses two discrete sheet parts sharing an adjacent vector path into a single contiguous component joined by a physical bend.
*   **Parameters:**
    *   `part_a_id` (string): Initial panel identifier.
    *   `part_b_id` (string): Target panel identifier to attach.
    *   `target_edges` (array of strings): The specific overlapping edge entities to weld/bend.
    *   `bend_radius` (number): Targeted internal radius of the resulting fold.

---

### Category C: Local Direct Modeling (Collision & Gap Fixes)
extend_face_to_target ──> trim_body_with_plane ──> offset_face

#### `extend_face_to_target`
*   **Description:** Drives a specified panel terminal face along its normal direction until it hits a boundary surface, closing gaps between bodies.
*   **Parameters:**
    *   `part_id` (string): Target body identifier.
    *   `face_id` (string): Specific terminal boundary face to extend.
    *   `target_type` (enum): `["plane", "face_id", "part_surface"]`
    *   `target` (object): Coordinate parameters or target component ID matrix.

#### `trim_body_with_plane`
*   **Description:** Clips away material projecting past a defined geometric plane. Used to resolve cross-component interferences.
*   **Parameters:**
    *   `part_id` (string): Target part to crop.
    *   `cutting_plane` (object): Slice vector (`normal: [x, y, z]`, `origin: [x, y, z]`).
    *   `keep_side` (enum): `["positive", "negative"]` (Determines which half along the normal vector remains).

#### `offset_face`
*   **Description:** Shifts an individual face parallel to its original state. Used to expand material thicknesses or generate mechanical fit clearances.
*   **Parameters:**
    *   `part_id` (string): Target body.
    *   `face_id` (string): Structural face to shift.
    *   `distance` (number): Linear move distance (Positive values add material; negative values remove material).

---

### Category D: Semantic Sheet Metal Detailing
add_flange ──> rip_edge ──> synthesize_joints ──> generate_reliefs

#### `add_flange`
*   **Description:** Extrudes a brand new folded flange extension off an open outer raw edge of a sheet component.
*   **Parameters:**
    *   `part_id` (string): Target part identifier.
    *   `edge_id` (string): Open straight edge entity to modify.
    *   `length` (number): Absolute length extension of the new flange lip.
    *   `angle` (number): Angle of fold relative to the face normal (e.g., **90.0**).
    *   `bend_radius` (number): Targeted punch radius for internal bend profiles.

#### `rip_edge`
*   **Description:** Disconnects a sharp interior corner seam where two walls meet. This provides the necessary geometric break to allow flat unfolding.
*   **Parameters:**
    *   `part_id` (string): Target part.
    *   `edge_id` (string): Solid corner edge to tear open.

#### `synthesize_joints`
*   **Description:** Evaluates a mating edge pair and writes physical joint features (e.g., tab-and-slot arrays or rivet alignments) while automatically enforcing kerf and assembly clearances.
*   **Parameters:**
    *   `edge_pair_ids` (array of strings): Mating perimeter edges of adjacent components.
    *   `joint_type` (enum): `["tab_slot", "spot_weld", "pop_rivet", "pem_nut"]`
    *   `clearance_offset` (number): Assembly fit gap (typically **0.1mm** to **0.2mm** based on finish coating requirements).

#### `generate_reliefs`
*   **Description:** Modifies bend intersections by placing mechanical cutouts to prevent tearing, deformation, or wrinkling during high-tonnage folding operations.
*   **Parameters:**
    *   `part_id` (string): Target body.
    *   `relief_type` (enum): `["circular", "dogbone", "rectangular", "linear"]`

---

### Category E: Geometric Diagnostics & Verification
check_boundary_compliance ──> compute_intersections ──> compute_gaps

#### `check_boundary_compliance`
*   **Description:** Validates if a single part or a full assembly fits cleanly inside specific logistics parameters or machine envelopes.
*   **Parameters:**
    *   `target_id` (string): Part or sub-assembly code.
    *   `envelope_type` (enum): `["shipping", "coating", "raw_stock"]`

#### `compute_intersections`
*   **Description:** Runs an explicit Boolean clash calculation across selected parts. If a physical clash occurs, it generates the exact bounding dimensions and center mass vector of the error volume.
*   **Parameters:**
    *   `part_ids` (array of strings): Component entities to evaluate.

#### `compute_gaps`
*   **Description:** Scans the proximity gap between two components. If they are detached, it returns the shortest open vector and lists the closest target face references.
*   **Parameters:**
    *   `part_a_id` (string): Primary body.
    *   `part_b_id` (string): Secondary body.
    *   `max_distance_threshold` (number): Maximum search depth.

---

### Category F: Production Export & State Control
apply_unfold ──> simulate_nesting ──> export_production_pack ──> rollback

#### `apply_unfold`
*   **Description:** Employs empirical bend deduction equations ($L = A + B - BD$) to project a 3D component into a precise flat 2D manufacturing profile.
*   **Parameters:**
    *   `part_id` (string): Target part.
    *   `material_id` (string): Specific material lookup code to reference K-factor arrays.

#### `simulate_nesting`
*   **Description:** Packs 2D flat layouts onto raw stock sheet patterns. Returns material yield efficiencies and nesting orientation coordinates.
*   **Parameters:**
    *   `parts_list` (array of strings): Flattened parts to pack.
    *   `sheet_size` (array of numbers): `[width, height]` of raw stock sheet.

#### `export_production_pack`
*   **Description:** Compiles production documentation asynchronously (flat DXF assets, nested shop layouts, step-by-step folding guides, complete bend sequence tables, and BOM data). Returns a tracking token.
*   **Parameters:**
    *   `assembly_id` (string): Core production assembly.

#### `get_export_job_status` / `get_export_job_result`
*   **Description:** Polling tools to track long-running production export jobs and retrieve download endpoints once processing completes.

#### `rollback`
*   **Description:** Reverts the geometric assembly to a prior modification index if the AI Agent reaches an unresolvable structural error or tooling conflict.
*   **Parameters:**
    *   `assembly_id` (string): Target assembly scope.
    *   `version_delta` (integer): Number of historical states to reverse.

---

## 5. Reference JSON Parameter & Response Schemas

### Example A: Clashing Interference Detection
The AI calls `compute_intersections` across two intersecting panels. The MCP identifies the precise intersection volume and provides a suggested cutting plane.

**Tool Input Call:**
```json
{
  "tool": "compute_intersections",
  "arguments": {
    "part_ids": ["side_panel_left", "front_shield"]
  }
}
```
MCP JSON Response:

```JSON
{
  "intersects": true,
  "clashes": [
    {
      "part_id_1": "side_panel_left",
      "part_id_2": "front_shield",
      "intersection_volume": 42.50,
      "clash_bounding_box": {
        "origin": [450.0, 12.0, 0.0],
        "dimensions": [5.0, 12.0, 80.0]
      },
      "suggested_cutting_plane": {
        "normal": [1.0, 0.0, 0.0],
        "origin": [450.0, 0.0, 0.0]
      }
    }
  ]
}
```
Example B: Distance Gap Correction
The AI calls compute_gaps to determine why two parts are not touching. The MCP returns the minimum gap distance and the extension vector required to close it.

Tool Input Call:

```JSON
{
  "tool": "compute_gaps",
  "arguments": {
    "part_a_id": "rear_plate",
    "part_b_id": "top_flange_corner",
    "max_distance_threshold": 25.0
  }
}
```
MCP JSON Response:

```JSON
{
  "has_gap": true,
  "minimum_distance": 4.20,
  "closest_elements": {
    "part_a_face_id": "face_102",
    "part_b_face_id": "face_04"
  },
  "extension_vector": [0.0, 1.0, 0.0],
  "gap_bounding_box": {
    "origin": [120.0, 200.0, 10.0],
    "dimensions": [20.0, 4.20, 5.0]
  }
}
```
## 6. Operational Execution Loop

The AI Harness drives the design from a raw 3D envelope to finished manufacturing plans by executing this automated feedback loop:
```
    [1. INGEST & CLEAN] ──> Ingest STEP file ──> clean_geometry()
             │
             ▼
    [2. QUERY ENVIRONMENT] ──> Check context://, logistics://, and manufacturing://
             │
             ▼
    [3. SEGMENT ENVELOPE] ──> decompose_volume(strategy="logistics")
             │
   ┌─────────┴─────────┐
   ▼                   ▼
[4A. DIAGNOSE CLASHES] [4B. DIAGNOSE GAPS]
compute_intersections() compute_gaps()
   │                   │
   v                   v
trim_body_with_plane() extend_face_to_target()
   │                   │
   └─────────┬─────────┘
             ▼
    [5. INJECT FEATURES] ──> add_flange() ──> rip_edge() ──> generate_reliefs()
             │
             ▼
    [6. SYNTHESIZE JOINTS] ──> Apply tab-and-slot with kerf offsets via synthesize_joints()
             │
             ▼
    [7. VALIDATE & TEST] ──> evaluate_manufacturability() ──> validate_bend_sequence()
             │  (If Validation Fails: call rollback() and try alternative split strategy)
             ▼
    [8. EXPORT FOR PRODUCTION] ──> apply_unfold() ──> simulate_nesting() ──> export_production_pack()
```

## Advanced System Safeguards
Safety Interlocking Filters: If context://intent/environmental flags the build as "Fire-Rated," the MCP actively blocks synthesize_joints from using structural adhesives or plastic rivets, forcing the agent to select welding or heavy steel riveting options.

Kerf Enforcement Guardrails: Every joint creation tool automatically applies structural offset metrics retrieved dynamically from manufacturing://shop. This ensures laser-cut paths fit tightly together upon physical assembly.

Automatic Assembly Verification: When a joint is synthesized, the MCP verifies that a tool (such as a rivet gun or weld torch tip) can physically reach the target region without hitting neighboring components. If access is blocked, it throws an error to force the AI to choose an alternate joining strategy.

---

## Manufacturing Graph Tools (Feature 009)

These tools expose the Manufacturing Graph DAG — a session-scoped directed acyclic graph of `PanelNode`, `BendNode`, `JoinNode`, and `CutNode` objects that represents sheet-metal intent independently of B-Rep geometry.

### `bootstrap_graph`
Ingests an existing STEP solid (by `part_id`), calls `splitBodyByBends` to detect panels and bend zones, and populates the Manufacturing Graph with `PanelNode` + `BendNode` entries. Auto-solves geometry once at the end. Returns `rollback_token`, `panel_count`, `bend_count`, and `foldability_warnings`.

### `add_bend`
Adds a `BendNode` connecting two existing `PanelNode`s. Runs DRC (bend radius, flange width, press-brake accessibility) synchronously before any geometry call. On success, auto-solves and returns `bend_allowance_mm`, `flat_pattern_width_mm`, `rollback_token`.

### `add_join`
Adds a `JoinNode` connecting two panels with join type `FLANGE`, `TAB_SLOT`, `RIVET_PATTERN`, or `WELD_PREP`. Dispatches geometry helpers (`addTabSlot`, `chamferEdges`) as available. Returns `rollback_token`.

### `add_cut`
Adds a `CutNode` defining a cut profile (`CIRCLE`, `RECTANGLE`, `POLYGON`, or `FREEFORM`) on a parent panel. Validates profile against panel bounds, polygon validity, and overlap with existing cuts before mutating. Dispatches `createCircleWire`/`createRectWire`/`createPolyWire` + `booleanCut`. Returns `rollback_token`.

### `solve_geometry`
Explicitly triggers a geometry solve pass over all dirty nodes in topological order. Use when batching multiple mutations in a transaction to avoid repeated NAPI calls. Returns `solved_nodes`, `invalidated_body_ids`.

### `check_foldability`
Non-mutating check. Runs the `FoldabilityChecker` on the current graph and returns `PanelAccessibility[]` (`OPEN`, `CONSTRAINED`, or `INACCESSIBLE`) with `locking_bend_ids` for any inaccessible panel.

### `query_graph`
Returns all nodes in Kahn's topological order (or insertion order). Includes `dirty` flag per node, `dirty_node_ids` array, and a `GEOMETRY_STALE` warning when unsolved dirty nodes exist.

### `update_node`
Updates any field(s) on an existing node, including structural panel references and node ID rename. Re-runs acyclicity check after structural changes. Returns `rollback_token`.

### `remove_node`
Removes a node from the graph. Fails with `REMOVE_WOULD_ORPHAN_NODES` if the node is still structurally referenced by other nodes. Marks formerly-downstream nodes dirty.

### `reset_graph`
Clears the entire Manufacturing Graph (all nodes, edges, dirty state). Returns `cleared_node_count` and `cleared_body_count`.