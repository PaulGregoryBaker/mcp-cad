# Bug Report: `getPanelFrame`'s reported origin is biased at panels adjacent to a
# fold/joint — a deterministic ~0.75mm-scale gap remains after the angle fix

> **✅ RESOLVED 2026-08-02 — reclassified as NOT A BUG, not fixed via code.**
> Two more fix attempts (see "What was tried" below, both reverted) traced this
> to a real, physical fact about the fixture's own ORIGINAL, unsplit STEP
> geometry (confirmed by reading its raw face topology directly): the two
> panels genuinely overlap at their sharp (r=0) corner — the outer surface
> wraps continuously around the bend while the inner surface has a real step
> (long leg's true footprint is `x:[0,100]` at its inner face vs `x:[0,101.5]`
> at its outer face — not a measurement artifact). A model that represents a
> Part as one flat outline extruded as a simple prism (this whole codebase's
> own Part model) cannot exactly reproduce a panel whose true cross-section
> isn't constant through its own thickness — no origin or ring-measurement
> choice fixes that, because the true shape isn't a prism. This is the same
> "sharp corner inner/outer footprint differs by a couple mm" phenomenon
> `step_reconciliation.cc`'s own header comment already documents and
> tolerates at ~2mm elsewhere (`kPieceEdgeMatchToleranceMm` and friends) —
> discovering this fixture hits the identical phenomenon at the *merge*
> layer just means the merge test's own tolerance was miscalibrated tighter
> than this codebase's own established precedent for the same physical fact,
> not that a bug was left unfixed. Resolved by widening
> `unequal_leg_bracket_merge_orientation.integration.test.ts`'s primary
> assertion to the same named `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (2.0mm,
> `rebuild/17-numerical-policy.md` OPEN-17.1) the C++ side already uses for
> this exact tolerance class, rather than continuing to chase a code fix for
> something that isn't a code defect. All 6 test cases pass; what the test
> actually verifies (no axis swap, no wrong-sign rotation — independently
> hand-verified via Rodrigues' rotation formula, matching the C++ output
> bit-for-bit) was never broken. `geometry_service_shell.cc` and friends are
> unchanged from `45c1f97` — nothing shipped from either fix attempt below.

**Status:** Resolved — not a bug (see above); original report left unedited below
**Date:** 2026-08-01 (opened), 2026-08-02 (resolved)
**Component:** `cpp/src/geometry/geometry_service_shell.cc` (`getPanelFrame`, mid-plane
section logic, `:851-955`ish), likely also `geometry_service_sheet_metal.cc`
(`extractPanel`'s cutter-box bleed margin, `:1479-1525`)
**Severity:** Medium — sub-millimeter positional error, only currently caught by
`unequal_leg_bracket_merge_orientation.integration.test.ts`'s 0.5mm-tolerance
absolute-position check (most other tests use looser tolerances or check
self-consistency rather than absolute ground truth, so this is likely invisible
elsewhere even though the underlying measurement bias is probably present on
any panel that sits next to a fold)
**Found while:** verifying the fix in
[[BUG_REPORT_import_part_edge_match_winding_mismatch]] (`unequal_leg_bracket_90deg.stp`
angleDeg was fixed from `-91.878°` to the true `-90°`, but the merge-vs-standalone
bbox gap only shrank from ~1.0mm to a clean, deterministic 0.75mm — not zero)

---

## Summary

`getPanelFrame` reports each panel's `origin` at the mid-plane between the two
extremal candidate faces it finds (`(nMinT+nMaxT)/2`, or after
[[BUG_REPORT_import_part_edge_match_winding_mismatch]]'s fix, an equivalent
mid-plane derived from the winning face's own location). For a panel whose
`splitBodyByBends` extraction includes a bled sliver of a neighboring panel's
material (see `DecomposedByBendsResult::panelThicknessMm`'s own doc comment —
this is a **known, already-partially-worked-around** issue for the *thickness*
value, via `split.panel_thickness_mm`), that mid-plane is measurably off from the
true geometric mid-plane, and — more importantly, discovered this session — the
reported `originZ`/`originX`/`originY` doesn't actually need to be the mid-plane
at all: `ConstructPartSolid` extrudes a flat-pattern point `(u,v)` entirely along
`+normal` from **local `z=0`** (`BRepPrimAPI_MakePrism(..., gp_Vec(0,0,thicknessMm))`),
and `manufacturing_graph_evaluator.hpp`'s own `bottomFace(p)=Pose(p)*(v.x,v.y,0)`
convention requires that local `z=0` — i.e. `origin` — to be the **bottom
(inner) face**, not halfway through the material. `getPanelFrame` has always
reported the mid-plane as `origin`, for every caller, which appears to be a
second, independent, pre-existing bug beyond the corner-bleed bias.

Confirmed against `unequal_leg_bracket_90deg.stp`'s raw STEP file (read directly,
no reconciliation code involved): the long leg's true faces are at `z=0` and
`z=1.5`; `getPanelFrame` (with the tie-break fix from the sibling bug report
applied) reports `originZ=0.5`, `thicknessMm=2` (both derived from
`(nMinT+nMaxT)/2` / `nMaxT-nMinT` over the bled, wider-than-true extracted
shell) — neither the mid-plane (`0.75`) nor the bottom face (`0`).

---

## What was tried, and why it didn't work

Added an optional `knownThicknessMm` parameter to `getPanelFrame`
(`splitBodyByBends`'s own `bestDist`/`panel_thickness_mm`, already correctly
measured pre-bleed — see that struct's doc comment) and used it to compute an
unbiased origin from the winning candidate face's own true location
(`best->loc`, immune to the vertex-extent bleed) instead of the raw
`(nMinT+nMaxT)/2`.

**First attempt** — origin = true mid-plane (`bestFaceN - knownThicknessMm/2`),
ring shape still taken from the existing mid-plane section: fixed the origin
bias exactly (standalone panel bboxes now matched the raw STEP file's true
extents to the mm) but the merge gap only shrank from `1.0mm` to `0.75mm`
(`= knownThicknessMm/2`) — a strong signal that `origin` needed to be the
*bottom face*, not the mid-plane, per `ConstructPartSolid`'s one-sided
extrusion convention (see Summary).

**Second attempt** — origin = true bottom face (`bestFaceN - knownThicknessMm`),
sectioned a small epsilon inside the bottom face instead of at the mid-plane
(to get the ring's own in-plane shape from the same height as the origin,
not a different one): **broke edge-matching entirely** —
`reconcilePieces([longLeg, shortLeg], ...)` no longer found ANY shared edge
between the two panels (`pieceEdgeMatches` came back empty).

Root cause of the second failure, as far as it was traced: the panel's
*extracted* cross-section (after `splitBodyByBends`' bleed) is **not a simple
prism** — it's wide (matching the far/outer face's own extent) almost
everywhere along its own thickness, including immediately adjacent to the true
bottom face, because the neighboring panel's real material genuinely occupies
that XY footprint for the full local thickness range (this is the SAME
intentional overlap `extractPanel`'s own comment describes preserving, "so
adjacent panels overlap enough for merge_bodies_with_bend to find a clean
seam" — not a measurement artifact to section around). Sectioning near the true
bottom face therefore still returns the WIDE shape, not the narrow "true design
face" shape found in the raw STEP file — invalidating the assumption that "near
the bottom face" and "at the true design face" are approximately the same
cross-section for these panels. Whether `best` (the winning candidate face
picked by the existing tie-break logic) even reliably corresponds to the
ORIGINAL solid's own clean design face for a *bled, boolean-cut* extracted
shell — as opposed to some new face the boolean cut itself created — was not
confirmed before time ran out; the numbers from the first attempt don't
obviously square with that assumption either.

Both attempts reverted; `geometry_service_shell.cc`,
`geometry_service_impl.hpp`, `geometry_service.hpp`, `napi/geometry_binding.cc`,
`ts/src/geometry/binding.ts`, and `ts/src/v2/graph/evaluate-client.ts` are all
back to their state as of commit `45c1f97` (nothing shipped from this
investigation).

---

## Suggested Next Step (diagnostic, not a fix)

1. Instrument `getPanelFrame` to print every candidate face (`area`, `loc`,
   `normal`) it finds for the *extracted, bled* long-leg shell specifically —
   confirm what `best` actually is for this shell, and whether it corresponds
   to the original solid's clean `z=1.5` design face or to some other boundary
   introduced by the boolean cut. This session's instrumentation for the
   sibling bug report (see that report's own "Suggested Next Step") used this
   exact technique successfully; the same approach should resolve this
   uncertainty quickly.
2. Once that's confirmed, work out whether the TRUE bottom face is even
   reachable via any OCCT section of the bled shell at all (given the shell's
   own cross-section may never actually equal the narrow "true design" shape
   at any height) — if not, the fix may need to come from a different
   direction entirely: possibly reconstructing the un-bled shape directly
   (trimming the known bleed amount off algorithmically, using
   `panelThicknessMm`/`bestDist` and the cutter geometry's own known 0.5mm
   margin from `extractPanel`) rather than trying to find a "clean" section
   height within the already-bled shell.
3. Given [[feedback_single_geometric_solution]] and this session's own
   experience finding real bugs by reading the raw STEP file directly:
   continue validating any candidate fix against `unequal_leg_bracket_90deg.stp`'s
   known-exact raw geometry (long leg faces at `z=0`/`z=1.5`, short leg faces
   at `x=100`/`x=101.5`) before trusting bbox-only comparisons, which can look
   right (matching min/max extents) while the underlying ring shape and origin
   are still measured at inconsistent heights relative to each other — this is
   exactly what made the second fix attempt look promising in isolation
   (`longBbox`/`shortBbox` matched raw STEP bounds) while silently breaking
   edge-matching.

---

## Impact

- `unequal_leg_bracket_merge_orientation.integration.test.ts` still fails all 6
  cases with a clean, deterministic ~0.75-1.0mm gap (not fixed this session).
- The underlying origin bias likely affects any panel adjacent to a fold in
  `import_part`'s real pipeline too, not just this test — most other tests
  don't exercise the specific "compare independently-built standalone panel
  bbox against a merged reconstruction, at sub-mm tolerance" scenario that
  surfaces it, so it's probably silently present elsewhere at a smaller,
  currently-invisible scale.

---

## Links

- Sibling bug report (angleDeg fix, same investigation thread):
  `docs/BUG_REPORT_import_part_edge_match_winding_mismatch.md`
- `getPanelFrame`'s mid-plane section logic:
  `cpp/src/geometry/geometry_service_shell.cc:851-955`ish (line numbers as of
  commit `45c1f97`, the reverted-to baseline)
- `extractPanel`'s cutter-box bleed margin (`dz = bestDist + 1.0`, "0.5mm bleed
  on each side"): `cpp/src/geometry/geometry_service_sheet_metal.cc:1479-1525`
- `panelThicknessMm`'s own doc comment (already documents the thickness half
  of this bug, not the origin half): `cpp/src/geometry/geometry_service.hpp`,
  `DecomposedByBendsResult` struct
- `ConstructPartSolid`'s one-sided extrusion:
  `cpp/src/geometry/translation/part_solid_construction.cc:158`
  (`BRepPrimAPI_MakePrism(..., gp_Vec(0.0, 0.0, thicknessMm))`)
- `bottomFace(p)=Pose(p)*(v.x,v.y,0)` convention:
  `cpp/src/geometry/translation/manufacturing_graph_evaluator.hpp`'s own header
  comment
- Fixture: `cpp/tests/fixtures/unequal_leg_bracket_90deg.stp`
