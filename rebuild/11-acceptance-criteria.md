# 11 — Acceptance Criteria (Phase 1.2)

**Status:** Draft for Paul's review. Companion to [02-requirements.md](02-requirements.md)
(the decision record). Every criterion is measurable, names its oracle
(O1–O4, [09](09-core-correctness-suite.md) §1), and cites the suite tier/case
([08](08-case-inventory.md)) or CI gate that enforces it. `ε` always means the active
project tolerance profile's budget (N11) — no criterion hardcodes a number.

Conventions: **AC-x.y** = acceptance criterion; *Gate:* CI mechanism if not a suite case.

---

## FR-A Ingest

- **AC-A.1** Importing each fixture (`testcube.step`, `braai.step`, `cauldron.step`)
  produces a manufacturing graph with the expected panel/bend node counts (recorded per
  fixture when the v1 driver first runs), where every panel carries a frame + outline
  from the single derivation (O3 identity between frame ring and stored outline).
- **AC-A.2** (A4 bootstrap) The imported graph is *connected and workable from the
  onset*: adjacent coplanar panels are fused, angled adjacencies carry bend nodes with
  dihedral-derived angles (±ε_angle); no orphan panels for the reference fixtures.
- **AC-A.3** replay(imported graph) reproduces the imported solid: O1 probes on ≥3
  non-collinear reference points per panel within ε; volume within ε_vol as smoke only.
- **AC-A.4** Non-manifold/unhealable input → typed error (N4 schema), **no partial
  graph persisted**; the store shows no new nodes (O4).
- **AC-A.5** (A3) Any verb invoked without an explicit part reference → typed error;
  there is no active-part fallback (contract test over every tool schema).

## FR-B Graph core, history, store

- **AC-B.1** (B2, P2 harness) **Every** mutating verb in the suite is wrapped:
  execute → serialize → replay from empty → O1 probe equivalence within ε. Coverage
  criterion: 100% of mutating verbs in the v2 contract appear ≥1× under the harness;
  a verb with zero harness coverage fails CI (gate).
- **AC-B.2** (B3a) The full-graph resource returns every node and edge, including
  semantic entities, validation findings, and state flags: schema-complete
  (contract-validated) and equal to the stored graph (deep compare) for every suite
  fixture. The UI renders from this resource alone — no auxiliary graph API exists
  (gate: contract review + boundary lint).
- **AC-B.3** (B5a/b) commit returns a version ID; view_at_commit(v) + replay
  reproduces v's geometry bit-stably per N1; restore(v) then replay ≡ v (O1 within ε).
- **AC-B.4** (B5c) For a scripted edit sequence with known deltas, diff(v₁,v₂) lists
  exactly the added/updated/removed nodes — no more, no less (O4); drawing diff lists
  exactly the dimensions whose values changed (O3).
- **AC-B.5** (B5d) Uncommitted mutations discard cleanly: mutate → rollback →
  state ≡ last commit (O1 + deep graph compare). No transaction API exists in the
  contract (gate: contract review).
- **AC-B.6** (B5e) All reads within a session resolve against one checkout; the only
  API accepting two versions is the compare/diff surface (gate: contract review).
- **AC-B.7** (B6/B7) serialize→deserialize round-trips to a canonical byte-stable form;
  node IDs stable across sessions and across branch/merge (tested by committing,
  branching, merging a no-op, re-reading).
- **AC-B.8** (B7) Store-level: schema is row-per-node/edge with stable primary keys —
  a single node update produces a Dolt diff touching only that node's rows (O4;
  validates diffability-by-design). Interactive mutation persisted < 1 s (N9, measured
  p95 on reference dev machine).

## FR-C Decomposition & bend model

- **AC-C.1** (C1) The single decomposition verb accepts a strategy parameter and
  produces, for each reference fixture, the recorded expected decomposition
  (panel/bend counts, adjacency map). Protrusions are tracked: remove_protrusions on
  the protrusion fixtures yields the recorded panel set (O1 probes on survivors).
- **AC-C.2** (C3) Bend allowance: for the closure-family allowance variant
  (C22-b, 08 §3.1), strips sized by the K-factor formula close within ε — closure IS
  the bend-math oracle. Analytic spot-checks: computed flat length equals the textbook
  bend-allowance value for ≥3 (angle, radius, K) triples to ε_len.
- **AC-C.3** (C5 orientation) Every T0–T3 case also runs under ≥3 random rigid
  transforms of its input; all oracles invariant (same residuals within ε). No test
  may assume axis alignment (gate: suite review checklist).

## FR-D Composition (merge/fuse/chains)

- **AC-D.1** (D1) Two-panel merge at angles {90°, acute, obtuse, inverted}: O1 probes
  on panel B's far corners within ε (tier T1). Includes the red case: cauldron pair
  (1,0) — **green required** (C05).
- **AC-D.2** (D2) Straight chains N∈{3..9}: polygon closure family fully green —
  closure residual ≤ ε at every partial-loop checkpoint and at final closure, both
  bend directions, all pose sweeps (T2/C22).
- **AC-D.3** (D2) Corner chains and fold trees: net closure family green — all 11 cube
  nets + tetrahedron/pyramid nets close at every unglued edge pair within ε (T3 +
  08 §3.2). *Gate (P3):* no fallback/parallel path exists in the composition code —
  one solver for all of T1–T3 (boundary lint + review rule).
- **AC-D.4** (D2) Multi-lobed composites: the refold-2-solids class produces exactly
  one solid (O4) with O1 probe placement — including v1's residual red case (C08).
- **AC-D.5** (D3) fuse/cut preserve orientation and lineage: probe-based fuse cases
  from T3 green; graph lineage after boolean names the source nodes (O4).
- **AC-D.6** Full-cauldron fidelity (C13): all 6 bbox bounds of the fully-merged part
  within ε of ground truth — v1's last-bound ~167 mm defect resolved.

## FR-E Part construction & mapping

- **AC-E.1** (E1) Forms are constructed from the graph alone: the construction path
  makes no shell-analysis kernel calls (gate: kernel-port capability audit — the
  construct operation's port surface simply lacks them, P3/L6).
- **AC-E.2** (E2) map_2d_to_3d ∘ map_3d_to_2d ≡ id within ε for a grid of ≥100 points
  per panel across all T0–T3 cases; **cumulative** error over an N-bend chain stays
  within ε (measured by the closure families — not per-bend budgets that stack).
- **AC-E.3** (E3) `[refined 2026-07-19 per Paul; terminology aligned 2026-07-20 —
  "region" = a panel's flat/folded area, "bridge" = a bend's, per 13/14]` The
  flat-pattern outline and the panel frame both come from the translation module,
  and **the only permitted difference between them is the bend-radii modeling**:
  (a) outside bend bridges, the outline vertices are O3-identical (byte-equal) to
  the frame ring; (b) within a bridge, the deviation equals the analytic
  bend-allowance expansion for that bend's (angle, radius, K-factor) within ε_len —
  never an arbitrary tolerance; (c) any discrepancy not attributable to a declared
  bridge is a failure (single derivation, L1 dead).
- **AC-E.4** (13 §3.3) `[added 2026-07-20 per Paul]` For every region panel in every
  suite fixture: `regionOf(p)`'s outer ring and hole rings are non-empty ordered
  point arrays with correct winding (O3, 12-domain-notes §2); `bottomFace(p)` and
  `topFace(p)` have equal length and pointwise correspondence to `regionOf(p)`'s
  rings; `|topFace(p)[i] − bottomFace(p)[i]|` equals the part's thickness `t` exactly
  for every `i` (O1, zero-reference — it's a direct arithmetic check, not a
  tolerance-budgeted measurement); the local-offset-then-pose and
  pose-then-world-offset derivations of `topFace` agree to machine precision.
- **AC-E.5** (16-kernel-port.md Port D) `[added 2026-07-20 per Paul: "agree that
  port D shouldn't fail"]` Port D (solid construction: thicken each region, stitch
  side walls, join along shared hinge material) **never returns a failure** for any
  well-formed graph in the case inventory (08) — run once a suite driver exists
  against a real kernel adapter. This is a stronger claim than "no errors expected in
  practice": Port D's inputs are 13 §3.3's exact, already-correct point arrays over
  regions that share exact boundary material by construction (14 §0), so there is no
  legitimate input state that should produce a kernel-side construction failure. A
  failure here indicates a bug upstream (in 13's derivation, or in a graph edit that
  produced a malformed-but-undetected outline), never a normal Port D outcome to be
  handled with a typed error and moved on from — O4 (structural), zero tolerance for
  a failure count above zero across the full case inventory.

## FR-F Validation

- **AC-F.1** Validation findings are typed (N4 schema), anchored to graph entities,
  and **reproducible**: same graph+profile → identical findings set (N1).
- **AC-F.2** Rule values come from resources/profiles: changing the profile changes
  the finding outcome for a boundary-straddling fixture (loose passes, tight flags).
- **AC-F.3** (K4/K5, C19) A seam-edge edit creating a 3D conflict yields a conflict
  finding anchored to both entities, visible in the full-graph resource; the edit
  itself is **not** blocked, and no geometry is silently clamped (O4; N5).
- **AC-F.4** validate_bend_sequence on the recorded fixtures returns the recorded
  feasible sequence; an infeasible (self-colliding) fixture yields a typed
  infeasibility finding, not a crash.
- **AC-F.5** check_clearance on a known-gap fixture reports the gap within ε; on an
  interpenetrating fixture reports the clash pair (O4).
- **AC-F.6** (F4) `[added 2026-07-19]` Every finding either carries a
  `recommendedFix {tool, params}` or an explicit no-auto-fix marker (contract-schema
  gate — the field is required, never absent). The fix parameters must be concrete and
  complete: replaying them requires no inference (contract test: params validate
  against the recommended tool's schema).
- **AC-F.7** (F4) `[strengthened 2026-07-19 per Paul]` **Fix-application harness,
  suite-wide:** for **every** finding with a `recommendedFix` emitted by **any** suite
  case (not a curated subset), the harness applies the recommended fix verbatim and
  re-validates: the original violation must **no longer exist**, no new finding of the
  same class may appear, and the fixed graph must still satisfy the replay invariant
  (AC-B.1 runs on the post-fix state). A recommendation whose application fails, or
  fails to clear its finding, fails the suite — untested recommendations cannot exist.

## FR-G Production output

- **AC-G.1** (G1, 07 §5) Same graph version + profile → **byte-identical**
  DrawingModel. Every dimension value equals the translation-module-computed value
  (O3); provenance (graph version, branch, profile) present on every drawing (O4).
- **AC-G.2** (07 OPEN-24) Dimensions are baseline-from-datum except within semantic
  patterns (chained pitch); curation edits persist as graph metadata and survive
  regeneration and branch/merge (scripted case).
- **AC-G.3** Drawings serve on demand: reading the drawing resource of an
  never-before-drawn component generates it; second read hits the version-keyed cache
  (observable via N6 trace, not by behavior differences).
- **AC-G.4** (G2) Nesting consumes graph-derived flat patterns directly (no
  unfold-id parameter exists — contract gate); output layout has zero part overlaps
  (O3 polygon check) and reports utilization.
- **AC-G.5** (G3) export_production_pack runs under the uniform job API: status
  transitions queued→running→done observable; the pack contains drawings + DXF + BOM
  for **every** component in the graph (O4 completeness).

## FR-I Semantic graph

- **AC-I.1** Semantic entities (incl. gaps and holes) are graph nodes: CRUD through
  the same K1 surface, present in the full-graph resource, replayed by B2 harness.
- **AC-I.2** Anchoring integrity: deleting a panel referenced by a semantic entity
  requires an explicit cascade choice; silent orphaning is impossible (O4 typed error).
- **AC-I.3** Semantic callouts appear on drawings by their engineering names (07 §2);
  removing the semantic node removes the callout on regeneration (O3).
- **AC-I.4** (I3a/I3b) `[revised 2026-07-20 per the panel/region alignment, 14 §0]`
  A whole-panel anchor (I3a, `target_kind=panel`) resolves to exactly `regionOf(p)` —
  no separate computation exists for the whole-panel case (O3 against the
  translation module's region boundaries; O1 probes for the 3D surface). After a
  move-edge resize of `p`, the anchor still resolves — to `p`'s *new* region — with
  no re-authoring, since the anchor references `panel_id`, not a shape (O3). A
  genuine sub-panel anchor (I3b, an explicit polygon strictly smaller than
  `regionOf(p)`) resolves to that stored polygon, checked for containment within
  `p`'s current region.
- **AC-I.5** (I3d) The air-flow-cavity worked example runs as a suite case: one
  semantic entity anchoring a panel on part A, a region on part B, and a hole set,
  each with a role; the full-graph resource returns the entity with all anchors and
  roles intact across commit/branch/merge (O4).
- **AC-I.6** (I3e) Deleting an anchored hole via cascade (true material removal, not
  a merge — see AC-I.7) produces a typed stale-anchor finding on the semantic
  entity — the entity survives, nothing is silently dropped, and the finding appears
  in the B5c compare view (O4).
- **AC-I.7** (I3f, merge) `[added 2026-07-20]` Removing the bend between panels `P`
  (parent) and `Q` (child) — a merge, not a delete: `Q`'s row persists with
  `merged_into_panel_id = P` (O4, row-level check); an anchor that targeted `Q`
  before the merge resolves, after it, to `P`'s current region with **zero** stale
  findings generated (O4 — this is a negative assertion: the fix-application/finding
  harness must report no I3e finding for this scenario, distinguishing it from
  AC-I.6). Chained merges (`Q→P→R`) resolve correctly through the alias chain.
- **AC-I.8** (I3f, split) `[added 2026-07-20]` Adding a bend that splits panel `P`
  into (shrunk) `P` and new child `Q`: every I3a whole-panel anchor that existed on
  `P` before the split exists, independently, on **both** `P` and `Q` immediately
  after (O4 — exact `{sem_id, role}` set equality on both sides). Subsequently
  re-anchoring or removing an anchor on `Q` alone does not affect `P`'s copy, and
  vice versa (independence, O4). An I3b sub-panel region whose stored polygon is
  bisected by the new hinge produces a typed finding with a `recommendedFix` that
  repoints it to the correct containing panel when the polygon falls wholly on one
  side (O4/F4), and a non-auto-fixable finding when the hinge crosses the polygon
  itself.

## FR-K Direct graph editing

- **AC-K.1** Every graph entity type supports CRUD via the contract; every edit is
  replayable (inherits AC-B.1) and appears in the action log with actor attribution
  (N12; O4).
- **AC-K.2** add-hole / move-edge / smooth-edge each yield consistent regeneration:
  the edit is visible in 3D form, flat pattern, and drawing with O2/O3 agreement
  within ε (T5 cases, incl. C18/C19).
- **AC-K.3** (K3) An edit expressed in drawing-view coordinates lands as a graph
  mutation and the drawing regenerates — there is no drawing-document write path
  (gate: contract review).
- **AC-K.4** (K6) `[added 2026-07-19]` Association CRUD: anchors of every type
  (I3a–d) can be added, updated (incl. role changes), and removed via the contract;
  each such change is replayable (AC-B.1), action-logged with actor attribution
  (N12), and visible as a delta in B5c diffs (O4). **Re-anchoring resolves staleness:**
  applying a re-anchor to a stale entity (AC-I.6 scenario) clears the stale-anchor
  finding on re-validation — and where the re-anchor is determinable, it is offered as
  that finding's `recommendedFix`, exercised automatically by the fix-application
  harness (AC-F.7).

## NFR gates (CI, from Phase 4 machinery)

- **AC-N.1** (N1) Determinism: full suite run twice on one machine → identical
  outputs (hash-compared artifacts). Cross-platform variance ≤ ε.
- **AC-N.2** (N3) Lint: zero numeric tolerance literals outside the policy module;
  winding canonicalization property test (random polygons → CCW invariant).
- **AC-N.3** (N4/N5) Contract test: every tool's declared failure modes exhaustively
  match the error enum; grep-gate: no raw kernel error strings cross the adapter.
- **AC-N.4** (N6) Every operation emits a structured trace (op, params hash, graph
  delta, timings, residuals); every pipeline stage dumps a valid artifact under the
  debug flag (schema-validated).
- **AC-N.5** (N9) p95 interactive-verb latency < 1 s on the reference dev machine;
  heavy verbs are async-job-only in the contract (gate: contract review).
- **AC-N.6** (N13) Soak: ≥10,000 mixed graph operations → RSS bounded (≤ configured
  ceiling), native handle count returns to baseline after GC+release (CI gate).
- **AC-N.7** (N11) Running one boundary-straddling suite case under a loose vs tight
  profile flips its outcome accordingly — proves budgets are profile-driven.
- **AC-N.8** (P1) Boundary lint: an intentionally violating import in a scratch branch
  fails CI (tested once during Phase 4 bring-up, kept as a canary test).

---

## Traceability summary

| Requirement family | Criteria | Verified by |
|---|---|---|
| FR-A | AC-A.1–5 | Suite Level C (T0 import cases) + contract tests |
| FR-B | AC-B.1–8 | P2 harness (all tiers) + store tests + contract review |
| FR-C | AC-C.1–3 | T0/T2 + closure allowance variant + fixtures |
| FR-D | AC-D.1–6 | T1–T3 + closure/net families + red cases C05/C08/C13 |
| FR-E | AC-E.1–5 | T0–T3 O2/O3 + port audit (AC-E.5: kernel Port D, 16) |
| FR-F | AC-F.1–5 | Validation fixtures + C19 |
| FR-G | AC-G.1–5 | Drawing/nesting/export cases + contract gates |
| FR-I | AC-I.1–3 | Semantic cases (all tiers) |
| FR-K | AC-K.1–3 | T5 + action-log checks |
| NFR | AC-N.1–8 | CI gates (Phase 4) + profile-flip case |
