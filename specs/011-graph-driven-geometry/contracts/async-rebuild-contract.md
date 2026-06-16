# Contract: Asynchronous Geometry Rebuild API

**Phase**: Phase 1 Design  
**Date**: 2026-06-08  
**Status**: Approved for Implementation

---

## Overview

This contract defines the interface and behavior of the asynchronous geometry rebuild system that powers mutation operations.

## RebuildManager Interface

All mutation operations (split, merge, bend-param-modify) return immediately through the RebuildManager, providing cached geometry and background rebuild capability.

### scheduleRebuild()

**Signature**:
```typescript
scheduleRebuild(
  partId: string,
  mutationType: 'split' | 'merge' | 'bend-param-modify',
  payload: unknown
): Promise<{
  taskId: string;
  cachedGeometry: { shellId: string; isFinal: false };
  estimated_rebuild_time: number;
}>
```

**Behavior**:
- Creates and enqueues a rebuild task
- Returns within 50ms (before any geometry work begins)
- Cached geometry provided immediately (from previous state)
- Background rebuild begins asynchronously

**Error cases**:
- Payload validation fails → `StructuredError` with code `GE_VALIDATION_ERROR` (synchronous)
- Task enqueue fails (queue full) → `StructuredError` with code `GE_QUEUE_FULL` (unlikely; queue is unbounded)

**Guarantees**:
- Non-blocking; never awaits geometry operations
- Task ID returned is guaranteed unique and valid
- Cached geometry is immutable during rebuild

---

### getProgress()

**Signature**:
```typescript
getProgress(taskId: string): {
  status: 'queued' | 'executing' | 'complete' | 'failed' | 'unknown';
  percentComplete: number; // 0-100
  elapsed: number;         // milliseconds
  estimated: number;       // milliseconds remaining (if known)
  message: string;         // Human-readable status
} | null
```

**Behavior**:
- Returns immediate progress snapshot
- Returns `null` if task ID not found
- Progress updates available every 100-200ms during execution
- Completes within 1-2 seconds for typical 20-panel parts

**Error cases**:
- Invalid task ID → returns `null` (not an error)

**Guarantees**:
- Progress percentage never decreases
- "Complete" status means final geometry is ready
- "Failed" status includes error details in message

---

### on(event, callback)

**Signature**:
```typescript
on(
  event: 'progress' | 'complete' | 'error',
  callback: (data: ProgressEvent | CompleteEvent | ErrorEvent) => void
): void
```

**Events**:

#### ProgressEvent
```typescript
{
  taskId: string;
  status: 'queued' | 'executing' | 'complete';
  percentComplete: number;
  message: string;
}
```
Emitted every 100-200ms during rebuild.

#### CompleteEvent
```typescript
{
  taskId: string;
  partId: string;
  final: {
    shellId: string;
    isFinal: true;
    geometryValid: boolean;
  };
}
```
Emitted once when rebuild completes successfully.

#### ErrorEvent
```typescript
{
  taskId: string;
  error: StructuredError;
  recovery_options?: string[]; // ['recompute', 'revert']
}
```
Emitted if rebuild fails (e.g., graph divergence detected).

**Behavior**:
- Callbacks are non-blocking
- Multiple subscribers supported
- Events delivered in order

---

## GeometryRebuildQueue Behavior

The rebuild queue is internal to RebuildManager but defined here for clarity.

### Task Processing

**Ordering**:
- FIFO (first-in-first-out)
- Respects dependency constraints (tasks may wait for other tasks)

**Execution**:
- Sequential; one task at a time
- No parallelization (Node.js single-threaded model)

**Failure handling**:
- Failed task does not block subsequent tasks
- Error reported via ErrorEvent
- User offered recovery options

### Cached Geometry Semantics

**Before rebuild complete**:
- Viewport shows cached geometry (from previous state)
- `geometry.isFinal = false`
- Geometry is read-only; not updated until rebuild complete

**After rebuild complete**:
- Final geometry displayed
- `geometry.isFinal = true`
- Replaces cached geometry atomically (no flicker)

---

## Error Contract

All errors follow the structured format:

```typescript
interface StructuredError {
  code: string;           // Machine-readable code
  message: string;        // User-readable message
  recoverable: boolean;   // Can user retry?
  suggested_tool?: string; // What tool to call next
  details?: {             // Implementation details
    [key: string]: any;
  };
}
```

### Error Codes (Rebuild Context)

| Code | HTTP | Recoverable | Message | Suggested Action |
|------|------|-------------|---------|------------------|
| `GE_VALIDATION_ERROR` | 400 | No | Mutation validation failed: {details} | Check payload format |
| `GE_UNSUPPORTED_MUTATION` | 400 | No | Not yet supported: {operation}. Supported: split, merge, bend-param | Use supported operation |
| `GE_GRAPH_DXF_DIVERGENCE` | 500 | Yes | Graph/DXF divergence in {panel}: {details}. Repair: recompute or revert | Call repair_manufacturing_graph |
| `GE_REBUILD_TIMEOUT` | 504 | Yes | Rebuild timed out (>5s). Retrying may succeed | Retry operation |
| `GE_REBUILD_FAILED` | 500 | Maybe | Rebuild failed: {reason}. Check logs | Inspect logs; try revert |
| `GE_QUEUE_FULL` | 503 | Yes | Rebuild queue full (>1000 tasks). Try again later | Reduce concurrent operations |

---

## Performance Contract

### Response Time Guarantees

| Operation | Target | P95 | P99 |
|-----------|--------|-----|-----|
| `scheduleRebuild()` return | <50ms | <100ms | <150ms |
| Geometry rebuild (20 panels) | <500ms | <800ms | <1200ms |
| Geometry rebuild (100 panels) | <2s | <2.2s | <3s |
| `getProgress()` return | <5ms | <10ms | <50ms |

### Typical Timings

- **Mutation returns**: 50-100ms (operation + task enqueue)
- **Progress visible**: 100-200ms (first progress event)
- **Final geometry ready**: 500-2000ms (depending on part size)

### Scaling

- Queue latency: O(1) — doesn't increase with queue length
- Rebuild latency: O(n) where n = number of panels
- Progress event overhead: <1% of rebuild time

---

## Behavioral Guarantees

1. **Atomicity**: Rebuild either completes fully or fails; no partial geometry
2. **Ordering**: Tasks executed in order (respecting dependencies); no race conditions
3. **Immutability (cached)**: Cached geometry unchanged until rebuild complete
4. **Progress accuracy**: percentComplete never decreases; always accurate
5. **Error transparency**: All errors reported with clear code + message
6. **Non-blocking**: No operation blocks the main thread or event loop

---

## Backward Compatibility

- Existing mutation handlers (split, merge, etc.) are adapted to use RebuildManager
- RebuildManager is opt-in; legacy synchronous paths remain available (not used in Phase 1)
- Progress events are new; clients without progress handling simply ignore them

---

## Testing Requirements

- Unit tests: Queue ordering, dependency tracking, error handling
- Integration tests: Split/merge/bend-param with async rebuild
- Stress tests: 10+ rapid mutations; queue under load
- Contract tests: Error codes match specification; messages are correct
- Performance tests: Verify timing guarantees on target hardware

---

## Future Extensions

**Phase 2+**:
- Parallel rebuild (worker threads): Reduce rebuild time for complex parts
- Cancellation: Allow user to cancel in-progress rebuilds
- Priority queue: Prioritize user-initiated mutations over batch operations
- Streaming progress: Finer-grained progress updates (per-panel stage)
