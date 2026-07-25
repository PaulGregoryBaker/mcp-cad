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

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(100.0));
}

TEST_CASE("FuseCoplanarParts: a part anchored on a different plane is a typed coplanarity error",
          "[translation][polygon_boolean]") {
  Transform3 anchorA = Transform3::Identity();
  auto outlineA = Rect(0, 0, 10, 5);

  // B's anchor tilts it 90 degrees about the shared seam axis (Y) — no
  // longer coplanar with A's own z=0 plane, regardless of touching in X/Y.
  Transform3 anchorB = Transform3::RotationAboutAxis({10.0, 0.0, 0.0}, {0.0, 1.0, 0.0}, 90.0);
  auto outlineB = Rect(0, 0, 10, 5);

  auto result = FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == PolygonBooleanErrorCode::kNotCoplanar);
}
