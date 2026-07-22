#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/point_mapping.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

constexpr double kTestPi = 3.14159265358979323846;

double Dist3(const Point3& a, const Point3& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) +
                    (a.z - b.z) * (a.z - b.z));
}
double Dist2(const Point2& a, const Point2& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

// A two-panel graph (seg0 -> bend0 -> seg1), real (possibly nonzero) radius,
// matching manufacturing_graph_evaluator_test.cc's own MakeStrip conventions
// (a documented, independent duplicate — see that file's own comment for why).
PartGraphSpec MakeTwoPanel(double segmentLenMm, double widthMm, double thicknessMm,
                           double angleDeg, double radiusMm = 0.0, double kFactor = 0.0) {
  PartGraphSpec graph;
  graph.partId = "test-part";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();

  double angleRad = std::fabs(angleDeg) * kTestPi / 180.0;
  double ba = angleRad * (radiusMm + kFactor * thicknessMm);
  double totalLen = 2.0 * segmentLenMm + ba;

  graph.outline.outer = {{0, 0}, {totalLen, 0}, {totalLen, widthMm}, {0, widthMm}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "seg0";
  bend.childRegionPanelId = "seg1";
  double hx = segmentLenMm + ba / 2.0;
  bend.hingeA = {hx, widthMm};
  bend.hingeB = {hx, 0};
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);
  return graph;
}

// A branching (Y-shaped) graph: root F0 has TWO children, L (west) and R
// (east) — a minimal reproduction of Slice 2's cross-cube-net branching,
// enough to exercise reverse mapping's ownership resolution without needing
// the full 6-face net. Hinge conventions match the validated cross-cube-net
// driver (ts/tests/integration/suite_driver_v2_nets.integration.test.ts's
// own computeHinge): west hingeA=(0,low-y)/hingeB=(0,high-y); east
// hingeA=(s,high-y)/hingeB=(s,low-y) — mirrored order, real (possibly
// nonzero) bend radius so bridge zones have real width too.
PartGraphSpec MakeBranchingY(double faceSizeMm, double thicknessMm, double radiusMm = 0.0,
                             double kFactor = 0.0) {
  double s = faceSizeMm;
  double angleRad = kTestPi / 2.0;
  double ba = angleRad * (radiusMm + kFactor * thicknessMm);

  PartGraphSpec graph;
  graph.partId = "branching-y";
  graph.rootRegionPanelId = "F0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {{-s - ba, 0}, {2 * s + ba, 0}, {2 * s + ba, s}, {-s - ba, s}};

  BendSpec toL;
  toL.id = "toL";
  toL.parentRegionPanelId = "F0";
  toL.childRegionPanelId = "L";
  toL.hingeA = {0, 0};
  toL.hingeB = {0, s};
  toL.angleDeg = 90.0;
  toL.radiusMm = radiusMm;
  toL.kFactor = kFactor;

  BendSpec toR;
  toR.id = "toR";
  toR.parentRegionPanelId = "F0";
  toR.childRegionPanelId = "R";
  toR.hingeA = {s, s};
  toR.hingeB = {s, 0};
  toR.angleDeg = 90.0;
  toR.radiusMm = radiusMm;
  toR.kFactor = kFactor;

  graph.bends = {toL, toR};
  return graph;
}

}  // namespace

// ─── Forward mapping: region panels ─────────────────────────────────────────

TEST_CASE("MapPointToWorld: single flat panel, identity anchor, maps directly",
          "[translation][mapping]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  MapToWorldResult result = MapPointToWorld(graph, layout, {30, 20});
  REQUIRE(result.ok);
  CHECK(result.regionPanelId == "only");
  CHECK(result.bendId.empty());
  CHECK(result.point3d.x == Approx(30.0));
  CHECK(result.point3d.y == Approx(20.0));
  CHECK(result.point3d.z == Approx(0.0));
}

TEST_CASE("MapPointToWorld: point outside every region reports GE_POINT_NOT_ON_PART",
          "[translation][mapping][errors]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  MapToWorldResult result = MapPointToWorld(graph, layout, {500, 500});
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == MapErrorCode::kPointNotOnPart);
}

TEST_CASE("MapPointToWorld: point on a folded panel uses that panel's own chain",
          "[translation][mapping]") {
  auto graph = MakeTwoPanel(60.0, 40.0, 1.0, 90.0, 2.0, 0.4);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : layout.panels)
    if (p.regionPanelId == "seg1") seg1 = &p;
  REQUIRE(seg1 != nullptr);

  // A point at seg1's own far corner (local, in F) should equal seg1's own
  // pose applied directly — MapPointToWorld must not accidentally use seg0's
  // chain for a point that belongs to seg1.
  Point2 farCornerLocal = seg1->regionOuter[1];  // an arbitrary real vertex
  MapToWorldResult result = MapPointToWorld(graph, layout, farCornerLocal);
  REQUIRE(result.ok);
  CHECK(result.regionPanelId == "seg1");
  Point3 expected = seg1->pose.Apply({farCornerLocal.x, farCornerLocal.y, 0.0});
  CHECK(Dist3(result.point3d, expected) < 1e-9);
}

// ─── Forward mapping: bend bridges (13 §4.3's Z_i) ──────────────────────────

TEST_CASE("MapPointToWorld: bridge zone boundaries match the adjacent panels exactly",
          "[translation][mapping][bridge]") {
  auto graph = MakeTwoPanel(60.0, 40.0, 1.0, 90.0, 2.0, 0.4);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : layout.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  // Find each panel's own tagged edge for bend0.
  auto taggedEdge = [](const RegionPanelLayout* panel, const std::string& bendId) {
    size_t n = panel->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (panel->edgeBendId[i] == bendId) return panel->regionOuter[i];
    }
    FAIL("no tagged edge found for " << bendId);
    return Point2{};
  };
  Point2 parentEdgePoint = taggedEdge(seg0, "bend0");
  Point2 childEdgePoint = taggedEdge(seg1, "bend0");

  // At u=0 (the parent-side zone boundary), the bridge map must equal the
  // parent's own bottom-face point exactly (13 §4.3: "At u=0 this equals the
  // parent's bottom plane").
  MapToWorldResult atParentEdge = MapPointToWorld(graph, layout, parentEdgePoint);
  REQUIRE(atParentEdge.ok);
  Point3 expectedAtParent = seg0->pose.Apply({parentEdgePoint.x, parentEdgePoint.y, 0.0});
  CHECK(Dist3(atParentEdge.point3d, expectedAtParent) < 1e-6);

  // At u=BA (the child-side zone boundary), the bridge map must equal the
  // child's own bottom-face attachment point ("tangent continuity").
  MapToWorldResult atChildEdge = MapPointToWorld(graph, layout, childEdgePoint);
  REQUIRE(atChildEdge.ok);
  Point3 expectedAtChild = seg1->pose.Apply({childEdgePoint.x, childEdgePoint.y, 0.0});
  CHECK(Dist3(atChildEdge.point3d, expectedAtChild) < 1e-6);
}

TEST_CASE("MapPointToWorld: mid-bridge point stays exactly as far from the "
          "pivot axis as the parent's own zone-boundary point (rotation "
          "preserves distance-to-axis)",
          "[translation][mapping][bridge]") {
  auto graph = MakeTwoPanel(60.0, 40.0, 1.0, 90.0, 2.0, 0.4);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);
  REQUIRE(layout.bridges.size() == 1);
  const BridgeLayout& bridge = layout.bridges[0];

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : layout.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  Point2 parentA, parentB, childA, childB;
  {
    size_t n = seg0->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (seg0->edgeBendId[i] == "bend0") {
        parentA = seg0->regionOuter[i];
        parentB = seg0->regionOuter[(i + 1) % n];
        break;
      }
    }
    n = seg1->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (seg1->edgeBendId[i] == "bend0") {
        childA = seg1->regionOuter[i];
        childB = seg1->regionOuter[(i + 1) % n];
        break;
      }
    }
  }
  // A genuinely INTERIOR bridge point (u strictly between the parent's u=0
  // boundary and the child's u=BA boundary — a boundary point is legitimately
  // ambiguous between "region panel" and "bridge" ownership by design, see
  // 13 §4.3's own continuity statement, so it isn't a useful probe here):
  // average the parent edge's own midpoint with the child edge's own
  // midpoint, both at the same axial (s) position.
  Point2 parentMid{(parentA.x + parentB.x) / 2.0, (parentA.y + parentB.y) / 2.0};
  Point2 childMid{(childA.x + childB.x) / 2.0, (childA.y + childB.y) / 2.0};
  Point2 query{(parentMid.x + childMid.x) / 2.0, (parentMid.y + childMid.y) / 2.0};

  MapToWorldResult result = MapPointToWorld(graph, layout, query);
  REQUIRE(result.ok);
  CHECK(result.bendId == "bend0");

  // Distance from the axis LINE (pivotOriginWorld is just A point on it, not
  // necessarily the closest — project onto pivotAxisWorld and subtract).
  auto distFromAxisLine = [&](const Point3& p) {
    Point3 rel = {p.x - bridge.pivotOriginWorld.x, p.y - bridge.pivotOriginWorld.y,
                  p.z - bridge.pivotOriginWorld.z};
    const Point3& axis = bridge.pivotAxisWorld;
    double along = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
    Point3 perp = {rel.x - along * axis.x, rel.y - along * axis.y, rel.z - along * axis.z};
    return std::sqrt(perp.x * perp.x + perp.y * perp.y + perp.z * perp.z);
  };

  // NOT radiusMm: the flat pattern's zone-boundary offset (BA/2, an
  // ARC-LENGTH quantity) is a different distance from the parent's own
  // geometric distance-to-axis in 3D — conflating the two was a real bug in
  // an earlier version of this test (see point_mapping.cc's own comment on
  // MapPointToWorld's bridge loop for the full story). The correct, general
  // invariant is simply that ROTATION preserves distance-to-axis — so the
  // mid-bridge point must be exactly as far from the axis as "a" (the SAME
  // query's own u=0 reference point) is, whatever that distance happens to be.
  MapToWorldResult atParentBoundary = MapPointToWorld(graph, layout, parentMid);
  REQUIRE(atParentBoundary.ok);
  double radiusOfA = distFromAxisLine(atParentBoundary.point3d);
  double radiusOfMidpoint = distFromAxisLine(result.point3d);
  CHECK(radiusOfMidpoint == Approx(radiusOfA).margin(1e-6));
}

// ─── Reverse mapping: round trip ────────────────────────────────────────────

TEST_CASE("MapPointToFlat: round trip (2D->3D->2D) recovers the original point, "
          "region panel",
          "[translation][mapping][roundtrip]") {
  auto graph = MakeTwoPanel(60.0, 40.0, 1.0, 90.0, 2.0, 0.4);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  for (auto& panel : layout.panels) {
    for (double fx : {0.1, 0.5, 0.9}) {
      for (double fy : {0.1, 0.5, 0.9}) {
        // Interior sample points (not on the boundary, to avoid the
        // "belongs to both neighbours" ambiguity at a shared hinge).
        double minX = panel.regionOuter[0].x, maxX = panel.regionOuter[0].x;
        double minY = panel.regionOuter[0].y, maxY = panel.regionOuter[0].y;
        for (auto& v : panel.regionOuter) {
          minX = std::min(minX, v.x);
          maxX = std::max(maxX, v.x);
          minY = std::min(minY, v.y);
          maxY = std::max(maxY, v.y);
        }
        Point2 query{minX + fx * (maxX - minX), minY + fy * (maxY - minY)};
        MapToWorldResult toWorld = MapPointToWorld(graph, layout, query);
        REQUIRE(toWorld.ok);
        REQUIRE(toWorld.regionPanelId == panel.regionPanelId);

        MapToFlatResult toFlat = MapPointToFlat(graph, layout, toWorld.point3d);
        REQUIRE(toFlat.ok);
        CHECK(toFlat.regionPanelId == panel.regionPanelId);
        CHECK(Dist2(toFlat.point2d, query) < 1e-6);
        CHECK(toFlat.residualMm < 1e-6);
      }
    }
  }
}

TEST_CASE("MapPointToFlat: round trip through a bend bridge recovers the "
          "original point and owning bendId",
          "[translation][mapping][roundtrip][bridge]") {
  auto graph = MakeTwoPanel(60.0, 40.0, 1.0, 90.0, 2.0, 0.4);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  const RegionPanelLayout* seg0 = nullptr;
  const RegionPanelLayout* seg1 = nullptr;
  for (auto& p : layout.panels) {
    if (p.regionPanelId == "seg0") seg0 = &p;
    if (p.regionPanelId == "seg1") seg1 = &p;
  }
  REQUIRE(seg0 != nullptr);
  REQUIRE(seg1 != nullptr);

  Point2 parentA, parentB, childA, childB;
  {
    size_t n = seg0->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (seg0->edgeBendId[i] == "bend0") {
        parentA = seg0->regionOuter[i];
        parentB = seg0->regionOuter[(i + 1) % n];
        break;
      }
    }
    n = seg1->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (seg1->edgeBendId[i] == "bend0") {
        childA = seg1->regionOuter[i];
        childB = seg1->regionOuter[(i + 1) % n];
        break;
      }
    }
  }
  // A handful of GENUINELY INTERIOR points (both axial position s and
  // perpendicular position u vary) — boundary points (u=0 or u=BA) are
  // legitimately ambiguous between "region panel" and "bridge" ownership by
  // design (13 §4.3's continuity statement), so they can't discriminate this
  // test's own claim (bendId == "bend0").
  for (double s : {0.1, 0.5, 0.9}) {
    Point2 parentAtS{parentA.x + s * (parentB.x - parentA.x),
                     parentA.y + s * (parentB.y - parentA.y)};
    Point2 childAtS{childA.x + s * (childB.x - childA.x),
                    childA.y + s * (childB.y - childA.y)};
    for (double u : {0.25, 0.5, 0.75}) {
      Point2 query{parentAtS.x + u * (childAtS.x - parentAtS.x),
                   parentAtS.y + u * (childAtS.y - parentAtS.y)};
      MapToWorldResult toWorld = MapPointToWorld(graph, layout, query);
      REQUIRE(toWorld.ok);
      REQUIRE(toWorld.bendId == "bend0");

      MapToFlatResult toFlat = MapPointToFlat(graph, layout, toWorld.point3d);
      REQUIRE(toFlat.ok);
      CHECK(toFlat.bendId == "bend0");
      CHECK(Dist2(toFlat.point2d, query) < 1e-6);
    }
  }
}

TEST_CASE("MapPointToFlat: point far from every surface reports GE_POINT_NOT_ON_PART",
          "[translation][mapping][errors]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  MapToFlatResult result = MapPointToFlat(graph, layout, {1000, 1000, 1000});
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == MapErrorCode::kPointNotOnPart);
}

// ─── Branching: the association-swap defect this whole design exists to ────
// ─── prevent (13 §5.1 — "under this procedure a swapped answer is           ─
// ─── impossible") ────────────────────────────────────────────────────────

TEST_CASE("MapPointToFlat: never swaps ownership between siblings at a "
          "branching node (v1's association-swap defect)",
          "[translation][mapping][roundtrip][branching]") {
  auto graph = MakeBranchingY(50.0, 1.0);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);
  REQUIRE(layout.panels.size() == 3);

  // Sample interior points on EVERY panel (including near the shared corners
  // at the branch point, where a swap is most likely) and require every
  // round trip to return to the SAME panel it started from.
  for (auto& panel : layout.panels) {
    double minX = panel.regionOuter[0].x, maxX = panel.regionOuter[0].x;
    double minY = panel.regionOuter[0].y, maxY = panel.regionOuter[0].y;
    for (auto& v : panel.regionOuter) {
      minX = std::min(minX, v.x);
      maxX = std::max(maxX, v.x);
      minY = std::min(minY, v.y);
      maxY = std::max(maxY, v.y);
    }
    for (double fx : {0.05, 0.5, 0.95}) {
      for (double fy : {0.05, 0.5, 0.95}) {
        Point2 query{minX + fx * (maxX - minX), minY + fy * (maxY - minY)};
        MapToWorldResult toWorld = MapPointToWorld(graph, layout, query);
        REQUIRE(toWorld.ok);
        REQUIRE(toWorld.regionPanelId == panel.regionPanelId);

        MapToFlatResult toFlat = MapPointToFlat(graph, layout, toWorld.point3d);
        REQUIRE(toFlat.ok);
        INFO("panel=" << panel.regionPanelId << " query=(" << query.x << "," << query.y << ")");
        CHECK(toFlat.regionPanelId == panel.regionPanelId);
        CHECK(Dist2(toFlat.point2d, query) < 1e-6);
      }
    }
  }
}
