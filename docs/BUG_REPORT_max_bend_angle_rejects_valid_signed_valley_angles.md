# Bug Report: `MAX_BEND_ANGLE` rejects every valley bend (negative `angleDeg`), contradicting the graph model's own signed-angle convention

**Status:** Fixed (2026-08-09, same day)
**Date:** 2026-08-09
**Component:** `cpp/src/geometry/validation/rules/bend_angle.cc` (`CheckBendAngle`)
**Severity:** High — fires unconditionally on every reconciled bend whose fold is a valley, which for many ordinary shapes (any box/enclosure/channel where adjacent walls fold the same rotational direction relative to the base) is every single bend. `testcube.step` fails 5/5 bends on a completely fresh `import_part`, no other operation involved.
**Reported during:** Form.AI.tion UI session, manual test: import `testcube.step`, no other action.

---

## Summary

`Bend.angleDeg` is documented (both in the TS graph model and, per `step_reconciliation.cc`'s own comments, in the C++ reconciliation that produces it) as **signed**: positive = mountain, negative = valley — "signed angleDeg from the TRUE measured position (never a hand-wavy default)" (`step_reconciliation.cc:504`). Reconciliation legitimately computes this via `std::atan2(...)`, which returns a value in `[-180, 180]`, and for `testcube.step` every one of its 5 bends measures as **exactly `-90°`** (a valley fold, which is entirely normal for a box-like part).

`CheckBendAngle` (`bend_angle.cc:11-16`) doesn't know about that convention — it checks the raw signed value against an unsigned range:

```cpp
double angle = bend.angleDeg;
if (angle < 0.0 || angle > profile.maxBendAngleDeg) {
  // ... "outside [0, max]"
}
```

`ManufacturingProfile::maxBendAngleDeg` defaults to `180.0` with the comment `// angle must be in [0, max]` (`profile.hpp:24`) — confirming the check was written assuming `angleDeg` is an unsigned magnitude, not the signed value the rest of the system actually produces and relies on (the sign is load-bearing elsewhere too — e.g. `bottomIsConcave`/mountain-valley classification, mesh/DXF reconstruction).

**Net effect:** any bend reconciled as a valley (negative angle) always fails `MAX_BEND_ANGLE`, regardless of whether the angle itself (`90°`, well within a sane `[0,180]` range in magnitude) is remotely unreasonable. This isn't an edge case — it's the common case for enclosure-style parts.

## Reproduction

```jsonc
// import_part("testcube.step") — no profile, no other args
// graph://part/{id}/full's findings include, for every one of the 5 bends:
{
  "code": "MAX_BEND_ANGLE",
  "severity": "error",
  "message": "Bend <id> angle -90° is outside [0, 180]",
  "anchors": [{ "kind": "bend", "id": "<id>" }],
  "recommendedFix": null
}
```

Reproduced live against `node ts/dist/v2/server.js` directly (not inferred from source alone) — both with and without a `profile.rules.default_bend_radius_mm` supplied (ruling out any interaction with the separate, already-tracked `MIN_BEND_RADIUS` behavior in `docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md`).

## Suggested fix

Check the *magnitude*, not the raw signed value — `std::abs(bend.angleDeg)` against `[0, profile.maxBendAngleDeg]` — so the rule validates "is this a physically reasonable bend angle" independent of which side it folds toward, consistent with how the rest of the system (mountain/valley via sign, `bottomIsConcave` as the separate concavity classification) already treats `angleDeg`'s sign as orientation, not magnitude.

Worth double-checking whether any other validation rule or downstream consumer makes the same unsigned-range assumption about `angleDeg`, given `bend_radius.cc` (checked while investigating the related report above) does not have this issue — it correctly compares `radiusMm` (always non-negative) with no sign involved.

## Resolution

Fixed as suggested: `CheckBendAngle` (`cpp/src/geometry/validation/rules/bend_angle.cc`)
now compares `std::abs(bend.angleDeg)` against `[0, profile.maxBendAngleDeg]` instead of
the raw signed value. Confirmed `bend_angle.cc` is the only validation rule that reads
`angleDeg` — no other rule needed the same fix.

Updated the two mirrored test suites that had baked in the old (wrong) assumption as an
explicit assertion — both had a scenario literally titled "negative angle produces
MAX_BEND_ANGLE":
- `cpp/tests/validation_rules_test.cc` — that case now asserts a valley bend in range
  produces no finding; added a new case for a negative angle *beyond* the max magnitude
  (still correctly rejected).
- `ts/tests/integration/findings_resource.integration.test.ts` — same change, plus the
  equivalent below-`-180` case.

Verified:
- C++ (`geometry_tests.exe`): 172 test cases, 1613 assertions, all passed (3 pre-existing
  skips, 0 regressions).
- TS (`vitest --project v2`): 177 passed, 5 pre-existing skips, 0 regressions.
- Live reproduction against the rebuilt addon: importing `testcube.step` via
  `dispatchGraphTool('import_part', ...)` reconciles all 5 bends at exactly `-90°` as
  before, and `graph://part/{id}/full`'s findings now contain zero `MAX_BEND_ANGLE`
  entries (down from 5/5).
