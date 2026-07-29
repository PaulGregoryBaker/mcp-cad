#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/add_flange.hpp"

using namespace mcp_cad::translation;

TEST_CASE("AddFlange: computes flange outline for a simple rectangle", "[translation][add_flange]") {
  // A 100×50 rectangle, CCW: (0,0)-(100,0)-(100,50)-(0,50)
  std::vector<Point2> outline = {{0, 0}, {100, 0}, {100, 50}, {0, 50}};
  // Flange on the top edge (edge index 2: from (100,50) to (0,50))
  // Edge direction: leftward, outward normal points up (+Y)

  auto result = ComputeFlangeOutline(outline, /*edgeIndex=*/2, /*flangeLength=*/10.0);

  // Original: 4 vertices. New: 4 - 1 (removed edge) + 2 (flange) + 1 = 6
  CHECK(result.newOutline.size() == 6);

  // Hinge is the original edge
  CHECK(result.hingeA.x == 100.0);
  CHECK(result.hingeA.y == 50.0);
  CHECK(result.hingeB.x == 0.0);
  CHECK(result.hingeB.y == 50.0);
}

TEST_CASE("AddFlange: flange on right edge of rectangle", "[translation][add_flange]") {
  std::vector<Point2> outline = {{0, 0}, {100, 0}, {100, 50}, {0, 50}};
  // Flange on right edge (edge index 1: from (100,0) to (100,50))
  // Edge direction: upward, outward normal points right (+X)

  auto result = ComputeFlangeOutline(outline, /*edgeIndex=*/1, /*flangeLength=*/5.0);

  CHECK(result.newOutline.size() == 6);
  // Hinge is the right edge
  CHECK(result.hingeA.x == 100.0);
  CHECK(result.hingeA.y == 0.0);
  CHECK(result.hingeB.x == 100.0);
  CHECK(result.hingeB.y == 50.0);

  // Flange should extend to x=105
  bool foundFlangeVertex = false;
  for (const auto& p : result.newOutline) {
    if (p.x > 100.0) foundFlangeVertex = true;
  }
  CHECK(foundFlangeVertex);
}
