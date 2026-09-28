#pragma once

/**
 * translation/generate_reliefs.hpp — computes relief polygons at bend
 * intersection corners, for cutting via cut_panel(kind=polygon).
 */

#include "manufacturing_graph_evaluator.hpp"
#include <string>
#include <vector>

namespace mcp_cad::translation {

struct ReliefPolygon {
  std::vector<Point2> polygon;  // CW (hole winding) in F
};

/**
 * Compute relief polygons at corners where the given bends intersect.
 *
 * Two bends share a corner when one endpoint of bend_a's hinge matches
 * one endpoint of bend_b's hinge (within 0.01 mm).
 *
 * @param bends       All bends on the part.
 * @param reliefType  "dogbone" or "circular".
 * @param radiusMm    Relief radius/length.
 * @param thicknessMm Part thickness — for computing relief dimensions.
 */
std::vector<ReliefPolygon> ComputeReliefPolygons(
    const std::vector<BendSpec>& bends,
    const std::string& reliefType,
    double radiusMm,
    double thicknessMm);

}  // namespace mcp_cad::translation
