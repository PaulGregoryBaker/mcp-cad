# Bug Report: reconciled bend radius is always exactly 0mm or exactly thickness — never a measured value — causing systematic `MIN_BEND_RADIUS` false positives on imports

> **✅ RESOLVED 2026-08-03.** Scoped per Paul's own steer during triage: the
> assumed radius comes from the org's `ManufacturingProfile`
> (`defaultBendRadiusMm`, absolute mm — the same mechanism
> `evaluate_manufacturability`/`evaluateFindings` already uses), not a raw
> ad-hoc tool parameter and not new settings-persistence infra.
> `import_part` now accepts an optional `profile`, matching
> `evaluateFindings`'s existing pattern exactly, defaulting to
> `DEFAULT_MANUFACTURING_PROFILE` (`defaultBendRadiusMm: 0.0`, i.e. today's
> behavior unchanged when omitted).
>
> **A real design bug was found while implementing this** (not in the
> original report): `tryPivotZ`'s pivot search cannot be coupled to the
> assumed radius — the search verifies against the piece's own TRUE
> measured (always sharp, r=0) position, so a nonzero assumed radius would
> make reconciliation of perfectly ordinary flush geometry spuriously fail.
> Fixed by decoupling: the pivot search and Step 7's self-consistency
> replay always run at r=0 (unchanged from before this fix); the profile's
> `defaultBendRadiusMm` is stamped onto every bend in a separate pass
> *after* that validation passes. This also fixes a second, independent bug
> found in the same investigation: the old convex-branch value
> (`radiusMm=thicknessMm`) never actually round-tripped through
> `Evaluate()`'s own `BottomRadiusMm` formula (would recompute
> `pivotZ=2×thicknessMm`, not `thicknessMm`) — silently masked by
> `kSelfConsistencyToleranceMm`'s 2mm budget for typical thin material, but
> a real latent defect. Both branches now agree at radiusMm=0 internally
> before stamping.
>
> Verified against this report's own repro (`l_bracket_corner_90deg.stp`):
> with no profile, `radiusMm=0.0` and `MIN_BEND_RADIUS` still trips
> (unchanged); with `defaultBendRadiusMm=1.5`, `radiusMm=1.5` on every bend
> and `MIN_BEND_RADIUS` passes. New C++ test confirms a nonzero default
> doesn't perturb which pivot side reconciliation finds. Full C++ ctest (174
> tests, same 3 pre-existing unrelated failures as baseline) and the
> `import_part` TS integration suites pass, 0 regressions.

**Status:** Resolved — see above; original report left unedited below
**Date:** 2026-07-31
**Component:** `cpp/src/geometry/translation/step_reconciliation.cc` (bend radius assignment,
~line 616), interacting with the manufacturability rules engine's `MIN_BEND_RADIUS` check
**Severity:** Medium-High (likely affects most real imported sheet-metal parts, not just
`testcube.step` — every concave-pivot bend is guaranteed to fail this check)
**Reported by:** Paul, from the live app — `testcube.step` shows manufacturing-error findings
for bend radius too small on every fold.

---

## Summary

`import_part`'s reconciliation never measures a bend's actual radius from the source STEP
geometry. It only ever assigns one of exactly two hard-coded values, chosen by which of two
*discrete* pivot points a fold's rigid rotation happens to fit:

```cpp
// step_reconciliation.cc:611-616
// Radius matches the pivot: z=0 (concave, fold touches inner surface)
// → radiusMm=0; z=thicknessMm (convex, fold offset from outer surface)
// → radiusMm=thicknessMm. This is the geometric fold radius derived
// from the measured piece positions, not a manufacturing constraint —
// merge_bodies_with_bend applies its own >=thickness validation.
bend.radiusMm = winner.bottomIsConcave ? 0.0 : thicknessMm;
```

For the (more common, in normal sheet metal) concave-pivot case, this is **always literally
`0.0`** — never a smaller-but-nonzero measured fillet, never anything in between. Fed straight
into the manufacturability rules engine's `MIN_BEND_RADIUS` check (any real minimum > 0mm),
this is a **guaranteed failure for every concave-pivot bend on every import**, regardless of
what the source part's true bend radius actually is.

---

## Reproduction

Verified 2026-07-31 against `l_bracket_corner_90deg.stp` (a simple, stable 2-panel/1-bend
fixture — chosen over `testcube.step` because the latter is currently hitting an unrelated,
apparently-still-in-flux `GE_PANEL_FRAME_FAILED` face-tie-break issue on this build, see note
at the end):

```typescript
const result = dispatchGraphTool(store, 'import_part', { file: 'l_bracket_corner_90deg.stp' });
const full = readGraphResource(store, `graph://part/${result.part_id}/full`);
// full.bends[0]: { radiusMm: 0.0, bottomIsConcave: true, angleDeg: -90.57... }
// full.findings: [
//   { code: 'MIN_BEND_RADIUS', severity: 'error',
//     message: 'Bend ... radius 0.00 mm is below minimum 1.50 mm for this material
//               (thickness 1.50 mm × factor 1.00)' },
//   { code: 'MAX_BEND_ANGLE', severity: 'error',
//     message: 'Bend ... angle -90.5701° is outside [0, 180]' },
// ]
```

`testcube.step` (the fixture Paul actually saw this on) shows the same `MIN_BEND_RADIUS`
pattern per the live app screenshot — same root cause, `radiusMm=0.0` on its concave-pivot
folds.

(The `MAX_BEND_ANGLE` finding alongside it looks like a separate, second issue — the angle
convention producing a negative value outside the validated `[0, 180]` range — not investigated
here since it wasn't what was asked about, flagging only so it's not mistaken for a
side-effect of the radius fix.)

---

## Analysis — two possible readings, not distinguished here

1. **The source STEP geometry genuinely has a sharp, zero-radius fold** (hand-modeled without a
   fillet) — in which case `MIN_BEND_RADIUS` is arguably doing its job correctly: a truly sharp
   crease isn't press-brake-manufacturable without *some* finite radius, and this is a real,
   legitimate finding about the fixture as modeled.
2. **The source geometry has a real, small fillet that the reconciliation can't see** — the fold
   detector (`tryPivotZ`) only ever tests two *discrete* candidate pivots (z=0 or
   z=thicknessMm), never fits or measures an actual intermediate radius from the piece
   geometry. Any real fillet, however small, either gets silently collapsed to one of those two
   exact values or (if neither pivot fits within tolerance) rejected entirely as
   `kNonDevelopableFold` ("likely a curved/filleted fold, out of this slice's scope" — the
   function's own comment, a few lines above the radius assignment). Genuine intermediate
   radii are explicitly out of scope for this reconciliation model today.

Either way, the practical consequence is the same: **every concave-pivot bend produced by
`import_part` today reports `radiusMm=0.0` unconditionally** — not a measured "this part
happens to have a sharp fold," but a structural fact of how this code works, for every part,
every time. Whether that's individually correct per-fixture (reading 1) or systematically
wrong (reading 2), the *validation* side treating it as a confirmed physical measurement
rather than "this reconciliation model doesn't represent radius on this axis at all" seems
worth reconsidering regardless of which reading applies to any given fixture.

---

## Impact

- `MIN_BEND_RADIUS` will fire on essentially every imported part with a normal (concave)
  fold direction — likely the majority of real sheet-metal imports, not an edge case specific
  to `testcube.step`.
- Makes the finding non-actionable as a DFM signal in its current form: the user has no way to
  distinguish "your part genuinely has an unmanufacturable sharp crease" from "the importer
  doesn't track radius on this fold direction at all."

---

## Possible directions (not proposing a specific fix — geometry-model decision)

- Actually measure/fit a fold radius from the source geometry rather than only testing the two
  discrete z=0/z=thickness pivots (the harder, more correct option — extends the reconciliation
  model's scope, ties into the same "curved/filleted fold" gap already called out as
  out-of-scope).
- Or, keep the current sharp-fold-only model but stop feeding its placeholder `radiusMm=0.0`
  into `MIN_BEND_RADIUS` as if it were a real measurement — e.g. a flag on reconciliation-
  derived bends distinguishing "measured" from "modeled as sharp by construction," and either
  skip the check or phrase the finding differently for those.
- Or (least invasive, matches the fuse-tolerance fix's spirit): default concave-pivot radius to
  something manufacturable (e.g. `thicknessMm`, same as the convex branch already does) instead
  of `0.0`, on the assumption that a truly-intended-as-sharp fold is rare and most real parts
  should be treated as needing *some* finite tooling radius unless explicitly authored otherwise.

Flagging the tradeoff rather than picking one — this changes what the reconciliation claims to
know about a fold's true radius, which seems like a call for whoever owns the manufacturability
rules/reconciliation model design, not something to guess at here.

---

## Note: `testcube.step` currently also hits an unrelated import failure

While reproducing, `testcube.step` itself failed to import at all on the current build with
`GE_PANEL_FRAME_FAILED: getPanelFrame: 3 distinct candidate faces tie on extent ... and are
also tied on outwardness ... refusing to guess` — appears related to very recent, still-
uncommitted work in `cpp/src/geometry_service_shell.cc` and the recent
`0187a08 fix: getPanelFrame face-selection tie-break` commit. Not the subject of this report
(used `l_bracket_corner_90deg.stp` instead, which reproduces the same `MIN_BEND_RADIUS` pattern
cleanly) — mentioning only so it isn't mistaken for a consequence of anything above, in case
it's still being actively worked on.

---

## Links

- Radius assignment: `cpp/src/geometry/translation/step_reconciliation.cc:568-616`
  (`tryPivotZ`, the `bend.radiusMm = winner.bottomIsConcave ? 0.0 : thicknessMm` line)
- `kNonDevelopableFold` (the "curved/filleted fold, out of scope" rejection path):
  same file, ~line 590
- `MIN_BEND_RADIUS` rule: C++ validation module (`cpp/src/geometry/validation/`, per the
  manufacturability-rules-engine commit `73c7501`)
- Fixture used for repro: `cpp/tests/fixtures/l_bracket_corner_90deg.stp`
