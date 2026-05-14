/**
 * Non-functional determinism test: verify unfold produces identical output
 * across repeated invocations on the same input.
 *
 * Requirement: TESTING_STRATEGY.md §non-functional — geometry operations must
 * be deterministic (same STEP input → identical UnfoldResult across runs).
 *
 * For each fixture, runs unfoldShell() 3 times and asserts:
 *   - flatWidthMm and flatHeightMm are identical across runs
 *   - DXF content is byte-for-byte identical across runs
 *
 * Fixtures are skipped when not present (CI without fixture files).
 *
 * Task: T154
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/geometry_service.hpp"
#include "helpers/fixtures.h"

#include <filesystem>
#include <string>
#include <vector>
using namespace mcp_cad;
using Catch::Approx;

static std::string tryFixture(const std::string& name) {
  const std::string p = test::getFixturePath(name);
  if (!std::filesystem::exists(p)) {
    SKIP("Fixture missing: " + p);
  }
  return p;
}

// Helper: load STEP → booleanCut → unfoldShell → exportDxf
struct UnfoldRun {
  double flatWidthMm;
  double flatHeightMm;
  double kFactorUsed;
  std::string dxfContent;
};

static UnfoldRun runUnfold(const std::string& fixturePath, double kFactor) {
  auto svc = GeometryService::create();
  SolidId solid = svc->loadStep(fixturePath);
  BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
  if (cut.shellIds.empty()) {
    FAIL("booleanCut returned no shells for: " + fixturePath);
  }
  ShellId shell = cut.shellIds[0];

  UnfoldResult ur = svc->unfoldShell(shell, kFactor);
  DxfExportResult dxf = svc->exportDxf(ur.unfoldId);

  return { ur.flatWidthMm, ur.flatHeightMm, ur.kFactorUsed, dxf.dxfContent };
}

// ─── Determinism replay tests ─────────────────────────────────────────────────

TEST_CASE("Determinism: unfold on simple_box.stp is reproducible",
          "[determinism][unfold][non-functional]") {
  std::string fixturePath = tryFixture("simple_box.stp");

  UnfoldRun run1 = runUnfold(fixturePath, 0.33);
  UnfoldRun run2 = runUnfold(fixturePath, 0.33);
  UnfoldRun run3 = runUnfold(fixturePath, 0.33);

  SECTION("flatWidthMm is identical across 3 runs") {
    REQUIRE(run1.flatWidthMm == Approx(run2.flatWidthMm).margin(0.001));
    REQUIRE(run1.flatWidthMm == Approx(run3.flatWidthMm).margin(0.001));
  }

  SECTION("flatHeightMm is identical across 3 runs") {
    REQUIRE(run1.flatHeightMm == Approx(run2.flatHeightMm).margin(0.001));
    REQUIRE(run1.flatHeightMm == Approx(run3.flatHeightMm).margin(0.001));
  }

  SECTION("DXF content is byte-for-byte identical across 3 runs") {
    REQUIRE(run1.dxfContent == run2.dxfContent);
    REQUIRE(run1.dxfContent == run3.dxfContent);
  }

  SECTION("k_factor is preserved correctly across runs") {
    REQUIRE(run1.kFactorUsed == Approx(0.33));
    REQUIRE(run2.kFactorUsed == Approx(0.33));
    REQUIRE(run3.kFactorUsed == Approx(0.33));
  }
}

TEST_CASE("Determinism: unfold on sheet_1panel.stp is reproducible",
          "[determinism][unfold][non-functional]") {
  std::string fixturePath = tryFixture("sheet_1panel.stp");

  UnfoldRun run1 = runUnfold(fixturePath, 0.35);
  UnfoldRun run2 = runUnfold(fixturePath, 0.35);
  UnfoldRun run3 = runUnfold(fixturePath, 0.35);

  SECTION("flatWidthMm is identical across 3 runs") {
    REQUIRE(run1.flatWidthMm == Approx(run2.flatWidthMm).margin(0.001));
    REQUIRE(run1.flatWidthMm == Approx(run3.flatWidthMm).margin(0.001));
  }

  SECTION("flatHeightMm is identical across 3 runs") {
    REQUIRE(run1.flatHeightMm == Approx(run2.flatHeightMm).margin(0.001));
    REQUIRE(run1.flatHeightMm == Approx(run3.flatHeightMm).margin(0.001));
  }

  SECTION("DXF content is byte-for-byte identical across 3 runs") {
    REQUIRE(run1.dxfContent == run2.dxfContent);
    REQUIRE(run1.dxfContent == run3.dxfContent);
  }
}

struct NestRun {
  double utilisationPct;
  int sheetsRequired;
  size_t placementCount;
};

static NestRun runNest(const std::string& fixturePath) {
  auto svc = GeometryService::create();
  SolidId solid = svc->loadStep(fixturePath);
  BooleanCutResult cut = svc->booleanCut(solid, 0, 0, 1, 0, 0, 0);
  
  std::vector<UnfoldId> unfoldIds;
  for (const ShellId& shell : cut.shellIds) {
    UnfoldResult ur = svc->unfoldShell(shell, 0.33);
    unfoldIds.push_back(ur.unfoldId);
  }

  NestResult nr = svc->nestShells(unfoldIds, 1220.0, 2440.0);
  return { nr.utilisationPct, nr.sheetsRequired, nr.placements.size() };
}

TEST_CASE("Determinism: nesting on sheet_3panel.stp is reproducible",
          "[determinism][nesting][non-functional]") {
  std::string fixturePath = tryFixture("sheet_3panel.stp");

  NestRun run1 = runNest(fixturePath);
  NestRun run2 = runNest(fixturePath);
  NestRun run3 = runNest(fixturePath);

  SECTION("utilisationPct is identical across 3 runs") {
    REQUIRE(run1.utilisationPct == Approx(run2.utilisationPct).margin(0.001));
    REQUIRE(run1.utilisationPct == Approx(run3.utilisationPct).margin(0.001));
  }

  SECTION("sheetsRequired is identical across 3 runs") {
    REQUIRE(run1.sheetsRequired == run2.sheetsRequired);
    REQUIRE(run1.sheetsRequired == run3.sheetsRequired);
  }

  SECTION("placementCount is identical across 3 runs") {
    REQUIRE(run1.placementCount == run2.placementCount);
    REQUIRE(run1.placementCount == run3.placementCount);
  }
}
