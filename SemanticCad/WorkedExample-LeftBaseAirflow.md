# Semantic CAD MCP Specification

# Worked Example — Left-Base Airflow Survives `split_body_by_bends`

> This document walks one MVP scenario end-to-end against the existing fixture
> [cpp/tests/fixtures/braai.step](../cpp/tests/fixtures/braai.step). It is the acceptance
> case for Phase 1 of [MVP.md](MVP.md).
>
> The point of the example is to demonstrate the **load-bearing claim** of the semantic
> layer: that a functional system defined by a relationship between two panels can
> survive a topology mutation of one of those panels without losing identity.

---

# 1. Scenario

The braai (BBQ) has two skins on its left side:

* an **outer panel** with aesthetic and user-safety requirements (low surface
  temperature, no sharp edges)
* an **inner firebox panel** that withstands combustion heat

The gap between them is a functional **airflow system** — convective air enters at the
base, rises between the skins, and exits near the lid. The airflow gap is not owned by
either panel; it exists as a spatial relationship between them.

We want:

1. To declare three semantic entities for this region.
2. To survive `split_body_by_bends` on the firebox panel (which mutates its topology
   from one shell into several panels) without breaking any of the three identities.
3. To prove identity survival via a lineage query that returns the binding before and
   after the mutation.

---

# 2. Geometry Baseline

After importing the fixture:

```text
clean_geometry({ file_path: ".../braai.step" })
→ { solid_ids: ["solid://braai_assembly"], shell_ids: [ ... ] }
```

Assume `clean_geometry` and a (currently manual) decomposition step have produced
two shell IDs for this discussion:

| Shell ID                          | Role                | Face count (illustrative) |
| --------------------------------- | ------------------- | ------------------------- |
| `shell://braai/outer_left`        | Outer skin, left    | 14                        |
| `shell://braai/firebox_left`      | Firebox skin, left  | 22                        |

The firebox shell is a thin-solid with three planar regions joined by two bends —
the candidate for `split_body_by_bends`.

---

# 3. Open a Transaction

```jsonc
// MCP call
begin_transaction({
  product: "braai",
  label: "declare left-base airflow system"
})
// → returns
{
  "transaction_id": "transaction://01HZ...",
  "base_geometry_revision": 1,
  "base_semantic_revision": 0,
  "status": "active"
}
```

Under the hood:

* `SnapshotRegistry::createSnapshot("declare left-base airflow system")` is called
  ([cpp/src/geometry/snapshot.hpp](../cpp/src/geometry/snapshot.hpp)).
* A new Dolt branch `txn/01HZ...` is checked out from `main`.

---

# 4. Declare the Three Semantic Entities

## 4.1 Outer panel

```jsonc
declare_semantic_entity({
  id: "semantic://braai/outer_panel_left",
  type: "panel",
  purpose: ["aesthetic", "user_safety"],
  manufactured_as: "sheet_metal"
})
```

## 4.2 Firebox panel

```jsonc
declare_semantic_entity({
  id: "semantic://braai/firebox_panel_left",
  type: "panel",
  purpose: ["thermal_containment"],
  manufactured_as: "sheet_metal"
})
```

## 4.3 Airflow system

```jsonc
declare_semantic_entity({
  id: "semantic://braai/left_base_airflow",
  type: "functional_system",
  purpose: ["combustion_air_supply", "outer_skin_cooling"],
  relationships: [
    {
      relationship: "bounded_by",
      target: "semantic://braai/outer_panel_left"
    },
    {
      relationship: "bounded_by",
      target: "semantic://braai/firebox_panel_left"
    }
  ]
})
```

After these three calls the **Semantic Store** in Dolt contains three rows in
`semantic_entity` and two rows in `semantic_relationship`, all on the transaction
branch. Nothing is bound to geometry yet.

---

# 5. Bind the Panels to Faces

For brevity we treat face IDs as opaque strings produced by the existing
`compute_intersections` / face indexing tools. Real face IDs in this project look like
`face://shell/firebox_left/face/3`.

## 5.1 Outer panel binding

```jsonc
bind_semantic_entity({
  semantic_id: "semantic://braai/outer_panel_left",
  binding: {
    kind: "face_group",
    face_ids: [
      "face://shell/outer_left/face/0",
      "face://shell/outer_left/face/1",
      "face://shell/outer_left/face/2",
      "face://shell/outer_left/face/3"
    ]
  }
})
```

## 5.2 Firebox panel binding (inner-facing faces only)

The "inner-facing" subset is the set of faces whose outward normal points *toward*
the outer panel — i.e. the faces that physically bound the airflow gap on the
firebox side.

```jsonc
bind_semantic_entity({
  semantic_id: "semantic://braai/firebox_panel_left",
  binding: {
    kind: "face_group",
    face_ids: [
      "face://shell/firebox_left/face/5",
      "face://shell/firebox_left/face/6",
      "face://shell/firebox_left/face/7"
    ]
  }
})
```

## 5.3 Airflow region binding

```jsonc
bind_semantic_entity({
  semantic_id: "semantic://braai/left_base_airflow",
  binding: {
    kind: "spatial_region",
    between: [
      "semantic://braai/outer_panel_left",
      "semantic://braai/firebox_panel_left"
    ]
  }
})
```

The Mapping Layer stores this as a **derived binding** — it does not enumerate face
IDs; it stores the rule "the spatial region between the bindings of those two
entities at this revision." Resolution materialises faces lazily.

---

# 6. The Mutation — `split_body_by_bends`

The user now decomposes the firebox shell into individual panels:

```jsonc
split_body_by_bends({
  transaction_id: "transaction://01HZ...",
  part_id: "shell://braai/firebox_left",
  max_thickness_mm: 5.0
})
// → returns
{
  "panel_ids": [
    "shell://braai/firebox_left/panel/0",   // bottom planar region
    "shell://braai/firebox_left/panel/1",   // vertical face (the airflow-facing one)
    "shell://braai/firebox_left/panel/2"    // upper return
  ],
  "protrusion_ids": [],
  "detected_mode": "thin_solid",
  "rollbackToken": "transaction://01HZ..."
}
```

This is the same call signature as today
([ts/src/mcp/tools.ts:381](../ts/src/mcp/tools.ts#L381)), with one addition: it
accepts the `transaction_id` and emits OCCT shape history to the per-transaction
`ShapeHistory` table.

## 6.1 OCCT shape history produced

After the cut, OCCT's `Modified` / `Generated` / `IsDeleted` queries yield (using
schematic IDs):

| Original face                              | OCCT verdict | New face(s)                                                                                                          |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `face://shell/firebox_left/face/5`         | Modified     | `face://shell/firebox_left/panel/0/face/0`                                                                           |
| `face://shell/firebox_left/face/6`         | Modified     | `face://shell/firebox_left/panel/1/face/0`                                                                           |
| `face://shell/firebox_left/face/7`         | Modified     | `face://shell/firebox_left/panel/2/face/0`                                                                           |
| (bend region 5→6)                          | Generated    | `face://shell/firebox_left/panel/0/face/3`, `face://shell/firebox_left/panel/1/face/3` (the new flange ends)         |
| (bend region 6→7)                          | Generated    | `face://shell/firebox_left/panel/1/face/4`, `face://shell/firebox_left/panel/2/face/3`                               |

This is the data the Mapping Layer needs and which today's pipeline throws away.

---

# 7. Commit the Transaction

```jsonc
commit_transaction({ transaction_id: "transaction://01HZ..." })
```

The commit pipeline runs, in this order:

## 7.1 Remap face-group bindings

For `semantic://braai/firebox_panel_left`, the Mapping Layer applies the history
table from §6.1 to the three previously-bound face IDs:

```text
Old binding:
  face/5, face/6, face/7

After Modified() lookup:
  panel/0/face/0, panel/1/face/0, panel/2/face/0
```

The new binding for `semantic://braai/firebox_panel_left` is the union of those
three new IDs. The semantic ID is unchanged.

For `semantic://braai/outer_panel_left`, no history entries apply (its faces were
not touched). Its binding is carried forward unchanged into the new revision.

## 7.2 Remap derived bindings

`semantic://braai/left_base_airflow` is a `spatial_region` binding with rule
`between(outer_panel_left, firebox_panel_left)`. The Mapping Layer re-resolves the
rule against the new bindings of the two referenced entities. The spatial region is
recomputed (slightly different shape — three sub-faces on the firebox side now
instead of three top-level faces — but it is the same gap).

## 7.3 Promote to main

* The Dolt branch `txn/01HZ...` is merged into `main` (fast-forward, since this
  session is single-writer per Constitution Principle VII).
* The pre-snapshot in `SnapshotRegistry` is discarded.
* A row is added to `topology_revision` recording the OCCT shape-history map for
  this transaction.

The MCP return value:

```jsonc
{
  "transaction_id": "transaction://01HZ...",
  "geometry_revision": 2,
  "semantic_revision": 4,
  "mapping_revision": 2,
  "status": "committed"
}
```

---

# 8. Identity Survival — The Test That Proves It

After commit, the AI agent (or any client) issues:

```jsonc
resolve_geometry({
  semantic_id: "semantic://braai/firebox_panel_left"
})
// → returns
{
  "semantic_id": "semantic://braai/firebox_panel_left",
  "topology_revision": 2,
  "bindings": [
    {
      "kind": "face_group",
      "face_ids": [
        "face://shell/firebox_left/panel/0/face/0",
        "face://shell/firebox_left/panel/1/face/0",
        "face://shell/firebox_left/panel/2/face/0"
      ]
    }
  ]
}
```

```jsonc
resolve_geometry({
  semantic_id: "semantic://braai/left_base_airflow"
})
// → returns
{
  "semantic_id": "semantic://braai/left_base_airflow",
  "topology_revision": 2,
  "bindings": [
    {
      "kind": "spatial_region",
      "materialised_face_ids": [
        // outer side
        "face://shell/outer_left/face/0",
        "face://shell/outer_left/face/1",
        "face://shell/outer_left/face/2",
        "face://shell/outer_left/face/3",
        // firebox side (now three panels)
        "face://shell/firebox_left/panel/0/face/0",
        "face://shell/firebox_left/panel/1/face/0",
        "face://shell/firebox_left/panel/2/face/0"
      ]
    }
  ]
}
```

The semantic identifier `semantic://braai/left_base_airflow` is the same string the
agent used **before** the mutation. The agent did not have to track topology
revision numbers or face IDs across the operation. This is the property the entire
proposal exists to deliver.

---

# 9. Lineage Query

The agent asks: "what changed for this entity between revisions 1 and 2?"

```jsonc
semantic_lineage({
  semantic_id: "semantic://braai/firebox_panel_left"
})
// → returns
[
  {
    "semantic_revision": 2,
    "transaction_id": "transaction://01HY...",  // the initial bind in §5.2
    "label": "declare left-base airflow system",
    "binding": {
      "kind": "face_group",
      "face_ids": ["face://shell/firebox_left/face/5",
                    "face://shell/firebox_left/face/6",
                    "face://shell/firebox_left/face/7"]
    }
  },
  {
    "semantic_revision": 4,
    "transaction_id": "transaction://01HZ...",  // the split commit
    "label": "declare left-base airflow system",
    "binding": {
      "kind": "face_group",
      "face_ids": ["face://shell/firebox_left/panel/0/face/0",
                    "face://shell/firebox_left/panel/1/face/0",
                    "face://shell/firebox_left/panel/2/face/0"]
    },
    "remap_reason": "split_body_by_bends → OCCT Modified()"
  }
]
```

The `remap_reason` field is the link between the OCCT shape history captured in
§6.1 and the user-visible explanation — the foundation of the conceptual
"explainability" goal from [DDD Design.md §13](DDD%20Design.md), shipped here with
zero AI inference.

Under the hood this is a Dolt query (see [Persistence-Dolt.md §5](Persistence-Dolt.md)):

```sql
SELECT
    sm.revision_id,
    t.label,
    t.id        AS transaction_id,
    sm.binding_json,
    sm.remap_reason
FROM   semantic_mapping AS OF '<head>' sm
JOIN   transaction t ON t.id = sm.created_in_transaction
WHERE  sm.semantic_id = 'semantic://braai/firebox_panel_left'
ORDER BY sm.revision_id ASC;
```

---

# 10. Why This Example Is The Right Acceptance Case

It exercises every load-bearing piece of the MVP in one workflow:

| MVP piece                                                          | Exercised by                  |
| ------------------------------------------------------------------ | ----------------------------- |
| Transaction primitive (`begin` / mutating tool / `commit`)         | §3, §6, §7                    |
| User-declared semantic identities (no inference)                   | §4                            |
| Face-group binding                                                 | §5.1, §5.2                    |
| Derived spatial-region binding (the novel part)                    | §5.3                          |
| OCCT shape history capture                                         | §6.1                          |
| Mapping Layer remap on commit                                      | §7.1, §7.2                    |
| Dolt persistence + lineage query                                   | §7.3, §9                      |
| Identity survival across a real topology mutation                  | §8                            |
| Operates on the existing fixture without geometry pipeline changes | throughout                    |

If a future change ever causes any of `semantic://braai/outer_panel_left`,
`semantic://braai/firebox_panel_left`, or `semantic://braai/left_base_airflow` to
resolve to an empty or wrong geometry binding after `split_body_by_bends`, the
semantic layer has regressed and the MVP claim is broken.

---

# 11. What This Example Does Not Cover (deferred)

* **Inference.** The three entities are user-declared. An Inference Engine that
  would derive `left_base_airflow` from geometry alone is concept-only — see
  [MCPDefinition.md §7.2](MCPDefinition.md).
* **Thermal/airflow analysis.** No CFD or thermal solver is invoked. The semantic
  identity says "this is the left base airflow region"; it does not say "the air
  flows at X CFM." Real analysis is concept-only — see
  [MCPDefinition.md §11](MCPDefinition.md).
* **Conflict resolution.** If two bindings claim the same face, MVP rejects the
  second. Semantic merge/split tools to fix this are deferred.
* **Multi-product graphs.** The example operates on one product. Cross-product
  identities are deferred.
