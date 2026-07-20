# 15 — MCP Contract v2 (Phase 2.3)

**Status:** **Reviewed & approved by Paul 2026-07-20** — 21 mutating tools across 5
families, resources split into structural (inline) vs. geometry (`Ref`, §3.0), the
OPEN-15.2 extension included, dedicated findings/parts/semantics resources added,
and the geometry-cache lifecycle (§3.0, tied to 14 §3.1) resolved. Joins 13/14 as an
approved Phase 2 artifact.
**Inputs it must satisfy:** 03-jobs-to-be-done.md (interface principles, job map),
02-requirements.md (FR-A–K, B5 history, N4 error taxonomy, N9 latency split, N12
action log), 10-tool-triage.md (the ~27-verb triage this contract makes concrete),
13/14 (the geometric model and graph schema every verb operates on).

---

## 0. What "contract-first" means here

Per 03 principle 2, this is the versioned artifact server and tests are checked
against — not implementation. Every tool below names its family, its purpose, the
schema entities it touches (14), and the FR/AC it satisfies. Two things apply
uniformly and are stated once, not per-tool: the **result envelope** (§1) and the
**error taxonomy** (§2).

## 1. The result envelope (every mutating tool returns this shape)

```
MutationResult {
  status:      "ok" | "error"
  dryRun:      bool                                    -- 03 principle 5
  delta: {                                              -- AC-B.2/B.4
    nodesAdded:   [ {kind, id} ],
    nodesUpdated: [ {kind, id, fields} ],
    nodesRemoved: [ {kind, id} ]
  }
  findings:    [ Finding ]                              -- computed even on dryRun
  actionLogId: string | null                             -- N12; null on dryRun (nothing
                                                          -- committed, nothing to log)
}

Finding {
  code:           string                                -- error taxonomy, §2
  severity:       "error" | "warning" | "info"
  message:        string
  anchors:        [ {kind, id} ]                         -- which entities this is about
  recommendedFix: { tool: string, params: object } | null  -- F4/AC-F.6
}
```

- **One `Finding` schema everywhere.** Whether a finding arrives inline from a
  mutation (e.g., a K5 seam conflict surfaced immediately by `move_edge`) or from a
  read of `graph://part/{id}/findings` (§3.2), it's the same shape. No duplicate
  finding representations to keep in sync (L1 applied to the API surface, not just
  the geometry).
- **`dryRun=true` computes everything except committing.** `delta` is the *predicted*
  delta; `findings` are fully computed (so an agent gets complete lookahead cheaply,
  03 principle 5); `actionLogId` is `null` since nothing happened.
- **The fix-application harness (AC-F.7) runs directly against this envelope**: apply
  a `recommendedFix` verbatim, and the finding it came from must no longer appear.

## 2. Error taxonomy (N4: `{code, message, recoverable, suggestedTool}`)

Representative, organized by where the failure originates — not exhaustive (new
codes are added as verbs are implemented, but always in one of these categories):

| Category | Example codes | recoverable | suggestedTool |
|---|---|---|---|
| Ingest | `IMPORT_UNHEALABLE` (AC-A.4), `IMPORT_NOT_DEVELOPABLE` (C5 boundary) | false | — |
| Graph structure | `GRAPH_INTEGRITY_ERROR`, `BEND_SELF_REFERENCE` (14 §5), `TREE_CYCLE_DETECTED` | false | — |
| Region derivation | `REGION_CLIP_FAILED` (14 OPEN-D2.6 algorithm failure — replaces v1's `GE_PANEL_FRAME_FAILED`) | false | — |
| Kernel boundary | `BOOLEAN_OP_FAILED` (Port C, 16 §1 — general boolean on independently-realized solids; never expected from Port D's constrained construction path, 16 §1) | false | inspect input geometry |
| Mapping | `POINT_NOT_ON_PART` (13 §5, N5 — no nearest-guess) | true | inspect input point |
| History | `SCHEMA_VERSION_MISMATCH` (B5e), `MERGE_CONFLICT` (row-level), `CHECKOUT_REQUIRED` | true | `restore` / resolve conflict |
| Contract usage | `MISSING_PART_REFERENCE` (AC-A.5 — no active-part fallback), `CASCADE_CHOICE_REQUIRED` (K1) | true | re-call with explicit param |

**Findings are not this table.** A validation finding (min-flange violation, K5
conflict, I3e stale anchor) is a `Finding` (§1), always `recoverable` in spirit (it
has or lacks a `recommendedFix`) — it is never a hard `MutationResult.status="error"`
by itself (N5: nothing blocks on a finding). Only structural/contract failures use
the error table above.

## 3. Resources (read side — two namespaces, per 03 principle 4)

`[REVISED 2026-07-20 — Paul: gaps in list/findings resources, and "only a reference
is passed through the MCP, and not the whole object."]` Three corrections folded in
below: (i) project-level *list* resources were missing (parts, semantic entities);
(ii) findings had no dedicated, discoverable resource; (iii) every resource carrying
a geometry payload is now a **reference**, not the payload — see §3.0.

### 3.0 The reference pattern for geometry payloads

**Structural/graph data (nodes, edges, findings, lists) is returned inline as JSON**
— it's small, and clients need to query and filter it directly. **Geometry payloads
(mesh, exact boundary data, flat-pattern point arrays, drawings, exports) are
returned as a reference, never inline**, matching the existing pattern for async job
results (§4.5) — generalized here to ordinary resource reads, not just jobs, per
Paul's correction:

```
Ref {
  url:         string        -- fetched via a plain HTTP GET, OUTSIDE the MCP
                              -- JSON-RPC channel (a local resource server the MCP
                              -- host also runs, or a blob-store URL)
  contentType: string        -- e.g. "model/gltf-binary", "application/dxf", "application/pdf"
  byteSize:    number
  expiresAt:   timestamp | null
}
```

A resource whose value is geometry returns `{ ...metadata, ref: Ref }`, not the
vertices/curves themselves — this is the same shape whether the caller is the UI or
an agent, and it's why `graph://part/{id}/full` (below) never embeds geometry: it
answers "what does the graph contain," and geometry resources answer "show me this
node," each fetched only when actually needed, at whatever size/resolution the
consumer asks for.

**`expiresAt` is a real deadline, not a decoration** — it's the TTL half of the
geometry-blob cache lifecycle policy specified at 14 §3.1 (Layer 3): the blob behind
this `Ref` is keyed by `(part_id, commit_or_content_hash, profile_id, resource_type,
resolution/params)`, and expires primarily on TTL rather than LRU, because the same
exact resolution/params combination is unlikely to be requested again (a transient
viewport zoom level, say) — regenerating on a later miss is cheap, since the `Layout`
it's derived from (14 §3, Layer 2) is very likely still cached. Expiry here **never
loses data** — the blob is a pure function of the (immutable) graph; the only cost of
a miss is recomputation, per 14 §3.1's closing invariant.

### 3.1 Project profiles/capabilities
`profile://tolerance/{id}` (N11), `profile://material/{id}` (K-factor, thickness),
`profile://tooling/press_brake`, `profile://rules`, `profile://logistics/*`.

### 3.2 Graph projections — structural, inline JSON
All parameterized by an optional `commit` (defaults to the current checkout, B5e):
- `graph://parts` `[ADDED 2026-07-20]` — list every part in the project (id, name,
  material, root region, commit). This is where v1's `list_parts` DEMOTE-to-resource
  verdict (10-tool-triage.md) actually lands — it was never given a concrete home
  until now.
- `graph://semantics` `[ADDED 2026-07-20]` — list every semantic entity project-wide
  (`semantic_entity` is explicitly project-level, 14 §2 — a single entity may anchor
  into multiple parts, I3d, so it cannot be discovered by listing one part alone).
  `graph://semantics/{sem_id}` — one entity with all its anchors and roles, resolved
  across every part it touches.
- `graph://part/{id}/full` — the complete graph for one part (B3a: every node/edge,
  validation findings, state flags) — **the UI's single source for rendering graph
  structure**, per that requirement. Contains **no geometry** (§3.0) — findings and
  node data only.
- `graph://part/{id}/findings` `[ADDED 2026-07-20]` — **the dedicated place to view
  manufacturing validation errors** (this was missing — nothing pointed here
  explicitly before). Returns every current `Finding` (§1 schema) touching this
  part: rule violations (absorbing the OPEN-15.2 `manufacturability` resource, now
  folded in here with an optional `ruleSet` filter), K5 3D conflicts, I3e stale
  anchors, seam residual violations — one aggregated, always-current list, rather
  than findings scattered across `full`, a `manufacturability`-only endpoint, and
  the B5c diff. Cross-part findings (`check_clearance` between two parts) appear on
  *both* parts' `findings` resource. `full`'s embedded findings and this resource
  are **the same computation, packaged two ways** — `full` for one-shot whole-graph
  rendering (B3a), `findings` as a small, dedicated, easily-polled target for a
  validation panel — never two independently derived finding sets (L1, applied here
  too: one function, two projections, not two functions).
- `graph://part/{id}/topology`, `graph://part/{id}/history` (commit log),
  `graph://part/{id}/action-log` (N12).
- `graph://part/{id}/diff?from={commit}&to={commit}` — the B5c change-review diff
  (graph delta + drawing diff — the drawing half is a `Ref`, §3.0). Comparing two
  commits has no side effect, so per principle 4 it belongs on the read side, not
  among the mutating tools counted in §4.
- `graph://part/{id}/full?commit={hash}` **is** view-at-commit (B5b) — no separate
  tool needed; the full-graph resource already takes a commit parameter.

### 3.3 Geometry projections — always a `Ref` (§3.0)
- `graph://part/{id}/boundary?commit=…` `[ADDED 2026-07-20 — Paul: the UI currently
  renders exact boundary data, "something like B-rep," not a mesh]` — the exact
  per-region and per-bridge geometry: 13 §3.3's `bottomFace`/`topFace` point arrays
  per region, plus each bridge's exact parametric description (hinge axis, radius,
  angle range, width) rather than a tessellation of it. **This, not `mesh`, is the
  primary viewport resource** — it matches what the current UI actually consumes,
  and it's already exact (13 §3.3 was designed as exact point arrays from the
  start; it just wasn't wired to a resource correctly until now).
- `graph://part/{id}/mesh?resolution={mm}` — a tessellated mesh at the *requested*
  chordal resolution, for viewers that specifically want a mesh (rather than
  rendering `boundary` directly). Resolution is a query parameter, not a fixed
  bake — Paul: "a mesh may be useful, but need higher resolution display." No
  resolution is baked into the model (13 §3.3 already established tessellation as a
  per-consumer, query-time choice for arc/bulge segments — this extends the same
  rule to whole-part mesh export, closing the gap between what 13 specified and
  what 15 had actually wired up).
- `graph://part/{id}/flat-pattern?resolution={mm}` — 13 §3.3's 2D point arrays,
  same resolution parameter for tessellating any `bulge` (arc) segments.
- `graph://part/{id}/drawings` (07 — the primary UI for some users, per OPEN-23).

This reclassification removes two tools (`view_at_commit`, `diff`) from the mutating
surface counted in §4 — resources were the right home for both from the start; they
were only listed as tools in 10 because the triage was organized by "job" rather
than by "does it mutate."

## 4. Tools, by family

### 4.1 Ingest (J1) — 2 tools
| Tool | Purpose | Key params | Notes |
|---|---|---|---|
| `import_part` | Heal + auto-bootstrap a full manufacturing graph from a solid (A4) | `file`, `materialProfile` | **Async job** (N9: graph-build is a heavy op) — returns `{jobId}`; poll `get_job`. Internally runs the reconciliation pipeline (13 §6): per-piece measurement → unify into one outline → bend tree. `[N9a]` reports **granular `progress`** during the job (piece-by-piece measurement is naturally incremental) — async is a protocol shape, not license to leave the user watching a bare spinner; 16 §5 OPEN-16.1. |
| `create_part` | Author a part directly (Level A) | `outline` (point array + holes), `material`, `anchor?` | Sync — cheap, no kernel round-trip. The suite's Level A test path (09 §1.5) calls this directly. |

### 4.2 Decompose & compose (J3, J4, J5) — 7 tools
| Tool | Purpose | Key params | Notes |
|---|---|---|---|
| `split_body_by_bends` | (Re-)establish bend structure from geometric analysis | `part_id`, `strategy`, `angle_threshold?`, `max_thickness?` | Absorbs `decompose_volume` (C1). Used internally by `import_part`'s job; also directly callable to re-decompose with different thresholds. |
| `remove_protrusions` | Classify and split off non-panel material | `part_id` | Branch-005 lineage; feeds A4's classification step. |
| `split_body_by_plane` | Cut a part by a plane (absorbs `trim_body_with_plane` — keep-one-side option) | `part_id`, `plane`, `keep` | On Paul's explicit FR-J list. |
| `merge_bodies_with_bend` | Join **two separate parts** into one, connected by a new bend | `part_a_id`, `part_b_id`, `edge_refs`, `bend_params` | `[OPEN-15.1 RESOLVED 2026-07-20]` Same mechanism as panel-level merge, one level up (14 §2.1.2): reconciles `B`'s outline into `A`'s, re-parents `B`'s rows onto `A`, then an ordinary `create_node(bend, ...)` at the seam — **not** a distinct join primitive. `B.merged_into_part_id = A` (alias, never deleted); zero stale findings. Because the resulting bend is ordinary, an already-merged graph is split again using the *same* generic `create_node`/`delete_node(bend)` CRUD (§4.3) — no dedicated unmerge tool. That delete is an ordinary panel-level merge of the adjoining regions, not a resurrection of `B` as a standalone part (nobody has asked for that capability). |
| `fuse_bodies` | Boolean-join already-placed shells | `part_id`, `region_panel_ids[]` | |
| `cut_panel` | Cut a hole/cutout — parametric or boolean | `part_id`, `kind` (`circle`\|`slot`\|`polygon`\|`boolean`), `shape`, `region_panel_id?` (context only, §4.3 note) | `[OPEN-15.4 RESOLVED — merge agreed]` Absorbs `cut_bodies`/`add_cut` **and** the generic-CRUD `add_hole` (K2) into one verb, `kind`-dispatched. Parametric kinds (`circle`/`slot`/`polygon`) are cheap/sync-feeling; `boolean` is closer to `fuse_bodies`'s cost class — a latency-profile difference *within* one tool, not a reason to keep two tools. |
| `add_flange` | Add a flange feature | `part_id`, `edge_ref`, `flange_params` | |
| `generate_reliefs` | Add corner reliefs at bend intersections | `part_id`, `bend_ids[]`, `relief_type` | |
| `rip_edge` | Split material along an edge (no bend) | `part_id`, `edge_ref` | |
| `close_gap` | Close a gap between two edges | `part_id`, `edge_a`, `edge_b` | Highest FE-referenced v1 tool (10×) — kept as its own verb rather than folded into `move_edge`, since it solves *for* the closing translation rather than taking one. |
| `synthesize_joints` | Add weld/rivet/tab-slot joint features between two parts | `part_a_id`, `part_b_id`, `joint_type` | Absorbs `add_join`. The FR-C4 mechanism behind 14 §2.3's "parts connected by joints." Writes to the joint table — `[OPEN-15.3: left as a placeholder, per Paul]`, reserved at 14 D2.5, intentionally not designed yet. |

`[ABSORBED into generic CRUD, §4.3]`: `translate_body` (→ `update_node(part, {anchor})`,
14 §2.3) and `add_bend` (→ `create_node(bend, ...)`, which *is* the split operation,
14 §2.1.1) are not separate tools. Removing them from the triage's count of 21 KEEPs
tightens the mutating surface further, consistent with "few verbs" (03 principle 2).

### 4.3 Graph CRUD (FR-K, FR-I) — 5 tools
| Tool | Purpose | Key params | Notes |
|---|---|---|---|
| `create_node` | Create any entity | `kind`, `part_id`, `fields` | `kind=bend` **is** the split operation (14 §2.1.1): creates the bend row *and* its new child region panel atomically, and triggers I3f's anchor-copy behavior automatically — not a raw row insert. `kind=part` with an `anchor` field is how a whole-part move is expressed (absorbing `translate_body`, as a field update via `update_node` in the common case, or an initial value here at creation). |
| `update_node` | Update any entity's fields | `kind`, `id`, `patch` | Covers bend angle/radius/k_factor edits, part anchor moves, region panel label/override edits, semantic anchor role changes. |
| `delete_node` | Delete any entity | `kind`, `id`, `cascade` | `kind=bend` **is** the merge operation (14 §2.1.1/§2.1.2, both panel- and part-level): deletes the bend row, re-parents the absorbed side's children, sets the alias — not a raw row delete. Non-bend deletes require an explicit `cascade` choice (K1) — no default, no silent orphaning. |
| `move_edge` | K2: translate an outline edge | `part_id`, `ring_id`, `vertex_range`, `newPoints` | Edits the part's **one** shared ring (14 §0/§2.2) — never a per-panel copy. |
| `smooth_edge` | K2: redraw outline segment as a curve | `part_id`, `ring_id`, `vertex_range`, `curveSpec` | Produces `bulge`-bearing vertices (14 §2). |

`[OPEN-15.4 RESOLVED]` K2's parametric hole-adding is no longer a separate `add_hole`
tool — it's `cut_panel(kind=circle|slot|polygon, ...)` (§4.2). `region_panel_id`, when
supplied for UI/agent convenience, is resolved to `F` coordinates immediately and
never stored (14 §2.2: `feature` has no `panel_id` column) — true regardless of
which `cut_panel` `kind` is used.

**Semantic CRUD (I3a–f) uses the same three generic verbs** — `create_node`/
`update_node`/`delete_node` with `kind=semantic_entity` or `kind=semantic_anchor` —
rather than dedicated tools. `declare_semantic_entity`/`bind_semantic_entity` (v1)
and K6's "association CRUD" collapse into this, per the "few verbs, rich results"
principle: a semantic anchor is a graph row like any other, and needs no special
verb, only special *behavior* on delete (I3e/K6 stale-anchor-then-re-anchor) which
`delete_node`'s cascade handling already provides uniformly.

### 4.4 Derive & Validate (J6, J7, Pivot 1 outputs) — 0 mutating tools (all resources)
`[OPEN-15.2 RESOLVED 2026-07-20 — Paul: "move to resource makes sense," extended for
consistency]` `get_flat_pattern`, `map_2d_to_3d`, `map_3d_to_2d`, `get_drawings`, and
— per the same reasoning, since nothing distinguishes them — `evaluate_manufacturability`,
`validate_bend_sequence`, and `check_clearance` are all **reads**: each computes from
the `Layout` cache (14 §3) or a validation pass over it, with no side effect. The
"expensive to compute" concern that motivated keeping `evaluate_manufacturability` as
a tool doesn't actually distinguish it — resources already represent non-trivial
computed reads (`get_drawings`, `get_flat_pattern`); cost is not what separates a
resource from a tool, side effects are. Per principle 4, all seven are resources:
- `graph://part/{id}/flat-pattern` → §3.3 (a `Ref`, resolution-parameterized).
- `graph://part/{id}/map-2d-3d?point=x,y` and `.../map-3d-2d?point=x,y,z` → 13 §4/§5
  directly, including the typed `POINT_NOT_ON_PART` response (small, inline).
- `graph://part/{id}/drawings` → 07 (a `Ref`, §3.3).
- **Rule-violation findings fold into `graph://part/{id}/findings` (§3.2)** with an
  optional `ruleSet` filter — `[UPDATED 2026-07-20]` no separate
  `manufacturability` resource; §3.2's findings resource is the one aggregated place
  for every finding type, per Paul's "I don't see where to view validation errors."
- `graph://part/{id}/bend-sequence` → the feasible fold order, or an infeasibility
  finding (AC-F.4's distinct output shape — an ordering, not a `Finding[]`, so it
  stays its own small resource rather than folding into `findings`).
- `graph://clearance?refs={a},{b},...` → gap/clash findings between any two placed
  regions, same or different parts (explicitly cross-part, 14 §2.3 — this is what
  makes a cross-part semantic anchor, I3d, checkable). Also mirrored onto both
  parts' `findings` resource (§3.2) so a per-part view never misses a cross-part
  conflict.

`[RECLASSIFIED 2026-07-20]` v1 exposed all seven as tools; none of them ever mutated
anything, even in v1. The **separate Validate family is removed** — folded entirely
into this section, mirroring Derive. `[Flag: this extends beyond the literal ask in
OPEN-15.2, which named only `evaluate_manufacturability` — surfaced explicitly in
case Paul intended a narrower change.]`

### 4.5 Produce (J8) — 2 tools + uniform job API
| Tool | Purpose | Key params | Notes |
|---|---|---|---|
| `simulate_nesting` | Nest parts' flat outlines on stock sheets | `part_ids[]`, `sheetSpec` | Consumes graph-derived flat patterns directly (fixes v1's `unfold_ids` coupling, FR-G2). Async job. |
| `export_production_pack` | Drawings + DXF + BOM + assembly instructions | `part_ids[]`, `format?` | Async job. |
| `get_job` | Poll any async job | `job_id` | Uniform: `{status: queued\|running\|done\|error, progress?, result?, error?}`. Used by `import_part`, `simulate_nesting`, `export_production_pack`, and any future heavy op — one pattern, not per-tool status/result pairs (absorbing `get_export_job_status`/`get_export_job_result`). Where a job's result is geometry (an export pack, a nesting layout), `result` is a `Ref` or list of `Ref`s (§3.0) — the pattern jobs used first and §3.0 generalized to ordinary resource reads, not the other way around. |

### 4.6 History — 4 tools (mutating only; reads moved to §3)
| Tool | Purpose | Key params | Notes |
|---|---|---|---|
| `commit` | Record the current graph as a named version | `part_id`, `message` | B5a. |
| `restore` | Reset working state to a prior commit | `part_id`, `commit_hash` | B5b's mutating half (the read half is `graph://.../full?commit=`). Absorbs `rollback`. |
| `branch` | Create a branch pointer | `part_id`, `name`, `from_commit?` | |
| `merge_branch` | Merge one branch into another, gated by prior review | `part_id`, `source`, `target`, `resolution?` | B5. Requires the caller to have consulted the diff resource (§3) first; conflicts surface as `MERGE_CONFLICT` (§2) at row granularity (14 §4). |

No transaction tools exist (B5d — the uncommitted working set *is* the transaction);
`begin/commit/rollback_transaction` fully dissolve into `commit`/`restore` acting on
working state. No `set_active_part` (AC-A.5 — every call takes an explicit
`part_id`). `delete_part` is `delete_node(kind=part, ...)` — generic CRUD (§4.3), not
a dedicated verb.

## 5. Tally

| Family | Tools |
|---|---|
| Ingest | 2 |
| Decompose & compose | 7 |
| Graph CRUD | 5 |
| Derive & Validate | 0 (all resources) |
| Produce | 3 (incl. `get_job`) |
| History | 4 |
| **Total mutating tools** | **21** |

Down from the triage's ~27 estimate: reclassifying `view_at_commit`/`diff`/
`map_2d_to_3d`/`map_3d_to_2d`/`get_flat_pattern`/`get_drawings`/
`evaluate_manufacturability`/`validate_bend_sequence`/`check_clearance` as resources
(−9), merging `cut_panel`/`add_hole` (−1) and `translate_body`/`add_bend` into
generic CRUD (−2), against adding the previously-unlisted `create_node`/`delete_node`
pair (+2, since 10's triage only explicitly named `update_node`). **21 mutating
tools** is a materially tighter surface than the original estimate, every one tracing
to a specific FR/AC, with validation and derivation living entirely on the read side
— exactly the "resources for state, tools for change" principle applied without
exception, not just in the cases that were obvious at first pass.

## 6. Decisions (2026-07-20 — Paul: "agree with all")

- **OPEN-15.1 — RESOLVED.** `merge_bodies_with_bend` uses the exact same
  merge/alias mechanism as panel-level merge, one level up — see 14 §2.1.2 (new),
  including the new `part.merged_into_part_id` column. Confirmed by Paul: "an already
  merged graph can be split with this function" — because the connecting bend is an
  ordinary `create_node(bend)`, splitting it back apart is ordinary `delete_node`/
  `create_node(bend)` CRUD, no dedicated unmerge tool needed (§4.2).
- **OPEN-15.2 — RESOLVED, and extended.** `evaluate_manufacturability` moves to a
  resource, confirmed. Applied the same reasoning to `validate_bend_sequence` and
  `check_clearance` too (§4.4) — flagged above as an extension beyond the literal
  ask, in case Paul intended only the one tool.
- **OPEN-15.3 — RESOLVED: left as a placeholder**, per Paul. The joint table stays
  reserved (14 §7 D2.5), not designed, until a session specifically takes it up.
- **OPEN-15.4 — RESOLVED: merged.** `cut_panel` and `add_hole` are one verb,
  `kind`-dispatched (§4.2/§4.3).
