#pragma once

/**
 * ManufacturingGraphEvaluator — the pure translation module (rebuild/13-translation-module-design.md).
 *
 * Given a part's authored graph data (one flat outline + a tree of bends), derives
 * every region panel's 2D outline, 3D pose, and thickened-solid point arrays via a
 * single chain-of-transforms walk. This header and its .cc have NO OCCT dependency
 * and NO shared mutable state — deliberately, so this module is fakeable/testable in
 * isolation, in milliseconds, with zero kernel (13 §8's own stated goal).
 *
 * Per constitution v2.0.0 principle IV ("No Geometric Computation in TypeScript"),
 * this is the ONLY place any of these geometric facts are ever derived — TypeScript
 * never re-derives, approximates, or duplicates any part of this computation.
 *
 * Bends are modelled with their REAL bend allowance and bottom-surface radius —
 * `radiusMm=0` is not a special "sharp" code path, it is simply a normal input to
 * the same one formula (constitution principle III/VII: one model, no per-case
 * shortcuts dressed up as the general solution):
 *   - bend allowance (flat-pattern width consumed by the bend zone), the neutral-
 *     fibre arc length: BA = angleRad * (radiusMm + kFactor * thicknessMm).
 *   - bottom-surface radius (13 D3: DXF/regionOf maps to the BOTTOM surface): for a
 *     "mountain" fold (bottom = inner/concave surface) r_b = radiusMm; for a
 *     "valley" fold (bottom = outer/convex surface) r_b = radiusMm + thicknessMm —
 *     never exactly zero for a valley fold, even at radiusMm=0, because the
 *     material's own thickness cannot occupy zero arc length on the outer side of
 *     a fold without self-intersecting. This is what makes "sharp" folds direction-
 *     asymmetric, and is real, not a modelling artifact.
 * Fold direction ("mountain" vs "valley") is read from the sign of `angleDeg`
 * (positive = mountain, matching this module's existing RH-rule convention).
 *
 * regionOf(p) IS implemented as the general half-plane-clip algorithm (not a
 * rectangle special case) — clipping at each bend's own raw hinge line, zero
 * offset (a panel's own touching bends never shrink its measured territory: a
 * panel can be parent to several bends at once, so no single per-panel clip
 * offset could be correct for all of them simultaneously). The bend-allowance
 * material this leaves neither side "owning" is real, and is accounted for by
 * translating each panel's clipped territory by a running 2D shift accumulated
 * down the tree (Evaluate()'s own pose walk: each bend adds its own full
 * allowance, along the hinge's outward normal, to everything in its child's
 * subtree) — never by widening the clip lines themselves. `docs/BUG_REPORT_
 * outline_never_grows_for_bend_allowance.md` has the full derivation of why a
 * clip-line offset can't work once a panel touches more than one bend.
 * That cumulative-shift pass is a purely 2D, flat-pattern-domain fact (it
 * grows regionOuter for DXF/cutting purposes) — it deliberately does NOT
 * feed the 3D pose. bottomFace/topFace/solid-wall construction instead use
 * a panel's RAW (pre-shift) clipped points directly: a coordinate-geometry
 * proof (see ComputeBendGeometry's own comment, and the pose walk below)
 * confirms a wall built from the raw hinge coordinate is automatically,
 * exactly tangent to the bend's cylinder on both the parent's and the
 * child's own side, given the axis position the pose walk already computes
 * — no shift-then-cancel step and no separate "collar"/setback trim are
 * needed anywhere in 3D. Two representations of the same clipped topology,
 * on purpose: regionOuter is the "unrolled, as-cut" view; rawOuter (below)
 * is the "as-designed, mold-line-referenced" view the actual fold rotates.
 */

#include <optional>
#include <string>
#include <vector>

namespace mcp_cad::translation {

// ─── Plain geometric primitives (no OCCT) ───────────────────────────────────

struct Point2 {
  double x = 0.0;
  double y = 0.0;
};

struct Point3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

// A rigid transform: p -> R*p + t. Row-major 3x3 rotation.
struct Transform3 {
  double r[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
  double t[3] = {0, 0, 0};

  static Transform3 Identity();
  static Transform3 Translation(double dx, double dy, double dz);

  // Rotation about the LINE through `axisOrigin` with unit direction `axisDirUnit`,
  // by `angleDeg` degrees, right-hand rule about `axisDirUnit` (13 §10 D1).
  static Transform3 RotationAboutAxis(const Point3& axisOrigin, const Point3& axisDirUnit,
                                       double angleDeg);

  Point3 Apply(const Point3& p) const;
  // Rotates a free vector (direction), ignores translation.
  Point3 ApplyVector(const Point3& v) const;

  // Composition: (A.Compose(B)).Apply(p) == A.Apply(B.Apply(p)) — apply B first, A second.
  Transform3 Compose(const Transform3& inner) const;

  Transform3 Inverse() const;
};

// ─── Input: authored graph data (mirrors rebuild/14-graph-schema.md §2's rows) ──

// An exact circular hole — center + radius, never tessellated into a polygon
// anywhere in this pipeline (Phase 5 Slice 9a): containment against a region
// panel is an exact point-to-line-distance test (ring_containment.hpp), and
// ConstructPartSolid builds a true circular OCCT wire natively. Unlike a
// polygon hole, there is no "canonicalize winding" step needed at the data
// level (only at solid-construction time, choosing which way to wind the
// generated wire).
struct CircleHoleSpec {
  Point2 center;
  double radiusMm = 0.0;
};

// part_ring(kind=outline) + ring_vertex rows. Slice 1: one outer ring, no bulge
// (straight segments only on the outer ring — arcs are a documented future
// extension, K2 smooth_edge). Holes added Phase 5 Slice 9a (rebuild/06-plan.md):
// a hole is a wholly separate, self-contained closed loop (unlike a bulge
// segment spliced into the outer ring's own chain), so it needed no change to
// the outer ring's own representation — polygonHoles/circleHoles are simply
// additive, empty-by-default fields.
struct RingSpec {
  std::vector<Point2> outer;  // CCW, per 13 §3.1's canonicalization convention
  std::vector<std::vector<Point2>> polygonHoles;  // each CW, opposite outer's winding
  std::vector<CircleHoleSpec> circleHoles;        // exact center+radius, never tessellated
};

// One `bend` row (14 §2): hinge CENTRELINE in F (the part's one shared flat
// frame), no placement/offset fields — 14 §0 deletes T_pc entirely, on purpose.
struct BendSpec {
  std::string id;
  std::string parentRegionPanelId;
  std::string childRegionPanelId;
  Point2 hingeA;
  Point2 hingeB;
  double angleDeg = 0.0;  // signed, RH rule about (hingeB - hingeA); sign also
                           // selects fold direction (positive = mountain/bottom-
                           // inner, negative = valley/bottom-outer) — see header.
  double radiusMm = 0.0;   // bend radius, mm; 0 is a normal value, not a special case
  double kFactor = 0.0;    // neutral-fibre position as a fraction of thickness
  // Overrides the angleDeg-sign-derived mountain/valley pivot-side
  // classification below (BottomRadiusMm/pivotZ in the .cc): true = this
  // bend's "bottom" (z=0) reference is the CONCAVE side of THIS fold (the
  // pivot touches it exactly at radiusMm=0 — what "mountain" used to
  // always mean); false = bottom is the CONVEX side (pivot always offset
  // by thicknessMm, never touching — what "valley" used to always mean).
  // These are two INDEPENDENT facts — angleDeg's sign records rotation
  // direction; this records which side of the (single, part-wide) bottom
  // reference is concave at THIS specific crease — and a part's bottom
  // reference is not guaranteed concave at every positive-angle bend and
  // convex at every negative-angle one (confirmed on a real mitered-corner
  // fixture: a bend needed bottom=convex WITH a touching, r=0 pivot, a
  // combination the old sign-only rule could not express — see
  // step_reconciliation.cc, the only writer of this field so far).
  // Unset (nullopt): falls back to the old isMountain=(angleDeg>=0) rule
  // for full backward compatibility with every graph authored before this
  // field existed (Slices 1-4, part_merge.hpp).
  std::optional<bool> bottomIsConcave;
  // true (default): radiusMm is a real, authored/confirmed value — a
  // caller explicitly chose it (create_node, merge_bodies_with_bend,
  // add_flange, or an update_node patch that sets radius_mm directly).
  // false: radiusMm is not a measurement — step_reconciliation.cc sets
  // this for every bend it produces, because a flat-panel decomposition
  // can only ever see two flat faces meeting at a fold, never a real
  // fillet (see step_reconciliation.cc's own header comment). Geometry
  // construction (BottomRadiusMm/BendAllowanceMm below) uses radiusMm
  // exactly the same either way — this field never affects geometry,
  // only how validation/rules/bend_radius.cc interprets the number: a
  // measured/authored radiusMm=0 is a real design choice (MIN_BEND_RADIUS
  // applies normally); an unmeasured radiusMm=0 is reconciliation's own
  // placeholder (see BEND_RADIUS_NOT_MEASURED instead).
  bool radiusMeasured = true;
};

// A bend's two derived geometric facts, both functions of the same effective
// radius `reff = radiusMm + kFactor*thicknessMm` and the same `angleRad` —
// computed together, here, once, so every consumer (the 2D flat-pattern
// shift, any future dimensioning/annotation reader, and this file's own
// tests) reads the same numbers rather than re-deriving pieces of either.
struct BendGeometryMm {
  // Bend allowance: the neutral-fibre arc length the curve consumes —
  // BA = angleRad * reff. Drives ONLY the 2D flat-pattern (regionOuter)
  // growth (Evaluate()'s cumulativeShift pass) — never the 3D pose.
  double allowanceMm = 0.0;
  // Setback: how far the true 3D tangent point sits from the theoretical
  // sharp ("mold line") corner, along each leg — SB = reff * tan(angleRad/2)
  // (verified against the standard sheet-metal-engineering formula). A
  // real, useful, independently-testable quantity — but NOT consumed by
  // the pose walk or solid construction below: given the axis position
  // those already compute (ancestor-shift only), a wall built from a
  // panel's own raw hinge coordinate is automatically exactly tangent to
  // the bend's cylinder, on both sides, with no separate SB-trim needed.
  double setbackMm = 0.0;
};
BendGeometryMm ComputeBendGeometry(double angleDeg, double radiusMm, double kFactor,
                                    double thicknessMm);
BendGeometryMm ComputeBendGeometry(const BendSpec& bend, double thicknessMm);

// part.anchor_* (13 §3.1) — the root 2D->3D placement transform R.
struct RootAnchorSpec {
  Transform3 transform;  // defaults to identity
};

struct PartGraphSpec {
  std::string partId;
  std::string rootRegionPanelId;
  RingSpec outline;
  std::vector<BendSpec> bends;  // Slice 1: caller guarantees a path (chain); the
                                 // evaluator validates general tree-shape (14 §5),
                                 // not chain-specifically.
  double thicknessMm = 0.0;
  RootAnchorSpec anchor;
};

// ─── Output: one Layout row per region panel (13 §3.2/§3.3) ────────────────────

struct RegionPanelLayout {
  std::string regionPanelId;
  std::vector<Point2> regionOuter;  // regionOf(p) — outer ring only, Slice 1
  // The SAME clipped ring as regionOuter, BEFORE the 2D cumulativeShift pass
  // is applied — index-correlated with regionOuter (same clip topology and
  // order, just with/without the shift). This is what bottomFace/topFace
  // below are built from, and what ConstructPartSolid must build panel
  // walls/holes from too (see this file's header comment) — regionOuter
  // stays the flat-pattern/DXF-only view.
  std::vector<Point2> rawOuter;
  // Index-correlated with regionOuter and with each other (13 §3.3's closing
  // paragraph: side-wall quad i is bottomFace[i],bottomFace[i+1],topFace[i+1],topFace[i]).
  // Built from rawOuter (not regionOuter) — see header comment.
  std::vector<Point3> bottomFace;
  std::vector<Point3> topFace;
  Transform3 pose;  // the cached chain product for this panel (13 §4.1)
  // edgeBendId[i] names the bend whose zone the edge (regionOuter[i],
  // regionOuter[i+1]) borders, or "" if the edge is a true outer boundary. Computed
  // once, here, from the exact same boundingBends() query regionOf(p) itself uses —
  // never re-derived by a second, independent query (constitution v2.0.0 principle
  // III). A solid-construction consumer (ConstructPartSolid) MUST build a flat
  // side-wall quad only where this is "" — a non-empty entry means the neighbouring
  // material is real bridge (curved) geometry instead, see EvaluateResult::bridges.
  std::vector<std::string> edgeBendId;
  // Phase 5 Slice 9a: the subset of graph.outline.polygonHoles/circleHoles that
  // belong to THIS region panel — computed once, in RegionOf, via
  // ring_containment.hpp's containment check against this panel's own
  // just-clipped regionOuter (never re-derived independently downstream,
  // matching edgeBendId's own "computed once, here" discipline above).
  std::vector<std::vector<Point2>> regionPolygonHoles;
  std::vector<CircleHoleSpec> regionCircleHoles;
  // Raw (pre-cumulativeShift) counterparts of the two fields above — same
  // relationship as rawOuter to regionOuter, same reason (solid-construction
  // holes must be cut from the raw, tangent-consistent wall, not the
  // flat-pattern-shifted one).
  std::vector<std::vector<Point2>> rawPolygonHoles;
  std::vector<CircleHoleSpec> rawCircleHoles;
};

// One bend's realized bridge geometry (13 §4.3's Z_i, the cylindrical chart) —
// exposed as the pivot axis + angle needed to sweep it, computed once here (the
// same pivot the pose chain itself uses) rather than re-derived by a construction
// consumer. `pivotOriginWorld`/`pivotAxisWorld` are the bottom-surface arc's centre
// line, in world space; sweeping the parent panel's own zone-boundary cross-section
// about this axis by `angleDeg` produces the exact bridge volume (13 §3.3's
// point-array approach and an OCCT native revolve are equivalent for a cylindrical
// chart — ConstructPartSolid uses the latter, since it needs no extra derivation).
struct BridgeLayout {
  std::string bendId;
  std::string parentRegionPanelId;
  std::string childRegionPanelId;
  Point3 pivotOriginWorld;
  Point3 pivotAxisWorld;  // unit direction
  double angleDeg = 0.0;  // same signed value as the source BendSpec
  // The bend's own true 2D position in the flat frame — the CENTER of its
  // real bend-allowance zone, not the raw (start-of-zone) hingeA/hingeB a
  // BendSpec stores (that raw value is a clip-line input to RegionOf, and
  // was never meant to be read back out as "where the bend is" — doing so
  // is exactly the bug docs/BUG_REPORT_outline_never_grows_for_bend_
  // allowance.md describes). Computed once, here, in the pose walk (the
  // exact same hingeAShifted/hingeBShifted/ba/nLeft already computed there
  // for the 3D fold axis) — this is the ONE fact every consumer that wants
  // "this bend's position" (flat-pattern, boundary, full) should read;
  // none of them should ever read a BendSpec's own hingeA/hingeB directly.
  Point2 hingeA;
  Point2 hingeB;
  // The axis now sits `setbackMm` in-plane off the raw hinge (docs/
  // BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md) — the
  // parent's and child's own raw walls are deliberately left untrimmed
  // (RegionOf/BoundingBends stay zero-offset, unchanged, for the
  // flat-pattern/DXF side), so they no longer reach the axis's own tangent
  // points, by exactly `setbackMm` on the parent side and `setbackMm` again
  // on the child side (the same per-bend value both places — see the pose
  // walk's own comment on why). `nLeftWorld`/`childNLeftWorld` are the
  // world-space unit directions a real edge point needs to move along to
  // reach its own tangent point — parentTangent = parentRealEdgePoint +
  // setbackMm*nLeftWorld; childTangent = childRealEdgePoint -
  // setbackMm*childNLeftWorld (subtracted: the child's real edge is
  // FURTHER out than its tangent point, by construction). Deliberately NOT
  // precomputed absolute tangent points here — this bend's own raw
  // hingeA/hingeB use an intentionally exaggerated half-span (so the
  // infinite hinge line visually crosses the whole panel even with a Y
  // offset — MakeStrip's own test-only convention, but RegionOf's real
  // clip authoring can do the same), which does NOT match a real edge's
  // own corner positions — only the panel's own already-clipped
  // bottomFace/topFace points (computed later, from RegionOf) are the real
  // corners a tangent point must be measured relative to.
  double setbackMm = 0.0;
  Point3 nLeftWorld;
  Point3 childNLeftWorld;
};

enum class EvaluateErrorCode {
  kNone,
  kTreeCycleDetected,
  kBendSelfReference,
  kDanglingBendReference,
  kRegionClipFailed,
  kDegenerateOutline,
};

struct EvaluateResult {
  bool ok = false;
  EvaluateErrorCode errorCode = EvaluateErrorCode::kNone;
  std::string message;
  std::vector<RegionPanelLayout> panels;
  std::vector<BridgeLayout> bridges;
};

// The pure translation function. Never throws; all failure is reported via
// EvaluateResult.ok / errorCode (constitution principle VI — typed errors, no raw
// exceptions crossing a module boundary that doesn't need them).
EvaluateResult Evaluate(const PartGraphSpec& graph);

}  // namespace mcp_cad::translation
