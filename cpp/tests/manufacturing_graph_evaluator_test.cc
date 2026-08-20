#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"

#include <array>
#include <cmath>
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
  bool isMountain = angleDeg >= 0.0;
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
TEST_CASE("GraphEvaluator: sharp (r=0) N=3 closure — mountain matches the "
          "suite's independent zero-reference formula exactly; valley does "
          "NOT (real thickness-scale pivot offset), though both self-close",
          "[translation][closure][investigation]") {
  const double L = 60.0, widthMm = 40.0, thicknessMm = 1.0;
  const double bendDeg = 120.0;  // 360/3

  // closure_family.mjs's own checkpoint formula (independent re-derivation,
  // dirSign=+1 here — matches this test's "mountain" construction directly;
  // the JSON suite's "down" cases instead mirror the whole construction via a
  // world anchor rather than negating angleDeg — see this TEST_CASE's own
  // banner comment and the companion "up"/"down" anchor-mirror test below).
  auto zeroReferenceCheckpoint1 = [&](double dirSign) -> Point3 {
    double theta = 2.0 * kTestPi / 3.0;
    double vx = L, vz = 0.0;  // V_1 = L * d(0) = L*(1,0,0)
    double dkx = std::cos(theta), dkz = dirSign * std::sin(theta);
    return {vx + 2.0 * L * dkx, 0.0, vz + 2.0 * L * dkz};
  };

  SECTION("mountain (angleDeg=+bendDeg): exact match to the zero-reference formula") {
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, Transform3::Identity(),
                           /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = 0.0;  // bottom surface — meaningful check for nonzero R
    CHECK(z == Approx(0.0).margin(1e-12));  // mountain at r=0: pivot sits exactly on bottomFace
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(+1.0);
    CHECK(Dist(got, expected) < 1e-6);
  }

  SECTION("valley (angleDeg=-bendDeg): self-consistent closure, but a real "
          "thicknessMm-scale gap from the zero-reference formula") {
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, -bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, Transform3::Identity(),
                           /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = TestPivotZOffset(-bendDeg, 0.0, thicknessMm);
    CHECK(z == Approx(thicknessMm).margin(1e-12));  // valley at r=0: pivot is thicknessMm off bottomFace
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(-1.0);
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
    auto graph = MakeStrip(3, L, widthMm, thicknessMm, bendDeg, /*radiusMm=*/0.0,
                           /*kFactor=*/0.0, 0.0, 0.0, mirror, /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);
    const RegionPanelLayout* seg1 = nullptr;
    for (auto& p : result.panels) if (p.regionPanelId == "seg1") seg1 = &p;
    REQUIRE(seg1 != nullptr);

    double z = 0.0;  // bottom surface — meaningful check for nonzero R
    Point3 got = seg1->pose.Apply({3.0 * L, 0.0, z});
    Point3 expected = zeroReferenceCheckpoint1(-1.0);  // the suite's "down" checkpoint
    CHECK(Dist(got, expected) < 1e-6);
  }

  SECTION("N=4 confirms 180deg-about-X (not -Y) is the correct mirror once X "
          "is nonzero at a checkpoint") {
    const double L4 = 60.0, w4 = 40.0, t4 = 1.0, bend4 = 90.0;  // 360/4
    Transform3 mirrorX = Transform3::RotationAboutAxis({0, 0, 0}, {1, 0, 0}, 180.0);
    auto graph = MakeStrip(4, L4, w4, t4, bend4, /*radiusMm=*/0.0, /*kFactor=*/0.0,
                           0.0, 0.0, mirrorX, /*closesLoop=*/false);
    EvaluateResult result = Evaluate(graph);
    REQUIRE(result.ok);

    auto theta4 = 2.0 * kTestPi / 4.0;
    auto d4 = [&](int j, double dirSign) -> std::array<double, 2> {
      return {std::cos(j * theta4), dirSign * std::sin(j * theta4)};
    };
    double z = 0.0;  // bottom surface — meaningful check for nonzero R
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
        auto dPrev = d4(j, -1.0);
        vx += L4 * dPrev[0];
        vz += L4 * dPrev[1];
      }
      auto dk = d4(k, -1.0);
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

  // Child-side landing point (docs/BUG_REPORT_reconstructed_envelope_grows_
  // with_bend_radius.md). Rotating seg1's own bend-adjacent bottomFace/
  // topFace BACK by the bridge's own angle, about the bridge's own axis,
  // used to land it exactly on the raw hinge vertex — that was only true
  // because the child's own local frame wasn't extended at all. Now it's
  // extended by 2x this bend's own setback (radiusMm*tan(|angleDeg|/2)) —
  // the same per-bend, purely local quantity that also moves the axis — so
  // unfolding lands 2x setback further out along nLeft than the raw hinge,
  // never short of it, on either surface.
  Point2 hingeDir{bend.hingeB.x - bend.hingeA.x, bend.hingeB.y - bend.hingeA.y};
  double hingeDirLen = std::sqrt(hingeDir.x * hingeDir.x + hingeDir.y * hingeDir.y);
  Point2 nLeft{-hingeDir.y / hingeDirLen, hingeDir.x / hingeDirLen};
  double setbackMm = bend.radiusMm * std::tan(std::fabs(bend.angleDeg) * kTestPi / 180.0 / 2.0);
  double extend = 2.0 * setbackMm;

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

TEST_CASE("ComputeBendGeometry: setback matches the standard sheet-metal formula "
          "at a non-90-degree angle (90 alone can't distinguish tan(angle/2) "
          "from other plausible variants, e.g. cot(angle/2), which happen to "
          "coincide exactly at 90 degrees)",
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

    bool concave = angleDeg >= 0.0;
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
    bool concave = angleDeg >= 0.0;
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

