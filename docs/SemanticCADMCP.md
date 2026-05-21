# Semantic CAD MCP Architecture

## Overview

This document describes a proposed architecture for an AI-native CAD MCP (Model Context Protocol) system.

The central idea is:

> AI should not manipulate geometry directly.
>
> AI should manipulate semantic engineering intent, constraints, functional systems, and relationships.

The geometry becomes a compiled representation of the semantic system.

---

# The Core Problem

Traditional CAD systems are primarily:

* Geometry-centric
* Feature-history-centric
* Topology-centric

This creates several major limitations for AI:

| Problem                      | Result                       |
| ---------------------------- | ---------------------------- |
| Unstable topology references | AI loses context after edits |
| Geometry-only reasoning      | No engineering understanding |
| Feature history ≠ intent     | AI cannot infer purpose      |
| CAD APIs are low-level       | AI becomes command-driven    |
| No semantic continuity       | Edits become fragile         |

A true AI-native CAD system requires:

* Stable semantic references
* Functional understanding
* Intent preservation
* Constraint reasoning
* Explainable editing
* Semantic selection
* Persistent identity systems

---

# Core Architectural Principle

The MCP should own:

* Semantic meaning
* Functional understanding
* Stable references
* Constraint systems
* Intent graphs
* Transactional editing

The CAD backend should own:

* Exact geometry mathematics
* B-Rep operations
* Tessellation
* Surface evaluation
* Boolean operations
* Kernel-level geometry generation

This creates a clean separation:

| Layer      | Responsibility            |
| ---------- | ------------------------- |
| MCP        | Engineering reasoning     |
| CAD Kernel | Exact geometry generation |

---

# Recommended System Architecture

```text
LLM / Agent Layer
        ↓
Intent Interpreter
        ↓
Semantic CAD Engine (MCP)
    ├── Semantic Graph
    ├── Intent Graph
    ├── Constraint Graph
    ├── Stable Identity System
    ├── Transaction Engine
    ├── Feature Recognition
    ├── Topology Resolver
    └── Analysis Systems
        ↓
CAD Backend Adapter(s)
        ↓
Geometry Kernel
```

---

# The Five Core Representation Layers

A successful AI CAD system requires multiple synchronized representations.

| Layer          | Purpose                              |
| -------------- | ------------------------------------ |
| Geometry Layer | Exact surfaces and solids            |
| Topology Layer | Faces, edges, vertices, adjacency    |
| Feature Layer  | Parametric features and operations   |
| Semantic Layer | Functional engineering meaning       |
| Intent Layer   | Goals, constraints, design rationale |

Most existing CAD systems only properly expose the first two or three layers.

The MCP must own all five.

---

# Why Metadata Is Not Enough

A naive metadata system fails because topology changes.

Example:

```json
{
  "face_123": {
    "type": "mounting_face"
  }
}
```

This breaks when:

* faces split
* topology regenerates
* fillets reorder
* booleans modify geometry
* imported models are repaired

This is the classic topological naming problem.

Instead:

## Semantics must exist independently from topology.

---

# Semantic Entity Model

The MCP should create semantic entities above geometry.

Example:

```text
Semantic Entity:
    left_mounting_interface

Owns:
    feature:housing_pad
    hole_pattern:m4_mount
    datum_plane:A

Currently Resolves To:
    faces[12,19,22]
    edges[91,92]
```

This enables:

* Stable references
* Persistent meaning
* Intent-aware editing
* Regeneration resilience

---

# The Topology Resolver

The topology resolver is one of the most important subsystems.

Its job is to maintain mappings between:

```text
Semantic Entity
    ↓
Feature Ownership
    ↓
Topology Pattern
    ↓
Current Geometry
```

When geometry changes:

* faces may split
* edges may merge
* topology IDs may disappear

But semantic entities survive.

This is essential.

---

# Semantic Selection

Traditional CAD selection is topology-based.

AI-native selection should be semantic.

Instead of:

* face 51
* edge 12

The AI should operate on:

* sealing surface
* airflow vent system
* mounting interface
* structural rib network
* wheel assembly

---

# Multi-Level Selection Model

The MCP should support selection at multiple semantic levels.

| Selection Level | Example             |
| --------------- | ------------------- |
| Topological     | Face, edge, vertex  |
| Feature         | Hole, rib, chamfer  |
| Functional      | Airflow system      |
| Mechanical      | Bearing interface   |
| Manufacturing   | Sheet metal bend    |
| Structural      | Load-bearing member |
| Simulation      | Thermal surface     |

---

# Intent-Aware Editing

The AI should edit intent, not geometry.

Example request:

> Improve heat retention.

The AI reasons through the semantic graph:

```text
Heat Retention Depends On:
- lid sealing
- vent leakage
- wall thickness
- chamber geometry
```

Then proposes geometry modifications.

This is fundamentally different from:

> Offset face by 3 mm.

---

# Transactional Editing Model

AI should never mutate geometry directly.

All edits should flow through a transactional pipeline.

```text
Plan
→ Preview
→ Simulate
→ Validate
→ Explain
→ Commit
```

This is critical for:

* safety
* trust
* explainability
* rollback
* collaborative editing

---

# Imported CAD Problem

## Example Scenario

User uploads:

```text
bbq.step
```

Initially the system only has:

| Available             | Missing                |
| --------------------- | ---------------------- |
| Geometry              | Functional meaning     |
| Topology              | Design intent          |
| Surface continuity    | Constraints            |
| Assembly structure    | Engineering goals      |
| Spatial relationships | Semantic understanding |

The system must bootstrap semantic understanding from geometry.

---

# Semanticization Pipeline

The semanticization pipeline converts geometry into engineering meaning.

```text
Geometry Import
      ↓
Topology Extraction
      ↓
Feature Recognition
      ↓
Functional Region Detection
      ↓
Mechanical Relationship Inference
      ↓
Constraint Inference
      ↓
Intent Hypothesis Generation
      ↓
Semantic Graph Construction
      ↓
Human Validation Loop
      ↓
Persistent Semantic Twin
```

---

# Step 1 — Geometry & Topology Extraction

The system extracts:

| Artifact                |
| ----------------------- |
| Bodies                  |
| Faces                   |
| Edges                   |
| Vertices                |
| Adjacency graphs        |
| Surface classifications |
| Symmetry                |
| Repeated structures     |
| Assembly hierarchy      |

This becomes the raw topology graph.

---

# Step 2 — Feature Recognition

The system infers engineering features.

Examples:

| Feature Type |
| ------------ |
| Hole         |
| Pocket       |
| Rib          |
| Boss         |
| Fillet chain |
| Shell        |
| Pattern      |
| Bend         |
| Shaft        |
| Slot         |

This creates the first semantic layer.

---

# Step 3 — Functional Region Detection

The AI groups geometry into functional systems.

## Example: BBQ Appliance

| Functional System       | Example                     |
| ----------------------- | --------------------------- |
| Cooking System          | Grill surface, heat chamber |
| Airflow System          | Vents and dampers           |
| Structural System       | Frame and supports          |
| Fuel System             | Charcoal tray               |
| User Interaction System | Handles and wheels          |

This is where geometry becomes engineering meaning.

---

# Example Semantic Graph

```text
BBQ Appliance
├── Cooking System
│   ├── Grill Surface
│   ├── Heat Chamber
│   ├── Lid Assembly
│   └── Airflow Regulation
│
├── Structural System
│   ├── Main Frame
│   ├── Leg Assembly
│   └── Wheel Supports
│
├── Fuel System
│   ├── Charcoal Tray
│   └── Ash Collection
│
└── User Interaction System
    ├── Lid Handle
    ├── Vent Controls
    └── Wheels
```

---

# Step 4 — Intent Inference

The system infers engineering goals.

| Goal Type     | Example                 |
| ------------- | ----------------------- |
| Thermal       | Heat retention          |
| Structural    | Load support            |
| Safety        | Heat shielding          |
| Airflow       | Combustion control      |
| Ergonomic     | Handle accessibility    |
| Manufacturing | Sheet metal fabrication |
| Assembly      | Fastener accessibility  |

These become intent nodes.

---

# Example Intent Graph

```text
Goal:
    maintain_even_heat_distribution

Depends On:
    vent placement
    chamber geometry
    lid sealing

Conflicts With:
    low manufacturing cost
```

This enables engineering reasoning.

---

# Step 5 — Constraint Inference

The system infers constraints.

## Geometric Constraints

| Constraint |
| ---------- |
| Concentric |
| Parallel   |
| Symmetry   |
| Coplanar   |
| Tangent    |

## Functional Constraints

| Constraint        |
| ----------------- |
| Lid rotation      |
| Tray clearance    |
| Thermal isolation |
| Vent range        |

## Manufacturing Constraints

| Constraint         |
| ------------------ |
| Bend radius        |
| Tool accessibility |
| Weld access        |
| Draft angle        |

## Safety Constraints

| Constraint      |
| --------------- |
| Stability       |
| Heat shielding  |
| Pinch avoidance |

---

# Step 6 — Geometry-to-Semantic Linking

Bidirectional mappings are created.

Example:

```text
Semantic Entity:
    airflow_control_system

Maps To:
    vent_faces[12-24]
    rotating_disc[2]
    vent_handle[3]

Constraints:
    rotational_clearance
    airflow_area_range

Goals:
    combustion_control
```

---

# Persistent Identity System

The MCP should own stable references.

Example:

```text
semantic://bbq/lid/handle
semantic://bbq/cooking_system/grill_surface
semantic://bbq/airflow/vent_left
```

These references survive topology mutations.

---

# Confidence & Probabilistic Semantics

Semantic inference is probabilistic.

The system should store confidence levels.

Example:

```json
{
  "entity": "airflow_control_system",
  "confidence": 0.82
}
```

This is essential for:

* explainability
* validation
* human review
* iterative refinement

---

# Human Validation Loop

The AI should continuously refine semantics with user feedback.

Example:

```text
Detected Functional Systems:
- airflow system
- cooking chamber
- ash collection tray

Please confirm.
```

This dramatically improves long-term semantic quality.

---

# The Semantic Twin

The final output is not merely a CAD file.

It is:

## A persistent semantic twin of the product.

This semantic twin contains:

| Artifact         |
| ---------------- |
| Geometry graph   |
| Feature graph    |
| Semantic graph   |
| Intent graph     |
| Constraint graph |
| Dependency graph |
| Identity graph   |
| Validation state |
| Confidence state |

The CAD geometry becomes one representation of this higher-order engineering model.

---

# The Compiler Analogy

The architecture resembles a software compiler.

| Software System | Semantic CAD System        |
| --------------- | -------------------------- |
| Source code     | Semantic graph             |
| Compiler        | Constraint/geometry engine |
| Binary          | CAD geometry               |

The semantic graph is the true editable representation.

The geometry is a compiled artifact.

---

# Long-Term Capability

With semantic understanding, the system can support high-level engineering requests.

Example:

> Convert this charcoal BBQ into a gas grill while preserving:
>
> * cooking capacity
> * wheelbase
> * manufacturing cost
> * heat distribution

This is impossible with geometry-only systems.

It becomes achievable with:

* semantic graphs
* intent systems
* constraints
* topology resolution
* engineering reasoning
* transactional editing

---

# MCP Tooling Model

The MCP should expose tools at the semantic engineering level rather than at the raw geometry level.

The AI should rarely operate directly on:

* vertices
* edges
* raw B-Rep entities
* kernel commands

Instead, the MCP should expose:

* semantic selection
* engineering reasoning
* topology-safe editing
* intent-aware modification
* explainable analysis

---

# Core Design Principle

Every MCP tool should:

| Requirement               | Purpose                             |
| ------------------------- | ----------------------------------- |
| Be semantic-first         | Avoid geometry-only interactions    |
| Support stable references | Survive topology changes            |
| Be transactional          | Preview before commit               |
| Be explainable            | AI can justify actions              |
| Be queryable              | AI can inspect reasoning            |
| Support confidence        | Semantic inference is probabilistic |
| Preserve intent           | Constraints survive edits           |

---

# Proposed MCP Tool Categories

| Category               | Purpose                        |
| ---------------------- | ------------------------------ |
| Model Management       | Import/export/versioning       |
| Geometry Query         | Read topology and geometry     |
| Semantic Query         | Read engineering meaning       |
| Selection              | Stable semantic selection      |
| Analysis               | Inspection and validation      |
| Constraint Management  | Read/write constraints         |
| Intent Management      | Read/write engineering goals   |
| Feature Operations     | Parametric modeling            |
| Direct Editing         | Geometry manipulation          |
| Semantic Editing       | Functional modifications       |
| Transaction Management | Preview/commit/rollback        |
| Visualization          | Camera/highlighting/inspection |
| Learning & Inference   | Semantic inference pipeline    |
| Explanation            | Explain reasoning and failures |

---

# 1. Model Management Tools

These manage the lifecycle of CAD models and semantic twins.

## Import Model

```json
{
  "tool": "model.import",
  "file": "bbq.step"
}
```

Outputs:

* topology graph
* assembly graph
* geometry identifiers
* semantic twin ID

---

## Export Model

```json
{
  "tool": "model.export",
  "format": "step",
  "semantic_twin": true
}
```

---

## Version Snapshot

```json
{
  "tool": "model.snapshot.create",
  "label": "pre-airflow-optimization"
}
```

---

# 2. Geometry Query Tools

These expose exact geometry and topology.

## Query Topology

```json
{
  "tool": "geometry.query.topology",
  "target": "body:12"
}
```

Returns:

* faces
* edges
* adjacency
* surface types
* continuity

---

## Measure Geometry

```json
{
  "tool": "geometry.measure",
  "targets": [
    "semantic://bbq/grill_surface"
  ],
  "measurement": "area"
}
```

---

## Query Physical Properties

```json
{
  "tool": "geometry.properties",
  "target": "body:lid"
}
```

Returns:

* mass
* center of gravity
* inertia
* volume
* surface area

---

# 3. Semantic Query Tools

These are among the most important MCP tools.

## Query Semantic Entity

```json
{
  "tool": "semantic.query",
  "entity": "semantic://bbq/airflow_system"
}
```

Returns:

* mapped geometry
* functional role
* dependencies
* goals
* constraints
* confidence

---

## Find Semantic Entities

```json
{
  "tool": "semantic.search",
  "query": {
    "type": "thermal_system"
  }
}
```

---

## Query Functional Relationships

```json
{
  "tool": "semantic.relationships",
  "entity": "semantic://bbq/lid"
}
```

Returns:

* depends_on
* connected_to
* influences
* constrained_by

---

# 4. Semantic Selection Tools

Selection is foundational.

## Select by Semantic Meaning

```json
{
  "tool": "selection.semantic",
  "query": {
    "function": "airflow_control"
  }
}
```

---

## Select Similar Features

```json
{
  "tool": "selection.similar",
  "target": "hole:12"
}
```

---

## Select by Spatial Rule

```json
{
  "tool": "selection.spatial",
  "query": {
    "inside": "heat_chamber",
    "type": "vent"
  }
}
```

---

# 5. Constraint Tools

Constraints are central to engineering reasoning.

## Query Constraints

```json
{
  "tool": "constraint.query",
  "entity": "semantic://bbq/lid"
}
```

---

## Create Constraint

```json
{
  "tool": "constraint.create",
  "constraint": {
    "type": "thermal_isolation",
    "target": "handle",
    "max_temperature": 45
  }
}
```

---

## Constraint Importance

```json
{
  "tool": "constraint.priority.set",
  "constraint": "shaft_alignment",
  "priority": "critical"
}
```

---

# 6. Intent Management Tools

Intent tools define WHY the design exists.

## Query Intent

```json
{
  "tool": "intent.query",
  "entity": "semantic://bbq/cooking_system"
}
```

---

## Create Goal

```json
{
  "tool": "intent.create",
  "goal": {
    "name": "maximize_heat_retention",
    "priority": "high"
  }
}
```

---

## Link Intent to Geometry

```json
{
  "tool": "intent.attach",
  "goal": "maximize_heat_retention",
  "targets": [
    "semantic://bbq/lid",
    "semantic://bbq/chamber"
  ]
}
```

---

# 7. Feature Operation Tools

These expose parametric CAD operations.

## Create Extrude

```json
{
  "tool": "feature.create.extrude",
  "profile": "sketch:12/profile:1",
  "distance": 25
}
```

---

## Create Fillet

```json
{
  "tool": "feature.create.fillet",
  "targets": ["edge:12"],
  "radius": 3
}
```

---

## Edit Feature

```json
{
  "tool": "feature.edit",
  "feature": "fillet:12",
  "parameters": {
    "radius": 5
  }
}
```

---

# 8. Direct Editing Tools

These support imported geometry workflows.

## Move Face

```json
{
  "tool": "direct.move_face",
  "target": "face:12",
  "offset": 5
}
```

---

## Delete & Heal

```json
{
  "tool": "direct.delete_heal",
  "targets": ["hole:4"]
}
```

---

# 9. Semantic Editing Tools

These are the most important AI-native tools.

## Modify Functional System

```json
{
  "tool": "semantic.modify",
  "target": "semantic://bbq/airflow_system",
  "goal": "increase_airflow"
}
```

The MCP determines:

* affected geometry
* required constraints
* feature updates
* validation impacts

---

## Optimize Semantic Goal

```json
{
  "tool": "semantic.optimize",
  "goal": "maximize_heat_retention",
  "constraints": [
    "maintain_weight",
    "preserve_cost"
  ]
}
```

---

# 10. Analysis Tools

These provide engineering inspection.

## Interference Analysis

```json
{
  "tool": "analysis.interference",
  "targets": [
    "assembly:main"
  ]
}
```

---

## Thermal Analysis

```json
{
  "tool": "analysis.thermal",
  "target": "semantic://bbq/cooking_system"
}
```

---

## Manufacturability Analysis

```json
{
  "tool": "analysis.manufacturing",
  "target": "body:12"
}
```

Checks:

* tool access
* wall thickness
* bend radius
* draft angles
* weld access

---

# 11. Visualization Tools

AI needs visual communication tools.

## Highlight Semantic Region

```json
{
  "tool": "view.highlight",
  "target": "semantic://bbq/airflow_system"
}
```

---

## Create Section View

```json
{
  "tool": "view.section",
  "plane": "datum:A"
}
```

---

## Compare Revisions

```json
{
  "tool": "view.compare",
  "before": "snapshot:12",
  "after": "snapshot:13"
}
```

---

# 12. Transaction Tools

These make AI editing safe.

## Start Transaction

```json
{
  "tool": "transaction.begin"
}
```

---

## Preview Changes

```json
{
  "tool": "transaction.preview"
}
```

---

## Validate Changes

```json
{
  "tool": "transaction.validate"
}
```

Checks:

* constraint violations
* manufacturability
* topology failures
* assembly collisions

---

## Commit Transaction

```json
{
  "tool": "transaction.commit"
}
```

---

## Rollback Transaction

```json
{
  "tool": "transaction.rollback"
}
```

---

# 13. Explanation Tools

These are critical for trust.

## Explain Modification

```json
{
  "tool": "explain.change",
  "transaction": "txn:14"
}
```

Returns:

* changed geometry
* affected semantics
* preserved constraints
* risks
* tradeoffs

---

## Explain Failure

```json
{
  "tool": "explain.failure",
  "feature": "shell:12"
}
```

Returns:

* root cause
* dependency chain
* possible fixes

---

# 14. Learning & Inference Tools

These bootstrap semantic understanding.

## Detect Features

```json
{
  "tool": "infer.features",
  "target": "assembly:bbq"
}
```

---

## Infer Functional Systems

```json
{
  "tool": "infer.semantic_systems",
  "target": "assembly:bbq"
}
```

---

## Infer Constraints

```json
{
  "tool": "infer.constraints",
  "target": "assembly:bbq"
}
```

---

## Infer Design Intent

```json
{
  "tool": "infer.intent",
  "target": "assembly:bbq"
}
```

---

# Most Important Insight

The highest-value MCP tools are not geometry operations.

They are:

* semantic queries
* intent manipulation
* topology-safe editing
* constraint reasoning
* engineering analysis
* explainability

These are the tools that allow AI to behave like an engineering collaborator rather than a CAD macro system.

---

# Strategic Conclusion

n

The MCP is not merely an API adapter.

It is:

## A semantic operating system for engineering reasoning.

The systems that will feel revolutionary are the ones where AI can maintain:

* semantic continuity
* engineering understanding
* stable references
* intent preservation
* explainable reasoning

across:

* many edits
* topology mutations
* imported CAD
* multiple CAD backends
* collaborative workflows

That requires the MCP to own the semantic layer.
