# Tasks: Semantic Mapping Layer + Dolt Persistence

**Input**: Design documents from `specs/005-semantic-mapping-layer/`

**Prerequisites**: spec.md ✓, plan.md ✓, Constitution v1.2 ratified (T001), `004` merged (T003)

**Organization**: Four phases per plan.md. Each phase ends at an independently testable checkpoint.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel with other [P] tasks in the same phase (different files, no in-phase dependency)
- **[Story]**: US1–US4 from spec.md

---

## Phase 1: Prerequisites + Dolt Scaffolding

**Goal**: A Dolt-MySQL instance is reachable to the MCP server in dev and CI; the
schema is installed; a smoke test inserts and reads one row through the
`SemanticPersistencePort`. No MCP tools yet.

**Independent Test**: `npm run dolt:check` starts a local Dolt server, runs the
migration, inserts and reads a `semantic_entity` row, then tears down.

### Gates

- [ ] T001 Verify Constitution v1.2 is on `main`: open `.specify/memory/constitution.md` and confirm `**Version**: 1.2`. If not, halt and resolve before proceeding.
- [ ] T002 Verify `Engineering-Design.md §1 D3` lists `D3-B` and §2 lists the Semantic Mapping context. If not, file the edit per amendment v1.2 §5.1 in a small PR and merge before continuing.
- [ ] T003 Verify `004-transaction-primitive` is merged to `main`: `git log main --oneline | grep transaction-primitive` returns at least one merge commit. If not, halt.
- [ ] T004 Install Dolt CLI on the local dev box. Add a step to the GitHub Actions workflow under `.github/workflows/` that installs and starts `dolt sql-server` for the integration job. Reference: `dolt version` returns 1.x.

### Dependency + Config

- [ ] T005 [P] Add `mysql2@^3.6.0` to `package.json` dependencies. Confirm `package-lock.json` updates cleanly.
- [ ] T006 [P] Extend `ts/src/config/loader.ts` to accept a `persistence` block: `{driver: "dolt", host: "127.0.0.1", port: 3306, database: "semantic_braai", data_dir: "./state/dolt/braai"}`. Defaults documented in `docs/CONFIG.md`.

### Local + CI Dolt runtime

- [ ] T007 Add a `dolt-sql-server` service to `docker-compose.yml` (or create one if absent), exposing port 3306 to the MCP server container, with a bound volume for the data directory. Document a `scripts/run_dolt.ps1` and `scripts/run_dolt.sh` launcher for developers not using Compose.
- [ ] T008 [P] Add a `dolt:check` script to `package.json` that runs `dolt sql -q "SELECT 1"` against the configured host:port; non-zero exit if unreachable.
- [ ] T009 Update the integration test workflow to start the Dolt server, apply migrations, run tests, then shut down. Cache the Dolt data directory between runs by hashing `migrations/`.

### Schema + Migration

- [ ] T010 [P] Create `ts/src/semantic/migrations/001_initial.sql` containing the six tables from [SemanticCad/Persistence-Dolt.md §4](../../SemanticCad/Persistence-Dolt.md): `semantic_entity`, `semantic_relationship`, `semantic_mapping`, `topology_revision`, `shape_history`, `transaction`. Use the exact column types and constraints from §4.
- [ ] T011 Create `ts/src/semantic/migration_runner.ts` with `applyMigrations(connection)` that lists `migrations/*.sql` in lexical order and executes any not recorded in a (created-if-absent) `_schema_migrations` table. Idempotent.

### Port + Adapter

- [ ] T012 [P] Create `ts/src/semantic/types.ts` with `SemanticEntity`, `SemanticRelationship`, `SemanticMapping`, `TopologyRevision`, `ShapeHistoryRecord`, `Transaction`, `Binding`, `EntityType`, `RelationshipType`, `BindingKind`. Use string-literal unions for the locked vocabularies in spec.md FR-013/FR-014.
- [ ] T013 [P] Create `ts/src/semantic/port.ts` defining `SemanticPersistencePort` as an interface (typed methods only, no implementation): `connect`, `disconnect`, `checkoutBranch`, `mergeBranch`, `deleteBranch`, `asOf`, `transaction(callback)`, plus per-table accessors (`insertEntity`, `findEntity`, `insertMapping`, `getCurrentMappingsForEntity`, `getMappingHistory`, `insertShapeHistory`, `getShapeHistoryForTransaction`, etc.).
- [ ] T014 Create `ts/src/semantic/dolt_adapter.ts` implementing `SemanticPersistencePort` via `mysql2/promise`. Use a connection pool. Translate `CALL DOLT_CHECKOUT/MERGE/BRANCH` into method calls on the port. Errors map to the new error codes (`PERSISTENCE_UNAVAILABLE` on connection failure, `PERSISTENCE_COMMIT_FAILED` on merge/commit failures).
- [ ] T015 Decide JSON-query strategy: try `MEMBER OF` + `JSON_TABLE` against the pinned Dolt version. If unsupported, switch the spatial-region resolution and the commit-time remap join (plan.md §Design) to application-side joins. Document the decision in a comment at the top of `dolt_adapter.ts`.

### Smoke Test

- [ ] T016 Add `ts/tests/integration/dolt_smoke.integration.test.ts`: starts adapter, runs migrations against a fresh database, inserts one `semantic_entity` row, reads it back, asserts equality. Skipped when `process.env.SKIP_DOLT === "1"`.

**Checkpoint**: T016 passes locally and in CI. No MCP tools exist yet; the next phase wires them.

---

## Phase 2: Declare / Bind / Resolve Without Remap (US1)

**Goal**: A caller can `declare_semantic_entity` and `bind_semantic_entity` on a
face-group, then `resolve_geometry` reads the binding back. `commit_transaction`
now opens, merges, and closes a Dolt branch. The remap pass is still a no-op pass.

**Independent Test**: New integration test executes declare → bind face_group →
commit → resolve. Asserts face IDs round-trip.

### Semantic Store + Identifiers

- [ ] T017 [P] [US1] Create `ts/src/semantic/identifiers.ts`: `validateEntityId(uri): {product, slug}` enforces `semantic://<product>/<slug>` shape, slug regex `^[a-z][a-z0-9_]*$`, product slug regex same. Returns structured errors `SEMANTIC_ID_INVALID` on failure. Add `validateEntityType` and `validateRelationship` checking the locked vocabularies.
- [ ] T018 [P] [US1] Create `ts/src/semantic/semantic_store.ts` exposing high-level methods over the port: `declareEntity({id, type, purpose?, relationships?, transaction_id})`, `bindEntity({semantic_id, binding, transaction_id})`, `resolveCurrent({semantic_id})`, `getEntity({semantic_id})`. Each method runs inside `port.transaction(...)` for atomicity at the SQL level. Pre-validates inputs via `identifiers.ts`.

### TransactionRegistry Extension

- [ ] T019 [US1] Extend `ts/src/mcp/transactions.ts` to coordinate Dolt branches. `begin(label, product)` now also calls `port.checkoutBranch('txn/' + id)` and inserts a `transaction` row. `commit(id)` calls `port.mergeBranch('txn/' + id)` then `port.deleteBranch('txn/' + id)`. `rollback(id)` calls `port.deleteBranch('txn/' + id)`. Failure of the Dolt step raises `PERSISTENCE_COMMIT_FAILED` (commit path) or `PERSISTENCE_UNAVAILABLE` (begin/rollback paths).

### MCP Tools

- [ ] T020 [US1] Add `declare_semantic_entity` to `getToolDefinitions()` in `ts/src/mcp/tools.ts`. inputSchema: `{id: string, type: enum [...], purpose?: array<string>, relationships?: array<{relationship, target}>, transaction_id: string}`. All five entity types from FR-013 listed in the enum.
- [ ] T021 [US1] Add `bind_semantic_entity` to `getToolDefinitions()`. inputSchema accepts a discriminated union over `binding.kind`: `face_group` with `face_ids: string[]`, `body` with `body_id: string`, `spatial_region` with `between: [semantic_id, semantic_id]`. (`spatial_region` implementation comes in Phase 3; in Phase 2 the tool accepts it but the resolver is unimplemented and `resolve_geometry` returns the raw rule.)
- [ ] T022 [US1] Add `resolve_geometry` to `getToolDefinitions()`. inputSchema: `{semantic_id: string, at_revision?: integer}`. (Time-travel comes in Phase 4; in Phase 2 `at_revision` is accepted but ignored, with a `// TODO Phase 4` comment.)
- [ ] T023 [US1] Add corresponding handlers `handleDeclareSemanticEntity`, `handleBindSemanticEntity`, `handleResolveGeometry` to `ts/src/mcp/tools.ts`. Each: validates inputs, calls into `semantic_store`, maps errors, returns the structured response.
- [ ] T024 [US1] Wire the three new handlers into `dispatchTool()` switch in `ts/src/mcp/tools.ts`.
- [ ] T025 [US1] Add the new error codes to `ts/src/mcp/errors.ts`: `PERSISTENCE_UNAVAILABLE`, `PERSISTENCE_COMMIT_FAILED`, `SEMANTIC_ID_EXISTS`, `SEMANTIC_ID_NOT_FOUND`, `SEMANTIC_ID_INVALID`, `SEMANTIC_TYPE_NOT_SUPPORTED`, `SEMANTIC_RELATIONSHIP_NOT_SUPPORTED`, `BINDING_FACE_ALREADY_BOUND`, `BINDING_KIND_NOT_SUPPORTED`, `SEMANTIC_CONSTITUENT_NOT_FOUND`, `REVISION_NOT_FOUND`.

### Session Wiring

- [ ] T026 [US1] Extend `ts/src/geometry/session.ts` to construct a `DoltAdapter`, run `migration_runner.applyMigrations()` at startup, hold a `SemanticStore` instance, and expose `getSemanticStore()` + `getPort()` accessors. Initialise after the existing geometry session is ready; fail server startup with `PERSISTENCE_UNAVAILABLE` if Dolt is unreachable.

### Integration Tests

- [ ] T027 [US1] Create `ts/tests/integration/semantic_mapping.integration.test.ts` with the US1 cases: (a) declare → bind face_group → commit → resolve returns the same face IDs; (b) declare with a duplicate id → `SEMANTIC_ID_EXISTS`; (c) bind a non-existent entity → `SEMANTIC_ID_NOT_FOUND`; (d) rollback after declare → resolve returns `SEMANTIC_ID_NOT_FOUND`.

**Checkpoint**: T027 passes. The transaction lifecycle now spans Dolt branches end-to-end. SC-005 (existing tests still pass) holds.

---

## Phase 3: Mapping Layer Remap (US2 + US3)

**Goal**: On commit, face-group bindings remap using the OCCT shape history captured
by `004`, and spatial-region bindings recompute. The worked example in
`WorkedExample-LeftBaseAirflow.md` survives `split_body_by_bends` end-to-end (still
without lineage queries — those land in Phase 4).

**Independent Test**: A test that mirrors §3–§8 of the worked example: declare three
entities (outer panel, firebox panel, airflow region), bind the two panels to face
groups, bind the airflow as a spatial region, run `split_body_by_bends`, commit,
then `resolve_geometry` on all three returns the post-mutation bindings.

### Mapping Layer Core

- [ ] T028 [US2] Create `ts/src/semantic/mapping_layer.ts` with `MappingLayer` class. Constructor takes a `SemanticStore`. Method `applyShapeHistoryToBindings(transactionId, topologyRevision)`: (1) fetches all `shape_history` rows for the transaction via the port; (2) fetches all currently-bound `face_group` mappings whose face IDs appear in any `shape_history.original_id`; (3) for each affected mapping, computes the new face-id set (replace via `modified`/`generated`, drop via `deleted`); (4) inserts a new `semantic_mapping` row per affected entity with `remap_reason: "<operation_label> → OCCT <verdict>()"`.
- [ ] T029 [US3] Extend `MappingLayer` with `refreshDerivedBindings(transactionId, topologyRevision, affectedEntityIds)`: for each `spatial_region` mapping whose `between` constituents include any id in `affectedEntityIds`, insert a new mapping row with the same derivation rule, the new topology revision, and `remap_reason: "spatial_region refresh"`. Run after `applyShapeHistoryToBindings`.
- [ ] T030 [US3] Extend `SemanticStore.resolveCurrent` to materialise spatial-region bindings: if the latest mapping for the entity has `binding_kind: 'spatial_region'`, follow the `between` rule, fetch the current bindings of each constituent, union the face IDs, and return a synthetic `face_group` binding with the union as `materialised_face_ids`. The original `between` rule is also returned for transparency.

### Commit-Time Hook

- [ ] T031 [US2] Extend `handleCommitTransaction` in `ts/src/mcp/tools.ts`: after the geometry snapshot is discarded, before merging the Dolt branch, call `mappingLayer.applyShapeHistoryToBindings(txnId, newRevisionId)` followed by `mappingLayer.refreshDerivedBindings(...)`. Insert the `topology_revision` row. Any failure raises `PERSISTENCE_COMMIT_FAILED` and the Dolt branch is dropped with `DOLT_BRANCH('-D')` (not merged).
- [ ] T032 [US2] Modify each mutating tool handler in `ts/src/mcp/tools.ts` to additionally write `shape_history` rows on the active transaction branch when one is active (the shape_history records are already returned by the geometry layer thanks to `004`; this task is just the per-handler bulk insert). Apply to: `decompose_volume`, `synthesize_joints`, `generate_reliefs`, `apply_unfold`, `trim_body_with_plane`, `split_body_by_plane`, `merge_bodies_with_bend`, `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, `split_body_by_bends`. The TransactionRegistry already accumulates them in-memory per `004`; here we additionally persist to Dolt.

### Tests

- [ ] T033 [US2] Extend `semantic_mapping.integration.test.ts` with US2 cases: (a) firebox panel binding remaps after `split_body_by_bends`; new binding has the new face IDs; `remap_reason` set; (b) untouched outer panel binding is carried forward via a new row whose face IDs are identical to the previous row's; (c) `IsDeleted` verdict produces an empty face-group with the `deleted` remap_reason; (d) rollback leaves the pre-split binding intact.
- [ ] T034 [US3] Extend `semantic_mapping.integration.test.ts` with US3 cases: (a) declare + bind the three entities from the worked example, run `split_body_by_bends`, commit, resolve airflow id → `materialised_face_ids` includes the new firebox panel face IDs; (b) binding a `spatial_region` with a non-existent constituent → `SEMANTIC_CONSTITUENT_NOT_FOUND`; (c) one constituent has an empty binding after remap → airflow region resolves to the other constituent's faces only.

**Checkpoint**: The worked example from `WorkedExample-LeftBaseAirflow.md` passes through §8 (the identity-survival proof). SC-001 met. The MVP architectural claim is delivered.

---

## Phase 4: Lineage and Time Travel (US4)

**Goal**: `semantic_lineage` returns historical bindings; `resolve_geometry({at_revision})`
returns point-in-time state via Dolt `AS OF`.

**Independent Test**: After Phase 3 tests run, call `semantic_lineage` on firebox panel
→ two rows; call `resolve_geometry({at_revision: 1})` → returns original face IDs.

### Store Extensions

- [ ] T035 [P] [US4] Add `getMappingLineage(semanticId): SemanticMapping[]` to `SemanticStore` — selects every row for the entity in `revision_id` order, joined with `transaction.label` and `transaction.id`.
- [ ] T036 [P] [US4] Add `resolveAtRevision(semanticId, atRevision): Binding` to `SemanticStore` — uses the port's `asOf(commitRef)` helper to execute the resolution query against Dolt at the given commit. The mapping between integer `topology_revision` and Dolt commit ref is via the `topology_revision` table inserted in Phase 3.

### MCP Tools

- [ ] T037 [US4] Add `semantic_lineage` to `getToolDefinitions()` in `ts/src/mcp/tools.ts`. inputSchema: `{semantic_id: string}`. Output: array of lineage rows per spec.md FR-009.
- [ ] T038 [US4] Add the `at_revision` path in `handleResolveGeometry`: if `at_revision` is provided, call `store.resolveAtRevision`; if the revision doesn't exist, return `REVISION_NOT_FOUND`.
- [ ] T039 [US4] Wire `semantic_lineage` handler into `dispatchTool()` switch.

### Tests

- [ ] T040 [US4] Extend `semantic_mapping.integration.test.ts` with US4 cases: (a) after Phase 3 mutations, `semantic_lineage` for firebox panel returns ≥2 rows in revision order, each with `transaction_id`, `label`, `binding`, `remap_reason`; (b) `resolve_geometry({at_revision: 1})` returns pre-split face IDs; (c) `at_revision: 9999` → `REVISION_NOT_FOUND`.

**Checkpoint**: The worked example from `WorkedExample-LeftBaseAirflow.md` passes end-to-end, including §9 (lineage query). The MVP is feature-complete for Semantic CAD Phase 1.

---

## Dependencies & Execution Order

```
Phase 1 (Scaffolding) — gates plus parallel scaffolding work
  T001, T002, T003, T004              [gates, sequential, halt-on-fail]
  T005 [P], T006 [P]                  [deps + config, parallel]
  T007 → T008 [P], T009               [Dolt runtime, mostly parallel]
  T010 [P]                            [schema]
  T011                                [migration runner, after T010]
  T012 [P], T013 [P]                  [types + port interface, parallel]
  T014                                [adapter, after T013]
  T015                                [JSON strategy decision, after T014]
  T016                                [smoke test, last]

Phase 2 (Declare/Bind/Resolve) — after Phase 1 checkpoint
  T017 [P], T018 [P]                  [identifiers + store, parallel]
  T019                                [TransactionRegistry extension]
  T020 [P], T021 [P], T022 [P]        [tool definitions, parallel]
  T023 → T024                          [handlers + dispatch]
  T025                                [error codes]
  T026                                [session wiring]
  T027                                [integration test]

Phase 3 (Mapping Layer remap) — after Phase 2 checkpoint
  T028 → T029                          [mapping layer methods, sequential same file]
  T030                                [spatial-region resolution]
  T031                                [commit-time hook]
  T032                                [per-tool shape_history persistence]
  T033 [P], T034 [P]                  [tests, parallel]

Phase 4 (Lineage + time travel) — after Phase 3 checkpoint
  T035 [P], T036 [P]                  [store extensions, parallel]
  T037 → T038, T039                    [tool definitions + handlers]
  T040                                [tests]
```

---

## Out of Scope (do NOT do in this feature)

The following are deliberately deferred. Adding any of them in this feature breaks
the Phase 1 boundary in [SemanticCad/MVP.md](../../SemanticCad/MVP.md).

- Inference Engine (`infer_semantics`, confidence/evidence scoring on `semantic_entity`).
- Multi-domain analyses beyond `evaluate_manufacturability`.
- Semantic merge / split tools.
- Conflict-resolution UI or workflow when two bindings claim the same face.
- Cross-product semantic graphs (multiple Dolt databases).
- Multi-session concurrency (two simultaneous `begin_transaction` calls).
- DoltgreSQL (Postgres wire) variant.
- Schema versioning / migration framework beyond the single initial migration.
- Garbage collection of unreferenced topology revisions.
- Persisting in-memory geometry state to Dolt (geometry stays in-memory + BREP per amendment v1.2).
- Renaming or auto-deduping semantic identifiers (append-only per MVP.md §6.3).
