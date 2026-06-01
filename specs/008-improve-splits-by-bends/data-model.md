# Data Model: Splits by Bends and Viewport Alignment Enhancements (008)

**Phase 1 Output** | **Date**: 2026-06-01
**Spec**: [spec.md](./spec.md)

---

## C++ Types (`geometry_service.hpp` additions/modifications)

### Viewport Re-orientation and Centering Structures

```cpp
struct AlignmentResult {
  ShellId                         solidId;
  double                          centroid[3];
  double                          rotationMatrix[9];
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory;
};
```

### Enhanced Decomposition Structures (Modified)

```cpp
struct ProtrusionParent {
  ShellId protrusionId;
  ShellId parentPanelId;
};

struct SplitBodyByBendsResult {
  std::vector<ShellId>            panelIds;
  std::vector<BBox3>              panelBboxes;
  std::vector<ShellId>            protrusionIds;
  std::vector<BBox3>              protrusionBboxes;
  std::vector<ProtrusionParent>   protrusionParents;
  std::string                     detectedMode;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory; // Added for FR-007 shape lineage tracking
};
```

### Protrusion Removal Structures (Modified)

```cpp
struct RemoveProtrusionsResult {
  ShellId                         cleanedPartId;
  std::vector<ShellId>            protrusionIds;
  std::vector<BBox3>              protrusionBboxes;
  int                             protrusionCount  = 0;
  SnapshotId                      rollbackToken;
  std::vector<ShapeHistoryRecord> shapeHistory; // Added for loop-traversal lineage
};
```

---

## TypeScript Types (`ts/src/geometry/types.ts` additions/modifications)

```typescript
export interface AlignmentResult {
  solid_id: string;
  centroid: [number, number, number];
  rotation_matrix: [number, number, number, number, number, number, number, number, number];
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[];
}

export interface SplitBodyByBendsResult {
  panel_ids: string[];
  panel_count: number;
  panel_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
  protrusion_ids: string[];
  protrusion_count: number;
  protrusion_bboxes: Array<{ x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number }>;
  protrusion_parents: Array<{ protrusion_id: string; parent_panel_id: string | null }>;
  detected_mode: string;
  rollback_token: string;
  shape_history?: ShapeHistoryRecord[]; // Enhanced shape lineage tracking
}
```

---

## Error Codes (`ts/src/mcp/errors.ts` and `geometry_service.hpp`)

These error codes provide precise feedback for new re-orientation and stitching failures:

| Code | Bounded Context | Description |
|---|---|---|
| `GE_ALIGN_FAILED` | Geometry Engine | Viewport/Centering re-orientation calculation or translation failed due to degenerate topology. |
| `GE_MERGE_NON_MANIFOLD` | Geometry Engine | Fusing adjacent panels produced non-manifold edge junctions or intersecting shells. |
| `GE_PROTRUSION_LOOP_FAILED` | Feature Extractor | The loop-traversal algorithm could not resolve a closed seam loop around a thin flange. |

---

## Validation & Constraint Rules

| Constraint / Variable | Rule | Default / Limits |
|---|---|---|
| **Collinear Unification Angle** | Max angular deviation of normal vectors to merge adjacent facet triangles into a trapezoidal panel. | $\le 0.5\text{ degrees}$ |
| **Viewport Alignment Up Axis** | Target Up-vector system alignment. | Global Z (`[0,0,1]`) |
| **Fuzzy Stitching Tolerance** | Dynamic sewing tolerance used in `merge_bodies_with_bend` for faceted complex curves. | $0.05\text{ mm} - 0.2\text{ mm}$ (thickness-based) |
| **Protrusion Cycle Ratio** | Ratio of loop interface circumference to thickness to classify as a narrow closed loop. | $\ge 4.0$ |
