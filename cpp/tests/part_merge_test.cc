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

// Single flat panel per side: the panel ring is the whole outline and its
// pose is the part's anchor.
DetectContactResult DetectContactSingle(const std::vector<Point2>& outlineA, const Transform3& anchorA,
                                         const std::vector<Point2>& outlineB, const Transform3& anchorB) {
  return DetectContact(outlineA, {ContactPanelCandidate{outlineA, anchorA, "panelA"}}, outlineB,
                        {ContactPanelCandidate{outlineB, anchorB, "panelB"}});
}

Point2 RefPointForTest(const std::vector<Point2>& outline, const OutlineRef& r) {
  const Point2& a = outline[static_cast<size_t>(r.edgeIndex)];
  const Point2& b = outline[(static_cast<size_t>(r.edgeIndex) + 1) % outline.size()];
  return {a.x + (b.x - a.x) * r.t, a.y + (b.y - a.y) * r.t};
}

ReconcileOutlinesResult Reconcile(const std::vector<Point2>& outlineA, const std::vector<Point2>& outlineB,
                                  const ContactRegion& r, const std::vector<Point2>& carryB = {}) {
  return ReconcileOutlines(outlineA, r.aStart, r.aEnd, outlineB, r.bStart, r.bEnd, carryB);
}

// The longest of every region DetectContact found — the old single-region
// API always returned exactly this one; most tests below still only care
// about "the" contact and use this to keep their old assertions unchanged.
const ContactRegion& LongestRegion(const DetectContactResult& result) {
  const ContactRegion* best = &result.regions.at(0);
  for (const auto& region : result.regions) {
    if (region.lengthMm > best->lengthMm) best = &region;
  }
  return *best;
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

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(Dist2(region.aRunStart, {10, 0}) < 1e-6);
  CHECK(Dist2(region.aRunEnd, {10, 5}) < 1e-6);
  CHECK(Dist2(region.bRunStart, {0, 0}) < 1e-6);
  CHECK(Dist2(region.bRunEnd, {5, 0}) < 1e-6);
  // A genuine fold was detected (magnitude 90 — this anchor's own rotation
  // direction, not asserted against a specific sign here; see the dedicated
  // sign-convention test below for that).
  CHECK(std::fabs(std::fabs(region.angleDeg) - 90.0) < 1e-6);

  // Carry two B-frame points (B's own far corners) — they must land exactly
  // where the same B vertices land in combinedOutline below.
  auto result = Reconcile(outlineA, outlineB, region, {{5, 8}, {0, 8}});
  REQUIRE(result.ok);
  REQUIRE(result.carriedB.size() == 2);
  CHECK(Dist2(result.carriedB[0], {18, 0}) < 1e-9);
  CHECK(Dist2(result.carriedB[1], {18, 5}) < 1e-9);
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
  //
  // B is authored on the CHILD side of that hinge (x > 10, the left of
  // hingeA->hingeB, Evaluate's own child-side rule) — exactly where a real
  // unfolded child panel sits — so the rotation is a real fold of a real
  // child, not a fold of material from A's own side.
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{10, 0}, {18, 0}, {18, 5}, {10, 5}};
  Transform3 anchorA = Transform3::Identity();

  const Point3 hingeAWorld{10, 5, 0};  // = aRunEnd's world position
  const Point3 axis{0, -1, 0};         // aRunStart's world position - aRunEnd's, normalized
  const double targetAngleDeg = 90.0;
  Transform3 anchorB = Transform3::RotationAboutAxis(hingeAWorld, axis, targetAngleDeg);

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(region.angleDeg == Approx(targetAngleDeg).margin(1e-6));
  CHECK(Dist2(region.aRunStart, {10, 0}) < 1e-6);
  CHECK(Dist2(region.aRunEnd, {10, 5}) < 1e-6);
}

// B authored on A's own side of the hinge, then folded: B's outline walks
// the seam the SAME way A's does — B's sheet normal is reversed relative to
// A. Still a real contact: reported as `flipped`, with B's refs already on
// FlipPart(B)'s outline, so splicing against that outline is exact.
TEST_CASE("DetectContact: a seam where B's normal is reversed is a flipped region, splicable after FlipPart",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  PartGraphSpec b;
  b.partId = "b";
  b.rootRegionPanelId = "b0";
  b.outline.outer = {{10, 0}, {10, 5}, {2, 5}, {2, 0}};
  b.thicknessMm = 1.0;
  b.anchor.transform = Transform3::RotationAboutAxis({10, 5, 0}, {0, -1, 0}, 90.0);

  auto contact = DetectContactSingle(outlineA, Transform3::Identity(), b.outline.outer, b.anchor.transform);
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(region.flipped);
  CHECK(std::fabs(std::fabs(region.angleDeg) - 90.0) < 1e-6);

  const PartGraphSpec flippedB = FlipPart(b);
  // B's refs name real vertices of the flipped outline, at the seam.
  CHECK(Dist2(region.bRunStart, RefPointForTest(flippedB.outline.outer, region.bStart)) < 1e-12);
  auto result = Reconcile(outlineA, flippedB.outline.outer, region);
  REQUIRE(result.ok);
  CHECK(result.combinedOutline.size() == 6);
  CHECK(ShoelaceArea(result.combinedOutline) == Approx(50.0 + 40.0).margin(1e-6));
}

TEST_CASE("DetectContact: an asymmetric seam - B's edge covers only PART of A's longer edge",
          "[part_merge]") {
  // A: 20-wide x 10-tall plate; its right edge (x=20, y in [0,10]) is one
  // plain, un-split edge. B: a 4x4 flange whose edge0 only covers y in [3,7]
  // — 3mm in from each of A's corners, clearly more than the contact
  // tolerance, so this is a genuine partial seam (TASK_SPEC.md F3).
  std::vector<Point2> outlineA = {{0, 0}, {20, 0}, {20, 10}, {0, 10}};
  std::vector<Point2> outlineB = {{0, 0}, {4, 0}, {4, 4}, {0, 4}};
  Transform3 anchorA = Transform3::Identity();

  // R maps local +x -> world -y, local +y -> world +z; local (0,0) lands at
  // A's (20,7) and local (4,0) at A's (20,3).
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 20; anchorB.t[1] = 7; anchorB.t[2] = 0;

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(Dist2(region.aRunStart, {20, 3}) < 1e-6);
  CHECK(Dist2(region.aRunEnd, {20, 7}) < 1e-6);
  CHECK(region.aStart.t > 0.0);  // mid-edge on A
  CHECK(region.bStart.t == 0.0);  // B's own corners
  CHECK(region.bEnd.t == 0.0);

  auto result = Reconcile(outlineA, outlineB, region);
  REQUIRE(result.ok);
  // A gains (20,3) and (20,7) on its right edge; B needs no insertion.
  // Combined: 6 + 4 - 2 shared = 8.
  CHECK(result.combinedOutline.size() == 8);

  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-6));
  CHECK(areaCombined > 0.0);
}

// A corner of the other part within the contact tolerance of a seam end is
// that end's corner — the closest one wins over any farther candidate.
TEST_CASE("DetectContact: at a seam end, the other part's closest vertex within tolerance is the shared corner",
          "[part_merge]") {
  // A's right edge carries an extra vertex at y=9.5, 0.5mm below its
  // corner (20,10). B's flange ends at y=9.7 in A's frame: both (20,9.5)
  // [0.2mm] and (20,10) [0.3mm] are within tolerance; the closest wins.
  std::vector<Point2> outlineA = {{0, 0}, {20, 0}, {20, 9.5}, {20, 10}, {0, 10}};
  std::vector<Point2> outlineB = {{0, 0}, {4, 0}, {4, 4}, {0, 4}};
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 20; anchorB.t[1] = 9.7; anchorB.t[2] = 0;  // B spans y in [5.7, 9.7]

  auto contact = DetectContactSingle(outlineA, Transform3::Identity(), outlineB, anchorB);
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(Dist2(region.aRunEnd, {20, 9.5}) < 1e-9);
  CHECK(region.aEnd.t == 0.0);
  CHECK(Dist2(region.aRunStart, {20, 5.7}) < 1e-6);  // 3.7mm from any A vertex: mid-edge
}

TEST_CASE("DetectContact: no real contact is a typed error", "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};
  Transform3 anchorA = Transform3::Identity();
  // B floats 500mm away in Z, at an angle — nowhere near A's boundary.
  Transform3 anchorB = Transform3::RotationAboutAxis({0, 0, 500}, {0, 1, 0}, 37.0);
  anchorB.t[2] += 500;

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE_FALSE(contact.ok);
  CHECK(contact.errorCode == MergeErrorCode::kNoContact);
  CHECK(contact.regions.empty());
}

// Live-app regression (2026-09-22, cauldron.step): a real multi-bend part's
// touching material can sit on a NON-ROOT region panel — that panel's true
// world position only exists via its own cascaded pose
// (manufacturing_graph_evaluator.cc's poseByRegionPanel), never via the
// part's root anchor applied to its whole flat pattern. Confirmed live: a
// panel genuinely 0.168mm from another part's boundary was reported ~450mm
// apart because the wrong (root) plane was checked. This is a minimal,
// hand-authored repro: part B has two candidate panels — its OWN root panel,
// positioned far from A (no real contact there), and a non-root panel using
// the exact same fold as the first test above (the one real contact). Real
// per-panel search must find the contact on the non-root panel and ignore
// the non-touching root panel, without the caller ever hinting which one to
// check.
TEST_CASE("DetectContact: contact on a non-root panel of a multi-panel part is found via that "
 "panel's own pose, not the part's root anchor",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};

  // B: one 5x16 flat outline, split by a hinge at y=8 into two panels.
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 16}, {0, 16}};
  // B's root panel (y in [8,16]) sits 500mm away — real material of B,
  // genuinely not touching A anywhere.
  std::vector<Point2> ringBRoot = {{0, 8}, {5, 8}, {5, 16}, {0, 16}};
  Transform3 poseBRoot = Transform3::Identity();
  poseBRoot.t[2] = 500;
  // B's non-root panel (y in [0,8]): the same fold as "two rectangles folded
  // 90deg" above — its edge (0,0)-(5,0) lands exactly on A's (10,0)-(10,5).
  std::vector<Point2> ringBChild = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};
  Transform3 poseBChild;
  poseBChild.r[0] = 0;  poseBChild.r[1] = 0; poseBChild.r[2] = -1;
  poseBChild.r[3] = -1; poseBChild.r[4] = 0; poseBChild.r[5] = 0;
  poseBChild.r[6] = 0;  poseBChild.r[7] = 1; poseBChild.r[8] = 0;
  poseBChild.t[0] = 10; poseBChild.t[1] = 5; poseBChild.t[2] = 0;

  auto contact = DetectContact(outlineA, {ContactPanelCandidate{outlineA, Transform3::Identity(), "panelA"}},
                                outlineB,
                                {ContactPanelCandidate{ringBRoot, poseBRoot, "panelB_root"},
                                 ContactPanelCandidate{ringBChild, poseBChild, "panelB_child"}});
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  CHECK(region.regionPanelIdA == "panelA");
  CHECK(region.regionPanelIdB == "panelB_child");
  CHECK(Dist2(region.aRunStart, {10, 0}) < 1e-6);
  CHECK(Dist2(region.aRunEnd, {10, 5}) < 1e-6);
  // Refs point at B's whole outline, not the panel ring.
  CHECK(region.bStart.edgeIndex == 0);
  CHECK(region.bStart.t == 0.0);
  CHECK(region.bEnd.edgeIndex == 1);
  CHECK(region.bEnd.t == 0.0);
  CHECK(std::fabs(std::fabs(region.angleDeg) - 90.0) < 1e-6);
}

// A hinge edge is internal to its part and can never be a seam, even when it
// happens to lie exactly where another part's edge is.
TEST_CASE("DetectContact: a panel's hinge edge is never a seam", "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 16}, {0, 16}};
  // B's upper panel, folded so its HINGE edge (5,8)->(0,8) lies on A's
  // (10,0)-(10,5); B's free edges stay off A's plane.
  std::vector<Point2> ringBRoot = {{0, 8}, {5, 8}, {5, 16}, {0, 16}};
  Transform3 pose;
  pose.r[0] = 0;  pose.r[1] = 0; pose.r[2] = -1;
  pose.r[3] = -1; pose.r[4] = 0; pose.r[5] = 0;
  pose.r[6] = 0;  pose.r[7] = 1; pose.r[8] = 0;
  pose.t[0] = 10; pose.t[1] = 5; pose.t[2] = -8;
  auto contact = DetectContact(outlineA, {ContactPanelCandidate{outlineA, Transform3::Identity(), "panelA"}},
                                outlineB, {ContactPanelCandidate{ringBRoot, pose, "panelB_root"}});
  REQUIRE_FALSE(contact.ok);
  CHECK(contact.errorCode == MergeErrorCode::kNoContact);
}

// Two edges that are one physical seam but differ in length by import noise
// (well under the contact tolerance): each seam end is the same corner on
// both parts, so no sub-mm step may be created in either outline.
TEST_CASE("DetectContact+ReconcileOutlines: seam ends within tolerance are shared corners, no sliver step",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  // B's seam edge is 0.06mm longer than A's (5.06 vs 5).
  std::vector<Point2> outlineB = {{0, 0}, {5.06, 0}, {5.06, 8}, {0, 8}};
  Transform3 anchorB;
  anchorB.r[0] = 0;  anchorB.r[1] = 0; anchorB.r[2] = -1;
  anchorB.r[3] = -1; anchorB.r[4] = 0; anchorB.r[5] = 0;
  anchorB.r[6] = 0;  anchorB.r[7] = 1; anchorB.r[8] = 0;
  anchorB.t[0] = 10; anchorB.t[1] = 5.03; anchorB.t[2] = 0;  // centred on A's edge

  auto contact = DetectContactSingle(outlineA, Transform3::Identity(), outlineB, anchorB);
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  // Every seam end is an existing vertex on its own outline.
  CHECK(region.aStart.t == 0.0);
  CHECK(region.aEnd.t == 0.0);
  CHECK(region.bStart.t == 0.0);
  CHECK(region.bEnd.t == 0.0);

  auto result = Reconcile(outlineA, outlineB, region);
  REQUIRE(result.ok);
  // No inserted vertices: 4 + 4 - 2 shared corners.
  CHECK(result.combinedOutline.size() == 6);
}

TEST_CASE("DetectContact: a genuinely coplanar pair is a typed error directing to fuse_bodies",
          "[part_merge]") {
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  std::vector<Point2> outlineB = {{20, 0}, {30, 0}, {30, 5}, {20, 5}};
  Transform3 anchorA = Transform3::Identity();
  Transform3 anchorB = Transform3::Identity();  // same plane as A, just offset in X

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE_FALSE(contact.ok);
  CHECK(contact.errorCode == MergeErrorCode::kCoplanarSeam);
  CHECK(contact.regions.empty());
}

TEST_CASE("DetectContact: two disjoint contact regions on the same panel pair are both returned",
          "[part_merge]") {
  // A: a 10x10 plate, right edge (10,-5)-(10,5) one plain unbroken edge.
  // B (local, CCW): a rectangle with a notch cut into its own bottom edge —
  // two separate "feet" both sitting at local y=0 (length 2 and length 4),
  // joined by a raised step at y=10 (well clear of the 2mm contact
  // tolerance, so the bridge is unambiguously NOT part of either contact
  // run) — a single flat (planar, as every part outline must be) polygon
  // that nonetheless touches A's plane along two physically disjoint
  // stretches once folded: one real B, two disjoint real contacts, BOTH
  // returned (TASK_SPEC.md §8.3 phase 2 — no longer picking one "best"
  // region and discarding the other).
  // A's right edge spans y in [-10,10], so none of A's corners is within the
  // contact tolerance of either foot's ends.
  std::vector<Point2> outlineA = {{0, -10}, {10, -10}, {10, 10}, {0, 10}};
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

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  // Two disjoint regions found: the length-2 foot at local x in [0,2], the
  // length-4 foot at local x in [3,7] — both present, neither discarded.
  REQUIRE(contact.regions.size() == 2);

  const ContactRegion& longer = LongestRegion(contact);
  CHECK(Dist2(longer.aRunStart, {10, -2}) < 1e-6);
  CHECK(Dist2(longer.aRunEnd, {10, 2}) < 1e-6);
  CHECK(Dist2(longer.bRunStart, {3, 0}) < 1e-6);
  CHECK(Dist2(longer.bRunEnd, {7, 0}) < 1e-6);
  CHECK(longer.lengthMm == Approx(4.0).margin(1e-6));

  const ContactRegion& shorter =
      &longer == &contact.regions[0] ? contact.regions[1] : contact.regions[0];
  CHECK(shorter.lengthMm == Approx(2.0).margin(1e-6));
}

// Live-app regression (2026-09-14): the EXACT real outlines/anchors captured
// from merge_bodies_with_bend.integration.test.ts's "ZZZ REPRO" dump (a real
// testcube.step import, split_part_at_bend on every bend with
// keep_corner_on='parent', Protrusion2 translated +75mm on Y, fuse_bodies
// onto the resulting panel, then merge_bodies_with_bend against another
// imported component) — reproduced live as GE_MERGE_SELF_INTERSECTION
// ("spliced outline would self-intersect - detected contact interval was
// wrong"), with no STEP import and no TS layer involved, isolating the
// failure to this module alone. Values are bit-for-bit what the TS repro
// dumped (not hand-derived or rounded).
//
// Root cause: outlineA is a hexagon - a 150x150 main panel plus a fused
// protrusion "wing" hanging off its left edge (vertices 0-2), whose own
// near-bottom edge (vertex2->vertex3, (-24.05,-0.05) to (0.05,0)) is
// ALMOST but not exactly collinear with the panel's TRUE bottom edge
// (vertex3->vertex4, (0.05,0) to (150.95,0)) - a real ~0.05mm kink baked
// into this fixture's own STEP geometry, not import noise from this
// recipe. DetectContact's own A-side coverage scan (part_merge.cc) checks
// every A edge independently against a flat kMergeContactToleranceMm
// (2mm) perpendicular-distance tolerance, and picked whichever qualifying
// edge came FIRST in outlineA's own array order to set aLineOrigin/
// aLineDirHat (the line B's boundary gets projected onto). The wing edge
// is checked first (index 2, before the true seam edge at index 3) and is
// well within that 2mm band, so its own (slightly tilted) line won by
// pure accident even though its genuine overlap with this run's own
// [0, runLen] window is only ~0.05mm - a coincidental sliver, not a real
// physical touch - against the true seam edge's ~150mm overlap. Landing
// on the wrong line projected the run's boundary ~0.05-0.3mm short of
// vertex3, not onto it; ReconcileOutlines then spliced B onto a point
// that wasn't quite A's real corner, leaving a razor-thin sliver of the
// wing's own edge unconsumed, which SegmentsBadOverlap correctly flagged.
//
// FIXED: aLineOrigin/aLineDirHat are now chosen by whichever qualifying
// edge has the GREATEST positive-length overlap with the run's own
// window, not simply the first one found in array order - the true seam
// edge's ~150mm overlap always dominates a coincidental sliver like the
// wing edge's 0.05mm. Also added: an edge whose own extent doesn't
// positively overlap the run's window at all (a touch or a miss) no
// longer counts as coverage, the same "positive-length overlap, not just
// a touch" distinction SegmentsBadOverlap already relies on elsewhere.
TEST_CASE("DetectContact+ReconcileOutlines: a fused protrusion's near-collinear wing edge no "
 "longer steals A-side seam coverage (regression for the fix above)",
          "[part_merge]") {
  std::vector<Point2> outlineA = {
      {0.05000000000001137, 150},
      {-24, 150.05},
      {-24.049999999999997, -0.05000000000001137},
      {0.05000000000001137, 0},
      {150.94999999999996, 0},
      {150.94999999999996, 150},
  };
  Transform3 anchorA;
  anchorA.r[0] = 1; anchorA.r[1] = 0; anchorA.r[2] = 0;
  anchorA.r[3] = 0; anchorA.r[4] = 0; anchorA.r[5] = 1;
  anchorA.r[6] = 0; anchorA.r[7] = -1; anchorA.r[8] = 0;
  anchorA.t[0] = -75; anchorA.t[1] = 74.275; anchorA.t[2] = 75;

  std::vector<Point2> outlineB = {
      {149.95, 74.95000000000002},
      {150, 150},
      {76.05, 150},
      {0, 150},
      {0, 76.05000000000001},
      {0, 1.4210854715202004e-14},
      {74.95, 0},
      {150, 1.4210854715202004e-14},
  };
  Transform3 anchorB;
  anchorB.r[0] = 1; anchorB.r[1] = 0; anchorB.r[2] = 0;
  anchorB.r[3] = 0; anchorB.r[4] = 1; anchorB.r[5] = 0;
  anchorB.r[6] = 0; anchorB.r[7] = 0; anchorB.r[8] = 1;
  anchorB.t[0] = -75; anchorB.t[1] = -75.00000000000001; anchorB.t[2] = 74.25;

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  CHECK(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  // The seam lies on A's true seam edge, never on the wing's near-collinear
  // edge. Each end is A's own corner: B's corners (0,0)/(150,0) are 0.05mm
  // and 0.95mm from A's (0.05,0)/(150.95,0) — the closest A vertex within
  // the contact tolerance, so shared corners, no sliver step inserted.
  CHECK(Dist2(region.aRunStart, {0.05000000000001137, 0}) < 1e-9);
  CHECK(Dist2(region.aRunEnd, {150.94999999999996, 0}) < 1e-9);
  CHECK(region.aStart.t == 0.0);
  CHECK(region.aEnd.t == 0.0);

  auto result = Reconcile(outlineA, outlineB, region);
  REQUIRE(result.ok);
  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  // B's two seam corners move onto A's, 0.05mm and 0.95mm along the seam;
  // B is 150mm tall, so the area changes by at most (0.05+0.95)*150/2.
  CHECK(std::fabs(areaCombined - (areaA + areaB)) <= (0.05 + 0.95) * 150.0 / 2.0);
  CHECK(areaCombined > 0.0);  // still CCW
}

// STEP 2 (structured repro, live-app regression 2026-09): the EXACT real
// outlines/anchors captured from
// merge_bodies_with_bend.integration.test.ts's "STEP 1" repro (a real
// testcube.step import, split_part_at_bend on every bend with
// keep_corner_on='parent', Protrusion1 translated -76.6mm on Y, fuse_bodies
// onto the resulting panel, then merge_bodies_with_bend against another
// imported component) — originally reproduced "edgeB0/edgeB1 are not a
// consecutive pair after vertex resolution" with NO STEP import, NO TS
// layer, isolating the failure to this module alone. Values are bit-for-bit
// what the TS repro dumped (not hand-derived or rounded). Now asserts the
// FIXED behavior: the real relief-cut midpoint (74.95, 0) sitting between
// edgeB0/edgeB1 is dropped as part of the vanishing seam, not rejected.
TEST_CASE("ReconcileOutlines: live-app regression - B's outline carries a real vertex strictly "
 "between edgeB0 and edgeB1 (a relief-cut midpoint), absorbed into the seam",
          "[part_merge]") {
  std::vector<Point2> outlineA = {
      {450, 5.684341886080802e-14},
      {450, 150.00000000000006},
      {300.04999999999995, 150},
      {275.94999999999993, 150.05},
      {275.99999999999994, 0},
  };
  Transform3 anchorA;
  anchorA.r[0] = -1; anchorA.r[1] = 0; anchorA.r[2] = -3.2162452993532727e-16;
  anchorA.r[3] = 3.2162452993532727e-16; anchorA.r[4] = 0; anchorA.r[5] = -1;
  anchorA.r[6] = 0; anchorA.r[7] = -1; anchorA.r[8] = 0;
  anchorA.t[0] = 375; anchorA.t[1] = -75.7250000000001; anchorA.t[2] = 75;

  std::vector<Point2> outlineB = {
      {149.95, 74.95000000000002},
      {150, 150},
      {76.05, 150},
      {0, 150},
      {0, 76.05000000000001},
      {0, 1.4210854715202004e-14},
      {74.95, 0},
      {150, 1.4210854715202004e-14},
  };
  Transform3 anchorB = Transform3::Identity();
  anchorB.t[0] = -75; anchorB.t[1] = -75.00000000000001; anchorB.t[2] = 74.25;

  auto contact = DetectContactSingle(outlineA, anchorA, outlineB, anchorB);
  REQUIRE(contact.ok);
  REQUIRE(contact.regions.size() == 1);
  const ContactRegion& region = contact.regions[0];
  // DetectContact itself succeeds — the bad B outline vertex (74.95, 0)
  // sitting between bRunStart and bRunEnd is real, in-tolerance seam
  // material; DetectContact's own interval selection is not what's
  // rejecting this case.
  CHECK(Dist2(region.bRunStart, {0, 0}) < 1e-6);
  CHECK(Dist2(region.bRunEnd, {150, 0}) < 1e-6);

  auto result = Reconcile(outlineA, outlineB, region);
  // FIXED behavior: B's real vertex (74.95, 0), sitting strictly between
  // edgeB0=(0,0) and edgeB1=(150,0) in outlineB's own array order, is
  // absorbed into the vanishing seam instead of causing a rejection.
  REQUIRE(result.ok);
  CHECK(result.combinedOutline.size() == 11);
  double areaA = std::fabs(ShoelaceArea(outlineA));
  double areaB = std::fabs(ShoelaceArea(outlineB));
  double areaCombined = ShoelaceArea(result.combinedOutline);
  CHECK(areaCombined == Approx(areaA + areaB).margin(1e-3));
  CHECK(areaCombined > 0.0);  // still CCW
}

// STEP 4 (structured repro): minimal, hand-authored unit test targeting the
// EXACT failing component step 3's root-cause analysis identified.
//
// Root cause (found by hand-replicating the earlier reverted fix's splice
// logic against the real captured geometry above, with NO changes to
// part_merge.cc itself): that fix's A-side combining loop assumed
// `a1Idx > kFinal` always (`for (i = a1Idx; i < n; ++i)`), copied from the
// simple case's `kFinal + 1`. That assumption breaks whenever the seam wraps
// across the outline array's own physical start/end boundary — i.e.
// edgeA0 resolves near the END of the array (kFinal close to n-1) while
// edgeA1 resolves near the START (a1Idx close to 0), which is exactly what
// happens whenever LocateOrInsertVertex's "insert after the last edge"
// case (part_merge.cc's own `insertAt == 0 -> push_back` branch) fires for
// edgeA0. In that case `a1Idx <= kFinal`, and `for (i = a1Idx; i < n; ++i)`
// re-walks a chunk of A's own outline a SECOND time into `combined`,
// producing a self-intersecting, duplicate-vertex polygon — confirmed live:
// hand-replicating the exact reverted splice logic against the real
// captured geometry from the live-app regression produced a 17-vertex
// outline that was literally A's 5 vertices emitted twice. That corrupted
// 2D outline is what the downstream region-panel evaluator turned into the
// visible extra panel/fin.
//
// This test is a minimal repro of the SAME index-arithmetic shape (kFinal
// near n-1, a1Idx = 0, with one genuine interior vertex that must be
// dropped) — small enough to hand-verify the correct combinedOutline
// exactly. It is the correctness spec the fix must satisfy: it must handle
// the wrap-around case WITHOUT duplicating any vertex.
TEST_CASE("ReconcileOutlines: a real interior vertex on a seam that wraps across the outline "
 "array's own start/end boundary - the fix must not duplicate A's outline",
          "[part_merge]") {
  // A: a 10x5 rectangle with one genuine extra vertex (0,1) already sitting
  // on its own left edge (a "relief-cut midpoint," same real-world shape as
  // the live-app regression above) — so the left edge is really two
  // sub-edges, (0,5)->(0,1) and (0,1)->(0,0), CCW.
  std::vector<Point2> outlineA = {{0, 0}, {10, 0}, {10, 5}, {0, 5}, {0, 1}};
  // The seam is A's ENTIRE left edge, (0,5) to (0,0) — both endpoints are
  // ALREADY exact outline vertices (kFinal=3, a1Idx=0): no insertion needed,
  // yet a1Idx <= kFinal, the exact wrap-around shape that broke the earlier
  // fix attempt (that attempt's bug fires whenever a1Idx <= kFinal, whether
  // or not either point required insertion).
  const OutlineRef edgeA0{3, 0.0};  // (0,5)
  const OutlineRef edgeA1{0, 0.0};  // (0,0)

  // B: a 5-wide x 3-tall rectangle whose own edge0 (length 5) exactly
  // matches A's seam length.
  std::vector<Point2> outlineB = {{0, 0}, {5, 0}, {5, 3}, {0, 3}};
  const OutlineRef edgeB0{0, 0.0};  // (0,0)
  const OutlineRef edgeB1{1, 0.0};  // (5,0)

  auto result = ReconcileOutlines(outlineA, edgeA0, edgeA1, outlineB, edgeB0, edgeB1);

  // FIXED behavior: kFinal=3, a1Idx=0 (a1Idx <= kFinal, the wrap-around
  // shape) — the interior vertex (0,1) is absorbed into the vanishing seam
  // instead of causing a rejection.
  REQUIRE(result.ok);

  // Hand-derived expected result: A's own material, walked from a1Idx(0)
  // forward to kFinal(3) INCLUSIVE — (0,0),(10,0),(10,5),(0,5) — correctly
  // dropping the interior vertex (0,1), which belongs to the vanishing seam
  // — plus B's own material (excluding its shared edge0), rotated/placed by
  // T(edgeB0)=edgeA1, T(edgeB1)=edgeA0: (5,3)->(-3,5), (0,3)->(-3,0).
  // Combined: a 10x5 rectangle with a 3x5 flap glued flush onto its whole
  // left edge — EXACTLY this (6 vertices, no duplicates), NOT the
  // 9-raw-point, overlapping mess the earlier (reverted) fix attempt's
  // `for (i = a1Idx; i < n; ++i)` loop would have produced by re-emitting
  // indices [0,1,2,3] a second time.
  std::vector<Point2> expected = {{0, 0}, {10, 0}, {10, 5}, {0, 5}, {-3, 5}, {-3, 0}};
  REQUIRE(result.combinedOutline.size() == expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    CHECK(Dist2(result.combinedOutline[i], expected[i]) < 1e-9);
  }
  CHECK(ShoelaceArea(result.combinedOutline) == Approx(65.0).margin(1e-6));
}
