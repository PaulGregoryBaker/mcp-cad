#include "rip_edge.hpp"
#include <cmath>

namespace mcp_cad::translation {

RipEdgeResult ComputeRipEdge(
    const std::vector<Point2>& outline,
    int edgeIndex,
    double gapMm) {

  int n = static_cast<int>(outline.size());
  int i0 = edgeIndex;
  int i1 = (edgeIndex + 1) % n;

  const Point2& a = outline[i0];
  const Point2& b = outline[i1];

  // Midpoint of the edge
  double mx = (a.x + b.x) * 0.5;
  double my = (a.y + b.y) * 0.5;

  // Edge direction
  double edx = b.x - a.x;
  double edy = b.y - a.y;

  // Perpendicular (rotate edge direction by 90°)
  double px = -edy;
  double py = edx;

  // Normalize
  double len = std::sqrt(px * px + py * py);
  if (len > 0.0) {
    px /= len;
    py /= len;
  }

  double halfGap = gapMm * 0.5;

  // Two offset vertices at the midpoint, separated by gapMm perpendicular
  // to the edge direction. One offset in +perp direction, one in -perp.
  Point2 v1{mx + px * halfGap, my + py * halfGap};
  Point2 v2{mx - px * halfGap, my - py * halfGap};

  // Build new outline: replace edge (i0→i1) with (i0→v2→v1→i1)
  RipEdgeResult result;
  result.newOutline.reserve(n + 2);
  for (int i = 0; i <= i0; ++i) {
    result.newOutline.push_back(outline[i]);
  }
  result.newOutline.push_back(v2);
  result.newOutline.push_back(v1);
  for (int i = i1; i < n; ++i) {
    result.newOutline.push_back(outline[i]);
  }

  return result;
}

}  // namespace mcp_cad::translation
