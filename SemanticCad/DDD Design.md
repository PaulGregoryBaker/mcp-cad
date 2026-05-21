# Semantic CAD MCP Specification

# Part 2 — Simplified Domain Model and Architectural Responsibilities

---

# 1. Introduction

This document defines the simplified domain architecture for the semantic engineering MCP system.

The architecture is intentionally organized around a small number of authoritative domains.

The objective is to:

* minimize unnecessary orchestration
* avoid domain fragmentation
* reduce synchronization complexity
* preserve semantic clarity
* maintain implementation simplicity
* support graph-centric engineering workflows
* support AI-native engineering reasoning

The system is fundamentally a semantic engineering runtime built around:

* semantic meaning
* geometric realization
* persistent relationships between them

---

# 2. Core Architectural Principle

The architecture is based on the following foundational separation:

```text
Semantic Meaning
        ↕
Semantic ↔ Geometry Mapping
        ↕
Geometry Realization
```

This is the primary architectural boundary.

All other system behaviors are built around this structure.

---

# 3. Architectural Design Goals

The architecture shall:

* preserve stable semantic identity
* support topology evolution
* support semantic inference
* enable explainable engineering reasoning
* support transactional modification
* support progressive semanticization
* maintain implementation simplicity
* support extensible engineering analysis

The architecture shall avoid:

* unnecessary bounded contexts
* duplicated ownership
* excessive domain messaging
* fragmented semantic authority
* unnecessary event complexity

---

# 4. High-Level Domain Structure

The system is organized into five primary architectural systems.

| System                        | Responsibility                               |
| ----------------------------- | -------------------------------------------- |
| Semantic Core                 | Engineering meaning and semantic identity    |
| Geometry Core                 | Geometry and topology realization            |
| Semantic Mapping Layer        | Stable semantic-to-geometry relationships    |
| Inference Engine              | Semantic derivation and semantic evolution   |
| Transaction & Analysis Engine | Safe modification and engineering validation |

This structure intentionally minimizes domain fragmentation.

---

# 5. Semantic Core

## 5.1 Responsibility

The Semantic Core is the authoritative engineering model.

It owns:

* semantic entities
* engineering systems
* engineering intent
* constraints
* semantic relationships
* semantic state
* semantic confidence
* semantic lineage
* stable semantic identity

The Semantic Core represents the persistent engineering understanding of a product.

---

## 5.2 Core Principle

The Semantic Core defines:

## what the product means

rather than:

## how geometry is implemented

---

## 5.3 Semantic Entity

A semantic entity represents a stable engineering concept.

Examples:

* airflow system
* cooking chamber
* structural support system
* thermal isolation region
* mounting interface
* user interaction surface

Semantic entities are independent from topology.

---

## 5.4 Semantic Entity Structure

A semantic entity may contain:

| Property      | Description                  |
| ------------- | ---------------------------- |
| Identity      | Stable semantic identifier   |
| Type          | Engineering classification   |
| Purpose       | Functional meaning           |
| Intent        | Engineering goals            |
| Constraints   | Engineering rules            |
| Relationships | Semantic graph relationships |
| Confidence    | Inference certainty          |
| Evidence      | Supporting reasoning         |
| State         | Validation state             |

---

## 5.5 Semantic States

Semantic entities may exist in the following states.

| State       | Meaning                            |
| ----------- | ---------------------------------- |
| Inferred    | AI-generated hypothesis            |
| Candidate   | Awaiting validation                |
| Confirmed   | Validated semantic meaning         |
| Deprecated  | Invalidated semantic understanding |
| Superseded  | Replaced by newer understanding    |
| Conflicting | Ambiguous semantic interpretation  |

---

## 5.6 Semantic Relationships

Relationships include:

* contains
* connected_to
* depends_on
* influences
* constrained_by
* implemented_by
* conflicts_with
* supports

---

## 5.7 Semantic Core Invariants

The Semantic Core guarantees:

* stable semantic identity
* graph consistency
* semantic lineage preservation
* constraint traceability
* intent traceability
* semantic continuity across geometry evolution

---

# 6. Geometry Core

## 6.1 Responsibility

The Geometry Core owns:

* exact geometry
* topology structures
* geometry kernels
* feature implementation
* spatial queries
* geometry measurements
* geometry serialization
* topology tracking

The Geometry Core is the physical realization layer.

---

## 6.2 Geometry Responsibilities

Responsibilities include:

* B-Rep management
* tessellation
* adjacency queries
* geometric transforms
* feature operations
* boolean operations
* collision geometry
* geometric validation

---

## 6.3 Feature Representation

Engineering features are treated as geometry implementation structures.

Examples:

* holes
* fillets
* chamfers
* ribs
* bends
* pockets
* shells
* lofts

Features are not authoritative semantic entities.

---

## 6.4 Geometry Core Invariants

The Geometry Core guarantees:

* valid topology
* deterministic geometry access
* kernel synchronization
* geometric consistency
* geometry version integrity

---

# 7. Semantic Mapping Layer

## 7.1 Responsibility

The Semantic Mapping Layer maintains relationships between:

* semantic entities
* geometry
* topology
* features
* spatial regions

This layer preserves semantic continuity across geometry evolution.

---

## 7.2 Core Principle

The Semantic Mapping Layer exists because topology is unstable while semantic meaning must remain stable.

---

## 7.3 Mapping Responsibilities

Responsibilities include:

* semantic-to-geometry binding
* topology remapping
* persistent reference tracking
* geometry ownership mapping
* semantic region tracking
* topology lineage tracking

---

## 7.4 Mapping Structure

Mappings may include:

| Mapping Type              | Example              |
| ------------------------- | -------------------- |
| Semantic → Body           | Cooking chamber body |
| Semantic → Face Group     | Air vent surfaces    |
| Semantic → Feature        | Vent pattern feature |
| Semantic → Spatial Region | Heat zone            |

---

## 7.5 Mapping Invariants

The Semantic Mapping Layer guarantees:

* stable semantic continuity
* topology remapping consistency
* persistent reference preservation
* geometry lineage traceability

---

# 8. Inference Engine

## 8.1 Responsibility

The Inference Engine derives semantic understanding from geometry and engineering context.

It owns:

* feature recognition
* semantic inference
* intent inference
* constraint inference
* confidence scoring
* evidence generation
* semantic evolution

---

## 8.2 Core Principle

Imported geometry initially lacks authoritative semantic meaning.

The Inference Engine progressively semanticizes products over time.

---

## 8.3 Inference Pipeline

The inference pipeline includes:

```text
Geometry Analysis
      ↓
Feature Recognition
      ↓
Functional Inference
      ↓
Constraint Inference
      ↓
Intent Inference
      ↓
Semantic Candidate Generation
```

---

## 8.4 Semantic Evolution

Semantic understanding evolves through:

* geometric analysis
* user feedback
* simulation results
* transaction history
* engineering validation
* manufacturing analysis
* workflow interaction

---

## 8.5 Inference Invariants

The Inference Engine guarantees:

* evidence traceability
* confidence attribution
* inference reproducibility
* semantic lineage preservation

---

# 9. Transaction & Analysis Engine

## 9.1 Responsibility

The Transaction & Analysis Engine owns:

* transactional modification
* validation workflows
* rollback
* engineering analysis
* optimization
* manufacturability evaluation
* simulation orchestration
* impact analysis

---

## 9.2 Core Principle

All engineering modifications are transactional.

No destructive modification occurs directly.

---

## 9.3 Transaction Lifecycle

All modifications follow:

```text
Propose
    ↓
Stage
    ↓
Preview
    ↓
Analyze
    ↓
Validate
    ↓
Explain
    ↓
Commit
```

---

## 9.4 Analysis Responsibilities

Analysis responsibilities include:

* thermal analysis
* structural analysis
* manufacturability analysis
* collision analysis
* optimization evaluation
* constraint validation
* semantic impact analysis

---

## 9.5 Transaction Invariants

The Transaction & Analysis Engine guarantees:

* atomic modifications
* rollback consistency
* validation completeness
* dependency integrity
* explainable changes

---

# 10. System Relationships

## 10.1 Primary Runtime Structure

The runtime operates as follows:

```text
Semantic Core
        ↓
Semantic Mapping Layer
        ↓
Geometry Core
```

Supporting systems continuously interact with this structure.

---

## 10.2 Inference Flow

```text
Geometry Core
        ↓
Inference Engine
        ↓
Semantic Core
```

---

## 10.3 Transaction Flow

```text
User / AI Intent
        ↓
Transaction Engine
        ↓
Semantic Core
        ↓
Semantic Mapping Layer
        ↓
Geometry Core
        ↓
Analysis & Validation
```

---

# 11. Product Semanticization Lifecycle

## 11.1 Initial Import

Immediately after import, the system may only possess:

* geometry
* topology
* assembly hierarchy
* spatial relationships

No authoritative semantic understanding exists.

---

## 11.2 Progressive Semanticization

The product evolves through:

```text
Geometry Import
      ↓
Topology Extraction
      ↓
Feature Recognition
      ↓
Functional Inference
      ↓
Constraint Inference
      ↓
Intent Inference
      ↓
Semantic Candidate Creation
      ↓
Human Validation
      ↓
Persistent Semantic Twin
```

---

# 12. Domain Ownership Summary

| System                        | Owns Authoritative State          |
| ----------------------------- | --------------------------------- |
| Semantic Core                 | Yes                               |
| Geometry Core                 | Yes                               |
| Semantic Mapping Layer        | Yes                               |
| Inference Engine              | No — derived understanding        |
| Transaction & Analysis Engine | No — orchestration and validation |

This separation intentionally minimizes duplicated ownership.

---

# 13. Architectural Simplifications

The following concerns are intentionally treated as internal modules or capabilities rather than independent domains.

| Concern           | Treated As               |
| ----------------- | ------------------------ |
| Intent            | Semantic Core component  |
| Constraints       | Semantic Core component  |
| Features          | Geometry Core component  |
| Topology Resolver | Mapping Layer capability |
| Visualization     | Application/UI concern   |
| Explainability    | Cross-cutting capability |

This reduces orchestration complexity and preserves coherent ownership boundaries.

---

# 14. Strategic Design Decisions

## 14.1 Semantic Meaning Is Authoritative

Engineering meaning is authoritative.

Geometry is a realization.

---

## 14.2 Stable Semantic Identity Is Mandatory

AI reasoning depends on stable semantic references.

Topology alone is insufficient.

---

## 14.3 Semantics Are Probabilistic

Semantic understanding evolves continuously.

Inference is never assumed perfect.

---

## 14.4 Transactions Are Mandatory

All engineering modification is transactional.

---

## 14.5 The Architecture Is Graph-Centric

The system is fundamentally a semantic graph runtime.

It is not a collection of isolated CRUD services.

---

# 15. Strategic Outcome

The resulting architecture establishes:

* a buildable semantic engineering runtime
* a persistent semantic twin
* topology-resilient engineering reasoning
* explainable AI-driven modification
* progressive semantic understanding
* stable engineering identity
* transactional engineering workflows

while avoiding:

* excessive domain fragmentation
* duplicated ownership
* orchestration sprawl
* unnecessary complexity
* over-engineered service boundaries

The architecture is intentionally optimized for semantic coherence, implementation simplicity, and long-term extensibility.
