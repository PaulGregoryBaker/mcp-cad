# Contract: Geometry Port (C++ ↔ TypeScript NAPI Boundary)

**Phase**: Phase 1 | **Status**: Complete  
**Task**: T014 | **Date**: 2026-05-13  
**Reference**: Engineering-Design.md §3, Architecture.md §4

---

## Overview

The Geometry Port defines the NAPI boundary between the TypeScript MCP server and the C++ Geometry Engine. All data crossing this boundary must use the serialization invariants defined below.

**Invariants**:
1. All IDs are UTF-8 strings (UUID v4 format).
2. All dimensional values are IEEE-754 doubles in millimetres.
3. All topology data is transmitted as JSON-serializable objects.
4. Errors are thrown as JavaScript `Error` objects with a `code` property.

---

## FFI Signatures

All methods are exposed on the `GeometryAddon` NAPI object.

### `loadStep(filePath: string): SolidId`

```typescript
function loadStep(filePath: string): string;
```

- `filePath`: Absolute path to a STEP AP203/AP214 file.
- Returns: `SolidId` (UUID string).
- Throws: `{ code: "GE_IMPORT_FAILED", message: string }` if file cannot be loaded.
- Throws: `{ code: "GE_INVALID_SOLID", message: string }` if STEP contains no valid solids.

**C++ signature**:
```cpp
Napi::Value LoadStep(const Napi::CallbackInfo& info);
// info[0]: string filePath
// Returns: Napi::String solidId
```

---

### `getTopology(solidId: string): TopologyGraph`

```typescript
interface TopologyGraph {
  solidId: string;
  faces: FaceNode[];
  edges: EdgeNode[];
  adjacency: AdjacencyEntry[];
}

interface FaceNode {
  faceId: string;
  surfaceType: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
  areaMm2: number;
  normalX: number;
  normalY: number;
  normalZ: number;
}

interface EdgeNode {
  edgeId: string;
  curveType: 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';
  lengthMm: number;
}

interface AdjacencyEntry {
  faceIdA: string;
  faceIdB: string;
  sharedEdgeId: string;
  dihedralAngleDeg: number;
}

function getTopology(solidId: string): TopologyGraph;
```

- Throws: `{ code: "GE_SOLID_NOT_FOUND", message: string }` if `solidId` is unknown.

---

### `checkManifold(solidId: string): ManifoldResult`

```typescript
interface ManifoldResult {
  isManifold: boolean;
  issues: ManifoldIssue[];
}

interface ManifoldIssue {
  type: 'free_edge' | 'non_manifold_edge' | 'degenerate_face' | 'sliver_face';
  faceId?: string;
  edgeId?: string;
  description: string;
}

function checkManifold(solidId: string): ManifoldResult;
```

---

### `healGeometry(solidId: string): SolidId`

```typescript
function healGeometry(solidId: string): string;
```

- Returns new `SolidId` for the healed solid (original ID preserved for rollback).
- Throws: `{ code: "GE_HEAL_FAILED", message: string }` if healing cannot produce a valid solid.

---

### `booleanCut(solidId: string, planeNormal: Vector3, planeOrigin: Vector3): BooleanCutResult`

```typescript
interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface BooleanCutResult {
  shellIds: string[];     // Child shell IDs from decomposition
  rollbackToken: string;  // RollbackToken for this operation
}

function booleanCut(solidId: string, planeNormal: Vector3, planeOrigin: Vector3): BooleanCutResult;
```

- Throws: `{ code: "GE_BOOLEAN_FAILURE", message: string }` if boolean operation fails.
- Throws: `{ code: "GE_EMPTY_RESULT", message: string }` if cut produces no valid shells.

---

### `addTabSlot(shellIdA: string, shellIdB: string, kerfOffsetMm: number): TabSlotResult`

```typescript
interface TabSlotResult {
  modifiedShellIds: string[];
  kerfOffsetApplied: number;   // Actual kerf applied (must be 0.1–0.2 mm)
  rollbackToken: string;
}

function addTabSlot(shellIdA: string, shellIdB: string, kerfOffsetMm: number): TabSlotResult;
```

- `kerfOffsetMm`: Must be in range [0.1, 0.2]. Clamped if out of range.
- Throws: `{ code: "GE_TAB_SLOT_FAILED", message: string }` on geometry failure.

---

### `addRivetHole(shellId: string, faceId: string, centerX: number, centerY: number, diameterMm: number): RivetHoleResult`

```typescript
interface RivetHoleResult {
  modifiedShellId: string;
  holeFeatureId: string;
  rollbackToken: string;
}

function addRivetHole(shellId: string, faceId: string, centerX: number, centerY: number, diameterMm: number): RivetHoleResult;
```

---

### `unfoldShell(shellId: string, kFactor: number): UnfoldResult`

```typescript
interface UnfoldResult {
  unfoldId: string;
  flatWidthMm: number;
  flatHeightMm: number;
  kFactorUsed: number;
  bendCount: number;
}

function unfoldShell(shellId: string, kFactor: number): UnfoldResult;
```

- Throws: `{ code: "GE_UNFOLD_FAILED", message: string }` if geometry cannot be unfolded.

---

### `exportDxf(unfoldId: string): DxfExportResult`

```typescript
interface DxfExportResult {
  dxfContent: string;       // DXF file content as UTF-8 string
  wireCount: number;        // Number of wire entities in DXF
  boundingBox: {
    widthMm: number;
    heightMm: number;
  };
}

function exportDxf(unfoldId: string): DxfExportResult;
```

---

### `nestShells(unfoldIds: string[], sheetWidthMm: number, sheetHeightMm: number): NestResult`

```typescript
interface NestResult {
  nestId: string;
  placements: NestPlacement[];
  utilisationPct: number;    // Material utilization (0–100)
  sheetsRequired: number;
}

interface NestPlacement {
  unfoldId: string;
  sheetIndex: number;
  x: number;
  y: number;
  rotationDeg: number;
}

function nestShells(unfoldIds: string[], sheetWidthMm: number, sheetHeightMm: number): NestResult;
```

---

### `createSnapshot(label: string): string`

```typescript
function createSnapshot(label: string): string; // Returns snapshotId
```

---

### `restoreSnapshot(snapshotId: string): RestoreResult`

```typescript
interface RestoreResult {
  restoredSolidIds: string[];
  restoredShellIds: string[];
}

function restoreSnapshot(snapshotId: string): RestoreResult;
```

---

### `clearSnapshots(): void`

```typescript
function clearSnapshots(): void;
```

---

## Serialization Invariants

| Type | Wire Format | Precision |
|------|-------------|-----------|
| ID (`SolidId`, `ShellId`, etc.) | UTF-8 string (UUID v4) | N/A |
| Dimension (mm) | IEEE-754 double | No rounding at boundary |
| Angle (degrees) | IEEE-754 double | No rounding |
| Boolean | JS boolean | N/A |
| Array | JS Array | No truncation |

**Forbidden**: C++ `float` (32-bit) must be upcast to `double` before crossing NAPI boundary to prevent precision loss.
