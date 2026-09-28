#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/rip_edge.hpp"

using namespace mcp_cad::translation;

TEST_CASE("RipEdge: splits edge at midpoint with gap", "[translation][rip_edge]") {
  // 100×50 rectangle, CCW
  std::vector<Point2> outline = {{0, 0}, {100, 0}, {100, 50}, {0, 50}};
  // Rip top edge (index 2: (100,50)→(0,50))
  auto result = ComputeRipEdge(outline, /*edgeIndex=*/2, /*gapMm=*/1.0);

  // Original: 4 vertices. New: 4 - 1 (removed edge) + 2 (gap vertices) + 1 = 6
  CHECK(result.newOutline.size() == 6);

  // First 3 vertices should match original (indices 0,1,2 = (0,0),(100,0),(100,50))
  CHECK(result.newOutline[0].x == 0.0);
  CHECK(result.newOutline[0].y == 0.0);
  CHECK(result.newOutline[1].x == 100.0);
  CHECK(result.newOutline[1].y == 0.0);
  CHECK(result.newOutline[2].x == 100.0);
  CHECK(result.newOutline[2].y == 50.0);

  // Gap vertices should be near the midpoint of the original edge (50, 50)
  // and offset perpendicularly (the edge goes leftward, perpendicular is upward)
  bool hasGapVertex = false;
  for (const auto& p : result.newOutline) {
    if (std::abs(p.x - 50.0) < 10.0 && std::abs(p.y - 50.0) < 10.0) {
      hasGapVertex = true;
    }
  }
  CHECK(hasGapVertex);

  // Last vertex should be (0,50) — the original edge end
  CHECK(result.newOutline[5].x == 0.0);
  CHECK(result.newOutline[5].y == 50.0);
}

TEST_CASE("RipEdge: zero gap produces degenerate case", "[translation][rip_edge]") {
  std::vector<Point2> outline = {{0, 0}, {100, 0}, {100, 50}, {0, 50}};
  auto result = ComputeRipEdge(outline, /*edgeIndex=*/2, /*gapMm=*/0.0);
  // Zero gap: the two offset vertices should be identical
  // (both at the midpoint), still producing 6 vertices
  CHECK(result.newOutline.size() == 6);
}
