# Data Model: Advanced Sheet Metal Unfolding (007)

**Phase 1 output** | **Date**: 2026-05-26

This document lists all new and modified data structures, types, and error codes introduced by the Advanced Sheet Metal Unfolding feature (007).

---

## C++ Types (`geometry_service.hpp` additions/modifications)

### Validation Structures

```cpp
struct SheetMetalValidationResult {
  bool                     isValid          = false;
  double                   nominalThickness = 0.0;
  bool                     canFlatten       = false;
  std::vector<std::string> validationErrors;
};
```

### Unfolding Structures (Modified)

```cpp
struct UnfoldResult {
  UnfoldId                        unfoldId;
  double                          flatWidthMm      = 0.0;
  double                          flatHeightMm     = 0.0;
  double                          kFactorUsed      = 0.33;
  int                             bendCount        = 0;
  bool                            validated        = false;
  double                          detectedThickness = 0.0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Gap Sewing & Curved Rebuild Structures

```cpp
struct GapSewResult {
  ShellId                         solidId;
  bool                            sewComplete      = false;
  double                          maxGapFound      = 0.0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};

struct CurvedRebuildResult {
  ShellId                         solidId;
  int                             bendsReplaced    = 0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### New Error Codes (C++)

Added to `geometry_service.hpp` for precise diagnostics:

```cpp
constexpr const char* GE_INVALID_SHEET_METAL      = "GE_INVALID_SHEET_METAL";
constexpr const char* GE_UNFOLD_CYCLE_DETECTED    = "GE_UNFOLD_CYCLE_DETECTED";
constexpr const char* GE_UNFOLD_T_JUNCTION        = "GE_UNFOLD_T_JUNCTION";
constexpr const char* GE_UNFOLD_SEWING_FAILED      = "GE_UNFOLD_SEWING_FAILED";
constexpr const char* GE_UNFOLD_REBUILD_FAILED     = "GE_UNFOLD_REBUILD_FAILED";
```

---

## TypeScript Types (`ts/src/geometry/types.ts` additions/modifications)

```typescript
export interface SheetMetalValidationResult {
  is_valid: boolean;
  nominal_thickness: number;
  can_flatten: boolean;
  validation_errors: string[];
}

export interface UnfoldResult {
  unfold_id: string;
  flat_width_mm: number;
  flat_height_mm: number;
  k_factor_used: number;
  bend_count: number;
  validated: boolean;
  detected_thickness: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface GapSewResult {
  solid_id: string;
  sew_complete: boolean;
  max_gap_found: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface CurvedRebuildResult {
  solid_id: string;
  bends_replaced: number;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}
```

### TypeScript Error Codes (`ts/src/mcp/errors.ts` additions)

```typescript
GE_INVALID_SHEET_METAL:      'GE_INVALID_SHEET_METAL',
GE_UNFOLD_CYCLE_DETECTED:    'GE_UNFOLD_CYCLE_DETECTED',
GE_UNFOLD_T_JUNCTION:        'GE_UNFOLD_T_JUNCTION',
GE_UNFOLD_SEWING_FAILED:      'GE_UNFOLD_SEWING_FAILED',
GE_UNFOLD_REBUILD_FAILED:     'GE_UNFOLD_REBUILD_FAILED',
```

---

## Key Entities — Session Store

| Entity | Stored In | Lifetime | Rollback |
|---|---|---|---|
| `UnfoldState` | `GeometryServiceImpl::unfolds_` | Session-scoped | Cleared on rollback |
| `ValidationCache` | `GeometryServiceImpl::validation_cache_` | Session-scoped | Cleared on rollback |

---

## Validation & Constraint Rules

| Constraint / Variable | Rule | Default / Limits |
|---|---|---|
| **Max Sewing Gap** | Maximum gap size that will be sewn by auto-healing. | $0.1\text{ mm}$ (non-bypassable limit) |
| **Material Thickness** | Uniform sheet thickness detected. | $[0.5\text{ mm}, 6.0\text{ mm}]$ |
| **Thickness Tolerance** | Permitted local thickness deviation. | $\pm 10\%$ of nominal thickness |
| **Planar Area Ratio** | Minimum percentage of surface area that must consist of flat offset faces. | $\geq 85\%$ |
| **Graph Edge Degree** | The degree of connected faces per bend edge. | Exactly $2$ (degree $>2$ is a T-junction) |
| **K-Factor Range** | Scale factor for neutral axis shift. | $[0.25, 0.50]$ (default: $0.33$) |
| **DXF Layer Names** | Target DXF output drawing layers. | `'CUT'`, `'BEND_UP'`, `'BEND_DOWN'` |
