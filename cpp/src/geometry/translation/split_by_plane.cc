#include "split_by_plane.hpp"
#include <cmath>

namespace mcp_cad::translation {

namespace {

// ── Sutherland-Hodgman polygon clipping against a half-plane ───────────────
// Clips a CCW polygon against the half-plane a*x + b*y >= c (positive side)
// and a*x + b*y <= c (negative side).  Returns both fragments.

double SignedDistance(double a, double b, double c, const Point2& p) {
  return a * p.x + b * p.y - c;
}

// Clip a polygon against the half-plane a*x + b*y >= c.
// Returns the portion of the polygon on or above the line.
std::vector<Point2> ClipPositive(
    const std::vector<Point2>& poly,
    double a, double b, double c) {
  if (poly.size() < 3) return {};

  std::vector<Point2> out;
  for (size_t i = 0; i < poly.size(); ++i) {
    const Point2& curr = poly[i];
    const Point2& next = poly[(i + 1) % poly.size()];
    double dCurr = SignedDistance(a, b, c, curr);
    double dNext = SignedDistance(a, b, c, next);
    bool currInside = (dCurr >= 0.0);
    bool nextInside = (dNext >= 0.0);

    if (currInside) {
      out.push_back(curr);
    }
    if (currInside != nextInside) {
      // Edge crosses the line — compute intersection
      double t = dCurr / (dCurr - dNext);
      Point2 intersect{
        curr.x + t * (next.x - curr.x),
        curr.y + t * (next.y - curr.y)};
      out.push_back(intersect);
    }
  }
  return out;
}

// Clip a polygon against the half-plane a*x + b*y <= c.
// Returns the portion of the polygon on or below the line.
std::vector<Point2> ClipNegative(
    const std::vector<Point2>& poly,
    double a, double b, double c) {
  // Same as ClipPositive with a,b negated
  return ClipPositive(poly, -a, -b, -c);
}

}  // namespace

SplitByPlaneResult ComputeSplitByPlane(
    const EvaluateResult& layout,
    double nx, double ny, double nz,
    double d) {

  SplitByPlaneResult result;

  for (const auto& panel : layout.panels) {
    const auto& R = panel.pose;
    // Project 3D plane n·x = d to 2D line in F:
    // (n·R)·p = d - n·t
    // a = n·R_col0 = nx*R.r[0] + ny*R.r[3] + nz*R.r[6]
    // b = n·R_col1 = nx*R.r[1] + ny*R.r[4] + nz*R.r[7]
    // c = d - n·t  = d - (nx*R.t[0] + ny*R.t[1] + nz*R.t[2])
    double a = nx * R.r[0] + ny * R.r[3] + nz * R.r[6];
    double b = nx * R.r[1] + ny * R.r[4] + nz * R.r[7];
    double ndott = nx * R.t[0] + ny * R.t[1] + nz * R.t[2];
    double c = d - ndott;

    // Positive side: a*x + b*y >= c
    auto posPoly = ClipPositive(panel.regionOuter, a, b, c);
    if (posPoly.size() >= 3) {
      result.fragments.push_back({panel.regionPanelId, true, std::move(posPoly)});
    }

    // Negative side: a*x + b*y <= c
    auto negPoly = ClipNegative(panel.regionOuter, a, b, c);
    if (negPoly.size() >= 3) {
      result.fragments.push_back({panel.regionPanelId, false, std::move(negPoly)});
    }
  }

  return result;
}

}  // namespace mcp_cad::translation
