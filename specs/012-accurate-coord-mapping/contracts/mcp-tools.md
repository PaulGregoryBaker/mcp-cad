# MCP Tool Contracts: Coordinate Mapping

**Feature**: 012-accurate-coord-mapping

These contracts describe the observable input/output behaviour of the two coordinate mapping MCP tools. Internal implementation details (graph traversal, frame computation) are out of scope here.

---

## map_3d_to_2d

**Input schema** (unchanged):
```json
{
  "part_id": "string",
  "point":   [number, number, number]
}
```

**Success response** (unchanged shape, semantics updated):
```json
{
  "panel_id": "string",   // NodeId of the PanelNode whose surface the point lies on
  "xy":       [number, number],  // Master merged flat DXF coordinate (mm)
  "error_mm": number             // |height| above panel surface (≤ 0.1 mm on success)
}
```

**Behaviour change**: Previously only canonical PanelNodes were searched. Now ALL PanelNodes in the graph are searched. The returned `xy` is now a coordinate in the master merged flat (incorporating the panel's `dxfPlacement`), not a panel-local coordinate.

**Error responses** (unchanged codes):
```json
{ "code": "GE_POINT_NOT_ON_PANEL", "nearestPanelId": "...", "distanceMm": number }
{ "code": "GE_NO_MANUFACTURING_GRAPH" }
{ "code": "GE_PANEL_NO_FRAME" }
```

---

## map_2d_to_3d

**Input schema** (unchanged):
```json
{
  "part_id":  "string",
  "panel_id": "string",   // now optional — if omitted, region lookup is used
  "point":    [number, number]
}
```

**Success response** (unchanged):
```json
{
  "point3d":  [number, number, number],
  "error_mm": 0
}
```

**Behaviour change**: When `panel_id` is omitted, the correct panel is located by finding the PanelNode whose `dxfPlacement`-transformed region contains the query point. When `panel_id` is provided, only that panel is used.

---

## split_body_by_bends — new field in response

The existing response gains a new panel-level field (per panel in `panel_ids`):
```json
{
  "panel_frame_source": "occt_face" | "failed"
}
```
`"occt_face"` = frame derived from actual geometry (all success cases).
`"failed"` = panel creation failed; this panel is not returned.

The bbox fallback (`"bbox_estimate"`) is no longer a valid value.

---

## Error code: GE_PANEL_FRAME_FAILED (new structured error)

Returned when `computeDxfAlignedFrame` cannot find a planar face on the shell.

```json
{
  "code":          "GE_PANEL_FRAME_FAILED",
  "message":       "Shell {shellId} has no planar faces; cannot derive panel frame.",
  "recoverable":   false,
  "suggestedTool": "clean_geometry"
}
```

This error is thrown at graph creation time (split, bootstrap, unfold) and propagated as a structured MCP error. No silent fallback.
