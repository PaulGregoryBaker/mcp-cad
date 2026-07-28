#include "bend_angle.hpp"
#include <sstream>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckBendAngle(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;

  for (const auto& bend : graph.bends) {
    double angle = bend.angleDeg;
    if (angle < 0.0 || angle > profile.maxBendAngleDeg) {
      std::ostringstream msg;
      msg << "Bend " << bend.id << " angle " << angle
          << "° is outside [0, " << profile.maxBendAngleDeg << "]";
      findings.push_back({
        "MAX_BEND_ANGLE",
        FindingSeverity::kError,
        msg.str(),
        {{"bend", bend.id}},
        std::nullopt  // no auto-fix — angle is design intent
      });
    }
  }
  return findings;
}

}  // namespace
