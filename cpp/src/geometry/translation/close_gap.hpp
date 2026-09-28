#pragma once

/**
 * translation/close_gap.hpp — computes the 2D outline delta needed to close a
 * 3D gap between two free edges on the same part.
 *
 * Graph-first (no OCCT mutation): the caller (TypeScript) resolves two free
 * edges via evaluatePart, passes their 3D bottom-face coordinates and the
 * edge-to-move's panel pose to this function, receives the 2D delta in F
 * (the part's one shared flat frame), and applies it via the existing
 * move_edge graph operation.  The 3D solid is then reconstructed from the
 * updated graph via constructPart — no OCCT mutations anywhere.
 */

#include "manufacturing_graph_evaluator.hpp"
#include <vector>

namespace mcp_cad::translation {

/** Result of computing the close-gap delta.  Always succeeds — a zero delta
 *  means the edges already touch. */
struct CloseGapResult {
  double deltaX = 0.0;   // 2D translation to apply in F
  double deltaY = 0.0;
  double gapMm = 0.0;    // magnitude of the 3D gap (informational)
};

/**
 * Compute the 2D outline delta to close a 3D gap between two edges.
 *
 * @param edgeA3d  Bottom-face 3D points of the reference edge (what edge_b
 *                 should meet).
 * @param edgeB3d  Bottom-face 3D points of the edge to move.
 * @param panelBPose  The pose (R,t) of edge_b's region panel, from
 *                    EvaluateResult.panels[].pose.
 *
 * The delta is R⁻¹ × (midpoint_a - midpoint_b), i.e. the 3D gap vector
 * expressed in the flat frame F via the panel's inverse pose.  The caller
 * applies this delta to edge_b's F-coordinates via move_edge.
 */
CloseGapResult ComputeCloseGapDelta(
    const std::vector<Point3>& edgeA3d,
    const std::vector<Point3>& edgeB3d,
    const Transform3& panelBPose);

}  // namespace mcp_cad::translation
