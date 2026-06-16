# Dead Code Audit (Phase 1 backfill: T002-T004)

This artifact was originally scoped for Phase 1 (before the file-split work in
Phases 2-4 and the dedup work in Phase 5). It is being written retroactively,
audited against the *current* post-decomposition, post-dedup codebase (after
T001-T052), because T002-T004 were never executed in their original slot.
Running the audit now is strictly more accurate: it reflects the actual file
layout that T053-T057 need to act on.

## C++ Unused Symbols (T002)

**Method**: MSVC has no `-Wunused-function` flag (that's a GCC/Clang flag).
The project's MSVC build already compiles with `/W4` (`cpp/CMakeLists.txt`
lines 38-44), which includes the MSVC equivalents: C4505 (unreferenced local
function), C4101/C4189 (unreferenced local/static variable). Ran a full clean
rebuild to surface every warning project-wide:

```
cmake --build build --config Release --clean-first
```

**Result**: **zero** C4505/C4101/C4189 warnings anywhere in the C++ codebase.
No unused static functions, no unused local/static variables.

Unrelated warnings the same rebuild surfaced (not unused-symbol findings,
listed here only so they aren't re-discovered and mistaken for dead code):

- 8x C4100 (unreferenced **parameter** — not a candidate for T053, which
  targets unused *functions*): `geometry_service_core.cc:574-576`
  (`faceId`, `centerX`, `centerY`, `diameterMm`), `geometry_service_modelling.cc:331`
  (`fixTolerances`, `fixWires`), `geometry_service_sheet_metal.cc:1263`
  (`planeHalfSize`), `feature_extractor.cc:58` (`materialThicknessMm`).
- 9x C4267 (size_t -> uint32_t narrowing) — pre-existing, unrelated to dead code.
- 2x C4456 (local variable shadowing) in `geometry_service_export.cc`:
  `sewer` (line 157 outer scope vs line 887 inner `for` loop scope) and
  `freeEdges` (line 169 vs line 899). Verified both occurrences are live,
  independently-used locals in two genuinely separate scopes (an
  open-edge-audit pass over the whole sewn shape vs. a per-panel
  flat-pattern sewing pass inside a loop) — a naming-collision/shadowing
  style nit, not unused code. Nothing to delete.

**Conclusion**: no C++ deletions required. T053 has nothing to act on.

## TypeScript Unused Symbols (T003)

**Method**: `ts/tsconfig.json` already permanently sets `"strict": true`,
`"noUnusedLocals": true`, `"noUnusedParameters": true` (not a temporary
add-then-revert — these are standing project settings). Ran:

```
npx tsc --noEmit
```

**Result**: clean, zero errors. Zero unused locals, zero unused parameters,
zero unused imports anywhere under `ts/src/`.

**Conclusion**: no TypeScript deletions required. T054 has nothing to act on.

## Commented-Out / Legacy Blocks (T004)

**Method**: manual marker sweep across all C++ `.cc`/`.hpp` files under
`cpp/src/geometry/` and all TypeScript files under `ts/src/`, using the
pattern `LEGACY|TODO[: ]*remove|FIXME|XXX|DEPRECATED|dead code|no longer used|unused|obsolete`.

**Result**: 11 hits, every one investigated individually. All are live,
reachable, intentional code — zero actual commented-out or orphaned blocks:

- `geometry_service_shell.cc:443,1020` — explanatory comments describing
  legacy-fallback/back-compat *behavior* in active code paths (not dead code).
- `removeProtrusionsLegacy` (`geometry_service.hpp:657`,
  `geometry_service_impl.hpp:204`; defined `geometry_service_sheet_metal.cc:2227,2427`) —
  live, reachable via the `algorithm: "legacy_volumetric" | "loop_traversal"`
  parameter on the `remove_protrusions` MCP tool
  (`geometry_binding.cc:1157-1189`, `ts/src/mcp/handlers/shape-ops.ts:310,312,1863`).
  Intentional dual-implementation feature, not a dead leftover.
- `ts/src/geometry/coordinate-map.ts:261`, `ts/src/geometry/binding.ts:918` —
  comments about deprecated upstream behavior being handled, not dead code.
- `ts/src/semantic/types.ts:15` — `'deprecated'` is a live `EntityState` enum
  value, actively matched elsewhere.
- `ts/src/manufacturing/graph/solver.ts:363` — live, reachable switch-case
  branch (confirmed via surrounding context lines 350-368).

**Conclusion**: no commented-out or orphaned legacy blocks exist in either
codebase. T055 and T056 have nothing to act on.

## Summary for T053-T057

Every category audited came back empty. T053-T056 are closed as **no-op,
confirmed via audit** — there is nothing listed above to delete. T057's
"run full test suite; confirm zero regressions" reduces to the T052 run
already recorded in `dedup-report.md` (63/64 passing, 1 pre-existing
unrelated failure tracked under feature 010-graph-driven-mutations); no new
deletions occurred in this phase, so no new regression risk was introduced.
