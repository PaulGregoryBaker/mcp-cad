#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"

#include <array>
#include <cmath>

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

// Same pivot-offset formula manufacturing_graph_evaluator.cc's Evaluate() uses
// (duplicated here for the same reason TestBendAllowanceMm is). This is the ONLY
// z-height (relative to the panel's own bottom/z=0 surface) that sits exactly ON
// the fold's rotation axis — every other z-height sweeps around it and picks up a
// residual translation once the fold's own radius is nonzero, so it is the correct
// reference for a raw flat-corner closure check, not z=0 (z=0 only happens to
// coincide with the pivot for a mountain fold at radiusMm=0).
double TestPivotZOffset(double angleDeg, double radiusMm, double thicknessMm) {
  bool isMountain = angleDeg >= 0.0;
  double rBottom = isMountain ? radiusMm : radiusMm + thicknessMm;
  return isMountain ? -rBottom : rBottom;
}

// The outline's own totalLen (segments*segLenMm + bendCount*ba, MINUS
// thicknessMm if MakeStrip's closesLoop setback was applied) is the correct
// query for the FLAT PATTERN's own far edge for most purposes — but NOT for the
// 3D closure check here: closure implicitly treats segLast as if one more
// (virtual, unmodelled) bend followed it, closing back onto seg0 — and that
// virtual bend's own zone would consume another halfBa of material beyond
// segLast's raw far edge. Solved and verified empirically (independent
// complex-number re-derivation of the whole chain, exact to 1e-12): the correct
// closure query is the outline's totalLen PLUS half of the last bend's own bend
// allowance — and, since this is a mathematically exact closure check
// independent of MakeStrip's own visual/construction closing setback, PLUS
// thicknessMm back too when that setback was applied (closesLoop=true),
// undoing it for this specific query.
double TestClosureFarX(double totalLen, double angleDeg, double radiusMm, double kFactor,
                        double thicknessMm, bool closesLoop) {
  return totalLen + TestBendAllowanceMm(angleDeg, radiusMm, kFactor, thicknessMm) / 2.0 +
         (closesLoop ? thicknessMm : 0.0);
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
// Outline length is NOT simply `segments * segmentLenMm`, for two independent
// reasons:
//
// 1. BoundingBends/RegionOf clip each bend-adjacent panel edge by half the bend
//    allowance (BA/2), so without compensation every interior panel's clipped
//    region would come out BA narrower than intended — this ALWAYS applies.
// 2. If (and only if) the strip is authored to CLOSE into a loop
//    (`closesLoop=true`), the last panel's own free end and the root's own free
//    end (seg0's x=0) are the two surfaces that would otherwise physically
//    coincide/overlap at the closing corner — a single thickness's worth of
//    setback on the outline's own far edge (NOT one per panel — only the last
//    panel's free end is pulled back) is what lets them meet without intruding
//    on each other. An open (non-closing) strip has no such corner and needs no
//    setback at all, hence this is opt-in, not automatic (a test-authoring
//    convention, not something ManufacturingGraphEvaluator itself computes or
//    assumes).
//
// Hinge k (1-indexed) sits at `k*segmentLenMm + (k-0.5)*ba` (full nominal
// spacing, unaffected by the closing setback), and the total outline length is
// `segments*segmentLenMm + (segments-1)*ba`, minus `thicknessMm` if closesLoop.
PartGraphSpec MakeStrip(int segments, double segmentLenMm, double widthMm,
                        double thicknessMm, double angleDeg, double radiusMm = 0.0,
                        double kFactor = 0.0, double hingeTiltDeg = 0.0,
                        double hingeYOffsetMm = 0.0,
                        Transform3 anchor = Transform3::Identity(),
                        bool closesLoop = false) {
  PartGraphSpec graph;
  graph.partId = "test-part";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = anchor;

  double ba = TestBendAllowanceMm(angleDeg, radiusMm, kFactor, thicknessMm);
  int bendCount = segments - 1;
  double totalLen = segments * segmentLenMm + bendCount * ba - (closesLoop ? thicknessMm : 0.0);

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
    double hx = (i + 1) * segmentLenMm + (i + 0.5) * ba;
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

  // Closure holds exactly at the fold's own pivot height, not necessarily z=0 —
  // see TestPivotZOffset's comment. seg0's pose is identity here, so its own
  // bottom-relative pivot offset applies directly to its query height too.
  double z = TestPivotZOffset(90.0, radiusMm, thicknessMm);
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  Point3 start1 = seg0->pose.Apply({0, 50, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, 90.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
  Point3 end1 = segLast->pose.Apply({farX, 50, z});

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
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, -90.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
  CHECK(Dist(start0, end0) < 1e-6);
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
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  Point3 start1 = seg0->pose.Apply({0, 40, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, 72.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
  Point3 end1 = segLast->pose.Apply({farX, 40, z});

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
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, -72.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
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
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  Point3 start1 = seg0->pose.Apply({0, 40, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, 60.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
  Point3 end1 = segLast->pose.Apply({farX, 40, z});

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
  Point3 start0 = seg0->pose.Apply({0, 0, z});
  double farX = TestClosureFarX(graph.outline.outer[1].x, -60.0, radiusMm, kFactor, thicknessMm, true);
  Point3 end0 = segLast->pose.Apply({farX, 0, z});
  CHECK(Dist(start0, end0) < 1e-6);
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
    double farX = TestClosureFarX(graph.outline.outer[1].x, angle, radiusMm, kFactor, thicknessMm, true);
    Point3 start0 = seg0->pose.Apply({0, 0, z});
    Point3 end0 = segLast->pose.Apply({farX, 0, z});
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

    double z = TestPivotZOffset(bendDeg, 0.0, thicknessMm);
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

    double z = TestPivotZOffset(bendDeg, 0.0, thicknessMm);
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
    double z = TestPivotZOffset(bend4, 0.0, t4);
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
    double farX = TestClosureFarX(graph.outline.outer[1].x, angle, radiusMm, kFactor, thicknessMm, true);
    Point3 start0 = seg0->pose.Apply({0, 0, z});
    Point3 end0 = segLast->pose.Apply({farX, 0, z});
    // Same 1e-6mm closure tolerance as the identity-anchor sweep above — closure
    // is a property of the fold chain alone and must not degrade just because the
    // whole part sits at an arbitrary, non-axis-aligned orientation in world space.
    CHECK(Dist(start0, end0) < 1e-6);
  }
}

// ─── OPEN INVESTIGATION: does a panel's own far, free corner stay at a fixed ──
// ─── world position when nominal leg length is held fixed and only R varies? ──
//
// Real-world sheet-metal expectation: for a bracket with a SPECIFIED leg length,
// forming it with a bigger or smaller bend-radius tool should not move the far
// (free) end of the leg — only the shape of the corner itself should change.
// This test documents MakeStrip's CURRENT actual behaviour (segmentLenMm -
// thicknessMm as each panel's clipped length, independent of R) against that
// expectation — it is NOT yet known whether the current behaviour is correct,
// or whether MakeStrip's panel-length formula needs to become R-dependent (a
// standard "outside setback" style correction) to match it. Recorded here, with
// real numbers, as the concrete artifact for that open discussion rather than a
// throwaway scratch diagnostic — see the two `diag_tip_check`/`diag_flat_vs_built`
// investigations from this session for how these numbers were first found.
TEST_CASE("GraphEvaluator: far outer corner position for a fixed nominal leg "
          "length, across varying bend radius (documents current behaviour, "
          "NOT yet asserted correct)",
          "[translation][investigation]") {
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

  // Currently: the far corner MOVES substantially as R varies (does not match
  // the "fixed leg length -> fixed free end" real-world expectation) — recorded
  // here as a fact to review, not endorsed as intended behaviour. If/when the
  // panel-length formula changes to compensate for R, this assertion should
  // flip to CHECK(Dist(...) < some tight tolerance) instead.
  double driftFromR0 = Dist(farTopCorners.back(), farTopCorners.front());
  INFO("total drift from radiusMm=0 to radiusMm=" << radii.back() << ": " << driftFromR0
                                                    << "mm");
  CHECK(driftFromR0 > 1.0);
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
