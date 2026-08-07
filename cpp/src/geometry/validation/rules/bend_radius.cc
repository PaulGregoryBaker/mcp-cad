#include "bend_radius.hpp"
#include <sstream>
#include <iomanip>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckBendRadius(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double minRadius = profile.minBendRadiusFactor * graph.thicknessMm;

  for (const auto& bend : graph.bends) {
    if (!bend.radiusMeasured) {
      // A flat-panel decomposition (import_part's reconciliation) can
      // never measure a real bend radius — radiusMm=0 here is a
      // placeholder, not a confirmed sharp fold, so asserting MIN_BEND_
      // RADIUS against it would report a violation nobody actually
      // measured (docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md).
      // Suggest the profile's assumed default (if configured) or the
      // computed minimum as a starting point for the caller to confirm.
      double suggested = profile.defaultBendRadiusMm > 0.0
                              ? profile.defaultBendRadiusMm
                              : minRadius;
      std::ostringstream msg;
      msg << "Bend " << bend.id << "'s radius could not be measured from the imported "
          << "geometry (a flat-panel decomposition can only see two flat faces meeting "
          << "at a fold, never a real fillet) — treated as sharp for construction. "
          << "Specify a real radius via update_node if this needs to pass manufacturability "
          << "checks.";
      std::ostringstream params;
      params << "{\"kind\":\"bend\",\"id\":\"" << bend.id
             << "\",\"patch\":{\"radius_mm\":" << std::fixed << std::setprecision(2)
             << suggested << "}}";
      findings.push_back({
        "BEND_RADIUS_NOT_MEASURED",
        FindingSeverity::kWarning,
        msg.str(),
        {{"bend", bend.id}},
        RecommendedFix{"update_node", params.str()},
      });
      continue;
    }

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
