#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/split_by_plane.hpp"
#include "geometry/translation/manufacturing_graph_evaluator.hpp"

using namespace mcp_cad::translation;

namespace {

EvaluateResult MakeLayout(double w = 100.0, double h = 50.0) {
  EvaluateResult layout;
  layout.ok = true;

  // One panel covering the entire outline
  RegionPanelLayout panel;
  panel.regionPanelId = "root";
  panel.regionOuter = {{0, 0}, {w, 0}, {w, h}, {0, h}};
  panel.pose = Transform3::Identity();
  layout.panels.push_back(panel);

  return layout;
}

}  // namespace

TEST_CASE("SplitByPlane: horizontal plane splits rectangle into two fragments",
          "[translation][split_by_plane]") {
  auto layout = MakeLayout();
  // Plane: normal=(0,0,1), offset at z=25 (midpoint of a flat panel)
  // For an identity-pose panel, this projects to 2D: 0*x + 0*y = 25 → always false
  // Let's use a simpler plane: normal=(1,0,0), offset=50 (split at x=50)
  auto result = ComputeSplitByPlane(layout, /*nx=*/1.0, /*ny=*/0.0, /*nz=*/0.0, /*d=*/50.0);

  // Should get 2 fragments: positive side (x>=50) and negative side (x<=50)
  CHECK(result.fragments.size() == 2);

  bool hasPos = false, hasNeg = false;
  for (const auto& f : result.fragments) {
    CHECK(f.regionPanelId == "root");
    CHECK(f.polygon.size() >= 3);
    if (f.positiveSide) hasPos = true;
    else hasNeg = true;
  }
  CHECK(hasPos);
  CHECK(hasNeg);
}

TEST_CASE("SplitByPlane: panel entirely on one side produces one fragment",
          "[translation][split_by_plane]") {
  auto layout = MakeLayout();
  // Plane at x=200 — entire panel is on the negative side
  auto result = ComputeSplitByPlane(layout, /*nx=*/1.0, /*ny=*/0.0, /*nz=*/0.0, /*d=*/200.0);

  CHECK(result.fragments.size() == 1);
  CHECK_FALSE(result.fragments[0].positiveSide);
  CHECK(result.fragments[0].polygon.size() == 4);  // unchanged
}
