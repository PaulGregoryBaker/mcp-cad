# Contract: MCP Tools Extended (Gap Closure)

**Phase**: Phase 1 | **Status**: Draft  
**Feature**: 002-mcp-tools-gap | **Date**: 2026-05-17  
**Reference**: spec.md FR-101–FR-114, Engineering-Design.md §3.3

---

## Overview

This document defines input/output schemas for the ten new MCP tools added to close the gap between the MCP Tools specification v5.0 and the existing implementation. All schemas are enforced via Zod at the MCP Protocol Layer boundary.

For the base tool set schemas, see `specs/001-align-specification/contracts/mcp-tools.md`.

---

## `compute_intersections`

**Category**: Diagnostics (non-mutating)  
**Spec Reference**: FR-101

### Input
```typescript
{
  part_ids: string[];     // Array of ShellId (minimum 2)
}
```

### Output
```typescript
{
  intersects: boolean;
  clashes: Array<{
    part_id_a: string;
    part_id_b: string;
    intersection_volume_mm3: number;
    clash_bounding_box: {
      origin: { x: number; y: number; z: number };
      dimensions: { x: number; y: number; z: number };
    };
    suggested_cutting_plane: {
      normal: { x: number; y: number; z: number };
      origin: { x: number; y: number; z: number };
    };
  }>;
}
```

### Error Codes
- `GE_CLASH_DETECTION_FAILED`: OCCT Boolean Common raised an exception
- `GE_SHELL_NOT_FOUND`: One or more `part_ids` not found

---

## `compute_gaps`

**Category**: Diagnostics (non-mutating)  
**Spec Reference**: FR-102

### Input
```typescript
{
  part_a_id: string;              // ShellId
  part_b_id: string;              // ShellId
  max_distance_threshold: number; // mm; maximum search depth
}
```

### Output
```typescript
{
  has_gap: boolean;
  minimum_distance_mm: number;
  closest_elements: {
    part_a_face_id: string;
    part_b_face_id: string;
  };
  extension_vector: { x: number; y: number; z: number };
  gap_bounding_box: {
    origin: { x: number; y: number; z: number };
    dimensions: { x: number; y: number; z: number };
  };
}
```

### Error Codes
- `GE_GAP_DETECTION_FAILED`: OCCT distance computation raised an exception
- `GE_SHELL_NOT_FOUND`: One or both `part_ids` not found

---

## `check_boundary_compliance`

**Category**: Diagnostics / Logistics (non-mutating)  
**Spec Reference**: FR-103

### Input
```typescript
{
  target_id: string;                                  // ShellId or assembly ID
  envelope_type: 'shipping' | 'coating' | 'raw_stock';
}
```

### Output
```typescript
{
  compliant: boolean;
  envelope_type: string;
  violations: Array<{
    axis: 'x' | 'y' | 'z';
    measured_mm: number;
    limit_mm: number;
    excess_mm: number;
  }>;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`: `target_id` not found
- `MD_LOGISTICS_NOT_CONFIGURED`: Requested envelope type not present in `logistics://` config

---

## `trim_body_with_plane`

**Category**: Direct Modeling  
**Spec Reference**: FR-104

### Input
```typescript
{
  part_id: string;          // ShellId to trim
  cutting_plane: {
    normal: { x: number; y: number; z: number };
    origin: { x: number; y: number; z: number };
  };
  keep_side: 'positive' | 'negative';
}
```

### Output
```typescript
{
  trimmed_shell_id: string;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_TRIM_FAILED`: Cut produced an empty body on the requested keep side

---

## `split_body_by_plane`

**Category**: Topology  
**Spec Reference**: FR-107

### Input
```typescript
{
  part_id: string;            // ShellId to split
  cutting_plane: {
    normal: { x: number; y: number; z: number };
    origin: { x: number; y: number; z: number };
  };
  output_names: [string, string]; // Exactly 2 names for the resulting bodies
}
```

### Output
```typescript
{
  positive_shell_id: string;  // Shell on positive normal side
  negative_shell_id: string;  // Shell on negative normal side
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_SPLIT_FAILED`: Cutting plane does not intersect the solid, or one side is empty

---

## `extend_face_to_target`

**Category**: Direct Modeling  
**Spec Reference**: FR-105

### Input
```typescript
{
  part_id: string;             // ShellId
  face_id: string;             // FaceId on the shell to extend
  target_type: 'plane' | 'face_id' | 'part_surface';
  target: {
    // When target_type = 'plane':
    normal?: { x: number; y: number; z: number };
    origin?: { x: number; y: number; z: number };
    // When target_type = 'face_id' or 'part_surface':
    part_id?: string;
    face_id?: string;
  };
}
```

### Output
```typescript
{
  modified_shell_id: string;
  extension_distance_mm: number;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_EXTEND_FAILED`: Extension would create self-intersection or target not reachable

---

## `offset_face`

**Category**: Direct Modeling  
**Spec Reference**: FR-106

### Input
```typescript
{
  part_id: string;    // ShellId
  face_id: string;    // FaceId to offset
  distance: number;   // mm; positive = add material, negative = remove
}
```

### Output
```typescript
{
  modified_shell_id: string;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_OFFSET_FAILED`: Offset would produce invalid geometry

---

## `add_flange`

**Category**: Sheet Metal Detailing  
**Spec Reference**: FR-109

### Input
```typescript
{
  part_id: string;       // ShellId
  edge_id: string;       // Open (boundary) EdgeId
  length: number;        // mm; flange extension length
  angle: number;         // degrees relative to face normal (e.g. 90.0)
  bend_radius: number;   // mm; internal bend radius
}
```

### Output
```typescript
{
  modified_shell_id: string;
  flange_feature_id: string;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_EDGE_NOT_OPEN`: `edge_id` is not a boundary (open) edge
- `GE_FLANGE_FAILED`: Flange extrusion failed

---

## `rip_edge`

**Category**: Sheet Metal Detailing  
**Spec Reference**: FR-110

### Input
```typescript
{
  part_id: string;    // ShellId
  edge_id: string;    // Interior corner EdgeId to open
}
```

### Output
```typescript
{
  modified_shell_id: string;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_EDGE_NOT_INTERIOR`: `edge_id` is a boundary edge, not an interior corner
- `GE_RIP_FAILED`: Edge removal produced invalid topology

---

## `merge_bodies_with_bend`

**Category**: Topology  
**Spec Reference**: FR-108

### Input
```typescript
{
  part_a_id: string;          // ShellId
  part_b_id: string;          // ShellId
  target_edges: string[];     // Adjacent edge IDs to fuse along
  bend_radius: number;        // mm; internal radius of the resulting fold
}
```

### Output
```typescript
{
  merged_shell_id: string;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_MERGE_FAILED`: Bodies are not adjacent or fusion produced non-manifold result
