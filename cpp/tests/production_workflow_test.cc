#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <sstream>
#include <cmath>
#include <filesystem>

#include "geometry/geometry_service.hpp"

#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <STEPControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>

namespace fs = std::filesystem;
using namespace mcp_cad;

namespace {

std::string fixtureDir() {
  return (fs::path(__FILE__).parent_path() / "fixtures").string();
}

std::string fixture(const std::string& name) {
  fs::path p = fs::path(fixtureDir()) / name;
  if (!fs::exists(p)) {
    SKIP("Fixture missing: " + p.string());
  }
  return p.string();
}

struct DxfLine { double x1, y1, x2, y2; std::string layer; };

std::vector<DxfLine> parseDxfLines(const std::string& dxf) {
  std::vector<DxfLine> result;
  std::istringstream iss(dxf);
  std::string tok, val;
  std::string layer;
  double x1=0, y1=0, x2=0, y2=0;
  bool inLine = false;

  auto trim = [](std::string s) {
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();
    auto start = s.find_first_not_of(" \t");
    return start == std::string::npos ? std::string{} : s.substr(start);
  };

  while (std::getline(iss, tok)) {
    tok = trim(tok);
    if (tok == "LINE") { inLine = true; x1=y1=x2=y2=0; layer.clear(); continue; }
    if (!inLine) continue;
    if (!std::getline(iss, val)) break;
    val = trim(val);
    if (tok == "0") {
      // Entity terminator: the value is the type of the NEXT entity.
      // If the next entity is also a LINE, start it immediately so we don't
      // skip it (the old code set inLine=false unconditionally and lost the
      // "LINE" keyword, causing every second LINE entity to be silently skipped).
      if (val == "LINE") { x1=y1=x2=y2=0; layer.clear(); /* inLine stays true */ }
      else               { inLine = false; }
    }
    else if (tok == "8")  { layer = val; }
    else if (tok == "10") { x1 = std::stod(val); }
    else if (tok == "20") { y1 = std::stod(val); }
    else if (tok == "11") { x2 = std::stod(val); }
    else if (tok == "21") { y2 = std::stod(val); result.push_back({x1,y1,x2,y2,layer}); }
  }
  return result;
}

// Returns true when segment a and b are parallel and share the same infinite line
// within perpTol, and their projections overlap by at least minOverlap mm.
bool segmentsCoincident(const DxfLine& a, const DxfLine& b,
                        double perpTol = 0.3,
                        double parallelCos = 0.99,
                        double minOverlap = 0.3) {
  double dax=a.x2-a.x1, day=a.y2-a.y1;
  double dbx=b.x2-b.x1, dby=b.y2-b.y1;
  double la=std::hypot(dax,day), lb=std::hypot(dbx,dby);
  if (la<0.01 || lb<0.01) return false;
  if (std::abs((dax*dbx+day*dby)/(la*lb)) < parallelCos) return false;
  double ux=dax/la, uy=day/la;
  double perp = std::abs((b.x1-a.x1)*(-uy)+(b.y1-a.y1)*ux);
  if (perp > perpTol) return false;
  auto proj = [&](double px, double py){ return (px-a.x1)*ux+(py-a.y1)*uy; };
  double b0=proj(b.x1,b.y1), b1p=proj(b.x2,b.y2);
  if (b0>b1p) std::swap(b0,b1p);
  return (std::min(la,b1p)-std::max(0.0,b0)) >= minOverlap;
}

// Fails the test if any CUT segment coincides with a BEND_UP / BEND_DOWN segment.
void assertNoCutOnBend(const std::string& dxfContent, const std::string& label) {
  auto lines = parseDxfLines(dxfContent);
  std::vector<DxfLine> cutLines, bendLines;
  for (const auto& s : lines) {
    if (s.layer == "CUT") cutLines.push_back(s);
    else if (s.layer == "BEND_UP" || s.layer == "BEND_DOWN") bendLines.push_back(s);
  }
  for (size_t ci=0; ci<cutLines.size(); ++ci) {
    for (size_t bi=0; bi<bendLines.size(); ++bi) {
      if (segmentsCoincident(cutLines[ci], bendLines[bi])) {
        FAIL_CHECK("CUT[" << ci << "] overlaps " << bendLines[bi].layer
                   << "[" << bi << "] in " << label
                   << " — cut=(" << cutLines[ci].x1 << "," << cutLines[ci].y1
                   << ")->(" << cutLines[ci].x2 << "," << cutLines[ci].y2 << ")"
                   << " bend=(" << bendLines[bi].x1 << "," << bendLines[bi].y1
                   << ")->(" << bendLines[bi].x2 << "," << bendLines[bi].y2 << ")");
      }
    }
  }
}

}  // namespace

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CAPTURE: Testcube Panel 1_panel_1 + Panel 1_panel_2 merge
//
// This test loads testcube.step, decomposes it via splitBodyByBends, and merges
// the first two outer panels (Panel 1_panel_1 and Panel 1_panel_2) at 90°.
// These panels are 200×200mm outer faces matching user's FormAI-tion workflow.
//
// Expected flat pattern: ~399×200mm with 1 bend centerline
// Regression check: CUT lines should NOT overlap BEND_UP/BEND_DOWN centerlines
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Regression: testcube Panel 1 merge produces CUT-on-BEND overlaps",
          "[prod][regression][dxf][testcube]") {
  auto svc = GeometryService::create();

  // Load and decompose testcube
  std::string tcPath = fixture("testcube.step");
  SolidId tcId = svc->loadStep(tcPath);
  REQUIRE_FALSE(tcId.empty());

  std::cout << "[REGRESSION] Decomposing testcube...\n";
  auto decomposed = svc->splitBodyByBends(tcId, 30.0, 5.0, 1.0, 50);
  std::cout << "[REGRESSION] Decomposed into " << decomposed.panelIds.size() << " panels\n";
  REQUIRE(decomposed.panelIds.size() >= 2);

  // The first two panel IDs are the ones we want to merge
  std::vector<ShellId> allShells;
  for (size_t i = 0; i < std::min(size_t(2), decomposed.panelIds.size()); ++i) {
    allShells.push_back(decomposed.panelIds[i]);
    std::cout << "[REGRESSION] Panel " << i << " shell: " << decomposed.panelIds[i] << "\n";
  }

  // Merge first two panels (Panel 1_panel_1 and Panel 1_panel_2)
  REQUIRE(allShells.size() >= 2);
  std::cout << "[REGRESSION] Merging first two panels...\n";
  MergeBodyResult merged = svc->mergeBodiesWithBend(allShells[0], allShells[1], {"all"}, 0.75);
  REQUIRE_FALSE(merged.mergedShellId.empty());

  // Unfold the merged geometry
  UnfoldResult unfold = svc->unfoldShell(merged.mergedShellId, 0.33);
  REQUIRE_FALSE(unfold.unfoldId.empty());
  REQUIRE(unfold.bendCount == 1);  // Should have exactly 1 bend

  std::cout << "[REGRESSION] Merged panel flat=" << unfold.flatWidthMm
            << "x" << unfold.flatHeightMm << " bends=" << unfold.bendCount << "\n";

  // Export to DXF
  DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);
  REQUIRE_FALSE(dxf.dxfContent.empty());

  // Parse and check for CUT-on-BEND overlaps
  auto lines = parseDxfLines(dxf.dxfContent);
  std::vector<DxfLine> cutLines, bendLines;
  for (const auto& seg : lines) {
    if (seg.layer == "CUT") cutLines.push_back(seg);
    else if (seg.layer == "BEND_UP" || seg.layer == "BEND_DOWN") bendLines.push_back(seg);
  }

  std::cout << "[REGRESSION] DXF has " << cutLines.size() << " CUT lines, "
            << bendLines.size() << " BEND lines\n";

  // Sanity check: the raw DXF string must contain the BEND layer name.
  bool rawHasBend = dxf.dxfContent.find("BEND_UP") != std::string::npos ||
                    dxf.dxfContent.find("BEND_DOWN") != std::string::npos;
  std::cout << "[REGRESSION] Raw DXF contains BEND layer: " << (rawHasBend ? "YES" : "NO") << "\n";
  INFO("DXF content has no BEND_UP or BEND_DOWN layer text at all");
  REQUIRE(rawHasBend);

  // Must have at least one bend line parsed (regression: parser was skipping every
  // second LINE entity, causing the BEND line to be silently dropped).
  INFO("Expected >= 1 BEND line in parsed DXF (flatBendEdges empty or parser bug)");
  REQUIRE(bendLines.size() >= 1);

  // ──── OUTLINE INTEGRITY CHECKS ────
  // Verify the outline is not distorted (should be a clean rectangle)
  std::cout << "[REGRESSION] Outline verification:\n";
  
  // Expected dimensions for two 200×200 panels merged at 90°
  double expectedWidth = 398.55;   // ~200 + 200 + negligible bend thickness
  double expectedHeight = 200.0;
  double tolDim = 1.0;  // 1mm tolerance on dimensions
  
  // Check unfolded dimensions match expectation
  std::cout << "  Expected: " << expectedWidth << "×" << expectedHeight << " mm\n";
  std::cout << "  Actual:   " << unfold.flatWidthMm << "×" << unfold.flatHeightMm << " mm\n";
  REQUIRE(std::abs(unfold.flatWidthMm - expectedWidth) < tolDim);
  REQUIRE(std::abs(unfold.flatHeightMm - expectedHeight) < tolDim);

  // Collect unique X and Y coordinates from CUT lines (outer boundary)
  std::vector<double> xCoords, yCoords;
  for (const auto& cut : cutLines) {
    xCoords.push_back(cut.x1); xCoords.push_back(cut.x2);
    yCoords.push_back(cut.y1); yCoords.push_back(cut.y2);
  }
  std::sort(xCoords.begin(), xCoords.end());
  std::sort(yCoords.begin(), yCoords.end());
  xCoords.erase(std::unique(xCoords.begin(), xCoords.end()), xCoords.end());
  yCoords.erase(std::unique(yCoords.begin(), yCoords.end()), yCoords.end());

  std::cout << "  X range: " << (xCoords.empty() ? 0 : xCoords.front()) << " to " 
            << (xCoords.empty() ? 0 : xCoords.back()) << " mm\n";
  std::cout << "  Y range: " << (yCoords.empty() ? 0 : yCoords.front()) << " to " 
            << (yCoords.empty() ? 0 : yCoords.back()) << " mm\n";

  // Rectangle check: expect 4 corners (min/max X and min/max Y)
  REQUIRE(xCoords.size() >= 2);  // At least min and max X
  REQUIRE(yCoords.size() >= 2);  // At least min and max Y
  
  double minX = xCoords.front(), maxX = xCoords.back();
  double minY = yCoords.front(), maxY = yCoords.back();
  
  // Verify width and height from coordinate ranges
  REQUIRE(std::abs((maxX - minX) - expectedWidth) < tolDim);
  REQUIRE(std::abs((maxY - minY) - expectedHeight) < tolDim);

  // Check all CUT line segments are either horizontal or vertical (no diagonal distortion)
  int horizontalEdges = 0, verticalEdges = 0, diagonalEdges = 0;
  double tolAngle = 5.0;  // degrees tolerance for "horizontal" or "vertical"
  for (const auto& cut : cutLines) {
    double dx = cut.x2 - cut.x1;
    double dy = cut.y2 - cut.y1;
    double angle = std::atan2(std::abs(dy), std::abs(dx)) * 180.0 / M_PI;  // 0-90 degrees
    
    if (angle < tolAngle) horizontalEdges++;
    else if (angle > (90.0 - tolAngle)) verticalEdges++;
    else diagonalEdges++;
  }
  std::cout << "  Edge orientation: " << horizontalEdges << " horizontal, " 
            << verticalEdges << " vertical, " << diagonalEdges << " diagonal\n";
  
  // All outline edges should be axis-aligned (horizontal or vertical) — no diagonal distortion
  REQUIRE(diagonalEdges == 0);  // Should have NO diagonal edges in outline

  // Debug output: print all CUT and BEND coordinates
  std::cout << "[REGRESSION] CUT lines:\n";
  for (size_t ci = 0; ci < cutLines.size(); ++ci) {
    std::cout << "  [" << ci << "] (" << cutLines[ci].x1 << "," << cutLines[ci].y1 
              << ") -> (" << cutLines[ci].x2 << "," << cutLines[ci].y2 << ")\n";
  }
  std::cout << "[REGRESSION] BEND lines:\n";
  for (size_t bi = 0; bi < bendLines.size(); ++bi) {
    std::cout << "  [" << bi << "] layer=" << bendLines[bi].layer 
              << " (" << bendLines[bi].x1 << "," << bendLines[bi].y1 
              << ") -> (" << bendLines[bi].x2 << "," << bendLines[bi].y2 << ")\n";
  }

  // Check 1: No CUT line should coincide with or be very close to any BEND line
  int overlapsFound = 0;
  double maxPermittedOffset = 1.0;  // mm - catch the ~0.7mm offset observed in screenshot
  
  for (size_t ci = 0; ci < cutLines.size(); ++ci) {
    for (size_t bi = 0; bi < bendLines.size(); ++bi) {
      // Check if CUT and BEND share the same location/direction
      double dax=cutLines[ci].x2-cutLines[ci].x1, day=cutLines[ci].y2-cutLines[ci].y1;
      double dbx=bendLines[bi].x2-bendLines[bi].x1, dby=bendLines[bi].y2-bendLines[bi].y1;
      double la=std::hypot(dax,day), lb=std::hypot(dbx,dby);
      
      if (la<0.01 || lb<0.01) continue;
      
      // Check if parallel (same or opposite direction)
      double cosAngle = std::abs((dax*dbx+day*dby)/(la*lb));
      if (cosAngle < 0.95) continue;  // Not parallel
      
      // If parallel, check perpendicular distance
      double ux=dax/la, uy=day/la;
      double perpDist = std::abs((bendLines[bi].x1-cutLines[ci].x1)*(-uy)+(bendLines[bi].y1-cutLines[ci].y1)*ux);
      
      if (perpDist < maxPermittedOffset) {
        overlapsFound++;
        std::cout << "[REGRESSION] ERROR: CUT[" << ci << "] is parallel and close to BEND[" << bi 
                  << "] (perpendicular distance: " << perpDist << " mm)\n";
        std::cout << "           CUT:  (" << cutLines[ci].x1 << "," << cutLines[ci].y1 
                  << ") -> (" << cutLines[ci].x2 << "," << cutLines[ci].y2 << ")\n";
        std::cout << "           BEND: (" << bendLines[bi].x1 << "," << bendLines[bi].y1 
                  << ") -> (" << bendLines[bi].x2 << "," << bendLines[bi].y2 << ")\n";
      }
    }
  }

  if (overlapsFound > 0) {
    std::cout << "[REGRESSION] **FAILURE**: Found " << overlapsFound 
              << " CUT line(s) coinciding with BEND lines\n";
    std::cout << "[REGRESSION] Problem: CUT lines should NOT exist where bends occur\n";
  } else {
    std::cout << "[REGRESSION] **PASS**: No CUT lines coincide with BEND lines\n";
  }

  // This test should FAIL when regression exists
  REQUIRE(overlapsFound == 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression: 90° merged-panel DXF (150×150×1.95 mm — matches testcube panels)
//
// Two 150×150×1.95mm flat panels are merged at 90° (matching the dimensions
// of testcube.step faces), then unfolded and exported. This provides a clean
// minimal case for validating the fix.
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Validation: 150x150 merged-panel DXF has no CUT overlapping BEND lines",
          "[prod][validation][dxf][merge]") {
  auto svc = GeometryService::create();

  // Geometry matching testcube face dimensions
  constexpr double W = 150.0, H = 150.0, T = 1.95;
  TopoDS_Shape box1 = BRepPrimAPI_MakeBox(gp_Pnt(0,0,0),   W, H, T).Shape();
  TopoDS_Shape box2 = BRepPrimAPI_MakeBox(gp_Pnt(0,0,T),   T, H, W).Shape();

  auto writeTmp = [](const TopoDS_Shape& s, const std::string& path) {
    STEPControl_Writer w;
    REQUIRE(w.Transfer(s, STEPControl_AsIs) == IFSelect_RetDone);
    REQUIRE(w.Write(path.c_str()) == IFSelect_RetDone);
  };

  auto tmp1 = (fs::temp_directory_path() / "val_box1.stp").string();
  auto tmp2 = (fs::temp_directory_path() / "val_box2.stp").string();
  writeTmp(box1, tmp1);
  writeTmp(box2, tmp2);

  SolidId id1 = svc->loadStep(tmp1);
  SolidId id2 = svc->loadStep(tmp2);
  fs::remove(tmp1); fs::remove(tmp2);

  auto shells1 = svc->separateSolids(id1);
  auto shells2 = svc->separateSolids(id2);
  REQUIRE_FALSE(shells1.empty());
  REQUIRE_FALSE(shells2.empty());

  // Merge — this is the exact mergeBodiesWithBend path the user executes
  MergeBodyResult merged = svc->mergeBodiesWithBend(shells1[0], shells2[0], {"all"}, 2.0);
  REQUIRE_FALSE(merged.mergedShellId.empty());

  UnfoldResult unfold = svc->unfoldShell(merged.mergedShellId, 0.33);
  REQUIRE_FALSE(unfold.unfoldId.empty());
  REQUIRE(unfold.bendCount == 1);

  DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);
  REQUIRE_FALSE(dxf.dxfContent.empty());
  REQUIRE(dxf.dxfContent.find("BEND_UP") != std::string::npos);
  REQUIRE(dxf.dxfContent.find("CUT")     != std::string::npos);

  assertNoCutOnBend(dxf.dxfContent, "150x150_merge");
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression: Panel-with-protrusion merge produces correct flat dimensions
//
// PanelA (174×150×T) is built by fusing a 150×150×T base with a 24×150×T
// protrusion at its far edge — matching the user's workflow of translating an
// inner-cube panel to align with an edge and performing a union fuse.  PanelB
// is a plain 150×150×T panel standing up at 90° from panelA's left edge.
//
// Correct flat: ≈(174 + 150 + BA) × 150 mm  ≈  327 × 150 mm
// Buggy flat:   ≈174 × 151 mm  (UV-overlap collapses both panels to one footprint)
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Regression: panel-with-protrusion merge produces correct flat dimensions",
          "[prod][regression][protrusion]") {
  auto svc = GeometryService::create();

  // PanelA: 150×150×T base with a 24×150×T protrusion fused at x=150
  // → combined footprint 174×150×T
  constexpr double W = 150.0, H = 150.0, T = 1.95, P = 24.0;
  TopoDS_Shape panelA_base  = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), W, H, T).Shape();
  TopoDS_Shape panelA_protr = BRepPrimAPI_MakeBox(gp_Pnt(W, 0, 0), P, H, T).Shape();
  BRepAlgoAPI_Fuse fuseA(panelA_base, panelA_protr);
  fuseA.Build();
  REQUIRE(fuseA.IsDone());
  TopoDS_Shape panelA = fuseA.Shape();

  // PanelB: plain 150×150×T standing up at 90° — its bottom (z=T) touches
  // the leftmost portion of panelA's top face, forming the bend interface.
  TopoDS_Shape panelB = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, T), T, H, W).Shape();

  auto writeTmp = [](const TopoDS_Shape& s, const std::string& path) {
    STEPControl_Writer w;
    REQUIRE(w.Transfer(s, STEPControl_AsIs) == IFSelect_RetDone);
    REQUIRE(w.Write(path.c_str()) == IFSelect_RetDone);
  };

  auto tmpA = (fs::temp_directory_path() / "reg_protr_panelA.stp").string();
  auto tmpB = (fs::temp_directory_path() / "reg_protr_panelB.stp").string();
  writeTmp(panelA, tmpA);
  writeTmp(panelB, tmpB);

  SolidId idA = svc->loadStep(tmpA);
  SolidId idB = svc->loadStep(tmpB);
  fs::remove(tmpA);
  fs::remove(tmpB);

  auto shellsA = svc->separateSolids(idA);
  auto shellsB = svc->separateSolids(idB);
  REQUIRE_FALSE(shellsA.empty());
  REQUIRE_FALSE(shellsB.empty());

  // Merge with 1 mm bend radius (matching the user's test scenario)
  MergeBodyResult merged = svc->mergeBodiesWithBend(shellsA[0], shellsB[0], {"all"}, 1.0);
  REQUIRE_FALSE(merged.mergedShellId.empty());

  // Unfold — must produce exactly 1 bend
  UnfoldResult unfold = svc->unfoldShell(merged.mergedShellId, 0.33);
  REQUIRE_FALSE(unfold.unfoldId.empty());

  std::cout << "[REGRESSION protrusion] flat=" << unfold.flatWidthMm
            << "x" << unfold.flatHeightMm << "mm  bends=" << unfold.bendCount << "\n";
  REQUIRE(unfold.bendCount == 1);

  // Expected flat dimensions:
  //   BA = (innerR + T/2) * pi/2 = (1.0 + 0.975) * 1.5708 ≈ 3.1 mm
  //   Width  = (W + P) + W + BA = 174 + 150 + 3.1 ≈ 327 mm
  //   Height = H = 150 mm
  const double BA        = (1.0 + T / 2.0) * M_PI / 2.0;  // ≈3.1 mm
  const double expWidth  = (W + P) + W + BA;               // ≈327 mm
  const double expHeight = H;                              // 150 mm
  const double tol       = 5.0;                            // mm

  double flatMax = std::max(unfold.flatWidthMm, unfold.flatHeightMm);
  double flatMin = std::min(unfold.flatWidthMm, unfold.flatHeightMm);
  std::cout << "[REGRESSION protrusion] expected ≈ " << expWidth << "x" << expHeight << "mm\n";

  // Both checks fail when UV-overlap collapses the flat to ~174×151 mm
  CHECK(std::abs(flatMax - expWidth)  < tol);
  CHECK(std::abs(flatMin - expHeight) < tol);

  // DXF integrity: no CUT line may coincide with a BEND line
  DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);
  REQUIRE_FALSE(dxf.dxfContent.empty());
  assertNoCutOnBend(dxf.dxfContent, "protrusion_panel_merge");
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression: fuseBodies-then-bend flat pattern (service-level fuse workflow)
//
// Reproduces the exact MCP tool chain the UI runs:
//   fuse_bodies([panelA_base, protrusion]) → fusedPanel
//   merge_bodies_with_bend(fusedPanel, panelB, "all", 1.0)
//   unfold_shell(merged)
//
// PanelA_base  = 150×150×T (first inner panel)
// Protrusion   = 24×150×T  (extension translated to x=150 edge)
// fusedPanel   = 174×150×T (combined)
// PanelB       = 150×150×T at 90° from fusedPanel's x=0 edge
//
// Correct flat ≈ (174 + 150 + BA) × 150 mm.  Buggy flat ≈ 174×151 mm.
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Regression: fuseBodies-then-bend produces correct flat dimensions",
          "[prod][regression][protrusion][fuse_bodies]") {
  auto svc = GeometryService::create();

  constexpr double W = 150.0, H = 150.0, T = 1.95, P = 24.0;
  TopoDS_Shape base_shape  = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), W, H, T).Shape();
  TopoDS_Shape protr_shape = BRepPrimAPI_MakeBox(gp_Pnt(W, 0, 0), P, H, T).Shape();
  TopoDS_Shape panelB_shp  = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, T), T, H, W).Shape();

  auto writeTmp = [](const TopoDS_Shape& s, const std::string& path) {
    STEPControl_Writer w;
    REQUIRE(w.Transfer(s, STEPControl_AsIs) == IFSelect_RetDone);
    REQUIRE(w.Write(path.c_str()) == IFSelect_RetDone);
  };

  auto tmpBase  = (fs::temp_directory_path() / "fuse_base.stp").string();
  auto tmpProtr = (fs::temp_directory_path() / "fuse_protr.stp").string();
  auto tmpB     = (fs::temp_directory_path() / "fuse_panelB.stp").string();
  writeTmp(base_shape,  tmpBase);
  writeTmp(protr_shape, tmpProtr);
  writeTmp(panelB_shp,  tmpB);

  SolidId idBase  = svc->loadStep(tmpBase);
  SolidId idProtr = svc->loadStep(tmpProtr);
  SolidId idB     = svc->loadStep(tmpB);
  fs::remove(tmpBase); fs::remove(tmpProtr); fs::remove(tmpB);

  auto shellsBase  = svc->separateSolids(idBase);
  auto shellsProtr = svc->separateSolids(idProtr);
  auto shellsB     = svc->separateSolids(idB);
  REQUIRE_FALSE(shellsBase.empty());
  REQUIRE_FALSE(shellsProtr.empty());
  REQUIRE_FALSE(shellsB.empty());

  // Step 1: fuse_bodies (flat coplanar union — same code path as the MCP tool)
  FuseResult fused = svc->fuseBodies({shellsBase[0], shellsProtr[0]}, 0.0);
  REQUIRE_FALSE(fused.solidId.empty());

  // Step 2: merge_bodies_with_bend (90° bend — same code path as the MCP tool)
  MergeBodyResult merged = svc->mergeBodiesWithBend(fused.solidId, shellsB[0], {"all"}, 1.0);
  REQUIRE_FALSE(merged.mergedShellId.empty());

  // Step 3: unfold
  UnfoldResult unfold = svc->unfoldShell(merged.mergedShellId, 0.33);
  REQUIRE_FALSE(unfold.unfoldId.empty());

  std::cout << "[REGRESSION fuse_bodies_then_bend] flat=" << unfold.flatWidthMm
            << "x" << unfold.flatHeightMm << "mm  bends=" << unfold.bendCount << "\n";
  REQUIRE(unfold.bendCount == 1);

  const double BA        = (1.0 + T / 2.0) * M_PI / 2.0;  // ≈3.1 mm
  const double expWidth  = (W + P) + W + BA;               // ≈327 mm
  const double expHeight = H;                              // 150 mm
  const double tol       = 5.0;

  double flatMax = std::max(unfold.flatWidthMm, unfold.flatHeightMm);
  double flatMin = std::min(unfold.flatWidthMm, unfold.flatHeightMm);
  std::cout << "[REGRESSION fuse_bodies_then_bend] expected ≈ " << expWidth << "x" << expHeight << "mm\n";

  // Both CHECKs fail when UV-overlap collapses the flat to ~174×151 mm
  CHECK(std::abs(flatMax - expWidth)  < tol);
  CHECK(std::abs(flatMin - expHeight) < tol);

  // DXF integrity
  DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);
  REQUIRE_FALSE(dxf.dxfContent.empty());
  assertNoCutOnBend(dxf.dxfContent, "fuse_bodies_then_bend");
}

// ─────────────────────────────────────────────────────────────────────────────
// Regression: testcube inner-panel + real protrusion produces correct flat
//
// This is the EXACT workflow the UI performs:
//   splitBodyByBends(testcube) → panelIds, protrusionIds
//   translateBody(protrusion[2], dx=73.6, 0, 0, keepOriginal=true)
//   fuseBodies([panel[7], translatedProtrusion], 0.15) → 150×174mm vertical panel
//   mergeBodiesWithBend(fusedPanel, panel[6], "all", 1.0) → 3D L-bracket
//   unfoldShell(merged)
//
// Panel geometry (from splitBodyByBends):
//   panel[7]:      x=[73.55,75], y=[-75,75],   z=[-75,75]   (right face, 1.45×150×150)
//   protrusion[2]: x=[-0.05,1.05], y=[74.95,99.05], z=[-75.05,75.05] (1.1×24×150)
//   panel[6]:      x=[-75,75],  y=[73.55,75],  z=[-75,75]   (top face,  150×1.45×150)
//
// After translation (dx≈73.6): protrusion[2] sits at x=[73.5,74.6], coplanar with panel[7]
// After fuse:  x=[73.55,75], y=[-75,99.05], z=[-75,75]  ≈ 1.45×174×150mm
// After merge: 3D bbox ≈ 150.1×174.1×150.1mm  — matches the UI screenshot exactly
//
// Correct flat: ≈ (174 + 150 + BA) × 150mm ≈ 327 × 150mm
// Buggy flat:   ≈ 174 × 151mm  (UV-overlap; second panel not unfolded)
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Regression: testcube inner-panel with protrusion produces correct flat",
          "[prod][regression][protrusion][testcube_workflow]") {
  auto svc = GeometryService::create();

  // Load testcube and decompose into panels
  SolidId tcId = svc->loadStep(fixture("testcube.step"));
  DecomposedByBendsResult split = svc->splitBodyByBends(tcId, 45.0, 2.0, 1.0, 2);
  REQUIRE(split.panelIds.size() == 12);

  // panel[7]: right inner face  x=[73.55,75], y=[-75,75],  z=[-75,75]  (1.45×150×150mm)
  // panel[6]: top  inner face   x=[-75,75],  y=[73.55,75], z=[-75,75]  (150×1.45×150mm)
  // Bend will be at the y≈73.55-75 junction.
  // Protrusion must extend on the OPPOSITE side (y<-75) so the corner cut
  // (which trims y=[73.55,75]) cannot sever the protrusion from the panel.
  ShellId panel7 = split.panelIds[7];
  ShellId panel6 = split.panelIds[6];

  auto bbP7 = svc->computeBoundingBox(panel7);

  // panel[7] dimensions
  double T      = bbP7.xMax - bbP7.xMin;  // ≈1.45mm thickness (in X)
  double panelY = bbP7.yMax - bbP7.yMin;  // ≈150mm
  double panelZ = bbP7.zMax - bbP7.zMin;  // ≈150mm
  double extLen = 24.0;  // protrusion extension length (mm)

  // Create a matching-thickness protrusion box that extends panel[7] in -Y
  // (away from the bend at y≈75, so the corner cut leaves it intact)
  TopoDS_Shape protrBox = BRepPrimAPI_MakeBox(
    gp_Pnt(bbP7.xMin, bbP7.yMin - extLen, bbP7.zMin), T, extLen, panelZ
  ).Shape();

  auto tmpProt = (fs::temp_directory_path() / "tc_prot2.stp").string();
  {
    STEPControl_Writer w;
    REQUIRE(w.Transfer(protrBox, STEPControl_AsIs) == IFSelect_RetDone);
    REQUIRE(w.Write(tmpProt.c_str()) == IFSelect_RetDone);
  }
  SolidId idProt = svc->loadStep(tmpProt);
  fs::remove(tmpProt);
  auto shellsProt = svc->separateSolids(idProt);
  REQUIRE_FALSE(shellsProt.empty());

  // fuse_bodies: panel[7] + protrusion → (150+24)×150mm = 174×150mm vertical panel
  // Protrusion is at y=[-99,-75], panel at y=[-75,75].  Total y=[-99,75], span=174mm.
  FuseResult fused = svc->fuseBodies({panel7, shellsProt[0]}, 0.15);
  REQUIRE_FALSE(fused.solidId.empty());

  auto bbFused = svc->computeBoundingBox(fused.solidId);
  double fusedYspan = bbFused.yMax - bbFused.yMin;  // should be ≈174mm
  std::cout << "[REGRESSION testcube_workflow] fused bbox:"
            << " x=[" << bbFused.xMin << "," << bbFused.xMax << "]"
            << " y=[" << bbFused.yMin << "," << bbFused.yMax << "]"
            << " z=[" << bbFused.zMin << "," << bbFused.zMax << "]\n";
  REQUIRE(std::abs(fusedYspan - (panelY + extLen)) < 1.0);  // ≈174mm

  // merge_bodies_with_bend: fusedPanel + panel[6] (top face) at 90° with 1mm bend radius
  MergeBodyResult merged = svc->mergeBodiesWithBend(fused.solidId, panel6, {"all"}, 1.0);
  REQUIRE_FALSE(merged.mergedShellId.empty());

  UnfoldResult unfold = svc->unfoldShell(merged.mergedShellId, 0.33);
  REQUIRE_FALSE(unfold.unfoldId.empty());

  double flatMax = std::max(unfold.flatWidthMm, unfold.flatHeightMm);
  double flatMin = std::min(unfold.flatWidthMm, unfold.flatHeightMm);
  std::cout << "[REGRESSION testcube_workflow] flat=" << unfold.flatWidthMm
            << "x" << unfold.flatHeightMm << "mm  bends=" << unfold.bendCount << "\n";

  REQUIRE(unfold.bendCount == 1);

  // Correct flat: (panelY + extLen) + panelY + BA ≈ 174 + 150 + 2.7 ≈ 327mm × 150mm
  // Buggy flat:   ≈ 174 × 151mm  (UV-overlap: second panel maps to same footprint as first)
  double BA      = (1.0 + T / 2.0) * M_PI / 2.0;  // ≈2.7mm
  double expLong = (panelY + extLen) + panelY + BA; // ≈327mm
  const double tol = 5.0;

  CHECK(std::abs(flatMax - expLong) < tol);
  CHECK(std::abs(flatMin - panelY)  < tol);

  DxfExportResult dxf = svc->exportDxf(unfold.unfoldId);
  REQUIRE_FALSE(dxf.dxfContent.empty());
  assertNoCutOnBend(dxf.dxfContent, "testcube_protrusion_workflow");
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic: print bboxes of testcube split panels and protrusions
// Tag [diag] so it can be run in isolation when needed; not part of CI.
// ─────────────────────────────────────────────────────────────────────────────
TEST_CASE("Diag: print testcube panel and protrusion bounding boxes",
          "[diag][testcube_bbox]") {
  auto svc = GeometryService::create();
  SolidId tcId = svc->loadStep(fixture("testcube.step"));
  DecomposedByBendsResult split = svc->splitBodyByBends(tcId, 45.0, 2.0, 1.0, 2);

  std::cout << "\n=== TESTCUBE PANELS (" << split.panelIds.size() << ") ===\n";
  for (size_t i = 0; i < split.panelIds.size(); ++i) {
    auto bb = svc->computeBoundingBox(split.panelIds[i]);
    std::cout << "  panel[" << i << "] x=[" << bb.xMin << "," << bb.xMax << "]"
              << " y=[" << bb.yMin << "," << bb.yMax << "]"
              << " z=[" << bb.zMin << "," << bb.zMax << "]\n";
  }

  std::cout << "\n=== TESTCUBE PROTRUSIONS (" << split.protrusionIds.size() << ") ===\n";
  for (size_t i = 0; i < split.protrusionIds.size(); ++i) {
    auto bb = svc->computeBoundingBox(split.protrusionIds[i]);
    std::cout << "  protrusion[" << i << "] x=[" << bb.xMin << "," << bb.xMax << "]"
              << " y=[" << bb.yMin << "," << bb.yMax << "]"
              << " z=[" << bb.zMin << "," << bb.zMax << "]\n";
  }

  // Always pass — this is a diagnostic only
  SUCCEED("Bounding box dump complete");
}


