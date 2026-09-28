# 02 — Requirements (DRAFT)

**Status:** Draft for grilling. Every requirement is tagged with its evidence source:
`(tool: …)` = existing v1 tool, `(spec: NNN)` = v1 spec cycle, `(bug: L#)` = lesson in
[01-lessons-learned.md](01-lessons-learned.md), `(new)` = new product decision needing an owner.

**Scope authority `[DECIDED 2026-07-18]`:** A scientific usage audit is impossible — the
front end ([Form.AI.tion](../../Form.AI.tion/), Flutter) binds nominally to the entire
surface per its UI_MCP_SPEC, and real usage never stabilized because the core problem was
never solved. Scope is therefore governed by the **two foundational pivots** below plus
informed judgment; per-tool verdicts are recorded with rationale, not call counts.

---

## 0. Foundational pivots (the rebuild's axioms)

These two pivots emerged from v1's lifetime and are foundational to v2 — every
requirement below is subordinate to them.

**Pivot 1 — Graph is the component.** On import, a shape *becomes* a manufacturing graph,
and the graph is the source of truth from then onwards. All modifications are
modifications to the graph. The graph produces its derived views: the **3D object** and
**well-defined engineering drawings** associated with each component. (Geometry is never
edited directly; drawings are never drawn — both are projections of the graph.)

**Pivot 2 — The semantic graph is a first-class citizen.** It is composed of
parts-of-parts — and sometimes **gaps and holes** — and represents *the engineering that
solves a problem* (design intent). It is not metadata bolted onto geometry; it is the
layer at which human and AI reason about the design, anchored to manufacturing-graph
entities (panels within a part).

---

## 1. Product frame

**Job statement `[DECIDED 2026-07-18]`: Folding core first.** The v2 product core is the
manufacturing graph + decompose/merge/unfold + exact 2D↔3D mapping. Nesting, export,
and other full-orchestrator pipeline stages are satellites, added only once the core
is proven. This targets v1's actual pain rather than the full orchestrator vision.

**Consumers `[DECIDED 2026-07-18]`: both paths are real.** Some flows are agent-driven
(AI agent calls MCP tools), others are direct front-end → MCP calls. The v2 contract must
serve both: agent ergonomics (terse structured results, graph deltas, typed errors with
suggested next actions) AND programmatic UI needs (latency, partial results, stable
schemas). Follow-up `[OPEN-21]`: enumerate which jobs are UI-direct vs agent-mediated —
this drives per-tool latency budgets and result shapes.

## 2. Functional requirements (candidate)

### FR-A: Part lifecycle & ingestion
- A1. Import STEP; heal/validate to manifold solid. (tool: clean_geometry, heal_geometry_ex; spec: 001)
- A2. Create primitive/parametric parts directly. (tool: create_part)
- A3. Multi-part session state with explicit part references (v1's implicit
  set_active_part is cut). (tool: list_parts, delete_part)
- A4. `[DECIDED 2026-07-19]` **Import bootstraps a workable manufacturing graph from
  the onset.** The load pipeline is: heal → split_body_by_bends (the single
  decomposition verb, C1) → classify adjacent panels (coplanar → fuse; angled → bend) →
  connected graph, automatically. v1's standalone heal-then-manually-build-graph flow is
  replaced. Prior art to harvest as reference: `ts/src/manufacturing/graph/bootstrap.ts`
  (in-tree) and the unmerged branch `origin/010-build-manufacturing-plan` (joint
  prioritization by priority category / combined area / axis alignment).

### FR-B: Manufacturing graph (the core)
- B1. Typed graph: panels, bends, cuts, flanges, joints, alias/merge nodes. (spec: 009, 010, 011)
- B2. **Graph is the sole source of truth: replay(graph) ≡ geometry, for every mutating
  operation.** (bug: L2 — the single most expensive gap in v1)
- B3. Graph queries and node updates as first-class operations. (tool: query_graph, update_node, remove_node)
- B3a. `[DECIDED 2026-07-19]` **The full manufacturing graph is readable as a complete
  projection** — every node and edge (panels, bends, cuts, semantic entities, validation
  findings, state flags), served as a read-side resource so the **UI can render the
  entire graph**. v1 only partially delivered this (graph access was a query tool;
  the geometry:// resource was a stub); in v2 it is a first-class read model of the
  current checkout (B5e).
- B4. Versioned graph history; undo/rollback = replay of an earlier version. (bug: L8; tool: rollback, transactions)
- B5. `[DECIDED 2026-07-18]` **History is version-control-shaped:** multi-user
  collaboration is handled through **branching and merging with review functionality**,
  not locking or real-time co-editing. A branch is a divergent graph history; merge is a
  graph-level operation gated by review. (Aligns with Form.AI.tion's existing revision/
  commenting feature; v1's Dolt smoke test was an early probe in this direction.)
  Concretely `[NEW 2026-07-18]`:
  - B5a. **Commit** — record the current graph as a named version.
  - B5b. **View & restore** — open a read-only projection of any commit (its 3D form,
    flat pattern, drawings), with the option to restore the working state to it.
  - B5c. **Compare** — diff the working state (or a branch head) against another commit:
    graph delta (nodes added/updated/removed) plus drawing diff (07 §5). This is the
    change-review workflow — the "code review" performed before a merge is accepted.
  - B5d. `[DECIDED 2026-07-19]` **Transactions are the working set** — not a separate
    subsystem. Uncommitted mutations on a branch *are* the transaction; rollback
    discards the working set; commit seals it (v1's begin/commit/rollback_transaction
    verbs dissolve into this model — one history mechanism, per L8).
  - B5e. `[DECIDED 2026-07-19]` **Single-checkout working model:** the working state
    shown to a user always derives from exactly one checkout (one branch/commit) —
    never a blend — with one exception: the B5c compare view during merge evaluation.
    (Also narrows OPEN-15: migration is migrate-on-checkout; merge evaluation is the
    only cross-version surface.)
- B6. `[DECIDED 2026-07-18]` **Durability is an eventual requirement** — v1 never got
  there because the core was never stable, but the v2 graph model must be
  serialization-ready from day one (stable IDs, schema version, no in-memory-only
  state), so persistence is an adapter added later, not a redesign.
- B7. `[DECIDED 2026-07-18 — storage direction]` **Graph store: MySQL-compatible
  database, versioned with Dolt.** Because the manufacturing graph is the source of
  truth, it is the *only* component requiring durable, versioned storage — and Dolt
  provides B5a–c natively: commit, branch, merge, and row-level diff are database
  operations, so the change-review diff (B5c) is derived from Dolt diffs over
  stable-keyed graph rows (stable node IDs per B6 are what make those diffs readable).
  The shared action log (N12) lives in the same store. Corollary: **geometric shapes are
  never persisted as truth — they are generated on demand from the graph** (the replay
  invariant B2, operationalized). A content-addressed cache keyed by graph version hash
  is permitted as a pure optimization; a cache entry can always be discarded and
  regenerated. Phase 3 (stack selection) validates the remaining unknowns: write latency
  for interactive edits (N9/OPEN-7) and schema-migration-across-branches policy (OPEN-15).

### FR-C: Decomposition & sheet-metal semantics
- C1. `[DECIDED 2026-07-19]` **One decomposition verb:** decompose_volume is merged into
  split_body_by_bends — a single solid→manufacturing-graph operation (strategy as a
  parameter), realizing Pivot 1's "imported shape becomes the graph" as one entry point.
  Includes protrusion tracking/removal (remove_protrusions KEPT).
  (tools: decompose_volume + split_body_by_bends + remove_protrusions; spec: 003, 008)
- C3. Bend model: K-factor/allowance, bend direction, hinge placement, acute/inverted folds. (spec: 007, 010)
- C4. Reliefs, flanges, rips, edge treatments. (tool: generate_reliefs, add_flange, rip_edge)
- C5. `[DECIDED 2026-07-18]` Geometry scope for the initial version:
  - **Arbitrarily oriented flat panels are core** — panels need not align with any axis,
    and outlines need not be rectangular. (This was never optional: v1's worst bugs came
    from implicitly assuming axis-aligned rectangles.)
  - **Curved bends are IN the initial version**, as first-class graph nodes with
    graph-driven flat-pattern construction (mechanism per NG1 — never via 3D shell
    reconstruction).
  - **Rolled sections are committed scope but may land after the initial version.**
  - `[DECIDED 2026-07-18]` The geometric boundary of v2 is **developable surfaces**
    (planar panels, cylindrical/conical bends, rolls — anything that flattens without
    stretching).
    Non-developable forming (stamping, stretch-forming, deep drawing) is out of scope.
    This is the precise line that makes "a single geometric solution for all situations"
    (L1) a closed, achievable statement.

### FR-D: Composition (the hard part of v1)
- D1. Merge two panels with a bend, preserving exact 3D orientation at any angle. (tool: merge_bodies_with_bend; spec: 010)
- D2. Chained merges: N sequential bends (straight chains) AND perpendicular fold lines
  (corner chains) AND multi-lobed composite flat patterns. **The placement representation
  must express all of these** — v1's couldn't. (bug: L3)
- D3. Boolean ops preserving orientation and graph lineage. (tool: fuse/cut/intersect_bodies)

### FR-E: Part construction — folded and flat forms (2D↔3D)
*(Renamed from "Unfold" 2026-07-18: under Pivot 1 nothing is unfolded — the graph
constructs the part.)*
- E1. Both forms are constructed from the graph alone: the folded 3D body and the flat
  pattern are parallel constructions of the same graph — neither is ever derived by
  analyzing the other's shell. (spec: apply_unfold redesign; bug: L1, L2)
- E2. Bijective 2D↔3D mapping with accuracy measured against the **project tolerance
  profile** (see N11) — v1's fixed 0.1 mm target becomes a profile default, not a
  constant. (tool: map_2d_to_3d/map_3d_to_2d; spec: 012)
- E3. Frame + flat shape derived from one computation — self-consistent by construction. (bug: L1)

### FR-F: Validation & manufacturability
- F1. Manufacturability evaluation against shop rules (min hole, min flange, tooling). (tool: evaluate_manufacturability; resources: manufacturing://)
- F2. Bend-sequence and foldability checks. (tool: validate_bend_sequence, check_foldability)
- F3. Clash/gap analysis. (tool: compute_gaps, compute_intersections; validation rules)
- F4. `[DECIDED 2026-07-19]` **Findings carry a recommended fix.** When a validation
  error is found, the finding includes — where a deterministic remediation exists —
  a **recommended fix: the tool and the parameters necessary to fix the error**
  (e.g., a min-flange violation recommends `move_edge` with the exact edge ref and
  delta; a gap finding recommends `close_gap` with the computed extension). Findings
  with no automatic remediation say so explicitly. This upgrades v1's string-valued
  `suggestedTool` into an executable call: the agent can apply it directly, the UI can
  offer it as a one-click fix, and either action lands in the shared action log (N12)
  like any other mutation.

### FR-G: Production output
- G1. **Engineering drawings (Pivot 1, `[NEW 2026-07-18]`):** each component in the
  manufacturing graph has well-defined associated engineering drawings, derived from the
  graph by the canonical pipeline (N2) — dimensioned flat pattern with bend lines/
  directions/angles, bend table (sequence, K-factor, allowances), and hole/cut schedule.
  `[OPEN-22]` exact drawing set, dimensioning rules, and format (DXF layers? PDF sheet?
  drawing standard?) to be specified.
- G2. Nesting on stock sheets, consuming graph-derived DXF directly (fixes v1's
  unfold_ids coupling). (tool: simulate_nesting)
- G3. Production pack export: drawings, DXF, BOM, assembly instructions; async job model.
  (tool: export_production_pack, get_export_job_*)

### FR-H: Assembly `[DECIDED 2026-07-18]` — CUT by default
- Assembly documents/instances/mates/tree are not in v2 scope (not selected as a
  candidate). The usage audit can reopen this only with hard evidence of front-end use.
- H1. `[DECIDED 2026-07-19]` **What replaces it:** parts are built in isolation, each
  with its own independent root anchor (13 §3.1; 14 §2.1), then brought into correct
  relative position via the ordinary part-level move verb (FR-J) — no kinematic mate
  system. The semantic graph (FR-I, I3d cross-part anchors) records *why* two parts
  must relate as they do; cross-part `check_clearance` (F3) validates that they
  actually do. "Assembly" in v2 is this semantic-driven positioning, not a CAD
  assembly tree.

### FR-I: Semantic graph `[DECIDED 2026-07-18]` — first-class citizen (Pivot 2)
- I1. The semantic graph is a first-class layer: a hierarchy of parts-of-parts that
  represents the engineering solving a problem (design intent).
- I2. Semantic entities include **negative space**: gaps and holes are first-class
  semantic objects (a ventilation gap, a fastener hole pattern), even though they have no
  material realization of their own.
- I3. `[SPECIFIED 2026-07-19]` Semantic entities anchor to manufacturing-graph
  entities through a defined **anchor model** — no free-floating geometry references;
  lineage rides the graph's history (FR-B4). Anchor types:
  - **I3a — Node anchor:** a whole graph node (panel, bend, cut/hole, joint). Because
    a panel **is** the region of the flat layout between its bounding bends
    (`[ALIGNED 2026-07-20]` — 14 §0/§2.1: panel and region are one graph entity, not
    two synchronized concepts), **anchoring "the area between two bends" is I3a on
    that panel** whenever the area in question is a whole panel — not a separate
    mechanism.
  - **I3b — Region anchor:** a **sub-panel** area — strictly *smaller* than a whole
    panel — as an explicit 2D polygon within one named panel's flat area (in the
    part's shared flat frame `F`, 14 §2). Used only when the semantic area doesn't
    coincide with a panel's own boundary; if it does, use I3a instead.
  - **I3c — Feature-set anchor:** a set of cut/hole nodes (e.g., a ventilation hole
    pattern).
  - **I3d — Cross-component & cross-part:** one semantic entity may anchor into
    multiple components and multiple parts; each anchor carries a **role** naming what
    the referenced geometry contributes to the concept. A concept spanning a whole
    panel plus slivers of its neighbors is a **compound anchor set** — one I3a per
    fully-covered panel, one I3b per partially-covered neighbor — not a single anchor
    describing "between two bends" across panel boundaries.
  - *Worked example (Paul), re-expressed after the alignment:* semantic concept
    **"air-flow cavity"** anchors: **panel P on part A** in full (I3a, role: bounding
    surface), **a component on part B** (I3a or I3b depending on coverage, role:
    opposing surface), and the hole set cut into one of the panels (I3c, role:
    inlet/outlet).
  - **I3e — Anchor integrity, flag-don't-block:** if a mutation genuinely invalidates
    an anchor (a referenced hole deleted without cascade — real removal of material,
    never a bend removal — see I3f), the semantic entity is not silently dropped — it
    gains a typed **stale-anchor finding** (K5 philosophy), visible in the full-graph
    resource and the B5c review.
  - **I3f — Semantic continuity across splits and merges** `[ADDED 2026-07-20, Paul]`:
    **the semantic graph stays constant through structural edits to the fold tree.**
    Removing a bend (merging two panels) never invalidates an anchor — the merged
    panel's identity persists via an alias, and every reference to it resolves
    transparently to the surviving panel; **no stale-anchor finding is generated for
    a merge.** Adding a bend (splitting a panel) **copies the parent's whole-panel
    (I3a) semantic links onto the new panel** at split time, so both the original and
    new panel carry the same engineering meaning the material had before the split —
    coverage is never silently lost by subdividing the geometry. Mechanism: 14 §2.1.1
    (`panel.merged_into_panel_id` alias chain for merges; anchor duplication for
    splits; I3b sub-panel regions get a geometric containment check, flagged with a
    safe `recommendedFix` if a split hinge crosses them, F4).
- I4. The semantic graph is the vocabulary of human↔AI collaboration: both actors select,
  discuss, and operate at semantic level; the system resolves down to graph mutations.

### FR-J: Direct shape editing `[DECIDED 2026-07-18]` — pruned to the sheet-metal set
- J1. v2 direct manipulation is limited to what sheet-metal manufacturing needs, and every
  one of these is a graph operation (replayable per B2 — v1's direct edits were a
  source-of-truth leak, bug: L2):
  - fuse panels (tool: fuse_bodies)
  - merge with bend (tool: merge_bodies_with_bend)
  - split by bends (tool: split_body_by_bends)
  - create holes/cuts (tool: add_cut / cut_bodies)
  - split part by plane (tool: split_body_by_plane)
  - translate shapes (tool: translate_body)
  - build/edit the manufacturing graph itself (which is expressed through the above)
- J2. CUT: general CAD verbs with no sheet-metal job — fillet/chamfer/offset/sew/
  delete_face/extend_face_to_target/rotate/scale/mirror/align/trim as free-standing
  tools. (If a surviving job needs one internally — e.g., reliefs need corner geometry —
  it becomes an internal function, not an MCP tool.)

### FR-K: Direct manufacturing-graph editing `[NEW 2026-07-18, generalized same day]`
It must be possible to **directly edit any part of the manufacturing graph**, CRUD-style
(Pivot 1: geometry is never edited; the graph is). Every edit is a replayable graph
mutation (B2), propagated to 3D, flat pattern, and drawings by the single geometric
model (N2):
- K1. **Full CRUD over graph entities** — create/read/update/delete any node or
  attribute: panels, bends (angle, radius, K-factor), holes/cutouts, outline edges,
  flanges, semantic entities, material/thickness parameters — subject to graph schema
  invariants. Deletes respect referential integrity: removing an entity that others
  depend on (e.g., a panel referenced by a bend) requires an explicit cascade choice,
  never a silent one.
- K2. **Outline editing verbs** (K1 applied at edge level, named because they are the
  primary interactive edits): add holes (against the panel datum, optionally semantic per
  FR-I2); move edge (resize — adjacent edges extend/trim); smooth edge (redraw the
  outline between two chosen points as a smoothed curve).
- K3. **The drawing is an editing surface.** Some engineers are most comfortable working
  with the drawing — since drawings and flat patterns are projections of the graph
  (FR-G1, 07-engineering-drawings.md), an edit made "on the drawing" is graph CRUD
  expressed through that view: the mutation lands in the graph and the drawing
  regenerates. (The drawing is still never a hand-edited document — the editing surface
  is bidirectional, the artifact remains derived.)
- K4. Edits are validated against manufacturing constraints (FR-F: min flange, bend-zone
  clearance, min hole-to-edge) — violations are typed errors, not silent clamps (N5).
- K5. `[DECIDED 2026-07-18]` **Edits do not propagate to neighbor panels.** An edit
  applies to the edited panel only — including on a bend/seam edge shared with a
  neighbor. If the change results in a conflict in the 3D assembly (seam mismatch, gap,
  overlap, clash), the system **highlights that error**: a typed validation finding
  (FR-F/N4) anchored to the conflicting entities, visible in the 3D view and on the
  drawing. Consequences: the working graph may legitimately hold a flagged-inconsistent
  state (validation is a reporting pass, not a mutation gate); outstanding conflict
  findings appear in the B5c change review, where merge acceptance can be gated on them.
- K6. `[ADDED 2026-07-19]` **Semantic-graph CRUD, including associations.** The CRUD
  surface covers the semantic layer fully: create/update/delete semantic entities
  **and their associations** — add, remove, and update anchors (node / region /
  feature-set, per I3a–d) with their roles; **re-anchor** a stale entity (I3e) to new
  geometry. Every association change is a replayable graph mutation (B2), appears in
  the action log (N12) and in B5c diffs, and a stale-anchor finding's
  `recommendedFix` (F4), where determinable, is exactly such a re-anchor call.

## 3. Non-functional requirements

- N1. **Determinism:** same graph + same inputs → identical geometry, bit-stable within a
  stated tolerance; no wall-clock, no iteration-order dependence. (v1 Constitution I)
- N2. **One geometric solution:** all 2D/3D facts (frames, flat patterns, DXF, mappings,
  drawing dimensions) derive from the single geometric model of the completed graph
  pivot; parallel solvers and per-case fallback paths are prohibited. (bug: L1)
- N3. **Numerical policy:** central units/tolerance/winding module; no inline tolerance
  literals in geometry code. (bug: L5)
- N4. **Error taxonomy:** every failure is a typed code with {message, recoverable,
  suggestedTool}-class structure at the MCP boundary; raw kernel errors never escape the
  adapter. (v1 Constitution VI; bug: L6)
- N5. **No silent fallbacks:** unrepresentable/out-of-scope cases fail loudly with a typed
  error. (v1 Constitution X; bug: L3)
- N6. **Observability:** every pipeline stage can emit inspectable intermediates (graph
  JSON, DXF, mesh) behind a debug flag; structured traces per operation. (bug: L9)
- N7. **Testability:** strong oracles are part of the definition of done — position probes
  and round-trip residual budgets, not bbox/volume. Real asymmetric fixtures required in
  the acceptance suite. (bug: L4)
- N8. **Enforced boundaries:** layering and kernel isolation are lint-enforced in CI, not
  convention. (bug: L6, L10; detail in 04-architecture-principles.md)
- N9. **Performance `[DECIDED 2026-07-19]` — split budgets:** general interactive
  editing completes in **< 1 s**; heavy operations (split-by-bends / manufacturing-graph
  build, nesting layout, export) may be much slower and run as async jobs — for these,
  **accuracy takes precedence over performance** (never trade tolerance for time; N11
  budgets are inviolable).
  - N9a. `[ADDED 2026-07-20, Paul]` **"Async" is a protocol shape, not permission to
    ignore wait time.** For import specifically (16-kernel-port.md OPEN-16.1): "the
    user is probably going to wait before doing anything else, so wait times still
    need to be reasonable." Async heavy-op jobs must report meaningful, granular
    `progress` (15 §1) rather than a bare queued→running→done — the realistic usage
    pattern is a human watching the job, not walking away. This does not relax
    "accuracy over performance" above; it means reasonable engineering effort toward
    latency (parallelizing independent work, incremental construction) is expected
    *within* the accuracy budget, not waived because a call happens to be async.
- N10. **Deployment `[DECIDED 2026-07-19]`:** the end goal is cloud deployment, so v2
  must ship Docker components and stay containerizable by design (no host-coupled
  assumptions). But not during the initial dev build — the dev environment is
  resource-constrained, so native local runs are the initial mode; Docker becomes the
  standard deploy once maturity is reached.
- N11. **Project tolerance profiles `[DECIDED 2026-07-18]`:** accuracy requirements are
  project-dependent and modeled explicitly — each project carries a tolerance profile
  (mapping round-trip budget, drawing dimension precision, kerf class, fit clearances).
  Accuracy-sensitive operations and validations read the active profile; nothing
  hardcodes an accuracy number. Acceptance tests run parametrized by profile. (Distinct
  from N3's *internal* numerical policy — epsilons and winding stay non-configurable.)
- N12. **Shared human/AI action log `[DECIDED 2026-07-18]`:** the human user and the AI
  are collaborators using the same tools and controls. Every action — regardless of actor
  — is the same graph operation, recorded in one ordered, actor-attributed action log
  that both can read as context. No UI-private mutation paths, no agent-private ones.
- N13. **Cross-bridge memory & resource management `[NEW 2026-07-18]`:** wherever the
  solution crosses a language bridge (v1: TS↔C++ via NAPI), memory leaks are a
  first-order concern. Native resources (B-Rep shapes, meshes, kernel sessions) must
  have deterministic ownership and lifetime: explicit handle lifecycle (acquire/release
  or scope-bound), never reliance on GC finalizers for native memory, and handle counts
  observable per session (ties into N6). Because the server is long-lived (human + AI
  collaborate over long sessions, B5 branches stay open), slow leaks are product bugs:
  CI includes soak/endurance tests that run thousands of graph operations and assert
  bounded RSS and native-handle counts.

## 4. Explicit non-goals (draft — to ratify)
- NG1. `[DECIDED 2026-07-18]` Curved bends are supported **only through the manufacturing
  graph** (a curved-bend node type with graph-driven unfold), never via direct shell
  reconstruction tools. `reconstruct_curved_bends` as a standalone 3D-analysis tool is cut.
- NG2. `[DECIDED 2026-07-18]` Real-time co-editing (locking, CRDTs, live cursors) is a
  non-goal; concurrent users are served by branching + merge + review (B5). Session
  runtime remains single-writer per branch.
- NG3. Cloud geometry backends (Onshape/Fusion adapters) unless a consumer exists.
- NG4. `[DECIDED 2026-07-19]` Bending scope = **all standard approaches to bending
  custom parts** (notched/relieved bends, rolled bends); features specific to
  high-tonnage press dies (coining, stamping-class forming) are out of scope —
  consistent with the developable boundary (C5). (13 §10 D2.)
