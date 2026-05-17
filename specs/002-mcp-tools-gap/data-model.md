# Data Model: MCP Tools Gap Closure

**Phase**: Phase 1 | **Feature**: 002-mcp-tools-gap | **Date**: 2026-05-17

---

## New Types

These types extend the existing type system in `ts/src/geometry/types.ts` and `cpp/src/geometry/geometry_service.hpp`.

### `CuttingPlane`

A vector object used as a geometric operator in split, trim, and extend operations.

```typescript
// ts/src/geometry/types.ts
interface CuttingPlane {
  normal: { x: number; y: number; z: number };  // unit vector
  origin: { x: number; y: number; z: number };  // point on plane (mm)
}
```

```cpp
// cpp/src/geometry/geometry_service.hpp
struct CuttingPlane {
  double normalX, normalY, normalZ;  // unit vector
  double originX, originY, originZ;  // point on plane (mm)
};
```

**Validation**: `normal` must be a unit vector (magnitude = 1.0 ± 0.001). If not, the C++ layer normalizes it.

---

### `ClashReport`

Result of `compute_intersections`. Describes one or more clash pairs between parts.

```typescript
// ts/src/geometry/types.ts
interface ClashPair {
  partIdA: string;
  partIdB: string;
  intersectionVolumeMm3: number;
  clashBoundingBox: {
    origin: { x: number; y: number; z: number };
    dimensions: { x: number; y: number; z: number };
  };
  suggestedCuttingPlane: CuttingPlane;
}

interface ClashReport {
  intersects: boolean;
  clashes: ClashPair[];
}
```

```cpp
struct ClashPair {
  ShellId partIdA;
  ShellId partIdB;
  double  intersectionVolumeMm3;
  struct BBox { double ox, oy, oz, dx, dy, dz; } clashBoundingBox;
  CuttingPlane suggestedCuttingPlane;
};

struct ClashReport {
  bool                      intersects;
  std::vector<ClashPair>    clashes;
};
```

---

### `GapReport`

Result of `compute_gaps`. Describes the minimum gap between two parts.

```typescript
// ts/src/geometry/types.ts
interface GapReport {
  hasGap: boolean;
  minimumDistanceMm: number;
  closestElements: {
    partAFaceId: string;
    partBFaceId: string;
  };
  extensionVector: { x: number; y: number; z: number };
  gapBoundingBox: {
    origin: { x: number; y: number; z: number };
    dimensions: { x: number; y: number; z: number };
  };
}
```

```cpp
struct GapReport {
  bool        hasGap;
  double      minimumDistanceMm;
  std::string partAFaceId;
  std::string partBFaceId;
  struct Vec3 { double x, y, z; } extensionVector;
  struct BBox { double ox, oy, oz, dx, dy, dz; } gapBoundingBox;
};
```

---

### `ComplianceReport`

Result of `check_boundary_compliance`. Entirely a TypeScript-layer type (no C++ equivalent needed).

```typescript
// ts/src/mcp/tools.ts (inline, no new file)
interface AxisViolation {
  axis: 'x' | 'y' | 'z';
  measuredMm: number;
  limitMm: number;
  excessMm: number;
}

interface ComplianceReport {
  compliant: boolean;
  envelopeType: 'shipping' | 'coating' | 'raw_stock';
  violations: AxisViolation[];
}
```

---

### `SplitBodyResult`

Result of `split_body_by_plane`. Returns two new independently registered shell IDs.

```typescript
// ts/src/geometry/types.ts
interface SplitBodyResult {
  positiveShellId: string;   // shell on positive side of normal
  negativeShellId: string;   // shell on negative side of normal
  rollbackToken: string;
}
```

```cpp
struct SplitBodyResult {
  ShellId    positiveShellId;
  ShellId    negativeShellId;
  SnapshotId rollbackToken;
};
```

---

### `TrimBodyResult`

Result of `trim_body_with_plane`. Single remaining shell.

```typescript
// ts/src/geometry/types.ts
interface TrimBodyResult {
  trimmedShellId: string;
  rollbackToken: string;
}
```

```cpp
struct TrimBodyResult {
  ShellId    trimmedShellId;
  SnapshotId rollbackToken;
};
```

---

### `ExtendFaceResult`

Result of `extend_face_to_target`.

```typescript
// ts/src/geometry/types.ts
interface ExtendFaceResult {
  modifiedShellId: string;
  extensionDistanceMm: number;
  rollbackToken: string;
}
```

```cpp
struct ExtendFaceResult {
  ShellId    modifiedShellId;
  double     extensionDistanceMm;
  SnapshotId rollbackToken;
};
```

---

### `OffsetFaceResult`

Result of `offset_face`.

```typescript
// ts/src/geometry/types.ts
interface OffsetFaceResult {
  modifiedShellId: string;
  rollbackToken: string;
}
```

---

### `AddFlangeResult`

Result of `add_flange`.

```typescript
// ts/src/geometry/types.ts
interface AddFlangeResult {
  modifiedShellId: string;
  flangeFeatureId: string;
  rollbackToken: string;
}
```

---

### `RipEdgeResult`

Result of `rip_edge`.

```typescript
// ts/src/geometry/types.ts
interface RipEdgeResult {
  modifiedShellId: string;
  rollbackToken: string;
}
```

---

### `MergeBodyResult`

Result of `merge_bodies_with_bend`.

```typescript
// ts/src/geometry/types.ts
interface MergeBodyResult {
  mergedShellId: string;
  rollbackToken: string;
}
```

---

## Validation Rules

| Field | Constraint | Error |
|---|---|---|
| `CuttingPlane.normal` | Must be non-zero; normalized if not unit | `GE_TRIM_FAILED` |
| `add_flange.angle` | 0 < angle ≤ 180 | `GE_FLANGE_FAILED` |
| `add_flange.bend_radius` | > 0.0 mm | `GE_FLANGE_FAILED` |
| `add_flange.length` | > 0.0 mm | `GE_FLANGE_FAILED` |
| `offset_face.distance` | ≠ 0.0 (zero offset is a no-op) | `GE_OFFSET_FAILED` |
| `merge_bodies_with_bend.bend_radius` | > 0.0 mm | `GE_MERGE_FAILED` |
| `merge_bodies_with_bend.target_edges` | Length ≥ 1 | `GE_MERGE_FAILED` |
| `compute_intersections.part_ids` | Length ≥ 2 | `INTERNAL_ERROR` |
| `compute_gaps.max_distance_threshold` | > 0.0 mm | `INTERNAL_ERROR` |
