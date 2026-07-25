#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/ring_containment.hpp"

using namespace mcp_cad::translation;

namespace {

std::vector<Point2> Rect(double x0, double y0, double x1, double y1) {
  return {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}};
}

// A "C" shaped (non-convex) container: a 10x10 square with a 4x6 notch cut
// from the middle of its right edge, deep enough that a ring straddling the
// notch mouth has both endpoints inside the outer square but its connecting
// edge would cross into the notch.
std::vector<Point2> NotchedContainer() {
  return {
      {0, 0}, {10, 0}, {10, 4}, {6, 4}, {6, 6}, {10, 6}, {10, 10}, {0, 10},
  };
}

}  // namespace

TEST_CASE("CircleFullyInsidePolygon: centered with clearance is fully inside",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  CHECK(CircleFullyInsidePolygon({5, 5}, 3.0, container));
}

TEST_CASE("CircleFullyInsidePolygon: touching an edge is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  // Center at x=3, radius=3 -> touches x=0 exactly.
  CHECK_FALSE(CircleFullyInsidePolygon({3, 5}, 3.0, container));
}

TEST_CASE("CircleFullyInsidePolygon: crossing an edge is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  CHECK_FALSE(CircleFullyInsidePolygon({1, 5}, 3.0, container));
}

TEST_CASE("CircleFullyInsidePolygon: center entirely outside the container is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  CHECK_FALSE(CircleFullyInsidePolygon({50, 50}, 1.0, container));
}

TEST_CASE("CircleFullyInsidePolygon: non-positive radius or degenerate container is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  CHECK_FALSE(CircleFullyInsidePolygon({5, 5}, 0.0, container));
  CHECK_FALSE(CircleFullyInsidePolygon({5, 5}, -1.0, container));
  std::vector<Point2> degenerate = {{0, 0}, {1, 1}};
  CHECK_FALSE(CircleFullyInsidePolygon({0.4, 0.4}, 0.01, degenerate));
}

TEST_CASE("RingFullyInsidePolygon: a small rectangle fully inside a larger one",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  auto candidate = Rect(2, 2, 8, 8);
  CHECK(RingFullyInsidePolygon(candidate, container));
}

TEST_CASE("RingFullyInsidePolygon: a candidate with a vertex outside is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  auto candidate = Rect(2, 2, 12, 8);  // right edge extends past the container
  CHECK_FALSE(RingFullyInsidePolygon(candidate, container));
}

TEST_CASE("RingFullyInsidePolygon: an edge bulging outside a non-convex container is rejected "
          "even though both its endpoints are inside",
          "[translation][ring_containment]") {
  auto container = NotchedContainer();
  // (7,2) and (7,8) are both inside the outer "C" shape (below and above the
  // notch respectively, x=7 is solid material at both those y's), but the
  // straight vertical edge between them at x=7 passes directly through the
  // notch's own missing-material region (x in [6,10], y in [4,6]) — a
  // vertex-only containment check would wrongly accept this.
  std::vector<Point2> candidate = {{7, 2}, {7, 8}, {5, 8}, {5, 2}};
  CHECK_FALSE(RingFullyInsidePolygon(candidate, container));
}

TEST_CASE("RingFullyInsidePolygon: a candidate fully inside a non-convex container's safe region",
          "[translation][ring_containment]") {
  auto container = NotchedContainer();
  auto candidate = Rect(1, 1, 5, 3);  // entirely in the lower-left, clear of the notch
  CHECK(RingFullyInsidePolygon(candidate, container));
}

TEST_CASE("RingFullyInsidePolygon: degenerate (fewer than 3 vertices) input is rejected",
          "[translation][ring_containment]") {
  auto container = Rect(0, 0, 10, 10);
  std::vector<Point2> degenerate = {{1, 1}, {2, 2}};
  CHECK_FALSE(RingFullyInsidePolygon(degenerate, container));
}
