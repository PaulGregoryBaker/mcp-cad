# Research: Graph-Driven Object Mutations

**Spec**: specs/010-graph-driven-mutations/spec.md | **Date**: 2026-06-06

---

## R-010-001: OCCT Re-Fold Strategy for `buildShellFromFlatPattern`

**Question**: What OCCT API should implement `buildShellFromFlatPattern(dxf, bendZones, thickness)`?

**Decision**: Reuse the existing `buildSheetFromDxf` + `thickenSheet` + `applyBend` sequence rather than introducing a new OCCT surface-swept primitive. For a flat pattern with one bend zone at offset X (width = BA):

1. Split the DXF at the bend zone boundaries — strip the BA strip, yielding two sub-outline DXFs:
   - Sub-panel A: x ∈ [0, X]
   - Sub-panel B: x ∈ [X + BA, flatWidth]
2. Build sub-panel A solid: `buildSheetFromDxf(subDxfA)` → `thickenSheet(idA, t)`
3. Build sub-panel B solid: `buildSheetFromDxf(subDxfB)` → `thickenSheet(idB, t)`
4. Fold: `applyBend(idA, idB, radius, angle, kFactor)` → merged 3D shell

For zero bend zones (flat panel): call `buildSheetFromDxf(dxf)` → `thickenSheet(id, t)` directly.

**Rationale**: `applyBend` is already implemented and tested in `geometry_service.cc`. This path avoids new OCCT surface topology work (e.g., `BRepOffsetAPI_MakePipeShell`), minimising C++ risk. The split-and-fold approach maps directly to physical sheet-metal semantics.

**Round-trip contract (SC-003)**: `unfoldShell(buildShellFromFlatPattern(dxf, [bend], t))` must return a DXF outline matching the input within ±1mm bounding-box. Testable with existing `unfoldShell` + `exportDxf` methods.

**Alternatives considered**:
- `BRepOffsetAPI_MakePipeShell` (spine sweep): More OCCT-idiomatic for general bending but requires implementing the reverse mapping (flat → 3D) without existing test coverage. High risk for V1.
- Direct B-Rep construction (manual vertices/edges/faces): Maximum control; unacceptable maintenance cost.

---

## R-010-002: DXF Disjoint Detection for `fuse_bodies` (FR-002c)

**Question**: How to detect a disjoint DXF union before calling C++?

**Decision**: Add a `checkDxfUnionConnectivity(dxfA, dxfB, placement): { disjoint: boolean }` function in `ts/src/manufacturing/dxf/merge.ts`. The existing `mergeDxfOutlines` already detects the disjoint case at line 239 (`union.length > 1`) and silently falls back to a bounding-box merge. This silent fallback violates constitution §X and must be replaced with:

1. In `fuse_bodies` pre-flight: call `checkDxfUnionConnectivity` (uses `polygon-clipping.union()`, same as `mergeDxfOutlines`)
2. If `disjoint: true` → return `GE_FUSE_DISJOINT_RESULT` before any graph or geometry mutation
3. If `disjoint: false` → proceed with `mergeDxfOutlines` (which can now assume a connected union)

**Why polygon-clipping detects disjoint correctly**: `polygon-clipping.union()` returns multiple polygon rings only when the inputs have no shared area or shared edges. If panels are touching at exactly one edge (zero-width contact), it still returns two polygons — but manufacturing semantics require overlap or shared edge area for a valid fuse. The `disjoint` flag covers both no-contact and edge-only-contact cases.

**Alternatives considered**:
- C++ connectivity check after boolean union: Requires calling C++ first, violating FR-002c.
- Centroid-distance heuristic (e.g., `|centroid_A - centroid_B| < threshold`): Less precise; does not detect the edge-only-contact case correctly.

---

## R-010-003: Coplanarity and Thickness Pre-Flight for `fuse_bodies` (FR-002a, FR-002b)

**Question**: Where and how to enforce thickness and coplanarity checks?

**Decision**: Pure TypeScript in `handleFuseBodies`, before any graph or C++ mutation:

### Thickness check (FR-002a)
```typescript
const FUSE_THICKNESS_TOLERANCE_MM = 0.1;
if (Math.abs(panelA.nominalThickness - panelB.nominalThickness) > FUSE_THICKNESS_TOLERANCE_MM) {
  throwError('GE_FUSE_THICKNESS_MISMATCH', ...);
}
```
All required data is in `PanelNode.nominalThickness` — no C++ call needed.

### Coplanarity check (FR-002b)
```typescript
const FUSE_COPLANARITY_THRESHOLD_DEG = 2;
// Compute normals from panelFrame.u × panelFrame.v
// If |dot(nA, nB)| < cos(2°) ≈ 0.9994 → not coplanar
```
Requires `panelFrame` to be populated. If `panelFrame` is null, derive it via `computeBoundingBox` (same pattern as `ensurePanelFrame` in `handleMergeBodiesWithBend`).

**Rationale**: All required data lives in the manufacturing graph (`nominalThickness`, `panelFrame`). These checks are pure arithmetic — no geometry kernel involved. Performing them first satisfies FR-002a/b's "before any graph or geometry mutation" requirement.

---

## R-010-004: Graph Enforcement for Raw Mutations (FR-005)

**Question**: What constitutes a "raw mutation" that must be guarded?

**Decision**: Any MCP tool that accepts body UUIDs directly (not via `part_id` that resolves through graph-first logic) is a raw mutation path. The primary tools to guard:

- `cut_bodies` — accepts `blank: string` and `tools: string[]` as raw body IDs
- `fuse_bodies` — the no-graph fallback path (already exists; must continue to work for untracked parts per FR-005 scenario 2)

**Enforcement helper**:
```typescript
function findGraphOwner(bodyId: string): string | null {
  for (const [partId, graph] of _parts) {
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode' && node.bodyId === bodyId) {
        return partId;
      }
    }
  }
  return null;
}
```

Guard in `handleCutBodies` and `handleFuseBodies` no-graph path: if `findGraphOwner(bodyId) !== null`, throw `GRAPH_INTEGRITY_ERROR`.

**Important caveat**: `merge_bodies_with_bend` and `fuse_bodies` ARE the graph-coordinated paths — they must NOT self-reject. The guard applies only to tools that receive raw UUIDs without performing a corresponding graph operation first.

**Alternatives considered**:
- C++-layer enforcement: Would require NAPI round-trips for every body lookup; the TypeScript layer already has the complete graph state, making a TS-layer check both cheaper and simpler.

---

## R-010-005: CutNode Preservation Through Merge (FR-006)

**Question**: How to translate CutNode profiles from individual panel coordinates to the merged flat pattern coordinate system?

**Decision**: During `handleMergeBodiesWithBend`, after computing the DXF merge `placement` (rotation + translation), collect all `CutNode` entries from both graphs and apply the 2D affine transform to each profile's coordinates. Create corresponding `CutNode` entries in the merged graph.

The existing `applyPlacement(ring, placement)` function in `merge.ts` handles 2D affine transformation. Profile coordinate transforms:

| Profile type | Fields to transform |
|---|---|
| `CIRCLE` | `(centreX, centreY)` via placement |
| `RECTANGLE` | `(originX, originY)` via placement (width/height unchanged) |
| `POLYGON` / `FREEFORM` | All `vertices` via placement |

Panel A's `CutNode`s use identity placement (no transform). Panel B's `CutNode`s use the computed `(rotationMatrix, translation)`.

**Fuse case**: Two coplanar panels — the relative 2D offset between their DXF origins determines the translation applied to Panel B's cut profiles.

**Interaction with `buildShellFromFlatPattern`**: The merged DXF written to the canonical `PanelNode.shapeDxf` does NOT include cut outlines — it is the panel outline only. `CutNode`s remain separate graph nodes; the solver applies them as boolean cuts after the flat-pattern solid is built (existing `APPLY_CUT` step in solver). The merged flat pattern must therefore be the panel outline only, and the translated `CutNode`s must be re-added to the merged graph's dirty node set.
