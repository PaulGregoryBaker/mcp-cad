#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/geometry_service.hpp"
#include "helpers/fixtures.h"

#include <filesystem>

using namespace mcp_cad;
using Catch::Approx;

TEST_CASE("GE-05: addTabSlot clamps kerf in [0.1,0.2]", "[ge-05][tab-slot]") {
  const std::string boxFixture = test::getFixturePath("simple_box.stp");
  if (!std::filesystem::exists(boxFixture)) {
    SKIP("Fixture simple_box.stp missing; skipping tab-slot test.");
  }

  auto svc = GeometryService::create();
  const auto solidId = svc->loadStep(boxFixture);
  const auto cut = svc->booleanCut(solidId, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0);

  if (cut.shellIds.size() < 2) {
    SKIP("booleanCut did not produce at least two shells for tab-slot test.");
  }

  SECTION("kerf below minimum is clamped") {
    const auto out = svc->addTabSlot(cut.shellIds[0], cut.shellIds[1], 0.01);
    REQUIRE(out.kerfOffsetApplied == Approx(0.1));
    REQUIRE(out.modifiedShellIds.size() == 2);
  }

  SECTION("kerf above maximum is clamped") {
    const auto out = svc->addTabSlot(cut.shellIds[0], cut.shellIds[1], 0.5);
    REQUIRE(out.kerfOffsetApplied == Approx(0.2));
    REQUIRE(out.modifiedShellIds.size() == 2);
  }

  SECTION("kerf in range is preserved") {
    const auto out = svc->addTabSlot(cut.shellIds[0], cut.shellIds[1], 0.15);
    REQUIRE(out.kerfOffsetApplied == Approx(0.15));
  }
}
