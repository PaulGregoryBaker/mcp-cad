#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/part_solid_construction.hpp"
#include "geometry/geometry_service_impl.hpp"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <map>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

using namespace mcp_cad;
using namespace mcp_cad::translation;
using Catch::Approx;

namespace {

constexpr double kTestPi = 3.14159265358979323846;

// Same BA formula manufacturing_graph_evaluator.cc uses internally — duplicated
// here (and again, separately, in manufacturing_graph_evaluator_test.cc) rather
// than exposed from the .cc, purely to size the flat outline below. Both test
// files need this independently; see MakeStrip's own comment for why.
double TestBendAllowanceMm(double angleDeg, double radiusMm, double kFactor,
                            double thicknessMm) {
  double angleRad = std::fabs(angleDeg * kTestPi / 180.0);
  return angleRad * (radiusMm + kFactor * thicknessMm);
}

// Builds an N-segment strip with N-1 bends of `angleDeg` each, real (possibly
// nonzero) bend radius/K-factor. `hingeTiltDeg`/`hingeYOffsetMm` rotate/shift the
// hinge line away from being perfectly perpendicular to and centred on the
// strip's own length axis, so tests can assert no hidden bias toward axis-aligned
// hinges (mirrors manufacturing_graph_evaluator_test.cc's own MakeStrip exactly —
// see that file's comment for the full derivation of the spacing formula below).
// Every hinge sits at the FULL nominal `segmentLenMm` spacing; `closesLoop` (opt
// in, off by default) additionally pulls the outline's own far edge back by a
// single thicknessMm — NOT one per panel — so a strip meant to close into a loop
// (e.g. an N=4 tube) has its closing corner meet rather than overlap. An open
// strip has no such corner and needs no setback at all.
PartGraphSpec MakeStrip(int segments, double segmentLenMm, double widthMm,
                        double thicknessMm, double angleDeg, double radiusMm = 0.0,
                        double kFactor = 0.0, double hingeTiltDeg = 0.0,
                        double hingeYOffsetMm = 0.0,
                        Transform3 anchor = Transform3::Identity(),
                        bool closesLoop = false) {
  PartGraphSpec graph;
  graph.partId = "test-part";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = anchor;

  double ba = TestBendAllowanceMm(angleDeg, radiusMm, kFactor, thicknessMm);
  int bendCount = segments - 1;
  double totalLen = segments * segmentLenMm + bendCount * ba - (closesLoop ? thicknessMm : 0.0);

  // Outline AND every hinge share a single tilted (F, W) basis — F/W are
  // orthonormal, so this is a rigid rotation of the whole strip by
  // hingeTiltDeg, not a shear into a parallelogram.
  double tiltRad = hingeTiltDeg * kTestPi / 180.0;
  Point2 F{std::cos(tiltRad), -std::sin(tiltRad)};
  Point2 W{std::sin(tiltRad), std::cos(tiltRad)};
  auto Along = [&](double f, double w) -> Point2 {
    return {f * F.x + w * W.x, f * F.y + w * W.y};
  };

  graph.outline.outer = {Along(0, 0), Along(totalLen, 0), Along(totalLen, widthMm),
                          Along(0, widthMm)};

  double halfSpan = widthMm / 2.0 + std::fabs(hingeYOffsetMm) + widthMm;

  for (int i = 0; i < bendCount; ++i) {
    double hx = (i + 1) * segmentLenMm + (i + 0.5) * ba;
    Point2 mid = Along(hx, widthMm / 2.0 + hingeYOffsetMm);
    BendSpec bend;
    bend.id = "bend" + std::to_string(i);
    bend.parentRegionPanelId = "seg" + std::to_string(i);
    bend.childRegionPanelId = "seg" + std::to_string(i + 1);
    bend.hingeA = {mid.x + W.x * halfSpan, mid.y + W.y * halfSpan};
    bend.hingeB = {mid.x - W.x * halfSpan, mid.y - W.y * halfSpan};
    bend.angleDeg = angleDeg;
    bend.radiusMm = radiusMm;
    bend.kFactor = kFactor;
    graph.bends.push_back(bend);
  }
  return graph;
}

// A fixed (deterministic, reproducible — not a runtime RNG) rotation that involves
// all three axes at deliberately unround angles, plus a translation offset. Used to
// catch hidden axis-alignment bias: every geometric quantity this module computes
// (volume, validity, manifoldness) must be identical whether the part sits at the
// identity anchor or tumbled arbitrarily away from every axis — nothing in the
// construction pipeline may implicitly assume X/Y/Z-aligned geometry.
Transform3 MakeTumbledAnchor() {
  Transform3 rx = Transform3::RotationAboutAxis({0, 0, 0}, {1, 0, 0}, 23.0);
  Transform3 ry = Transform3::RotationAboutAxis({0, 0, 0}, {0, 1, 0}, 41.0);
  Transform3 rz = Transform3::RotationAboutAxis({0, 0, 0}, {0, 0, 1}, 67.0);
  Transform3 rotation = rz.Compose(ry.Compose(rx));
  Transform3 translation = Transform3::Translation(1234.5, -678.9, 42.0);
  return translation.Compose(rotation);
}

double SolidVolume(const TopoDS_Shape& shape) {
  GProp_GProps props;
  BRepGProp::VolumeProperties(shape, props);
  return props.Mass();
}

int CountSolids(const TopoDS_Shape& shape) {
  int count = 0;
  for (TopExp_Explorer exp(shape, TopAbs_SOLID); exp.More(); exp.Next()) ++count;
  return count;
}

}  // namespace

TEST_CASE("ConstructPartSolid: single flat panel produces one valid manifold solid",
          "[translation][construction]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, graph.thicknessMm);
  REQUIRE(result.ok);
  REQUIRE_FALSE(result.shellId.empty());

  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());
  BRepCheck_Analyzer analyzer(it->second.shape);
  CHECK(analyzer.IsValid());
  CHECK(SolidVolume(it->second.shape) == Approx(100.0 * 60.0 * 2.0).epsilon(0.01));
}

TEST_CASE("ConstructPartSolid: a panel with a circular hole and a polygon hole has "
          "correctly reduced volume",
          "[translation][construction][holes]") {
  PartGraphSpec graph;
  graph.partId = "with-holes";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.outline.circleHoles.push_back({/*center=*/{20.0, 30.0}, /*radiusMm=*/5.0});
  // CW winding (opposite the outer ring's CCW) — holes are stored CW, per
  // this codebase's own canonical convention (PreparePolygonCut/cut_panel.cc
  // canonicalizes to this automatically; this test authors it directly).
  graph.outline.polygonHoles.push_back({{60, 20}, {60, 30}, {70, 30}, {70, 20}});
  graph.thicknessMm = 2.0;

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);
  REQUIRE(layout.panels.size() == 1);
  CHECK(layout.panels[0].regionCircleHoles.size() == 1);
  CHECK(layout.panels[0].regionPolygonHoles.size() == 1);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, graph.thicknessMm);
  REQUIRE(result.ok);

  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());
  BRepCheck_Analyzer analyzer(it->second.shape);
  CHECK(analyzer.IsValid());

  // Full panel (100x60x2) minus the circular hole (pi*5^2 area) and the
  // 10x10 polygon hole, each times thickness — a real oracle (not bbox),
  // matching 09's O1-O4 standard.
  constexpr double kPi = 3.14159265358979323846;
  double circleAreaMm2 = kPi * 5.0 * 5.0;
  double polygonAreaMm2 = 10.0 * 10.0;
  double expectedVolume = (100.0 * 60.0 - circleAreaMm2 - polygonAreaMm2) * 2.0;
  CHECK(SolidVolume(it->second.shape) == Approx(expectedVolume).epsilon(0.001));
}

// A genuinely sharp (zero-radius) fold does not keep BOTH surfaces continuous across
// the hinge: the inside (bottomFace) stays exactly continuous by construction, but
// the outside (topFace) either overlaps ("mountain" folds, like this one) or leaves a
// small wedge-shaped void ("valley" folds) — a real consequence of the idealization,
// not a defect (see part_solid_construction.cc's header comment). A boolean fuse
// resolves the overlap case by removing the double-counted volume, so the true volume
// is somewhat LESS than the naive per-panel sum — never more. These tests assert that
// physically-grounded bound instead of a naive exact-sum equality.
TEST_CASE("ConstructPartSolid: N=4 square tube (mountain/up fold) is one manifold "
          "solid, volume bounded below the naive sum",
          "[translation][construction]") {
  auto graph = MakeStrip(4, 100.0, 50.0, 2.0, 90.0, 0.0, 0.0, 0.0, 0.0, Transform3::Identity(),
                         /*closesLoop=*/true);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, graph.thicknessMm);
  REQUIRE(result.ok);

  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());

  BRepCheck_Analyzer analyzer(it->second.shape);
  CHECK(analyzer.IsValid());
  CHECK(CountSolids(it->second.shape) == 1);

  // 4 panels x ((segmentLenMm - thicknessMm) x widthMm) x thicknessMm — see
  // MakeStrip's own comment on the inside-corner thickness setback.
  double naiveSum = 4 * (100.0 - 2.0) * 50.0 * 2.0;
  // Upper bound on total volume fuse removes at the 3 internal hinges: each one
  // has BOTH a panel/panel overlap (the panels' own top surfaces still meet past
  // the hinge at a sharp/near-zero radius) AND a panel/bridge overlap (the
  // bridge's own swept wedge partially re-covers already-included panel
  // material) — empirically characterized (not re-derived analytically here) at
  // radiusMm=0, with a 2x safety margin.
  double maxOverlap = 3 * 2.0 * (2.0 * 2.0 * 50.0 * 2.0);
  double volume = SolidVolume(it->second.shape);
  CHECK(volume <= naiveSum + 1e-6);  // fuse must never ADD material — a hard invariant
  CHECK(volume >= naiveSum - maxOverlap);
}

TEST_CASE("ConstructPartSolid: N=4 square tube (valley/down fold) is one manifold "
          "solid, with EXACTLY the same volume as the mountain/up fold",
          "[translation][construction]") {
  // The old "sharp fold" model had no real bridge material, so a valley fold's
  // outer (bottom) surface only touched its neighbour along a 1D edge — nothing
  // for boolean fuse to merge on, reported as the typed GE_SHARP_FOLD_GAP error.
  // That gap is now closed for real: the bottom-surface radius r_b is never
  // exactly zero for a valley fold (r_b = radiusMm + thicknessMm, see
  // manufacturing_graph_evaluator.hpp), so a real, non-degenerate bridge solid
  // always exists there, sharing a coincident face with each neighbouring panel.
  //
  // At radiusMm=0 (this test), the flat pattern's zone width (BA) is exactly
  // zero, so neither panel is clipped at all — panel AND bridge material overlap
  // directly at the hinge, exactly as they do in the mountain case, and fuse
  // resolves it the same way. A real physical square tube is one unambiguous
  // object regardless of which direction you happen to call "mountain" versus
  // "valley" — so its volume must come out EXACTLY the same either way, not just
  // within some approximate bound. This is a strong, self-checking oracle: if it
  // ever fails while the mountain test still passes, the two fold directions have
  // diverged, which is a real bug (an asymmetry constitution v2.0.0 principle III
  // would not allow — one geometric model, not two).
  auto graphMountain = MakeStrip(4, 100.0, 50.0, 2.0, 90.0, 0.0, 0.0, 0.0, 0.0,
                                 Transform3::Identity(), /*closesLoop=*/true);
  auto graphValley = MakeStrip(4, 100.0, 50.0, 2.0, -90.0, 0.0, 0.0, 0.0, 0.0,
                               Transform3::Identity(), /*closesLoop=*/true);

  EvaluateResult layoutMountain = Evaluate(graphMountain);
  EvaluateResult layoutValley = Evaluate(graphValley);
  REQUIRE(layoutMountain.ok);
  REQUIRE(layoutValley.ok);

  GeometryState stateMountain, stateValley;
  ConstructPartSolidResult resultMountain =
      ConstructPartSolid(stateMountain, layoutMountain, graphMountain.thicknessMm);
  ConstructPartSolidResult resultValley =
      ConstructPartSolid(stateValley, layoutValley, graphValley.thicknessMm);
  REQUIRE(resultMountain.ok);
  REQUIRE(resultValley.ok);

  auto itMountain = stateMountain.solids.find(resultMountain.shellId);
  auto itValley = stateValley.solids.find(resultValley.shellId);
  REQUIRE(itMountain != stateMountain.solids.end());
  REQUIRE(itValley != stateValley.solids.end());

  BRepCheck_Analyzer analyzerValley(itValley->second.shape);
  CHECK(analyzerValley.IsValid());
  CHECK(CountSolids(itValley->second.shape) == 1);

  double volumeMountain = SolidVolume(itMountain->second.shape);
  double volumeValley = SolidVolume(itValley->second.shape);
  CHECK(volumeValley == Approx(volumeMountain).epsilon(1e-6));
}

TEST_CASE("ConstructPartSolid: N=4 square tube with a REAL (nonzero) bend radius and "
          "K-factor is one manifold solid, mountain and valley volumes match exactly",
          "[translation][construction]") {
  // Same oracle as the radiusMm=0 case above, but this is the one that actually
  // exercises real bend physics end-to-end (bend allowance clipping a genuine
  // nonzero-width zone, a bridge solid with real curvature, not a degenerate
  // wedge) — the whole point of this slice's rebuild away from the sharp-fold
  // idealization.
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graphMountain = MakeStrip(4, 100.0, 50.0, thicknessMm, 90.0, radiusMm, kFactor, 0.0, 0.0,
                                 Transform3::Identity(), /*closesLoop=*/true);
  auto graphValley = MakeStrip(4, 100.0, 50.0, thicknessMm, -90.0, radiusMm, kFactor, 0.0, 0.0,
                               Transform3::Identity(), /*closesLoop=*/true);

  EvaluateResult layoutMountain = Evaluate(graphMountain);
  EvaluateResult layoutValley = Evaluate(graphValley);
  REQUIRE(layoutMountain.ok);
  REQUIRE(layoutValley.ok);

  GeometryState stateMountain, stateValley;
  ConstructPartSolidResult resultMountain =
      ConstructPartSolid(stateMountain, layoutMountain, thicknessMm);
  ConstructPartSolidResult resultValley =
      ConstructPartSolid(stateValley, layoutValley, thicknessMm);
  REQUIRE(resultMountain.ok);
  REQUIRE(resultValley.ok);

  auto itMountain = stateMountain.solids.find(resultMountain.shellId);
  auto itValley = stateValley.solids.find(resultValley.shellId);
  REQUIRE(itMountain != stateMountain.solids.end());
  REQUIRE(itValley != stateValley.solids.end());

  BRepCheck_Analyzer analyzerMountain(itMountain->second.shape);
  BRepCheck_Analyzer analyzerValley(itValley->second.shape);
  CHECK(analyzerMountain.IsValid());
  CHECK(analyzerValley.IsValid());
  CHECK(CountSolids(itMountain->second.shape) == 1);
  CHECK(CountSolids(itValley->second.shape) == 1);

  double volumeMountain = SolidVolume(itMountain->second.shape);
  double volumeValley = SolidVolume(itValley->second.shape);
  CHECK(volumeValley == Approx(volumeMountain).epsilon(1e-6));
}

TEST_CASE("ConstructPartSolid: N=5 pentagon tube (real bend radius) is one manifold "
          "solid, mountain and valley volumes match exactly",
          "[translation][construction]") {
  // Same oracle as the N=4 square tube above, extended to a non-90-degree
  // closing angle (72 degrees x 5 = 360) — confirms the closesLoop setback and
  // bridge construction generalize beyond a right-angle corner.
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graphMountain = MakeStrip(5, 80.0, 50.0, thicknessMm, 72.0, radiusMm, kFactor, 0.0, 0.0,
                                 Transform3::Identity(), /*closesLoop=*/true);
  auto graphValley = MakeStrip(5, 80.0, 50.0, thicknessMm, -72.0, radiusMm, kFactor, 0.0, 0.0,
                               Transform3::Identity(), /*closesLoop=*/true);

  EvaluateResult layoutMountain = Evaluate(graphMountain);
  EvaluateResult layoutValley = Evaluate(graphValley);
  REQUIRE(layoutMountain.ok);
  REQUIRE(layoutValley.ok);

  GeometryState stateMountain, stateValley;
  ConstructPartSolidResult resultMountain =
      ConstructPartSolid(stateMountain, layoutMountain, thicknessMm);
  ConstructPartSolidResult resultValley =
      ConstructPartSolid(stateValley, layoutValley, thicknessMm);
  REQUIRE(resultMountain.ok);
  REQUIRE(resultValley.ok);

  auto itMountain = stateMountain.solids.find(resultMountain.shellId);
  auto itValley = stateValley.solids.find(resultValley.shellId);
  REQUIRE(itMountain != stateMountain.solids.end());
  REQUIRE(itValley != stateValley.solids.end());

  BRepCheck_Analyzer analyzerMountain(itMountain->second.shape);
  BRepCheck_Analyzer analyzerValley(itValley->second.shape);
  CHECK(analyzerMountain.IsValid());
  CHECK(analyzerValley.IsValid());
  CHECK(CountSolids(itMountain->second.shape) == 1);
  CHECK(CountSolids(itValley->second.shape) == 1);

  double volumeMountain = SolidVolume(itMountain->second.shape);
  double volumeValley = SolidVolume(itValley->second.shape);
  CHECK(volumeValley == Approx(volumeMountain).epsilon(1e-6));
}

TEST_CASE("ConstructPartSolid: N=6 hexagon tube (real bend radius) is one manifold "
          "solid, mountain and valley volumes match exactly",
          "[translation][construction]") {
  // Same oracle again at 60-degree corners (6 x 60 = 360).
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graphMountain = MakeStrip(6, 70.0, 50.0, thicknessMm, 60.0, radiusMm, kFactor, 0.0, 0.0,
                                 Transform3::Identity(), /*closesLoop=*/true);
  auto graphValley = MakeStrip(6, 70.0, 50.0, thicknessMm, -60.0, radiusMm, kFactor, 0.0, 0.0,
                               Transform3::Identity(), /*closesLoop=*/true);

  EvaluateResult layoutMountain = Evaluate(graphMountain);
  EvaluateResult layoutValley = Evaluate(graphValley);
  REQUIRE(layoutMountain.ok);
  REQUIRE(layoutValley.ok);

  GeometryState stateMountain, stateValley;
  ConstructPartSolidResult resultMountain =
      ConstructPartSolid(stateMountain, layoutMountain, thicknessMm);
  ConstructPartSolidResult resultValley =
      ConstructPartSolid(stateValley, layoutValley, thicknessMm);
  REQUIRE(resultMountain.ok);
  REQUIRE(resultValley.ok);

  auto itMountain = stateMountain.solids.find(resultMountain.shellId);
  auto itValley = stateValley.solids.find(resultValley.shellId);
  REQUIRE(itMountain != stateMountain.solids.end());
  REQUIRE(itValley != stateValley.solids.end());

  BRepCheck_Analyzer analyzerMountain(itMountain->second.shape);
  BRepCheck_Analyzer analyzerValley(itValley->second.shape);
  CHECK(analyzerMountain.IsValid());
  CHECK(analyzerValley.IsValid());
  CHECK(CountSolids(itMountain->second.shape) == 1);
  CHECK(CountSolids(itValley->second.shape) == 1);

  double volumeMountain = SolidVolume(itMountain->second.shape);
  double volumeValley = SolidVolume(itValley->second.shape);
  CHECK(volumeValley == Approx(volumeMountain).epsilon(1e-6));
}

TEST_CASE("ConstructPartSolid: result is invariant under an arbitrary non-axis-aligned "
          "root anchor (no hidden axis bias)",
          "[translation][construction]") {
  Transform3 tumbled = MakeTumbledAnchor();

  auto graphIdentity = MakeStrip(4, 100.0, 50.0, 2.0, 90.0, 0.0, 0.0, 0.0, 0.0,
                                 Transform3::Identity(), /*closesLoop=*/true);
  auto graphTumbled =
      MakeStrip(4, 100.0, 50.0, 2.0, 90.0, 0.0, 0.0, 0.0, 0.0, tumbled, /*closesLoop=*/true);

  EvaluateResult layoutIdentity = Evaluate(graphIdentity);
  EvaluateResult layoutTumbled = Evaluate(graphTumbled);
  REQUIRE(layoutIdentity.ok);
  REQUIRE(layoutTumbled.ok);

  GeometryState stateIdentity, stateTumbled;
  ConstructPartSolidResult resultIdentity =
      ConstructPartSolid(stateIdentity, layoutIdentity, graphIdentity.thicknessMm);
  ConstructPartSolidResult resultTumbled =
      ConstructPartSolid(stateTumbled, layoutTumbled, graphTumbled.thicknessMm);
  REQUIRE(resultIdentity.ok);
  REQUIRE(resultTumbled.ok);

  auto itIdentity = stateIdentity.solids.find(resultIdentity.shellId);
  auto itTumbled = stateTumbled.solids.find(resultTumbled.shellId);
  REQUIRE(itIdentity != stateIdentity.solids.end());
  REQUIRE(itTumbled != stateTumbled.solids.end());

  BRepCheck_Analyzer analyzerTumbled(itTumbled->second.shape);
  CHECK(analyzerTumbled.IsValid());
  CHECK(CountSolids(itTumbled->second.shape) == 1);

  // Volume is exactly invariant under any rigid transform (rotation + translation) —
  // a self-checking oracle that needs no hand-derived expected value. If this fails
  // while the identity case passes, the construction pipeline has an axis-alignment
  // bug (e.g. an accidental use of a world-frame axis instead of the panel's own
  // local/transformed frame somewhere).
  double volumeIdentity = SolidVolume(itIdentity->second.shape);
  double volumeTumbled = SolidVolume(itTumbled->second.shape);
  CHECK(volumeTumbled == Approx(volumeIdentity).epsilon(1e-6));
}

// ─── Fold-tree nets: branching + perpendicular fold lines ───────────────────
//
// Slice 2 (rebuild/06-plan.md's phased build order): every prior test above is a
// LINEAR chain of PARALLEL fold lines (MakeStrip). This is the first test of a
// genuine fold TREE (one region panel — F1 — has three children: F2, L, R) with
// PERPENDICULAR fold lines (F1's own four bounding edges are two pairs of
// mutually-perpendicular hinges) — closing into a Latin-cross cube net
// (rebuild/suite/cases/T3/net_cross_cube.json, Paul's anchor case for 08 §3.2).
//
// This test is the direct-C++ reproduction (zero NAPI/TS in the path) that found
// and confirmed a real bug in ClipHalfPlane: a region bounded by only ONE
// touching bend (F0, whose only bend is F0-F1) was clipping to a degenerate
// polygon that bridged out to its SIBLINGS' (L/R's) far corners — because those
// siblings' own base edges happen to graze F0's clip line (y=50) without ever
// crossing it, and the inclusive `>= -eps` boundary test in IsInside treated
// those grazing touch-points as "inside," connecting them directly. Every
// previous linear-chain test only ever clipped simple rectangles with clean
// crossings, so this never surfaced before. Fixed by making IsInside strict at
// the boundary (see its own comment in manufacturing_graph_evaluator.cc) — the
// ENTER/EXIT transition logic still exactly reconstructs genuine boundary edges
// regardless of length, so this did not regress any linear-chain case (full
// suite re-run confirmed 0 regressions before this test was added).
namespace {

double Dist3(const Point3& a, const Point3& b) {
  return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) +
                    (a.z - b.z) * (a.z - b.z));
}

// Latin-cross cube net: F0 (root, bottom) -> F1 (front) -> F2 (top) -> F3 (back),
// with F1 also branching to L (left) and R (right). Grid coords x faceSizeMm,
// matching rebuild/suite/cases/T3/net_cross_cube.json's own "faces" layout
// exactly (F0=[0,0], F1=[0,1], F2=[0,2], F3=[0,3], L=[-1,1], R=[1,1]).
//
// Hinge point order was calibrated empirically against a throwaway NAPI probe
// before being trusted here: all 5 folds are "mountain" (angleDeg=+90, the
// zero-pivot-offset case at r=0 — see the sharp-fold closure investigation
// test above), but L's and R's own hinge endpoint order must be MIRRORED
// relative to each other (not just F0-F1/F1-F2/F2-F3's shared convention)
// since they sit on opposite sides of their shared parent F1 — confirmed by
// this test's own exact (0mm) seam closure below.
PartGraphSpec MakeCrossCubeNet(double faceSizeMm, double thicknessMm) {
  double s = faceSizeMm;
  PartGraphSpec graph;
  graph.partId = "cross-cube";
  graph.rootRegionPanelId = "F0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {
      {0, 0},    {s, 0},      {s, s},     {2 * s, s},  {2 * s, 2 * s}, {s, 2 * s},
      {s, 3 * s}, {s, 4 * s}, {0, 4 * s}, {0, 3 * s},  {0, 2 * s},
      {-s, 2 * s}, {-s, s},   {0, s},
  };

  auto MakeBend = [&](const std::string& id, const std::string& parent,
                       const std::string& child, Point2 hingeA, Point2 hingeB) {
    BendSpec bend;
    bend.id = id;
    bend.parentRegionPanelId = parent;
    bend.childRegionPanelId = child;
    bend.hingeA = hingeA;
    bend.hingeB = hingeB;
    bend.angleDeg = 90.0;
    bend.radiusMm = 0.0;
    bend.kFactor = 0.0;
    return bend;
  };

  graph.bends = {
      MakeBend("b01", "F0", "F1", {0, s}, {s, s}),
      MakeBend("b12", "F1", "F2", {0, 2 * s}, {s, 2 * s}),
      MakeBend("b23", "F2", "F3", {0, 3 * s}, {s, 3 * s}),
      MakeBend("b1L", "F1", "L", {0, s}, {0, 2 * s}),
      MakeBend("b1R", "F1", "R", {s, 2 * s}, {s, s}),  // mirrored order vs b1L
  };
  return graph;
}

}  // namespace

TEST_CASE("GraphEvaluator: Latin-cross cube net (branching + perpendicular "
          "folds) closes at all 7 seams exactly",
          "[translation][closure][net]") {
  double faceSizeMm = 50.0, thicknessMm = 1.0;
  auto graph = MakeCrossCubeNet(faceSizeMm, thicknessMm);
  EvaluateResult result = Evaluate(graph);
  REQUIRE(result.ok);
  REQUIRE(result.panels.size() == 6);

  std::map<std::string, const RegionPanelLayout*> byId;
  for (auto& p : result.panels) byId[p.regionPanelId] = &p;

  double s = faceSizeMm;
  // Each named edge, in the shared flat frame (face:cardinal per schema.md's
  // net encoding), at the mountain-fold zero-offset pivot height (z=0).
  auto edge = [&](const std::string& face, double x0, double y0, double x1,
                   double y1) {
    return std::make_pair(byId.at(face), std::make_pair(Point3{x0, y0, 0},
                                                          Point3{x1, y1, 0}));
  };
  std::vector<std::pair<decltype(edge("", 0, 0, 0, 0)), decltype(edge("", 0, 0, 0, 0))>>
      seams = {
          {edge("F3", 0, 4 * s, s, 4 * s), edge("F0", 0, 0, s, 0)},          // F3:N vs F0:S
          {edge("L", -s, s, 0, s), edge("F0", 0, 0, 0, s)},                  // L:S vs F0:W
          {edge("R", s, s, 2 * s, s), edge("F0", s, 0, s, s)},               // R:S vs F0:E
          {edge("L", -s, 2 * s, 0, 2 * s), edge("F2", 0, 2 * s, 0, 3 * s)},  // L:N vs F2:W
          {edge("R", s, 2 * s, 2 * s, 2 * s), edge("F2", s, 2 * s, s, 3 * s)},  // R:N vs F2:E
          {edge("L", -s, s, -s, 2 * s), edge("F3", 0, 3 * s, 0, 4 * s)},     // L:W vs F3:W
          {edge("R", 2 * s, s, 2 * s, 2 * s), edge("F3", s, 3 * s, s, 4 * s)},  // R:E vs F3:E
      };

  double worst = 0.0;
  for (auto& [e1, e2] : seams) {
    Point3 w1a = e1.first->pose.Apply(e1.second.first);
    Point3 w1b = e1.first->pose.Apply(e1.second.second);
    Point3 w2a = e2.first->pose.Apply(e2.second.first);
    Point3 w2b = e2.first->pose.Apply(e2.second.second);
    double dSame = std::max(Dist3(w1a, w2a), Dist3(w1b, w2b));
    double dSwap = std::max(Dist3(w1a, w2b), Dist3(w1b, w2a));
    worst = std::max(worst, std::min(dSame, dSwap));
  }
  CHECK(worst < 1e-6);
}

TEST_CASE("ConstructPartSolid: Latin-cross cube net builds one manifold cube",
          "[translation][construction][net]") {
  double faceSizeMm = 50.0, thicknessMm = 1.0;
  auto graph = MakeCrossCubeNet(faceSizeMm, thicknessMm);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, thicknessMm);
  REQUIRE(result.ok);
  REQUIRE_FALSE(result.shellId.empty());

  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());
  BRepCheck_Analyzer analyzer(it->second.shape);
  CHECK(analyzer.IsValid());
  CHECK(CountSolids(it->second.shape) == 1);

  // A closed 50mm cube shell of 1mm sheet: volume must be well below the
  // naive per-face sum (6 * 50 * 50 * 1 = 15000, same "mountain overlap"
  // bound as the tube tests above) and comfortably above a degenerate sliver.
  double volume = SolidVolume(it->second.shape);
  CHECK(volume < 15000.0);
  CHECK(volume > 10000.0);
}

// ─── Branching (multi-child parent) + real bend radius ──────────────────────
//
// docs/BUG_REPORT_nonzero_default_bend_radius_breaks_mesh_construction.md: a
// root panel that is parent to MORE THAN ONE bend (e.g. a tray's base folding
// up into 4 walls — testcube.step's own real topology) failed construction
// with "N disconnected solid(s)" as soon as any of those bends had a real
// (nonzero) radius. Every prior nonzero-radius test in this file (the N=4/5/6
// tube tests above) is a LINEAR CHAIN — each panel parent to at most one
// bend — which never exercised this: the childShift correction that lands
// each bend's far end exactly on its child lives on the CHILD's own pose, but
// a panel can be parent to several bends at once, so a single pose-level
// correction can't cover all of them — only a per-bridge correction (the
// collar solid in part_solid_construction.cc) can. This is the test that
// would have caught the bug before it shipped.
namespace {

// A rectangular base panel with up to 4 walls, one per edge, each attached by
// its own bend with a real (possibly nonzero) radius/K-factor. Hinges overhang
// their edge slightly (matching MakeStrip's own convention) so this also
// guards against assuming a hinge's raw endpoints line up 1:1 with the panel
// edge they bound — the actual bug this test's fix required (the bridge's
// parent-side tangent line must be derived from the panel's own clipped edge
// shifted by the bend-allowance offset, never from the hinge's own raw,
// deliberately-longer endpoints).
PartGraphSpec MakeTray(double widthMm, double heightMm, double thicknessMm, double angleDeg,
                       double radiusMm, double kFactor, int wallCount = 4) {
  PartGraphSpec graph;
  graph.partId = "test-tray";
  graph.rootRegionPanelId = "base";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();

  // The whole part is ONE shared flat blank (13 §0's F-frame) — every panel is
  // a region of THIS SAME outline, never its own separate shape. A tray's
  // base-plus-4-walls blank is a plus/cross shape: the base rectangle plus one
  // wall-depth-tall flap on each edge (flat corners, no miter/relief — this
  // fixture only needs a valid clip region per wall, not a manufacturable
  // closed box), CCW per RingSpec::outer's own convention.
  double d = widthMm < heightMm ? widthMm / 4.0 : heightMm / 4.0;  // wall depth
  double w = widthMm, h = heightMm;
  graph.outline.outer = {
      {0, -d},     {w, -d},     {w, 0},      {w + d, 0},  {w + d, h},
      {w, h},      {w, h + d},  {0, h + d},  {0, h},      {-d, h},
      {-d, 0},     {0, 0},
  };

  double overhang = 10.0;
  struct WallSpec {
    std::string id;
    Point2 hingeA;
    Point2 hingeB;
  };
  // hingeA->hingeB chosen (per BoundingBends' fixed "child = left side"
  // convention) so each wall's child territory is OUTWARD from the base.
  std::vector<WallSpec> walls = {
      {"south", {widthMm + overhang, 0.0}, {-overhang, 0.0}},
      {"east", {widthMm, heightMm + overhang}, {widthMm, -overhang}},
      {"north", {-overhang, heightMm}, {widthMm + overhang, heightMm}},
      {"west", {0.0, -overhang}, {0.0, heightMm + overhang}},
  };

  for (int i = 0; i < wallCount; ++i) {
    BendSpec bend;
    bend.id = "bend-" + walls[i].id;
    bend.parentRegionPanelId = "base";
    bend.childRegionPanelId = "wall-" + walls[i].id;
    bend.hingeA = walls[i].hingeA;
    bend.hingeB = walls[i].hingeB;
    bend.angleDeg = angleDeg;
    bend.radiusMm = radiusMm;
    bend.kFactor = kFactor;
    graph.bends.push_back(bend);
  }
  return graph;
}

}  // namespace

TEST_CASE("ConstructPartSolid: a tray base branching into 4 walls with a REAL bend "
          "radius is one manifold solid per fold direction",
          "[translation][construction][net]") {
  double radiusMm = 1.5, kFactor = 0.4, thicknessMm = 2.0;
  auto graphMountain = MakeTray(100.0, 80.0, thicknessMm, 90.0, radiusMm, kFactor);
  auto graphValley = MakeTray(100.0, 80.0, thicknessMm, -90.0, radiusMm, kFactor);

  EvaluateResult layoutMountain = Evaluate(graphMountain);
  EvaluateResult layoutValley = Evaluate(graphValley);
  REQUIRE(layoutMountain.ok);
  REQUIRE(layoutValley.ok);
  REQUIRE(layoutMountain.panels.size() == 5);  // base + 4 walls

  GeometryState stateMountain, stateValley;
  ConstructPartSolidResult resultMountain =
      ConstructPartSolid(stateMountain, layoutMountain, thicknessMm);
  ConstructPartSolidResult resultValley = ConstructPartSolid(stateValley, layoutValley, thicknessMm);
  REQUIRE(resultMountain.ok);
  REQUIRE(resultValley.ok);

  auto itMountain = stateMountain.solids.find(resultMountain.shellId);
  auto itValley = stateValley.solids.find(resultValley.shellId);
  REQUIRE(itMountain != stateMountain.solids.end());
  REQUIRE(itValley != stateValley.solids.end());

  BRepCheck_Analyzer analyzerMountain(itMountain->second.shape);
  BRepCheck_Analyzer analyzerValley(itValley->second.shape);
  CHECK(analyzerMountain.IsValid());
  CHECK(analyzerValley.IsValid());
  CHECK(CountSolids(itMountain->second.shape) == 1);
  CHECK(CountSolids(itValley->second.shape) == 1);

  // Same symmetry oracle as this file's other mountain/valley pairs: a real
  // physical tray's volume can't depend on which direction is labelled
  // "mountain" vs "valley".
  double volumeMountain = SolidVolume(itMountain->second.shape);
  double volumeValley = SolidVolume(itValley->second.shape);
  CHECK(volumeValley == Approx(volumeMountain).epsilon(1e-6));
}

TEST_CASE("ConstructPartSolid: a tray base branching into 4 walls at radiusMm=0 "
          "still builds one manifold solid (regression guard)",
          "[translation][construction][net]") {
  double thicknessMm = 2.0;
  auto graph = MakeTray(100.0, 80.0, thicknessMm, 90.0, 0.0, 0.0);
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, thicknessMm);
  REQUIRE(result.ok);

  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());
  BRepCheck_Analyzer analyzer(it->second.shape);
  CHECK(analyzer.IsValid());
  CHECK(CountSolids(it->second.shape) == 1);
}

TEST_CASE("ConstructPartSolid: rejects a failed layout", "[translation][construction][errors]") {
  EvaluateResult layout;
  layout.ok = false;
  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, 2.0);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == "GE_INVALID_LAYOUT");
}

TEST_CASE("ConstructPartSolid: rejects non-positive thickness",
          "[translation][construction][errors]") {
  PartGraphSpec graph;
  graph.partId = "single";
  graph.rootRegionPanelId = "only";
  graph.outline.outer = {{0, 0}, {100, 0}, {100, 60}, {0, 60}};
  graph.thicknessMm = 2.0;
  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, 0.0);
  REQUIRE_FALSE(result.ok);
  CHECK(result.errorCode == "GE_INVALID_SHEET_METAL");
}

// Phase 5 Slice 4 investigation (merge_bodies_with_bend's own volume check
// found this and needed to confirm it wasn't a merge-specific defect):
// directly measures the boolean overlap between the two panel prisms of an
// asymmetric-length, sharp (r=0) N=2 mountain fold, and asserts it EXACTLY
// equals the naive-sum-vs-fused-volume shortfall — the strongest possible
// confirmation that "volume short of the naive flat-area sum" is this
// file's own documented panel/panel outer-corner overlap phenomenon (see
// the N=4 square tube test's comment above), not a distinct defect. Kept
// as a permanent regression: if this ever stops matching, the overlap
// mechanism itself has changed, which every other test here only bounds,
// never explains directly.
TEST_CASE("ConstructPartSolid: N=2 asymmetric sharp mountain fold — measured panel/panel "
          "overlap exactly accounts for the naive-sum shortfall",
          "[translation][construction]") {
  double widthMm = 5.0, thicknessMm = 1.0;
  double seg0Len = 8.115044407846124, seg1Len = 6.115044407846124;
  double totalLen = seg0Len + seg1Len; // BA=0 at r=0,k=0

  PartGraphSpec graph;
  graph.partId = "diag";
  graph.rootRegionPanelId = "seg0";
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = Transform3::Identity();
  graph.outline.outer = {{0, 0}, {totalLen, 0}, {totalLen, widthMm}, {0, widthMm}};

  BendSpec bend;
  bend.id = "bend0";
  bend.parentRegionPanelId = "seg0";
  bend.childRegionPanelId = "seg1";
  bend.hingeA = {seg0Len, widthMm};
  bend.hingeB = {seg0Len, 0};
  bend.angleDeg = 90.0;
  bend.radiusMm = 0.0;
  bend.kFactor = 0.0;
  graph.bends.push_back(bend);

  EvaluateResult layout = Evaluate(graph);
  REQUIRE(layout.ok);

  GeometryState state;
  ConstructPartSolidResult result = ConstructPartSolid(state, layout, thicknessMm);
  REQUIRE(result.ok);
  auto it = state.solids.find(result.shellId);
  REQUIRE(it != state.solids.end());
  double fusedVolume = SolidVolume(it->second.shape);

  double naiveSum = totalLen * widthMm * thicknessMm;
  double shortfall = naiveSum - fusedVolume;

  // Independently build the two panel prisms exactly as ConstructPartSolid
  // does (polygon -> face -> prism -> place by pose), then measure their
  // pairwise boolean Common() volume directly — no dependency on
  // ConstructPartSolid's own internal bookkeeping.
  std::unordered_map<std::string, TopoDS_Shape> panelSolidById;
  for (const auto& panel : layout.panels) {
    BRepBuilderAPI_MakePolygon polyMaker;
    for (const auto& v : panel.regionOuter) polyMaker.Add(gp_Pnt(v.x, v.y, 0.0));
    polyMaker.Close();
    BRepBuilderAPI_MakeFace faceMaker(polyMaker.Wire());
    BRepPrimAPI_MakePrism prism(faceMaker.Face(), gp_Vec(0.0, 0.0, thicknessMm), true);
    gp_Trsf trsf;
    trsf.SetValues(panel.pose.r[0], panel.pose.r[1], panel.pose.r[2], panel.pose.t[0],
                   panel.pose.r[3], panel.pose.r[4], panel.pose.r[5], panel.pose.t[1],
                   panel.pose.r[6], panel.pose.r[7], panel.pose.r[8], panel.pose.t[2]);
    BRepBuilderAPI_Transform placed(prism.Shape(), trsf, /*Copy=*/true);
    panelSolidById[panel.regionPanelId] = placed.Shape();
  }
  REQUIRE(panelSolidById.count("seg0") == 1);
  REQUIRE(panelSolidById.count("seg1") == 1);

  BRepAlgoAPI_Common common(panelSolidById["seg0"], panelSolidById["seg1"]);
  common.Build();
  REQUIRE(common.IsDone());
  double overlapVolume = SolidVolume(common.Shape());

  INFO("naiveSum=" << naiveSum << " fusedVolume=" << fusedVolume << " shortfall=" << shortfall
                    << " directly-measured panelA/panelB overlap=" << overlapVolume);
  CHECK(overlapVolume == Approx(shortfall).epsilon(0.01));
}
