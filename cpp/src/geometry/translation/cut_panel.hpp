#pragma once

/**
 * cut_panel (Phase 5 Slice 9a, rebuild/06-plan.md) — validates a candidate
 * hole (circle or polygon) against a part's own live region panels and
 * returns it ready to store. Pure (no OCCT): both operations are either an
 * exact primitive (circle) or a well-known canonicalization + the shared
 * ring_containment.hpp check (polygon) — no boolean/clipping machinery
 * needed here at all, unlike polygon_boolean.hpp's fuse_bodies/
 * remove_protrusions siblings.
 *
 * `kind=circle` never tessellates — the hole is stored and later realized
 * (ConstructPartSolid) as an exact center+radius primitive, all the way
 * through. This is NOT the same class of gap as K2 smooth_edge's deferred
 * bulge support: a hole is a wholly separate, self-contained closed loop,
 * not a segment spliced into the outer ring's own boundary chain, so it
 * needs no change to how that chain is represented or clipped.
 */

#include "manufacturing_graph_evaluator.hpp"  // Point2, CircleHoleSpec

#include <string>
#include <vector>

namespace mcp_cad::translation {

enum class CutPanelErrorCode {
  kNone,
  kDegenerateInput,     // <3-vertex ring, or non-positive radius
  kHoleNotContained,    // fits fully within none of the candidate regions
};

struct CutPanelResult {
  bool ok = false;
  CutPanelErrorCode errorCode = CutPanelErrorCode::kNone;
  std::string message;
  std::vector<Point2> canonicalRing;  // kind=polygon only; empty for kind=circle
  int regionIndex = -1;               // index into candidateRegions, valid iff ok
};

// kind=circle: no tessellation, no canonicalization needed at the data level
// (center+radius has no winding) — just validates containment.
CutPanelResult PrepareCircleCut(const Point2& center, double radiusMm,
                                 const std::vector<std::vector<Point2>>& candidateRegions);

// kind=polygon: canonicalizes the caller's ring to CW winding (opposite the
// outer ring's CCW convention, matching this codebase's own "holes are CW"
// rule already used in ConstructPartSolid) via a shoelace-sign check, then
// validates containment.
CutPanelResult PreparePolygonCut(const std::vector<Point2>& ring,
                                  const std::vector<std::vector<Point2>>& candidateRegions);

}  // namespace mcp_cad::translation
