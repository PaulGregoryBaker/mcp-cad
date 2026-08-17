# Bug Report: any nonzero `default_bend_radius_mm` breaks `graph://part/{id}/mesh` construction for `testcube.step`'s main part

**Status:** Fixed (2026-08-09, same day)
**Date:** 2026-08-09
**Component:** Mesh/geometry construction (fuse step) — likely `manufacturing_graph_evaluator.cc` or wherever the per-bend "revolved bridge solid" is fused into the part's 3D reconstruction, given `docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md`'s own note that `radiusMm` sizes that bridge solid.
**Severity:** High — the manufacturing profile mechanism (`profile.rules.default_bend_radius_mm`, restored 2026-08-09 specifically so imports don't get a sharp 0mm fold by default) makes this trigger on *every* import once a project has any non-zero default configured, for any multi-bend part shaped like this fixture.
**Reported during:** Form.AI.tion UI session — user imported `testcube.step` with a manufacturing profile default bend radius of 2.0mm (a normal, encouraged use of the just-added profile-definition feature) and the parts with bends never appeared in the 3D viewport.

---

## Summary

`graph://part/{id}/mesh` for `testcube.step`'s main (multi-bend) part fails with:

```json
{"code":"GE_CONSTRUCTION_FAILED","message":"fuse produced 2 disconnected solid(s) joining piece index 2 — every panel/bridge pair is expected to share a coincident face","recoverable":false}
```

This is **not** specific to 2.0mm — isolated by re-importing the same fixture at several radii and reading the main part's mesh each time:

| `default_bend_radius_mm` | mesh result |
|---|---|
| omitted (server default) | ✅ succeeds |
| `0` | ✅ succeeds |
| `0.5` | ❌ `GE_CONSTRUCTION_FAILED` |
| `1.0` | ❌ `GE_CONSTRUCTION_FAILED` (identical message) |
| `2.0` | ❌ `GE_CONSTRUCTION_FAILED` (identical message) |

Only `radiusMm == 0` (sharp fold) constructs successfully — **any** positive radius fails identically, always citing "piece index 2." The other 6 of 8 parts from the same import (protrusions/components without multi-panel fuses) mesh successfully regardless of radius; only the main part (12 panels, 8 bends, the multi-piece fuse) and one other multi-panel component part fail.

Findings/flat-pattern resources are unaffected — `graph://part/{id}/full`'s `bends[].radiusMm` correctly reflects the configured default, and `graph://part/{id}/flat-pattern`'s DXF/outline are correct at every radius tested. Only mesh (3D) construction breaks.

## Why this matters now specifically

Before 2026-08-09, `import_part`'s `profile` was rarely exercised end-to-end with a real nonzero radius in the UI — the client had no path to *set* one deliberately. As of today, Form.AI.tion gates every project's first import behind a manufacturing profile definition step (a client-side change made in response to `docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md`'s 2026-08-09 resolution, which restored `default_bend_radius_mm` specifically so real MIN_BEND_RADIUS findings replace the sharp-fold default). Any project defining a sane non-sharp default — which is now the encouraged, gated path — hits this on its very first import for any part shaped like this fixture.

## Reproduction

```jsonc
// import_part(file: "testcube.step", profile: {rules: {default_bend_radius_mm: 2.0}})
// → part_id X, 12 panels, 8 bends

// resources/read graph://part/X/mesh
{"code":"GE_CONSTRUCTION_FAILED","message":"fuse produced 2 disconnected solid(s) joining piece index 2 — every panel/bridge pair is expected to share a coincident face","recoverable":false}
```

Reproduced live against `node ts/dist/v2/server.js` directly, varying only `default_bend_radius_mm` (null/0/0.5/1.0/2.0) across otherwise-identical imports of the same fixture file.

## Suggested next step

"Piece index 2" plus "every panel/bridge pair is expected to share a coincident face" both point at the fuse step's coincident-face assumption breaking once a bend's bridge solid has real volume (radius > 0) instead of degenerating to a shared edge at r=0 — worth checking whether the bridge solid's placement/sizing at piece 2's junction is using stale (r=0) geometry from an earlier stage while a later fuse step expects the radius-adjusted one, or whether the coincident-face tolerance check itself needs to account for the bridge solid's now-nonzero extent.

## Client-side handling (already fixed in Form.AI.tion)

The client was silently swallowing this exception per-part (`_importPartV2` in `mcp_session_provider.dart`) — the affected part still imported (graph/flat-pattern data intact) but simply never got a 3D mesh, with zero indication anything had failed. It now surfaces a visible warning card ("3D mesh unavailable: <part>") with the real error message. This doesn't fix the underlying construction failure, just stops it from looking like a part that legitimately has no mesh.

## Resolution

Two layered bugs, both in the geometry the "suggested next step" above pointed at.

**Bug 1 — the real root cause.** `ConstructPartSolid` built each bend's bridge
by revolving the *parent* panel's own zone-boundary quad — already clipped
`BA/2` in from the raw hinge (`BoundingBends`,
`manufacturing_graph_evaluator.cc`) — through the fold angle. The child
panel's pose already carries a compensating shift that cancels its own
`BA/2` offset before folding, so the revolve's far end lands exactly on the
child's boundary — but only when `BA == 0` (`radiusMm==0` and
`kFactor==0`). The parent side had no analogous correction: the bridge's
*starting* profile was the parent's already-offset edge, not the true
tangent line at the raw hinge. The gap this left is proportional to `BA/2`,
zero only at r=0 — which is exactly why the table above showed r=0 succeed
and every r>0 fail identically.

This didn't show up in any existing test because every prior nonzero-radius
case in `part_solid_construction_test.cc` is a **linear chain** (each panel
parent to at most one bend) — the same mismatch there resolves as a
harmless volumetric *overlap* (fuse still merges into one solid), never
manifesting as the hard "N disconnected solids" error. `testcube.step`'s
root panel is parent to 4 direct bends (a box-base-with-4-walls topology,
its literal shape) — the first test-uncovered case where the mismatch opens
a real *gap* on a child instead.

Fixed by anchoring each bridge's revolve profile at the true tangent line
(the raw hinge, transformed by the parent's own pose) instead of the
parent's clipped edge, and — since the child side's correction lives in its
*pose* (works for exactly one bend) but a panel can be parent to several
bends at once — adding a small flat "collar" solid per bridge that closes
the resulting parent-side gap locally, skipped when it's zero-width
(`radiusMm=0, kFactor=0`, today's sharp-fold case). Confined to
`part_solid_construction.cc` (plus exposing the raw hinge as a new
`BridgeLayout::parentTangentOffsetLocal` field the fix needs) — no change
to `RegionOf`/flat-pattern clipping, so `graph://part/{id}/flat-pattern`
(already correct) is untouched.

**Bug 2 — found only by testing against the real NAPI addon, not direct C++
unit tests.** `evaluatePartGraph`'s result is round-tripped through JS
before being passed back into `constructPartSolid` (`evaluate-client.ts`'s
`constructPart`). `translation_binding.cc`'s `WriteBridgeLayout`/
`ReadEvaluateResult` — and the TS mirror type `NapiBridgeLayout` — weren't
updated to carry the new `parentTangentOffsetLocal` field, so it silently
round-tripped as `{0,0}` regardless of the real value: Bug 1's fix compiled
and passed every direct-C++ test (`ConstructPartSolid` called straight from
C++ never exercises this boundary) while still reproducing the exact
original failure live. Caught by re-running the bug's own live repro after
the "fix" — a reminder that this project's `check-napi-field-sync.mjs`
lint only catches a struct/mirror *shape* mismatch, not a forgotten
read/write of a real field at the boundary; only an end-to-end test through
the actual addon catches that.

Verified:
- C++ (`geometry_tests.exe`): 174 test cases (172 baseline + 2 new — a
  branching 4-wall tray at `radiusMm=1.5, kFactor=0.4` for both fold
  directions, and the same tray at `radiusMm=0` as a regression guard), all
  passed, 3 pre-existing skips, 0 regressions.
- `npx tsc --noEmit`: clean.
- `vitest --project v2`: 181 passed (177 baseline + 4 new — parameterized
  over this bug's own radius table, 0/0.5/1.0/2.0 — testcube.step mesh
  construction for every resulting part), 5 pre-existing skips, 0
  regressions.
- Live re-run of this bug's exact reproduction against the rebuilt addon:
  `testcube.step` at `default_bend_radius_mm` 0, 0.5, 1.0, 2.0 all now
  succeed for every one of the 4 resulting parts (previously: only 0
  succeeded, matching the bug report's table exactly).

## Correction (2026-08-10)

This report's own summary claimed `graph://part/{id}/flat-pattern`'s
"DXF/outline are correct at every radius tested" — that was wrong; it
just wasn't checked against the outline's own SIZE, only that it built
without error. `docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md`
found and fixed the real issue: the flat outline never grew to account
for bend allowance at all, at any radius. The collar mechanism this
report's fix added has also since been removed — the later fix makes it
unnecessary (see the note in `BUG_REPORT_boundary_resource_disagrees_
with_mesh_after_collar_fix.md`).
