/**
 * nestPolygons tests — irregular-shape nesting (rebuild/21-nesting-libnest2d.md §9).
 *
 * Core oracle: zero pairwise overlap between placed outlines (Clipper
 * intersection area == 0). Utilisation is asserted only after overlap.
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/nesting/nest_polygons.hpp"

#include <clipper.hpp>
#include <libnest2d/libnest2d.hpp>

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using Catch::Approx;
using namespace mcp_cad;
using translation::NestErrorCode;
using translation::NestPolygonInput;
using translation::NestPolygonOptions;
using translation::NestPolygonResult;
using translation::Point2;

namespace {

// CCW concave L-shape (40 x 30, with a 30 x 20 notch).
std::vector<Point2> lShape() {
  return {
      {0, 0}, {40, 0}, {40, 10}, {10, 10}, {10, 30}, {0, 30},
  };
}

NestPolygonInput part(const std::string& id, const std::vector<Point2>& outer) {
  NestPolygonInput in;
  in.id = id;
  in.outer = outer;
  return in;
}

ClipperLib::Path toClipper(const std::vector<Point2>& ring) {
  ClipperLib::Path p;
  for (const auto& pt : ring) {
    p.emplace_back(static_cast<ClipperLib::cInt>(std::llround(pt.x * 1e6)),
                   static_cast<ClipperLib::cInt>(std::llround(pt.y * 1e6)));
  }
  if (!p.empty() && p.front() != p.back()) p.push_back(p.front());
  return p;
}

// Intersection area (mm^2) between two outlines. Touching edges give 0.
double intersectionArea(const std::vector<Point2>& a, const std::vector<Point2>& b) {
  ClipperLib::Clipper c;
  ClipperLib::Paths sa{toClipper(a)};
  ClipperLib::Paths sb{toClipper(b)};
  c.AddPaths(sa, ClipperLib::ptSubject, true);
  c.AddPaths(sb, ClipperLib::ptClip, true);
  ClipperLib::Paths sol;
  c.Execute(ClipperLib::ctIntersection, sol, ClipperLib::pftNonZero,
            ClipperLib::pftNonZero);
  double area = 0.0;
  for (const auto& p : sol) area += std::fabs(ClipperLib::Area(p));
  return area / (1e6 * 1e6);
}

}  // namespace

TEST_CASE("debug inflation", "[.debug]") {
  const std::vector<Point2> ring = {{0, 0}, {40, 0}, {40, 20}, {0, 20}};
  ClipperLib::Path p;
  for (const auto& pt : ring) {
    p.emplace_back(static_cast<ClipperLib::cInt>(std::llround(pt.x * 1e6)),
                   static_cast<ClipperLib::cInt>(std::llround(pt.y * 1e6)));
  }
  std::reverse(p.begin(), p.end());
  p.push_back(p.front());
  libnest2d::PolygonImpl poly;
  poly.Contour = p;
  std::cerr << "raw contour size: " << poly.Contour.size() << "\n";
  libnest2d::Item item(poly);
  item.inflate(75000);
  const auto& tsh = item.transformedShape();
  std::cerr << "inflated contour size: " << tsh.Contour.size()
            << " holes: " << tsh.Holes.size() << "\n";
  REQUIRE(tsh.Contour.size() >= 3);
}

TEST_CASE("nestPolygons places two rectangles without overlap (convex sanity)",
          "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  const std::vector<Point2> r1 = {{0, 0}, {40, 0}, {40, 20}, {0, 20}};
  const std::vector<Point2> r2 = {{0, 0}, {30, 0}, {30, 15}, {0, 15}};
  NestPolygonResult r = translation::nestPolygons(
      {part("R1", r1), part("R2", r2)}, 100.0, 100.0, opts);

  REQUIRE(r.ok);
  REQUIRE(r.placements.size() == 2);
  REQUIRE(intersectionArea(r.placements[0].outline, r.placements[1].outline) ==
          Approx(0.0).margin(1e-6));
}

TEST_CASE("nestPolygons places two concave L-shapes without overlap",
          "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  NestPolygonResult r = translation::nestPolygons(
      {part("L1", lShape()), part("L2", lShape())}, 100.0, 100.0, opts);

  REQUIRE(r.ok);
  REQUIRE(r.errorCode == NestErrorCode::kNone);
  REQUIRE(r.placements.size() == 2);
  REQUIRE(r.sheetsRequired == 1);

  const auto& a = r.placements[0].outline;
  const auto& b = r.placements[1].outline;
  REQUIRE(a.size() > 4);  // irregular polygon, not a bbox rectangle
  REQUIRE(b.size() > 4);
  REQUIRE(intersectionArea(a, b) == Approx(0.0).margin(1e-6));
}

TEST_CASE("nestPolygons returns NEST_PART_EXCEEDS_SHEET for an oversize part",
          "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  NestPolygonResult r = translation::nestPolygons(
      {part("big", lShape())}, 20.0, 20.0, opts);

  REQUIRE_FALSE(r.ok);
  REQUIRE(r.errorCode == NestErrorCode::kPartExceedsSheet);
  REQUIRE(r.message.find("big") != std::string::npos);
}

TEST_CASE("nestPolygons returns NEST_INVALID_CUTTING_WIDTH above the kerf ceiling",
          "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.maxKerfWidthMm = 0.2;
  opts.cuttingWidthMm = 1.0;
  NestPolygonResult r = translation::nestPolygons({part("L", lShape())}, 100, 100, opts);

  REQUIRE_FALSE(r.ok);
  REQUIRE(r.errorCode == NestErrorCode::kInvalidCuttingWidth);
}

TEST_CASE("nestPolygons copies:n produces n placements with copy_index 0..n-1",
          "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  opts.copies = 3;
  NestPolygonResult r = translation::nestPolygons({part("L", lShape())}, 200, 200, opts);

  REQUIRE(r.ok);
  REQUIRE(r.placements.size() == 3);
  bool saw[3] = {false, false, false};
  for (const auto& p : r.placements) {
    REQUIRE(p.id == "L");
    REQUIRE(p.copyIndex >= 0);
    REQUIRE(p.copyIndex < 3);
    saw[p.copyIndex] = true;
  }
  for (bool s : saw) REQUIRE(s);
}

TEST_CASE("nestPolygons fill mode is deterministic", "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  opts.copies = -1;  // fill

  NestPolygonResult r1 = translation::nestPolygons({part("L", lShape())}, 120, 120, opts);
  NestPolygonResult r2 = translation::nestPolygons({part("L", lShape())}, 120, 120, opts);

  REQUIRE(r1.ok);
  REQUIRE(r2.ok);
  REQUIRE(r1.placements.size() > 1);       // more than one copy fits
  REQUIRE(r1.placements.size() == r2.placements.size());
  REQUIRE(r1.sheetsRequired == r2.sheetsRequired);
}

TEST_CASE("nestPolygons is deterministic across repeated runs", "[nesting][nest-polygons]") {
  NestPolygonOptions opts;
  opts.sheetMarginMm = 0.0;
  opts.copies = 2;

  auto run = [&]() { return translation::nestPolygons({part("L", lShape())}, 100, 100, opts); };
  NestPolygonResult r1 = run();
  NestPolygonResult r2 = run();
  NestPolygonResult r3 = run();

  REQUIRE(r1.ok);
  REQUIRE(r2.ok);
  REQUIRE(r3.ok);
  REQUIRE(r1.sheetsRequired == r2.sheetsRequired);
  REQUIRE(r1.sheetsRequired == r3.sheetsRequired);
  REQUIRE(r1.placements.size() == r2.placements.size());
  REQUIRE(r1.placements.size() == r3.placements.size());

  for (size_t i = 0; i < r1.placements.size(); ++i) {
    REQUIRE(r1.placements[i].x == Approx(r2.placements[i].x).margin(1e-6));
    REQUIRE(r1.placements[i].y == Approx(r2.placements[i].y).margin(1e-6));
    REQUIRE(r1.placements[i].rotationDeg == Approx(r2.placements[i].rotationDeg).margin(1e-6));
    REQUIRE(r1.placements[i].sheetIndex == r2.placements[i].sheetIndex);
  }
}
