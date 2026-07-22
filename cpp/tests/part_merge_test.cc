#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/part_merge.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

double Dist2(const Point2& a, const Point2& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

// Shoelace area (signed; positive for CCW) — the general, hand-derivation-
// free correctness oracle used below: gluing two CCW polygons along one
// shared edge with no other overlap must produce a combined polygon whose
// area is exactly the sum of the two input areas, whatever their shapes.
double ShoelaceArea(const std::vector<Point2>& poly) {
  double sum = 0.0;
  const size_t n = poly.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = poly[i];
    const Point2& b = poly[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2.0;
}

}  // namespace

TEST_CASE("ReconcileOutlines: two rectangles at an axis-aligned seam", "[part_merge]") {
  // A: 10x5 rectangle. B: 5x8 rectangle attached at A's right edge (length 5).
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};

  auto result = ReconcileOutlines(outlineA, {10, 0}, {10, 5}, outlineB, {0, 0}, {5, 0});
  REQUIRE(result.ok);
  CHECK(result.combinedOutline.size() == outlineA.size() + outlineB.size() - 2);
  // Reversed from the literal edgeA0/edgeA1 order — see part_merge.hpp's
  // ReconcileOutlinesResult doc comment: A's material must land on the
  // RIGHT (parent) side of the returned hinge, per BoundingBends' fixed
  // "child = left of hingeA->hingeB" convention.
  CHECK(Dist2(result.hingeA, {10, 5}) < 1e-9);
  CHECK(Dist2(result.hingeB, {10, 0}) < 1e-9);

  // Hand-verified: B (5 wide along the seam, 8 tall) attaches outward,
  // producing a plain 18x5 rectangle (two collinear vertices at x=10).
  std::vector<Point2> expected = {{0, 0}, {10, 0}, {18, 0}, {18, 5}, {10, 5}, {0, 5}};
  REQUIRE(result.combinedOutline.size() == expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    CHECK(Dist2(result.combinedOutline[i], expected[i]) < 1e-9);
  }

  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-6));
  CHECK(areaCombined > 0.0);  // still CCW
}

TEST_CASE("ReconcileOutlines: the returned hinge puts A's own material on the PARENT side",
          "[part_merge]") {
  // Builds a real bend from the returned hinge (via the actual Evaluate()
  // pipeline, not a hand re-derivation) and checks which side each region
  // panel lands on — catching an association-swap regression (parent/child
  // sides swapped) that a pure area or outline-shape check cannot detect,
  // since a swapped split still has the exact right combined area/shape.
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};

  auto result = ReconcileOutlines(outlineA, {10, 0}, {10, 5}, outlineB, {0, 0}, {5, 0});
  REQUIRE(result.ok);

  PartGraphSpec graph;
  graph.partId = "merged";
  graph.rootRegionPanelId = "A";
  graph.thicknessMm = 1.0;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = result.combinedOutline;

  BendSpec bend;
  bend.id = "seam-bend";
  bend.parentRegionPanelId = "A";
  bend.childRegionPanelId = "B";
  bend.hingeA = result.hingeA;
  bend.hingeB = result.hingeB;
  bend.angleDeg = 90.0;
  bend.radiusMm = 0.0;
  bend.kFactor = 0.0;
  graph.bends.push_back(bend);

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  const RegionPanelLayout* panelA = nullptr;
  const RegionPanelLayout* panelB = nullptr;
  for (const auto& p : layout.panels) {
    if (p.regionPanelId == "A") panelA = &p;
    if (p.regionPanelId == "B") panelB = &p;
  }
  REQUIRE(panelA != nullptr);
  REQUIRE(panelB != nullptr);

  auto maxX = [](const RegionPanelLayout& p) {
    double m = p.regionOuter[0].x;
    for (const auto& v : p.regionOuter) m = std::max(m, v.x);
    return m;
  };
  auto minX = [](const RegionPanelLayout& p) {
    double m = p.regionOuter[0].x;
    for (const auto& v : p.regionOuter) m = std::min(m, v.x);
    return m;
  };

  // A's own material spans x in [0,10]; B's spliced-in material spans
  // x in [10,18] — parent (A) must stay on A's own original side.
  CHECK(maxX(*panelA) <= 10.0 + 1e-6);
  CHECK(minX(*panelB) >= 10.0 - 1e-6);
}

TEST_CASE("ReconcileOutlines: area-additivity holds at a non-axis-aligned seam", "[part_merge]") {
  // A: a parallelogram with a diagonal right edge — proves the algorithm
  // generalizes beyond axis-aligned edges (rebuild/02-requirements.md:
  // "panels need not align with any axis").
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {12, 6}, {2, 6}};
  Point2 edgeA0 = {10, 0};
  Point2 edgeA1 = {12, 6};
  double seamLen = Dist2(edgeA0, edgeA1);

  std::vector<Point2> outlineB = {{0, 0}, {seamLen, 0}, {seamLen, 4}, {0, 4}};

  auto result = ReconcileOutlines(outlineA, edgeA0, edgeA1, outlineB, {0, 0}, {seamLen, 0});
  REQUIRE(result.ok);

  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-6));
  CHECK(areaCombined > 0.0);
}

TEST_CASE("ReconcileOutlines: merging onto an already-bent part's free edge", "[part_merge]") {
  // A two-panel graph (root seg0 -> bend0 -> seg1). seg0's free (non-hinge)
  // right-hand edge is used as the merge seam — exercising the design
  // decision that ANY live region panel's free edge works uniformly,
  // matching 13 section7's C07 claim that corner/composite chains need no
  // special-casing.
  PartGraphSpec graph;
  graph.partId = "bent-part";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = 1.0;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {{0, 0}, {20, 0}, {20, 5}, {0, 5}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "seg0";
  bend.childRegionPanelId = "seg1";
  bend.hingeA = {10, 5};
  bend.hingeB = {10, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = 0.0;
  bend.kFactor = 0.0;
  graph.bends.push_back(bend);

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  const RegionPanelLayout* seg0 = nullptr;
  for (const auto& p : layout.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
  }
  REQUIRE(seg0 != nullptr);

  // seg0's free edge (edgeBendId == "") is the outer boundary at x=0 (the
  // part's true left edge — never touched by the bend's clip).
  Point2 edgeA0, edgeA1;
  bool found = false;
  size_t n = seg0->regionOuter.size();
  for (size_t i = 0; i < n; ++i) {
    if (seg0->edgeBendId[i].empty()) {
      Point2 a = seg0->regionOuter[i];
      Point2 b = seg0->regionOuter[(i + 1) % n];
      // Pick specifically the x=0 edge (there may be two free edges — top
      // and bottom — on a simple rectangle-minus-bend-zone region; we want
      // the true outer edge, not a fragment of the long boundary).
      if (std::fabs(a.x) < 1e-6 && std::fabs(b.x) < 1e-6) {
        edgeA0 = a;
        edgeA1 = b;
        found = true;
      }
    }
  }
  REQUIRE(found);

  double seamLen = Dist2(edgeA0, edgeA1);
  std::vector<Point2> outlineB = {{0, 0}, {seamLen, 0}, {seamLen, 3}, {0, 3}};

  auto result = ReconcileOutlines(graph.outline.outer, edgeA0, edgeA1, outlineB, {0, 0}, {seamLen, 0});
  REQUIRE(result.ok);
  double areaA = std::fabs(ShoelaceArea(graph.outline.outer));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-6));
}

TEST_CASE("ReconcileOutlines: edge length mismatch is a typed error", "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {40, 0}, {40, 8}, {0, 8}};  // seam edge length 40 vs 5

  auto result = ReconcileOutlines(outlineA, {10, 0}, {10, 5}, outlineB, {0, 0}, {40, 0});
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == MergeErrorCode::kMergeEdgeMismatch);
}

TEST_CASE("ReconcileOutlines: an edge_ref that isn't a real consecutive pair is a typed error",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};

  // (0,0) and (10,5) are both real vertices of A but not a consecutive pair.
  auto result = ReconcileOutlines(outlineA, {0, 0}, {10, 5}, outlineB, {0, 0}, {5, 0});
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == MergeErrorCode::kInvalidEdgeRef);
}

TEST_CASE("ReconcileOutlines: a wrong/mismatched edge pair that would overlap is a typed error",
          "[part_merge]") {
  // Same A as the main test, but B is deliberately CW-wound (a data-
  // integrity/wrong-pick stand-in) so its "outward" side, per the CCW-
  // assuming transform rule, actually folds back on top of A instead of
  // extending away from it — a genuine, general way to force overlap for
  // this test, not a claim about how a real caller would trigger it.
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {0, 8}, {5, 8}, {5, 0}};  // CW

  auto result = ReconcileOutlines(outlineA, {10, 0}, {10, 5}, outlineB, {5, 0}, {0, 0});
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == MergeErrorCode::kMergeSelfIntersecting);
}
