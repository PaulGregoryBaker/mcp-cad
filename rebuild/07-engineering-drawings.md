# 07 — Engineering Drawings (OPEN-22 draft spec)

**Status:** `[PROPOSAL]` — first concrete draft for grilling. Pivot 1 requires that the
manufacturing graph produce *well-defined engineering drawings associated with each
component*; v1 only touched on this (DXF flat patterns), so this is mostly new design.

## 1. Principles

1. **Drawings are derived views, never documents.** A drawing is a deterministic
   projection of the graph (same canonical pipeline as the 3D object, per N2/P3),
   regenerated on graph change. The drawing *artifact* is never hand-edited — but the
   drawing *view* is an **editing surface** (FR-K3): engineers comfortable working with
   the drawing can edit through it, and each such edit is a graph CRUD mutation that
   lands in the graph, after which the drawing regenerates. Bidirectional surface,
   derived artifact.
2. **Data first, rendering second.** The canonical artifact is a structured
   **DrawingModel** (serializable; geometry + dimensions + annotations as typed data).
   Renderers turn it into output formats. This keeps drawings diffable — essential for
   the branch/merge/review workflow (B5): a review shows *drawing deltas*, not pixel
   comparisons.
3. **Traceability.** Every drawing states the graph version (and branch) it was derived
   from, plus the tolerance profile in effect. A drawing without provenance is invalid.
4. **Precision from the tolerance profile (N11).** Dimension display precision, tolerance
   callouts, and fit clearances come from the active project profile — never hardcoded.
5. **Datums from the translation module (OPEN-14).** All 2D dimensions are referenced to
   the flat-pattern datum produced by the placement/translation class — the same origin
   used by 2D↔3D mapping. One datum authority; drawings can never disagree with the
   mapping.

## 2. Proposed drawing set per component

For each **panel/part component** in the manufacturing graph:

| # | Sheet | Contents |
|---|---|---|
| D1 | **Flat pattern** | Outline; bend lines (centerline) with direction **stated as text — "UP"/"DOWN" with unsigned angle** (13 §10 D1: signed angles never appear on drawings; no universal sign convention exists), inner radius; grain direction; holes/cutouts; datum + critical dimensions |
| D2 | **Bend table** | Bend sequence, direction as text + unsigned angle, radius, K-factor, bend allowance/deduction, resulting flange lengths, tooling hint (V-die width) |
| D3 | **Hole/cut schedule** | Datum-referenced positions, size/shape, count, process (laser/punch/tap), kerf class |
| D4 | **Formed views** | Orthographic views + isometric of the folded state, overall dimensions |
| D5 | **Part block** | Material + gauge/thickness, finish, mass, part ID, graph version hash, branch, tolerance profile, revision history (from graph history — not a manually maintained table) |

For **semantic-graph entities** (Pivot 2): gaps and holes that carry engineering intent
get called out on D1/D3 with their semantic name (e.g., "VENT-GAP-3: 5 mm ventilation
gap"), so drawings speak the same vocabulary the collaborators use. `[PROPOSAL — needs
Paul's confirmation that intent callouts belong on manufacturing drawings.]`

At **part (multi-component) level**: fold-sequence sheet and BOM live in the production
pack (FR-G3), not per-component. `[OPEN-23]` is a per-part assembly/folding drawing
required, or is the production pack's instruction set enough?

## 3. Output formats

- **DrawingModel (canonical):** versioned JSON schema; the thing tests assert against.
- **Layered DXF:** for manufacturing (cut layer, bend-up layer, bend-down layer,
  annotation layer — layer scheme to be fixed in the contract).
- **PDF sheet:** for human review/sign-off (title block per D5).
- **SVG:** lightweight UI preview (Form.AI.tion flat_patterns screens).

## 4. Dimensioning rules (draft)

- Baseline dimensioning from the flat-pattern datum (consistent with D3 schedule);
  chain dimensioning only for bend-relative features. `[OPEN-24]` confirm convention.
- Standard: pragmatic subset of ISO 129 dimensioning; full GD&T (ASME Y14.5) is out of
  scope for v2 unless a customer requires it. `[OPEN-25]`
- Units: mm everywhere (matches v1); display precision per tolerance profile.

## 5. Acceptance criteria (sketch)

- Determinism: same graph version + profile → byte-identical DrawingModel.
- Consistency: every dimension value on D1–D4 must equal the value computable from the
  graph via the translation module within profile tolerance (no independent measurement
  path — this is L1 applied to drawings).
- Round-trip: D1 outline + bend lines must reproduce the flat pattern used by nesting
  exactly (single derivation, not a parallel DXF writer).
- Review: two graph versions → a structured drawing diff (added/removed/changed
  dimensions and features), consumable by the review UI.

## 6. Open questions — resolutions (2026-07-19)

- ~~`[OPEN-23]`~~ **ANSWERED: drawings are resources — and a primary UI.** All drawings
  (including the per-part folding drawing) are served through the graph-projection
  resource namespace (B3a family), not merely bundled into the export pack — because
  **some users will use the drawings as their primary UI**. The production pack (FR-G3)
  is just a bundled snapshot of the same projections. This elevates K3: the drawing
  view is a full working surface (read via resource, edit via graph CRUD), not an
  output format.
- ~~`[OPEN-24]`~~ **ANSWERED (2026-07-19): mixed dimensioning, auto + curation.**
  (a) *Measurement:* **baseline from the panel datum** (the flat-pattern origin owned by
  the translation module) for outline, bend lines, and hole positions — no tolerance
  accumulation, machine-friendly; **chain dimensioning only within semantic patterns**
  (e.g., hole pitch in a row), where the spacing *is* the design intent.
  (b) *Selection:* the system **auto-generates the full dimension set** (outline, every
  bend line, every hole, semantic callouts); an engineer may then **curate** — promote
  critical dimensions, hide noise — and the curation is stored as **graph metadata**
  (a K3 edit through the drawing view), so it survives regeneration and rides
  branches/commits like everything else.
- ~~`[OPEN-25]`~~ **ANSWERED: align with best-practice drawing standards.** Drawings
  follow recognized standard conventions (projection, line types, dimensioning
  practice — ISO 128/129 family as the metric default; sheet-metal bend annotation per
  accepted practice). Selecting the exact standard set and title-block contents is a
  research task inside the Phase 2 drawing-spec design; "invented conventions" are
  not acceptable.
- ~~`[OPEN-26]`~~ **ANSWERED: generated on demand.** Lazy generation — a drawing is
  produced when its resource is read or an export requests it, backed by the
  content-addressed cache keyed by graph version (B7 corollary). Consistent with N9:
  drawing generation is a heavy op where accuracy beats speed.
