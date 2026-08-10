#include "bend_radius.hpp"
#include <sstream>
#include <iomanip>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckBendRadius(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double minRadius = profile.minBendRadiusFactor * graph.thicknessMm;

  // One uniform check per bend, regardless of radiusMeasured (provenance
  // metadata only — system-defaulted vs. human/AI-confirmed — never a
  // reason to skip validating the actual value; see
  // docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md's
  // 2026-08-09 correction).
  for (const auto& bend : graph.bends) {
    if (bend.radiusMm < minRadius) {
      std::ostringstream msg;
      msg << "Bend " << bend.id << " radius " << std::fixed << std::setprecision(2)
          << bend.radiusMm << " mm is below minimum " << minRadius
          << " mm for this material (thickness " << graph.thicknessMm
          << " mm × factor " << profile.minBendRadiusFactor << ")";
      findings.push_back({
        "MIN_BEND_RADIUS",
        FindingSeverity::kError,
        msg.str(),
        {{"bend", bend.id}},
        std::nullopt  // no auto-fix — radius is a design choice
      });
    }
  }
  return findings;
}

}  // namespace
