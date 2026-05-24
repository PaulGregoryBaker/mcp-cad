# Data Model: Geometric Primitive Tools (006)

**Phase 1 output** | **Date**: 2026-05-24

This document catalogues every new type introduced by feature 006. Existing types are not repeated; see [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts) and [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp) for the full prior surface.

---

## C++ Types (`geometry_service.hpp` additions)

### Session State

```cpp
using AssemblyId  = std::string;   // UUID v4 — new, parallel to SolidId/ShellId
using ComponentId = std::string;   // UUID v4 — identifies one instance in an assembly

struct AssemblyState {
  AssemblyId id;
  Handle(TDocStd_Document) doc;                    // XCAF document handle
  Handle(XCAFDoc_ShapeTool) shapeTool;             // cached ShapeTool accessor
  std::unordered_map<ComponentId, TDF_Label> components; // component registry
};
// Stored in: GeometryServiceImpl::assemblies_ (new map)
// Lifetime: session-scoped, rolled back via SnapshotRegistry
```

### Boolean Operation Results

```cpp
struct FuseResult {
  ShellId solidId;                         // new fused body
  bool disjoint;                           // true → result is a compound, not single body
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct CutResult {
  ShellId solidId;                         // new cut blank
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct IntersectResult {
  ShellId solidId;                         // intersection body
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Interrogation Results (non-mutating, no rollback token)

```cpp
struct BoundingBoxResult {
  double xMin, yMin, zMin;
  double xMax, yMax, zMax;
  // All values in mm; axis-aligned bounding box from BRepBndLib::AddOptimal
};

struct MassPropertiesResult {
  std::optional<double>               volume;           // mm³
  std::optional<double>               surfaceArea;      // mm²
  std::optional<std::array<double,3>> centroid;         // mm, [x, y, z]
  std::optional<std::array<double,9>> inertiaTensor;    // mm⁵, row-major 3x3
};

struct MeasureResult {
  double      value;                 // mm (distances) or degrees (angles)
  std::string measurementType;       // "min_distance" | "max_distance" | "angle"
};

struct ExploreResult {
  std::vector<std::string> entityIds;  // ordered list of sub-entity id strings
};
```

### Transform Results

All five transform tools share the same result shape:

```cpp
struct TransformResult {
  ShellId solidId;                         // new transformed body
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Direct Edit Results

```cpp
struct FilletResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct ChamferResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct SimplifyResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct HealExResult {
  ShellId solidId;
  bool healComplete;                        // false → BRepCheck_Analyzer still finds issues
  std::vector<std::string> remainingIssues; // free-text OCCT diagnostic messages
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct OffsetShapeResult {
  ShellId solidId;
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct DeleteFaceResult {
  std::vector<ShellId> solidIds;           // 1+ bodies (removal may disconnect)
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Sewing Result

```cpp
struct SewResult {
  ShellId solidId;                         // resulting shell (or solid if make_solid)
  bool sewComplete;                        // false → freeEdges is non-empty
  std::vector<std::string> freeEdges;      // unstitched edge IDs
  SnapshotId rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Assembly Results

```cpp
struct CreateAssemblyResult {
  AssemblyId assemblyId;
};

struct AddInstanceResult {
  ComponentId componentId;
  SnapshotId rollbackToken;
};

struct LocationMatrix {
  // Flat 4×4 column-major homogeneous matrix, as in glTF/XCAF convention
  std::array<double,16> m;
};

struct MateRigidResult {
  ComponentId componentId;             // the moved component
  LocationMatrix locationMatrix;       // new absolute location
  SnapshotId rollbackToken;
};

struct AssemblyNode {
  ComponentId              componentId;
  std::string              shapeId;           // SolidId or sub-AssemblyId
  LocationMatrix           locationMatrix;
  std::vector<AssemblyNode> children;
};

struct ListAssemblyResult {
  AssemblyId   assemblyId;
  AssemblyNode root;
};
```

### New Error Code Constants (C++)

Added to `geometry_service.hpp` alongside the existing `GE_DECOMPOSE_*` constants:

```cpp
// ─── Error codes — Feature 006-geometry-primitives ────────────────────────────
constexpr const char* GE_BOOLEAN_EMPTY_RESULT      = "GE_BOOLEAN_EMPTY_RESULT";
constexpr const char* GE_ALIGN_UNSUPPORTED         = "GE_ALIGN_UNSUPPORTED";
constexpr const char* GE_SCALE_NON_UNIFORM         = "GE_SCALE_NON_UNIFORM";
constexpr const char* GE_FILLET_TOO_LARGE          = "GE_FILLET_TOO_LARGE";
constexpr const char* GE_CHAMFER_TOO_LARGE         = "GE_CHAMFER_TOO_LARGE";
constexpr const char* GE_HEAL_INCOMPLETE           = "GE_HEAL_INCOMPLETE";
constexpr const char* GE_SEW_INCOMPLETE            = "GE_SEW_INCOMPLETE";
constexpr const char* GE_ASSEMBLY_MATE_UNSUPPORTED = "GE_ASSEMBLY_MATE_UNSUPPORTED";
constexpr const char* GE_ASSEMBLY_CROSS_DOCUMENT   = "GE_ASSEMBLY_CROSS_DOCUMENT";
```

---

## TypeScript Types (`ts/src/geometry/types.ts` additions)

All follow the existing snake_case, optional-field conventions:

```typescript
// ── Assembly IDs ──────────────────────────────────────────────────────────────
export type AssemblyId  = string;
export type ComponentId = string;

// ── Boolean results ───────────────────────────────────────────────────────────
export interface FuseResult {
  solid_id: string;
  disjoint: boolean;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface CutResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface IntersectResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Interrogation results ─────────────────────────────────────────────────────
export interface BoundingBoxResult {
  x_min: number; y_min: number; z_min: number;
  x_max: number; y_max: number; z_max: number;
}

export interface MassPropertiesResult {
  volume?: number;
  surface_area?: number;
  centroid?: [number, number, number];
  inertia_tensor?: [number, number, number, number, number, number, number, number, number];
}

export interface MeasureResult {
  value: number;
  measurement_type: string;
}

export interface ExploreResult {
  entity_ids: string[];
}

// ── Transform result ──────────────────────────────────────────────────────────
export interface TransformResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Direct edit results ───────────────────────────────────────────────────────
export interface FilletResult {
  solid_id: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}
export interface ChamferResult  extends FilletResult {}   // same shape
export interface SimplifyResult extends FilletResult {}
export interface OffsetShapeResult extends FilletResult {}

export interface HealExResult {
  solid_id: string;
  heal_complete: boolean;
  remaining_issues: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface DeleteFaceResult {
  solid_ids: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Sewing ────────────────────────────────────────────────────────────────────
export interface SewResult {
  solid_id: string;
  sew_complete: boolean;
  free_edges: string[];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

// ── Assembly ──────────────────────────────────────────────────────────────────
export interface CreateAssemblyResult {
  assembly_id: string;
}

export interface AddInstanceResult {
  component_id: string;
  rollback_token: string;
}

export type LocationMatrix16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export interface MateRigidResult {
  component_id: string;
  location_matrix: LocationMatrix16;
  rollback_token: string;
}

export interface AssemblyNode {
  component_id: string;
  shape_id: string;
  location_matrix: LocationMatrix16;
  children: AssemblyNode[];
}

export interface ListAssemblyResult {
  assembly_id: string;
  root: AssemblyNode;
}
```

---

## TypeScript Error Codes (`ts/src/mcp/errors.ts` additions)

```typescript
// Feature 006-geometry-primitives
GE_BOOLEAN_EMPTY_RESULT:      'GE_BOOLEAN_EMPTY_RESULT',
GE_ALIGN_UNSUPPORTED:         'GE_ALIGN_UNSUPPORTED',
GE_SCALE_NON_UNIFORM:         'GE_SCALE_NON_UNIFORM',
GE_FILLET_TOO_LARGE:          'GE_FILLET_TOO_LARGE',
GE_CHAMFER_TOO_LARGE:         'GE_CHAMFER_TOO_LARGE',
GE_HEAL_INCOMPLETE:           'GE_HEAL_INCOMPLETE',
GE_SEW_INCOMPLETE:            'GE_SEW_INCOMPLETE',
GE_ASSEMBLY_MATE_UNSUPPORTED: 'GE_ASSEMBLY_MATE_UNSUPPORTED',
GE_ASSEMBLY_CROSS_DOCUMENT:   'GE_ASSEMBLY_CROSS_DOCUMENT',
```

---

## Key Entities — Session Store

| Entity | Stored In | Lifetime | Rollback |
|---|---|---|---|
| `SolidState` (existing) | `GeometryServiceImpl::solids_` | Session | SnapshotRegistry |
| `ShellState` (existing) | `GeometryServiceImpl::shells_` | Session | SnapshotRegistry |
| `AssemblyState` (new) | `GeometryServiceImpl::assemblies_` | Session | SnapshotRegistry (component map) |
| `AssemblyComponent` (implicit in AssemblyState) | `AssemblyState::components` map | Session | Part of AssemblyState snapshot |

## Key Entities — MCP Protocol Layer

| Entity | Source | Notes |
|---|---|---|
| `solid_id` / `shell_id` | Existing — returned by most mutating tools | Both are UUIDs; `solid_id` is what the spec calls these for clarity |
| `assembly_id` | New — returned by `create_assembly_document` | UUID v4 |
| `component_id` | New — returned by `add_assembly_instance` | UUID v4 |
| `face_id` | Existing — shape hash string from `explore_topology` | Used as input to `fillet_edges`, `delete_face` |
| `edge_id` | Existing — shape hash string from `explore_topology` | Used as input to `fillet_edges`, `chamfer_edges` |
| `rollback_token` | Existing — `SnapshotId` from SnapshotRegistry | Passed to `rollback` tool if user wants single-step undo |
| `shape_history` | Existing — `ShapeHistoryRecord[]` | Consumed by transaction commit for semantic remap |

## Validation Rules

| Field | Rule |
|---|---|
| `fuzzy_tolerance` | > 0.0; default 1e-5 mm |
| `radius` (fillet) | > 0.0 mm |
| `distance` (chamfer) | > 0.0 mm |
| `scale_factor` | > 0.0; non-uniform rejected (only single scalar accepted) |
| `offset_value` | Non-zero; negative = inward offset |
| `tolerance` (sew) | > 0.0 mm; default 0.001 mm |
| `angle_degrees` | Any real number (rotation wraps modulo 360°) |
| `axis_direction` | Must be a non-zero vector (normalised internally) |
| `plane_normal` | Must be a non-zero vector (normalised internally) |
| `tools` (fuse/cut) | ≥ 1 element; ≤ 100 (MVP cap) |
| `targets` (transform/direct-edit) | ≥ 1 element |
| `properties` (mass_props) | At least one of: `volume`, `surface_area`, `centroid`, `inertia_tensor` |
| `return_type` (explore) | One of: `solid`, `shell`, `face`, `edge`, `vertex` |
| `measurement_type` | One of: `min_distance`, `max_distance`, `angle` |
| `mate_type` | Phase 1: `coincident` only |
