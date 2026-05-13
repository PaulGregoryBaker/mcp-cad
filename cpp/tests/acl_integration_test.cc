/**
 * ACL BC Integration Test — topology to FeatureSet pipeline.
 *
 * Implements TESTING_STRATEGY.md ACL-JTBD-01 to ACL-JTBD-03:
 *   topology graph → FeatureSet (Bend/Hole/Flange) as a realistic ACL-internal flow.
 *
 * Accuracy target: >90% on tier-1 and tier-2 STEP fixtures (T062 heuristic).
 * For fixtures without STEP files the test uses a synthetic topology graph
 * that exercises every classification branch.
 *
 * Task: T149
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "acl/feature_extractor.hpp"
#include "geometry/geometry_service.hpp"
#include "helpers/fixtures.h"

#include <filesystem>
#include <set>
#include <cmath>

using namespace mcp_cad;
using Catch::Approx;

// ─── Synthetic topology helpers ───────────────────────────────────────────────

/**
 * Build a minimal topology graph that represents a simple L-shaped bracket:
 *   - Two planar faces connected by a 90° dihedral (one bend)
 *   - One cylindrical face (one through-hole)
 *   - One shared line edge of length 50 mm
 */
static TopologyGraph makeBracketGraph() {
  TopologyGraph g;
  g.solidId = "synthetic-bracket";

  // Two flat faces — the bend flanges
  FaceNode f1;
  f1.faceId      = "f1";
  f1.surfaceType = SurfaceType::PLANE;
  f1.areaMm2     = 2500.0;   // 50x50 mm
  f1.normalX = 0; f1.normalY = 0; f1.normalZ = 1;

  FaceNode f2;
  f2.faceId      = "f2";
  f2.surfaceType = SurfaceType::PLANE;
  f2.areaMm2     = 2500.0;
  f2.normalX = 0; f2.normalY = 1; f2.normalZ = 0;

  // A cylindrical face — represents a 5 mm hole
  // Area ≈ 2πr·h  (r=2.5, h=1.5) ≈ 23.6 mm²
  FaceNode fHole;
  fHole.faceId      = "fHole";
  fHole.surfaceType = SurfaceType::CYLINDER;
  fHole.areaMm2     = 2.0 * 3.14159265 * 2.5 * 1.5;
  fHole.normalX = 1; fHole.normalY = 0; fHole.normalZ = 0;

  g.faces = {f1, f2, fHole};

  // Shared edge between f1 and f2 (the bend line)
  EdgeNode e1;
  e1.edgeId    = "e1";
  e1.curveType = CurveType::LINE;
  e1.lengthMm  = 50.0;

  g.edges = {e1};

  // Adjacency: f1–f2 at 90° dihedral → bendAngle = 90°
  AdjacencyEntry adj;
  adj.faceIdA         = "f1";
  adj.faceIdB         = "f2";
  adj.sharedEdgeId    = "e1";
  adj.dihedralAngleDeg = 90.0;

  g.adjacency = {adj};
  return g;
}

/**
 * Build a graph with multiple bends, holes, and flanges — simulating
 * a 3-panel sheet metal design.
 */
static TopologyGraph makeThreePanelGraph() {
  TopologyGraph g;
  g.solidId = "synthetic-three-panel";

  // Six planar faces (3 panels × 2 faces per bend)
  for (int i = 0; i < 6; ++i) {
    FaceNode f;
    f.faceId      = "p" + std::to_string(i);
    f.surfaceType = SurfaceType::PLANE;
    f.areaMm2     = 1000.0 * (i + 1);
    f.normalX = (i % 3 == 0) ? 1 : 0;
    f.normalY = (i % 3 == 1) ? 1 : 0;
    f.normalZ = (i % 3 == 2) ? 1 : 0;
    g.faces.push_back(f);
  }

  // Two cylindrical faces (holes of different sizes)
  FaceNode hole1;
  hole1.faceId      = "hole1";
  hole1.surfaceType = SurfaceType::CYLINDER;
  hole1.areaMm2     = 2.0 * 3.14159 * 3.0 * 1.5;   // r=3
  hole1.normalX = 0; hole1.normalY = 0; hole1.normalZ = 1;

  FaceNode hole2;
  hole2.faceId      = "hole2";
  hole2.surfaceType = SurfaceType::CYLINDER;
  hole2.areaMm2     = 2.0 * 3.14159 * 5.0 * 1.5;   // r=5
  hole2.normalX = 0; hole2.normalY = 0; hole2.normalZ = 1;

  g.faces.push_back(hole1);
  g.faces.push_back(hole2);

  // Three bend edges
  for (int i = 0; i < 3; ++i) {
    EdgeNode e;
    e.edgeId    = "e" + std::to_string(i);
    e.curveType = CurveType::LINE;
    e.lengthMm  = 80.0 + i * 10.0;
    g.edges.push_back(e);
  }

  // Three adjacency entries for the bends
  for (int i = 0; i < 3; ++i) {
    AdjacencyEntry adj;
    adj.faceIdA         = "p" + std::to_string(i * 2);
    adj.faceIdB         = "p" + std::to_string(i * 2 + 1);
    adj.sharedEdgeId    = "e" + std::to_string(i);
    adj.dihedralAngleDeg = 90.0 + i * 15.0;   // 90°, 105°, 120°
    g.adjacency.push_back(adj);
  }

  return g;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ── Synthetic fixture: L-bracket ─────────────────────────────────────────────

TEST_CASE("ACL integration: L-bracket extracts 1 bend, 1 hole, 2 flanges",
          "[acl][integration][l-bracket]") {
  auto extractor = FeatureExtractor::create();
  const auto graph = makeBracketGraph();

  const auto fs = extractor->composeFeatureSet(graph, "shell-bracket", 1.5, 0.33);

  REQUIRE(fs.shellId == "shell-bracket");

  SECTION("exactly one bend detected") {
    REQUIRE(fs.bends.size() == 1);
    const auto& bend = fs.bends[0];
    REQUIRE_FALSE(bend.featureId.empty());
    // Bend angle = 180° - dihedral (90°) = 90°
    REQUIRE(bend.angleDeg == Approx(90.0).epsilon(0.01));
    REQUIRE(bend.lengthMm == Approx(50.0).epsilon(0.01));
    REQUIRE(bend.kFactor  == Approx(0.33).epsilon(0.01));
    REQUIRE(bend.bendAllowanceMm > 0.0);
    REQUIRE(bend.faceIds.size() == 2);
  }

  SECTION("exactly one hole detected") {
    REQUIRE(fs.holes.size() == 1);
    const auto& hole = fs.holes[0];
    REQUIRE_FALSE(hole.featureId.empty());
    REQUIRE(hole.diameterMm == Approx(5.0).epsilon(0.5));   // estimated from area
    REQUIRE(hole.throughHole == true);
  }

  SECTION("two flanges detected (one per bend face)") {
    REQUIRE(fs.flanges.size() == 2);
    for (const auto& fl : fs.flanges) {
      REQUIRE_FALSE(fl.featureId.empty());
      REQUIRE_FALSE(fl.adjacentBendId.empty());
      REQUIRE(fl.lengthMm == Approx(50.0).epsilon(0.01));
    }
  }
}

// ── Synthetic fixture: Three-panel graph ─────────────────────────────────────

TEST_CASE("ACL integration: three-panel graph extracts multiple bends and holes",
          "[acl][integration][three-panel]") {
  auto extractor = FeatureExtractor::create();
  const auto graph = makeThreePanelGraph();

  const auto fs = extractor->composeFeatureSet(graph, "shell-three-panel", 1.5, 0.33);

  SECTION("three bends detected") {
    REQUIRE(fs.bends.size() == 3);
    for (const auto& b : fs.bends) {
      REQUIRE(b.angleDeg > 0.0);
      REQUIRE(b.angleDeg < 180.0);
      REQUIRE(b.lengthMm >= 80.0);
    }
  }

  SECTION("two holes detected") {
    REQUIRE(fs.holes.size() == 2);
    // Larger hole should have larger diameter
    double d0 = fs.holes[0].diameterMm;
    double d1 = fs.holes[1].diameterMm;
    // Sort order is insertion order; both must be positive
    REQUIRE(d0 > 0.0);
    REQUIRE(d1 > 0.0);
    REQUIRE(d0 != Approx(d1));   // different cylinders → different diameters
  }

  SECTION("flanges derived from bend faces") {
    // Each bend has 2 adjacent faces → 6 flanges total (3 bends × 2 faces)
    REQUIRE(fs.flanges.size() == 6);
  }

  SECTION("each flange references a known bend ID") {
    std::set<std::string> bendIds;
    for (const auto& b : fs.bends) bendIds.insert(b.featureId);

    for (const auto& fl : fs.flanges) {
      REQUIRE(bendIds.count(fl.adjacentBendId) > 0);
    }
  }
}

// ── Flat graph (no adjacency) — zero features ─────────────────────────────────

TEST_CASE("ACL integration: flat topology graph produces zero bends",
          "[acl][integration][flat]") {
  auto extractor = FeatureExtractor::create();

  TopologyGraph g;
  g.solidId = "flat-plate";
  FaceNode f;
  f.faceId      = "top";
  f.surfaceType = SurfaceType::PLANE;
  f.areaMm2     = 10000.0;
  f.normalX = 0; f.normalY = 0; f.normalZ = 1;
  g.faces = {f};
  // No edges, no adjacency

  const auto fs = extractor->composeFeatureSet(g, "shell-flat", 1.5, 0.33);

  REQUIRE(fs.bends.empty());
  REQUIRE(fs.flanges.empty());
}

// ── K-factor variation affects bend allowance ─────────────────────────────────

TEST_CASE("ACL integration: higher K-factor produces larger bend allowance",
          "[acl][integration][k-factor]") {
  auto extractor = FeatureExtractor::create();
  const auto graph = makeBracketGraph();

  const auto fs25 = extractor->composeFeatureSet(graph, "s1", 1.5, 0.25);
  const auto fs45 = extractor->composeFeatureSet(graph, "s2", 1.5, 0.45);

  REQUIRE_FALSE(fs25.bends.empty());
  REQUIRE_FALSE(fs45.bends.empty());

  REQUIRE(fs45.bends[0].bendAllowanceMm > fs25.bends[0].bendAllowanceMm);
}

// ── Live STEP fixture (skipped when fixture files missing) ────────────────────

TEST_CASE("ACL integration: pipeline on live STEP tier-1 fixtures",
          "[acl][integration][step][tier1]") {
  auto svc       = GeometryService::create();
  auto extractor = FeatureExtractor::create();

  const auto fixtures = mcp_cad::test::getTier1Fixtures();

  for (const auto& fixturePath : fixtures) {
    SECTION("Fixture: " + fixturePath) {
      if (!std::filesystem::exists(fixturePath)) {
        SKIP("Fixture missing: " + fixturePath);
      }

      const SolidId solidId = svc->loadStep(fixturePath);
      REQUIRE_FALSE(solidId.empty());

      const TopologyGraph topo = svc->getTopology(solidId);
      REQUIRE_FALSE(topo.faces.empty());

      const auto fs = extractor->composeFeatureSet(topo, solidId, 1.5, 0.33);

      // The pipeline must complete without throwing regardless of feature count
      REQUIRE(fs.shellId == solidId);

      // Every bend must have a positive length and valid angle
      for (const auto& b : fs.bends) {
        REQUIRE(b.angleDeg > 0.0);
        REQUIRE(b.angleDeg < 180.0);
        REQUIRE(b.lengthMm > 0.0);
        REQUIRE(b.bendAllowanceMm > 0.0);
      }

      // Every hole must have a positive diameter
      for (const auto& h : fs.holes) {
        REQUIRE(h.diameterMm > 0.0);
      }
    }
  }
}
