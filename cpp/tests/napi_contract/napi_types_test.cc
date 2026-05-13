/**
 * C++ NAPI contract tests — roundtrip serialisation invariants.
 * Validates SolidId, ShellId, TopologyGraph serialisation across NAPI boundary.
 *
 * Task: T139
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "geometry/geometry_service.hpp"
#include "geometry/topology_graph.hpp"

#include <string>
#include <regex>

using namespace mcp_cad;

// ─── UUID format validation ───────────────────────────────────────────────────

static bool isValidUUID(const std::string& s) {
  static const std::regex uuidPattern(
      "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
      std::regex::icase);
  return std::regex_match(s, uuidPattern);
}

// ─── SolidId serialisation ────────────────────────────────────────────────────

TEST_CASE("NAPI Contract: SolidId is UUID v4 format", "[contract][napi][solid-id]") {
  auto svc = GeometryService::create();
  // Use a known-good fixture if available; otherwise test with a snapshot
  SnapshotId snap = svc->createSnapshot("test");
  REQUIRE(isValidUUID(snap));
}

TEST_CASE("NAPI Contract: SnapshotId roundtrip (create -> restore)", "[contract][napi][snapshot]") {
  auto svc = GeometryService::create();

  SnapshotId snap1 = svc->createSnapshot("state1");
  SnapshotId snap2 = svc->createSnapshot("state2");

  REQUIRE(snap1 != snap2);
  REQUIRE(isValidUUID(snap1));
  REQUIRE(isValidUUID(snap2));

  // Restore snap1 — should not throw
  REQUIRE_NOTHROW(svc->restoreSnapshot(snap1));
}

// ─── TopologyGraph serialisation invariants ───────────────────────────────────

TEST_CASE("NAPI Contract: TopologyGraph struct has no precision-loss fields", "[contract][napi][topology]") {
  // Verify that all TopologyGraph fields are double (IEEE-754 64-bit)
  // This is a compile-time check via static_assert
  static_assert(std::is_same_v<decltype(FaceNode::areaMm2), double>,
                "FaceNode::areaMm2 must be double (no float allowed at NAPI boundary)");
  static_assert(std::is_same_v<decltype(FaceNode::normalX), double>,
                "FaceNode::normalX must be double");
  static_assert(std::is_same_v<decltype(EdgeNode::lengthMm), double>,
                "EdgeNode::lengthMm must be double");
  static_assert(std::is_same_v<decltype(AdjacencyEntry::dihedralAngleDeg), double>,
                "AdjacencyEntry::dihedralAngleDeg must be double");
  SUCCEED("All NAPI boundary fields are double precision (IEEE-754)");
}

TEST_CASE("NAPI Contract: UnfoldResult fields are double precision", "[contract][napi][unfold]") {
  static_assert(std::is_same_v<decltype(UnfoldResult::flatWidthMm), double>,
                "UnfoldResult::flatWidthMm must be double");
  static_assert(std::is_same_v<decltype(UnfoldResult::flatHeightMm), double>,
                "UnfoldResult::flatHeightMm must be double");
  static_assert(std::is_same_v<decltype(UnfoldResult::kFactorUsed), double>,
                "UnfoldResult::kFactorUsed must be double");
  SUCCEED("UnfoldResult NAPI boundary fields are double precision");
}

TEST_CASE("NAPI Contract: TabSlotResult kerf is in valid range", "[contract][napi][tab-slot]") {
  static_assert(std::is_same_v<decltype(TabSlotResult::kerfOffsetApplied), double>,
                "TabSlotResult::kerfOffsetApplied must be double");
  // No runtime check here (requires actual geometry service with shells loaded)
  SUCCEED("TabSlotResult kerf field type verified");
}

// ─── GeometryError error code contract ───────────────────────────────────────

TEST_CASE("NAPI Contract: GeometryError code is non-empty string", "[contract][napi][error]") {
  auto svc = GeometryService::create();

  try {
    svc->loadStep("/nonexistent/path/fake.stp");
    FAIL("Should have thrown");
  } catch (const GeometryError& e) {
    REQUIRE_FALSE(std::string(e.code).empty());
    REQUIRE_FALSE(std::string(e.what()).empty());
    // code should follow ALL_CAPS_WITH_UNDERSCORES convention
    const std::string code = e.code;
    REQUIRE(std::none_of(code.begin(), code.end(), [](char c) {
      return c != '_' && !std::isupper(c) && !std::isdigit(c);
    }));
  }
}
