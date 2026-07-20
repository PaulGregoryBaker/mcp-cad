# 09 — Core Correctness Suite: Harvest Plan (Phase 1.3)

**Purpose.** The implementation-agnostic acceptance suite that *defines rebuild success*
(OPEN-18 decision: v1's unsolved failures are the main motivation for the rebuild).
v2 is done-enough-to-retire-v1 when this suite is green; Phase 5's slices are gated on
its tiers by level (closure families gate slices 1–2; T1–T3 gate slice 4; the Level C
red cases gate slice 5).

## 1. Oracle standard (what counts as an assertion)

Per L4, weak oracles are excluded — they produced v1's false confidence (a 1440-case
sweep reported zero issues that a position probe later disproved).

**Admitted oracles:**
- **O1 True-position probes:** assert specific 3D points/features of the result land at
  exact expected coordinates (within profile tolerance). The only oracle that catches
  mirrored/far-edge/mis-rotated placement.
- **O2 Round-trip residuals:** map2d∘map3d ≡ id and replay(graph) ≡ geometry, with
  numeric residual budgets from the tolerance profile (N11).
- **O3 Exact polygon comparison:** flat pattern / DXF / drawing outline compared
  vertex-wise against expected polygons (not area, not bbox).
- **O4 Structural asserts:** solid count, manifoldness, seam-closure residual (C15),
  typed-error identity for cases that must fail loudly (N5).

Two standing **harness middlewares** wrap every case (opting out is impossible):
1. **Replay harness (P2/AC-B.1):** after every mutating verb — serialize → replay →
   O1 equivalence.
2. **Fix-application harness (F4/AC-F.7):** every finding with a `recommendedFix`
   emitted anywhere in the suite gets the fix applied verbatim and re-validated — the
   violation must no longer exist, with no new same-class finding, and the post-fix
   state must still pass the replay harness.

**Excluded as primary oracles:** bounding-box extents, volume-only comparison, "did not
throw". (Allowed only as fast smoke pre-checks before a real oracle runs.)

## 1.5 Direction-layered levels (Paul, 2026-07-18)

Every case is tagged with the *least* capability it needs, so failures attribute to one
layer and the suite can go green layer by layer:

- **Level A — graph-first, forward-only:** the graph is authored directly as data; only
  2D→3D construction runs. No import, no decomposition, no inverse mapping. The closure
  families (C22 polygon loops, 08 §3.1; net closures incl. the 5-bend cross→cube,
  08 §3.2) live here — the simplest and first-to-green layer.
- **Level B — bidirectional mapping:** adds 3D→2D (map_3d_to_2d, round-trip residuals,
  replay invariance) on the same authored graphs.
- **Level C — full pipeline:** starts from a STEP fixture (import → heal → decompose →
  graph), then everything above. All harvested v1 tests are Level C — which is why they
  are the heaviest and land last.

## 2. Suite form: implementation-agnostic

- Each case = a **data file** (YAML/JSON): fixture reference (STEP file or graph
  document) + operation script (v2-contract verbs) + expected oracle values.
- A thin **driver** binds the case format to an implementation. Two drivers planned:
  - **v1 driver** (first deliverable): runs the suite against this repo. Purpose is to
    *validate the suite itself* — it must reproduce the known ❌ failures (C05, C08,
    C13) and pass the 🩹 rows. A suite that can't detect v1's known bugs is not a
    valid oracle set.
  - **v2 driver**: written in Phase 5 slice 1; identical case files.
- Fixtures copied into the suite, not referenced from v1: `cauldron.step` (skewed
  quads — the killer fixture), `testcube.step`, `braai.step`, plus a **parametric
  generator** for synthetic panels (skew angle, orientation, protrusion placement) to
  fill the D-axis grid of 08-case-inventory.md systematically.

## 3. Harvest map (v1 → suite)

### Tier T0 — single panel, construction + mapping (cases C01, C02, C20)
Harvest: `split_panel_frame_dxf_consistency`, `unfold_roundtrip`,
`coordinate_mapping_multibend` (single-panel parts), `coordinate-map.unit`,
`merge_4point_mapping`, `flat-pattern-projection` unit tests → re-expressed as O2/O3
cases. Systematic orientation sweep added via generator (v1 never did this).

### Tier T1 — two-panel merge (C03, C04, C05, C09)
Harvest: `merge_orientation_preserved`, `merge_edge_alignment`,
`build_shell_acute_fold`, `merge_asymmetric_flat`, `unequal_leg_bracket_orientation`,
`real_panel_translate_merge_bend_rotation` (probe-based) → O1+O2 cases.
**Red case:** cauldron pair (1,0) simple merge (C05) — enters as a failing acceptance
case with the position oracle; v2 must make it green.

### Tier T2 — straight chains (C06, C12, C21, C22)
Harvest: `testcube_three_panel_chain_merge_repro`, `four_panel_near_end_chain`,
`testcube_chained_merge_then_fuse_volume` (upgrade its volume oracle to O1),
`fuse_undo_redo_consistency`, `fuse_unfold_graph_regression` (replay invariance).
**Generated: the polygon closure family (C22, 08 §3.1)** — N ∈ {3..9} × both bend
directions × DXF pose sweep × sharp/allowance variants, with per-bend partial-loop
checkpoints. Oracle: O1 on the analytic checkpoints + a dedicated **closure residual**
(distance between the mapped images of the two strip ends; budget from the tolerance
profile). Zero-reference: no stored expected coordinates to maintain. Because all folds
are parallel, **v1 can run this family today** via its straight-chain support — it goes
into the v1-driver validation run immediately, and doubles as a diagnostic instrument
for the open C05/C13 investigations (closure decomposes error per bend).

### Tier T3 — corner chains & composites (C07, C08, C10, C11, C13)
Harvest: `chained_merge_protrusion_fuse_rotation`, the four `testcube_*_protrusion_*`
probe tests, `testcube_protrusion_coplanar_merge`, `cauldron_diagnose_2solids`,
`cauldron_trapezoidal_panel_merge`, `merge_unfold_dxf_content`.
**Red cases:** refold-2-solids residual edge case (C08); cauldron full-part bound
(C13). The 1440-triple sweep is re-created as a *generative* case over the suite's
fixtures — but with O1 oracles this time.

### Tier T4 — curved bends (C16) — 🆕 authored, no harvest
No usable v1 tests (reconstruct_curved_bends is cut). Cases authored from first
principles: cylindrical bend construct/flatten/map with arc-length ground truth
computed analytically; conical variant; curved bend inside a chain.

### Tier T5 — direct graph editing (C18, C19) + closed loop (C15) — 🆕 authored
Move-edge/smooth-edge/hole cases with O2+O3 (forms and drawings regenerate
consistently); K5 conflict-flagging with O4 typed-error identity; all-sides box seam
closure (O4).

### Harvest scope `[REVISED 2026-07-19 per OPEN-19: ALL tests are harvested]`
Nothing is dropped outright; every v1 test is carried, with per-category treatment:
- **Weak-oracle tests** (bbox/volume-only): harvested with oracles **upgraded** to
  O1–O4 during translation — the scenario survives, the weak assert does not (L4).
- **v1-implementation-detail tests** (shard internals, NAPI binding shapes, handler
  regression tests): harvested as *intent* — re-expressed against the v2 contract at
  the layer where the behavior is observable.
- **DB-infra tests** (`dolt_smoke`, `md_*` config/rules/scoring): intent carried into
  Phase 3 store validation and v2 contract tests.
- **Debug-artifact repro files** at repo root (`cauldron_*.txt`, `test-*-repro.cjs`):
  findings encoded in 08-case-inventory.md; files themselves not migrated.

Additionally (OPEN-19): this acceptance suite is the **top layer only** — the v2 stack
carries its own layered tests beneath it (unit/property tests for the translation
module per OPEN-14, integration tests per service), organized along the §1.5 direction
levels.

### C++ ctest tier (60 tests)
Not harvested into the agnostic suite (they test kernel internals). Disposition
follows the Phase 3 kernel ADR: kernel reused → tier carried as-is; kernel replaced →
tier retired and its *intent* (healing, sewing, boolean robustness) re-covered by T0–T3.

## 4. Deliverables & order

1. Suite skeleton (case schema + fixtures + generator spec).
2. **v1 driver + T0–T3 harvested cases** → run against v1; confirm 🩹 pass and ❌ fail
   (suite validation gate).
3. Red cases pinned (C05, C08, C13) with their oracles frozen.
4. T4/T5 authored cases (can proceed in parallel with Phase 2 design).
- **Exit (matches Phase 1.3):** suite runs red-on-stub / correctly-red-on-v1; case
  files reviewed; oracle budgets tied to a named tolerance profile.
