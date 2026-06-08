# Data Model: Graph-Driven Object Mutations

**Spec**: specs/010-graph-driven-mutations/spec.md | **Date**: 2026-06-06

---

## Modified Types

### `BendZone` — `ts/src/manufacturing/graph/types.ts`

Add `radius`, `kFactor`, and `angle` fields so `buildShellFromFlatPattern` has full bend geometry:

```typescript
// BEFORE
export interface BendZone {
  offset: number;   // mm from panel A's near edge
  width: number;    // BA in mm
  nodeId: NodeId;
}

// AFTER
export interface BendZone {
  offset: number;   // mm from panel A's near edge (unchanged)
  width: number;    // BA in mm (unchanged)
  nodeId: NodeId;   // reference to BendNode (unchanged)
  radius: number;   // mm, inner bend radius (NEW)
  kFactor: number;  // 0 < k ≤ 1 (NEW)
  angle: number;    // degrees (NEW)
}
```

---

## New TypeScript Types

### `FusePreflightResult` — internal, `ts/src/mcp/tools.ts`

```typescript
interface FusePreflightResult {
  ok: boolean;
  errorCode?: 'GE_FUSE_THICKNESS_MISMATCH' | 'GE_FUSE_NOT_COPLANAR' | 'GE_FUSE_DISJOINT_RESULT';
  message?: string;
  suggestedTool?: string;
}
```

Used internally by `handleFuseBodies` before any graph or geometry mutation.

---

## New C++ Types

### `BendZoneSpec` — `cpp/src/geometry/geometry_service.hpp`

```cpp
struct BendZoneSpec {
  double offsetMm;       // x-position of bend zone start in flat pattern
  double widthMm;        // bend allowance width in mm
  double angleDeg;       // bend angle in degrees (90.0 for MVP)
  double innerRadiusMm;  // inner bend radius
  double kFactor;        // 0 < k ≤ 1
};
```

### `BuildShellFromFlatPatternResult` — `cpp/src/geometry/geometry_service.hpp`

```cpp
struct BuildShellFromFlatPatternResult {
  std::string shellId;   // registered shell UUID on success; empty on failure
  bool ok;
  std::string errorCode; // "GE_BUILD_FROM_PATTERN_FAILED" on error; empty on success
  std::string message;   // human-readable detail
};
```

---

## New Error Codes

| Code | MCP tool | Trigger condition | Recoverable |
|------|----------|------------------|-------------|
| `GE_FUSE_THICKNESS_MISMATCH` | `fuse_bodies` | `\|thicknessA − thicknessB\| > 0.1mm` | `false` |
| `GE_FUSE_NOT_COPLANAR` | `fuse_bodies` | Panel face normals differ by > 2° | `false` |
| `GE_FUSE_DISJOINT_RESULT` | `fuse_bodies` | DXF union produces disconnected regions | `false` |
| `GE_BUILD_FROM_PATTERN_FAILED` | internal / `buildShellFromFlatPattern` | C++ failed to construct solid | `false` |

All new codes follow the existing JSON error model: `{ code, message, recoverable, suggested_tool }`.

---

## Named Constants (module-scope, `ts/src/mcp/tools.ts`)

```typescript
/** Maximum thickness difference (mm) for a valid fuse operation (FR-002a). */
const FUSE_THICKNESS_TOLERANCE_MM = 0.1;

/** Maximum angle difference (degrees) between panel normals for a valid coplanar fuse (FR-002b). */
const FUSE_COPLANARITY_THRESHOLD_DEG = 2;
```

These replace inline magic numbers. Both are candidates for future promotion to `manufacturing://rules` configuration resource (constitution §VIII).

---

## Entity State Transitions

### `merge_bodies_with_bend` — graph-first flow (replaces current C++-first flow)

```
[Call arrives]
  panelNodeA: { bodyId: "uuid-A", shapeDxf: "...", dirty: false }
  panelNodeB: { bodyId: "uuid-B", shapeDxf: "...", dirty: false }

[Step 1: DXF merge + BendAllowance computation (TypeScript)]
  mergedDxf  ← mergeDxfOutlines(dxfA, dxfB, placement)
  bendAllowance ← computeBendAllowance(angle=90, radius, kFactor, thickness)
  bendZones  ← [{ offset: panelA.flatWidth, width: bendAllowance, angle: 90, radius, kFactor }]

[Step 2: Graph update (TypeScript — BEFORE any C++ call)]
  bendNode:       { id: bendId, panelAId, panelBId, angle: 90, innerRadius, kFactor, bendAllowance }
  mergedPanelNode: { id: nodeBId, bodyId: null, shapeDxf: mergedDxf, dirty: true }

[Step 3: C++ call — buildShellFromFlatPattern(mergedDxf, bendZones, thickness)]
  ↓  (on failure → restoreSnapshot, restore graph to pre-call state)
  result: { shellId: "uuid-merged" }

[Step 4: Graph finalisation]
  mergedPanelNode.bodyId ← "uuid-merged"
  mergedPanelNode.dirty  ← false
  CutNodes from both panels translated to merged coordinates and added to graph

[Returns]
  { merged_shell_id: "uuid-merged", merged_part_id: partAId, graphs_merged: true, ... }
```

### `fuse_bodies` — graph-first flow with pre-flight (replaces current C++-first flow)

```
[Call arrives]
  panelNodeA: { bodyId: "uuid-A", shapeDxf: "dxf-A", nominalThickness: 1.5, panelFrame: {...} }
  panelNodeB: { bodyId: "uuid-B", shapeDxf: "dxf-B", nominalThickness: 1.5, panelFrame: {...} }

[Step 1: Pre-flight validation (TypeScript — NO graph or C++ mutation yet)]
  thickness check:    |1.5 - 1.5| = 0.0 ≤ 0.1mm  ✅
  coplanarity check:  |dot(nA, nB)| ≥ cos(2°)     ✅
  DXF union check:    checkDxfUnionConnectivity()  ✅ (connected)

[Step 2: DXF union computation]
  unionDxf ← mergeDxfOutlines(dxfA, dxfB, identityPlacement)

[Step 3: Graph update (BEFORE any C++ call)]
  fusedPanelNode: { bodyId: null, shapeDxf: unionDxf, dirty: true }

[Step 4: C++ call — buildSheetFromDxf(unionDxf) → thickenSheet(sheetId, thickness)]
  ↓  (on failure → restoreSnapshot, restore graph)
  result: { solidId: "uuid-fused" }

[Step 5: Graph finalisation]
  fusedPanelNode.bodyId ← "uuid-fused"
  fusedPanelNode.dirty  ← false

[Returns]
  { solid_id: "uuid-fused", part_id: preservedPartId, ... }
```

---

## Invariants

1. **DXF is single source of truth (FR-008)**: After any successful `merge_bodies_with_bend` or `fuse_bodies`, `PanelNode.shapeDxf` IS the flat pattern used to generate the 3D solid. `apply_unfold` reads this field directly — no re-derivation from C++ geometry.

2. **BendAllowance populated before C++ (FR-001)**: `BendNode.bendAllowance` is computed from the BA formula in TypeScript before `buildShellFromFlatPattern` is called, so the graph is fully consistent at the point of the C++ call.

3. **Null bodyId window is unobservable**: Between the graph update (step 2) and C++ finalisation (step 4), `PanelNode.bodyId` is null. This window is contained within the synchronous handler — no external observer can interleave.

4. **Graph enforcement (FR-004, FR-005)**: A `PanelNode.bodyId` that appears in any part's graph MUST NOT be passed to raw mutation tools (`cut_bodies`, unguarded `fuseBodies` path). `findGraphOwner(bodyId)` is checked at tool dispatch time.
