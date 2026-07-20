# 01 — Lessons Learned from v1

Each lesson cites concrete v1 evidence, states the lesson, and derives the architectural
implication for v2. These implications are the raw material for the invariants in
[04-architecture-principles.md](04-architecture-principles.md).

---

## L1. The graph pivot was never completed — no single geometric solution was ever reached

**Evidence.** The pivot — imported shape *becomes* the manufacturing graph, and all
geometry flows from it — was adopted in principle but never completely implemented. In
its absence, geometric facts kept being re-derived from the 3D shell ad hoc:
`split_body_by_bends` populated `panelFrame` via one OCCT routine and `shapeDxf` via an
independent `unfoldShell` pass — two solutions to the same geometric question, agreeing
for rectangles, corrupting every 2D↔3D mapping for skewed quads. And the pattern
repeated: session after session, the AI's response to each failing case was to **create
another parallel solution** — a flat-pattern rebuild path *and* a live-3D fuse path, a
straight-chain model *and* a corner-chain fallback, per-case gates
(`compositeFarEdgeDegenerate`, `priorBendDirAligned`) arbitrating between them. Each
patch stabilized one case and destabilized the whole; the core never converged.

**Lesson.** This is a geometric problem, and it demands a **single geometric solution
that solves all situations** — all panel shapes, all chain topologies, all placements.
The instability was not bad luck or hard geometry; it was the accumulation of partial
solutions where one complete solution was required. Two routines answering the same
geometric question is not a redundancy problem — it is proof the real solution doesn't
exist yet.

**Lesson (complexity).** This is a complex problem that requires a complex solution.
The AI assistant kept simplifying the problem with shortcuts and hacks — compensating
offsets (`seamYOffset` corrections, anchor W+H shifts, `bHingeOffsetMm` pivot fixes,
"plausibility checks" on offset values) and assumptions of alignment at the end of an
operation — where a **direct 3D geometric mapping** would work in all situations. Every
compensating constant was an admission that the mapping in use was not the true one; the
shortcuts only ever approximated the real solution case by case, and each approximation
became the next session's bug. The complexity has to live *in the geometric model*, not
be wished away around it.

**Implication for v2.** Complete the pivot. The manufacturing graph, backed by one
geometric model (the OPEN-14 translation module), is the *only* solver: every frame,
flat pattern, DXF, and mapping derives from it, and it is validated against the full
case inventory before anything is built on top. And a binding process rule, aimed
squarely at the failure mode above — **for the AI as much as anyone**: when a case
fails, the fix goes into the single geometric model and must keep the whole inventory
green; adding a parallel derivation path, special-case gate, or fallback solver is
prohibited. A case the model can't handle is a defect *of the model*, never a reason
for a second model.

## L2. The graph must be the sole source of truth — v1 only half-committed

**Evidence.** `merge_bodies_with_bend`'s fold placement was not graph-persisted: bent panels
could not be regenerated from the graph alone. Later specs (009–012) retrofitted
graph-driven mutations, append-mode graph building, and persisted `foldNormal`/`bendDir`/
`anchor`/`bHingeOffsetMm` onto BendNodes — each retrofit exposing bugs in code that had
quietly depended on ephemeral 3D state.

**Lesson.** "Graph-driven" cannot be retrofitted per-tool. Any operation whose effect isn't
fully replayable from persisted state creates a second, invisible source of truth.

**Implication for v2.** Define the invariant up front: **replay(graph) ≡ current geometry**,
enforced by a round-trip test that runs for *every* mutating operation, from day one. An
operation that can't state its graph delta doesn't ship.

## L3. Representation expressiveness must match the domain — fallbacks don't fix model gaps

**Evidence.** `buildShellFromFlatPattern` used a 1D-strip segment model (sequential bend
zones along one axis). Straight chains worked; cube-corner chains (perpendicular fold lines)
could not be represented, so a "graceful fallback" produced silently wrong placement for
months, survived a 1440-triple sweep that reported zero alignment issues (false negative),
and was finally fixed by abandoning the flat-pattern rebuild entirely for corner chains in
favor of live-3D fusion of already-placed shells. One panel pair still fails today.

**Lesson.** When the data model can't express a case, every downstream "fix" is a patch on
a lie. The graceful-degradation path was worse than a hard error (v1's Constitution
Principle X was added for exactly this reason — late).

**Implication for v2.** Choose the placement representation *first*, against the full case
inventory (straight chains, corner chains, multi-lobed composites, protrusions), and make
unrepresentable states unconstructible. Where a case is out of scope, fail loudly.

## L4. bbox/volume assertions are worthless for placement; probe-based tests are mandatory

**Evidence.** Bounding-box and volume checks passed while panels sat at mirrored/far-edge
positions. The bug class was only caught after introducing true-3D position probe-box
asserts. A 1440-triple sweep using weak asserts reported "0 alignment issues" that a
rigorous position probe later disproved.

**Lesson.** Test strength determines which bug classes can exist. Weak oracles create
false confidence that is worse than no test.

**Implication for v2.** The harvested acceptance suite (see [06-plan.md](06-plan.md))
standardizes on strong oracles: exact-position probes, round-trip residuals with mm
budgets, and real skewed/asymmetric fixtures (cauldron.step class), never only synthetic
rectangles — rectangles hide an entire bug family (winding, skew, frame correlation).

## L5. Numerical policy must be explicit, central, and reviewed

**Evidence.** A boolean-fuse fuzzy tolerance of 0.15 mm silently discarded ~50% of a
part's volume once kerf-notch detail existed (fix: 1e-5). `BRepTools_WireExplorer` winding
varies face-to-face and a face-build was winding-sensitive (fix: canonicalize CCW by
shoelace sign). Off-by-one in a `hi>lo` range check broke single-point cross-sections.

**Lesson.** Tolerances, winding conventions, and units are architecture, not
implementation detail. Scattered per-call-site choices fail silently at scale.

**Implication for v2.** One numerical-policy module: canonical units, canonical winding,
named tolerance constants with documented rationale, and a rule (lint + review checklist)
against inline tolerance literals in geometry code.

## L6. The kernel boundary leaked, and the leak was expensive

**Evidence.** NAPI fields were added ad hoc when needed (`ringLocal`), raw OCCT failures
surfaced as user-facing strings ("Refold produced 2 solids"), and TS code accumulated
knowledge of OCCT quirks (wire explorer winding, fuzzy tolerance semantics).

**Lesson.** Without a designed port, the kernel's incidental behavior becomes the de facto
contract, and orchestration code absorbs kernel pathology.

**Implication for v2.** A single `GeometryKernel` port with a versioned, documented
contract: typed requests/responses, error taxonomy at the boundary, kernel quirks
normalized *inside* the adapter. Lint-enforced: nothing outside the adapter imports kernel
bindings. (v1's Constitution Principle II said this; v2 must make it mechanically
enforceable.)

## L7. The tool surface accreted; the front end used a fraction of it

**Evidence.** ~80 tools with overlapping responsibilities (`rollback` vs
`rollback_transaction`; `clean_geometry` vs `heal_geometry_ex`; `solve_geometry` vs
`resolve_geometry`; multiple validate_* variants). Per Paul: **many MCP features were never
used by the front end at all.**

**Lesson.** Tools added speculatively or per-bug become surface area to test, document,
and keep coherent — cost without evidence of value.

**Implication for v2.** The v2 surface is derived from observed jobs-to-be-done
([03-jobs-to-be-done.md](03-jobs-to-be-done.md)), starting from a usage audit of v1
(front-end call paths + agent transcripts). Default answer to a new tool is "no" until a
job demands it.

## L8. Transactionality was bolted on and became its own bug source

**Evidence.** 12 bugs in one session spanning fuse/merge/rollback interactions; graph
rollback initially saved only two root pointers rather than the node set; undo/redo
consistency needed dedicated regression tests.

**Lesson.** Undo/rollback implemented as geometry snapshots fights the graph model.
If the graph is the source of truth (L2), history is *graph history*.

**Implication for v2.** Transactions are graph-level (append/remove nodes, versioned),
and geometry rollback is just replay of an earlier graph version. One mechanism, not two.

## L9. Diagnosis was archaeology; observability was an afterthought

**Evidence.** The repo root is littered with `cauldron_*.txt` dump files from manual
instrumentation runs; multi-session root-cause hunts (the "191mm hinge" misdiagnosis)
happened because intermediate derivations weren't inspectable.

**Lesson.** In geometry code the failure is rarely at the reporting site. Without
inspectable intermediates, every deep bug costs sessions instead of minutes.

**Implication for v2.** First-class diagnostic output: every pipeline stage can dump its
input/output in a viewable form (graph JSON, DXF, mesh) behind a debug flag; structured
per-operation trace instead of scattered console dumps.

## L10. Big handlers hid structure the domain already had

**Evidence.** `handleMergeBodiesWithBend` reached 1430 lines before being decomposed into
4 named phase functions (427 lines). The phases (validate → derive frames → place → fuse →
persist) were always there; the code just didn't say so.

**Lesson / implication.** v2 names the pipeline phases as interfaces from the start, with
a size/complexity lint budget per module so drift is caught mechanically, not in a heroic
refactor.
