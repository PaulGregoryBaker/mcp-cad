# MCP Architecture: AI-Driven Sheet Metal Orchestrator

**Version:** 3.0

**Domain:** CAD/CAM Manufacturing Automation

**Deployment:** Docker (Local/Edge) & Kubernetes (Cloud)

---

## 1. Executive Summary

This MCP (Model Context Protocol) server acts as a **Deterministic Geometry Intelligence Layer**. It translates raw 3D CAD data into structured manufacturing state for AI Agents. The core philosophy is to keep the AI in the "reasoning and orchestration" layer while the MCP handles the heavy-duty geometric math and manufacturing rule validation.

---

## 2. System Architecture

The system is built on a tripartite model:

1. **AI Harness:** Manages user dialogue, high-level intent, and strategic decision-making.
2. **MCP Server:** Exposes structured resources and tools.
3. **Geometry Service:** A containerized backend (OpenCASCADE/CadQuery) or Cloud API (Onshape/Fusion) for B-Rep manipulation.

---

## 3. Structured Resources (The State)

Resources provide the AI Agent with a real-time "map" of the engineering environment.

### A. `context://` (Project Intent)

* `context://intent/environmental`: Stores functional constraints (e.g., Fire-rated, Marine-grade, High-vibration).
* `context://intent/assembly`: Preferred assembly method (e.g., Factory-welded vs. Field-riveted).

### B. `logistics://` (Physical Limits)

* `logistics://envelope/shipping`: Max $L \times W \times H$ for crating.
* `logistics://handling/max_weight`: Max weight (e.g., **23kg**) for ergonomic safety.
* `logistics://envelope/coating`: Physical limits of the powder-coating/plating line.

### C. `manufacturing://` (Shop Capability)

* `manufacturing://tooling/press_brake`: V-die widths, punch radii, and max tonnage.
* `manufacturing://material/inventory`: Gauge thickness, K-factors, and grain directions.
* `manufacturing://rules`: Minimum hole diameters ($d \geq t$) and minimum flange widths.

### D. `geometry://` (The Part State)

* `geometry://part/{id}/topology`: Face/Edge adjacency graph and B-Rep data.
* `geometry://part/{id}/features`: Semantic list of bends, holes, louvers, and flanges.
* `geometry://part/{id}/nest`: Material utilization and nesting efficiency metrics.

---

## 4. MCP Tools (The Actions)

Tools are the deterministic "verbs" the AI Agent uses to manipulate the CAD model.

| Category | Tool Name | Parameters | Description |
| --- | --- | --- | --- |
| **Analysis** | `clean_geometry` | `file_path` | Heals non-manifold edges and sliver faces. |
| **Decomposition** | `decompose_volume` | `strategy` [Integrity, Simplicity, Logistics] | Splits a solid volume into manufacturable panels based on a priority flag. |
| **Joining** | `synthesize_joints` | `joint_type`, `clearance` | Adds Tab-and-Slot, Rivet holes, or Weld preps between adjacent parts. |
| **Sheet Metal** | `generate_reliefs` | `relief_type` | Adds "dog-bone" or circular reliefs at bend intersections to prevent tearing. |
| **Flattening** | `apply_unfold` | `material_id`, `k_factor` | Generates 2D flat patterns with precise bend compensation. |
| **Optimization** | `simulate_nesting` | `sheet_size`, `parts_list` | Performs 2D packing to minimize material waste before final export. |

---

## 5. Orchestration Workflow

The AI Harness orchestrates the design process through the following loop:

1. **Ingestion:** MCP `clean_geometry` validates the master volume.
2. **Constraint Query:** AI Harness checks `logistics://` and `context://` to set project boundaries.
3. **Strategy Selection:** User chooses **Logistics**. AI Harness instructs MCP `decompose_volume(strategy="logistics")`.
4. **Detailing:** AI iterates through parts to add flanges and `synthesize_joints` (e.g., Rivets for fire-rated onsite assembly).
5. **Validation:** AI calls `evaluate_manufacturability` and `validate_bend_sequence`.
6. **Production:** MCP `simulate_nesting` generates a high-efficiency layout on raw sheet stock.
7. **Export:** MCP `export_production_pack` outputs DXFs, BOMs, and Assembly instructions.

---

## 6. Implementation Notes

### Dual-Track Deployment

* **Local (Docker):** Standard `python:3.11-slim` image containing `OCP` (OpenCASCADE) and the MCP FastAPI wrapper.
* **Cloud (Kubernetes):** MCP Server pods act as gateways; heavy geometry tasks are offloaded to a horizontal `geometry-worker` cluster.

### Key Logic Enforcements

* **Kerf Compensation:** All slot tools must include a $0.1\text{mm} - 0.2\text{mm}$ offset to account for laser/waterjet material removal.
* **Version Control:** The MCP must maintain a "Geometry State History" to allow the AI Harness to roll back a failed decomposition strategy.
* **Safety Filter:** If `context://intent` is "Fire-Rated," the MCP will block `synthesize_joints` from using adhesives or plastic fasteners.

---

## 7. Recommended MVP Scope

* **Input:** 3D STEP volume.
* **Capabilities:** Volume decomposition (2-5 parts), Tab-and-Slot joinery, and Nested DXF export.
* **Success Metric:** A part designed in 1 minute that would take a human engineer 1 hour.

---