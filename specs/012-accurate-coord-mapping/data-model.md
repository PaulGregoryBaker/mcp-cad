# Data Model: Accurate Coordinate Mapping & Graph Mutation Model

**Feature**: 012-accurate-coord-mapping
**Date**: 2026-06-11

---

## Type: DxfPlacement2D

Reuses the existing `Placement2D` type from `ts/src/manufacturing/dxf/merge.ts`. No new type definition required.

```
DxfPlacement2D = {
  rotationMatrix: [[a, b], [c, d]]   // 2×2 rotation matrix (orthogonal)
  translation:    [tx, ty]            // translation in mm
}
```

Maps a point `(x, y)` in panel-local DXF coordinates to master merged flat coordinates via:
```
[master_x, master_y] = rotationMatrix * [x, y] + [tx, ty]
```

Identity (root panel, no merge): `{ rotationMatrix: [[1,0],[0,1]], translation: [0,0] }`.

Inverse: `[x, y] = rotationMatrix_transposed * ([master_x, master_y] - [tx, ty])` (since rotation matrices are orthogonal, their inverse = transpose).

---

## Updated: PanelNode

Added fields (to `ts/src/manufacturing/graph/types.ts`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dxfPlacement` | `DxfPlacement2D` | Yes (after this feature) | 2D rigid transform from panel-local DXF coords to master merged flat coords. Identity for root panels. |

Existing field change — `panelFrame`:

| Field | Old constraint | New constraint |
|-------|---------------|----------------|
| `panelFrame` | Optional, may be bbox-derived | Required in all graph-creation paths; always OCCT-derived via `computeDxfAlignedFrame`; never bbox-derived |

**Invariant**: `panelFrame.u` corresponds to DXF +X direction in 3D; `panelFrame.v` corresponds to DXF +Y direction in 3D; `panelFrame.origin` is the 3D world point at panel-local DXF (0, 0). These axes already incorporate any `rotateDxf90` normalization applied during DXF creation.

---

## Updated: BendNode

Added field (to `ts/src/manufacturing/graph/types.ts`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bendZoneDxfX` | `number` | Yes (after this feature) | X coordinate (mm) in the master merged flat DXF where this bend zone begins. Equals the upstream panel's DXF X-max. Used for DRC cut-in-bend-zone checks. |

---

## Deleted: derivePanelFrameFromBbox

This function (`ts/src/mcp/tools.ts` lines 2034–2076) is deleted in its entirety. All five call sites are replaced or removed as specified in research.md.

---

## New (unexported): computeDxfAlignedFrame

**Location**: `ts/src/mcp/tools.ts` (module-private, not exported)

**Signature**:
```typescript
function computeDxfAlignedFrame(shellId: string, isRotated: boolean): PanelFrame
```

**Behaviour**:
1. Calls `getGeometryBinding().getPanelFrame(shellId)` to obtain the OCCT face axes.
2. If `isRotated = false`: returns `{ origin: [pf.originX, pf.originY, pf.originZ], u: [pf.uX, pf.uY, pf.uZ], v: [pf.vX, pf.vY, pf.vZ] }`.
3. If `isRotated = true` (the DXF was rotated 90° CCW by `rotateDxf90` before being placed):
   - `new_u` = `[pf.vX, pf.vY, pf.vZ]` — face V (fold-perp) → DXF +X
   - `new_v` = `[-pf.uX, -pf.uY, -pf.uZ]` — negative face U (fold-parallel) → DXF +Y
   - `new_origin` = `[pf.originX + pf.uExtentMm * pf.uX, pf.originY + pf.uExtentMm * pf.uY, pf.originZ + pf.uExtentMm * pf.uZ]` — corner that lands at DXF (0,0) after rotation
   - Returns `{ origin: new_origin, u: new_u, v: new_v }`.
4. Throws `GE_PANEL_FRAME_FAILED` structured error if `getPanelFrame` throws.

**Access control**: The function must not be exported. It is called only from:
- `handleSplitBodyByBends` (for each split panel)
- `handleBootstrapGraph` (for each registered shell)
- `handleApplyUnfold` (for panel and protrusion nodes)

---

## Coordinate mapping: full chain

### map_3d_to_2d

For each `PanelNode` in the graph (all nodes, not just canonical):

```
d = point3d − panelFrame.origin
u_local = dot(d, panelFrame.u)
v_local = dot(d, panelFrame.v)
height  = dot(d, cross(panelFrame.u, panelFrame.v))

if |height| ≤ 0.1 mm AND 0 ≤ u_local ≤ flatWidth AND 0 ≤ v_local ≤ flatHeight:
    [mx, my] = dxfPlacement.rotationMatrix * [u_local, v_local] + dxfPlacement.translation
    return { panelId, xy: [mx, my], errorMm: |height| }
```

Return `GE_POINT_NOT_ON_PANEL` (with nearest panel) if no panel matches.

### map_2d_to_3d

For each `PanelNode` in the graph:

```
R_inv = transpose(dxfPlacement.rotationMatrix)   // orthogonal → inverse = transpose
local = R_inv * (master_xy − dxfPlacement.translation)
u_local = local[0], v_local = local[1]

if 0 ≤ u_local ≤ flatWidth AND 0 ≤ v_local ≤ flatHeight:
    point3d = panelFrame.origin + u_local * panelFrame.u + v_local * panelFrame.v
    return { point3d, errorMm: 0 }
```

Return `GE_POINT_NOT_ON_PANEL` if no panel's region contains the point (should not occur for valid DXF coordinates).

---

## Graph structure: three-panel chain after append-mode merge

After split + two sequential merges (A→B→C):

```
Graph keyed under partAId (and aliases partBId, partCId):

PanelNode A   id=panel-a-{aId}   canonical=false  dxfPlacement={I, [0,0]}       bodyId=null
BendNode 1    id=bend-{aId}      panelAId=A  panelBId=B  bendZoneDxfX=wA
PanelNode B   id={aId}           canonical=false  dxfPlacement={I, [wA+ba1,0]}  bodyId=null
BendNode 2    id=bend-{bId}      panelAId=B  panelBId=C  bendZoneDxfX=wA+ba1+wB
PanelNode C   id={bId}           canonical=true   dxfPlacement={I, [wA+ba1+wB+ba2,0]}  bodyId=mergedShellId  shapeDxf=full_merged_DXF

PanelNode C_alias  id={cId}  canonical=true  (same dxfPlacement as C, alias for lookup)
```

All nodes retained; only the canonical flag migrates to the newest downstream panel.
