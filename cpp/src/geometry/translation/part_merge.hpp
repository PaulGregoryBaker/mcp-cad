#pragma once

/**
 * Part merge — reconciling two independently-authored flat outlines at a
 * caller-specified seam edge (rebuild/14-graph-schema.md §2.1.2, Phase 5
 * Slice 4).
 *
 * `merge_bodies_with_bend` is NOT a new geometric primitive — per 14 §2.1.2 it
 * is (1) reconcile part B's outline into part A's one flat frame, (2) an
 * ordinary create_node(bend, ...) at the seam, (3) alias B via
 * merged_into_part_id. This module does ONLY step (1)'s pure geometry: given
 * an edge on A and an edge on B (each already resolved by the caller to its
 * two live 2D endpoints — this module never touches region panels, bends, or
 * bend zones), it computes the rigid 2D transform that makes the two edges
 * coincide and splices the two outlines into one combined outline plus the
 * shared hinge segment. All graph bookkeeping (re-parenting rows, creating
 * the bend) happens in TypeScript's GraphStore, reusing the existing
 * createBendNode path — this module has no knowledge of parts, bends, or
 * region panels as graph rows, only raw polygons (13 §6: "the module is
 * pure... it never calls the kernel").
 *
 * Two CCW polygons that will share a boundary edge must traverse that edge in
 * OPPOSITE order — this is the one fact that makes the alignment transform
 * unique (no search, no ambiguity, any angle including acute/inverted folds):
 * the transform T satisfies T(edgeB0) = edgeA1 and T(edgeB1) = edgeA0
 * (reversed correspondence). Edge-length mismatch beyond
 * kMergeEdgeAlignmentToleranceMm (part_merge.cc; resolves
 * rebuild/17-numerical-policy.md OPEN-17.1 as a fixed constant for this
 * slice) and a post-splice self-intersection check are the two typed failure
 * modes — no silent fallback to a bad merge (constitution principle VI).
 */

#include "manufacturing_graph_evaluator.hpp"

namespace mcp_cad::translation {

enum class MergeErrorCode {
  kNone,
  kInvalidEdgeRef,          // the given edge points aren't a consecutive pair in their outline
  kMergeEdgeMismatch,       // GE_MERGE_EDGE_MISMATCH — edge lengths differ beyond tolerance
  kMergeSelfIntersecting,   // GE_MERGE_SELF_INTERSECTION — spliced outline would overlap itself
};

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
  // always on the LEFT of A's own directed boundary edge edgeA0->edgeA1 —
  // so hingeA/hingeB here are edgeA1/edgeA0 (reversed), putting A's material
  // on the RIGHT (parent) side and B's spliced-in material on the LEFT
  // (child) side, matching the caller's own parentRegionPanelId (A's).
  Point2 hingeA;
  Point2 hingeB;
};

// outlineA/outlineB: each part's own one stored flat outline (CCW). edgeA0/
// edgeA1 and edgeB0/edgeB1: the two endpoints of a FREE boundary edge already
// resolved by the caller (via evaluatePartGraph + edgeBendId=="") — each pair
// must appear as consecutive vertices, in order, in its own outline.
ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineA, const Point2& edgeA0,
                                           const Point2& edgeA1, const std::vector<Point2>& outlineB,
                                           const Point2& edgeB0, const Point2& edgeB1);

}  // namespace mcp_cad::translation
