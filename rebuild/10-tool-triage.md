# 10 — v1 Tool Triage (Phase 1.1)

**Status:** `[PROPOSAL]` for Paul's review. All 76 tools from v1's `dispatch.ts`, each
with a verdict justified by a job (J1–J11, 03-jobs-to-be-done.md) under one of the two
pivots. Default verdict is CUT (plan risk R1); a KEEP must earn its row.

**Verdicts:**
- **KEEP** — survives as a v2 MCP tool (possibly renamed / absorbing others).
- **MERGE→x** — capability survives inside another v2 tool or the graph CRUD.
- **DEMOTE** — becomes a read-side resource/query or an internal function; no longer a
  mutating MCP tool.
- **CUT** — gone. No v2 equivalent planned.

Rows marked ⚑ need Paul's call — my verdict is a recommendation with open doubt.

---

## Family: Ingest (J1)

| v1 tool | Verdict | Rationale |
|---|---|---|
| clean_geometry | **KEEP** as v2 `import_part` (import+heal+validate as one job) | J1; Pivot 1 entry point — import *becomes* graph |
| heal_geometry_ex | **MERGE→import_part** | L7 duplicate of clean_geometry |
| create_part | **KEEP** | J1; authored parts; also the Level A test path (graph authored directly) |
| sew_faces | **DEMOTE** (internal to healing) | No standalone job |
| simplify_body | **DEMOTE** (internal to import/heal) | No standalone job |

## Family: Decompose (J3)

| v1 tool | Verdict | Rationale |
|---|---|---|
| decompose_volume | **MERGE→split_body_by_bends** (strategy parameter) `[DECIDED 2026-07-19]` | One decomposition verb — together they are Pivot 1's "shape becomes graph" operation |
| split_body_by_bends | **KEEP** — absorbs decompose_volume; the single solid→manufacturing-graph verb | J3; Paul's FR-J list; graph-producing |
| split_body_by_plane | **KEEP** | Explicitly on Paul's FR-J list |
| trim_body_with_plane | **MERGE→split_body_by_plane** (keep-one-side option) | Trim ≡ split + discard; two tools, one geometry op |
| remove_protrusions | **KEEP** `[DECIDED 2026-07-19]` | Supports the decompose flow (branch 005); sheet-metal-specific |

## Family: Graph mutate — composition & detailing (J4, J5)

| v1 tool | Verdict | Rationale |
|---|---|---|
| merge_bodies_with_bend | **KEEP** | The core verb; Paul's list |
| fuse_bodies | **KEEP** | Paul's list |
| cut_bodies | **KEEP** as v2 `cut_panel` (holes/cutouts) | Paul's list ("creating holes") |
| add_cut | **MERGE→cut_panel** | Same job as cut_bodies; simple holes also covered by graph CRUD (FR-K K2) |
| add_flange | **KEEP** | FR-C4, J5 |
| generate_reliefs | **KEEP** | FR-C4; sheet-metal necessity |
| rip_edge | **KEEP** | FR-C4, J5 |
| close_gap | **KEEP** `[DECIDED 2026-07-19]` | J4; highest FE reference count in Form.AI.tion (10×) |
| synthesize_joints | **KEEP** `[DECIDED 2026-07-19]` | J4 (tab-slot/rivet/weld prep); in scope |
| add_join | **MERGE→synthesize_joints** | L7 overlap; one joints verb |
| add_bend | **MERGE→graph CRUD** (bend-node create) | Bend creation between existing panels is merge_bodies_with_bend; standalone bend node authoring is K1 CRUD |
| translate_body | **KEEP** | Explicitly on Paul's list |
| intersect_bodies | **CUT** | No sheet-metal job (FR-J2) |
| rotate_body | **CUT** | FR-J2 |
| scale_body | **CUT** | FR-J2 |
| mirror_body | **CUT** | FR-J2 |
| center_and_align_body | **CUT** | FR-J2 |
| align_to_face | **CUT** | FR-J2 |
| offset_face | **CUT** | FR-J2 |
| offset_shape | **CUT** | FR-J2 |
| extend_face_to_target | **CUT** | FR-J2 |
| delete_face | **CUT** | FR-J2 |
| fillet_edges | **DEMOTE** (internal: reliefs/corner geometry) | FR-J2; generate_reliefs needs corner geometry internally |
| chamfer_edges | **CUT** | FR-J2; no surviving job needs it internally |
| reconstruct_curved_bends | **CUT** | NG1 decided: curved bends only via graph nodes; 3D shell reconstruction is the prohibited direction |

## Family: Graph CRUD & semantic (FR-K, FR-I; J5)

| v1 tool | Verdict | Rationale |
|---|---|---|
| update_node | **KEEP** — becomes the K1 CRUD update core | FR-K |
| remove_node | **MERGE→graph CRUD** (delete w/ referential integrity) | FR-K K1 |
| bootstrap_graph | **MERGE→import_part / decompose** | Pivot 1: import produces the graph; no separate bootstrap step |
| reset_graph | **CUT** | Destructive; replaced by version restore (B5b) |
| declare_semantic_entity | **MERGE→graph CRUD** (semantic node types) | FR-I: semantic graph lives inside the manufacturing graph |
| bind_semantic_entity | **MERGE→graph CRUD** | Same |
| semantic_lineage | **DEMOTE** to resource | Lineage = graph-history read (B4) |
| NEW: move_edge, smooth_edge | *(no v1 equivalent)* | FR-K K2 — first genuinely new verbs |

## Family: Derive / read side (J2, J7; Pivot 1 outputs)

| v1 tool | Verdict | Rationale |
|---|---|---|
| get_unfold | **KEEP**, renamed **get_flat_pattern** | Decided; J7 |
| map_2d_to_3d | **KEEP** | J7 core |
| map_3d_to_2d | **KEEP** | J7 core |
| solve_geometry | **MERGE→v2 construct/derive op** (regenerate forms from graph) | L7 duplicate pair with resolve_geometry; capability = E1 construction |
| resolve_geometry | **MERGE→v2 construct/derive op** | Same |
| explore_topology | **DEMOTE** to resource (`geometry://…/topology`) | Read model; principle "resources for state" |
| bounding_box | **DEMOTE** to read-side query | J2 read |
| mass_properties | **DEMOTE** to read-side query | J2 read (feeds drawing part block D5) |
| measure_distance | **DEMOTE** to read-side query | J2 read; UI hover/pick class |
| NEW: get_drawings | *(no v1 equivalent)* | FR-G1 engineering drawings (07) |

## Family: Validate (J6)

| v1 tool | Verdict | Rationale |
|---|---|---|
| evaluate_manufacturability | **KEEP** as the validation umbrella (rule-set parameter) | J6 |
| validate_sheet_metal | **MERGE→evaluate_manufacturability** | L7 overlap |
| check_boundary_compliance | **MERGE→evaluate_manufacturability** (logistics rule set, reads tolerance/logistics profile) | J6 |
| is_panel_valid | **MERGE→evaluate_manufacturability** | Fragment of the same job |
| validate_bend_sequence | **KEEP** | J6; distinct output (an ordering), not a findings list |
| check_foldability | **MERGE→validate_bend_sequence** | Same analysis family |
| compute_gaps | **MERGE→** one v2 `check_clearance` (gap+clash) | J6; also the K5 conflict detector |
| compute_intersections | **MERGE→check_clearance** | Same |
| validate_assembly | **CUT** | FR-H assembly cut |

## Family: Produce (J8)

| v1 tool | Verdict | Rationale |
|---|---|---|
| simulate_nesting | **KEEP** (consumes graph DXF directly — fixes v1 TODO) | J8, FR-G2 |
| export_production_pack | **KEEP** | J8, FR-G3 |
| get_export_job_status | **MERGE→** uniform async job API (`get_job`) | Principle: one job API, not per-tool status |
| get_export_job_result | **MERGE→get_job** | Same |

## Family: History & session (J9–J11; B5)

| v1 tool | Verdict | Rationale |
|---|---|---|
| begin_transaction | **MERGE→** working-set model (uncommitted state on a branch) `[DECIDED 2026-07-19]` | J9→J10 unification confirmed; Dolt-native |
| commit_transaction | **MERGE→commit** (B5a) | Same |
| rollback_transaction | **MERGE→** discard working set | Same |
| rollback | **MERGE→restore** (B5b) | Same |
| get_transaction_history | **DEMOTE** to resource (action log, N12) | Read model |
| list_parts | **DEMOTE** to resource | Read model |
| set_active_part | **CUT** | Implicit session state is hostile to agents and to the shared action log; v2 verbs take explicit part references |
| delete_part | **MERGE→graph CRUD** (delete root, referential integrity) | FR-K K1 |
| NEW: branch, merge_branch (review-gated), diff (graph+drawing), view_at_commit | *(no v1 equivalent)* | B5a–c, J10/J11 |

## Family: Assembly — CUT wholesale (FR-H)

| v1 tool | Verdict |
|---|---|
| create_assembly_document | **CUT** |
| add_assembly_instance | **CUT** |
| mate_rigid | **CUT** |
| list_assembly_tree | **CUT** |

---

## Tally

| Verdict | Count |
|---|---|
| KEEP (v2 tools, incl. renames) | 21 |
| MERGE | 25 |
| DEMOTE (resource / internal) | 11 |
| CUT | 19 |
| **Total v1 tools** | **76** |

**Resulting v2 mutating surface: ~21 tools + ~6 new** (move_edge, smooth_edge,
get_drawings, branch/merge_branch/diff/view_at_commit, get_job) ≈ **27 verbs in 8
families**, with the read side served by resources. Slightly above the "~6 families"
sketch because History became its own family (B5) and Derive split from read-only
resources — flag if you want it tighter.

## ⚑ Review outcome (2026-07-19) — all flags resolved
1. **decompose_volume → merged into split_body_by_bends** (Paul): one decomposition
   verb, with strategy as a parameter — the Pivot 1 "shape becomes graph" operation.
2. **remove_protrusions** — KEEP confirmed.
3. **close_gap** — KEEP confirmed.
4. **synthesize_joints** — KEEP confirmed, in scope.
5. **Transactions → working-set/commit unification** — confirmed, along with jobs
   J9–J11 as a whole. Transactions are not a separate subsystem: uncommitted working
   state on a branch, sealed by commit (encoded as B5d in 02-requirements.md).
