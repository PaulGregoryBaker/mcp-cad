# Implementation Plan: Semantic Mapping Layer + Dolt Persistence

**Branch**: `005-semantic-mapping-layer` | **Date**: 2026-05-21 | **Spec**: [spec.md](spec.md)

---

## Summary

Adds a new **Semantic Mapping** bounded context (TS) backed by a local Dolt-MySQL
database. The context exposes five MCP tools (`declare_semantic_entity`,
`bind_semantic_entity`, `resolve_geometry`, `semantic_lineage`, plus a startup-time
migration runner), and a Mapping Layer remap pass that runs inside the
`commit_transaction` handler shipped in [`004`](../004-transaction-primitive/plan.md).

This is the **MVP gate** for the Semantic CAD MCP architecture
([SemanticCad/MVP.md](../../SemanticCad/MVP.md)). After this ships, the worked
scenario in [WorkedExample-LeftBaseAirflow.md](../../SemanticCad/WorkedExample-LeftBaseAirflow.md)
runs end-to-end.

---

## Prerequisites

| Prerequisite                                                  | Verified by                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Constitution v1.2 in `main`                                   | T001 — string match for "Version: 1.2" in [.specify/memory/constitution.md](../../.specify/memory/constitution.md). |
| `Engineering-Design.md §1 D3` updated with `D3-B`             | T002 — manual review.                                                                        |
| `004-transaction-primitive` merged to `main`                  | T003 — `git log --grep="004-transaction-primitive"` returns a merge commit on `main`.        |
| `dolt` CLI installed on developer/CI machine                  | T004 — `dolt version` succeeds in CI.                                                        |

Tasks T001–T004 are gates. None of the remaining work runs if any fail.

---

## Technical Context

**Language/Version**: TypeScript only. No C++ changes in Phase 1; OCCT shape history
is already captured by `004`.

**Primary Dependencies**:
- TS: `mysql2` (^3.x, MySQL driver for the Dolt wire protocol), `ulid` (already added
  in `004`).
- External: Dolt 1.x (MySQL-compatible binary, `dolt sql-server`).

**Constraints**:
- Constitution v1.2 `D3-B`: Dolt is allowed only for the semantic graph + transaction
  metadata. Geometry stays in memory + BREP files.
- Constitution Principle II: the Semantic Mapping context owns Dolt; no OCCT
  primitives leak into it (only `ShapeHistoryRecord` arrives via the
  `ShapeHistoryPort`).
- Constitution Principle VII: single-session, single-writer. Multi-session is
  out of scope.
- The schema in [Persistence-Dolt.md §4](../../SemanticCad/Persistence-Dolt.md) is
  authoritative. The plan does not redefine it; it implements it.

---

## Design

### Module layout

```
ts/src/semantic/
├── port.ts                  // SemanticPersistencePort interface
├── dolt_adapter.ts          // mysql2-backed implementation
├── migrations/
│   └── 001_initial.sql      // schema from Persistence-Dolt.md §4
├── migration_runner.ts      // applies migrations idempotently on startup
├── semantic_store.ts        // CRUD over the schema (no Dolt-branch awareness)
├── mapping_layer.ts         // remap on commit; spatial-region resolution
├── identifiers.ts           // URI validation + slug rules
└── types.ts                 // shared types (SemanticEntity, Binding, etc.)

ts/src/mcp/tools.ts          // 4 new tools + commit_transaction hook
ts/src/mcp/transactions.ts   // extended: opens/closes Dolt branches
```

### Tool surface added in Phase 1

| Tool                       | Input                                                                                | Output                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `declare_semantic_entity`  | `{id, type, purpose?, relationships?, transaction_id}`                               | `{id, revision_id}`                                                     |
| `bind_semantic_entity`     | `{semantic_id, binding: face_group | body | spatial_region, transaction_id}`         | `{mapping_id, revision_id}`                                             |
| `resolve_geometry`         | `{semantic_id, at_revision?}`                                                        | `{semantic_id, topology_revision, bindings: [...]}`                     |
| `semantic_lineage`         | `{semantic_id}`                                                                      | `[{revision_id, transaction_id, label, binding, remap_reason}]`         |

All four require `transaction_id` for mutating ops and resolve via the active
transaction's Dolt branch when one is active, or against `main` when none is.

### `commit_transaction` extension

The existing handler from `004` keeps its current responsibilities. After the
in-memory snapshot is discarded, it additionally calls
`MappingLayer.applyShapeHistoryToBindings(transaction)`:

```
1. Read shape_history rows for this transaction.
2. For each currently-bound face_group whose face_ids intersect shape_history.original_id:
     - Compute new face_ids by applying Modified/Generated/Deleted verdicts.
     - INSERT a new semantic_mapping row with the new topology_revision and the
       remap_reason "{operation_label} → OCCT {verdict}()".
3. For each spatial_region binding whose constituents had bindings remapped in step 2:
     - INSERT a new semantic_mapping row with the same derivation rule, new
       topology_revision, and remap_reason "spatial_region refresh".
4. Insert a topology_revision row recording the new BREP file hash.
5. CALL DOLT_MERGE('txn/<id>') and CALL DOLT_COMMIT.
6. CALL DOLT_BRANCH('-d', 'txn/<id>').
```

Step 5 failure → step 6 is replaced by `DOLT_BRANCH('-D')` and the structured error
`PERSISTENCE_COMMIT_FAILED` is raised. The geometry snapshot from `004` has already
been discarded by this point; the geometry is in the new state but the semantic
store didn't catch up. This is a known, surfaced inconsistency for MVP; recovery
is "reload product." A future hardening pass can defer geometry snapshot disposal
until after the Dolt merge succeeds.

### Spatial-region resolution

Resolution is lazy. `resolve_geometry` on a `spatial_region` binding does not
read pre-materialised face IDs from `binding_json`; it joins the constituent
entities' current bindings and returns the union as `materialised_face_ids`:

```sql
WITH current_binding AS (
    SELECT semantic_id, binding_json
    FROM semantic_mapping
    WHERE revision_id IN (
        SELECT MAX(revision_id)
        FROM semantic_mapping
        GROUP BY semantic_id
    )
)
SELECT
    sm.semantic_id,
    JSON_ARRAYAGG(jt.face_id) AS materialised_face_ids
FROM   semantic_mapping sm
JOIN   JSON_TABLE(sm.binding_json, '$.between[*]'
         COLUMNS (constituent_id VARCHAR(255) PATH '$')) AS between_ids
JOIN   current_binding cb ON cb.semantic_id = between_ids.constituent_id
JOIN   JSON_TABLE(cb.binding_json, '$.face_ids[*]'
         COLUMNS (face_id VARCHAR(255) PATH '$')) AS jt
WHERE  sm.binding_kind = 'spatial_region'
AND    sm.semantic_id = ?
GROUP BY sm.semantic_id;
```

If `JSON_TABLE` turns out unsupported on the Dolt build pinned for the project,
fall back to application-side materialisation (load the two bindings, union in TS).
Variant is decided at task T015.

### Branch lifecycle (extends `004`)

```
begin_transaction
  → SnapshotRegistry::createSnapshot(label)    (existing in 004)
  → CALL DOLT_CHECKOUT('-b', 'txn/<id>')       (new in 005)
  → INSERT INTO transaction (...)              (new in 005)

[semantic mutations] → INSERT on the branch
[geometry mutations] → existing 004 behaviour + shape_history rows on the branch

commit_transaction
  → MappingLayer.applyShapeHistoryToBindings(txn)  (new in 005)
  → INSERT topology_revision                       (new in 005)
  → UPDATE transaction SET state='committed'       (new in 005)
  → CALL DOLT_CHECKOUT('main')
  → CALL DOLT_MERGE('txn/<id>', '--no-ff')
  → CALL DOLT_COMMIT('-m', '<label>')
  → CALL DOLT_BRANCH('-d', 'txn/<id>')
  → SnapshotRegistry::clearSnapshots()             (existing in 004)

rollback_transaction
  → CALL DOLT_CHECKOUT('main')
  → CALL DOLT_BRANCH('-D', 'txn/<id>')
  → SnapshotRegistry::restoreSnapshot(...)         (existing in 004)
```

### Identifier validation

Implemented in `identifiers.ts` as a pure function. URI shape and slug rules per
[SemanticCad/MVP.md §6.3](../../SemanticCad/MVP.md). Type and relationship
vocabularies enforced as enums in `types.ts` and mirrored by ENUM columns in the
Dolt schema.

---

## Constitution Check

| Principle                  | Status        | Notes                                                                                                              |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| I. Deterministic geometry  | PASS          | All semantic operations are deterministic given the same shape history + same Dolt state.                          |
| II. Bounded contexts       | EXPANDED      | New **Semantic Mapping** context introduced per amendment v1.2 §4.1. No OCCT primitives cross the port.            |
| III. Safety filter         | PASS          | Unchanged.                                                                                                         |
| IV. Rollback-first         | PASS          | Geometry rollback still goes through `SnapshotRegistry`. Semantic rollback is `DOLT_BRANCH('-D')` on the txn branch. |
| V. Kerf compensation       | PASS          | Unchanged.                                                                                                         |
| VI. Structured errors      | PASS          | All new error codes structured.                                                                                    |
| VII. MVP scope             | PASS          | Single-session, single-writer, local Dolt only. No inference, no analyses beyond existing manufacturability.       |
| VIII. Configuration        | PASS          | Dolt connection params loaded from YAML config; no hard-coded values.                                              |
| IX. Async export           | PASS          | Unchanged.                                                                                                         |

---

## New Error Codes

| Code                            | Meaning                                                                                                | Recoverable |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| `PERSISTENCE_UNAVAILABLE`       | Dolt server not reachable                                                                              | true        |
| `PERSISTENCE_COMMIT_FAILED`     | `DOLT_MERGE` or `DOLT_COMMIT` failed during `commit_transaction` (semantic store inconsistent — reload required) | false |
| `SEMANTIC_ID_EXISTS`            | A `declare_semantic_entity` call collided with an existing id                                          | true        |
| `SEMANTIC_ID_NOT_FOUND`         | The semantic id does not exist in the current branch                                                   | true        |
| `SEMANTIC_TYPE_NOT_SUPPORTED`   | Entity `type` is outside the Phase 1 vocabulary lock                                                   | true        |
| `SEMANTIC_RELATIONSHIP_NOT_SUPPORTED` | Relationship is outside the Phase 1 vocabulary lock                                              | true        |
| `BINDING_FACE_ALREADY_BOUND`    | A face id is already bound to a different entity at this revision                                      | true        |
| `BINDING_KIND_NOT_SUPPORTED`    | Binding kind is outside `face_group`, `body`, `spatial_region`                                         | true        |
| `SEMANTIC_CONSTITUENT_NOT_FOUND`| A `spatial_region` binding referenced an unknown constituent entity                                    | true        |
| `REVISION_NOT_FOUND`            | `at_revision` is beyond current HEAD                                                                   | true        |

---

## Project Files Changed

| File                                                       | Change                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `package.json`                                             | Add `mysql2` dependency.                                                                            |
| `ts/src/config/loader.ts`                                  | Add `persistence: {driver, host, port, database, data_dir}` schema with sensible defaults.          |
| `ts/src/semantic/port.ts`                                  | **new**. `SemanticPersistencePort` interface.                                                       |
| `ts/src/semantic/dolt_adapter.ts`                          | **new**. `mysql2` implementation of the port.                                                       |
| `ts/src/semantic/migrations/001_initial.sql`               | **new**. Schema per Persistence-Dolt.md §4.                                                         |
| `ts/src/semantic/migration_runner.ts`                      | **new**. Idempotent startup-time migration application.                                             |
| `ts/src/semantic/semantic_store.ts`                        | **new**. CRUD wrapper around the port.                                                              |
| `ts/src/semantic/mapping_layer.ts`                         | **new**. Remap pass + spatial-region resolution.                                                    |
| `ts/src/semantic/identifiers.ts`                           | **new**. URI + slug + vocabulary validation.                                                        |
| `ts/src/semantic/types.ts`                                 | **new**. Shared types.                                                                              |
| `ts/src/mcp/tools.ts`                                      | Add 4 new tool definitions and dispatch handlers; extend `handleCommitTransaction` and `handleRollbackTransaction` to call the Dolt branch lifecycle and Mapping Layer. |
| `ts/src/mcp/transactions.ts`                               | Extend `TransactionRegistry.begin/commit/rollback` to coordinate Dolt branches.                     |
| `ts/src/mcp/errors.ts`                                     | Add the new error codes.                                                                            |
| `ts/src/geometry/session.ts`                               | Expose a `getSemanticStore()` and `getMappingLayer()` accessor; wire startup-time migration runner. |
| `ts/tests/integration/semantic_mapping.integration.test.ts`| **new**. Covers US1–US4 against a CI-managed Dolt instance.                                         |
| `Engineering-Design.md`                                    | Update §1 D3 to list `D3-B`; add the Semantic Mapping context to §2.                                |
| `docker-compose.yml` (or new launcher script)              | Add a `dolt-sql-server` service for local + CI.                                                     |
| `.github/workflows/*.yml`                                  | Add a job step to start `dolt sql-server` before the integration suite.                             |

---

## Implementation Order

Four phases, each independently testable.

1. **Phase 1** — Prerequisites and Dolt scaffolding: ratify the amendment in `main`,
   stand up Dolt locally and in CI, install the schema, prove the store can be
   written to and read from. No MCP tools yet.

2. **Phase 2** — Declare/bind/resolve without remap (US1): four CRUD tools and a
   simple `resolve_geometry` that returns the latest binding. Demonstrates that the
   schema + branch lifecycle work; remap on commit is still a no-op pass-through.

3. **Phase 3** — Mapping Layer remap (US2 + US3): the load-bearing piece. The
   `commit_transaction` handler invokes `applyShapeHistoryToBindings`, face-group
   bindings remap, and spatial-region bindings recompute. After this phase, the
   worked example from `WorkedExample-LeftBaseAirflow.md` passes through §8 (identity
   survival).

4. **Phase 4** — Lineage and time travel (US4): `semantic_lineage` and
   `resolve_geometry({at_revision})` ship. After this, the worked example passes
   end-to-end including §9 (lineage query).
