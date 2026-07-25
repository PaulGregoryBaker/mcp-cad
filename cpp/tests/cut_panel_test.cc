#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/cut_panel.hpp"

using namespace mcp_cad::translation;

namespace {

std::vector<Point2> Rect(double x0, double y0, double x1, double y1) {
  return {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}};
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

}  // namespace

TEST_CASE("PrepareCircleCut: succeeds against the containing region among several candidates",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {
      Rect(0, 0, 10, 10),
      Rect(20, 0, 30, 10),  // this one actually contains the circle
      Rect(40, 0, 50, 10),
  };
  auto result = PrepareCircleCut({25, 5}, 2.0, candidates);
  REQUIRE(result.ok);
  CHECK(result.regionIndex == 1);
}

TEST_CASE("PrepareCircleCut: no candidate contains it -> kHoleNotContained",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {Rect(0, 0, 10, 10)};
  auto result = PrepareCircleCut({5, 5}, 8.0, candidates);  // radius too big, crosses edges
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == CutPanelErrorCode::kHoleNotContained);
}

TEST_CASE("PrepareCircleCut: non-positive radius -> kDegenerateInput",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {Rect(0, 0, 10, 10)};
  auto result = PrepareCircleCut({5, 5}, 0.0, candidates);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == CutPanelErrorCode::kDegenerateInput);
}

TEST_CASE("PreparePolygonCut: canonicalizes a CCW ring to CW",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {Rect(0, 0, 10, 10)};
  auto ccwRing = Rect(2, 2, 8, 8);
  REQUIRE(SignedArea(ccwRing) > 0.0);  // Rect() itself is CCW

  auto result = PreparePolygonCut(ccwRing, candidates);
  REQUIRE(result.ok);
  CHECK(result.regionIndex == 0);
  CHECK(SignedArea(result.canonicalRing) < 0.0);  // now CW
}

TEST_CASE("PreparePolygonCut: selects the correct region among several candidates",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {
      Rect(0, 0, 10, 10),
      Rect(20, 0, 30, 10),
  };
  auto ring = Rect(22, 2, 28, 8);
  auto result = PreparePolygonCut(ring, candidates);
  REQUIRE(result.ok);
  CHECK(result.regionIndex == 1);
}

TEST_CASE("PreparePolygonCut: not contained by any candidate -> kHoleNotContained",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {Rect(0, 0, 10, 10)};
  auto ring = Rect(50, 50, 60, 60);
  auto result = PreparePolygonCut(ring, candidates);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == CutPanelErrorCode::kHoleNotContained);
}

TEST_CASE("PreparePolygonCut: fewer than 3 vertices -> kDegenerateInput",
          "[translation][cut_panel]") {
  std::vector<std::vector<Point2>> candidates = {Rect(0, 0, 10, 10)};
  std::vector<Point2> degenerate = {{1, 1}, {2, 2}};
  auto result = PreparePolygonCut(degenerate, candidates);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == CutPanelErrorCode::kDegenerateInput);
}
