# 04 — Architecture Principles & Enforcement (stack-agnostic)

**Premise.** v1 already had a constitution (Deterministic Geometry; Bounded Context
Separation; Rollback-First; Structured Errors; Graceful Failure Over Silent Fallbacks…).
The principles were right; the failure was that they were *checked in review prose*, not
*enforced by machinery*. v2's rule: **a principle that isn't mechanically enforced is a
wish.** Every principle below therefore names its enforcement mechanism.

These are stack-agnostic: "lint rule" means whatever boundary/complexity linter the chosen
stack provides; "port" means an interface in the chosen language.

---

## P1. Layered core with one-way dependencies

```
MCP boundary (protocol, schemas, error mapping)
        ↓
Application services (jobs J1–J9: orchestration, transactions)
        ↓
Domain core (manufacturing graph, bend math, placement model, numerical policy)
        ↓ (port only)
GeometryKernel adapter (the ONLY module that touches the B-Rep kernel)
```

- Domain core has zero dependencies on MCP, kernel bindings, or I/O. Pure and unit-testable.
- **Enforcement:** dependency-boundary lint in CI (fail the build on any edge that
  violates the arrows); kernel binding package importable only by the adapter module.

## P2. Graph is the single source of truth (replay invariant)

`replay(graph) ≡ current geometry` after every mutating operation.

Graph history is **version-control-shaped** (B5): branch = divergent history, merge =
graph-level operation gated by review, undo = replay of an earlier version. The replay
invariant applies at every branch head, which is also what makes branch/merge *possible*
— a branch that can't replay can't be reviewed or merged.

- **Enforcement:** a test-harness middleware wraps every mutating tool in the acceptance
  suite: execute → serialize graph → replay from scratch → assert geometric equivalence
  (position probes + residual budget, per L4). New tools inherit this for free; opting out
  is impossible rather than forgotten.

## P3. One geometric solution (complete the pivot)

The 2D↔3D problem gets a **single geometric solution that solves all situations** (L1):
one geometric model — the translation module (OPEN-14) — from which every frame, flat
pattern, DXF, and mapping derives. Prohibited outright: parallel solvers, per-case gates,
fallback paths, **compensating offsets, and end-state alignment assumptions** — the
mapping is a direct 3D geometric mapping, and a failing case is a defect of the model,
fixed in the model and validated against the full case inventory. The problem is complex;
the complexity lives in the geometric model, not in patches around it.

- **Enforcement (architecture):** the kernel port exposes exactly one operation returning
  measured geometry to the translation module; no raw projection primitives are exported.
  Lint: no module outside the translation module may import projection/unfold internals.
- **Enforcement (process — binds the AI too):** any change adding a second derivation
  path or case-arbitration gate to the geometric core is rejected in review by rule;
  fixes must keep the entire case inventory green, not one case.

## P4. Central numerical policy

One module owns units, tolerances (named, documented rationale), winding convention
(canonical CCW), and comparison helpers (L5).

- **Enforcement:** lint ban on numeric tolerance literals in geometry/domain code
  (allowlist: the policy module); code-review checklist item; property tests for winding
  canonicalization.

## P5. Typed error taxonomy at every boundary

Kernel adapter maps every kernel failure to a typed domain error; MCP layer maps domain
errors to the wire schema {code, message, recoverable, suggestedTool}. Raw kernel strings
never cross a boundary (L6).

- **Enforcement:** exhaustiveness checking on the error enum; contract tests that assert
  every tool's failure modes are in the schema; lint ban on rethrowing untyped errors
  across layer boundaries.

## P6. No silent fallbacks

If the model can't represent a case, the operation fails with a typed, actionable error
(L3). Fallback paths require an explicit, documented decision with a test proving the
fallback's output is *correct*, not merely non-crashing.

- **Enforcement:** review rule + a lint marker: any code path tagged `@fallback` must
  reference an ADR and a dedicated correctness test.

## P7. SOLID, applied where it earns its keep

The rebuild brief asks for SOLID enforcement via SDLC. Concretely for this domain:

- **S:** pipeline phases are named modules (validate / derive / place / fuse / persist —
  the shape the 1430-line handler was hiding, L10). Enforcement: per-module size and
  cyclomatic-complexity lint budgets.
- **O/L:** new node types and new placement cases extend the graph schema and placement
  model without editing switch statements scattered across layers. Enforcement:
  exhaustive-match lint so adding a node type produces compile/lint errors at every site
  that must handle it (this is *deliberate* friction — the opposite of silent fallback).
- **I:** the kernel port is split by capability (tessellate, boolean, unfold-derive,
  import/heal) so fakes for testing are small.
- **D:** application services depend on ports; adapters are injected at the composition
  root. Enforcement: boundary lint (P1) + no constructor-side instantiation of adapters
  outside the composition root.

## P8. Observability as a feature

Every pipeline stage can dump inputs/outputs (graph JSON, DXF, mesh) under a debug flag;
every operation emits a structured trace (op, params hash, graph delta, timings,
residuals) (L9).

- **Enforcement:** the pipeline interface *requires* a describe/dump capability per stage;
  acceptance harness asserts traces are emitted.

## P9. SDLC (the "SLCD" item from the brief)

- Constitution v2: evolve v1's constitution with the enforcement column added — use
  `speckit-constitution` so all dependent spec templates stay in sync.
- Spec-first flow (speckit specify → clarify → plan → tasks) carried over from v1 — it
  worked; keep it.
- Definition of done includes: replay-invariant test (P2), strong oracles (L4), error
  taxonomy coverage (P5), lint-clean boundaries (P1).
- CI gates: boundary lint, complexity budgets, tolerance-literal ban, acceptance suite,
  plus the kernel-level test tier (v1's ctest equivalent).

## Open items for this doc

- `[OPEN-14]` Placement/translation model — **direction set 2026-07-18, design still
  owed.** This is the never-solved core of v1 and the main motivation for the rebuild.
  Paul's direction: abstract the translations (2D↔3D placement/transform logic) into
  **its own separate class/module, thoroughly testable in isolation**, then consumed by
  the manufacturing graph. Ratified, with two sharpenings from v1 evidence:
  1. *Isolation is necessary but not sufficient.* v1 had a coordinate-mapping module and
     it was still wrong — because its **inputs** (frame, ring) came from uncorrelated
     derivations (L1). The isolated module must therefore own the **entire chain** —
     given a graph node, it alone produces frame, flat shape, 2D placement, and both
     mapping directions — so consistency is internal to the class, not an agreement
     between callers.
  2. *Tested in isolation means property-based, not example-based.* Round-trip identity
     (map3d∘map2d = id within profile tolerance), composition associativity over bend
     chains, and invariance under graph replay — run against the full case inventory
     (straight chains, corner chains, multi-lobed composites, protrusions, curved-bend
     nodes) with zero kernel dependency, so thousands of cases run in milliseconds.
  Gets its own design doc + review in Phase 2.1 before any stack talk.
- `[OPEN-15]` Graph schema versioning/migration policy (v1 never had to migrate persisted
  graphs; v2 with real users will).
