# Contract: Mutation Handlers (Split, Merge, Bend-Param)

**Phase**: Phase 1 Design  
**Date**: 2026-06-08  
**Status**: Approved for Implementation

---

## Overview

This contract defines how mutation operations (split-by-bends, merge-by-bend, modify-bend-params) integrate with the async rebuild system.

## Mutation Handler Pattern

All three mutation types follow the same pattern:

```typescript
async function handleMutation(request: MutationRequest): Promise<MutationResponse> {
  // 1. Validate mutation is supported
  if (!isSupportedMutation(mutationType)) {
    return error('GE_UNSUPPORTED_MUTATION');
  }
  
  // 2. Validate payload
  const validation = await validateMutation(partId, mutationType, payload);
  if (!validation.valid) {
    return error('GE_INVALID_MUTATION');
  }
  
  // 3. Execute graph mutation (synchronous, fast)
  const graphResult = await executeGraphMutation(partId, payload);
  
  // 4. Schedule async rebuild
  const rebuild = await rebuildManager.scheduleRebuild(partId, mutationType, payload);
  
  // 5. Return immediately with cached geometry
  return {
    status: 'success',
    taskId: rebuild.taskId,
    operation: 'queued',
    cachedGeometry: rebuild.cachedGeometry,
    graphResult: graphResult, // Graph updates
    message: 'Mutation queued. Geometry rebuilding in background.'
  };
}
```

---

## Split-by-Bends Handler

**Endpoint**: `split_body_by_bends`

### Request

```typescript
{
  part_id: string;
  angle_threshold_deg: number;     // Min dihedral angle for bend detection
  default_thickness_mm?: number;   // For surface-mode parts
  max_thickness_mm?: number;       // Thin-solid detection threshold
}
```

### Response (Success)

```typescript
{
  status: 'success';
  taskId: string;
  operation: 'queued';
  
  // Graph mutations completed synchronously
  parts_created: string[];         // IDs of new sub-parts
  panels: {
    [partId]: string[];           // Panel IDs per part
  };
  
  // Async rebuild
  cachedGeometry: {
    shellId: string;
    isFinal: false;
  };
  estimated_rebuild_time_ms: number;
  
  message: string;
}
```

### Response (Error)

**Unsupported mutation**:
```typescript
{
  error: {
    code: 'GE_UNSUPPORTED_MUTATION';
    message: 'Not yet supported: Split operation. Supported mutations: split-by-bends, merge-by-bend, modify bend parameters';
    recoverable: false;
  }
}
```

**Invalid part**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Part not found: {part_id}';
    recoverable: false;
  }
}
```

**Impossible topology**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Part contains non-planar faces; cannot split at bends';
    recoverable: false;
  }
}
```

---

## Merge-by-Bend Handler

**Endpoint**: `merge_bodies_with_bend`

### Request

```typescript
{
  part_a_id: string;
  part_b_id: string;
  
  // Bend specification (optional; inferred if not provided)
  bend_angle_deg?: number;
  inner_radius_mm?: number;
  k_factor?: number;
}
```

### Response (Success)

```typescript
{
  status: 'success';
  taskId: string;
  operation: 'queued';
  
  // Graph mutations completed synchronously
  merged_part_id: string;
  new_bend_id: string;
  
  // Async rebuild
  cachedGeometry: {
    shellId: string;
    isFinal: false;
  };
  estimated_rebuild_time_ms: number;
  
  message: string;
}
```

### Response (Error)

**Unsupported mutation**:
```typescript
{
  error: {
    code: 'GE_UNSUPPORTED_MUTATION';
    message: 'Not yet supported: Fuse operation. Supported mutations: split-by-bends, merge-by-bend, modify bend parameters';
    recoverable: false;
  }
}
```

**Incompatible materials**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Cannot merge parts with different materials: {mat_a} vs {mat_b}';
    recoverable: false;
  }
}
```

**Incompatible thicknesses**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Cannot merge parts with different thicknesses: {thick_a} mm vs {thick_b} mm';
    recoverable: false;
  }
}
```

---

## Modify-Bend-Parameters Handler

**Endpoint**: `modify_bend_parameters` (NEW)

### Request

```typescript
{
  part_id: string;
  bend_id: string;
  
  // At least one parameter must be specified
  angle_deg?: number;
  inner_radius_mm?: number;
  k_factor?: number;
}
```

### Response (Success)

```typescript
{
  status: 'success';
  taskId: string;
  operation: 'queued';
  
  // Graph mutations completed synchronously
  bend: {
    id: string;
    angle_deg: number;
    inner_radius_mm: number;
    k_factor: number;
  };
  
  // Async rebuild
  cachedGeometry: {
    shellId: string;
    isFinal: false;
  };
  estimated_rebuild_time_ms: number;
  
  message: string;
}
```

### Response (Error)

**Bend not found**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Bend not found: {bend_id}';
    recoverable: false;
  }
}
```

**Invalid parameter value**:
```typescript
{
  error: {
    code: 'GE_INVALID_MUTATION';
    message: 'Bend angle must be 1-179 degrees; got {value}';
    recoverable: false;
  }
}
```

---

## Unsupported Mutations

The following mutations are explicitly unsupported in Phase 1 and return a consistent error:

**Operations rejected**:
- Fuse / Boolean union
- Trim / Cut / Hole operations
- Flange / Tab additions
- Any operation not explicitly listed above

### Response

```typescript
{
  error: {
    code: 'GE_UNSUPPORTED_MUTATION';
    message: 'Not yet supported: {operation}. Supported mutations: split-by-bends, merge-by-bend, modify bend parameters';
    recoverable: false;
  }
}
```

**Pattern**:
- Code: Always `GE_UNSUPPORTED_MUTATION`
- Message: "Not yet supported: {operation name}. Supported mutations: [list]"
- Recoverable: Always `false` (Phase 2+ may change this)

---

## Validation Rules

### Split-by-Bends Validation

1. Part must exist in manufacturing graph
2. Part must not be empty (have at least one panel)
3. All faces must be planar (required for DXF representation)
4. Angle threshold must be >= 0.1° and <= 179.9°

### Merge-by-Bend Validation

1. Both parts must exist
2. Both must be in manufacturing-graph mode (have DXF)
3. Materials must match
4. Thicknesses must match (within 0.01mm tolerance)
5. Panels must be coplanar (or within 2° dihedral tolerance)
6. Bend angle must be 1-179° (90° preferred for Phase 1)

### Modify-Bend-Parameters Validation

1. Part must exist
2. Bend must exist in part's manufacturing graph
3. Angle: 1-179°
4. Inner radius: 0.1 mm to 50 mm
5. K-factor: 0.25-0.5
6. At least one parameter must change

---

## Graph Mutation Atomicity

**Guarantee**: All mutations are atomic at the graph level.

- If any validation fails, **no graph changes occur**
- If graph mutation succeeds but rebuild fails, **graph remains mutated** (cached geometry provides fallback; user can revert)
- No partial graph states visible to user

---

## Rebuild Integration

### Rebuild Payload

Each mutation type provides a rebuild payload for validation and progress reporting:

```typescript
// Split
{
  mutationType: 'split',
  originalPartId: string,
  panelIds: string[],
  angle_threshold_deg: number
}

// Merge
{
  mutationType: 'merge',
  panelAId: string,
  panelBId: string,
  bendId: string,
  angle_deg: number,
  innerRadius: number,
  kFactor: number
}

// Bend-param-modify
{
  mutationType: 'bend-param-modify',
  bendId: string,
  angle_deg?: number,
  innerRadius_mm?: number,
  kFactor?: number
}
```

---

## Testing Requirements

- Unit tests: Validation rules for each mutation type
- Integration tests: Split/merge/param-modify with async rebuild
- Error contract tests: Unsupported operations return correct error code + message
- Edge case tests: Invalid geometries, missing parameters, conflicting constraints

---

## Future Extensions (Phase 2+)

- Fuse operation support
- Trim/cut support
- Flange/tab support
- Arbitrary bend angles (beyond 90°)
- Multi-part assemblies
