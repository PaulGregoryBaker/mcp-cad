# Tasks: Geometric Primitive Tools (006)

**Input**: Design documents from `specs/006-geometry-primitives/`

**Prerequisites**: spec.md ✓, plan.md ✓, research.md ✓, data-model.md ✓, contracts/mcp-tool-schemas.md ✓

**Organization**: 9 phases — Setup → Foundational → US2 (Interrogation, P1) → US1 (Booleans, P1) → US3 (Transforms, P2) → US4 (Direct Edits, P2) → US5 (Sewing, P3) → US6 (Assembly, P3) → Polish. Interrogation (US2) is implemented before Booleans (US1) because it is pure-read and provides the edge/face ID tooling needed by later stories — see quickstart.md §Implementation order.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel with other [P] tasks in the same phase (different files, no in-phase dependency)
- **[Story]**: US1–US6 from spec.md
- All paths are repository-relative

---

## Phase 1: Setup (Error Codes + TypeScript Types)

**Purpose**: Add all new error codes and TypeScript types up front so every subsequent phase compiles clean without partial additions.

**⚠️ CRITICAL**: Both tasks must be complete before any Phase 2+ work begins; downstream tasks import from these files.

- [x] T001 Add 9 new error code string constants to `ts/src/mcp/errors.ts` under a `// Feature 006-geometry-primitives` comment block: `GE_BOOLEAN_EMPTY_RESULT`, `GE_ALIGN_UNSUPPORTED`, `GE_SCALE_NON_UNIFORM`, `GE_FILLET_TOO_LARGE`, `GE_CHAMFER_TOO_LARGE`, `GE_HEAL_INCOMPLETE`, `GE_SEW_INCOMPLETE`, `GE_ASSEMBLY_MATE_UNSUPPORTED`, `GE_ASSEMBLY_CROSS_DOCUMENT` (exact names from data-model.md §New Error Code Constants). Also add the 9 matching `constexpr const char*` constants to `cpp/src/geometry/geometry_service.hpp` after the existing `GE_DECOMPOSE_*` constants.

- [x] T002 [P] Add all new TypeScript result interfaces to `ts/src/geometry/types.ts` as defined in data-model.md §TypeScript Types: `FuseResult`, `CutResult`, `IntersectResult`, `BoundingBoxResult`, `MassPropertiesResult`, `MeasureResult`, `ExploreResult`, `TransformResult`, `FilletResult`, `ChamferResult`, `SimplifyResult`, `HealExResult`, `OffsetShapeResult`, `DeleteFaceResult`, `SewResult`, `CreateAssemblyResult`, `AddInstanceResult`, `LocationMatrix16`, `MateRigidResult`, `AssemblyNode`, `ListAssemblyResult`, `AssemblyId`, `ComponentId`. Follow the snake_case field conventions and `ShapeHistoryRecord[]` optional pattern of existing types.

**Checkpoint**: `npm run build` (TypeScript only) passes with the new types exported.

---

## Phase 2: Foundational (C++ Type Declarations)

**Purpose**: Add all C++ result struct declarations and new OCCT includes to the header and implementation file. No method implementations yet — the build will still fail until implementations are added per-story, but the declarations provide a stable target.

**⚠️ Note**: Adding `= 0` pure virtual methods to `GeometryService` without implementing them in `GeometryServiceImpl` breaks the build. Therefore T004 adds the includes now, but T005 adds both the virtual signature and implementation together as a sequential pair within Phase 3, not here.

- [x] T003 [P] Add all C++ result struct definitions and type aliases to `cpp/src/geometry/geometry_service.hpp` as listed in data-model.md §C++ Types: `FuseResult`, `CutResult`, `IntersectResult`, `BoundingBoxResult`, `MassPropertiesResult`, `MeasureResult`, `ExploreResult`, `TransformResult`, `FilletResult`, `ChamferResult`, `SimplifyResult`, `HealExResult`, `OffsetShapeResult`, `DeleteFaceResult`, `SewResult`, `CreateAssemblyResult`, `AddInstanceResult`, `LocationMatrix`, `MateRigidResult`, `AssemblyNode`, `ListAssemblyResult`, `AssemblyId`, `ComponentId`. Place after the existing `BBox3D` and before the `GeometryService` class declaration.

- [x] T004 [P] Add 6 new OCCT `#include` directives to `cpp/src/geometry/geometry_service.cc` (after the existing include block at ~line 84): `<BRepBuilderAPI_Transform.hxx>`, `<ShapeUpgrade_UnifySameDomain.hxx>`, `<BRepOffsetAPI_MakeOffsetShape.hxx>`, `<TDocStd_Application.hxx>`, `<TDocStd_Document.hxx>`, `<XCAFDoc_DocumentTool.hxx>`, `<XCAFDoc_ShapeTool.hxx>`, `<XCAFDoc_Location.hxx>`, `<TDF_Label.hxx>`. Confirm `cmake --build build` succeeds (headers resolve from `${OpenCASCADE_LIBRARIES}` include paths — no CMakeLists.txt change needed per research.md §R-001).

**Checkpoint**: `cmake --build build` succeeds with the new includes.

---

## Phase 3: User Story 2 — Topological Interrogation (Priority: P1) 🎯 Implement First

**Goal**: Four non-mutating read tools — `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology`. No transaction required. Provides the face/edge ID resolution tooling all other stories depend on for verification.

**Independent Test**: Load `braai.step` → call all 4 tools in sequence → assert results match known fixture metrics → call twice → assert results are bit-identical (determinism).

### Implementation for User Story 2

- [x] T005 [P] [US2] Add 4 virtual method signatures to the `GeometryService` abstract class in `cpp/src/geometry/geometry_service.hpp`: `virtual BoundingBoxResult computeBoundingBox(const std::string& entityId) = 0`, `virtual MassPropertiesResult computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) = 0`, `virtual MeasureResult measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) = 0`, `virtual ExploreResult exploreTopology(const std::string& entityId, const std::string& returnType) = 0`.

- [x] T006 [US2] Implement all 4 methods in `cpp/src/geometry/geometry_service.cc`. `computeBoundingBox`: look up entity (solid or shell) in `solids_`/`shells_` maps, call `BRepBndLib::AddOptimal(shape, box)`, extract min/max. `computeMassProperties`: dispatch on requested properties — `BRepGProp::VolumeProperties(shape, props)` for volume/centroid/inertia, `BRepGProp::SurfaceProperties(shape, props)` for surface_area. `measureDistance`: `min_distance`/`max_distance` via `BRepExtrema_DistShapeShape`; `angle` via `Geom_Plane::Axis().Direction()` on both face surfaces (throw `GE_ALIGN_UNSUPPORTED` if non-planar per research.md §R-010). `exploreTopology`: `TopExp_Explorer(shape, returnType)` → collect `shapeId(sub)` in iteration order. Throw `GE_SHELL_NOT_FOUND`/`GE_SOLID_NOT_FOUND` on unknown entity IDs.

- [x] T007 [P] [US2] Register `computeBoundingBox`, `computeMassProperties`, `measureDistance`, `exploreTopology` as NAPI functions in `cpp/src/napi/addon.cc` following the existing registration pattern. Add corresponding method signatures to the `GeometryAddon` interface in `ts/src/geometry/binding.ts` with correct parameter and return types using the new TS interfaces from T002.

- [x] T008 [P] [US2] Add tool definitions for `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology` to `getToolDefinitions()` in `ts/src/mcp/tools.ts` per the schemas in `specs/006-geometry-primitives/contracts/mcp-tool-schemas.md`. Add 4 dispatch cases to the tool switch. Interrogation tools: no `transaction_id` required. `mass_properties`: default `properties` to all four when omitted.

- [x] T009 [US2] Write integration tests in `ts/tests/integration/interrogation.integration.test.ts`. Cover: (a) `bounding_box` on `braai.step` returns correct AABB within 1e-4mm; (b) `mass_properties` with `["volume","centroid"]` returns expected values for the fixture; (c) `measure_distance(face_a, face_b, "min_distance")` where faces are parallel and separated by known distance d; (d) `measure_distance` with `"angle"` on two planar faces; (e) `measure_distance` with `"angle"` on a non-planar face returns `GE_ALIGN_UNSUPPORTED`; (f) `explore_topology` returns exactly N faces for the fixture body; (g) determinism: two calls on identical input produce byte-identical output; (h) unknown entity id returns `GE_SHELL_NOT_FOUND`.

**Checkpoint**: All 4 interrogation tools pass integration tests. `explore_topology` can now be used in later stories to discover face/edge IDs for fillet, chamfer, delete_face inputs.

---

## Phase 4: User Story 1 — Boolean Operations (Priority: P1)

**Goal**: Three general-purpose boolean ops — `fuse_bodies`, `cut_bodies`, `intersect_bodies`. All mutating, require `transaction_id`, emit `ShapeHistoryRecord`s for semantic remap.

**Independent Test**: Load two overlapping boxes → `begin_transaction` → `fuse_bodies` → assert volume = V_A + V_B − V_overlap → `commit_transaction` → `rollback_transaction` on a fresh identical session restores both originals.

### Implementation for User Story 1

- [x] T010 [P] [US1] Add 3 virtual method signatures to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`: `virtual FuseResult fuseBodies(const std::vector<ShellId>& tools, double fuzzyTolerance) = 0`, `virtual CutResult cutBodies(const ShellId& blank, const std::vector<ShellId>& tools, bool keepTools) = 0`, `virtual IntersectResult intersectBodies(const ShellId& a, const ShellId& b) = 0`.

- [x] T011 [US1] Implement all 3 boolean methods in `cpp/src/geometry/geometry_service.cc`. Pattern for all three: create snapshot, build operation (`BRepAlgoAPI_Fuse`/`BRepAlgoAPI_Cut`/`BRepAlgoAPI_Common` — already `#include`d), check `IsDone()`, run `BRepCheck_Analyzer` on result (throw `GE_BOOLEAN_FAILURE` if fails), capture history via `captureHistory(algo, inputShape, resolveId, operationLabel)` for each input shape, register result as new shell, remove inputs from `shells_` as appropriate. `fuseBodies`: handle ≥2 tools by fusing pairwise; detect `disjoint` by checking `result.ShapeType() == TopAbs_COMPOUND`. `cutBodies`: if `!keepTools`, remove tool shells. `intersectBodies`: empty result (zero volume via `BRepGProp`) → throw `GE_BOOLEAN_EMPTY_RESULT`.

- [x] T012 [P] [US1] Register `fuseBodies`, `cutBodies`, `intersectBodies` NAPI functions in `cpp/src/napi/addon.cc`. Add corresponding methods to `GeometryAddon` interface in `ts/src/geometry/binding.ts`.

- [x] T013 [P] [US1] Add tool definitions for `fuse_bodies`, `cut_bodies`, `intersect_bodies` to `getToolDefinitions()` in `ts/src/mcp/tools.ts` per contracts/mcp-tool-schemas.md. Add 3 dispatch cases. Each validates `transaction_id` is present (throw `TRANSACTION_REQUIRED` if not). After the C++ call, append returned `shape_history` records to `transactionRegistry.getActive().shapeHistory`.

- [x] T014 [US1] Write integration tests in `ts/tests/integration/booleans.integration.test.ts`. Cover: (a) fuse two overlapping boxes: volume = V_A + V_B − V_intersection; (b) fuse two disjoint boxes: `disjoint: true`; (c) cut with `keep_tools: false` removes tool shell from session; (d) cut with `keep_tools: true` keeps tool shell; (e) intersect with known overlap: result volume matches pre-calculated intersection; (f) intersect with no overlap: `GE_BOOLEAN_EMPTY_RESULT`; (g) rollback after fuse restores both original shells; (h) semantic remap: declare entity on a face of body A before fuse, verify binding resolves to corresponding face on fused result after commit_transaction.

**Checkpoint**: 3 boolean tools working with semantic remap verified in integration test.

---

## Phase 5: User Story 3 — Geometric Transformations (Priority: P2)

**Goal**: Five rigid-body transform tools — `translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face`. All mutating, support `keep_original`.

**Independent Test**: Load a box at origin → `translate_body([10,0,0])` inside a transaction → assert bounding box shifted by 10 in x → commit → rollback on fresh session restores original.

### Implementation for User Story 3

- [x] T015 [P] [US3] Add 5 virtual method signatures to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`: `translateBody`, `rotateBody`, `mirrorBody`, `scaleBody`, `alignToFace` (signatures from plan.md §C++ GeometryService interface additions). All return `TransformResult`.

- [x] T016 [US3] Implement `translateBody` and `rotateBody` in `cpp/src/geometry/geometry_service.cc`. Both follow the same skeleton: build `gp_Trsf` via `SetTranslation(gp_Vec)` / `SetRotation(gp_Ax1, angleDeg * M_PI / 180)`, apply via `BRepBuilderAPI_Transform(shape, trsf, /*copy=*/true)`, register new shell, delete old unless `keepOriginal`, capture history via `captureHistory` (all face verdicts will be `Modified`). `BRepBuilderAPI_Transform` is already `#include`d after T004.

- [x] T017 [US3] Implement `mirrorBody` (`gp_Trsf::SetMirror(gp_Ax2)` from `plane_origin`+`plane_normal`), `scaleBody` (`gp_Trsf::SetScale(gp_Pnt, factor)` — validate factor > 0), and `alignToFace` (extract `Geom_Plane` from both faces via `BRep_Tool::Surface` → `Handle(Geom_Plane)::DownCast`; throw `GE_ALIGN_UNSUPPORTED` if `IsNull()`; build `gp_Ax3` from each plane's `Position()`; compute `gp_Trsf::SetTransformation(srcAx3, dstAx3)`; apply flip if `flipNormal`) in `cpp/src/geometry/geometry_service.cc`.

- [x] T018 [P] [US3] Register all 5 transform NAPI functions in `cpp/src/napi/addon.cc`. Add methods to `GeometryAddon` interface in `ts/src/geometry/binding.ts`. Pass vector/axis params as arrays.

- [x] T019 [P] [US3] Add tool definitions for `translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face` to `getToolDefinitions()` in `ts/src/mcp/tools.ts` per contracts/mcp-tool-schemas.md. Add 5 dispatch cases. All require `transaction_id`. Handle `GE_ALIGN_UNSUPPORTED` in `align_to_face` dispatch. Emit `shape_history` records on transaction.

- [x] T020 [US3] Write integration tests in `ts/tests/integration/transforms.integration.test.ts`. Cover: (a) `translate_body`: bounding box shifts by exact vector; (b) `rotate_body` 90° around Z: known point remaps from (1,0,0) to (0,1,0) within 1e-6; (c) `mirror_body` across YZ plane: bounding box x-extents are negated; (d) `scale_body` 1.5×: volume = V × 1.5³; (e) `align_to_face` on two planar faces: centroids coincide and normals are anti-parallel after alignment; (f) `align_to_face` on non-planar face: `GE_ALIGN_UNSUPPORTED`; (g) `keep_original: true` leaves original shell in session; (h) rollback for each transform restores original.

**Checkpoint**: 5 transform tools working, `keep_original` verified.

---

## Phase 6: User Story 4 — Direct Edit Operations (Priority: P2)

**Goal**: Six direct-edit tools — `fillet_edges`, `chamfer_edges`, `simplify_body`, `heal_geometry_ex`, `offset_shape`, `delete_face`. Requires edge/face IDs from `explore_topology` (US2).

**Independent Test**: Load a box → `explore_topology` for edges → `fillet_edges` on one edge → commit → assert that edge is replaced by a cylindrical fillet of the requested radius.

### Implementation for User Story 4

- [ ] T021 [P] [US4] Add 6 virtual method signatures to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`: `filletEdges`, `chamferEdges`, `simplifyBody`, `healGeometryEx`, `offsetShape`, `deleteFace` (signatures from plan.md §C++ GeometryService interface additions). Return types: `FilletResult`, `ChamferResult`, `SimplifyResult`, `HealExResult`, `OffsetShapeResult`, `DeleteFaceResult` respectively.

- [ ] T022 [US4] Implement `filletEdges` and `chamferEdges` in `cpp/src/geometry/geometry_service.cc`. Both use the edge-ID resolution pattern from research.md §R-004: `TopExp_Explorer(shape, TopAbs_EDGE)`, collect edges matching requested IDs via `shapeId(edge)`, add each to `BRepFilletAPI_MakeFillet(shape)` / `BRepFilletAPI_MakeChamfer(shape)`. Call `Build()`. If `!IsDone()`: catch `Standard_Failure` and throw `GE_FILLET_TOO_LARGE` / `GE_CHAMFER_TOO_LARGE` with the offending edge ID. On success: register new shell, capture history.

- [ ] T023 [US4] Implement `simplifyBody` (`ShapeUpgrade_UnifySameDomain` — newly included in T004), `healGeometryEx` (`ShapeFix_Shape` — already `#include`d; run `BRepCheck_Analyzer` on result; populate `HealExResult.healComplete` and `remainingIssues`), `offsetShape` (`BRepOffsetAPI_MakeOffsetShape` with `BRepOffset_Skin` mode — newly included in T004), and `deleteFace` (remove target faces from shell via `BRepBuilderAPI_Sewing` minus those faces + optional `ShapeFix_Shape`; if result disconnects into multiple shells, register each as a separate `ShellId` and return all in `DeleteFaceResult.solidIds`) in `cpp/src/geometry/geometry_service.cc`.

- [ ] T024 [P] [US4] Register all 6 direct-edit NAPI functions in `cpp/src/napi/addon.cc`. Add methods to `GeometryAddon` interface in `ts/src/geometry/binding.ts`.

- [ ] T025 [P] [US4] Add tool definitions for `fillet_edges`, `chamfer_edges`, `simplify_body`, `heal_geometry_ex`, `offset_shape`, `delete_face` to `getToolDefinitions()` in `ts/src/mcp/tools.ts` per contracts/mcp-tool-schemas.md. Add 6 dispatch cases. `fillet_edges`/`chamfer_edges`: validate `radius`/`distance` > 0. `delete_face`: response has `solid_ids` array. `heal_geometry_ex`: response includes `heal_complete` and `remaining_issues` — not an error even when `heal_complete: false`.

- [ ] T026 [US4] Write integration tests in `ts/tests/integration/direct_edits.integration.test.ts`. Cover: (a) `fillet_edges` on a box edge: new solid has fewer sharp edges; (b) `fillet_edges` with radius > half-face-width: `GE_FILLET_TOO_LARGE`; (c) `chamfer_edges`; (d) `simplify_body` on a body with known redundant co-planar faces: face count decreases; (e) `heal_geometry_ex` on a valid body: `heal_complete: true`; (f) `offset_shape` outward: bounding box dimensions all increase by 2×offset; (g) `delete_face` + `heal_remaining: true`: valid shell returned; (h) `delete_face` that disconnects body: `solid_ids.length > 1`; (i) rollback for each tool restores original.

**Checkpoint**: 6 direct-edit tools working. Full US4 integration test file passing.

---

## Phase 7: User Story 5 — Topology Sewing (Priority: P3)

**Goal**: One tool — `sew_faces`. Stitches loose faces into a shell or solid.

**Independent Test**: Construct 3 adjacent faces sharing edges → `sew_faces({tolerance: 0.001, make_solid: false})` → assert single shell with `sew_complete: true` and empty `free_edges`.

### Implementation for User Story 5

- [ ] T027 [US5] Add virtual signature `virtual SewResult sewFaces(const std::vector<std::string>& entityIds, double tolerance, bool makeSolid) = 0` to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`. Implement in `cpp/src/geometry/geometry_service.cc`: look up each entity ID in `shells_` and `solids_` maps; add each shape to `BRepBuilderAPI_Sewing` (already `#include`d) via `sewer.Add(shape)`; call `sewer.Perform()`; retrieve `sewer.SewedShape()`. Collect free edges via `sewer.NbFreeEdges()` + `sewer.FreeEdge(i)` → `shapeId(edge)` for `SewResult.freeEdges`; set `sewComplete = freeEdges.empty()`. If `makeSolid` and result is a closed shell, wrap in `BRepBuilderAPI_MakeSolid`. Register result, capture history.

- [ ] T028 [P] [US5] Register `sewFaces` NAPI function in `cpp/src/napi/addon.cc` and add to `GeometryAddon` interface in `ts/src/geometry/binding.ts`. Add tool definition for `sew_faces` to `getToolDefinitions()` and dispatch case in `ts/src/mcp/tools.ts` per contracts/mcp-tool-schemas.md. Return `sew_complete` and `free_edges[]` in response. Requires `transaction_id`.

- [ ] T029 [US5] Write integration tests in `ts/tests/integration/sew.integration.test.ts`. Cover: (a) sew N adjacent faces → `sew_complete: true`, `free_edges: []`; (b) `make_solid: true` on closed face set → result is a solid (verify via `mass_properties` returning a volume); (c) sew disjoint faces → `sew_complete: false`, `free_edges` non-empty; (d) rollback restores original faces.

**Checkpoint**: `sew_faces` working with free-edge reporting.

---

## Phase 8: User Story 6 — Hierarchical Assembly / XCAF (Priority: P3)

**Goal**: Four assembly tools — `create_assembly_document`, `add_assembly_instance`, `mate_rigid`, `list_assembly_tree`. Introduces XCAF session state to the C++ Geometry Engine.

**Independent Test**: `create_assembly_document` → `add_assembly_instance` (×3) → `list_assembly_tree` → assert 3 children. Then `mate_rigid` on two planar faces → assert location_matrix reflects snap.

### Implementation for User Story 6

- [ ] T030 [US6] Add `AssemblyState` internal struct and `assemblies_` map to `GeometryServiceImpl` in `cpp/src/geometry/geometry_service.cc`. `AssemblyState`: `AssemblyId id; Handle(TDocStd_Document) doc; Handle(XCAFDoc_ShapeTool) shapeTool; std::unordered_map<ComponentId, TDF_Label> components;`. Add 4 virtual method signatures to `GeometryService` in `cpp/src/geometry/geometry_service.hpp`: `createAssemblyDocument`, `addAssemblyInstance`, `mateRigid`, `listAssemblyTree` (signatures from plan.md §C++ GeometryService interface additions). Return `CreateAssemblyResult`, `AddInstanceResult`, `MateRigidResult`, `ListAssemblyResult`.

- [ ] T031 [US6] Implement `createAssemblyDocument` in `cpp/src/geometry/geometry_service.cc`: allocate `TDocStd_Document` via `TDocStd_Application::GetApplication()->NewDocument("BinXCAF", doc)`, init `XCAFDoc_ShapeTool`, generate UUID as `assemblyId`, store in `assemblies_`. Create snapshot capturing current `assemblies_` map size (allows rollback to detect and remove the new document).

- [ ] T032 [US6] Implement `addAssemblyInstance` in `cpp/src/geometry/geometry_service.cc`: look up `assembly_id` in `assemblies_`; look up `target` in `shells_` or `assemblies_`; call `shapeTool->AddShape(targetShape)` to get TDF_Label; if `location` provided, build `TopLoc_Location` from quaternion + translation via `gp_Trsf`, apply via `XCAFDoc_Location::Set(label, loc)`; generate `componentId` UUID; store label in `components` map. Create snapshot capturing the pre-add `components` map (rollback deletes the new entry and calls `shapeTool->RemoveShape(label)`).

- [ ] T033 [US6] Implement `mateRigid` in `cpp/src/geometry/geometry_service.cc`: resolve both face entity IDs to their parent component via the `components` map (throw `GE_ASSEMBLY_CROSS_DOCUMENT` if in different assemblies). Extract `gp_Ax3` from each face via `Geom_Plane` (throw `GE_ASSEMBLY_MATE_UNSUPPORTED` if non-planar). Build `gp_Trsf::SetTransformation(srcAx3, dstAx3)`. If `flipAlignment`, add a 180° rotation around the face normal to the transform. Apply to source component's location via `XCAFDoc_Location::Set`. Snapshot captures pre-mate location for rollback.

- [ ] T034 [US6] Implement `listAssemblyTree` in `cpp/src/geometry/geometry_service.cc`: look up `assembly_id`, call `shapeTool->GetFreeShapes(roots)`, recursively build `AssemblyNode` tree by iterating `shapeTool->GetComponents(label, children)`. Extract 4×4 location matrix from `TopLoc_Location::IsIdentity()` / `::IsTopLevelTransformation()` → `gp_Mat` → flat column-major `std::array<double,16>`. Non-mutating, no snapshot.

- [ ] T035 [P] [US6] Register `createAssemblyDocument`, `addAssemblyInstance`, `mateRigid`, `listAssemblyTree` NAPI functions in `cpp/src/napi/addon.cc`. Add methods to `GeometryAddon` interface in `ts/src/geometry/binding.ts`. Pass `location_matrix` as `number[]` (16 elements) across NAPI boundary. `listAssemblyTree` returns a recursive `AssemblyNode` object tree.

- [ ] T036 [P] [US6] Add tool definitions for `create_assembly_document`, `add_assembly_instance`, `mate_rigid`, `list_assembly_tree` to `getToolDefinitions()` in `ts/src/mcp/tools.ts` per contracts/mcp-tool-schemas.md. Add 4 dispatch cases. `list_assembly_tree`: no `transaction_id`. Others: require `transaction_id`. Handle `GE_ASSEMBLY_MATE_UNSUPPORTED` and `GE_ASSEMBLY_CROSS_DOCUMENT` in `mate_rigid` dispatch.

- [ ] T037 [US6] Write integration tests in `ts/tests/integration/assembly.integration.test.ts`. Cover: (a) `create_assembly_document` returns `assembly_id`; (b) `add_assembly_instance` × 3 → `list_assembly_tree` returns 3 children; (c) `add_assembly_instance` with explicit location → `list_assembly_tree` shows non-identity matrix; (d) `mate_rigid` on two planar faces → `location_matrix` changes to reflect snap (verify via `list_assembly_tree`); (e) `mate_rigid` on non-planar face → `GE_ASSEMBLY_MATE_UNSUPPORTED`; (f) rollback after `add_assembly_instance` → `list_assembly_tree` shows 0 children (component removed); (g) `create_assembly_document` without `transaction_id` → `TRANSACTION_REQUIRED`.

**Checkpoint**: 4 assembly tools working. Assembly rollback verified.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Regression validation, tool registry verification, documentation, and final acceptance gate.

- [ ] T038 [P] Run the full existing integration test suite (`ts/tests/integration/split_by_bends.*`, `ts/tests/integration/transaction.*`, `ts/tests/integration/semantic.*`, `ts/tests/integration/dolt_smoke.*`) and confirm zero regressions from the new tools. Fix any failures before marking complete. Command: `npm test` from `ts/`.

- [ ] T039 [P] Write a unit test in `ts/tests/unit/tool_registry.test.ts` asserting that `getToolDefinitions()` includes all 22 new tool names: `fuse_bodies`, `cut_bodies`, `intersect_bodies`, `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology`, `translate_body`, `rotate_body`, `mirror_body`, `scale_body`, `align_to_face`, `fillet_edges`, `chamfer_edges`, `simplify_body`, `heal_geometry_ex`, `offset_shape`, `delete_face`, `sew_faces`, `create_assembly_document`, `add_assembly_instance`, `mate_rigid`, `list_assembly_tree`. Also assert total tool count is previous count + 22.

- [ ] T040 Run the smoke test sequence from `specs/006-geometry-primitives/quickstart.md` manually against `braai.step` + `simple_box.stp`. Mark the checklist items in `specs/006-geometry-primitives/checklists/requirements.md` as complete once verified. Document any deviations in checklist Notes.

- [ ] T041 [P] Update `docs/OCCT_API_USAGE.md` to add entries for the 6 newly-wired OCCT modules: `BRepBuilderAPI_Transform` (transform_body tools), `ShapeUpgrade_UnifySameDomain` (simplify_body), `BRepOffsetAPI_MakeOffsetShape` (offset_shape), `BRepFilletAPI_MakeFillet` (fillet_edges — was deferred, now active), `BRepAlgoAPI_Fuse` (fuse_bodies — was deferred, now active), and the XCAF group (`TDocStd_Document`, `XCAFDoc_ShapeTool`, `XCAFDoc_Location` — assembly tools). Remove these from the "APIs Explicitly NOT Used" table and add them to the module tables with stability notes per existing format.

**Checkpoint**: All 41 tasks complete, zero regressions, all 22 new tools in registry.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1** (T001–T002): No dependencies — start immediately. Both tasks are independent [P].
- **Phase 2** (T003–T004): Depends on Phase 1 completion. Both tasks are independent [P].
- **Phase 3 – US2** (T005–T009): Depends on Phase 2. T005 (hpp) before T006 (cc implementation). T007, T008 parallelizable after T006. T009 after T007+T008.
- **Phase 4 – US1** (T010–T014): Depends on Phase 2. Can start in parallel with Phase 3 (different files). T010 (hpp) before T011 (cc). T012, T013 parallelizable after T011. T014 after T012+T013.
- **Phase 5 – US3** (T015–T020): Depends on Phase 2. T015 before T016 before T017. T018, T019 parallelizable after T017. T020 after T018+T019.
- **Phase 6 – US4** (T021–T026): Depends on Phase 2 + Phase 3 (uses `explore_topology` for test inputs). T021 before T022 before T023. T024, T025 parallelizable after T023. T026 after T024+T025.
- **Phase 7 – US5** (T027–T029): Depends on Phase 2. T027 before T028. T029 after T028.
- **Phase 8 – US6** (T030–T037): Depends on Phase 2 + Phase 3 (uses `explore_topology` for face lookups in mate_rigid). T030 → T031 → T032 → T033 → T034 (sequential, each extends the previous). T035, T036 parallelizable after T034. T037 after T035+T036.
- **Phase 9** (T038–T041): Depends on all story phases complete. T038, T039, T041 parallelizable. T040 after T038+T039.

### User Story Dependencies

- **US2 (P1, Interrogation)**: No dependency on other new stories. Recommended first.
- **US1 (P1, Booleans)**: No dependency on other new stories. Can develop in parallel with US2.
- **US3 (P2, Transforms)**: No dependency on US1/US2 in implementation. Integration tests benefit from US2 tools for verification.
- **US4 (P2, Direct Edits)**: Depends on US2 (`explore_topology` needed to get edge/face IDs for fillet/chamfer/delete tests).
- **US5 (P3, Sewing)**: No dependency on other new stories.
- **US6 (P3, Assembly)**: Depends on US2 (`explore_topology` needed to resolve face IDs for `mate_rigid` tests).

---

## Parallel Execution Examples

### Phase 3 (US2 Interrogation) — After T006

```
T007: Register NAPI functions (addon.cc + binding.ts)
T008: Add tool definitions + dispatch (tools.ts)
→ Both touch different files, run in parallel
→ Both complete → T009: Write integration tests
```

### Phases 3 + 4 — After Phase 2 completes

```
Phase 3 (US2): T005 → T006 → T007+T008 → T009
Phase 4 (US1): T010 → T011 → T012+T013 → T014
→ These two phase tracks are fully independent (different method groups in .cc, different test files)
```

### Phase 9 Polish — After all stories complete

```
T038: Run existing regression tests
T039: Tool registry unit test
T041: Update OCCT_API_USAGE.md
→ All three fully parallelizable
→ T040 (smoke test) after T038+T039
```

---

## Implementation Strategy

### MVP First (US2 + US1 Only)

1. Complete Phase 1: Setup (error codes + TS types)
2. Complete Phase 2: Foundational (C++ result structs + OCCT includes)
3. Complete Phase 3: US2 Interrogation (4 non-mutating tools)
4. **STOP and VALIDATE**: All 4 interrogation tools work, `explore_topology` returns face/edge IDs
5. Complete Phase 4: US1 Booleans (3 mutating tools + semantic remap)
6. **STOP and VALIDATE**: fuse/cut/intersect working with transaction + rollback

At this point: 7 tools shipped, all foundational infrastructure validated.

### Incremental Delivery

- Add US3 (Transforms) → 5 more tools, all patterns established
- Add US4 (Direct Edits) → 6 more tools, depends on US2 edge IDs
- Add US5 (Sewing) → 1 more tool, minimal risk
- Add US6 (Assembly) → 4 more tools, new XCAF context
- Polish → zero regressions, docs updated

### Parallel Team Strategy

After Phase 2 (Foundational) is complete:

- **Developer A**: US2 (Interrogation) → US4 (Direct Edits) — uses `explore_topology` results
- **Developer B**: US1 (Booleans) → US3 (Transforms) — pure mutation path
- **Developer C**: US5 (Sewing) → US6 (Assembly) — P3 stories, XCAF

All three tracks are independent at the file level after Phase 2.

---

## Notes

- [P] tasks = different files, no in-phase dependency — safe to parallelize
- Every mutating tool must have: `transaction_id` validated, `rollback_token` returned, `shape_history` emitted
- `explore_topology` (T006) must be verified working before starting US4 (Direct Edits) tests — edge/face IDs from it are used as inputs to fillet/chamfer/delete_face
- XCAF `TDF_Label` values are OCCT-internal — never cross the NAPI boundary. Only `ComponentId` (UUID string) is exposed to TypeScript
- Avoid adding OCCT `#include` to any file other than `geometry_service.cc` (Constitution Principle II)
- Commit after each phase checkpoint using `/speckit-git-commit`
