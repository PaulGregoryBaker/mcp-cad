# Bug Report: `graph://part/{id}/boundary` disagrees with `graph://part/{id}/mesh` at every bend-adjacent panel edge

**Status:** Fixed (2026-08-09, same day)
**Date:** 2026-08-09
**Component:** `ts/src/v2/resources/graph.ts` (`ensureBoundaryBlobFresh`) — serves stale panel corners
**Severity:** High — every bend-adjacent panel edge, on every part with a nonzero bend radius, now visibly disagrees between the two resources meant to describe the exact same 3D solid. User-visible in Form.AI.tion as a reference-wireframe overlay that doesn't line up with the rendered part, on any merged multi-bend part.
**Reported during:** Form.AI.tion UI session, live visual inspection of `testcube.step`'s main (base + 4 walls, merged through bends) part after this session's `docs/BUG_REPORT_nonzero_default_bend_radius_breaks_mesh_construction.md` fix landed.

---

## Summary

`graph://part/{id}/boundary`'s own doc comment (`ts/src/v2/resources/graph.ts:123`) describes it as "the part's exact 3D boundary ... no tessellation" — the same real solid `graph://part/{id}/mesh` serves as a tessellated GLB, just exact instead of triangulated. Both are supposed to describe one single geometric truth (constitution v2.0.0 principle III / `rebuild/01-lessons-learned.md` L1 — one model, never two independently-derived facts that can disagree).

This session's fix for `docs/BUG_REPORT_nonzero_default_bend_radius_breaks_mesh_construction.md` changed how the *actual* 3D solid (`ConstructPartSolid`, feeding `mesh`) is built at every bend-adjacent panel edge: instead of stopping at the panel's own bend-allowance-clipped boundary (`BA/2` short of the true hinge, `RegionOf`/`BoundingBends`' flat-pattern-facing clip), it now correctly extends a small "collar" to the true tangent line, matching real bend geometry.

`ensureBoundaryBlobFresh` was never updated to match — it still serves each panel's `bottomFace`/`topFace` straight from `Evaluate()`'s `RegionPanelLayout` (`graph.ts:443-446`), which that fix deliberately left untouched (on purpose, so `graph://part/{id}/flat-pattern` stayed correct — `RegionOf`'s clip is shared by both the flat-pattern and, previously, the boundary/mesh path). So `boundary` now reports every bend-adjacent panel edge `BA/2` short of where the real, `mesh`-served solid actually is. Before this session's fix, both were *consistently* wrong together (`mesh` was also stuck at the clipped boundary — that was the bug), so this particular disagreement didn't yet exist; fixing `mesh` alone exposed it.

Confirmed live in Form.AI.tion (testCube's merged 4-wall inner part, `default_bend_radius_mm` configured, thickness ≈0.95mm, `radiusMm=2`): overlaying `boundary`'s reported panel-corner wireframe (the blue lines) on the actual rendered solid, the true outer boundary edge — the one edge not adjacent to any bend — lines up exactly. Every bend-adjacent edge does not:
- the two side edges (each adjacent to one bend) fall short of the real solid by roughly one bend-radius-scaled amount (`BA/2`) each
- the top edge — adjacent to bends on *both* sides via a chained fold (a wall panel that is itself parent to a further bend) — is off by roughly twice that

This matches the fix's own mechanism exactly: a collar is added independently per bend-adjacent edge, so a panel edge touched by two bends accumulates two uncorrected `BA/2` gaps relative to `boundary`, while an edge touched by one accumulates one.

## Reproduction

```jsonc
// import_part(file: "testcube.step", profile: {rules: {default_bend_radius_mm: 2.0}})
// -> merged/main part_id X (base panel + 4 walls folded via bends)

// resources/read graph://part/X/boundary
// -> regionPanels[].bottomFace/topFace: every bend-adjacent edge still at the
//    OLD, BA/2-clipped position

// resources/read graph://part/X/mesh
// -> the real solid's corresponding edge, now BA/2 (or 2×BA/2 for a
//    doubly-bend-adjacent edge) further out, per this session's fix
```

Not yet isolated to a minimal C++/TS unit-test repro — found via live visual comparison in the client, not (yet) reproduced as an automated assertion. `map-2d-3d`'s own use of `bottomFace`/`topFace` (`graph.ts:194-195`) is *not* part of this bug — that resource is explicitly mapping the flat pattern's own (clipped) 2D coordinate to its 3D position, which is correctly the clipped position by definition, not a claim about the real solid's outer boundary.

## Suggested fix

`ensureBoundaryBlobFresh`'s `regionPanels[].bottomFace/topFace` need to reflect the same true-tangent-extended corners `ConstructPartSolid`'s collar now builds, not the raw `RegionPanelLayout.bottomFace/topFace` `Evaluate()` produces. Since `Evaluate()` deliberately stays kernel-free and collar-unaware (per `manufacturing_graph_evaluator.hpp`'s own design — see this session's collar fix), this likely means exposing the true-tangent corner points from the C++ side — they're already computed as `tb0/tb1/tt0/tt1` inside `part_solid_construction.cc`'s bridge loop — as part of the NAPI-crossing output, then having `ensureBoundaryBlobFresh` build its arrays from those instead of reading `evaluated.panels[]` directly. This mirrors the exact "expose what `ConstructPartSolid` already computes rather than re-deriving it a second time" pattern this session's own fix used for `BridgeLayout::parentTangentOffsetLocal` — worth checking whether the two can share one exposed field rather than adding a second.

Worth also double-checking every other consumer of `RegionPanelLayout.bottomFace/topFace` for the same assumption (that it's the real 3D solid boundary, not the flat-pattern-facing clip) now that the two have diverged — `graph://part/{id}/full` was checked this session and does *not* expose per-panel `bottomFace`/`topFace` at all, so it's not affected.

## Resolution

Fixed largely as suggested. `RegionPanelLayout` gained two new parallel
arrays, `bottomFaceTrue`/`topFaceTrue` (index-correlated with
`regionOuter`/`bottomFace`/`topFace`), computed in `Evaluate()` itself —
identical to `bottomFace`/`topFace` everywhere except at a vertex bounding
an edge where the panel is the PARENT of a bend, where it's the true
tangent-line position instead. Computed by reusing
`BridgeLayout::parentTangentOffsetLocal` (already correct, already exposed
by this session's earlier mesh-construction fix) rather than re-deriving
anything — `manufacturing_graph_evaluator.cc`'s `Evaluate()` adds a second
pass after building all panels: for each bridge, find the parent panel's
tagged edge via its own `edgeBendId`, and set that edge's two corners to
`pose.Apply(regionOuter[i] + parentTangentOffsetLocal, z)`. Confirmed the
child side needs no correction — it already lands on the true tangent line
today via `Evaluate()`'s existing `childShift` cancellation.

`bottomFace`/`topFace` themselves are untouched (still correctly feed the
panel's own solid extrusion and the flat-pattern clip). `ensureBoundaryBlobFresh`
now sources its (unchanged wire-format) `bottomFace`/`topFace` JSON fields
from `bottomFaceTrue`/`topFaceTrue` instead. No geometric computation moved
to TypeScript — the correction is entirely computed and stored in C++;
TS only selects which pre-computed array to serve.

Wired both the NAPI write side (`WriteRegionPanelLayout`) and read side
(`ReadEvaluateResult`) for the two new fields, and the TS mirror type
(`NapiRegionPanelLayout`), specifically because this session's earlier fix
found a real regression from forgetting exactly this — `check-napi-field-
sync.mjs` confirmed all 17 NAPI-crossing structs stayed in sync throughout.

Verified:
- C++ (`geometry_tests.exe`): 176 test cases (174 baseline + 2 new — one
  confirming the correction is exact and confined to the parent-side edge
  of a bend on both bottom and top, one confirming it's a no-op at
  `radiusMm=0`), all passed, 3 pre-existing skips, 0 regressions.
- `npx tsc --noEmit`: clean.
- `vitest --project v2`: 182 passed (181 baseline + 1 new — an end-to-end
  test through the real NAPI addon confirming a bend-adjacent panel corner
  in `graph://part/{id}/boundary` now lands exactly on the raw hinge
  coordinate rather than `BA/2` short), 5 pre-existing skips, 0 regressions.
- Live re-run against `testcube.step` (`default_bend_radius_mm=2.0`):
  `boundary`'s reported bbox now extends to the true (bend-radius-adjusted)
  part extent, and `mesh` construction still succeeds.

## Superseded (2026-08-10)

The collar mechanism and `bottomFaceTrue`/`topFaceTrue` this fix added no
longer exist. `docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md`'s
fix found that widening the flat outline itself (rather than patching the
3D construction output after the fact) makes the parent's own clipped edge
land exactly on the pivot axis with no separate correction needed —
`boundary` and `mesh` now both read the same `bottomFace`/`topFace`
directly from `Evaluate()`, converged back to one representation. The
underlying symptom this report describes (boundary/mesh disagreement) is
still correctly fixed, just by a different, simpler mechanism than the one
`bottomFaceTrue`/`topFaceTrue` implemented.
