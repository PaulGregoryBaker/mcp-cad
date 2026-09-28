#pragma once

/**
 * translation/add_flange.hpp — computes the extended outline for adding a
 * rectangular flange to a free edge of a part's flat outline.
 *
 * Graph-first: the flange is a rectangular extension from the specified edge,
 * computed in F (the part's one shared flat frame).  The caller applies the
 * result as GraphStore mutations (update the part's outline, create a bend
 * node, create a new child region panel for the flange).  The 3D solid is
 * reconstructed from the updated graph — no OCCT mutations.
 */

#include "manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::translation {

struct FlangeOutlineResult {
  std::vector<Point2> newOutline;  // original outline with flange rectangle spliced in
  Point2 hingeA;                   // original edge start (flange hinge)
  Point2 hingeB;                   // original edge end
};

/**
 * Compute the extended outline for a flange on a free edge.
 *
 * @param outline          The part's flat outline (CCW), at least 3 vertices.
 * @param edgeIndex        Index of the edge's first vertex in outline.
 * @param flangeLengthMm   How far the flange extends outward (mm).
 *
 * The edge must be a free edge (not a bend hinge).  Validity is checked by
 * the caller (TS resolveFreeEdge) before this is called — this function
 * performs no geometric validation, only the outline extension math.
 */
FlangeOutlineResult ComputeFlangeOutline(
    const std::vector<Point2>& outline,
    int edgeIndex,
    double flangeLengthMm);

}  // namespace mcp_cad::translation
