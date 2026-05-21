# Semantic CAD MCP Specification

# Part 0 — MVP Scope and Phased Plan

> This document defines what ships first. Parts 1–4 (Solution, DDD, Interface, MCP, Transaction)
> describe the long-term concept. Anything in those documents that is not referenced here is
> **concept-only** for the MVP and must not be implemented until a later phase is opened.

---

# 1. Purpose

The conceptual proposal in Parts 1–4 spans semantic inference, multi-domain analysis
(thermal/structural/airflow), an event bus, and ~40 candidate MCP tools. None of that is
buildable as a single increment.

This document narrows the proposal to two concrete phases, grounded in:

* the existing snapshot/rollback primitive at [cpp/src/geometry/snapshot.hpp](../cpp/src/geometry/snapshot.hpp)
* the current MCP tool surface in [ts/src/mcp/tools.ts](../ts/src/mcp/tools.ts)
* Constitution Principles IV (rollback-first) and VI (structured errors) in
  [.specify/memory/constitution.md](../.specify/memory/constitution.md)
* the BBQ fixture [cpp/tests/fixtures/braai.step](../cpp/tests/fixtures/braai.step) for end-to-end
  worked examples

The semantic capabilities are added **on top of** the existing sheet-metal tools, not as a
replacement.

---

# 2. MVP Boundary

## 2.1 In scope

* **Phase 0** — Transaction primitive (wraps existing `SnapshotId`)
* **Phase 1** — User-declared semantic identities + Mapping Layer with topology remap on commit
* **Persistence** — Dolt (MySQL-wire). See [Persistence-Dolt.md](Persistence-Dolt.md).
* **One worked end-to-end example** — Left-base airflow on `braai.step`. See
  [WorkedExample-LeftBaseAirflow.md](WorkedExample-LeftBaseAirflow.md).

## 2.2 Explicitly deferred (concept-only)

| Concept                                           | Document                                                       | Why deferred                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Inference Engine (`infer_semantics`)              | [MCPDefinition.md §7.2](MCPDefinition.md)                      | Hardest part of the system; no ground truth yet. User-declared entities for MVP. |
| Multi-domain analyses (thermal, structural, etc.) | [MCPDefinition.md §11](MCPDefinition.md)                       | Only manufacturability has a solver in this repo. The others are aspirational.   |
| Probabilistic confidence/evidence scoring         | [DDD Design.md §5.4](DDD%20Design.md)                          | Useful only once inference exists. All MVP entities are user-confirmed.          |
| Semantic merge/split tools                        | [MCPDefinition.md §12](MCPDefinition.md)                       | No real use case until multi-product graphs exist.                               |
| Event bus / push events                           | [DDD InterfaceDesign.md §11](DDD%20InterfaceDesign.md)         | MCP has no native push channel. MVP exposes state via polled query tools.        |
| Multi-product semantic graphs                     | [MCPDefinition.md §5.1](MCPDefinition.md)                      | Constitution Principle VII restricts MVP to single-session, single-product.      |
| Cross-product entity reuse                        | n/a                                                            | Naming/registration not designed. Out of scope.                                  |
| Feature primitives (`create_primitive`, etc.)     | [TransactionBCMCP.md §2](TransactionBCMCP.md)                  | This project consumes imported STEP geometry; no need to author primitives.      |

---

# 3. Tool Surface Reconciliation

Parts 3 and 4 propose two parallel tool surfaces (`*_modification` in MCPDefinition and
`*_transaction` in TransactionBCMCP) that overlap. For the MVP, **TransactionBCMCP is the
canonical layer** because it maps directly onto OCCT operations and the existing snapshot
registry. The `*_modification` variants are deferred convenience workflows that, when shipped,
will compose the transaction primitives.

## 3.1 MVP tool surface

| Tool                      | Source doc                                                | Status        | Notes                                                                                   |
| ------------------------- | --------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `begin_transaction`       | [TransactionBCMCP §1](TransactionBCMCP.md)                | **MVP**       | Thin facade over `SnapshotRegistry::createSnapshot`; opens a Dolt branch                |
| `commit_transaction`      | [TransactionBCMCP §1](TransactionBCMCP.md)                | **MVP**       | Drops the pre-snapshot; merges Dolt branch into `main`                                  |
| `rollback_transaction`    | [TransactionBCMCP §1](TransactionBCMCP.md)                | **MVP**       | Calls `SnapshotRegistry::restoreSnapshot`; drops Dolt branch                            |
| `declare_semantic_entity` | new (this doc)                                            | **MVP**       | User-authored; replaces `infer_semantics` for MVP                                       |
| `bind_semantic_entity`    | new (this doc)                                            | **MVP**       | Attaches a semantic ID to face groups or a spatial region                               |
| `resolve_geometry`        | [TransactionBCMCP §7](TransactionBCMCP.md)                | **MVP**       | Returns the current geometry bindings for a semantic ID                                 |
| `semantic_lineage`        | new (this doc)                                            | **MVP**       | Returns binding history across topology revisions (Dolt `AS OF`)                        |
| `capture_shape_history`   | [TransactionBCMCP §7](TransactionBCMCP.md)                | **MVP-internal** | Called automatically inside every mutating tool; not exposed as MCP                  |
| `remap_semantic_bindings` | [TransactionBCMCP §7](TransactionBCMCP.md)                | **MVP-internal** | Called automatically inside `commit_transaction`; not exposed as MCP                 |
| All existing MCP tools    | [ts/src/mcp/tools.ts](../ts/src/mcp/tools.ts)             | **unchanged** | `clean_geometry`, `split_body_by_bends`, etc. operate inside an active transaction      |
| `propose_modification`    | [MCPDefinition §10.1](MCPDefinition.md)                   | concept       | Deferred; would compose `begin_transaction` + stage + preview                           |
| `infer_semantics`         | [MCPDefinition §7.2](MCPDefinition.md)                    | concept       | Inference Engine deferred                                                               |
| `run_analysis` (thermal…) | [MCPDefinition §11](MCPDefinition.md)                     | concept       | Only manufacturability solver exists; surfaced via existing `evaluate_manufacturability`|

## 3.2 Manufacturing as a first-class semantic domain

The conceptual docs list manufacturability as one analysis among many. For this MVP it is
**the only** analysis domain and gets first-class semantic treatment:

* Manufacturing intent is a recognised semantic relationship type (`manufactured_as`,
  `joined_by`, `bent_along`).
* `evaluate_manufacturability` is the only `run_analysis`-like tool that ships.
* The semantic entity vocabulary for MVP is constrained to: `functional_system`,
  `panel`, `panel_group`, `joint_interface`, `spatial_region`.

---

# 4. Architecture (MVP only)

```text
┌─────────────────────────────────────────────────────────┐
│                  MCP Protocol Layer (TS)                │
│  begin_transaction / commit_transaction / rollback      │
│  declare_semantic / bind_semantic / resolve_geometry    │
│  + all existing sheet-metal tools (unchanged surface)   │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────────────────┐
        ▼            ▼                        ▼
┌──────────────┐  ┌─────────────────┐  ┌────────────────────┐
│ Semantic     │  │  Mapping Layer  │  │   Geometry Core    │
│  Store       │  │   (TS)          │  │   (C++/OCCT)       │
│  (Dolt)      │  │                 │  │                    │
│              │  │  face-group &   │  │  SnapshotRegistry  │
│  entities    │  │  spatial-region │  │  (extant)          │
│  bindings    │  │  bindings,      │  │                    │
│  revisions   │  │  OCCT history   │  │  BREP / STEP       │
│              │  │  consumer       │  │  files (extant)    │
└──────────────┘  └─────────────────┘  └────────────────────┘
```

What changes vs. today:

1. **C++ Geometry Service** — every mutating call captures OCCT shape history
   (`Modified` / `Generated` / `IsDeleted`) and returns it alongside the existing
   `rollbackToken`. Today's tools throw the history away.
2. **TS Mapping Layer** — new module. Consumes the captured history to update
   face-group bindings. Stores results in Dolt.
3. **TS Semantic Store** — new module backed by Dolt. CRUD for semantic entities,
   relationships, and bindings.
4. **MCP dispatch** — every existing mutating tool is wrapped to require an active
   `transaction_id` (the snapshot lifecycle moves from per-tool implicit to
   per-transaction explicit).

What does not change:

* The C++/TS split and the bounded contexts named in Constitution Principle II.
* The existing tool surface (`clean_geometry`, `decompose_volume`, `synthesize_joints`,
  `split_body_by_bends`, etc.) keeps its inputs and outputs.
* BREP/STEP files remain the authoritative geometry store. Dolt does **not** store mesh
  data — only references.

---

# 5. Phase 0 — Transaction Primitive

**Duration target**: 1–2 weeks. **Acceptance**: existing test suite green; new tests
cover the three new tools.

## 5.1 Deliverables

* `begin_transaction(label, [product]) → { transaction_id, base_geometry_revision }`
* `commit_transaction(transaction_id) → { geometry_revision, status: "committed" }`
* `rollback_transaction(transaction_id) → { status: "rolled_back" }`
* Capture of OCCT `Modified` / `Generated` / `IsDeleted` in every mutating C++ entry
  point. Result stored as a per-transaction `ShapeHistory` map in memory; not yet
  consumed.
* `transaction_id` field added to every mutating tool's input schema (optional in
  Phase 0, **required** in Phase 1).

## 5.2 Non-deliverables

* No semantic entities yet.
* No Dolt — Phase 0 keeps state in memory (matches Constitution D3-A).
* No staged-operation queue. `stage_operation` from
  [TransactionBCMCP §1](TransactionBCMCP.md) is deferred; for MVP, calling an existing
  mutating tool while a transaction is open is the staging mechanism.

## 5.3 Mapping onto existing primitives

```text
begin_transaction(label)
   → SnapshotRegistry::createSnapshot(label)
   → returns SnapshotId rebadged as transaction_id

[any mutating tool, e.g. split_body_by_bends]
   → executes against working state
   → C++ captures shape history; TS stores it under transaction_id

commit_transaction(transaction_id)
   → SnapshotRegistry::clearSnapshots()  (the pre-snapshot becomes garbage)
   → keeps the captured ShapeHistory chain for lineage queries

rollback_transaction(transaction_id)
   → SnapshotRegistry::restoreSnapshot(transaction_id)
   → discards the captured ShapeHistory
```

This is a pure additive change to [cpp/src/geometry/snapshot.hpp](../cpp/src/geometry/snapshot.hpp) —
no breaking changes to the snapshot interface.

---

# 6. Phase 1 — Semantic Identity + Mapping Layer

**Duration target**: 3–4 weeks. **Acceptance**: the worked example in
[WorkedExample-LeftBaseAirflow.md](WorkedExample-LeftBaseAirflow.md) runs end-to-end and the
three semantic identities survive `split_body_by_bends`.

## 6.1 Deliverables

* Dolt store with schema in [Persistence-Dolt.md §3](Persistence-Dolt.md).
* `declare_semantic_entity({id, type, purpose?, relationships?}) → { id, revision }`
* `bind_semantic_entity({semantic_id, binding}) → { mapping_id, revision }` where
  `binding` is one of:
    * `{ kind: "face_group", face_ids: [...] }`
    * `{ kind: "spatial_region", between: [semantic_id_a, semantic_id_b] }`
    * `{ kind: "body", body_id: "..." }`
* `resolve_geometry({semantic_id, at_revision?}) → { bindings, topology_revision }`
* `semantic_lineage({semantic_id}) → [{revision, bindings, transaction_id, label}]`
* Mapping Layer remap on commit:
    1. Read the captured `ShapeHistory` for the transaction.
    2. For each affected face-group binding, apply `Modified`/`Generated`/`IsDeleted`
       to produce the new face ID set.
    3. For each spatial-region binding, recompute the region from the new bindings of
       its constituent entities.
    4. Persist new bindings as a new revision in Dolt.

## 6.2 Vocabulary lock for MVP

Only these semantic entity types are accepted by `declare_semantic_entity`:

| Type                  | Bindable to                                | Example                                          |
| --------------------- | ------------------------------------------ | ------------------------------------------------ |
| `panel`               | `face_group`, `body`                       | `semantic://braai/firebox_panel_left`            |
| `panel_group`         | aggregation of `panel` entities            | `semantic://braai/outer_skin`                    |
| `joint_interface`     | `face_group` spanning two panels           | `semantic://braai/joint_outer_to_firebox_left`   |
| `functional_system`   | `spatial_region` or aggregation            | `semantic://braai/left_base_airflow`             |
| `spatial_region`      | `between` two `panel` entities             | (typically embedded in a `functional_system`)    |

Only these relationship types are accepted:

`contains`, `bounded_by`, `connected_to`, `manufactured_as`, `joined_by`, `bent_along`.

`influences`, `constrained_by`, `conflicts_with`, `supports`, `implemented_by`, and
`depends_on` from [DDD Design.md §5.6](DDD%20Design.md) are deferred.

## 6.3 Identity URI scheme (MVP rules)

```text
semantic://<product>/<entity_slug>
```

* `<product>` is a kebab-case slug fixed at `begin_transaction` time. For MVP, one
  product per session (matches Constitution Principle VII).
* `<entity_slug>` is user-supplied at `declare_semantic_entity` time. Must match
  `^[a-z][a-z0-9_]*$`.
* Identities are append-only. Renaming requires `declare_semantic_entity` of a new
  ID and a relationship `supersedes` (Phase 2; not in MVP).
* The store rejects duplicate `<product>/<entity_slug>` declarations.

---

# 7. Constitution Alignment

| Principle                     | MVP impact                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. Deterministic geometry     | Unchanged. All semantic operations are deterministic given the same OCCT shape history.                                                                     |
| II. Bounded contexts          | Adds a **Semantic Mapping** context (TS) and **Semantic Store** (Dolt). No leakage of OCCT primitives into either; the Mapping Layer consumes shape history through a typed port. |
| III. Safety filter            | Unchanged. `fire_rated` checks still occur at the MCP Protocol Layer.                                                                                       |
| IV. Rollback-first            | Strengthened. The transaction primitive makes rollback explicit at the protocol level. `commit_transaction` is required to make a mutation permanent.       |
| V. Kerf compensation          | Unchanged.                                                                                                                                                  |
| VI. Structured errors         | Extended. New error codes: `TRANSACTION_NOT_FOUND`, `TRANSACTION_NOT_ACTIVE`, `SEMANTIC_ID_EXISTS`, `SEMANTIC_ID_NOT_FOUND`, `BINDING_REMAP_FAILED`.         |
| VII. MVP scope discipline     | Honoured. The conceptual material in Parts 1–4 is bracketed by §2.2 above.                                                                                  |
| VIII. Configuration           | Persistence target (Dolt host / database name) added to config schema.                                                                                      |
| IX. Async export              | Unchanged.                                                                                                                                                  |

The state-persistence resolution in the Constitution tech-stack table
(`D3-A: In-memory, session-scoped only`, sourced from
[Engineering-Design.md §1](../Engineering-Design.md)) is **amended for Phase 1** — Dolt is
introduced as the session-spanning store for semantic state. Geometry state remains
session-scoped in memory plus BREP files. The amendment is filed at
[.specify/memory/amendments/v1.2-semantic-persistence.md](../.specify/memory/amendments/v1.2-semantic-persistence.md)
per Constitution §Governance and must be ratified before Phase 1 begins.

---

# 8. Acceptance Criteria

Phase 0 ships when:

1. `begin_transaction` / `commit_transaction` / `rollback_transaction` are present in
   [ts/src/mcp/tools.ts](../ts/src/mcp/tools.ts) and tested.
2. Every existing mutating tool accepts an optional `transaction_id`.
3. C++ shape history is captured on every mutation and round-trips through the N-API
   binding.
4. Existing integration tests still pass without source changes.

Phase 1 ships when the worked example in
[WorkedExample-LeftBaseAirflow.md](WorkedExample-LeftBaseAirflow.md) executes against
`braai.step` and the three semantic identities
(`semantic://braai/firebox_panel_left`, `semantic://braai/outer_panel_left`,
`semantic://braai/left_base_airflow`) all resolve to non-empty, semantically correct
geometry bindings after `split_body_by_bends` is committed.

---

# 9. What This Document Replaces

This MVP doc **does not replace** Parts 1–4. They remain the long-term vision. It
**does** override them on:

* In-scope tool set (this doc §3)
* Persistence mechanism (this doc §6 → [Persistence-Dolt.md](Persistence-Dolt.md))
* Semantic vocabulary (this doc §6.2)
* Identity URI rules (this doc §6.3)
* Inference scope (none, for MVP)
* Analysis scope (manufacturability only, for MVP)

Anything in Parts 1–4 that contradicts the above is deferred to a later phase.
