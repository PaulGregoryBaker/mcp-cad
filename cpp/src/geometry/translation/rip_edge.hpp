#pragma once

/**
 * translation/rip_edge.hpp — splits a free edge of the flat outline at its
 * midpoint, creating a seam gap of the specified width.
 *
 * Graph-first: C++ computes the new outline with the gap inserted; the caller
 * applies it as a GraphStore.replaceOutline mutation. No OCCT mutations.
 */

#include "manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::translation {

struct RipEdgeResult {
  std::vector<Point2> newOutline;  // outline with gap replacing the original edge
};

/**
 * Compute the outline after ripping a free edge.
 *
 * @param outline    The part's flat outline (CCW), at least 3 vertices.
 * @param edgeIndex  Index of the edge's first vertex.
 * @param gapMm      Width of the seam gap to create (mm).
 */
RipEdgeResult ComputeRipEdge(
    const std::vector<Point2>& outline,
    int edgeIndex,
    double gapMm);

}  // namespace mcp_cad::translation
