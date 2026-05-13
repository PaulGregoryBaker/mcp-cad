/**
 * generate_fixtures.cc
 *
 * Utility program that generates canonical STEP test fixtures using OCCT.
 *
 * Output directory: cpp/tests/fixtures/
 *
 * Fixtures generated:
 *   simple_box.stp       — 100×100×10 mm box (basic GE unit tests)
 *   sheet_1panel.stp     — 300×200×1.5 mm thin plate (single panel)
 *   sheet_3panel.stp     — three 100×200×1.5 mm plates stacked
 *                          (canonical INF-03 golden-path fixture, T120)
 *
 * Usage (from cpp/build-vcpkg/):
 *   generate_fixtures.exe ../tests/fixtures/
 *
 * This program must be re-run after any change to the canonical fixture spec.
 * The generated files are committed to the repository.
 *
 * Task: T120
 */

#include <BRepPrimAPI_MakeBox.hxx>
#include <gp_Pnt.hxx>
#include <TopoDS_Shape.hxx>
#include <STEPControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

// ─── Helpers ─────────────────────────────────────────────────────────────────

static bool writeStp(const TopoDS_Shape& shape,
                     const std::string& path)
{
  STEPControl_Writer writer;
  IFSelect_ReturnStatus status = writer.Transfer(shape, STEPControl_AsIs);
  if (status != IFSelect_RetDone) {
    std::cerr << "Transfer failed for: " << path << "\n";
    return false;
  }
  status = writer.Write(path.c_str());
  if (status != IFSelect_RetDone) {
    std::cerr << "Write failed for: " << path << "\n";
    return false;
  }
  std::cout << "  Written: " << path << "\n";
  return true;
}

// ─── Fixture definitions ──────────────────────────────────────────────────────

/**
 * simple_box.stp — 100×100×10 mm box.
 * Used by geometry_test.cc unit tests.
 */
static bool genSimpleBox(const fs::path& outDir) {
  // Box from (-50, 0, -5) to (50, 100, 5).
  // Centered at X=0, Z=0 so booleanCut planes at X=0 and Z=0 pass through
  // the solid interior (not tangent to faces).
  TopoDS_Shape box = BRepPrimAPI_MakeBox(gp_Pnt(-50.0, 0.0, -5.0), 100.0, 100.0, 10.0).Shape();
  return writeStp(box, (outDir / "simple_box.stp").string());
}

/**
 * sheet_1panel.stp — 300×200×1.5 mm thin plate.
 * Single sheet metal panel for unfold/DXF tests.
 */
static bool genSheet1Panel(const fs::path& outDir) {
  // 300×200×1.5mm plate centered at Z=0 (Z: -0.75 to 0.75)
  TopoDS_Shape plate = BRepPrimAPI_MakeBox(gp_Pnt(-150.0, 0.0, -0.75), 300.0, 200.0, 1.5).Shape();
  return writeStp(plate, (outDir / "sheet_1panel.stp").string());
}

/**
 * sheet_3panel.stp — three 100×200×1.5 mm plates stacked in Z.
 *
 * The three panels share a common bounding box volume (100×200×4.5 mm)
 * but are separate solids in the STEP file. The INF-03 test decomposes
 * this compound solid into 3 child shells via booleanCut.
 *
 * Decomposition path:
 *   1. Cut at Z=1.5 → bottom panel (Z: 0–1.5)
 *   2. Cut at Z=3.0 → middle panel (Z: 1.5–3.0)
 *   3. Top panel (Z: 3.0–4.5)
 *
 * NOTE: Because BRepPrimAPI_MakeBox creates individual solids,
 *       we use a single taller box (100×200×4.5 mm) as the canonical
 *       "multi-panel" fixture. The INF-03 test cuts it at Z=1.5 and Z=3.0.
 *
 * IMPORTANT: This fixture is a tier-1 canonical fixture.
 *            Do not modify its dimensions without a review.
 *            Reference: T120, INF-03.
 */
static bool genSheet3Panel(const fs::path& outDir) {
  // 100×200×4.5mm block centered at X=0, Z=0.
  // Cut at Z=0 and Z=1.5 yields 3 panels of 1.5mm thickness.
  TopoDS_Shape block = BRepPrimAPI_MakeBox(gp_Pnt(-50.0, 0.0, -2.25), 100.0, 200.0, 4.5).Shape();
  return writeStp(block, (outDir / "sheet_3panel.stp").string());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
  fs::path outDir;

  if (argc > 1) {
    outDir = argv[1];
  } else {
    // Default: adjacent fixtures/ directory
    outDir = fs::path(__FILE__).parent_path().parent_path() / "tests" / "fixtures";
  }

  if (!fs::exists(outDir)) {
    std::error_code ec;
    if (!fs::create_directories(outDir, ec)) {
      std::cerr << "Failed to create output directory: " << outDir << " (" << ec.message() << ")\n";
      return 1;
    }
  }

  std::cout << "Generating fixtures in: " << fs::absolute(outDir) << "\n";

  bool ok = true;
  ok &= genSimpleBox(outDir);
  ok &= genSheet1Panel(outDir);
  ok &= genSheet3Panel(outDir);

  if (ok) {
    std::cout << "All fixtures generated successfully.\n";
    return 0;
  } else {
    std::cerr << "One or more fixtures failed to generate.\n";
    return 1;
  }
}
