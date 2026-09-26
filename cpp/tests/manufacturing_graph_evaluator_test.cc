#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"

#include <array>
#include <cmath>
#include <sstream>
#include <unordered_set>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

constexpr double kTestPi = 3.14159265358979323846;

// Same BA formula manufacturing_graph_evaluator.cc uses internally (duplicated here,
// not exposed from the .cc, purely to size the flat outline below — see MakeStrip's
// own comment for why this duplication is necessary, not a re-derivation of a fact
// the evaluator itself computes differently).
double TestBendAllowanceMm(double angleDeg, double radiusMm, double kFactor,
                            double thicknessMm) {
  double angleRad = std::fabs(angleDeg * kTestPi / 180.0);
  return angleRad * (radiusMm + kFactor * thicknessMm);
}

// The panel's own TRUE crease height — the one z-height that is the SAME
// physical point regardless of which bend radius reconstructed it (0 for a
// mountain fold, thicknessMm for a valley fold — see BottomRadiusMm's own
// header comment on why a valley fold's true crease is never at z=0, even
// at radiusMm=0). This used to be radiusMm-dependent (the fold's own pivot
// height, `+/-rBottom`) because that was the one height the OLD, in-plane-
// unmodified axis construction held invariant as radiusMm changed — a fact
// about that specific (buggy) construction, not a physical truth. Now that
// Evaluate() carries a per-bend, radius-dependent in-plane offset AND a
// matching child-side extension
// (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md), EVERY
// z-height is radius-invariant, not just one — so the correct, and
// simplest, choice for a raw flat-corner closure check is the true,
// physical crease line itself. `radiusMm` is intentionally unused now (kept
// so call sites don't all need editing); `angleDeg`'s sign still selects
// fold direction the same way BottomIsConcave's own fallback does.
double TestPivotZOffset(double angleDeg, double /*radiusMm*/, double thicknessMm) {
  bool isMountain = angleDeg < 0.0;  // matches BottomIsConcave's fallback polarity
  return isMountain ? 0.0 : thicknessMm;
}

// Builds an N-segment strip with N-1 bends of `angleDeg` each, real (possibly
// nonzero) bend radius/K-factor — the same shape rebuild/suite/generator/
// closure_family.mjs (C22) generates, hand-authored here for a direct,
// no-suite-driver unit test.
//
// `hingeTiltDeg`/`hingeYOffsetMm` rotate/shift the hinge line away from being
// perfectly perpendicular to and centred on the strip's own length axis — so tests
// can assert the evaluator has no hidden bias toward hinges that are axis-aligned
// within the flat pattern's own 2D frame (distinct from MakeTumbledAnchor's
// world-space root-anchor rotation, below, which stress-tests a different axis).
//
// Authored FLUSH — hinge k (1-indexed) sits at exactly `k*segmentLenMm`, and
// the outline spans exactly `segments*segmentLenMm` — a zero-bend-allowance
// baseline, the same shape a real import's own reconciled (sharp-fold)
// outline has. Evaluate() itself now grows the effective spacing by each
// bend's own real allowance (docs/BUG_REPORT_outline_never_grows_for_bend_
// allowance.md), so this function must NOT also bake a `ba`-sized gap into
// the authored spacing — doing both would double-count it.
//
// `closesLoop` no longer affects the authored outline at all — kept only as
// a call-site documentation flag (an N-gon-prism test reads clearly with
// `/*closesLoop=*/true`). It used to pull the outline's own far edge back by
// one thicknessMm, compensating for the OLD (pre-allowance-fix) model's own
// panel/panel overlap at the closing corner (the sharp-fold topFace overlap
// several other tests in this file document directly) — with panels no
// longer artificially shrunk or overlapping, that compensation is gone too:
// removing it is what makes the closure checks below land on an exact 0mm
// residual again (confirmed empirically after the allowance fix landed —
// every closure test previously passed with the setback, at the OLD,
// now-superseded panel-clipping convention).
PartGraphSpec MakeStrip(int segments, double segmentLenMm, double widthMm,
                        double thicknessMm, double angleDeg, double radiusMm = 0.0,
                        double kFactor = 0.0, double hingeTiltDeg = 0.0,
                        double hingeYOffsetMm = 0.0,
                        Transform3 anchor = Transform3::Identity(),
                        bool closesLoop = false) {
  (void)closesLoop;  // call-site documentation only, see comment above
  PartGraphSpec graph;
  graph.partId = "test-part";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = anchor;

  int bendCount = segments - 1;
  double totalLen = segments * segmentLenMm;

  // The whole flat pattern — outline AND every hinge — is authored in a single
  // tilted (F, W) basis instead of the raw (X, Y) axes: F is the strip's own
  // length axis, W is the hinge/width axis, both rotated together by
  // hingeTiltDeg. F and W are orthonormal (a rigid rotation of the (X,Y) axes),
  // so the outline stays a proper rectangle — just rotated by hingeTiltDeg — not
  // sheared into a parallelogram; an outline built from raw (X,Y) corners with
  // only the hinge tilted would no longer be a strip the hinge cuts sensibly
  // across.
  double tiltRad = hingeTiltDeg * kTestPi / 180.0;
  Point2 F{std::cos(tiltRad), -std::sin(tiltRad)};
  Point2 W{std::sin(tiltRad), std::cos(tiltRad)};
  auto Along = [&](double f, double w) -> Point2 {
    return {f * F.x + w * W.x, f * F.y + w * W.y};
  };

  graph.outline.outer = {Along(0, 0), Along(totalLen, 0), Along(totalLen, widthMm),
                          Along(0, widthMm)};

  // Generous half-span so the (infinite-line) hinge segment still visually crosses
  // the whole strip width even after a Y offset — the clip itself only uses the
  // line's direction/position, never the finite segment length, so this is cosmetic.
  double halfSpan = widthMm / 2.0 + std::fabs(hingeYOffsetMm) + widthMm;

  for (int i = 0; i < bendCount; ++i) {
    double hx = (i + 1) * segmentLenMm;
    Point2 mid = Along(hx, widthMm / 2.0 + hingeYOffsetMm);
    BendSpec bend;
    bend.id = "bend" + std::to_string(i);
    bend.parentRegionPanelId = "seg" + std::to_string(i);
    bend.childRegionPanelId = "seg" + std::to_string(i + 1);
    bend.hingeA = {mid.x + W.x * halfSpan, mid.y + W.y * halfSpan};
    bend.hingeB = {mid.x - W.x * halfSpan, mid.y - W.y * halfSpan};
    bend.angleDeg = angleDeg;
    bend.radiusMm = radiusMm;
    bend.kFactor = kFactor;
    graph.bends.push_back(bend);
  }
  return graph;
}

double Dist(const Point3& a, const Point3& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) +
                    (a.z - b.z) * (a.z - b.z));
}

double Dist2D(const Point2& a, const Point2& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

// Locates a panel's own extremal-x rawOuter vertex at a given y (its own
// near or far edge corner, for an axis-aligned — hingeTiltDeg=0 — MakeStrip
// panel) — read directly from Evaluate()'s own already-computed output
// (which already correctly reflects every bend's own real allowance shift,
// however many rotations deep) rather than an independently hand-derived
// closed-form position. A hand-derived formula for "segLast's far edge"
// would need to replay each ancestor bend's own shift contribution rotated
// by every subsequent fold — exactly the class of second, independently
// hand-derived formula this project's own convention avoids wherever the
// real computation is available to read directly instead (see
// step_reconciliation.hpp's header comment on the same principle).
// rawOuter (not regionOuter) — panel.pose consumes the raw, un-widened
// frame; regionOuter is the flat-pattern/DXF-only, BA-shifted view.
Point2 FindCorner(const RegionPanelLayout& panel, bool wantMaxX, double wantY) {
  Point2 best = panel.rawOuter[0];
  bool found = false;
  for (const auto& v : panel.rawOuter) {
    if (std::fabs(v.y - wantY) > 1e-6) continue;
    if (!found || (wantMaxX ? (v.x > best.x) : (v.x < best.x))) {
      best = v;
      found = true;
    }
  }
  return best;
}

// A fixed (deterministic — not a runtime RNG), non-axis-aligned rotation involving
// all three axes at deliberately unround angles, plus a translation offset. Used to
// catch hidden axis-alignment bias — see MakeTumbledAnchor's twin in
// part_solid_construction_test.cc for the full rationale. This is also a concrete,
// restricted instance of 13 §8's DXF-pose-equivariance property: rotating the whole
// authored frame and compensating only the root anchor R must leave closure intact.
Transform3 MakeTumbledAnchor() {
  Transform3 rx = Transform3::RotationAboutAxis({0, 0, 0}, {1, 0, 0}, 23.0);
  Transform3 ry = Transform3::RotationAboutAxis({0, 0, 0}, {0, 1, 0}, 41.0);
  Transform3 rz = Transform3::RotationAboutAxis({0, 0, 0}, {0, 0, 1}, 67.0);
  Transform3 rotation = rz.Compose(ry.Compose(rx));
  Transform3 translation = Transform3::Translation(1234.5, -678.9, 42.0);
  return translation.Compose(rotation);
}

// Perpendicular distance between two panels' own planes, using panelA's
// bottomFace to derive the plane normal (via two edge vectors) and
// projecting the vector to a panelB corner onto it. Used for the
// opposite-wall/envelope-invariance checks below — a property of where two
// panels' planes actually sit in 3D, independent of whether their edges
// happen to touch anything.
double PlaneDistance(const RegionPanelLayout& panelA, const RegionPanelLayout& panelB) {
  const Point3& a0 = panelA.bottomFace[0];
  const Point3& a1 = panelA.bottomFace[1];
  const Point3& a2 = panelA.bottomFace[2];
  Point3 e01{a1.x - a0.x, a1.y - a0.y, a1.z - a0.z};
  Point3 e12{a2.x - a1.x, a2.y - a1.y, a2.z - a1.z};
  Point3 n{e01.y * e12.z - e01.z * e12.y, e01.z * e12.x - e01.x * e12.z,
           e01.x * e12.y - e01.y * e12.x};
  double len = std::sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
  n = {n.x / len, n.y / len, n.z / len};
  const Point3& b0 = panelB.bottomFace[0];
  Point3 v{b0.x - a0.x, b0.y - a0.y, b0.z - a0.z};
  return std::fabs(v.x * n.x + v.y * n.y + v.z * n.z);
}

// Standard even-odd ray-casting point-in-polygon test (any simple polygon,
// either winding) -- used to numerically check whether a bend's tangent
// point actually lands inside a panel's own real 2D material footprint,
// rather than trusting a distance-from-axis or self-consistency check that
// can't tell "inside" from "outside" (both are equally valid answers to
// "is this the right distance/rotation away").
bool TestPointInPolygon(const Point2& p, const std::vector<Point2>& poly) {
  bool inside = false;
  const size_t n = poly.size();
  for (size_t i = 0, j = n - 1; i < n; j = i++) {
    const Point2& a = poly[i];
    const Point2& b = poly[j];
    const bool crosses = (a.y > p.y) != (b.y > p.y);
    if (crosses) {
      const double xIntersect = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (p.x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

}  // namespace

// ─── C22-equivalent closure family: N-gon prism via N-1 equal bends ──────────

TEST_CASE("GraphEvaluator: N=4 square tube closes exactly, angle up", "[translation][closure]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, 90.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 4);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg3") segLast = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(segLast != nullptr);

  // Check at the panel's own real, raw corner (the actual constructed wall
  // vertex — no fudge/correction term) at the pivot z-height: this is the
  // physical position a manufacturer's real folded part would have at that
  // corner, and it must close to 0mm exactly, the same way a real physical
  // N-gon prism does.
  double z = TestPivotZOffset(90.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 near1 = FindCorner(*seg0, /*wantMaxX=*/false, 50.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point2 far1 = FindCorner(*segLast, /*wantMaxX=*/true, 50.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 start1 = seg0->pose.Apply({near1.x, near1.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  Point3 end1 = segLast->pose.Apply({far1.x, far1.y, z});

  CHECK(Dist(start0, end0) < 1e-6);
  CHECK(Dist(start1, end1) < 1e-6);
}

TEST_CASE("GraphEvaluator: N=4 square tube closes exactly, angle down",
          "[translation][closure]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, -90.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg3") segLast = &p;
  }
  double z = TestPivotZOffset(-90.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  CHECK(Dist(start0, end0) < 1e-6);
}

// docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md's
// testing-strategy item 3: the N-gon closure tests above only ever check
// that the loop meets back up with itself — they never check that it
// closes at the RIGHT SIZE. A defect that grows every corner's reach by
// the same proportion still closes exactly (the whole loop scales
// together), which is exactly why this defect went undetected by every
// closure test in this file despite being present the whole time. This
// test closes the gap: for a square tube (opposite walls seg0/seg2 and
// seg1/seg3), the flat-to-flat distance between opposite walls must be
// IDENTICAL to the radius=0 reference at every other radius — the
// manufacturing method (bend radius) must not change the resulting
// shape's size. KNOWN FAILING until the setback-based fix (see the bug
// report's "Solution approach") lands.
TEST_CASE("GraphEvaluator: N=4 square tube's opposite-wall spacing stays "
          "fixed regardless of bend radius",
          "[translation][closure][envelope]") {
  double kFactor = 0.4, thicknessMm = 2.0;

  auto measure = [&](double radiusMm) -> std::pair<double, double> {
    auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, 90.0, radiusMm, kFactor, 0.0, 0.0,
                           Transform3::Identity(), /*closesLoop=*/true);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.panels.size() == 4);
    const RegionPanelLayout *seg0 = nullptr, *seg1 = nullptr, *seg2 = nullptr, *seg3 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg1") seg1 = &p;
      if (p.regionPanelId == "seg2") seg2 = &p;
      if (p.regionPanelId == "seg3") seg3 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg1 != nullptr);
    REQUIRE(seg2 != nullptr);
    REQUIRE(seg3 != nullptr);
    return {PlaneDistance(*seg0, *seg2), PlaneDistance(*seg1, *seg3)};
  };

  auto [refA, refB] = measure(0.0);
  INFO("radius=0 (reference) seg0-seg2=" << refA << " seg1-seg3=" << refB);
  for (double radiusMm : {0.5, 1.0, 1.5, 3.0}) {
    auto [a, b] = measure(radiusMm);
    INFO("radiusMm=" << radiusMm << " seg0-seg2=" << a << " (reference=" << refA << ") "
                      << "seg1-seg3=" << b << " (reference=" << refB << ")");
    CHECK(a == Approx(refA).margin(1e-6));
    CHECK(b == Approx(refB).margin(1e-6));
  }
}

// TEMP DIAGNOSTIC (docs/BUG_REPORT_complex_panel_bend_surfaces.md
// investigation): the "opposite-wall spacing stays fixed" test above has
// ONLY ever been run with angleDeg=90 (mountain / concave bottom). This
// runs the identical check for angleDeg=-90 (valley / convex bottom) to see
// whether the right-SIZE property (not just closure) also holds for that
// sign combination.
TEST_CASE("DIAGNOSTIC: N=4 square tube's opposite-wall spacing stays fixed "
          "regardless of bend radius -- VALLEY fold (angleDeg=-90)",
          "[translation][closure][envelope][diagnostic]") {
  double kFactor = 0.4, thicknessMm = 2.0;

  auto measure = [&](double radiusMm) -> std::pair<double, double> {
    auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, -90.0, radiusMm, kFactor, 0.0, 0.0,
                           Transform3::Identity(), /*closesLoop=*/true);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.panels.size() == 4);
    const RegionPanelLayout *seg0 = nullptr, *seg1 = nullptr, *seg2 = nullptr, *seg3 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg1") seg1 = &p;
      if (p.regionPanelId == "seg2") seg2 = &p;
      if (p.regionPanelId == "seg3") seg3 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg1 != nullptr);
    REQUIRE(seg2 != nullptr);
    REQUIRE(seg3 != nullptr);
    return {PlaneDistance(*seg0, *seg2), PlaneDistance(*seg1, *seg3)};
  };

  auto [refA, refB] = measure(0.0);
  INFO("radius=0 (reference) seg0-seg2=" << refA << " seg1-seg3=" << refB);
  for (double radiusMm : {0.5, 1.0, 1.5, 3.0}) {
    auto [a, b] = measure(radiusMm);
    INFO("radiusMm=" << radiusMm << " seg0-seg2=" << a << " (reference=" << refA << ") "
                      << "seg1-seg3=" << b << " (reference=" << refB << ")");
    WARN("VALLEY radiusMm=" << radiusMm << " a=" << a << " b=" << b << " refA=" << refA
         << " refB=" << refB << " diffA=" << (a - refA) << " diffB=" << (b - refB));
    CHECK(a == Approx(refA).margin(1e-6));
    CHECK(b == Approx(refB).margin(1e-6));
  }
}

// axisInPlaneOffset's formula (manufacturing_graph_evaluator.cc) is
// D*tan(angleRad/2) with D = bottomIsConcave ? +radiusMm : -radiusMm and
// angleRad using angleDeg's own signed value — never a magnitude-only
// |angleDeg| shortcut. Every closure/envelope test elsewhere in this file
// leaves bottomIsConcave unset, so bottomIsConcave and angleDeg's sign are
// always aligned via the angleDeg>=0 fallback — none of them can catch a
// regression to the |angleDeg| shortcut, since D and angleRad's signs
// cancel identically either way in the aligned case. This test explicitly
// sets bottomIsConcave OPPOSITE to what the fallback would choose for a
// negative angleDeg (concave=true at angleDeg=-90, where the fallback would
// say convex) — a mismatched pair the |angleDeg| shortcut gets backwards
// but the signed formula still gets right. If envelope preservation still
// holds here, the code is reading bottomIsConcave itself, not re-deriving
// it from angleDeg's sign.
TEST_CASE("GraphEvaluator: N=4 square tube's opposite-wall spacing stays fixed "
          "regardless of bend radius -- bottomIsConcave explicitly set OPPOSITE "
          "to the angleDeg-sign fallback",
          "[translation][closure][envelope]") {
  double kFactor = 0.4, thicknessMm = 2.0;

  auto measure = [&](double radiusMm) -> std::pair<double, double> {
    auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, -90.0, radiusMm, kFactor, 0.0, 0.0,
                           Transform3::Identity(), /*closesLoop=*/true);
    for (auto& bend : graph.bends) {
      bend.bottomIsConcave = true;  // fallback (angleDeg=-90 < 0) would say false
    }
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.panels.size() == 4);
    const RegionPanelLayout *seg0 = nullptr, *seg1 = nullptr, *seg2 = nullptr, *seg3 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg1") seg1 = &p;
      if (p.regionPanelId == "seg2") seg2 = &p;
      if (p.regionPanelId == "seg3") seg3 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg1 != nullptr);
    REQUIRE(seg2 != nullptr);
    REQUIRE(seg3 != nullptr);
    return {PlaneDistance(*seg0, *seg2), PlaneDistance(*seg1, *seg3)};
  };

  auto [refA, refB] = measure(0.0);
  INFO("radius=0 (reference) seg0-seg2=" << refA << " seg1-seg3=" << refB);
  for (double radiusMm : {0.5, 1.0, 1.5, 3.0}) {
    auto [a, b] = measure(radiusMm);
    INFO("radiusMm=" << radiusMm << " seg0-seg2=" << a << " (reference=" << refA << ") "
                      << "seg1-seg3=" << b << " (reference=" << refB << ")");
    CHECK(a == Approx(refA).margin(1e-6));
    CHECK(b == Approx(refB).margin(1e-6));
  }
}

// The N-gon closure tests above all use a REGULAR loop — every bend
// identical (same angle, radius, kFactor, thickness) — which is exactly
// what makes closure survive this bug: each bend's own reach distortion
// acts as a scalar multiplying that bend's own step vector, and if the
// scalar is the SAME for every step (guaranteed only when every bend is
// identical), the closed-loop vector sum v1+v2+...+vN=0 becomes
// k*(v1+...+vN) = k*0 = 0 regardless of k — the loop still closes, just at
// the wrong size. A real part's bends are not generally identical to each
// other (different radii is a completely ordinary thing to specify). This
// test breaks that special-case symmetry on purpose: same 4-panel loop as
// the N=4 tests above, but with ONE of the three bends given a different
// radius than the other two.
//
// The assertion is that the loop DOES close (gap < 1e-6, the same
// tolerance every other closure test in this file uses) — because a real,
// correctly manufactured part closes regardless of which bend radius was
// used at which corner; the outer shape is the source of truth (see the
// bug report's "Statement of the requirement"). Once each bend's own
// reach is made radius-invariant (the agreed fix), every individual
// bend's contribution to the loop returns to its own r=0 value regardless
// of that bend's own radius, so the total sum returns to its r=0 (closed)
// value too — for ANY mix of radii, not just uniform ones. KNOWN FAILING
// under the current code: mixing radii breaks the uniform-scaling
// cancellation that (coincidentally) keeps the regular-loop tests above
// passing, exposing the same defect as an outright non-closure here
// instead of just a size discrepancy.
TEST_CASE("GraphEvaluator: N=4 loop with non-uniform bend radii still closes "
          "exactly (breaks the uniform-scaling symmetry that hides the "
          "envelope bug in the regular-loop closure tests)",
          "[translation][closure][envelope]") {
  double kFactor = 0.4, thicknessMm = 2.0;
  auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, 90.0, /*radiusMm=*/1.5, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  REQUIRE(graph.bends.size() == 3);
  // bend0 and bend2 keep the base radius; bend1 alone gets a different one.
  graph.bends[1].radiusMm = 3.5;

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 4);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg3") segLast = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(segLast != nullptr);

  // bend2 (the closing corner's own parent-side bend) still uses the base
  // radius, so its own pivot height is the same reference the other
  // regular-loop tests use.
  double z = TestPivotZOffset(90.0, 1.5, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  double gap = Dist(start0, end0);
  INFO("gap between seg0's own corner and segLast's far corner = " << gap << "mm "
       << "(a real, correctly manufactured part closes regardless of which radius "
       << "was used at which corner)");
  CHECK(gap < 1e-6);
}

TEST_CASE("GraphEvaluator: N=5 pentagon tube closes exactly, angle up",
          "[translation][closure]") {
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  auto graph = MakeStrip(5, 80.0, 40.0, thicknessMm, 72.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 5);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg4") segLast = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(segLast != nullptr);

  double z = TestPivotZOffset(72.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 near1 = FindCorner(*seg0, /*wantMaxX=*/false, 40.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point2 far1 = FindCorner(*segLast, /*wantMaxX=*/true, 40.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 start1 = seg0->pose.Apply({near1.x, near1.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  Point3 end1 = segLast->pose.Apply({far1.x, far1.y, z});

  CHECK(Dist(start0, end0) < 1e-6);
  CHECK(Dist(start1, end1) < 1e-6);
}

TEST_CASE("GraphEvaluator: N=5 pentagon tube closes exactly, angle down",
          "[translation][closure]") {
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  auto graph = MakeStrip(5, 80.0, 40.0, thicknessMm, -72.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg4") segLast = &p;
  }
  double z = TestPivotZOffset(-72.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  CHECK(Dist(start0, end0) < 1e-6);
}

TEST_CASE("GraphEvaluator: N=6 hexagon tube closes exactly, angle up",
          "[translation][closure]") {
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  auto graph = MakeStrip(6, 70.0, 40.0, thicknessMm, 60.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 6);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg5") segLast = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(segLast != nullptr);

  double z = TestPivotZOffset(60.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 near1 = FindCorner(*seg0, /*wantMaxX=*/false, 40.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point2 far1 = FindCorner(*segLast, /*wantMaxX=*/true, 40.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 start1 = seg0->pose.Apply({near1.x, near1.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  Point3 end1 = segLast->pose.Apply({far1.x, far1.y, z});

  CHECK(Dist(start0, end0) < 1e-6);
  CHECK(Dist(start1, end1) < 1e-6);
}

TEST_CASE("GraphEvaluator: N=6 hexagon tube closes exactly, angle down",
          "[translation][closure]") {
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  auto graph = MakeStrip(6, 70.0, 40.0, thicknessMm, -60.0, radiusMm, kFactor, 0.0, 0.0,
                         Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* segLast = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg5") segLast = &p;
  }
  double z = TestPivotZOffset(-60.0, radiusMm, thicknessMm);
  Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
  Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
  Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
  Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
  CHECK(Dist(start0, end0) < 1e-6);
}

// Second even-N confirmation of the same envelope defect, independent of
// N=4's own scale/thickness/kFactor choices (see the N=4 companion test's
// own comment for the full rationale). seg0/seg3 are the hexagon's own
// opposite-wall pair.
TEST_CASE("GraphEvaluator: N=6 hexagon's opposite-wall spacing stays fixed "
          "regardless of bend radius",
          "[translation][closure][envelope]") {
  double kFactor = 0.33, thicknessMm = 1.6;

  auto measure = [&](double radiusMm) -> double {
    auto graph = MakeStrip(6, 70.0, 40.0, thicknessMm, 60.0, radiusMm, kFactor, 0.0, 0.0,
                           Transform3::Identity(), /*closesLoop=*/true);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.panels.size() == 6);
    const RegionPanelLayout *seg0 = nullptr, *seg3 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg3") seg3 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg3 != nullptr);
    return PlaneDistance(*seg0, *seg3);
  };

  double ref = measure(0.0);
  INFO("radius=0 (reference) seg0-seg3=" << ref);
  for (double radiusMm : {0.5, 1.0, 1.5, 2.5}) {
    double d = measure(radiusMm);
    INFO("radiusMm=" << radiusMm << " seg0-seg3=" << d << " (reference=" << ref << ")");
    CHECK(d == Approx(ref).margin(1e-6));
  }
}

TEST_CASE("GraphEvaluator: N=3..9 triangle-through-nonagon prisms all close",
          "[translation][closure]") {
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  for (int n = 3; n <= 9; ++n) {
    double angle = 360.0 / n;
    auto graph = MakeStrip(n, 80.0, 40.0, thicknessMm, angle, radiusMm, kFactor, 0.0, 0.0,
                           Transform3::Identity(), /*closesLoop=*/true);
    EvaluateResult result = Evaluate(graph);
    INFO("N=" << n);
    REQUIRE(result.ok);
    REQUIRE(result.panels.size() == static_cast<size_t>(n));

    const RegionPanelLayout* seg0 = nullptr;
    const RegionPanelLayout* segLast = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg" + std::to_string(n - 1)) segLast = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(segLast != nullptr);
    double z = TestPivotZOffset(angle, radiusMm, thicknessMm);
    Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
    Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
    Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
    Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
    CHECK(Dist(start0, end0) < 1e-6);
  }
}

// ─── C22 suite (rebuild/suite) cross-check: sharp (r=0) folds, both mountain ──
// ─── and valley angle sign, self-consistency AND independent zero-reference ──
//
// rebuild/suite/generator/closure_family.mjs computes its own "endCorners"
// oracle from a PURE zero-thickness idealization (E_k = V_k + (N-k)L*d_k, no
// radius/thickness term at all — its own comment calls this a "zero-reference
// oracle"). That independent formula can only exactly equal this evaluator's
// real output when TestPivotZOffset is itself exactly zero — true for a
// MOUNTAIN fold at r=0 (pivot = -radiusMm = 0) but NOT for a VALLEY fold at
// r=0 (pivot = +(radiusMm+thicknessMm) = +thicknessMm, nonzero even at r=0 —
// a real physical consequence of this evaluator's material-thickness model,
// not a bug: see TestPivotZOffset's own comment). This test proves that
// split directly at the Evaluate() layer (no NAPI/TS involved) so a v2 suite
// driver reproducing these JSON cases through the MCP layer knows in advance
// which construction to use, instead of discovering a false "TS-layer bug"
// from a mismatch that is actually just this formula-domain gap.
//
// Mountain is angleDeg<0 (bottomIsConcave's fallback polarity — see that
// function's own comment), NOT angleDeg>=0 as an earlier version of this
// test assumed.
TEST_CASE("GraphEvaluator: sharp (r=0) N=3 closure - mountain matches the "
 "suite's independent zero-reference formula exactly; valley does "
 "NOT (real thickness-scale pivot offset), though both self-close",
          "[translation][closure][investigation]") {
  const double L = 60.0, widthMm = 40.0, thicknessMm = 1.0;
  const double bendDeg = 120.0;  // 360/3

  // closure_family.mjs's own checkpoint formula (independent re-derivation,
  // dirSign matches whichever angleDeg sign is actually under test in each
  // SECTION below; the JSON suite's "down" cases instead mirror the whole
  // construction via a world anchor rather than negating angleDeg — see this
  // TEST_CASE's own banner comment and the companion "up"/"down" anchor-
  // mirror test below).
  auto zeroReferenceCheckpoint1 = [&](double dirSign) -> Point3 {
    double theta = 2.0 * kTestPi / 3.0;
    double vx = L, vz = 0.0;  // V_1 = L * d(0) = L*(1,0,0)
    double dkx = std::cos(theta), dkz = dirSign * std::sin(theta);
    return {vx + 2.0 * L * dkx, 0.0, vz + 2.0 * L * dkz};
  };

  SECTION("mountain (angleDeg=-bendDeg): exact match to the zero-reference formula") {
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, -bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, Transform3::Identity(),
                           /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = TestPivotZOffset(-bendDeg, 0.0, thicknessMm);
    CHECK(z == Approx(0.0).margin(1e-12));  // mountain at r=0: pivot sits exactly on bottomFace
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(-1.0);
    CHECK(Dist(got, expected) < 1e-6);
  }

  SECTION("valley (angleDeg=+bendDeg): self-consistent closure, but a real "
          "thicknessMm-scale gap from the zero-reference formula") {
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, Transform3::Identity(),
                           /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = TestPivotZOffset(bendDeg, 0.0, thicknessMm);
    CHECK(z == Approx(thicknessMm).margin(1e-12));  // valley at r=0: pivot is thicknessMm off bottomFace
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(+1.0);
    // Real, expected gap — NOT a bug: documents exactly why a suite driver
    // must author "sharp" strips as mountain folds (with a mirrored world
    // anchor for the opposite direction) rather than negating angleDeg.
    CHECK(Dist(got, expected) > 0.5);
    CHECK(Dist(got, expected) == Approx(thicknessMm).margin(1e-6));
  }

  SECTION("mountain + 180deg-about-X anchor reproduces the mirrored ('down') "
          "zero-reference checkpoint exactly, still as a pure mountain fold "
          "(NOT 180-about-Y: that negates X and Z together, which N=3's own "
          "single checkpoint can't distinguish from the correct X-preserving "
          "mirror since its X component happens to be exactly zero — see the "
          "N=4 section below, where a nonzero X finally tells them apart)") {
    Transform3 mirror = Transform3::RotationAboutAxis({0, 0, 0}, {1, 0, 0}, 180.0);
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, -bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, mirror, /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = TestPivotZOffset(-bendDeg, 0.0, thicknessMm);
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(+1.0);  // the suite's "down" checkpoint
    CHECK(Dist(got, expected) < 1e-6);
  }

  SECTION("N=4 confirms 180deg-about-X (not -Y) is the correct mirror once X "
          "is nonzero at a checkpoint") {
    const double L4 = 60.0, w4 = 40.0, t4 = 1.0, bend4 = -90.0;  // 360/4, mountain
    Transform3 mirrorX = Transform3::RotationAboutAxis({0, 0, 0}, {1, 0, 0}, 180.0);
    auto graph = MakeStrip(4, L4, w4, t4, bend4, /*radiusMm=*/0.0, /*kFactor=*/0.0,
                           0.0, 0.0, mirrorX, /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);

    auto theta4 = 2.0 * kTestPi / 4.0;
    auto d4 = [&](int j, double dirSign) -> std::array<double, 2> {
      return {std::cos(j * theta4), dirSign * std::sin(j * theta4)};
    };
    double z = TestPivotZOffset(bend4, 0.0, t4);  // mountain (bend4<0): pivot at bottomFace
    // The width-side query must use LOCAL y=-widthMm: mirrorX negates the
    // flat pattern's own Y axis too, so +widthMm in local space lands at
    // world y=-widthMm — querying the negated local Y compensates exactly
    // (this is the ts/v2 suite driver's widthSign convention, mirrored here).
    for (int k = 1; k <= 3; ++k) {
      const RegionPanelLayout* seg = nullptr;
      for (auto& p : result.panels) if (p.regionPanelId == "seg" + std::to_string(k)) seg = &p;
      REQUIRE(seg != nullptr);

      double vx = 0.0, vz = 0.0;
      for (int j = 0; j < k; ++j) {
        auto dPrev = d4(j, 1.0);
        vx += L4 * dPrev[0];
        vz += L4 * dPrev[1];
      }
      auto dk = d4(k, 1.0);
      double ex = vx + (4 - k) * L4 * dk[0];
      double ez = vz + (4 - k) * L4 * dk[1];

      Point3 got0 = seg->pose.Apply({4.0 * L4, 0.0, z});
      Point3 got1 = seg->pose.Apply({4.0 * L4, -w4, z});
      INFO("k=" << k);
      CHECK(got0.x == Approx(ex).margin(1e-6));
      CHECK(got0.y == Approx(0.0).margin(1e-6));
      CHECK(got0.z == Approx(ez).margin(1e-6));
      CHECK(got1.x == Approx(ex).margin(1e-6));
      CHECK(got1.y == Approx(w4).margin(1e-6));
      CHECK(got1.z == Approx(ez).margin(1e-6));
    }
  }
}

TEST_CASE("GraphEvaluator: N=3..9 prisms still close under an arbitrary "
          "non-axis-aligned root anchor (no hidden axis bias)",
          "[translation][closure]") {
  Transform3 tumbled = MakeTumbledAnchor();
  double radiusMm = 1.0, kFactor = 0.33, thicknessMm = 1.6;
  for (int n = 3; n <= 9; ++n) {
    double angle = 360.0 / n;
    auto graph = MakeStrip(n, 80.0, 40.0, thicknessMm, angle, radiusMm, kFactor, 0.0, 0.0, tumbled,
                           /*closesLoop=*/true);
    EvaluateResult result = Evaluate(graph);
    INFO("N=" << n);
    REQUIRE(result.ok);

    const RegionPanelLayout* seg0 = nullptr;
    const RegionPanelLayout* segLast = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg" + std::to_string(n - 1)) segLast = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(segLast != nullptr);
    double z = TestPivotZOffset(angle, radiusMm, thicknessMm);
    Point2 near0 = FindCorner(*seg0, /*wantMaxX=*/false, 0.0);
    Point2 far0 = FindCorner(*segLast, /*wantMaxX=*/true, 0.0);
    Point3 start0 = seg0->pose.Apply({near0.x, near0.y, z});
    Point3 end0 = segLast->pose.Apply({far0.x, far0.y, z});
    // Same 1e-6mm closure tolerance as the identity-anchor sweep above — closure
    // is a property of the fold chain alone and must not degrade just because the
    // whole part sits at an arbitrary, non-axis-aligned orientation in world space.
    CHECK(Dist(start0, end0) < 1e-6);
  }
}

// ─── far outer corner position for a fixed nominal leg length does NOT ─────
// ─── vary with bend radius — this used to be pinned as expected drift ──────
//
// A previous session concluded the drift asserted below was real, expected
// geometry — reasoning that pivotZ is real (radius-scale), so the rotated
// image of the near edge must move by a radius-scale amount as R varies,
// and the panel's far edge, rigidly attached to it, moves with it. That
// reasoning is incomplete: it only accounts for the axis's HEIGHT. It does
// not hold once the axis also carries its own in-plane offset and a
// matching child-side extension
// (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md) — with
// both in place, this far corner is provably radius-invariant (verified
// exactly, both fold directions, five bend angles, chained multiple bends
// deep, in the bug report above). The "far corner must drift because a real
// fillet occupies space a sharp corner doesn't" intuition conflates two
// different things: the fillet's own curved material really does occupy
// different space at different radii, but the FLAT leg beyond it does not
// have to — its own reach is exactly what the per-bend setback and
// extension correct for. This test used to pin the drift as correct; it now
// pins its absence.
TEST_CASE("GraphEvaluator: far outer corner position for a fixed nominal leg "
          "length stays fixed regardless of bend radius",
          "[translation][envelope]") {
  double L = 100.0, widthMm = 50.0, thicknessMm = 2.0, kFactor = 0.4;

  std::vector<double> radii = {0.0, 1.0, 2.0, 5.0, 10.0};
  std::vector<Point3> farTopCorners;

  for (double radiusMm : radii) {
    auto graph = MakeStrip(2, L, widthMm, thicknessMm, 90.0, radiusMm, kFactor);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);

    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg1") seg1 = &p;
    }
    REQUIRE(seg1 != nullptr);

    double totalLen = graph.outline.outer[1].x;
    // Far outer (top, local z=thicknessMm) corner of seg1, at the outline's own
    // raw far edge — the panel's genuinely free end, not a bend-zone boundary.
    Point3 farTop = seg1->pose.Apply({totalLen, 0.0, thicknessMm});
    INFO("radiusMm=" << radiusMm << " farTop=(" << farTop.x << ", " << farTop.y << ", "
                      << farTop.z << ")");
    farTopCorners.push_back(farTop);
  }

  // The far corner must NOT move as R varies (see this TEST_CASE's own
  // banner comment) — the whole point of the setback/extension fix.
  double driftFromR0 = Dist(farTopCorners.back(), farTopCorners.front());
  INFO("total drift from radiusMm=0 to radiusMm=" << radii.back() << ": " << driftFromR0
                                                    << "mm");
  CHECK(driftFromR0 < 1e-6);
}

// ─── bottomFace/topFace: exact thickness offset, index-correlated ───────────

TEST_CASE("GraphEvaluator: bottomFace/topFace are exact thickness apart and index-correlated",
          "[translation]") {
  auto graph = MakeStrip(3, 100.0, 50.0, 3.5, 90.0);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  for (const auto& panel : result.panels) {
    REQUIRE(panel.bottomFace.size() == panel.topFace.size());
    REQUIRE(panel.bottomFace.size() == panel.regionOuter.size());
    for (size_t i = 0; i < panel.bottomFace.size(); ++i) {
      double d = Dist(panel.bottomFace[i], panel.topFace[i]);
      CHECK(d == Approx(3.5).margin(1e-9));
    }
  }
}

// ─── regionOf: correct subdivision, order-independent clipping ─────────────

TEST_CASE("GraphEvaluator: regionOf subdivides the outline into equal segments",
          "[translation][region]") {
  double thicknessMm = 2.0;
  auto graph = MakeStrip(4, 100.0, 50.0, thicknessMm, 90.0);  // closesLoop=false (default):
                                                                // no setback at all, every
                                                                // panel is a full segmentLenMm
                                                                // x widthMm rectangle.
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  double expectedArea = 100.0 * 50.0;
  for (const auto& panel : result.panels) {
    const auto& r = panel.regionOuter;
    REQUIRE(r.size() == 4);
    double area = 0.0;
    for (size_t i = 0; i < r.size(); ++i) {
      const auto& a = r[i];
      const auto& b = r[(i + 1) % r.size()];
      area += a.x * b.y - b.x * a.y;
    }
    area = std::fabs(area) / 2.0;
    CHECK(area == Approx(expectedArea).margin(1e-6));
  }
}

TEST_CASE("GraphEvaluator: a hole is assigned only to the region panel that contains it",
          "[translation][region][holes]") {
  // A 2-segment strip: seg0 spans roughly F in [0,100], seg1 roughly [100,200]
  // (bend near F=100, zero radius/k-factor -> negligible bend allowance).
  auto graph = MakeStrip(2, 100.0, 50.0, /*thicknessMm=*/1.0, 90.0);

  // A circle well within seg0's own territory, far from the hinge.
  graph.outline.circleHoles.push_back({/*center=*/{20.0, 25.0}, /*radiusMm=*/5.0});
  // A polygon hole well within seg1's own territory.
  graph.outline.polygonHoles.push_back(
      {{150.0, 10.0}, {160.0, 10.0}, {160.0, 20.0}, {150.0, 20.0}});

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  CHECK(seg0->regionCircleHoles.size() == 1);
  CHECK(seg0->regionPolygonHoles.empty());
  CHECK(seg1->regionCircleHoles.empty());
  CHECK(seg1->regionPolygonHoles.size() == 1);
}

TEST_CASE("GraphEvaluator: boundingBends clip order does not affect the result",
          "[translation][region]") {
  // A middle segment of a longer chain has two touching bends (one as child, one as
  // parent) — applied in either order, the clipped region must be identical, since
  // half-plane intersection is commutative (14 §2.1's boundingBends formula is
  // explicitly order-independent by construction).
  auto graphForward = MakeStrip(5, 60.0, 30.0, 1.0, 72.0);
  auto graphReversed = graphForward;
  std::reverse(graphReversed.bends.begin(), graphReversed.bends.end());

  EvaluateResult resultForward = Evaluate(graphForward);
  EvaluateResult resultReversed = Evaluate(graphReversed);
  REQUIRE(resultForward.ok);
  REQUIRE(resultReversed.ok);

  auto findPanel = [](const EvaluateResult& r, const std::string& id) {
    for (auto& p : r.panels) {
      if (p.regionPanelId == id) return &p;
    }
    return static_cast<const RegionPanelLayout*>(nullptr);
  };

  const auto* mid1 = findPanel(resultForward, "seg2");
  const auto* mid2 = findPanel(resultReversed, "seg2");
  REQUIRE(mid1 != nullptr);
  REQUIRE(mid2 != nullptr);
  REQUIRE(mid1->regionOuter.size() == mid2->regionOuter.size());
  for (size_t i = 0; i < mid1->regionOuter.size(); ++i) {
    CHECK(mid1->regionOuter[i].x == Approx(mid2->regionOuter[i].x).margin(1e-9));
    CHECK(mid1->regionOuter[i].y == Approx(mid2->regionOuter[i].y).margin(1e-9));
  }
}

// ─── Chain composition matches the definitional (unrolled) form ────────────

TEST_CASE("GraphEvaluator: single-panel part (no bends) has identity-derived pose",
          "[translation]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;
  graph.anchor.transform = Transform3::Identity();

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 1);
  const auto& panel = result.panels[0];
  REQUIRE(panel.regionOuter.size() == 4);
  CHECK(panel.regionOuter[0].x == Approx(0.0));
  CHECK(panel.regionOuter[2].x == Approx(100.0));
  CHECK(panel.regionOuter[2].y == Approx(60.0));
  // Identity anchor => bottomFace is the outline embedded at z=0 unchanged.
  CHECK(panel.bottomFace[1].x == Approx(100.0));
  CHECK(panel.bottomFace[1].z == Approx(0.0));
  CHECK(panel.topFace[1].z == Approx(2.0));
}

TEST_CASE("GraphEvaluator: root anchor transform is applied to every panel",
          "[translation]") {
  auto graph = MakeStrip(2, 100.0, 50.0, 2.0, 90.0);
  graph.anchor.transform = Transform3::Translation(1000.0, 2000.0, 3000.0);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  const RegionPanelLayout* seg0 = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
  }
  REQUIRE(seg0 != nullptr);
  Point3 origin = seg0->pose.Apply({0, 0, 0});
  CHECK(origin.x == Approx(1000.0));
  CHECK(origin.y == Approx(2000.0));
  CHECK(origin.z == Approx(3000.0));
}

// ─── Error handling: typed errors, never a crash/exception ─────────────────

TEST_CASE("GraphEvaluator: degenerate outline (<3 vertices) reports a typed error",
          "[translation][errors]") {
  PartGraphSpec graph;
  graph.partId = "bad";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {10, 0}};
  graph.thicknessMm = 1.0;

  EvaluateResult result = Evaluate(graph);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == EvaluateErrorCode::kDegenerateOutline);
}

TEST_CASE("GraphEvaluator: bend self-reference reports a typed error", "[translation][errors]") {
  PartGraphSpec graph;
  graph.partId = "bad";
  graph.rootRegionPanelId = "seg0";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 50}, {0, 50}};
  graph.thicknessMm = 1.0;
  BendSpec bend;
  bend.id = "b0";
  bend.parentRegionPanelId = "seg0";
  bend.childRegionPanelId = "seg0";  // self-reference
  bend.hingeA = {50, 0};
  bend.hingeB = {50, 50};
  bend.angleDeg = 90;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == EvaluateErrorCode::kBendSelfReference);
}

TEST_CASE("GraphEvaluator: duplicate incoming bends on one region panel is rejected",
          "[translation][errors]") {
  PartGraphSpec graph;
  graph.partId = "bad";
  graph.rootRegionPanelId = "seg0";
  graph.outline.outer = {{0, 0}, {300, 0}, {300, 50}, {0, 50}};
  graph.thicknessMm = 1.0;
  BendSpec b0;
  b0.id = "b0";
  b0.parentRegionPanelId = "seg0";
  b0.childRegionPanelId = "seg1";
  b0.hingeA = {100, 50};
  b0.hingeB = {100, 0};
  b0.angleDeg = 90;
  BendSpec b1 = b0;
  b1.id = "b1";
  b1.hingeA = {200, 50};
  b1.hingeB = {200, 0};
  // b1 ALSO claims seg1 as its child — invalid, seg1 would have 2 incoming bends.
  graph.bends = {b0, b1};

  EvaluateResult result = Evaluate(graph);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == EvaluateErrorCode::kTreeCycleDetected);
}

TEST_CASE("GraphEvaluator: a bend not reachable from the root is rejected, not silently skipped",
          "[translation][errors]") {
  PartGraphSpec graph;
  graph.partId = "bad";
  graph.rootRegionPanelId = "seg0";
  graph.outline.outer = {{0, 0}, {300, 0}, {300, 50}, {0, 50}};
  graph.thicknessMm = 1.0;
  BendSpec b0;
  b0.id = "b0";
  b0.parentRegionPanelId = "seg0";
  b0.childRegionPanelId = "seg1";
  b0.hingeA = {100, 50};
  b0.hingeB = {100, 0};
  b0.angleDeg = 90;
  BendSpec orphan = b0;
  orphan.id = "orphan";
  orphan.parentRegionPanelId = "detached";  // no bend leads to "detached"
  orphan.childRegionPanelId = "seg2";
  orphan.hingeA = {200, 50};
  orphan.hingeB = {200, 0};
  graph.bends = {b0, orphan};

  EvaluateResult result = Evaluate(graph);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == EvaluateErrorCode::kDanglingBendReference);
}

// RerootAt must not move any panel: re-rooting a chain at its far end, with
// the new root anchored at its own original pose, reproduces every panel's
// pose and 3D bottom face exactly.
TEST_CASE("RerootAt: every panel keeps its world pose and 3D faces", "[translation][reroot]") {
  for (double radius : {0.0, 2.0}) {
    CAPTURE(radius);
    PartGraphSpec graph;
    graph.partId = "chain";
    graph.rootRegionPanelId = "seg0";
    graph.outline.outer = {{0, 0}, {300, 0}, {300, 50}, {0, 50}};
    graph.thicknessMm = 1.0;
    graph.anchor.transform = Transform3::Translation(7, -3, 11);
    BendSpec b0;
    b0.id = "b0";
    b0.parentRegionPanelId = "seg0";
    b0.childRegionPanelId = "seg1";
    b0.hingeA = {100, 50};
    b0.hingeB = {100, 0};
    b0.angleDeg = 90;
    b0.radiusMm = radius;
    b0.kFactor = 0.44;
    BendSpec b1 = b0;
    b1.id = "b1";
    b1.parentRegionPanelId = "seg1";
    b1.childRegionPanelId = "seg2";
    b1.hingeA = {200, 50};
    b1.hingeB = {200, 0};
    b1.angleDeg = -60;
    graph.bends = {b0, b1};

    EvaluateResult before = Evaluate(graph);
    REQUIRE(before.ok);

    RerootResult reroot = RerootAt(graph.bends, "seg0", "seg2");
    REQUIRE(reroot.ok);
    PartGraphSpec rerooted = graph;
    rerooted.bends = reroot.bends;
    rerooted.rootRegionPanelId = "seg2";
    for (const auto& p : before.panels) {
      if (p.regionPanelId == "seg2") rerooted.anchor.transform = p.pose;
    }
    EvaluateResult after = Evaluate(rerooted);
    REQUIRE(after.ok);
    REQUIRE(after.panels.size() == before.panels.size());

    for (const auto& pb : before.panels) {
      CAPTURE(pb.regionPanelId);
      const RegionPanelLayout* pa = nullptr;
      for (const auto& p : after.panels) {
        if (p.regionPanelId == pb.regionPanelId) pa = &p;
      }
      REQUIRE(pa != nullptr);
      for (int i = 0; i < 9; ++i) CHECK(pa->pose.r[i] == Approx(pb.pose.r[i]).margin(1e-9));
      for (int i = 0; i < 3; ++i) CHECK(pa->pose.t[i] == Approx(pb.pose.t[i]).margin(1e-9));
      // Same ring, same winding; a panel between two bends may start its
      // ring at a different vertex once its incoming bend changes.
      const size_t n = pb.bottomFace.size();
      REQUIRE(pa->bottomFace.size() == n);
      auto same = [](const Point3& a, const Point3& b) {
        return std::fabs(a.x - b.x) < 1e-9 && std::fabs(a.y - b.y) < 1e-9 && std::fabs(a.z - b.z) < 1e-9;
      };
      size_t offset = n;
      for (size_t k = 0; k < n; ++k) {
        if (same(pa->bottomFace[k], pb.bottomFace[0])) offset = k;
      }
      REQUIRE(offset < n);
      for (size_t i = 0; i < n; ++i) {
        CHECK(same(pa->bottomFace[(offset + i) % n], pb.bottomFace[i]));
      }
    }
  }
}

// FlipPart describes the same physical part from the other side of the sheet:
// every panel's solid, and every bend's true pivot axis, must be unchanged.
TEST_CASE("FlipPart: the same solid, seen from the other side of the sheet", "[translation][flip]") {
  for (double radius : {0.0, 2.0}) {
    CAPTURE(radius);
    PartGraphSpec graph;
    graph.partId = "chain";
    graph.rootRegionPanelId = "seg0";
    graph.outline.outer = {{0, 0}, {300, 0}, {300, 50}, {0, 50}};
    graph.outline.circleHoles = {{{40, 25}, 5.0}};
    graph.thicknessMm = 1.5;
    graph.anchor.transform = Transform3::RotationAboutAxis({3, 4, 5}, {0.3, 0.8, 0.5}, 37.0);
    BendSpec b0;
    b0.id = "b0";
    b0.parentRegionPanelId = "seg0";
    b0.childRegionPanelId = "seg1";
    b0.hingeA = {100, 50};
    b0.hingeB = {100, 0};
    b0.angleDeg = 90;
    b0.radiusMm = radius;
    b0.kFactor = 0.44;
    BendSpec b1 = b0;
    b1.id = "b1";
    b1.parentRegionPanelId = "seg1";
    b1.childRegionPanelId = "seg2";
    b1.hingeA = {200, 50};
    b1.hingeB = {200, 0};
    b1.angleDeg = -60;
    graph.bends = {b0, b1};

    EvaluateResult before = Evaluate(graph);
    REQUIRE(before.ok);
    const PartGraphSpec flipped = FlipPart(graph);
    EvaluateResult after = Evaluate(flipped);
    REQUIRE(after.ok);
    REQUIRE(after.panels.size() == before.panels.size());

    Transform3 m = Transform3::Identity();
    m.r[0] = -1.0;
    m.r[8] = -1.0;
    m.t[2] = graph.thicknessMm;
    auto samePoint = [](const Point3& a, const Point3& b) {
      return std::fabs(a.x - b.x) < 1e-9 && std::fabs(a.y - b.y) < 1e-9 && std::fabs(a.z - b.z) < 1e-9;
    };

    for (const auto& pb : before.panels) {
      CAPTURE(pb.regionPanelId);
      const RegionPanelLayout* pa = nullptr;
      for (const auto& p : after.panels) {
        if (p.regionPanelId == pb.regionPanelId) pa = &p;
      }
      REQUIRE(pa != nullptr);
      const Transform3 expected = pb.pose.Compose(m);
      for (int i = 0; i < 9; ++i) CHECK(pa->pose.r[i] == Approx(expected.r[i]).margin(1e-9));
      for (int i = 0; i < 3; ++i) CHECK(pa->pose.t[i] == Approx(expected.t[i]).margin(1e-9));
      // New bottom face == old top face (same points; winding reversed by the mirror).
      REQUIRE(pa->bottomFace.size() == pb.topFace.size());
      for (const auto& p : pa->bottomFace) {
        bool found = false;
        for (const auto& q : pb.topFace) found = found || samePoint(p, q);
        CHECK(found);
      }
    }

    // Each bend's true pivot axis is the same physical line.
    auto Cross3 = [](const Point3& a, const Point3& b) {
      return Point3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
    };
    REQUIRE(after.bridges.size() == before.bridges.size());
    for (const auto& bb : before.bridges) {
      CAPTURE(bb.bendId);
      const BridgeLayout* ba = nullptr;
      for (const auto& b : after.bridges) {
        if (b.bendId == bb.bendId) ba = &b;
      }
      REQUIRE(ba != nullptr);
      const Point3 d = Cross3(bb.pivotAxisWorld, ba->pivotAxisWorld);
      CHECK(std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z) < 1e-9);  // parallel
      const Point3 off{ba->pivotOriginWorld.x - bb.pivotOriginWorld.x, ba->pivotOriginWorld.y - bb.pivotOriginWorld.y,
                       ba->pivotOriginWorld.z - bb.pivotOriginWorld.z};
      const Point3 perp = Cross3(off, bb.pivotAxisWorld);
      CHECK(std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z) < 1e-9);  // on the same line
    }
  }
}

TEST_CASE("RerootAt: a new root outside the tree is a typed error", "[translation][reroot]") {
  BendSpec b0;
  b0.id = "b0";
  b0.parentRegionPanelId = "seg0";
  b0.childRegionPanelId = "seg1";
  RerootResult reroot = RerootAt({b0}, "seg0", "elsewhere");
  REQUIRE_FALSE(reroot.ok);
  CHECK(reroot.errorCode == EvaluateErrorCode::kDanglingBendReference);
}

// ─── Transform3 primitives, tested directly ─────────────────────────────────

TEST_CASE("Transform3: identity composed with anything is a no-op", "[translation][transform]") {
  Transform3 t = Transform3::Translation(5, 6, 7);
  Transform3 composed = Transform3::Identity().Compose(t);
  Point3 p = composed.Apply({1, 2, 3});
  CHECK(p.x == Approx(6.0));
  CHECK(p.y == Approx(8.0));
  CHECK(p.z == Approx(10.0));
}

TEST_CASE("Transform3: inverse undoes a rotation+translation", "[translation][transform]") {
  Transform3 t = Transform3::RotationAboutAxis({10, 20, 0}, {0, 0, 1}, 37.0);
  Point3 p = {5, -3, 8};
  Point3 forward = t.Apply(p);
  Point3 back = t.Inverse().Apply(forward);
  CHECK(back.x == Approx(p.x).margin(1e-9));
  CHECK(back.y == Approx(p.y).margin(1e-9));
  CHECK(back.z == Approx(p.z).margin(1e-9));
}

TEST_CASE("Transform3: 360 degree rotation about any axis is the identity",
          "[translation][transform]") {
  Transform3 t = Transform3::RotationAboutAxis({3, 4, 5}, {0.267, 0.535, 0.802}, 360.0);
  Point3 p = {11, -7, 2};
  Point3 result = t.Apply(p);
  CHECK(result.x == Approx(p.x).margin(1e-6));
  CHECK(result.y == Approx(p.y).margin(1e-6));
  CHECK(result.z == Approx(p.z).margin(1e-6));
}

// ─── Bend allowance grows the outline; the pivot lands on BOTH true edges ────
//
// docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md: neither a
// panel's own measured length nor its neighbour's ever shrank to make room
// for a bend zone — RegionOf clips at zero offset from the raw hinge, and
// Evaluate()'s pose walk instead accumulates each bend's own full allowance
// as a running 2D shift applied to everything in its child's subtree. This
// is the regression test for that fix: both the PARENT's and the CHILD's
// own bend-adjacent edge should land exactly on the bend's pivot axis (no
// gap, no shrinkage, no separate "collar" needed on either side), and the
// two panels' straight lengths should each equal their own authored length
// exactly, growing the part's total span by the bend's own BA.
TEST_CASE("GraphEvaluator: bend allowance shifts the child's subtree, leaves "
          "each panel's own length untouched, only when BA>0",
          "[translation][allowance]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  double ba = TestBendAllowanceMm(90.0, radiusMm, kFactor, thicknessMm);
  REQUIRE(ba > 1e-6);

  PartGraphSpec graph;
  graph.partId = "diag";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.outline.outer = {{0, 0}, {200, 0}, {200, 50}, {0, 50}};  // flush, un-widened
  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "seg0";
  bend.childRegionPanelId = "seg1";
  bend.hingeA = {100, 50};
  bend.hingeB = {100, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 2);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  const BridgeLayout& bridge = result.bridges[0];

  // seg0's own pose is identity (it's the root, no anchor set), so its
  // bend-adjacent bottomFace/topFace corners should land exactly at the raw
  // hinge (x,y), z=0/thicknessMm — no collar-sized gap in the in-plane (x,y)
  // direction on the parent side (only the true radial offset in z, which
  // pivotOriginWorld/bottomFace/topFace already encode independently).
  for (size_t i = 0; i < seg0->edgeBendId.size(); ++i) {
    if (seg0->edgeBendId[i] != bridge.bendId) continue;
    const Point3& b = seg0->bottomFace[i];
    const Point3& t = seg0->topFace[i];
    bool atHingeA = std::fabs(b.x - bend.hingeA.x) < 1e-9 && std::fabs(b.y - bend.hingeA.y) < 1e-9;
    bool atHingeB = std::fabs(b.x - bend.hingeB.x) < 1e-9 && std::fabs(b.y - bend.hingeB.y) < 1e-9;
    CHECK((atHingeA || atHingeB));
    CHECK(b.z == Approx(0.0).margin(1e-9));
    CHECK(t.x == Approx(b.x).margin(1e-9));
    CHECK(t.y == Approx(b.y).margin(1e-9));
    CHECK(t.z == Approx(thicknessMm).margin(1e-9));
  }

  // Child-side landing point. Rotating seg1's own bend-adjacent bottomFace/
  // topFace BACK by the bridge's own angle, about the bridge's own TRUE
  // axis, does NOT land exactly on the raw hinge vertex — childPose rotates
  // the child about the SHARP (raw-hinge) axis, not the bridge's true axis,
  // so unfolding by the bridge's own rotation lands 2x this bend's own
  // setback (radiusMm*tan(|angleDeg|/2)) SHORT of the raw hinge along nLeft
  // (BuildBendCuts's own tangent point is pre-compensated by exactly this
  // amount so the WALL — not the raw hinge — ends up tangent to the true
  // axis; unfolding undoes the rotation but not that pre-compensation).
  Point2 hingeDir{bend.hingeB.x - bend.hingeA.x, bend.hingeB.y - bend.hingeA.y};
  double hingeDirLen = std::sqrt(hingeDir.x * hingeDir.x + hingeDir.y * hingeDir.y);
  Point2 nLeft{-hingeDir.y / hingeDirLen, hingeDir.x / hingeDirLen};
  double setbackMm = bend.radiusMm * std::tan(std::fabs(bend.angleDeg) * kTestPi / 180.0 / 2.0);
  double extend = -2.0 * setbackMm;

  Transform3 unfold = Transform3::RotationAboutAxis(bridge.pivotOriginWorld,
                                                      bridge.pivotAxisWorld, -bridge.angleDeg);
  int checkedChildEdges = 0;
  for (size_t j = 0; j < seg1->edgeBendId.size(); ++j) {
    if (seg1->edgeBendId[j] != bridge.bendId) continue;
    const Point3& cb = seg1->bottomFace[j];
    const Point3& ct = seg1->topFace[j];
    Point3 unfoldedB = unfold.Apply(cb);
    Point3 unfoldedT = unfold.Apply(ct);
    Point2 extendedHingeA{bend.hingeA.x + extend * nLeft.x, bend.hingeA.y + extend * nLeft.y};
    Point2 extendedHingeB{bend.hingeB.x + extend * nLeft.x, bend.hingeB.y + extend * nLeft.y};
    bool atHingeA = std::fabs(unfoldedB.x - extendedHingeA.x) < 1e-6 &&
                     std::fabs(unfoldedB.y - extendedHingeA.y) < 1e-6;
    bool atHingeB = std::fabs(unfoldedB.x - extendedHingeB.x) < 1e-6 &&
                     std::fabs(unfoldedB.y - extendedHingeB.y) < 1e-6;
    CHECK((atHingeA || atHingeB));
    CHECK(unfoldedB.z == Approx(0.0).margin(1e-6));
    CHECK(unfoldedT.x == Approx(unfoldedB.x).margin(1e-6));
    CHECK(unfoldedT.y == Approx(unfoldedB.y).margin(1e-6));
    CHECK(unfoldedT.z == Approx(thicknessMm).margin(1e-6));
    ++checkedChildEdges;
  }
  CHECK(checkedChildEdges > 0);

  // Direct, no-OCCT regression: pose applied to rawOuter exactly reproduces
  // bottomFace/topFace, for every panel/index — documents (and pins) the
  // raw/shifted split this whole fix depends on.
  for (const auto* panel : {seg0, seg1}) {
    REQUIRE(panel->rawOuter.size() == panel->bottomFace.size());
    for (size_t i = 0; i < panel->rawOuter.size(); ++i) {
      const Point2& v = panel->rawOuter[i];
      Point3 expectedBottom = panel->pose.Apply({v.x, v.y, 0.0});
      Point3 expectedTop = panel->pose.Apply({v.x, v.y, thicknessMm});
      CHECK(Dist(panel->bottomFace[i], expectedBottom) < 1e-9);
      CHECK(Dist(panel->topFace[i], expectedTop) < 1e-9);
    }
  }

  // seg0's own straight length (0 to its bend-adjacent edge) is exactly
  // 100mm, its authored length — not shrunk by BA/2.
  double seg0MaxX = 0.0;
  for (const auto& v : seg0->regionOuter) seg0MaxX = std::max(seg0MaxX, v.x);
  CHECK(seg0MaxX == Approx(100.0).margin(1e-9));

  // seg1's own straight length is ALSO exactly 100mm (200-100 authored),
  // just translated outward by the bend's own full allowance.
  double seg1MinX = 1e9, seg1MaxX = -1e9;
  for (const auto& v : seg1->regionOuter) {
    seg1MinX = std::min(seg1MinX, v.x);
    seg1MaxX = std::max(seg1MaxX, v.x);
  }
  CHECK((seg1MaxX - seg1MinX) == Approx(100.0).margin(1e-9));
  CHECK(seg1MinX == Approx(100.0 + ba).margin(1e-9));

  // bridge.hingeA/hingeB is the bend's true 2D position — the CENTER of
  // its own allowance zone, not the raw (start-of-zone) mark: the raw
  // hinge (100,50)->(100,0), shifted by half the zone's own width along
  // nLeft=(1,0) (root has no ancestor shift of its own).
  CHECK(bridge.hingeA.x == Approx(100.0 + 0.5 * ba).margin(1e-9));
  CHECK(bridge.hingeA.y == Approx(50.0).margin(1e-9));
  CHECK(bridge.hingeB.x == Approx(100.0 + 0.5 * ba).margin(1e-9));
  CHECK(bridge.hingeB.y == Approx(0.0).margin(1e-9));
}

TEST_CASE("GraphEvaluator: bend allowance shift is a no-op at radiusMm=0, kFactor=0",
          "[translation][allowance]") {
  auto graph = MakeStrip(4, 100.0, 50.0, 2.0, 90.0, /*radiusMm=*/0.0, /*kFactor=*/0.0,
                         0.0, 0.0, Transform3::Identity(), /*closesLoop=*/true);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  // seg1 starts exactly where seg0 ends (flush, no inserted gap) — matches
  // today's sharp-fold behaviour exactly, the critical regression guard.
  double seg0MaxX = 0.0;
  for (const auto& v : seg0->regionOuter) seg0MaxX = std::max(seg0MaxX, v.x);
  double seg1MinX = 1e9;
  for (const auto& v : seg1->regionOuter) seg1MinX = std::min(seg1MinX, v.x);
  CHECK(seg1MinX == Approx(seg0MaxX).margin(1e-9));

  // At BA=0, the bend's true position is exactly its raw stored mark — no
  // shift, centered or otherwise, since the zone has zero width.
  REQUIRE(result.bridges.size() >= 1);
  REQUIRE(graph.bends.size() >= 1);
  CHECK(result.bridges[0].hingeA.x == Approx(graph.bends[0].hingeA.x).margin(1e-9));
  CHECK(result.bridges[0].hingeA.y == Approx(graph.bends[0].hingeA.y).margin(1e-9));
  CHECK(result.bridges[0].hingeB.x == Approx(graph.bends[0].hingeB.x).margin(1e-9));
  CHECK(result.bridges[0].hingeB.y == Approx(graph.bends[0].hingeB.y).margin(1e-9));
}

// 90 alone can't distinguish tan(angle/2) from other plausible variants,
// e.g. cot(angle/2), which happen to coincide exactly at 90 degrees - a
// non-90-degree angle is required to pin the real formula down.
TEST_CASE("ComputeBendGeometry: setback matches the standard sheet-metal "
          "formula at a non-90-degree angle",
          "[translation][bendgeometry]") {
  double angleRad = 1.0;  // ~57.3 degrees, deliberately not 90 or any round degree value
  double angleDeg = angleRad * 180.0 / kTestPi;
  double radiusMm = 3.0, kFactor = 0.25, thicknessMm = 2.0;
  double reff = radiusMm + kFactor * thicknessMm;  // 3.5

  BendGeometryMm geom = ComputeBendGeometry(angleDeg, radiusMm, kFactor, thicknessMm);
  CHECK(geom.allowanceMm == Approx(angleRad * reff).margin(1e-9));

  // Hardcoded, independently hand-computed (not re-typing this module's own
  // formula): SB = reff * tan(0.5) = 3.5 * 0.54630248984379051 = 1.91205871445...
  CHECK(geom.setbackMm == Approx(1.9120587144517668).margin(1e-6));

  // The BendSpec-based overload must agree exactly with the raw-parameter one.
  BendSpec bend;
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  BendGeometryMm geom2 = ComputeBendGeometry(bend, thicknessMm);
  CHECK(geom2.allowanceMm == Approx(geom.allowanceMm).margin(1e-12));
  CHECK(geom2.setbackMm == Approx(geom.setbackMm).margin(1e-12));
}

// The wall built from a panel's raw hinge coordinate is no longer exactly
// tangent to the bend's own cylinder (docs/BUG_REPORT_reconstructed_
// envelope_grows_with_bend_radius.md) — that was only achievable by leaving
// the panel's own far edge free to drift with radiusMm, which is the bug
// this fix addresses. With the axis now offset in-plane by this bend's own
// setback, a wall edge that itself didn't move sits `setbackMm` off the
// axis's own in-plane position, so its distance to the axis is no longer
// the bare radius but the hypotenuse of that offset against it —
// `sqrt(setbackMm^2 + radius^2)` — on both surfaces, both fold directions.
TEST_CASE("GraphEvaluator: parent AND child wall edges sit exactly "
          "sqrt(setback^2 + radius^2) from the bend's own pivot axis, both "
          "surfaces, both fold directions, across radii",
          "[translation][probe]") {
  double thicknessMm = 2.0;
  for (double angleDeg : {90.0, -90.0}) {
  for (double radiusMm : {0.0, 1.0, 1.5, 2.0, 3.0}) {
    double kFactor = radiusMm > 0 ? 0.4 : 0.0;
    INFO("angleDeg=" << angleDeg << " radiusMm=" << radiusMm);
    auto graph = MakeStrip(2, 100.0, 50.0, thicknessMm, angleDeg, radiusMm, kFactor);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.bridges.size() == 1);
    const BridgeLayout& bridge = result.bridges[0];

    const RegionPanelLayout* seg0 = nullptr;
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg1") seg1 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg1 != nullptr);

    bool concave = angleDeg < 0.0;  // matches BottomIsConcave's fallback polarity
    double rBottom = concave ? radiusMm : radiusMm + thicknessMm;
    double rTop = concave ? radiusMm + thicknessMm : radiusMm;
    double setbackMm = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
    double expectedBottom = std::sqrt(setbackMm * setbackMm + rBottom * rBottom);
    double expectedTop = std::sqrt(setbackMm * setbackMm + rTop * rTop);

    // Perpendicular distance from a world point to the axis line.
    auto distToAxis = [&](const Point3& p) -> double {
      Point3 v{p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
                p.z - bridge.pivotOriginWorld.z};
      const Point3& a = bridge.pivotAxisWorld;
      double dot = v.x * a.x + v.y * a.y + v.z * a.z;
      Point3 proj{a.x * dot, a.y * dot, a.z * dot};
      Point3 perp{v.x - proj.x, v.y - proj.y, v.z - proj.z};
      return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
    };

    auto checkPanel = [&](const char* label, const RegionPanelLayout& panel) {
      int checked = 0;
      for (size_t i = 0; i < panel.edgeBendId.size(); ++i) {
        if (panel.edgeBendId[i] != bridge.bendId) continue;
        double dBottom = distToAxis(panel.bottomFace[i]);
        double dTop = distToAxis(panel.topFace[i]);
        INFO(label << " edge index " << i << " dBottom=" << dBottom << " expected="
                    << expectedBottom << " dTop=" << dTop << " expected=" << expectedTop);
        CHECK(dBottom == Approx(expectedBottom).margin(1e-6));
        CHECK(dTop == Approx(expectedTop).margin(1e-6));
        ++checked;
      }
      CHECK(checked > 0);
    };
    checkPanel("parent", *seg0);
    checkPanel("child", *seg1);
  }
  }
}

// The bridge's own end face (parent's tagged edge, rotated by the full bend
// angle about the axis — exactly reproducing what ConstructPartSolid
// computes) no longer lands exactly on the child panel's own real wall edge
// (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md) — the
// child's pose is that rotation PLUS its own 2x-setback extension, so the
// two now differ by exactly that extension's own world-space length (a
// rotation preserves vector length, so the gap is exactly `2*setbackMm`
// regardless of fold direction or which corner) — checked for both fold
// directions.
TEST_CASE("GraphEvaluator: bridge end face reaches the child panel's own "
          "real wall edge, offset by exactly 2x this bend's own setback",
          "[translation][allowance]") {
  for (double radiusMm : {0.0, 1.5}) {
    double kFactor = radiusMm > 0 ? 0.4 : 0.0;
    double thicknessMm = 2.0;
    for (double angleDeg : {90.0, -90.0}) {
      double setbackMm = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
      auto graph = MakeStrip(2, 100.0, 50.0, thicknessMm, angleDeg, radiusMm, kFactor);
      EvaluateResult result = Evaluate(graph);
      REQUIRE(result.ok);
      REQUIRE(result.bridges.size() == 1);
      const BridgeLayout& bridge = result.bridges[0];

      const RegionPanelLayout* seg0 = nullptr;
      const RegionPanelLayout* seg1 = nullptr;
      for (auto& p : result.panels) {
        if (p.regionPanelId == "seg0") seg0 = &p;
        if (p.regionPanelId == "seg1") seg1 = &p;
      }
      REQUIRE(seg0 != nullptr);
      REQUIRE(seg1 != nullptr);

      int parentEdge = -1, childEdge = -1;
      for (size_t i = 0; i < seg0->edgeBendId.size(); ++i)
        if (seg0->edgeBendId[i] == bridge.bendId) parentEdge = static_cast<int>(i);
      for (size_t j = 0; j < seg1->edgeBendId.size(); ++j)
        if (seg1->edgeBendId[j] == bridge.bendId) childEdge = static_cast<int>(j);
      REQUIRE(parentEdge >= 0);
      REQUIRE(childEdge >= 0);

      Transform3 worldFold = Transform3::RotationAboutAxis(bridge.pivotOriginWorld,
                                                             bridge.pivotAxisWorld, bridge.angleDeg);
      size_t i0 = static_cast<size_t>(parentEdge);
      size_t i1 = (i0 + 1) % seg0->bottomFace.size();
      size_t j0 = static_cast<size_t>(childEdge);
      size_t j1 = (j0 + 1) % seg1->bottomFace.size();

      // Determine parent-child corner correspondence once, using bottomFace
      // index i0 (winding is consistent across bottom/top, so this same
      // correspondence applies to topFace too).
      Point3 endB0 = worldFold.Apply(seg0->bottomFace[i0]);
      bool j0MatchesI0 = Dist(endB0, seg1->bottomFace[j0]) < Dist(endB0, seg1->bottomFace[j1]);
      size_t childForI0 = j0MatchesI0 ? j0 : j1;
      size_t childForI1 = j0MatchesI0 ? j1 : j0;

      auto check = [&](const char* label, const Point3& parentPt, const Point3& childPt) {
        Point3 end = worldFold.Apply(parentPt);
        double residual = Dist(end, childPt);
        INFO("angleDeg=" << angleDeg << " radiusMm=" << radiusMm << " " << label
                          << ": end=(" << end.x << "," << end.y << "," << end.z << ") child=("
                          << childPt.x << "," << childPt.y << "," << childPt.z
                          << ") residual=" << residual);
        CHECK(residual == Approx(2.0 * setbackMm).margin(1e-6));
      };
      check("i0/bottom", seg0->bottomFace[i0], seg1->bottomFace[childForI0]);
      check("i1/bottom", seg0->bottomFace[i1], seg1->bottomFace[childForI1]);
      check("i0/top", seg0->topFace[i0], seg1->topFace[childForI0]);
      check("i1/top", seg0->topFace[i1], seg1->topFace[childForI1]);
    }
  }
}

// Independent measurement-based check, deliberately NOT reusing the pose
// walk's own rotation/composition formula (only the trivial axis DIRECTION,
// hingeB-hingeA, and the axis's simple position — raw hinge offset by
// pivotZ height — neither of which involves composing a fold). Everything
// else here is measured straight off the two panels' own real, placed
// vertices: the dihedral angle between their surfaces (via plane normals)
// must equal the bend's authored angleDeg; their tagged edges are no longer
// the same 3D line (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_
// radius.md — the child's own 2x-setback extension moves it by exactly that
// much), and both surfaces sit `sqrt(setback^2 + radius^2)` from the axis,
// not the bare radius (see the probe test above for the same relationship).
// A bug in the pose walk's own rotation math (e.g. composing in the wrong
// order) would still have to also corrupt this independently-derived
// measurement to slip past both checks — this is the closest this test file
// gets to "measure the real geometry and compare to spec" rather than
// "compare one derivation to another derivation of the same formula."
TEST_CASE("GraphEvaluator: bend geometry measured directly off the two "
          "placed panels' own real vertices matches the authored spec",
          "[translation][probe]") {
  double thicknessMm = 2.0;
  for (double angleDeg : {90.0, -90.0, 45.0, -30.0}) {
  for (double radiusMm : {0.0, 1.0, 2.5}) {
    double kFactor = radiusMm > 0 ? 0.4 : 0.0;
    double setbackMm = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
    INFO("angleDeg=" << angleDeg << " radiusMm=" << radiusMm);
    auto graph = MakeStrip(2, 100.0, 50.0, thicknessMm, angleDeg, radiusMm, kFactor);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.bridges.size() == 1);
    const BridgeLayout& bridge = result.bridges[0];

    const RegionPanelLayout* seg0 = nullptr;
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "seg0") seg0 = &p;
      if (p.regionPanelId == "seg1") seg1 = &p;
    }
    REQUIRE(seg0 != nullptr);
    REQUIRE(seg1 != nullptr);

    int parentEdge = -1, childEdge = -1;
    for (size_t i = 0; i < seg0->edgeBendId.size(); ++i)
      if (seg0->edgeBendId[i] == bridge.bendId) parentEdge = static_cast<int>(i);
    for (size_t j = 0; j < seg1->edgeBendId.size(); ++j)
      if (seg1->edgeBendId[j] == bridge.bendId) childEdge = static_cast<int>(j);
    REQUIRE(parentEdge >= 0);
    REQUIRE(childEdge >= 0);
    size_t i0 = static_cast<size_t>(parentEdge);
    size_t i1 = (i0 + 1) % seg0->bottomFace.size();
    size_t j0 = static_cast<size_t>(childEdge);
    size_t j1 = (j0 + 1) % seg1->bottomFace.size();

    // The bridge occupies the real, curved material between the parent's
    // edge (angle=0 on the cylinder) and the child's edge (angle=angleDeg
    // on the SAME cylinder) — they are the two ends of the bridge, not the
    // same point, except in the degenerate r=0/pivotZ=0 case. Rotating the
    // parent's own edge by the full bend angle about the axis gives the
    // point that must coincide with the child's edge.
    Transform3 worldFold = Transform3::RotationAboutAxis(bridge.pivotOriginWorld,
                                                           bridge.pivotAxisWorld, bridge.angleDeg);
    Point3 rotatedI0 = worldFold.Apply(seg0->bottomFace[i0]);
    bool j0MatchesI0 =
        Dist(rotatedI0, seg1->bottomFace[j0]) < Dist(rotatedI0, seg1->bottomFace[j1]);
    size_t childForI0 = j0MatchesI0 ? j0 : j1;
    size_t childForI1 = j0MatchesI0 ? j1 : j0;

    // Edge gap: the parent's edge carried through the same fold the child's
    // own pose applies now falls short of the child's real edge by exactly
    // 2x this bend's own setback (a rotation preserves vector length, so
    // this holds regardless of fold direction or which corner).
    CHECK(Dist(worldFold.Apply(seg0->bottomFace[i0]), seg1->bottomFace[childForI0]) ==
          Approx(2.0 * setbackMm).margin(1e-6));
    CHECK(Dist(worldFold.Apply(seg0->bottomFace[i1]), seg1->bottomFace[childForI1]) ==
          Approx(2.0 * setbackMm).margin(1e-6));
    CHECK(Dist(worldFold.Apply(seg0->topFace[i0]), seg1->topFace[childForI0]) ==
          Approx(2.0 * setbackMm).margin(1e-6));
    CHECK(Dist(worldFold.Apply(seg0->topFace[i1]), seg1->topFace[childForI1]) ==
          Approx(2.0 * setbackMm).margin(1e-6));

    // Dihedral angle between the two panels' own surface planes, measured
    // via their normals (cross product of two edges within each panel's
    // own bottomFace) and the axis's DIRECTION only (hingeB-hingeA — a
    // one-line fact, not the pose walk's rotation/composition machinery).
    auto planeNormal = [](const std::vector<Point3>& face) -> Point3 {
      Point3 e01{face[1].x - face[0].x, face[1].y - face[0].y, face[1].z - face[0].z};
      Point3 e12{face[2].x - face[1].x, face[2].y - face[1].y, face[2].z - face[1].z};
      Point3 n{e01.y * e12.z - e01.z * e12.y, e01.z * e12.x - e01.x * e12.z,
                e01.x * e12.y - e01.y * e12.x};
      double len = std::sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
      return {n.x / len, n.y / len, n.z / len};
    };
    Point3 nParent = planeNormal(seg0->bottomFace);
    Point3 nChild = planeNormal(seg1->bottomFace);
    const Point3& axisDir = bridge.pivotAxisWorld;
    double dot = nParent.x * nChild.x + nParent.y * nChild.y + nParent.z * nChild.z;
    Point3 cross{nParent.y * nChild.z - nParent.z * nChild.y, nParent.z * nChild.x - nParent.x * nChild.z,
                 nParent.x * nChild.y - nParent.y * nChild.x};
    double crossDotAxis = cross.x * axisDir.x + cross.y * axisDir.y + cross.z * axisDir.z;
    double measuredAngleDeg = std::atan2(crossDotAxis, dot) * 180.0 / kTestPi;
    INFO("measuredAngleDeg=" << measuredAngleDeg << " authored=" << angleDeg);
    CHECK(measuredAngleDeg == Approx(angleDeg).margin(1e-6));

    // Radius from the axis's simple position (raw hinge + pivotZ height —
    // not the rotation/composition step under test) — sqrt(setback^2 +
    // radius^2), same relationship as the probe test above, since the
    // child's own edge sits `setbackMm` off the axis's in-plane position.
    bool concave = angleDeg < 0.0;  // matches BottomIsConcave's fallback polarity
    double rBottom = concave ? radiusMm : radiusMm + thicknessMm;
    double rTop = concave ? radiusMm + thicknessMm : radiusMm;
    double expectedBottom = std::sqrt(setbackMm * setbackMm + rBottom * rBottom);
    double expectedTop = std::sqrt(setbackMm * setbackMm + rTop * rTop);
    auto distToAxis = [&](const Point3& p) -> double {
      Point3 v{p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
                p.z - bridge.pivotOriginWorld.z};
      double d = v.x * axisDir.x + v.y * axisDir.y + v.z * axisDir.z;
      Point3 perp{v.x - axisDir.x * d, v.y - axisDir.y * d, v.z - axisDir.z * d};
      return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
    };
    CHECK(distToAxis(seg1->bottomFace[childForI0]) == Approx(expectedBottom).margin(1e-6));
    CHECK(distToAxis(seg1->topFace[childForI0]) == Approx(expectedTop).margin(1e-6));
  }
  }
}

// Investigated 2026-09 after a live-app report of unexpected extra material
// in merge_bodies_with_bend at a real radius (0.95mm) on a PARTIAL-WIDTH
// (T-shaped, asymmetric) seam -- the flange's own seam is narrower than the
// full straight run of the parent edge it sits on. This test found the
// evaluator's own tangent-point math correct for exactly this combination;
// the live report's actual cause turned out to be a flaw in an ad hoc
// TS-level diagnostic (it compared a source part's own PRE-bend-allowance
// anchor against the post-shift child pose real bends legitimately apply --
// see "GraphEvaluator: bend allowance shifts the child's subtree" above --
// not a defect in this evaluator). Kept as permanent regression coverage:
// this exact combined outline (8 vertices) is bit-for-bit what
// merge_partial_seam_tab_bracket.integration.test.ts's own ReconcileOutlines
// call produces for a 100x200 plate + a 100x100 flange attached to the
// plate's middle 100mm (y=[50,150]) of its 200mm right edge -- hand-derived
// here from that same authored scenario (plate CCW, flange anchor r=[0,0,-1,
// -1,0,0,0,1,0] t=[100,150,0]) so this test needs no TS/merge_bodies_with_bend
// call at all, only Evaluate() on the resulting graph.
//
// That TS test only ever runs this exact T-shape at radius_mm=0 (the tool's
// default) -- it had never been checked with a real nonzero radius before.
// The OTHER existing invariant checks above (the "parent AND child wall
// edges sit exactly sqrt(setback^2+radius^2) from the pivot axis" probe, and
// this test's own sibling immediately above) only ever use MakeStrip's
// full-width, symmetric seam. This is the first test to combine a REAL
// partial-width seam with a REAL nonzero radius.
TEST_CASE("GraphEvaluator: partial-width (T-shaped) seam wall edges sit exactly "
          "sqrt(setback^2 + radius^2) from the bend's own pivot axis, real nonzero radius",
          "[translation][probe][regression]") {
  double thicknessMm = 1.5;
  for (double angleDeg : {90.0, -90.0}) {
  for (double radiusMm : {0.0, 0.95, 2.0}) {
    double kFactor = radiusMm > 0 ? 0.4 : 0.0;
    INFO("angleDeg=" << angleDeg << " radiusMm=" << radiusMm);

    PartGraphSpec graph;
    graph.partId = "tshape";
    graph.rootRegionPanelId = "parent";
    graph.thicknessMm = thicknessMm;
    graph.anchor.transform = Transform3::Identity();
    // Plate (100x200) + flange (100x100) attached to the plate's middle
    // 100mm of its 200mm right edge -- exactly ReconcileOutlines' own
    // combined outline for merge_partial_seam_tab_bracket's authored
    // plate/flange pair (hand-derived, see this TEST_CASE's own comment
    // above).
    graph.outline.outer = {
        {0, 0}, {100, 0}, {100, 50}, {200, 50}, {200, 150}, {100, 150}, {100, 200}, {0, 200},
    };

    BendSpec bend;
    bend.id = "bend0";
    bend.parentRegionPanelId = "parent";
    bend.childRegionPanelId = "child";
    bend.hingeA = {100, 150};
    bend.hingeB = {100, 50};
    bend.angleDeg = angleDeg;
    bend.radiusMm = radiusMm;
    bend.kFactor = kFactor;
    graph.bends.push_back(bend);

    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    REQUIRE(result.bridges.size() == 1);
    const BridgeLayout& bridge = result.bridges[0];

    const RegionPanelLayout* parent = nullptr;
    const RegionPanelLayout* child = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == "parent") parent = &p;
      if (p.regionPanelId == "child") child = &p;
    }
    REQUIRE(parent != nullptr);
    REQUIRE(child != nullptr);

    bool concave = angleDeg < 0.0;  // matches BottomIsConcave's fallback polarity
    double rBottom = concave ? radiusMm : radiusMm + thicknessMm;
    double rTop = concave ? radiusMm + thicknessMm : radiusMm;
    double setbackMm = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
    double expectedBottom = std::sqrt(setbackMm * setbackMm + rBottom * rBottom);
    double expectedTop = std::sqrt(setbackMm * setbackMm + rTop * rTop);

    auto distToAxis = [&](const Point3& p) -> double {
      Point3 v{p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
                p.z - bridge.pivotOriginWorld.z};
      const Point3& a = bridge.pivotAxisWorld;
      double dot = v.x * a.x + v.y * a.y + v.z * a.z;
      Point3 proj{a.x * dot, a.y * dot, a.z * dot};
      Point3 perp{v.x - proj.x, v.y - proj.y, v.z - proj.z};
      return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
    };

    auto checkPanel = [&](const char* label, const RegionPanelLayout& panel) {
      int checked = 0;
      for (size_t i = 0; i < panel.edgeBendId.size(); ++i) {
        if (panel.edgeBendId[i] != bridge.bendId) continue;
        double dBottom = distToAxis(panel.bottomFace[i]);
        double dTop = distToAxis(panel.topFace[i]);
        INFO(label << " edge index " << i << " dBottom=" << dBottom << " expected="
                    << expectedBottom << " dTop=" << dTop << " expected=" << expectedTop);
        CHECK(dBottom == Approx(expectedBottom).margin(1e-6));
        CHECK(dTop == Approx(expectedTop).margin(1e-6));
        ++checked;
      }
      CHECK(checked > 0);
    };
    checkPanel("parent", *parent);
    checkPanel("child", *child);
  }
  }
}

// Live-app regression (2026-09): ConstructPartSolid's own FindZoneEdges
// (part_solid_construction.cc) reads wallEdgeIsTransitionStep to exclude
// flat connector material from its revolve scan -- but at radiusMm=0 (a
// sharp bend, no allowance), a transition step's own endpoint exactly
// coincides with the real parentBridge edge's own start point (both
// collapse to the same raw hinge point, since setbackMm=0), so SimplifyLoop
// merges them. An earlier fix attempt merged the flag with OR, so the
// SURVIVING edge -- the real, 100mm hinge-parallel wall-zone edge -- wrongly
// inherited "transitional" from the degenerate step it absorbed, making
// FindZoneEdges find NOTHING for this bend at all ("no zone-boundary edge
// tagged for bend"), confirmed live on testcube.step and on this exact
// T-shape via merge_bodies_with_bend at its own tool default (radius_mm=0).
// Fixed by merging with AND instead (prefer "real" whenever either side
// is real). This is the first test checking wallEdgeIsTransitionStep
// directly, at exactly the radius that broke it.
TEST_CASE("GraphEvaluator: a partial-width seam's real wall-zone edge is never "
          "marked a transition step, even at radiusMm=0 where SimplifyLoop merges "
          "it with the (degenerate) step",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 0.0;
  double kFactor = 0.0;
  double angleDeg = 90.0;

  PartGraphSpec graph;
  graph.partId = "tshape";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {
      {0, 0}, {100, 0}, {100, 50}, {200, 50}, {200, 150}, {100, 150}, {100, 200}, {0, 200},
  };

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {100, 150};
  bend.hingeB = {100, 50};
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);

  const RegionPanelLayout* parent = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "parent") parent = &p;
  }
  REQUIRE(parent != nullptr);
  REQUIRE(parent->wallEdgeIsTransitionStep.size() == parent->wallEdgeBendId.size());

  int realZoneEdges = 0;
  for (size_t i = 0; i < parent->wallEdgeBendId.size(); ++i) {
    if (parent->wallEdgeBendId[i] != "bend0") continue;
    INFO("edge index " << i << " isTransitionStep=" << parent->wallEdgeIsTransitionStep[i]);
    CHECK_FALSE(parent->wallEdgeIsTransitionStep[i]);
    ++realZoneEdges;
  }
  // At least one real (non-transitional) tagged edge must survive -- this
  // is what ConstructPartSolid's FindZoneEdges needs to find anything at
  // all for this bend.
  CHECK(realZoneEdges > 0);
}

// Live-app regression: a partial-width seam produces a visible flat
// protrusion on the bend line instead of a smooth radius. Root cause: in
// BuildCutEdges (this file), the `isB && !isA` branch unconditionally
// redirects the edge immediately preceding a simple hingeB to end at
// `parentShiftB` (the setback-shifted point) -- correct when that preceding
// edge is an ordinary corner (approaches the hinge from a different
// direction), but wrong when it's a FREE edge collinear with the hinge line
// itself (the partial-width case: the parent's own edge continues past
// where the seam ends, e.g. reused testcube.step geometry via
// merge_bodies_with_bend). The free edge's endpoint gets yanked from the
// raw hinge point to the setback point, producing a diagonal wedge instead
// of the wall cleanly terminating at the true corner for the bridge to
// round off. This test uses the SAME T-shaped outline as the test above
// (whose own hinge is collinear with two of parent's own free edges) but
// checks the FREE edge's own endpoint in `wallOuter`, which that test never
// inspected (it only checks edges tagged to the bend).
TEST_CASE("GraphEvaluator: a free edge collinear with the hinge line keeps its own "
          "true endpoint in wallOuter, not the bend's setback-shifted point",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 0.95;
  double kFactor = 0.4;
  double angleDeg = 90.0;

  PartGraphSpec graph;
  graph.partId = "tshape";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  // Same plate+flange outline as the test above: the flange (child) attaches
  // to only the MIDDLE 100mm of the plate's 200mm right edge, so the plate's
  // own edges (100,0)-(100,50) and (100,150)-(100,200) are FREE — collinear
  // with the hinge line (x=100) but not part of the bend zone at all.
  graph.outline.outer = {
      {0, 0}, {100, 0}, {100, 50}, {200, 50}, {200, 150}, {100, 150}, {100, 200}, {0, 200},
  };

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {100, 150};
  bend.hingeB = {100, 50};
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* parent = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "parent") parent = &p;
  }
  REQUIRE(parent != nullptr);

  // The free edge (100,0)-(100,50) must survive into wallOuter with its own
  // true endpoint intact -- some vertex at (100,50) within numerical
  // tolerance, NOT silently replaced by a point 0.95mm away (the setback
  // amount) with no vertex left at the true corner at all.
  bool foundTrueHingeB = false;
  double closestDist = 1e18;
  for (const auto& v : parent->wallOuter) {
    double dist = std::hypot(v.x - bend.hingeB.x, v.y - bend.hingeB.y);
    closestDist = std::min(closestDist, dist);
    if (dist < 1e-6) foundTrueHingeB = true;
  }
  INFO("closest wallOuter vertex to raw hingeB (100,50) is " << closestDist << "mm away");
  CHECK(foundTrueHingeB);
}

// Live bug (l_bracket_corner_90deg.stp @ default_bend_radius_mm=5,
// docs/BUG_REPORT_complex_panel_bend_surfaces.md): a non-collinear child
// vertex right next to hingeA (an ordinary angled tab edge, unclaimed by any
// other bend) was left at its raw position while the hinge shifted by
// setback past it, so the tab's own true edge crossed back through the
// shifted hinge line -- a self-intersecting wallOuter and, downstream, an
// invalid extruded solid ("invalid boolean topology" from the fuse). Fixed
// in BuildCutEdges' prevA loop: a vertex still inside the trimmed setback
// band (on the child's own side of the raw hinge, but not yet past the
// shifted line) must be DROPPED, walking backward until reaching the true
// boundary crossing -- not corrected in place by intersecting the wrong
// (outgoing, already-inside-the-band) edge, which is what an earlier,
// incomplete version of this fix did.
TEST_CASE("GraphEvaluator: an angled tab immediately before hingeA, fully "
          "inside the setback band, is dropped at the true incoming-edge "
          "crossing -- not corrected in place",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 25.0;
  double kFactor = 0.0;
  double angleDeg = -90.0;

  PartGraphSpec graph;
  graph.partId = "tab_before_hingeA";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  // hingeA(20,200)->parent(0,200)->parent(0,0)->hingeB(20,0)->child(120,0)->
  // child(120,100)->child tab tip(40,100)->back to hingeA. The tab tip
  // (40,100) sits only 20mm from the hinge line (x=20) -- well inside the
  // setback band once radius=25 pushes the shifted hinge line out to x=45 --
  // and its own true edge (40,100)->hingeA(20,200) runs AWAY from the shift
  // line (decreasing x), so intersecting it directly (the old, broken
  // behavior) extrapolates backward into fabricated territory. The real
  // crossing is on the INCOMING edge (120,100)->(40,100) instead.
  graph.outline.outer = {
      {20, 200}, {0, 200}, {0, 0}, {20, 0}, {120, 0}, {120, 100}, {40, 100},
  };

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {20, 200};
  bend.hingeB = {20, 0};
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* child = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "child") child = &p;
  }
  REQUIRE(child != nullptr);

  double sb = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
  Point2 expectedCrossing{20.0 + sb, 100.0};  // (45, 100)

  double closestToCrossing = 1e18;
  bool foundRawTabTip = false;
  for (const auto& v : child->wallOuter) {
    closestToCrossing =
        std::min(closestToCrossing, std::hypot(v.x - expectedCrossing.x, v.y - expectedCrossing.y));
    if (std::hypot(v.x - 40.0, v.y - 100.0) < 1e-6) foundRawTabTip = true;
  }
  INFO("closest wallOuter vertex to the true incoming-edge crossing ("
       << expectedCrossing.x << "," << expectedCrossing.y << ") is " << closestToCrossing << "mm away");
  CHECK(closestToCrossing < 1e-6);
  CHECK_FALSE(foundRawTabTip);

  // The resulting wallOuter must be a valid, non-self-intersecting polygon --
  // the original bug's downstream symptom (extruding it produced an invalid
  // solid).
  size_t n = child->wallOuter.size();
  bool selfIntersects = false;
  for (size_t i = 0; i < n && !selfIntersects; ++i) {
    Point2 a0 = child->wallOuter[i], a1 = child->wallOuter[(i + 1) % n];
    for (size_t j = i + 2; j < n; ++j) {
      if (i == 0 && j == n - 1) continue;
      Point2 b0 = child->wallOuter[j], b1 = child->wallOuter[(j + 1) % n];
      Point2 d1{a1.x - a0.x, a1.y - a0.y}, d2{b1.x - b0.x, b1.y - b0.y};
      double denom = d1.x * d2.y - d1.y * d2.x;
      if (std::fabs(denom) < 1e-9) continue;
      double t = ((b0.x - a0.x) * d2.y - (b0.y - a0.y) * d2.x) / denom;
      double u = ((b0.x - a0.x) * d1.y - (b0.y - a0.y) * d1.x) / denom;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) selfIntersects = true;
    }
  }
  CHECK_FALSE(selfIntersects);
}

// Mirror of the test above, for the vertex immediately AFTER hingeB (the
// symmetric gap fixed in BuildCutEdges' own nextB loop). Live bug
// (tab_bracket_90deg.stp @ default_bend_radius_mm=2): the same self-
// intersection, but on the other side of the hinge.
TEST_CASE("GraphEvaluator: an angled tab immediately after hingeB, fully "
          "inside the setback band, is dropped at the true incoming-edge "
          "crossing -- not left at its raw position",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 25.0;
  double kFactor = 0.0;
  double angleDeg = -90.0;

  PartGraphSpec graph;
  graph.partId = "tab_after_hingeB";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  // hingeA(20,200)->parent(0,200)->parent(0,0)->hingeB(20,0)->child tab tip
  // (40,100)->child(120,100)->child(120,200)->back to hingeA. Same tab-tip
  // geometry as the prevA test above, mirrored onto hingeB's own side.
  graph.outline.outer = {
      {20, 200}, {0, 200}, {0, 0}, {20, 0}, {40, 100}, {120, 100}, {120, 200},
  };

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {20, 200};
  bend.hingeB = {20, 0};
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* child = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "child") child = &p;
  }
  REQUIRE(child != nullptr);

  double sb = radiusMm * std::tan(std::fabs(angleDeg) * kTestPi / 180.0 / 2.0);
  Point2 expectedCrossing{20.0 + sb, 100.0};  // (45, 100)

  double closestToCrossing = 1e18;
  bool foundRawTabTip = false;
  for (const auto& v : child->wallOuter) {
    closestToCrossing =
        std::min(closestToCrossing, std::hypot(v.x - expectedCrossing.x, v.y - expectedCrossing.y));
    if (std::hypot(v.x - 40.0, v.y - 100.0) < 1e-6) foundRawTabTip = true;
  }
  INFO("closest wallOuter vertex to the true incoming-edge crossing ("
       << expectedCrossing.x << "," << expectedCrossing.y << ") is " << closestToCrossing << "mm away");
  CHECK(closestToCrossing < 1e-6);
  CHECK_FALSE(foundRawTabTip);

  size_t n = child->wallOuter.size();
  bool selfIntersects = false;
  for (size_t i = 0; i < n && !selfIntersects; ++i) {
    Point2 a0 = child->wallOuter[i], a1 = child->wallOuter[(i + 1) % n];
    for (size_t j = i + 2; j < n; ++j) {
      if (i == 0 && j == n - 1) continue;
      Point2 b0 = child->wallOuter[j], b1 = child->wallOuter[(j + 1) % n];
      Point2 d1{a1.x - a0.x, a1.y - a0.y}, d2{b1.x - b0.x, b1.y - b0.y};
      double denom = d1.x * d2.y - d1.y * d2.x;
      if (std::fabs(denom) < 1e-9) continue;
      double t = ((b0.x - a0.x) * d2.y - (b0.y - a0.y) * d2.x) / denom;
      double u = ((b0.x - a0.x) * d1.y - (b0.y - a0.y) * d1.x) / denom;
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) selfIntersects = true;
    }
  }
  CHECK_FALSE(selfIntersects);
}

// Live-app report (2026-09, testcube.step: Protrusion 1 fused onto "Component
// 1 Part 1", then merge_bodies_with_bend against Component 2): the corner
// where the fold meets a fuse_bodies seam renders as a cross with two
// protrusions in line with the panels, instead of a clean rounded fold.
//
// Hypothesis, tested here directly at the GraphEvaluator level: the isA&&isB
// branch in BuildCutEdges (this file) assumes two bends sharing a ring vertex
// always have hinge lines that truly converge to one miter point. But a
// fuse_bodies seam landing exactly on an existing straight fold line produces
// TWO BendSpecs whose hinge lines are COLLINEAR (not converging at an angle)
// -- e.g. one long top edge, folded in two pieces at different angles either
// side of the seam. LineIntersect2 on two parallel lines returns nullopt, so
// the code falls back to `cuts[outerA].parentShiftA` alone for BOTH
// `edges[parentBridgeIdx[outerA]].to` and `edges[parentBridgeIdx[outerB]]
// .from` -- silently ignoring bend B's own, DIFFERENT setback whenever its
// angle/radius differ from bend A's. That leaves bend B's own parent-side
// wall edge starting from the WRONG point (bend A's setback, not its own),
// producing exactly the small in-line jog/tab the live report describes.
TEST_CASE("GraphEvaluator: two bends sharing a corner vertex on a COLLINEAR "
          "hinge line (a fuse seam landing on an existing fold line) each "
          "keep their own true setback distance, not each other's",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 1.0;
  double kFactor = 0.4;

  PartGraphSpec graph;
  graph.partId = "collinear_corner";
  graph.rootRegionPanelId = "base";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  // One straight top edge (y=100, x in [0,300]) subdivided at x=150 into two
  // separate bends -- exactly what a fuse_bodies seam landing on an existing
  // fold line produces. The two bends fold in the SAME direction (both
  // toward +y) but at DIFFERENT angles, so their in-plane setbacks differ.
  graph.outline.outer = {
      {0, 0}, {300, 0}, {300, 100}, {150, 100}, {0, 100},
  };

  BendSpec bendLeft;
  bendLeft.id = "bendLeft";
  bendLeft.parentRegionPanelId = "base";
  bendLeft.childRegionPanelId = "childLeft";
  bendLeft.hingeA = {150, 100};
  bendLeft.hingeB = {0, 100};
  bendLeft.angleDeg = 90.0;
  bendLeft.radiusMm = radiusMm;
  bendLeft.kFactor = kFactor;
  graph.bends.push_back(bendLeft);

  BendSpec bendRight;
  bendRight.id = "bendRight";
  bendRight.parentRegionPanelId = "base";
  bendRight.childRegionPanelId = "childRight";
  bendRight.hingeA = {300, 100};
  bendRight.hingeB = {150, 100};
  bendRight.angleDeg = 45.0;  // deliberately different from bendLeft's 90deg
  bendRight.radiusMm = radiusMm;
  bendRight.kFactor = kFactor;
  graph.bends.push_back(bendRight);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 2);

  const RegionPanelLayout* base = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "base") base = &p;
  }
  REQUIRE(base != nullptr);

  // wallOuter (RegionOf's non-zero-setback pass, via BuildBendCuts) is where
  // this shows up -- NOT bottomFace/topFace (the zeroOffset=true pass, where
  // every bend's shift collapses to the raw hinge point regardless of angle,
  // so the two bends' setbacks can never disagree there). Both bends share
  // nLeft=(0,-1) (identical hinge direction, hence identical normal), so
  // bendLeft's own near-corner point is exactly hingeA + radius*tan(45deg)
  // along nLeft = (150, 100-1.0) = (150, 99.0), and bendRight's own is
  // hingeB + radius*tan(22.5deg) along nLeft = (150, 100-0.41421356...) =
  // (150, 99.58578644). These are genuinely different points -- a correct
  // corner must keep both distinct (joined by a short connecting edge, the
  // same pattern already used for the isB&&!isA / isA&&!isB free-edge case
  // above), not collapse to one.
  double sbLeft = radiusMm * std::tan(90.0 * kTestPi / 180.0 / 2.0);
  double sbRight = radiusMm * std::tan(45.0 * kTestPi / 180.0 / 2.0);
  Point2 expectedLeftPoint{150.0, 100.0 - sbLeft};
  Point2 expectedRightPoint{150.0, 100.0 - sbRight};

  auto closestDistTo = [&](const Point2& target) {
    double best = 1e18;
    for (const auto& v : base->wallOuter) {
      best = std::min(best, std::hypot(v.x - target.x, v.y - target.y));
    }
    return best;
  };

  double distToLeftPoint = closestDistTo(expectedLeftPoint);
  double distToRightPoint = closestDistTo(expectedRightPoint);
  INFO("bendLeft's own near-corner point (150, " << expectedLeftPoint.y
       << ") -- closest wallOuter vertex is " << distToLeftPoint << "mm away");
  INFO("bendRight's own near-corner point (150, " << expectedRightPoint.y
       << ") -- closest wallOuter vertex is " << distToRightPoint << "mm away");
  CHECK(distToLeftPoint < 1e-6);
  CHECK(distToRightPoint < 1e-6);
}

// Live-app case, more precisely: the bend's own EDGE is longer than its
// HINGE (a partial-width seam -- Protrusion 1 widens the fused composite
// past where it actually contacts Component 2, so merge_bodies_with_bend's
// new hinge is shorter than the composite's own edge there), and the
// hinge's OTHER (grounded, non-free) end lands exactly at a real
// PERPENDICULAR corner with a second, pre-existing bend (Component 1 Part
// 1's own fold from the original decompose_volume). This directly checks
// whether ConstructPartSolid's OWN bridge-tangent-point formula
// (`bottomFace[i] + setbackMm*nLeftWorld`, part_solid_construction.cc) at
// that shared corner agrees with RegionOf's own corner-miter computation
// (BuildCutEdges' isA&&isB branch, which computes a genuine line
// intersection -- the value wallOuter uses and the wall SOLID is built
// from). Both consumers read the SAME `parent.bottomFace`/`edgeBendId`
// arrays this file's own header comment claims are already correct at a
// bend's real corners -- this test checks whether the REVOLVE's own
// re-derived tangent point (not just wallOuter) actually lands there too.
TEST_CASE("GraphEvaluator: a bend whose hinge is shorter than its own panel "
          "edge, grounded at a real perpendicular corner with a second bend "
          "-- ConstructPartSolid's own tangent-point formula vs the true "
          "corner miter",
          "[translation][regression]") {
  double thicknessMm = 1.5;
  double radiusMm = 1.0;
  double kFactor = 0.4;

  PartGraphSpec graph;
  graph.partId = "long_edge_short_hinge_corner";
  graph.rootRegionPanelId = "base";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  // Top edge (y=100) runs the full x=[0,200], but bendTop's own hinge only
  // covers x=[0,150] -- the composite's own edge (0-200) is LONGER than the
  // hinge (0-150), leaving a FREE edge from (200,100) to (150,100),
  // collinear with the hinge line, exactly the "edge longer than hinge"
  // case. bendTop's OTHER, grounded end (0,100) lands exactly on bendLeft's
  // own hingeA -- a genuine PERPENDICULAR (non-collinear) two-bend corner,
  // the ordinary box-corner case, not the parallel-hinge case above.
  graph.outline.outer = {
      {0, 0}, {200, 0}, {200, 100}, {150, 100}, {0, 100},
  };

  BendSpec bendTop;
  bendTop.id = "bendTop";
  bendTop.parentRegionPanelId = "base";
  bendTop.childRegionPanelId = "childTop";
  bendTop.hingeA = {150, 100};
  bendTop.hingeB = {0, 100};
  bendTop.angleDeg = 90.0;
  bendTop.radiusMm = radiusMm;
  bendTop.kFactor = kFactor;
  graph.bends.push_back(bendTop);

  BendSpec bendLeft;
  bendLeft.id = "bendLeft";
  bendLeft.parentRegionPanelId = "base";
  bendLeft.childRegionPanelId = "childLeft";
  bendLeft.hingeA = {0, 100};
  bendLeft.hingeB = {0, 0};
  bendLeft.angleDeg = 90.0;
  bendLeft.radiusMm = radiusMm;
  bendLeft.kFactor = kFactor;
  graph.bends.push_back(bendLeft);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 2);

  const RegionPanelLayout* base = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "base") base = &p;
  }
  REQUIRE(base != nullptr);

  const BridgeLayout* bridgeTop = nullptr;
  const BridgeLayout* bridgeLeft = nullptr;
  for (auto& b : result.bridges) {
    if (b.bendId == "bendTop") bridgeTop = &b;
    if (b.bendId == "bendLeft") bridgeLeft = &b;
  }
  REQUIRE(bridgeTop != nullptr);
  REQUIRE(bridgeLeft != nullptr);

  // The TRUE corner miter: the two bends' own parent-side offset LINES
  // (point + direction, exactly BuildBendCuts' own parentShiftA/B + hinge
  // direction) actually intersect at an angle here (a genuine converging
  // corner, not the parallel/collinear case the earlier test covers) --
  // computed independently by hand, from the same raw hinge points and
  // nLeftWorld/setbackMm this test already confirmed match the production
  // bridge data, NOT by guessing which wallOuter vertex is "closest" to the
  // raw corner (a child-side point can be numerically closer than the true
  // parent-side miter, as this test's own earlier revision discovered the
  // hard way).
  auto parentShift = [](const Point2& hinge, const Point3& nLeftWorld, double setbackMm) {
    return Point2{hinge.x + setbackMm * nLeftWorld.x, hinge.y + setbackMm * nLeftWorld.y};
  };
  // bendLeft's own parent-side line: point=parentShiftA(hingeA=(0,100)), direction=hingeB-hingeA.
  Point2 pA = parentShift({0.0, 100.0}, bridgeLeft->nLeftWorld, bridgeLeft->setbackMm);
  Point2 dA{0.0 - 0.0, 0.0 - 100.0};  // bendLeft.hingeB - bendLeft.hingeA
  // bendTop's own parent-side line: point=parentShiftB(hingeB=(0,100)), direction=hingeB-hingeA.
  Point2 pB = parentShift({0.0, 100.0}, bridgeTop->nLeftWorld, bridgeTop->setbackMm);
  Point2 dB{0.0 - 150.0, 100.0 - 100.0};  // bendTop.hingeB - bendTop.hingeA
  double denom = dA.x * dB.y - dA.y * dB.x;
  REQUIRE(std::fabs(denom) > 1e-9);  // must be a genuine converging (non-parallel) corner
  double t = ((pB.x - pA.x) * dB.y - (pB.y - pA.y) * dB.x) / denom;
  Point2 trueMiter{pA.x + dA.x * t, pA.y + dA.y * t};
  INFO("true corner miter (hand-computed intersection) = (" << trueMiter.x << ", " << trueMiter.y << ")");

  // ConstructPartSolid's ACTUAL mechanism after the fix: FindZoneEdges reads
  // wallOuter/wallEdgeBendId directly (part_solid_construction.cc), and the
  // revolve's own tangent points ARE wallBottomFace/wallTopFace at those
  // same indices -- no separate re-derivation.
  REQUIRE(base->wallBottomFace.size() == base->wallOuter.size());
  auto findWallZoneEdges = [&](const std::string& bendId) {
    std::vector<size_t> found;
    for (size_t i = 0; i < base->wallEdgeBendId.size(); ++i) {
      if (base->wallEdgeBendId[i] == bendId) found.push_back(i);
    }
    return found;
  };

  // Each bend's own revolve construction must include, among its own
  // wall-tagged edges' endpoints, this EXACT shared miter point -- not
  // "some point near the corner" (both bends also have unrelated
  // child-side/far-end points nearby), the literal same coordinate both
  // bends fold around.
  for (const auto* bridge : {bridgeTop, bridgeLeft}) {
    bool found = false;
    double bestDist = 1e18;
    for (size_t i0 : findWallZoneEdges(bridge->bendId)) {
      size_t i1 = (i0 + 1) % base->wallOuter.size();
      for (size_t idx : {i0, i1}) {
        Point3 b = base->wallBottomFace[idx];
        double d = std::hypot(b.x - trueMiter.x, b.y - trueMiter.y);
        bestDist = std::min(bestDist, d);
        if (d < 1e-6) found = true;
      }
    }
    INFO(bridge->bendId << "'s own closest wall-tagged point to the true miter ("
         << trueMiter.x << ", " << trueMiter.y << ") is " << bestDist << "mm away");
    CHECK(found);
  }
}

// DIAGNOSTIC (rebuild/20-bend-bridge-geometry.md Ch. 5 Phase 2 investigation):
// reproduces the exact Chapter 5 counterexample fixture (single 90deg bend,
// r=t=0.95mm, outline (0,0)-(20,40), hinge at y=20, child below) and reports
// each of the child panel's own tangent-line points' distance from the axis
// childPose ACTUALLY rotates about (bridge.pivotOriginWorld/pivotAxisWorld),
// via wallBottomFace/wallTopFace (the "already correctly trimmed" values)
// -- checking directly whether they land at the expected radius (r or R) or
// not, rather than assuming either.
TEST_CASE("GraphEvaluator: DIAGNOSTIC -- Chapter 5 counterexample fixture, "
          "wallBottomFace/wallTopFace tangency against the real pivot axis",
          "[translation][diagnostic]") {
  PartGraphSpec graph;
  graph.partId = "test-part";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = 0.95;
  graph.outline.outer = {{0, 0}, {20, 0}, {20, 40}, {0, 40}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {20, 20};
  bend.hingeB = {0, 20};
  bend.angleDeg = 90.0;
  bend.radiusMm = 0.95;
  bend.kFactor = 0.0;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 2);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* child = nullptr;
  const RegionPanelLayout* parent = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "child") child = &p;
    if (p.regionPanelId == "parent") parent = &p;
  }
  REQUIRE(child != nullptr);
  REQUIRE(parent != nullptr);
  const BridgeLayout& bridge = result.bridges[0];

  for (size_t i = 0; i < parent->wallOuter.size(); ++i) {
    const Point3& b = parent->wallBottomFace[i];
    const Point3& t = parent->wallTopFace[i];
    WARN("parent wallOuter[" << i << "]=(" << parent->wallOuter[i].x << ","
         << parent->wallOuter[i].y << ") edgeBendId=" << parent->wallEdgeBendId[i]
         << " wallBottomFace=(" << b.x << "," << b.y << "," << b.z << ")"
         << " wallTopFace=(" << t.x << "," << t.y << "," << t.z << ")");
  }

  INFO("pivotOriginWorld=(" << bridge.pivotOriginWorld.x << "," << bridge.pivotOriginWorld.y
       << "," << bridge.pivotOriginWorld.z << ")");
  INFO("pivotAxisWorld=(" << bridge.pivotAxisWorld.x << "," << bridge.pivotAxisWorld.y << ","
       << bridge.pivotAxisWorld.z << ")");
  INFO("setbackMm=" << bridge.setbackMm << " angleDeg=" << bridge.angleDeg);
  INFO("childNLeftWorld=(" << bridge.childNLeftWorld.x << "," << bridge.childNLeftWorld.y << ","
       << bridge.childNLeftWorld.z << ")");
  WARN("expected inner radius(r)=0.95, outer radius(R=r+t)=1.9");

  auto distFromAxis = [&](const Point3& p) -> double {
    Point3 v{p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
             p.z - bridge.pivotOriginWorld.z};
    double along = v.x * bridge.pivotAxisWorld.x + v.y * bridge.pivotAxisWorld.y +
                    v.z * bridge.pivotAxisWorld.z;
    Point3 perp{v.x - along * bridge.pivotAxisWorld.x, v.y - along * bridge.pivotAxisWorld.y,
                v.z - along * bridge.pivotAxisWorld.z};
    return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
  };

  for (size_t i = 0; i < child->wallOuter.size(); ++i) {
    const Point3& b = child->wallBottomFace[i];
    const Point3& t = child->wallTopFace[i];
    WARN("wallOuter[" << i << "]=(" << child->wallOuter[i].x << "," << child->wallOuter[i].y
         << ") edgeBendId=" << child->wallEdgeBendId[i]
         << " wallBottomFace=(" << b.x << "," << b.y << "," << b.z << ") dist=" << distFromAxis(b)
         << " wallTopFace=(" << t.x << "," << t.y << "," << t.z << ") dist=" << distFromAxis(t));
  }
  for (size_t i = 0; i < child->rawOuter.size(); ++i) {
    WARN("rawOuter[" << i << "]=(" << child->rawOuter[i].x << "," << child->rawOuter[i].y
         << ") edgeBendId=" << child->edgeBendId[i]
         << " bottomFace dist=" << distFromAxis(child->bottomFace[i])
         << " topFace dist=" << distFromAxis(child->topFace[i]));
  }
}

// DIAGNOSTIC, NOT a settled correctness check: distance from the axis (what
// every other tangency probe in this file checks) is blind to direction -- a
// point diametrically opposite the correct one is the same distance away and
// passes identically. This check is stronger (it requires parent's own real
// wall tangent point, rotated by the bend's own angleDeg about the bridge's
// true axis, to land EXACTLY on child's own real wall tangent point) but it
// is STILL NOT SUFFICIENT: it only proves parent and child agree with EACH
// OTHER, not that the shared axis is in the physically correct place. A
// formula that places both panels' tangent points outside their own material
// in the same consistent way passes this check while still being wrong --
// confirmed directly: this test passes against the current, un-fixed
// formula, while direct 3D visualization of the same fixture shows the
// tangent point landing outside the panel. Kept as a partial check and a
// record of this gap, not as evidence of correctness. Reproduces the exact
// failing fixture from part_solid_construction_test.cc ("radius==thickness,
// no wing/T-shape").
TEST_CASE("GraphEvaluator: DIAGNOSTIC -- parent's wall tangent point, rotated "
          "by the bend's own angle about the true axis, must land exactly on "
          "child's wall tangent point",
          "[translation][diagnostic]") {
  double thicknessMm = 0.95;
  double radiusMm = 0.95;
  double kFactor = 0.4;

  PartGraphSpec graph;
  graph.partId = "simplest";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {{0, 0}, {20, 0}, {20, 40}, {0, 40}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {20, 20};
  bend.hingeB = {0, 20};
  bend.angleDeg = -90.0;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* parent = nullptr;
  const RegionPanelLayout* child = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "parent") parent = &p;
    if (p.regionPanelId == "child") child = &p;
  }
  REQUIRE(parent != nullptr);
  REQUIRE(child != nullptr);
  const BridgeLayout& bridge = result.bridges[0];

  Transform3 trueRotation = Transform3::RotationAboutAxis(
      bridge.pivotOriginWorld, bridge.pivotAxisWorld, bridge.angleDeg);

  auto dist3 = [](const Point3& a, const Point3& b) {
    return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) +
                      (a.z - b.z) * (a.z - b.z));
  };
  size_t n = parent->wallOuter.size();
  size_t nc = child->wallOuter.size();
  for (size_t i = 0; i < parent->wallEdgeBendId.size(); ++i) {
    if (parent->wallEdgeBendId[i] != bridge.bendId) continue;
    size_t i1 = (i + 1) % n;
    for (size_t ii : {i, i1}) {
      Point3 predictedBottom = trueRotation.Apply(parent->wallBottomFace[ii]);
      Point3 predictedTop = trueRotation.Apply(parent->wallTopFace[ii]);

      double bestBottomDist = 1e18, bestTopDist = 1e18;
      for (size_t j = 0; j < nc; ++j) {
        bestBottomDist = std::min(bestBottomDist, dist3(predictedBottom, child->wallBottomFace[j]));
        bestTopDist = std::min(bestTopDist, dist3(predictedTop, child->wallTopFace[j]));
      }
      WARN("parent wall vertex " << ii << ": predictedBottom=(" << predictedBottom.x << ","
           << predictedBottom.y << "," << predictedBottom.z
           << ") closest child wallBottomFace dist=" << bestBottomDist);
      WARN("parent wall vertex " << ii << ": predictedTop=(" << predictedTop.x << ","
           << predictedTop.y << "," << predictedTop.z
           << ") closest child wallTopFace dist=" << bestTopDist);
      CHECK(bestBottomDist < 1e-6);
      CHECK(bestTopDist < 1e-6);
    }
  }
}

// The numeric containment check the self-consistency and distance-only
// checks above cannot do: does the bend's own tangent point actually land
// INSIDE the panel it's supposed to trim? Converts each panel's own wall
// tangent point into the shared 2D flat-pattern coordinate (the same frame
// BuildBendCuts/wallOuter already use) and runs a point-in-polygon test
// against that SAME panel's own raw, un-trimmed 2D outline (panel.rawOuter)
// -- the actual authored material boundary, not a derived/rotated proxy.
// Reproduces the exact failing fixture from part_solid_construction_test.cc
// ("radius==thickness, no wing/T-shape").
TEST_CASE("GraphEvaluator: DIAGNOSTIC -- bend tangent point numerically "
          "inside each panel's own raw 2D outline (point-in-polygon, not "
          "distance-from-axis)",
          "[translation][diagnostic]") {
  double thicknessMm = 0.95;
  double radiusMm = 0.95;
  double kFactor = 0.4;

  PartGraphSpec graph;
  graph.partId = "simplest";
  graph.rootRegionPanelId = "parent";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {{0, 0}, {20, 0}, {20, 40}, {0, 40}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "parent";
  bend.childRegionPanelId = "child";
  bend.hingeA = {20, 20};
  bend.hingeB = {0, 20};
  bend.angleDeg = -90.0;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.bridges.size() == 1);

  const RegionPanelLayout* parent = nullptr;
  const RegionPanelLayout* child = nullptr;
  for (auto& p : result.panels) {
    if (p.regionPanelId == "parent") parent = &p;
    if (p.regionPanelId == "child") child = &p;
  }
  REQUIRE(parent != nullptr);
  REQUIRE(child != nullptr);
  const BridgeLayout& bridge = result.bridges[0];

  auto checkPanel = [&](const char* label, const RegionPanelLayout& panel) {
    int checked = 0;
    size_t n = panel.wallOuter.size();
    for (size_t i = 0; i < panel.wallEdgeBendId.size(); ++i) {
      if (panel.wallEdgeBendId[i] != bridge.bendId) continue;
      // The tangent line's own endpoints can legitimately sit exactly on
      // the panel's boundary (e.g. a hinge spanning the panel's full width
      // touches both side edges) -- a genuine ray-casting ambiguity, not a
      // containment failure. The edge's MIDPOINT has no such ambiguity: it
      // is strictly inside the panel if and only if the tangent trim is
      // correctly positioned.
      const Point2& a = panel.wallOuter[i];
      const Point2& b = panel.wallOuter[(i + 1) % n];
      Point2 mid{(a.x + b.x) / 2.0, (a.y + b.y) / 2.0};
      bool inside = TestPointInPolygon(mid, panel.rawOuter);
      WARN(label << " tangent edge midpoint (" << mid.x << "," << mid.y
           << ") inside own rawOuter=" << (inside ? "true" : "false"));
      CHECK(inside);
      ++checked;
    }
    CHECK(checked > 0);
  };
  checkPanel("parent", *parent);
  checkPanel("child", *child);
}

// DIAGNOSTIC (rebuild/20-bend-bridge-geometry.md Ch. 5 Phase 2, EXPERIMENT 3):
// a genuine 2-bend chain (seg0 -> seg1 -> seg2), checking wallBottomFace/
// wallTopFace tangency INDEPENDENTLY at each bend, to isolate whether a
// per-bend correction (bend1, seg0->seg1, no ancestor) behaves differently
// from a chained one (bend2, seg1->seg2, seg1 already carries bend1's own
// correction) -- with childExtension's coefficient set to 0.0 (see the
// pose-walk's own EXPERIMENT 3 comment).
TEST_CASE("GraphEvaluator: DIAGNOSTIC -- 2-bend chain, wallBottomFace/"
          "wallTopFace tangency at EACH bend independently",
          "[translation][diagnostic]") {
  double radiusMm = 0.95, thicknessMm = 0.95, kFactor = 0.0;
  auto graph = MakeStrip(3, 20.0, 10.0, thicknessMm, 90.0, radiusMm, kFactor);

  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 3);
  REQUIRE(result.bridges.size() == 2);

  auto distFromAxis = [](const BridgeLayout& bridge, const Point3& p) -> double {
    Point3 v{p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
             p.z - bridge.pivotOriginWorld.z};
    double along = v.x * bridge.pivotAxisWorld.x + v.y * bridge.pivotAxisWorld.y +
                    v.z * bridge.pivotAxisWorld.z;
    Point3 perp{v.x - along * bridge.pivotAxisWorld.x, v.y - along * bridge.pivotAxisWorld.y,
                v.z - along * bridge.pivotAxisWorld.z};
    return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
  };

  for (const auto& bridge : result.bridges) {
    const RegionPanelLayout* childPanel = nullptr;
    for (auto& p : result.panels) {
      if (p.regionPanelId == bridge.childRegionPanelId) childPanel = &p;
    }
    REQUIRE(childPanel != nullptr);
    WARN("bend=" << bridge.bendId << " parent=" << bridge.parentRegionPanelId
         << " child=" << bridge.childRegionPanelId);
    for (size_t i = 0; i < childPanel->wallOuter.size(); ++i) {
      if (childPanel->wallEdgeBendId[i] != bridge.bendId) continue;
      WARN("  wallOuter[" << i << "]=(" << childPanel->wallOuter[i].x << ","
           << childPanel->wallOuter[i].y << ") wallBottomFace dist="
           << distFromAxis(bridge, childPanel->wallBottomFace[i])
           << " wallTopFace dist=" << distFromAxis(bridge, childPanel->wallTopFace[i])
           << " (expected r=" << radiusMm << " R=" << radiusMm + thicknessMm << ")");
    }
  }
}

