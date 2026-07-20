# 05 — Open Questions (the grill)

Ordered by how much the answer constrains everything downstream. `[OPEN-n]` tags are
referenced from the other docs.

## Tier 1 — product frame (blocks requirements sign-off)

- ~~**OPEN-2 Product scope.**~~ **ANSWERED 2026-07-18: Folding core first.** Graph +
  decompose/merge/unfold + exact 2D↔3D mapping is the core; nesting/export are satellites.
- ~~**OPEN-3 Consumers.**~~ **ANSWERED 2026-07-18: Both paths are real** — agent-driven
  and direct front-end → MCP. Contract must serve both. Spawned **OPEN-21**: enumerate
  which jobs are UI-direct vs agent-mediated (drives latency budgets and result shapes).
- ~~**OPEN-11 Usage evidence.**~~ **ANSWERED 2026-07-18:** cannot be made scientific —
  the core problem was never solved, so usage never stabilized; anecdote is accepted.
  Front end: `C:\Projects\Form.AI.tion` (Flutter; audited, see 03-jobs-to-be-done.md §1).
  Scope authority instead = the **two foundational pivots** (02-requirements.md §0):
  (1) imported shape becomes the manufacturing graph — sole source of truth, producing
  the 3D object and engineering drawings; (2) the semantic graph is first-class —
  parts-of-parts, gaps and holes, representing the engineering that solves a problem.
- ~~**OPEN-1/4/5/6 Cut list.**~~ **ANSWERED 2026-07-18:** Assembly CUT by default.
  Semantic layer KEPT as a distinct concept but living inside the manufacturing graph,
  referencing panels in a part. Direct editing pruned to the sheet-metal set (fuse panels,
  merge with bend, split by bends, holes/cuts, split by plane, translate, graph building).
  Curved bends only via the manufacturing graph. Details in 02-requirements.md FR-H/I/J, NG1.

## Tier 2 — architecture-shaping (blocks interface design)

- ~~**OPEN-14 Placement model.**~~ **DESIGN DRAFTED 2026-07-19** —
  [13-translation-module-design.md](13-translation-module-design.md): fold forest with
  exact shared fold-line segments, one tree walk producing (Flat SE(2), Pose SE(3))
  pairs per panel, zones = bend allowance strips with cylindrical development, seams
  checked-not-driven, mapping total over panels+zones, pure function of
  (graph, profile). Walked against all 22 inventory rows; 5 open design points (D1–D5)
  flagged. **Awaiting Paul's careful review** (his stated requirement).
- ~~**OPEN-10 Persistence & concurrency.**~~ **ANSWERED 2026-07-18:** durability is the
  eventual requirement (v1 never reached it — system never stable); multi-user is
  naturally handled through **branching and merging with review functionality**. Encoded
  as B5/B6 + NG2 in 02-requirements.md and P2 in 04-architecture-principles.md: history
  is version-control-shaped; graph serialization-ready from day one; real-time co-editing
  is a non-goal.
- **OPEN-16 Greenfield vs. strangler / kernel reuse.** **DEFERRED 2026-07-18 by Paul:**
  decide later, based on the finished requirements. Explicitly: do NOT design the C++/TS
  kernel interface now — port definitions stay language- and kernel-agnostic until this
  is decided in Phase 3 — stack selection, which now precedes the enforcement machinery
  (affects 06-plan.md Phase 2.4/4.3).
- ~~**OPEN-21 UI-direct vs agent-mediated.**~~ **ANSWERED 2026-07-18:** human and AI are
  collaborators — same tools, same controls, both actors' actions in one shared context
  (N12). Mutation surface is unified; only read-side projections differ per consumer
  (03-jobs-to-be-done.md §3.1).
- ~~**OPEN-12 Tool surface budget.**~~ **ANSWERED 2026-07-18:** smaller surface agreed
  (~6 families, see 03-jobs-to-be-done.md §3.2) — and, given how hard the core was to
  stabilize, the graph-mutate core is **built, reviewed, and thoroughly tested first**,
  before any other family gets more than a stub.
- ~~**OPEN-13 Resources.**~~ **ANSWERED 2026-07-19:** v1's resources were mostly
  config-backed project defaults/capabilities (tooling, materials/K-factor, rules,
  logistics, intent); the graph was never a resource (query tool only; geometry://
  was a stub). v2 resolution — **two resource namespaces**: (a) project
  profiles/capabilities (incl. N11 tolerance profiles), (b) **graph projections** —
  including the **full manufacturing graph** (B3a; the UI must render it entirely —
  only partially completed in v1) plus derived views (topology, flat pattern, drawings,
  mesh, action log, history). Rule: mutate = tool; read = resource.
- ~~**OPEN-22 Engineering drawing spec.**~~ **AGREED 2026-07-18** (only touched on in the
  v1 trial) — drafted as [07-engineering-drawings.md](07-engineering-drawings.md).
  Its spawned questions, resolved 2026-07-19 (see 07 §6): OPEN-23 — drawings are
  **resources** and for some users the **primary UI** (production pack = bundled
  snapshot of the same projections); OPEN-25 — align with best-practice drawing
  standards (ISO 128/129 family default; exact set = Phase 2 research); OPEN-26 —
  generated **on demand** (lazy + content-addressed cache, B7 corollary).
  OPEN-24 — **ANSWERED 2026-07-19 after elaboration: mixed** (baseline from the panel
  datum for outline/bends/holes; chain only within semantic patterns where spacing is
  the intent) with **auto-generated dimensions + engineer curation stored as graph
  metadata** (survives regeneration; rides branches). **All spawned drawing questions
  now closed.**

## Tier 3 — requirements detail (blocks acceptance criteria)

- ~~**OPEN-7 Performance budgets.**~~ **ANSWERED 2026-07-19:** split budgets — general
  interactive editing < 1 s; heavy ops (split-by-bends / graph build, nesting layout)
  may be much slower, run as async jobs, and there **accuracy beats performance**.
  Encoded as N9.
- ~~**OPEN-8 Deployment reality.**~~ **ANSWERED 2026-07-19:** cloud is the end goal —
  Docker components required, containerizable by design — but NOT during the initial dev
  build (resource-constrained dev environment); Docker becomes the standard deploy once
  maturity is reached. Encoded as N10.
- ~~**OPEN-9 Geometry scope edges.**~~ **ANSWERED 2026-07-18:** curved bends IN for the
  initial version; arbitrarily oriented (non-axis-aligned) flat panels are core; rolled
  sections committed but may come later. Encoded as C5 in 02-requirements.md, including
  the **ratified** boundary: v2's geometric scope is *developable surfaces* (anything
  that flattens without stretching; stamping/stretch-forming out of scope). Terminology note: "non-planar" originally meant curved panel surfaces —
  that territory is now covered by the curved-bend/rolled-section items.
- ~~**OPEN-17 Accuracy budget.**~~ **ANSWERED 2026-07-18:** accuracy requirements are
  project-dependent — modeled as per-project tolerance profiles (N11 in
  02-requirements.md); nothing hardcodes an accuracy number; acceptance tests run
  parametrized by profile.
- ~~**OPEN-18 Known unfinished v1 business.**~~ **ANSWERED 2026-07-18:** these are not
  edge cases — they are symptoms that the core functionality is still buggy and unusable,
  and are **the main motivation for the rebuild**. Consequence: the harvested v1 failure
  cases (cauldron pair (1,0), refold-2-solids class, chained/corner merges) form the
  *core correctness suite* — the definition of rebuild success, first-class in Phase 1's
  test harvest and gating Phase 5 slice 5 (post-reorder; see 09 §1.5 direction layering).
- **OPEN-15 Graph migration.** **NARROWED 2026-07-19 by Paul's working model:** the
  working state shown to a user always comes from a **single checkout** — never a blend
  of branches — *except* when a change merge is being evaluated (B5c compare view).
  Consequence: migration reduces to migrate-on-checkout (a branch is upgraded when
  checked out), and the only cross-version surface is merge evaluation, which must
  either require both sides schema-aligned first or refuse with a typed error.
  Mechanics settled in Phase 3 against Dolt's schema-diff/merge behavior.
- ~~**OPEN-27**~~ **ANSWERED 2026-07-18:** no propagation — an edit applies to the edited
  panel only; if the change results in a conflict in the 3D assembly, the system
  highlights that error (typed validation finding anchored to the conflicting entities).
  Encoded as K5 in 02-requirements.md: working graph may hold flagged-inconsistent
  states; conflicts surface in the B5c change review.

## Tier 4 — process

- ~~**OPEN-19 Test harvest scope.**~~ **ANSWERED 2026-07-19: ALL tests must be
  harvested** — not the strong-oracle subset only. Weak-oracle tests are harvested with
  their oracles *upgraded* to the O1–O4 standard (L4 still holds — nothing ships with a
  bbox-only assert), and the v2 stack additionally needs its own layered tests
  (unit/property/integration) beneath the acceptance suite. 09 §3 revised accordingly.
- ~~**OPEN-20 What stays behind.**~~ **ANSWERED 2026-07-19 — references, not verbatim:**
  (a) the **split-by-bends algorithm incl. remove_protrusions** — a lot of time went
  into its robustness; take as a strong reference, adjusted to the new manufacturing
  graph; (b) the **DXF writer** — good reference, needs graph alignment; (c) the **OCCT
  healing pipeline on load changes**: import now bootstraps a full manufacturing graph
  (heal → split-by-bends → classify adjacent panels → fuse/merge) per A4 — prior art
  found in-tree (`ts/src/manufacturing/graph/bootstrap.ts`) plus the unmerged
  `origin/010-build-manufacturing-plan` branch (joint prioritization).
