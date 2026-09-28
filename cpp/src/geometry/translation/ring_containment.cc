#include "ring_containment.hpp"

#include <algorithm>
#include <cmath>

namespace mcp_cad::translation {
namespace {

constexpr double kEps = 1e-9;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Length2(const Point2& v) { return std::sqrt(v.x * v.x + v.y * v.y); }

// Standard even-odd ray-casting point-in-polygon test (works for any simple
// polygon, either winding).
bool PointInPolygon(const Point2& p, const std::vector<Point2>& poly) {
  bool inside = false;
  const size_t n = poly.size();
  for (size_t i = 0, j = n - 1; i < n; j = i++) {
    const Point2& a = poly[i];
    const Point2& b = poly[j];
    const bool crosses = (a.y > p.y) != (b.y > p.y);
    if (crosses) {
      const double xIntersect = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (p.x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

// Minimum distance from point `p` to segment (a, b).
double DistancePointToSegment(const Point2& p, const Point2& a, const Point2& b) {
  const Point2 ab = Sub2(b, a);
  const double abLen2 = ab.x * ab.x + ab.y * ab.y;
  if (abLen2 < kEps) return Length2(Sub2(p, a));
  double t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / abLen2;
  t = std::max(0.0, std::min(1.0, t));
  const Point2 closest{a.x + ab.x * t, a.y + ab.y * t};
  return Length2(Sub2(p, closest));
}

int Sign(double v) { return (v > kEps) ? 1 : (v < -kEps ? -1 : 0); }

// Standard orientation-based PROPER segment intersection test (does not
// count touching-at-an-endpoint as a crossing — irrelevant here since the
// candidate ring's vertices are already separately confirmed inside the
// container; this only needs to catch genuine mid-edge crossings).
bool SegmentsProperlyIntersect(const Point2& p1, const Point2& p2, const Point2& p3,
                                const Point2& p4) {
  const double d1 = Cross2(Sub2(p4, p3), Sub2(p1, p3));
  const double d2 = Cross2(Sub2(p4, p3), Sub2(p2, p3));
  const double d3 = Cross2(Sub2(p2, p1), Sub2(p3, p1));
  const double d4 = Cross2(Sub2(p2, p1), Sub2(p4, p1));
  return (Sign(d1) * Sign(d2) < 0) && (Sign(d3) * Sign(d4) < 0);
}

}  // namespace

bool CircleFullyInsidePolygon(const Point2& center, double radiusMm,
                               const std::vector<Point2>& container) {
  if (container.size() < 3 || radiusMm <= 0.0) return false;
  if (!PointInPolygon(center, container)) return false;
  const size_t n = container.size();
  for (size_t i = 0; i < n; ++i) {
    const double dist = DistancePointToSegment(center, container[i], container[(i + 1) % n]);
    if (dist <= radiusMm) return false;  // circle touches or crosses this edge — no real clearance
  }
  return true;
}

bool RingFullyInsidePolygon(const std::vector<Point2>& ring,
                             const std::vector<Point2>& container) {
  if (ring.size() < 3 || container.size() < 3) return false;
  for (const auto& v : ring) {
    if (!PointInPolygon(v, container)) return false;
  }
  const size_t rn = ring.size();
  const size_t cn = container.size();
  for (size_t i = 0; i < rn; ++i) {
    const Point2& r1 = ring[i];
    const Point2& r2 = ring[(i + 1) % rn];
    for (size_t j = 0; j < cn; ++j) {
      const Point2& c1 = container[j];
      const Point2& c2 = container[(j + 1) % cn];
      if (SegmentsProperlyIntersect(r1, r2, c1, c2)) return false;
    }
  }
  return true;
}

}  // namespace mcp_cad::translation
