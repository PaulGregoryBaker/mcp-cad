# Semantic CAD MCP Specification

# Part 5 — Persistence on Dolt

> Companion to [MVP.md](MVP.md) and [WorkedExample-LeftBaseAirflow.md](WorkedExample-LeftBaseAirflow.md).
> Scope is MVP only. The schema and lifecycle here are sufficient for Phase 1; later phases
> will extend the schema but not break it.

---

# 1. Why Dolt

Dolt is a version-controlled SQL database. Every commit is queryable; branches are
first-class; merge/diff/`AS OF` are native SQL operations.

The fit with the proposed Transaction lifecycle is exact:

| Transaction concept ([TransactionBCMCP.md](TransactionBCMCP.md)) | Dolt primitive                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `begin_transaction`                                              | `CALL DOLT_CHECKOUT('-b', 'txn/<id>')`                               |
| stage operation (any mutating MCP tool with `transaction_id`)    | `INSERT` / `UPDATE` on the branch                                    |
| `preview_transaction` (deferred — concept only)                  | `SELECT` against the branch                                          |
| `validate_transaction` (deferred — concept only)                 | SQL constraint checks against the branch                             |
| `commit_transaction`                                             | `CALL DOLT_MERGE('txn/<id>')` into `main`; then `CALL DOLT_COMMIT`   |
| `rollback_transaction`                                           | `CALL DOLT_BRANCH('-D', 'txn/<id>')`                                 |
| Semantic lineage queries                                         | `SELECT ... FROM table AS OF 'rev'` or `DOLT_LOG('main', '--table')` |
| Impact analysis (deferred — concept only)                        | `DOLT_DIFF` between two refs                                         |

The two heaviest concepts in the conceptual docs — transactional preview/commit/rollback,
and semantic lineage with explainability — collapse into native Dolt operations rather than
custom infrastructure. This is the single biggest reason to adopt Dolt.

---

# 2. Variant Choice — Dolt-MySQL

Dolt ships two protocol variants:

* **Dolt** — MySQL wire-compatible. Mature, the primary supported product.
* **DoltgreSQL** — Postgres wire-compatible. Newer, less battle-tested, smaller surface.

**MVP picks Dolt-MySQL.** Rationale:

* No part of this project currently uses Postgres, so there is no compatibility constraint
  pulling toward DoltgreSQL.
* The MySQL wire protocol has mature TypeScript drivers (`mysql2`, `mysql2/promise`).
* Dolt's documented migrations, backup/restore, and replication target Dolt-MySQL.
* All Dolt stored procedures (`DOLT_MERGE`, `DOLT_DIFF`, `DOLT_LOG`, `DOLT_BRANCH`) are
  available identically on both variants, so a future switch is low-risk.

If at some point an external constraint forces Postgres, DoltgreSQL is the migration target.
Re-evaluate before Phase 2.

---

# 3. What Lives Where

The persistence boundary is sharp.

| Data                                                                      | Stored in            | Why                                                                      |
| ------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| OCCT B-Rep geometry (faces, edges, solids, the actual `TopoDS_Shape`)     | OS files / in-memory | Large, write-heavy, content-addressed by hash. Stays where it is today.  |
| Tessellations / preview meshes                                            | OS files / in-memory | Same.                                                                    |
| Semantic entities, relationships, bindings                                | **Dolt**             | Low volume, history-rich, lineage queries are the point.                 |
| Transaction metadata (id, label, timestamps, outcome)                     | **Dolt**             | Branch state is the transaction state.                                   |
| OCCT shape history per transaction (`Modified`/`Generated`/`IsDeleted`)   | **Dolt**             | Small, needed for lineage explainability.                                |
| Geometry revision pointers (revision id → BREP file path + content hash)  | **Dolt**             | Cheap; lets lineage queries reach back to the geometry that existed then. |
| Per-product Dolt database name and config                                 | YAML config          | Same place as existing manufacturing config.                             |

The principle: **Dolt stores references to geometry; OCCT/files store the geometry itself.**

---

# 4. Schema

All tables live in a single Dolt database, one database per product (e.g.
`semantic_braai`). Single-session MVP means one writer at a time.

## 4.1 `semantic_entity`

```sql
CREATE TABLE semantic_entity (
    id              VARCHAR(255) NOT NULL PRIMARY KEY,
    -- e.g. 'semantic://braai/firebox_panel_left'

    type            ENUM('panel', 'panel_group', 'joint_interface',
                          'functional_system', 'spatial_region') NOT NULL,
    purpose_json    JSON NULL,
    -- e.g. ["thermal_containment"]

    state           ENUM('candidate', 'confirmed', 'deprecated') NOT NULL
                       DEFAULT 'confirmed',
    -- 'inferred' and 'conflicting' deferred until an Inference Engine exists

    created_in_transaction VARCHAR(64) NOT NULL,
    created_at      DATETIME(3) NOT NULL,

    INDEX (type),
    INDEX (created_in_transaction)
);
```

## 4.2 `semantic_relationship`

```sql
CREATE TABLE semantic_relationship (
    source_id       VARCHAR(255) NOT NULL,
    relationship    ENUM('contains', 'bounded_by', 'connected_to',
                          'manufactured_as', 'joined_by', 'bent_along') NOT NULL,
    target_id       VARCHAR(255) NOT NULL,

    created_in_transaction VARCHAR(64) NOT NULL,
    created_at      DATETIME(3) NOT NULL,

    PRIMARY KEY (source_id, relationship, target_id),
    INDEX (target_id, relationship)
);
```

## 4.3 `semantic_mapping`

```sql
CREATE TABLE semantic_mapping (
    revision_id     BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    semantic_id     VARCHAR(255) NOT NULL,

    binding_kind    ENUM('face_group', 'body', 'spatial_region') NOT NULL,

    -- For 'face_group' and 'body': enumerated face/body IDs.
    -- For 'spatial_region': the derivation rule { between: [id_a, id_b] }.
    binding_json    JSON NOT NULL,

    topology_revision      BIGINT NOT NULL,
    created_in_transaction VARCHAR(64) NOT NULL,
    created_at             DATETIME(3) NOT NULL,
    remap_reason           VARCHAR(255) NULL,
    -- NULL for original bindings; populated when this row was produced by a
    -- topology remap on commit. e.g. 'split_body_by_bends → OCCT Modified()'

    INDEX (semantic_id, revision_id),
    INDEX (topology_revision)
);
```

A semantic entity's "current binding" is the row with the largest `revision_id` for
its `semantic_id`. Older rows are the lineage.

## 4.4 `topology_revision`

```sql
CREATE TABLE topology_revision (
    id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    transaction_id  VARCHAR(64) NOT NULL,
    brep_file_path  VARCHAR(1024) NOT NULL,
    brep_sha256     CHAR(64) NOT NULL,
    created_at      DATETIME(3) NOT NULL,

    UNIQUE (transaction_id),
    INDEX (brep_sha256)
);
```

## 4.5 `shape_history`

The captured `Modified`/`Generated`/`IsDeleted` records from OCCT, per transaction:

```sql
CREATE TABLE shape_history (
    transaction_id  VARCHAR(64) NOT NULL,
    verdict         ENUM('modified', 'generated', 'deleted') NOT NULL,
    -- 'modified' / 'generated': original_face → new_face mapping
    -- 'deleted':                original_face only
    original_id     VARCHAR(255) NOT NULL,
    new_id          VARCHAR(255) NULL,
    operation_label VARCHAR(64) NOT NULL,
    -- e.g. 'split_body_by_bends'

    PRIMARY KEY (transaction_id, verdict, original_id, new_id),
    INDEX (original_id),
    INDEX (transaction_id)
);
```

This is the input to the Mapping Layer's remap pass in
[WorkedExample-LeftBaseAirflow.md §7.1](WorkedExample-LeftBaseAirflow.md).

## 4.6 `transaction`

```sql
CREATE TABLE transaction (
    id              VARCHAR(64) NOT NULL PRIMARY KEY,
    -- e.g. 'transaction://01HZ...' (ULID)

    label           VARCHAR(255) NOT NULL,
    product         VARCHAR(64) NOT NULL,
    state           ENUM('active', 'committed', 'rolled_back') NOT NULL,
    started_at      DATETIME(3) NOT NULL,
    ended_at        DATETIME(3) NULL,

    INDEX (state)
);
```

The Dolt branch name for a transaction is `txn/<id>`. State is also implied by branch
existence (active = branch exists; committed/rolled_back = branch gone), but storing it
explicitly avoids a branch-listing call on every lookup.

---

# 5. Lifecycle in SQL

Mapping the [MVP.md §3.1](MVP.md) tools to Dolt operations:

## 5.1 `begin_transaction`

```sql
-- Transaction id is generated client-side as a ULID.
CALL DOLT_CHECKOUT('-b', 'txn/01HZ...');

INSERT INTO transaction (id, label, product, state, started_at)
VALUES ('transaction://01HZ...',
        'declare left-base airflow system',
        'braai',
        'active',
        NOW(3));
```

## 5.2 `declare_semantic_entity` / `bind_semantic_entity`

Plain `INSERT`s on the transaction branch.

## 5.3 Mutating geometry tool (e.g. `split_body_by_bends`)

```sql
-- After the OCCT operation finishes, the C++ layer hands the shape-history
-- records to the TS layer, which bulk-inserts them:
INSERT INTO shape_history
  (transaction_id, verdict, original_id, new_id, operation_label)
VALUES
  ('transaction://01HZ...', 'modified',
   'face://shell/firebox_left/face/5',
   'face://shell/firebox_left/panel/0/face/0',
   'split_body_by_bends'),
  ('transaction://01HZ...', 'modified',
   'face://shell/firebox_left/face/6',
   'face://shell/firebox_left/panel/1/face/0',
   'split_body_by_bends'),
  ...;
```

## 5.4 `commit_transaction`

```sql
-- 1. Compute the new topology revision row.
INSERT INTO topology_revision
  (transaction_id, brep_file_path, brep_sha256, created_at)
VALUES
  ('transaction://01HZ...', '/state/braai/rev/2.brep', '<sha>', NOW(3));

-- 2. For each semantic_id with a binding affected by shape_history,
--    insert a new row in semantic_mapping with remap_reason set.
INSERT INTO semantic_mapping
  (semantic_id, binding_kind, binding_json,
   topology_revision, created_in_transaction, created_at, remap_reason)
SELECT
  sm.semantic_id,
  sm.binding_kind,
  JSON_OBJECT('face_ids', JSON_ARRAYAGG(sh.new_id)),
  2,
  'transaction://01HZ...',
  NOW(3),
  CONCAT(sh.operation_label, ' → OCCT ', sh.verdict, '()')
FROM semantic_mapping sm
JOIN shape_history sh
  ON sh.original_id MEMBER OF (sm.binding_json->>'$.face_ids')
WHERE sm.revision_id IN (
        SELECT MAX(revision_id) FROM semantic_mapping GROUP BY semantic_id
      )
  AND sh.transaction_id = 'transaction://01HZ...'
GROUP BY sm.semantic_id, sm.binding_kind, sh.operation_label, sh.verdict;

-- 3. Mark transaction committed.
UPDATE transaction
SET    state = 'committed', ended_at = NOW(3)
WHERE  id = 'transaction://01HZ...';

-- 4. Switch back to main and merge.
CALL DOLT_CHECKOUT('main');
CALL DOLT_MERGE('txn/01HZ...', '--no-ff');
CALL DOLT_COMMIT('-m', 'declare left-base airflow system');
CALL DOLT_BRANCH('-d', 'txn/01HZ...');
```

The `MEMBER OF` predicate is the only piece of MySQL-specific JSON syntax used; if it
turns out unsupported on the Dolt build pinned for the project, swap it for a join
materialised in application code.

## 5.5 `rollback_transaction`

```sql
UPDATE transaction
SET    state = 'rolled_back', ended_at = NOW(3)
WHERE  id = 'transaction://01HZ...';

CALL DOLT_CHECKOUT('main');
CALL DOLT_BRANCH('-D', 'txn/01HZ...');   -- discard everything on the branch
```

## 5.6 `semantic_lineage`

The query shown in
[WorkedExample-LeftBaseAirflow.md §9](WorkedExample-LeftBaseAirflow.md):

```sql
SELECT
    sm.revision_id,
    t.label,
    t.id          AS transaction_id,
    sm.binding_json,
    sm.remap_reason,
    sm.created_at
FROM   semantic_mapping sm
JOIN   transaction t ON t.id = sm.created_in_transaction
WHERE  sm.semantic_id = ?
ORDER BY sm.revision_id ASC;
```

For point-in-time queries (`at_revision` parameter on `resolve_geometry`):

```sql
SELECT *
FROM   semantic_mapping AS OF 'main~5'
WHERE  semantic_id = ?
ORDER BY revision_id DESC
LIMIT 1;
```

The `AS OF` syntax is Dolt's native time-travel. The reference can be a commit hash,
a tag, or a relative ref.

---

# 6. Operational Notes

## 6.1 Where Dolt runs

For MVP single-session use, Dolt runs as a **local process** alongside the MCP server.
Two options:

* **`dolt sql-server`** — TCP MySQL endpoint on localhost. Standard MySQL drivers work.
  Recommended for the MVP.
* **Embedded** — Dolt's Go library embedded into a sidecar process. Lower latency, more
  setup. Not recommended for MVP.

The MCP server connects via `mysql2/promise`. Connection config goes in the existing
YAML config:

```yaml
persistence:
  driver: dolt
  host: 127.0.0.1
  port: 3306
  database: semantic_braai
```

## 6.2 Where the Dolt data directory lives

* Default: `<project_state_dir>/dolt/<product>/`.
* Configurable via `persistence.data_dir` in the YAML config.
* Backed up by copying the directory while `dolt sql-server` is stopped, or by
  `dolt clone --depth 1` while it is running.

## 6.3 Performance envelope (informational)

Dolt's per-row write is heavier than vanilla MySQL because of the underlying
Prolly tree commits. For the MVP workload — semantic store inserts and shape-history
inserts on the order of 100s–1000s of rows per transaction — this is well within
budget. If a future operation generates significantly more shape-history rows
(e.g. a large boolean cut producing tens of thousands of faces), batch the inserts
and commit once per transaction rather than per row.

The 30-second MVP end-to-end budget from
[docs/MVP_SCOPE.md §MVP Success Criteria](../docs/MVP_SCOPE.md) is not threatened by
this volume.

## 6.4 Constitution amendment required

The state-persistence resolution `D3-A: In-memory, session-scoped only` lives in the
Constitution's tech-stack table (sourced from [Engineering-Design.md §1](../Engineering-Design.md)).
Introducing Dolt is a deliberate, scoped amendment to that resolution, filed at
[.specify/memory/amendments/v1.2-semantic-persistence.md](../.specify/memory/amendments/v1.2-semantic-persistence.md).
It must be ratified per Constitution §Governance before Phase 1 starts. Geometry state
remains in-memory + BREP files; only the semantic graph and transaction metadata move
to Dolt.

---

# 7. What Is Not Yet Designed

These are deliberately deferred to a later phase. They are listed here so future
work doesn't accidentally lock them out.

* **Multi-product graph linking.** The schema is per-product. Cross-product
  `semantic://*` references would need either a single shared database or
  cross-database foreign keys (Dolt supports both, but the merge story across
  products is undesigned).
* **Concurrent transactions.** MVP is single-session, so the second writer is
  rejected at the MCP layer. True multi-session would use Dolt branches per
  session and rely on `DOLT_MERGE` conflict resolution. The schema supports it;
  the policy doesn't yet.
* **Schema migrations.** No tooling proposed yet. The first migration after Phase 1
  ships will need a `schema_version` table and a forward-only migration runner.
* **Inferred entities.** When the Inference Engine ships, `semantic_entity.state`
  will accept `inferred` and `conflicting`, and confidence/evidence columns will be
  added. Their absence in MVP is intentional.
* **Garbage collection of unreferenced topology revisions.** Phase 1 keeps every
  revision. A future GC pass can drop revisions older than N once no semantic
  lineage row references them.
