# Bug Report / Feature Request: `fuse_bodies` coplanarity tolerance is fixed at 0.05mm — should scale with panel thickness

> **✅ RESOLVED 2026-08-03.** Implemented exactly as proposed:
> `FuseCoplanarParts` (`polygon_boolean.cc`, `polygon_boolean.hpp`) now takes a
> `thicknessMm` parameter and uses `max(kCoplanarToleranceMm, thicknessMm)`;
> threaded through the NAPI binding (`translation_binding.cc`) and
> `fuseBodies()` (`evaluate-client.ts`, passing
> `Math.min(partA.thicknessMm, partB.thicknessMm)`). No new snapping logic
> needed — `ringBInA` already discarded `inA.z` for any in-tolerance point.
> Verified: this report's own synthetic repro (0.5mm Z offset, 0.9mm-thick
> parts) now succeeds end-to-end via `dispatchGraphTool`; new C++ test
> (`polygon_boolean_test.cc`) confirms the same offset is accepted at
> thicknessMm=0.9 and still rejected at thicknessMm=0.0. Full C++ ctest (174
> tests, same 3 pre-existing unrelated failures as baseline) and the
> `fuse_bodies`/`import_part` TS integration suites pass, 0 regressions.

**Status:** Resolved — see above; original report left unedited below
**Date:** 2026-07-31
**Component:** `cpp/src/geometry/translation/polygon_boolean.cc`, `FuseCoplanarParts`
(`kCoplanarToleranceMm`)
**Severity:** Medium (blocks `fuse_bodies` on real imported geometry with typical
sub-millimeter STEP-import misalignment; does not affect hand-authored/exact fixtures)
**Reported by:** Paul, from the live app — fusing two panels of an imported `testcube.step`
in Form.AI.tion.

---

## Summary

`GE_FUSE_NOT_COPLANAR: part B's outline, transformed into part A's frame, is -0.525002mm out
of A's own z=0 plane (tolerance 0.050000mm) — not coplanar`

Reported live, fusing two adjacent panels of a `testcube.step` import (0.9mm material
thickness) in the Form.AI.tion UI. `FuseCoplanarParts`'s coplanarity check
(`kCoplanarToleranceMm = 0.05`, `polygon_boolean.cc:229`) is a **fixed 0.05mm**, independent of
the parts' actual material thickness — so a perfectly normal amount of import-derived
misalignment (well under the 0.9mm material thickness here) hard-rejects the fuse instead of
being treated as the user error/measurement noise it almost certainly is.

**Requested behavior** (Paul's framing): tolerate a coplanarity offset up to the panel's own
thickness, treating anything smaller as alignment noise, and produce a single, properly
flat-aligned panel — not a rejection.

---

## Reproduction

Synthetic repro (isolates the tolerance check from any real-fixture import noise):

```typescript
import { GraphStore } from './src/v2/graph/store';
import { dispatchGraphTool } from './src/v2/tools/graph';

const store = new GraphStore();
const partA = dispatchGraphTool(store, 'create_part', {
  name: 'A',
  outline: [{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50}],
  thickness_mm: 0.9,
}) as { part_id: string };
const partB = dispatchGraphTool(store, 'create_part', {
  name: 'B',
  outline: [{x:100,y:0},{x:200,y:0},{x:200,y:50},{x:100,y:50}],
  thickness_mm: 0.9,
  anchor: { r: [1,0,0,0,1,0,0,0,1], t: [0, 0, 0.5] },  // 0.5mm Z offset
}) as { part_id: string };

dispatchGraphTool(store, 'fuse_bodies', { part_a_id: partA.part_id, part_b_id: partB.part_id });
```

Result (verified 2026-07-31, matches the live app's error exactly in shape):
```
GE_FUSE_NOT_COPLANAR
part B's outline, transformed into part A's frame, is 0.500000mm out of A's own z=0 plane
(tolerance 0.050000mm) — not coplanar
```
0.5mm is well inside the 0.9mm material thickness of both parts, yet still 10× the fixed
tolerance — confirming the tolerance, not the misalignment itself, is what's too strict here.

---

## Root Cause

`polygon_boolean.cc:222-252`:
```cpp
PolygonBooleanResult FuseCoplanarParts(const std::vector<Point2>& outlineA,
                                        const Transform3& anchorA,
                                        const std::vector<Point2>& outlineB,
                                        const Transform3& anchorB) {
  constexpr double kCoplanarToleranceMm = 0.05;   // ← fixed, no thickness input at all
  ...
  for (const auto& p : outlineB) {
    Point3 inA = bToA.Apply({p.x, p.y, 0.0});
    if (std::fabs(inA.z) > kCoplanarToleranceMm) {
      // reject
    }
    ringBInA.push_back({inA.x, inA.y});   // ← z already discarded when accepted
  }
  return PolygonUnion(outlineA, ringBInA);
}
```

Two things worth noting for whoever picks this up:
1. **The function signature doesn't receive thickness at all** — `outlineA`/`anchorA`/
   `outlineB`/`anchorB` only. The caller, `fuseBodies()` in
   `ts/src/v2/graph/evaluate-client.ts:298-328`, *does* have both parts' `thicknessMm` on hand
   (`partA.thicknessMm`, `partB.thicknessMm` — both already fetched via `store.getPart`) but
   currently doesn't pass either through.
2. **The "snap flat" behavior Paul is asking for already exists for in-tolerance cases** — the
   loop already discards `inA.z` and uses only `(inA.x, inA.y)` when building `ringBInA`, so an
   accepted fuse is already perfectly aligned onto A's exact z=0 plane. This is *only* a
   threshold problem, not a missing-alignment-step problem — raising what counts as "close
   enough" is sufficient; no new snapping logic is needed.

---

## Proposed Fix

Thread a thickness-derived tolerance through:

1. Add a `thicknessMm` parameter to `FuseCoplanarParts` (and its NAPI binding,
   `translation_binding.cc:726` `FuseCoplanarPartsBinding`).
2. Replace the fixed `kCoplanarToleranceMm` with something like
   `std::max(kCoplanarToleranceMm, thicknessMm)` — keeps the existing 0.05mm floor for
   very thin/exact material, but accepts up to a full panel thickness of offset for
   everything else, per Paul's explicit ask.
3. `fuseBodies()` (`evaluate-client.ts`) passes `Math.min(partA.thicknessMm, partB.thicknessMm)`
   (or whichever policy is preferred — same-material fuses should have equal thickness anyway,
   but the smaller of the two is the conservative choice if they ever differ) through to the
   binding call.
4. Worth a quick decision: full thickness, or half-thickness (each part contributing half the
   allowed error)? Paul's wording was "up to the panel thickness" — taking that literally as
   the full value.

**Resolved (Paul):** no `Finding`/note needed for the snap — stays silent, consistent with
today's sub-tolerance behavior. `FuseCoplanarParts` owns this behavior itself; the caller
doesn't need to editorialize about what the function it called chose to do.

---

## Impact

- Blocks `fuse_bodies` on real imported geometry with normal STEP-import sub-thickness
  misalignment (this is not a contrived edge case — it's the reported behavior on a
  straightforward `testcube.step` import).
- No impact on hand-authored/exact fixtures (already well under the existing 0.05mm tolerance).

---

## Links

- Tolerance check: `cpp/src/geometry/translation/polygon_boolean.cc:222-252`
  (`FuseCoplanarParts`, `kCoplanarToleranceMm`)
- Error code mapping: `cpp/src/napi/translation_binding.cc:126` (`GE_FUSE_NOT_COPLANAR`)
- NAPI binding (needs the new thickness param): `cpp/src/napi/translation_binding.cc:726`
  (`FuseCoplanarPartsBinding`)
- Caller (already has both thicknesses on hand): `ts/src/v2/graph/evaluate-client.ts:298-328`
  (`fuseBodies`)
- Numerical tolerance policy background: `rebuild/17-numerical-policy.md §2.1`
