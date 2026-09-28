# Bug Report: `split_part_at_bend` with `keep_corner_on` into the trunk of a branching (cross) net produces a sliver the length of the whole part and corrupts the remainder's mesh

**Status:** Fixed — seven layered bugs, the last six found via live, iterative testing against the real `testcube.step` fixture after each prior fix looked complete on hand-authored cases alone:

1. `SplitPartAtBend` no longer re-grounds the shifted cut line against the whole ring. It splits at the hinge's own two grounded points first, then finds the corner-bias crossing only against the trimmed side's own two edges touching the hinge.
2. `radiusMm=0` (the as-imported default before a user sets a real radius) spuriously hit a typed failure at a branching hinge, because the local-edge search ran even with a zero offset — nothing to search for. Fixed: a zero shift skips the search and uses the raw hinge points directly.
3. (Introduced and reverted within this fix, never shipped) An intermediate attempt derived which side gets trimmed from the raw sign of the `childShift`/`parentShift` formula (`BuildBendCuts`'s signed `sb`). That sign is fold-direction bookkeeping — real for reconciled bends (`ReconcilePieces` can stamp a negative `angleDeg` with an explicit `bottomIsConcave`) — and letting it drive which side is trimmed made `keepCornerOn`'s own meaning flip with fold direction.
4. `keepCornerOn` must be a fabrication choice, not a function of fold direction. Fixed by decoupling magnitude from direction — the setback's magnitude (`|sb|`, physical and always positive) still matches `BuildBendCuts` bit-for-bit, but the *direction* to shift is fixed by `keepCornerOn` alone via `nLeft` (which points toward child independent of `sb`'s sign).
5. A side whose own adjacent edge is exactly parallel to the cut (a corner shared with another live bend) still failed typed. Not actually unrepresentable — a direct point-substitution just has nothing to land on there. Initial fix: branch on whether the adjacent edge is parallel, and insert a local notch instead of substituting when it is.
6. **Per the user's explicit request to unify (5) into one geometric path, not a branch that decides which case it's in**: `SplitPartAtBend` now uses ONE construction for every endpoint — always insert the offset point next to the endpoint (never a conditional replace) — then run a general `Simplify` pass that collapses any resulting 180° fold. On an ordinary perpendicular edge this collapses back down to exactly the point a direct substitution would have found; on a parallel edge (case 5) nothing collapses, and the insertion stands as the notch. Validity is read off the *result* (the trimmed side's own signed area flips orientation when the setback is genuinely wider than the material) rather than gated beforehand — same "material narrower than setback" failure, now falling out of the single construction instead of a separate check.
7. **The deepest bug, only visible when splitting more than one bend off the same net in sequence**: two *independently correct* local edits — each bend's own notch, entirely valid on its own — could still leave the STORED outline self-intersecting where their own edges crossed (a second bend's own notch "bend line" spans that bend's full hinge length with no way to know an earlier, already-departed bend's notch wall now sits in the middle of that span). This showed up one step downstream, as `Evaluate()`/`RegionOf` producing a degenerate region that then failed OCCT's `BRepCheck_Analyzer` when `flat_outline.cc` tried to fuse an allowance strip onto it — "Flat pattern preview failed to load." Fixed at two levels: (a) `SplitPartAtBend` now runs a general `ResolveCrossings` pass after construction — splits the ring at any non-adjacent edge crossing and keeps whichever half's signed area still matches the original orientation; (b) `RegionOf` in `manufacturing_graph_evaluator.cc` gained the same `Simplify`-style spike cleanup for a narrower, related case — a corner that used to be shared by a since-departed bend, which the default "just continue along the ring" walk (`BuildCutEdges`) has no way to recognize as orphaned.

Regression coverage: a 14-vertex Latin-cross fixture in `part_split_test.cc` covering `radiusMm=0`, the sign-independence of `keepCornerOn` across all 4 real `(angleDeg sign, bottomIsConcave)` combinations, and — per the user's explicit request to see the fix's own test fail first — a test asserting `keepCornerOn='child'` succeeds at the hub bend (confirmed red against the pre-notch code, green after). A TS integration suite (`graph_crud.integration.test.ts`, `[v2] split_part_at_bend on a real reconciled part (testcube.step)`) imports the real fixture end-to-end and confirms **both** `'parent'` and `'child'` split every one of the 5 bends cleanly at `radiusMm=0` and at a real 2mm radius, AND — the test class that actually caught bug 7 — splitting off every bend **in sequence**, re-evaluating and rebuilding the flat pattern after **every individual step**, not just checking the whole sequence at the end. This iterative, real-fixture-driven testing caught bugs 2, 3, 4, 5, and 7; none of them were reachable from a hand-authored fixture or a single-split test.

Final state: C++ `cpp/build`: 202 test cases / 2450 assertions, 0 failures (3 pre-existing skips). TS: all integration tests pass (`SUITE_V2_DRIVER=1 vitest run`), including full sequential splitting of every testcube bend for both `keepCornerOn` values with flat-pattern verification after each step — verified live against the originally reported failure.
**Date:** 2026-08-27
**Component:** `cpp/src/geometry/translation/part_split.cc` (`SplitPartAtBend` / `GroundLine`) — **not** `split_body_by_bends`. The two tools are different operations: `split_body_by_bends` decomposes a 3D solid into panels; `split_part_at_bend` is the graph-level inverse of `merge_bodies_with_bend` (one live fold-tree part, one stored flat outline, one bend). This is a C++-layer geometry bug; TS (`evaluate-client.ts` / `GraphStore.splitPartAtBend`) only applies the two rings C++ returns.
**Severity:** High — a legal `keep_corner_on` on a real cube-net part returns a geometrically wrong child outline and leaves the surviving parent in a state that no longer meshes. The "exactly 2 crossings" gate that is supposed to reject an ambiguous cut does not fire.
**Reported by:** Paul — Form.AI.tion session. Part that is a cube when folded, a cross in flat-pattern with 5 bends (6-face Latin-cross cube net). Split at one arm's bend to remove that arm; `keep_corner_on` set to the trunk / "into the corner" of the remaining cross rather than onto the arm.

---

## Summary

`SplitPartAtBend` does not cut the stored outline along the bend's own local seam. It builds an **infinite line** parallel to the hinge, offset by the parent or child tangent setback (`sb`) according to `keepCornerOn`, then asks `GroundLine` for **exactly two** intersections with the outer ring. Those two points become the split vertices; each ring-chain between them is classified as parent vs child by which side of the line a sample vertex sits on (`nLeft`).

That is equivalent to a local seam cut **only while the outline is convex along that line** (the 2-rectangle merge fixture every current test uses). On a branching concave net — a cube unfolded as a cross — an offset into the **parent/trunk** still has exactly two crossings: they are the far extremities of the other arms that share the trunk's width, not the two ends of this bend. `GroundLine` therefore returns success, and the "child" ring is:

- the arm that was meant to be split off, **plus**
- a thin strip running the **full length of the cross** (the offset is `sb`, typically a couple of mm — much shorter than the hinge, and far shorter than the sliver).

The parent ring is the rest of the net after that through-cut. Graph bookkeeping still re-parents only the chosen bend's child subtree and leaves the other four bends on the original `part_id`, now against an outline that no longer matches those hinges. Downstream `Evaluate` / mesh construction fails — the remaining part "loses its mesh."

The opposite `keep_corner_on` (corner on the arm / child) shifts the line **into the arm**. That line only intersects the arm's own two long sides, so the split looks correct. The defect is not "keep_corner_on is unimplemented"; it is that the infinite-line + exactly-2-crossings rule is not a local-bend cut, and the typed failure `kCornerZoneNotGrounded` does not cover this case.

---

## Reproduction

Not yet an automated test — found live. Geometry is a standard 6-face cube net (cross, 5 bends): one base, four walls, one lid in a line with the base.

```
        [lid]
[wall] [base] [wall]     ← split here, at the right-wall bend
        [wall]
```

1. Import / merge so the live part's flat-pattern is that cross (5 live bends).
2. `split_part_at_bend` on the bend joining **one arm** to the base.
3. `keep_corner_on` = the side that keeps the allowance on the **trunk** (`parent` when the arm is the bend's child — "into the corner" of the remaining cross, not onto the arm).

**Observed**

- New part: the removed arm **plus** a thin sliver whose length is the full cross (lid + base + opposite wall), width ≈ the tangent setback `sb`, not the bend length.
- Remaining part: outline no longer matches the leftover fold tree; mesh is gone.

**Not observed** (same part, opposite `keep_corner_on`): arm splits off cleanly; remainder keeps a sensible cross-minus-arm outline and still meshes.

The existing C++ tests cannot catch this: `cpp/tests/part_split_test.cc` only uses `CombinedOutline()` — a convex hexagon from two rectangles at one seam. On that shape, an infinite line parallel to the hinge really does have exactly two local crossings.

---

## Root Cause — exact location

`part_split.cc`, `GroundLine` (header comment: "the infinite line through (lineA, lineB)") and the cut construction in `SplitPartAtBend`:

```cpp
// GroundLine: require exactly 2 intersections of an INFINITE line with the ring.
if (crossings.size() == 2) { /* insert vertices, succeed */ }
// else: collinear-on-boundary fallback or nullopt → kCornerZoneNotGrounded

Point2 shift = keepCornerOn == CornerSide::kChild ? Point2{-sb * nLeft.x, -sb * nLeft.y}
                                                  : Point2{ sb * nLeft.x,  sb * nLeft.y};
Point2 cutA = {groundedHinge->crossA.x + shift.x, groundedHinge->crossA.y + shift.y};
Point2 cutB = {groundedHinge->crossB.x + shift.x, groundedHinge->crossB.y + shift.y};

auto groundedCut = GroundLine(outline, cutA, cutB, cutA, cutB);
```

On the cross, `keepCornerOn = kParent` places `cutA`/`cutB` a distance `sb` **into the base**, parallel to a short wall hinge. That infinite line stays inside material from the lid, through the base, through the opposite wall, and exits at the far end — **two** crossings, `crossings.size() == 2`, no typed error.

The subsequent chain split then assigns the entire half-plane on the child-normal side to `childOutline`. That half-plane contains the target arm **and** the `sb`-wide strip of every panel the line traversed. `sb` is `radiusMm * tan(|angleDeg|/2)` (same formula as `BuildBendCuts`); it is unrelated to the hinge length and unrelated to the net's overall span — which is why the sliver is "much longer than the bend."

`kCornerZoneNotGrounded` only fires when the line does **not** hit exactly twice (or the collinear fallback fails). A clean 2-hit through-cut of a concave net is treated as success.

TS then trusts those rings (`evaluate-client.ts` → `store.splitPartAtBend`): new `part_id` gets `childOutline` + the split bend's child subtree; the original `part_id` gets `parentOutline` and keeps every other bend. Mesh loss on the remainder is a consequence of that mismatched outline vs leftover fold tree, not a separate mesher bug.

---

## Expected Behavior

Splitting at one bend of a branching net must only partition material that belongs to **that** bend's two legs (parent panel vs child subtree), along a cut localized to that seam's tangent line.

Concretely, for the cube-cross:

- Child part = that one arm (flush or corner-keeping, per `keep_corner_on`), area on the order of one face, **no** strip through lid/base/opposite wall.
- Parent part = the remaining 5 faces, still a valid simple outline whose leftover hinges still lie on it, still able to `Evaluate` and mesh.

If `keep_corner_on` would place the cut line through other panels of the same outline, that must be a **typed** failure (`kCornerZoneNotGrounded` or a new "cut is not local to this hinge" code) — not a successful sliver. An infinite line with exactly two crossings is not sufficient on a concave ring.

---

## Proposed Fix Direction (C++ layer only)

`GroundLine` / `SplitPartAtBend` need a locality constraint, not a third copy of allowance math. Options (same module):

1. **Reject non-local 2-hit cuts.** After finding two crossings, require they lie on (or within epsilon of) the two outline edges that already ground the **hinge**, offset by `shift` — i.e. the cut is the hinge's own edges translated by `sb`, not some other pair of edges on a distant arm. If the two hits are a different pair of edges, return `kCornerZoneNotGrounded`.
2. **Finite-segment cut.** Intersect a segment of length = hinge length (plus a small epsilon), not the infinite line. A through-cut of the lid/opposite wall would then miss that segment and fail typed.
3. **Do not half-plane split a concave ring.** Walk only the two chains that stay in the hinge's adjacent corridors (the same adjacency already implied by `hingeA`/`hingeB` on the ring).

(1) is the smallest change and matches the existing error enum. Tests should add a cross-shaped outline with a short side-arm hinge; `keepCornerOn=kParent` must not return a child whose bbox length is the full net height.

Do not patch this in TypeScript after the fact — constitution v2.0.0 principle IV; the wrong polygons are produced in C++.

---

## Impact

- Any branching fold-tree part (cube nets, trays with 4 walls, anything whose flat outline is concave at a bend) can hit this as soon as the user picks the trunk side of `keep_corner_on` on one arm.
- Convex 2-panel merges (today's test fixture) stay green; the bug is invisible there.
- Failed mesh on the remainder looks like a construction/OCCT failure; the actual defect is the split rings.

---

## Links

- Cut implementation: `cpp/src/geometry/translation/part_split.cc` (`GroundLine`, `SplitPartAtBend`)
- Contract: `cpp/src/geometry/translation/part_split.hpp` (`CornerSide`, `kCornerZoneNotGrounded`)
- Tests that miss this: `cpp/tests/part_split_test.cc` (`CombinedOutline` only)
- TS apply-only path: `ts/src/v2/graph/evaluate-client.ts` (`splitPartAtBend`), `ts/src/v2/graph/store.ts` (`splitPartAtBend`)
- Tool: `split_part_at_bend` in `ts/src/v2/tools/graph.ts` — **not** `split_body_by_bends`
- Related (different tool, similar visual "wrong keep side"): Form.AI.tion split-by-bend UX; reproduction may use the same cube/cross part as import fixtures (`cpp/tests/fixtures/testcube.step`) after it has been reconciled into one live graph part
