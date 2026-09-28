#pragma once

/**
 * validation/rules_engine.hpp — the single entry point for rule evaluation.
 *
 * EvaluateFindings() is a pure function of (graph, layout, profile) — no OCCT,
 * no shared state, never throws.  `layout` is nullable: when null (evaluatePart
 * failed), geometry-dependent rules silently produce no findings so the
 * resource still returns useful data from the structural-only rules.
 */

#include "findings.hpp"
#include "profile.hpp"
#include "../translation/manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::validation {

std::vector<Finding> EvaluateFindings(
    const translation::PartGraphSpec& graph,
    const translation::EvaluateResult* layout,   // nullable
    const ManufacturingProfile& profile);

}  // namespace mcp_cad::validation
