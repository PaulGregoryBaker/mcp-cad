# Semantic CAD MCP Specification

# Part 3 — Interface Boundaries and Canonical Models

> **Scope note.** Interface contracts in this document are the long-term shape. For MVP, only
> the interfaces consumed by tools in [MVP.md §3.1](MVP.md) are implemented. The Inference
> Engine interfaces (§8) are concept-only. The Event Interfaces (§11) are deferred —
> MCP has no native push channel; MVP exposes state via the polled `semantic_lineage` /
> `resolve_geometry` tools described in [MVP.md](MVP.md). Persistence (§12) is realised
> via Dolt — see [Persistence-Dolt.md](Persistence-Dolt.md).

---

# 1. Introduction

This document defines the interface boundaries, canonical data models, and interaction contracts between the core systems of the semantic engineering MCP runtime.

The objective of these interfaces is to:

* preserve stable semantic identity
* isolate geometry implementation details
* support topology evolution
* support incremental semanticization
* enable transactional engineering workflows
* provide explainable engineering reasoning
* maintain implementation simplicity
* minimize coupling between systems

The interfaces defined here establish the canonical runtime contracts for:

* semantic understanding
* geometry realization
* semantic-to-geometry mapping
* semantic inference
* transactional engineering operations

---

# 2. Architectural Interface Model

The runtime is organized around the following primary interfaces.

```text
Semantic Core
        ↕
Semantic Mapping Layer
        ↕
Geometry Core

Inference Engine
        ↕
Semantic Core
        ↕
Transaction & Analysis Engine
```

Each system owns a constrained set of responsibilities and exposes stable interface contracts.

---

# 3. Core Interface Principles

## 3.1 Semantic Identity Is Canonical

All cross-system interactions shall reference:

* semantic identities
* semantic regions
* semantic systems

rather than raw topology references whenever possible.

---

## 3.2 Geometry Is Non-Authoritative

Geometry identifiers are implementation details.

Geometry references:

* may evolve
* may be remapped
* may be regenerated
* are not globally stable

---

## 3.3 Mapping Layer Isolation

The Semantic Mapping Layer isolates:

* semantic meaning
  from:
* topology instability

No external system shall directly depend on persistent topology identifiers.

---

## 3.4 Transactions Are Required

All modifying operations shall execute through transactional interfaces.

Direct destructive mutation is prohibited.

---

# 4. Canonical Identity Model

## 4.1 Identity Categories

The runtime uses the following identity classes.

| Identity Type        | Stability   | Example                       |
| -------------------- | ----------- | ----------------------------- |
| Semantic Identity    | Stable      | semantic://bbq/airflow_system |
| Geometry Identity    | Volatile    | geometry://body/12            |
| Feature Identity     | Semi-stable | feature://vent_pattern/3      |
| Transaction Identity | Stable      | transaction://9912            |
| Analysis Identity    | Stable      | analysis://thermal/42         |

---

## 4.2 Semantic Identity Rules

Semantic identities shall:

* survive topology changes
* survive geometry rebuilds
* survive feature regeneration
* survive backend migration
* remain globally unique
* remain human readable where practical

---

## 4.3 Identity Structure

Canonical semantic identity format:

```text
semantic://<product>/<semantic_entity>
```

Example:

```text
semantic://bbq/airflow_system
semantic://bbq/cooking_chamber
semantic://bbq/thermal_handle_region
```

---

# 5. Semantic Core Interfaces

## 5.1 Responsibility

The Semantic Core exposes interfaces for:

* semantic entity management
* semantic graph traversal
* semantic relationship queries
* constraint access
* intent access
* semantic state management
* semantic lineage access

---

## 5.2 Canonical Semantic Entity

Canonical semantic entity structure:

```json
{
  "id": "semantic://bbq/airflow_system",
  "type": "functional_system",
  "state": "candidate",
  "confidence": 0.84,
  "purpose": [
    "combustion_control",
    "temperature_regulation"
  ],
  "intent": [
    "maximize_airflow_control"
  ],
  "constraints": [
    "constraint://minimum_opening_area"
  ],
  "relationships": [
    {
      "type": "connected_to",
      "target": "semantic://bbq/cooking_chamber"
    }
  ],
  "evidence": [
    "repeating vent geometry",
    "rotating damper surfaces"
  ],
  "created_by": "inference_engine",
  "created_at": "2026-05-21T10:00:00Z"
}
```

---

## 5.3 Semantic Query Interface

Example query contract:

```json
{
  "semantic_id": "semantic://bbq/airflow_system",
  "include_relationships": true,
  "include_constraints": true,
  "include_geometry_bindings": true
}
```

---

## 5.4 Semantic Relationship Model

Canonical relationship structure:

```json
{
  "source": "semantic://bbq/airflow_system",
  "relationship": "influences",
  "target": "semantic://bbq/thermal_distribution",
  "confidence": 0.78
}
```

---

# 6. Geometry Core Interfaces

## 6.1 Responsibility

The Geometry Core exposes:

* geometry queries
* topology queries
* feature operations
* geometric measurements
* spatial evaluation
* geometry mutation operations

---

## 6.2 Canonical Geometry Entity

Canonical geometry structure:

```json
{
  "id": "geometry://body/12",
  "type": "solid_body",
  "topology_revision": 44,
  "kernel": "occ",
  "features": [
    "feature://vent_pattern/3"
  ],
  "bounding_box": {
    "min": [0,0,0],
    "max": [100,50,80]
  }
}
```

---

## 6.3 Geometry Query Interface

Example geometry query:

```json
{
  "geometry_id": "geometry://body/12",
  "include_topology": true,
  "include_features": true
}
```

---

## 6.4 Feature Model

Canonical feature structure:

```json
{
  "id": "feature://vent_pattern/3",
  "type": "pattern",
  "parameters": {
    "count": 12,
    "diameter": 8
  },
  "geometry_targets": [
    "geometry://face/44"
  ]
}
```

---

# 7. Semantic Mapping Layer Interfaces

## 7.1 Responsibility

The Semantic Mapping Layer exposes:

* semantic-to-geometry mappings
* topology remapping
* stable reference resolution
* semantic region tracking
* geometry ownership tracking

---

## 7.2 Canonical Mapping Structure

```json
{
  "semantic_id": "semantic://bbq/airflow_system",
  "geometry_bindings": [
    {
      "type": "body",
      "target": "geometry://body/12",
      "confidence": 0.92
    },
    {
      "type": "face_group",
      "target": [
        "geometry://face/44",
        "geometry://face/45"
      ],
      "confidence": 0.88
    }
  ],
  "topology_revision": 44
}
```

---

## 7.3 Mapping Resolution Interface

Example resolution request:

```json
{
  "semantic_id": "semantic://bbq/airflow_system",
  "requested_binding": "current_geometry"
}
```

---

## 7.4 Topology Remapping Interface

Example remapping contract:

```json
{
  "previous_topology_revision": 44,
  "new_topology_revision": 45,
  "affected_semantic_entities": [
    "semantic://bbq/airflow_system"
  ]
}
```

---

# 8. Inference Engine Interfaces

## 8.1 Responsibility

The Inference Engine exposes:

* feature recognition
* semantic inference
* intent inference
* constraint inference
* confidence scoring
* evidence generation

---

## 8.2 Inference Request Interface

Canonical inference request:

```json
{
  "target_geometry": "geometry://assembly/main",
  "inference_types": [
    "features",
    "functional_systems",
    "constraints",
    "intent"
  ]
}
```

---

## 8.3 Semantic Candidate Structure

```json
{
  "candidate_id": "semantic://bbq/airflow_system",
  "state": "inferred",
  "confidence": 0.82,
  "evidence": [
    "radial vent pattern",
    "air channel adjacency",
    "rotational control geometry"
  ],
  "requires_validation": true
}
```

---

## 8.4 Inference Evidence Structure

```json
{
  "source": "geometry_analysis",
  "observation": "repeating circular vent pattern",
  "weight": 0.74
}
```

---

# 9. Transaction & Analysis Interfaces

## 9.1 Responsibility

The Transaction & Analysis Engine exposes:

* transactional modification
* validation workflows
* rollback
* engineering analysis
* optimization evaluation
* impact analysis

---

## 9.2 Canonical Transaction Structure

```json
{
  "transaction_id": "transaction://9912",
  "state": "staged",
  "requested_change": "increase_airflow",
  "targets": [
    "semantic://bbq/airflow_system"
  ],
  "predicted_effects": [
    "increase vent opening area"
  ],
  "constraint_risks": [],
  "created_at": "2026-05-21T10:00:00Z"
}
```

---

## 9.3 Transaction Lifecycle

Transactions progress through:

```text
Proposed
    ↓
Staged
    ↓
Previewed
    ↓
Validated
    ↓
Committed
```

or:

```text
Rolled Back
```

---

## 9.4 Validation Result Structure

```json
{
  "transaction_id": "transaction://9912",
  "status": "valid",
  "constraint_violations": [],
  "warnings": [
    "increased thermal loss risk"
  ],
  "analysis_results": [
    "analysis://thermal/44"
  ]
}
```

---

## 9.5 Analysis Result Structure

```json
{
  "analysis_id": "analysis://thermal/44",
  "type": "thermal",
  "targets": [
    "semantic://bbq/cooking_chamber"
  ],
  "findings": [
    {
      "severity": "warning",
      "message": "heat leakage detected near vent region"
    }
  ]
}
```

---

# 10. Cross-System Interaction Rules

## 10.1 Semantic-First Interactions

Systems shall communicate primarily through semantic identities.

Geometry references shall remain internal whenever practical.

---

## 10.2 No Direct Topology Ownership Outside Geometry Core

Only the Geometry Core and Mapping Layer may own topology references.

External systems shall not persist topology identifiers.

---

## 10.3 Mapping Layer Isolation

All semantic-to-geometry resolution shall pass through the Mapping Layer.

This prevents topology leakage into semantic systems.

---

## 10.4 Transaction Isolation

All modifications shall execute through transactional interfaces.

Direct geometry mutation is prohibited.

---

# 11. Event Interfaces

## 11.1 Event Principles

Events communicate:

* state changes
* topology evolution
* semantic updates
* transaction outcomes
* analysis completion

Events are informational rather than authoritative.

---

## 11.2 Canonical Event Structure

```json
{
  "event_type": "SemanticEntityValidated",
  "event_id": "event://9912",
  "timestamp": "2026-05-21T10:00:00Z",
  "entity": "semantic://bbq/airflow_system",
  "payload": {}
}
```

---

## 11.3 Example Event Types

| Event                   | Description                   |
| ----------------------- | ----------------------------- |
| GeometryImported        | Geometry added                |
| TopologyMutated         | Topology changed              |
| SemanticEntityInferred  | Semantic candidate created    |
| SemanticEntityValidated | Semantic meaning confirmed    |
| TransactionCommitted    | Modification applied          |
| ConstraintViolated      | Validation failure detected   |
| AnalysisCompleted       | Engineering analysis finished |

---

# 12. Persistence Boundaries

## 12.1 Semantic Persistence

The Semantic Core persists:

* semantic entities
* semantic relationships
* constraints
* intent
* semantic lineage
* validation state

---

## 12.2 Geometry Persistence

The Geometry Core persists:

* topology
* geometry kernels
* feature representations
* geometry revisions
* tessellations

---

## 12.3 Mapping Persistence

The Mapping Layer persists:

* semantic bindings
* topology remapping history
* stable geometry references
* geometry lineage

---

# 13. Versioning Model

## 13.1 Semantic Versioning

Semantic understanding evolves independently from geometry revisions.

Semantic revisions may occur without geometry modification.

---

## 13.2 Geometry Revisioning

Geometry revisions track:

* topology mutations
* feature regeneration
* geometry edits
* backend rebuilds

---

## 13.3 Transactional Revisioning

All committed changes generate:

* semantic revision updates
* geometry revision updates
* mapping revision updates
* transaction history entries

---

# 14. Strategic Outcome

These interfaces establish:

* stable semantic ownership
* isolated geometry implementation
* topology-resilient references
* progressive semantic evolution
* explainable engineering workflows
* transactional engineering modification
* graph-centric engineering reasoning

while maintaining:

* implementation simplicity
* bounded ownership
* extensibility
* backend independence
* AI-native interaction semantics
