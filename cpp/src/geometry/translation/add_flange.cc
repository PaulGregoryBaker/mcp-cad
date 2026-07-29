#include "add_flange.hpp"
#include <cmath>

namespace mcp_cad::translation {

FlangeOutlineResult ComputeFlangeOutline(
    const std::vector<Point2>& outline,
    int edgeIndex,
    double flangeLengthMm) {

  int n = static_cast<int>(outline.size());
  int i0 = edgeIndex;
  int i1 = (edgeIndex + 1) % n;

  const Point2& a = outline[i0];  // hinge start
  const Point2& b = outline[i1];  // hinge end

  // Edge direction in F
  double edx = b.x - a.x;
  double edy = b.y - a.y;

  // Outward normal: rotate edge direction by -90° (right turn).
  // For a CCW polygon, interior is to the left of each edge, so
  // outward is to the right.
  double nx = edy;   // rotate (dx,dy) by +90 → (-dy, dx) → wait...
  double ny = -edx;

  // Normalize
  double len = std::sqrt(nx * nx + ny * ny);
  if (len > 0.0) {
    nx /= len;
    ny /= len;
  }

  // Flange extension: two new vertices offset from the edge endpoints
  // along the outward normal.
  double fx = nx * flangeLengthMm;
  double fy = ny * flangeLengthMm;

  Point2 v1{b.x + fx, b.y + fy};  // flange corner near hinge end
  Point2 v2{a.x + fx, a.y + fy};  // flange corner near hinge start

  // Build the new outline: splice the flange rectangle in place
  // of the original edge, maintaining CCW order:
  //   ... a → v2 → v1 → b → ...
  FlangeOutlineResult result;
  result.newOutline.reserve(n + 2);
  for (int i = 0; i <= i0; ++i) {
    result.newOutline.push_back(outline[i]);
  }
  result.newOutline.push_back(v2);
  result.newOutline.push_back(v1);
  for (int i = i1; i < n; ++i) {
    result.newOutline.push_back(outline[i]);
  }

  result.hingeA = a;
  result.hingeB = b;
  return result;
}

}  // namespace mcp_cad::translation
