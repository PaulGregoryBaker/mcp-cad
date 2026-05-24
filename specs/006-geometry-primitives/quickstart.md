# Quickstart: Geometric Primitive Tools (006)

**Feature 006** — additive extension, no breaking changes, no new build dependencies.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| OCCT | 7.8.1 | Already in `cpp/vcpkg.json`. No change. |
| CMake | 3.26+ | No change. |
| Node.js | 22.x LTS | No change. |
| cmake-js | 7.x | No change. |
| Dolt | 1.x | No change (semantic layer optional). |

No new npm packages. No new vcpkg dependencies. No new environment variables.

---

## Build steps

Identical to existing workflow:

```bash
# 1. Build C++ geometry engine (after editing geometry_service.hpp / .cc)
cd cpp
cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# 2. Build NAPI addon (after editing binding.ts / src/napi/addon.cc)
cd cpp
cmake-js build

# 3. Build TypeScript
cd ts
npm run build

# 4. Run C++ unit tests
cd cpp/build && ctest --output-on-failure

# 5. Run TypeScript integration tests
cd ts && npm test
```

---

## Implementation order for tasks (recommended)

The 22 new tools span two bounded contexts (C++ engine + TS MCP layer) and one new XCAF sub-context. Recommended order that minimises integration risk:

1. **Interrogation tools first** (US2 — zero mutation risk, highest utility for verification):
   - Add `BoundingBoxResult`, `MassPropertiesResult`, `MeasureResult`, `ExploreResult` to `.hpp`
   - Implement `computeBoundingBox`, `computeMassProperties`, `measureDistance`, `exploreTopology` in `.cc`
   - Wire NAPI, add tool definitions, integration tests
   - These tools validate the `explore_topology` → face/edge ID flow used by fillet/chamfer/delete_face

2. **Boolean operations** (US1 — `BRepAlgoAPI_Fuse`/`Common` already imported):
   - Add result structs, implement `fuseBodies`, `cutBodies`, `intersectBodies`
   - Wire NAPI + tools. Integration tests cover disjoint-body edge case.

3. **Transform operations** (US3 — all use same `TransformResult` and `gp_Trsf` pattern):
   - Add `BRepBuilderAPI_Transform.hxx` import
   - Implement all five transforms. `translate_body` → `rotate_body` → `mirror_body` → `scale_body` → `align_to_face` (increasing complexity)
   - Integration tests: verify shape_history emission and semantic remap

4. **Direct edit operations** (US4 — `BRepFilletAPI_MakeFillet` already imported):
   - Add `ShapeUpgrade_UnifySameDomain.hxx`, `BRepOffsetAPI_MakeOffsetShape.hxx`
   - Implement: `simplifyBody` → `healGeometryEx` → `filletEdges` → `chamferEdges` → `offsetShape` → `deleteFace`
   - Fillet and chamfer edge cases require the edge-id resolution pattern (documented in research.md §R-004)

5. **Topology sewing** (US5 — `BRepBuilderAPI_Sewing` already imported):
   - Short implementation. Main concern: `free_edges` reporting.

6. **Assembly / XCAF** (US6 — new XCAF includes, new session state):
   - Add XCAF `#include`s and `AssemblyState` struct
   - Implement: `createAssemblyDocument` → `addAssemblyInstance` → `mateRigid` → `listAssemblyTree`
   - XCAF rollback pattern is the assembly-specific extension to SnapshotRegistry (see plan.md §Design/Assembly)

---

## Key file locations

| File | Change type |
|---|---|
| [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp) | Add ~22 result structs + virtual methods |
| [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) | Add ~600 LOC implementations |
| [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts) | Add ~15 TypeScript result interfaces |
| [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts) | Add ~22 NAPI binding methods |
| [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts) | Add 22 tool defs + dispatch cases |
| [ts/src/mcp/errors.ts](../../ts/src/mcp/errors.ts) | Add 9 error codes |
| `ts/tests/integration/booleans.integration.test.ts` | New file |
| `ts/tests/integration/interrogation.integration.test.ts` | New file |
| `ts/tests/integration/transforms.integration.test.ts` | New file |
| `ts/tests/integration/direct_edits.integration.test.ts` | New file |
| `ts/tests/integration/sew.integration.test.ts` | New file |
| `ts/tests/integration/assembly.integration.test.ts` | New file |
| `cpp/tests/ge_primitives_test.cc` | New file |

---

## Testing a new tool (checklist per tool)

For each of the 22 tools, verify before marking done:

- [ ] C++ method compiles without errors (`cmake --build build`)
- [ ] NAPI binding registered in `src/napi/addon.cc`
- [ ] TypeScript types added to `types.ts` and imported in `binding.ts`
- [ ] Tool definition added to `getToolDefinitions()` in `tools.ts`
- [ ] Dispatch case added in tool switch in `tools.ts`
- [ ] For mutating tools: `transaction_id` is required and validated
- [ ] For mutating tools: `rollback_token` is emitted in the response
- [ ] For mutating tools: `shape_history` records are emitted with correct `operation_label`
- [ ] Integration test covers happy path, edge case, and rollback
- [ ] Error codes for this tool are in `errors.ts`

---

## Smoke test sequence (manual verification)

After implementing all tools, run this sequence against `braai.step`:

```
1. clean_geometry(braai.step)                 → solid_id: S
2. explore_topology({target: S, return_type: "face"})  → [f1..fN]
3. bounding_box({target: S})                  → AABB
4. mass_properties({target: S})               → volume, centroid
5. begin_transaction({label: "smoke"})        → txn_id
6. fuse_bodies({tools: [S], txn_id})          → solid_id: S2  (fuse with itself = same shape, no-op)
   # Actually: load a second body first:
5b. clean_geometry(simple_box.stp)            → solid_id: B
6b. begin_transaction                         → txn_id
7.  fuse_bodies({tools: [S, B], txn_id})      → solid_id: F
8.  bounding_box({target: F})                 → AABB' (should enclose both S and B)
9.  commit_transaction                        → success
10. rollback_transaction (won't work after commit — start fresh for rollback test)
```

The full acceptance scenario for US1–US2 is in the integration test files.
