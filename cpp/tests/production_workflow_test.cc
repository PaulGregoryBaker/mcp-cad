#include <catch2/catch_test_macros.hpp>
#include <fstream>
#include <sstream>
#include <cmath>
#include <filesystem>

#include "geometry/geometry_service.hpp"

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


