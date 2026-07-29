#include "generate_reliefs.hpp"
#include <cmath>
#include <algorithm>

namespace mcp_cad::translation {

namespace {

constexpr double kEndpointTolerance = 0.01;

bool EndpointsMatch(const Point2& a, const Point2& b) {
  double dx = a.x - b.x;
  double dy = a.y - b.y;
  return (dx * dx + dy * dy) < (kEndpointTolerance * kEndpointTolerance);
}

Point2 NormalizedDirection(const Point2& from, const Point2& to) {
  double dx = to.x - from.x;
  double dy = to.y - from.y;
  double len = std::sqrt(dx * dx + dy * dy);
  if (len < 0.001) return {0, 0};
  return {dx / len, dy / len};
}

std::vector<Point2> DogbonePolygon(const Point2& corner,
                                    const Point2& dir1, const Point2& dir2,
                                    double radiusMm) {
  // Dogbone extends along each hinge from the corner.
  // Polygon vertices (CW for hole): corner → along dir1 → far corner → along dir2
  Point2 p1{corner.x + dir1.x * radiusMm, corner.y + dir1.y * radiusMm};
  Point2 p2{corner.x + dir2.x * radiusMm, corner.y + dir2.y * radiusMm};
  // Far corner
  Point2 p3{corner.x + dir1.x * radiusMm + dir2.x * radiusMm,
            corner.y + dir1.y * radiusMm + dir2.y * radiusMm};
  return {corner, p1, p3, p2};
}

std::vector<Point2> CircularPolygon(const Point2& corner, double radiusMm) {
  // Approximate circle with an octagon (8 vertices, CW).
  std::vector<Point2> poly;
  constexpr int kSegments = 8;
  for (int i = 0; i < kSegments; ++i) {
    double angle = -2.0 * 3.141592653589793 * i / kSegments;  // CW
    poly.push_back({corner.x + radiusMm * std::cos(angle),
                    corner.y + radiusMm * std::sin(angle)});
  }
  return poly;
}

}  // namespace

std::vector<ReliefPolygon> ComputeReliefPolygons(
    const std::vector<BendSpec>& bends,
    const std::string& reliefType,
    double radiusMm,
    double /*thicknessMm*/) {

  std::vector<ReliefPolygon> results;

  for (size_t i = 0; i < bends.size(); ++i) {
    for (size_t j = i + 1; j < bends.size(); ++j) {
      const auto& ba = bends[i];
      const auto& bb = bends[j];

      // Check all four endpoint combinations
      Point2 corner;
      Point2 dir1, dir2;
      bool found = false;

      auto tryCorner = [&](const Point2& ea, const Point2& eb,
                           const Point2& oa, const Point2& ob) {
        if (EndpointsMatch(ea, eb)) {
          corner = ea;
          dir1 = NormalizedDirection(corner, oa);
          dir2 = NormalizedDirection(corner, ob);
          found = true;
        }
      };

      tryCorner(ba.hingeA, bb.hingeA, ba.hingeB, bb.hingeB);
      if (!found) tryCorner(ba.hingeA, bb.hingeB, ba.hingeB, bb.hingeA);
      if (!found) tryCorner(ba.hingeB, bb.hingeA, ba.hingeA, bb.hingeB);
      if (!found) tryCorner(ba.hingeB, bb.hingeB, ba.hingeA, bb.hingeA);

      if (!found || dir1.x == 0.0 && dir1.y == 0.0 ||
          dir2.x == 0.0 && dir2.y == 0.0) {
        continue;
      }

      ReliefPolygon rp;
      if (reliefType == "dogbone") {
        rp.polygon = DogbonePolygon(corner, dir1, dir2, radiusMm);
      } else {
        rp.polygon = CircularPolygon(corner, radiusMm);
      }
      results.push_back(std::move(rp));
    }
  }

  return results;
}

}  // namespace mcp_cad::translation
