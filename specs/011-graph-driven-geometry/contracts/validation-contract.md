# Contract: Graph/DXF Validation & Consistency

**Phase**: Phase 1 Design  
**Date**: 2026-06-08  
**Status**: Approved for Implementation

---

## Overview

This contract defines the graph/DXF validation system that detects and reports inconsistencies between the manufacturing graph (authoritative source) and the DXF representations (engineering drawings).

---

## Validation API

### validateGraphDxfConsistency()

**Signature**:
```typescript
validateGraphDxfConsistency(graph: ManufacturingGraph): Promise<GraphValidationResult>
```

**Input**:
- A manufacturing graph (from a part with manufacturing-graph tracking enabled)

**Output**:
```typescript
interface GraphValidationResult {
  partId: string;
  isValid: boolean;
  timestamp: number;
  
  divergences: Array<{
    type: DiverenceType;
    severity: 'error' | 'warning';
    panelId?: string;
    bendId?: string;
    expected: string;
    actual: string;
    message: string;
  }>;
  
  canAutoRepair: boolean;
  suggestedRepair?: 'recompute_dxf' | 'revert_mutation' | 'manual_review';
  
  summary: {
    panelsValidated: number;
    bendsValidated: number;
    divergencesFound: number;
    errorCount: number;
    warningCount: number;
  };
}

type DiverenceType = 
  | 'null_dxf'               // Panel has no DXF seeded
  | 'entity_mismatch'        // DXF entity count doesn't match graph
  | 'parameter_mismatch'     // Stored param differs from graph (thickness, material)
  | 'orphan_dxf'             // DXF exists but panel not in graph
  | 'thickness_mismatch'     // Panel thickness inconsistent with DXF implied geometry
  | 'material_mismatch'      // Material property inconsistent
  | 'bend_angle_mismatch'    // Bend angle parameter mismatch
  | 'kfactor_mismatch'       // K-factor parameter mismatch
  | 'malformed_dxf'          // DXF string unparseable
;
```

**Behavior**:
- Validates entire graph (all panels and bends)
- Non-destructive; does not modify graph or DXF
- Completes in <100ms for typical parts
- Detailed error reporting with repair suggestions

**Error cases**:
- Part not found: `StructuredError` with code `GE_PART_NOT_FOUND`
- Graph not in manufacturing-graph mode: No error; returns `isValid: false` with explanation

---

### suggestRepair()

**Signature**:
```typescript
suggestRepair(validation: GraphValidationResult): RepairStrategy

type RepairStrategy = 'recompute_dxf' | 'revert_mutation' | 'manual_review';
```

**Behavior**:
- Recommends repair strategy based on divergence types
- Returns deterministic suggestion (same input → same output)

**Strategy rules**:
- **recompute_dxf**: Divergences are parameter mismatches or null_dxf → recompute drawing from graph
- **revert_mutation**: Last mutation caused divergence → revert to previous state
- **manual_review**: Multiple divergence types or uncertain cause → require user judgment

---

## Repair Operations

### repairDxf()

**Signature**:
```typescript
repairDxf(
  partId: string,
  panelId: string
): Promise<{ dxf: string; panelUpdated: boolean }>
```

**Behavior**:
- Recomputes DXF from panel's manufacturing graph node
- Updates panel.shapeDxf with new DXF
- Non-destructive if recomputation fails; returns error without modifying state

**Use case**: After divergence detection, user chooses "Repair by recomputing DXF"

---

### revertMutation()

**Signature**:
```typescript
revertMutation(partId: string): Promise<{
  success: boolean;
  reverted_to_state: string; // Previous graph state ID
}>
```

**Behavior**:
- Reverts manufacturing graph to state before last mutation
- Cached geometry replaced with previous final geometry
- New rebuild scheduled for reverted geometry

**Constraints**:
- Only one level of undo (last mutation only)
- Cannot undo beyond initial part creation

**Use case**: After divergence detection, user chooses "Revert last mutation"

---

## Divergence Detection Rules

### null_dxf (Error)

**Condition**: Panel exists in graph but `panel.shapeDxf === null`

**Cause**: 
- Panel created without DXF seed (shouldn't happen in Phase 1; all operations seed DXF)
- Bug in mutation handler

**Recovery**:
- recompute_dxf: Yes (unfold panel to generate DXF)
- revert_mutation: Yes

---

### entity_mismatch (Error)

**Condition**: DXF LWPOLYLINE entity count differs from expected

**Examples**:
- Graph has 1 bend; DXF has 0 layer-0 polylines
- Graph modified but DXF not updated

**Recovery**:
- recompute_dxf: Yes
- revert_mutation: Yes

---

### parameter_mismatch (Error)

**Condition**: Stored parameter (thickness, material, K-factor) differs from what's in graph

**Examples**:
- Panel thickness changed in graph but old value persists in DXF metadata
- K-factor in BendNode differs from what DXF was unfolded with

**Recovery**:
- recompute_dxf: Yes (regenerate with current parameters)
- revert_mutation: Maybe (if caused by recent mutation)

---

### thickness_mismatch (Error)

**Condition**: Panel thickness inconsistent with DXF-implied 3D geometry

**Examples**:
- DXF area + thickness implies volume X; actual panel geometry is volume Y
- Unit mismatch (DXF in mm; thickness in different unit)

**Recovery**:
- recompute_dxf: Yes
- Manual review: Required if units ambiguous

---

### orphan_dxf (Warning)

**Condition**: DXF exists but panel not in manufacturing graph

**Cause**:
- Partial undo/redo not cleaned up properly
- Debugging artifact

**Recovery**:
- Manual review: Orphaned DXF can be ignored (won't affect geometry)
- No action required; rebuild proceeds normally

---

### bend_angle_mismatch (Error)

**Condition**: BendNode.angle differs from angle used in last unfold

**Examples**:
- Angle changed from 90° to 85° but DXF not regenerated
- User modifies angle; DXF becomes stale

**Recovery**:
- recompute_dxf: Yes

---

## Validation in Rebuild Lifecycle

### During Mutation

```
User executes mutation (split/merge/bend-param)
    ↓
Mutation handler updates graph
    ↓
Rebuild scheduled
    ↓
(ASYNC) Rebuild executes
    ↓
Geometry reconstructed via pipeline
    ↓
validateGraphDxfConsistency() called
    ↓ (if divergence detected)
Rebuild fails with GE_GRAPH_DXF_DIVERGENCE
    ↓ (repair suggestions offered)
User chooses: recompute_dxf or revert_mutation
    ↓
Repair operation executes
    ↓
New rebuild scheduled
    ↓
Final geometry displayed
```

### Periodic Validation (Optional)

In future phases, consider:
- Periodic background validation of all manufacturing-graph parts
- "Health check" tool that identifies divergences
- Auto-repair with user notification

---

## Performance Contract

| Operation | Target |
|-----------|--------|
| validateGraphDxfConsistency (20 panels) | <50ms |
| validateGraphDxfConsistency (100 panels) | <100ms |
| suggestRepair | <1ms |
| repairDxf (single panel) | <100ms |
| revertMutation | <50ms |

---

## Error Handling

All divergences are categorized as **Error** or **Warning**:

- **Error**: Blocks rebuild; must be repaired before operation completes
- **Warning**: Noted but rebuild proceeds; user can ignore or address later

---

## Testing Requirements

- Unit tests: Each divergence type detected correctly
- Edge case tests: Null DXF, malformed DXF, missing parameters
- Integration tests: Divergence triggered by intentional corruption; repair successful
- Contract tests: Repair suggestions deterministic and correct

---

## Future Extensions (Phase 2+)

- Schema validation: DXF structure matches defined schema
- Geometry validation: Rebuilt geometry matches expected bounding box
- Multi-level undo: Revert multiple mutations, not just last one
- Automatic periodic validation: Background health checks
- Divergence prevention: Pre-commit hooks before mutations
