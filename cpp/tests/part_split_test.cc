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

BendSpec MakeRightWallBend(double radiusMm) {
  BendSpec bend;
  bend.id = "bWall";
  bend.parentRegionPanelId = "base";
  bend.childRegionPanelId = "rightWall";
  bend.hingeA = {10, 10};  // matches CombinedOutline's hingeA=top convention
  bend.hingeB = {10, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = radiusMm;
  bend.kFactor = 0.4;
  return bend;
}

}  // namespace

TEST_CASE("SplitPartAtBend: on a branching cross net, radiusMm=0 (bend not yet measured) succeeds on "
          "BOTH corner sides — a zero-length offset needs no local-edge search at all",
          "[part_split]") {
  // Real reconciled parts (e.g. cpp/tests/fixtures/testcube.step, as
  // imported) commonly carry radiusMm=0 until a real bend radius is set.
  // sb==0 means the "corner-biased" line IS the raw hinge line, so both
  // sides must reduce to the plain unshifted split — including at a
  // branching hinge where the trimmed side's own local edge happens to run
  // PARALLEL to the hinge (a real case here: base's incident edge on the far
  // side of this corner is another wall's own edge, colinear with the
  // hinge). Testing that parallel edge for a crossing would spuriously fail
  // even though there is nothing to search for.
  auto outline = CrossOutline();
  auto bend = MakeRightWallBend(0.0);

  std::vector<Point2> expectedChild = {{10, 0}, {20, 0}, {20, 10}, {10, 10}};
  std::vector<Point2> expectedParent = {{10, 10}, {10, 20}, {10, 30}, {0, 30}, {0, 20},
                                         {0, 10},  {-10, 10}, {-10, 0}, {0, 0}, {0, -10},
                                         {10, -10}, {10, 0}};

  for (CornerSide side : {CornerSide::kParent, CornerSide::kChild}) {
    auto result = SplitPartAtBend(outline, bend, 1.0, side);
    REQUIRE(result.ok);
    REQUIRE(result.childOutline.size() == expectedChild.size());
    for (size_t i = 0; i < expectedChild.size(); ++i) {
      CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
    }
    REQUIRE(result.parentOutline.size() == expectedParent.size());
    for (size_t i = 0; i < expectedParent.size(); ++i) {
      CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
    }
  }
}

TEST_CASE("SplitPartAtBend: a negative angleDeg with an explicit bottomIsConcave (both real for "
          "reconciled bends, not just hand-authored fixtures) does NOT change which keepCornerOn "
          "value stays local — that's a fabrication choice, not a function of fold direction",
          "[part_split]") {
  // ReconcilePieces stamps angleDeg<0 for some folds and bottomIsConcave
  // explicitly (not left to default) — both real for reconciled bends, and
  // together they flip the SIGN of the raw childShift/parentShift formula
  // relative to the angleDeg>=0-and-default-concave fixtures every other
  // hand-authored test in this file uses. That sign is fold-direction
  // bookkeeping internal to the shift formula; it must not leak into which
  // side keepCornerOn actually keeps — kParent always means "parent grows,
  // child is cut back" regardless of which literal fold direction this
  // bend happens to be (see part_split.cc's own comment on why: unlike
  // BuildBendCuts, which clips each panel independently and never has to
  // choose, this module picks ONE side per the caller's own intent).
  auto outline = CrossOutline();
  BendSpec bend = MakeRightWallBend(2.0);
  bend.angleDeg = -90.0;
  bend.bottomIsConcave = true;  // explicit, same as ReconcilePieces stamps

  // Same numbers as the angleDeg=+90 fixture's own kParent success case —
  // the sign flip must be fully absorbed internally, invisible here.
  auto ok = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(ok.ok);
  std::vector<Point2> expectedChild = {{12, 0}, {20, 0}, {20, 10}, {12, 10}};
  REQUIRE(ok.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(ok.childOutline[i], expectedChild[i]) < 1e-9);
  }

  // kChild lands on the far side's parallel edge too (same as the
  // angleDeg=+90 fixture) — but a parallel edge is exactly a corner shared
  // with another live bend continuing straight through, not an
  // unrepresentable cut: it succeeds via a local notch instead of a direct
  // substitution. Same numbers as the angleDeg=+90 fixture's own kChild
  // success case.
  auto ok2 = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  REQUIRE(ok2.ok);
  std::vector<Point2> expectedChild2 = {{8, 0}, {10, 0}, {20, 0}, {20, 10}, {10, 10}, {8, 10}};
  REQUIRE(ok2.childOutline.size() == expectedChild2.size());
  for (size_t i = 0; i < expectedChild2.size(); ++i) {
    CHECK(Dist2(ok2.childOutline[i], expectedChild2[i]) < 1e-9);
  }
}

TEST_CASE("SplitPartAtBend: exhaustive over every (angleDeg sign, bottomIsConcave) combination a real "
          "reconciled bend can carry — BOTH keepCornerOn sides stay local at this hinge (one via a "
          "direct replace, the other via a local notch around the shared corner), regardless of "
          "which literal fold direction produced the data",
          "[part_split]") {
  // sb's raw sign = (concave ? +1 : -1) * sign(angleDeg) — a real, data-
  // driven fact for reconciled bends, not just a hand-authored-fixture
  // artifact. If that sign ever leaked into which keepCornerOn value stays
  // local, a caller's choice of "keep the corner on the trunk" would
  // silently flip to "keep it on the arm" depending on which way the part
  // happened to be folded — exactly the live bug this test guards against.
  // Neither side should ever fail typed here: a corner shared with another
  // live bend (this fixture's own shape) is a LOCAL notch, not an
  // unrepresentable cut — see BuildEndpoint's own comment.
  struct Combo {
    double angleDeg;
    bool concave;
  };
  const Combo combos[] = {
      {90.0, true},    // original bug-report fixture
      {90.0, false},   // sign flip via concave alone (must not change the outcome)
      {-90.0, true},   // sign flip via angle alone — the live testcube data
      {-90.0, false},  // both flipped
  };

  auto outline = CrossOutline();
  std::vector<Point2> expectedChildParent = {{12, 0}, {20, 0}, {20, 10}, {12, 10}};
  std::vector<Point2> expectedChildChild = {{8, 0}, {10, 0}, {20, 0}, {20, 10}, {10, 10}, {8, 10}};

  for (const Combo& c : combos) {
    INFO("angleDeg=" << c.angleDeg << " bottomIsConcave=" << c.concave);
    BendSpec bend = MakeRightWallBend(2.0);
    bend.angleDeg = c.angleDeg;
    bend.bottomIsConcave = c.concave;

    auto okParent = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
    REQUIRE(okParent.ok);
    REQUIRE(okParent.childOutline.size() == expectedChildParent.size());
    for (size_t i = 0; i < expectedChildParent.size(); ++i) {
      CHECK(Dist2(okParent.childOutline[i], expectedChildParent[i]) < 1e-9);
    }
    CHECK(std::fabs(ShoelaceArea(okParent.parentOutline)) +
              std::fabs(ShoelaceArea(okParent.childOutline)) ==
          Approx(std::fabs(ShoelaceArea(outline))).margin(1e-9));

    auto okChild = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
    REQUIRE(okChild.ok);
    REQUIRE(okChild.childOutline.size() == expectedChildChild.size());
    for (size_t i = 0; i < expectedChildChild.size(); ++i) {
      CHECK(Dist2(okChild.childOutline[i], expectedChildChild[i]) < 1e-9);
    }
    CHECK(std::fabs(ShoelaceArea(okChild.parentOutline)) +
              std::fabs(ShoelaceArea(okChild.childOutline)) ==
          Approx(std::fabs(ShoelaceArea(outline))).margin(1e-9));
  }
}

TEST_CASE("SplitPartAtBend: on a branching cross net, a cut direction with no directly-usable local "
          "edge still succeeds via a local notch, instead of finding a far-away pair of crossings",
          "[part_split]") {
  // Reproduces docs/BUG_REPORT_split_part_at_bend_cross_net_sliver.md: the
  // OLD ring-wide search found this direction's two crossings on the
  // bottom-wall's and lid's far edges (both at y=-10 and y=30 — the full net
  // height away), producing a "child" that was the wall plus a sliver the
  // length of the whole net. The fix's own first cut made this fail typed
  // instead — safe, but this direction is not actually unrepresentable: the
  // parallel edge that blocks a direct substitution is exactly the
  // signature of a corner shared with another live bend, and a small local
  // notch around it is a valid, fully local cut (see BuildEndpoint).
  auto outline = CrossOutline();
  auto bend = MakeRightWallBend(2.0);

  // A branching corner does NOT mean this direction is unrepresentable —
  // parent's own incident edge here happens to be a NEIGHBOR bend's edge,
  // running parallel to the cut, so a direct substitution has nothing to
  // land on. But the cut is still perfectly local: parent's own front/back
  // stay exactly where they are, and the two offset points are added right
  // next to them as a small notch, never touching anything beyond this one
  // corner. Must succeed, not fail typed.
  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kChild);
  REQUIRE(result.ok);

  std::vector<Point2> expectedChild = {{8, 0}, {10, 0}, {20, 0}, {20, 10}, {10, 10}, {8, 10}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }

  std::vector<Point2> expectedParent = {{8, 10}, {10, 10}, {10, 20}, {10, 30}, {0, 30},   {0, 20},
                                         {0, 10}, {-10, 10}, {-10, 0}, {0, 0}, {0, -10}, {10, -10},
                                         {10, 0}, {8, 0}};
  REQUIRE(result.parentOutline.size() == expectedParent.size());
  for (size_t i = 0; i < expectedParent.size(); ++i) {
    CHECK(Dist2(result.parentOutline[i], expectedParent[i]) < 1e-9);
  }

  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) + std::fabs(ShoelaceArea(result.childOutline)) ==
        Approx(std::fabs(ShoelaceArea(outline))).margin(1e-9));
}

TEST_CASE("SplitPartAtBend: on a branching cross net, the other direction stays local — child is just "
          "the wall, not a sliver spanning the whole net",
          "[part_split]") {
  auto outline = CrossOutline();
  auto bend = MakeRightWallBend(2.0);  // sb = 2*tan(45deg) = 2mm

  auto result = SplitPartAtBend(outline, bend, 1.0, CornerSide::kParent);
  REQUIRE(result.ok);

  double minY = result.childOutline[0].y, maxY = result.childOutline[0].y;
  for (const auto& p : result.childOutline) {
    minY = std::min(minY, p.y);
    maxY = std::max(maxY, p.y);
  }
  // The wall's own extent is 10mm tall; the full net is 40mm (y in
  // [-10,30]). A sliver bug would make this ~40.
  CHECK((maxY - minY) < 15.0);

  std::vector<Point2> expectedChild = {{12, 0}, {20, 0}, {20, 10}, {12, 10}};
  REQUIRE(result.childOutline.size() == expectedChild.size());
  for (size_t i = 0; i < expectedChild.size(); ++i) {
    CHECK(Dist2(result.childOutline[i], expectedChild[i]) < 1e-9);
  }
  CHECK(std::fabs(ShoelaceArea(result.childOutline)) == Approx(8.0 * 10.0).margin(1e-9));

  // Parent keeps every other panel (base, bottom/left/top walls, lid) —
  // still a valid simple outline, area-complementary to child.
  CHECK(std::fabs(ShoelaceArea(result.parentOutline)) + std::fabs(ShoelaceArea(result.childOutline)) ==
        Approx(std::fabs(ShoelaceArea(outline))).margin(1e-9));
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
