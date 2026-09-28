#include "bend_angle.hpp"
#include <cmath>
#include <sstream>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckBendAngle(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;

  for (const auto& bend : graph.bends) {
    // angleDeg is signed (positive = mountain, negative = valley, see
    // step_reconciliation.cc) — the sign is orientation, not magnitude, so
    // this rule validates |angle| against the profile's physical range.
    double angle = std::abs(bend.angleDeg);
    if (angle > profile.maxBendAngleDeg) {
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
