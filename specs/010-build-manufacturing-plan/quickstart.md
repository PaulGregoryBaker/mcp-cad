# Quickstart: Build Manufacturing Plan

This document outlines how to invoke and test the `build_manufacturing_plan` tool.

## 1. Tool Parameters

The MCP tool `build_manufacturing_plan` accepts the following arguments:

- `part_id` (string, required): The ID of the solid body to analyze.
- `transaction_id` (string, required): The active transaction ID to track operations.
- `angle_threshold_deg` (number, optional, default: `30.0`): The dihedral angle threshold for detecting bends.
- `max_thickness_mm` (number, optional, default: `5.0`): The maximum thickness of a sheet metal panel.
- `default_thickness_mm` (number, optional, default: `1.0`): The thickness fallback.
- `material_id` (string, optional): Sourced from config.yaml if not provided.

---

## 2. Invocation Example

To run the tool, open a transaction and call `build_manufacturing_plan`:

```json
// Step 1: Start transaction
{
  "method": "tools/call",
  "params": {
    "name": "begin_transaction",
    "arguments": {
      "label": "Import and reconstruct brackets step"
    }
  }
}

// Response returns transaction_id: "tx-12345"

// Step 2: Run build_manufacturing_plan
{
  "method": "tools/call",
  "params": {
    "name": "build_manufacturing_plan",
    "arguments": {
      "part_id": "imported-bracket-body-id",
      "transaction_id": "tx-12345",
      "angle_threshold_deg": 30.0
    }
  }
}
```

---

## 3. Example Response

The response contains the status of all reconstructed parts, unmerged protrusions/panels, and skipped joints:

```json
{
  "success": true,
  "reconstructed_parts": [
    {
      "part_id": "reconstructed-shell-1",
      "graph": {
        "part_id": "reconstructed-shell-1",
        "nodes": [
          { "type": "PanelNode", "id": "panel-1", "bodyId": "panel-body-1" },
          { "type": "PanelNode", "id": "panel-2", "bodyId": "panel-body-2" },
          { "type": "BendNode", "id": "bend-1", "panelAId": "panel-1", "panelBId": "panel-2", "angle": 90 }
        ],
        "edges": [
          { "from": "panel-1", "to": "bend-1" },
          { "from": "bend-1", "to": "panel-2" }
        ]
      }
    }
  ],
  "unmerged_parts": [
    {
      "part_id": "boss-nut-protrusion-1",
      "reason": "protrusion",
      "bbox": {
        "x_min": 10.0, "y_min": 10.0, "z_min": 0.0,
        "x_max": 15.0, "y_max": 15.0, "z_max": 5.0
      },
      "parent_panel_id": "panel-1"
    }
  ],
  "skipped_joints": []
}
```
