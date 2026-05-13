/**
 * C++ Geometry Engine integration test.
 * Integration flow: STEP ingest → topology analysis → manifold check → heal
 * Tests T143: golden path on 10 fixtures.
 *
 * Task: T143
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/geometry_service.hpp"
#include "helpers/fixtures.h"

#include <cmath>
#include <filesystem>
using namespace mcp_cad;
using Catch::Approx;

static std::string requireFixturePath(const std::string& name) {
  const std::string p = test::getFixturePath(name);
  if (!std::filesystem::exists(p)) {
    SKIP("Fixture missing: " + p);
  }
  return p;
}

// ─── GE-01: STEP import ──────────────────────────────────────────────────────

TEST_CASE("GE Integration: STEP import on box fixture", "[integration][ge][import]") {
  auto svc = GeometryService::create();
  std::string filePath = requireFixturePath("simple_box.stp");

  // Import should succeed
  SolidId solidId = svc->loadStep(filePath);
  REQUIRE_FALSE(solidId.empty());

  // ID should be a valid UUID
  REQUIRE(solidId.find('-') != std::string::npos);  // UUID format check
}

// ─── GE-02: Topology extraction on imports ───────────────────────────────────

TEST_CASE("GE Integration: topology extraction on imported box", "[integration][ge][topology]") {
  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(requireFixturePath("simple_box.stp"));

  TopologyGraph topo = svc->getTopology(solidId);

  // Box should have 6 faces
  REQUIRE(topo.faces.size() == 6);

  // Each face should have positive area
  for (const auto& face : topo.faces) {
    REQUIRE(face.areaMm2 > 0);
    // Normals should be unit length (approx 1.0)
    double normLen = std::sqrt(
        face.normalX * face.normalX +
        face.normalY * face.normalY +
        face.normalZ * face.normalZ);
    REQUIRE(normLen == Approx(1.0).margin(0.01));
  }

  // Adjacency should have valid face references
  for (const auto& adj : topo.adjacency) {
    bool faceAFound = false, faceBFound = false;
    for (const auto& f : topo.faces) {
      if (f.faceId == adj.faceIdA) faceAFound = true;
      if (f.faceId == adj.faceIdB) faceBFound = true;
    }
    REQUIRE(faceAFound);
    REQUIRE(faceBFound);
  }
}

// ─── GE-03: Manifold check ────────────────────────────────────────────────────

TEST_CASE("GE Integration: manifold check on valid solid", "[integration][ge][manifold]") {
  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(requireFixturePath("simple_box.stp"));

  ManifoldResult mr = svc->checkManifold(solidId);

  REQUIRE(mr.isManifold == true);
  REQUIRE(mr.issues.empty());
}

// ─── GE-14: Snapshot -> restore roundtrip ─────────────────────────────────────

TEST_CASE("GE Integration: snapshot -> restore roundtrip", "[integration][ge][snapshot]") {
  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(requireFixturePath("simple_box.stp"));

  SnapshotId snap1 = svc->createSnapshot("state_after_import");
  SnapshotId snap2 = svc->createSnapshot("state_after_heal");

  // Restore snap1 (earlier state)
  RestoreResult restore = svc->restoreSnapshot(snap1);
  REQUIRE(restore.restoredSolidIds.size() > 0);
}

// ─── Multi-fixture integration smoke test ──────────────────────────────────────

TEST_CASE("GE Integration: golden path on TIER1 fixtures", "[integration][ge][tier1]") {
  auto svc = GeometryService::create();
  const auto& fixtures = test::getTier1Fixtures();

  for (const auto& fixturePath : fixtures) {
    SECTION("Fixture: " + fixturePath) {
      // Import
      if (!std::filesystem::exists(fixturePath)) {
        SKIP("Fixture missing: " + fixturePath);
      }
      SolidId solidId = svc->loadStep(fixturePath);
      REQUIRE_FALSE(solidId.empty());

      // Extract topology
      TopologyGraph topo = svc->getTopology(solidId);
      REQUIRE_FALSE(topo.faces.empty());

      // Check manifold
      ManifoldResult mr = svc->checkManifold(solidId);
      // Some may be non-manifold; we just verify the check completes
      if (mr.isManifold) {
        REQUIRE(mr.issues.empty());
      }

      // Create snapshot
      SnapshotId snap = svc->createSnapshot("after_analysis");
      REQUIRE_FALSE(snap.empty());
    }
  }
}

// ─── Healing flow ─────────────────────────────────────────────────────────────

TEST_CASE("GE Integration: heal non-manifold geometry", "[integration][ge][heal]") {
  auto svc = GeometryService::create();

  // Use INF-03 fixture if available; otherwise use first TIER1
  std::string filePath;
  try {
    filePath = test::getInf03FixturePath();
    if (!std::filesystem::exists(filePath)) {
      throw std::runtime_error("INF03 fixture missing");
    }
  } catch (...) {
    filePath = test::getTier1Fixtures()[0];
    if (!std::filesystem::exists(filePath)) {
      SKIP("No GE fixtures available for heal integration test.");
    }
  }

  SolidId originalId = svc->loadStep(filePath);
  ManifoldResult originalMr = svc->checkManifold(originalId);

  SolidId healedId = svc->healGeometry(originalId);
  REQUIRE_FALSE(healedId.empty());

  // Healed geometry should at least have a topology
  TopologyGraph healedTopo = svc->getTopology(healedId);
  REQUIRE_FALSE(healedTopo.faces.empty());

  // Snapshot the healed state
  SnapshotId healSnapId = svc->createSnapshot("healed_state");
  REQUIRE_FALSE(healSnapId.empty());
}

// ─── Snapshot cleanup ──────────────────────────────────────────────────────────

TEST_CASE("GE Integration: clearSnapshots", "[integration][ge][snapshot]") {
  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(requireFixturePath("simple_box.stp"));

  svc->createSnapshot("snap1");
  svc->createSnapshot("snap2");
  svc->createSnapshot("snap3");

  // Should not throw
  REQUIRE_NOTHROW(svc->clearSnapshots());
}
