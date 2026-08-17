#pragma once

/**
 * FlatOutlineBuilder — combines every region panel's own (already correctly
 * widened) territory, plus each bend's own flat allowance-strip (the
 * unfolded footprint of its curved material — real, physical sheet, not
 * empty space), into the part's ONE flat-pattern outline: the actual cut
 * boundary a manufacturer uses (docs/BUG_REPORT_outline_never_grows_for_
 * bend_allowance.md).
 *
 * `Evaluate()` (manufacturing_graph_evaluator.hpp) is deliberately OCCT-free
 * — this needs a real polygon union (the allowance zone between two
 * adjacent, non-overlapping regions has to become one filled, contiguous
 * ring), and per this codebase's own policy (polygon_boolean.hpp's header
 * comment) a general polygon union always goes through OCCT via the
 * existing `PolygonUnion` primitive, never a hand-rolled clipper. So this
 * lives here, as its own OCCT-touching adapter — the same role
 * polygon_boolean.cc already plays for fuse_bodies/remove_protrusions —
 * called AFTER `Evaluate()` on its already-computed result, never inside it.
 *
 * Needs no data beyond what `EvaluateResult` already exposes
 * (`panels[].regionOuter`/`edgeBendId`, `bridges[].bendId/parentRegionPanelId
 * /childRegionPanelId`): a bend's parent-side and child-side tagged edges
 * are each already fully positioned (shifted) by `Evaluate()`'s own pose
 * walk — the strip connecting them is just those two already-correct edges,
 * connected into a quad, no separate shift/delta bookkeeping needed.
 */

#include "manufacturing_graph_evaluator.hpp"

#include <string>
#include <vector>

namespace mcp_cad::translation {

enum class FlatOutlineErrorCode {
  kNone,
  kDegenerateInput,   // fewer than 3 panels' worth of usable geometry
  kUnionFailed,       // the underlying PolygonUnion did not succeed
};

struct FlatOutlineResult {
  bool ok = false;
  FlatOutlineErrorCode errorCode = FlatOutlineErrorCode::kNone;
  std::string message;
  std::vector<Point2> outer;  // valid only when ok == true
};

// `graph` supplies rootRegionPanelId (which panel to start the union from);
// `evaluated` must be an ok==true result from Evaluate() on that same graph.
FlatOutlineResult BuildFlatOutline(const PartGraphSpec& graph, const EvaluateResult& evaluated);

}  // namespace mcp_cad::translation
