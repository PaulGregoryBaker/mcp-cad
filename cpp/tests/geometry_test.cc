#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include "geometry/geometry_service.hpp"

#include <filesystem>
#include <fstream>
#include <set>
#include <cmath>
using Catch::Approx;
#include <cmath>
#include <string>

namespace fs = std::filesystem;
using namespace mcp_cad;

// ─── Fixture path helper ──────────────────────────────────────────────────────

static std::string fixtureDir() {
  return (fs::path(__FILE__).parent_path() / "fixtures").string();
}

static std::string fixture(const std::string& name) {
  fs::path p = fs::path(fixtureDir()) / name;
  if (!fs::exists(p)) {
    SKIP("Fixture missing: " + p.string());
  }
  return p.string();
}

// ─── GE-01: STEP import ───────────────────────────────────────────────────────

TEST_CASE("GE-01: STEP import loads valid fixture file", "[ge-01][step]") {
  auto svc = GeometryService::create();

  SECTION("simple_box.stp loads successfully") {
    const auto path = fixture("simple_box.stp");
    REQUIRE_NOTHROW([&] {
      SolidId id = svc->loadStep(path);
      REQUIRE_FALSE(id.empty());
    }());
  }

  SECTION("loadStep returns a UUID-format SolidId") {
    SolidId id = svc->loadStep(fixture("simple_box.stp"));
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    REQUIRE(id.length() == 36);
    REQUIRE(id[8]  == '-');
    REQUIRE(id[13] == '-');
    REQUIRE(id[14] == '4');   // version 4
    REQUIRE(id[18] == '-');
    REQUIRE(id[23] == '-');
  }

  SECTION("loadStep throws GE_IMPORT_FAILED for missing file") {
    try {
      svc->loadStep("/nonexistent/path/fake.stp");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_IMPORT_FAILED");
    }
  }

  SECTION("loadStep throws GE_IMPORT_FAILED for invalid file content") {
    // Create a temp file with invalid STEP content
    std::string tmpPath = fixtureDir() + "/tmp_invalid.stp";
    {
      std::ofstream f(tmpPath);
      f << "this is not a valid STEP file\n";
    }
    try {
      svc->loadStep(tmpPath);
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE((e.code == "GE_IMPORT_FAILED" || e.code == "GE_INVALID_SOLID"));
    }
    std::remove(tmpPath.c_str());
  }
}

// ─── GE-02: Topology extraction ───────────────────────────────────────────────

TEST_CASE("GE-02: Topology graph builds correctly", "[ge-02][topology]") {
  auto svc  = GeometryService::create();
  SolidId id = svc->loadStep(fixture("simple_box.stp"));

  SECTION("getTopology returns a non-empty graph") {
    TopologyGraph graph = svc->getTopology(id);
    REQUIRE(graph.solidId == id);
    REQUIRE_FALSE(graph.faces.empty());
    REQUIRE_FALSE(graph.edges.empty());
  }

  SECTION("simple box has 6 faces") {
    TopologyGraph graph = svc->getTopology(id);
    REQUIRE(graph.faces.size() == 6);
  }

  SECTION("all faces have positive area") {
    TopologyGraph graph = svc->getTopology(id);
    for (const auto& face : graph.faces) {
      REQUIRE(face.areaMm2 > 0.0);
    }
  }

  SECTION("face normals are unit vectors") {
    TopologyGraph graph = svc->getTopology(id);
    for (const auto& face : graph.faces) {
      double mag = std::sqrt(face.normalX * face.normalX +
                             face.normalY * face.normalY +
                             face.normalZ * face.normalZ);
      REQUIRE_THAT(mag, Catch::Matchers::WithinAbs(1.0, 1e-6));
    }
  }

  SECTION("adjacency entries reference valid face IDs") {
    TopologyGraph graph = svc->getTopology(id);
    std::set<std::string> faceIds;
    for (const auto& f : graph.faces) faceIds.insert(f.faceId);

    for (const auto& adj : graph.adjacency) {
      REQUIRE(faceIds.count(adj.faceIdA) > 0);
      REQUIRE(faceIds.count(adj.faceIdB) > 0);
    }
  }

  SECTION("getTopology throws GE_SOLID_NOT_FOUND for unknown ID") {
    try {
      svc->getTopology("00000000-0000-4000-8000-000000000000");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SOLID_NOT_FOUND");
    }
  }
}

// ─── GE-03: Manifold detection and healing ─────────────────────────────────────

TEST_CASE("GE-03: Manifold detection and healing", "[ge-03][manifold]") {
  auto svc = GeometryService::create();

  SECTION("simple_box.stp is manifold") {
    SolidId id = svc->loadStep(fixture("simple_box.stp"));
    ManifoldResult result = svc->checkManifold(id);
    REQUIRE(result.isManifold);
    REQUIRE(result.issues.empty());
  }

  SECTION("checkManifold throws GE_SOLID_NOT_FOUND for unknown ID") {
    try {
      svc->checkManifold("00000000-0000-4000-8000-000000000000");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SOLID_NOT_FOUND");
    }
  }

  SECTION("healGeometry returns a valid SolidId") {
    SolidId id     = svc->loadStep(fixture("simple_box.stp"));
    SolidId healed = svc->healGeometry(id);
    REQUIRE_FALSE(healed.empty());
    // Healed solid should pass topology check
    REQUIRE_NOTHROW(svc->getTopology(healed));
  }

  SECTION("healGeometry on already-manifold solid succeeds") {
    SolidId id     = svc->loadStep(fixture("simple_box.stp"));
    SolidId healed = svc->healGeometry(id);
    ManifoldResult result = svc->checkManifold(healed);
    REQUIRE(result.isManifold);
  }

  SECTION("healGeometry throws GE_SOLID_NOT_FOUND for unknown ID") {
    try {
      svc->healGeometry("00000000-0000-4000-8000-000000000000");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SOLID_NOT_FOUND");
    }
  }
}

// ─── GE-14: Snapshot / rollback ───────────────────────────────────────────────

TEST_CASE("GE-14: Snapshot creation and restoration", "[ge-14][snapshot][rollback]") {
  auto svc = GeometryService::create();

  SECTION("createSnapshot returns non-empty snapshotId") {
    SnapshotId snap = svc->createSnapshot("test snapshot");
    REQUIRE_FALSE(snap.empty());
    REQUIRE(snap.length() == 36);  // UUID format
  }

  SECTION("restoreSnapshot after loadStep removes the solid") {
    SnapshotId snap = svc->createSnapshot("before load");
    SolidId id = svc->loadStep(fixture("simple_box.stp"));

    // Solid should exist before restore
    REQUIRE_NOTHROW(svc->getTopology(id));

    // Restore to before-load snapshot
    RestoreResult result = svc->restoreSnapshot(snap);

    // Solid should be gone after restore
    REQUIRE_THROWS_AS(svc->getTopology(id), GeometryError);
  }

  SECTION("restoreSnapshot throws GE_SNAPSHOT_NOT_FOUND for unknown token") {
    try {
      svc->restoreSnapshot("00000000-0000-4000-8000-000000000000");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SNAPSHOT_NOT_FOUND");
    }
  }

  SECTION("clearSnapshots makes all snapshot IDs invalid") {
    SnapshotId snap = svc->createSnapshot("to be cleared");
    svc->clearSnapshots();
    try {
      svc->restoreSnapshot(snap);
      FAIL("Expected GeometryError after clearSnapshots");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SNAPSHOT_NOT_FOUND");
    }
  }

  SECTION("multiple snapshots restore to correct state") {
    SolidId id1 = svc->loadStep(fixture("simple_box.stp"));
    SnapshotId snap1 = svc->createSnapshot("after first load");
    SolidId id2 = svc->loadStep(fixture("sheet_1panel.stp"));

    // Both solids exist
    REQUIRE_NOTHROW(svc->getTopology(id1));
    REQUIRE_NOTHROW(svc->getTopology(id2));

    // Restore to after first load
    svc->restoreSnapshot(snap1);

    // id1 still exists, id2 is gone
    REQUIRE_NOTHROW(svc->getTopology(id1));
    REQUIRE_THROWS_AS(svc->getTopology(id2), GeometryError);
  }
}

// ─── GE-08: Corner relief generation ─────────────────────────────────────────

TEST_CASE("GE-08: addCornerRelief returns a new ShellId", "[ge-08][relief]") {
  auto svc = GeometryService::create();

  SECTION("addCornerRelief on valid shell returns non-empty ID") {
    // Decompose a solid to get a shell
    SolidId solid = svc->loadStep(fixture("simple_box.stp"));
    BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
    REQUIRE_FALSE(cut.shellIds.empty());
    ShellId shell = cut.shellIds[0];

    ShellId relieved = svc->addCornerRelief(
        shell, GeometryService::ReliefType::DOGBONE, 2.0);
    REQUIRE_FALSE(relieved.empty());
    REQUIRE_FALSE(relieved == shell);  // new distinct ID
  }

  SECTION("addCornerRelief throws GE_SHELL_NOT_FOUND for unknown shell") {
    try {
      svc->addCornerRelief("unknown-shell-id",
                           GeometryService::ReliefType::DOGBONE, 2.0);
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SHELL_NOT_FOUND");
    }
  }
}

// ─── GE-09: Sheet metal unfolding ─────────────────────────────────────────────

TEST_CASE("GE-09: unfoldShell produces valid flat dimensions", "[ge-09][unfold]") {
  auto svc = GeometryService::create();

  SECTION("unfoldShell on valid shell returns positive flat dimensions") {
    SolidId solid = svc->loadStep(fixture("simple_box.stp"));
    BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
    REQUIRE_FALSE(cut.shellIds.empty());
    ShellId shell = cut.shellIds[0];

    UnfoldResult result = svc->unfoldShell(shell, 0.33);

    REQUIRE_FALSE(result.unfoldId.empty());
    REQUIRE(result.flatWidthMm > 0.0);
    REQUIRE(result.flatHeightMm > 0.0);
    REQUIRE(result.kFactorUsed == Approx(0.33));
    REQUIRE(result.bendCount >= 0);
    REQUIRE_FALSE(result.rollbackToken.empty());
  }

  SECTION("unfoldShell throws GE_SHELL_NOT_FOUND for unknown shell") {
    try {
      svc->unfoldShell("unknown-shell-id", 0.33);
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_SHELL_NOT_FOUND");
    }
  }
}

// ─── GE-10: DXF export ────────────────────────────────────────────────────────

TEST_CASE("GE-10: exportDxf produces valid DXF content", "[ge-10][dxf]") {
  auto svc = GeometryService::create();

  SECTION("exportDxf returns non-empty DXF string with wire count > 0") {
    SolidId solid = svc->loadStep(fixture("simple_box.stp"));
    BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
    ShellId shell = cut.shellIds[0];

    UnfoldResult unfold = svc->unfoldShell(shell, 0.33);
    DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);

    REQUIRE_FALSE(dxf.dxfContent.empty());
    REQUIRE(dxf.wireCount > 0);
    REQUIRE(dxf.bboxWidthMm > 0.0);
    REQUIRE(dxf.bboxHeightMm > 0.0);
  }

  SECTION("DXF content contains SECTION and EOF markers") {
    SolidId solid = svc->loadStep(fixture("simple_box.stp"));
    BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
    ShellId shell = cut.shellIds[0];

    UnfoldResult unfold = svc->unfoldShell(shell, 0.33);
    DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);

    REQUIRE(dxf.dxfContent.find("SECTION") != std::string::npos);
    REQUIRE(dxf.dxfContent.find("EOF") != std::string::npos);
  }

  SECTION("exportDxf throws GE_UNFOLD_NOT_FOUND for unknown unfold ID") {
    try {
      svc->exportDxf("unknown-unfold-id");
      FAIL("Expected GeometryError");
    } catch (const GeometryError& e) {
      REQUIRE(e.code == "GE_UNFOLD_NOT_FOUND");
    }
  }
}
// ─── GE-12: Nesting ───────────────────────────────────────────────────────────

TEST_CASE("GE-12: nestShells places all panels and returns a nest ID", "[ge-12][nesting]") {
  auto svc = GeometryService::create();

  SECTION("nestShells requires valid unfold IDs") {
    REQUIRE_THROWS_AS(
      svc->nestShells({"unknown-id"}, 2440, 1220),
      GeometryError
    );
  }

  SECTION("nestShells returns valid NestResult for real unfolds") {
    if (!std::filesystem::exists(fixture("simple_box.stp"))) {
      SKIP("simple_box.stp fixture not found");
    }
    SolidId solid = svc->loadStep(fixture("simple_box.stp"));
    BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
    UnfoldResult ur = svc->unfoldShell(cut.shellIds[0], 0.33);

    NestResult nr = svc->nestShells({ur.unfoldId}, 2440, 1220);

    REQUIRE_FALSE(nr.nestId.empty());
    REQUIRE(nr.placements.size() == 1);
    REQUIRE(nr.utilisationPct > 0.0);
    REQUIRE(nr.sheetsRequired >= 1);
    REQUIRE_FALSE(nr.svgPreview.empty());
  }
}

// ─── GE-13: Nesting determinism ───────────────────────────────────────────────

TEST_CASE("GE-13: nestShells is deterministic across repeated calls", "[ge-13][nesting]") {
  if (!std::filesystem::exists(fixture("simple_box.stp"))) {
    SKIP("simple_box.stp fixture not found");
  }

  auto svc = GeometryService::create();
  SolidId solid = svc->loadStep(fixture("simple_box.stp"));
  BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);

  std::vector<UnfoldId> unfoldIds;
  for (int i = 0; i < 3; ++i) {
    UnfoldResult ur = svc->unfoldShell(cut.shellIds[0], 0.33);
    unfoldIds.push_back(ur.unfoldId);
  }

  // Run nesting 3 times on the same unfold IDs
  NestResult r1 = svc->nestShells({unfoldIds[0]}, 2440, 1220);
  NestResult r2 = svc->nestShells({unfoldIds[1]}, 2440, 1220);
  NestResult r3 = svc->nestShells({unfoldIds[2]}, 2440, 1220);

  REQUIRE(r1.utilisationPct == Approx(r2.utilisationPct).epsilon(0.001));
  REQUIRE(r2.utilisationPct == Approx(r3.utilisationPct).epsilon(0.001));
  REQUIRE(r1.placements[0].x == Approx(r2.placements[0].x).margin(0.01));
  REQUIRE(r1.placements[0].y == Approx(r2.placements[0].y).margin(0.01));
}
// ─── GE-XX: Split by Bends on testcube.step ───────────────────────────────

TEST_CASE("GE-XX: splitBodyByBends on testcube.step produces panels", "[ge-xx][bends][step]" ) {
  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(fixture("testcube.step"));

  SECTION("splitBodyByBends with recursion returns expected panel count or triggers crash") {
    // Set maxRecursionDepth high to exercise recursion and expose crash/loop
    auto result = svc->splitBodyByBends(solidId, 30.0, 5.0, 1.0, 50);
    // For a cube, expect 12 panels (one per face pair), no protrusions
    REQUIRE(result.panelIds.size() == 12);
    REQUIRE(result.protrusionIds.empty());
  }
}

// ─── T028: splitBodyByBends shape history capture ─────────────────────────────

TEST_CASE("T028: splitBodyByBends populates shapeHistory", "[t028][bends][shape-history][step]") {
  auto svc = GeometryService::create();
  const auto path = fixture("testcube.step");
  SolidId solidId = svc->loadStep(path);

  SECTION("shapeHistory is non-empty after split") {
    auto result = svc->splitBodyByBends(solidId, 30.0, 5.0, 1.0, 0);
    REQUIRE(result.shapeHistory.size() >= 6);
    for (const auto& rec : result.shapeHistory) {
      CHECK(rec.operationLabel == "split_body_by_bends");
      CHECK_FALSE(rec.originalId.empty());
      // deleted records have empty newId; others must have a non-empty newId
      if (rec.verdict != "deleted") {
        CHECK_FALSE(rec.newId.empty());
      }
    }
  }
}

/**
 * Geometry Engine Unit Tests — GE-01, GE-02, GE-03, GE-14 (snapshot/rollback)
 *
 * Task: T026
 */

