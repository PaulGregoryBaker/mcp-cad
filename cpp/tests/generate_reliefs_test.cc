#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/generate_reliefs.hpp"

using namespace mcp_cad::translation;

TEST_CASE("GenerateReliefs: two perpendicular bends sharing a corner produce dogbone relief",
          "[translation][generate_reliefs]") {
  // Two bends sharing an endpoint: bend1 hinge (0,0)→(0,50), bend2 hinge (0,50)→(50,50)
  // They share the corner at (0,50).
  std::vector<BendSpec> bends;
  BendSpec b1;
  b1.id = "bend-1";
  b1.hingeA = {0, 0};
  b1.hingeB = {0, 50};
  bends.push_back(b1);

  BendSpec b2;
  b2.id = "bend-2";
  b2.hingeA = {0, 50};
  b2.hingeB = {50, 50};
  bends.push_back(b2);

  auto results = ComputeReliefPolygons(bends, "dogbone", /*radiusMm=*/2.0, /*thicknessMm=*/1.0);
  CHECK(results.size() == 1);
  CHECK(results[0].polygon.size() >= 3);
}

TEST_CASE("GenerateReliefs: no shared corners produces empty result",
          "[translation][generate_reliefs]") {
  // Two bends far apart — no shared endpoints
  std::vector<BendSpec> bends;
  BendSpec b1;
  b1.id = "bend-1";
  b1.hingeA = {0, 0};
  b1.hingeB = {0, 10};
  bends.push_back(b1);

  BendSpec b2;
  b2.id = "bend-2";
  b2.hingeA = {50, 50};
  b2.hingeB = {60, 50};
  bends.push_back(b2);

  auto results = ComputeReliefPolygons(bends, "dogbone", 2.0, 1.0);
  CHECK(results.empty());
}

TEST_CASE("GenerateReliefs: circular relief at corner", "[translation][generate_reliefs]") {
  std::vector<BendSpec> bends;
  BendSpec b1;
  b1.id = "bend-1";
  b1.hingeA = {10, 0};
  b1.hingeB = {10, 10};
  bends.push_back(b1);

  BendSpec b2;
  b2.id = "bend-2";
  b2.hingeA = {10, 10};
  b2.hingeB = {20, 10};
  bends.push_back(b2);

  auto results = ComputeReliefPolygons(bends, "circular", 1.5, 1.0);
  CHECK(results.size() == 1);
  // Circular relief approximates with octagon (8 vertices)
  CHECK(results[0].polygon.size() == 8);
}
