# MCP Tool Schemas: Geometric Primitive Tools (006)

**Phase 1 output** | **Date**: 2026-05-24

These are the MCP JSON Schema contracts for all 22 new tools. Existing tools are not repeated. These schemas are implemented verbatim in `ts/src/mcp/tools.ts` → `getToolDefinitions()`.

**Convention**: `transaction_id` is required on every mutating tool. `keep_original` defaults to `false` on all transforms. Interrogation tools have no `transaction_id`.

---

## Boolean Operations

### `fuse_bodies`

```json
{
  "name": "fuse_bodies",
  "description": "Merges two or more solids/shells into a single continuous body using a Boolean union. Returns a new body id. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tools":           { "type": "array", "items": { "type": "string" }, "minItems": 2, "description": "IDs of the bodies to fuse" },
      "fuzzy_tolerance": { "type": "number", "default": 1e-5, "description": "Fuzzy tolerance for near-coincident geometry (mm)" },
      "transaction_id":  { "type": "string" }
    },
    "required": ["tools", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, disjoint: bool, rollback_token, shape_history[] }`

---

### `cut_bodies`

```json
{
  "name": "cut_bodies",
  "description": "Subtracts tool bodies from a blank body (Boolean difference). Returns the modified blank as a new body id. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "blank":           { "type": "string", "description": "Body to cut into" },
      "tools":           { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Cutter body IDs" },
      "keep_tools":      { "type": "boolean", "default": false, "description": "If false, tool bodies are removed from the session after the cut" },
      "transaction_id":  { "type": "string" }
    },
    "required": ["blank", "tools", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `intersect_bodies`

```json
{
  "name": "intersect_bodies",
  "description": "Returns the shared volume between two overlapping bodies (Boolean intersection). Returns a new body id, or GE_BOOLEAN_EMPTY_RESULT if no overlap. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_a":       { "type": "string", "description": "First body ID" },
      "target_b":       { "type": "string", "description": "Second body ID" },
      "transaction_id": { "type": "string" }
    },
    "required": ["target_a", "target_b", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`
**Error**: `GE_BOOLEAN_EMPTY_RESULT` (recoverable) when no intersection exists.

---

## Topological Interrogation (non-mutating)

### `bounding_box`

```json
{
  "name": "bounding_box",
  "description": "Returns the axis-aligned bounding box of a body, face, edge, or vertex. Non-mutating.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": { "type": "string", "description": "Entity ID (solid, shell, face, edge, or vertex)" }
    },
    "required": ["target"]
  }
}
```

**Response**: `{ x_min, y_min, z_min, x_max, y_max, z_max }` (all in mm)

---

### `mass_properties`

```json
{
  "name": "mass_properties",
  "description": "Returns physical properties of a solid or shell: volume, surface area, centroid, and/or inertia tensor. Non-mutating.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target":     { "type": "string", "description": "Body ID" },
      "properties": {
        "type": "array",
        "items": { "type": "string", "enum": ["volume", "surface_area", "centroid", "inertia_tensor"] },
        "minItems": 1,
        "default": ["volume", "surface_area", "centroid", "inertia_tensor"]
      }
    },
    "required": ["target"]
  }
}
```

**Response**: `{ volume?, surface_area?, centroid?: [x,y,z], inertia_tensor?: [9 numbers] }` (mm³, mm², mm)

---

### `measure_distance`

```json
{
  "name": "measure_distance",
  "description": "Measures the minimum distance, maximum distance, or angle between two topological entities. Non-mutating.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_a":        { "type": "string", "description": "First entity ID (face, edge, vertex, or body)" },
      "target_b":        { "type": "string", "description": "Second entity ID" },
      "measurement_type": {
        "type": "string",
        "enum": ["min_distance", "max_distance", "angle"],
        "default": "min_distance",
        "description": "angle is only supported between two planar faces"
      }
    },
    "required": ["target_a", "target_b"]
  }
}
```

**Response**: `{ value: number, measurement_type: string }` (mm or degrees)
**Error**: `GE_ALIGN_UNSUPPORTED` if `angle` requested on non-planar faces.

---

### `explore_topology`

```json
{
  "name": "explore_topology",
  "description": "Returns an ordered list of sub-entity IDs of the specified type within a body. Non-mutating. Order is deterministic for identical inputs.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target":      { "type": "string", "description": "Body or shell ID to explore" },
      "return_type": {
        "type": "string",
        "enum": ["solid", "shell", "face", "edge", "vertex"],
        "description": "Sub-entity type to return"
      }
    },
    "required": ["target", "return_type"]
  }
}
```

**Response**: `{ entity_ids: string[] }`

---

## Geometric Transformations

### `translate_body`

```json
{
  "name": "translate_body",
  "description": "Moves one or more bodies along a 3D vector. Produces a new body id per target. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "vector":         { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[dx, dy, dz] in mm" },
      "keep_original":  { "type": "boolean", "default": false },
      "transaction_id": { "type": "string" }
    },
    "required": ["targets", "vector", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }` (one per target in request order)

---

### `rotate_body`

```json
{
  "name": "rotate_body",
  "description": "Rotates one or more bodies around a defined axis. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets":          { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "axis_origin":      { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[x, y, z] of a point on the rotation axis (mm)" },
      "axis_direction":   { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[dx, dy, dz] direction vector of the axis (need not be unit)" },
      "angle_degrees":    { "type": "number", "description": "Rotation angle in degrees (right-hand rule)" },
      "keep_original":    { "type": "boolean", "default": false },
      "transaction_id":   { "type": "string" }
    },
    "required": ["targets", "axis_origin", "axis_direction", "angle_degrees", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `mirror_body`

```json
{
  "name": "mirror_body",
  "description": "Mirrors one or more bodies across a defined plane. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "plane_origin":   { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[x,y,z] of a point on the mirror plane (mm)" },
      "plane_normal":   { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[nx,ny,nz] plane normal (need not be unit)" },
      "keep_original":  { "type": "boolean", "default": false },
      "transaction_id": { "type": "string" }
    },
    "required": ["targets", "plane_origin", "plane_normal", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `scale_body`

```json
{
  "name": "scale_body",
  "description": "Uniformly scales one or more bodies relative to a fixed origin. Non-uniform scaling is not supported (returns GE_SCALE_NON_UNIFORM). Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1 },
      "origin":         { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": "[x,y,z] scale origin (mm)" },
      "scale_factor":   { "type": "number", "exclusiveMinimum": 0, "description": "Uniform scale factor (> 0)" },
      "keep_original":  { "type": "boolean", "default": false },
      "transaction_id": { "type": "string" }
    },
    "required": ["targets", "origin", "scale_factor", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `align_to_face`

```json
{
  "name": "align_to_face",
  "description": "Repositions the body containing source_face so that source_face is coincident with destination_face. Phase 1 supports planar-to-planar only. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source_face":    { "type": "string", "description": "Face ID on the body to move" },
      "destination_face": { "type": "string", "description": "Target face ID (this body does not move)" },
      "flip_normal":    { "type": "boolean", "default": false, "description": "If true, source face normal is flipped before alignment" },
      "keep_original":  { "type": "boolean", "default": false },
      "transaction_id": { "type": "string" }
    },
    "required": ["source_face", "destination_face", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`
**Error**: `GE_ALIGN_UNSUPPORTED` if either face is non-planar.

---

## Direct Edit Operations

### `fillet_edges`

```json
{
  "name": "fillet_edges",
  "description": "Applies a circular fillet of the given radius to the specified edges. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string", "description": "Body/shell containing the edges" },
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Edge IDs to fillet" },
      "radius":         { "type": "number", "exclusiveMinimum": 0, "description": "Fillet radius in mm" },
      "transaction_id": { "type": "string" }
    },
    "required": ["part_id", "targets", "radius", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`
**Error**: `GE_FILLET_TOO_LARGE` (recoverable) with offending edge id if OCCT fails.

---

### `chamfer_edges`

```json
{
  "name": "chamfer_edges",
  "description": "Applies an angled chamfer of the given distance to the specified edges. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string" },
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Edge IDs to chamfer" },
      "distance":       { "type": "number", "exclusiveMinimum": 0, "description": "Chamfer offset distance in mm" },
      "transaction_id": { "type": "string" }
    },
    "required": ["part_id", "targets", "distance", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `simplify_body`

```json
{
  "name": "simplify_body",
  "description": "Merges co-planar adjacent faces and collinear edges into single entities (ShapeUpgrade_UnifySameDomain). Reduces face count without changing geometry. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string" },
      "unify_faces":    { "type": "boolean", "default": true, "description": "Merge co-planar adjacent faces" },
      "unify_edges":    { "type": "boolean", "default": true, "description": "Merge collinear adjacent edges" },
      "transaction_id": { "type": "string" }
    },
    "required": ["part_id", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `heal_geometry_ex`

```json
{
  "name": "heal_geometry_ex",
  "description": "Repairs B-Rep validity issues (gaps, bad tolerances, invalid wires) using ShapeFix_Shape. Returns heal_complete: true if BRepCheck_Analyzer passes on the result. Non-destructive but mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":          { "type": "string" },
      "fix_tolerances":   { "type": "boolean", "default": true },
      "fix_wires":        { "type": "boolean", "default": true },
      "transaction_id":   { "type": "string" }
    },
    "required": ["part_id", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, heal_complete: bool, remaining_issues: string[], rollback_token, shape_history[] }`
**Note**: Returns success even if `heal_complete: false` — the partial result is still useful. Use `remaining_issues` to understand what could not be fixed.

---

### `offset_shape`

```json
{
  "name": "offset_shape",
  "description": "Offsets the boundary of a solid outward (positive) or inward (negative) by the given distance. Distinct from offset_face (which offsets a single face in 2D). Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string" },
      "offset_value":   { "type": "number", "description": "Offset distance in mm. Positive = outward (thicken), negative = inward (shrink)." },
      "tolerance":      { "type": "number", "default": 1e-4, "description": "Shape tolerance (mm)" },
      "transaction_id": { "type": "string" }
    },
    "required": ["part_id", "offset_value", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, rollback_token, shape_history[] }`

---

### `delete_face`

```json
{
  "name": "delete_face",
  "description": "Removes specified faces and attempts to heal the surrounding topology. May produce multiple bodies if removal disconnects the shape. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string", "description": "Body containing the faces" },
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "Face IDs to delete" },
      "heal_remaining": { "type": "boolean", "default": true, "description": "If true, run ShapeFix_Shape on the result" },
      "transaction_id": { "type": "string" }
    },
    "required": ["part_id", "targets", "transaction_id"]
  }
}
```

**Response**: `{ solid_ids: string[], rollback_token, shape_history[] }` — `solid_ids` has 1 entry normally, multiple if removal disconnected the body.

---

## Topology Sewing

### `sew_faces`

```json
{
  "name": "sew_faces",
  "description": "Stitches contiguous faces or shells into a single shell or solid (BRepBuilderAPI_Sewing). If unstitched edges remain, sew_complete is false and free_edges is populated. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets":        { "type": "array", "items": { "type": "string" }, "minItems": 2, "description": "Face or shell IDs to sew together" },
      "tolerance":      { "type": "number", "default": 0.001, "description": "Sewing tolerance (mm)" },
      "make_solid":     { "type": "boolean", "default": false, "description": "If true and result is a closed shell, promote to solid" },
      "transaction_id": { "type": "string" }
    },
    "required": ["targets", "transaction_id"]
  }
}
```

**Response**: `{ solid_id, sew_complete: bool, free_edges: string[], rollback_token, shape_history[] }`

---

## Assembly Operations

### `create_assembly_document`

```json
{
  "name": "create_assembly_document",
  "description": "Creates a new XCAF assembly document. Returns an assembly_id that can be populated with instances and mates. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "transaction_id": { "type": "string" }
    },
    "required": ["transaction_id"]
  }
}
```

**Response**: `{ assembly_id: string, rollback_token: string }`

---

### `add_assembly_instance`

```json
{
  "name": "add_assembly_instance",
  "description": "Adds a body or sub-assembly as a new component instance in a parent assembly. Optionally places it at a location specified as translation + quaternion rotation. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "assembly_id":    { "type": "string", "description": "Parent assembly ID" },
      "target":         { "type": "string", "description": "Body ID or sub-assembly ID to instantiate" },
      "location": {
        "type": "object",
        "description": "Optional initial placement. Defaults to identity (at origin, no rotation).",
        "properties": {
          "translation": { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 },
          "rotation":    { "type": "array", "items": { "type": "number" }, "minItems": 4, "maxItems": 4, "description": "[qw, qx, qy, qz] unit quaternion" }
        }
      },
      "transaction_id": { "type": "string" }
    },
    "required": ["assembly_id", "target", "transaction_id"]
  }
}
```

**Response**: `{ component_id: string, rollback_token: string }`

---

### `mate_rigid`

```json
{
  "name": "mate_rigid",
  "description": "Calculates and applies the transform needed to snap source_entity (on a component) coincident with target_entity (on another component). Phase 1: planar coincident mates only. The source component moves; the target does not. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "assembly_id":    { "type": "string" },
      "source_entity":  { "type": "string", "description": "Face ID on the component to move" },
      "target_entity":  { "type": "string", "description": "Face ID on the stationary component" },
      "mate_type":      { "type": "string", "enum": ["coincident"], "default": "coincident" },
      "flip_alignment": { "type": "boolean", "default": false },
      "transaction_id": { "type": "string" }
    },
    "required": ["assembly_id", "source_entity", "target_entity", "transaction_id"]
  }
}
```

**Response**: `{ component_id: string, location_matrix: number[16], rollback_token: string }`
**Errors**:
- `GE_ASSEMBLY_MATE_UNSUPPORTED` if either entity is non-planar.
- `GE_ASSEMBLY_CROSS_DOCUMENT` if entities belong to different assembly documents.

---

### `list_assembly_tree`

```json
{
  "name": "list_assembly_tree",
  "description": "Returns the hierarchical tree of components in an assembly, with their location matrices. Non-mutating.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "assembly_id": { "type": "string" }
    },
    "required": ["assembly_id"]
  }
}
```

**Response**: `{ assembly_id, root: AssemblyNode }` where `AssemblyNode = { component_id, shape_id, location_matrix: number[16], children: AssemblyNode[] }`.

---

## Error Reference

All errors follow Constitution Principle VI — `{ code, message, recoverable, suggested_tool? }`.

| Code | Tool(s) | Recoverable | Suggested Action |
|---|---|---|---|
| `GE_BOOLEAN_EMPTY_RESULT` | `intersect_bodies` | ✅ | Check overlap with `compute_intersections` before calling |
| `GE_ALIGN_UNSUPPORTED` | `align_to_face`, `measure_distance` | ✅ | Use `explore_topology` to confirm face is planar (surfaceType=plane) |
| `GE_SCALE_NON_UNIFORM` | `scale_body` | ✅ | Use uniform scale_factor only |
| `GE_FILLET_TOO_LARGE` | `fillet_edges` | ✅ | Reduce radius; use `measure_distance` between adjacent faces to bound max radius |
| `GE_CHAMFER_TOO_LARGE` | `chamfer_edges` | ✅ | Reduce distance |
| `GE_HEAL_INCOMPLETE` | `heal_geometry_ex` | ✅ | Inspect `remaining_issues`; consider `simplify_body` first |
| `GE_SEW_INCOMPLETE` | `sew_faces` | ✅ | Result is still returned with `free_edges`; agent can inspect and re-try |
| `GE_ASSEMBLY_MATE_UNSUPPORTED` | `mate_rigid` | ✅ | Only planar coincident mates in Phase 1 |
| `GE_ASSEMBLY_CROSS_DOCUMENT` | `mate_rigid` | ❌ | Both components must be in the same assembly document |
