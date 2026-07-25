# 06 — Rebuild Plan (phased)

Stack selection deliberately comes after requirements, interface, and the placement model
— so the stack is chosen against real constraints instead of taste — but **before** the
SDLC/enforcement machinery (reordered 2026-07-18): lint-based enforcement of the
architecture requires the stack decision. (Paul has opinions on the stack; they get their
hearing in Phase 3 with requirements in hand.)

## Phase 0 — Frame (this folder) ✅ in progress
- Design docs 01–06 drafted.
- Paul answers Tier 1 questions in [05-open-questions.md](05-open-questions.md); docs
  updated; `[PROPOSAL]` tags ratified or amended.
- **Exit:** product scope + consumers agreed; cut-list gut calls recorded.

## Phase 1 — Evidence extraction from v1
*(Status 2026-07-19: 1.1 ✅ 10-tool-triage.md; 1.2 ✅ 11-acceptance-criteria.md;
1.3 ✅ suite/ — schema, 42 generated closure cases, net case, T0/T1 harvest, red cases
C05/C08/C13 as sweeps; v1 driver 50/50 green as a consistent characterization ledger,
3 real v1 defects found along the way; 1.4 ✅ 08-case-inventory.md + 12-domain-notes.md.
**Phase 1 exit criteria met** — remaining suite work (harness middlewares, v2 driver,
remaining cube nets, allowance variant) belongs to Phases 2/5.)*
1. **Tool-surface triage** (usage audit resolved 2026-07-18 as non-scientific — see
   03-jobs-to-be-done.md §1): per-tool KEEP/MERGE/DEMOTE/CUT verdicts justified by the
   two foundational pivots (02-requirements.md §0) and the job map, with rationale
   recorded.
2. **Requirements hardening:** each FR with acceptance criteria
   (tolerance-profile-relative accuracy, error behavior) → drafted as
   11-acceptance-criteria.md (02-requirements.md stays the decision record). Includes
   the engineering-drawing spec (OPEN-22 → 07, all sub-questions closed).
3. **Test harvest → core correctness suite:** harvest **all** v1 tests (OPEN-19
   decision) + real fixtures (cauldron.step class) into a standalone,
   implementation-agnostic acceptance suite ("given graph/STEP in → assert
   positions/residuals/DXF out"), upgrading weak oracles to the O1–O4 standard during
   translation.
   Per OPEN-18: v1's unresolved failures (cauldron pair (1,0), refold-2-solids, chained/
   corner merges) are not edge cases — they are the *definition of rebuild success* and
   sit at the center of this suite, gating Phase 5 slice 5 (they require imported
   geometry; the authored closure families gate the earlier slices).
4. **Domain-knowledge capture:** the bend math, K-factor handling, winding/tolerance
   rules, and placement edge-case inventory (straight/corner/multi-lobed/protrusion)
   written up as domain notes — the stuff currently living in code, memory, and Paul's
   head.
- **Exit:** v2 scope frozen; acceptance suite runs (red) against a stub.

## Phase 2 — Interface & domain model design ✅ COMPLETE (2026-07-20)
1. ✅ **Placement/fold representation design** (OPEN-14) — 13-translation-module-design.md,
   reviewed & approved, validated against the full edge-case inventory (08).
2. ✅ **Manufacturing graph schema v2** — 14-graph-schema.md, reviewed & approved,
   incl. branch/merge/review semantics (B5) and day-one serializability (B6).
3. ✅ **MCP contract v2** — 15-mcp-contract.md, reviewed & approved: 21 mutating
   tools, resources, error taxonomy, uniform job API, authored as a versioned
   artifact.
4. ✅ **Port definitions** — 16-kernel-port.md, a language/kernel-agnostic capability
   list (7 ports, HEAVY vs LIGHT), open points resolved. Per Paul (2026-07-18): no
   C++/TS interface design until the repo/kernel decision (OPEN-16, still deferred to
   Phase 3 — this doc is exactly the input that decision needs). ✅ Numerical policy
   module spec — 17-numerical-policy.md.
- **Exit:** ✅ contract + schemas reviewed (13/14/15 approved); ✅ acceptance suite
  reconciled against the v2 contract (suite/schema.md, 2026-07-20 — documents the
  concrete v1→v2 op mapping per case, including where A4's auto-bootstrap collapses
  several v1-era explicit steps into no-ops for a v2 driver). Suite *implementation*
  against the v2 contract (an actual v2 driver) remains Phase 5 work, as planned.

## Phase 3 — Stack selection (Paul's opinions, now with constraints)
*(Moved ahead of enforcement 2026-07-18: lint rules require a chosen stack.)*
- Candidates evaluated against: kernel reuse-vs-replace (OPEN-16), performance budgets
  (OPEN-7), deployment (OPEN-8), lint/boundary tooling maturity (P1 enforcement — the
  stack must *support* mechanical boundary enforcement, or it fails selection),
  MCP SDK maturity, team fluency.
- **Graph store direction pre-decided (2026-07-18, B7): MySQL-compatible DB versioned
  with Dolt** — branch/merge/commit/diff native to the store; geometry generated on
  demand. This phase validates it against interactive write-latency budgets and settles
  the schema-migration-across-branches policy rather than reopening the choice.
- Decisions recorded as ADRs (kernel, orchestration language, graph store, lint stack).
- **Exit:** ✅ ADRs merged (2026-07-21) — see
  [19-cpp-ts-interface-boundary.md](19-cpp-ts-interface-boundary.md): stack stays
  C++/TS (ADR-1/2/3), interface binding shape + ownership decided (ADR-4 groundwork,
  pending Phase 4 lint tooling to enforce it). Graph store (B7, Dolt) stands as
  previously decided. **Phase 3 complete.**

## Phase 4 — SDLC & enforcement machinery (in the chosen stack)
1. Constitution v2 via `speckit-constitution` (principles + enforcement column from
   04-architecture-principles.md).
2. CI gates implemented in the chosen stack's tooling: boundary lint, complexity budgets,
   tolerance-literal ban, replay-invariant harness, acceptance suite, kernel test tier,
   and a native-resource soak gate (N13: bounded RSS + handle counts over thousands of
   graph operations — required because the solution crosses language bridges).
3. Repo scaffold per the Phase 3 OPEN-16 ADR, with the lint rules live from commit one —
   enforced on empty code is cheap; retrofitted is not.
- **Exit:** an empty-but-enforced skeleton where a violating import fails CI.

## Phase 5 — Build (spec-kit cycles, thin vertical slices)
Order chosen so the riskiest invariants are proven earliest — per Paul (2026-07-18), the
graph-mutate core (the part v1 could never stabilize) is built, reviewed, and thoroughly
tested before any other tool family gets more than a stub:
*(Reordered 2026-07-18 per the direction-layering insight (09 §1.5): graph-authored,
forward-only construction comes first — ingestion, which v1 led with, moves after the
core is proven.)*
1. Slice 1 (Level A): **graph-authored construction, forward-only** — author graphs
   directly as data, construct 3D + flat forms; replay-invariant harness live; polygon
   closure family (C22) green for single panels & chains.
2. Slice 2 (Level A): fold trees & perpendicular folds — net closure family green
   (cross→cube and the other 10 cube nets, 08 §3.2).
3. Slice 3 (Level B): inverse mapping + round-trip residuals on the same authored
   graphs (both directions now; suite tiers T0–T2 fully green).
4. Slice 4 (Level A/B): merge_bodies_with_bend & chains as *graph operations* on
   authored panels (T1–T3 authored cases; corner chains native, no fallbacks — P3).
5. Slice 5 (Level C): ingest STEP → graph (clean/heal/decompose/split). **v1's red
   cases go green here: C05 cauldron pair (1,0), C08 refold-2-solids, C13 cauldron
   bounds** — they need real imported geometry, which is why they gate this slice.
   *(Sub-sliced in practice as 5/5B/5C: import_part core, fixture-breadth test
   coverage, cauldron adjacent-pair merge coverage — the last of which found and
   fixed a real splitBodyByBends bug, see project memory.)*


6. **Slices 6+ REORDERED (2026-07-25, per Paul): the objective is MVP parity on v2 —
v1 is not usable and is being decommissioned, not maintained alongside v2. Ordering
is now driven by which of the approved 21-tool contract's (15) still-unbuilt tools
unblock the most real v1 test-coverage migration, not by risk-proving order.** Only
4 of 21 contract tools are built so far (`create_part`, `create_node`(bend-only),
`merge_bodies_with_bend`, `import_part`). A full inventory of v1's ~66
non-v2 integration test files (2026-07-25) found: 14 depend on `fuse_bodies`/
`remove_protrusions` (no v2 equivalent yet), 12 depend on unfold/DXF export
(`flat-pattern`/`drawings` resources, planned but unbuilt), ~10 depend on tools
**deliberately CUT** from v2 per 10-tool-triage.md (assembly family, `rotate_body`/
`scale_body`/`mirror_body`/`align_to_face`, `chamfer_edges`, generic
transaction primitives — B5d dissolves these into `commit`/`restore`) and should be
retired, not migrated; the rest is v1-only test infra/diagnostics or already
superseded by v2-native tests. Graph CRUD completion (`update_node`/`delete_node`/
`move_edge`/`smooth_edge`) is real and foundational but explicitly deprioritized
below fuse/protrusions and DXF export, per Paul: "prioritise reaching v1 parity on
the test coverage."

   6. **Slice 6 (Decompose & compose, 15 §4.2) — DONE (2026-07-25).** `fuse_bodies`:
   coplanar-only first cut (matches v1's dominant flange/tab-on-wall case; the
   footprint-CONTAINED "stacked patch" case v1 also supports — different plane,
   same normal — stays deferred), backed by a new general-purpose OCCT polygon
   union/difference primitive (`cpp/src/geometry/translation/polygon_boolean.*`,
   `FuseCoplanarParts` doing the anchor-relative transform + coplanarity check in
   C++ per constitution principle IV). `remove_protrusions` — REDESIGNED per Paul
   (no v2 Part has a backing OCCT shell to re-detect protrusions from, unlike v1):
   folded into `import_part` itself, which already runs `splitBodyByBends` and now
   extracts each detected protrusion into its own independent, simple v2 Part
   (`protrusion_part_ids` in the result) instead of a standalone tool. Real-fixture
   finding: `cube_with_flanges.stp`'s wall+flange pairs turned out to BE the
   deferred stacked-patch case (0/45 candidate pairs coplanar under the true 3D
   anchor check) — `fuse_bodies`' tests use hand-authored synthetic panels instead,
   following v1's own precedent for this exact in-scope case
   (`fuse_bodies_coplanar_orientation.integration.test.ts`'s second describe
   block). `testcube.step` (the only fixture with protrusions) independently
   refuses `import_part`'s main-panel reconciliation with `GE_DISCONNECTED_PIECES`
   for an unrelated, pre-existing reason, so the extraction mechanism itself is
   tested directly against real `splitBodyByBends` output rather than via a full
   `import_part` call. 20 new v2 integration tests, 8 new C++ unit tests, 0
   regressions (TS typecheck/lint clean; C++ ctest 121 total, same 2 pre-existing
   failures as before this slice).
   7. **Slice 7 (Derive & Validate resources, 15 §4.4) — DONE (2026-07-25),
   scoped to flat-pattern only.** map-2d-3d/map-3d-2d were already built in
   Slice 3; a fresh count of v1's non-v2 test files (not the earlier ~12
   estimate) found 26 depend on unfold/DXF export vs 0 on `get_drawings` and
   only 2 on validation/findings tools — so this slice implements
   `graph://part/{id}/flat-pattern` only, applying the same "unblock the most
   real test-coverage migration" rule Slice 6 used. `drawings` (07's D1-D5
   sheet set) and `findings` (validation-rule aggregation) are deferred to a
   later slice — 0 and 2 v1 files respectively don't justify their much
   larger design/build cost right now. Unlike v1's per-panel `get_unfold`
   (needs a `panel_id`), a v2 part's flat pattern is naturally ONE cut
   boundary — the part's own outline (14 §0: region panels are derived clips
   of it, not separate cut pieces) — so there's no per-panel DXF to
   reassemble; the resource returns that outline, one bend-line annotation
   per bend (from the bend's own stored hinge), and a DXF export built by a
   new, deliberately v1-independent serializer
   (`ts/src/v2/resources/dxf.ts` — pure string formatting, no geometric
   computation). 4 new v2 integration tests, 0 regressions.
   8. Slice 8: Graph CRUD completion — `update_node`, `delete_node`, `move_edge`,
   `smooth_edge` (15 §4.3) + a standalone `split_body_by_bends` tool (currently
   only reachable internally via `import_part`). `update_node(part, {anchor})` is
   the planned replacement for v1's `translate_body`.
   9. Slice 9: remaining Decompose & compose tools — `cut_panel`, `add_flange`,
   `generate_reliefs`, `rip_edge`, `close_gap` (v1's most FE-referenced tool, 10×),
   `split_body_by_plane`. `synthesize_joints` stays a placeholder (joint table
   intentionally undesigned, 14 D2.5) until specifically taken up.
   10. Slice 10: persistence/History — `commit`, `restore`, `branch`, `merge_branch`
    (15 §4.6, B5/B7 Dolt). `GraphStore` is in-memory-per-call only today — no
    real persistence exists yet; needed for v2 to be genuinely usable past a test
    run, not just testable.
   11. Slice 11: Produce — `simulate_nesting`, `export_production_pack`, `get_job`/
    async job protocol (15 §4.5). `import_part` is synchronous today; the
    contract specifies it as an async job with granular progress (N9a).
   12. Slice 12 (last, per Paul 2026-07-25): curved-bend nodes (initial-version scope
    per C5; covered on paper in Phase 2.1 — this slice proves it). Deliberately
    pushed behind the rest of the MVP tool surface rather than proven early.
- v1 retired once v2 reaches this MVP tool surface (not the full 21-tool contract
  necessarily — CUT items never block retirement) and the acceptance suite is
  green on v2.

## Risks
- **R1. Requirements nostalgia:** carrying v1 tools without justification. Mitigation:
  every KEEP verdict must cite a job under one of the two pivots; default verdict is CUT.
- **R2. Placement model under-design:** repeating L3 by picking a representation before
  enumerating cases. Mitigation: Phase 2.1 is paper-validated against the edge-case
  inventory, reviewed separately.
- **R3. Big-bang rebuild stall:** v2 grows in the dark while v1 rots. Mitigation:
  vertical slices each shippable behind the same MCP contract; acceptance suite as the
  finish line, v1 kept runnable as reference.
- **R4. Enforcement theater:** lint rules that exist but are advisory. Mitigation: gates
  are CI-blocking from the first commit (Phase 4 before Phase 5).
