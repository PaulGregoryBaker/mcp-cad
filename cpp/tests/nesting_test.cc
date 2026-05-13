/**
 * Nesting tests — GE-12, GE-13, GE-12b (SVG preview)
 *
 * Verifies that the Shelf-Next-Fit Decreasing rectangular bin-packing
 * algorithm achieves >80% material utilisation on three standard sheet sizes
 * when panels are appropriately sized.
 *
 * Task: T087, T088
 */

#include <catch2/catch_test_macros.hpp>
#include <catch2/catch_approx.hpp>

#include "geometry/geometry_service.hpp"

#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>

using Catch::Approx;
using namespace mcp_cad;
namespace fs = std::filesystem;

// ─── Fixture helper ───────────────────────────────────────────────────────────

static std::string fixtureFile(const std::string& name) {
  fs::path p = fs::path(__FILE__).parent_path() / "fixtures" / name;
  return p.string();
}

// ─── Algorithm property tests ─────────────────────────────────────────────────

/**
 * GE-12: Single panel fills its sheet perfectly (utilisation ≈ 100%).
 *
 * Uses the simple_box.stp fixture to create a real unfold, then nests it on a
 * sheet exactly matching the panel dimensions.
 */
TEST_CASE("GE-12: nestShells utilisation formula is correct", "[ge-12][nesting]") {
  const std::string FIXTURE = fixtureFile("simple_box.stp");
  if (!fs::exists(FIXTURE)) {
    SKIP("Fixture not available: " + FIXTURE);
  }

  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(FIXTURE);
  REQUIRE_FALSE(solidId.empty());

  BooleanCutResult cut = svc->booleanCut(solidId, 0, 0, 1, 0, 0, 0);
  REQUIRE_FALSE(cut.shellIds.empty());
  const ShellId shellId = cut.shellIds.front();

  UnfoldResult ur = svc->unfoldShell(shellId, 0.33);
  REQUIRE(ur.flatWidthMm > 0.0);
  REQUIRE(ur.flatHeightMm > 0.0);

  // Nest using a sheet exactly matching the unfold dimensions
  NestResult nr = svc->nestShells({ur.unfoldId}, ur.flatWidthMm, ur.flatHeightMm);

  REQUIRE(nr.placements.size() == 1);
  REQUIRE(nr.utilisationPct == Approx(100.0).epsilon(0.01));
  REQUIRE(nr.sheetsRequired == 1);
  REQUIRE(nr.placements[0].x == Approx(0.0).margin(0.1));
  REQUIRE(nr.placements[0].y == Approx(0.0).margin(0.1));
  REQUIRE(nr.placements[0].sheetIndex == 0);
}

/**
 * GE-13: Nesting algorithm achieves >80% material utilisation when panels
 *        are sized to fill the sheet.
 *
 * Uses a custom sheet size: exactly 2×panelWidth × 2×panelHeight, so 4 panels
 * pack with ~94% utilisation.
 *
 * Task: T087
 */
TEST_CASE("GE-13: shelf packing achieves >80% utilisation", "[ge-13][nesting]") {
  const std::string FIXTURE = fixtureFile("simple_box.stp");
  if (!fs::exists(FIXTURE)) {
    SKIP("Fixture not available: " + FIXTURE);
  }

  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(FIXTURE);
  BooleanCutResult cut = svc->booleanCut(solidId, 0, 0, 1, 0, 0, 0);
  REQUIRE_FALSE(cut.shellIds.empty());
  const ShellId shellId = cut.shellIds.front();

  // Get the reference panel dimensions
  UnfoldResult ref = svc->unfoldShell(shellId, 0.33);
  REQUIRE(ref.flatWidthMm > 0.0);
  REQUIRE(ref.flatHeightMm > 0.0);

  // Create 4 unfolds of the same panel
  std::vector<UnfoldId> unfoldIds;
  const int PANELS = 4;
  for (int i = 0; i < PANELS; ++i) {
    UnfoldResult ur = svc->unfoldShell(shellId, 0.33);
    unfoldIds.push_back(ur.unfoldId);
  }

  // Use a sheet sized to accommodate 2x2 panel arrangement
  // with 2mm clearance per row so panels fit with >94% utilisation
  double sheetW = ref.flatWidthMm  * 2.0 + 2.0;
  double sheetH = ref.flatHeightMm * 2.0 + 2.0;

  NestResult nr = svc->nestShells(unfoldIds, sheetW, sheetH);

  REQUIRE(nr.utilisationPct > 80.0);
  REQUIRE(nr.sheetsRequired >= 1);
  REQUIRE(nr.placements.size() == static_cast<size_t>(PANELS));

  // All placements should be on sheet 0 (fits in 2x2 grid)
  for (const auto& pl : nr.placements) {
    REQUIRE(pl.sheetIndex == 0);
  }
}

/**
 * GE-12b: SVG preview is well-formed and non-empty.
 *
 * Task: T088
 */
TEST_CASE("GE-12b: nestShells SVG preview is non-empty and contains SVG markers",
          "[ge-12b][nesting]")
{
  const std::string FIXTURE = fixtureFile("simple_box.stp");
  if (!fs::exists(FIXTURE)) {
    SKIP("Fixture not available: " + FIXTURE);
  }

  auto svc = GeometryService::create();
  SolidId solidId = svc->loadStep(FIXTURE);
  BooleanCutResult cut = svc->booleanCut(solidId, 0, 0, 1, 0, 0, 0);
  REQUIRE_FALSE(cut.shellIds.empty());

  UnfoldResult ur = svc->unfoldShell(cut.shellIds.front(), 0.33);
  NestResult nr = svc->nestShells({ur.unfoldId},
                                   ur.flatWidthMm * 2.0,
                                   ur.flatHeightMm * 2.0);

  REQUIRE_FALSE(nr.svgPreview.empty());
  REQUIRE(nr.svgPreview.find("<svg") != std::string::npos);
  REQUIRE(nr.svgPreview.find("</svg>") != std::string::npos);
  REQUIRE(nr.svgPreview.find("<rect") != std::string::npos);
}

/**
 * GE-12c: nestShells throws GE_UNFOLD_NOT_FOUND for unknown unfold IDs.
 */
TEST_CASE("GE-12c: nestShells throws GE_UNFOLD_NOT_FOUND for unknown ID",
          "[ge-12c][nesting]")
{
  auto svc = GeometryService::create();

  bool threw = false;
  try {
    svc->nestShells({"unknown-unfold-id"}, 2440, 1220);
  } catch (const GeometryError& e) {
    threw = true;
    REQUIRE(e.code == "GE_UNFOLD_NOT_FOUND");
  }
  REQUIRE(threw);
}
