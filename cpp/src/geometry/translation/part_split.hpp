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
 * Real material meets a real bend at TWO tangent lines, one on each leg,
 * bracketing the curved bend-allowance zone between them (manufacturing_
 * graph_evaluator.hpp's own header comment: BA = angleRad*(radiusMm +
 * kFactor*thicknessMm), SB = reff*tan(angleRad/2)) — cutting a formed part
 * back into two loose flat blanks means picking ONE of those two tangent
 * lines as the single dividing line, so exactly one side absorbs the whole
 * curved zone ("goes into the corner") and the other is trimmed flush at
 * its own tangent line, carrying no allowance material at all (`kFactor`
 * included, per that same allowance formula — this is the sense in which
 * the corner-losing side has the bend's kFactor-driven stretch removed,
 * not just its angle). `keepCornerOn` selects which side that is.
 *
 * The tangent-shift formula (`sb`, signed by which surface is concave) is
 * bit-for-bit the same one manufacturing_graph_evaluator.cc's BuildBendCuts
 * already uses to trim RegionPanelLayout::wallOuter — deliberately mirrored
 * here (not re-derived) rather than exported and shared, because that
 * function's own hinge-grounding pass is coupled to simultaneously cutting
 * EVERY bend on a ring (later bends see earlier bends' inserted vertices);
 * this module only ever grounds ONE line against ONE ring, with no such
 * coupling, so sharing the loop itself would add a parameter no other
 * caller needs. cpp/tests/part_split_test.cc cross-checks this module's
 * flush-side output directly against Evaluate()'s own wallOuter for the
 * same bend, so drift from the source formula is caught by tests, not by
 * hoping the two copies stay in sync.
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

// Which side is cut at its OWN natural (corner-reaching) tangent line —
// that side keeps its normal, un-shrunk shape; the OTHER side is cut at the
// SAME line, which sits on the far side of the raw hinge from ITS OWN
// tangent line, so it loses the whole allowance band (trimmed past even a
// raw-hinge cut, not merely flush at it).
enum class CornerSide {
  kParent,  // parent keeps its normal shape; child is the harshly-trimmed side
  kChild,   // child keeps its normal shape; parent is the harshly-trimmed side
};

struct SplitAtBendResult {
  bool ok = false;
  SplitErrorCode errorCode = SplitErrorCode::kNone;
  std::string message;
  std::vector<Point2> parentOutline;  // CCW
  std::vector<Point2> childOutline;   // CCW
  // The new child part's own anchor — a rotation about the axis THIS
  // split's own cut actually introduces (the corner-biased cut point,
  // raw hinge shifted by this bend's own setback magnitude along nLeft
  // per keepCornerOn — never negative, see this file's own
  // BottomIsConcave/setback comment), composed with `parentPose` (the
  // caller's own, unchanged pose for whichever region panel is
  // SplitPartAtBend's own bend.parentRegionPanelId).
  //
  // Deliberately NOT built from Evaluate()'s own axisInPlaneOffset-based
  // axis (a different, pose-walk-internal quantity whose sign depends on
  // angleDeg's own raw sign combined with concave/convex, and can come
  // out on the wrong side of the raw hinge for some real fold/concavity
  // combinations — confirmed live, see split_part_at_bend.integration.
  // test.ts's own regression test): using THIS split's own cut point
  // instead guarantees childAnchor and childOutline stay self-consistent
  // by construction, since both come from the same cutA/cutB — no second,
  // independently-signed quantity to drift out of sync with the first.
  //
  // Only meaningful when SplitPartAtBend was called with a real
  // `parentPose` — defaults to Transform3::Identity() composed the same
  // way when the caller doesn't have one (e.g. a pure-2D unit test that
  // only cares about parentOutline/childOutline).
  Transform3 childAnchor;
};

// outline: the part's one stored flat outline (CCW). bend: the ONE live bend
// being split off — bend.hingeA/hingeB in the SAME flat frame as `outline`.
// thicknessMm: the part's own thickness (bend allowance's kFactor term).
// parentPose: the CURRENT 3D pose of bend.parentRegionPanelId (Evaluate()'s
// own already-computed, always-correct RegionPanelLayout::pose for that
// panel — see SplitAtBendResult::childAnchor's own comment for why this
// function derives the new child's anchor from it directly rather than
// leaving the caller to reconcile a second, independently-signed axis).
// Defaults to identity for callers that only need the 2D outlines.
SplitAtBendResult SplitPartAtBend(const std::vector<Point2>& outline, const BendSpec& bend,
                                   double thicknessMm, CornerSide keepCornerOn,
                                   const Transform3& parentPose = Transform3::Identity());

}  // namespace mcp_cad::translation
