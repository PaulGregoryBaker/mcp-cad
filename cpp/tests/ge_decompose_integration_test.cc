#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/geometry_service.hpp"
#include "helpers/fixtures.h"

#include <filesystem>

using namespace mcp_cad;
using Catch::Approx;

TEST_CASE("GE Phase B integration: load -> decompose -> tab-slot", "[integration][ge][decompose]") {
  const std::string boxFixture = test::getFixturePath("simple_box.stp");
  if (!std::filesystem::exists(boxFixture)) {
    SKIP("Fixture simple_box.stp missing; skipping decompose integration test.");
  }

  auto svc = GeometryService::create();

  const auto solidId = svc->loadStep(boxFixture);
  REQUIRE_FALSE(solidId.empty());

  const auto decomp = svc->booleanCut(solidId, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  REQUIRE(decomp.shellIds.size() >= 1);

  if (decomp.shellIds.size() >= 2) {
    const auto tab = svc->addTabSlot(decomp.shellIds[0], decomp.shellIds[1], 0.15);
    REQUIRE(tab.modifiedShellIds.size() == 2);
    REQUIRE(tab.kerfOffsetApplied == Approx(0.15));
  }
}
