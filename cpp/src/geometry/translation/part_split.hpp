#pragma once

/**
 * Part split — the graph-level inverse of merge_bodies_with_bend, but
 * operating within ONE part rather than across two (rebuild/14-graph-
 * schema.md §2.1's fold tree). Given a part's one stored flat outline and
 * ONE of its own live bends, cuts that outline into two separate rings at
 * the bend's hinge — the CHILD side (the bend's own child region panel and
 * everything folded beneath it) and the PARENT side (everything else). The
 * bend itself is removed: TypeScript mints a fresh part_id for whichever
 * side is spun off and re-parents that subtree's region-panel/bend rows
 * onto it (this module has no knowledge of parts, region panels, or bends
 * as graph rows — only raw polygons, same discipline as part_merge.hpp).
 *
 * A LAP JOINT, not a mitered tangent-line trim. Converting a real (nonzero-
 * radius) bend into a sharp corner means one side ("grown", `keepCornerOn`'s
 * choice) extends past the raw hinge far enough to cover the OTHER side's
 * ("trimmed") own full cross-section at the corner — trimmed is cut SQUARE
 * (perpendicular to its own length) exactly at the raw hinge, nothing more:
 * its own solid, extruded through its own full thickness, already begins
 * exactly at the bend's true fold axis once cut flush there, no matter which
 * face (inner or outer) that axis actually sits at for this bend's own fold
 * direction — no separate reconciliation needed on that side at all.
 *
 * How far must grown extend? Hand-verified against a real 3D solid (not
 * just the 2D outline): for a 90-degree fold and 1mm material, extending by
 * exactly 1mm puts the grown side's own far face flush against the trimmed
 * side's own near face, no gap, no overlap. In general (interior angle
 * between the two panels, thetaBetween = 180 - |angleDeg|; a = thetaBetween
 * - 90, its own deviation from square):
 *   extensionMm = thicknessMm * sin(|angleDeg|)                     (thetaBetween >= 90, obtuse or square)
 *   extensionMm = thicknessMm * sin(|angleDeg|) + thicknessMm * tan(|a|)   (thetaBetween < 90, acute)
 * (sin(|angleDeg|) == cos(|a|) by the co-function identity, since a = 90 -
 * |angleDeg| in the first branch — this is the SAME formula continuously
 * extended, not two unrelated cases; the tan(|a|) term only ever adds for
 * an acute (pinched) corner, where the grown side must reach further still
 * to cover trimmed's now-more-oblique cross-section). Neither term involves
 * radiusMm or kFactor at all — this is purely a function of the fold angle
 * and the trimmed side's own material thickness, unlike the tangent-line/
 * bend-allowance formulas (ComputeBendGeometry, BuildBendCuts) used
 * elsewhere in this codebase for an INTACT bend's own flat-pattern unroll.
 */

#include "manufacturing_graph_evaluator.hpp"

namespace mcp_cad::translation {

enum class SplitErrorCode {
  kNone,
  kHingeNotGrounded,      // the bend's hinge doesn't cross the outline at exactly 2 points
  kCornerZoneNotGrounded, // the corner-biased cut line doesn't cross the outline at exactly 2 points
                          // (the flush side's own material is narrower than the requested setback)
  kDegenerateResult,      // a resulting ring has fewer than 3 vertices
};

// Which side extends into the corner (see this file's own header comment
// for the lap-joint construction) — that side's own outline grows past the
// raw hinge; the OTHER side is simply cut square at the raw hinge, nothing
// removed from its own normal shape at all.
enum class CornerSide {
  kParent,  // parent extends into the corner; child is cut square at the raw hinge
  kChild,   // child extends into the corner; parent is cut square at the raw hinge
};

struct SplitAtBendResult {
  bool ok = false;
  SplitErrorCode errorCode = SplitErrorCode::kNone;
  std::string message;
  std::vector<Point2> parentOutline;  // CCW
  std::vector<Point2> childOutline;   // CCW
  // The new child part's own anchor — always exactly the caller-supplied
  // `childPose`, unchanged. See SplitPartAtBend's own doc comment for why
  // no correction is needed.
  Transform3 childAnchor;
};

// outline: the part's one stored flat outline (CCW) — bend.hingeA/hingeB
// and every vertex here live in the RAW frame (manufacturing_graph_
// evaluator.cc's own rawOuter: "cut exactly at each bend's raw hinge line,
// no setback" — what pose/bottomFace/topFace, and hence the actual 3D
// solid, consume directly; NOT regionOuter, the flat-pattern/DXF-only
// widened view point_mapping.cc's own PanelShift derives from it — that
// widening is a purely-derived, per-query display quantity, meaningless
// for a bend that's just been removed). thicknessMm: the part's own
// thickness — this file's own lap-joint extension formula (header comment
// above), not a bend-allowance term.
//
// childPose: the bend's own childRegionPanelId's TRUE pose, already
// computed by Evaluate() while the bend was still live (RegionPanelLayout::
// pose) — reused UNCHANGED as childAnchor. Because both `outline` and the
// new child's own pose consumption are RAW-frame throughout, no shift
// correction is needed: a brand-new, bendless part's root panel starting a
// fresh pose-walk with cumulativeShift=0 doesn't change what its OWN raw
// geometry means, only what its (unrelated, display-only) regionOuter
// widening would be. Defaults to identity for callers that only need the
// 2D outlines.
SplitAtBendResult SplitPartAtBend(const std::vector<Point2>& outline, const BendSpec& bend,
                                   double thicknessMm, CornerSide keepCornerOn,
                                   const Transform3& childPose = Transform3::Identity());

}  // namespace mcp_cad::translation
