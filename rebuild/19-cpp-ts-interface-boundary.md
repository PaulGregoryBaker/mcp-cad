# 19 — C++/TS Interface Boundary & Resource Lifecycle (Phase 3 decision + Phase 2.4 completion)

**Status:** Decision recorded 2026-07-21 (Paul). This closes Phase 3's stack question
and finishes the interface design 16 §4 deliberately deferred until it did.

---

## 0. The decision

**Stack stays as-is: OCCT → C++ wrapper/geometry layer → TS orchestration/MCP.** No
move to Rust for this rebuild.

This was a real evaluation, not a default. Three spikes ran against Rust alternatives
(`rebuild/spikes/`): a Rust+OCCT hybrid (`cadrum`) worked well on import and had one
small, traceable leak; a pure-Rust kernel (`truck`) worked well on import but its
boolean operations can't run on imported geometry at all today, a real gap in the
library, not a rough edge. Full results and the cross-spike scorecard are in
`rebuild/spikes/SUMMARY.md`.

What actually decided it wasn't the spikes, though — it was tracing the real history
behind this rebuild's own reason for existing. The manufacturing-graph pivot (commit
`97f5e28`, 2026-06-10, the direct predecessor of this rebuild) took about a month to
reach, and the git history behind it shows two phases: several days of genuine,
repeated C++ fix attempts on the actual geometry bugs, followed by a pivot to a new
TS-side architecture once those attempts didn't fully resolve things. That pivot
itself turned out to be incomplete — the eventual root cause, found much later, was
two different C++ routines computing the same geometric fact and silently
disagreeing. That's a domain-model bug, not a language bug. It's already being fixed
by this rebuild's redesign (13, 14), independent of stack.

Given that, the case for switching stacks came down to a narrower set of real but
modest benefits (resource-lifecycle discipline, compile-time safety across a binding,
personal Rust+AI productivity) against a real, concrete cost: rewriting the entire MCP
server and orchestration layer on an unproven ecosystem, stacked on top of the
architecture rebuild that's already the highest-risk part of this project. Per Paul's
own priority order (design for long-term performance and functionality; then build
functionality; then build long-term performance), pulling a stack migration in front
of getting the redesigned graph/merge logic working and stable is the wrong order.
The stack question can be revisited later, once there's a known-good design to port
rather than two unknowns to solve at once.

**Keeping the stack is not "no changes."** It comes with three conditions, below.

## 1. Condition 1 — no geometric computation of any kind happens in TS

This is the direct lesson from the history in §0. The dual-derivation bug happened
because a geometric fact was computed twice, on two independent paths, and the two
paths disagreed. The only way to make that class of bug structurally impossible is a
rule with no exceptions:

**TS never computes geometry. Not kernel calls, not pure math, not "this transform
composition is safe because it's just arithmetic." Every geometric fact used anywhere
in the system is computed exactly once, in C++, and TS consumes it by reference.**

This reverses a principle stated in v1's own constitution — that DXF-frame
interpretation logic belonged in TS, with C++ supplying only raw geometry. That
principle is implicated in the bug this rebuild exists to fix. It should not carry
forward.

**Consequence for 13-translation-module-design.md**: 13's `evaluate()` function (the
2D↔3D translation module — fold-tree walk, point mapping, the whole chain formulation)
is written kernel-agnostic and, on its own terms, doesn't need the kernel — it's pure
matrix/point math over data already extracted from the graph. That purity was true and
is still true. But per the rule above, *pure* is not the bar — *single-sided* is the
bar. **`evaluate()` runs in C++.** TS holds the graph's structure (which nodes exist,
how they connect, their stored parameters) and calls into C++ for every derived
geometric quantity: a panel's flat outline, its 3D pose, a mapped point, a flat
pattern. 13's own content doesn't need to change — it was already written
kernel-agnostic — but its status line should note where it executes now that this is
decided. (Applied below.)

## 2. Condition 2 — a narrow, port-shaped interface, one adapter per port

16-kernel-port.md already lists the 7 capability ports (Import/Heal, Measurement,
Boolean, Construction, Tessellation, Clearance, Export) and deliberately left the
actual binding shape undesigned, per Paul's instruction at the time (no interface work
until the stack question resolved). It's resolved. This section finishes that.

**The rule:** every crossing of the C++/TS line goes through exactly one of the
bindings below. Nothing else crosses. No general-purpose "call arbitrary C++ function"
escape hatch, no passing raw kernel handles to TS ever.

| Port | Owner | What crosses to TS | Lifecycle |
|---|---|---|---|
| A — Import/Heal | C++ | a graph-ready measured-piece set (Port B's output, since A always runs into B per 15/16) or a typed failure | handle acquired for the call, released before return |
| B — Measurement | C++ | `{plane, boundaryRing, neighbours}` per piece — plain data, no handles | same |
| C — Boolean (general) | C++ | a new solid reference (opaque ID, not a raw pointer) or `BOOLEAN_OP_FAILED` | handle held only as long as the resulting solid is needed downstream in the *same* request |
| D — Construction | C++ | a solid reference from exact point arrays | same |
| E — Tessellation | C++ (or a LIGHT dependency-light implementation per 16 §0 — still C++-side, not TS) | a mesh buffer (plain data) | request-scoped |
| F — Clearance | C++ (or LIGHT, same note as E) | a distance value / interference report — plain data | request-scoped |
| G — Export | C++ | file bytes (STEP) or plain DXF entity data | request-scoped |
| **13's `evaluate()`** | **C++** (new, per §1) | mapped points, flat patterns, poses — plain data, never a handle | pure function of (graph snapshot, profile); no state held across calls |

Everything in the "what crosses to TS" column is **plain, owned data** — value types
copied across the boundary, or opaque reference IDs the TS side treats as identifiers
and never dereferences directly. **No live kernel handle (`TopoDS_Shape` or
equivalent) is ever visible on the TS side of any binding**, including today's ones
that aren't listed above. This is the same discipline 14 §3.1 already specifies for
the *Layout cache* (native handles are request-scoped, never held across requests) —
this section just makes it a binding-level rule, not only a caching-layer one.

**Enforcement:** the P1 boundary lint (04, Phase 4) checks this once tooling exists —
nothing outside a port's adapter file imports the kernel bindings. This table is what
that lint gets checked against, same relationship 16 §3 already established for the
kernel-agnostic version of this rule.

## 3. Condition 3 — a concrete resource-lifecycle plan, not a deferred abstraction

N13 (02-requirements.md) already states the target: explicit acquire/release, no
reliance on GC finalizers, CI soak tests asserting bounded RSS and handle counts. It's
written as a requirement for the *new* system. Since the stack isn't changing, there's
no reason to wait for Phase 4 to act on it — the current NAPI layer is real code today
(`ts/src/geometry/binding.ts`, `cpp/src/napi/geometry_binding.cc`,
`cpp/src/napi/addon.cc`) and is the closest thing that exists right now to the leak
class Spike 1 also found in `cadrum`'s STEP reader.

**Plan:**

1. **Audit** the current NAPI binding code for where native handles (`TopoDS_Shape`
   and similar) are acquired and how their release is triggered today — explicit call,
   scope exit, or (the N13 failure mode) a GC finalizer with no deterministic timing.
   This is real, scoped follow-up work, not done as part of writing this doc — the
   binding files are ~1000 (TS) and ~2200 (C++) lines and deserve a dedicated pass, not
   a rushed read.
2. **Apply Condition 2's table** as the target shape: once every crossing is one of the
   ports above, the audit in (1) has a fixed, small surface to check against instead of
   an open-ended one.
3. **Add the soak-gate check now**, not deferred to Phase 4's CI buildout — a test that
   runs a representative operation (import + heal, or merge, matching Spike 1's own
   soak methodology) thousands of times against the *current* stack and asserts bounded
   RSS and handle count. This directly answers Boundary A's open half from
   18 §1 (the current stack's leak was never diagnosed as being in the MCP layer or the
   TS↔C++ boundary specifically) — running this now, before more redesign work lands
   on top of the current binding layer, localizes it while it's still cheap to.

## 4. What this changes in other docs

- **13-translation-module-design.md**: status line gets a note that `evaluate()`
  executes in C++ per §1 above. No change to 13's actual content — it was already
  written kernel-agnostic, which is exactly what made this possible to decide later
  without rework.
- **16-kernel-port.md**: §4 ("what is explicitly not decided here") is now decided —
  this doc is the answer. 16's port list and HEAVY/LIGHT split stand unchanged; this
  doc adds the binding shape and ownership on top.
- **18-stack-evaluation-plan.md**: ADR-1 (kernel), ADR-2 (orchestration language),
  ADR-3 (MCP layer language) are all answered the same way — stay C++/TS. ADR-4
  (boundary/lint tooling) is this doc's §2 table, pending Phase 4 tooling to enforce it.
  Spike 4 (P1 lint feasibility) is no longer blocked on picking a language combination
  — it can proceed against the current stack directly.
- **06-plan.md**: Phase 3 exit criterion ("ADRs merged") is met by this doc. Phase 4
  can proceed against a decided stack.

## 5. Open items

- The NAPI audit (§3.1) itself — not done here, real next work.
- Whether Ports E/F (LIGHT per 16 §0) get a dependency-light implementation distinct
  from the HEAVY ports' OCCT-backed code, or share the same C++ binary for simplicity
  now that "which language" is no longer a reason to split them — 16 §0 left this open
  and it still is; revisit once the audit in §3.1 gives a clearer picture of the
  current code's shape.
- Spike 4 (P1 lint/boundary tooling feasibility) — now unblocked, not yet run.
