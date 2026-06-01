# MCP Tool Schemas: Advanced Sheet Metal Unfolding (007)

**Phase 1 output** | **Date**: 2026-05-26

This document lists the JSON schemas for the new and modified MCP tools introduced for Advanced Sheet Metal Unfolding (007).

---

## Tool Schemas

### `validate_sheet_metal`

```json
{
  "name": "validate_sheet_metal",
  "description": "Inspects a 3D solid/shell and validates if it conforms to standard sheet metal constraints: uniform thickness and unfoldability (no T-junctions, no closed cycles). Non-mutating.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string", "description": "ID of the body/shell to validate" }
    },
    "required": ["part_id"]
  }
}
```

**Response**:
```json
{
  "is_valid": true,
  "nominal_thickness": 2.0,
  "can_flatten": true,
  "validation_errors": []
}
```

---

### `reconstruct_curved_bends`

```json
{
  "name": "reconstruct_curved_bends",
  "description": "Replaces infinitely sharp joint edges in a 3D CAD model with realistic rounded cylindrical bends based on material thickness (inner radius = t, outer radius = 2t). Returns a new replacement solid ID. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id":        { "type": "string", "description": "ID of the sharp-edge part to reconstruct" },
      "transaction_id": { "type": "string", "description": "Active transaction ID" }
    },
    "required": ["part_id", "transaction_id"]
  }
}
```

**Response**:
```json
{
  "solid_id": "new-reconstructed-solid-uuid",
  "bends_replaced": 4,
  "rollback_token": "transaction-id",
  "shape_history": [
    { "source_id": "sharp-edge-1", "target_id": "cylindrical-face-1", "verdict": "modified" }
  ]
}
```

---

### `apply_unfold` (Enhanced)

```json
{
  "name": "apply_unfold",
  "description": "Validates, heals minor gaps (up to 0.1 mm), and flattens a 3D sheet metal shell using analytical K-factor calculations. Produces flat blank dimensions and registers the unfold pattern. Mutating — requires transaction_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_id":             { "type": "string", "description": "ID of the sheet metal body to unfold" },
      "material_id":          { "type": "string", "description": "Material ID from configuration" },
      "k_factor":             { "type": "number", "minimum": 0.25, "maximum": 0.50, "description": "Optional K-factor override. Sourced from material DB if omitted." },
      "auto_heal_tolerance":  { "type": "number", "default": 0.1, "maximum": 0.1, "description": "Maximum gap tolerance (mm) for automatic sewing repair." },
      "transaction_id":       { "type": "string", "description": "Active transaction ID" }
    },
    "required": ["panel_id", "material_id", "transaction_id"]
  }
}
```

**Response**:
```json
{
  "unfold_id": "unfold-uuid",
  "flat_width_mm": 240.52,
  "flat_height_mm": 120.45,
  "k_factor_used": 0.33,
  "bend_count": 4,
  "validated": true,
  "detected_thickness": 2.0,
  "rollback_token": "transaction-id",
  "shape_history": []
}
```

---

## Errors Reference

| Code | Tool | Description |
|---|---|---|
| `GE_INVALID_SHEET_METAL` | `validate_sheet_metal`, `apply_unfold` | The shape is not a thin uniform-thickness sheet metal part or contains solid blocks. |
| `GE_UNFOLD_CYCLE_DETECTED` | `validate_sheet_metal`, `apply_unfold` | A cyclical bend loop exists that cannot be unfolded without inserting a rip. |
| `GE_UNFOLD_T_JUNCTION` | `validate_sheet_metal`, `apply_unfold` | A flange originates from the middle of a face, creating an unfoldable T-joint. |
| `GE_UNFOLD_SEWING_FAILED` | `apply_unfold` | Gaps along seams exceed the maximum `auto_heal_tolerance` ($0.1\text{ mm}$). |
| `GE_UNFOLD_REBUILD_FAILED` | `reconstruct_curved_bends` | Sharp joints could not be filleted due to invalid geometry or overlapping vertices. |
