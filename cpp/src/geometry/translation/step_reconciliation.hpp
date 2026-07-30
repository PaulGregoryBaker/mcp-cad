#pragma once

/**
 * Import reconciliation (rebuild/13-translation-module-design.md §6, Phase 5
 * Slice 5) — the ONE genuinely new step "ingest STEP -> graph" needs. Given N
 * independently-measured, flat panel pieces (each already canonicalized CCW
 * in its own local (u,v) frame — exactly `PanelFrameResult`'s shape, one per
 * shell `getPanelFrame` was called on after `splitBodyByBends`), this module
 * finds how they were physically joined, picks a root, and *unfolds* every
 * other piece back into the root's flat frame across its measured hinge (the
 * inverse of a forward fold, applied once at import) — producing exactly one
 * `PartGraphSpec`, the SAME shape `Evaluate()`/`ConstructPartSolid()`/
 * `MapPointToWorld()`/`MapPointToFlat()` already consume unchanged.
 *
 * This module is pure (no OCCT, no kernel calls) — same isolation rationale
 * as manufacturing_graph_evaluator/point_mapping/part_merge. It reuses two
 * already-proven techniques rather than inventing new ones:
 *   - the pairwise rigid-2D edge-alignment + splice from part_merge.hpp
 *     (there the transform is SOLVED from two independent edges that need to
 *     align; here it's the identical operation, just applied once per tree
 *     edge instead of once total, generalized to a recursive boundary trace
 *     since a splice's insertion point can itself contain further splices);
 *   - the "derive an angle from a measured, distance-preserving invariant,
 *     never hand-derive a sin/cos formula" discipline from point_mapping.cc
 *     (a hand-derived hinge-frame decomposition there had a real sign bug;
 *     reusing Transform3::RotationAboutAxis's own already-tested convention
 *     and solving for its angle from a known before/after point pair
 *     sidestepped it entirely — the same approach is used here to derive
 *     each bend's signed angleDeg from the piece's TRUE measured position,
 *     never from face-normal trigonometry directly).
 *
 * Sharp folds only (radiusMm=0, kFactor=0) — curved-bend nodes are Slice 6's
 * named scope; a fold whose measured geometry isn't a clean two-flat-faces
 * edge is a typed error here, not an approximation.
 */

#include "manufacturing_graph_evaluator.hpp"

namespace mcp_cad::translation {

// One kernel-measured flat panel piece — mirrors PanelFrameResult's shape
// exactly (world origin/u/v/normal + a CCW ring already local to (u,v),
// per getPanelFrame's own convention) so no new kernel-side measurement is
// needed to produce this input.
struct PanelPieceSpec {
  Point3 origin;
  Point3 uAxis;
  Point3 vAxis;
  Point3 normal;
  std::vector<Point2> ringLocal;
  double thicknessMm = 0.0;
};

enum class ReconcileErrorCode {
  kNone,
  kTooFewPieces,         // fewer than 1 piece supplied
  kDisconnectedPieces,   // one or more pieces share no measured edge with the rest
  kNonDevelopableFold,   // a matched edge's lengths disagree, or the measured
                         // fold can't be reproduced by a single rigid rotation
                         // (e.g. a real fillet face between panels) — the C5
                         // "curved bend" boundary this slice does not attempt
  kSelfIntersecting,     // the reconciled outline would overlap itself
  // The graph built here, replayed through the REAL downstream consumer
  // (Evaluate(), the exact machinery every other v2 tool uses), does not
  // reproduce the pieces' own true measured positions. This is a distinct,
  // stronger check than kNonDevelopableFold's own self-consistency test:
  // that check can only ever verify internal consistency against THIS
  // module's own math, so it cannot catch an upstream input defect where
  // every individual piece is well-formed but pieces disagree with each
  // other about which physical surface they each reference (found in
  // practice: getPanelFrame returning one panel's bottom face and an
  // adjacent panel's top face for the same decomposed part) — Evaluate()'s
  // own bend-direction-dependent pose chain (mountain vs valley bottom-
  // surface radius) exposes exactly that disagreement even when this
  // module's own rotation math was internally self-consistent throughout.
  kDownstreamPoseMismatch,
};

// A bend's hinge, traced back to the original per-piece ring-edge index it
// came from (BEFORE any flattening/splicing into the shared flat frame) —
// e.g. needed by a caller wanting to drive merge_bodies_with_bend's own
// edge_a/edge_b refs {region_panel_id, edge_index} against independently-
// created single-panel Parts built directly from the same input pieces.
// Not used by ReconcilePieces' own graph construction (BendSpec.hingeA/
// hingeB, already in the shared flat frame, are sufficient there) — this
// exists purely to expose an already-computed internal value to callers
// that need to correlate back to piece-local geometry.
struct PieceEdgeMatch {
  int parentEdgeIndex = -1;  // edge index within the PARENT piece's own ringLocal
  int childEdgeIndex = -1;   // edge index within the CHILD piece's own ringLocal
};

struct ReconcilePiecesResult {
  bool ok = false;
  ReconcileErrorCode errorCode = ReconcileErrorCode::kNone;
  std::string message;
  // rootRegionPanelId and every BendSpec's parent/childRegionPanelId use the
  // temporary, deterministic correlation ids "piece{inputIndex}" — the
  // caller (TS import_part orchestration) walks `graph.bends` in the
  // returned (parent-before-child, BFS) order, remapping each temp id onto
  // the real UUID GraphStore.createPart/createBendNode mints for it. This
  // graph is never evaluated by its own ids directly downstream of this
  // call — only its outline/anchor/thicknessMm/bends field VALUES are used.
  //
  // When the input pieces form a single connected component, this is the
  // reconciled graph.  When there are multiple disconnected components,
  // `graphs` below holds one graph per component and this field is the
  // first (largest) one for backward compatibility.
  PartGraphSpec graph;
  // One graph per connected component — always populated (even for single-
  // component input, where it contains exactly one entry).  The TS caller
  // should iterate this rather than relying on the single `graph` field.
  std::vector<PartGraphSpec> graphs;
  // Non-fatal findings — e.g. a piece touching more than one already-placed
  // neighbour (an extra, non-tree adjacency: a real physical seam, 14 §2,
  // not auto-detected/driven this slice) is reported here, not silently
  // dropped and not a hard failure.
  std::vector<std::string> notes;
  // Parallel to `graph.bends` (same index, same order) — see PieceEdgeMatch.
  std::vector<PieceEdgeMatch> pieceEdgeMatches;
};

ReconcilePiecesResult ReconcilePieces(const std::vector<PanelPieceSpec>& pieces,
                                       double thicknessMm);

}  // namespace mcp_cad::translation
