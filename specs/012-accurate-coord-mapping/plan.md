# Implementation Plan: Accurate Coordinate Mapping & Graph Mutation Model

**Branch**: `012-accurate-coord-mapping` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-accurate-coord-mapping/spec.md`

---

## Summary

Replace the axis-aligned bounding-box panel frame approximation with OCCT face-geometry frames, model the 2D placement of each panel in the merged flat DXF as a full 2D rigid transform, and change `merge_bodies_with_bend` (and all graph-mutating operations) to append nodes rather than rebuild the graph — enabling correct bidirectional 3D↔2D coordinate mapping across any number of sequential bends.

---

## Technical Context

**Language/Version**: TypeScript 5.x (Manufacturing Domain + MCP Protocol Layer); C++ with OCCT (Geometry Engine — no changes in this feature)

**Primary Dependencies**: node-addon-api (NAPI bridge to C++); vitest (testing); existing `Placement2D` type from `ts/src/manufacturing/dxf/merge.ts` reused as `DxfPlacement2D`

**Storage**: In-memory manufacturing graph (`_parts: Map<string, ManufacturingGraphData>`)

**Testing**: vitest integration tests (`ts/tests/integration/`), unit tests (`ts/tests/unit/`), contract tests (`ts/tests/contracts/`)

**Target Platform**: Node.js (same process as MCP server); C++ addon already built

**Performance Goals**: Coordinate mapping round-trip ≤ 0.1 mm; no regression in existing test suite; no additional C++ build required (NAPI binding already exists)

**Constraints**: `computeDxfAlignedFrame` must not be exported (TypeScript module boundary). `derivePanelFrameFromBbox` must be fully deleted. `GE_PANEL_FRAME_FAILED` is a hard error — no fallback.

**Scale/Scope**: Affects `ts/src/mcp/tools.ts`, `ts/src/manufacturing/graph/types.ts`, `ts/src/geometry/coordinate-map.ts`. No C++ changes. No new files (except test files).

---

## Constitution Check

| Principle | Assessment |
|-----------|------------|
| **I. Deterministic Geometry** | ✅ Replacing bbox approximation with exact OCCT face analysis improves determinism. `computeDxfAlignedFrame` is a pure function for a given shell. |
| **II. Bounded Context Separation** | ✅ `computeDxfAlignedFrame` lives in the Manufacturing Domain (TypeScript) and calls through `getGeometryBinding()` (the `GeometryPort`). The C++ engine has no knowledge of DXF conventions. |
| **IV. Rollback-First** | ✅ Append-mode graph building still takes a C++ snapshot before mutation. Graph rollback now saves/restores the full node set, not just the two root pointers. |
| **VI. Structured Errors** | ✅ New `GE_PANEL_FRAME_FAILED` error code follows the `{code, message, recoverable, suggestedTool}` schema. |
| **X. Graceful Failure Over Silent Fallbacks** | ✅ Primary motivation of this feature. Deleting `derivePanelFrameFromBbox` removes the silent fallback path. Hard errors at graph creation time instead. |

No constitution violations.

---

## Project Structure

### Documentation (this feature)

```text
specs/012-accurate-coord-mapping/
├── plan.md            ← this file
├── spec.md
├── research.md
├── data-model.md
├── contracts/
│   └── mcp-tools.md
├── checklists/
│   └── requirements.md
└── tasks.md           ← /speckit-tasks output (not yet created)
```

### Source Code (affected files)

```text
ts/src/manufacturing/graph/
└── types.ts                        ← add dxfPlacement to PanelNode, bendZoneDxfX to BendNode

ts/src/mcp/
└── tools.ts                        ← delete derivePanelFrameFromBbox; add computeDxfAlignedFrame;
                                      fix all 5 call sites; refactor merge to append-mode

ts/src/geometry/
└── coordinate-map.ts               ← rewrite map3dTo2d / map2dTo3d

ts/tests/
├── unit/
│   └── coordinate-map.unit.test.ts ← extend with dxfPlacement tests
├── integration/
│   ├── merge_orientation_preserved.integration.test.ts   ← extend with Panel B mapping
│   └── coordinate_mapping_multibend.integration.test.ts  ← new: 3-panel chain
└── contracts/
    └── coordinate-map.contract.test.ts  ← update for new error codes
```

---

## Phase 1: Type definitions & delete the fallback

**Goal**: Establish the new data model. All downstream code will fail to compile until Phase 2 fixes call sites — that is the intended forcing function.

### Steps

**P1-A** — Add `dxfPlacement` to `PanelNode` and `bendZoneDxfX` to `BendNode` in `ts/src/manufacturing/graph/types.ts`.

- `dxfPlacement: Placement2D` (import `Placement2D` from `../dxf/merge`; alias as `DxfPlacement2D` in the types comment for clarity, no new type needed).
- `bendZoneDxfX: number` on `BendNode`.
- Mark both as required (not optional) — all creation paths must provide them.

**P1-B** — Delete `derivePanelFrameFromBbox` (tools.ts lines 2034–2076).

This will immediately cause 5 TypeScript compile errors at the call sites, which Phases 2 and 3 resolve.

**P1-C** — Add `GE_PANEL_FRAME_FAILED` to the `ErrorCodes` registry in tools.ts.

---

## Phase 2: computeDxfAlignedFrame + fix graph creation paths

**Goal**: Every PanelNode created by split/bootstrap/unfold has an OCCT-derived frame and an identity `dxfPlacement`.

### Steps

**P2-A** — Write `computeDxfAlignedFrame(shellId: string, isRotated: boolean): PanelFrame` as a module-private function in tools.ts (no `export`).

Logic (see data-model.md for exact computation):
- Call `getGeometryBinding().getPanelFrame(shellId)`.
- If `isRotated=false`: return natural face frame.
- If `isRotated=true`: return rotated frame (`u = face.v`, `v = -face.u`, `origin = face.origin + uExtentMm * face.u`).
- On exception: throw `GE_PANEL_FRAME_FAILED` structured error.

**P2-B** — Fix `handleBootstrapGraph` (tools.ts ~line 1864).

Replace `derivePanelFrameFromBbox(bbox)` with `computeDxfAlignedFrame(shellId, false)` (bootstrap panels are not yet merged, so `isRotated=false`). Populate `dxfPlacement: { rotationMatrix: [[1,0],[0,1]], translation: [0,0] }` on each created PanelNode.

**P2-C** — Fix `handleSplitBodyByBends` (tools.ts ~line 5014).

Replace `derivePanelFrameFromBbox(bbox)` with `computeDxfAlignedFrame(panelId, false)`. Split panels have never been rotated, so `isRotated=false`. Populate `dxfPlacement` as identity. Remove the bbox-derived fallback block entirely.

**P2-D** — Fix `handleApplyUnfold` — panel node (tools.ts ~line 5014) and protrusion node (tools.ts ~line 5114).

Both use `derivePanelFrameFromBbox` as fallback. Replace with `computeDxfAlignedFrame`. If the shell has no planar face, propagate `GE_PANEL_FRAME_FAILED` rather than continuing with a bbox estimate.

**P2-E** — Fix the inline bbox fallback in the merge handler (tools.ts ~line 3544).

This call to `derivePanelFrameFromBbox` occurs when the merge handler re-derives the frame after a C++ shell update. Replace with `computeDxfAlignedFrame(shellId, foldAlongU_A)` — using the already-computed `foldAlongU_A` boolean.

**P2-F** — Fix the inline bbox fallback in the unfold path (tools.ts ~line 3754).

Replace with `computeDxfAlignedFrame(shellId, false)` (unfold panels are not rotated).

**P2-G** — Verify: `npm run build` in `ts/` produces zero errors. Run existing split tests to confirm no regressions.

---

## Phase 3: Append-mode merge

**Goal**: `merge_bodies_with_bend` extends the existing graph rather than rebuilding it. `dxfPlacement` and `bendZoneDxfX` are correctly populated for all new nodes.

### Steps

**P3-A** — Refactor graph construction in `handleMergeBodiesWithBend` (tools.ts ~lines 3912–3998).

Current code:
```
_parts.delete(partAId); _parts.delete(partBId);
createPart(partAId);   // fresh graph
addNode(panelNodeA);   // non-canonical copy of Panel A
addNode(panelNodeB);   // canonical merged
addNode(alias);
addNode(bendNode);
```

New code (append-mode):
1. If `_parts.has(partAId)` and the existing graph already has BendNodes (i.e. Panel A is itself a merged assembly): reuse the existing graph. Do NOT call `createPart`.
2. Mark the current canonical PanelNode(s) in the existing graph as `canonical=false`.
3. Add the new BendNode with `bendZoneDxfX = currentMergedFlatWidth`.
4. Add the new PanelNode B with:
   - `canonical=true`
   - `dxfPlacement = { rotationMatrix: [[1,0],[0,1]], translation: [currentMergedFlatWidth + ba, 0] }`
   - `panelFrame = computeDxfAlignedFrame(shellBId, foldAlongU_B)`
5. Add the alias node for `partBId` lookup (same `dxfPlacement` as Panel B).
6. Register `partBId → same graph` in `_parts`.

`currentMergedFlatWidth` = `preflightMerge.metrics.bbox.width` (total width of the new merged DXF).

**P3-B** — For the FIRST merge of a pristine split (Panel A has no existing BendNodes), the existing Panel A PanelNode should receive its `dxfPlacement = identity` at this point if it was not set by split (backwards compatibility for panels created before this feature).

**P3-C** — Rollback path: save the full set of existing node IDs from `partAId`'s graph before mutation. On C++ failure, restore all nodes to their prior state.

**P3-D** — Verify: existing `merge_orientation_preserved` integration test still passes. Run `merge_edge_alignment` test.

---

## Phase 4: Rewrite coordinate mapping

**Goal**: `map3dTo2d` and `map2dTo3d` use `dxfPlacement` + accurate `panelFrame` with full panel traversal.

### Steps

**P4-A** — Rewrite `map3dTo2d` in `ts/src/geometry/coordinate-map.ts`.

```typescript
for (const node of graph.nodes.values()) {
  if (node.type !== 'PanelNode' || !node.panelFrame || !node.dxfPlacement) continue;
  const { u_local, v_local, height } = projectOntoPanel(point3d, node.panelFrame);
  if (Math.abs(height) < COORD_MAP_ACCURACY_THRESHOLD_MM
      && u_local >= 0 && u_local <= (node.flatWidth ?? Infinity)
      && v_local >= 0 && v_local <= (node.flatHeight ?? Infinity)) {
    const [mx, my] = applyPlacement([[u_local, v_local]], node.dxfPlacement)[0];
    return { panelId: node.id, xy: [mx, my], errorMm: Math.abs(height) };
  }
}
// GE_POINT_NOT_ON_PANEL with nearest
```

Note: `applyPlacement` from `merge.ts` applies `rotationMatrix * [x,y] + translation`.

**P4-B** — Rewrite `map2dTo3d` in `ts/src/geometry/coordinate-map.ts`.

```typescript
for (const node of graph.nodes.values()) {
  if (node.type !== 'PanelNode' || !node.panelFrame || !node.dxfPlacement) continue;
  const R_inv = transpose2x2(node.dxfPlacement.rotationMatrix);
  const [lx, ly] = matMul2x2Vec(R_inv,
    [point2d[0] - node.dxfPlacement.translation[0],
     point2d[1] - node.dxfPlacement.translation[1]]);
  if (lx >= 0 && lx <= (node.flatWidth ?? Infinity)
      && ly >= 0 && ly <= (node.flatHeight ?? Infinity)) {
    return { point3d: unprojectFromPanel(lx, ly, node.panelFrame), errorMm: 0 };
  }
}
```

Add helpers `transpose2x2` and `matMul2x2Vec` as module-private pure functions.

**P4-C** — Remove the `canonical === false` filter from both functions (currently only canonical nodes are iterated — see coordinate-map.ts line 159).

**P4-D** — Update the `map_2d_to_3d` handler in tools.ts to make `panel_id` optional (see contracts/mcp-tools.md).

---

## Phase 5: Tests & verification

**P5-A** — Extend `ts/tests/unit/coordinate-map.unit.test.ts`:
- Test that `map3dTo2d` returns the correct master flat coordinate for a point on Panel B of a two-panel assembly (not just Panel A).
- Test that `map2dTo3d` correctly inverts `dxfPlacement` for a non-identity rotation matrix.
- Test that a 3-panel chain round-trips within 0.1 mm for all three regions.

**P5-B** — New integration test `ts/tests/integration/coordinate_mapping_multibend.integration.test.ts`:
- Split `angle_bracket_45deg.stp` → Panel A + Panel B; merge → assembly AB.
- Call `map_3d_to_2d` with a known corner of Panel B; verify `xy` is in Panel B's DXF region (`x > effectiveAFlatWidth + ba`).
- Call `map_2d_to_3d` with that DXF coordinate; verify 3D round-trip ≤ 0.1 mm.

**P5-C** — Update `ts/tests/contracts/coordinate-map.contract.test.ts` to verify `GE_PANEL_FRAME_FAILED` is in the error code registry.

**P5-D** — Static verification: `grep -r "derivePanelFrameFromBbox" ts/src/` must return zero results.

**P5-E** — Full test suite: `cd ts && npm test`. Target: all currently-passing tests still pass. The 18 pre-existing failures (pre-dating this feature) are unchanged.

---

## Complexity Tracking

No constitution violations to justify.
