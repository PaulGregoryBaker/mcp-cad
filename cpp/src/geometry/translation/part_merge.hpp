#pragma once

/**
 * Part merge — reconciling two independently-authored flat outlines at their
 * own real, anchor-derived seam (rebuild/14-graph-schema.md §2.1.2, Phase 5
 * Slice 4; redesigned per docs/TASK_SPEC.md — anchor-driven, single-path
 * reconciliation).
 *
 * `merge_bodies_with_bend` is NOT a new geometric primitive — per 14 §2.1.2 it
 * is (1) reconcile part B's outline into part A's one flat frame, (2) an
 * ordinary create_node(bend, ...) at the seam, (3) alias B via
 * merged_into_part_id. This module does step (1)'s pure geometry in two
 * phases, both still pure 2D/3D math with no OCCT dependency:
 *
 *   (a) DetectContact — given each part's own real anchor (13 §3.1's R,
 *       already stored on every part, never caller-supplied), find the one
 *       real 3D interval where A's and B's boundaries actually coincide, and
 *       the real dihedral angle between their planes there. This is a purely
 *       geometric fact about how the two parts are positioned — never a
 *       caller choice, never a solid boolean (TASK_SPEC.md §2.1/§9).
 *   (b) ReconcileOutlines — exactly today's flat-pattern splice (a pure 2D
 *       rigid alignment: two CCW polygons sharing a boundary run must
 *       traverse it in OPPOSITE order, the one fact that makes the alignment
 *       transform unique, any angle including acute/inverted folds), now
 *       generalized to splice at an arbitrary contact interval — inserting a
 *       new vertex into either outline where the interval's endpoint falls
 *       mid-edge — instead of requiring a whole pre-existing, exactly
 *       length-matched consecutive edge on each side (TASK_SPEC.md F2a/F3).
 *
 * All graph bookkeeping (re-parenting rows, creating the bend) happens in
 * TypeScript's GraphStore, reusing the existing createBendNode path — this
 * module has no knowledge of parts, bends, or region panels as graph rows,
 * only raw polygons and anchors (13 §6: "the module is pure... it never calls
 * the kernel").
 */

#include "manufacturing_graph_evaluator.hpp"

namespace mcp_cad::translation {

enum class MergeErrorCode {
  kNone,
  kNoContact,               // GE_MERGE_NO_CONTACT — the two parts' real anchors place them with
                            // no boundary contact anywhere (within MERGE_EDGE_ALIGNMENT_TOLERANCE_MM)
  kCoplanarSeam,            // GE_MERGE_COPLANAR_SEAM — the two parts are genuinely coplanar
                            // (angle ~= 0) at their only contact — this tool's job is a FOLD;
                            // use fuse_bodies for a flush, no-bend absorb instead
  kMergeSelfIntersecting,   // GE_MERGE_SELF_INTERSECTION — spliced outline would overlap itself
  kInternalInconsistency,   // should never trigger from any valid DetectContact result — a defensive
                            // check catching a bug, not a caller-triggerable outcome
};

struct DetectContactResult {
  bool ok = false;
  MergeErrorCode errorCode = MergeErrorCode::kNone;
  std::string message;

  // The chosen contact interval, in EACH side's own local 2D frame — exactly
  // the (edgeA0, edgeA1, edgeB0, edgeB1) the old caller-supplied API took,
  // now derived from anchors instead. Correspondence is physical: aRunStart
  // and bRunEnd are the SAME real 3D point (and aRunEnd/bRunStart the same),
  // matching the "opposite traversal order" rule ReconcileOutlines relies on
  // — ReconcileOutlines re-derives this itself from the points, this is not
  // a promise callers need to hand-verify.
  Point2 aRunStart;
  Point2 aRunEnd;
  Point2 bRunStart;
  Point2 bRunEnd;
  double angleDeg = 0.0;  // the real dihedral angle between A's and B's planes at the contact

  // Diagnostics for TASK_SPEC.md §8.3 (phase 1: pick the longest deterministically,
  // still surfaced here so a caller/test can confirm that's what happened;
  // phase 2, deferred, will need this to build a real disambiguation error).
  int contactRegionCount = 0;
};

// outlineA/outlineB: each part's own one stored flat outline (CCW), in its
// own local 2D frame. anchorA/anchorB: each part's own real R (13 §3.1),
// embedding that local flat frame into world — the ONLY input this function
// uses to find the seam; edge choice is never caller-supplied (TASK_SPEC.md
// F1/F2).
DetectContactResult DetectContact(const std::vector<Point2>& outlineA, const Transform3& anchorA,
                                   const std::vector<Point2>& outlineB, const Transform3& anchorB);

struct ReconcileOutlinesResult {
  bool ok = false;
  MergeErrorCode errorCode = MergeErrorCode::kNone;
  std::string message;
  std::vector<Point2> combinedOutline;  // A's outline with B spliced in, CCW
  // The shared seam segment, oriented for direct use as create_node(bend)'s
  // hingeA/hingeB — NOT necessarily (edgeA0, edgeA1) in that literal order.
  // manufacturing_graph_evaluator.cc's BoundingBends has one fixed rule ("the
  // CHILD side of a bend is the LEFT side of the directed line
  // hingeA->hingeB"); A's own pre-existing material is, by CCW winding,
  // always on the LEFT of A's own directed boundary run — so hingeA/hingeB
  // here are the run's end/start (reversed), putting A's material on the
  // RIGHT (parent) side and B's spliced-in material on the LEFT (child) side.
  Point2 hingeA;
  Point2 hingeB;
};

// outlineA/outlineB: each part's own one stored flat outline (CCW). edgeA0/
// edgeA1/edgeB0/edgeB1: DetectContact's own aRunStart/aRunEnd/bRunStart/
// bRunEnd — real points ON each outline's own boundary (on an existing
// vertex, or requiring a new vertex inserted mid-edge for an asymmetric seam;
// either way this function locates/inserts them itself, no index is passed
// in). radiusMm/kFactor/bottomIsConcave are NOT inputs here — this function
// only produces the combined 2D outline; bend-allowance/k-factor accounting
// happens the one existing way every other bend already gets it, via
// createBendNode + evaluatePartGraph's ComputeBendGeometry, never
// reimplemented here (TASK_SPEC.md F2b).
ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineA, const Point2& edgeA0,
                                           const Point2& edgeA1, const std::vector<Point2>& outlineB,
                                           const Point2& edgeB0, const Point2& edgeB1);

}  // namespace mcp_cad::translation
