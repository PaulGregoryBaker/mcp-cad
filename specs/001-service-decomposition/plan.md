# Implementation Plan: Service Decomposition Refactor

**Branch**: `013-service-decomposition` | **Date**: 2026-06-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-service-decomposition/spec.md`

## Summary

Both `cpp/src/geometry/geometry_service.cc` (9,242 lines) and `ts/src/mcp/tools.ts` (6,339 lines) are monolithic files containing the full implementation of their respective layers. This plan decomposes each into cohesive, single-concern modules by moving groups of methods into new files, co-locating TypeScript handler functions with their tool definitions, extracting shared state, and deleting dead code. No public interface or behaviour changes.

## Technical Context

**Language/Version**: C++17 (geometry engine) · TypeScript 5.x (MCP layer)

**Primary Dependencies**: OpenCASCADE (OCCT) in C++ · Node.js NAPI binding (N-API) · MCP SDK in TypeScript

**Storage**: In-memory geometry registry (session-scoped) — unchanged

**Testing**: Jest integration tests (`ts/tests/integration/`) · C++ tests via Node integration

**Target Platform**: Local Node.js process (stdio MCP transport)

**Project Type**: Library — geometry engine exposed as MCP tools

**Performance Goals**: Compile time and test run time must not regress; no runtime performance impact expected from a pure file-split refactor

**Constraints**: Public API surface (MCP tool names, argument schemas, return shapes, NAPI binding signatures) must be byte-identical before and after

**Scale/Scope**: ~15,600 lines across two files → ~10 C++ files + ~12 TypeScript modules

## Constitution Check

| Principle | Impact | Status |
|-----------|--------|--------|
| I. Deterministic Geometry | No logic change | ✅ PASS |
| II. Bounded Context Separation | Decomposition makes bounded contexts **more** explicit in file names | ✅ STRENGTHENS |
| III. Safety Filter Enforcement | Safety filter logic untouched | ✅ PASS |
| IV. Rollback-First State | Rollback logic untouched | ✅ PASS |
| V. Kerf Compensation | Kerf logic untouched | ✅ PASS |
| VI. Structured Errors | Error model untouched | ✅ PASS |
| VII. MVP Scope Discipline | Pure restructuring — no features added | ✅ PASS |
| VIII. Configuration Over Hard-Coding | No config changes | ✅ PASS |
| IX. Async Export Contract | Async export logic untouched | ✅ PASS |
| X. Graceful Failure | Error handling untouched | ✅ PASS |

No violations. No complexity justification required.

## Project Structure

### Documentation (this feature)

```text
specs/001-service-decomposition/
├── plan.md              ← This file
├── spec.md              ← Feature specification
├── research.md          ← Phase 0: technical decisions
├── data-model.md        ← Phase 1: module map
└── tasks.md             ← Phase 2 output (/speckit-tasks)
```

### Source Code After Refactor

```text
cpp/src/geometry/
├── geometry_service.hpp              ← unchanged (facade declaration + all result types)
├── geometry_service_core.cc          ← ctor, factory, clearState, clearSnapshots, restoreSnapshot, utilities
├── geometry_service_validation.cc    ← checkManifold, healGeometryEx, simplifyBody
├── geometry_service_booleans.cc      ← fuseBodies, cutBodies, intersectBodies
├── geometry_service_transforms.cc    ← translateBody, rotateBody, mirrorBody, scaleBody, alignToFace
├── geometry_service_modelling.cc     ← filletEdges, chamferEdges, offsetShape, deleteFace, sewFaces, closeGap
├── geometry_service_shell.cc         ← separateSolids, thickenSheet, reconstructCurvedBends, getPanelFrame, unfoldShell
├── geometry_service_export.cc        ← exportDxf, buildSheetFromDxf, exportGlb
├── geometry_service_measurement.cc   ← computeBoundingBox, computeMassProperties, measureDistance, exploreTopology
├── geometry_service_assembly.cc      ← createAssemblyDocument, addAssemblyInstance, mateRigid, listAssemblyTree
├── geometry_service_sheet_metal.cc   ← splitBodyByBends, validateSheetMetal
├── [existing files unchanged: nesting.hpp, relief.hpp, shape_history.*, snapshot.hpp, topology_graph.*, unfold.*]

ts/src/mcp/
├── errors.ts           ← unchanged
├── resources.ts        ← unchanged
├── transactions.ts     ← unchanged
├── state.ts            ← NEW: all shared mutable state (binding mock, semantic store, graph, parts map, solvers)
├── tools.ts            ← THINNED: barrel re-exporting getToolDefinitions, dispatchTool, test helpers
├── registry.ts         ← NEW: assembles getToolDefinitions() from all handler definition arrays
├── handlers/
│   ├── body-ops.ts          ← clean_geometry, bounding_box, mass_props, measure, explore_topology, transforms, modify
│   ├── booleans.ts          ← fuse_bodies, cut_bodies, intersect_bodies
│   ├── shape-ops.ts         ← split_by_plane, merge_with_bend, close_gap, panel ops, trim, boundary, split_by_bends, protrusions
│   ├── manufacturing.ts     ← decompose_volume, synthesize_joints, generate_reliefs, sheet metal, manufacturability
│   ├── unfold-export.ts     ← apply_unfold, export_production_pack, job status/result
│   ├── assembly.ts          ← assembly CRUD + validate_assembly
│   ├── transactions.ts      ← rollback, begin/commit/rollback transaction, history
│   ├── semantic.ts          ← declare, bind, resolve, lineage
│   ├── graph.ts             ← part CRUD, bootstrap, add_bend, solve, foldability, graph ops, join, cut
│   └── mapping.ts           ← map_3d_to_2d, map_2d_to_3d
```

## Implementation Phases

---

### Phase A: Baseline Safety Net

**Goal**: Establish an unambiguous pass/fail baseline before any code moves.

#### A-1: Record baseline test results
Run the full integration test suite and capture pass/fail counts. Any test that fails before the refactor is excluded from regression tracking.

**Acceptance**: Baseline result file committed to the feature branch.

#### A-2: Identify dead code
- C++: Compile with `-Wunused-function` and capture warnings.
- TypeScript: Enable `noUnusedLocals: true` / `noUnusedParameters: true` in `tsconfig.json` (local, reverted after audit).
- Manual pass: search for commented-out blocks, `// LEGACY`, `// TODO remove`, `// OLD`.

**Acceptance**: Dead code inventory committed to `specs/001-service-decomposition/dead-code.md`.

---

### Phase B: TypeScript State Extraction

**Goal**: Extract all shared mutable state out of `tools.ts` into a new `state.ts` module so handler files can be written without circular dependencies.

**Why first**: All TypeScript handler modules will need to import from `state.ts`. Writing it before splitting handlers avoids rework.

#### B-1: Create `ts/src/mcp/state.ts`
Move the following from `tools.ts`:
- `geometryBindingOverride` and `setGeometryBindingMock` / `getGeometryBinding`
- `semanticStoreInstance` and `setSemanticStore` / `getSemanticStore`
- `mcpManufacturingGraphs`, `mcpActivePart`, and all graph/part helper functions (`findGraphOwner`, `createPart`, `getManufacturingGraph`, `setActivePart`, `deletePart`, `listParts`)
- `mcpSolvers`, `initializeSolvers`, `getGeometrySolver`, `getGraphFoldabilityChecker`
- `resetMcpGraphStateForTests`, `registerTestPart`

Export everything that is currently exported from `tools.ts` — the public interface must not change.

**Acceptance**: `tools.ts` imports from `state.ts`; all tests pass.

#### B-2: Update `tools.ts` to import from `state.ts`
Replace all moved declarations in `tools.ts` with imports. Run tests.

**Acceptance**: All baseline tests pass.

---

### Phase C: TypeScript Handler Extraction

**Goal**: Move each handler function and its corresponding tool definition out of `tools.ts` into purpose-specific modules under `ts/src/mcp/handlers/`.

Each handler module follows this pattern:
```typescript
// handlers/booleans.ts
import { getGeometryBinding } from '../state.js';

export const booleanDefinitions = [
  { name: 'fuse_bodies', description: '...', inputSchema: { ... } },
  { name: 'cut_bodies',  description: '...', inputSchema: { ... } },
  { name: 'intersect_bodies', description: '...', inputSchema: { ... } },
];

export function handleFuseBodies(args: Record<string, unknown>): unknown { ... }
export function handleCutBodies(args: Record<string, unknown>): unknown { ... }
export function handleIntersectBodies(args: Record<string, unknown>): unknown { ... }
```

After each sub-task below, run the full test suite before proceeding.

#### C-1: Extract `handlers/booleans.ts`
Tools: `fuse_bodies`, `cut_bodies`, `intersect_bodies`
Handlers: `handleFuseBodies`, `handleCutBodies`, `handleIntersectBodies`

#### C-2: Extract `handlers/body-ops.ts`
Tools: `clean_geometry`, `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology`, `translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face`, `fillet_edges`, `chamfer_edges`, `simplify_body`, `heal_geometry_ex`, `offset_shape`, `delete_face`, `sew_faces`, `center_and_align_body`
Handlers: corresponding `handle*` functions

#### C-3: Extract `handlers/shape-ops.ts`
Tools: `split_body_by_plane`, `merge_bodies_with_bend`, `close_gap`, `is_panel_valid`, `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, `compute_intersections`, `compute_gaps`, `trim_body_with_plane`, `check_boundary_compliance`, `split_body_by_bends`, `remove_protrusions`
Handlers: corresponding `handle*` functions

#### C-4: Extract `handlers/manufacturing.ts`
Tools: `decompose_volume`, `synthesize_joints`, `generate_reliefs`, `validate_sheet_metal`, `reconstruct_curved_bends`, `evaluate_manufacturability`, `validate_bend_sequence`, `simulate_nesting`
Handlers: corresponding `handle*` functions

#### C-5: Extract `handlers/unfold-export.ts`
Tools: `apply_unfold`, `export_production_pack`, `get_export_job_status`, `get_export_job_result`
Handlers: corresponding `handle*` functions

#### C-6: Extract `handlers/assembly.ts`
Tools: `create_assembly_document`, `add_assembly_instance`, `mate_rigid`, `list_assembly_tree`, `validate_assembly`
Handlers: corresponding `handle*` functions

#### C-7: Extract `handlers/transactions.ts`
Tools: `rollback`, `begin_transaction`, `commit_transaction`, `rollback_transaction`, `get_transaction_history`
Handlers: corresponding `handle*` functions

#### C-8: Extract `handlers/semantic.ts`
Tools: `declare_semantic_entity`, `bind_semantic_entity`, `resolve_geometry`, `semantic_lineage`
Handlers: corresponding `handle*` functions

#### C-9: Extract `handlers/graph.ts`
Tools: `create_part`, `set_active_part`, `list_parts`, `delete_part`, `bootstrap_graph`, `add_bend`, `solve_geometry`, `check_foldability`, `query_graph`, `reset_graph`, `update_node`, `remove_node`, `add_join`, `add_cut`
Handlers: corresponding `handle*` functions

#### C-10: Extract `handlers/mapping.ts`
Tools: `map_3d_to_2d`, `map_2d_to_3d`
Handlers: `handleMapTo2D`, `handleMapTo3D`

---

### Phase D: TypeScript Registry and Barrel Cleanup

#### D-1: Create `ts/src/mcp/registry.ts`
Assemble `getToolDefinitions()` from all handler definition arrays:
```typescript
import { booleanDefinitions } from './handlers/booleans.js';
import { bodyOpsDefinitions } from './handlers/body-ops.js';
// ... all others

export function getToolDefinitions(): object[] {
  return [
    ...booleanDefinitions,
    ...bodyOpsDefinitions,
    // ... all others
  ];
}
```

#### D-2: Thin `tools.ts` to a barrel
`tools.ts` becomes:
```typescript
export { getToolDefinitions } from './registry.js';
export { dispatchTool } from './dispatch.js'; // or inline if small
export { setGeometryBindingMock, setSemanticStore, resetMcpGraphStateForTests, registerTestPart } from './state.js';
```

#### D-3: Create `ts/src/mcp/dispatch.ts` (if tools.ts dispatch switch is large)
Move the `dispatchTool` switch from `tools.ts` into `dispatch.ts`. Import handler functions from their modules.

**Acceptance**: `tools.ts` is under 50 lines. All tests pass. No import errors.

---

### Phase E: Dead Code Deletion (TypeScript)

Using the inventory from Phase A:

#### E-1: Delete unused functions
Remove each function identified as dead in Phase A-2. Confirm tests still pass after each deletion.

#### E-2: Delete commented-out blocks
Remove all commented-out code blocks from all TypeScript files in scope.

**Acceptance**: Zero dead-code items remain. Tests pass.

---

### Phase F: C++ Method Extraction

**Goal**: Split `geometry_service.cc` into per-domain `.cc` files.

Each new `.cc` file follows this pattern:
```cpp
// geometry_service_booleans.cc
#include "geometry_service_impl.hpp"  // internal header with struct defs and OCCT includes

namespace mcp_cad {

FuseResult GeometryServiceImpl::fuseBodies(...) { ... }
CutResult GeometryServiceImpl::cutBodies(...) { ... }
IntersectResult GeometryServiceImpl::intersectBodies(...) { ... }

} // namespace mcp_cad
```

An internal header `geometry_service_impl.hpp` (not exported outside the geometry layer) will hold:
- All OCCT `#include` directives
- `SolidState`, `ShellState`, `FlatBendEdge`, `UnfoldState`, `AssemblyState` struct definitions
- Helper function declarations (`generateUUID`, `nowMs`, `shapeId`)
- The full `GeometryServiceImpl` class declaration

This keeps `geometry_service.hpp` clean (no OCCT types in the public interface) and lets each `.cc` file be self-contained.

**Sub-tasks** (each followed by a build + test run):

#### F-1: Create `geometry_service_impl.hpp`
Move all OCCT includes, internal structs, and helper declarations from `geometry_service.cc` into this private header.

#### F-2: Create `geometry_service_core.cc`
Move: constructor, factory function `GeometryService::create()`, `clearState`, `clearSnapshots`, `restoreSnapshot`, `generateUUID`, `nowMs`, `shapeId`.

#### F-3: Create `geometry_service_booleans.cc`
Move: `fuseBodies`, `cutBodies`, `intersectBodies`.

#### F-4: Create `geometry_service_transforms.cc`
Move: `translateBody`, `rotateBody`, `mirrorBody`, `scaleBody`, `alignToFace`.

#### F-5: Create `geometry_service_modelling.cc`
Move: `filletEdges`, `chamferEdges`, `offsetShape`, `deleteFace`, `sewFaces`, `closeGap`.

#### F-6: Create `geometry_service_shell.cc`
Move: `separateSolids`, `thickenSheet`, `reconstructCurvedBends`, `getPanelFrame`, `unfoldShell`.

#### F-7: Create `geometry_service_export.cc`
Move: `exportDxf`, `buildSheetFromDxf`, `exportGlb`.

#### F-8: Create `geometry_service_measurement.cc`
Move: `computeBoundingBox`, `computeMassProperties`, `measureDistance`, `exploreTopology`.

#### F-9: Create `geometry_service_assembly.cc`
Move: `createAssemblyDocument`, `addAssemblyInstance`, `mateRigid`, `listAssemblyTree`.

#### F-10: Create `geometry_service_validation.cc`
Move: `checkManifold`, `healGeometryEx`, `simplifyBody`.

#### F-11: Create `geometry_service_sheet_metal.cc`
Move: `splitBodyByBends`, `validateSheetMetal`.

#### F-12: Delete `geometry_service.cc`
After all methods are moved and the build succeeds, delete the original monolith.

---

### Phase G: C++ Dead Code Deletion

#### G-1: Delete unused static helpers
Remove any static helper functions identified in Phase A-2 that are not called after the refactor.

#### G-2: Delete commented-out blocks
Remove all commented-out code in the new C++ files.

**Acceptance**: C++ compiler reports zero `-Wunused-function` warnings in the geometry layer. Tests pass.

---

### Phase H: Build System Update

#### H-1: Update `CMakeLists.txt`
Replace the `geometry_service.cc` source entry with all new `.cc` files:
```cmake
geometry_service_core.cc
geometry_service_validation.cc
geometry_service_booleans.cc
geometry_service_transforms.cc
geometry_service_modelling.cc
geometry_service_shell.cc
geometry_service_export.cc
geometry_service_measurement.cc
geometry_service_assembly.cc
geometry_service_sheet_metal.cc
```

**Acceptance**: `cmake --build` succeeds. All tests pass.

---

### Phase I: Final Validation

#### I-1: Run full test suite
All tests that passed at baseline (Phase A-1) must pass.

#### I-2: Line-count audit
Verify no single new file exceeds 1,000 lines (SC-001 sets a ceiling of 400; flag any file approaching this for further review).

#### I-3: Dead code audit
Confirm zero dead-code items remain (SC-006).

#### I-4: Discoverability test
Given the new directory listing, a reviewer should be able to identify the file responsible for any named operation (e.g., "boolean union", "unfold") within 60 seconds (SC-004).

---

## Complexity Tracking

No constitution violations. No complexity justification required.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Circular imports between TS handler modules | Low | All shared state goes to `state.ts`; handlers never import from each other |
| OCCT `#include` ordering bugs when splitting C++ | Medium | Internal header `geometry_service_impl.hpp` centralises all OCCT includes |
| Tests catch regressions not immediately obvious | Low | Run tests after every individual sub-task (not just at the end) |
| CMakeLists.txt misses a new file | Low | `cmake --build` will immediately fail with a linker error |
