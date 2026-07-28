#pragma once

#include "../findings.hpp"
#include "../profile.hpp"
#include "../../translation/manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::validation::rules {

std::vector<Finding> CheckHoleDiameter(
    const translation::PartGraphSpec& graph,
    const ManufacturingProfile& profile);

}  // namespace
