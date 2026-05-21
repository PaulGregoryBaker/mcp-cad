# Semantic CAD MCP Specification

# Part 4 — MCP Definition

---

# 1. Introduction

This document defines the MCP (Model Context Protocol) structure for the semantic engineering runtime.

The MCP layer provides the operational interface between:

* AI systems
* semantic engineering runtime services
* geometry execution systems
* analysis systems
* engineering workflows

The MCP is designed around semantic-first engineering principles.

The MCP therefore exposes:

* semantic entities
* engineering intent
* constraints
* transactional operations
* explainable reasoning
* topology-resilient references

rather than low-level geometry primitives alone.

---

# 2. MCP Design Principles

## 2.1 Semantic-First Interaction

The MCP shall expose semantic engineering concepts as first-class objects.

AI systems should interact with:

* airflow systems
* mounting interfaces
* thermal regions
* structural supports
* user interaction surfaces

rather than:

* face IDs
* edge IDs
* raw topology handles

whenever practical.

---

## 2.2 Stable References

All MCP interactions shall use stable semantic references.

Topology references are considered volatile implementation details.

---

## 2.3 Transactional Modification

All modifications shall occur through staged transactional workflows.

Direct destructive mutation is prohibited.

---

## 2.4 Explainable Operations

All engineering operations shall produce explainable outputs.

The MCP shall expose:

* reasoning
* assumptions
* affected systems
* violated constraints
* inferred tradeoffs

for all significant operations.

---

## 2.5 Progressive Semanticization

The MCP shall support products with incomplete semantic understanding.

Imported geometry may initially contain:

* unknown semantics
* partial semantic inference
* uncertain mappings
* incomplete constraints
* unresolved intent

The MCP must support progressive refinement over time.

---

# 3. MCP Runtime Structure

The MCP exposes three primary categories:

| Category  | Purpose                        |
| --------- | ------------------------------ |
| Resources | Persistent engineering state   |
| Tools     | Engineering operations         |
| Prompts   | Structured reasoning workflows |

---

# 4. MCP Resources

## 4.1 Resource Principles

Resources expose persistent engineering understanding.

Resources are:

* queryable
* referenceable
* inspectable
* explainable
* stable across sessions

Resources represent authoritative runtime state.

---

# 5. Core Resource Categories

## 5.1 Product Resources

### Purpose

Represent imported or authored engineering products.

### Examples

```text
product://bbq
product://bbq/revision/44
```

### Resource Contents

* assembly hierarchy
* semantic systems
* geometry revisions
* transaction history
* analysis summaries
* semanticization status

---

## 5.2 Semantic Entity Resources

### Purpose

Represent semantic engineering concepts.

### Examples

```text
semantic://bbq/airflow_system
semantic://bbq/cooking_chamber
semantic://bbq/thermal_handle_region
```

### Resource Contents

* semantic type
* purpose
* intent
* constraints
* relationships
* confidence
* evidence
* geometry bindings
* validation state

---

## 5.3 Geometry Resources

### Purpose

Expose geometry and topology state.

### Examples

```text
geometry://bbq/body/12
geometry://bbq/assembly/main
```

### Resource Contents

* topology revision
* geometry kernel
* feature references
* bounding geometry
* tessellation state
* adjacency information

---

## 5.4 Mapping Resources

### Purpose

Represent semantic-to-geometry relationships.

### Examples

```text
mapping://bbq/airflow_system
```

### Resource Contents

* semantic bindings
* geometry targets
* topology mappings
* remapping history
* confidence scores

---

## 5.5 Constraint Resources

### Purpose

Expose engineering constraints.

### Examples

```text
constraint://minimum_wall_thickness
constraint://safe_touch_temperature
```

### Resource Contents

* constraint type
* validation rules
* affected semantics
* severity
* violation history

---

## 5.6 Analysis Resources

### Purpose

Represent engineering analysis outputs.

### Examples

```text
analysis://thermal/44
analysis://manufacturing/12
```

### Resource Contents

* analysis type
* findings
* violations
* recommendations
* linked semantic entities
* linked transactions

---

## 5.7 Transaction Resources

### Purpose

Represent staged or committed engineering modifications.

### Examples

```text
transaction://9912
```

### Resource Contents

* requested changes
* affected semantics
* predicted impacts
* validation results
* rollback state
* commit history

---

# 6. MCP Tool Definitions

## 6.1 Tool Design Principles

Tools perform:

* engineering operations
* semantic reasoning
* geometry operations
* analysis workflows
* transactional modifications

Tools shall:

* operate semantically where practical
* remain topology-resilient
* produce explainable outputs
* preserve engineering intent

---

# 7. Semanticization Tools

## 7.1 import_geometry

### Purpose

Import external engineering geometry.

### Inputs

```json
{
  "source": "bbq.step"
}
```

### Outputs

* product resource
* geometry resources
* initial topology graph

---

## 7.2 infer_semantics

### Purpose

Infer semantic systems from geometry.

### Inputs

```json
{
  "target": "product://bbq"
}
```

### Outputs

* semantic candidates
* confidence scores
* evidence graph

---

## 7.3 validate_semantics

### Purpose

Confirm or reject inferred semantic understanding.

### Inputs

```json
{
  "semantic_entities": [
    "semantic://bbq/airflow_system"
  ]
}
```

### Outputs

* updated semantic states
* semantic lineage updates

---

# 8. Semantic Query Tools

## 8.1 query_semantic_graph

### Purpose

Query semantic relationships.

### Example Queries

* systems affecting airflow
* thermal dependencies
* mounting interfaces
* user interaction surfaces

### Inputs

```json
{
  "query": "systems influencing combustion airflow"
}
```

---

## 8.2 explain_semantic_entity

### Purpose

Explain semantic understanding.

### Inputs

```json
{
  "target": "semantic://bbq/airflow_system"
}
```

### Outputs

* engineering purpose
* inferred intent
* linked geometry
* evidence
* constraints

---

## 8.3 resolve_geometry_bindings

### Purpose

Resolve current geometry associated with semantic entities.

### Inputs

```json
{
  "semantic_id": "semantic://bbq/airflow_system"
}
```

### Outputs

* current geometry bindings
* topology references
* confidence scores

---

# 9. Geometry Inspection Tools

## 9.1 inspect_geometry_region

### Purpose

Inspect geometry associated with semantic systems.

### Inputs

```json
{
  "semantic_id": "semantic://bbq/cooking_chamber"
}
```

### Outputs

* geometry summary
* dimensions
* topology statistics
* feature summaries

---

## 9.2 inspect_topology_changes

### Purpose

Explain topology evolution.

### Inputs

```json
{
  "from_revision": 44,
  "to_revision": 45
}
```

### Outputs

* topology mutations
* remapped references
* affected semantic entities

---

# 10. Transactional Modification Tools

## 10.1 propose_modification

### Purpose

Create a staged engineering modification.

### Inputs

```json
{
  "targets": [
    "semantic://bbq/airflow_system"
  ],
  "goal": "increase airflow while preserving heat retention"
}
```

### Outputs

* transaction resource
* predicted changes
* affected systems
* risk analysis

---

## 10.2 preview_modification

### Purpose

Preview staged engineering changes.

### Inputs

```json
{
  "transaction": "transaction://9912"
}
```

### Outputs

* geometry previews
* semantic impacts
* constraint risks
* analysis summaries

---

## 10.3 validate_modification

### Purpose

Validate staged changes.

### Inputs

```json
{
  "transaction": "transaction://9912"
}
```

### Outputs

* constraint violations
* manufacturability findings
* optimization conflicts
* simulation summaries

---

## 10.4 commit_modification

### Purpose

Apply validated engineering modifications.

### Inputs

```json
{
  "transaction": "transaction://9912"
}
```

### Outputs

* updated geometry revision
* updated semantic graph
* topology remapping results

---

## 10.5 rollback_modification

### Purpose

Revert committed modifications.

### Inputs

```json
{
  "transaction": "transaction://9912"
}
```

### Outputs

* restored semantic state
* restored geometry revision
* updated mapping state

---

# 11. Analysis Tools

## 11.1 run_analysis

### Purpose

Execute engineering analysis.

### Analysis Types

* thermal
* structural
* manufacturability
* collision
* airflow
* optimization

### Inputs

```json
{
  "analysis_type": "thermal",
  "targets": [
    "semantic://bbq/cooking_chamber"
  ]
}
```

---

## 11.2 explain_analysis

### Purpose

Explain engineering analysis results.

### Inputs

```json
{
  "analysis": "analysis://thermal/44"
}
```

### Outputs

* findings
* affected systems
* risk explanations
* mitigation suggestions

---

# 12. Semantic Graph Evolution Tools

## 12.1 refine_semantic_understanding

### Purpose

Update semantic understanding using new evidence.

### Inputs

```json
{
  "target": "semantic://bbq/airflow_system",
  "new_evidence": [
    "thermal simulation"
  ]
}
```

---

## 12.2 merge_semantic_entities

### Purpose

Merge overlapping semantic concepts.

---

## 12.3 split_semantic_entity

### Purpose

Separate incorrectly grouped semantic systems.

---

# 13. Explainability Tools

## 13.1 explain_modification

### Purpose

Explain why a modification occurred.

### Outputs

* engineering rationale
* affected constraints
* optimization tradeoffs
* impacted systems

---

## 13.2 explain_constraint_violation

### Purpose

Explain validation failures.

### Outputs

* violated constraints
* contributing geometry
* semantic impacts
* mitigation options

---

# 14. MCP Prompt Definitions

## 14.1 Prompt Principles

Prompts provide structured reasoning workflows for AI systems.

Prompts are not authoritative.

They guide:

* semantic interpretation
* engineering reasoning
* analysis workflows
* design modification
* explainability

---

# 15. Core Prompt Categories

## 15.1 Semanticization Prompts

Examples:

* infer functional systems
* identify user interaction regions
* detect thermal systems
* identify manufacturing intent

---

## 15.2 Engineering Reasoning Prompts

Examples:

* improve airflow efficiency
* reduce manufacturing complexity
* improve structural rigidity
* minimize user burn risk

---

## 15.3 Validation Prompts

Examples:

* validate manufacturability
* inspect safety risks
* identify optimization conflicts
* evaluate thermal exposure

---

## 15.4 Explainability Prompts

Examples:

* explain why topology changed
* explain semantic confidence
* explain modification rationale
* explain simulation findings

---

# 16. MCP Interaction Model

## 16.1 Semantic Interaction Pattern

Preferred interaction flow:

```text
User Intent
      ↓
Semantic Query
      ↓
Transaction Proposal
      ↓
Analysis & Validation
      ↓
Preview
      ↓
Commit
```

---

## 16.2 Imported Geometry Workflow

```text
Import Geometry
      ↓
Infer Semantics
      ↓
Validate Semantics
      ↓
Construct Semantic Twin
      ↓
Enable AI Engineering Operations
```

---

# 17. MCP Safety Principles

## 17.1 No Direct Destructive Mutation

All modifications must be transactional.

---

## 17.2 Explainability Required

All major engineering actions must be explainable.

---

## 17.3 Stable References Required

AI systems must operate primarily on semantic references.

---

## 17.4 Human Validation Support

Semantic understanding must support:

* review
* correction
* refinement
* approval

---

# 18. Strategic Outcome

The MCP establishes:

* an AI-native engineering interface
* semantic-first engineering workflows
* topology-resilient AI interaction
* explainable engineering modification
* progressive semantic understanding
* transactional engineering safety
* graph-centric engineering reasoning

The resulting system enables AI agents to interact with engineering products as persistent semantic systems rather than transient collections of geometry primitives.
