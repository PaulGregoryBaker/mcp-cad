# Quick-Start Guide: Graph-Driven Geometry Pipeline

**Phase**: Phase 1 Complete  
**Date**: 2026-06-08  
**Target Audience**: Developers implementing Phase 2 tasks

---

## Overview

This guide walks through building, testing, and manually validating the Graph-Driven Geometry Pipeline feature.

## Prerequisites

- Node.js 22+
- Python 3.11+ (for OpenCASCADE dependency resolution)
- CMake 3.26+
- MSVC or GCC (C++17)
- Git (for running test fixtures)

## Build Instructions

### 1. Build TypeScript

```bash
cd ts
npm ci                    # Install dependencies
npm run build             # Compile TypeScript
# Output: ts/dist/index.js
```

### 2. Build C++ Addon

```bash
cd cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
# Output: cpp/build/Release/geometry_addon.node
# Symlink or copy to ts/geometry_addon.node
cp cpp/build/Release/geometry_addon.node ../ts/geometry_addon.node
```

### 3. Verify Addon Loads

```bash
cd ts
node -e "console.log(require('./geometry_addon.node'))"
# Should print: { buildSheetFromDxf: [Function], thickenSheet: [Function], ... }
```

## Running Tests

### Unit Tests

```bash
cd ts
npm test -- ts/tests/unit/

# Example output:
# ✓ ts/tests/unit/geometry/rebuild-queue.test.ts (15 tests)
# ✓ ts/tests/unit/manufacturing/mutation-rules.test.ts (12 tests)
# ✓ ts/tests/unit/geometry/validator.test.ts (18 tests)
# Test Files  3 passed (3)
# Tests  45 passed (45)
```

### Integration Tests

```bash
cd ts
npm test -- ts/tests/integration/

# Example output:
# ✓ ts/tests/integration/split-with-rebuild.integration.test.ts (8 tests)
# ✓ ts/tests/integration/merge-with-rebuild.integration.test.ts (6 tests)
# ✓ ts/tests/integration/bend-param-modify.integration.test.ts (5 tests)
# Test Files  3 passed (3)
# Tests  19 passed (19)
```

### Contract Tests

```bash
cd ts
npm test -- ts/tests/contract/

# Validates error codes and "Not yet supported" messages
```

### All Tests

```bash
cd ts
npm test                  # Run all test suites
```

## Manual Validation

### Scenario 1: Split-by-Bends with Async Rebuild

**Expected behavior**: 
- Split operation returns immediately
- Cached geometry displayed
- Progress indicator shows "Computing..."
- Final geometry appears after ~1 second

**Steps**:

1. Start MCP server:
   ```bash
   cd ts
   node dist/index.js
   ```

2. In client (e.g., Claude Desktop or test script):
   ```typescript
   // Load a sample part (STEP file)
   const result = await mcp.call_tool('load_model', { 
     model_path: 'fixtures/box_with_bends.step' 
   });
   const partId = result.part_id;
   
   // Trigger split
   const splitResult = await mcp.call_tool('split_body_by_bends', {
     part_id: partId,
     angle_threshold_deg: 30
   });
   
   // split_body_by_bends should return IMMEDIATELY with:
   // {
   //   status: 'success',
   //   task_id: 'task-123',
   //   operation: 'queued',
   //   cached_geometry: { shellId: '...', isFinal: false },
   //   parts_created: ['part-A', 'part-B'],
   //   message: 'Split queued. Geometry rebuilding in background.'
   // }
   
   // Poll progress
   const progress = await mcp.call_tool('get_progress', { 
     task_id: splitResult.task_id 
   });
   // { status: 'executing', percent: 45, message: 'Rebuilding part-A...' }
   
   // Wait for completion
   setTimeout(() => {
     const final = await mcp.call_tool('get_progress', { 
       task_id: splitResult.task_id 
     });
     // { status: 'complete', percent: 100, message: 'Complete' }
   }, 2000);
   ```

3. **Verify in viewport**:
   - Sub-parts visible immediately (cached geometry)
   - Progress bar animates for ~1 second
   - Final geometry appears sharper/more detailed
   - No flickering or intermediate incomplete states

### Scenario 2: Unsupported Mutation (Fuse)

**Expected behavior**: 
- Fuse operation is rejected immediately
- Clear error message: "Not yet supported: Fuse operations deferred to Phase 2+"
- No graph mutation occurs

**Steps**:

```typescript
const fuseResult = await mcp.call_tool('fuse_bodies', {
  part_a_id: 'part-A',
  part_b_id: 'part-B'
});

// Should return:
// {
//   error: {
//     code: 'GE_UNSUPPORTED_MUTATION',
//     message: 'Not yet supported: Fuse operations deferred to Phase 2+. Supported mutations: split-by-bends, merge-by-bend, modify bend parameters',
//     recoverable: false
//   }
// }
```

### Scenario 3: Graph/DXF Divergence Recovery

**Expected behavior**: 
- Rebuild detects divergence
- Operation fails with "Graph divergence" error
- User offered repair options (recompute or revert)

**Steps** (simulated):

```typescript
// Manually corrupt the graph to trigger divergence detection
// (In real use, this shouldn't happen; this validates the safety net)

const validateResult = await mcp.call_tool('validate_manufacturing_graph', {
  part_id: partId
});

// If divergence detected:
// {
//   valid: false,
//   divergences: [
//     {
//       type: 'null_dxf',
//       panelId: 'panel-1',
//       message: 'Panel DXF not seeded'
//     }
//   ],
//   repair_options: ['recompute_dxf', 'revert_mutation'],
//   recovery_tool: 'repair_manufacturing_graph'
// }

// Repair by recomputing DXF
const repairResult = await mcp.call_tool('repair_manufacturing_graph', {
  part_id: partId,
  strategy: 'recompute_dxf'
});

// { status: 'success', message: 'DXF recomputed from graph' }
```

### Scenario 4: Rapid Sequential Mutations (Stress Test)

**Expected behavior**: 
- 10+ split operations queued rapidly
- All complete without data corruption
- Rebuild queue processes in dependency order

**Steps**:

```typescript
// Queue 10 splits in rapid succession
const taskIds = [];
for (let i = 0; i < 10; i++) {
  const result = await mcp.call_tool('split_body_by_bends', {
    part_id: partId,
    angle_threshold_deg: 30
  });
  taskIds.push(result.task_id);
}

// All should return immediately
console.log(`${taskIds.length} rebuilds queued`);

// Wait for all to complete
await Promise.all(
  taskIds.map(id => 
    new Promise(resolve => {
      const checkProgress = setInterval(async () => {
        const progress = await mcp.call_tool('get_progress', { task_id: id });
        if (progress.status === 'complete') {
          clearInterval(checkProgress);
          resolve(progress);
        }
      }, 200);
    })
  )
);

// All 10 rebuilds should complete without corruption
console.log('✓ All 10 rebuilds completed successfully');
```

## Performance Baseline

Expected timings on standard hardware (Ryzen 5/i7):

| Operation | Time | Notes |
|-----------|------|-------|
| Split 2-panel box | 50-100ms | Geometry rebuild |
| Merge 2 panels | 100-200ms | Graph merge + rebuild |
| Modify bend angle | 50-150ms | Rebuild only |
| 10 rapid splits | 800-1200ms total | Sequential queue processing |
| 100-panel stress test | 800-1000ms | Worst-case linear assembly |

**Key metric**: **Operation returns within 200ms; final geometry ready within 2 seconds.**

## Debugging

### Enable Verbose Logging

```bash
DEBUG=mcp-cad:* node dist/index.js
```

### Check Rebuild Queue State

```typescript
// In development builds, RebuildManager exposes queue state
const queueState = await mcp.call_tool('debug_get_queue_state', {});
console.log(queueState);
// {
//   queued: 3,
//   executing: 1,
//   completed: 47,
//   tasks: [
//     { id: 'task-123', status: 'executing', progress: 45 },
//     { id: 'task-124', status: 'queued', progress: 0 },
//     ...
//   ]
// }
```

### Validate Graph Consistency

```typescript
const validation = await mcp.call_tool('validate_manufacturing_graph', {
  part_id: partId,
  verbose: true
});

console.log(validation);
// {
//   valid: true,
//   panels: [
//     { id: 'panel-1', dxf_valid: true, thickness_valid: true },
//     { id: 'panel-2', dxf_valid: true, thickness_valid: true }
//   ],
//   bends: [
//     { id: 'bend-1', angle_valid: true, radius_valid: true }
//   ],
//   divergences: []
// }
```

## Troubleshooting

### Build Failures

**C++ addon not found**: 
- Ensure `cpp/build/Release/geometry_addon.node` exists
- Copy to `ts/geometry_addon.node`
- Verify NAPI exports with `node -e "require('./ts/geometry_addon.node')"`

**TypeScript build errors**:
- Run `npm ci` to ensure clean install
- Check tsconfig.json references

### Test Failures

**Integration tests timeout**:
- Increase Vitest timeout in `ts/vitest.config.ts`
- Check that C++ addon loads correctly
- Verify STEP fixtures exist in `cpp/tests/fixtures/`

**Progress indicator not showing**:
- Verify RebuildManager is emitting progress events
- Check that UI/client is subscribing to progress channel

### Performance Issues

**Rebuilds taking >2 seconds**:
- Profile C++ geometry operations
- Check for blocking I/O or synchronous operations
- Verify no console.log statements in hot paths

---

## Next Steps

1. **Run all tests** to confirm integration
2. **Validate error codes** against contract spec
3. **Benchmark performance** on target hardware
4. **Manual validation** of all four scenarios above
5. **Proceed to Phase 2 tasks** (task breakdown generation)
