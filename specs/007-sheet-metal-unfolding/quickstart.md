# Quickstart: Advanced Sheet Metal Unfolding (007)

**Feature 007** — precise thin-panel sheet validation, gap sewing, sharp-to-curved bend reconstruction, K-factor-based K-allowance flattening, and layer-separated DXF export drawing generation.

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

### 1. Thin-Panel Sheet Validation (`validate_sheet_metal`)
- Implement normal offset parallel groupings and distance verification checks in C++ (`GeometryServiceImpl::validateSheetMetal`).
- Add the Face-Bend graph cycle and T-junction DFS/BFS checks to detect cycles and T-joints.
- Wire the C++ method to NAPI and expose the tool schema in `tools.ts`. Add happy path and invalid-thickness tests.

### 2. Auto-Sewing Healing in Unfold (`apply_unfold`)
- Integrate `BRepBuilderAPI_Sewing` inside the C++ `unfoldShell` function before executing BFS traversal.
- Configure sewing to run with a maximum tolerance gap of $0.1\text{ mm}$ (Option A).
- Implement error raising with coordinates if gaps remain open above $0.1\text{ mm}$ (returns `GE_UNFOLD_SEWING_FAILED`).

### 3. Sharp-to-Curved Bend Reconstruction (`reconstruct_curved_bends`)
- Implement `reconstructCurvedBends` in C++ utilizing `BRepFilletAPI_MakeFillet` on all sharp joint transitions.
- Map sharp corners to rounded cylindrical bends with inner radius $R_i = t$ and outer radius $R_e = 2t$ (Option A).
- Verify the new shape is registered in the CAD session and returned as a replacement solid.

### 4. DXF Layer Separation drawing
- Modify `exportDxf` in C++ to write outer blank polylines and cutout wire loops onto the `'CUT'` layer.
- Project the bend lines during traversal and export them onto `'BEND_UP'` and `'BEND_DOWN'` layers with text annotations showing angle and direction.

---

## Key File Locations

| File | Change Type | Description |
|---|---|---|
| [cpp/src/geometry/geometry_service.hpp](../../cpp/src/geometry/geometry_service.hpp) | **MODIFY** | Add `SheetMetalValidationResult`, `GapSewResult`, `CurvedRebuildResult`, method signatures, and error codes. |
| [cpp/src/geometry/geometry_service.cc](../../cpp/src/geometry/geometry_service.cc) | **MODIFY** | Add C++ validation, sewing, filleting, and DXF projection logic (~450 LOC). |
| [ts/src/geometry/types.ts](../../ts/src/geometry/types.ts) | **MODIFY** | Add TS result interfaces for the new unfolding tools. |
| [ts/src/geometry/binding.ts](../../ts/src/geometry/binding.ts) | **MODIFY** | Map new native addon methods to JavaScript functions. |
| [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts) | **MODIFY** | Register `validate_sheet_metal`, `reconstruct_curved_bends`, and dispatch handlers. |
| [ts/src/mcp/errors.ts](../../ts/src/mcp/errors.ts) | **MODIFY** | Register new unfold-specific error codes. |
| `ts/tests/integration/unfold.integration.test.ts` | **NEW/MODIFY**| Verify validation, sewing, curved bends, and DXF layers end-to-end. |

---

## Tool Verification Checklist (Per Tool)

Before completing a tool task, confirm that:

- [ ] C++ implementation compiles successfully without errors (`cmake --build build`).
- [ ] Addon bindings are registered in `addon.cc`.
- [ ] TypeScript types are exported from `types.ts` and loaded in `binding.ts`.
- [ ] JSON schema schemas are correctly defined in `tools.ts`.
- [ ] Mutating tools validate `transaction_id`, emit a `rollback_token`, and capture shape histories.
- [ ] Integration tests verify the happy path, standard failure modes, and rollback states.
- [ ] Standardized JSON errors are returned for all exceptions (no raw crashes).

---

## Smoke Test Sequence

You can verify the entire advanced unfolding flow manually using the following sequence against a STEP fixture `bracket_sharp.step`:

```text
1. clean_geometry("bracket_sharp.step")    → solid_id: S
2. validate_sheet_metal({part_id: S})      → { is_valid: true, nominal_thickness: 2.0, can_flatten: true }
3. begin_transaction({label: "reconstruct"})→ txn_id
4. reconstruct_curved_bends({part_id: S, transaction_id: txn_id})
                                           → solid_id: SR (replacement with rounded bends)
5. apply_unfold({panel_id: SR, material_id: "mild-steel", transaction_id: txn_id})
                                           → unfold_id: U, flat_width_mm, flat_height_mm, bend_count: 2
6. export_dxf({unfold_id: U})              → dxf_content containing layers: CUT, BEND_UP, BEND_DOWN
7. commit_transaction({transaction_id})   → success
```
