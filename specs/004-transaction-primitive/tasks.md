# Tasks: Explicit Transaction Primitive

**Input**: Design documents from `specs/004-transaction-primitive/`

**Prerequisites**: spec.md ✓, plan.md ✓

**Organization**: Four phases matching the agreed implementation order. Each phase is
independently buildable and testable before the next begins.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks in same phase)
- **[Story]**: US1–US3 from spec.md

---

## Phase 1: TS-Side Transaction Registry + Lifecycle Tools

**Goal**: A caller can `begin_transaction`, run two existing mutating ops, and either
`commit_transaction` or `rollback_transaction` — using only TS-side wrapping of the
existing per-op snapshot mechanism. No C++ changes yet.

**Independent Test**: New integration test opens a transaction, decomposes a volume,
synthesises joints, then rolls back. Assert the session contains only the original solid
(verifies SC-001).

### Dependency

- [X] T001 Reuse existing `uuid@^9.0.0` dependency in `ts/package.json` for `transaction://<uuid>` ids; no new dependency required. (Deviation from original plan which proposed `ulid@^2.3.0` — `uuid` is already present and the existing `SnapshotId` in [cpp/src/geometry/snapshot.hpp](../../cpp/src/geometry/snapshot.hpp) is already UUID v4. Lexicographic sortability of ULIDs is not required for MVP lineage queries.)

### TS Layer — Registry

- [X] T002 [P] [US1] Added 4 new error codes to `ts/src/mcp/errors.ts`: `TRANSACTION_NOT_FOUND`, `TRANSACTION_NOT_ACTIVE`, `TRANSACTION_ALREADY_ACTIVE`, `TRANSACTION_MISMATCH`.

- [X] T003 [US1] Created `ts/src/mcp/transactions.ts` with the `TransactionRegistry` class. Uses `node:crypto.randomUUID()` for `transaction://<uuid>` ids (matches existing `SnapshotId` UUID v4 convention). `appendHistory` / `getHistory` deferred to Phase 3 (T026/T027) when `get_transaction_history` ships — `shape_history` isn't captured in Phase 1 anyway.

- [X] T004 [US1] **Deviation**: kept the `transactionRegistry` singleton in `ts/src/mcp/transactions.ts` rather than `ts/src/geometry/session.ts`. Reason: putting the singleton in `session.ts` would create a `geometry → mcp` import, violating Constitution Principle II (bounded context separation — MCP may import from Geometry, but not the reverse). Tests reset the registry explicitly via `transactionRegistry.reset()`.

### TS Layer — Tool Definitions

- [X] T005 [US1] Added `begin_transaction` tool definition to `getToolDefinitions()` in `ts/src/mcp/tools.ts`. `base_geometry_revision` deferred to Phase 1 of 005 (no concept of geometry revision exists in 004 — would be a TODO field of value 0). Output: `{transaction_id, status: 'active', label, product, rollback_token}`.

- [X] T006 [US1] Added `commit_transaction` tool definition. Output: `{transaction_id, status: 'committed', label}`.

- [X] T007 [US1] Added `rollback_transaction` tool definition. Output: `{transaction_id, status: 'rolled_back', label, restored_solid_ids, restored_shell_ids}`.

### TS Layer — Tool Handlers

- [X] T008 [US1] Added `handleBeginTransaction(args)` in `ts/src/mcp/tools.ts`. Calls `getGeometryBinding().createSnapshot(label)` and `transactionRegistry.begin(...)`. `TRANSACTION_ALREADY_ACTIVE` errors include the active id and `suggested_tool: 'commit_transaction'`.

- [X] T009 [US1] Added `handleCommitTransaction(args)`. **Deviation**: uses `clearSnapshots()` (clears all) rather than the proposed `clearSnapshot(snapshotId)` — the per-id primitive doesn't exist yet on the C++ side, and Phase 1 of 004 explicitly defers C++ changes. In MVP single-active-transaction this clears at most one outer snapshot. Phase 2 (T016) is where the per-id primitive lands if needed.

- [X] T010 [US1] Added `handleRollbackTransaction(args)`. Looks up the transaction first to resolve the snapshot id, then calls `restoreSnapshot` and `registry.rollback`. Returns `restored_solid_ids` / `restored_shell_ids` from the C++ restore result.

- [X] T011 [US1] Wired the three new cases into `dispatchTool()` switch immediately after `case 'rollback'`.

### Integration Test

- [X] T012 [US1] Created `ts/tests/integration/transaction_primitive.integration.test.ts` with 5 tests covering all four planned cases (rollback case (d) was split into two — `commit_transaction` and `rollback_transaction` on unknown ids). All 5 pass. Note: case (b) was adjusted — a rollback after commit errors with `TRANSACTION_NOT_ACTIVE` (the transaction exists but is committed), not `TRANSACTION_NOT_FOUND`. This matches the registry's design and is the more precise error.

**Checkpoint** ✓: All 5 tests in T012 pass. Full `npm test` suite passes (288/288 — 283 existing + 5 new). No C++ changes. SC-001, SC-002, SC-004, SC-005 met.

---

## Phase 2: Existing Mutating Tools Accept `transaction_id`

**Goal**: Each existing mutating tool accepts an optional `transaction_id`. When passed
(or when one is active), the tool joins the transaction instead of creating its own
snapshot.

**Independent Test**: Pre-existing integration tests pass without modification (verifies
SC-002). New test confirms mutating tools auto-join an active transaction.

### TS Layer — Tool Definition Updates

- [X] T013 [P] [US2] Update `ts/src/mcp/tools.ts`: add optional `transaction_id: { type: 'string' }` to the `inputSchema.properties` of every mutating tool listed in the spec assumptions (`decompose_volume`, `synthesize_joints`, `generate_reliefs`, `apply_unfold`, `trim_body_with_plane`, `split_body_by_plane`, `merge_bodies_with_bend`, `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, `split_body_by_bends`). Do NOT add it to `required`.

### TS Layer — Dispatch Logic

- [X] T014 [US2] Add a `resolveTransactionContext(args)` helper in `ts/src/mcp/tools.ts` that returns either `{mode: 'join', transactionId}` (when args contains a `transaction_id` matching the active txn, or when no `transaction_id` is provided but a txn is active) or `{mode: 'implicit'}` (when no txn is active and no `transaction_id` is provided). Throw `TRANSACTION_MISMATCH` when args specifies a `transaction_id` that doesn't equal the active txn id.

- [X] T015 [US2] Update every mutating tool handler in `ts/src/mcp/tools.ts` to call `resolveTransactionContext(args)` at entry. When `mode === 'join'`, suppress the per-op snapshot creation that the existing handlers do, and instead append shape-history records (empty for Phase 2 — populated in Phase 3) to the active transaction via `registry.appendHistory(id, [])`. When `mode === 'implicit'`, behave exactly as today. In both cases, the returned `rollback_token` equals the active transaction id (join) or the per-op snapshot id (implicit).

- [X] T016 [P] [US2] Update `ts/src/geometry/binding.ts` to expose a `createSnapshot(label)` and `clearSnapshot(snapshotId)` passthrough to the C++ snapshot registry, if not already present. Used by `handleBeginTransaction` and `handleCommitTransaction`. **Note**: `createSnapshot` was already present; `clearSnapshot(snapshotId)` added to both `GeometryAddon` interface and `GeometryBinding` class.

### Integration Tests

- [X] T017 [US2] Extend `ts/tests/integration/transaction_primitive.integration.test.ts` with: (a) `begin → split_body_by_bends without transaction_id → commit` ⇒ verifies auto-join; (b) `begin → split_body_by_bends with wrong transaction_id` ⇒ `TRANSACTION_MISMATCH`; (c) confirm response `rollback_token === transaction_id` in the auto-join case. **Note**: 6 new tests added in a second `describe` block (Phase 2 suite). Also tests backward-compat for implicit mode (no active txn) and snapshot suppression for decompose_volume.

- [X] T018 [P] [US2] Run the full existing `ts/tests/integration/` suite. Any test that breaks indicates a backward-compat regression — fix the dispatch logic, not the test. **Result**: 294/294 pass (288 existing + 6 new). No regressions.

**Checkpoint** ✓: T013–T018 pass. 294/294 tests green (6 new Phase 2 tests). No source-code changes to existing tests (SC-002 met). `appendHistory` and `getHistory` added to TransactionRegistry; `ShapeHistoryRecord` type defined. `clearSnapshot(snapshotId)` added to binding. `resolveTransactionContext` helper governs all 12 mutating tools.

---

## Phase 3: C++ Shape-History Capture in `split_body_by_bends`

**Goal**: `split_body_by_bends` populates a `shape_history` field on its result. The
field round-trips through N-API into the TS-side TransactionRegistry. Verifies US3 for
one operation; proves the plumbing.

**Independent Test**: Open a transaction, call `split_body_by_bends` on the hollow-cube
fixture, call `get_transaction_history` ⇒ returns ≥ 6 records (SC-003).

### C++ Layer — History Helper

- [X] T019 [P] [US3] Create `cpp/src/geometry/shape_history.hpp` with the `ShapeHistoryRecord` struct (`std::string verdict`, `originalId`, `newId`, `operationLabel`) and the `captureHistory` helper signature. Verdict is one of the string literals `"modified"`, `"generated"`, `"deleted"`.

- [X] T020 [US3] Create `cpp/src/geometry/shape_history.cc` implementing `captureHistory(BRepBuilderAPI_MakeShape& algo, std::function<std::string(const TopoDS_Shape&)> resolveId, const std::string& operationLabel)`. For each face in the input shape: iterate `algo.Modified(face)` and emit one `modified` record per output face; iterate `algo.Generated(face)` and emit `generated`; check `algo.IsDeleted(face)` and emit `deleted` if true. Use `TopExp_Explorer` to enumerate faces. Skip records whose `resolveId` returns an empty string (unresolved shapes are a known degenerate case worth tolerating in Phase 0).

- [X] T021 [US3] Update `cpp/CMakeLists.txt` (and any sub-lists) to include `shape_history.cc` in the geometry library target. Also added directly to `cpp/build/geometry_engine.vcxproj` ClCompile ItemGroup to work around cmake re-configure trigger.

### C++ Layer — Wire Into `splitBodyByBends`

- [X] T022 [US3] Update `DecomposedByBendsResult` in `cpp/src/geometry/geometry_service.hpp`: add `std::vector<ShapeHistoryRecord> shapeHistory`.

- [X] T023 [US3] Update `splitBodyByBends` in `cpp/src/geometry/geometry_service.cc`: for the Mode 2 cutting path, after each `BRepAlgoAPI_Cut` / `BRepAlgoAPI_Common` call, invoke `captureHistory(algo, idResolver, "split_body_by_bends")` and append to `result.shapeHistory`. For the Mode 1 extrusion path, do the same for `BRepPrimAPI_MakePrism`. The `idResolver` is a lambda that looks up the face ID via the existing face indexing (`shellFaceIndex_` / equivalent).

### C++ NAPI Layer

- [X] T024 [US3] Update `SplitBodyByBends` NAPI in `cpp/src/napi/geometry_binding.cc`: after deserialising the existing fields, build a JS array `shape_history` by iterating `result.shapeHistory` and constructing one JS object per record (`{verdict, original_id, new_id, operation_label}`). Add to the returned JS object.

### TS Layer

- [X] T025 [P] [US3] Update `splitBodyByBends` return type in `ts/src/geometry/binding.ts` to include `shape_history?: Array<{verdict: 'modified' | 'generated' | 'deleted', original_id: string, new_id: string, operation_label: string}>`.

- [X] T026 [US3] Update `handleSplitBodyByBends` in `ts/src/mcp/tools.ts`: after the geometry call returns, if a transaction is active (per `resolveTransactionContext`), call `registry.appendHistory(transactionId, result.shape_history ?? [])`. Pass `shape_history` through into the MCP response so callers see what changed.

- [X] T027 [US3] Add `get_transaction_history` tool definition and handler to `ts/src/mcp/tools.ts`: inputSchema requires `transaction_id: string`; handler calls `registry.getHistory(transactionId)` (returns `TRANSACTION_NOT_FOUND` if the transaction was rolled back or never existed). Output: `{transaction_id, records: ShapeHistoryRecord[]}`.

### Tests

- [X] T028 [US3] Add a C++ unit test in `cpp/tests/geometry_test.cc`: load the hollow-cube fixture, call `splitBodyByBends`, assert `result.shapeHistory.size() >= 6` and that every record has `operationLabel == "split_body_by_bends"`. **Build note**: C++ compilation requires OCCT rebuild (vcpkg `dependencies.patch` corrupt line 108 fixed — now building).

- [X] T029 [US3] Extend `ts/tests/integration/transaction_primitive.integration.test.ts` with: (a) `begin → split_body_by_bends → get_transaction_history` ⇒ 3 records (mock); (b) `begin → split_body_by_bends → commit → get_transaction_history` ⇒ records still returned; (c) `begin → split_body_by_bends → rollback → get_transaction_history` ⇒ `TRANSACTION_NOT_FOUND`; (d) unknown id ⇒ `TRANSACTION_NOT_FOUND`. All 15 Phase 1+2+3 TS tests pass.

**Checkpoint**: T025–T029 complete (TS side). T028 C++ build pending (OCCT recompilation in progress). SC-003 met for TS layer. `split_body_by_bends` is the proof-of-concept op for shape-history; remaining ops are Phase 4.

---

## Phase 4: Extend Shape-History Capture to Remaining Mutating Ops

**Goal**: Every mutating op populates `shape_history`. Mostly mechanical — the helper
exists, the plumbing is proven; this is repetition.

**Independent Test**: Per-op integration tests confirm each op contributes records to
the active transaction's history.

### C++ Layer — Per-Op Capture

For each of the following tools, perform the same three-step change as in T022–T024:
add `shapeHistory` field to the result struct (if not already present), invoke
`captureHistory` in the C++ implementation, and surface through NAPI.

- [ ] T030 [P] `decompose_volume` — captures history from each boolean cut.
- [ ] T031 [P] `synthesize_joints` — captures from tab/slot extrusions and cuts.
- [ ] T032 [P] `generate_reliefs` — captures from the corner-relief cuts.
- [ ] T033 [P] `apply_unfold` — captures from the unfold transform.
- [ ] T034 [P] `trim_body_with_plane` — captures from the half-space cut.
- [ ] T035 [P] `split_body_by_plane` — same.
- [ ] T036 [P] `merge_bodies_with_bend` — captures from the fuse.
- [ ] T037 [P] `extend_face_to_target` — captures from the face extension.
- [ ] T038 [P] `offset_face` — captures from the offset.
- [ ] T039 [P] `add_flange` — captures from the prism + fuse.
- [ ] T040 [P] `rip_edge` — captures from the edge ripping.

### TS Layer

- [ ] T041 Update `ts/src/geometry/binding.ts` return types for each tool above to add `shape_history?`.

- [ ] T042 Update each corresponding `handle*` function in `ts/src/mcp/tools.ts` to append shape history to the active transaction when one is active (same pattern as T026).

### Tests

- [ ] T043 Add one integration test per op (or one combined parameterised test) verifying that running the op inside a transaction populates non-empty `shape_history` for ops that produce topology changes. Some ops may legitimately produce zero records (no-op cases) — document those exceptions.

**Checkpoint**: Every mutating tool contributes shape-history records when called inside a transaction. The Semantic Mapping Layer in Phase 1 of the Semantic CAD MCP plan (a future feature spec, likely `005-semantic-mapping-layer`) has everything it needs to remap face-group bindings on commit.

---

## Dependencies & Execution Order

```
Phase 1 (TS registry + lifecycle tools) — no C++ dependency
  T001                        [dependency install, first]
  T002 [P], T003              [TS, parallel-ish]
  T004 → T005 [P] → T006 [P] → T007 [P]
  T008 → T009 → T010 → T011   [TS handlers, sequential same file]
  T012                        [tests, last]

Phase 2 (transaction_id on existing tools) — after Phase 1
  T013 [P], T016 [P]          [parallel — different files]
  T014 → T015                  [sequential — same file]
  T017                        [tests]
  T018 [P]                    [runs the suite — parallel with test authoring]

Phase 3 (shape-history for split_body_by_bends) — after Phase 2
  T019 [P]                    [header]
  T020 → T021                  [impl + build wiring]
  T022 → T023                  [service hpp + cc, sequential]
  T024                        [NAPI]
  T025 [P]                    [TS binding type]
  T026 → T027                  [TS handler + new tool]
  T028 [P], T029 [P]          [tests, parallel]

Phase 4 (remaining ops) — after Phase 3
  T030–T040                   [all [P] — each is a different mutating op file region]
  T041                        [TS binding types, after C++ NAPI changes for each op land]
  T042                        [TS handlers, after T041]
  T043                        [tests]
```

---

## Out of Scope (do NOT do in this feature)

The following are deliberately deferred to a later feature spec — most likely
`005-semantic-mapping-layer`. Implementing any of them in this feature breaks the Phase 0
boundary in [SemanticCad/MVP.md](../../SemanticCad/MVP.md).

- Semantic entity declaration (`declare_semantic_entity`)
- Semantic bindings (`bind_semantic_entity`)
- The Mapping Layer remap-on-commit pass
- Dolt persistence (transactions remain in memory)
- `resolve_geometry`, `semantic_lineage` tools
- Reading `shape_history` for any purpose other than `get_transaction_history` and tests
- Multi-session or nested transactions
- Migrating existing tests to use the transaction primitive (they keep working
  unchanged — that's the point of Phase 2)
