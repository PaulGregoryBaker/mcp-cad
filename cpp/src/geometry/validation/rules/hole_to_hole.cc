#include "hole_to_hole.hpp"
#include <cmath>
#include <sstream>
#include <iomanip>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckHoleToHoleDistance(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double minDist = profile.minHoleToHoleDistanceMm;
  const auto& holes = graph.outline.circleHoles;

  for (size_t i = 0; i < holes.size(); ++i) {
    for (size_t j = i + 1; j < holes.size(); ++j) {
      double dist = std::hypot(
          holes[i].center.x - holes[j].center.x,
          holes[i].center.y - holes[j].center.y);
      if (dist < minDist) {
        std::ostringstream msg;
        msg << "Holes at (" << std::fixed << std::setprecision(2)
            << holes[i].center.x << ", " << holes[i].center.y
            << ") and (" << holes[j].center.x << ", " << holes[j].center.y
            << ") are " << dist << " mm apart (min: " << minDist << " mm)";
        findings.push_back({
          "HOLE_TOO_CLOSE_TO_HOLE",
          FindingSeverity::kError,
          msg.str(),
          {{"part", graph.partId}},
          std::nullopt  // no single obvious fix
        });
      }
    }
  }
  return findings;
}

}  // namespace
