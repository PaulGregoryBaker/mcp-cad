# 13 — Translation Module Design (Phase 2.1) — THE single geometric solution

**Status:** **Reviewed & approved by Paul 2026-07-19; REVISED 2026-07-20** to match the
schema correction in [14](14-graph-schema.md) §0: **a part is one flat outline, cut
once, then bent** — not N independently-outlined region panels glued together. The chain
formulation (root transform + per-bend transforms), all of D1–D5, and the case-inventory
coverage survive; what changes is that `T_pc` (child-local → parent-local placement) is
**deleted**, because there is no longer a separate child frame to place — every region panel
is already a subset of the part's one flat frame.
This is the highest-stakes artifact of the rebuild: the one geometric model from which
every frame, flat pattern, DXF, drawing dimension, and 2D↔3D mapping derives (P3).
Prohibited by construction: parallel solvers, per-case gates, fallbacks, compensating
offsets, end-state alignment assumptions (L1). Scope: developable surfaces (C5).

---

## 1. The model in one paragraph

A part is **one flat outline** — its cut profile, in a single flat frame `F` — with a
set of **fold lines (bends)** drawn on it. Each bend has an exact hinge segment, an
angle, a radius, and a K-factor, and divides `F` into a fold **tree** of regions; each
region, once folded, is a **region panel**. Region panel and region are one entity, not two: "the
region of the flat layout between bends" and "the region panel in the folded graph" are the
same graph row (14 §0). One tree walk derives, for every region panel, its 3D pose — the
rigid transform composing the root anchor with every bend transform on the path from
the root — plus a developable **bridge zone** per fold whose flat width is the bend
allowance and whose 3D form is the cylinder sector. Both directions of the 2D↔3D
mapping, the flat pattern, the drawing datum, and semantic region resolution are all
*reads* of this one structure. There is no boolean union step anywhere: region panels are
never separately-shaped pieces that need to be glued back together, because they were
never separate — they are clips of one outline that share exact material at every
hinge.

## 2. Definitions

- **Part flat frame `F`**: the single 2D coordinate system for the whole part. The
  part's **outline** is a CCW polygon (holes CW) in `F` — the one shape that is cut
  (14 §2, `part_ring`). Nothing else defines the part's cut geometry; there is no
  per-region-panel frame.
- **Region panel** `p`: a named region of `F`, identified by the set of bend hinges
  that directly touch it — its own incoming bend (if any) plus its own outgoing
  bends to its children (if any), `[CORRECTED 2026-07-20 — Paul]` **not the full
  ancestor chain** (14 §2.1: an earlier version of this definition clipped only by
  ancestors, which is wrong for any panel with its own children — their territory
  must be excluded too, not just the parent's respected). Its flat shape is **not
  stored** — it is `regionOf(p)`, `F` clipped by each of `p`'s own touching hinges,
  on `p`'s side of each, minus any holes (14 §2.1). A region panel touched by zero
  bends is `F` itself (a part with just one region panel), or the tree's root region.
- **Fold edge (bend)** `f = (parent p, child c, hinge, θ, r, K)`:
  - `hinge` — the fold-line segment, in `F` (one shared frame — there is no
    "parent-local" vs "child-local" distinction to keep consistent; this alone
    removes the v1 pattern of two edge copies that could disagree).
  - `θ` — signed fold angle (+ = up); `r` — inner radius; `K` — K-factor from the
    profile. **Bridge width** `w = θ·(r + K·t)` (the bend allowance; `t` thickness).
    Sharp model = limit `w→0` (used by closure-family sharp cases).
  - No placement transform exists on the bend (`T_pc` is deleted, §0 of 14): `c`'s
    region is already exactly where it is in `F` — a bend records only how to *fold*
    it, via `B_i` (§4.1), never how to *place* it.
- **Curved bend**: a fold edge with large `r` (cylindrical developable). **Rolled
  section** (post-initial): a fold edge chain generated from a curvature profile.
  Structurally identical — no new node type in the model.
- **Seam constraint** `s = (region panel a, region panel b, seg_a, seg_b)`: a non-tree adjacency —
  two edges of `F`, each on a different region, that should meet in 3D after folding
  without being the same hinge (e.g., the last edge of a closed box). Seams are
  **checked, never driven**: the model computes the residual between the two mapped
  segments; profile-relative findings result. (Closed boxes, C15/C22 closure.)
- **Part layout**: the evaluated result — per region panel: `Pose(p): SE(3)` (the only
  placement transform that exists — there is no 2D placement transform, because a
  region panel's flat shape is already a subset of `F`, needing no further positioning); per
  fold: bridge zone geometry in both spaces.

## 3. Evaluation: root anchor, outline subdivision, and the tree walk

### 3.1 The part's 2D→3D root transform (R = Pose(root))

`R` is **data, not derivation** — a rigid transform stored on the part (14 §2,
`part.anchor_*`), set once at graph construction, embedding `F` (the whole flat frame,
not just "the root region panel's frame" — there is only one frame now) into world space:

- **Imported parts:** at decompose time, the kernel reports the root region's measured
  plane in world coordinates: in-plane axes `û, v̂` (from the canonicalized outline's
  principal edge), origin `o` (outline's canonical corner), normal `ŵ = û × v̂`. Then
  `R = [û v̂ ŵ | o]`. This is what makes import → graph → replay reproduce **world**
  coordinates (C13, AC-A.3).
- **Authored parts (Level A):** identity, or an explicit anchor supplied at authoring.
- **Transforms of the whole part** (translate verb, FR-J): mutate `R` — and *only*
  it (14 §2.3). Region panels never carry world data individually.

### 3.2 Subdividing the outline, and the tree walk

Two distinct steps, evaluated together and both cached on the `Layout`:

1. **Region subdivision (2D, no transforms):** for each region panel `p`, clip `F`
   by every bend touching `p` directly — its own incoming bend (child side kept) and
   each of its own outgoing bends (that child's side excluded), per D1's direction
   convention (14 §2.1, `boundingBends(p)`, `[CORRECTED 2026-07-20]`: this is *not*
   a walk to the root — a panel's ancestors beyond its own immediate bend never
   constrain it; only its own touching bends do). Each bend contributes one
   half-plane constraint, so the clip is order-independent. This is the multi-line
   outline subdivision v1 never finished for N>1 hinges (14 §2.1, OPEN-D2.6) and is
   the module's core algorithmic requirement.
2. **Pose walk (3D, the tree of bend transforms):**

```
evaluate(graph, profile) -> Layout:
  regions = subdivide(F, bends)                                  # step 1, order-independent
  Pose(root) = R                                                # §3.1
  for each fold f = (p → c) in pre-order:
    Pose(c) = Pose(p) · B(f)                                    # 3D only, B(f) in §4.1
  return { Pose(·), regions, bridge charts }                      # memoized per graph version
```

The walk visits each region panel exactly once (it is a tree); results are cached on the
Layout. **No translations exist anywhere except inside `B(f)` and `R` — there is no
place to put a compensating offset, and no second 2D placement step to disagree with
the region subdivision, because regions are read directly off `F` (step 1), never
re-derived from a 2D chain.** This is L1 killed twice over: one stored shape (14 §0),
one function that folds it. AC-E.3's rule (differences only from bend-radius
modeling) is literally the definition of the bridge zone.

### 3.3 Concrete output: point arrays for 2D and 3D

`[ADDED 2026-07-20 — Paul: "both ideally need an array of points to be derived. The
3D should have two arrays, one for each panel surface (inside and out)."]` §3.2
defines `regionOf(p)` and `Pose(p)` as the region panel's shape and placement — this
section states the **concrete deliverable** a consumer (mesh export, solid
realization, drawing generation, FR-E) actually receives when it asks for a region
panel's geometry.

**2D — one point array per ring.** `regionOf(p)` is not an abstract "region"; its
value *is* an ordered array of 2D points in `F` — the outer boundary — plus zero or
more further ordered arrays for holes (polygon-with-holes, outer CCW / holes CW per
the canonical winding rule, 12-domain-notes §2). Where a ring includes arc (`bulge`)
segments (K2 smooth-edge, 14 §2), the *stored* ring stays exact (line+bulge); a
tessellated point array is produced only when a consumer needs one, at whatever
resolution its tolerance profile calls for (N11) — tessellation resolution is never
baked into the model.

**3D — two point arrays, index-correlated.** Because a region panel is a single
thickness `t` (D3) with the flat frame `F` mapped to its **bottom** surface, the 3D
shape is exactly two arrays, same point count and order as the 2D boundary (and each
hole ring), so corresponding entries line up pairwise:

```
bottomFace(p) = [ Pose(p) · (v.x, v.y, 0) : v in regionOf(p).outer ]   -- D3's bottom surface
topFace(p)    = [ Pose(p) · (v.x, v.y, t) : v in regionOf(p).outer ]   -- offset by t, THEN posed
```

(and the same pair for each hole ring). Offsetting in the panel's own local frame
*before* applying `Pose(p)` and offsetting by `t` along the world-space transformed
normal *after* applying `Pose(p)` give the same points — `Pose(p)` is rigid, so
translation-then-rotate and rotate-then-translate-along-the-rotated-axis agree
exactly; this equivalence is a property test (§8), not an assumption.

Colloquially, `bottomFace`/`topFace` are the panel's "inside" and "outside" faces —
D3 fixed *which* physical face is bottom (an arbitrary but consistently-applied
choice, independent of any adjacent bend's fold direction: a panel's own two faces
don't have an intrinsic up/down without reference to a specific bend). Because the
two arrays are index-correlated, a consumer building an actual solid or mesh
connects `bottomFace[i], bottomFace[i+1], topFace[i+1], topFace[i]` as the side-wall
quad for each boundary edge — the thin edge of the sheet metal — with no separate
lookup or matching step required.

**Bridges get the analogous pair.** A bend's bridge chart (§4.3) already computes an
inner/outer radius (`r_b = r` for UP, `r_b = r + t` for DOWN) for exactly this
reason; discretizing the bridge's arc at a chosen resolution produces the same
bottom/top point-array pair for the curved strip, using the same two formulas with
`Z_i` in place of the flat embedding. Not repeated in full here — it's the same
pattern, applied to a cylindrical chart instead of a planar one.

## 4. Forward mapping (2D → 3D): the transformation chain

**The graph nodes ARE the transformation model** (Paul's formulation, 2026-07-19):

- The **part** carries the one **2D→3D transformation** `R`: it embeds `F` — the
  part's single flat outline, holding every region panel's region as a subset — into world
  coordinates (§3.1).
- **Each bend node** carries a **3D→3D transformation** `B_i` — the additional rigid
  transform necessary to *navigate that bend*. The bend's **hinge** (a segment in
  `F`) and **extents** (the bridge strip: hinge → hinge + width `w`, over the bend's
  lateral span) are explicitly modelled on the node. Nothing else is on the node —
  in particular, no 2D placement transform (`T_pc` is deleted, 14 §0): the child
  region is already sitting in `F` exactly where the outline subdivision (§3.2 step 1)
  put it.
- A **separate transformation** — the cylindrical bridge map `Z_i` (§4.3) — applies
  when the queried point lies **within the bend's bridge zone** instead of on a region panel.

### 4.1 The chain, spelled out

All flat points live in `F`, the single, undivided flat-pattern space — there is only
ever one set of 2D coordinates for any point of the part, whichever region panel's region it
falls in. To map a 2D point to 3D,
apply the root transform, then the bend transform of **every bend node on the unique
tree path** from the root to the point's region panel, in path order:

```
point on root region panel:            3d_p1 = 2d_p1 · R
point on region panel after bend 1:    3d_p2 = 2d_p2 · R · B_1
point on region panel after bends 1,2: 3d_p3 = 2d_p3 · R · B_1 · B_2
…
point k bends deep:             3d_pk = 2d_pk · R · B_1 · B_2 · … · B_k
```

Exactly the bends on the path are applied — no more, no fewer. The path is unique
because the structure is a tree (parent pointers, O(depth) retrieval — a tree *walk*,
never a search).

**How each `B_i` is computed** (once, in the evaluation walk §3.2, then stored on the
bend node): the bend's intrinsic fold is a rotation by `θ_i` about its hinge line with
the radius-`ρ_i` cylindrical advance (the `u ≥ w` branch of §4.3's development map).
Because bend `i`'s hinge has already been moved by the chain ahead of it, its world
transform is the intrinsic fold **conjugated by the preceding chain**:

```
C_{i−1} = R · B_1 · … · B_{i−1}          # chain up to the parent region panel
B_i     = C_{i−1}⁻¹-side conjugation of the intrinsic fold:
          B_i = C_{i−1} · B̃_i · C_{i−1}⁻¹
```

where `B̃_i` is the fold about the hinge *at its flat-embedded position* `R(hinge_i)`.
(Equivalent distal-first view: folding bends leaf→root applies each `B̃_i` about its
still-flat hinge — same result; the conjugated form is what lets the chain be written
in Paul's natural root→leaf order.) Either way, **every `B_i` is derived from the bend
node's own data (hinge, θ, ρ) — there is no other input, and no place for an offset.**

The evaluation walk also caches each region panel's full chain product
`C_p = R · B_1 · … · B_k`, so an individual query is one matrix apply
(`3d = 2d · C_p`). A property test asserts the unrolled chain ≡ the cached product on
random trees — the cache can never drift from the definition.

### 4.2 Which chain does a 2D point use?

Ownership in `F` decides: every region panel has its **region** (`regionOf(p)`, §3.2 step 1 — a
clip of the part's one outline, not a separately stored or placed shape), and every
bend has its **bridge zone** (hinge + extents, also a clip of `F`). A 2D query point
is located by point-in-polygon over these regions/bridges (closed boundaries; a point on a
shared hinge line belongs to both neighbours and maps identically through either
chain — §4.3 continuity). The owning node determines the chain: a region panel uses §4.1; a
bridge uses §4.3.

### 4.3 A point within a bend bridge

A bridge-resident point is on the bend's cylinder, not on any region panel plane. Its chain
is the path chain **up to the bend's parent region panel**, followed by the bridge's own
transformation `Z_i` in place of `B_i`:

```
3d = 2d · R · B_1 · … · B_{i−1} · Z_i
```

`Z_i` is the development map. In the bend's hinge frame (hinge direction `d̂`,
in-plane normal `n̂` toward the child, plane normal `ẑ`), a flat point at axial
coordinate `s` along the hinge and distance `u` past it (`0 ≤ u ≤ w_i`) maps to a
point on the **bottom-face arc** (D3: the DXF plane is the region panel's bottom surface):

```
φ = u / ρ_i                       # angular coordinate: NEUTRAL parameterization,
                                  # ρ = r + K·t  (so u = w  ⇒  φ = θ exactly)
r_b = r_i        (UP bend — bottom face is the inner face)
r_b = r_i + t    (DOWN bend — bottom face is the outer face)

Z_i(s, u) = a + s·d̂ + r_b·[ sin φ ·n̂ ± (1 − cos φ)·ẑ ]     # ± per bend direction
```

The angle comes from the neutral fiber (that is what the allowance width `w` measures
— flat distances between bend lines stay physically exact), while the *position* sits
on the bottom surface so the mapped point lies exactly on the created solid's face.
At `u = 0` this equals the parent's bottom plane; at `u = w` it equals the child's
bottom-plane attachment (tangent continuity), which is what makes hinge-boundary
points chain-independent. The sharp model is the limit `w → 0` (bridge vanishes;
`B_i` = pure rotation about the hinge).

## 5. Reverse mapping (3D → 2D): inverse chains + DXF membership

**Every transformation has a reverse.** `R⁻¹` is the 3D→2D root transform (project
onto the root plane, then leave the embedding); each `B_i⁻¹` is the reverse bend
navigation; each `Z_i` inverts in closed form (cylindrical `atan2` unwrap → arc length
back to flat distance `u = ρφ`). Applying an inverse chain means applying the
inverses **in reverse order**:

```
point on root region panel:            2d_p1 = 3d_p1 · R⁻¹
point on region panel after bend 1:    2d_p2 = 3d_p2 · B_1⁻¹ · R⁻¹
point k bends deep:             2d_pk = 3d_pk · B_k⁻¹ · … · B_1⁻¹ · R⁻¹
bridge of bend i:               2d    = 3d · Z_i⁻¹ · B_{i−1}⁻¹ · … · B_1⁻¹ · R⁻¹
```

### 5.1 Resolution procedure

Going 3D→2D, the owning chain is not known in advance — so **all candidate chains are
checked, stopping at the one whose transformed point falls within that node's region (region panel) or bridge (bend) on
the DXF flat pattern**:

```
map3dTo2d(X):
  for each node n (region panel or bridge), i.e. each candidate chain:   # one chain per node
    x2d = X · inverseChain(n)                    # cached: C_n⁻¹, one matrix apply
    residual = out-of-surface distance           # |z| after R⁻¹ for region panels;
                                                 # |dist_to_axis − ρ| for bridges
    if residual ≤ ε  AND  x2d lies within n's region/bridge on the flat pattern:
       return (n, x2d, residual)                 # STOP — owner found
  return typed GE_POINT_NOT_ON_PART              # no nearest-guess fallback (N5)
```

- **Both tests are required.** The residual alone is proximity, not ownership; the
  **membership test in the DXF flat pattern** is what binds the answer to the right
  region panel. (v1's association-swap defect was precisely a mapping not anchored to flat
  membership — under this procedure a swapped answer is impossible, because the
  candidate that "wins" is by definition the one whose inverse lands inside its own
  DXF region/bridge.)
- **Determinism at shared boundaries:** a 3D point on a hinge satisfies both
  neighbouring chains, but both inverses land on the same hinge line in the DXF
  (§4.3 continuity), so iteration order cannot change the returned 2D point beyond ε.
  For a stable `region_panel_id`, candidates are checked in canonical node order and the
  smallest residual wins ties.
- **Thickness (D3):** charts live on each region panel's **bottom surface**. A 3D query
  anywhere within the slab (up to `t + ε` above a bottom-surface chart, measured
  along its normal) is projected to the bottom surface first; the projection distance
  is reported as `error_mm`.
- **Cost:** linear in node count per query (bbox pre-filter on the candidate regions/bridges
  prunes without affecting exactness). All inverses are precomputed with the chains.

Round-trip identity (`2d → 3d → 2d = id`) and chain-composition exactness are
algebraic properties of rigid-transform composition; the property tests (§8) verify
the implementation, not the math.

## 6. Where geometry comes from (kernel port contract)

The module is **pure**: it consumes a graph document and a tolerance profile; it never
calls the kernel. But building that graph document from an imported solid requires a
reconciliation step, because of how the kernel necessarily works:

**The kernel measures region panel by region panel; the graph stores one outline.** OCCT (or any
B-Rep kernel) gives geometry as flat *faces* — decomposing an imported folded solid
naturally yields N separate flat pieces, one per region panel, each with its own measured
plane and boundary. That is a measurement artifact, not the target representation
(14 §0). At *graph-construction* time only, the kernel port supplies:

- **per-piece measured outlines**: face ring + plane per panel-piece, which the
  module **canonicalizes** (CCW by shoelace; principal-edge frame alignment) —
  winding hazards die at this boundary (12-domain-notes §2);
- **fold detection between adjacent pieces** (dihedral, shared edge) — becomes bend
  data (hinge, θ, r).

From these, the import step **reconciles the N pieces into the part's one outline
and bend tree**: pick a root piece, and for each fold, *unfold* the child piece back
into the root's flat frame across its hinge (the inverse of §4.1's fold, applied once
at import) so its measured boundary lands exactly where it belongs in `F`; the
part's outline is the union of all unfolded pieces (which is well-defined and exact,
because each piece's edge at a hinge is, by measurement, the same edge as its
neighbour's — they were one material). This decompose→reconcile pattern is exactly
what the salvaged `010-build-manufacturing-plan` branch was built for
(12-domain-notes §5: split by bends → per-region-panel analysis → recombine) — direct prior
art for this step, not merely thematically related.
- **solid realization downstream** (thicken each region, join along shared hinge
  material — guaranteed manifold, since adjoining regions share exact boundary
  material rather than independently-placed edges that merely ought to match) is a
  consumer of `Pose(p)`, never a producer of placement.

The module's outputs (`Layout`: regions + poses) are the *only* placement facts the
rest of v2 may use (P3 lint: nothing else imports projection/subdivision internals).

## 7. Case-inventory walk (08 §3 — every row)

| Case | How the model handles it |
|---|---|
| C01 rectangle | Trivial single-node tree. |
| C02 skewed quad | Outline is an arbitrary polygon in `F`; no rectangle assumption exists anywhere to be violated. Canonicalized ring is the single source (guarded by t0-cauldron suite case). |
| C03/C04 two-region-panel any angle | One bend; θ signed covers acute/obtuse/inverted; hinge direction is unconstrained — the outline subdivision (§3.2) handles any mutual orientation, no placement transform needed. |
| C05 pair-dependent failure class | No per-pair code paths exist; every pair is the same `evaluate`. The association swap is unrepresentable (§4) — doubly so now: there isn't even a second outline to associate incorrectly. |
| C06 straight chains | Path tree over one outline's regions; composition of `B_i`'s for pose, one clip operation for shape. Closure family (C22) asserts exactness per bend. |
| C07 corner chains | Hinges are ordinary line segments in `F` with no orientation restriction — perpendicular/oblique fold lines are the same multi-line clip as parallel ones (14 §2.1/OPEN-D2.6). No corner-specific anything, and (§0) no separate-outline gluing that could fail at a corner. |
| C08 multi-lobed composites | The flat pattern was never separate pieces to union — it's one outline, however complex its shape, sliced by hinges. "Refold" = thicken each region + join along shared hinge material, which is manifold by construction (adjoining regions share exact boundary material, not independently-placed edges that merely ought to match) — "2 solids" cannot arise from bad adjacency data because there is no adjacency *data* to be bad, only one outline. |
| C09 seam/hinge offsets | **Gone as parameters, and now doubly gone.** The hinge is a segment of the one outline itself; there is no per-bend placement field of any kind (v1's `bHingeOffsetMm` class, and even `T_pc`, cannot be expressed — there's nothing left to hold an offset). |
| C10 protrusions | Outline detail is part of the part's one outline in `F`; regions inherit it automatically via clipping (true polygons, never bboxes). |
| C11 cut at bend | Cuts are holes in the part's one outline (in `F`); if they intersect a bridge zone, the bridge clips against the true outline (D2, 14 §2.1). Layer separation is a drawing concern (07). |
| C12 degenerate far edge | No far-edge logic exists (that was a v1 rebuild-path concept). Point/degenerate cross-sections never enter the model. |
| C13 whole-part fidelity | Reassembly = evaluate (subdivide once, pose each region) + thicken/join along shared hinges; bounds identity is the C13 suite case. |
| C14 fold trees | The model **is** a tree over one outline's regions; branching is the base case, not an extension. |
| C15 closed loops | Spanning tree + seam constraints; loop closure residual = seam residual (typed finding if > ε). |
| C16 curved bends | Fold edge with `r`>0 ⇒ bridge zone = cylinder sector; arc-length development is the bridge mapping already required for radius modeling. Initial-version scope holds. |
| C17 rolled | Fold-edge chain from curvature profile (post-initial; no new machinery). |
| C18/C19 edits | Edits mutate the part's one outline / bend data (14 §2); the layout re-evaluates (re-subdivides + re-poses). Seam-touching edits change one region panel's data only (K5); the seam constraint reports the conflict. |
| C20 arbitrary orientation | `Pose(root)` is the part's world anchor; everything else is relative. Orientation invariance is structural (suite AC-C.3 sweeps confirm). |
| C21 replay | `evaluate` is a pure function of (graph, profile) — replay invariance is definitional. |
| C22 closure family | Sharp model (`w→0`) reproduces the analytic checkpoints; allowance variant exercises `w = θ(r+Kt)` — both are direct reads of the model. |

## 8. Isolated testing (the OPEN-14 requirement)

Pure data-in/data-out ⇒ thousands of cases in milliseconds, zero kernel:

- **Property tests**: `map3d∘map2d = id` (grid × all suite fixtures × random poses);
  `Flat`/`Pose` composition associativity along random trees; pose-sweep invariance;
  seam residual = 0 for analytically-closed loops (C22 all N, cube nets ×11);
  allowance closure for random (θ, r, K, t).
- **Bottom/top face consistency (§3.3, added 2026-07-20)**: `bottomFace(p)` and
  `topFace(p)` have equal length and index correspondence for every suite region
  panel; `|topFace(p)[i] − bottomFace(p)[i]| = t` exactly, for every `i`; the
  local-offset-then-pose and pose-then-world-offset constructions of `topFace`
  agree to machine precision (the rigidity equivalence claimed in §3.3).
- **DXF-pose equivariance (Paul, 2026-07-19)**: apply a 2D rigid transform `G` (e.g.,
  rotate by 45°, or any random rotation+translation) to `F` — the part's one outline
  and its bend hinges, together, as a single rigid re-expression — and compensate
  **only the root transform**: `R' = G⁻¹ · R`. Then *nothing else may change*:
  - the generated 3D object is identical (every `B_i` and `C_p` produce the same
    world geometry);
  - forward mapping commutes: `map2dTo3d'(G·p) = map2dTo3d(p)` for every flat point
    `p` (region panels and bridges);
  - reverse mapping commutes: `map3dTo2d'(X) = G · map3dTo2d(X)` for every valid 3D
    point `X`, including the returned node identity.
  Run for random `G` over every Level A case. This test kills, in isolation, the
  entire "implicit axis-alignment" bug class (v1's hinge-at-x=const assumptions,
  bbox-frame shortcuts): any code path that secretly depends on the DXF's orientation
  fails this property and nothing else.
- **Suite Level A cases run directly against the module** (no MCP, no kernel) — the
  same case files the acceptance suite uses (09 §1.5), so module tests and acceptance
  tests can never disagree about what "correct" means.
- **The three v1 defects as anti-regression properties**: N-ary chains evaluate (no
  multi-zone concept exists to be unimplemented); mapping is total (no region-lookup
  misses); region panel identity is structural (no swap).

## 9. Consumers

| Consumer | Uses |
|---|---|
| Part construction (FR-E) | `bottomFace(p)`/`topFace(p)` (§3.3) + side-wall quads per boundary edge + join along shared hinge material → 3D body; `regionOf(p)`'s point arrays, split per part → flat pattern/DXF |
| Mapping tools (J7) | §4 directly |
| Drawings (07) | datum = the part's flat-frame origin; every dimension value = a read of the layout (AC-G.1); bend table = fold-edge data |
| Semantic regions (I3a/I3b, 02 §0 alignment) | "this region panel" resolves directly to `regionOf(p)` (I3a — no computation beyond the subdivision already done); a genuine sub-region-panel area (I3b) resolves an explicit polygon within `regionOf(p)`, in `F` |
| Validation (FR-F) | seam residuals, region/bridge/edge clearances |
| Nesting/export (J8) | the part's flat outline, split into regions |

## 10. Open design points for review

- **D1. Fold-line direction convention** — `[DECIDED 2026-07-19]` right-hand rule
  about the directed hinge segment, child on the left. **Drawing consequence (Paul):
  signed angles never appear on engineering drawings** — there is no universal
  convention for what a sign means, so drawings state bend direction as **text**
  ("UP 90°" / "DOWN 45°", unsigned magnitude) on the flat-pattern sheet and in the
  bend table (07 D1/D2). The sign convention is internal to the model only.
- **D2. Bridge-zone material clipping** — `[DECIDED 2026-07-19; SIMPLIFIED
  2026-07-20]` **All standard approaches to bending custom parts are supported**:
  notched/relieved bends (bridge material = ideal strip ∩ **the part's one outline**
  — a relief notch removes its span in both the flat and the folded 3D; no metal is
  invented) and **rolled bends** (large-radius / fold-edge chains, already native
  §2). Since there is only one outline (14 §0), this is now a single intersection
  against one shape, not two independently-owned outlines that must agree — the
  "mismatched edge spans" concern from the earlier draft cannot occur; there is
  nothing to mismatch. Out of scope: features specific to high-tonnage press dies
  (coining, stamping-class forming) — consistent with the developable boundary (C5).
  (v1's bug class — sampling the union rectangle's oversized edge, inventing metal —
  is unrepresentable under the intersection rule.)
- **D3. Which surface does the DXF represent?** — `[DECIDED 2026-07-19]` **The DXF is
  the part's one 2D cutout**, and its plane maps to the **bottom surface** of each
  thickened 3D region panel (bottom vs top is arbitrary; bottom chosen). Thickening extrudes
  **upward** (+ẑ of `F`) by the part's single thickness `t`, so the 2D→3D transform
  of an outline point lands exactly on the created solid's bottom face — the
  transform aligns with 3D region panel creation by definition.
  Consequences carried into the formulas:
  - Flat *lengths* still use the neutral-fiber allowance (`w = θ·(r + K·t)`) — that is
    what makes the cutout fold to the right size; K appears only in widths/angles,
    never as a mapped surface.
  - The bridge chart (§4.3) positions points on the **bottom-face arc**: radius
    `r_b = r` for an UP bend (bottom face is the inner face) and `r_b = r + t` for a
    DOWN bend (bottom face is outer), while the angular coordinate keeps the neutral
    parameterization `φ = u/ρ` (so `u = w ⇒ φ = θ` and the child's bottom face
    attaches tangent-exactly).
- **D4. Root anchoring** — `[DECIDED 2026-07-19]` the root transformation `R` manages
  root anchoring: captured from the imported body's world placement at decompose time
  (authored parts: identity/explicit), so import→graph→replay reproduces world
  coordinates exactly (C13).
- **D5. Numeric representation** — `[DECIDED 2026-07-19]` doubles, with
  profile-relative comparisons from the numerical policy module (P4); no epsilon
  literals inside the module.
