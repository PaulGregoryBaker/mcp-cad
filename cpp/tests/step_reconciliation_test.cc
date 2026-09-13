#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/point_mapping.hpp"
#include "geometry/translation/step_reconciliation.hpp"

#include <cmath>

using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

double Dist3(const Point3& a, const Point3& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) +
                    (a.z - b.z) * (a.z - b.z));
}

// A 90-degree L: piece0 (root, 10x5, in the world z=0 plane) and piece1
// (5x8, in the world x=10 plane) sharing the world edge (10,0,0)-(10,5,0).
// Hand-derived so the ring/frame data is independently known to be
// self-consistent (not copied from any solver) — see the plan's own
// worked derivation. piece1's ring is deliberately wound in REVERSE order
// relative to piece0's own edge traversal, matching the physical fact any
// two CCW panels meeting at a real fold always do.
std::vector<PanelPieceSpec> MakeLBracket() {
  PanelPieceSpec piece0;
  piece0.origin = {0, 0, 0};
  piece0.uAxis = {1, 0, 0};
  piece0.vAxis = {0, 1, 0};
  piece0.normal = {0, 0, 1};
  piece0.ringLocal = {{0, 0}, {10, 0}, {10, 5}, {0, 5}};
  piece0.thicknessMm = 1.0;

  PanelPieceSpec piece1;
  piece1.origin = {10, 5, 0};
  piece1.uAxis = {0, -1, 0};
  piece1.vAxis = {0, 0, 1};
  piece1.normal = {-1, 0, 0};
  piece1.ringLocal = {{0, 0}, {5, 0}, {5, 8}, {0, 8}};
  piece1.thicknessMm = 1.0;

  return {piece0, piece1};
}

// Extends MakeLBracket with a third piece folded again from piece1's FAR
// edge (opposite its seam with piece0), forming a U/channel — exercises the
// recursive splice/unfold at depth 2 (root -> child -> grandchild), not
// just a single pairwise fold. Hand-derived the same way as MakeLBracket.
std::vector<PanelPieceSpec> MakeUChannel() {
  auto pieces = MakeLBracket();

  PanelPieceSpec piece2;
  piece2.origin = {10, 5, 8};
  piece2.uAxis = {0, -1, 0};
  piece2.vAxis = {-1, 0, 0};
  piece2.normal = {0, 0, -1};
  piece2.ringLocal = {{0, 0}, {5, 0}, {5, 6}, {0, 6}};
  piece2.thicknessMm = 1.0;

  pieces.push_back(piece2);
  return pieces;
}

// A real mitered corner: piece0 (200x200 floor, z=0 plane) is parent to TWO
// separate children, piece1 and piece2, each folded up 90deg from a
// DIFFERENT edge of piece0 that meets at piece0's own (0,0,0) corner —
// piece1 from the Y=0 edge, piece2 from the X=0 edge. Once folded, piece1's
// far edge and piece2's near edge both land on the same world line
// (X=0,Y=0,Z=0..150) — they touch after folding but share no flat material
// (a real "two bends converging on one corner" case, manufacturing_graph_
// evaluator.hpp's bottomIsConcave doc comment's own cited scenario). Hand-
// derived the same way as MakeLBracket/MakeUChannel (normal = uAxis x vAxis
// throughout, each child's u/v traversing its shared edge with piece0 in
// reverse order from piece0's own ring). Realistic sheet-metal proportions
// throughout (200mm panels, 1mm
// thickness — thickness << side, unlike an earlier draft of this fixture
// that used thickness=10 on a 10mm panel, which isn't a "panel" at all and
// produced meaningless edge-matching behaviour).
std::vector<PanelPieceSpec> MakeMiteredCorner() {
  PanelPieceSpec piece0;
  piece0.origin = {0, 0, 0};
  piece0.uAxis = {1, 0, 0};
  piece0.vAxis = {0, 1, 0};
  piece0.normal = {0, 0, 1};
  piece0.ringLocal = {{0, 0}, {200, 0}, {200, 200}, {0, 200}};
  piece0.thicknessMm = 1.0;

  // Folds up from piece0's Y=0 edge, (0,0,0)-(200,0,0), traversed in reverse.
  PanelPieceSpec piece1;
  piece1.origin = {200, 0, 0};
  piece1.uAxis = {-1, 0, 0};
  piece1.vAxis = {0, 0, 1};
  piece1.normal = {0, 1, 0};
  piece1.ringLocal = {{0, 0}, {200, 0}, {200, 150}, {0, 150}};
  piece1.thicknessMm = 1.0;

  // Folds up from piece0's X=0 edge, (0,200,0)-(0,0,0), traversed in reverse.
  PanelPieceSpec piece2;
  piece2.origin = {0, 0, 0};
  piece2.uAxis = {0, 1, 0};
  piece2.vAxis = {0, 0, 1};
  piece2.normal = {1, 0, 0};
  piece2.ringLocal = {{0, 0}, {200, 0}, {200, 150}, {0, 150}};
  piece2.thicknessMm = 1.0;

  return {piece0, piece1, piece2};
}

// Same corner, but with thicknessMm=5 (not 1) throughout -- still a
// realistic 2.5% of the 200mm panel side, not the earlier (invalid)
// thickness=10-on-a-10mm-panel draft -- and piece1 replaced by piece1cvx:
// the SAME 90deg rotation (same angleDeg must be recoverable, since
// angleDeg is a pure function of the panels' normals, independent of pivot
// position) applied about pivotZ = thicknessMm instead of pivotZ = 0 --
// i.e. a genuine convex (bottom = outer, non-touching) fold. Derived by
// hand: piece1's own world corners, rotated about the shifted axis line
// {(x, 0, 5)} instead of {(x, 0, 0)} by the identical rotation -- general
// formula (verified against the thickness=1 case first): origin becomes
// (W, -T, T) instead of (W, 0, 0), everything else unchanged. At T=5 the
// concave/convex hypotheses are 5*sqrt(2)~=7.07mm apart in world space,
// comfortably beyond kSelfConsistencyToleranceMm/kPieceEdgeMatchToleranceMm
// (2.0mm each) -- unlike thickness=1 (~1.41mm apart, indistinguishable) or
// the invalid thickness=10-on-10mm-panel draft (14mm apart but the panel
// itself wasn't thin, and the shifted edge fell out of match tolerance
// entirely, treating piece1 as disconnected).
std::vector<PanelPieceSpec> MakeMiteredCornerWithConvexPiece1() {
  auto pieces = MakeMiteredCorner();
  for (auto& p : pieces) p.thicknessMm = 5.0;

  PanelPieceSpec piece1cvx;
  piece1cvx.origin = {200, -5, 5};
  piece1cvx.uAxis = {-1, 0, 0};
  piece1cvx.vAxis = {0, 0, 1};
  piece1cvx.normal = {0, 1, 0};
  piece1cvx.ringLocal = {{0, 0}, {200, 0}, {200, 150}, {0, 150}};
  piece1cvx.thicknessMm = 5.0;

  pieces[1] = piece1cvx;
  return pieces;
}

}  // namespace

TEST_CASE("ReconcilePieces: 2-piece L reproduces true 3D positions via MapPointToWorld",
          "[translation][step_reconciliation]") {
  auto pieces = MakeLBracket();
  auto result = ReconcilePieces(pieces, 1.0);
  REQUIRE(result.ok);
  CHECK(result.graph.bends.size() == 1);
  CHECK(result.graph.rootRegionPanelId == "piece0");

  // pieceEdgeMatches must be parallel to graph.bends and correctly trace
  // back to the ORIGINAL piece-local edge each hinge came from — verified
  // by hand: piece0's ring is {(0,0),(10,0),(10,5),(0,5)}, so its shared
  // edge (world (10,0,0)-(10,5,0), the seam with piece1) is edge index 1
  // ((10,0)->(10,5)); piece1's ring is {(0,0),(5,0),(5,8),(0,8)}, so its
  // own shared edge (local (0,0)->(5,0), which maps to the SAME world seam
  // per piece1's origin/uAxis) is edge index 0. Checked via each edge's own
  // hand-verified length (5, the seam's true length) rather than the raw
  // index alone, so this doesn't silently pass if BOTH indices happened to
  // shift by the same wrong amount.
  REQUIRE(result.pieceEdgeMatches.size() == result.graph.bends.size());
  const auto& match0 = result.pieceEdgeMatches[0];
  REQUIRE(match0.parentEdgeIndex >= 0);
  REQUIRE(match0.parentEdgeIndex < static_cast<int>(pieces[0].ringLocal.size()));
  REQUIRE(match0.childEdgeIndex >= 0);
  REQUIRE(match0.childEdgeIndex < static_cast<int>(pieces[1].ringLocal.size()));
  {
    const auto& ring0 = pieces[0].ringLocal;
    size_t ea = static_cast<size_t>(match0.parentEdgeIndex);
    double lenParent = std::hypot(ring0[(ea + 1) % ring0.size()].x - ring0[ea].x,
                                   ring0[(ea + 1) % ring0.size()].y - ring0[ea].y);
    CHECK(lenParent == Approx(5.0));

    const auto& ring1 = pieces[1].ringLocal;
    size_t eb = static_cast<size_t>(match0.childEdgeIndex);
    double lenChild = std::hypot(ring1[(eb + 1) % ring1.size()].x - ring1[eb].x,
                                  ring1[(eb + 1) % ring1.size()].y - ring1[eb].y);
    CHECK(lenChild == Approx(5.0));
  }

  // Hand-verified combined outline (matches part_merge_test.cc's own worked
  // 18x5 rectangle for the identical geometry): piece1 (5 wide along the
  // seam, 8 tall) attaches outward from piece0's right edge.
  std::vector<Point2> expected = {{0, 0}, {10, 0}, {18, 0}, {18, 5}, {10, 5}, {0, 5}};
  REQUIRE(result.graph.outline.outer.size() == expected.size());
  for (size_t i = 0; i < expected.size(); ++i) {
    double d = std::hypot(result.graph.outline.outer[i].x - expected[i].x,
                          result.graph.outline.outer[i].y - expected[i].y);
    CHECK(d < 1e-6);
  }

  EvaluateResult layout = Evaluate(result.graph);
  REQUIRE(layout.ok);

  // A point at flat (15, 2.5) lies inside piece1's own reconciled (spliced)
  // territory (x in [10,18]) — mapping it forward must reproduce the TRUE
  // 3D position on piece1's real (unfolded) plane at x=10, y in [0,5],
  // z in [0,8]. Piece1's true world embedding: local (u,v) -> world via
  // origin + u*uAxis + v*vAxis. The flat point (15,2.5) is 5 units past the
  // seam (x=10) and 2.5 units up the seam (y from 0 at x=10 vertex to 5 at
  // x=18 vertex, matching piece0's own y-range) — in piece1's OWN local
  // (u,v) frame this is (u=|15-10|=5 measured along its own v-mapped axis...
  // simplest: just confirm the ROUND TRIP (2D->3D->2D) lands back on the
  // same flat point and reports the reconciled child panel — this is the
  // exact position_preserved-style oracle the suite itself uses (09 §1's O1:
  // true-position probes), without hand-deriving piece1's own local (u,v)
  // mapping a second time.
  Point2 flatQuery{15.0, 2.5};
  MapToWorldResult toWorld = MapPointToWorld(result.graph, layout, flatQuery);
  REQUIRE(toWorld.ok);
  CHECK(toWorld.regionPanelId == "piece1");

  MapToFlatResult toFlat = MapPointToFlat(result.graph, layout, toWorld.point3d);
  REQUIRE(toFlat.ok);
  CHECK(toFlat.regionPanelId == "piece1");
  CHECK(std::hypot(toFlat.point2d.x - flatQuery.x, toFlat.point2d.y - flatQuery.y) < 1e-6);

  // Stronger, independent check: piece1's TRUE world corner (10,0,8) is
  // known directly from MakeLBracket's own hand-derivation (not derived via
  // this module) — its flat-frame position must be exactly piece1's own
  // ringLocal[1]=(5,0) spliced into the combined outline (i.e. world x=18,
  // y=0 in the flat pattern, since piece1's local (5,0) maps to combined
  // (18,0) by the hand-verified outline above) — mapping THAT known flat
  // point forward must reproduce (10,0,8) exactly.
  MapToWorldResult corner = MapPointToWorld(result.graph, layout, {18.0, 0.0});
  REQUIRE(corner.ok);
  CHECK(Dist3(corner.point3d, {10, 0, 8}) < 1e-6);

  MapToWorldResult corner2 = MapPointToWorld(result.graph, layout, {18.0, 5.0});
  REQUIRE(corner2.ok);
  CHECK(Dist3(corner2.point3d, {10, 5, 8}) < 1e-6);
}

TEST_CASE("ReconcilePieces: 3-piece U-channel reproduces true 3D positions at depth 2",
          "[translation][step_reconciliation]") {
  auto pieces = MakeUChannel();
  auto result = ReconcilePieces(pieces, 1.0);
  INFO("errorCode=" << static_cast<int>(result.errorCode) << " message=" << result.message);
  REQUIRE(result.ok);
  CHECK(result.graph.bends.size() == 2);
  CHECK(result.graph.rootRegionPanelId == "piece0");

  EvaluateResult layout = Evaluate(result.graph);
  REQUIRE(layout.ok);
  CHECK(layout.panels.size() == 3);

  // Round-trip every piece's TRUE world corners through MapPointToFlat ->
  // MapPointToWorld, avoiding any hand-derived expected flat coordinate —
  // the strongest available oracle (09 §1's O1 true-position probe) without
  // re-deriving this module's own splice arithmetic in the test itself.
  // Corner points shared between two panels are genuinely ambiguous by
  // design (point_mapping.hpp: "a point on the boundary... belongs to both
  // neighbours") — MapPointToWorld resolves ties to whichever panel is
  // visited first in Evaluate()'s own BFS (root, then parent-before-child),
  // so shared corners here resolve to piece0 (root, shares with piece1) and
  // piece1 (piece2's own parent, shares with piece2) respectively. Only
  // piece0's and piece2's own UNSHARED corners get an unambiguous match.
  struct Check {
    std::string expectedPanel;
    Point3 trueWorld;
  };
  std::vector<Check> checks = {
      {"piece0", {0, 0, 0}},   {"piece0", {10, 5, 0}}, {"piece0", {10, 0, 0}},
      {"piece1", {10, 0, 8}},  {"piece1", {10, 5, 8}}, {"piece2", {4, 5, 8}},
      {"piece2", {4, 0, 8}},
  };
  for (const auto& c : checks) {
    MapToFlatResult toFlat = MapPointToFlat(result.graph, layout, c.trueWorld);
    REQUIRE(toFlat.ok);
    CHECK(toFlat.regionPanelId == c.expectedPanel);

    MapToWorldResult back = MapPointToWorld(result.graph, layout, toFlat.point2d);
    REQUIRE(back.ok);
    CHECK(Dist3(back.point3d, c.trueWorld) < 1e-6);
  }
}

TEST_CASE("ReconcilePieces: a leftover component of 2+ pieces sharing a real edge is "
          "grouped into ONE graph with a bend, not emitted as separate singleton pieces",
          "[translation][step_reconciliation]") {
  // Main component: an ordinary 2-piece L-bracket (piece0, piece1).
  auto pieces = MakeLBracket();

  // Leftover component: a SECOND, independent L-bracket (piece2, piece3),
  // built the same way but translated far away in world space — shares no
  // edge with the main component, but piece2/piece3 DO share a real edge
  // with EACH OTHER, exactly like testcube.step's own pieces 6+8
  // (docs/BUG_REPORT_disconnected_components_not_grouped.md).
  auto leftoverPair = MakeLBracket();
  const Point3 offset{1000.0, 0.0, 0.0};
  for (auto& piece : leftoverPair) {
    piece.origin = {piece.origin.x + offset.x, piece.origin.y + offset.y,
                     piece.origin.z + offset.z};
  }
  pieces.push_back(leftoverPair[0]);  // piece2
  pieces.push_back(leftoverPair[1]);  // piece3

  auto result = ReconcilePieces(pieces, 1.0);
  INFO("errorCode=" << static_cast<int>(result.errorCode) << " message=" << result.message);
  REQUIRE(result.ok);

  // Main graph unaffected by the leftover pieces' presence.
  CHECK(result.graph.bends.size() == 1);
  CHECK(result.graph.rootRegionPanelId == "piece0");

  // Exactly ONE leftover entry (the grouped pair), not two singletons —
  // the actual bug this fix addresses.
  REQUIRE(result.graphs.size() == 2);
  const PartGraphSpec& leftoverGraph = result.graphs[1];
  CHECK(leftoverGraph.bends.size() == 1);
  CHECK((leftoverGraph.rootRegionPanelId == "piece2" || leftoverGraph.rootRegionPanelId == "piece3"));

  // The grouped leftover component round-trips through Evaluate() exactly
  // like the main component does — it went through the SAME reconciliation.
  EvaluateResult leftoverLayout = Evaluate(leftoverGraph);
  REQUIRE(leftoverLayout.ok);
  CHECK(leftoverLayout.panels.size() == 2);
}

TEST_CASE("ReconcilePieces: defaultBendRadiusMm is stamped onto every bend without "
          "perturbing which pivot side reconciliation finds, and radiusMeasured stays "
          "false regardless (provenance, not validation)",
          "[translation][step_reconciliation]") {
  auto pieces = MakeLBracket();

  // Default (0.0, matching the historical sharp-fold assumption) round-trips
  // to the exact positions the un-parameterized overload always produced.
  auto baseline = ReconcilePieces(pieces, 1.0);
  REQUIRE(baseline.ok);
  REQUIRE(baseline.graph.bends.size() == 1);
  CHECK(baseline.graph.bends[0].radiusMm == Approx(0.0));
  CHECK(baseline.graph.bends[0].radiusMeasured == false);
  bool bottomIsConcave = baseline.graph.bends[0].bottomIsConcave.value_or(true);

  // A nonzero org-profile default must NOT change reconciliation's own
  // success/failure or which pivot side it finds — only the stamped
  // radiusMm on the output — since the pivot search always reconciles the
  // TRUE (always sharp/flush) measured geometry, never the assumed radius
  // (see step_reconciliation.cc's own comment on this design). This is
  // safe (docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md's
  // 2026-08-09 correction): Evaluate() re-derives the flat/3D
  // representation fresh from whatever radius a bend carries, always
  // self-consistently (AC-E.3) — stamping here doesn't need to match what
  // the r=0 replay validated, only the replay's own topology (hinge,
  // angle, pivot side) needs to be sound, and that's unaffected by radius.
  auto withRadius = ReconcilePieces(pieces, 1.0, /*defaultBendRadiusMm=*/1.5);
  REQUIRE(withRadius.ok);
  REQUIRE(withRadius.graph.bends.size() == 1);
  CHECK(withRadius.graph.bends[0].radiusMm == Approx(1.5));
  CHECK(withRadius.graph.bends[0].radiusMeasured == false);
  CHECK(withRadius.graph.bends[0].bottomIsConcave.value_or(true) == bottomIsConcave);
  CHECK(withRadius.graph.bends[0].angleDeg == Approx(baseline.graph.bends[0].angleDeg));
  CHECK(withRadius.graph.outline.outer.size() == baseline.graph.outline.outer.size());

  // graphs[0] (the caller-facing entry) must carry the same stamped value.
  REQUIRE(withRadius.graphs.size() >= 1);
  REQUIRE(withRadius.graphs[0].bends.size() == 1);
  CHECK(withRadius.graphs[0].bends[0].radiusMm == Approx(1.5));
  CHECK(withRadius.graphs[0].bends[0].radiusMeasured == false);
}

TEST_CASE("ReconcilePieces: two pieces with no shared edge become two standalone "
          "solo-graph parts, not a hard error",
          "[translation][step_reconciliation]") {
  // Since commit 4f89251 ("ReconcilePieces handles disconnected components
  // gracefully"), a piece sharing no measured edge with anything else is no
  // longer a hard failure — it's surfaced as its own standalone one-piece
  // part (kDisconnectedPieces is retired/unused; see step_reconciliation.hpp).
  auto pieces = MakeLBracket();
  // Move piece1 far away so no edge matches.
  pieces[1].origin = {1000, 1000, 1000};

  auto result = ReconcilePieces(pieces, 1.0);
  INFO("errorCode=" << static_cast<int>(result.errorCode) << " message=" << result.message);
  REQUIRE(result.ok);
  CHECK(result.graph.bends.empty());
  REQUIRE(result.graphs.size() == 2);
  CHECK(result.graphs[0].bends.empty());
  CHECK(result.graphs[1].bends.empty());
}

TEST_CASE("ReconcilePieces: a malformed (non-orthonormal) piece frame is a typed error",
          "[translation][step_reconciliation]") {
  auto pieces = MakeLBracket();
  // A non-unit vAxis makes BuildPieceFrame's transform not a pure rotation
  // (not length/angle-preserving) — the shared edge still matches (it only
  // depends on uAxis/origin here), but the self-consistency check on the
  // piece's OTHER vertices must catch the inconsistency rather than silently
  // accepting a distorted fold.
  pieces[1].vAxis = {0, 0, 2.0};

  auto result = ReconcilePieces(pieces, 1.0);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == ReconcileErrorCode::kNonDevelopableFold);
}

// rebuild/20-bend-bridge-geometry.md Ch. 6d: a symmetric mitered corner
// (both children folding the same physical direction, up) must reconcile
// both bends to the SAME, fallback-matching concavity -- there's no reason
// for a symmetric corner to disagree with itself. Regression-pins the
// non-convex half of Ch. 6d's fix (this passed even before that fix; kept
// as a baseline so a future change can't silently break the ordinary case
// while "fixing" the convex one).
TEST_CASE("ReconcilePieces: mitered corner (piece0 parent of TWO children via "
          "separate edges), both folding the same direction, agree with the "
          "angleDeg-sign fallback",
          "[translation][step_reconciliation]") {
  auto pieces = MakeMiteredCorner();
  auto result = ReconcilePieces(pieces, 1.0);
  INFO("errorCode=" << static_cast<int>(result.errorCode) << " message=" << result.message);
  REQUIRE(result.ok);
  CHECK(result.graph.rootRegionPanelId == "piece0");
  REQUIRE(result.graph.bends.size() == 2);

  for (const auto& bend : result.graph.bends) {
    CHECK(bend.angleDeg == Approx(90.0));
    CHECK(bend.bottomIsConcave.value_or(true) == true);
  }
  // The non-tree piece1/piece2 touch (the miter seam itself) must be
  // reported, not silently dropped or mistaken for a third bend.
  CHECK_FALSE(result.notes.empty());
}

// rebuild/20-bend-bridge-geometry.md Ch. 6d's actual fix, locked in: with
// piece1 replaced by a genuinely convex fold (MakeMiteredCornerWithConvexPiece1
// -- realistic 200mm/5mm proportions, well beyond the old shared-tolerance
// ambiguity zone), tryPivotZ must now correctly select the convex branch --
// a real, verified disagreement with the angleDeg>=0 fallback, unlike the
// old "confirmed on a mitered-corner fixture" claim this test replaces
// (manufacturing_graph_evaluator.hpp's bottomIsConcave doc comment), which
// no test ever actually backed. Notably, bottomIsConcave=false with
// angleDeg=+90 here AGREES with Fact 2.1's own fold-direction prediction
// (doc 20 Ch. 2) for a fold going "up" in this convention -- this is not a
// counterexample to Fact 2.1.
TEST_CASE("ReconcilePieces: mitered corner with piece1 as a genuine CONVEX "
          "fold (pivotZ=thicknessMm, not 0) is correctly detected, "
          "disagreeing with the angleDeg-sign fallback",
          "[translation][step_reconciliation]") {
  auto pieces = MakeMiteredCornerWithConvexPiece1();
  auto result = ReconcilePieces(pieces, 5.0);
  INFO("errorCode=" << static_cast<int>(result.errorCode) << " message=" << result.message);
  REQUIRE(result.ok);
  REQUIRE(result.graph.bends.size() == 2);

  const BendSpec* bend1 = nullptr;
  const BendSpec* bend2 = nullptr;
  for (const auto& bend : result.graph.bends) {
    if (bend.childRegionPanelId == "piece1") bend1 = &bend;
    if (bend.childRegionPanelId == "piece2") bend2 = &bend;
  }
  REQUIRE(bend1 != nullptr);
  REQUIRE(bend2 != nullptr);

  CHECK(bend1->angleDeg == Approx(90.0));
  CHECK(bend1->bottomIsConcave.value_or(true) == false);  // genuinely convex

  CHECK(bend2->angleDeg == Approx(90.0));
  CHECK(bend2->bottomIsConcave.value_or(true) == true);  // still concave, unchanged
}
