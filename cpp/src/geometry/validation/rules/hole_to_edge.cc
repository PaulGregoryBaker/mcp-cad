#include "hole_to_edge.hpp"
#include <cmath>
#include <sstream>
#include <iomanip>

namespace mcp_cad::validation::rules {

namespace {

double PointToSegmentDistance(
    const translation::Point2& p,
    const translation::Point2& a,
    const translation::Point2& b) {
  double dx = b.x - a.x;
  double dy = b.y - a.y;
  double lenSq = dx * dx + dy * dy;
  if (lenSq == 0.0) return std::hypot(p.x - a.x, p.y - a.y);
  double t = std::max(0.0, std::min(1.0,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return std::hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

}  // namespace

std::vector<Finding> CheckHoleToEdgeClearance(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double clearance = profile.minHoleToEdgeClearanceMm;

  const auto& outer = graph.outline.outer;
  if (outer.size() < 2) return findings;

  for (const auto& hole : graph.outline.circleHoles) {
    double minDist = std::numeric_limits<double>::max();
    for (size_t i = 0; i < outer.size(); ++i) {
      const auto& a = outer[i];
      const auto& b = outer[(i + 1) % outer.size()];
      double dist = PointToSegmentDistance(hole.center, a, b);
      if (dist < minDist) minDist = dist;
    }
    double required = clearance + hole.radiusMm;
    if (minDist < required) {
      std::ostringstream msg;
      msg << "Hole at (" << std::fixed << std::setprecision(2)
          << hole.center.x << ", " << hole.center.y
          << ") edge is " << minDist << " mm from the part outline "
          << "(min: " << clearance << " mm clearance + "
          << hole.radiusMm << " mm radius = " << required << " mm)";
      findings.push_back({
        "HOLE_TOO_CLOSE_TO_EDGE",
        FindingSeverity::kError,
        msg.str(),
        {{"part", graph.partId}},
        std::nullopt  // no single obvious fix
      });
    }
  }
  return findings;
}

}  // namespace
