# 12 — Domain Notes & v1 Salvage (Phase 1.4)

Knowledge that must survive the rebuild, extracted from v1 code, memory, and unmerged
branches. Companion to the placement case inventory ([08](08-case-inventory.md) §4).

## 1. Bend math

- **Bend allowance** (arc length of the neutral axis through a bend):
  `BA = θ_rad · (r + K·t)` — angle in radians, inner radius r, K-factor K, thickness t.
  v1: `ts/src/manufacturing/material.ts:33` (validates 0≤θ≤180, r≥0).
- ⚠️ **v1 has TWO independent implementations** of this formula
  (`manufacturing/material.ts:33` and `manufacturing/graph/types.ts:258`, different
  signatures) — the L1 dual-derivation smell in miniature. v2: one implementation,
  inside the translation module.
- **K-factor** comes from the material record (config: e.g. mild_steel_1.5mm → K=0.33,
  t=1.5); v2 moves this into the project tolerance/material profile (N11).
- Flat segment length between two bends = outside dimension − bend deductions; the
  closure-family allowance variant (C22-b) is the intended oracle: strips sized by this
  math must close within ε. The surface convention v1 never stated is now pinned
  (13 §10 D3): the DXF is the panel's 2D cutout mapped to the **bottom surface** of
  the thickened panel (thicken upward by t); flat lengths remain neutral-fiber-based
  via BA; the bridge chart positions on the bottom-face arc with angle φ = u/ρ.

## 2. Numerical policy facts (→ v2 policy module, P4)

- **Winding:** `BRepTools_WireExplorer` yields face-dependent winding; v1 canonicalizes
  outlines to **CCW by shoelace sign** inside `getPanelFrame`. Any kernel adapter must
  canonicalize at the boundary.
- **Boolean fuzzy tolerance:** 1e-5 mm. The earlier 0.15 mm silently discarded ~50% of
  a part's volume once kerf-notch detail existed. Fuzzy tolerance must scale with the
  *smallest feature*, not the part size.
- **Mapping accuracy:** 0.1 mm round-trip was spec 012's constant
  (`COORD_MAP_ACCURACY_THRESHOLD_MM`); becomes the default profile's `closureMm`/
  `probeMm` budget, not a constant.
- **Merge edge alignment:** `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (adjacency gate ~2 mm
  in practice — "panels are not close enough to share a bend edge" at 2 mm threshold).
- **Region lookup boundary behavior:** v1's flat-pattern panel-region test excludes
  points exactly on the outline (suite driver needs 1 mm inset). v2 should define
  closed-boundary semantics (a point on the outline IS on the panel).
- Split classification thresholds: `angle_threshold_deg: 35`, `max_thickness_mm: 5.0`
  (defaults used across v1 tests); flat sheets classify as `thin_solid` and get **no**
  graph — v2's A4 bootstrap must handle the single-panel case.

## 3. DXF conventions

- Parsing/writing helpers: `ts/src/mcp/dxf-helpers.ts`, `ts/src/manufacturing/dxf/`
  (incl. `Placement2D` in `dxf/merge.ts`, reused by spec 012 as `DxfPlacement2D`).
- Flat outline = closed LWPOLYLINE on layer `0`; minimal-document shape as in
  `rectDxf()` (suite driver) / cube_box_workflow test.
- Cut lines vs bend lines live on separate layers (bend-up/bend-down distinction is
  the drawing spec's D1 concern, 07 §2); v1's cut-line-at-bend filter bug is the
  cautionary tale (a bend line emitted as a cut line gets cut).
- Kerf compensation: 0.1–0.2 mm offset class for laser/waterjet (constitution v2
  principle XII); v2: kerf class lives in the tolerance profile (N11).

## 4. Fixture inventory (cpp/tests/fixtures/)

Real: `cauldron.step` (skewed quads — the killer), `testcube.step`, `braai.step`.
Synthetic: angle brackets (15/30/45°), `l_bracket_corner_90deg.stp` (suite driver's
segment source, flat panel 201.5×200×2), `unequal_leg_bracket_90deg.stp`,
`tab_bracket_90deg.stp`, `cube_with_flanges.stp`, `hollow_cube.stp`, `sheet_1panel.stp`
(300×200×1.6, centered origin), `sheet_3panel.stp`, `simple_box.stp`.
Generator: Python (fixtures dir, pycache present; source .py missing — regenerate or
reconstruct in v2 suite).

## 5. Salvage: unmerged branch `origin/010-build-manufacturing-plan`

**One commit ahead of main** (`751c5e4` "Implement dynamic joint prioritization by
priority category, combined area, and axis alignment"), ~1900 added lines. This is the
direct prior art for requirement **A4** (import bootstraps a workable manufacturing
graph) — a complete spec-kit feature that was never merged:

- `specs/010-build-manufacturing-plan/` — full spec/plan/research/data-model/tasks.
  Spec intent (Paul's own words): split parts by bends → per-panel graphs (flag
  non-panels) → recombine via merge_bodies_with_bend → joints that break the process
  (e.g., protrusion in panel center) are not merged.
- `ts/src/manufacturing/reconstruction/orchestrator.ts` (521 lines) + `types.ts` —
  the reconstruction pipeline incl. **dynamic joint prioritization** (priority
  category, combined area, axis alignment) deciding merge order.
- `build_manufacturing_plan` MCP tool + integration/unit tests (135 + 143 lines).
- User Story 2: detection/isolation of non-panel features (welded nuts, bosses, ribs)
  with an unmerged-features report — this classification requirement should be carried
  into A4's acceptance criteria.

**Salvage action:** treat as *reference for Phase 2 design and A4 criteria*, not as
code to merge — but do not delete the branch. The joint-prioritization heuristics and
the non-panel classification report shape are the valuable parts.

## 6. v1 mapping-defect repro (found by the suite, 2026-07-19)

Minimal C05-class repro without cauldron: two authored flat panels (registerTestPart),
posed perpendicular, merged with merge_bodies_with_bend → `map_2d_to_3d` with explicit
panel_id maps each panel onto the OTHER panel's 3D plane (association swap); global
(no-panel_id) lookup can't find panel B's region at all. Full recipe in
`ts/tests/integration/suite_driver_v1.integration.test.ts` + suite README calibration
notes. Keep this repro alive — it's the fast entry point into v1's deepest bug class.
