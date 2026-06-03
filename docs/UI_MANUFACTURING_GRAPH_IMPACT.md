# Manufacturing Graph — UI Impact Summary

**Audience**: UI application team
**Feature branch**: `009-manufacturing-graph`
**Prerequisite shipped**: `004-transaction-primitive` (transactions already in place)

---

## What Has Changed (High Level)

The MCP server now maintains a **Manufacturing Graph** — a session-scoped DAG that records fabrication intent (panels, bends, joins, cut profiles) as a first-class, queryable domain object. The B-Rep geometry is a *derivative* of this graph, not the source of truth.

This has three concrete implications for the UI:

1. **There is now a graph to display and navigate** — 10 new MCP tools expose CRUD operations on graph nodes.
2. **The `apply_unfold` response is richer** — graph-derived flat-pattern data and cut profiles are now included.
3. **Body IDs are volatile; node IDs are stable** — the UI must stop treating geometry body UUIDs as persistent identifiers.

---

## New MCP Tools — What the UI Can Call

All are in-session, synchronous, and return within the existing MCP tool call pattern. None require a new transport.

| Tool | Mutating? | Purpose |
|---|---|---|
| `bootstrap_graph` | yes | Auto-populate graph from an already-imported STEP solid |
| `add_bend` | yes | Add a `BendNode` between two panels; auto-solves geometry |
| `add_join` | yes | Add a `JoinNode` (FLANGE, TAB_SLOT, RIVET_PATTERN, WELD_PREP) |
| `add_cut` | yes | Add a `CutNode` (hole/slot/profile) to a panel's flat pattern |
| `solve_geometry` | yes | Explicit solve pass — required when batching mutations in a transaction |
| `update_node` | yes | Mutate any field of any node, including rename and structural re-wire |
| `remove_node` | yes | Delete a node; fails if other nodes still reference it |
| `reset_graph` | yes | Clear entire graph for the session (new part workflow) |
| `query_graph` | no | Read all nodes in topological order with all parameters |
| `check_foldability` | no | Non-mutating: returns press-brake accessibility per panel |

---

## Suggested UI Additions

### 1. Manufacturing Graph Panel

A sidebar or inspector panel showing the graph in topological order. Each node row should display:

- **Node ID** (caller-supplied, stable, human-readable — e.g. `"panel-top"`, `"bend-flange-left"`)
- **Node type badge**: Panel / Bend / Join / Cut
- **Dirty indicator** (⚠ stale) — driven by `dirty: boolean` and the top-level `dirty_node_ids` array from `query_graph`
- **Key parameters** inline (thickness, angle, join type, profile type)

The graph can be polled after any mutating action; it is cheap and non-mutating.

> **Why a dirty indicator?** When dirty nodes exist, the returned geometry and flat-pattern values are from the *last successful solve* — not the current parameters. The UI must surface this so users know a re-solve is pending.

### 2. Foldability Status in the Graph Panel

`check_foldability` returns per-panel accessibility: `OPEN`, `CONSTRAINED`, or `INACCESSIBLE`. Show this as a colour indicator on each `PanelNode` row. `INACCESSIBLE` panels should display which bends are locking them (`locking_bend_ids`).

### 3. Bootstrap Entry Point

After a user imports a STEP file (existing flow), offer a **"Build Manufacturing Graph"** action that calls `bootstrap_graph` with the imported `part_id`. This auto-populates all `PanelNode` + `BendNode` entries and returns `foldability_warnings` that should be displayed as advisory notices.

### 4. Cut Profile Editor (New Feature)

`add_cut` accepts profiles in panel-local 2D coordinates. The UI needs a way to author these:

- **CIRCLE**: centre (x, y) + radius
- **RECTANGLE**: origin (x, y) + width + height
- **POLYGON** / **FREEFORM**: ordered vertex list

Coordinates are relative to the panel's flat-pattern origin (bottom-left). The panel bounds are available from `query_graph` (`flatWidth`, `flatHeight` on each `PanelNode`).

A validation pass runs server-side — `CUT_PROFILE_OUT_OF_BOUNDS` and `CUT_OVERLAP` are hard errors; `DRC_CUT_IN_BEND_ZONE` is a **warning** (the operation proceeds — the user gets a notice that the cut crosses a bend zone).

### 5. Updated DXF Preview

The `apply_unfold` response now includes additional top-level fields when a Manufacturing Graph is populated:

```jsonc
{
  // existing fields — unchanged:
  "flat_width_mm": 245.3,
  "flat_height_mm": 80.0,
  "bend_lines": [...],
  "dxf_content": "...",

  // NEW — graph-derived flat-pattern data:
  "graph_flat_width_mm": 245.1,       // from graph BA formula, more accurate than topology inference
  "graph_flat_height_mm": 80.0,
  "graph_bend_zones": [
    { "offset_mm": 100.0, "width_mm": 2.8, "node_id": "bend-left" }
  ],

  // NEW — cut profiles to overlay on the DXF preview:
  "cut_profiles": [
    { "id": "hole-1",    "label": "M6 fastener", "profile": { "type": "CIRCLE",    "centreX": 50, "centreY": 40, "radius": 3 } },
    { "id": "slot-vent", "label": null,           "profile": { "type": "RECTANGLE", "originX": 80, "originY": 20, "width": 30, "height": 8 } }
  ]
}
```

**`graph_flat_width_mm` vs `flat_width_mm`**: prefer `graph_flat_width_mm` when present — it is computed from explicit graph parameters (angle, K-factor, radius) rather than re-inferred from B-Rep topology, so it is more reliable when the source geometry has surface defects.

**`cut_profiles`**: render each as a closed inner wire on the DXF preview canvas — circle, rectangle, or polygon outline. These are cutouts and should be visually distinct from the panel outline (e.g. dashed or a different colour).

**`graph_bend_zones`**: the `offset_mm` and `width_mm` values can be used to draw precise bend-zone shaded bands on the preview, replacing the heuristically-spaced hint lines currently used as fallback.

---

## Identity Model Change — Important

| Old model | New model |
|---|---|
| Geometry body UUID (`"body-abc-123"`) was the persistent identifier | **Node ID** (`"panel-top"`) is the stable identity |
| Body UUID was re-used across solves if the solid wasn't changed | Body UUID **changes** after any Geometry Solve that regenerates the node |
| UI stored body UUIDs as references in state | UI must store **node IDs**; retrieve current body UUID via `query_graph` when needed |

If the UI passes a stale body UUID to any geometry tool it will receive `BODY_NOT_FOUND`. The fix is to call `query_graph`, look up the node by node ID, and read its current `bodyId` field.

---

## Error Codes to Handle

These are new codes the UI may receive from graph tools:

| Code | How to surface it |
|---|---|
| `DRC_BEND_RADIUS_VIOLATION` | Inline error on the bend angle/radius input |
| `DRC_FLANGE_WIDTH_VIOLATION` | Inline error on the flange dimension input |
| `DRC_FOLDABILITY_VIOLATION` | Modal or toast: "This bend cannot be reached by a press brake in the current assembly sequence" |
| `DRC_FOLDABILITY_UNCERTAIN` | Advisory warning: "Accessibility could not be determined — verify manually" |
| `CUT_PROFILE_OUT_OF_BOUNDS` | Inline error on the cut profile editor |
| `CUT_OVERLAP` | Inline error: "Profile overlaps an existing cut" |
| `DRC_CUT_IN_BEND_ZONE` | Advisory warning (not blocking): "Cut crosses a bend zone — verify structural integrity" |
| `GEOMETRY_STALE` | Status indicator on affected node rows: values shown are from last solve |
| `NODE_ID_ALREADY_EXISTS` | Inline error on the node ID input field |
| `REMOVE_WOULD_ORPHAN_NODES` | Error dialog listing which nodes still reference the one being removed |
| `JOIN_EDGE_ALREADY_BOUND` | Inline error: "An edge connection already exists here" |
| `GRAPH_INTEGRITY_ERROR` | Hard error: requires user to reset or rollback |

---

## What Does Not Change

- Existing tools (`clean_geometry`, `split_body_by_bends`, `evaluate_manufacturability`, `apply_unfold`, etc.) are **unchanged** in their input signatures.
- The transaction primitive (`begin_transaction` / `commit_transaction` / `rollback_transaction`) is already in place — no changes needed there.
- STEP/BREP file handling is unchanged.
- The single-session constraint is unchanged.

---

## Suggested Integration Order

| Priority | Work item |
|---|---|
| **P1** | Wire `bootstrap_graph` into the STEP import flow; display `query_graph` output in a sidebar panel |
| **P1** | Consume `graph_flat_width_mm`, `graph_bend_zones`, and `cut_profiles` from `apply_unfold`; render bend-zone bands and cut outlines on the DXF preview |
| **P2** | Build `add_bend`, `add_join`, `add_cut` authoring UI with inline DRC feedback |
| **P2** | Colour-code `PanelNode` rows by foldability accessibility status |
| **P2** | Expose an explicit **Re-solve** button for power users batching mutations inside a transaction |
