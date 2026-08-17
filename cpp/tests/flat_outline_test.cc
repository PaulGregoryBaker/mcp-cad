#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/flat_outline.hpp"
#include "geometry/translation/manufacturing_graph_evaluator.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

constexpr double kPi = 3.14159265358979323846;

double BendAllowanceMm(double angleDeg, double radiusMm, double kFactor, double thicknessMm) {
  double angleRad = std::fabs(angleDeg * kPi / 180.0);
  return angleRad * (radiusMm + kFactor * thicknessMm);
}

double PolygonArea(const std::vector<Point2>& ring) {
  double sum = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return std::fabs(sum) / 2.0;
}

std::vector<Point2> Rect(double x0, double y0, double x1, double y1) {
  return {{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}};
}

// A rectangle [0,widthMm] x [0,heightMm] split by ONE vertical bend at
// x=hingeXMm (if hingeVertical) or one horizontal bend at y=hingeXMm (if
// !hingeVertical, "hingeXMm" then means the y-coordinate) — flush-authored
// (zero bend-allowance baseline), matching MakeStrip's own discipline in
// manufacturing_graph_evaluator_test.cc.
PartGraphSpec MakeTwoPanel(double widthMm, double heightMm, double hingeAtMm, bool hingeVertical,
                            double angleDeg, double radiusMm, double kFactor, double thicknessMm) {
  PartGraphSpec graph;
  graph.partId = "flat-outline-test";
  graph.rootRegionPanelId = "root";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = Rect(0, 0, widthMm, heightMm);

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "root";
  bend.childRegionPanelId = "child";
  if (hingeVertical) {
    bend.hingeA = {hingeAtMm, heightMm};
    bend.hingeB = {hingeAtMm, 0.0};
  } else {
    bend.hingeA = {widthMm, hingeAtMm};
    bend.hingeB = {0.0, hingeAtMm};
  }
  bend.angleDeg = angleDeg;
  bend.radiusMm = radiusMm;
  bend.kFactor = kFactor;
  graph.bends.push_back(bend);
  return graph;
}

}  // namespace

TEST_CASE("BuildFlatOutline: no bends returns the root panel's own outline directly",
          "[translation][flat_outline]") {
  PartGraphSpec graph;
  graph.partId = "no-bend";
  graph.rootRegionPanelId = "root";
  graph.thicknessMm = 1.0;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = Rect(0, 0, 10, 5);

  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(50.0));
}

TEST_CASE("BuildFlatOutline: BA=0 is a no-op, area matches the raw outline exactly",
          "[translation][flat_outline]") {
  auto graph = MakeTwoPanel(100.0, 20.0, 50.0, /*hingeVertical=*/true, 90.0,
                             /*radiusMm=*/0.0, /*kFactor=*/0.0, /*thicknessMm=*/2.0);
  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);
  CHECK(PolygonArea(result.outer) == Approx(100.0 * 20.0));
}

TEST_CASE("BuildFlatOutline: a real bend allowance grows the outline by exactly BA*hingeLength "
          "(vertical hinge)",
          "[translation][flat_outline]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0, heightMm = 20.0;
  auto graph = MakeTwoPanel(100.0, heightMm, 50.0, /*hingeVertical=*/true, 90.0, radiusMm, kFactor,
                             thicknessMm);
  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);

  double ba = BendAllowanceMm(90.0, radiusMm, kFactor, thicknessMm);
  double expectedArea = (100.0 + ba) * heightMm;
  CHECK(PolygonArea(result.outer) == Approx(expectedArea).margin(1e-6));

  double minX = 1e9, maxX = -1e9;
  for (const auto& p : result.outer) {
    minX = std::min(minX, p.x);
    maxX = std::max(maxX, p.x);
  }
  CHECK((maxX - minX) == Approx(100.0 + ba).margin(1e-6));
}

// Same fixture, rotated 90° (horizontal hinge) — a real regression guard
// for the strip-winding bug found live in an earlier (reverted) TS
// implementation of this same computation: the naive [near, far-reversed]
// corner order happened to produce a clockwise-wound quad for a VERTICAL
// hinge specifically, which PolygonUnion then silently reported as two
// disjoint faces. This case exercises the other axis to catch the same
// class of bug if it recurs.
TEST_CASE("BuildFlatOutline: a real bend allowance grows the outline by exactly BA*hingeLength "
          "(horizontal hinge)",
          "[translation][flat_outline]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0, widthMm = 20.0;
  auto graph = MakeTwoPanel(widthMm, 100.0, 50.0, /*hingeVertical=*/false, 90.0, radiusMm, kFactor,
                             thicknessMm);
  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);

  double ba = BendAllowanceMm(90.0, radiusMm, kFactor, thicknessMm);
  double expectedArea = widthMm * (100.0 + ba);
  CHECK(PolygonArea(result.outer) == Approx(expectedArea).margin(1e-6));

  double minY = 1e9, maxY = -1e9;
  for (const auto& p : result.outer) {
    minY = std::min(minY, p.y);
    maxY = std::max(maxY, p.y);
  }
  CHECK((maxY - minY) == Approx(100.0 + ba).margin(1e-6));
}

TEST_CASE("BuildFlatOutline: a negative (valley) fold angle grows the outline the same way",
          "[translation][flat_outline]") {
  double radiusMm = 1.0, kFactor = 0.4, thicknessMm = 1.5, heightMm = 20.0;
  auto graph = MakeTwoPanel(100.0, heightMm, 50.0, /*hingeVertical=*/true, -90.0, radiusMm,
                             kFactor, thicknessMm);
  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);

  double ba = BendAllowanceMm(-90.0, radiusMm, kFactor, thicknessMm);
  double expectedArea = (100.0 + ba) * heightMm;
  CHECK(PolygonArea(result.outer) == Approx(expectedArea).margin(1e-6));
}

TEST_CASE("BuildFlatOutline: a chained (2-bend) strip grows by the sum of both allowances",
          "[translation][flat_outline]") {
  // Three 100mm-wide panels in a row, hinges at x=100 and x=200, flush
  // authored (0..300 total), same discipline as MakeStrip.
  PartGraphSpec graph;
  graph.partId = "chain";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = 2.0;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = Rect(0, 0, 300, 50);

  double radiusMm = 1.5, kFactor = 0.4;

  BendSpec bend0;
  bend0.id = "bend0";
  bend0.parentRegionPanelId = "seg0";
  bend0.childRegionPanelId = "seg1";
  bend0.hingeA = {100, 50};
  bend0.hingeB = {100, 0};
  bend0.angleDeg = 90.0;
  bend0.radiusMm = radiusMm;
  bend0.kFactor = kFactor;
  graph.bends.push_back(bend0);

  BendSpec bend1;
  bend1.id = "bend1";
  bend1.parentRegionPanelId = "seg1";
  bend1.childRegionPanelId = "seg2";
  bend1.hingeA = {200, 50};
  bend1.hingeB = {200, 0};
  bend1.angleDeg = 90.0;
  bend1.radiusMm = radiusMm;
  bend1.kFactor = kFactor;
  graph.bends.push_back(bend1);

  EvaluateResult evaluated = Evaluate(graph);
  REQUIRE(evaluated.ok);

  FlatOutlineResult result = BuildFlatOutline(graph, evaluated);
  REQUIRE(result.ok);

  double ba = BendAllowanceMm(90.0, radiusMm, kFactor, graph.thicknessMm);
  double expectedSpan = 300.0 + 2.0 * ba;
  double minX = 1e9, maxX = -1e9;
  for (const auto& p : result.outer) {
    minX = std::min(minX, p.x);
    maxX = std::max(maxX, p.x);
  }
  CHECK((maxX - minX) == Approx(expectedSpan).margin(1e-6));
  CHECK(PolygonArea(result.outer) == Approx(expectedSpan * 50.0).margin(1e-6));
}
