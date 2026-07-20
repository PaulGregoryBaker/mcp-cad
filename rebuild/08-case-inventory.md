# 08 — Placement & Translation Case Inventory (Phase 1.4)

**Purpose.** The complete enumeration of situations the v2 translation module (OPEN-14)
must solve. Per L1/P3 there will be **one geometric solution for all of these** — no
per-case gates. The Phase 2.1 design doc must walk every row of §3 and show, on paper,
how the single model handles it. Scope boundary: developable surfaces (C5, ratified).

**Sources.** v1 test suite (`ts/tests/integration/`, 64 tests; `cpp` ctest, 60 tests),
v1 bug history (01-lessons-learned.md), fixtures `cauldron.step` / `testcube.step` /
`braai.step` (`cpp/tests/fixtures/`).

---

## 1. Case dimensions

A concrete case is a combination across these axes. The design must handle the *product*
of the axes, not a curated list — the rows in §3 are the named combinations v1 proved
dangerous, plus the new-scope rows v1 never attempted.

- **D1 Panel outline:** rectangle · skewed quad/trapezoid · multi-lobed polygon ·
  outline with protrusions · with holes/cutouts · with smoothed (curved) outline
  segments (FR-K2)
- **D2 Panel orientation:** axis-aligned · arbitrary 3D orientation · mirrored
- **D3 Bend:** 90° · obtuse · acute · inverted fold direction · arbitrary angle ·
  partial-width bend · **curved bend (cylindrical/conical — initial version, C5)** ·
  rolled section (post-initial, C5)
- **D4 Topology:** single panel · two-panel · N-panel sequential **straight chain**
  (parallel fold lines) · **corner chain** (perpendicular/oblique fold lines) · mixed ·
  **fold tree** (one panel with bends to multiple neighbors — branching, not a chain) ·
  closed loop (all-sides-folded box; the redundant seam)
- **D5 Seam detail:** seam offset along the fold line · hinge offset · bend at/near a
  cut line · reliefs at bend intersections · kerf notches on segment edges
- **D6 Composite state:** fresh panels · merge onto an already-merged composite (3+
  chained) · composite whose far edge is degenerate (single point / non-parallel)
- **D7 Post-construction edits (FR-K):** move-edge on a free edge · move-edge on a
  seam edge (K5: no propagation, flag 3D conflict) · smooth-edge crossing a bend zone ·
  hole spanning near a bend zone

## 2. Model requirements implied by the inventory

The single geometric solution must therefore natively represent:

1. **A fold tree, not a chain** — D4's branching case rules out any 1D-strip/sequential
   model (v1's fatal simplification, L3).
2. **Arbitrary fold-line direction in the flat plane** — corner chains rule out
   one-axis bend zones.
3. **Full rigid transforms** — per-panel 3D pose and per-panel 2D placement in the flat
   pattern, composed exactly along tree paths (no offsets, no end-alignment
   assumptions — L1 complexity lesson).
4. **True polygon geometry throughout** — clipped polygons, never bbox
   rectangularization (v1 lost ~51% of a segment's area to a bbox shortcut).
5. **Developable curved zones** — a curved bend is a ruled developable strip with exact
   arc-length flattening, same citizen as a straight bend zone.
6. **Closed-loop awareness** — detect the redundant seam in a closed box; the loop's
   accumulated transform must close within profile tolerance or produce a typed finding.

## 3. Named cases and v1 status

Status legend: ✅ v1 solved · 🩹 v1 solved late/fragile (fix known, carry the test) ·
❌ v1 never solved (**core correctness suite, red until v2 passes**) · 🆕 new scope,
no v1 coverage (tests must be authored).

| # | Case | v1 status | Evidence |
|---|---|---|---|
| C01 | Single rectangular panel, axis-aligned, flat construction + mapping | ✅ | unfold.integration, coordinate-map.unit |
| C02 | Single skewed-quad panel — frame/DXF self-consistency | 🩹 (dual-derivation bug; fixed via single projected ring + CCW canonicalization) | split_panel_frame_dxf_consistency, cauldron_trapezoidal_panel_merge |
| C03 | Two-panel merge, 90°, rectangles | ✅ | merge_orientation_preserved |
| C04 | Two-panel merge at any angle incl. acute + inverted fold | 🩹 (branch 010) | build_shell_acute_fold, merge_edge_alignment |
| C05 | Two-panel merge, skewed quads (cauldron class) | 🩹 mostly; **pair (1,0) still fails simple-merge position check — root cause unknown** ❌ | cauldron_diag_pair2, cauldron_verify_adjacency |
| C06 | N-panel straight chain (3+, parallel folds) | 🩹 (N sequential bend zones generalization) | testcube_three_panel_chain_merge_repro, four_panel_near_end_chain |
| C07 | Corner chain (perpendicular folds) — true 3D position | 🩹 (flat-pattern model could NOT represent it; final fix = live-3D fuse of placed shells; sweep false-negatives en route) | chained_merge_protrusion_fuse_rotation, memory: corner-chain saga |
| C08 | Chain onto multi-lobed composite flat ("Refold produced 2 solids") | 🩹 with **1 documented unresolved edge case** ❌ | cauldron_diagnose_2solids, 1440-triple sweep |
| C09 | Merge with seam offset / hinge offset (bHingeOffsetMm class) | 🩹 (four separate offset bugs; the anti-pattern that motivated the no-offsets rule) | merge_asymmetric_flat, seam-offset memory |
| C10 | Panels with protrusions through merge/fuse (incl. same-side corner cuts) | 🩹 | testcube_*_protrusion_* (probe-based), remove_protrusions tests |
| C11 | Bend at/near cut line; kerf-notch detail through booleans | 🩹 (cut-line DXF filter; fuzzy-tolerance volume loss 0.15→1e-5) | merge_unfold_dxf_content, cauldron metrics |
| C12 | Composite with degenerate far edge (single-point cross-section) | 🩹 (`hi>lo` off-by-one; `compositeFarEdgeDegenerate` gate — gate must NOT survive into v2, P3) | four_panel_near_end_chain |
| C13 | Full cauldron: all panels, all pairs, total-bbox fidelity | ❌ (5/6 bounds within ~1mm; last bound off ~167mm, mechanism never found) | cauldron_metrics.txt, test-file docs |
| C14 | Fold tree (branching: one base panel, 2+ folded neighbors on different edges) | ⚠️ split_body_by_bends produced them; **merge/construction path never supported branching** — v1 model was sequential-only | split_by_bends tests; L3 |
| C15 | Closed loop (all-sides box) — seam closure within tolerance | 🆕 (never attempted) | — |
| C16 | Curved bend (cylindrical/conical), construct + flatten + map | 🆕 initial version (C5); v1's reconstruct_curved_bends (3D-analysis) is cut — no reusable coverage | 007 spec background only |
| C17 | Rolled section | 🆕 post-initial (C5) | — |
| C18 | Move-edge/smooth-edge on free edge → forms + drawings regenerate consistently | 🆕 (FR-K) | — |
| C19 | Move-edge on seam edge → local change + flagged 3D conflict (K5), no propagation | 🆕 | — |
| C20 | Arbitrary panel orientation (no axis alignment anywhere) for every case above | 🩹 partially — v1 fixed instances as found; never systematic | fuse_bodies U/V-swap memory; C5 core |
| C21 | Round-trip: replay(graph) ≡ geometry after every op above (P2 harness) | 🩹 retrofitted per-tool, incomplete | fuse_unfold_graph_regression, unfold_roundtrip |
| C22 | **Polygon closure family** (§3.1): flat strip divided into N equal segments, N−1 parallel bends of 360°/N → prism closes on itself; both ends of the DXF map to identical 3D coordinates | ❌ (Paul's proposal 2026-07-18. First driver run 2026-07-19 disproved "v1 can run it": three defects found — multi-zone hinge split unimplemented; merged-DXF region lookup misses panel B; **panel↔frame association swapped** in merged-part mapping, a minimal 2-panel repro of the C05 class) | suite README calibration findings; suite_driver_v1 |

### 3.1 The polygon closure family (C22) — self-referencing translation oracle

Proposed by Paul as the primary test vehicle for the manufacturing graph's 2D→3D
translation. Construction: a DXF rectangle divided into **N equal segments** forming
**N−1 parallel bend lines**; bend each by the polygon exterior angle (**360°/N**); the
strip closes into a regular-N-gon prism, so **both ends of the flat pattern must map to
the same 3D coordinates** — closure is the oracle, no external ground truth needed.

Parameter axes:
- **N ∈ {3, 4, 5, 6, 7, 8, 9}** — square tube (4 × 90°) through nonagon (140° folds);
  odd N exercises non-right angles automatically.
- **Both bend directions** (all-up = closes one way; all-down = mirror closure).
- **DXF pose sweep:** the flat pattern placed at multiple 2D positions/rotations — and
  the base panel at arbitrary 3D orientations (D2) — closure must be invariant.
- **Partial-loop checkpoints:** after k of N−1 bends, the free end's position is known
  analytically (regular-polygon chord) — giving per-bend intermediate oracles that
  *localize* which bend introduces error, not just detect that one did.
- **Two thickness variants:** (a) sharp midsurface folds — equal segments close
  exactly; tests pure transform composition; (b) real bend radius + K-factor — closure
  requires correct bend allowance in the segment lengths; tests the bend math on top.

Limitation (deliberate): all folds are parallel, so C22 isolates chain composition —
it complements, never replaces, the corner-chain (C07), fold-tree (C14), and box
closure (C15) cases. Those get their own zero-reference family: §3.2.

### 3.2 The net closure family (C15 generalized — fold trees, perpendicular folds)

Same zero-reference principle applied to polyhedral **nets** (Paul's example: a cross
shape bent 5 times produces a closed cube). The cross cube net is 6 square faces with
5 fold lines — and it is a **fold tree with branching** (the spine face carries side
arms), with **perpendicular fold lines**, closing at **7 unglued edge pairs**. Oracle:
every meeting edge pair maps to coincident 3D segments, within profile tolerance.

Parameter axes:
- **All 11 cube nets** — same target solid, 11 different fold trees; a model that is
  secretly sequential or orientation-biased will pass some nets and fail others.
- **Other polyhedra:** tetrahedron net (3 folds at the tetrahedral dihedral — non-right
  angles in a tree), square pyramid, triangular prism (mixes with C22).
- Same sweeps as C22: both fold directions, DXF pose sweep, sharp vs
  radius+allowance variants.

Together C22 (parallel chains) + §3.2 (trees, perpendicular/oblique folds) cover the
D4 topology axis with self-checking oracles.

### 3.3 Methodological note — direction-layered testing (Paul, 2026-07-18)

These closure families are **graph-first, forward-only**: the manufacturing graph is
*authored directly* and only the 2D→3D construction is exercised. The harvested v1
tests all start from a STEP file, so they need import + decomposition + both mapping
directions to work before they can say anything. Testing one direction first is
simpler and attributes failure precisely. This layering is formalized in
09-core-correctness-suite.md §1.5 and reorders the Phase 5 slices (06-plan.md).

## 4. Other Phase 1.4 domain knowledge to capture (not placement)

Pointers for extraction into domain notes during Phase 2 — v1 locations verified:

- **Bend allowance / K-factor math** — `ts/src/manufacturing/` (+ 007 spec).
- **Numerical policy facts:** canonical CCW via shoelace sign; boolean fuzzy tolerance
  1e-5 (0.15 destroyed kerf detail); mapping budget 0.1 mm (now profile default N11).
- **Winding hazard:** BRepTools_WireExplorer winding varies face-to-face — any kernel
  adapter must canonicalize at the boundary.
- **DXF conventions** — `ts/src/mcp/dxf-helpers.ts`, `ts/src/manufacturing/dxf/`
  (layer scheme feeds 07 §3).
