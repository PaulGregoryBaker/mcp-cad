# Research: Accurate Coordinate Mapping & Graph Mutation Model

**Feature**: 012-accurate-coord-mapping
**Date**: 2026-06-11

---

## Decision 1: Panel frame derivation source

**Decision**: Use the existing `getPanelFrame` NAPI binding exclusively. Delete `derivePanelFrameFromBbox` with no replacement.

**Rationale**: `getPanelFrame` is already implemented in C++ (geometry_service.cc ~line 2600), exposed via NAPI (geometry_binding.cc line 468), and called from TypeScript in the `split_body_by_bends` handler (tools.ts line 4991). It returns the face UV-min corner as `origin`, the longer in-plane axis as `u`, and the shorter as `v` — derived from OCCT's largest planar face analysis, not world-axis measurements. `derivePanelFrameFromBbox` is a pure-TypeScript function at tools.ts:2034 with five call sites (lines 1864, 3544, 3754, 5014, 5114) — all must be removed.

**Alternatives considered**: Keeping `derivePanelFrameFromBbox` as a fallback for shells with no planar face — rejected because it violates Constitution §X (silent fallback masks errors) and the user's explicit requirement.

---

## Decision 2: DXF-aligned frame vs. natural face frame

**Decision**: Define `computeDxfAlignedFrame(shellId, isRotated: boolean): PanelFrame` that returns the frame with axes oriented to match the final DXF coordinate system — accounting for the 90° rotation applied by `rotateDxf90`.

**Rationale**: The existing `getPanelFrame` returns `u` = longer axis, `v` = shorter. After `normalizePanelDxfOrientation`, DXF X = longer = `u`. But when `rotateDxf90` is applied (when `foldAlongU=true`), DXF X becomes `v` (shorter = fold-perp) and DXF Y becomes `-u` (negative of longer = -fold-parallel). The stored `panelFrame` must always describe where DXF (0,0) is in 3D and which 3D directions DXF +X and +Y point to. If `isRotated=false`, the natural frame is returned unchanged. If `isRotated=true`:
- `new_u` = `face.v` (fold-perp → DXF +X)
- `new_v` = `-face.u` (negative fold-parallel → DXF +Y)
- `new_origin` = `face.origin + face.uExtentMm * face.u` (the corner that lands at DXF (0,0) after rotation and re-normalisation to (0,0))

**Alternatives considered**: Storing the natural face frame and encoding the rotation separately in `dxfPlacement` — possible, but splits the physical meaning across two fields. DXF-aligned frame is cleaner because `map3dTo2d` can project directly without needing to un-rotate.

---

## Decision 3: DxfPlacement2D type

**Decision**: Reuse the existing `Placement2D` type from `ts/src/manufacturing/dxf/merge.ts` as `DxfPlacement2D`. No new type is required.

**Rationale**: `Placement2D = { rotationMatrix: [[n,n],[n,n]], translation: [n,n] }` is exactly the right structure. Because `panelFrame` is already DXF-aligned (Decision 2), `dxfPlacement` in practice will have an identity rotation matrix for all standard merge cases — its role is to record the XY translation of the panel in the master merged flat. The rotation component is available for future non-planar-strip layouts.

**Alternatives considered**: A scalar `dxfOffset: number` — rejected because it cannot represent a panel that is rotated within the merged flat DXF.

---

## Decision 4: Append-mode graph building

**Decision**: When `merge_bodies_with_bend` is called on a part that already has a multi-node manufacturing graph (i.e., Panel A is itself the product of a prior merge), extend that graph by adding the new BendNode and Panel B node — do not delete and recreate the graph.

**Rationale**: Currently, `merge_bodies_with_bend` calls `_parts.delete(partAId)`, `_parts.delete(partBId)`, then `createPart(partAId)` — discarding all prior PanelNode/BendNode history. For a three-panel chain (A→B→C), the second merge loses Panel A and Panel B as distinct nodes, making it impossible to perform region-based coordinate mapping. Append-mode preserves all nodes: each retains its `dxfPlacement` (which points to an immutable region of the master flat — that region does not shift when new panels are appended to the right).

**Rollback note**: Append-mode must still satisfy Constitution §IV (Rollback-First). The C++ snapshot is taken before any C++ call. Graph rollback now requires saving and restoring the full node set, not just the two prior root nodes.

**Alternatives considered**: Post-hoc graph reconstruction (walk the C++ shape history to infer all panels) — rejected as fragile and unverifiable.

---

## Decision 5: Region bounds checking for map_2d_to_3d

**Decision**: Each panel's region in the master flat is defined by its bounding box in `dxfPlacement`-transformed local DXF coordinates: `[0..flatWidth] × [0..flatHeight]`. For `map_2d_to_3d`, invert `dxfPlacement` for each PanelNode and check if the resulting panel-local coordinate falls in `[0..flatWidth] × [0..flatHeight]`.

**Rationale**: This correctly handles panels at arbitrary positions and rotations in the merged flat. For the standard axis-aligned case, inversion is trivial (negate translation). For rotated panels, the 2×2 rotation matrix inverse is its transpose (orthogonal matrix).

**Bend-zone handling**: Coordinates in the bend zone (gap between panels) are assigned to the upstream panel (lower X boundary). This matches the downstream bend-zone DRC check and is deterministic.

---

## Existing infrastructure confirmed available

| Component | Location | Status |
|-----------|----------|--------|
| `getPanelFrame` C++ function | geometry_service.cc ~line 2600 | ✅ exists |
| `GetPanelFrame` NAPI binding | geometry_binding.cc line 468 | ✅ exists |
| `getPanelFrame` TypeScript binding | binding.ts line 477 | ✅ exists |
| `Placement2D` type | merge.ts lines 6–9 | ✅ exists, reuse as `DxfPlacement2D` |
| `applyPlacement` function | merge.ts line 155 | ✅ exists, reuse for dxfPlacement application |
| `computeDxfMergePlacement` | orientation.ts line 91 | ✅ exists, used by fuse path |
| `PanelFrameResult` interface | types.ts lines 157–163 | ✅ exists |

## Call sites to eliminate

| Function | Call site | Replacement |
|----------|-----------|-------------|
| `derivePanelFrameFromBbox` | tools.ts:1864 | `computeDxfAlignedFrame` |
| `derivePanelFrameFromBbox` | tools.ts:3544 | remove (merge re-derives from shell geometry) |
| `derivePanelFrameFromBbox` | tools.ts:3754 | `computeDxfAlignedFrame` |
| `derivePanelFrameFromBbox` | tools.ts:5014 | `computeDxfAlignedFrame` |
| `derivePanelFrameFromBbox` | tools.ts:5114 | `computeDxfAlignedFrame` |
