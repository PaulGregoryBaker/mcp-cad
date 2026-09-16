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

BendSpec MakeBend(double angleDeg) {
  BendSpec bend;
  bend.id = "b0";
  bend.parentRegionPanelId = "A";
  bend.childRegionPanelId = "B";
  bend.hingeA = {10, 5};
  bend.hingeB = {10, 0};
  bend.angleDeg = angleDeg;
  bend.radiusMm = 2.0;  // irrelevant to this module's own lap-joint extension
                         // (see part_split.hpp's own header comment) — carried
                         // through only because BendSpec always has one.
  bend.kFactor = 0.4;    // likewise irrelevant here.
  return bend;
}

}  // namespace

// part_split.hpp's own header comment derives, and hand-verifies against a
// real 3D solid, the lap-joint extension formula this whole file pins:
//   extensionMm = thicknessMm * sin(|angleDeg|)                                   (interior angle >= 90)
//   extensionMm = thicknessMm * sin(|angleDeg|) + thicknessMm * tan(|angleDeg|-90) (interior angle < 90)
// Every fixture below uses angleDeg=90 unless stated, where both branches
// agree: extensionMm = thicknessMm * sin(90) = thicknessMm exactly — 1mm for
// the 1mm-thick fixtures used throughout. Neither radiusMm nor kFactor enter
// it at all (unlike ComputeBendGeometry/BuildBendCuts elsewhere in this
// codebase, which describe an INTACT bend's own curved allowance zone — a
// different, unrelated physical thing once the bend itself is removed).

TEST_CASE("SplitPartAtBend: keepCornerOn=kChild — child extends into the corner, parent is cut "
          "square at the raw hinge with no loss at all",
          "[part_split]") {
  auto outline = CombinedOutline();
  auto bend = MakeBend(90.0);

  auto result = SplitPartAtBend(outline, bend, /*thicknessMm=*/1.0, CornerSide::kChild);
  REQUIRE(result.ok);

  // Parent (A) is cut square exactly at the raw hinge (x=10) — its own
  // FULL natural shape, nothing lost to the corner at all.
  std::vector<Point2> expectedParent = {{10, 5}, {0, 5}, {0, 0}, {10, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) == Approx(10.0 * 5.0).margin(1e-9));

  // Child (B) extends 1mm PAST the raw hinge, into parent's own old
  // territory — a real, deliberate overlap in the flat 2D footprint (the
  // two panels occupy different heights in the real 3D lap joint; see
  // part_split.hpp's header comment for the hand-verified derivation).
  std::vector<Point2> expectedChild = {{9, 0}, {10, 0}, {18, 0}, {18, 5}, {10, 5}, {9, 5}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(9.0 * 5.0).margin(1e-9));
}

TEST_CASE("SplitPartAtBend: keepCornerOn=kParent gives the mirror-image extension",
          "[part_split]") {
  auto outline = CombinedOutline();
  auto bend = MakeBend(90.0);

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(result.ok);

  std::vector<Point2> expectedParent = {{11, 5}, {10, 5}, {0, 5}, {0, 0}, {10, 0}, {11, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) == Approx(11.0 * 5.0).margin(1e-9));

  std::vector<Point2> expectedChild = {{10, 0}, {18, 0}, {18, 5}, {10, 5}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(8.0 * 5.0).margin(1e-9));
}

TEST_CASE("SplitPartAtBend: angleDeg=0 (a flat, unfolded 'bend') needs no extension at all — "
          "both sides collapse to the plain raw-hinge cut",
          "[part_split]") {
  // Unlike the OLD tangent-line model, radiusMm=0 no longer implies a
  // zero extension (real material still needs a real lap joint regardless
  // of the bend's own radius) — the only truly-zero case is angleDeg=0
  // itself (sin(0)=0): no fold at all, nothing to convert to a corner.
  auto outline = CombinedOutline();
  auto bend = MakeBend(0.0);

  auto childKeep = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  auto parentKeep = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(childKeep.ok);
  REQUIRE(parentKeep.ok);

  std::vector<Point2> expectedParent = {{10, 5}, {0, 5}, {0, 0}, {10, 0}};
  std::vector<Point2> expectedChild = {{10, 0}, {18, 0}, {18, 5}, {10, 5}};
  REQUIRE(childKeep.parentOutline.size() == expectedParent.size());
  REQUIRE(parentKeep.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(childKeep.parentOutline[i], expectedParent[i]) < 1e-9);
    CHECK(Dist2(parentKeep.parentOutline[i], expectedParent[i]) < 1e-9);
  }
  REQUIRE(childKeep.childOutline.size() == expectedChild.size());
  REQUIRE(parentKeep.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(childKeep.childOutline[i], expectedChild[i]) < 1e-9);
    CHECK(Dist2(parentKeep.childOutline[i], expectedChild[i]) < 1e-9);
  }
}

// angleDeg's own sign and bottomIsConcave are both real, data-driven facts
// for a reconciled bend — but this module's own extension formula uses
// std::fabs(bend.angleDeg) and never reads bottomIsConcave at all (see this
// file's own header comment), so every combination below must produce
// IDENTICAL output. This guards against a future regression reintroducing
// a sign/concave dependency into the lap-joint construction.
TEST_CASE("SplitPartAtBend: angleDeg's sign and bottomIsConcave never affect the lap-joint "
          "extension",
          "[part_split]") {
  struct Combo {
    double angleDeg;
    bool concave;
  };
  const Combo combos[] = {
      {90.0, true},
      {90.0, false},
      {-90.0, true},
      {-90.0, false},
  };

  auto outline = CombinedOutline();
  std::vector<Point2> expectedParent = {{11, 5}, {10, 5}, {0, 5}, {0, 0}, {10, 0}, {11, 0}};
  std::vector<Point2> expectedChild = {{10, 0}, {18, 0}, {18, 5}, {10, 5}};

  for (const Combo& c : combos) {
    INFO("angleDeg=" << c.angleDeg << " bottomIsConcave=" << c.concave);
    BendSpec bend = MakeBend(c.angleDeg);
    bend.bottomIsConcave = c.concave;

    auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
    REQUIRE(result.ok);
    REQUIRE(result.parentOutline.size() == expectedParent.size());
    for (size_t i = 0; i < expectedParent.size(); ++i) {
      CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
    }
    REQUIRE(result.childOutline.size() == expectedChild.size());
    for (size_t i = 0; i < expectedChild.size(); ++i) {
      CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
    }
  }
}

namespace {

// A Latin-cross cube net (base + 4 walls + lid), same shape as the reported
// live bug: base [0,10]x[0,10], bottom wall [0,10]x[-10,0], right wall
// [10,20]x[0,10], left wall [-10,0]x[0,10], top wall [0,10]x[10,20], lid
// [0,10]x[20,30]. CCW boundary trace (14 vertices) — the right-wall hinge
// (x=10, y in [0,10]) is INTERIOR except its own two endpoints, which are
// real concave corners of this ring.
std::vector<Point2> CrossOutline() {
  return {{0, -10}, {10, -10}, {10, 0},  {20, 0},  {20, 10}, {10, 10}, {10, 20},
          {10, 30}, {0, 30},   {0, 20},  {0, 10},  {-10, 10}, {-10, 0}, {0, 0}};
}

BendSpec MakeRightWallBend() {
  BendSpec bend;
  bend.id = "bWall";
  bend.parentRegionPanelId = "base";
  bend.childRegionPanelId = "rightWall";
  bend.hingeA = {10, 10};
  bend.hingeB = {10, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = 2.0;  // irrelevant here, see MakeBend's own comment above
  bend.kFactor = 0.4;
  return bend;
}

}  // namespace

TEST_CASE("SplitPartAtBend: on a branching cross net, kParent's own extension is a small local "
          "notch — base's incident edge runs perpendicular to the cut, so it doesn't span the "
          "whole net",
          "[part_split]") {
  auto outline = CrossOutline();
  auto bend = MakeRightWallBend();

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(result.ok);

  // Child (rightWall) is cut square at the raw hinge — its own FULL
  // natural shape, unchanged.
  std::vector<Point2> expectedChild = {{10, 0}, {20, 0}, {20, 10}, {10, 10}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(10.0 * 10.0).margin(1e-9));

  // Parent (base + every other panel) keeps its own full 12-vertex shape,
  // plus a 1mm notch bulging out at the corner — still local, not a sliver
  // spanning the whole net (the OLD ring-wide-search bug this fixture
  // guards against, docs/BUG_REPORT_split_part_at_bend_cross_net_sliver.md).
  std::vector<Point2> expectedParent = {{11, 10}, {10, 10}, {10, 20}, {10, 30}, {0, 30},  {0, 20},
                                         {0, 10},  {-10, 10}, {-10, 0}, {0, 0}, {0, -10}, {10, -10},
                                         {10, 0},  {11, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }
}

TEST_CASE("SplitPartAtBend: on a branching cross net, kChild's own extension is a small local "
          "notch — child is just the wall plus 1mm, not a sliver spanning the whole net",
          "[part_split]") {
  auto outline = CrossOutline();
  auto bend = MakeRightWallBend();

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  REQUIRE(result.ok);

  double minY = result.childOutline[0].y, maxY = result.childOutline[0].y;
  for (const auto& p : result.childOutline) {
    minY = std::min(minY, p.y);
    maxY = std::max(maxY, p.y);
  }
  // The wall's own extent is 10mm tall; the full net is 40mm (y in
  // [-10,30]). A sliver bug would make this ~40.
  CHECK((maxY - minY) < 15.0);

  std::vector<Point2> expectedChild = {{9, 0}, {10, 0}, {20, 0}, {20, 10}, {10, 10}, {9, 10}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }
  // Wall's own natural width (10mm, x in [10,20]) plus the 1mm extension.
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(11.0 * 10.0).margin(1e-9));

  // Parent keeps every other panel (base, bottom/left/top walls, lid) at
  // its own FULL natural shape — cut square at the raw hinge, unchanged.
  std::vector<Point2> expectedParent = {{10, 10}, {10, 20}, {10, 30}, {0, 30},   {0, 20},
                                         {0, 10},  {-10, 10}, {-10, 0}, {0, 0}, {0, -10}, {10, -10},
                                         {10, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }
}
