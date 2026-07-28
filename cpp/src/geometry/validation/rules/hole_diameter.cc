#include "hole_diameter.hpp"
#include <sstream>
#include <iomanip>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckHoleDiameter(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double minDiameter = profile.minHoleDiameterFactor * graph.thicknessMm;

  for (const auto& hole : graph.outline.circleHoles) {
    double diameter = 2.0 * hole.radiusMm;
    if (diameter < minDiameter) {
      std::ostringstream msg;
      msg << "Hole at (" << std::fixed << std::setprecision(2)
          << hole.center.x << ", " << hole.center.y
          << ") diameter " << diameter << " mm is below minimum "
          << minDiameter << " mm for this material (thickness "
          << graph.thicknessMm << " mm × factor "
          << profile.minHoleDiameterFactor << ")";
      findings.push_back({
        "MIN_HOLE_DIAMETER",
        FindingSeverity::kError,
        msg.str(),
        {{"part", graph.partId}},
        std::nullopt  // no auto-fix — hole diameter is a design choice
      });
    }
  }
  // Polygon holes: minimum diameter requires computing the minimum width
  // of an arbitrary polygon, which is non-trivial — deferred until the
  // engine genuinely needs it.  A polygon hole whose ring is degenerate
  // (fewer than 3 vertices) is already rejected by GraphStore.createPart.
  return findings;
}

}  // namespace
