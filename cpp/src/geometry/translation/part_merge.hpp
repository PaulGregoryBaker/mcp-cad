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

// One candidate flat panel to test for contact — a part with bends has one of
// these per region panel (rebuild live-app regression 2026-09-22: a part's
// single stored (outline, anchor) only ever describes its ROOT panel's real
// world position; a folded, non-root panel's true 3D position only exists via
// that panel's own pose, manufacturing_graph_evaluator.cc's poseByRegionPanel
// cascade — applying the part's root anchor to material beyond the root
// silently checks the wrong plane and misses real contact entirely). A part
// with no bends passes exactly one candidate (its root panel, pose == its own
// anchor) — the single-panel case is not special-cased, just the n=1 case of
// this loop.
struct ContactPanelCandidate {
  // This panel's own ring, in the part's shared flat-pattern frame (F) — a
  // subring of the part's whole stored outline, e.g. a region panel's own
  // rawOuter. Points here are ALREADY in F, not a separately-local frame:
  // `pose` maps them straight to world, so a contact point found against this
  // ring is directly usable against the part's full outline with no remap.
  std::vector<Point2> outline;
  // This panel's own true world pose (the cascade product, not the part's
  // root anchor) — see the struct comment above.
  Transform3 pose;
  // Diagnostics only (ContactRegion::regionPanelIdA/B) — never consulted for
  // geometry.
  std::string regionPanelId;
};

// One real, physically-disjoint contact interval between some panel of A and
// some panel of B — TASK_SPEC.md §8.3 phase 2 (deferred no longer): a real
// assembly can have multiple simultaneous genuine contacts (e.g. two
// different panel pairs each touching along their own seam), and silently
// picking one used to hide that from the caller entirely. DetectContact
// returns every one it finds; the caller decides what to do with more than
// one (never DetectContact's own decision — TASK_SPEC.md F1/F2's "edge choice
// is never caller-supplied" is about DECIDING geometry, not about hiding real
// candidates).
// A point on a part's outline, by topology rather than by coordinate: the
// point outline[edgeIndex] + t * (outline[edgeIndex+1] - outline[edgeIndex]).
// t == 0 means exactly the vertex outline[edgeIndex]; 0 < t < 1 is strictly
// inside that edge. Always normalized so t is in [0, 1).
struct OutlineRef {
  int edgeIndex = -1;
  double t = 0.0;
};

struct ContactRegion {
  // B walks this seam the same way A does: B's sheet normal is reversed
  // relative to A here. The merge must first re-express B from the other
  // side of the sheet (FlipPart, manufacturing_graph_evaluator.hpp); bStart/
  // bEnd/bRunStart/bRunEnd and angleDeg below are ALREADY in those flipped
  // terms (refs on FlipPart(B)'s outline, B's normal reversed).
  bool flipped = false;
  // The seam's two ends on each part's own outline, in A's forward-walk
  // order. Physical correspondence: aStart and bEnd are the same real 3D
  // point, as are aEnd and bStart (two CCW polygons sharing a boundary run
  // traverse it in opposite directions) — exactly what ReconcileOutlines
  // takes.
  OutlineRef aStart;
  OutlineRef aEnd;
  OutlineRef bStart;
  OutlineRef bEnd;
  // The same four points as coordinates in each part's flat frame —
  // derived from the refs above, for diagnostics and callers that need a
  // location.
  Point2 aRunStart;
  Point2 aRunEnd;
  Point2 bRunStart;
  Point2 bRunEnd;
  double angleDeg = 0.0;  // the real dihedral angle between THIS panel pair's planes, at this contact
  double lengthMm = 0.0;
  // Diagnostics: which panel of A/B this region came from — never consulted
  // for geometry (ReconcileOutlines only ever needs the four points above).
  std::string regionPanelIdA;
  std::string regionPanelIdB;
};

struct DetectContactResult {
  bool ok = false;
  MergeErrorCode errorCode = MergeErrorCode::kNone;
  std::string message;

  // Every real contact region found, across every (panelA, panelB) pair —
  // empty iff errorCode == kNoContact. No ordering is guaranteed beyond
  // being deterministic for the same input (panel-pair discovery order);
  // a caller that wants "the longest" sorts this itself.
  std::vector<ContactRegion> regions;
};

// outlineA/outlineB: each part's whole stored flat outline (CCW, frame F).
// panelsA/panelsB: every region panel of each part, as its own ring (a
// region panel's rawOuter, whose vertices are outline vertices or hinge
// endpoints on the outline) + its own true world pose — never a single
// whole-part anchor, since a part with bends has no single rigid transform
// that places all of its material. Only a panel's FREE edges (those lying on
// the part's outline) can be a seam; hinge edges are internal. Tests every
// (panelA, panelB) pair and returns every real region; choosing among them
// is the caller's decision.
DetectContactResult DetectContact(const std::vector<Point2>& outlineA,
                                   const std::vector<ContactPanelCandidate>& panelsA,
                                   const std::vector<Point2>& outlineB,
                                   const std::vector<ContactPanelCandidate>& panelsB);

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
  // carryB mapped into A's frame by the exact rigid transform that placed
  // outlineB into combinedOutline — same order, same length as carryB.
  std::vector<Point2> carriedB;
};

// outlineA/outlineB: each part's own stored flat outline (CCW). a0/a1/b0/b1:
// a ContactRegion's aStart/aEnd/bStart/bEnd — the seam ends by topology. A
// mid-edge ref (t > 0) inserts exactly that point; a vertex ref uses the
// vertex as-is. No coordinate search. radiusMm/kFactor/bottomIsConcave are
// not inputs: bend-allowance accounting happens via the created bend.
//
// carryB: any other B-frame geometry that must move with B's outline (B's own
// bend hinges, hole centres, hole vertices), mapped by the same transform.
ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineA, const OutlineRef& a0,
                                           const OutlineRef& a1, const std::vector<Point2>& outlineB,
                                           const OutlineRef& b0, const OutlineRef& b1,
                                           const std::vector<Point2>& carryB = {});

}  // namespace mcp_cad::translation
