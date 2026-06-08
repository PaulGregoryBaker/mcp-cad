# Developer Quickstart: Graph-Driven Mutations

**Feature**: 010-graph-driven-mutations | **Updated**: 2026-06-06

---

## Prerequisites

- CMake 3.26+, MSVC (Windows) or GCC 11+ (Linux)
- Node.js 22+, npm
- OpenCASCADE (OCCT) available via vcpkg (already configured in `cpp/vcpkg.json`)

---

## Build

```powershell
# Step 1: Build the C++ NAPI addon (from repo root)
cmake -B cpp/build -S cpp -DCMAKE_BUILD_TYPE=Release
cmake --build cpp/build --config Release

# Step 2: Build TypeScript
cd ts
npm install
npm run build
```

The built `.node` addon is referenced by `ts/src/geometry/binding.ts` at load time.

---

## Run Tests

### TypeScript unit tests (fast, no C++ addon required)
```powershell
cd ts
npx vitest run --project unit
```

### TypeScript integration tests (requires built `.node` addon, real geometry)
```powershell
cd ts
npx vitest run --project integration --reporter verbose
```
Integration tests allocate up to 4GB heap — do not run in parallel with other memory-heavy processes.

### C++ unit tests
```powershell
cd cpp/build
ctest --output-on-failure
```

---

## Key Files for This Feature

### C++
| File | What changed |
|------|-------------|
| `cpp/src/geometry/geometry_service.hpp` | Add `BendZoneSpec`, `BuildShellFromFlatPatternResult`; declare `buildShellFromFlatPattern` |
| `cpp/src/geometry/geometry_service.cc` | Implement `buildShellFromFlatPattern` (reuses `buildSheetFromDxf` + `thickenSheet` + `applyBend`) |
| `cpp/src/napi/geometry_binding.cc` | NAPI wrapper for `buildShellFromFlatPattern` |

### TypeScript
| File | What changed |
|------|-------------|
| `ts/src/geometry/binding.ts` | Add `buildShellFromFlatPattern` to `GeometryAddon` and `GeometryBinding` |
| `ts/src/manufacturing/graph/types.ts` | Extend `BendZone` with `radius`, `kFactor`, `angle` fields |
| `ts/src/manufacturing/dxf/merge.ts` | Add `checkDxfUnionConnectivity` function |
| `ts/src/mcp/tools.ts` | Refactor `handleMergeBodiesWithBend` (graph-first order), refactor `handleFuseBodies` (pre-flight + graph-first), add `findGraphOwner` guard, add tolerance constants |

### Tests
| File | What it tests |
|------|-------------|
| `ts/tests/integration/merge_unfold_dxf_content.test.ts` | Graph-first merge round-trip (SC-001, SC-002, SC-003) |
| `ts/tests/integration/fuse_shell_resolution.test.ts` | Fuse with graph-tracked parts |
| `ts/tests/unit/` | Fuse pre-flight: thickness mismatch, coplanarity, disjoint detection |
| `ts/tests/contract/` | Error code contract: `GE_FUSE_THICKNESS_MISMATCH`, `GE_FUSE_NOT_COPLANAR`, `GE_FUSE_DISJOINT_RESULT` |

---

## Architecture: Graph-First Mutation Flow

```
MCP tool call (e.g. merge_bodies_with_bend)
  │
  ├─ 1. Validate: both parts have manufacturing graphs
  ├─ 2. Compute DXF merge placement (TypeScript, no C++)
  ├─ 3. mergeDxfOutlines() → mergedDxf             ← DXF is source of truth
  ├─ 4. Update ManufacturingGraph:                  ← BEFORE any C++ call
  │      BendNode + canonical PanelNode (bodyId=null, shapeDxf=mergedDxf)
  ├─ 5. C++: buildShellFromFlatPattern(mergedDxf, bendZones, thickness)
  │      (on failure → restoreSnapshot + restore graph)
  └─ 6. PanelNode.bodyId ← returned shellId
```

The `GeometrySolver` (invoked by `solve_geometry`) is a separate path — it handles full graph reconstruction from DXF for all dirty nodes. The mutation tools (`merge_bodies_with_bend`, `fuse_bodies`) bypass the solver and update `bodyId` directly.

---

## Testing the Round-Trip Invariant (SC-003)

```typescript
// After merge_bodies_with_bend:
const mergeResult = await mcp.call('merge_bodies_with_bend', { part_a_id, part_b_id, ... });

// Unfold must equal merged DXF (within 1mm tolerance)
const unfoldResult = await mcp.call('apply_unfold', { panel_id: mergeResult.merged_part_id });
// unfoldResult.dxf bounding box ≈ mergeResult DXF bounding box
```

The merged `PanelNode.shapeDxf` is set before the C++ call, so `apply_unfold` reads it directly without calling `unfoldShell`. This is the key observable change from the old architecture.
