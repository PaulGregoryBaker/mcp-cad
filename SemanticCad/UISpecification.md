# Semantic CAD MCP Specification

# UI Specification — Transaction & Semantic Layer Impact

> **Audience.** This document is written for the UI application team. It describes
> what is changing in the MCP server and what the UI must do differently to
> accommodate those changes. For the server-side specification, see
> [MVP.md](MVP.md), [TransactionBCMCP.md](TransactionBCMCP.md), and
> [WorkedExample-LeftBaseAirflow.md](WorkedExample-LeftBaseAirflow.md).
>
> Two phases are covered. **Phase 0** (Transaction Primitive) ships first and is a
> prerequisite for **Phase 1** (Semantic Layer). Nothing in Phase 1 is required before
> Phase 0 acceptance criteria are met.

---

# 1. Why Things Are Changing

## 1.1 The Problem With the Current Model

Today, every geometry tool (`split_body_by_bends`, `clean_geometry`,
`decompose_volume`, etc.) is a stateless call with an implicit, per-tool rollback
token baked into its response. From the UI's perspective, each tool either succeeds
or fails on its own, and "undo" means calling the rollback token from that one tool
call.

This model breaks down as the system grows in three specific ways:

**No grouped undo.** There is no way to treat several geometry operations as a single
undoable unit. If a workflow involves `clean_geometry` followed by
`split_body_by_bends` followed by `synthesize_joints`, the user cannot roll back all
three as one action.

**Topology is volatile.** Face IDs (`face://shell/firebox_left/face/5`) change every
time a mutation runs. Nothing in the system today can answer "which geometry represents
the airflow region *now*?" after faces have been reshuffled. The UI must re-derive
region identity from scratch after every operation.

**No persistent naming.** There is no way to give a region of engineering intent a
stable name that survives across sessions or geometry mutations. The "left-base airflow
gap" has no persistent identity — it is a pattern the user re-establishes manually each
time.

## 1.2 What Is Being Added

**Phase 0 — Transaction Primitive.** All geometry mutations are now grouped into an
explicit, named transaction: `begin_transaction → [mutations] → commit` or `rollback`.
The implicit per-tool snapshot lifecycle is promoted to a first-class, user-visible
concept at the protocol level.

**Phase 1 — Semantic Layer.** Users can declare stable, named engineering entities
(`semantic://braai/left_base_airflow`) and bind them to geometry. When a commit changes
topology, the server automatically remaps those bindings — the semantic name survives
the mutation. A lineage history records exactly how and why each binding changed.

**The key consequence for the UI:**

* The session now has explicit transaction state that must be managed and displayed.
* Geometry regions can now have persistent identities that the user authors and the
  server maintains across topology mutations.

---

# 2. What Does Not Change

The following are unchanged and require no UI modification beyond threading
`transaction_id` through existing call sites:

* The input/output signatures of `clean_geometry`, `split_body_by_bends`,
  `decompose_volume`, `synthesize_joints`, and `evaluate_manufacturability`.
* BREP/STEP files remain the geometry store. The semantic layer stores references to
  geometry, not geometry data.
* The single-session, single-product constraint. Multi-product semantic graphs are
  deferred to a later phase.
* The `evaluate_manufacturability` surface. It is the only analysis tool for MVP and
  its interface is unchanged.

---

# 3. Phase 0 — Transaction Primitive

## 3.1 New MCP Tools

### `begin_transaction`

Opens an isolated working state for the session.

**Input:**
```json
{
  "product": "braai",
  "label": "Split firebox panels"
}
```

**Output:**
```json
{
  "transaction_id": "transaction://01HZ...",
  "base_geometry_revision": 1,
  "status": "active"
}
```

### `commit_transaction`

Permanently applies all mutations made since `begin_transaction`.

**Input:**
```json
{ "transaction_id": "transaction://01HZ..." }
```

**Output:**
```json
{
  "geometry_revision": 2,
  "semantic_revision": 4,
  "mapping_revision": 2,
  "status": "committed"
}
```

### `rollback_transaction`

Discards all mutations and restores geometry to the state at `begin_transaction`.

**Input:**
```json
{ "transaction_id": "transaction://01HZ..." }
```

**Output:**
```json
{ "status": "rolled_back" }
```

### Changed: all mutating tools now accept `transaction_id`

Every existing mutating tool (`split_body_by_bends`, `clean_geometry`, etc.) gains a
`transaction_id` field. This field is **optional in Phase 0** and **required in Phase
1**. The UI must thread the active `transaction_id` through all mutating calls.

## 3.2 New Error Codes

| Code | When it occurs |
|---|---|
| `TRANSACTION_NOT_FOUND` | `commit` or `rollback` called with an unknown `transaction_id` |
| `TRANSACTION_NOT_ACTIVE` | A mutation attempted against an already-committed or rolled-back transaction |

In Phase 1, attempting a geometry mutation without an active transaction will be
rejected at the server. The UI should gate all mutating controls behind "transaction
is open" state.

## 3.3 UX Requirements

### Session startup

Before any geometry mutation, the UI must call `begin_transaction` and store the
returned `transaction_id` for the duration of the work session. The `label` should be
human-readable and describe the intended change (e.g. "Split firebox panels",
"Declare airflow system"). Consider prompting the user for a label or deriving one
from the first operation they trigger.

### Transaction state indicator

The UI must display that a transaction is active. The user needs to know they are in
a staged working state — changes are not permanent until committed. Suggested
treatments: a persistent status bar or header showing the transaction label and its
active state; visual differentiation of the viewport when uncommitted changes are
present.

### Commit and rollback controls

The UI must surface explicit **Commit** and **Rollback** actions. These replace the
implicit per-tool undo token. The scope of each must be communicated clearly:

* **Commit** makes all mutations since `begin_transaction` permanent.
* **Rollback** undoes *everything* since `begin_transaction`, not just the last step.

This is a significant UX distinction from a single-step undo. If the user has run
three geometry operations, rollback discards all three. The UI should reflect this
scope — for example: *"Roll back all changes to 'Split firebox panels'?"* rather than
*"Undo last action."*

### Geometry refresh after commit

After `commit_transaction`, the `geometry_revision` in the response is the new
canonical version of the model. The UI should use this revision number when
displaying geometry state and store it as the current baseline for the next
transaction.

---

# 4. Phase 1 — Semantic Layer

## 4.1 New MCP Tools

### `declare_semantic_entity`

Creates a named, stable engineering entity. The ID is permanent; renaming is not
supported in MVP.

**Input:**
```json
{
  "id": "semantic://braai/firebox_panel_left",
  "type": "panel",
  "purpose": ["thermal_containment"],
  "relationships": []
}
```

**Output:**
```json
{ "id": "semantic://braai/firebox_panel_left", "revision": 1 }
```

### `bind_semantic_entity`

Attaches a semantic entity to geometry. Three binding kinds are supported:

```json
{ "kind": "face_group", "face_ids": ["face://shell/firebox_left/face/5", "..."] }
```
```json
{ "kind": "body", "body_id": "body://braai/outer_shell" }
```
```json
{ "kind": "spatial_region", "between": ["semantic://braai/outer_panel_left", "semantic://braai/firebox_panel_left"] }
```

A spatial-region binding is a *rule*, not an enumerated face list. The server derives
and materialises the geometry lazily from the bindings of the referenced entities.

**Output:**
```json
{ "mapping_id": "...", "revision": 2 }
```

### `resolve_geometry`

Returns the current geometry bindings for a semantic entity. This is the call to make
after any commit to refresh what geometry a semantic entity covers.

**Input:**
```json
{ "semantic_id": "semantic://braai/left_base_airflow", "at_revision": null }
```

**Output:**
```json
{
  "semantic_id": "semantic://braai/left_base_airflow",
  "topology_revision": 2,
  "bindings": [
    {
      "kind": "spatial_region",
      "materialised_face_ids": [
        "face://shell/outer_left/face/0",
        "face://shell/firebox_left/panel/1/face/0"
      ]
    }
  ]
}
```

### `semantic_lineage`

Returns the binding history for a semantic entity across all topology revisions,
including the reason each binding changed.

**Input:**
```json
{ "semantic_id": "semantic://braai/firebox_panel_left" }
```

**Output:**
```json
[
  {
    "semantic_revision": 2,
    "transaction_id": "transaction://01HY...",
    "label": "Declare left-base airflow system",
    "binding": { "kind": "face_group", "face_ids": ["face://shell/firebox_left/face/5", "..."] },
    "remap_reason": null
  },
  {
    "semantic_revision": 4,
    "transaction_id": "transaction://01HZ...",
    "label": "Declare left-base airflow system",
    "binding": { "kind": "face_group", "face_ids": ["face://shell/firebox_left/panel/1/face/0", "..."] },
    "remap_reason": "split_body_by_bends → OCCT Modified()"
  }
]
```

## 4.2 New Error Codes (Phase 1 additions)

| Code | When it occurs |
|---|---|
| `SEMANTIC_ID_EXISTS` | `declare_semantic_entity` called with an ID already in the store |
| `SEMANTIC_ID_NOT_FOUND` | `bind_semantic_entity` or `resolve_geometry` references an unknown semantic ID |
| `BINDING_REMAP_FAILED` | Commit-time remap could not map an old face ID to any new face; binding is broken |

## 4.3 Semantic Entity Vocabulary (MVP)

Only the following entity types are accepted by `declare_semantic_entity`:

| Type | Bindable to | Example |
|---|---|---|
| `panel` | `face_group`, `body` | `semantic://braai/firebox_panel_left` |
| `panel_group` | aggregation of `panel` entities | `semantic://braai/outer_skin` |
| `joint_interface` | `face_group` spanning two panels | `semantic://braai/joint_outer_to_firebox_left` |
| `functional_system` | `spatial_region` or aggregation | `semantic://braai/left_base_airflow` |
| `spatial_region` | `between` two `panel` entities | (typically embedded in a `functional_system`) |

Only the following relationship types are accepted:

`contains`, `bounded_by`, `connected_to`, `manufactured_as`, `joined_by`, `bent_along`

## 4.4 Semantic Identity Format

```
semantic://<product>/<entity_slug>
```

* `<product>` is fixed at `begin_transaction` time (e.g. `braai`).
* `<entity_slug>` is user-supplied and must match `^[a-z][a-z0-9_]*$`.
* IDs are append-only. The server rejects duplicate declarations.
* Renaming is not supported in MVP.

## 4.5 UX Requirements

### Semantic entity authoring workflow

The UI needs a workflow that allows a user to name a region:

1. User selects one or more faces in the viewport.
2. UI prompts for a semantic ID (slug), entity type, and optional purpose.
3. UI calls `declare_semantic_entity` then `bind_semantic_entity` within the active
   transaction.
4. The named region is now displayed with its semantic label instead of raw face IDs.

This workflow must be inside an open transaction. If no transaction is active, the UI
must prompt the user to start one.

### Spatial region authoring

A spatial region is defined between two existing semantic entities, not as a face
selection. The UI must provide a separate authoring path for this binding kind:

1. User selects two already-declared semantic entities (e.g. two panels).
2. UI calls `declare_semantic_entity` (type `functional_system` or `spatial_region`)
   then `bind_semantic_entity` with `kind: "spatial_region"` and `between: [id_a, id_b]`.
3. The UI displays the region as "the gap between [entity A] and [entity B]" — not as
   an enumerated face list.

### Semantic-first display

Where a geometry region has a semantic binding, the UI should prefer the semantic
label over the raw face ID in all user-facing text. The full face ID list should be
accessible on demand (e.g. in a detail panel) but must not be the primary label.

Raw face IDs should be treated as volatile. A face ID that is valid at revision 1 may
not exist at revision 2. UI state that persists a face ID across a commit will silently
point to stale or non-existent geometry.

### Geometry refresh after commit

After `commit_transaction`, the server has automatically remapped all face-group
bindings and re-resolved all spatial-region bindings. The UI must call `resolve_geometry`
for each known semantic entity to refresh its displayed geometry. The semantic IDs are
stable; the face IDs underneath them may have changed.

### Binding history / lineage panel

A dedicated panel or view should surface the `semantic_lineage` response for a
selected entity. Required display elements:

* Semantic ID and type.
* Each revision in chronological order: revision number, transaction label, binding
  snapshot, and `remap_reason` (null for original bindings; e.g.
  `split_body_by_bends → OCCT Modified()` for topology-driven remaps).
* A link or navigation action to the transaction that produced each revision.

This is the primary explainability surface for users who want to understand why a
region's geometry changed.

### Handling `BINDING_REMAP_FAILED`

If commit returns a `BINDING_REMAP_FAILED` error, one or more semantic entities lost
their geometry bindings because the faces they were bound to were deleted by the
geometry operation with no mapped successors. The UI must:

1. Surface which semantic entities are affected (by name, not face ID).
2. Prevent the commit from proceeding silently.
3. Offer the user a choice: roll back the transaction, or manually re-bind the
   affected entities before re-attempting the commit.

---

# 5. Updated Session Flow

The following is the canonical happy path after Phase 1 is in place. Phase 0
follows the same flow but without the semantic declaration steps.

```
Session starts
  → UI calls begin_transaction({ product, label })
  → UI stores transaction_id; shows active transaction indicator

User runs geometry operations
  → UI passes transaction_id in every mutating tool call
  → Server executes operations, captures OCCT shape history internally

User declares and binds semantic entities (Phase 1)
  → UI calls declare_semantic_entity + bind_semantic_entity
  → UI displays semantic labels in viewport

User is satisfied with the changes
  → UI calls commit_transaction(transaction_id)
  → Server remaps all semantic bindings automatically
  → UI calls resolve_geometry for each semantic entity
  → UI refreshes viewport with updated geometry; clears transaction indicator

Alternatively: user wants to discard all changes
  → UI calls rollback_transaction(transaction_id)
  → Server restores geometry to base_geometry_revision
  → UI refreshes viewport; clears transaction indicator
```

---

# 6. Open Questions for the UI Team

The following design decisions are not resolved in the server specification and will
need product/UX input:

1. **Transaction label UX.** Should the label be prompted explicitly, inferred from the
   first action, or generated automatically? The label appears in lineage history and
   is the primary human-readable description of what a transaction did.

2. **Rollback scope communication.** How should the UI communicate that rollback undoes
   *all* changes since `begin_transaction`, not just the last step? This is a
   meaningful departure from conventional undo behaviour.

3. **Face selection lifting.** When a user clicks a face in the viewport, should the
   UI immediately resolve it to its semantic entity (if one exists) and operate at the
   semantic level? Or should face-level selection remain available as an explicit mode?

4. **Broken binding handling.** `BINDING_REMAP_FAILED` requires a repair workflow. What
   does re-binding an entity look like, and should the UI block commit or allow a
   "commit with broken bindings" escape hatch?

5. **Lineage navigation.** The `at_revision` parameter on `resolve_geometry` allows the
   UI to show what geometry a semantic entity covered at any past revision. Is a
   "time travel" view in scope, and if so, at what fidelity?
