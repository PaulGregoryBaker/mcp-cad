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

TEST_CASE("DetectContact: two rectangles folded 90deg at an axis-aligned seam", "[part_merge]") {
  // A: 10x5 rectangle at identity. B: 5x8 rectangle, anchored so its own
  // local edge0 (0,0)-(5,0) is folded onto A's edge (10,0)-(10,5) — hand-
  // derived and verified directly (R's columns checked against R*ex/R*ey/
  // R*ez by construction; B's local (0,0)/(5,0) confirmed to land exactly on
  // A's hinge world points), not fit to the expected output below.
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};
  Transform3 anchorA = Transform3::Identity();
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 10; anchorB.t[1] = 5; anchorB.t[2] = 0;

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.contactRegionCount == 1);
  CHECK(Dist2(contact.aRunStart, {10, 0}) < 1e-6);
  CHECK(Dist2(contact.aRunEnd, {10, 5}) < 1e-6);
  CHECK(Dist2(contact.bRunStart, {0, 0}) < 1e-6);
  CHECK(Dist2(contact.bRunEnd, {5, 0}) < 1e-6);
  // A genuine fold was detected (magnitude 90 — this anchor's own rotation
  // direction, not asserted against a specific sign here; see the dedicated
  // sign-convention test below for that).
  CHECK(std::fabs(std::fabs(contact.angleDeg) - 90.0) < 1e-6);

  auto result = ReconcileOutlines(outlineA, contact.aRunStart, contact.aRunEnd, outlineB, contact.bRunStart,
                                   contact.bRunEnd);
  REQUIRE(result.ok);
  CHECK(result.combinedOutline.size() == outlineA.size() + outlineB.size() - 2);
  CHECK(Dist2(result.hingeA, {10, 5}) < 1e-9);
  CHECK(Dist2(result.hingeB, {10, 0}) < 1e-9);

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

TEST_CASE("DetectContact: signed angleDeg matches RotationAboutAxis's own convention exactly",
          "[part_merge]") {
  // B's outline is authored so its own local edge0 (10,0)-(10,5) is
  // literally identical (same coordinates) to A's hinge edge — so at
  // anchorB=Identity, B would sit flush/coplanar with A (angle 0). Applying
  // RotationAboutAxis about that exact hinge line by a KNOWN angle, then
  // asking DetectContact to recover it, tests the sign convention against
  // the authoritative source (the same function Evaluate()'s own pose walk
  // uses) rather than a hand-derived expectation.
  //
  // A's forward edge walk here is (10,0)->(10,5), so DetectContact reports
  // aRunStart=(10,0), aRunEnd=(10,5) — and ReconcileOutlines will set the
  // REAL BendRow's hingeA=edgeA1=aRunEnd, hingeB=edgeA0=aRunStart (part_merge
  // .hpp's own reversed-order rule), so the rotation must be constructed
  // about that SAME axis (from aRunEnd's world position to aRunStart's) for
  // targetAngleDeg to be the exact value Evaluate()'s own pose walk would
  // read back from the real, created bend — not aRunStart-to-aRunEnd, which
  // is the opposite axis direction and would silently test the mirror-image
  // convention instead (this was a real bug, caught live against
  // unequal_leg_bracket_90deg.stp: a ~30-100mm systematic bbox error with
  // exactly the wrong-fold-direction signature).
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{10, 0}, {10, 5}, {2, 5}, {2, 0}};
  Transform3 anchorA = Transform3::Identity();

  const Point3 hingeAWorld{10, 5, 0};  // = aRunEnd's world position
  const Point3 axis{0, -1, 0};         // aRunStart's world position - aRunEnd's, normalized
  const double targetAngleDeg = 90.0;
  Transform3 anchorB = Transform3::RotationAboutAxis(hingeAWorld, axis, targetAngleDeg);

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.angleDeg == Approx(targetAngleDeg).margin(1e-6));
  CHECK(Dist2(contact.aRunStart, {10, 0}) < 1e-6);
  CHECK(Dist2(contact.aRunEnd, {10, 5}) < 1e-6);
}

TEST_CASE("DetectContact: an asymmetric seam — B's edge covers only PART of A's longer edge",
          "[part_merge]") {
  // A: 20-wide x 5-tall plate; its right edge (length 5, x=20, y in [0,5]) is
  // one plain, un-split edge — no pre-authored sub-splitting. B: a 3x4
  // flange whose own 3-length edge0 only covers y in [1,4] of A's edge —
  // TASK_SPEC.md F3: an unequal-length seam, resolved without the caller
  // pre-splitting A's outline.
  std::vector<Point2> outlineA = {{0, 0}, {20, 0}, {20, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {3, 0}, {3, 4}, {0, 4}};
  Transform3 anchorA = Transform3::Identity();

  // Fold B 90 degrees about the sub-interval x=20, y in [1,4] — anchor
  // derived the same way as the first test (R maps local +x -> world -y,
  // local +y -> world +z), just translated so local (0,0) lands at A's
  // (20,4) and local (3,0) lands at A's (20,1).
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 20; anchorB.t[1] = 4; anchorB.t[2] = 0;

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.contactRegionCount == 1);
  // The detected interval is the sub-run [1,4] on A's edge — NOT the whole
  // [0,5] edge — since that's the actual overlap with B's shorter run.
  CHECK(Dist2(contact.aRunStart, {20, 1}) < 1e-6);
  CHECK(Dist2(contact.aRunEnd, {20, 4}) < 1e-6);

  auto result = ReconcileOutlines(outlineA, contact.aRunStart, contact.aRunEnd, outlineB, contact.bRunStart,
                                   contact.bRunEnd);
  REQUIRE(result.ok);
  // A gains two new vertices (20,1) and (20,4) splitting its own right edge
  // (4 -> 6 vertices); B needs no insertion (its own edge0 endpoints (0,0)/
  // (3,0) are already existing vertices). Combined: 6 + 4 - 2 shared = 8.
  CHECK(result.combinedOutline.size() == 8);

  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-6));
  CHECK(areaCombined > 0.0);
}

TEST_CASE("DetectContact: no real contact is a typed error", "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};
  Transform3 anchorA = Transform3::Identity();
  // B floats 500mm away in Z, at an angle — nowhere near A's boundary.
  Transform3 anchorB = Transform3::RotationAboutAxis({0, 0, 500}, {0, 1, 0}, 37.0);
  anchorB.t[2] += 500;

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE_FALSE(contact.ok);
  CHECK(contact.errorCode == MergeErrorCode::kNoContact);
}

TEST_CASE("DetectContact: a genuinely coplanar pair is a typed error directing to fuse_bodies",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{20, 0}, {30, 0}, {30, 5}, {20, 5}};
  Transform3 anchorA = Transform3::Identity();
  Transform3 anchorB = Transform3::Identity();  // same plane as A, just offset in X

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE_FALSE(contact.ok);
  CHECK(contact.errorCode == MergeErrorCode::kCoplanarSeam);
}

TEST_CASE("DetectContact: two disjoint contact regions — the longer one is chosen deterministically",
          "[part_merge]") {
  // A: a 10x10 plate, right edge (10,-5)-(10,5) one plain unbroken edge.
  // B (local, CCW): a rectangle with a notch cut into its own bottom edge —
  // two separate "feet" both sitting at local y=0 (length 2 and length 4),
  // joined by a raised step at y=10 (well clear of the 2mm contact
  // tolerance, so the bridge is unambiguously NOT part of either contact
  // run) — a single flat (planar, as every part outline must be) polygon
  // that nonetheless touches A's plane along two physically disjoint
  // stretches once folded, exactly the TASK_SPEC.md §8.3 phase-1 scenario:
  // one real B, two disjoint contacts.
  std::vector<Point2> outlineA = {{0, -5}, {10, -5}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {2, 0}, {2, 10}, {3, 10}, {3, 0}, {7, 0}, {7, 13}, {0, 13}};
  Transform3 anchorA = Transform3::Identity();
  // Same fold family as the first test above (local +x -> world -y, local
  // +y -> world +z, hinge at world x=10,y=5 i.e. local origin) — folds this
  // B's y=0 boundary onto A's x=10 edge.
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 10; anchorB.t[1] = 5; anchorB.t[2] = 0;

  auto contact = DetectContact(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  // Two disjoint regions found (the length-2 foot at local x in [0,2], the
  // length-4 foot at local x in [3,7]) — the longer one (length 4) is chosen.
  CHECK(contact.contactRegionCount == 2);
  CHECK(Dist2(contact.aRunStart, {10, -2}) < 1e-6);
  CHECK(Dist2(contact.aRunEnd, {10, 2}) < 1e-6);
  CHECK(Dist2(contact.bRunStart, {3, 0}) < 1e-6);
  CHECK(Dist2(contact.bRunEnd, {7, 0}) < 1e-6);
}
