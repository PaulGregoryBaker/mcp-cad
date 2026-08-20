# Bug Report: reconstructed panel positions drift from the source-of-truth envelope as bend radius grows

**Status:** Fixed (2026-08-20)
**Date:** 2026-08-17
**Component:** `cpp/src/geometry/translation/manufacturing_graph_evaluator.cc` (`Evaluate()`'s pose walk — axis position formula) and `cpp/src/geometry/translation/part_solid_construction.cc` (bridge construction). `BoundingBends`/`RegionOf` were NOT changed — see "Solution" below for why.
**Severity:** High — visibly wrong geometry ("panels in the wrong place") for any part reconstructed with a nonzero bend radius, which is the normal case.
**Reported during:** Manual testing in Form.AI.tion, testcube.step's inner-cube component — user-observed gap between two walls that visibly grows as you trace around the shape.

## Statement of the requirement (source of truth)

The overall shape of a manufactured part — its outer envelope — is fixed by design and does not change based on which manufacturing method (in this case, which bend radius) is used to produce it. Choosing a different bend radius may change the local shape of a joint/corner, but the resulting part must still occupy the same overall space. This tool's purpose is to let a user explore different manufacturing approaches (different bend radii, different fold strategies) and see how each one's *resulting shape* compares to the target — the target itself does not move.

## Summary

Every panel's own flat geometry (`rawOuter`, used for 3D wall construction) is built from the graph's raw hinge coordinates, which are derived by `step_reconciliation.cc` at `radiusMm=0` (i.e., they describe the real part's true, sharp-cornered dimensions). The 3D pose walk positions each bend's rotation axis directly "above" this same raw hinge, offset only in the panel's own thickness direction (by `rBottom`, the bottom surface's radius) — never offset in-plane. This makes every individual bend exactly tangent on both surfaces (verified extensively, see below) — but it means each panel's own flat length, measured from the raw hinge to the panel's own far edge, is held fixed *regardless of the bend radius chosen*.

Holding leg length fixed while rotating around a wider-radius pivot is not neutral: it measurably increases how far the folded panel's far edge reaches, in proportion to the radius. Confirmed by direct measurement on testcube.step's real, reconciled inner-cube component (four panels connected by three 90° bends):

- **Perpendicular distance between opposite walls** (nominal/true value: 150mm, confirmed by the fact that the one dimension unaffected by any bend, the panel width, measures exactly 150mm regardless of radius):
  - `default_bend_radius_mm=0`: 150.0000mm (matches — r=0 is the reference state `step_reconciliation.cc` derives the graph from).
  - `default_bend_radius_mm=2`: **154.0000mm** — exactly +2mm per bend-corner (two corners' worth of growth, both wall-pairs measuring identically).
- **The same component has a branching graph topology** (one panel is parent to two separate bends, one of which has its own child) — three of the shape's four corners are real, modeled bends; the fourth is two free edges that are never connected by a bend at all, relying entirely on the reconstructed geometry landing in the same place it started. Measured directly: the gap between those two free edges is 0.0000mm at radius=0, and **5.6569mm at radius=2** — this is very likely the *same* root cause manifesting as an outright non-closure, rather than a separate defect: as the three real bends' reach grows, the untouched fourth corner is dragged out of alignment with them, since nothing about its own construction changes to compensate.

This is **not** the `childShiftWorld` tangency bug fixed earlier the same day (commit `f4db0cd`) — every real, modeled bend in this exact component is independently verified exact, on both surfaces, at every radius tested. This is about panel *reach* growing with radius, not any individual bend's own position being wrong.

## Reproduction / permanent regression tests

`cpp/tests/manufacturing_graph_evaluator_test.cc` (fast, no STEP import or NAPI round-trip):
- `GraphEvaluator: N=4 square tube's opposite-wall spacing stays fixed regardless of bend radius` — **originally FAILED** (100mm reference → 99 → 98 → 97 → 94mm as radius swept 0→0.5→1→1.5→3, exactly linear, −2mm per 1mm radius). **PASSES** after the fix, exactly, at every radius.
- `GraphEvaluator: N=6 hexagon's opposite-wall spacing stays fixed regardless of bend radius` — **originally FAILED**, same pattern. **PASSES** after the fix.
- `GraphEvaluator: N=4 loop with non-uniform bend radii still closes exactly` — **originally FAILED** (2.8284mm gap). **PASSES** after the fix, exactly.

`ts/tests/integration/import_fixture_validation.integration.test.ts` (real STEP import, full NAPI round-trip, real 3D solid construction):
- `testcube.step: 3D distance between opposite walls of the inner cube does not exceed 150mm` — **originally FAILED** (154mm at radius=2). **PASSES** after the fix.
- `testcube.step: opposite-wall distance is identical across a bend-radius sweep` — **originally FAILED** (150→151→...→154mm). **PASSES** after the fix, exactly, across the full sweep.
- `testcube.step: branching inner-cube component closes its unmodeled 4th seam at a real bend radius` — **originally FAILED** (5.6569mm gap at radius=2). **PASSES** after the fix.
- `testcube.step: outer assembly and inner component bounding boxes, checked individually` — was passing throughout (a bounding-box-only check was never tight enough to catch this defect — kept as a companion test documenting that fact).
- `cauldron.step: overall reconstructed bounding box stays identical across a bend-radius sweep` — **still FAILS**, but for an unrelated, pre-existing reason (`GE_BRIDGE_UNSUPPORTED_TOPOLOGY: zone boundary spans more than one edge on region panel`). Cauldron.step has a real, separate construction limitation (a bend's zone boundary spanning more than one panel edge, not yet supported) that blocks this check before the envelope question can even be measured — out of scope for this fix, tracked separately.
- `testcube.step: reconstructed geometry (every resulting part) matches the original imported solid at radius=0` — **still FAILS**, but this is a pre-existing, unrelated ~3% volume deficit present even at radius=0 (where this fix is a no-op) — not touched by this work.

## Why the regular-loop closure tests still pass (and always will)

All of the N-gon "closes exactly" tests use a *regular* loop — every bend identical (same angle, radius, kFactor, thickness) — and that regularity is exactly what hides this bug from a pure closure check, provably: a closed loop's own panels form a vector sum v₁+v₂+...+vₙ = 0. If this bug scales every step vector by the same factor k — which it does, whenever every bend in the loop is identical — the sum becomes k·(v₁+...+vₙ) = k·0 = 0 regardless of k. The loop still closes; it's just been uniformly rescaled. This isn't a coincidence of these particular tests, it's linear algebra, and it is why every regular-loop closure test in this file passed while this defect was present the whole time.

Breaking the uniformity breaks the cancellation: the `N=4 loop with non-uniform bend radii` test above gives one bend a different radius from the other two, and the loop fails to close by 2.8mm — turning the same underlying defect into an outright non-closure instead of a hidden size discrepancy. This also explains testcube's branching-component non-closure (its three real bends are identical to each other, so the vector-sum argument still applies to them — but the fourth, unmodeled corner is never scaled by k at all, so the three-corner shape simply doesn't reach it anymore).

The practical conclusion: a pure "does it close" test can only ever catch this bug class when the loop is *irregular* (bends that differ from each other) or has an unmodeled corner. A regular-loop closure test passing is not evidence this bug is absent — it is mathematically incapable of detecting it.

## Testing strategy

1. **Opposite-wall extent bound** (done) — `testcube.step: 3D distance between opposite walls...`.
2. **Envelope invariance across a radius sweep** (done) — `testcube.step: opposite-wall distance is identical across a bend-radius sweep...`.
3. **Extend the synthetic N-gon closure tests with absolute size at swept radii** (done) — N=4 and N=6 opposite-wall sweep tests above, both fast, no STEP import needed.
4. **A non-uniform (irregular) closure test** (done) — needed because the regular-loop tests above can *only* show a size discrepancy, never an outright non-closure, for the mathematical reason explained above. The `N=4 loop with non-uniform bend radii` test is the one place in the suite that demonstrates this bug can break closure itself, not just size.
5. **Same opposite-wall/envelope check against cauldron.step** — still blocked by the separate, pre-existing `GE_BRIDGE_UNSUPPORTED_TOPOLOGY` limitation; not this fix's scope.
6. **Permanent unit-level regression pinning the corrected formula** (done) — every test in the list above IS that regression pin now that the fix lands; additionally, `cpp/tests/manufacturing_graph_evaluator_test.cc`'s tangency-probe tests (parent/child wall edges vs. the axis, bridge-end-reaches-child-edge) were rewritten to check the new, correct relationship (`sqrt(setback^2 + radius^2)` from the axis, and an edge gap of exactly `2*setbackMm`) instead of the old exact-tangency assumption that's no longer true by design.
7. **Audit pass over existing closure-style tests for the same blind spot** — done for the tests this bug report's own investigation touched (the "far outer corner" test that used to pin the drift as *expected* — see "Root causes" below — and the `merge_bodies_with_bend` volume bound, which encoded the old, buggy construction's coincidental zero-gap property as a false upper bound). Not a systematic audit of the entire suite.

## What was ruled out while investigating

- The axis position's *height* offset (`pivotZ = ±rBottom`) is correct and unrelated to this bug — it already makes both bottom and top surfaces exactly tangent at their respective true radii, for any in-plane axis position.
- A circle tangent to a line at a *known* point has no freedom in its center's in-plane position — it must sit on the perpendicular through that point. This means the old axis (in-plane position = the raw hinge, untrimmed) could only be exactly correct in the special case where the true tangent point *is* the raw hinge, which is only true at `radiusMm=0`.
- Repositioning the axis in-plane, on its own, **cannot** fix this — proved algebraically (not just tested): rotating a fixed-length child by a fixed angle about ANY parallel axis reproduces the sharp-corner (`radiusMm=0`) target only in the trivial `radiusMm=0` case. A rotation about a parallel axis always differs from one about the true axis by exactly one constant translation, and cancelling that translation for every point simultaneously forces the axis's height back to its own `radiusMm=0` value — so axis position alone, or a translation added afterward alone, can never do it while the height stays real. This is why every earlier attempt at an axis-only fix (this session's, and the ones already reverted before it — see `manufacturing_graph_evaluator.cc`'s own git history) failed.

## Root cause and fix

**The formula.** Fixing this requires a second, per-bend quantity beyond the axis height: an in-plane offset that *also* extends the child's own effective local origin by twice that amount, before the fold rotation is applied. Both directly follow from one requirement — reproduce the `radiusMm=0` target exactly, for any point, given the real (nonzero) pivot height — solved directly, not guessed:

```
D = pivotZ_true - pivotZ = concave ? +radiusMm : -radiusMm
axisInPlaneOffset = D * tan(radians(angleDeg) / 2)      // angleDeg SIGNED, not abs()
childExtension = 2 * axisInPlaneOffset, along nLeft
```

Verified exactly (0 residual, machine precision) for both fold directions, five bend angles, and chains of bends of arbitrary depth, by direct comparison against a from-scratch `radiusMm=0` reconstruction in an independent Python model before being ported to C++.

**Two real implementation bugs found while landing this, both caught by checking against real STEP data, not synthetic tests alone:**

1. **A sign bug.** `concave` (`BottomIsConcave`) and `angleDeg`'s sign are documented as independent facts — a fold's bottom-surface direction and its rotation direction don't have to agree. Every synthetic test in this codebase happened to author them aligned (concave ⟺ `angleDeg≥0`), under which the formula above collapses to a simpler `radiusMm*tan(|angleDeg|/2)`, always positive, because the two signs cancel. The first implementation used that simplified, magnitude-only form unconditionally — which is *wrong* whenever a real graph sets them independently. `testcube.step`'s own real, reconciled bends do exactly this (`bottomIsConcave=true` with `angleDeg=-90`) — a case no synthetic test exercised, and the one that caught it: the opposite-wall measurement was reproducibly *worse* after the first (magnitude-only) fix landed than before it. Comparing the C++ addon's actual pose output against an independent by-hand Python replica of the same formula, for testcube's exact real parameters, showed identical rotation matrices but different translations — isolating the bug to the offset's sign, not the rotation.
2. **The panel wall and the bridge no longer agreed about where flat material ends.** The pose-walk fix alone doesn't touch the panel's own wall geometry (`RegionOf`/`BoundingBends` stay deliberately untrimmed — see below) or the bridge's construction (`part_solid_construction.cc`), so once the axis moved, the wall's own un-trimmed edge and the bridge's tangent-point construction disagreed by exactly `setbackMm`, on both sides. This surfaced as real `fuse produced N disconnected solid(s)` construction failures on testcube.step (not just a numeric mismatch) — proving this needed a construction-level fix, not just the pose-walk formula. Fixed by building the bridge in three pieces instead of one: a flat "collar" from the parent's real edge to its true tangent point, the real tangent-preserving revolve between the two tangent points, and a matching collar from the child's true tangent point to its real edge. `BoundingBends`/`RegionOf` were deliberately left untouched — that clip is shared with the flat-pattern/DXF export, which is already correct, and the wall/bridge mismatch can be fully resolved on the bridge side alone.

**Why `BoundingBends`/`RegionOf` (the panel outline clip) was never touched, despite earlier investigation suggesting panel trimming was needed:** it isn't. The pose walk determines *where* things go; the panel's own flat *shape* and the bridge's own *shape* are separate concerns owned by separate code. Trimming the panel's own boundary would have meant touching code shared with the flat-pattern/DXF export — the fix instead makes the bridge (which only affects 3D construction) span the real gap between the un-trimmed panel walls, leaving the flat pattern untouched. This turned out to be sufficient; no code outside `manufacturing_graph_evaluator.cc`'s pose walk and `part_solid_construction.cc`'s bridge construction needed to change.

**A related, downstream discovery:** with the fix landed, `merge_bodies_with_bend`'s own volume test started failing with volume *above* its old upper bound. Investigation showed the old bound (`volume ≤ naiveSum`, the two flat panels' volume with no bend material at all) was never a real physical law — it happened to hold only because the *old, buggy* construction placed the child panel's edge exactly at the bridge's far end (zero gap by construction), so panel/panel overlap always outweighed the bridge's own small volume. A real, non-sharp bend genuinely contains more material than its two flat panels alone — it has real curved material connecting them, which a sharp corner doesn't. The test now checks volume against the physically-derived `naiveSum + bendAllowanceMaterial` (same `BA = angleRad * (radiusMm + kFactor*thicknessMm)` formula the engine itself uses), to a tight, justified tolerance — not an arbitrary wide band.

## Verification

- **C++** (`geometry_tests.exe`): 188/188 test cases pass (2118/2118 assertions), 3 pre-existing skips, 0 regressions. Includes every test listed under "Reproduction" above, now passing, plus several existing tangency-probe tests rewritten to check the new, correct (no-longer-exactly-tangent, `sqrt(setback^2+radius^2)`) relationship instead of the old assumption the fix deliberately changes.
- **TS** (`vitest --project v2`): 191/198 pass, 5 pre-existing skips, 2 pre-existing failures unrelated to this bug (testcube's own radius=0 volume deficit; cauldron's `GE_BRIDGE_UNSUPPORTED_TOPOLOGY` construction limitation) — 0 regressions.
- **Real STEP data**: testcube.step's actual reconciled bends (`bottomIsConcave=true`, `angleDeg=-90`, a branching topology with one panel parent to two bends directly) checked by hand against an independent Python replica of the formula — panel poses now match their own `radiusMm=0` reference exactly (bit-for-bit), at every radius tested, confirming the fix holds on real, branching, non-synthetic data, not just linear synthetic chains.
