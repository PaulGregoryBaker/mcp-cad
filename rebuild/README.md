# mcp-cad v2 — Rebuild Design

**Status:** Requirements phase. Stack selection is explicitly deferred until requirements are agreed.

## Why a rebuild

v1 (this repo) succeeded as a domain exploration vehicle: it proved the concept of an
AI-driven sheet-metal orchestrator over MCP, and — more importantly — it surfaced *what is
hard* about this domain. The bug history (see [01-lessons-learned.md](01-lessons-learned.md))
shows that the remaining pain is architectural, not incidental: dual derivation of the same
geometric facts, a source-of-truth that drifted between graph and B-Rep, and a flat-pattern
placement model whose expressiveness doesn't match the domain. Those are rebuild-shaped
problems, not patch-shaped problems.

## Doc map

| Doc | Purpose |
|---|---|
| [01-lessons-learned.md](01-lessons-learned.md) | Evidence from v1 → architectural implications. The "why" behind every v2 invariant. |
| [02-requirements.md](02-requirements.md) | Draft functional + non-functional requirements. **The current work item.** |
| [03-jobs-to-be-done.md](03-jobs-to-be-done.md) | The MCP surface as jobs-to-be-done; critique of v1's ~80-tool surface. |
| [04-architecture-principles.md](04-architecture-principles.md) | Candidate invariants and how they get *enforced* (lint, SDLC, tests) — stack-agnostic. |
| [05-open-questions.md](05-open-questions.md) | Open decisions, ordered by how much they constrain everything downstream. |
| [06-plan.md](06-plan.md) | Phased plan for the rebuild design → build. |
| [07-engineering-drawings.md](07-engineering-drawings.md) | Draft spec for graph-derived engineering drawings (Pivot 1, OPEN-22). |
| [08-case-inventory.md](08-case-inventory.md) | Placement/translation case inventory (Phase 1.4) — what the single geometric solution must solve; validates the Phase 2.1 design. |
| [09-core-correctness-suite.md](09-core-correctness-suite.md) | Harvest plan for the acceptance suite that defines rebuild success (Phase 1.3). |
| [10-tool-triage.md](10-tool-triage.md) | Per-tool KEEP/MERGE/DEMOTE/CUT verdicts for all 76 v1 tools (Phase 1.1) — reviewed & decided. |
| [11-acceptance-criteria.md](11-acceptance-criteria.md) | Measurable acceptance criteria for every FR/NFR, with oracles and suite/gate references (Phase 1.2). |
| [12-domain-notes.md](12-domain-notes.md) | Domain knowledge & v1 salvage (Phase 1.4): bend math, numerical policy facts, DXF conventions, fixtures, the unmerged 010 branch, and the minimal mapping-defect repro. |
| [suite/](suite/) | The core correctness suite itself (Phase 1.3): schema, profiles, generators, cases, driver notes. |
| [13-translation-module-design.md](13-translation-module-design.md) | **Phase 2.1 — the single geometric solution**: a part is ONE flat outline subdivided by bend lines into panels (regions = panels, one entity); chain formulation (root 2D→3D transform + per-bend 3D→3D transforms + bridge charts). Approved 2026-07-19; revised 2026-07-20 to remove per-panel outlines/`T_pc`. |
| [14-graph-schema.md](14-graph-schema.md) | **Phase 2.2 — graph schema v2**, reviewed & approved 2026-07-20: the outline is owned by `part` (not `region_panel`); region panels are derived zones, correctly bounded by their own touching bends. Row-per-entity tables, Dolt diffability, tree invariants, migration policy. |
| [15-mcp-contract.md](15-mcp-contract.md) | **Phase 2.3 — MCP contract v2**, reviewed & approved 2026-07-20: 21 mutating tools across 5 families (Validate/Derive fully moved to resources) + resources split into structural (inline JSON: parts/semantics lists, dedicated findings) vs geometry (always a `Ref`, never inline — mesh/boundary/flat-pattern/drawings). |
| [16-kernel-port.md](16-kernel-port.md) | **Phase 2.4 — kernel port capability list**: 7 ports (Import/Heal, Measurement, Boolean, Construction, Tessellation, Clearance, Export), kernel- and language-agnostic. Splits capabilities into HEAVY (needs a real B-Rep kernel) vs LIGHT (plain computational geometry on 13's exact output) — most of the tool surface never touches a kernel at all. Open points resolved 2026-07-20. |
| [17-numerical-policy.md](17-numerical-policy.md) | **Phase 2.4, cont'd — numerical policy module spec**, reviewed & approved 2026-07-20: the N11-vs-policy boundary rule (project tolerance budgets vs. fixed numerical-robustness constants), fixed constants table, comparison helpers, degeneracy-is-reported-never-repaired discipline. Two open points (edge-alignment tolerance placement, unpinned epsilon values) remain deferred, not blocking. |
| [18-stack-evaluation-plan.md](18-stack-evaluation-plan.md) | **Phase 3 — stack evaluation plan.** DECIDED 2026-07-21 — see 19. Kept as the historical record of the spike process (Spikes 1-3 run to completion, `spikes/SUMMARY.md`); not re-opened. |
| [19-cpp-ts-interface-boundary.md](19-cpp-ts-interface-boundary.md) | **Phase 3 decision + Phase 2.4 completion**, 2026-07-21: stack stays C++/TS — decided not from the spikes directly but from tracing this rebuild's own git history (the manufacturing-graph pivot took a month; real C++ root-cause effort for several days, then a TS-side architectural workaround that was itself incomplete — a domain-model bug, not a language one, already fixed by 13/14 regardless of stack). Three conditions attached: (1) no geometric computation of any kind in TS, not even pure math — 13's `evaluate()` moves to C++; (2) a narrow port-shaped binding, one adapter per port, finishing 16 §4's deferred design; (3) a concrete N13 resource-lifecycle plan (audit the current NAPI layer, add a soak-gate test now rather than deferring to Phase 4). |

## Working agreement for this folder

- Requirements before stack. Nothing in 01–05 may assume a language, kernel, or framework
  beyond what the domain forces (a B-Rep kernel exists somewhere; MCP is the interface).
- Every requirement traces to evidence: a v1 tool, a v1 spec (001–012), a v1 bug, or an
  explicit new product decision. No aspirational requirements without an owner.
- `[PROPOSAL]` marks something Claude proposed that Paul has not yet ratified.
- `[OPEN]` marks an unresolved question (mirrored in 05-open-questions.md).
- v1 stayed runnable through the design and early build phases, serving as the executable
  reference for expected behavior and the source of harvested acceptance tests. That job is
  done — the harvest lives in [09-core-correctness-suite.md](09-core-correctness-suite.md)
  and [suite/](suite/) — and v1 has since been deleted from the repo.
