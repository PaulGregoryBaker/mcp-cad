# Implementation Plan: Geometric Primitive Tools

**Branch**: `006-geometry-primitives` | **Date**: 2026-05-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from [specs/006-geometry-primitives/spec.md](spec.md)

---

## Summary

Implements ~22 new MCP tools derived from [docs/MoreMCPTools.md](../../docs/MoreMCPTools.md), spanning five categories: Boolean operations, topological interrogation, rigid-body transforms, direct-edit operations, topology sewing, and XCAF hierarchical assembly. All mutating tools integrate with the existing transaction primitive ([004](../004-transaction-primitive/plan.md)) and semantic mapping layer ([005](../005-semantic-mapping-layer/plan.md)) via `ShapeHistoryRecord` emission.

The work is **additive**: no existing tool is changed or deprecated. All OCCT calls live exclusively in `cpp/src/geometry/geometry_service.cc`. The pattern established by the existing 30+ methods in `GeometryService` is followed verbatim.

---

## Prerequisites

None beyond what is already merged:

| Prerequisite | Status |
|---|---|
| `004-transaction-primitive` merged to `main` | ✅ Merged (`eb40792` on `005-semantic-mapping-layer`) |
| `005-semantic-mapping-layer` merged to `main` | ✅ Merged (same) |
| OCCT 7.8.1 with full `${OpenCASCADE_LIBRARIES}` (includes XCAF) | ✅ Already linked via `cpp/CMakeLists.txt` |

---

## Technical Context

**Language/Version**: C++ 17 (Geometry Engine) + TypeScript ESM (MCP layer). No language changes.

**Primary Dependencies**:
- C++: OCCT 7.8.1 via vcpkg (already linked). New OCCT modules used:
  - `BRepAlgoAPI_Fuse` — already imported in `geometry_service.cc` (unused)
  - `BRepFilletAPI_MakeFillet`, `BRepFilletAPI_MakeChamfer` — already imported
  - `ShapeUpgrade_UnifySameDomain` — **new import**
  - `BRepOffsetAPI_MakeOffsetShape` — **new import** (distinct from existing `BRepOffsetAPI_MakeOffset`)
  - `gp_Trsf`, `BRepBuilderAPI_Transform` — `gp_Trsf` already imported; `BRepBuilderAPI_Transform` **new import**
  - `XCAFDoc_ShapeTool`, `TDocStd_Document`, `TopLoc_Location`, `XCAFDoc_Location` — **new imports** (XCAF subsystem)
  - `GProp_GProps`, `BRepGProp` — already imported
  - `BRepExtrema_DistShapeShape` — already imported
- TypeScript: no new npm packages. All runtime is existing (Node.js 22, `node-addon-api`).

**Storage**: No new persistence. Assembly documents live in the existing in-memory geometry session (a new `AssemblyState` map in `GeometryServiceImpl`). Rollback via the existing `SnapshotRegistry`.

**Testing**: C++ with Catch2 (`cpp/tests/geometry_tests`). TypeScript integration tests with Vitest/ts-jest (`ts/tests/integration/`).

**Target Platform**: Local stdio MCP (Docker + bare-metal, matching existing deployment).

**Performance Goals**:
- Interrogation tools (bounding_box, mass_properties, measure_distance, explore_topology): < 50 ms on `braai.step` (per SC-006).
- Boolean fuse on ~10 kB solids: < 500 ms (per SC-007).

**Constraints**:
- Constitution Principle II: all new OCCT includes go in `geometry_service.cc` only. No OCCT types in `.hpp`.
- Constitution Principle IV: all mutating tools require `transaction_id` → rollback token path.
- Constitution Principle VI: all new error codes registered in `ts/src/mcp/errors.ts`.

---

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Deterministic geometry | PASS | All OCCT operations are deterministic given the same inputs and OCCT version. `BRepBuilderAPI_Transform` is pure math. XCAF location transforms are deterministic. |
| II. Bounded contexts | PASS | OCCT calls stay in `geometry_service.cc`. XCAF assembly context is a sub-context within the Geometry Engine bounded context — it does not cross into Manufacturing Domain or MCP Protocol Layer. |
| III. Safety filter | PASS | No safety-sensitive operations in this feature. |
| IV. Rollback-first | PASS | Every mutating C++ method returns a `SnapshotId rollbackToken`; session adds the `ShapeHistoryRecord`s to the active transaction. `rollback_transaction` restores the snapshot as before. |
| V. Kerf compensation | PASS | No joint synthesis added. |
| VI. Structured errors | PASS | 9 new error codes added to `errors.ts`. All OCCT exceptions caught at `geometry_service.cc` boundary, serialised to JSON, re-thrown as `GeometryError`. |
| VII. MVP scope | PASS | These are OCCT primitive tools, additive, do not expand the MVP integration test. Assembly is explicitly in scope by clarification. |
| VIII. Configuration | PASS | Tolerances passed as parameters (already in spec). No new hard-coded manufacturing parameters. |
| IX. Async export | PASS | Unchanged. |

---

## Project Structure

### Documentation (this feature)

```text
specs/006-geometry-primitives/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   └── mcp-tool-schemas.md   ← Phase 1 output
└── tasks.md             ← Phase 2 output (/speckit-tasks)
```

### Source Code Changes (additive)

```text
cpp/src/geometry/
├── geometry_service.hpp       # +~22 new result structs + ~22 new virtual methods
│                              # +9 new error-code constexprs
├── geometry_service.cc        # +~600 LOC — implementations of all new methods
│                              # +~10 new OCCT #include directives

ts/src/geometry/
├── types.ts                   # +~15 new result interfaces (mirroring hpp structs)
├── binding.ts                 # +~22 new methods on GeometryAddon interface

ts/src/mcp/
├── tools.ts                   # +22 new tool definitions + dispatch cases
├── errors.ts                  # +9 new error code entries

ts/tests/integration/
├── booleans.integration.test.ts       # New — US1 scenarios
├── interrogation.integration.test.ts  # New — US2 scenarios
├── transforms.integration.test.ts     # New — US3 scenarios
├── direct_edits.integration.test.ts   # New — US4 scenarios
├── sew.integration.test.ts            # New — US5 scenario
├── assembly.integration.test.ts       # New — US6 scenarios

cpp/tests/
├── ge_primitives_test.cc      # New C++ unit tests for Geometry Engine methods
```

---

## Design

### Overall approach

Follow the **exact same pattern** as every existing method in the project:

1. Add result struct(s) to `geometry_service.hpp` (no OCCT types).
2. Add `virtual` method signature(s) to `GeometryService` class in `.hpp`.
3. Implement the method in `geometry_service.cc` — OCCT calls inside the `try { } catch (Standard_Failure&)` wrapper, populate result, emit `captureHistory(...)`.
4. Add corresponding method to `GeometryAddon` interface in `binding.ts`.
5. Register NAPI function in the addon entry file (`src/napi/addon.cc`).
6. Add tool definition object to `getToolDefinitions()` in `tools.ts`.
7. Add dispatch case to the tool switch in `tools.ts`.
8. Add error codes to `errors.ts`.
9. Write integration tests.

No architectural changes. No new bounded contexts. No new process-level components.

### Session state extension for Assembly

The existing implementation holds:
```cpp
std::unordered_map<SolidId,  SolidState>  solids_;
std::unordered_map<ShellId,  ShellState>  shells_;
std::unordered_map<UnfoldId, UnfoldState> unfolds_;
```

A new map is added:
```cpp
std::unordered_map<AssemblyId, AssemblyState> assemblies_;
```

Where `AssemblyState` wraps a `Handle(TDocStd_Document)` (XDE document) plus a component-id-to-TDF_Label map:
```cpp
struct AssemblyState {
  AssemblyId id;
  Handle(TDocStd_Document) doc;
  std::unordered_map<ComponentId, TDF_Label> components;
};
```

The XDE document is not serialised to disk by default (like `SolidState`). Rollback for assembly mutations goes through the same snapshot mechanism (snapshot captures the component-id map; rollback re-applies it). Because XCAF documents are mutable in place, the snapshot stores a deep-copy of the component-id map — sufficient since XCAF location transforms are the only mutable state during a Phase 1 mate.

If the Session's `SnapshotRegistry::createSnapshot` needs extending to capture assembly state, it is extended as a follow-on task (T-Axxx). For Phase 1, since assembly operations are treated as purely additive (add instance, set location), a simpler approach is taken: rollback restores the component map from the snapshot, but the document is rebuilt from scratch from the surviving component entries (no deep XCAF copy required).

### C++ side — XCAF module inclusion

The existing `geometry_service.cc` currently includes no XCAF headers. New includes needed:

```cpp
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Location.hxx>
#include <TopLoc_Location.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
```

The existing `CMakeLists.txt` already links `${OpenCASCADE_LIBRARIES}`, which includes `TKXCAF`, `TKBinXCAF`, and `TKXDESSTEP`. No CMake changes needed.

### C++ side — edge-ID resolution for fillet/chamfer

The current session stores face and edge IDs as OCCT shape hash strings (`shapeId(shape) = std::to_string(std::hash<TopoDS_Shape>{}(shape))`). To look up an edge by its ID when filleting, the implementation iterates the body's topology with `TopExp_Explorer(shape, TopAbs_EDGE)`, calling `shapeId(edge)` on each, and collects those matching the requested IDs. This is O(E) per operation — acceptable for the MVP's geometry scale (< 1000 edges).

### C++ side — transform semantics

All five transform tools (`translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face`) follow the same output pattern:
1. Build a `gp_Trsf`.
2. Apply via `BRepBuilderAPI_Transform(inputShape, trsf, /*copy=*/true)`.
3. Register the result as a new `ShellId`.
4. Remove the original from `shells_` unless `keep_original: true`.
5. Emit `ShapeHistoryRecord{verdict: "modified", originalId: face_i, newId: new_face_i}` for every face pair via `captureHistory`.

The `captureHistory` helper already handles `BRepBuilderAPI_MakeShape`-derived types, which `BRepBuilderAPI_Transform` is. No changes to the history infrastructure.

### TypeScript side — tool dispatch pattern

The existing `tools.ts` switch dispatches on `tool.name`. New tools are added as new `case 'fuse_bodies':` blocks following the existing verbatim pattern: validate inputs, call addon, wrap in transaction scope (record history on the registry), return structured result. No abstraction change.

### New error codes (FR-029)

| Code | Category | Recoverable |
|---|---|---|
| `GE_BOOLEAN_EMPTY_RESULT` | Geometry Engine | true |
| `GE_ALIGN_UNSUPPORTED` | Geometry Engine | true |
| `GE_SCALE_NON_UNIFORM` | Geometry Engine | true |
| `GE_FILLET_TOO_LARGE` | Geometry Engine | true |
| `GE_CHAMFER_TOO_LARGE` | Geometry Engine | true |
| `GE_HEAL_INCOMPLETE` | Geometry Engine | true (warning) |
| `GE_SEW_INCOMPLETE` | Geometry Engine | true (warning) |
| `GE_ASSEMBLY_MATE_UNSUPPORTED` | Geometry Engine | true |
| `GE_ASSEMBLY_CROSS_DOCUMENT` | Geometry Engine | false |

All are added to `errors.ts` under the `// Feature 006-geometry-primitives` comment block. C++ `constexpr const char*` equivalents are added to `geometry_service.hpp`.

---

## Phase 0: Research

*See [research.md](research.md) for findings.*

Key findings:
1. **XCAF is already linked** — `${OpenCASCADE_LIBRARIES}` includes TKXCAF. No vcpkg or CMake changes needed.
2. **`BRepAlgoAPI_Fuse` and `BRepFilletAPI_MakeFillet` are already `#include`d** in `geometry_service.cc` — both were imported early but never wired to the NAPI layer. They compile and link today.
3. **`BRepBuilderAPI_Transform` must be added** — it is in TKBRep (already linked) but not currently imported.
4. **`ShapeUpgrade_UnifySameDomain` is in TKShapeHealing** (already linked) but not imported.
5. **`BRepOffsetAPI_MakeOffsetShape` is in TKOffset** (already linked) — distinct from `BRepOffsetAPI_MakeOffset` (2D); the 3D offset class is the correct one for `offset_shape`.
6. **XCAF stability in 7.8.1**: Confirmed stable for add-instance + location mutation workflows. `XCAFDoc_ShapeTool::AddShape` / `XCAFDoc_Location` are marked stable in [docs/OCCT_STABILITY.md](../../docs/OCCT_STABILITY.md) (implicitly, they were not in the brittle list).
7. **Fillet risk**: `BRepFilletAPI_MakeFillet` is the same risk class as `BRepAlgoAPI_Cut` — can fail on near-tangent or degenerate edges. The existing mitigation pattern (try/catch + `BRepCheck_Analyzer`) applies.

---

## Phase 1: Design & Contracts

*See [data-model.md](data-model.md) for the complete type table.*
*See [contracts/mcp-tool-schemas.md](contracts/mcp-tool-schemas.md) for MCP tool schemas.*

### Data model additions (hpp + types.ts)

**C++ result structs** (additions to `geometry_service.hpp`):

```cpp
// ── Booleans ──────────────────────────────────────────────────────────────────
struct FuseResult  { SolidId solidId; bool disjoint; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct CutResult   { SolidId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct IntersectResult { SolidId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };

// ── Interrogation ─────────────────────────────────────────────────────────────
struct BoundingBoxResult { double xMin, yMin, zMin, xMax, yMax, zMax; };
struct MassPropertiesResult {
  std::optional<double> volume;
  std::optional<double> surfaceArea;
  std::optional<std::array<double,3>> centroid;
  std::optional<std::array<double,9>> inertiaTensor;
};
struct MeasureResult { double value; std::string measurementType; };
struct ExploreResult { std::vector<std::string> entityIds; };

// ── Transforms ────────────────────────────────────────────────────────────────
struct TransformResult { ShellId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };

// ── Direct edits ──────────────────────────────────────────────────────────────
struct FilletResult      { ShellId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct ChamferResult     { ShellId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct SimplifyResult    { ShellId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct HealExResult      { ShellId solidId; bool healComplete; std::vector<std::string> remainingIssues;
                           SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct OffsetShapeResult { ShellId solidId; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };
struct DeleteFaceResult  { std::vector<ShellId> solidIds; SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };

// ── Sewing ────────────────────────────────────────────────────────────────────
struct SewResult { ShellId solidId; bool sewComplete; std::vector<std::string> freeEdges;
                   SnapshotId rollbackToken; std::vector<ShapeHistoryRecord> shapeHistory; };

// ── Assembly ──────────────────────────────────────────────────────────────────
using AssemblyId  = std::string;
using ComponentId = std::string;

struct CreateAssemblyResult { AssemblyId assemblyId; };
struct AddInstanceResult    { ComponentId componentId; SnapshotId rollbackToken; };
struct MateRigidResult      { ComponentId componentId; std::array<double,16> locationMatrix;
                               SnapshotId rollbackToken; };

struct AssemblyNode {
  ComponentId componentId;
  std::string shapeId;       // may be a SolidId or sub-AssemblyId
  std::array<double,16> locationMatrix;
  std::vector<AssemblyNode> children;
};
struct ListAssemblyResult { AssemblyId assemblyId; AssemblyNode root; };
```

**TypeScript interfaces** mirror the above in `ts/src/geometry/types.ts` (snake_case field names, same pattern as existing interfaces).

### MCP tool surface summary

| Tool | Category | Mutating | Returns |
|---|---|---|---|
| `fuse_bodies` | Boolean | ✅ | `{solid_id, disjoint, rollback_token, shape_history}` |
| `cut_bodies` | Boolean | ✅ | `{solid_id, rollback_token, shape_history}` |
| `intersect_bodies` | Boolean | ✅ | `{solid_id, rollback_token, shape_history}` |
| `bounding_box` | Interrogation | ❌ | `{x_min,y_min,z_min,x_max,y_max,z_max}` |
| `mass_properties` | Interrogation | ❌ | `{volume?,surface_area?,centroid?,inertia_tensor?}` |
| `measure_distance` | Interrogation | ❌ | `{value, measurement_type}` |
| `explore_topology` | Interrogation | ❌ | `{entity_ids: string[]}` |
| `translate_body` | Transform | ✅ | `{solid_id, rollback_token, shape_history}` |
| `rotate_body` | Transform | ✅ | `{solid_id, rollback_token, shape_history}` |
| `mirror_body` | Transform | ✅ | `{solid_id, rollback_token, shape_history}` |
| `scale_body` | Transform | ✅ | `{solid_id, rollback_token, shape_history}` |
| `align_to_face` | Transform | ✅ | `{solid_id, rollback_token, shape_history}` |
| `fillet_edges` | Direct edit | ✅ | `{solid_id, rollback_token, shape_history}` |
| `chamfer_edges` | Direct edit | ✅ | `{solid_id, rollback_token, shape_history}` |
| `simplify_body` | Direct edit | ✅ | `{solid_id, rollback_token, shape_history}` |
| `heal_geometry_ex` | Direct edit | ✅ | `{solid_id, heal_complete, remaining_issues, rollback_token, shape_history}` |
| `offset_shape` | Direct edit | ✅ | `{solid_id, rollback_token, shape_history}` |
| `delete_face` | Direct edit | ✅ | `{solid_ids[], rollback_token, shape_history}` |
| `sew_faces` | Topology | ✅ | `{solid_id, sew_complete, free_edges[], rollback_token, shape_history}` |
| `create_assembly_document` | Assembly | ✅ | `{assembly_id}` |
| `add_assembly_instance` | Assembly | ✅ | `{component_id, rollback_token}` |
| `mate_rigid` | Assembly | ✅ | `{component_id, location_matrix, rollback_token}` |
| `list_assembly_tree` | Assembly | ❌ | `{assembly_id, root: AssemblyNode}` |

**Note on `heal_geometry_ex`**: The existing `GeometryService::healGeometry` (used inside `clean_geometry`) takes a `SolidId` and returns a `SolidId`. The new tool exposes it with the full result struct (heal_complete flag, remaining_issues list, history, rollback token) and registers it as `heal_geometry_ex` to avoid name collision with the existing NAPI method. The existing `healGeometry` is left unchanged.

### C++ GeometryService interface additions

All 22 new virtual methods are appended to the `GeometryService` class in `geometry_service.hpp`. The implementation follows the **exact** same coding style as existing methods. Key examples:

```cpp
// Boolean
virtual FuseResult  fuseBodies(const std::vector<ShellId>& tools, double fuzzyTolerance = 1e-5) = 0;
virtual CutResult   cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools = false) = 0;
virtual IntersectResult intersectBodies(const ShellId& a, const ShellId& b) = 0;

// Interrogation (non-mutating)
virtual BoundingBoxResult   computeBoundingBox(const std::string& entityId) = 0;
virtual MassPropertiesResult computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) = 0;
virtual MeasureResult       measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) = 0;
virtual ExploreResult       exploreTopology(const std::string& entityId, const std::string& returnType) = 0;

// Transforms
virtual TransformResult translateBody(const std::vector<ShellId>& targets, double dx, double dy, double dz, bool keepOriginal = false) = 0;
virtual TransformResult rotateBody(const std::vector<ShellId>& targets, double axOriginX, double axOriginY, double axOriginZ, double axDirX, double axDirY, double axDirZ, double angleDeg, bool keepOriginal = false) = 0;
virtual TransformResult mirrorBody(const std::vector<ShellId>& targets, double plOriginX, double plOriginY, double plOriginZ, double plNormX, double plNormY, double plNormZ, bool keepOriginal = false) = 0;
virtual TransformResult scaleBody(const std::vector<ShellId>& targets, double originX, double originY, double originZ, double scaleFactor, bool keepOriginal = false) = 0;
virtual TransformResult alignToFace(const std::string& sourceFaceId, const std::string& destFaceId, bool flipNormal, bool keepOriginal = false) = 0;

// Direct edit
virtual FilletResult      filletEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double radiusMm) = 0;
virtual ChamferResult     chamferEdges(const ShellId& partId, const std::vector<std::string>& edgeIds, double distanceMm) = 0;
virtual SimplifyResult    simplifyBody(const ShellId& partId, bool unifyFaces, bool unifyEdges) = 0;
virtual HealExResult      healGeometryEx(const ShellId& partId, bool fixTolerances, bool fixWires) = 0;
virtual OffsetShapeResult offsetShape(const ShellId& partId, double offsetValue, double tolerance = 1e-4) = 0;
virtual DeleteFaceResult  deleteFace(const ShellId& partId, const std::vector<std::string>& faceIds, bool healRemaining) = 0;

// Sewing
virtual SewResult sewFaces(const std::vector<std::string>& entityIds, double tolerance, bool makeSolid) = 0;

// Assembly
virtual CreateAssemblyResult createAssemblyDocument() = 0;
virtual AddInstanceResult    addAssemblyInstance(const AssemblyId& assemblyId, const std::string& shapeId, double tx, double ty, double tz, double qw, double qx, double qy, double qz) = 0;
virtual MateRigidResult      mateRigid(const AssemblyId& assemblyId, const std::string& srcEntityId, const std::string& dstEntityId, bool flipAlignment) = 0;
virtual ListAssemblyResult   listAssemblyTree(const AssemblyId& assemblyId) = 0;
```

---

## Complexity Tracking

No complexity violations. All additions are strictly within the existing Geometry Engine bounded context, following established patterns. XCAF assembly is a new session-state bucket (like `shells_`) but does not require a new bounded context.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `BRepFilletAPI_MakeFillet` fails on complex edges (known brittle) | Medium | Catch `Standard_Failure`, return `GE_FILLET_TOO_LARGE` with offending edge id. Integration test covers this. |
| XCAF deep-copy for rollback is complex | Low | Phase 1 uses the simpler "rebuild from component map" rollback (see Design §Assembly session state). If found insufficient, escalate in task T-A010. |
| `BRepOffsetAPI_MakeOffsetShape` fails on non-convex solids | Medium | Same pattern: catch, return `GE_OFFSET_FAILED` (existing code). |
| XCAF module not accessible via `${OpenCASCADE_LIBRARIES}` on Windows builds | Low | Research confirmed all modules included. Verified by checking that vcpkg's opencascade package includes XCAF by default. Can be validated by adding a tiny XCAF smoke test at T-B001. |
| `ShapeUpgrade_UnifySameDomain` changes volume | Low | Integration test asserts volume preserved to 1e-6 mm³. Known-safe for co-planar merging. |
