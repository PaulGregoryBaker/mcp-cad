#pragma once

#include "../findings.hpp"
#include "../profile.hpp"
#include "../../translation/manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::validation::rules {

// Requires the EvaluateResult (from evaluatePartGraph) — the only rule that
// depends on evaluated geometry: it needs region polygons to measure flange
// width (max perpendicular distance from bounding-bend hinge to region
// vertices).  When the layout is unavailable, this rule is simply not run
// (the orchestrator skips it), producing zero findings rather than an error.
std::vector<Finding> CheckFlangeWidth(
    const translation::PartGraphSpec& graph,
    const translation::EvaluateResult& layout,
    const ManufacturingProfile& profile);

}  // namespace
