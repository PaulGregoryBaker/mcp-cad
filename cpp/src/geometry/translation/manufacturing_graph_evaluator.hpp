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
 * rectangle special case), with each bend now clipping a REAL-WIDTH zone (two
 * offset lines, BA/2 either side of the hinge centreline) rather than a single
 * zero-width line — since Slice 2 (branching) needs the identical primitive either
 * way, there is no simpler "sharp-only" code path to fall back to.
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
  // Index-correlated with regionOuter and with each other (13 §3.3's closing
  // paragraph: side-wall quad i is bottomFace[i],bottomFace[i+1],topFace[i+1],topFace[i]).
  std::vector<Point3> bottomFace;
  std::vector<Point3> topFace;
  // Same as bottomFace/topFace, index-correlated, EXCEPT at a vertex bounding
  // an edge where THIS panel is the PARENT of a bend (edgeBendId names a
  // bend whose parentRegionPanelId is this panel's own id) — there, this is
  // the TRUE tangent-line position (where the parent's flat material
  // actually stops and the curved bend begins) rather than the BA/2-clipped
  // boundary bottomFace/topFace use. Identical to bottomFace/topFace at
  // every true outer edge, at BA=0 (sharp fold — nothing to correct), and at
  // a CHILD-side bend-adjacent edge (already exactly the tangent line via
  // childShift, see Evaluate()'s own comment on that — nothing to correct
  // there either). For a consumer that needs the part's real 3D extent
  // (e.g. graph://part/{id}/boundary) rather than the flat-pattern-facing
  // clip bottomFace/topFace (and the panel's own solid extrusion, and
  // ConstructPartSolid's collar) use — see docs/BUG_REPORT_boundary_
  // resource_disagrees_with_mesh_after_collar_fix.md for why the two
  // diverge and why a second array, not overwriting bottomFace/topFace
  // themselves, is the correct fix.
  std::vector<Point3> bottomFaceTrue;
  std::vector<Point3> topFaceTrue;
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
  // The 2D flat-frame vector (nLeft * BA/2, the same quantity BoundingBends
  // subtracts to produce the PARENT's own clipped region boundary) that maps
  // a point on the parent's clipped zone edge back to the corresponding
  // point on the true tangent line (the raw hinge) — same along-hinge
  // position, just undoing the perpendicular BA/2 clip offset. A
  // construction consumer adds this to each of the parent panel's own
  // zone-boundary edge points (never to the raw BendSpec::hingeA/hingeB
  // endpoints directly, which are deliberately authored longer than the
  // panel they bound and so have no consistent per-vertex correspondence)
  // to find where the parent's flat material actually stops and the curved
  // bend begins. Zero when BA=0 (sharp fold): the clipped boundary already
  // IS the tangent line.
  Point2 parentTangentOffsetLocal;
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
