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

TEST_CASE("ReconcilePieces: every reconciled bend is radiusMm=0.0, "
          "radiusMeasured=false, always - no caller-supplied radius is stamped in",
          "[translation][step_reconciliation]") {
  auto pieces = MakeLBracket();

  // No radius argument exists on ReconcilePieces anymore (removed
  // 2026-08-06 — see docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md:
  // stamping an assumed radius onto radiusMm after reconciliation's own
  // r=0-only replay validation silently moved every downstream
  // reconstruction away from the true, as-scanned geometry). radiusMm=0.0
  // is the only value this module's own self-consistency replay ever
  // validates, and radiusMeasured=false honestly records that it's not a
  // measurement.
  auto result = ReconcilePieces(pieces, 1.0);
  REQUIRE(result.ok);
  REQUIRE(result.graph.bends.size() == 1);
  CHECK(result.graph.bends[0].radiusMm == Approx(0.0));
  CHECK(result.graph.bends[0].radiusMeasured == false);

  // graphs[0] (the caller-facing entry) must carry the same values.
  REQUIRE(result.graphs.size() >= 1);
  REQUIRE(result.graphs[0].bends.size() == 1);
  CHECK(result.graphs[0].bends[0].radiusMm == Approx(0.0));
  CHECK(result.graphs[0].bends[0].radiusMeasured == false);
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
