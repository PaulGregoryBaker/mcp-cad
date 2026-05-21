# Geometry Transaction MCP Tool Specification

## OCCT-Aligned Transactional Geometry Operations

This section should become:

## the concrete executable contract layer

between:

* AI agents
* semantic runtime
* geometry kernel orchestration

The key design rule is:

> MCP tools expose engineering intent and stable references,
> while internally orchestrating OCCT operations and topology remapping.

---

# 1. Transaction Lifecycle Tools

These tools establish safe mutation workflows.

---

# begin_transaction

## Purpose

Create isolated working state for geometry, semantic graph, and mappings.

## Parameters

```json
{
  "product": "product://bbq",
  "description": "Increase airflow efficiency"
}
```

## Returns

```json
{
  "transaction": "transaction://9912",
  "base_geometry_revision": 44,
  "base_semantic_revision": 12,
  "status": "active"
}
```

## Internal Responsibilities

* snapshot geometry state
* snapshot semantic graph
* snapshot mappings
* establish rollback point

---

# stage_operation

## Purpose

Add a geometry operation to a transaction pipeline.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "operation": {
    "tool": "create_opening",
    "parameters": {
      "target": "semantic://bbq/airflow_system",
      "diameter": 20
    }
  }
}
```

## Returns

```json
{
  "operation_id": "operation://883",
  "status": "staged"
}
```

## Internal Responsibilities

* validate target references
* build operation graph
* register dependency chain

---

# preview_transaction

## Purpose

Execute staged operations in temporary workspace.

## Parameters

```json
{
  "transaction": "transaction://9912"
}
```

## Returns

```json
{
  "preview_geometry_revision": 45,
  "modified_semantics": [
    "semantic://bbq/airflow_system"
  ],
  "generated_topology": 18,
  "deleted_topology": 6,
  "warnings": []
}
```

## Internal Responsibilities

* execute temporary geometry pipeline
* capture shape history
* remap topology
* update semantic bindings
* generate preview mesh

---

# validate_transaction

## Purpose

Perform geometry and semantic validation.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "checks": [
    "geometry_validity",
    "minimum_thickness",
    "constraint_consistency"
  ]
}
```

## Returns

```json
{
  "status": "valid",
  "violations": [],
  "warnings": [
    "Reduced structural stiffness near vent region"
  ]
}
```

## Internal Responsibilities

* run BRepCheck
* run engineering constraints
* run semantic integrity checks
* run mapping consistency checks

---

# commit_transaction

## Purpose

Apply staged operations permanently.

## Parameters

```json
{
  "transaction": "transaction://9912"
}
```

## Returns

```json
{
  "geometry_revision": 45,
  "semantic_revision": 13,
  "mapping_revision": 18,
  "status": "committed"
}
```

## Internal Responsibilities

* promote working state
* persist topology history
* persist semantic rebinding
* generate transaction log

---

# rollback_transaction

## Purpose

Discard staged modifications.

## Parameters

```json
{
  "transaction": "transaction://9912"
}
```

## Returns

```json
{
  "status": "rolled_back"
}
```

---

# 2. Primitive Geometry Creation Tools

Maps primarily to:

* BRepPrimAPI
* BRepBuilderAPI

---

# create_primitive

## Purpose

Create basic engineering solids.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "type": "cylinder",
  "parameters": {
    "radius": 120,
    "height": 400
  }
}
```

## Supported Types

* box
* cylinder
* cone
* sphere
* torus
* wedge

## Returns

```json
{
  "geometry": "geometry://body/44",
  "created_topology": 26
}
```

## OCCT Operations

```text
BRepPrimAPI_MakeBox
BRepPrimAPI_MakeCylinder
BRepPrimAPI_MakeCone
```

---

# create_extrusion

## Purpose

Create geometry from profile extrusion.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "profile": "sketch://vent_profile",
  "direction": [0,0,1],
  "distance": 40
}
```

## Returns

```json
{
  "geometry": "geometry://body/52"
}
```

## OCCT Operations

```text
BRepPrimAPI_MakePrism
```

---

# create_revolve

## Purpose

Create revolved geometry.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "profile": "sketch://cross_section",
  "axis": {
    "origin": [0,0,0],
    "direction": [0,1,0]
  },
  "angle": 360
}
```

## OCCT Operations

```text
BRepPrimAPI_MakeRevol
```

---

# 3. Boolean Modification Tools

Maps primarily to:

* BRepAlgoAPI

---

# add_material

## Purpose

Fuse geometry into target body.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "target": "geometry://body/12",
  "tool_geometry": "geometry://body/88"
}
```

## Returns

```json
{
  "modified_geometry": "geometry://body/12",
  "generated_faces": 14
}
```

## OCCT Operations

```text
BRepAlgoAPI_Fuse
```

---

# remove_material

## Purpose

Subtract geometry from target body.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "target": "semantic://bbq/airflow_system",
  "tool_geometry": "geometry://body/90"
}
```

## Returns

```json
{
  "modified_geometry": "geometry://body/12",
  "deleted_faces": 8,
  "generated_faces": 14
}
```

## OCCT Operations

```text
BRepAlgoAPI_Cut
```

---

# intersect_geometry

## Purpose

Compute shared volume between shapes.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "targets": [
    "geometry://body/12",
    "geometry://body/13"
  ]
}
```

## OCCT Operations

```text
BRepAlgoAPI_Common
```

---

# split_geometry

## Purpose

Split bodies using tool geometry.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "target": "geometry://body/12",
  "splitter": "geometry://surface/44"
}
```

## OCCT Operations

```text
BRepAlgoAPI_Splitter
```

---

# 4. Feature Modification Tools

Maps to:

* BRepFilletAPI
* BRepOffsetAPI
* BRepFeat

---

# apply_fillet

## Purpose

Apply edge fillets.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "edges": [
    "geometry://edge/44"
  ],
  "radius": 4
}
```

## Returns

```json
{
  "modified_edges": 12,
  "generated_faces": 8
}
```

## OCCT Operations

```text
BRepFilletAPI_MakeFillet
```

---

# apply_chamfer

## Purpose

Apply chamfers.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "edges": [
    "geometry://edge/12"
  ],
  "distance": 2
}
```

## OCCT Operations

```text
BRepFilletAPI_MakeChamfer
```

---

# shell_body

## Purpose

Convert solid into hollow shell.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "target": "geometry://body/12",
  "wall_thickness": 2
}
```

## OCCT Operations

```text
BRepOffsetAPI_MakeThickSolid
```

---

# offset_surface

## Purpose

Create offset geometry.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "target": "geometry://face/12",
  "offset": 3
}
```

## OCCT Operations

```text
BRepOffsetAPI_MakeOffset
```

---

# 5. Geometry Analysis Tools

Maps to:

* BRepCheck
* ShapeAnalysis
* GProp
* TopExp

---

# validate_geometry

## Purpose

Validate topological correctness.

## Parameters

```json
{
  "geometry": "geometry://body/12"
}
```

## Returns

```json
{
  "valid": true,
  "issues": []
}
```

## OCCT Operations

```text
BRepCheck_Analyzer
```

---

# compute_mass_properties

## Purpose

Calculate engineering properties.

## Parameters

```json
{
  "geometry": "geometry://body/12"
}
```

## Returns

```json
{
  "volume": 12000,
  "surface_area": 4400,
  "center_of_mass": [0,12,44]
}
```

## OCCT Operations

```text
GProp_GProps
BRepGProp
```

---

# detect_interference

## Purpose

Detect geometric collisions.

## Parameters

```json
{
  "targets": [
    "geometry://body/12",
    "geometry://body/44"
  ]
}
```

## Returns

```json
{
  "interference_detected": true,
  "intersection_regions": 2
}
```

---

# 6. Geometry Healing Tools

Critical for imported STEP geometry.

Maps to:

* ShapeFix
* ShapeUpgrade

---

# heal_geometry

## Purpose

Repair invalid geometry.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "geometry": "geometry://body/12"
}
```

## Returns

```json
{
  "fixed_issues": [
    "small_edge_removed",
    "wire_closed"
  ]
}
```

## OCCT Operations

```text
ShapeFix_Shape
```

---

# sew_faces

## Purpose

Sew disconnected faces into shells.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "faces": [
    "geometry://face/12",
    "geometry://face/13"
  ]
}
```

## OCCT Operations

```text
BRepBuilderAPI_Sewing
```

---

# unify_geometry

## Purpose

Merge coplanar/same-domain geometry.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "geometry": "geometry://body/12"
}
```

## OCCT Operations

```text
ShapeUpgrade_UnifySameDomain
```

---

# 7. Mapping & Topology Tracking Tools

These are AI-critical.

---

# capture_shape_history

## Purpose

Capture topology evolution after operations.

## Parameters

```json
{
  "transaction": "transaction://9912"
}
```

## Returns

```json
{
  "generated": 24,
  "modified": 18,
  "deleted": 6
}
```

## OCCT Operations

```text
Generated()
Modified()
IsDeleted()
```

---

# remap_semantic_bindings

## Purpose

Rebind semantic entities after topology mutation.

## Parameters

```json
{
  "transaction": "transaction://9912",
  "semantic_entities": [
    "semantic://bbq/airflow_system"
  ]
}
```

## Returns

```json
{
  "updated_bindings": 12,
  "failed_bindings": []
}
```

---

# resolve_semantic_geometry

## Purpose

Resolve geometry currently associated with semantic entities.

## Parameters

```json
{
  "semantic_entity": "semantic://bbq/airflow_system"
}
```

## Returns

```json
{
  "geometry_bindings": [
    "geometry://face/44",
    "geometry://face/45"
  ]
}
```

---

# 8. MVP Recommendation

The realistic MVP toolset is probably:

| Priority  | Tool                    |
| --------- | ----------------------- |
| Critical  | begin_transaction       |
| Critical  | preview_transaction     |
| Critical  | commit_transaction      |
| Critical  | rollback_transaction    |
| Critical  | remove_material         |
| Critical  | add_material            |
| Critical  | apply_fillet            |
| Critical  | validate_geometry       |
| Critical  | capture_shape_history   |
| Critical  | remap_semantic_bindings |
| Important | heal_geometry           |
| Important | split_geometry          |
| Important | shell_body              |
| Important | compute_mass_properties |

Because these establish:

* stable topology evolution
* semantic continuity
* transactional mutation
* recoverable operations
* explainable modeling behavior

Those are the true foundations of an AI-native CAD runtime.
