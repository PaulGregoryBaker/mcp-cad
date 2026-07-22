#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/translation/part_solid_construction.hpp"
#include "geometry/geometry_service_impl.hpp"

#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>

#include <cmath>

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
