# 18 — Stack Evaluation Plan (Phase 3)

**Status:** `[PROPOSAL]` for Paul's review — a plan for *how* to decide, not the
decision itself. Phase 3 is explicitly where Paul's stack opinions get their hearing
(06-plan.md), now against a complete requirement set: 13 (geometric model), 14
(schema), 15 (contract), 16 (kernel capability list, HEAVY/LIGHT split), 17
(numerical policy). This doc structures the evaluation; it does not pre-select a
winner.

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
scorecard:

| Criterion | Source | What "pass" looks like |
|---|---|---|
| Covers all 7 kernel ports, esp. HEAVY ones | 16 | Import/heal, general boolean, construction, STEP export all genuinely reliable — not "mostly works" |
| Handles the historically-hardest case-inventory rows | 08 (esp. C05/C07/C08/C13 — the red cases) | Not generic CAD confidence; *these specific* corner-chain/multi-lobed cases, validated directly (§4 spike) |
| Scope is developable surfaces only | C5 | A candidate need not support general NURBS booleans — this narrows the bar a "young" kernel must clear, and should be weighed *for* Candidate 2/3, not against them by default |
| Boundary-crossing performance, both A and B | §1 (new) | Measured, not asserted — a concrete number beats a design argument |
| Build/iteration velocity | Paul, explicit | Time from a representative code change to a passing test run, measured, not estimated |
| AI-assisted development throughput | Paul, explicit | A real criterion, not a soft one — Paul has first-hand evidence for Rust specifically; worth weighing alongside the harder technical criteria, not dismissed as unmeasurable |
| N13 native memory/handle discipline — **the sharpest criterion in this table** | 02 N13; §1's elaboration | Passes the §4 soak leg: bounded RSS and native-handle count over thousands of repeated operations. Does the language make "acquire/release, scope-bound" the *idiomatic* path (Rust's ownership/`Drop` model is a structural point in its favor, independent of Paul's personal preference), or something the team must enforce by discipline/lint alone, the way the current stack apparently did — and evidently didn't sustain? |
| P1 boundary/lint enforcement tooling | 04 P1 | Can dependency-boundary lint, complexity budgets, and the tolerance-literal ban (17 §6) actually be mechanically enforced in the chosen language(s)? A stack that can't support this *fails selection* per P1's own text. |
| MCP SDK maturity per language | 06-plan (existing criterion) | Official/well-supported SDK with resource, tool, and job-API primitives matching 15's contract shape — genuinely uncertain for Rust today; a named research item (§4), not an assumption either way |
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

## 4. Evaluation process — spikes before ADRs

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
   caller. Measure: latency, iteration time (edit → build → running test — Paul's
   explicit ask), **and a soak run — the same operation repeated thousands of times,
   asserting bounded RSS and native-handle count (N13's soak-gate shape, run here at
   evaluation time rather than deferred to Phase 4 CI)**. A candidate that's fast
   once but still leaks under sustained use has not cleared the actual bar.
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
Paul's own productivity signal, which makes Rust-for-orchestration attractive
*if* Spike 3 doesn't reveal an MCP-SDK gap serious enough to keep that layer in TS.
None of this is a recommendation to skip §4 — it's a starting hypothesis for the
spikes to confirm or kill, offered because a plan with no point of view is harder to
react to than one with a stated, falsifiable lean.

## 7. Open questions for Paul

- ~~`[OPEN-18.1]`~~ **ANSWERED 2026-07-20:** no diagnostic spike on the current
  stack — its evidence is the project itself (§1.1).
- `[OPEN-18.2]` Timebox per spike — how much time is reasonable before this needs to
  convert to a decision? (Not answered here; a resourcing call.)
- `[OPEN-18.3]` Since Boundary A vs. B isn't being disambiguated in the *old* system
  (§1.1), each replacement candidate's soak spike (§4) will show bounded-or-not as a
  single combined result. If a candidate's soak leg fails, is a follow-up spike to
  isolate *which* boundary is responsible worth the time, or is "still leaking,
  reject the candidate" a sufficient outcome without further isolation?
