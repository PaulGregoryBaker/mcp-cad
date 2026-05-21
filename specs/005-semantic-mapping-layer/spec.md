# Feature Specification: Semantic Mapping Layer + Dolt Persistence (Phase 1 of Semantic CAD MCP)

**Feature Branch**: `005-semantic-mapping-layer`

**Created**: 2026-05-21

**Status**: Draft (gated on Constitution v1.2)

---

## Background

[Phase 0](../004-transaction-primitive/spec.md) gives the system explicit transactions
and per-transaction OCCT shape history. This feature layers semantic identity on top of
that. After this ships, an AI agent can declare a semantic identifier such as
`semantic://braai/firebox_panel_left`, bind it to a set of face IDs, and continue to
refer to it by the same identifier after `split_body_by_bends` has rewritten those face
IDs underneath it.

This is the load-bearing claim of the Semantic CAD MCP architecture
([SemanticCad/MVP.md](../../SemanticCad/MVP.md) Phase 1). The full acceptance scenario
is documented in
[SemanticCad/WorkedExample-LeftBaseAirflow.md](../../SemanticCad/WorkedExample-LeftBaseAirflow.md).

Persistence is on Dolt-MySQL per
[SemanticCad/Persistence-Dolt.md](../../SemanticCad/Persistence-Dolt.md).

---

## Prerequisites

This feature **cannot merge** until:

1. **Constitution amendment v1.2 is ratified.** Adds `D3-B: In-memory + Dolt-persisted
   semantic graph (Phase 1)` to the tech-stack table. Filed at
   [.specify/memory/amendments/v1.2-semantic-persistence.md](../../.specify/memory/amendments/v1.2-semantic-persistence.md).
   Required because the existing `D3-A` resolution forbids out-of-process persistence.
2. **`004-transaction-primitive` is merged to main.** Phase 1 consumes the
   `ShapeHistoryRecord` records produced by transactional mutating ops; without them
   the Mapping Layer cannot remap face-group bindings on commit.
3. **`Engineering-Design.md §1 D3` and §2 Context Map updated.** Per Constitution
   §Governance migration plan in the amendment.

These prerequisites are enforced as T001/T002 of [tasks.md](tasks.md).

---

## User Scenarios & Testing

### User Story 1 — Declare and bind a semantic entity (Priority: P1)

An engineer (or AI agent) imports `braai.step`, identifies the outer-left panel, and
wants to give it a stable name that survives all future modifications. They declare
`semantic://braai/outer_panel_left` and bind it to a set of face IDs. Future operations
can refer to it by name without holding onto face IDs.

**Why this priority**: Nothing else in this feature works without basic
declare-and-bind. This is the schema, the persistence, and the simplest end-to-end
path through Dolt.

**Independent Test**: Open transaction → `declare_semantic_entity` →
`bind_semantic_entity` → `commit_transaction` → `resolve_geometry`. Assert
returned face IDs match what was bound.

**Acceptance Scenarios**:

1. **Given** an active transaction and a loaded `braai.step`, **When** the agent
   calls `declare_semantic_entity` with a fresh id, **Then** the entity is written
   to Dolt on the transaction branch and the response includes the id and a
   revision number.

2. **Given** a declared but unbound entity, **When** `bind_semantic_entity` is called
   with a `face_group` binding, **Then** a `semantic_mapping` row is inserted on the
   transaction branch with `remap_reason: NULL`.

3. **Given** the transaction is committed, **When** `resolve_geometry` is called on
   the entity id, **Then** the bound face IDs are returned along with the current
   `topology_revision`.

4. **Given** the transaction is rolled back, **When** `resolve_geometry` is called,
   **Then** `SEMANTIC_ID_NOT_FOUND` is returned — the entity is gone with the
   discarded branch.

---

### User Story 2 — Face-group binding survives `split_body_by_bends` (Priority: P1)

An engineer has declared `semantic://braai/firebox_panel_left` and bound it to three
face IDs on the firebox shell. They now call `split_body_by_bends` on that shell,
which cuts it into three panels with new face IDs. The semantic identifier must
continue to resolve — to the *new* face IDs — without the agent having to track the
mutation.

**Why this priority**: This is the entire reason the Mapping Layer exists. Without
this scenario passing, the feature has not delivered any of its promised value.

**Independent Test**: Open transaction → declare + bind firebox panel → call
`split_body_by_bends` → commit. After commit, `resolve_geometry` returns the new
face IDs produced by the cut, not the original ones, under the same semantic id.

**Acceptance Scenarios**:

1. **Given** the firebox panel entity is bound to faces `f5, f6, f7` at
   `topology_revision: 1`, **When** `split_body_by_bends` produces shape-history
   records `f5 → p0/f0`, `f6 → p1/f0`, `f7 → p2/f0` and the transaction is
   committed, **Then** `resolve_geometry` returns face IDs `p0/f0, p1/f0, p2/f0`
   under the same semantic id, with `topology_revision: 2`.

2. **Given** the same setup, **When** `semantic_lineage` is queried, **Then** it
   returns at least two rows for this entity: the original binding and the
   post-commit remapped binding, the latter with
   `remap_reason: "split_body_by_bends → OCCT modified()"` (or similar).

3. **Given** a binding whose face IDs were marked `IsDeleted` by the operation,
   **When** the transaction is committed, **Then** the new binding row contains an
   empty face-group and `remap_reason: "<op> → OCCT deleted()"` — the entity still
   exists, the binding is just empty. The agent can decide whether to delete or
   re-bind the entity.

4. **Given** the transaction is rolled back instead of committed, **When**
   `resolve_geometry` is called, **Then** the pre-split binding (`f5, f6, f7`) is
   returned — no remap was persisted.

---

### User Story 3 — Spatial-region binding survives mutation of a constituent (Priority: P2)

An engineer declares `semantic://braai/left_base_airflow` as a `functional_system`
bounded by the outer panel and the firebox panel. They bind it as a `spatial_region`
"between" the two panels. After `split_body_by_bends` on the firebox panel, the
airflow region still resolves — to a region computed from the *new* firebox panel
faces.

**Why this priority**: This is the novel binding kind that distinguishes the Mapping
Layer from a simple face-ID alias table. It's the part that earns the architecture
its keep.

**Independent Test**: Run the full scenario in
[WorkedExample-LeftBaseAirflow.md](../../SemanticCad/WorkedExample-LeftBaseAirflow.md)
on the `braai.step` fixture. After commit, `resolve_geometry` on the airflow id
returns materialised faces that include the new firebox panel face IDs, not the old.

**Acceptance Scenarios**:

1. **Given** the airflow entity is bound as
   `{kind: "spatial_region", between: [outer_panel_left, firebox_panel_left]}`,
   **When** `resolve_geometry` is called before any mutation, **Then** the response
   includes `materialised_face_ids` that is the union of the constituent entities'
   current face-group bindings.

2. **Given** `split_body_by_bends` runs on the firebox panel and the transaction
   commits, **When** `resolve_geometry` is called on the airflow id, **Then** the
   `materialised_face_ids` reflect the new firebox panel face IDs without the agent
   re-declaring or re-binding anything.

3. **Given** the agent supplies a non-existent constituent id at binding time,
   **When** `bind_semantic_entity` is called, **Then**
   `SEMANTIC_CONSTITUENT_NOT_FOUND` is returned.

---

### User Story 4 — Lineage and point-in-time queries (Priority: P3)

An agent (or an explainability tool) needs to answer "how did
`semantic://braai/firebox_panel_left` get to its current binding?" or "what did this
entity look like at `topology_revision: 1`?" The Mapping Layer surfaces this via
`semantic_lineage` and an `at_revision` parameter on `resolve_geometry`.

**Why this priority**: Explainability is one of the original architectural goals from
[SemanticCad/SolutionDesign.md](../../SemanticCad/SolutionDesign.md). It is not a
runtime dependency of any other story — but without it, debugging and human
validation are blind.

**Independent Test**: After US2 commits, query `semantic_lineage` and verify two
rows; query `resolve_geometry({semantic_id, at_revision: 1})` and verify the
pre-split binding is returned.

**Acceptance Scenarios**:

1. **Given** the firebox panel has been declared, bound, split, and re-bound
   (two persisted revisions), **When** `semantic_lineage` is called, **Then** it
   returns both rows in revision order, each with its `transaction_id`,
   `transaction.label`, `binding`, and `remap_reason`.

2. **Given** the same state, **When** `resolve_geometry({semantic_id,
   at_revision: 1})` is called, **Then** the pre-split face IDs are returned and
   `topology_revision: 1` is in the response.

3. **Given** an `at_revision` value beyond the current head, **When**
   `resolve_geometry` is called, **Then** `REVISION_NOT_FOUND` is returned.

---

### Edge Cases

- **Two bindings claim the same face.** Phase 1 rejects the second binding with
  `BINDING_FACE_ALREADY_BOUND`. A future merge-and-split toolkit will handle
  conflict resolution.
- **Operation produces no OCCT history records that match any binding.** The
  commit completes; affected entities carry their previous binding forward into
  the new revision with no `remap_reason`. This is the "untouched" case.
- **Spatial-region binding where one constituent has an empty face-group after
  remap.** The materialised region is the other constituent's faces only. The
  binding does not fail. The agent can detect this via `resolve_geometry`.
- **Dolt server unreachable at transaction commit.** Commit returns
  `PERSISTENCE_UNAVAILABLE` (structured error, recoverable). The transaction
  remains active; the agent can retry commit, or call `rollback_transaction` to
  discard.
- **Declared identifier collides with an existing one (same product slug + entity
  slug).** Returns `SEMANTIC_ID_EXISTS`.

---

## Requirements

### Functional Requirements

- **FR-001**: A Dolt-MySQL instance MUST be reachable to the MCP server at server
  startup. Configuration parameters are loaded from the YAML config under
  `persistence:` per [SemanticCad/Persistence-Dolt.md §6.1](../../SemanticCad/Persistence-Dolt.md).
- **FR-002**: On startup the server MUST verify the schema in
  [SemanticCad/Persistence-Dolt.md §4](../../SemanticCad/Persistence-Dolt.md) is
  present; if absent, run the bundled initial migration. Schema-version tracking is
  out of scope for Phase 1.
- **FR-003**: `begin_transaction` MUST create a Dolt branch `txn/<transaction_id>`
  in addition to the existing snapshot work from
  [`004`](../004-transaction-primitive/spec.md). The branch is checked out for the
  remainder of the transaction.
- **FR-004**: `commit_transaction` MUST execute the Mapping Layer remap pass
  (§Design below), then merge the transaction branch into `main` and delete it.
- **FR-005**: `rollback_transaction` MUST delete the transaction branch without
  merging.
- **FR-006**: `declare_semantic_entity` MUST insert a row in `semantic_entity` and
  any rows in `semantic_relationship` per the request; entities are scoped to the
  product slug fixed at `begin_transaction` time.
- **FR-007**: `bind_semantic_entity` MUST accept `face_group`, `body`, and
  `spatial_region` binding kinds. Other kinds are deferred.
- **FR-008**: `resolve_geometry` without `at_revision` MUST return the binding from
  the highest `revision_id` for the entity at the current Dolt HEAD. With
  `at_revision`, it MUST return the binding at that revision via Dolt `AS OF`.
- **FR-009**: `semantic_lineage` MUST return all `semantic_mapping` rows for an
  entity in `revision_id` order, joined with `transaction.label` and the
  `remap_reason`.
- **FR-010**: On commit, the Mapping Layer MUST iterate the transaction's
  `shape_history` records and, for each `face_group` binding whose face IDs appear
  in `shape_history.original_id`, write a new `semantic_mapping` row at the new
  `topology_revision`. The new row's `binding_json` reflects the
  `Modified`/`Generated`/`Deleted` verdicts. `remap_reason` carries
  `<operation_label> → OCCT <verdict>()`.
- **FR-011**: On commit, the Mapping Layer MUST refresh derived `spatial_region`
  bindings whose constituents had bindings remapped in this transaction. The
  refresh writes a new row referencing the same derivation rule; resolution at
  any later point materialises faces lazily against the current constituent
  bindings.
- **FR-012**: Identifier validation: the entity slug MUST match `^[a-z][a-z0-9_]*$`
  and the resulting `semantic://<product>/<slug>` MUST be unique within the
  product's database. Duplicates return `SEMANTIC_ID_EXISTS`.
- **FR-013**: The entity-type vocabulary is locked for Phase 1 to: `panel`,
  `panel_group`, `joint_interface`, `functional_system`, `spatial_region`.
  Other types from [DDD Design.md](../../SemanticCad/DDD%20Design.md) §5.3 return
  `SEMANTIC_TYPE_NOT_SUPPORTED`.
- **FR-014**: The relationship vocabulary is locked for Phase 1 to: `contains`,
  `bounded_by`, `connected_to`, `manufactured_as`, `joined_by`, `bent_along`.
- **FR-015**: All new error paths return structured errors per Constitution
  Principle VI.

### Key Entities

- **Semantic Entity**: A row in `semantic_entity` identifying a stable engineering
  concept. Keyed by `semantic://<product>/<slug>`.
- **Semantic Mapping**: A row in `semantic_mapping` binding an entity to geometry
  at a particular revision. Multiple rows per entity form its lineage.
- **Topology Revision**: A row in `topology_revision` representing one committed
  geometry state. Increments per commit.
- **Transaction Branch**: A Dolt branch `txn/<transaction_id>` representing
  the working state of one open transaction.

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: Running the full scenario in
  [WorkedExample-LeftBaseAirflow.md](../../SemanticCad/WorkedExample-LeftBaseAirflow.md)
  end-to-end on `braai.step` produces identical resolutions for all three
  identifiers (`outer_panel_left`, `firebox_panel_left`, `left_base_airflow`)
  before and after `split_body_by_bends` — same semantic ids, different
  underlying face IDs after commit.
- **SC-002**: A `semantic_lineage` call after the scenario returns exactly two
  rows for `firebox_panel_left`, both linked to `transaction.label` values that
  match the labels supplied at `begin_transaction` time.
- **SC-003**: `resolve_geometry({semantic_id, at_revision: 1})` on
  `firebox_panel_left` after the scenario returns the original three face IDs
  (verifying time travel).
- **SC-004**: `commit_transaction` end-to-end timing on the scenario's
  one-`split_body_by_bends` transaction completes in under 1 second, including
  Dolt merge.
- **SC-005**: All existing integration tests from `004-transaction-primitive`
  continue to pass.
- **SC-006**: Rolling back a transaction containing semantic operations leaves the
  Dolt `main` branch unchanged (no leaked rows from the dropped branch).

---

## Assumptions

- One Dolt database per product, named `semantic_<product>`. Phase 1 deals with
  exactly one product (`braai`).
- Single-session, single-writer. No multi-session contention model; the second
  caller to `begin_transaction` while another is active hits
  `TRANSACTION_ALREADY_ACTIVE` from
  [`004`](../004-transaction-primitive/spec.md).
- Dolt runs locally as `dolt sql-server` on `127.0.0.1` (default). Embedded mode
  and remote-server configurations are deferred.
- The `mysql2` npm package (driver) is added as a dependency.
- ULIDs for `transaction_id` continue to come from the existing `ulid` package
  introduced in [`004`](../004-transaction-primitive/spec.md).
- BREP / OCCT geometry remains in memory + on disk exactly as today. Dolt holds
  only the references (path + sha256).
- Per [WorkedExample-LeftBaseAirflow.md §11](../../SemanticCad/WorkedExample-LeftBaseAirflow.md),
  inference and thermal/structural analysis remain out of scope. The entity
  vocabulary lock in FR-013/FR-014 enforces this.
- A failed Dolt merge during `commit_transaction` is treated as a hard error
  (`PERSISTENCE_COMMIT_FAILED`); rollback the geometry snapshot, drop the
  transaction branch, surface the error. Conflict resolution within Dolt is
  not needed because the session is single-writer.
