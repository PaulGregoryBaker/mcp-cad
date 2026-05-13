#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "acl/feature_extractor.hpp"

using namespace mcp_cad;
using Catch::Approx;

static TopologyGraph sampleGraph() {
  TopologyGraph g;
  g.solidId = "solid-1";
  g.faces = {
      FaceNode{"f1", SurfaceType::PLANE, 400.0, 0, 0, 1},
      FaceNode{"f2", SurfaceType::PLANE, 400.0, 0, 1, 0},
      FaceNode{"f3", SurfaceType::CYLINDER, 20.0, 1, 0, 0},
  };
  g.edges = {
      EdgeNode{"e1", CurveType::LINE, 100.0},
  };
  g.adjacency = {
      AdjacencyEntry{"f1", "f2", "e1", 90.0},
  };
  return g;
}

TEST_CASE("ACL: extractBends finds bend from adjacency", "[acl][bend]") {
  auto extractor = FeatureExtractor::create();
  const auto g = sampleGraph();

  const auto bends = extractor->extractBends(g, 0.33);
  REQUIRE_FALSE(bends.empty());
  REQUIRE(bends[0].angleDeg == Approx(90.0));
}

TEST_CASE("ACL: extractHoles identifies cylindrical faces", "[acl][hole]") {
  auto extractor = FeatureExtractor::create();
  const auto g = sampleGraph();

  const auto holes = extractor->extractHoles(g);
  REQUIRE_FALSE(holes.empty());
  REQUIRE(holes[0].diameterMm > 0.0);
}

TEST_CASE("ACL: composeFeatureSet aggregates all feature classes", "[acl][compose]") {
  auto extractor = FeatureExtractor::create();
  const auto g = sampleGraph();

  const auto fs = extractor->composeFeatureSet(g, "shell-1", 1.5, 0.33);
  REQUIRE(fs.shellId == "shell-1");
  REQUIRE_FALSE(fs.bends.empty());
  REQUIRE_FALSE(fs.holes.empty());
  REQUIRE_FALSE(fs.flanges.empty());
}
