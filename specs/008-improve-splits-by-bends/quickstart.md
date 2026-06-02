# Quickstart: Splits by Bends and Viewport Alignment Enhancements (008)

**Feature 008** — flat trapezoidal panel facet merging, explicit viewport re-orientation and auto-centering, complex body stitching, and high-performance edge-traversal protrusion closed-loop cycle removal.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| OCCT | 7.8.1 | Linked via CMake from standard vcpkg cache. |
| CMake | 3.26+ | Used for native C++ compilation. |
| Node.js | 22.x LTS | Runtime for the TypeScript MCP wrapper. |

No new npm packages or vcpkg dependencies are required. All work utilizes existing library interfaces.

---

## Build & Test Steps

```bash
# 1. Build C++ Geometry Engine (from repository root)
cd cpp
cmake -B build -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)

# 2. Build NAPI Node JS Addon Bindings
cd cpp
cmake-js build

# 3. Compile TypeScript Source
cd ts
npm run build

# 4. Run C++ Unit Tests
cd cpp/build && ctest --output-on-failure

# 5. Run TypeScript Integration Tests
cd ts && npm test
```

---

## Implementation Sequence (Recommended Task Order)

To minimize integration risk and ensure solid incremental testing, implement the components in the following order:

### 1. Trapezoidal Face Merging in `split_body_by_bends`
- Update C++ `GeometryServiceImpl::splitBodyByBends` to perform a **Facet Unification Pass**.
- For all segmented faces, traverse topological adjacency and merge adjacent triangular facets sharing collinear seams where the dihedral normals differ by less than `angle_threshold_deg` (default 0.5°).
- Verify that `cauldron.step` decomposes into clean trapezoidal flat panels instead of isolated triangles.

### 2. Viewport Re-orientation and Auto-Centering Tool (`center_and_align_body`)
- Implement `centerAndAlignBody` in C++ utilizing `BRepGProp` to find the shape's Center of Mass (centroid) and principal axes of inertia.
- Apply a translation to move the centroid to `[0,0,0]` and a rotation matrix to align the dominant face normal with global Z (`[0,0,1]`).
- Expose the mutating tool schema `center_and_align_body` in `tools.ts` and map to native bindings.

### 3. Healing in Merge by Bends (`merge_bodies_with_bend`)
- Update C++ `GeometryServiceImpl::mergeBodiesWithBend` seam verification.
- Perform a sewing pass using `BRepBuilderAPI_Sewing` with a dynamic fuzzy tolerance ($0.05\text{ mm} - 0.2\text{ mm}$ based on thickness) to close minute coordinates gaps on cauldron non-planar adjacencies before filleting the seam.

### 4. High-Performance Closed-Loop Protrusion Removal (`remove_protrusions`)
- Implement the **Mesh Edge-Traversal Loop Algorithm** in C++ to find localized narrow closed edge cycles.
- Slice protrusions cleanly off along the cycle boundary to preserve the parent panel.
- Expose the `algorithm` input parameter (`loop_traversal` vs `legacy_volumetric`), preserving the old volumetric approach as a benchmarking path.
- Benchmark and verify a speedup of $\geq 30\%$ for complex parts.

### 5. Shape History Remapping & Dolt Verification
- Ensure C++ `splitBodyByBends` returns complete `ShapeHistoryRecord` collections representing the panel segmentations.
- Verify that transaction commits automatically remap declared semantic entities (e.g. `semantic://cauldron/body-panel`) to the new split panels using Dolt AS OF history comparisons.

---

## Key File Locations

| File | Change Type | Description |
|---|---|---|
| [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp) | **MODIFY** | Add `AlignmentResult`, update method signatures, and error codes. |
| [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) | **MODIFY** | Add C++ facet unification, on-demand alignment, merge fuzzy sewing, and edge loop-traversal logic (~500 LOC). |
| [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts) | **MODIFY** | Add TS result interfaces for alignment and enhanced decomposition shape history. |
| [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts) | **MODIFY** | Map new native re-orientation and protrusion algorithm arguments. |
| [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts) | **MODIFY** | Register `center_and_align_body` and update dispatch handlers. |
| [ts/src/mcp/errors.ts](../../ts/src/mcp/errors.ts) | **MODIFY** | Register new alignment and decomposition error codes. |
| `ts/tests/integration/split_by_bends.integration.test.ts` | **MODIFY** | Add cauldron test cases for trapezoidal panel merging and protrusion loops. |

---

## Smoke Test Sequence

Verify the enhanced flow manually against the off-center `cauldron.step` fixture:

```text
1. clean_geometry("cauldron.step")         → solid_id: S
2. begin_transaction({label: "align"})     → txn_id: T
3. center_and_align_body({part_id: S, transaction_id: T})
                                           → solid_id: SA, centroid moved to [0,0,0]
4. split_body_by_bends({part_id: SA, transaction_id: T})
                                           → panel_ids (clean trapezoids), shape_history generated
5. merge_bodies_with_bend({part_a_id: P1, part_b_id: P2, bend_radius: 2.0, transaction_id: T})
                                           → fused manifold shell
6. commit_transaction({transaction_id: T}) → success, Dolt semantic mappings automatically remapped
```
