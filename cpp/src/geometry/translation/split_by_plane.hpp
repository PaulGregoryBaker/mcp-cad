#pragma once

/**
 * translation/split_by_plane.hpp — projects a 3D cutting plane to per-panel
 * 2D cut lines, clips each panel's region polygon, and returns the positive
 * and negative fragments.
 *
 * Graph-first: no OCCT mutations.  The caller (TypeScript) groups fragments
 * by bend connectivity, unions them into new outlines via PolygonUnion,
 * reassigns bends and holes, and creates new PartRows.
 */

#include "manufacturing_graph_evaluator.hpp"
#include <string>
#include <vector>

namespace mcp_cad::translation {

/** One fragment of a clipped region panel. */
struct PanelFragment {
  std::string regionPanelId;
  bool positiveSide;              // true = positive side of the plane
  std::vector<Point2> polygon;    // clipped polygon in F (CCW)
};

/** All fragments from splitting every panel by the plane. */
struct SplitByPlaneResult {
  std::vector<PanelFragment> fragments;
};

/**
 * Split a part by a 3D plane.
 *
 * For each region panel in the layout, projects the 3D plane to a 2D cut
 * line in F using the panel's pose, clips the panel's region polygon by
 * that line, and returns zero, one, or two fragments (zero if the panel
 * is degenerate against the line, one if entirely on one side, two if
 * straddling).
 *
 * @param layout     The EvaluateResult from evaluatePartGraph.
 * @param normalX    Plane normal X component (unit expected, not enforced).
 * @param normalY    Plane normal Y component.
 * @param normalZ    Plane normal Z component.
 * @param offsetD    Plane equation: n·x = d.
 */
SplitByPlaneResult ComputeSplitByPlane(
    const EvaluateResult& layout,
    double normalX, double normalY, double normalZ,
    double offsetD);

}  // namespace mcp_cad::translation
