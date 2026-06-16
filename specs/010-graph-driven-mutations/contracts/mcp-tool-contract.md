# MCP Tool Contract Changes

**Feature**: 010-graph-driven-mutations | **Updated**: 2026-06-06

---

## `fuse_bodies` — New Pre-Flight Error Codes

Input schema unchanged. The following structured errors are now returned **before** any graph or geometry mutation.

### `GE_FUSE_THICKNESS_MISMATCH`

Triggered when: `|panelA.nominalThickness − panelB.nominalThickness| > 0.1mm`

```json
{
  "code": "GE_FUSE_THICKNESS_MISMATCH",
  "message": "Cannot fuse panels with different nominal thicknesses (1.5mm vs 2.0mm). Thickness must match within 0.1mm for a valid coplanar fuse.",
  "recoverable": false,
  "suggested_tool": null
}
```

### `GE_FUSE_NOT_COPLANAR`

Triggered when: panel face normals differ by more than `FUSE_COPLANARITY_THRESHOLD_DEG` (2°)

```json
{
  "code": "GE_FUSE_NOT_COPLANAR",
  "message": "Cannot fuse panels whose face normals differ by more than 2°. These panels are at a bend angle — use merge_bodies_with_bend instead.",
  "recoverable": false,
  "suggested_tool": "merge_bodies_with_bend"
}
```

### `GE_FUSE_DISJOINT_RESULT`

Triggered when: the 2D DXF union of both panel outlines produces disconnected regions

```json
{
  "code": "GE_FUSE_DISJOINT_RESULT",
  "message": "Cannot fuse panels whose outlines do not touch or overlap. The resulting flat pattern would be disconnected.",
  "recoverable": false,
  "suggested_tool": null
}
```

---

## `merge_bodies_with_bend` — Execution Order Change (No Schema Change)

Input and output schemas are **unchanged**. Internal execution order changes:

| Step | Before (current) | After (this spec) |
|------|-----------------|-------------------|
| 1 | DXF merge (preflight only — not written to graph) | DXF merge → written to merged PanelNode.shapeDxf |
| 2 | **C++ `mergeBodiesWithBend` (boolean union)** | **Graph update: BendNode + canonical PanelNode created** |
| 3 | Graph update (BendNode + PanelNode post-C++) | **C++ `buildShellFromFlatPattern(mergedDxf, bendZones, t)`** |
| 4 | — | PanelNode.bodyId updated with returned shellId |

**Observable behaviour change (FR-008)**: `apply_unfold` after a merge now uses `PanelNode.shapeDxf` set during graph update (step 1), not re-derived from C++ geometry. The DXF is the single source of truth.

---

## `GRAPH_INTEGRITY_ERROR` — New Context: Raw Mutation Guard (FR-005)

Existing error code, new trigger context. Tools that receive raw body UUIDs without graph coordination now return this error if the UUID belongs to a graph-tracked panel.

```json
{
  "code": "GRAPH_INTEGRITY_ERROR",
  "message": "Shell UUID 'uuid-A' belongs to manufacturing-graph-tracked part 'part-A'. Use merge_bodies_with_bend or fuse_bodies (graph-coordinated paths) to mutate graph-tracked parts.",
  "recoverable": true,
  "suggested_tool": "merge_bodies_with_bend"
}
```

**Tools where this guard is added**:
- `cut_bodies` — guards `blank` and `tools` body IDs

**Tools exempt from this guard** (they ARE the graph-coordinated paths):
- `merge_bodies_with_bend`
- `fuse_bodies`

**Backward compatibility (FR-005 scenario 2)**: If a body UUID is NOT in any graph, the raw mutation proceeds normally. The guard is only triggered for graph-tracked bodies.

---

## No-Change Tools

The following tools are unaffected by this spec:

- `apply_unfold` — reads `PanelNode.shapeDxf` unchanged; benefits transparently from FR-008
- `solve_geometry` — solver path (`buildSheetFromDxf` + `thickenSheet`) already correct
- `split_body_by_bends` — no change; still populates initial `PanelNode.shapeDxf`
- `close_gap` — not a graph mutation; no change
