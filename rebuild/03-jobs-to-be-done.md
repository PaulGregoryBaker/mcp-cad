# 03 — Jobs To Be Done & the MCP Surface

**Premise.** v1 grew to ~80 tools across 10 handler groups. Paul confirms many were never
used by the front end. v2 inverts the design direction: start from observed jobs, derive
the minimal tool surface, and let the MCP contract be *the* product interface designed
up front (per the rebuild brief).

## 1. Usage audit — findings `[RESOLVED 2026-07-18]`

The audit cannot be made scientific, per Paul: the core problem was never solved, so
usage never stabilized into evidence. Findings from the front end
(`C:\Projects\Form.AI.tion`, Flutter):

- Its `UI_MCP_SPEC.md` mandates the UI "support invoking **all** production tools" — the
  front-end code mirrors the server surface nominally, so code references ≠ usage.
- The app has **two live MCP paths**, confirming the dual-consumer decision: a direct MCP
  client (`lib/mcp/client.dart` + tools/resources wrappers) and an AI chat panel
  (`lib/features/ai_panel/`). Feature areas: workspace (3D viewport), flat_patterns, bom,
  export, project, revision (commenting/review), auth.

**Consequence:** scope is governed by the two foundational pivots
(02-requirements.md §0) plus judgment. Per-tool KEEP/MERGE/DEMOTE/CUT verdicts are still
recorded, but justified by "which job under which pivot" rather than call counts.

## 2. Candidate job map `[PROPOSAL]`

Jobs, not tools. Each job below would map to a small number of coarse-grained tools with
rich structured results, rather than v1's many fine-grained verbs.

| # | Job ("hire the system to…") | v1 tools it absorbs |
|---|---|---|
| J1 | Get a clean, known-good solid into the session | clean_geometry, heal_geometry_ex, create_part, import path |
| J2 | Understand what I'm looking at | explore_topology, bounding_box, mass_properties, measure_distance, query_graph, resources |
| J3 | Break a volume into manufacturable panels | decompose_volume, split_body_by_bends, remove_protrusions |
| J4 | Join panels into a folded part | merge_bodies_with_bend, fuse_bodies, add_bend, add_join, synthesize_joints, close_gap |
| J5 | Detail a panel for manufacture / edit the graph directly | add_flange, add_cut, generate_reliefs, rip_edge, fillet/chamfer (survivors of FR-J pruning); NEW (FR-K): CRUD over any graph entity, incl. outline verbs — add holes, move edge (resize), smooth edge — usable through the drawing as an editing surface |
| J6 | Prove it can be made | evaluate_manufacturability, validate_bend_sequence, check_foldability, validate_sheet_metal, compute_gaps/intersections |
| J7 | Construct the part's forms (folded 3D / flat pattern) & map between them | **`get_flat_pattern`** (v2 name for v1's get_unfold — the domain term; construction, not unfolding), map_2d_to_3d, map_3d_to_2d |
| J8 | Produce the manufacturing package | simulate_nesting, export_production_pack, job status tools |
| J9 | Try things safely / change my mind | `[DECIDED 2026-07-19]` absorbed into the J10 commit model (B5d): uncommitted working state on a branch IS the transaction; no separate transaction verbs |
| J10 | Commit my work; view another commit, with the option to restore to it | NEW (B5): commit (named graph version), history/log, view-at-commit (read-only projection of any version), restore |
| J11 | Compare against another commit — the change review before merging | NEW (B5): graph diff (nodes added/updated/removed), drawing diff (07 §5), review comments, merge gate |

Everything in v1 that doesn't land in a row here is a CUT candidate by default —
notably large parts of assembly (H), semantic layer (I), and direct shape editing (J in
02-requirements.md).

## 3. Interface design principles for the v2 surface `[PROPOSAL]`

1. **One surface for two collaborators `[DECIDED 2026-07-18]`.** Human and AI are
   collaborators: same tools, same controls, and both actors' actions land in one shared,
   actor-attributed action log that forms the collaboration context (N12). There are no
   UI-only or agent-only *mutation* paths. Where consumers legitimately differ is the
   **read side**: the UI needs meshes/tessellation, streaming previews, and hover/pick
   queries; the agent needs compact structured summaries. Both are projections of the
   same graph state, served as resources/queries — they don't fragment the verb surface.
2. **Contract-first.** The MCP schema (tools + resources + error taxonomy) is authored as
   a versioned artifact before implementation; server and tests are generated/checked
   against it. This is the "define the job through the MCP upfront" requirement from the
   rebuild brief made concrete.
2. **Few verbs, rich results `[DECIDED 2026-07-18]`.** A small surface of intent-level
   tools returning structured state deltas, organized in ~6 families: ingest,
   graph-mutate (the sheet-metal verb set of FR-J), semantic ops, derive (drawings /
   flat pattern / mesh), validate, export. Well under the original ≤25 ceiling.
   **Build order follows hardness:** the graph-mutate core — the part v1 could never
   stabilize — is built, reviewed, and thoroughly tested **first**, before any other
   family gets more than a stub.
3. **Every mutation returns the graph delta** it caused (nodes added/updated), so the
   agent's world model and the server's never diverge, and every result is auditable
   against the replay invariant (FR-B2).
4. **Resources for state, tools for change `[DECIDED 2026-07-19]`.** Two resource
   namespaces: (a) **project profiles/capabilities** (tolerance profiles N11,
   materials/K-factor, tooling, rules, logistics — v1's scheme, kept); (b) **graph
   projections** — the **full manufacturing graph** (B3a: the UI renders it entirely;
   v1 only partially delivered this) and its derived views (topology, flat pattern,
   drawings, viewport mesh, action log, commit history — where the triage's 11 DEMOTE
   verdicts land). Rule: anything that mutates the graph is a tool; anything that reads
   graph or configuration is a resource.
5. **Idempotency & dry-run.** Mutating tools accept a `dryRun` flag returning the
   predicted delta + validation findings without committing — cheap agent lookahead,
   and it exercises the same validation path as the real call.
6. **Async jobs for long ops** (nesting, export, heavy decomposition) with one uniform
   job API, not per-tool status endpoints.
