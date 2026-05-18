# Implementation Plan: Smart Panel Decomposition for split_body_by_bends

**Branch**: `003-split-by-bends-enhanced` | **Date**: 2026-05-18 | **Spec**: [spec.md](spec.md)

---

## Summary

Enhances `split_body_by_bends` with two decomposition modes, protrusion detection, and optional
recursive decomposition. The existing BFS face-grouping logic is preserved and extended; the main
new work is in OCCT solid-cutting for Mode 2 and a protrusion-detection pass that runs before
any cutting.

---

## Technical Context

**Language/Version**: C++ (Geometry Engine, OCCT facade), TypeScript (MCP Protocol Layer)

**Primary Dependencies**: OCCT 7.8.x (`BRepGProp`, `BRepExtrema_DistShapeShape`,
`BRepPrimAPI_MakePrism`, `BRepPrimAPI_MakeHalfSpace`, `BRepAlgoAPI_Cut`,
`TopExp::MapShapesAndAncestors`)

**Constraints**: Every mutating call must snapshot first (Constitution Principle IV); structured
errors always (Principle VI).

---

## New Parameters

| Parameter | Type | Default | Purpose |
|---|---|---|---|
| `angle_threshold_deg` | number | 1.0 | Existing — what counts as a bend |
| `max_thickness_mm` | number | 5.0 | Mode-detection threshold; wall thickness above this → Mode 1 |
| `default_thickness_mm` | number | 1.0 | Mode 1 only — extrusion thickness for surface/thick models |
| `max_recursion_depth` | integer | 0 | 0 = single pass; ≥ 1 = recurse into remainder |

---

## Updated Result Structure

### C++ (`DecomposedByBendsResult`)

```cpp
struct DecomposedByBendsResult {
  std::vector<ShellId> panelIds;       // flat solid panels
  std::vector<ShellId> protrusionIds;  // flanges / tabs extracted before splitting
  SnapshotId           rollbackToken;
  std::string          detectedMode;   // "surface" | "thin_solid"
};
```

Replaces the existing `shellIds` field. The TypeScript handler maps this to `panel_ids`,
`protrusion_ids`, `detected_mode` in the MCP response.

---

## Mode Detection Algorithm

Runs at the start of every `splitBodyByBends` call (before any cutting).

```
1. Compute volume via BRepGProp::VolumeProperties on the input shape.
   - Volume ≈ 0 (< 1e-6 mm³) → MODE_SURFACE

2. For non-zero volume, measure minimum wall thickness:
   a. Index all faces with outward normals using TopExp::MapShapes.
   b. For each face F with normal N:
      - Find all faces F' where normal N' ≈ -N (dot product < -0.95).
      - Measure face-to-face distance via BRepExtrema_DistShapeShape(F, F').
   c. minimum_thickness = min of all measured distances across all face pairs.

3. minimum_thickness ≤ max_thickness_mm → MODE_THIN_SOLID
   minimum_thickness >  max_thickness_mm → MODE_SURFACE (thick solid, treat as conceptual)
```

---

## Mode 2: Thin-Solid Decomposition (Cutting Plane Approach)

Applies when `detectedMode == "thin_solid"`.

### Step 1 — Identify primary panel groups

Reuse the existing BFS coplanar-face-grouping logic from the current `splitBodyByBends`
implementation. Each connected group of coplanar faces on the outer surface is one primary panel.

### Step 2 — Find inner face for each panel

For each primary panel group with outer face plane P_outer and outward normal N:

```
For each face F in the group:
  Cast a sampling ray from F's centroid in direction -N (inward).
  Use IntCurvesFace_ShapeIntersector to find the first hit on the solid.
  Record the hit face F_inner and distance d.
Minimum d across all samples = wall_thickness for this panel.
F_inner plane = P_inner (the cutting plane for this panel).
```

### Step 3 — Sequential cutting

Process panels in order (e.g. largest-area first to minimise remainder complexity):

```
remainder = original solid
for each primary panel:
  halfSpaceOuter = BRepPrimAPI_MakeHalfSpace(P_outer, point_inside_solid)
  halfSpaceInner = complement of BRepPrimAPI_MakeHalfSpace(P_inner, point_outside_panel)
  panelSlab = BRepAlgoAPI_Common(remainder, halfSpaceOuter ∩ halfSpaceInner)
  remainder  = BRepAlgoAPI_Cut(remainder, panelSlab)
  register panelSlab → new ShellId → panelIds
```

**Corner ownership**: one panel receives the full corner material (the panel whose plane is used
first in the cut sequence). Adjacent panels are trimmed by that plane. This is intentional and
user-correctable with `merge_bodies_with_bend`.

---

## Mode 1: Surface / Thick-Solid Decomposition (Extrusion Approach)

Applies when `detectedMode == "surface"`.

### Step 1 — BFS face grouping

Identical to the existing logic: group coplanar faces by BFS with the `angle_threshold_deg`
constraint.

### Step 2 — Extrude each group

For each coplanar face group:

```
Build boundary wire from the group's combined outer edges
  → BRepBuilderAPI_MakeWire from boundary edges (edges with only one adjacent face).
Extrude wire by default_thickness_mm along outward face normal
  → BRepPrimAPI_MakePrism(face, extrusion_vector).
Register extruded solid → new ShellId → panelIds.
```

The extrusion direction is outward (away from the model interior for surface models, or outward
from the solid for thick models).

---

## Protrusion Detection

Runs after mode detection, before any cutting. Applied to each primary panel group.

A protrusion is a connected group of faces that:

1. **Extent test**: The attachment edge(s) between the protrusion and the primary panel face have
   total length < 50% of the primary panel's perimeter. This distinguishes a localised tab from a
   full-width panel extension.

2. **Orientation test**: The protrusion's "cap" face (the face furthest from the primary panel
   plane) has a normal approximately parallel to the primary panel normal (dot product > 0.85).
   This confirms it is a fin/tab sticking out, not a bend toward another panel.

3. **Thickness test**: The cross-section width of the protrusion group, measured perpendicular
   to the primary panel normal, is ≤ `max_thickness_mm`.

### Algorithm

```
for each primary panel group G:
  for each edge E on the boundary between G and a non-primary face:
    if attachment_length(E) / G.perimeter < 0.50:
      trace connected non-primary faces reachable from E
      if cap_face_normal ∥ G.normal AND cross_section_width ≤ max_thickness_mm:
        mark connected region as protrusion P
        cut P from solid at G's face plane
        register P → new ShellId → protrusionIds
```

### What is NOT a protrusion

- A face group that connects two different primary panels (it's a corner wall / bend face).
- A feature whose attachment spans ≥ 50% of the primary panel perimeter (it's a panel extension).

---

## Recursive Decomposition

Applies when `max_recursion_depth > 0`.

After one pass of protrusion removal + panel cutting, the remainder solid may contain inner
structures (inner cube, inner flanges). The algorithm recurses:

```
function decompose(solid, params, depth):
  mode = detectObjectMode(solid, params.max_thickness_mm)
  protrusions = detectAndExtractProtrusions(solid, params)
  panels = cutPanels(solid_minus_protrusions, mode, params)
  remainder = solid_minus_protrusions_minus_panels

  if depth > 0 AND remainder.volume > min_volume_threshold:
    sub = decompose(remainder, params, depth - 1)
    panels      += sub.panels
    protrusions += sub.protrusions

  return { panels, protrusions }
```

**Termination conditions** (stops before `max_recursion_depth` is reached):
- Remainder volume < 1 mm³ (nothing left).
- No bends found in remainder (single flat panel or solid blob).
- No primary panel groups identified (degenerate geometry).

**Connected components**: if cutting panels disconnects the remainder into separate solids,
each component is recursed independently.

---

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| I. Deterministic | PASS | All new ops are OCCT kernel calls |
| IV. Rollback-First | PASS | Snapshot taken before any mutation; rollback_token restores full pre-call state |
| VI. Structured Errors | PASS | New error codes added for each new failure mode |
| VII. MVP Scope | PASS | Phases are independently shippable; US1 alone is a viable MVP |

---

## New Error Codes

| Code | Meaning | Recoverable |
|---|---|---|
| `GE_DECOMPOSE_THICKNESS_MISMATCH` | Wall thickness measurement failed (non-uniform walls) | true |
| `GE_DECOMPOSE_EXTRUDE_FAILED` | Mode 1 extrusion produced invalid geometry | true |
| `GE_DECOMPOSE_CUT_FAILED` | Mode 2 panel cut produced empty or non-manifold result | true |
| `GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED` | Protrusion cutting produced degenerate geometry | true |

---

## Project Files Changed

| File | Change |
|---|---|
| `cpp/src/geometry/geometry_service.hpp` | Update `DecomposedByBendsResult`; add helper declarations |
| `cpp/src/geometry/geometry_service.cc` | Replace `splitBodyByBends` implementation with full algorithm |
| `cpp/src/napi/geometry_binding.cc` | Update `SplitBodyByBends` NAPI: new params + new result fields |
| `ts/src/geometry/binding.ts` | Update `splitBodyByBends` signature (new optional params) |
| `ts/src/mcp/tools.ts` | Update tool definition schema and handler |
| `ts/src/mcp/errors.ts` | Add 4 new error codes |
| `ts/tests/integration/cube_box_workflow.functional.test.ts` | Update mock and add new scenario tests |

---

## Implementation Order

1. **Phase 1** — Mode detection + Mode 2 basic (US1): validates the cutting-plane approach on a
   hollow cube before adding complexity.
2. **Phase 2** — Mode 1 surface extrusion (US2): simpler than Mode 2; layers on the detection logic.
3. **Phase 3** — Protrusion detection + extraction (US3): adds protrusion pass before cutting.
4. **Phase 4** — Recursive decomposition (US4): wraps the single-pass algorithm in a recursion loop.
