#include "rules_engine.hpp"
#include "rules/bend_radius.hpp"
#include "rules/bend_angle.hpp"
#include "rules/hole_diameter.hpp"
#include "rules/hole_to_bend.hpp"
#include "rules/hole_to_edge.hpp"
#include "rules/hole_to_hole.hpp"
#include "rules/flange_width.hpp"

namespace mcp_cad::validation {

std::vector<Finding> EvaluateFindings(
    const translation::PartGraphSpec& graph,
    const translation::EvaluateResult* layout,
    const ManufacturingProfile& profile) {

  std::vector<Finding> all;

  auto add = [&all](std::vector<Finding>&& batch) {
    all.insert(all.end(),
               std::make_move_iterator(batch.begin()),
               std::make_move_iterator(batch.end()));
  };

  // ── Structural-only rules (need only PartGraphSpec) ────────────────────
  add(rules::CheckBendRadius(graph, profile));
  add(rules::CheckBendAngle(graph, profile));
  add(rules::CheckHoleDiameter(graph, profile));
  add(rules::CheckHoleToBendClearance(graph, profile));
  add(rules::CheckHoleToEdgeClearance(graph, profile));
  add(rules::CheckHoleToHoleDistance(graph, profile));

  // ── Geometry-dependent rules (need the evaluated layout) ───────────────
  if (layout != nullptr && layout->ok) {
    add(rules::CheckFlangeWidth(graph, *layout, profile));
  }

  return all;
}

}  // namespace mcp_cad::validation
