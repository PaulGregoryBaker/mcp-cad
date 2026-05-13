# Contract: MCP Tools (Tool Schemas)

**Phase**: Phase 1 | **Status**: Complete  
**Task**: T016 | **Date**: 2026-05-13  
**Reference**: Engineering-Design.md §3.3, Architecture.md §4

---

## Overview

This document defines the input/output schemas for all MCP tools exposed by the mcp-cad server. All schemas are enforced via Zod at the MCP Protocol Layer boundary.

For error schemas, see `Engineering-Design.md §3.4` and `data-model.md #StructuredError`.

---

## `clean_geometry`

**Category**: Analysis  
**Spec Reference**: FR-001

### Input
```typescript
{
  file_path: string;      // Absolute path to STEP file
}
```

### Output
```typescript
{
  solid_id: string;           // SolidId
  is_manifold: boolean;
  face_count: number;
  issues_found: number;       // Count of issues detected (0 = clean)
  healed: boolean;            // true if healing was applied
  rollback_token: string;     // RollbackToken for this import
}
```

### Error Codes
- `GE_IMPORT_FAILED`: File not found or STEP parse error
- `GE_INVALID_SOLID`: No valid solids in file
- `GE_HEAL_FAILED`: Geometry cannot be healed

---

## `decompose_volume`

**Category**: Decomposition  
**Spec Reference**: FR-002

### Input
```typescript
{
  solid_id: string;       // SolidId to decompose
  strategy: 'Integrity' | 'Simplicity' | 'Logistics';
  max_panels?: number;    // Optional; default: 5
}
```

### Output
```typescript
{
  panel_ids: string[];        // Array of ShellId
  panel_count: number;
  strategy_applied: string;
  rollback_token: string;     // RollbackToken for this decomposition
}
```

### Error Codes
- `GE_SOLID_NOT_FOUND`: `solid_id` does not exist
- `GE_BOOLEAN_FAILURE`: Decomposition cut failed
- `GE_EMPTY_RESULT`: No valid shells produced

---

## `synthesize_joints`

**Category**: Joining  
**Spec Reference**: FR-003

### Input
```typescript
{
  panel_ids: string[];        // ShellId pair (exactly 2 for MVP)
  joint_type: 'tab_slot' | 'rivet' | 'weld' | 'adhesive' | 'plastic_fastener';
  clearance_mm?: number;      // Optional kerf override (default from manufacturing://rules)
}
```

### Output
```typescript
{
  modified_panel_ids: string[];
  joint_type_applied: string;
  kerf_offset_mm: number;     // Actual kerf applied (must be 0.1–0.2 mm)
  rollback_token: string;
}
```

### Error Codes
- `GE_TAB_SLOT_FAILED`: Tab-slot geometry operation failed
- `MD_SAFETY_VIOLATION`: Joint type blocked by environmental context
- `GE_SHELL_NOT_FOUND`: One or more `panel_ids` not found

---

## `generate_reliefs`

**Category**: Sheet Metal  
**Spec Reference**: FR-004

### Input
```typescript
{
  panel_id: string;           // ShellId
  relief_type: 'dogbone' | 'circular';
  radius_mm?: number;         // Optional; default derived from material thickness
}
```

### Output
```typescript
{
  modified_panel_id: string;
  relief_count: number;
  rollback_token: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `GE_RELIEF_FAILED`

---

## `apply_unfold`

**Category**: Flattening  
**Spec Reference**: FR-004

### Input
```typescript
{
  panel_id: string;           // ShellId
  material_id: string;        // Must match a MaterialSpec.id in config
  k_factor?: number;          // Optional override; default from MaterialSpec
}
```

### Output
```typescript
{
  unfold_id: string;          // UnfoldId
  flat_width_mm: number;
  flat_height_mm: number;
  k_factor_used: number;
  bend_count: number;
  rollback_token: string;
}
```

### Error Codes
- `GE_UNFOLD_FAILED`: Shell cannot be unfolded
- `MD_MATERIAL_NOT_FOUND`: `material_id` not in config
- `GE_SHELL_NOT_FOUND`

---

## `evaluate_manufacturability`

**Category**: Validation  
**Spec Reference**: FR-005

### Input
```typescript
{
  panel_id: string;           // ShellId
  material_id: string;
}
```

### Output
```typescript
{
  score: number;              // 0.0–1.0 (1.0 = fully compliant)
  violations: Array<{
    rule_code: string;
    severity: 'error' | 'warning';
    feature_id: string;
    description: string;
    measured_value_mm?: number;
    limit_value_mm?: number;
  }>;
  summary: string;
}
```

### Error Codes
- `GE_SHELL_NOT_FOUND`
- `MD_MATERIAL_NOT_FOUND`
- `ACL_EXTRACTION_FAILED`

---

## `validate_bend_sequence`

**Category**: Validation  
**Spec Reference**: FR-005

### Input
```typescript
{
  panel_id: string;           // ShellId
}
```

### Output
```typescript
{
  valid: boolean;
  suggested_sequence: string[];   // Feature IDs in recommended order
  collision_warnings: Array<{
    bend_id_a: string;
    bend_id_b: string;
    description: string;
  }>;
}
```

---

## `simulate_nesting`

**Category**: Optimization  
**Spec Reference**: FR-006

### Input
```typescript
{
  unfold_ids: string[];       // Array of UnfoldId
  sheet_size: {
    width_mm: number;
    height_mm: number;
    label?: string;
  };
}
```

### Output
```typescript
{
  nest_id: string;            // NestId
  utilisation_pct: number;    // 0–100
  sheets_required: number;
  placements: Array<{
    unfold_id: string;
    sheet_index: number;
    x: number;
    y: number;
    rotation_deg: number;
  }>;
}
```

### Error Codes
- `GE_NEST_FAILED`: Nesting algorithm failed
- `GE_UNFOLD_NOT_FOUND`

---

## `export_production_pack`

**Category**: Export (Async)  
**Spec Reference**: FR-007 (Constitution Principle IX — async-only)

### Input
```typescript
{
  nest_id: string;            // NestId from simulate_nesting
  include_bom: boolean;
  include_assembly: boolean;
}
```

### Output (immediate — job enqueued)
```typescript
{
  job_id: string;
  status: 'queued';
  estimated_duration_sec?: number;
}
```

**NOTE**: This tool returns immediately with `job_id`. The caller MUST poll `get_export_job_status` and then call `get_export_job_result`. Synchronous completion is not permitted (Constitution Principle IX).

---

## `get_export_job_status`

**Category**: Export  
**Spec Reference**: FR-007

### Input
```typescript
{
  job_id: string;
}
```

### Output
```typescript
{
  job_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;           // 0–100
  created_at: number;         // Unix epoch ms
  completed_at?: number;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    suggested_tool?: string;
  };
}
```

---

## `get_export_job_result`

**Category**: Export  
**Spec Reference**: FR-007

### Input
```typescript
{
  job_id: string;
}
```

### Output
```typescript
{
  job_id: string;
  files: Array<{
    type: 'dxf' | 'step' | 'bom_csv' | 'assembly_json' | 'svg_preview';
    path: string;
    size_bytes: number;
  }>;
  total_time_ms: number;
}
```

### Error Codes
- `EXPORT_JOB_NOT_FOUND`
- `EXPORT_JOB_NOT_COMPLETE`: Job still running; call `get_export_job_status` first

---

## `rollback`

**Category**: State Management  
**Spec Reference**: FR-008 (Constitution Principle IV)

### Input
```typescript
{
  rollback_token: string;     // RollbackToken from a previous mutating operation
}
```

### Output
```typescript
{
  restored_solid_ids: string[];
  restored_shell_ids: string[];
  snapshot_label: string;
}
```

### Error Codes
- `GE_SNAPSHOT_NOT_FOUND`: `rollback_token` does not reference a valid snapshot
- `GE_RESTORE_FAILED`: Snapshot state could not be restored
