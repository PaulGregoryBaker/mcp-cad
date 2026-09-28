# fuse_bodies "2 faces despite 0mm gap" — resolved

**Status:** ✅ RESOLVED 2026-09-04 — root cause was a winding/orientation defect in
`PolygonUnion`, not the `getPanelFrame` axis-convention theory this document originally
proposed (see "How the investigation got here" below for the wrong turns, kept for
context).
**Component:** `cpp/src/geometry/translation/polygon_boolean.cc` (`PolygonUnion`,
`PolygonDifference`)
**Related:** `docs/BUG_REPORT_split_part_at_bend_cross_net_sliver.md` (this session's
earlier, unrelated fix), `docs/BUG_REPORT_getPanelFrame_origin_bias_at_bled_joints.md`
(a real prior `getPanelFrame` bug — NOT the same one; this investigation's original
`getPanelFrame` theory turned out to be wrong, see below)

---

## The actual bug

`PolygonUnion`/`PolygonDifference` built OCCT `TopoDS_Face` objects directly from each
input ring's own vertex order, with no winding canonicalization. `BRepBuilderAPI_MakeFace`
derives each face's normal from its wire's winding (CCW → +Z, CW → -Z, for a ring at
z=0). Two independently-produced rings can legitimately have opposite winding — in the
live case, `FuseCoplanarParts`' own anchor-relative projection of a protrusion's outline
into a panel's local frame produces a CW ring whenever that projection's in-plane rotation
has determinant -1, which is a real, correct fact about two independently-chosen local
frames (confirmed: two testcube.step protrusions sit on walls whose outward normals point
in opposite directions along the same axis). Feeding `BRepAlgoAPI_Fuse` two coplanar faces
with opposite-facing normals could fail outright — reported as "2 faces (expected exactly
1)" even for a clean, verified-by-hand 0.05mm overlap (not a gap, not a shape mismatch).

Confirmed by isolating the exact live ring pair (extracted by hand from real anchors) down
to a bare `PolygonUnion(a, b)` call — no anchors, no projection, no gap-closing logic
involved — and reproducing the identical failure. Confirmed independent of
`kBooleanFuzzMm` (raising it 10,000x, from `1e-5` to `0.1`, made no difference) — ruling out
a numerical-tolerance explanation. Reversing just B's vertex order (same shape, same
position, only traversal direction changed) made the union succeed with the exact correct
area.

## The fix

`CanonicalizeCCW` (new helper in `polygon_boolean.cc`): reverses a ring in place if its
shoelace signed area is negative, leaving a CCW ring untouched. Applied to both input rings
in `PolygonUnion` and `PolygonDifference`, immediately before `BuildFace`. Pure vertex
re-ordering — cannot move or reshape anything, only changes which way each face's
winding-derived normal points.

Regression coverage:
- `polygon_boolean_test.cc`: the exact real ring pair (A CCW, B CW, clean 0.05mm overlap)
  now unions correctly.
- `fuse_bodies.integration.test.ts`: reproduces the live app's exact recipe (import
  testcube.step, split Component 1 on every bend with `keep_corner_on: 'parent'` via a
  worklist across every resulting part, translate Protrusion1 by -76.6mm, fuse) and asserts
  a real success — the target panel's area must genuinely grow, not just report `ok`.

Full suite: C++ 202/202 (2460/2460 assertions, 3 pre-existing fixture skips), TS 49/49.

---

## How the investigation got here (kept for context — both of these were wrong)

**First wrong turn:** noticing the composed rotation between two real anchors had
determinant -1 (a "mirror"), and trying to "correct" it inside `FuseCoplanarParts` by
reinterpreting B's local `(x,y)` through a different rotation before projecting. This
changed which SHAPE got unioned while leaving B's real anchor translation untouched — the
translation had been set (by a real "Translate Body" edit) against the true, uncorrected
outline the user actually sees rendered, so the "corrected" shape landed somewhere that
placement never accounted for. Confirmed live: the fused material landed on top of A
instead of beside it, so the protrusion visually vanished — no error at all, silently
wrong, worse than the typed rejection it replaced. Reverted.

**Second wrong turn:** theorizing the determinant-(-1) rotation traced back to
`getPanelFrame`'s own axis-choice convention (`gp_Dir U = ndir.IsParallel(X,0.99) ? Y : X`,
`geometry_service_shell.cc:877` — sign-dependent on each panel's own outward normal) and
proposing an upstream fix there. This was a real, correctly-identified fact about
`getPanelFrame`, but wrongly treated as an error needing correction. It isn't one: the 2D↔3D
round trip through each part's own anchor (`anchorA.Inverse().Compose(anchorB).Apply(p)`)
is pure change-of-basis math, correct by construction regardless of which convention chose
either anchor. A composed rotation with determinant -1 doesn't mean the geometry is wrong —
it's an accurate description of how B's real material projects into A's chosen axes. There
was nothing here to fix; the actual defect was one level further down, in how the boolean
kernel was fed that (entirely correct) projected ring.

The lesson that actually resolved this: stop reasoning about the anchors/rotations in the
abstract, and isolate the exact real ring pair down to the smallest possible call
(`PolygonUnion(a, b)` alone) with no anchors, no projection, no upstream theory attached.
That isolation is what surfaced the winding mismatch directly.
