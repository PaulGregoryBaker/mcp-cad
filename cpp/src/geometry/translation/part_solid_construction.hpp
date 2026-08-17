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
 * bend zone's own material, built by revolving the parent panel's zone-boundary
 * quad (its bottomFace/topFace edge tagged with that bend's id) about the bend's
 * already-computed pivot axis (EvaluateResult::bridges) through the full bend
 * angle, via BRepPrimAPI_MakeRevol. The bridge solid's own start-cap is exactly
 * the parent's zone-boundary quad, and (since the child panel's pose was derived
 * from the SAME pivot/shift) its end-cap is exactly the child's zone-boundary
 * quad — coincident faces, not approximate overlaps, so fusing panels and bridges
 * together is well-conditioned regardless of fold direction (mountain/valley) or
 * bend radius, including radiusMm=0 (a real, non-degenerate bridge still exists
 * there, since the bottom-surface radius r_b is never exactly zero for a valley
 * fold — see manufacturing_graph_evaluator.hpp's own header comment). Every
 * region panel is clipped at zero offset from its own touching bends' raw hinge
 * lines and then translated by its accumulated bend-allowance shift
 * (Evaluate()'s own pose walk) — never shrunk to make room for a bend zone — so
 * this coincidence holds regardless of how many bends share one parent panel
 * (docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md). This retires
 * the old "sharp fold" idealization entirely: there is no separate zero-radius
 * code path, and no GE_SHARP_FOLD_GAP case any more — a real bend, however small,
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
