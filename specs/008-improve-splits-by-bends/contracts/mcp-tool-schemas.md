# MCP Tool Schemas: Splits by Bends and Viewport Alignment Enhancements (008)

**Phase 1 Output** | **Date**: 2026-06-01
**Spec**: [spec.md](../spec.md)

---

## Tool Schemas

### 1. `center_and_align_body` (New Tool)

Exposes on-demand coordinate translation and re-orientation of off-center models (like `cauldron.step`) to global standard vectors.

```json
{
  "name": "center_and_align_body",
  "description": "Calculates the Center of Mass (centroid) of a 3D solid/shell, translates it to [0,0,0], and rotates it so its dominant planar normal aligns with the Z-axis. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string", "description": "ID of the shell body to re-orient" },
      "transaction_id": { "type": "string", "description": "Active transaction ID" }
    },
    "required": ["part_id", "transaction_id"]
  }
}
```

**Response**:
```json
{
  "solid_id": "aligned-solid-uuid",
  "centroid": [12.54, -45.12, 120.45],
  "rotation_matrix": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
  "rollback_token": "transaction-id",
  "shape_history": [
    {
      "verdict": "modified",
      "original_id": "original-solid-uuid",
      "new_id": "aligned-solid-uuid",
      "operation_label": "center_and_align_body"
    }
  ]
}
```

---

### 2. `split_body_by_bends` (Enhanced)

Decomposes the part and returns full `shape_history` for PR/branch compare remapping. Merges faceted adjacent coplanar triangles into single flat panels.

```json
{
  "name": "split_body_by_bends",
  "description": "Decomposes a shell body into flat panels by splitting at every bend. Auto-detects mode. Integrates co-planar adjacent triangular facets into flat trapezoidal panels. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string", "description": "Shell to decompose" },
      "angle_threshold_deg": {
        "type": "number",
        "minimum": 0,
        "description": "Minimum deviation from 180° dihedral to treat an edge as a bend. Default 1.0."
      },
      "max_thickness_mm": {
        "type": "number",
        "minimum": 0,
        "description": "Wall thickness at or below which the solid is treated as a thin-solid. Default 5.0."
      },
      "default_thickness_mm": {
        "type": "number",
        "minimum": 0,
        "description": "Panel thickness applied when extruding in surface mode. Default 1.0."
      },
      "max_recursion_depth": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10,
        "description": "Recursion depth for nested decomposition. Default 1."
      },
      "transaction_id": { "type": "string", "description": "Active transaction ID" }
    },
    "required": ["part_id"]
  }
}
```

**Response**:
```json
{
  "panel_ids": ["panel-1", "panel-2"],
  "panel_count": 2,
  "panel_bboxes": [
    { "x_min": -50, "y_min": -50, "z_min": 0, "x_max": 50, "y_max": 50, "z_max": 2.0 }
  ],
  "protrusion_ids": ["flange-1"],
  "protrusion_count": 1,
  "protrusion_bboxes": [
    { "x_min": -10, "y_min": -10, "z_min": 2.0, "x_max": 10, "y_max": 10, "z_max": 12.0 }
  ],
  "protrusion_parents": [
    { "protrusion_id": "flange-1", "parent_panel_id": "panel-1" }
  ],
  "detected_mode": "thin_solid",
  "rollback_token": "transaction-id",
  "shape_history": [
    {
      "verdict": "deleted",
      "original_id": "parent-part-uuid",
      "new_id": "panel-1",
      "operation_label": "split_body_by_bends"
    },
    {
      "verdict": "deleted",
      "original_id": "parent-part-uuid",
      "new_id": "panel-2",
      "operation_label": "split_body_by_bends"
    }
  ]
}
```

---

### 3. `remove_protrusions` (Enhanced)

Executes the high-speed mesh-traversal closed-loop algorithm to slice thin flanges cleanly off the parent panel. Maintains the legacy volumetric fallback method for comparative benchmarks.

```json
{
  "name": "remove_protrusions",
  "description": "Detects and extracts all protrusions (flanges, tabs, bosses) from a shell body without splitting it. Slices precisely along narrow closed edge loops. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string", "description": "Shell to clean protrusions from" },
      "angle_threshold_deg": { "type": "number", "description": "Minimum dihedral deviation to classify primary panels. Default 30.0." },
      "max_thickness_mm": { "type": "number", "description": "Maximum protrusion thickness. Default 5.0." },
      "algorithm": {
        "type": "string",
        "enum": ["loop_traversal", "legacy_volumetric"],
        "default": "loop_traversal",
        "description": "Algorithmic path. Defaults to loop_traversal for high speed; legacy_volumetric is kept for benchmarking."
      },
      "transaction_id": { "type": "string", "description": "Active transaction ID" }
    },
    "required": ["part_id"]
  }
}
```

**Response**:
```json
{
  "cleaned_part_id": "cleaned-body-uuid",
  "protrusion_ids": ["flange-1", "flange-2"],
  "protrusion_count": 2,
  "protrusion_bboxes": [
    { "x_min": -5.0, "y_min": -5.0, "z_min": 100, "x_max": 5.0, "y_max": 5.0, "z_max": 110 }
  ],
  "rollback_token": "transaction-id",
  "shape_history": [
    {
      "verdict": "modified",
      "original_id": "parent-part-uuid",
      "new_id": "cleaned-body-uuid",
      "operation_label": "remove_protrusions"
    }
  ]
}
```
