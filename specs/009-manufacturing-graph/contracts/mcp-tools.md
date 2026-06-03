# MCP Tool Contracts: Manufacturing Graph

**Phase 1 output for**: `specs/009-manufacturing-graph/plan.md`
**Date**: 2026-06-03
**Branch**: `009-manufacturing-graph`

All tools are registered in `ts/src/mcp/tools.ts`. All error responses conform to
the structured error model in `ts/src/mcp/errors.ts` (`code`, `message`,
`recoverable`, `suggested_tool`).

---

## Common Response Fields

Every mutating tool response includes:

```jsonc
{
  "node_id": "string",          // stable NodeId of the created/updated/removed node
  "rollback_token": "string",   // snapshot token for transaction rollback
  "warnings": [                 // optional; empty array if none
    { "code": "string", "message": "string", "affected_node_ids": ["string"] }
  ],
  "geometry_solve": {           // included when auto-Solve ran (single-step tools)
    "solve_id": "string",
    "solved_node_ids": ["string"],
    "invalidated_body_ids": ["string"],
    "solve_ms": 0
  }
}
```

When dirty nodes exist and geometry is returned without a fresh Solve, the response
includes:
```jsonc
{
  "warnings": [
    { "code": "GEOMETRY_STALE", "message": "...", "affected_node_ids": ["..."] }
  ]
}
```

---

## `bootstrap_graph`

Bootstrap a Manufacturing Graph from a geometry body already registered in the
session (e.g. after importing a STEP file).

**Input**:
```jsonc
{
  "part_id": "string",            // body ID of the imported STEP solid
  "root_panel_id_prefix": "string", // optional; prefix for auto-generated node IDs (default: "panel")
  "angle_threshold_deg": 3.0,     // optional; dihedral angle threshold for bend detection
  "max_thickness_mm": 5.0,        // optional
  "default_thickness_mm": 1.0     // optional
}
```

**Output**:
```jsonc
{
  "panel_node_ids": ["panel-1", "panel-2"],
  "bend_node_ids": ["bend-1"],
  "cut_node_ids": ["cut-1"],       // populated if holes detected in source geometry
  "foldability_warnings": [        // advisory only during bootstrap (FR-016)
    { "code": "DRC_FOLDABILITY_VIOLATION", "panel_id": "panel-3", "message": "..." }
  ],
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `BODY_NOT_FOUND`, `BOOTSTRAP_PARTIAL`, `GRAPH_ALREADY_POPULATED`

---

## `add_bend`

Add a `BendNode` connecting two existing `PanelNode` entries.

**Input**:
```jsonc
{
  "node_id": "string",            // caller-supplied NodeId for the new BendNode
  "panel_a_id": "string",         // upstream PanelNode
  "panel_b_id": "string",         // downstream PanelNode
  "inner_radius_mm": 1.0,
  "angle_deg": 90.0,              // 1–179
  "k_factor": 0.33               // optional; defaults from material config
}
```

**Output**:
```jsonc
{
  "node_id": "string",
  "bend_allowance_mm": 1.5708,
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `NODE_ID_ALREADY_EXISTS`, `BODY_NOT_FOUND`, `MANUFACTURING_GRAPH_CYCLE_DETECTED`,
`DRC_BEND_RADIUS_VIOLATION`, `DRC_MIN_FLANGE_WIDTH_VIOLATION`, `DRC_FOLDABILITY_VIOLATION`

---

## `add_join`

Add a `JoinNode` connecting two panels by a mechanical fastening feature.

**Input**:
```jsonc
{
  "node_id": "string",
  "panel_a_id": "string",
  "panel_b_id": "string",
  "reference_edge_a": "string",   // edge identifier in panel A
  "reference_edge_b": "string",
  "join_type": "RIVET_PATTERN",   // FLANGE | TAB_SLOT | RIVET_PATTERN | WELD_PREP
  "params": {
    // RIVET_PATTERN:
    "spacing": 25.0,
    "diameter": 4.0,
    "edge_offset": 8.0
    // FLANGE: { "width": 12.0, "bend_angle": 90.0 }
    // TAB_SLOT: { "tab_width": 8.0, "tab_depth": 6.0, "count": 3 }
    // WELD_PREP: { "groove_angle": 60.0, "root_gap": 1.5 }
  }
}
```

**Output**:
```jsonc
{
  "node_id": "string",
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `NODE_ID_ALREADY_EXISTS`, `JOIN_EDGE_ALREADY_BOUND`, `BODY_NOT_FOUND`

---

## `add_cut`

Add a `CutNode` (hole or cutout profile) to a panel.

**Input**:
```jsonc
{
  "node_id": "string",
  "parent_panel_id": "string",
  "cut_type": "CIRCLE",           // CIRCLE | RECTANGLE | POLYGON | FREEFORM
  "profile": {
    // CIRCLE:
    "centre_x": 50.0,
    "centre_y": 40.0,
    "radius": 5.0
    // RECTANGLE: { "origin_x", "origin_y", "width", "height" }
    // POLYGON/FREEFORM: { "vertices": [{ "x": 0, "y": 0 }, ...] }
  },
  "label": "mounting-hole-1"      // optional
}
```

**Output**:
```jsonc
{
  "node_id": "string",
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `NODE_ID_ALREADY_EXISTS`, `BODY_NOT_FOUND`, `CUT_PROFILE_OUT_OF_BOUNDS`,
`CUT_OVERLAP`, `CUT_INVALID_PROFILE`

**Warnings** (non-blocking): `DRC_CUT_IN_BEND_ZONE`

---

## `update_node`

Update any field of any node. All fields mutable including structural panel
references and node ID (rename). Re-runs DRC; auto-invokes Solve.

**Input**:
```jsonc
{
  "node_id": "string",            // current NodeId to identify the node
  "updates": {
    // Any subset of the node's fields. Examples:
    // Rename:
    "new_node_id": "string",
    // BendNode parameter:
    "inner_radius_mm": 2.0,
    "angle_deg": 45.0,
    // BendNode structural re-wire:
    "panel_a_id": "string",
    "panel_b_id": "string",
    // CutNode profile replacement (any type, including FREEFORM):
    "cut_type": "FREEFORM",
    "profile": { "vertices": [{ "x": 10, "y": 10 }, ...] }
  }
}
```

**Output**:
```jsonc
{
  "node_id": "string",            // new NodeId if renamed; same as input otherwise
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `NODE_ID_ALREADY_EXISTS` (rename conflict), `NODE_NOT_FOUND`,
`MANUFACTURING_GRAPH_CYCLE_DETECTED`, `DRC_BEND_RADIUS_VIOLATION`,
`CUT_PROFILE_OUT_OF_BOUNDS`, `CUT_INVALID_PROFILE`

---

## `remove_node`

Remove a node from the graph. Validates no dangling references; marks downstream
dirty; auto-invokes Solve.

**Input**:
```jsonc
{
  "node_id": "string"
}
```

**Output**:
```jsonc
{
  "removed_node_id": "string",
  "downstream_dirty_ids": ["string"],   // nodes marked dirty by this removal
  "rollback_token": "string",
  "geometry_solve": { ... }
}
```

**Errors**: `NODE_NOT_FOUND`, `REMOVE_WOULD_ORPHAN_NODES`

---

## `solve_geometry`

Explicitly trigger a Geometry Solve across all dirty nodes. Required when batching
mutations inside a transaction; optional for single-step callers (auto-Solve runs).

**Input**:
```jsonc
{
  "scope": "all"                  // currently only "all"; reserved for future partial Solve
}
```

**Output**:
```jsonc
{
  "solve_id": "string",
  "timestamp": "2026-06-03T12:00:00.000Z",
  "solved_nodes": [
    { "node_id": "panel-1", "body_id": "uuid-v4-..." },
    { "node_id": "bend-1" }       // BendNodes have no direct body ID
  ],
  "invalidated_body_ids": ["old-uuid-..."],
  "dirty_count_before": 5,
  "solve_ms": 420
}
```

**Errors**: `SOLVE_FAILED` (includes `offending_node_id` and C++ error detail);
on failure, all dirty flags are restored and registry is rolled back.

---

## `check_foldability`

Query foldability status for all panels without mutating the graph.

**Input**:
```jsonc
{}                                // no arguments; evaluates current graph state
```

**Output**:
```jsonc
{
  "panels": [
    {
      "panel_id": "panel-1",
      "state": "OPEN",            // OPEN | CONSTRAINED | INACCESSIBLE
      "locking_bend_ids": []      // populated when INACCESSIBLE
    },
    {
      "panel_id": "panel-5",
      "state": "INACCESSIBLE",
      "locking_bend_ids": ["bend-3", "bend-4"]
    }
  ]
}
```

---

## `query_graph`

Return the full Manufacturing Graph in topological order.

**Input**:
```jsonc
{
  "include_body_ids": false       // optional; default false (body UUIDs not shown by default)
}
```

**Output**:
```jsonc
{
  "session_id": "string",
  "root_panel_id": "panel-1",
  "nodes": [
    {
      "type": "PanelNode",
      "node_id": "panel-1",
      "dirty": false,
      "material_type": "mild_steel_1mm",
      "nominal_thickness_mm": 1.0,
      "flat_width_mm": 200.0,
      "flat_height_mm": 150.0,
      "body_id": null             // only present when include_body_ids=true
    },
    {
      "type": "BendNode",
      "node_id": "bend-1",
      "dirty": false,
      "panel_a_id": "panel-1",
      "panel_b_id": "panel-2",
      "inner_radius_mm": 1.0,
      "angle_deg": 90.0,
      "k_factor": 0.33,
      "bend_allowance_mm": 1.5708
    }
  ],
  "dirty_node_ids": [],
  "warnings": []
}
```

---

## `reset_graph`

Clear the Manufacturing Graph and all associated geometry for the current session.

**Input**:
```jsonc
{}
```

**Output**:
```jsonc
{
  "cleared_node_count": 7,
  "cleared_body_count": 4
}
```

---

## Error Code Registry (new codes introduced by this feature)

| Code | HTTP-like severity | Description |
|---|---|---|
| `NODE_ID_ALREADY_EXISTS` | 400 | Caller-supplied node ID is already in use |
| `NODE_NOT_FOUND` | 404 | Node ID does not exist in the graph |
| `MANUFACTURING_GRAPH_CYCLE_DETECTED` | 400 | Operation would create a cycle in the DAG |
| `REMOVE_WOULD_ORPHAN_NODES` | 400 | Removing this node would leave dangling references |
| `JOIN_EDGE_ALREADY_BOUND` | 400 | The specified edge is already used by another BendNode or JoinNode |
| `GRAPH_INTEGRITY_ERROR` | 500 | Internal graph consistency check failed |
| `BOOTSTRAP_PARTIAL` | 206 | Bootstrap completed but some panels/bends could not be identified |
| `GRAPH_ALREADY_POPULATED` | 400 | `bootstrap_graph` called when a graph already exists; use `reset_graph` first |
| `SOLVE_FAILED` | 500 | Geometry Solve failed on a specific node; full rollback applied |
| `GEOMETRY_STALE` | warning | Returned values may be outdated; a Geometry Solve is pending |
| `DRC_BEND_RADIUS_VIOLATION` | 400 | Inner radius below material minimum |
| `DRC_MIN_FLANGE_WIDTH_VIOLATION` | 400 | Flange width below material minimum |
| `DRC_FOLDABILITY_VIOLATION` | 400 | Proposed bend is physically inaccessible on a press brake |
| `DRC_FOLDABILITY_UNCERTAIN` | warning | Foldability check inconclusive; manual verification advised |
| `DRC_CUT_IN_BEND_ZONE` | warning | Cut profile intersects bend-allowance setback zone |
| `CUT_PROFILE_OUT_OF_BOUNDS` | 400 | Cut profile extends outside the parent panel outline |
| `CUT_OVERLAP` | 400 | Cut profile overlaps an existing CutNode on the same panel |
| `CUT_INVALID_PROFILE` | 400 | FREEFORM/POLYGON profile has < 3 vertices or self-intersects |
