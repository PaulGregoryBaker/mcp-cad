# 18 — Stack Evaluation Plan (Phase 3)

**Status:** **DECIDED 2026-07-21 — see [19-cpp-ts-interface-boundary.md](19-cpp-ts-interface-boundary.md) §0.**
Stack stays C++/TS; no move to Rust for this rebuild. This doc's plan-and-spike
process ran to completion (Spikes 1-3, `spikes/SUMMARY.md`) and produced real,
concrete findings, but the decision itself turned on tracing this rebuild's own git
history rather than the spikes directly — 19 §0 has the full reasoning. Kept below as
the historical record of how the evaluation was actually run; not re-opened.

---

## 0. What Phase 3 is actually deciding (unbundled)

06-plan.md names four things under "Stack selection." One is already settled; the
other three are separable decisions, not one monolithic "pick a stack" choice —
worth unbundling explicitly, because a candidate that's right for one may be wrong
for another:

1. **Graph store** — ✅ already decided (B7): MySQL-compatible, Dolt-versioned. Phase
   3 only validates write-latency and cross-branch migration behavior against it;
   not re-opened here.
2. **Kernel/geometry-engine** (OPEN-16) — which library implements 16's HEAVY ports
   (Import/Heal, Measurement, Boolean, Construction, STEP export), and whether the
   LIGHT ports (Tessellation, Clearance, DXF) share that dependency or not (16 §0
   already argues they needn't).
3. **Orchestration/domain language** — what 13's pure translation module and 14's
   graph logic are written in. Because 13 is provably pure (never calls the kernel),
   this is *architecturally separable* from the kernel decision, even though it's
   tempting to bundle them.
4. **MCP protocol-layer language** — what actually serves the 15 contract (tools,
   resources, the job API) to callers. Not automatically the same language as #3.

**Every additional distinct language across #2–#4 is a new boundary** — and Paul has
now made boundary-crossing performance a first-class, must-solve requirement (§1),
not a detail to accept as a cost of doing business. That reframes #2–#4: the question
isn't just "which language is best per layer in isolation," it's "which *combination*
minimizes boundary count while meeting every layer's own requirements."

## 1. New requirement, stated plainly: bounded resource lifecycle, not raw speed

`[SHARPENED 2026-07-20 — Paul elaborated]`: **the current stack performed fine on
individual operations — loading and processing worked.** The actual symptom is that
resources were **not released**, so performance degraded *over the life of a
session*, not on any single call. Paul: the exact cause "may have to do with either
the MCP layer, or the TS↔C++ boundary" — he's not certain which, and (§1.1) that
uncertainty is not being resolved by further investigation of the old system.

This reframes what "solve it upfront" actually means. It is **not** a request to
make FFI calls or MCP round-trips faster in isolation — it's a request that whichever
stack is chosen has a **verified, bounded resource lifecycle across a long-running
session**: native handles and any cross-boundary state must be deterministically
released, not accumulate. This is exactly what N13 (02-requirements.md) already
specifies as a requirement ("explicit handle lifecycle... never reliance on GC
finalizers... CI includes soak/endurance tests that assert bounded RSS and
native-handle counts") — Paul's elaboration is concrete, first-hand confirmation that
this is not a hypothetical risk N13 pre-emptively guarded against, it is **the actual
failure mode already observed**. Two boundaries remain worth distinguishing
*architecturally* (a candidate must have a story for both), even though — per §1.1 —
neither needs to be root-caused in the *old* system to move forward:

- **Boundary A — orchestration ↔ kernel** (TS↔C++ today, via NAPI): native handle
  lifecycle, N13's original scope.
- **Boundary B — controller ↔ MCP**: session/connection state on the transport
  itself — exists regardless of which language implements the kernel or domain
  logic. 15 §3.0's `Ref` pattern removes large payloads from this path but doesn't
  by itself prove session state elsewhere is bounded.

### 1.1 No new diagnostic spike on the current stack — Paul: "consider the current
project as the spike"

The originally-proposed "Spike 0: diagnose the current stack's boundaries" is
**removed**. Paul's direction: we already have the evidence that matters —
years of the current project running in anger *is* the finding (degrades over a
session; suspected in Boundary A or B) — and since Candidate 0 is being evaluated
alongside genuine replacements, spending new time pinpointing exactly which boundary
was at fault in code we may not keep is not a good use of the timebox. **What
replaces it:** every *other* candidate's spike (§4) must include an explicit
sustained/soak check — not just single-operation latency — because "resources
released over time" is the concrete, evidenced bar every candidate must clear, and
the only way to know a new architecture clears it is to run it for more than one
call.

## 2. Candidates

**Candidate 0 — Status quo: TS + C++/OCCT via NAPI.** Explicitly in scope per Paul —
"continuing with that stack must be one of the options." Its evidence base is the
project itself (§1.1), not a new spike: known-good on individual operations, known
to degrade over a session via unreleased resources in Boundary A or B (unconfirmed
which). Picking this candidate honestly would still mean committing to *fix* that
symptom — via the same soak-style verification the other candidates get held to
(§4) — not simply continuing unchanged; "it already works" was true of throughput,
not of the thing actually in question here.

**Candidate 1 — Rust + C++/OCCT hybrid.**
- **1A — `cadrum`** (or equivalent high-level safe Rust wrapper over OCCT): fastest
  path to Rust's build/ownership benefits while keeping OCCT's 30+ years of B-Rep
  edge-case handling for the HEAVY ports.
- **1B — Custom `cxx`/`opencascade-rs`** (low-level, pointer-level access): only
  worth it if the case inventory (08) needs an OCCT algorithm 1A doesn't expose —
  should not be assumed necessary without evidence.
- **Open sub-question, not to be assumed:** does Rust *replace* the TS orchestration
  layer too (Rust becomes the MCP server, via `napi-rs` only if TS stays outermost,
  or a Rust MCP SDK if it doesn't), or does it slot in *between* TS and C++, leaving
  three languages and two boundaries instead of the current two-and-one? The latter
  would violate §1's "minimize boundary count" framing and should be treated as a
  contra-indication unless a specific reason forces it.

**Candidate 2 — Pure Rust kernel** (`truck`/`monstertruck`/Fornjot-class), no OCCT.
No C++ compile step, no FFI boundary between orchestration and kernel at all if the
whole backend is Rust. Named risk (Paul's own research, §3): younger kernels, weaker
guarantees on complex booleans — a risk this project has particular reason to weigh
carefully (§3.1).

**Candidate 3 — Port-split hybrid** `[surfaced by 16 §0, not in Paul's original
list — added because it falls directly out of the kernel-port capability work]`.
16 §0 already found that most of the tool/resource surface (15 §5's traceability
table) never needs a B-Rep kernel at all — only Import/Heal, general Boolean,
Construction, and STEP export (16's HEAVY ports) do. This candidate takes that
finding as an architecture, not just an observation: OCCT (via 1A or 1B) implements
*only* the HEAVY ports, behind Port C/D's adapters; the LIGHT ports (Tessellation,
Clearance, DXF export) are implemented in dependency-light Rust (or even TS) with
**no OCCT dependency at all**, using 13 §3.3's exact point-array output directly.
This could reduce OCCT's footprint (build time, binary size, N13 native-handle
surface) to only the narrow slice that genuinely needs it.

## 3. Evaluation criteria — derived from what's already been decided, not generic

Every criterion below cites the requirement it comes from — this evaluation is
against *our* case inventory and *our* constraints, not a generic CAD-kernel
scorecard.

**Priority ordering across this table** `[SET 2026-07-20]`, Paul: "getting the soak
test passing is secondary to getting the functionality working correctly... Design
for long-term performance and functionality; next build functionality; after which
build long-term performance." Concretely, for reading the table below and scoring a
spike: the top two rows (kernel-port coverage, the historically-hardest case-inventory
rows) are the **primary** gate — a candidate that doesn't get the geometry right fails
regardless of anything else. Boundary-crossing performance and N13 (further down) are
evaluated and taken seriously at *design* time — a candidate whose architecture gives
no credible story for bounded resource lifecycle is a real problem *now* — but a
prototype that gets functionality correct and has *not yet* proven its soak leg is not
automatically rejected; that is exactly the kind of hardening work the priority
ordering above defers to *after* functionality, not a disqualifier at spike time. This
directly resolves how a soak-leg result should be weighed in §4 and OPEN-18.3.

| Criterion | Source | What "pass" looks like |
|---|---|---|
| Covers all 7 kernel ports, esp. HEAVY ones | 16 | Import/heal, general boolean, construction, STEP export all genuinely reliable — not "mostly works" |
| Handles the historically-hardest case-inventory rows | 08 (esp. C05/C07/C08/C13 — the red cases) | Not generic CAD confidence; *these specific* corner-chain/multi-lobed cases, validated directly (§4 spike) |
| Scope is developable surfaces only | C5 | A candidate need not support general NURBS booleans — this narrows the bar a "young" kernel must clear, and should be weighed *for* Candidate 2/3, not against them by default |
| Boundary-crossing performance, both A and B | §1 (new) | Measured, not asserted — a concrete number beats a design argument |
| Build/iteration velocity | Paul, explicit | Time from a representative code change to a passing test run, measured, not estimated |
| AI-assisted development throughput | Paul, explicit | A real criterion, not a soft one — Paul has first-hand evidence for Rust specifically; worth weighing alongside the harder technical criteria, not dismissed as unmeasurable |
| N13 native memory/handle discipline — **secondary to functional correctness, but a real design-time question** (priority note above) | 02 N13; §1's elaboration | Passes the §4 soak leg: bounded RSS and native-handle count over thousands of repeated operations. Does the language make "acquire/release, scope-bound" the *idiomatic* path (Rust's ownership/`Drop` model is a structural point in its favor, independent of Paul's personal preference), or something the team must enforce by discipline/lint alone, the way the current stack apparently did — and evidently didn't sustain? A candidate whose *architecture* offers no credible path here is a real concern now; a candidate that simply hasn't proven it yet is hardening work, deferred per the priority ordering. |
| P1 boundary/lint enforcement tooling | 04 P1 | Can dependency-boundary lint, complexity budgets, and the tolerance-literal ban (17 §6) actually be mechanically enforced in the chosen language(s)? A stack that can't support this *fails selection* per P1's own text. |
| MCP SDK maturity per language | 06-plan (existing criterion) | Official/well-supported SDK with resource, tool, and job-API primitives matching 15's contract shape — **RESOLVED by Spike 3 (2026-07-20, research-only, see `spikes/spike-3-mcp-language/RESEARCH.md`): `rmcp` v2.2.0, the official SDK under the `modelcontextprotocol` GitHub org, has `Resource`/tool-router/task-progress primitives that line up with 15's shape directly** — the "maybe no viable SDK exists" risk is closed; ADR-3 still weighs team fluency and boundary-count (§1), just not this risk |
| Deployment fit | N10 | Container size, cold-start time, matches the "native now, cloud later" trajectory |
| Team fluency / maintenance risk | 06-plan (existing criterion) | Honest accounting of ramp-up cost, not just greenfield productivity |

### 3.1 The strategic risk worth naming explicitly

This entire rebuild exists because v1's C++/OCCT-based geometry had correctness bugs
that took sessions to root-cause (01-lessons-learned.md). Picking an **immature**
geometry kernel — Candidate 2's named risk, per Paul's own research — risks
reintroducing that exact risk *class*, just in a new dependency instead of in v1's
own code, rather than eliminating it. This is not a reason to rule Candidate 2 out —
C5's developable-surfaces scope is genuinely narrower than the general CAD problem a
"is truck mature enough" assessment would ask about, and a young kernel may be fully
sufficient for exactly what 08's case inventory needs even if it isn't for general
CAD — but it is the single biggest thing §4's spikes must settle with evidence,
specifically against **our** hardest cases (C05/C07/C08/C13), not general confidence.

**Settled by Spike 2 (2026-07-20), and more precisely than expected.** The risk
didn't show up as "the boolean algorithm gives wrong answers" (§2c: it's precise,
0.0003% residual, on non-trivial curved geometry) — it showed up as **the import and
boolean crates not composing at all** (a missing trait impl) plus **measured per-call
latency in the seconds, not milliseconds, range** on geometry far simpler than
cauldron. Both are concrete, checkable findings against real evidence, not general
"young kernel" confidence — exactly what this section asked the spikes to produce. See
`spikes/spike-2-pure-rust-kernel/RESULTS.md` for the full detail.

## 4. Evaluation process — spikes before ADRs

**Progress log** (workspaces + write-ups live under `rebuild/spikes/`, not in this
doc — this doc stays the plan, not the results):
- **Spike 1 (Rust+OCCT via `cadrum`): substantially done.** Environment/build
  feasibility ✅, functional correctness on `cauldron.step` ✅ (cross-checked against
  v1's known 82-panel ground truth), build/iteration velocity measured (6.4s debug /
  9.3s release incremental), soak leg run to completion (3000 iterations — a real,
  small, quantified leak found and analyzed, not assumed clean or catastrophic; see
  `spikes/spike-1-rust-occt/RESULTS.md` §5). Remaining: MCP-caller-shape wiring
  (Boundary A itself, not yet exercised), hard-case coverage beyond import (more
  Spike 2's territory).
- **Spike 3 (MCP-layer language): done, research-only, no gap found.** Official
  `rmcp` SDK confirmed with matching primitives — see
  `spikes/spike-3-mcp-language/RESEARCH.md`. §3's table row updated to match.
- **Spike 2 (pure/partial Rust via `truck`): done — a decisive, concrete finding.**
  Import (Port A) as strong as Spike 1's, independently cross-validated to 3 decimal
  places against a completely different codebase (OCCT vs. pure-Rust `ruststep`).
  **But `truck_shapeops` booleans cannot run on `truck_stepio`-imported geometry at
  all** — a missing trait impl (`Curve3D` lacks `From<IntersectionCurve<..>>`), not an
  ergonomics gap. Pivoted to the officially-supported path (booleans on
  `truck_modeling`-authored solids): correctness is strong (0.0003% residual,
  inclusion-exclusion self-check, curved surfaces included) but **each boolean call
  measured ~2.5-3.1 seconds** on simple synthetic geometry — a real latency concern,
  separate from the composability gap. N13/soak result is the cleanest of both spikes:
  bounded, no leak, structurally explained (pure Rust, no C++ destructor-workaround
  class of bug possible). Net: two independent points against Candidate 2 for the
  actual import→operate pipeline; both reinforce Candidate 3's port-split design
  (HEAVY ports stay on OCCT per Spike 1; pure Rust never asked to bridge either gap).
  Full write-up: `spikes/spike-2-pure-rust-kernel/RESULTS.md`.
- Spike 4 not yet started (correctly gated on 1-3's survivor per §4).
- **Cross-spike summary against this whole §3 table**: `spikes/SUMMARY.md` — scores
  every row for Spikes 1-3, names a new architectural finding not previously stated
  here (Boundary A may not exist at all if Rust hosts orchestration+kernel together),
  and is explicit about what's still untested (the actual C05/C07/C08/C13 hard cases
  on real geometry remain unreproduced by either candidate — the single largest
  remaining evidence gap). Not an ADR — still short of that bar.

This decision is expensive to reverse (04 P1's whole "requirements before stack"
discipline exists because of exactly this class of choice). It is evaluated by
**time-boxed, scored spikes**, not a desk comparison — matching how the rest of this
rebuild has insisted on evidence (the suite, the case inventory, harvested v1 bugs)
over assertion.

**No spike runs against the current stack** (§1.1) — Candidate 0's evidence is the
project itself. Every spike below is for a *replacement* candidate, and every one of
1–2 includes a **soak leg, not just a single-call measurement**, because "resources
released over time" — not raw latency — is the actual, evidenced bar (§1):

1. **Spike 1 — Candidate 1 (Rust+OCCT) minimal path.** A `napi-rs`/`cadrum` (or
   custom `cxx`) prototype performing one representative HEAVY operation
   (import + heal a real fixture, e.g. `cauldron.step`) end-to-end from an MCP-style
   caller. Measure, **in this order of priority (§3's priority note): first, does the
   operation produce correct output on the real fixture — that gate is primary and
   non-negotiable; then** latency, iteration time (edit → build → running test —
   Paul's explicit ask), **and a soak run — the same operation repeated thousands of
   times, asserting bounded RSS and native-handle count (N13's soak-gate shape, run
   here at evaluation time rather than deferred to Phase 4 CI)**. A candidate that's
   functionally correct but hasn't yet proven the soak leg is not rejected on that
   basis alone — record it as a known hardening item and note whether anything about
   the architecture (vs. just this prototype's current state) explains the gap.
2. **Spike 2 — Candidate 2/3 (pure/partial Rust kernel) against the hard cases.** A
   minimal `truck`/`monstertruck` prototype attempting the specific
   developable-surfaces-scoped operations 08's red cases need — corner-chain
   construction, multi-lobed composite booleans, the C05/C08/C13 class directly, not
   generic shapes (§3.1's named risk, tested on *our* evidence) — **plus the same
   soak leg as Spike 1.** For a pure-Rust path this is also where ownership/`Drop`
   semantics get to show whether they make bounded release closer to automatic than
   the current NAPI-manual-lifecycle pattern was.
3. **Spike 3 — MCP-layer language.** A short research/prototype pass: does a Rust
   MCP SDK exist with resource/tool/job-API primitives matching 15's contract shape
   well enough to build on, or does the MCP-facing layer stay TS/Node regardless of
   what powers §0's items 2–3? Research-only if no clear gap surfaces; a small
   prototype if it does — and if a prototype is built, it should include a long-lived
   multi-request session check, since Boundary B was one of the two named suspects.
4. **Spike 4 — P1 lint/boundary tooling feasibility** for whichever language
   combination survives 1–3: confirm dependency-boundary lint and complexity budgets
   are mechanically enforceable, not just theoretically possible.

Each spike produces a short scored write-up against §3's table — inputs to the ADRs
below, not the ADRs themselves.

### 4.1 Timeboxing spikes under AI-assisted development `[PROPOSAL 2026-07-20]`

Paul: "I agree these need to be timeboxed; I'm uncertain how to do this when using AI
assistance." The difficulty is specific: AI-assisted coding throughput is **not**
linear with calendar time the way solo hand-coding roughly is — it front-loads
unpredictably (a full working prototype in an afternoon is plausible per Paul's own
signal, §3) *and* it can produce something that runs and looks plausible while hiding
the exact class of defect this whole rebuild exists to eliminate (dual derivation,
compensating hacks — L1). A calendar estimate ("this should take 3 days") is guessing
at the wrong variable. Proposed structure instead:

1. **A fixed calendar ceiling per spike, sized as a backstop, not a target.**
   `[ADOPTED 2026-07-20 as a starting point — Paul: "let's start with your
   suggestions; if the guidance is incorrect, we can adjust"]` scaled to each spike's
   actual scope rather than one uniform number, in **active working days** (see the
   soak-run carve-out below) — kept revisable once a spike is actually underway and
   real evidence exists about whether a given ceiling was too tight or too generous:
   - **Spike 1 (Rust+OCCT minimal path): 3 working days.** New toolchain + FFI bridge
     + one real HEAVY operation end-to-end + soak run — bounded scope, one fixture,
     one operation.
   - **Spike 2 (pure/partial Rust vs. hard cases): 4 working days.** One day more than
     Spike 1 on purpose: this spike targets exactly the cases v1 never fully solved
     (C05/C08/C13-class), so per point (3) it's the spike most likely to need more
     than one structurally different attempt before a verdict is honest.
   - **Spike 3 (MCP-layer language): 1–2 working days.** Research-first by design (§4)
     — most of the question is answerable without writing much code; only escalates
     toward the top of that range if a gap surfaces and a small prototype gets built.
   - **Spike 4 (lint/boundary tooling): 1–2 working days.** A narrow, well-defined
     feasibility question once a language combination is fixed.
   - Total ≈ 9–13 working days if run strictly in sequence — but Spikes 1, 2, and 3
     don't depend on each other's outcome and can run **concurrently** if resourcing
     allows, which shortens wall-clock time without changing any individual ceiling.
     Spike 4 is genuinely sequential — it needs 1–3's survivor(s) decided first.
   - **Soak runs don't count against the active-time ceiling.** "Thousands of repeated
     operations" is unattended wall-clock time (plausibly hours), not developer/AI
     iteration effort — launch it and let it run in the background while other work
     continues, the same way a long CI job isn't counted as a day of someone's time.
   - If AI-assisted iteration is as fast as Paul's own experience suggests, a real
     result lands well inside the ceiling; if it doesn't, hitting the ceiling with an
     inconclusive result *is itself the finding* ("this candidate didn't converge even
     with AI assistance in the time given") — write it up as exactly that, not as a
     failure to hide.
2. **Exit condition is §3/§4's criteria, not the clock — identical regardless of how
   the time was spent.** A spike stops the moment it clears its bar (don't keep
   polishing past done) or hits the ceiling (write up what's actually known). AI speed
   changes *when* you can check the criteria, never *what* the criteria are — the
   soak leg's bounded-RSS bar, the specific hard-case rows (§3.1), and the SDK-gap
   question (Spike 3) don't get relaxed because the code arrived quickly.
3. **Budget attempts, not hours, inside the ceiling.** If a first implementation
   tactic stalls, treat "try a structurally different approach" as the default move,
   not "debug the same approach for the rest of the ceiling" — cheap-to-try
   alternatives are specifically where AI assistance earns its keep, and a timebox
   that only tracks elapsed time doesn't reward that. Two or three independent
   attempts that all fail to clear the bar inside the ceiling is a stronger signal
   than one long grind.
4. **Extra scrutiny on fast passes of correctness-critical criteria, not less.** A
   spike that clears its soak leg or the §3.1 hard-case check quickly, with heavy AI
   involvement, should get the *same* verification rigor as a slow manual pass would
   — re-run the soak leg, re-check the specific case-inventory rows by hand, don't
   accept "it ran once and looked right" as equivalent to "it passed." This is the
   direct lesson of why this rebuild exists (L1): fast-and-plausible is not the same
   claim as correct, and a timeboxing scheme that implicitly rewards speed over
   verification would reintroduce the exact risk class this whole plan is trying to
   retire.
5. **Record the AI-assistance datapoint itself, concretely.** Since "AI-assisted
   development throughput" is already a named criterion (§3), each spike's write-up
   should note *where* AI assistance helped vs. where it produced something that
   needed to be caught and redone — real evidence for that criterion, not a
   retrospective impression.

This is a proposal, not a decision — Paul still sets the actual ceiling length (a
resourcing call this doc can't make) and confirms whether the attempt-budget framing
in (3) matches how he'd actually want to work a spike.

## 5. ADRs (the decision artifacts, per 06-plan's exit criterion)

- **ADR-1: Kernel/geometry-engine.** Which candidate (§2) implements the HEAVY
  ports; whether LIGHT ports get a separate, lighter implementation (Candidate 3's
  question).
- **ADR-2: Orchestration/domain language.** What 13/14's pure logic is written in.
- **ADR-3: MCP protocol-layer language.** What actually serves the 15 contract.
- **ADR-4: Boundary/lint tooling** for the ADR-1–3 combination (P1).
- *(Graph store: no new ADR needed — B7 stands, validated per §0 item 1.)*

## 6. Preliminary lean — explicitly non-binding, offered for reaction only

Given 16 §0's own finding (most operations are LIGHT, kernel-free) and §1's new
"minimize boundary count" framing, **Candidate 3 (port-split hybrid) is the
direction I'd validate first** — it doesn't treat "which kernel" as all-or-nothing,
and it directly exploits work already done rather than a fresh assumption. Within
that, Rust's ownership model is a genuine structural fit for N13 independent of
Paul's own productivity signal — and §1's elaboration sharpens *why* that fit
matters here specifically: the current stack's actual failure mode wasn't a missing
optimization, it was resources that depended on manual/GC-adjacent discipline being
released, and evidently weren't, over a session's lifetime. `Drop`-based release
tied to scope exit is a different *kind* of guarantee than "remember to call
release" — that's the concrete mechanism behind the lean, not just a general
preference for Rust. That makes Rust-for-orchestration attractive *if* Spike 3
doesn't reveal an MCP-SDK gap serious enough to keep that layer in TS, but the
lean is only as good as Spike 1/2's soak legs (§4) — a design argument about
ownership is exactly the kind of claim §1.1 says shouldn't be trusted without
running it.
None of this is a recommendation to skip §4 — it's a starting hypothesis for the
spikes to confirm or kill, offered because a plan with no point of view is harder to
react to than one with a stated, falsifiable lean.

## 7. Open questions for Paul

- ~~`[OPEN-18.1]`~~ **ANSWERED 2026-07-20:** no diagnostic spike on the current
  stack — its evidence is the project itself (§1.1).
- ~~`[OPEN-18.2]`~~ **ANSWERED 2026-07-20:** timeboxing approach ratified — attempt-
  budget framing (§4.1 point 3) agreed, and the scope-scaled ceilings adopted
  as a starting point: Spike 1 = 3 working days, Spike 2 = 4, Spike 3 = 1–2,
  Spike 4 = 1–2 (soak-run wall-clock time excluded, per the carve-out in §4.1).
  Paul: "let's start with your suggestions; if the guidance is incorrect, we can
  adjust" — explicitly a starting point, not a permanent commitment; §4.1's
  `[ADOPTED]` tag is kept in place (not deleted down to a bare number) since it still
  records the reasoning behind each figure, in case the numbers need revisiting once a
  spike is actually underway.
- ~~`[OPEN-18.3]`~~ **ANSWERED 2026-07-20**, by §3's priority ordering: neither
  "reject on first leak" nor "always isolate immediately" — **"still leaking, reject"
  is too strict** given the new priority (functionality first, long-term performance
  second) and **is only the right call for a *design-level* gap, not an
  *implementation* one.** Concretely: if a spike's soak leg fails, first ask whether
  anything about the candidate's *architecture* explains it (e.g. the language forces
  manual release the same way NAPI did, with no ownership/`Drop`-style structural
  alternative) — if so, that's a real reject reason and worth naming even without a
  full A-vs-B isolation spike. If nothing architectural explains it, treat it as an
  unfinished **implementation** detail: record it as a known hardening item and move
  on without a dedicated follow-up spike — per Paul, "I don't see any options at the
  moment that would break the soak test," so this is not expected to bite in practice,
  but the policy is set for if it does. A vs. B isolation, if ever needed, becomes
  Phase 4/5 "build long-term performance" work against real functionality, not a
  Phase 3 spike-extension.
