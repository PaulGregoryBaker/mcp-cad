# Feature Specification: Geometric Primitive Tools (Booleans, Transforms, Direct Edits, Interrogation, Assembly)

**Feature Branch**: `006-geometry-primitives`

**Created**: 2026-05-24

**Status**: Draft

**Input**: External requirements document [docs/MoreMCPTools.md](../../docs/MoreMCPTools.md) — *"CAD Geometric Control MCP: Tool Taxonomy & OCCT Mapping (MVP)"*. Adopted in full and adapted to project conventions (snake_case naming, transactional + semantic integration per [004](../004-transaction-primitive/spec.md) and [005](../005-semantic-mapping-layer/spec.md)).

---

## Background

The project today exposes a focused, sheet-metal-oriented set of MCP tools (decompose, joint synthesis, unfold, nest, export — plus the targeted geometric editors `trim_body_with_plane`, `split_body_by_plane`, `split_body_by_bends`, `offset_face`, `add_flange`, `rip_edge`, etc.). It is missing the **general-purpose OCCT primitive layer** an AI agent needs to compose arbitrary geometric reasoning: pure boolean ops, rigid-body transforms, generic edge editing, simple interrogation, and hierarchical assembly placement.

`docs/MoreMCPTools.md` defines that primitive layer as ~20 tools across five categories. This feature adopts that catalogue into the project, adapted to the project's:

- Snake-case tool naming (existing tools never use dotted names).
- Transaction primitive ([004](../004-transaction-primitive/spec.md)) — every mutating tool must accept `transaction_id`, emit `ShapeHistoryRecord`s, and be rolled back atomically.
- Semantic mapping layer ([005](../005-semantic-mapping-layer/spec.md)) — bindings against affected entities must survive the operation via the commit-time remap pass.
- Constitution v1.2 — structured errors, MVP scope discipline, rollback-first state.

The Assembly/Mating category (XCAF) introduces a new sub-context: a hierarchical assembly document layered over the existing flat-body session. This was explicitly elected during clarification (see Assumptions §Scope).

---

## User Scenarios & Testing

### User Story 1 — Boolean operations on arbitrary solids (Priority: P1)

An AI agent has two intersecting solids loaded into the session (e.g. a base block and a cylindrical cutter). It needs to compose them — fuse them into a single body, subtract one from the other, or extract the shared volume — without resorting to the specialized `trim_body_with_plane` / `split_body_by_plane` editors that only accept a plane.

**Why this priority**: Pure boolean ops are the most-requested missing primitive. Many higher-level workflows (joint synthesis, protrusion removal, custom decomposition) currently re-implement subsets internally because no general `fuse` / `cut` / `intersect` tool exists. Unblocking this lets the agent compose its own geometric reasoning.

**Independent Test**: Open transaction → load two intersecting solids → call `fuse_bodies` → commit. Assert (a) a single new solid id is returned, (b) volume equals the union volume within tolerance, (c) `get_transaction_history` shows the input solids as deleted and the output solid as generated, (d) rollback restores both originals.

**Acceptance Scenarios**:

1. **Given** solids `A` and `B` overlap in a known region of volume V_overlap, **When** `fuse_bodies({tools: [A, B]})` is called inside a transaction, **Then** a new solid id is returned whose volume equals `Vol(A) + Vol(B) − V_overlap` within 1e-6 mm³, and the response includes a `shape_history` summary with `A`/`B` mapped to the new id via `Modified`/`Generated` records.

2. **Given** solid `base` and tool solids `cutter1`, `cutter2` whose union lies wholly inside `base`, **When** `cut_bodies({blank: base, tools: [cutter1, cutter2], keep_tools: false})` is called, **Then** the response returns a single new blank id with `Vol(base) − Vol(cutter1 ∪ cutter2)` and the two cutters are reported as deleted (since `keep_tools: false`).

3. **Given** the same setup with `keep_tools: true`, **When** the same call is made, **Then** the cutter solids remain in the session unchanged in addition to the new blank.

4. **Given** solids `A` and `B` with overlapping volume, **When** `intersect_bodies({targets: [A, B]})` is called, **Then** a new solid representing the shared volume is returned; if no overlap exists, `BOOLEAN_EMPTY_RESULT` is returned.

5. **Given** a transaction containing a `fuse_bodies` call, **When** `rollback_transaction` is invoked, **Then** the original solids are restored and the generated id no longer resolves.

6. **Given** a semantic entity bound to a face on solid `A` before fusion, **When** the fuse transaction commits, **Then** `resolve_geometry` on that entity returns the corresponding face on the fused result via the [005](../005-semantic-mapping-layer/spec.md) remap pass.

---

### User Story 2 — Topological interrogation for AI reasoning (Priority: P1)

An AI agent needs to ask the geometry engine factual questions before deciding what to do: *"what faces does this solid have?"*, *"what's its bounding box?"*, *"how far apart are these two faces?"*, *"what's the centroid and volume?"*. These are non-mutating reads and are the cheapest, safest tools to expose first.

**Why this priority**: Interrogation tools are pure functions — no rollback, no transaction integration, no semantic remap. They are the lowest-risk slice and they unblock the agent's ability to verify the outcome of every other tool in this spec.

**Independent Test**: Load `braai.step` → call `bounding_box`, `mass_properties`, `measure_distance`, `explore_topology` in sequence on the same solid. Assert returned values match known fixture metrics within tolerance; no session state changes between calls.

**Acceptance Scenarios**:

1. **Given** a loaded solid `S` with known AABB `[xmin..xmax, ymin..ymax, zmin..zmax]`, **When** `bounding_box({target: S})` is called, **Then** the returned box matches within 1e-4 mm.

2. **Given** solid `S` with known volume V and centroid `(cx,cy,cz)`, **When** `mass_properties({target: S, properties: ["volume", "centroid"]})` is called, **Then** the response contains `volume` within 1e-4 mm³ and `centroid` within 1e-4 mm.

3. **Given** two parallel faces `face_a`, `face_b` on the same solid separated by distance `d`, **When** `measure_distance({target_a: face_a, target_b: face_b, measurement_type: "min_distance"})` is called, **Then** the returned distance equals `d` within 1e-6 mm.

4. **Given** solid `S` with N faces, M edges, K vertices, **When** `explore_topology({target: S, return_type: "face"})` is called, **Then** the response returns exactly N face ids in deterministic order; same for `edge` (M) and `vertex` (K).

5. **Given** any of the four interrogation tools, **When** called twice on the same input, **Then** the response is bit-identical (deterministic).

6. **Given** a non-existent target id, **When** any interrogation tool is called, **Then** `ENTITY_NOT_FOUND` is returned per Constitution Principle VI.

---

### User Story 3 — Rigid-body transformations and snap-alignment (Priority: P2)

An AI agent has placed a solid in the wrong orientation, or needs to mirror it across a plane, or wants to snap one face onto another (e.g. seat a stamped bracket against a chassis face). The agent needs `translate`, `rotate`, `mirror`, `scale`, and `align` as first-class tools — currently the only way to reposition geometry is to re-export and re-import.

**Why this priority**: Transformations are foundational but rarely the *first* thing an agent needs in the sheet-metal MVP (parts arrive pre-oriented from STEP). However they are required for assembly-time placement and for any agent that composes geometry from multiple sources. P2 reflects "needed soon, not the critical path".

**Independent Test**: Open transaction → load solid `S` → call `translate_body({vector: [10, 0, 0]})` → bounding-box assert shifted by 10 in x → rollback → re-assert original box.

**Acceptance Scenarios**:

1. **Given** solid `S` with bounding box centered at origin, **When** `translate_body({targets: [S], vector: [10, 0, -5]})` is called inside a transaction, **Then** the new solid's bounding box is shifted by `(10, 0, -5)` and a `shape_history` record links the original to the transformed id.

2. **Given** solid `S`, **When** `rotate_body({targets: [S], axis_origin: [0,0,0], axis_direction: [0,0,1], angle_degrees: 90})` is called, **Then** every face id has been remapped through `Modified` history and a point previously at `(1, 0, 0)` on the body now resolves to approximately `(0, 1, 0)`.

3. **Given** solid `S`, **When** `mirror_body({targets: [S], plane_origin: [0,0,0], plane_normal: [1,0,0]})` is called, **Then** a new mirrored solid is returned with orientation flipped; if `keep_original: true` was supplied, both copies exist post-commit.

4. **Given** solid `S` with volume V, **When** `scale_body({targets: [S], origin: [0,0,0], scale_factor: 1.5})` is called, **Then** the new solid's volume equals `V × 1.5³` within 1e-4 mm³.

5. **Given** two planar faces `src` and `dst` with known normals, **When** `align_to_face({source: src, destination: dst, flip_normal: false})` is called, **Then** the body containing `src` is repositioned so `src` is coincident with `dst` (centroids overlap, normals anti-parallel within 1e-6 rad).

6. **Given** any transform tool on a body with a semantic binding, **When** the transaction commits, **Then** the binding's face-group reflects the post-transform face ids via the remap pass.

---

### User Story 4 — Direct-edit operations on existing geometry (Priority: P2)

An AI agent has an existing solid and needs to modify its boundary directly — round an edge, chamfer a corner, simplify imported STEP topology with redundant co-planar faces, offset the entire shell to add wall thickness, remove a face to open a pocket, or heal a non-manifold body. These are the OCCT "direct modeling" toolkit.

**Why this priority**: Direct edits enable common AI-driven refinements ("round all the bend-side edges", "shell this body to 2mm wall thickness"). The current toolset has only `offset_face` (single face) and the implicit healing inside `clean_geometry`; explicit primitives unlock much broader composition. P2 because they layer on top of P1 booleans rather than blocking them.

**Independent Test**: Load a solid with sharp edges → call `fillet_edges({radius: 2.5})` on specific edges → commit. Assert affected edges are now filleted (curvature radius matches within 1e-4 mm); other geometry unchanged.

**Acceptance Scenarios**:

1. **Given** solid `S` and edge ids `[e1, e2]`, **When** `fillet_edges({targets: [e1, e2], radius: 2.5})` is called, **Then** the new solid has those edges replaced by cylindrical fillets of the requested radius, and `shape_history` reports `e1`/`e2` as `Modified → [new face ids]`.

2. **Given** the same setup with `chamfer_edges({distance: 1.0})`, **Then** the edges are replaced by planar chamfers of the given offset.

3. **Given** a solid imported from STEP with redundant co-planar adjacent faces, **When** `simplify_body({targets: [S], unify_faces: true, unify_edges: true})` is called, **Then** the returned solid has fewer faces (matching `ShapeUpgrade_UnifySameDomain` semantics) and is topologically equivalent (volume preserved within 1e-6 mm³).

4. **Given** solid `S` with a known invalid wire (gap), **When** `heal_geometry({targets: [S], fix_tolerances: true, fix_wires: true})` is called, **Then** the returned solid passes `BRepCheck_Analyzer` where the original did not.

5. **Given** solid `S` with surface area `A_orig`, **When** `offset_shape({targets: [S], offset_value: 2.5})` is called with `direction: "outward"`, **Then** the returned solid is strictly enclosing `S` and has greater surface area (sanity bound only — exact value depends on convexity).

6. **Given** solid `S` and face id `f`, **When** `delete_face({targets: [f], heal_remaining: true})` is called, **Then** the returned shape is a valid shell (or solid, if healing closed it) with `f` removed; if `heal_remaining: false`, an open shell is returned.

7. **Given** any direct-edit operation, **When** rolled back, **Then** the original solid is restored byte-equivalent to its pre-call state.

---

### User Story 5 — Topology sewing for surface-modeling workflows (Priority: P3)

An AI agent has a set of loose faces (e.g. from a partially failed STEP import, or from constructing surfaces face-by-face) and needs to stitch them into a single shell or solid. OCCT's `BRepBuilderAPI_Sewing` is the standard primitive for this and is currently inaccessible.

**Why this priority**: Surface-modeling workflows are a niche relative to the MVP's sheet-metal focus, but stitching is the only way to recover from certain STEP import failures. P3 reflects "needed eventually, not blocking MVP".

**Independent Test**: Construct three faces that share edges → call `sew_faces({tolerance: 0.001, make_solid: true})` → assert a single shell (or solid, if closed) is returned with all input faces consumed.

**Acceptance Scenarios**:

1. **Given** N adjacent faces with shared edges within `tolerance`, **When** `sew_faces({targets: [f1..fN], tolerance: 0.001, make_solid: false})` is called, **Then** a single shell is returned containing all N faces.

2. **Given** the same setup with `make_solid: true` and a closed face set, **Then** the result is a solid (closed shell).

3. **Given** face inputs that cannot form a connected shell within tolerance, **When** sewing is attempted, **Then** the response includes a list of free (unstitched) edges and a `SEW_INCOMPLETE` warning (the operation succeeds but the agent is told what failed).

---

### User Story 6 — Hierarchical assembly placement (Priority: P3)

An AI agent needs to compose multiple solids into an assembly tree (e.g. "instance the firebox panel into the chassis assembly at this location"), and to "mate" two parts by snapping a face on one to a face on another. This requires OCCT's XCAF assembly document model — a new bounded sub-context layered over the existing flat-body session.

**Why this priority**: Assembly modelling is not on the sheet-metal MVP critical path (the MVP currently outputs flat DXFs, not assembled CAD). It is included in this feature for completeness with the source doc, but is explicitly the last priority — if scope pressure emerges during planning, this story is the first candidate to split off.

**Independent Test**: Create an assembly document → add three solid instances via `add_assembly_instance` → call `mate_rigid` on two of them → assert the mated component's transform reflects the snap. Round-trip the assembly through OCCT's XCAF reader/writer (or a session export) and assert the structure survives.

**Acceptance Scenarios**:

1. **Given** an empty assembly document and a solid `S`, **When** `add_assembly_instance({target: S, parent_assembly: "assembly:root"})` is called, **Then** a new component id is returned, the assembly document contains that component as a child of root, and a subsequent query of the assembly tree reflects this.

2. **Given** two assembly components `compA` and `compB` and a face on each (`face_a`, `face_b`), **When** `mate_rigid({source_entity: face_a, target_entity: face_b, mate_type: "coincident", flip_alignment: false})` is called, **Then** `compB`'s location transform is updated so `face_b` is coincident with `face_a`; `compA` does not move.

3. **Given** the same setup with `mate_type: "coincident"` but the face normals already coplanar in the wrong orientation, **When** `flip_alignment: true` is supplied, **Then** the resulting orientation has the face normals anti-parallel.

4. **Given** an assembly with N instances, **When** the session is exported and re-loaded, **Then** the assembly tree, instance locations, and mate-derived transforms round-trip exactly.

5. **Given** a `mate_rigid` call where one of the supplied entity ids is not a planar face, **When** the call is made, **Then** `ASSEMBLY_MATE_UNSUPPORTED_GEOMETRY` is returned (Phase 1 supports planar coincident mates only).

---

### Edge Cases

- **Boolean fuse of disjoint (non-touching) solids.** Per OCCT, the result is a single compound, not a single connected solid. Spec: return success with a `disjoint: true` flag on the response so the agent knows it received a compound, not a single body. No error.
- **Boolean cut where the tool wholly contains the blank.** Result is empty. Return `BOOLEAN_EMPTY_RESULT` (recoverable error) rather than a zero-volume solid.
- **Transform on a body that participates in a semantic spatial-region binding** (per [005](../005-semantic-mapping-layer/spec.md)). The constituent's face-group remaps via shape_history; the spatial-region binding refreshes on commit through 005's existing refresh path. No new code in this feature.
- **`align_to_face` between non-planar surfaces.** Phase 1: planar-to-planar only. Curved-to-curved alignment returns `ALIGN_UNSUPPORTED_GEOMETRY`.
- **`fillet_edges` with a radius larger than local geometry permits.** OCCT will fail mid-operation. Catch and return `FILLET_RADIUS_TOO_LARGE` with the offending edge id, rolling back the transaction.
- **`delete_face` that disconnects the body.** Result may be multiple shells. Return all of them as separate body ids with a note in `shape_history` linking them to the original.
- **`scale_body` with non-uniform factors.** Out of scope for Phase 1 — only uniform scaling is supported (matches `gp_Trsf::SetScale`). Non-uniform scaling requires `GeomTransform` and is deferred.
- **Assembly document operation outside any transaction.** Assembly mutations follow the same transactional rules as body mutations (per Constitution Principle IV). Calling `add_assembly_instance` without a `transaction_id` returns `TRANSACTION_REQUIRED`.
- **`mate_rigid` between components in different assemblies.** Out of scope for Phase 1 — both components must belong to the same assembly document.
- **Interrogation tools called inside a transaction.** Permitted — they see the in-flight transaction state, not the committed state. This matches existing behavior of `compute_intersections` etc.

---

## Requirements

### Functional Requirements

#### Booleans (US1)

- **FR-001**: The system MUST expose `fuse_bodies` that accepts `tools: [solid_id, ...]` (≥ 2) and optional `fuzzy_tolerance` (default 1e-5 mm) and returns a single new solid id whose volume is the union, using OCCT's `BRepAlgoAPI_Fuse`.
- **FR-002**: The system MUST expose `cut_bodies` that accepts `blank: solid_id`, `tools: [solid_id, ...]` (≥ 1), and optional `keep_tools: bool` (default `false`), and returns a single new solid id for the cut blank, using OCCT's `BRepAlgoAPI_Cut`. When `keep_tools: false`, tool solids are removed from the session.
- **FR-003**: The system MUST expose `intersect_bodies` that accepts `targets: [solid_id, ...]` (exactly 2 for Phase 1) and returns a new solid id for the shared volume, using OCCT's `BRepAlgoAPI_Common`. Empty intersection returns `BOOLEAN_EMPTY_RESULT`.
- **FR-004**: All three boolean ops MUST emit `ShapeHistoryRecord`s (per [004](../004-transaction-primitive/spec.md)) mapping every input face/edge through `Modified` / `Generated` / `Deleted` verdicts, so the semantic mapping layer ([005](../005-semantic-mapping-layer/spec.md)) can remap bindings on commit.

#### Interrogation (US2)

- **FR-005**: The system MUST expose `bounding_box` that accepts `target: entity_id` (solid, shell, face, or edge) and returns `{xmin, ymin, zmin, xmax, ymax, zmax}` using `BRepBndLib::AddOptimal`. Non-mutating.
- **FR-006**: The system MUST expose `mass_properties` that accepts `target: entity_id` and `properties: ["volume" | "surface_area" | "centroid" | "inertia_tensor"]` (default all four). Returns the requested values using `BRepGProp`. Non-mutating.
- **FR-007**: The system MUST expose `measure_distance` that accepts `target_a` and `target_b` (any two topological entities in the session) and `measurement_type: "min_distance" | "max_distance" | "angle"` (default `min_distance`), returning the scalar result using `BRepExtrema_DistShapeShape` (for distances) or geometric evaluation (for angles between planar faces). Non-mutating.
- **FR-008**: The system MUST expose `explore_topology` that accepts `target: entity_id` and `return_type: "solid" | "shell" | "face" | "edge" | "vertex"`, returning an ordered list of sub-entity ids using `TopExp_Explorer`. Ordering MUST be deterministic for identical inputs. Non-mutating.
- **FR-009**: All interrogation tools MUST execute without requiring a `transaction_id`; if one is supplied they MUST read the in-flight state of that transaction.

#### Transforms (US3)

- **FR-010**: The system MUST expose `translate_body`, `rotate_body`, `mirror_body`, `scale_body` (uniform only), and `align_to_face`, each accepting `targets: [solid_id, ...]` plus operation-specific parameters per the source doc §2.
- **FR-011**: Each transform tool MUST default to producing a new transformed solid with a new id; the original is removed from the session unless `keep_original: true` is supplied. (This matches the rest of the codebase's mutation semantics — original disappears, history record links the ids.)
- **FR-012**: Each transform tool MUST emit `ShapeHistoryRecord`s mapping every face/edge through `Modified` (i.e. transformed-equivalent), so semantic bindings remap to the new ids automatically.
- **FR-013**: `align_to_face` MUST support planar-to-planar alignment in Phase 1. Non-planar source or destination returns `ALIGN_UNSUPPORTED_GEOMETRY`. Computation uses `gp_Ax3` construction from face normals + `gp_Trsf` between them.
- **FR-014**: `scale_body` MUST support uniform scaling only in Phase 1. Non-uniform parameters return `SCALE_NON_UNIFORM_UNSUPPORTED`.

#### Direct Edits (US4)

- **FR-015**: The system MUST expose `fillet_edges` (radius) and `chamfer_edges` (distance), each accepting `targets: [edge_id, ...]` and the relevant scalar. Implementations use `BRepFilletAPI_MakeFillet` / `BRepFilletAPI_MakeChamfer`. If OCCT fails (radius too large, edge not filletable), return `FILLET_RADIUS_TOO_LARGE` / `CHAMFER_DISTANCE_TOO_LARGE` with the offending edge id.
- **FR-016**: The system MUST expose `simplify_body` that accepts `targets: [solid_id, ...]`, `unify_faces: bool` (default `true`), `unify_edges: bool` (default `true`). Implementation uses `ShapeUpgrade_UnifySameDomain`. Returns one new solid id per input.
- **FR-017**: The system MUST expose `heal_geometry` that accepts `targets: [solid_id, ...]`, `fix_tolerances: bool`, `fix_wires: bool` (both default `true`). Implementation uses `ShapeFix_Shape`. The returned solid MUST pass `BRepCheck_Analyzer` (or `HEAL_INCOMPLETE` with diagnostics is returned).
- **FR-018**: The system MUST expose `offset_shape` that accepts `targets: [solid_id, ...]`, `offset_value: number` (signed; positive = outward), `tolerance: number` (default 1e-4 mm). Implementation uses `BRepOffsetAPI_MakeOffsetShape`. Distinct from the existing face-only `offset_face`.
- **FR-019**: The system MUST expose `delete_face` that accepts `targets: [face_id, ...]`, `heal_remaining: bool` (default `true`). Implementation rebuilds the shell via `BRepBuilderAPI_Sewing` with the target face omitted, then runs `ShapeFix_Shape` if `heal_remaining`. Returns one or more body ids depending on whether removal disconnected the body.
- **FR-020**: Every direct-edit tool MUST emit `ShapeHistoryRecord`s and integrate with the transaction primitive ([004](../004-transaction-primitive/spec.md)) and semantic remap pass ([005](../005-semantic-mapping-layer/spec.md)).

#### Topology Sewing (US5)

- **FR-021**: The system MUST expose `sew_faces` that accepts `targets: [face_id | shell_id, ...]`, `tolerance: number` (default 0.001 mm), `make_solid: bool` (default `false`). Implementation uses `BRepBuilderAPI_Sewing`. Returns one shell (or one solid if `make_solid: true` and the result is closed). If unstitched edges remain, the response includes a `free_edges` list and a `SEW_INCOMPLETE` warning (warning, not error — sewing succeeds with whatever was joined).

#### Assembly (US6)

- **FR-022**: The system MUST expose `create_assembly_document` that returns a new assembly id; this is the root of an XCAF document (`XCAFDoc_ShapeTool`).
- **FR-023**: The system MUST expose `add_assembly_instance` that accepts `target: solid_id | assembly_id`, `parent_assembly: assembly_id`, and optional `location: { translation, rotation }`, returning a new component id. Implementation uses `XCAFDoc_ShapeTool::AddShape`.
- **FR-024**: The system MUST expose `mate_rigid` that accepts `source_entity` and `target_entity` (currently planar faces on assembly components), `mate_type: "coincident"` (Phase 1 supports coincident only), and `flip_alignment: bool`. Implementation computes the relative `gp_Trsf` and applies it to the source component's `TopLoc_Location` via `XCAFDoc_Location`. Returns the updated component's new location.
- **FR-025**: Assembly mutations MUST participate in the transaction primitive — `add_assembly_instance` and `mate_rigid` require a `transaction_id` and are rolled back if the transaction is discarded.
- **FR-026**: An assembly document MUST be enumerable: a `list_assembly_tree({assembly_id})` interrogation call MUST return the hierarchy of components and their locations. (This is the minimum needed for an AI agent to reason about the assembly without re-deriving it.)
- **FR-027**: Mate operations between components in different assembly documents MUST return `ASSEMBLY_CROSS_DOCUMENT_UNSUPPORTED`.

#### Cross-cutting

- **FR-028**: All new mutating tools MUST require a `transaction_id` parameter per Constitution Principle IV. Calling without one returns `TRANSACTION_REQUIRED` (existing error code from [004](../004-transaction-primitive/spec.md)).
- **FR-029**: All new tools MUST return structured errors per Constitution Principle VI (`code`, `message`, `recoverable`, `suggested_tool`). New error codes introduced by this feature: `BOOLEAN_EMPTY_RESULT`, `ALIGN_UNSUPPORTED_GEOMETRY`, `SCALE_NON_UNIFORM_UNSUPPORTED`, `FILLET_RADIUS_TOO_LARGE`, `CHAMFER_DISTANCE_TOO_LARGE`, `HEAL_INCOMPLETE`, `SEW_INCOMPLETE` (warning), `ASSEMBLY_MATE_UNSUPPORTED_GEOMETRY`, `ASSEMBLY_CROSS_DOCUMENT_UNSUPPORTED`. These MUST be added to the error code registry in `Engineering-Design.md §3.4`.
- **FR-030**: Tool naming MUST follow the project's snake_case convention (e.g. `fuse_bodies`, not `boolean.fuse`). The dotted names in `docs/MoreMCPTools.md` are treated as functional descriptors, not literal names.
- **FR-031**: The new tools MUST coexist with the existing specialized tools (`trim_body_with_plane`, `split_body_by_plane`, `offset_face`, `clean_geometry`, etc.) without deprecating them. Rationalisation — if and when the agent can express the same operations via primitives — is deferred to a future feature.
- **FR-032**: All new tools' input schemas MUST be exposed via `getToolDefinitions()` in `ts/src/mcp/tools.ts` and dispatched via the existing `tools.ts` switch.
- **FR-033**: All new tools MUST be exercised by at least one TypeScript integration test against a real OCCT fixture (not a mock), per `Engineering-Design.md` testing-strategy section.

### Key Entities

- **Solid / Body**: Existing session-scoped solid id, unchanged by this feature.
- **Face / Edge / Vertex**: Existing topological entity ids, unchanged.
- **Assembly Document**: New entity introduced by US6 — an XCAF-backed hierarchical document holding components and their locations. Lives in the session alongside flat solids; serialised to disk as `.xbf` (XCAF binary) or via the existing session-export mechanism.
- **Assembly Component**: A reference to a solid (or to another sub-assembly) within an assembly document, with an associated `TopLoc_Location` transform. Distinct from a solid id — multiple components can reference the same solid.
- **Shape History Record**: Existing entity from [004](../004-transaction-primitive/spec.md). Every new mutating tool produces these; consumed by the semantic remap pass on commit.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every tool in [docs/MoreMCPTools.md](../../docs/MoreMCPTools.md) is implemented and listed in `getToolDefinitions()`. The count: 20 tools (4 boolean/sew, 5 transform, 5 direct-edit, 4 interrogation, 2+1 assembly including `create_assembly_document` and `list_assembly_tree`).
- **SC-002**: An AI agent can perform a *fully composed* edit using only Phase 6 primitives — e.g. "load a STEP file, fuse two solids, fillet the seam, measure the resulting bounding box, mirror the result across the YZ plane, and assert the final volume" — in a single transaction, with all intermediate state rolled-back-able.
- **SC-003**: Every mutating tool's integration test verifies (a) result correctness, (b) `shape_history` emission, (c) semantic-binding survival when the transaction commits, (d) byte-equivalent rollback. No mutating tool ships without all four checks passing.
- **SC-004**: Existing integration tests from [004](../004-transaction-primitive/spec.md) and [005](../005-semantic-mapping-layer/spec.md) continue to pass — none of the new tools regress the transaction primitive or the semantic mapping layer.
- **SC-005**: Existing specialized tools (`trim_body_with_plane`, `split_body_by_plane`, `split_body_by_bends`, `offset_face`, `clean_geometry`, etc.) continue to behave identically — this feature is purely additive.
- **SC-006**: Cold-start tool dispatch latency for each new interrogation tool (US2) is under 50 ms on the `braai.step` fixture (these tools are pure reads with no allocation hot spots).
- **SC-007**: Cold-start latency for a boolean fuse of two ~10kB solids is under 500 ms inside a transaction including history emission.
- **SC-008**: An assembly document with 10 instances and 5 rigid mates can be created, committed, rolled-back, re-created, and exported / re-imported with identical structure (round-trip parity).

---

## Assumptions

### Scope

- **Full doc adoption, including XCAF.** Clarification §1 decided to include the Assembly/Mating category with full XCAF document support (User Story 6). If scope pressure emerges during planning, US6 is the first candidate to split into a separate feature.
- **Phase 1 of assembly modelling only.** Coincident planar mates only. No constraint solver, no distance/angle/concentric mates, no kinematics. These are clearly out of scope and would be a future feature.
- **No primitive *generation* tools.** The source doc explicitly excludes "primitive generation" (boxes, cylinders, etc. — those exist in OCCT but are out of scope for this feature). Existing primitive-creation paths (e.g. inside `synthesize_joints`) remain.
- **Non-uniform scaling, full nonlinear deformation, sheet-bending operations, etc. are out of scope.** Only the 20 tools listed in the source doc are in scope.

### Naming & Conventions

- **Snake_case naming throughout.** The dotted names in the source doc (`boolean.fuse`, `transform.translate`, etc.) are descriptive — they map to project-convention names (`fuse_bodies`, `translate_body`, etc.). See FR-030.
- **Singular vs plural argument keys** follow existing project convention: `targets` for collections, single named args (`blank`, `source`, `destination`) when the role differs from siblings.
- **All tools require a session.** Operating on bodies / faces requires the session to already hold them (loaded via `clean_geometry`, derived via prior tools, or imported via assembly).

### Integration

- **Every mutating tool integrates with the transaction primitive ([004](../004-transaction-primitive/spec.md)).** No `transaction_id`, no mutation. The shape_history records emitted match the existing format consumed by [005](../005-semantic-mapping-layer/spec.md).
- **Every mutating tool integrates with the semantic mapping layer ([005](../005-semantic-mapping-layer/spec.md)) via the commit-time remap pass.** No new code in the mapping layer; new tools just emit history records correctly and the existing remap handles them.
- **Constitution v1.2 governs.** Specifically Principles II (Bounded Context Separation — OCCT calls live only in `cpp/src/geometry/geometry_service.cc`), IV (Rollback-First), VI (Structured Errors).

### Deferrals

- **Tool rationalisation deferred.** Existing specialized tools that overlap with new primitives (e.g. `trim_body_with_plane` ≈ `cut_bodies` with a half-space tool) are not deprecated; FR-031.
- **Assembly serialisation format.** Default is OCCT's `.xbf` (binary XCAF). If the existing session-export mechanism needs extending for assemblies, that is in scope for the implementation plan, not this spec.
- **Non-planar `align_to_face` and non-coincident `mate_rigid` mate types** deferred to a future feature.
- **Tolerance configuration.** Per-tool tolerances default to the values listed in `docs/MoreMCPTools.md`. A global override is out of scope.
- **Performance optimisation beyond SC-006/SC-007.** Bulk processing, caching, OCCT internal tuning — out of scope.

### Dependencies

- **[004 transaction-primitive](../004-transaction-primitive/spec.md) is merged** (already true per `git log`).
- **[005 semantic-mapping-layer](../005-semantic-mapping-layer/spec.md) is merged** (already true per `git log`).
- **No new external runtime dependencies.** All operations use OCCT classes already linked into the C++ geometry service. The XCAF subsystem (`TKXCAF`, `TKXDESTEP`, `TKBinXCAF`) is a new OCCT module link but ships in the same OCCT distribution already in use.
