# Bug Report: bend allowance never grows the flat outline; bend line isn't centered on its zone

**Status:** Fixed (2026-08-10)
**Date:** 2026-08-08 (reported), fixed 2026-08-10
**Component:** `cpp/src/geometry/translation/manufacturing_graph_evaluator.cc` (`Evaluate()`, `BoundingBends`), `ts/src/v2/graph/evaluate-client.ts` (`buildFlatOutline`, `centeredBendLine`), `ts/src/v2/resources/graph.ts` (`readFlatPattern`, `ensureFlatPatternDxfBlobFresh`)
**Severity:** High — every part with any nonzero bend radius/K-factor produced a flat-pattern DXF/outline that was measurably wrong (too short) and bend-line annotations at the wrong (uncentered, non-compounding) position. This is the literal artifact a manufacturer cuts and press-brakes from.
**Reported during:** Live testing, `testcube.step`'s inner 150mm cube (reconciled as a 4-panel/3-bend chain, `default_bend_radius_mm=2`).

---

## Summary (as reported)

> 1mm thick cube is imported. 150mm edge, split into 6 panels. 4 panels are
> merged by bends with a radii of 2mm, forming a 600x150mm panel with three
> 90° bends.
>
> 1. Part 1 flat panel has a length of 600mm. This doesn't account for the
>    bend radii. It should be longer.
> 2. Part 1 3D object: the bends are misaligned with their position. The
>    bend radii starts at 150mm, but that is not what is meant by "bend at
>    150mm" — a manufacturer centers the press brake at that position, not
>    its start.
> 3. Part 1 bend positions should not be every 150mm once the panel
>    extension from bending is taken into account.

## Root cause

Two separable, compounding defects, both real:

1. **The outline never grew.** `RegionOf`/`BoundingBends` clipped each
   region panel's territory at the bend's own raw hinge line with zero
   offset. The bend-allowance material this leaves neither side "owning"
   was never inserted anywhere — not into `Evaluate()`'s internal
   per-panel data, and not into the exported flat-pattern outline/DXF.
2. **The 3D pivot axis was pinned to the un-widened hinge mark, not the
   allowance zone's center**, so the parent's clipped edge and the axis
   only coincided by accident, and nothing in the flat/2D representation
   ever reflected where the zone's true center actually was.

## Fix — two phases

**Phase 1 (`Evaluate()` itself, C++):** `BoundingBends` now clips at zero
offset from the raw hinge on both sides (a panel's own touching bends
never shrink its measured territory). Alongside the existing pose walk,
`Evaluate()` computes a running 2D `cumulativeShift` per region panel: each
bend adds its own full allowance (`BA = angleRad * (radiusMm + kFactor *
thicknessMm)`), along the hinge's outward normal, to everything in its
child's subtree. Every region panel's own `regionOuter` (and its holes) is
translated by its own `cumulativeShift` before being returned. The 3D pose
walk's fold axis sits at the raw hinge plus the PARENT's own
`cumulativeShift` (never anything from the bend's own allowance) — so the
parent's own clipped edge always lands exactly on the axis with no gap,
and the whole allowance zone becomes one continuous, tangent-correct arc
with no separate "collar" fill needed (superseding this session's earlier,
now-removed `bottomFaceTrue`/`topFaceTrue`/`parentTangentOffsetLocal`
mechanism — see the note in `BUG_REPORT_boundary_resource_disagrees_
with_mesh_after_collar_fix.md`). At `BA=0` for every bend, every shift is
exactly zero — a no-op reproducing prior behavior exactly.

This alone fixed the 3D construction and every per-panel structural field,
but NOT the flat-pattern resource's own top-level `outline`/DXF — that
still read the raw, un-widened `part.outline` directly, so bug #1 as
reported (the literal exported flat panel length) was still broken. Found
by re-running the full TS integration suite end-to-end after the C++ fix,
not assumed fixed from the C++ suite alone.

**Phase 2 (`buildFlatOutline`/`centeredBendLine`, TS + one new C++ field):**

- `BridgeLayout` gained `flatShiftDelta` (the exact `ba * nLeft` value
  already computed in the pose walk, exposed rather than re-derived).
- `RegionPanelLayout` gained `cumulativeShift` (the exact per-panel shift
  already computed, exposed the same way) — needed because a bend's own
  raw hinge, for a bend not directly off the root, must also account for
  whatever its own parent panel already accumulated from ancestor bends
  (bug #3 — positions compound down a chain, not each independently
  ±BA/2 from their own raw mark).
- `buildFlatOutline` (`evaluate-client.ts`) builds the part's single
  combined flat outline: starting from the root panel's own `regionOuter`,
  it walks every bend in parent-before-child order, builds each bend's
  flat "allowance strip" (a parallelogram from the parent panel's own
  bend-adjacent edge, translated by `flatShiftDelta`), and unions
  everything together via the addon's existing `PolygonUnion` primitive
  (no new C++ geometry primitive needed — reused the same one
  `splitBodyByPlane` already calls iteratively from TS).
- `centeredBendLine` computes each bend's true annotated position: the raw
  hinge, plus its parent panel's own `cumulativeShift`, plus half the
  bend's own `flatShiftDelta` — the actual center of the allowance zone,
  compounding correctly down a chain.
- `readFlatPattern` and `ensureFlatPatternDxfBlobFresh` (`graph.ts`) now
  source `outline` and `bendLines` from these instead of the raw stored
  graph.

A real winding-order bug was found and fixed during this phase: the
allowance strip's corner order needs the parent's own tagged edge
REVERSED, followed by the shifted (far) points in the parent's original
order — the naive "near, then far reversed" order produces a
clockwise-wound quad here, which the addon's `PolygonUnion` (a real OCCT
face build, not winding-agnostic across two separate calls) then reports
as two disjoint faces even though the polygons genuinely touch. Verified
directly against the addon before and after the fix, not assumed from
theory.

## Verification

- C++ (`geometry_tests.exe`): 176 test cases (173 passed, 3 pre-existing
  skips), including two new regression tests confirming `flatShiftDelta ==
  ba * nLeft` and its no-op at `BA=0`.
- `check-napi-field-sync.mjs`: 17 NAPI-crossing structs in sync (two new
  fields, `BridgeLayout.flatShiftDelta` and
  `RegionPanelLayout.cumulativeShift`, both round-tripped both directions).
- `npx tsc --noEmit`: clean.
- `vitest --project v2`: 183 passed, 5 pre-existing skips, 0 regressions —
  including a permanent end-to-end regression test
  (`import_fixture_validation.integration.test.ts`) reproducing this
  report's exact scenario.
- **Live re-run of the exact reported scenario** — `testcube.step`,
  `default_bend_radius_mm=2`, the reconciled 4-panel/3-bend chain
  component:
  - Bug #1: flat-pattern outline span is `609.4247779608mm`, exactly
    `600 + 3*BA` (`BA = (pi/2)*2mm = pi mm` at `kFactor=0`), not the
    reported flat `600mm`.
  - Bugs #2/#3: the three bend lines, originally at raw marks
    `x=150,0,300`, now report at `x=151.5708, -1.5708, 304.7124` — each
    centered in its own zone (not starting at the raw mark), and the third
    (two bends deep in the chain) correctly compounds both ancestor
    bends' shifts (`300 + BA + BA/2 = 304.7124`), not just its own.
