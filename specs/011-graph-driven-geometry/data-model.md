# Data Model: Graph-Driven Geometry Pipeline

**Phase**: Phase 1 Design  
**Status**: Complete  
**Date**: 2026-06-08

---

## Core Entities

### GeometryRebuildTask

Represents a single async rebuild job triggered by a mutation operation.

```typescript
interface GeometryRebuildTask {
  id: string;                          // Unique task identifier (UUID)
  partId: string;                      // Part being rebuilt
  mutationType: SupportedMutationType; // 'split' | 'merge' | 'bend-param-modify'
  createdAt: number;                   // Unix timestamp when task was enqueued
  
  // Mutation context (varies by type)
  payload: SplitPayload | MergePayload | BendParamPayload;
  
  // Dependencies: this task waits for these tasks to complete
  dependsOn: string[];                 // Array of task IDs
  
  // Execution state
  status: 'queued' | 'executing' | 'complete' | 'failed' | 'cancelled';
  startedAt?: number;
  completedAt?: number;
  duration?: number;                   // Milliseconds
  
  // Result
  result?: GeometryRebuildResult;
  error?: StructuredError;
}

type SupportedMutationType = 'split' | 'merge' | 'bend-param-modify';

interface SplitPayload {
  originalPartId: string;
  panelIds: string[];                  // New sub-part IDs created by split
}

interface MergePayload {
  panelAId: string;
  panelBId: string;
  bendId: string;                      // New BendNode connecting panels
}

interface BendParamPayload {
  bendId: string;
  parameterChanges: {
    angle?: number;
    innerRadius?: number;
    kFactor?: number;
  };
}
```

### GeometryRebuildQueue

Manages async rebuild tasks with ordering and dependency tracking.

```typescript
class GeometryRebuildQueue {
  private queue: GeometryRebuildTask[] = [];
  private executing = false;
  private activeTask?: GeometryRebuildTask;
  
  enqueue(task: GeometryRebuildTask): string {
    // Add task to queue; return task ID
    // Non-blocking; returns immediately
    // Triggers async processing
  }
  
  getTaskStatus(taskId: string): GeometryRebuildTask | null {
    // Returns current task state (for progress tracking)
  }
  
  cancel(taskId: string): boolean {
    // Cancels queued task; no-op if already executing
  }
  
  private async processQueue(): Promise<void> {
    // Main event loop
    // - Dequeue next task
    // - Wait for dependencies
    // - Execute rebuild
    // - Handle errors
    // - Emit progress events
  }
}
```

### RebuildManager

Coordinates rebuild queue, caching, and progress tracking.

```typescript
interface RebuildManager {
  // Initiate a rebuild (internal use only; called by mutation handlers)
  scheduleRebuild(
    partId: string,
    mutationType: SupportedMutationType,
    payload: any
  ): Promise<{ taskId: string; cachedGeometry: CachedGeometry }>;
  
  // Query rebuild status
  getProgress(taskId: string): RebuildProgress | null;
  
  // Subscribe to progress updates
  on(event: 'progress' | 'complete' | 'error', callback: Function): void;
  
  // Internal execution
  executeRebuild(task: GeometryRebuildTask): Promise<GeometryRebuildResult>;
}

interface CachedGeometry {
  partId: string;
  shellId: string;  // OCCT shell ID from before mutation
  timestamp: number;
  isFinal: boolean; // false while rebuild in progress
}

interface RebuildProgress {
  taskId: string;
  status: 'queued' | 'executing' | 'complete' | 'failed';
  percentComplete: number; // 0-100
  elapsed: number;         // Milliseconds
  estimated: number;       // Estimated remaining (if known)
  message: string;         // "Geometry: Computing..." etc.
}

interface GeometryRebuildResult {
  partId: string;
  shellId: string;
  dxfValid: boolean;
  geometryValid: boolean;
  divergences: GraphValidationResult['divergences'];
  finalGeometry: Geometry3D;  // OCCT shell or equivalent
}
```

### GraphValidator

Detects and reports graph/DXF consistency issues.

```typescript
interface GraphValidationResult {
  isValid: boolean;
  panelId: string;
  divergences: Array<{
    type: 'null_dxf' | 'entity_mismatch' | 'parameter_mismatch' | 'orphan_dxf' | 'thickness_mismatch';
    panelId?: string;
    bendId?: string;
    expected: string;
    actual: string;
    severity: 'error' | 'warning';
  }>;
  canAutoRepair: boolean;
  suggestedRepair?: 'recompute_dxf' | 'revert_mutation';
}

interface GraphValidator {
  // Validates entire manufacturing graph against DXF representations
  validateGraphDxfConsistency(graph: ManufacturingGraph): GraphValidationResult;
  
  // Validates a single panel
  validatePanel(panel: PanelNode): { valid: boolean; issues: string[] };
  
  // Validates a bend
  validateBend(bend: BendNode): { valid: boolean; issues: string[] };
  
  // Suggests repair strategy
  suggestRepair(result: GraphValidationResult): 'recompute' | 'revert' | 'manual';
  
  // Repairs DXF from graph (recomputes unfold)
  repairDxf(partId: string, panelId: string): Promise<string>; // Returns new DXF string
}
```

### MutationValidator

Determines if a mutation is supported and valid.

```typescript
interface MutationValidationResult {
  supported: boolean;
  valid: boolean;
  errors: Array<{
    code: string; // 'GE_UNSUPPORTED_MUTATION', 'GE_INVALID_MUTATION', etc.
    message: string;
    recoverable: boolean;
    suggested_tool?: string;
  }>;
}

interface MutationValidator {
  // Determines if mutation type is supported in Phase 1
  isSupportedMutation(mutationType: string): {
    supported: boolean;
    reason?: string; // "Not yet supported: Fuse operations in Phase 2+"
  };
  
  // Validates mutation preconditions
  validateMutation(
    partId: string,
    mutationType: SupportedMutationType,
    payload: any
  ): Promise<MutationValidationResult>;
}
```

---

## State Transitions

### Mutation Lifecycle

```
User initiates mutation (split/merge/bend-param)
    ↓
MutationValidator.validateMutation() checks if supported
    ↓ (if unsupported)
ERROR: "Not yet supported: {operation}" → User sees error, no graph change
    ↓ (if supported)
Graph mutation executes (graph updated immediately)
    ↓
CachedGeometry prepared (snapshot of previous geometry)
    ↓
RebuildManager.scheduleRebuild() creates task
    ↓ (returns immediately)
Operation returns to user with { taskId, cachedGeometry }
    ↓ (ASYNC in background)
GeometryRebuildQueue processes task
    ↓ (Task waits for dependencies)
Rebuild executes: buildSheetFromDxf → thickenSheet → applyBend
    ↓
GraphValidator.validateGraphDxfConsistency() checks result
    ↓ (if divergence detected)
ERROR: "Graph divergence detected" → repair options offered (recompute/revert)
    ↓ (if valid)
Final geometry displayed; progress indicator cleared
    ↓
Viewport updated with new geometry
```

### Rebuild Queue Processing

```
Task A enqueued (split part X)
    ↓ (immediately after)
Task B enqueued (merge panels from X)
    ↓
Queue: [A, B]
    ↓
Process Task A → completes (800ms)
    ↓
Process Task B → waits for Task A (dependency)
    ↓
Task B executes → completes
    ↓
Queue empty; all tasks processed
```

### Error Recovery

```
Rebuild fails (divergence detected)
    ↓
Error reported to user: "Graph divergence in panel P1"
    ↓
Repair options offered:
  - Option 1: Recompute DXF from graph
  - Option 2: Revert last mutation
    ↓ (User selects option)
GraphValidator.repairDxf() or mutation rollback executes
    ↓
New rebuild task scheduled
    ↓
Final geometry updated
```

---

## Type Extensions (Existing Types Enhanced)

### PanelNode (ts/src/manufacturing/graph/types.ts)

```typescript
// EXISTING:
export interface PanelNode {
  id: string;
  partId: string;
  thickness: number;
  material: string;
  shapeDxf: string | null;
  // ... other properties
}

// NO CHANGES NEEDED
// (shapeDxf already exists from prior implementation)
```

### BendNode (ts/src/manufacturing/graph/types.ts)

```typescript
// EXISTING:
export interface BendNode {
  id: string;
  partId: string;
  panelAId: string;
  panelBId: string;
  angle: number;
  innerRadius: number;
  kFactor: number;
  // ... other properties
}

// NO CHANGES NEEDED
// (All required properties already exist)
```

---

## Error Codes (Structured Errors)

All errors follow the format:

```typescript
interface StructuredError {
  code: string;
  message: string;
  recoverable: boolean;
  suggested_tool?: string;
  details?: Record<string, any>;
}
```

**Error codes**:

| Code | HTTP Status | Message | Recoverable | Suggested Tool |
|------|-------------|---------|-------------|----------------|
| `GE_UNSUPPORTED_MUTATION` | 400 | "Not yet supported: {operation}. Supported operations: split-by-bends, merge-by-bend, modify bend parameters" | No | N/A |
| `GE_INVALID_MUTATION` | 400 | "Invalid mutation: {reason}" | Maybe | N/A |
| `GE_GRAPH_DXF_DIVERGENCE` | 500 | "Graph/DXF divergence detected in {panel}. Repair options: (1) Recompute DXF, (2) Revert mutation" | Yes | `repair_divergence` (internal) |
| `GE_REBUILD_TIMEOUT` | 504 | "Geometry rebuild timed out after 5 seconds" | Yes | Retry (user manually) |
| `GE_REBUILD_FAILED` | 500 | "Geometry rebuild failed: {reason}" | Maybe | Check geometry logs |
| `GE_VALIDATION_ERROR` | 400 | "{validation failure details}" | No | N/A |

---

## Implementation Notes

1. **Async/await pattern**: All rebuild operations use native JavaScript Promises; no callback hell
2. **Progress events**: RebuildManager emits progress updates on 100-200ms interval; UI subscribes for real-time feedback
3. **Dependency tracking**: Simple array of task IDs; queue processes in order respecting dependencies
4. **No parallelization**: Phase 1 processes tasks sequentially (matching Node.js single-threaded model)
5. **Cached geometry stability**: Cached geometry is immutable during rebuild; final geometry replaces it atomically
