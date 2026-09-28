<!--
SYNC IMPACT REPORT:
- Version change: 1.3 -> 2.0.0 (MAJOR)
- Rationale for MAJOR: principle II (Bounded Context Separation) is redefined in a
  backward-incompatible way (TS-side geometric interpretation, previously permitted,
  is now prohibited outright); every surviving principle gains a mandatory named
  enforcement mechanism where none existed before; the Technology Stack section is
  replaced entirely to match the actual decided v2 stack and interface design.
- Principles carried forward unchanged in substance (renumbered, enforcement added):
  III Safety Filter Enforcement -> XI; V Kerf Compensation -> XII; IX Async Export
  Contract -> XIII (generalized to all heavy async operations, not export-only);
  VIII Configuration Over Hard-Coding -> XIV (updated to reference the N11 tolerance-
  profile mechanism).
- Principles superseded / redefined:
  I Deterministic Geometry Intelligence -> absorbed into II (replay invariant) and
    III (one geometric solution), now with concrete enforcement instead of assertion.
  II Bounded Context Separation -> REDEFINED as IV (No Geometric Computation in
    TypeScript) — stricter, reverses the prior allowance for TS-side DXF-frame
    interpretation logic. This reversal is evidenced, not stylistic: see
    rebuild/19-cpp-ts-interface-boundary.md §0 for the git-history trace showing the
    old allowance is implicated in this project's worst historical defect (~1 month
    to root-cause a manufacturing-graph instability bug).
  IV Rollback-First State Management -> absorbed into II (graph replay invariant);
    the ad hoc snapshot-registry mechanism is superseded by Dolt branch/commit/replay
    (14-graph-schema.md, B5/B7).
  VI Structured Errors Always -> superseded by VI Typed Error Taxonomy At Every
    Boundary (same intent, concrete enforcement: exhaustiveness checking, contract
    tests, lint ban on untyped rethrows).
  X Graceful Failure Over Silent Fallbacks -> superseded by VII No Silent Fallbacks
    (same principle, sharper enforcement: @fallback lint marker + mandatory ADR).
- Principles retired (not carried forward):
  VII MVP Scope Discipline — was specific to v1's now-closed MVP boundary; superseded
    by rebuild/06-plan.md's phased build order and C5's developable-surfaces scope,
    which are living planning documents, not constitutional principles.
- Added sections/principles: I Layered Core With One-Way Dependencies; III One
  Geometric Solution; IV No Geometric Computation in TypeScript; V Central Numerical
  Policy; VIII SOLID Applied Where It Earns Its Keep; IX Observability As A Feature;
  X Native Resource Lifecycle Across the C++/TS Boundary.
- Removed sections: none outright; "Technology Stack & Architectural Decisions" is
  fully rewritten (v1's content — Python/CadQuery/FastMCP — was already stale
  relative to the actual C++/NAPI/TS codebase before this rebuild started; flagged
  here since it was never corrected until now).
- Templates checked: plan-template.md, spec-template.md, tasks-template.md — all
  reference the constitution generically ("[Gates determined based on constitution
  file]"), no principle names hardcoded. ✅ no updates needed.
  .claude/skills/*/SKILL.md — grepped for v1 principle names, no hits. ✅ no updates
  needed.
- Follow-up TODOs:
  - The NAPI resource-lifecycle audit named in principle X's enforcement (and in
    rebuild/19 §3) has not been performed yet — real, scoped follow-up work, not
    something this amendment could complete.
  - Phase 4 CI tooling (the lint rules, contract tests, and soak gate this
    constitution's enforcement columns name) does not exist yet — this amendment
    states the target; building it is the rest of Phase 4.
-->

# MCP-CAD Constitution

## Core Principles

### I. Layered Core With One-Way Dependencies (NON-NEGOTIABLE)

The system is a strict layered core: **MCP boundary** (protocol, schemas, error
mapping) → **Application services** (job orchestration, transactions) → **Domain
core** (manufacturing graph, bend math, placement model, numerical policy) →
**GeometryKernel adapter** (the only module permitted to touch the B-Rep kernel),
dependencies flowing one way only. Domain core MUST have zero dependencies on MCP,
kernel bindings, or I/O — it MUST be pure and unit-testable without a kernel present.

**Enforcement:** a dependency-boundary lint runs in CI and fails the build on any
import that violates the layer arrows; the kernel binding package is importable only
by the GeometryKernel adapter module, checked by the same lint.

### II. Graph Is The Single Source Of Truth — Replay Invariant (NON-NEGOTIABLE)

`replay(graph) ≡ current geometry` MUST hold after every mutating operation. Graph
history is version-control-shaped: branch = divergent history, merge = a graph-level
operation gated by review, undo = replay of an earlier version (Dolt-backed;
rebuild/14-graph-schema.md §3–§4). The replay invariant applies at every branch head —
a branch that cannot replay cannot be reviewed or merged, so this is what makes
branch/merge possible at all, not an add-on check.

**Enforcement:** a test-harness middleware wraps every mutating tool in the
acceptance suite — execute → serialize the graph → replay from scratch → assert
geometric equivalence (position probes + residual budget). New tools inherit this
automatically; opting out is not a supported code path.

### III. One Geometric Solution (NON-NEGOTIABLE)

The 2D↔3D placement problem has exactly one geometric solution that solves every case:
a single geometric model — the translation module
(rebuild/13-translation-module-design.md) — from which every frame, flat pattern, DXF,
and coordinate mapping derives. Prohibited outright, with no exceptions: parallel
solvers, per-case gates, fallback paths, compensating offsets, and end-state alignment
assumptions. A failing case is a defect of the model, fixed in the model and validated
against the full case inventory — never patched around.

**Enforcement (architecture):** the kernel port exposes exactly one operation
returning measured geometry to the translation module; no raw projection primitives
are exported elsewhere. A lint rule bans any module outside the translation module
from importing projection/unfold internals.

**Enforcement (process — binds AI-assisted changes too):** any change that adds a
second derivation path or a case-arbitration gate to the geometric core is rejected in
review by rule, not by judgment call. A fix must keep the entire case inventory green,
not the one case it was written for.

### IV. No Geometric Computation in TypeScript (NON-NEGOTIABLE)

TypeScript MUST NOT compute geometry of any kind — not a kernel call, not pure
matrix/point math, not a computation deemed "safe" because it doesn't touch the
kernel. Every geometric fact used anywhere in the system is computed exactly once, in
C++, and TypeScript consumes it by reference. TypeScript owns graph structure/identity
and structural mutation bookkeeping (which nodes exist, how they connect); it MUST
fetch every geometric fact a mutation needs from a single C++ call, never derive or
approximate one independently.

This principle **redefines and reverses** v1's Bounded Context Separation, which
permitted TS-side geometric interpretation logic (e.g. DXF-frame derivation). That
allowance is evidenced to be implicated in this project's worst historical defect: a
manufacturing-graph instability bug that took roughly a month to root-cause, ultimately
traced to two independent C++ routines computing the same geometric fact and silently
disagreeing — exactly the failure mode this principle makes structurally impossible.
Full reasoning: rebuild/19-cpp-ts-interface-boundary.md §0–§1.

**Enforcement:** the port-binding table in rebuild/19 §2 is the enforcement surface —
every C++/TS crossing goes through exactly one named port adapter; nothing else
crosses. The P1 boundary lint checks this table directly once Phase 4 tooling exists.
No live kernel handle is ever passed to TypeScript; only plain data or opaque
reference IDs cross the boundary.

### V. Central Numerical Policy

One module owns units, tolerances (each with a named, documented rationale), winding
convention (canonical CCW), and comparison helpers. A strict boundary separates this
module from project-configurable tolerance profiles (N11): this module answers "are
these two numbers the same value, allowing for floating-point/kernel noise" (never
project-configurable); N11 answers "is this result good enough for this project" (a
per-project budget). See rebuild/17-numerical-policy.md.

**Enforcement:** a lint rule bans numeric tolerance literals anywhere in geometry or
domain code outside the policy module; property tests assert winding canonicalization
is idempotent and correct across randomly generated polygons.

### VI. Typed Error Taxonomy At Every Boundary (NON-NEGOTIABLE)

The GeometryKernel adapter MUST map every kernel failure to a typed domain error; the
MCP layer MUST map every domain error to the wire schema `{code, message, recoverable,
suggestedTool}`. A raw kernel exception or string MUST never cross a boundary.

**Enforcement:** exhaustiveness checking on the error enum; contract tests asserting
every tool's documented failure modes appear in the schema; a lint rule banning
rethrow of an untyped error across a layer boundary.

### VII. No Silent Fallbacks (NON-NEGOTIABLE)

If the geometric model cannot represent a case, the operation MUST fail with a typed,
actionable error. A fallback path MUST NOT exist without an explicit, documented
decision and a dedicated test proving the fallback's output is *correct* — not merely
that it doesn't crash.

**Enforcement:** a lint marker requires any code path tagged `@fallback` to reference
an ADR and a dedicated correctness test; absence of either fails CI. This is also a
code-review checklist item.

### VIII. SOLID Applied Where It Earns Its Keep

Concretely, for this domain:
- **Single responsibility:** pipeline phases are named modules (validate / derive /
  place / fuse / persist), each under a size and cyclomatic-complexity lint budget.
- **Open/closed & Liskov:** new node types and new placement cases extend the graph
  schema and placement model without editing switch statements scattered across
  layers; an exhaustive-match lint makes adding a node type produce a compile/lint
  error at every site that must handle it — deliberate friction, not an oversight.
- **Interface segregation:** the kernel port is split by capability (import/heal,
  measurement, boolean, construction, tessellation, clearance, export —
  rebuild/16-kernel-port.md) so test fakes stay small.
- **Dependency inversion:** application services depend on ports; adapters are
  injected only at the composition root. Enforced by the boundary lint (I) plus a
  rule against constructor-side adapter instantiation outside the composition root.

**Enforcement:** as named per sub-point above — size/complexity lint budgets,
exhaustive-match lint, boundary lint, composition-root rule.

### IX. Observability As A Feature

Every pipeline stage MUST support dumping its inputs/outputs (graph JSON, DXF, mesh)
under a debug flag. Every operation MUST emit a structured trace: operation name,
parameter hash, graph delta, timings, and residuals.

**Enforcement:** the pipeline interface requires a describe/dump capability per
stage as part of its type signature, not an optional add-on; the acceptance harness
asserts traces are actually emitted, not just that the capability exists.

### X. Native Resource Lifecycle Across the C++/TS Boundary (NON-NEGOTIABLE)

Wherever the solution crosses the C++↔TypeScript bridge, native resources (B-Rep
shapes, meshes, kernel sessions) MUST have deterministic ownership and lifetime:
explicit acquire/release or strict scope-binding to one request. Native memory MUST
NOT rely on garbage-collector finalizers for release. Because the server is
long-lived (human and AI collaborate over long sessions; branches stay open), a slow
leak is a product bug, not a performance nitpick.

**Enforcement:** CI includes a soak/endurance test that runs a representative
operation thousands of times and asserts bounded RSS and bounded native-handle count.
This test targets the *current* NAPI binding layer directly — it is not deferred to a
future rewrite. A named, scoped audit of `ts/src/geometry/binding.ts` and
`cpp/src/napi/geometry_binding.cc`/`addon.cc` for today's actual handle-release
behavior is required follow-up work (rebuild/19 §3), tracked as an open item on this
amendment.

### XI. Safety Filter Enforcement (NON-NEGOTIABLE)

Safety constraints are non-bypassable. If `context://intent/environmental` declares a
`fire_rated` context, `synthesize_joints` MUST reject adhesive and plastic fastener
joint types before any geometry operation is attempted. Safety checks are enforced at
the MCP Protocol Layer before delegating to any sub-context. No override mechanism may
be exposed to the AI Harness.

**Enforcement:** contract test asserting `synthesize_joints` rejects disallowed joint
types under a `fire_rated` context before any geometry call is made.

### XII. Kerf Compensation Is Mandatory

All slot and tab geometry produced by `synthesize_joints` MUST include a kerf offset
of 0.1–0.2 mm (laser/waterjet respectively), sourced from `manufacturing://rules`. No
joint geometry may be written to a shell without kerf compensation applied. This rule
is enforced in the Geometry Engine Service layer, not the AI Harness.

**Enforcement:** a unit test on `synthesize_joints` output asserting kerf offset is
present and within range for every joint kind and material combination in the fixture
set.

### XIII. Async Contract For Heavy Operations (NON-NEGOTIABLE)

Any operation expected to take longer than the interactive budget (N9) MUST be async
at the protocol level: the MCP layer returns `job_id`, `status`, and `accepted_at`
immediately, with `get_job` as the uniform polling surface (rebuild/15-mcp-contract.md
§4.5). This generalizes v1's export-only async contract to every heavy operation
(import, construction, export alike), per N9a: "async" is a protocol shape, not
permission to ignore wait time — a heavy job MUST report granular `progress`, not a
bare `queued → running → done`, because the realistic usage pattern is a human
watching, not walking away.

**Enforcement:** contract tests assert every heavy-tier tool follows the `job_id` /
`get_job` shape; a lint or review rule flags any new tool whose expected latency
exceeds N9's interactive budget but which returns synchronously.

### XIV. Configuration Over Hard-Coding

Material inventory, tooling specifications, logistics constraints, environmental
context, and accuracy expectations MUST be managed through MCP configuration
tools/resources, never hard-coded in application logic. Accuracy/tolerance
expectations specifically are managed through named, per-project tolerance profiles
(N11, rebuild/17-numerical-policy.md) — the numerical policy module (V) never varies
by project; N11 profiles do.

**Enforcement:** the same lint rule as principle V (no tolerance literals outside the
policy module) plus a review rule against hard-coded gauge/K-factor/V-die/material
values anywhere outside configuration resources.

## Technology Stack & Architectural Decisions

**Decided 2026-07-21** (rebuild/18-stack-evaluation-plan.md,
rebuild/19-cpp-ts-interface-boundary.md) — this section replaces v1's MVP-era
description in full; that description (Python/CadQuery/FastMCP) had already fallen
out of sync with the actual implemented stack (C++/OCCT via NAPI, TypeScript) before
this rebuild began.

| Decision | Resolution |
|---|---|
| Geometry kernel | OCCT, via the existing C++ wrapper — no move to a Rust or pure-Rust kernel for this rebuild (real spikes ran against both; see rebuild/spikes/SUMMARY.md) |
| Orchestration language | TypeScript (Node) — structure, mutation bookkeeping, job/transaction orchestration only; no geometric computation (principle IV) |
| Geometry/translation-module language | C++ — includes rebuild/13's `evaluate()`, which is kernel-agnostic on its own terms but executes here per principle IV |
| MCP protocol layer | TypeScript |
| Interface binding | NAPI, narrowed to one adapter per kernel port (rebuild/16-kernel-port.md's 7 ports), per the table in rebuild/19 §2 — no general-purpose escape hatch |
| Graph persistence | MySQL-compatible database, versioned with Dolt (B7) — branch/merge/commit/diff are native store operations; geometry is never persisted as truth, always regenerated from the graph |
| Native resource lifecycle | explicit acquire/release, request-scoped; see principle X |

**Revisit trigger:** the stack decision may be reopened once the redesigned graph/
merge logic (principles II–IV) is built and proven stable — not before. Pulling a
stack migration in front of that work was explicitly rejected as the wrong order
(rebuild/19 §0).

## Development Workflow & Quality Gates

**CI gates** (Phase 4 build-out; this constitution states the target, the tooling is
being built): dependency-boundary lint (I), replay-invariant harness (II),
single-derivation lint (III), no-geometry-in-TS boundary lint (IV), tolerance-literal
ban (V, XIV), error-taxonomy exhaustiveness + contract tests (VI), `@fallback` marker
check (VII), complexity/size budgets + exhaustive-match lint (VIII), trace-emission
assertion (IX), native-resource soak/endurance test (X), kerf/safety contract tests
(XI, XII), async-shape contract test (XIII), plus the kernel-level test tier (v1's
ctest equivalent, carried forward unchanged).

**Spec-first flow** (speckit specify → clarify → plan → tasks) is carried over from
v1 unchanged — it worked.

**Definition of done** for any change includes: the replay-invariant test (II) passes;
oracles are strong, not weak (bbox/volume-only assertions are insufficient); error-
taxonomy coverage (VI) is complete for new failure modes; boundaries are lint-clean
(I, IV).

**Repo scaffold:** lint rules live from the first commit of new v2 code — enforcement
on empty code is cheap, retrofitting is not (rebuild/06-plan.md, Risk R4).

## Governance

This constitution supersedes all other practices, guidelines, and conventions in this
repository. Any amendment requires: (1) documenting the rationale, (2) updating
affected interface contracts (rebuild/13–19 as applicable), and (3) a migration plan
for in-flight work.

All implementation decisions MUST be verified against Principles I–XIV before a story
is marked complete. Complexity that cannot be justified against the current phase's
scope (rebuild/06-plan.md) MUST be deferred. Use the `rebuild/` design docs (01–19) as
the authoritative reference for interface contracts, tool schemas, and the phased
build order.

**Version**: 2.0.0 | **Ratified**: 2026-05-13 | **Last Amended**: 2026-07-21

## Amendment History

| Version | Date       | Summary                                                                                   |
|---------|------------|-------------------------------------------------------------------------------------------|
| 1.0     | 2026-05-13 | Initial ratification.                                                                     |
| 1.1     | 2026-05-13 | (See git history.)                                                                        |
| 1.2     | 2026-05-21 | Added `D3-B` (Dolt-persisted semantic graph) for Semantic CAD Phase 1. `D3-A` remains in force for geometry. See [amendments/v1.2-semantic-persistence.md](amendments/v1.2-semantic-persistence.md). |
| 1.3     | 2026-06-01 | Added Principle X (Graceful Failure Over Silent Fallbacks, NON-NEGOTIABLE).                |
| 2.0.0   | 2026-07-21 | Full v2 rebuild amendment: every surviving principle gains a named enforcement mechanism; principle II (Bounded Context Separation) redefined and reversed as principle IV (No Geometric Computation in TypeScript), per the git-history evidence in rebuild/19-cpp-ts-interface-boundary.md; Technology Stack section replaced to match the decided v2 stack (C++/TS retained, no Rust move) and the new port-shaped interface; four new principles added (I, III already existed in spirit but gain enforcement; V, VIII, IX, X are new); one principle (MVP Scope Discipline) retired in favor of rebuild/06-plan.md's living phase plan. |
