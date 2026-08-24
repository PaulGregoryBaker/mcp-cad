#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/part_split.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

double Dist2(const Point2& a, const Point2& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

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

// Same combined fixture as part_merge_test.cc's "two rectangles at an
// axis-aligned seam" (10x5 A, 5x8-attached-as-10x8-wide B): a bend hinge at
// x=10 dividing A (x in [0,10]) from B (x in [10,18]).
std::vector<Point2> CombinedOutline() {
  return {{0, 0}, {10, 0}, {18, 0}, {18, 5}, {10, 5}, {0, 5}};
}

BendSpec MakeBend(double radiusMm) {
  BendSpec bend;
  bend.id = "b0";
  bend.parentRegionPanelId = "A";
  bend.childRegionPanelId = "B";
  bend.hingeA = {10, 5};
  bend.hingeB = {10, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = radiusMm;
  bend.kFactor = 0.4;
  return bend;
}

}  // namespace

TEST_CASE("SplitPartAtBend: keepCornerOn=kChild gives child the allowance band", "[part_split]") {
  auto outline = CombinedOutline();
  auto bend = MakeBend(2.0);  // sb = 2*tan(45deg) = 2mm

  auto result = SplitPartAtBend(outline, bend, /*thicknessMm=*/1.0, CornerSide::kChild);
  REQUIRE(result.ok);

  // Parent (A) trimmed back PAST the raw hinge (x=10) to x=8 — harsher than
  // flush, having lost the whole 2mm allowance band to child.
  std::vector<Point2> expectedParent = {{8, 5}, {0, 5}, {0, 0}, {8, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }

  // Child (B) grows from its natural [10,18] to [8,18], absorbing the band.
  std::vector<Point2> expectedChild = {{8, 0}, {10, 0}, {18, 0}, {18, 5}, {10, 5}, {8, 5}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }

  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) == Approx(8.0 * 5.0).margin(1e-9));
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(10.0 * 5.0).margin(1e-9));
  // A strict partition of the same original polygon: areas sum exactly back.
  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) + std::fabs(ShoelaceArea(result.childOutline)) ==
        Approx(std::fabs(ShoelaceArea(outline))).margin(1e-9));
}

TEST_CASE("SplitPartAtBend: keepCornerOn=kParent gives parent the allowance band (mirror)",
          "[part_split]") {
  auto outline = CombinedOutline();
  auto bend = MakeBend(2.0);

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(result.ok);

  // Includes the original hinge's own leftover vertices (10,5)/(10,0) as
  // ordinary (now-collinear, since the real cut moved to x=12) points — the
  // algorithm doesn't simplify collinear vertices away, it just doesn't
  // introduce new ones beyond the two real cut points.
  std::vector<Point2> expectedParent = {{12, 5}, {10, 5}, {0, 5}, {0, 0}, {10, 0}, {12, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }

  std::vector<Point2> expectedChild = {{12, 0}, {18, 0}, {18, 5}, {12, 5}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }

  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) == Approx(12.0 * 5.0).margin(1e-9));
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(6.0 * 5.0).margin(1e-9));
}

TEST_CASE("SplitPartAtBend: zero radius collapses both sides to the raw hinge cut",
          "[part_split]") {
  auto outline = CombinedOutline();
  auto bend = MakeBend(0.0);  // sb = 0 -> no allowance band at all

  auto childKeep = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  auto parentKeep = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(childKeep.ok);
  REQUIRE(parentKeep.ok);

  std::vector<Point2> expectedParent = {{10, 5}, {0, 5}, {0, 0}, {10, 0}};
  std::vector<Point2> expectedChild = {{10, 0}, {18, 0}, {18, 5}, {10, 5}};
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(childKeep.parentOutline[i], expectedParent[i]) < 1e-9);
    CHECK(Dist2(parentKeep.parentOutline[i], expectedParent[i]) < 1e-9);
  }
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(childKeep.childOutline[i], expectedChild[i]) < 1e-9);
    CHECK(Dist2(parentKeep.childOutline[i], expectedChild[i]) < 1e-9);
  }
}

TEST_CASE("SplitPartAtBend: a corner bias wider than the flush side's own material fails typed",
          "[part_split]") {
  auto outline = CombinedOutline();
  // sb = 10*tan(45deg) = 10mm, but child's own material is only 8mm wide
  // (x in [10,18]) — the parent-keeps-corner cut line (x=10+10=20) falls
  // entirely outside the outline.
  auto bend = MakeBend(10.0);

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  CHECK_FALSE(result.ok);
  CHECK(result.errorCode == SplitErrorCode::kCornerZoneNotGrounded);
}

TEST_CASE("SplitPartAtBend: flush side matches Evaluate()'s own wallOuter for that region",
          "[part_split]") {
  // Independent correctness oracle: rather than trusting this module's own
  // re-derivation of the tangent-shift formula, cross-check its flush side
  // against manufacturing_graph_evaluator.cc's already-tested wallOuter for
  // the SAME bend, built via the ordinary Evaluate() pipeline.
  auto outline = CombinedOutline();
  auto bend = MakeBend(2.0);

  PartGraphSpec graph;
  graph.partId = "p";
  graph.rootRegionPanelId = "A";
  graph.outline.outer = outline;
  graph.bends = {bend};
  graph.thicknessMm = 1.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);
  REQUIRE(layout.panels.size() == 2);

  const RegionPanelLayout* childPanel = nullptr;
  const RegionPanelLayout* parentPanel = nullptr;
  for (const auto& p : layout.panels) {
    if (p.regionPanelId == "B") childPanel = &p;
    if (p.regionPanelId == "A") parentPanel = &p;
  }
  REQUIRE(childPanel != nullptr);
  REQUIRE(parentPanel != nullptr);

  // keepCornerOn=kChild cuts at CHILD's own tangent line (childShiftA/B),
  // so child's output here should be the exact same real shape as its own
  // wallOuter — an independent oracle for this module's tangent-shift
  // formula. RegionOf's own trace never emits the ORIGINAL (now-collinear)
  // hinge vertices this module's ring-insertion approach leaves in place
  // (see the previous test case), so vertex LISTS legitimately differ in
  // count; area is the robust, representation-independent equality check
  // (same discipline as part_merge_test.cc's own ShoelaceArea oracle), plus
  // every wallOuter vertex must lie exactly on this module's own boundary.
  auto childFlush = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  REQUIRE(childFlush.ok);
  CHECK(std::fabs(ShoelaceArea(childFlush.childOutline)) ==
        Approx(std::fabs(ShoelaceArea(childPanel->wallOuter))).margin(1e-6));
  for (const auto& q : childPanel->wallOuter) {
    bool found = false;
    for (const auto& p : childFlush.childOutline) {
      if (Dist2(p, q) < 1e-6) { found = true; break; }
    }
    CHECK(found);
  }

  // Mirror: keepCornerOn=kParent cuts at PARENT's own tangent line, so
  // parent's output should match region A's own wallOuter the same way.
  auto parentFlush = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(parentFlush.ok);
  CHECK(std::fabs(ShoelaceArea(parentFlush.parentOutline)) ==
        Approx(std::fabs(ShoelaceArea(parentPanel->wallOuter))).margin(1e-6));
  for (const auto& q : parentPanel->wallOuter) {
    bool found = false;
    for (const auto& p : parentFlush.parentOutline) {
      if (Dist2(p, q) < 1e-6) { found = true; break; }
    }
    CHECK(found);
  }
}
