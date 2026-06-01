# CAD Geometric Control MCP: Tool Taxonomy & OCCT Mapping (MVP)

This document defines the foundational Model Context Protocol (MCP) toolset for an Open CASCADE Technology (OCCT) based CAD engine.

This MVP specification focuses purely on base-level geometric manipulation, topological interrogation, and assembly management. It bypasses semantic reasoning and primitive generation, establishing the strict mechanical and state-driven APIs required for a backend system (e.g., written in Rust or Node.js) to interact safely with the OCCT B-Rep kernel.

---

## 1. Boolean & Merging Operations

These operations connect, combine, and divide existing topological shapes.

### `boolean.fuse`

Merges two or more intersecting solids into a single continuous solid.

* **OCCT Class:** `BRepAlgoAPI_Fuse`
* **Execution:** `fuse(shapeA, shapeB).Build()`

```json
{
  "action": "boolean.fuse",
  "tools": ["solid:A", "solid:B"],
  "fuzzy_tolerance": 1e-5 
}

```

### `boolean.cut`

Subtracts one set of geometries (tools) from a primary geometry (blank).

* **OCCT Class:** `BRepAlgoAPI_Cut`
* **Execution:** `cut(blankShape, toolList).Build()`

```json
{
  "action": "boolean.cut",
  "blank": "solid:base",
  "tools": ["solid:cutter1", "solid:cutter2"],
  "keep_tools": false
}

```

### `boolean.intersect`

Returns the shared volume between overlapping bodies.

* **OCCT Class:** `BRepAlgoAPI_Common`
* **Execution:** `common(shapeA, shapeB).Build()`

```json
{
  "action": "boolean.intersect",
  "targets": ["solid:A", "solid:B"]
}

```

### `topology.sew`

Stitches contiguous faces or shells into a single shell or solid. Critical for surface modeling and preparing imported geometry.

* **OCCT Class:** `BRepBuilderAPI_Sewing`
* **Execution:** Iterate `sewer.Add(face)`, then `sewer.Perform()`

```json
{
  "action": "topology.sew",
  "targets": ["face:12", "face:13", "face:14"],
  "tolerance": 0.001,
  "make_solid": true
}

```

---

## 2. Geometric Transformation Controls

Spatial operations applied to existing topology. These rely on constructing mathematical transforms and applying them to the B-Rep shape.

### `transform.translate`

Moves objects along a specific 3D vector.

* **OCCT Class:** `gp_Trsf::SetTranslation`, `BRepBuilderAPI_Transform`

```json
{
  "action": "transform.translate",
  "targets": ["solid:1"],
  "vector": [10.0, 0.0, -5.0]
}

```

### `transform.rotate`

Rotates a shape around a defined axis in 3D space.

* **OCCT Class:** `gp_Trsf::SetRotation`, `gp_Ax1`

```json
{
  "action": "transform.rotate",
  "targets": ["solid:1"],
  "axis_origin": [0.0, 0.0, 0.0],
  "axis_direction": [0.0, 0.0, 1.0],
  "angle_degrees": 45.0
}

```

### `transform.mirror`

Mirrors a shape across a defined plane.

* **OCCT Class:** `gp_Trsf::SetMirror`, `gp_Ax2`

```json
{
  "action": "transform.mirror",
  "targets": ["solid:1"],
  "plane_origin": [0.0, 0.0, 0.0],
  "plane_normal": [1.0, 0.0, 0.0]
}

```

### `transform.scale`

Scales a body relative to an origin point.

* **OCCT Class:** `gp_Trsf::SetScale`

```json
{
  "action": "transform.scale",
  "targets": ["solid:1"],
  "origin": [0.0, 0.0, 0.0],
  "scale_factor": 1.5
}

```

### `transform.align`

Calculates and applies the transformation matrix required to snap one topological entity to another without creating a persistent constraint.

* **OCCT Class:** Evaluate `Geom_Surface` normals, construct `gp_Ax3`, compute relative `gp_Trsf`.

```json
{
  "action": "transform.align",
  "source": "face:A",
  "destination": "face:B",
  "flip_normal": true
}

```

---

## 3. Direct Edit Operations

Base level manipulation of boundaries, edges, and topology health.

### `direct_edit.fillet` & `direct_edit.chamfer`

Applies radii or angled cuts to specific edges.

* **OCCT Class:** `BRepFilletAPI_MakeFillet`, `BRepFilletAPI_MakeChamfer`

```json
{
  "action": "direct_edit.fillet",
  "targets": ["edge:44", "edge:45"],
  "radius": 2.5
}

```

### `direct_edit.simplify_body`

Merges adjacent co-planar faces and collinear edges into single entities to prevent functional state corruption and simplify topology.

* **OCCT Class:** `ShapeUpgrade_UnifySameDomain`

```json
{
  "action": "direct_edit.simplify_body",
  "targets": ["solid:imported_step"],
  "unify_faces": true,
  "unify_edges": true
}

```

### `direct_edit.heal_geometry`

Repairs invalid B-Rep structures (disconnected edges, missing tolerances) to prevent boolean failures downstream.

* **OCCT Class:** `ShapeFix_Shape`

```json
{
  "action": "direct_edit.heal_geometry",
  "targets": ["solid:corrupted_1"],
  "fix_tolerances": true,
  "fix_wires": true
}

```

### `direct_edit.offset_shape`

Offsets the boundary of a solid to add thickness or shrink the body.

* **OCCT Class:** `BRepOffsetAPI_MakeOffsetShape`

```json
{
  "action": "direct_edit.offset_shape",
  "targets": ["solid:1"],
  "offset_value": 2.5,
  "tolerance": 1e-4
}

```

### `direct_edit.delete_face`

Removes a specific face and recalculates the surrounding topology, either leaving an open shell or attempting to heal the boundary.

* **OCCT Class:** Reconstruct shell via `BRepBuilderAPI_Sewing` minus target face, run `ShapeFix_Shape`.

```json
{
  "action": "direct_edit.delete_face",
  "targets": ["face:102"],
  "heal_remaining": true
}

```

---

## 4. Assembly & Mating Controls

Managing the hierarchical structure of geometry using XCAF.

### `assembly.add_instance`

Adds a geometric solid into a hierarchical assembly document.

* **OCCT Class:** `XCAFDoc_ShapeTool::AddShape`

```json
{
  "action": "assembly.add_instance",
  "target": "solid:1",
  "parent_assembly": "assembly:root"
}

```

### `assembly.mate_rigid`

Calculates the transform required to align two entities and permanently applies it to the component's hierarchical location.

* **OCCT Class:** `TopLoc_Location`, `XCAFDoc_Location`

```json
{
  "action": "assembly.mate_rigid",
  "source_entity": "face:44",
  "target_entity": "face:89",
  "mate_type": "coincident",
  "flip_alignment": false
}

```

---

## 5. Topological Interrogation (Inspection)

Tools required to extract spatial data, read entity properties, and prepare for state tracking.

### `topology.explore`

Iterates through a larger body to extract sub-shapes (faces, edges, vertices).

* **OCCT Class:** `TopExp_Explorer`

```json
{
  "action": "topology.explore",
  "target": "solid:1",
  "return_type": "face"
}

```

### `geometry.bounding_box`

Calculates the spatial footprint of an object.

* **OCCT Class:** `BRepBndLib::AddOptimal`, `Bnd_Box`

```json
{
  "action": "geometry.bounding_box",
  "target": "solid:1"
}

```

### `geometry.measure`

Measures distances or angles between two topological entities.

* **OCCT Class:** `BRepExtrema_DistShapeShape`

```json
{
  "action": "geometry.measure",
  "target_a": "face:1",
  "target_b": "face:2",
  "measurement_type": "min_distance"
}

```

### `geometry.mass_props`

Extracts physical properties like centroid, volume, and surface area.

* **OCCT Class:** `BRepGProp`, `GProp_GProps`

```json
{
  "action": "geometry.mass_props",
  "target": "solid:1",
  "properties": ["volume", "centroid"]
}

```
