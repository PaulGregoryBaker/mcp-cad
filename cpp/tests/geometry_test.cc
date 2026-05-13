/**
 * Geometry Engine Unit Tests — GE-01, GE-02, GE-03, GE-14 (snapshot/rollback)
 *
 * Task: T026
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>
#include <catch2/matchers/catch_matchers_string.hpp>

#include "geometry/geometry_service.hpp"

#include <filesystem>
#include <fstream>
#include <set>
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
