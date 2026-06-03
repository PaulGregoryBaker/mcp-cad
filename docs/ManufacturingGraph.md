
# Functional Specification: Dual-Graph Sheet Metal Manufacturing Workflow

## 1. System Overview

The system must define and process sheet metal manufacturing through a strict dual-graph workflow. This approach mathematically decouples the human/automated manufacturing intent from the resulting 3D topological boundaries, ensuring that complex geometric modifications do not corrupt the chronological sequence of fabrication steps.

---

## 2. Core Data Structures

### 2.1 The Manufacturing Graph (Source of Truth)

A Directed Acyclic Graph (DAG) that acts as the absolute source of truth. It represents pure manufacturing intent and logic, entirely detached from spatial 3D coordinates.

* **Node Types:**
* `PanelNode`: Represents a flat piece of material. Parameters must include material type and thickness.
* `BendNode`: Represents a joining or folding operation. Parameters must include inner radius, bend angle, and material K-Factor.
* `CutNode`: Represents material removal. Parameters must include 2D profile coordinates defined relative to the local coordinate system of a specific `PanelNode`.


* **Edges:** Represent chronological and logical dependencies (e.g., `Panel A` -> `Bend 1` -> `Panel B`).

### 2.2 The Geometric Graph (Derivative State)

The physical Boundary Representation (B-Rep) topology that represents the calculated physical reality of the sheet metal.

* **Entities:** Solid bodies, planar faces, boundary edges, and closed topological wires.
* **Topological Mapping:** The system must maintain a mapping mechanism where every generated topological face and edge is persistently tagged with the unique identifier of the Manufacturing Graph node that initiated its creation. This ensures bidirectional traceability when topology is regenerated.

---

## 3. Functional Workflows

### 3.1 Feature Recognition (Bootstrap Phase)

*Trigger: A raw, "unintelligent" 3D CAD model is ingested into the system.*

1. **Topological Analysis:** The system must traverse the ingested 3D topology to identify parallel planar faces (representing physical panels) separated by cylindrical faces (representing existing bends).
2. **Intent Extraction:** Based on the identified topology, the system must extract the implicit manufacturing parameters (thickness, bend radii, angles).
3. **Graph Initialization:** The system must automatically construct a new Manufacturing Graph, creating disconnected `PanelNode` entities for each flat section found.
4. **Geometric Separation:** The underlying 3D model must be split into separate, distinct topological bodies corresponding to the initialized nodes.

### 3.2 The Unidirectional Operation Loop

*Trigger: A command is issued to add or modify a manufacturing step (e.g., merging two panels via a bend).*

1. **Intent Appended:** A new node (e.g., a `BendNode`) is appended to the Manufacturing Graph, establishing a logical link between the target `PanelNodes`.
2. **State Validation:** The new state of the DAG is validated against established manufacturing rules.
3. **Geometry Regeneration:** The system reads the updated parameters from the graph and executes the necessary boolean operations or spatial transformations to update the Geometric Graph.
4. **Physical Update:** New topological faces (e.g., a cylindrical bend) are generated to seamlessly connect the previously distinct topological panels.

### 3.3 Flat Pattern & DXF Generation

*Trigger: A 2D cutting profile is requested for nesting or fabrication.*

1. **Traversal:** The system traverses the intent-based Manufacturing Graph, starting from a designated base panel.
2. **Unfolding Calculation:** When traversing across a `BendNode`, the system must calculate the exact stretched flat length using standard bend allowance formulas:

$$BA = \frac{\pi}{180} \cdot A \cdot (R + K \cdot T)$$


3. **Topology Flattening:** The 3D topological boundaries of the panels must be mathematically projected into a single 2D plane, separated by the calculated bend deduction values.
4. **Profile Export:** The resulting closed topological wires are translated into a standard 2D vector format. The system must insert specific annotations (e.g., dashed lines) to represent the neutral axis of the bend zones.

---

## 4. Automated Validation (Shift-Left Quality)

The system must support real-time manufacturability validation decoupled from 3D rendering.

* **Design Rule Checks (DRC):** Logic validation (e.g., verifying if a requested bend radius is physically possible for a given material thickness) must occur immediately upon node creation in the Manufacturing Graph, before any heavy geometric computation is triggered.
* **Extensibility:** The state of the Manufacturing Graph must be structured in a way that allows external rule engines or agents to traverse the DAG and flag tooling or fabrication conflicts during the initial design phase.