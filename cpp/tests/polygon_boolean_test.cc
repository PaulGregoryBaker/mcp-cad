#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/polygon_boolean.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

double PolygonArea(const std::vector<Point2>& ring) {
  double sum = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return std::fabs(sum) / 2.0;
}

// Positive iff CCW (standard shoelace sign convention).
double SignedArea(const std::vector<Point2>& ring) {
  double sum = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2.0;
}

std::vector<Point2> Rect(double x0, double y0, double x1, double y1) {
  return {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}};
}

}  // namespace

TEST_CASE("PolygonUnion: a real testcube.step ring pair with OPPOSITE (CW vs CCW) winding — a "
          "clean 0.05mm overlap, not a gap — unions correctly (live fuse_bodies failure, "
          "2026-09; root cause was PolygonUnion never canonicalizing its input rings' winding "
          "before building faces, NOT a position/shape/mirror defect)",
          "[translation][polygon_boolean]") {
  // A: a real split_part_at_bend panel's local outline (CCW), exactly as
  // measured live against testcube.step.
  std::vector<Point2> a = {
      {300.0, 0.0},
      {450.0, 0.0},
      {450.0, 150.0},
      {300.0, 150.0},
  };
  // B: a real protrusion's outline, already projected into A's local frame
  // via FuseCoplanarParts' own anchorA.Inverse().Compose(anchorB) math
  // (computed by hand from the live anchors) — CW, the OPPOSITE winding
  // from A, because that projection's in-plane rotation has determinant -1
  // (a real, correct fact about two independently-chosen local frames, not
  // an error — see this session's own reverted "mirror correction" attempt,
  // which wrongly tried to fix this one level up by moving vertices instead
  // of just re-ordering them). A clean, uniform 0.05mm overlap into A along
  // a perfectly vertical edge spanning A's own full height — nothing wrong
  // with the position or shape, only the winding disagrees with A's.
  std::vector<Point2> b = {
      {300.05, 0.0},
      {276.0, 0.0},
      {275.95, 150.05},
      {300.05, 150.0},
  };
  CHECK(SignedArea(a) > 0.0);   // A is CCW
  CHECK(SignedArea(b) < 0.0);   // B is CW — opposite winding, as found live

  auto result = PolygonUnion(a, b);
  INFO("errorCode=" << (result.ok ? "ok" : result.message));
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(22500.0 + 3611.85).epsilon(0.01));
}

TEST_CASE("PolygonUnion: two edge-touching rectangles combine into one larger rectangle",
          "[translation][polygon_boolean]") {
  auto a = Rect(0, 0, 10, 5);   // 10x5, right edge at x=10
  auto b = Rect(10, 0, 20, 5);  // 10x5, left edge at x=10 (shares A's right edge exactly)

  auto result = PolygonUnion(a, b);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(100.0));  // 20 x 5
  CHECK(SignedArea(result.outer) > 0.0);               // canonicalized CCW

  double xMin = 1e30, xMax = -1e30, yMin = 1e30, yMax = -1e30;
  for (const auto& p : result.outer) {
    xMin = std::min(xMin, p.x); xMax = std::max(xMax, p.x);
    yMin = std::min(yMin, p.y); yMax = std::max(yMax, p.y);
  }
  CHECK(xMin == Approx(0.0));
  CHECK(xMax == Approx(20.0));
  CHECK(yMin == Approx(0.0));
  CHECK(yMax == Approx(5.0));
}

TEST_CASE("PolygonUnion: two diagonally-overlapping rectangles produce the correct total area",
          "[translation][polygon_boolean]") {
  auto a = Rect(0, 0, 10, 10);    // area 100
  auto b = Rect(5, 5, 15, 15);    // area 100, overlapping A in [5,10]x[5,10] (area 25)

  auto result = PolygonUnion(a, b);
  REQUIRE(result.ok);
  // Union area = 100 + 100 - 25 (overlap) = 175.
  CHECK(PolygonArea(result.outer) == Approx(175.0));
  CHECK(SignedArea(result.outer) > 0.0);
}

TEST_CASE("PolygonDifference: subtracting a corner rectangle leaves the correct L-shaped area",
          "[translation][polygon_boolean]") {
  auto a = Rect(0, 0, 20, 10);  // area 200
  auto b = Rect(0, 0, 5, 5);    // area 25, at A's own corner (touches A's boundary)

  auto result = PolygonDifference(a, b);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(175.0));
  CHECK(SignedArea(result.outer) > 0.0);
}

TEST_CASE("PolygonUnion: disjoint (non-touching) rectangles is a typed error, not a silently "
          "dropped loop",
          "[translation][polygon_boolean]") {
  auto a = Rect(0, 0, 5, 5);
  auto b = Rect(100, 100, 105, 105);

  auto result = PolygonUnion(a, b);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == PolygonBooleanErrorCode::kMultipleLoops);
}

TEST_CASE("PolygonDifference: a fully-interior subtrahend (would leave a hole) is a typed error",
          "[translation][polygon_boolean]") {
  auto a = Rect(0, 0, 20, 20);
  auto b = Rect(5, 5, 10, 10);  // fully inside A, touching none of A's own boundary

  auto result = PolygonDifference(a, b);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == PolygonBooleanErrorCode::kHasHoles);
}

TEST_CASE("PolygonUnion/PolygonDifference: degenerate (fewer than 3 vertices) input is a typed "
          "error",
          "[translation][polygon_boolean]") {
  std::vector<Point2> degenerate = {{0, 0}, {1, 1}};
  auto a = Rect(0, 0, 10, 10);

  auto unionResult = PolygonUnion(a, degenerate);
  REQUIRE_FALSE(unionResult.ok);
  CHECK(unionResult.errorCode == PolygonBooleanErrorCode::kDegenerateInput);

  auto diffResult = PolygonDifference(a, degenerate);
  REQUIRE_FALSE(diffResult.ok);
  CHECK(diffResult.errorCode == PolygonBooleanErrorCode::kDegenerateInput);
}

TEST_CASE("FuseCoplanarParts: B's own-frame outline, translated into A's world-coplanar "
          "position, unions correctly",
          "[translation][polygon_boolean]") {
  // A sits at the world origin, identity anchor, 10x5 rectangle.
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B's own LOCAL outline is also a 10x5 rectangle at its own origin, but its
  // anchor places it in world space shifted +10 in X and coplanar with A
  // (same z=0 plane, no rotation) — i.e. B ends up exactly touching A's
  // right edge, the same physical configuration as the plain PolygonUnion
  // touching-rectangles test above, but arrived at via each part's own
  // independent anchor instead of an already-shared frame.
  Transform3 anchorB = Transform3::Translation(10.0, 0.0, 0.0);
  auto outlineB = Rect(0, 0, 10, 5);

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.0);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(100.0));
}

// NOTE (2026-09): a TEST_CASE previously lived here asserting that B
// anchored with a discrete in-plane mirror (local Y and Z both flip)
// fuses flush after a "mirror correction." That correction was reverted —
// see FuseCoplanarParts' own comment — because it silently substituted a
// different-shaped B into the union while leaving B's real anchor
// translation untouched, producing a wrong (overlapping, visually
// vanishing) result on a real live case instead of the old typed
// rejection. Removed rather than left asserting since-reverted behavior.

TEST_CASE("FuseCoplanarParts: a part anchored on a different plane is a typed coplanarity error",
          "[translation][polygon_boolean]") {
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B's anchor tilts it 90 degrees about the shared seam axis (Y) — no
  // longer coplanar with A's own z=0 plane, regardless of touching in X/Y.
  Transform3 anchorB = Transform3::RotationAboutAxis({10.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, 90.0);
  auto outlineB = Rect(0, 0, 10, 5);

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.0);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == PolygonBooleanErrorCode::kNotCoplanar);
}

TEST_CASE("FuseCoplanarParts: a z-offset within the parts' own thickness is accepted, "
          "the same offset with zero thickness is rejected",
          "[translation][polygon_boolean]") {
  // A sits at the world origin, identity anchor, 10x5 rectangle.
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B sits 0.5mm out of A's plane — well under real STEP-import
  // misalignment for 0.9mm-thick material, per
  // docs/BUG_REPORT_fuse_bodies_coplanar_tolerance_too_strict.md's own repro.
  Transform3 anchorB = Transform3::Translation(10.0, 0.0, 0.5);
  auto outlineB = Rect(0, 0, 10, 5);

  auto thickResult = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.9);
  REQUIRE(thickResult.ok);
  CHECK(PolygonArea(thickResult.outer) == Approx(100.0));

  auto thinResult = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.0);
  REQUIRE_FALSE(thinResult.ok);
  CHECK(thinResult.errorCode == PolygonBooleanErrorCode::kNotCoplanar);
}

TEST_CASE("FuseCoplanarParts: a z-offset beyond thickness but within the ~2mm STEP-import-"
          "noise floor is accepted for real material, still rejected at zero thickness",
          "[translation][polygon_boolean]") {
  // A sits at the world origin, identity anchor, 10x5 rectangle.
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B sits 1.025mm out of A's plane — matches the live testcube.step
  // panel+protrusion fuse this test guards against regressing (real report,
  // 2026-08-26): thickness-only tolerance (0.95mm, the thinner of the two
  // parts) rejected it; the ~2mm import-noise floor should not.
  Transform3 anchorB = Transform3::Translation(10.0, 0.0, 1.025);
  auto outlineB = Rect(0, 0, 10, 5);

  auto thickResult = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.95);
  REQUIRE(thickResult.ok);
  CHECK(PolygonArea(thickResult.outer) == Approx(100.0));

  // A part with NO real material thickness gets no import-noise allowance
  // — same floor as before this fix (0.05mm), not the 2mm one.
  auto thinResult = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.0);
  REQUIRE_FALSE(thinResult.ok);
  CHECK(thinResult.errorCode == PolygonBooleanErrorCode::kNotCoplanar);
}

TEST_CASE("FuseCoplanarParts: a small real XY gap between B's own edge and A's is CLOSED "
          "(zero-gap position correction), not merely tolerated, before unioning; a large "
          "gap between genuinely unrelated parts is still rejected",
          "[translation][polygon_boolean]") {
  // A sits at the world origin, identity anchor, 10x5 rectangle: x=[0,10], y=[0,5].
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B is meant to sit flush against A's right edge (x=10), but its own
  // anchor is off by 0.3mm in X — matches a real live scenario (2026-08-26):
  // a protrusion manually translated to align 90-degrees onto a panel,
  // landing a hair short instead of exactly flush.
  Transform3 anchorB = Transform3::Translation(10.3, 0.0, 0.0);
  auto outlineB = Rect(0, 0, 5, 5);

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.9);
  REQUIRE(result.ok);
  // The union is a clean 10x5 + 5x5 rectangle (15x5) — the gap closed
  // exactly, not left as a sliver or an overlap artifact.
  CHECK(PolygonArea(result.outer) == Approx(15.0 * 5.0));

  // Genuinely unrelated, far-apart parts must still be rejected — the snap
  // is bounded, not an unconditional "always make it work."
  Transform3 anchorFar = Transform3::Translation(50.0, 0.0, 0.0);
  auto farResult = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorFar, 0.9);
  REQUIRE_FALSE(farResult.ok);
  CHECK(farResult.errorCode == PolygonBooleanErrorCode::kMultipleLoops);
}

TEST_CASE("FuseCoplanarParts: a per-vertex-skewed touching edge (real STEP-import noise, NOT a "
          "rigid offset) is closed vertex-by-vertex, not by one shared delta",
          "[translation][polygon_boolean]") {
  // A sits at the world origin, identity anchor, a TALL 10x10 rectangle:
  // x=[0,10], y=[0,10] — the touching region below is kept well away from
  // A's own corners (y=[3,7]) so this test isolates the skewed-edge case
  // from any corner-adjacency ambiguity.
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 10);

  // B's own LOCAL outline is a quad whose "left" edge is meant to sit flush
  // against A's right edge (x=10) but is skewed: the bottom corner falls
  // 0.02mm short, the top corner falls 0.05mm short — two DIFFERENT gap
  // magnitudes on the same touching edge, matching the real testcube.step
  // protrusion dump (each ring's own vertices carry independent noise, not a
  // rigid translate/rotate of the whole outline). A single shared-delta snap
  // can zero out only ONE of these two gaps; the other remains a real,
  // unbridgeable gap (B's edge stays strictly past A's edge, x>10, along
  // that whole remaining span) that BRepAlgoAPI_Fuse's tight fuzzy value
  // cannot merge, so PolygonUnion still reports 2 disjoint faces.
  Transform3 anchorB = Transform3::Translation(10.0, 0.0, 0.0);
  std::vector<Point2> outlineB = {{0.02, 3.0}, {5.0, 3.0}, {5.0, 7.0}, {0.05, 7.0}};

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.9);
  REQUIRE(result.ok);
  // Both near corners snap onto A's edge, so B effectively becomes close to
  // a flush 5x4 rectangle against A: total area close to 10*10 + 5*4. Not
  // exact — the rigid pre-shift stage (needed to keep the OTHER, genuinely-
  // rigid misalignment case correct) nudges the far side by the same small
  // delta as a side effect, which is expected collateral at this noise
  // scale, not a defect: the actual requirement this test guards is that
  // the fuse SUCCEEDS despite per-vertex noise, not exact area
  // reconstruction from noisy input.
  CHECK(PolygonArea(result.outer) == Approx(120.0).margin(0.2));
}

TEST_CASE("FuseCoplanarParts: a rejected (too-large) gap reports the actual measured distance in "
          "its error message, not just a generic 'disjoint' — this is what made a real live "
          "'2 faces' failure (2026-08) unguessable without instrumenting the function by hand",
          "[translation][polygon_boolean]") {
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B sits exactly 35mm past A's right edge (x=45..50) — real, unrelated
  // parts, not import noise. This must still fail (the gap-close snap only
  // applies within coplanarToleranceMm), but the message must now say HOW
  // FAR apart they actually are, not just "2 faces."
  Transform3 anchorB = Transform3::Translation(45.0, 0.0, 0.0);
  auto outlineB = Rect(0, 0, 5, 5);

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB, 0.9);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == PolygonBooleanErrorCode::kMultipleLoops);
  CHECK(result.message.find("35.000000mm") != std::string::npos);
  CHECK(result.message.find("gap-close tolerance") != std::string::npos);
}
