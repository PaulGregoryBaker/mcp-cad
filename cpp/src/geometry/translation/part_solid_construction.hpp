#pragma once

/**
 * ConstructPartSolid — Port D-lite (rebuild/16-kernel-port.md Port D): builds the
 * realized 3D solid directly from ManufacturingGraphEvaluator's exact point-array
 * output.
 *
 * Deliberately NOT routed through the existing buildShellFromFlatPattern (DXF-text)
 * path — that function internally re-derives its own bend-zone placement from a
 * synthesized DXF string, which would mean two independently-computed placements
 * for the same fact (constitution v2.0.0 principles III/IV — the exact bug class
 * this rebuild exists to eliminate; see rebuild/19 §0). This module only ever
 * consumes ManufacturingGraphEvaluator's already-computed `pose` per panel — it
 * never re-derives placement itself.
 *
 * Each panel is built as its own independently-thickened, closed solid, placed via
 * its already-computed pose. Every bend also contributes a real BRIDGE solid — the
 * bend zone's own material, built by revolving a zone-boundary quad about the
 * bend's already-computed pivot axis (EvaluateResult::bridges) through the full
 * bend angle, via BRepPrimAPI_MakeRevol. That quad is anchored at the TRUE
 * tangent line (the raw hinge, BridgeLayout::hingeA/hingeB, transformed by the
 * parent panel's own pose) rather than the parent's own bend-allowance-clipped
 * region boundary — and since the child panel's pose was derived from this same
 * pivot (Evaluate()'s childShift cancellation), the revolve's end-cap coincides
 * exactly with the child's zone-boundary quad at any bend radius, not just
 * radiusMm=0.
 *
 * The parent panel's own solid, though, IS built from its bend-allowance-clipped
 * region boundary (unchanged) — which stops short of the true tangent line by
 * half the zone width whenever that width is nonzero (radiusMm>0 or kFactor>0).
 * A panel can be parent to more than one bend (branching), so there is no single
 * per-panel pose shift that could close this gap the way the child side's does —
 * each bridge instead contributes its own small flat COLLAR solid spanning from
 * the parent's clipped edge to the true tangent line, closing that gap locally,
 * per bend. At zone width 0 (sharp fold) the gap is exactly zero and no collar is
 * built. This is what makes fusing panels, collars, and bridges together
 * well-conditioned regardless of fold direction (mountain/valley), bend radius,
 * or how many bends share one parent panel (docs/BUG_REPORT_nonzero_default_
 * bend_radius_breaks_mesh_construction.md — omitting the collar left a real gap
 * at any bend radius > 0 on a panel with more than one child). This retires the
 * old "sharp fold" idealization entirely: there is no separate zero-radius code
 * path, and no GE_SHARP_FOLD_GAP case any more — a real bend, however small,
 * always has real bridge material connecting its two sides.
 *
 * This module DOES touch OCCT (unlike manufacturing_graph_evaluator, which stays
 * kernel-free) — it's the Port D adapter, the boundary where exact point-array data
 * becomes a real kernel shape.
 */

#include "manufacturing_graph_evaluator.hpp"
#include "../geometry_service.hpp"  // ShellId

namespace mcp_cad {
struct GeometryState;
}

namespace mcp_cad::translation {

struct ConstructPartSolidResult {
  bool ok = false;
  std::string errorCode;  // "" | GE_INVALID_LAYOUT | GE_EMPTY_LAYOUT |
                           // GE_INVALID_SHEET_METAL | GE_POLYGON_BUILD_FAILED |
                           // GE_EXTRUDE_FAILED | GE_BRIDGE_EDGE_NOT_FOUND |
                           // GE_BRIDGE_UNSUPPORTED_TOPOLOGY (a bend's zone
                           // boundary spans more than one panel edge — only
                           // straight chains with a single-edge zone boundary are
                           // supported this slice) | GE_BRIDGE_BUILD_FAILED |
                           // GE_CONSTRUCTION_FAILED
  std::string message;
  ShellId shellId;  // valid only when ok == true; a request-scoped registry entry —
                     // see rebuild/19 §3's N13 audit note, not held beyond this call
};

// `thicknessMm` is passed explicitly (matching what ManufacturingGraphEvaluator used to compute
// `layout`'s bottomFace/topFace) rather than re-derived from those arrays, so there
// is exactly one source for this value, not two.
ConstructPartSolidResult ConstructPartSolid(GeometryState& state, const EvaluateResult& layout,
                                             double thicknessMm);

}  // namespace mcp_cad::translation
