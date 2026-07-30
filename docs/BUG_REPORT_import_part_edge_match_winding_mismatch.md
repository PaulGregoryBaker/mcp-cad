# Bug Report: `reconcilePieces` treats genuinely-adjacent panels as disconnected
# — shared edge matches in the SAME winding order, not reversed

**Status:** Open — root cause narrowed to `getPanelFrame` face selection, not yet fixed
**Date:** 2026-07-30
**Component:** `cpp/src/geometry/translation/step_reconciliation.cc` (`ReconcilePieces`
edge-matching, `:220-245`), likely caused upstream by
`cpp/src/geometry/geometry_service_shell.cc` (`getPanelFrame`, `:615-`)
**Severity:** High — silently produces a WRONG result (disconnected fragments instead
of one correctly-bent part) for real, simple fixtures; no error is raised
**Found while:** investigating why `import_part`'s newly-exposed `component_part_ids`
(see [this session's fix, commit `57be094`]) was non-empty for fixtures that should
have zero disconnected components

---

## Summary

Two committed fixtures that should reconcile into one part with one bend instead
silently split into disconnected fragments:

- **`unequal_leg_bracket_90deg.stp`** — a deliberately simple 2-panel, single 90°
  fold fixture (its own test file describes it as "sharing their full common edge").
  `import_part` returns `panel_count: 2` but `bend_count: 0` — the two panels never
  get linked; each becomes its own disconnected 1-panel part.
- **`hollow_cube.stp`** — a closed 6-panel loop, topologically identical to
  `simple_box.stp` (which DOES reconcile correctly: `panel_count: 6`,
  `bend_count: 5`, one part). `hollow_cube.stp` instead produces a 4-panel main
  component (`bend_count: 3`) plus 2 disconnected single-panel components.

Neither of these fixtures is a legitimate multi-body case (unlike `testcube.step`'s
two hollow cubes joined by bridge flanges, or `cube_with_flanges.stp` — both
correctly produce multiple components and that's expected). These two are real
edge-matching failures.

**Why this is worse than it looks:** before commits `4f89251`/`09fb9fb`
("ReconcilePieces handles disconnected components gracefully"), this exact failure
mode threw `GE_DISCONNECTED_PIECES` loudly. The graceful-fallback change (intended
for genuinely separate sub-assemblies) now also silently masks this class of bug —
a part that should be one correctly-bent object instead comes back as several
disconnected flat fragments, with no error and no obvious signal something is wrong,
unless a caller specifically checks `component_part_ids`/`bend_count`.

---

## Reproduction

```typescript
import { geometryBinding } from './src/geometry/binding';
const solidId = geometryBinding.loadStep('cpp/tests/fixtures/unequal_leg_bracket_90deg.stp');
geometryBinding.healGeometryEx(solidId, true, true);
const split = geometryBinding.splitBodyByBends(solidId, 45, 5.0);
const pieces = split.panel_ids.map((shellId) => {
  const frame = geometryBinding.getPanelFrame(shellId);
  return { origin: {...}, uAxis: {...}, vAxis: {...}, normal: {...}, ringLocal: frame.ring,
           thicknessMm: frame.thicknessMm };
});
const reconciled = geometryBinding.reconcilePieces(pieces, pieces[0].thicknessMm);
// reconciled.ok === true, reconciled.graph.bends === [], reconciled.graphs.length === 2
// (should be: bends.length === 1, graphs.length === 1)
```

Also reproducible end-to-end via `dispatchGraphTool(store, 'import_part', { file: ... })`
— `result.bend_count === 0`, `result.component_part_ids.length === 1`.

---

## Geometry Data (from the standalone repro above, `unequal_leg_bracket_90deg.stp`)

**Piece 0** (long leg), origin `(100.5, 0, 1.5)`, `uAxis=(0,1,0)`, `vAxis=(0,0,-1)`,
`normal=(-1,0,0)`. Local ring: `[(100,0),(100,31.5),(0,31.5),(0,0)]`.

**Piece 1** (short leg), origin `(0, 0, 0.5)`, `uAxis=(1,0,0)`, `vAxis=(0,1,0)`,
`normal=(0,0,1)`. Local ring: `[(101.5,0),(101.5,100),(0,100),(0,0)]`.

Both frames are independently right-handed (`uAxis × vAxis == normal` holds for
both) — this is not a handedness bug in the frame construction itself.

True 3D positions of the edge each piece measures as its "shared" edge with the
other (piece 0's local `v=0` edge, i.e. ring edge 3; piece 1's local `u=101.5` edge,
i.e. ring edge 0):

```
piece 0 edge 3: a0=(100.5, 0, 1.5)   -> a1=(100.5, 100, 1.5)
piece 1 edge 0: b0=(101.5, 0, 0.5)   -> b1=(101.5, 100, 0.5)
```

`ReconcilePieces` requires **reversed** correspondence (`a0≈b1 && a1≈b0`) — the
documented, geometrically-required invariant: two real CCW-wound panels meeting at
a real fold always traverse their shared edge in opposite directions (a standard
manifold-boundary-orientation fact, the same one `part_merge.hpp` relies on).

Here, instead:
```
a0 (100.5,0,1.5) vs b0 (101.5,0,0.5):     diff = (1, 0, -1), length ≈ 1.414mm
a1 (100.5,100,1.5) vs b1 (101.5,100,0.5): diff = (1, 0, -1), length ≈ 1.414mm
```

i.e. `a0≈b0` and `a1≈b1` — **same** order, not reversed. Both endpoint gaps are
well inside `kPieceEdgeMatchToleranceMm` (2.0mm), so this is not a tolerance
problem — the matcher correctly rejects this pairing because reversed
correspondence genuinely doesn't hold, only same-order does.

---

## Analysis

Both panel frames are independently right-handed, and the ~1.414mm gap
(`(1,0,-1)`, i.e. 1mm along piece 0/1's shared axis and 1mm along the panel-normal
direction) is suspiciously consistent with a **half-thickness offset along one
panel's own normal** — piece 0's material is 2mm thick (`thicknessMm: 2`); a
1mm shift along its normal is exactly half that. That's the signature of
`getPanelFrame` measuring one of the two panels from its wrong face (inner vs
outer, or equivalently the wrong side of the mid-plane), not a defect in
`ReconcilePieces`'s matching logic itself — `ReconcilePieces` is correctly
rejecting a pairing that, given the ACTUAL (slightly wrong) measured positions,
genuinely isn't a valid reversed-edge match.

`getPanelFrame` (`geometry_service_shell.cc:615-`) was itself the target of a very
recent fix (commit `c00e758`, "extent-based face selection + BRepAlgoAPI_Section
outline") for a closely related class of bug — two sibling panels of the same part
silently referencing opposite physical faces. The section-at-mid-plane approach
that fix introduced (`:742-751`) sidesteps the outer-vs-inner face choice for the
RING itself (it sections at the panel's mid-plane, not either face), but the
`ndir`/`best->normal` sign choice up through that point (`:656-730`, the extremal-face
filter + smallest-extent tie-break) still determines the U/V frame orientation used
to build `ringLocal` — and that's what ultimately controls a panel's ring winding.
This bug's symptom (a consistent, uniform offset + same-order-not-reversed winding
on exactly one of two panels) is consistent with that normal-sign choice still
being wrong in some case `c00e758` didn't fully cover, rather than a new,
unrelated defect.

**Not yet confirmed against the actual `getPanelFrame` code path** (this required
re-implementing the pairwise 3D distance check outside the kernel, using the
already-measured `pieces` array — it does not yet trace which candidate/tie-break
branch inside `getPanelFrame` picks the wrong normal for which panel). That
confirmation is the natural next step.

---

## Suggested Next Step (diagnostic, not a fix)

1. Add temporary logging inside `getPanelFrame` printing which `PlanarCandidate`
   (`area`, `centroid`, `normal`) was selected as `best`, for the two panel shells
   of `unequal_leg_bracket_90deg.stp` specifically — confirm which one has its
   normal/ring measured from the "wrong" face.
2. Check whether `hollow_cube.stp`'s 2 disconnected panels (out of its 6) show the
   same signature (consistent offset along one panel's own normal, same-order
   instead of reversed edge correspondence) — if so, this is one root cause behind
   both fixtures, not two independent bugs.
3. Given `P3` ("single geometric solution" — [[feedback_single_geometric_solution]])
   this should be root-caused inside `getPanelFrame`'s own face/normal selection,
   not patched by loosening `ReconcilePieces`'s tolerance or reversed-correspondence
   requirement — the matcher is correctly detecting a real upstream measurement
   inconsistency, not being overly strict.

---

## Impact

- `import_part` silently returns a structurally wrong graph (disconnected flat
  fragments instead of one correctly-bent part) for at least 2 committed fixtures,
  with no error — a regression in correctness hidden by the (otherwise-correct)
  graceful-disconnected-components behavior added in `4f89251`/`09fb9fb`.
- Any real STEP file with a similar face-selection edge case will silently import
  as multiple disconnected flat panels instead of one properly-bent part.

---

## Links

- `ReconcilePieces` edge matching: `step_reconciliation.cc:220-245`
  (`kPieceEdgeMatchToleranceMm = 2.0`, `:25`)
- `getPanelFrame` face/normal selection: `geometry_service_shell.cc:615-730`
  (candidate collection `:656-681`, extremal filter `:683-712`,
  smallest-extent tie-break `:714-730`)
- Prior fix in this exact area: commit `c00e758` ("getPanelFrame — extent-based
  face selection + BRepAlgoAPI_Section outline")
- Graceful-disconnected-components change that unmasked this as a silent-wrong-
  result instead of a loud error: commits `4f89251`, `09fb9fb`
- Failing tests (left failing deliberately, not relaxed):
  `ts/tests/integration/import_part_fixtures.integration.test.ts`
  (`unequal_leg_bracket_90deg.stp`, `hollow_cube.stp` cases),
  `ts/tests/integration/unequal_leg_bracket_merge_orientation.integration.test.ts`
  (all 6 cases — same root cause, traced independently via `pieceEdgeMatches`
  coming back empty)
- Fixtures: `cpp/tests/fixtures/unequal_leg_bracket_90deg.stp`,
  `cpp/tests/fixtures/hollow_cube.stp`
