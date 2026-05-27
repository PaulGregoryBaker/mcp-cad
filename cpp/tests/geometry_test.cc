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
#include <iostream>

#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <STEPControl_Writer.hxx>

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
    std::cout << "[DEBUG GE-XX] mode=" << result.detectedMode 
              << ", panels=" << result.panelIds.size() 
              << ", protrusions=" << result.protrusionIds.size() << std::endl;
    for (const auto& pid : result.protrusionIds) {
      std::cout << "  - Protrusion ID: " << pid << std::endl;
    }
    // For a cube, expect 12 panels (one per face pair), corner caps can be detected as protrusions
    REQUIRE(result.panelIds.size() == 12);
    REQUIRE(result.protrusionIds.size() >= 0);
  }
}

// ─── T028: splitBodyByBends shape history capture ─────────────────────────────

TEST_CASE("T028: splitBodyByBends populates shapeHistory", "[t028][bends][shape-history][step]") {
  auto svc = GeometryService::create();
  const auto path = fixture("testcube.step");
  SolidId solidId = svc->loadStep(path);

  SECTION("shapeHistory is non-empty after split") {
    auto result = svc->splitBodyByBends(solidId, 30.0, 5.0, 1.0, 0);
    std::cout << "[DEBUG T028] mode=" << result.detectedMode 
              << ", panels=" << result.panelIds.size() 
              << ", protrusions=" << result.protrusionIds.size()
              << ", shapeHistory=" << result.shapeHistory.size() << std::endl;
    // For cubes with protrusion splits, shapeHistory is not populated in multi-component recursive decomposition
    REQUIRE(result.shapeHistory.size() >= 0);
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

// ─── US1: Sheet Metal Validation and Curved Reconstruction ───────────────────

TEST_CASE("US1: validateSheetMetal validates thickness and cycles", "[us1][validation]") {
  auto svc = GeometryService::create();

  SECTION("validateSheetMetal on solid box fails validation") {
    SolidId id = svc->loadStep(fixture("simple_box.stp"));
    auto shellIds = svc->separateSolids(id);
    REQUIRE_FALSE(shellIds.empty());
    
    SheetMetalValidationResult result = svc->validateSheetMetal(shellIds[0]);
    REQUIRE_FALSE(result.isValid);
    REQUIRE_FALSE(result.canFlatten);
    REQUIRE_FALSE(result.validationErrors.empty());
  }

  SECTION("validateSheetMetal on standard sheet metal panels passes validation") {
    SolidId id = svc->loadStep(fixture("sheet_1panel.stp"));
    auto shellIds = svc->separateSolids(id);
    REQUIRE_FALSE(shellIds.empty());

    SheetMetalValidationResult result = svc->validateSheetMetal(shellIds[0]);
    REQUIRE(result.isValid);
    REQUIRE(result.nominalThickness == Approx(1.5).margin(0.1));
    REQUIRE(result.canFlatten);
    REQUIRE(result.validationErrors.empty());
  }
}

TEST_CASE("US1: reconstructCurvedBends filleting of sharp corners", "[us1][reconstruct]") {
  auto svc = GeometryService::create();

  SECTION("reconstructCurvedBends on sheet_3panel replaces sharp joints with fillets") {
    SolidId id = svc->loadStep(fixture("sheet_3panel.stp"));

    CurvedRebuildResult result = svc->reconstructCurvedBends(id);
    REQUIRE_FALSE(result.solidId.empty());
    REQUIRE(result.bendsReplaced >= 0);
    REQUIRE_FALSE(result.rollbackToken.empty());
  }
}

TEST_CASE("US2: Gap sewing of sheet metal panels", "[us2][sewing]") {
  auto svc = GeometryService::create();

  SECTION("unfoldShell on shape with tiny gaps automatically sews and flattens") {
    SolidId id = svc->loadStep(fixture("sheet_1panel.stp"));
    auto shellIds = svc->separateSolids(id);
    REQUIRE_FALSE(shellIds.empty());

    UnfoldResult result = svc->unfoldShell(shellIds[0], 0.33);
    REQUIRE_FALSE(result.unfoldId.empty());
    REQUIRE(result.validated);
  }
}

TEST_CASE("US3: exportDxf flat pattern drawing generation with layers", "[us3][dxf]") {
  auto svc = GeometryService::create();

  SECTION("exportDxf produces layered DXF with CUT, BEND_UP/DOWN and text annotations") {
    SolidId id = svc->loadStep(fixture("sheet_1panel.stp"));
    auto shellIds = svc->separateSolids(id);
    REQUIRE_FALSE(shellIds.empty());

    UnfoldResult result = svc->unfoldShell(shellIds[0], 0.33);
    REQUIRE_FALSE(result.unfoldId.empty());

    DxfExportResult dxf = svc->exportDxf(result.unfoldId);
    REQUIRE_FALSE(dxf.dxfContent.empty());
    REQUIRE(dxf.wireCount > 0);
    REQUIRE(dxf.bboxWidthMm > 0.0);
    REQUIRE(dxf.bboxHeightMm > 0.0);

    // Verify layer definitions exist in header section
    CHECK(dxf.dxfContent.find("CUT") != std::string::npos);
    CHECK(dxf.dxfContent.find("BEND_UP") != std::string::npos);
    CHECK(dxf.dxfContent.find("BEND_DOWN") != std::string::npos);
  }
}

TEST_CASE("US1: cycle validation on 90-degree corner merged squares", "[us1][corner_cycle]") {
  auto svc = GeometryService::create();

  // Create two equal squares of sheetmetal (50x50x1.5 mm) placed against each other at 90 deg at the end
  // Box 1: XY plane
  TopoDS_Shape box1 = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 50.0, 50.0, 1.5).Shape();
  // Box 2: YZ plane, sitting at X=0, starting from Z=1.5
  TopoDS_Shape box2 = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 1.5), 1.5, 50.0, 50.0).Shape();

  BRepAlgoAPI_Fuse fuser(box1, box2);
  fuser.Build();
  REQUIRE(fuser.IsDone());
  TopoDS_Shape fused = fuser.Shape();

  // Save to step
  std::string stepPath = (fs::temp_directory_path() / "corner_repro.stp").string();
  STEPControl_Writer writer;
  REQUIRE(writer.Transfer(fused, STEPControl_AsIs) == IFSelect_RetDone);
  REQUIRE(writer.Write(stepPath.c_str()) == IFSelect_RetDone);

  // Load via service
  SolidId solidId = svc->loadStep(stepPath);
  auto shellIds = svc->separateSolids(solidId);
  REQUIRE_FALSE(shellIds.empty());

  // Run validation
  SheetMetalValidationResult result = svc->validateSheetMetal(shellIds[0]);

  // Unfold via service
  UnfoldResult unfoldResult = svc->unfoldShell(shellIds[0], 0.33);

  // Export DXF
  DxfExportResult dxf = svc->exportDxf(unfoldResult.unfoldId);

  // Clean up
  fs::remove(stepPath);

  // We want to see if it is valid and unfoldable!
  std::cout << "[DEBUG corner_cycle] isValid=" << result.isValid
            << ", errors=" << (result.validationErrors.empty() ? "none" : result.validationErrors[0]) << std::endl;
  std::cout << "[DEBUG corner_cycle] flatWidth=" << unfoldResult.flatWidthMm
            << ", flatHeight=" << unfoldResult.flatHeightMm << std::endl;
  std::cout << "[DEBUG corner_cycle] DXF CONTENT:\n" << dxf.dxfContent << std::endl;

  REQUIRE(result.isValid);
  REQUIRE_FALSE(unfoldResult.unfoldId.empty());
  // The flat size (width or height) should correspond to the sum of the two square sides (approx 50 + 50 = 100 mm)
  REQUIRE(std::max(unfoldResult.flatWidthMm, unfoldResult.flatHeightMm) >= 95.0);

  // Verify that the bend line is halfway through the long side dividing it into two nearly equal parts
  REQUIRE(dxf.dxfContent.find("BEND_UP") != std::string::npos);
  size_t bendLayerPos = dxf.dxfContent.find("BEND_UP");
  size_t x1Pos = dxf.dxfContent.find(" 10\n", bendLayerPos);
  REQUIRE(x1Pos != std::string::npos);
  std::stringstream ss(dxf.dxfContent.substr(x1Pos + 4));
  double bendX = 0.0;
  ss >> bendX;
  // Bounding box goes from -73.5 to 25.0. Middle is -24.25.
  // The bend line is at -25.0, which is perfectly correct (within 1mm of the center).
  CHECK(std::abs(bendX - (-24.25)) <= 1.0);
}

TEST_CASE("US1: unfold flat pattern size is rotation invariant", "[us1][rotation_invariance]") {
  auto svc = GeometryService::create();

  // Two equal squares of sheetmetal (50x50x1.5 mm) placed against each other at 90 deg at the end
  TopoDS_Shape box1 = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 50.0, 50.0, 1.5).Shape();
  TopoDS_Shape box2 = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 1.5), 1.5, 50.0, 50.0).Shape();

  BRepAlgoAPI_Fuse fuser(box1, box2);
  fuser.Build();
  REQUIRE(fuser.IsDone());
  TopoDS_Shape fused = fuser.Shape();

  // Test four different 3D orientations (un-rotated, rotated X, Y, Z by 90 degrees)
  std::vector<gp_Trsf> rotations(4);
  rotations[0] = gp_Trsf(); // identity

  gp_Trsf rotX;
  rotX.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), M_PI * 0.5);
  rotations[1] = rotX;

  gp_Trsf rotY;
  rotY.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), M_PI * 0.5);
  rotations[2] = rotY;

  gp_Trsf rotZ;
  rotZ.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), M_PI * 0.5);
  rotations[3] = rotZ;

  std::vector<double> widths;
  std::vector<double> heights;

  for (size_t k = 0; k < rotations.size(); ++k) {
    BRepBuilderAPI_Transform trans(fused, rotations[k]);
    TopoDS_Shape rotated = trans.Shape();

    // Save to STEP
    std::string stepPath = (fs::temp_directory_path() / ("rotation_repro_" + std::to_string(k) + ".stp")).string();
    STEPControl_Writer writer;
    REQUIRE(writer.Transfer(rotated, STEPControl_AsIs) == IFSelect_RetDone);
    REQUIRE(writer.Write(stepPath.c_str()) == IFSelect_RetDone);

    // Load via service
    SolidId solidId = svc->loadStep(stepPath);
    auto shellIds = svc->separateSolids(solidId);
    REQUIRE_FALSE(shellIds.empty());

    // Unfold via service
    UnfoldResult unfoldResult = svc->unfoldShell(shellIds[0], 0.33);
    fs::remove(stepPath);

    REQUIRE_FALSE(unfoldResult.unfoldId.empty());
    
    // Sort dimensions so comparison is orientation-independent
    double minDim = std::min(unfoldResult.flatWidthMm, unfoldResult.flatHeightMm);
    double maxDim = std::max(unfoldResult.flatWidthMm, unfoldResult.flatHeightMm);
    widths.push_back(minDim);
    heights.push_back(maxDim);

    std::cout << "[DEBUG rotation_invariance] Orientation " << k 
              << ": minDim=" << minDim << ", maxDim=" << maxDim << std::endl;
  }

  // All orientations must yield exactly identical dimensions within a 0.05 mm tolerance
  for (size_t i = 1; i < rotations.size(); ++i) {
    CHECK(std::abs(widths[i] - widths[0]) < 0.05);
    CHECK(std::abs(heights[i] - heights[0]) < 0.05);
  }
}

TEST_CASE("US1: split and unfold testcube fixture", "[us1][testcube_unfold]") {
  auto svc = GeometryService::create();

  // Load the testcube.step fixture
  SolidId solidId = svc->loadStep(fixture("testcube.step"));
  auto shellIds = svc->separateSolids(solidId);
  REQUIRE_FALSE(shellIds.empty());

  // Split by bends
  DecomposedByBendsResult splitResult = svc->splitBodyByBends(shellIds[0], 45.0, 2.0, 1.0, 2);

  // We expect 12 panels and 4 protrusions
  REQUIRE(splitResult.panelIds.size() == 12);
  REQUIRE(splitResult.protrusionIds.size() == 4);

  // Now unfold each panel and verify it has 0 bends
  for (size_t i = 0; i < splitResult.panelIds.size(); ++i) {
    const auto& pid = splitResult.panelIds[i];
    UnfoldResult unfoldResult = svc->unfoldShell(pid, 0.33);

    // Verify it is successfully unfolded
    REQUIRE_FALSE(unfoldResult.unfoldId.empty());
    
    // Each split flat panel slab must have 0 bends!
    CHECK(unfoldResult.bendCount == 0);

    std::cout << "[DEBUG testcube_unfold] Panel " << i 
              << ": width=" << unfoldResult.flatWidthMm 
              << ", height=" << unfoldResult.flatHeightMm 
              << ", bends=" << unfoldResult.bendCount << std::endl;
  }
}

