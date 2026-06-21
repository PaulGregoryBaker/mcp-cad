/**
 * generate_fixtures.cc
 *
 * Utility program that generates canonical STEP test fixtures using OCCT.
 *
 * Output directory: cpp/tests/fixtures/
 *
 * Fixtures generated:
 *   simple_box.stp             — 100×100×10 mm box (basic GE unit tests)
 *   sheet_1panel.stp           — 300×200×1.5 mm thin plate (single panel)
 *   sheet_3panel.stp           — three 100×200×1.5 mm plates stacked
 *                                (canonical INF-03 golden-path fixture, T120)
 *   angle_bracket_15deg.stp    — L-bracket: two 100×200×1.5 mm panels at 15° dihedral
 *   angle_bracket_30deg.stp    — L-bracket: two 100×200×1.5 mm panels at 30° dihedral
 *   angle_bracket_45deg.stp    — L-bracket: two 100×200×1.5 mm panels at 45° dihedral
 *   tab_bracket_90deg.stp      — 100×200mm panel + centered 100×100mm flange (T-shape flat)
 *   l_bracket_corner_90deg.stp — 200×200mm panel + corner-flush 100×100mm flange (L-shape flat)
 *   unequal_leg_bracket_90deg.stp — two SIMPLE (non-composite) perpendicular panels of
 *                                deliberately different leg lengths (100mm × 100mm and
 *                                100mm × 30mm, sharing the full 100mm edge) — used to
 *                                catch orientation/axis-swap bugs in merge_bodies_with_bend:
 *                                an axis swap would show up as a clearly-wrong combined
 *                                dimension (130mm landing on the wrong world axis), unlike
 *                                near-square fixtures where a swap is hard to detect.
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
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <TopoDS_Shape.hxx>
#include <STEPControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>

#include <cmath>
#include <filesystem>
#include <iostream>
#include <sstream>
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

/**
 * hollow_cube.stp — 200×200×200 mm hollow cube with 1 mm walls.
 * Used by split_body_by_bends integration tests to verify thin-solid mode
 * detection and 6-panel decomposition.
 */
static bool genHollowCube(const fs::path& outDir) {
  TopoDS_Shape outer = BRepPrimAPI_MakeBox(200.0, 200.0, 200.0).Shape();
  TopoDS_Shape inner = BRepPrimAPI_MakeBox(gp_Pnt(1.0, 1.0, 1.0), 198.0, 198.0, 198.0).Shape();
  BRepAlgoAPI_Cut cutter(outer, inner);
  if (!cutter.IsDone()) {
    std::cerr << "Hollow cube cut failed\n";
    return false;
  }
  return writeStp(cutter.Shape(), (outDir / "hollow_cube.stp").string());
}

/**
 * cube_with_flanges.stp — hollow cube with 4 thin flange tabs on the ±X and ±Y faces.
 * Each flange is 1 mm thick, 20 mm wide, 10 mm tall.
 * Used by split_body_by_bends integration tests to verify protrusion detection.
 */
static bool genCubeWithFlanges(const fs::path& outDir) {
  // Hollow cube base
  TopoDS_Shape outer = BRepPrimAPI_MakeBox(200.0, 200.0, 200.0).Shape();
  TopoDS_Shape inner = BRepPrimAPI_MakeBox(gp_Pnt(1.0, 1.0, 1.0), 198.0, 198.0, 198.0).Shape();
  BRepAlgoAPI_Cut hollower(outer, inner);
  if (!hollower.IsDone()) {
    std::cerr << "Hollow cube cut failed in genCubeWithFlanges\n";
    return false;
  }
  TopoDS_Shape base = hollower.Shape();

  // 4 flanges: 1 mm thick in the face-normal direction, 20×10 mm footprint
  TopoDS_Shape fPosX = BRepPrimAPI_MakeBox(gp_Pnt(200.0,  90.0, 95.0),  1.0, 20.0, 10.0).Shape();
  TopoDS_Shape fNegX = BRepPrimAPI_MakeBox(gp_Pnt(-1.0,   90.0, 95.0),  1.0, 20.0, 10.0).Shape();
  TopoDS_Shape fPosY = BRepPrimAPI_MakeBox(gp_Pnt( 90.0, 200.0, 95.0), 20.0,  1.0, 10.0).Shape();
  TopoDS_Shape fNegY = BRepPrimAPI_MakeBox(gp_Pnt( 90.0,  -1.0, 95.0), 20.0,  1.0, 10.0).Shape();

  BRepAlgoAPI_Fuse f1(base,          fPosX); if (!f1.IsDone()) { std::cerr << "Fuse +X failed\n"; return false; }
  BRepAlgoAPI_Fuse f2(f1.Shape(),    fNegX); if (!f2.IsDone()) { std::cerr << "Fuse -X failed\n"; return false; }
  BRepAlgoAPI_Fuse f3(f2.Shape(),    fPosY); if (!f3.IsDone()) { std::cerr << "Fuse +Y failed\n"; return false; }
  BRepAlgoAPI_Fuse f4(f3.Shape(),    fNegY); if (!f4.IsDone()) { std::cerr << "Fuse -Y failed\n"; return false; }

  return writeStp(f4.Shape(), (outDir / "cube_with_flanges.stp").string());
}

/**
 * angle_bracket_Ndeg.stp — two flat panels meeting at a sharp N-degree dihedral bend.
 *
 * Cross-section in XZ (extruded W mm in Y):
 *   Panel A: horizontal, x=[0,L], z=[0,T]
 *   Panel B: bends downward by angleDeg from Panel A's right edge
 *
 * The dihedral between Panel A's top face and Panel B's outer face equals angleDeg.
 * Use angle_threshold_deg < angleDeg with split_body_by_bends to recover 2 panels.
 *
 * The outer fold corner is at x = L + T*tan(angleDeg/2), z = T (exact sharp-bend geometry).
 * The inner fold corner is at x = L, z = 0.
 */
static bool genAngleBracket(const fs::path& outDir, double angleDeg) {
  const double theta  = angleDeg * M_PI / 180.0;
  const double L      = 100.0;  // panel leg length (mm)
  const double T      = 1.5;    // panel thickness (mm)
  const double W      = 200.0;  // extrusion width (mm)

  const double c       = std::cos(theta);
  const double s       = std::sin(theta);
  const double tanHalf = std::tan(theta / 2.0);

  // 6-point cross-section in the XZ plane (Y=0 before extrusion).
  // Listed counter-clockwise so the wire normal faces +Y (required for MakePrism).
  //
  //   P6──────────P5
  //   │  Panel A  │
  //   P1──────────P2
  //                  ╲ Panel B (bent down at theta)
  //                   P3
  //                   P4
  //
  // P5 (outer fold corner) is offset from x=L by T*tan(theta/2) — the exact
  // zero-radius bend correction so Panel B's outer face is flush with P5.
  gp_Pnt P1(0.0,             0.0, 0.0);
  gp_Pnt P2(L,               0.0, 0.0);
  gp_Pnt P3(L + L*c,         0.0, -L*s);
  gp_Pnt P4(L + L*c + T*s,   0.0, -L*s + T*c);
  gp_Pnt P5(L + T*tanHalf,   0.0, T);
  gp_Pnt P6(0.0,             0.0, T);

  BRepBuilderAPI_MakeWire wireMaker;
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P1, P2).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P2, P3).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P3, P4).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P4, P5).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P5, P6).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P6, P1).Edge());

  if (!wireMaker.IsDone()) {
    std::cerr << "Wire build failed for " << angleDeg << "deg bracket\n";
    return false;
  }

  BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), true);
  if (!faceMaker.IsDone()) {
    std::cerr << "Face build failed for " << angleDeg << "deg bracket\n";
    return false;
  }

  TopoDS_Shape prism = BRepPrimAPI_MakePrism(faceMaker.Face(), gp_Vec(0.0, W, 0.0)).Shape();

  std::ostringstream name;
  name << "angle_bracket_" << static_cast<int>(angleDeg) << "deg.stp";
  return writeStp(prism, (outDir / name.str()).string());
}

/**
 * tab_bracket_90deg.stp — two flat panels at 90° where Panel B is shorter than Panel A.
 *
 * Panel A: 100×200×1.5 mm horizontal plate (X: 0–100, Y: 0–200, Z: 0–1.5)
 * Panel B: 1.5×100×100 mm vertical flange (X: 100–101.5, Y: 50–150, Z: -100–0)
 *          centered on Panel A in Y (yStart=50mm, WB=100mm)
 *
 * Construction: extrude a full 90° L-bracket (both panels 200mm) in Y, then cut the
 * vertical flange at y=[0..50] and y=[150..200] to produce the shorter Panel B.
 * This prism+cut approach gives cleaner OCCT face topology than a three-box fuse.
 *
 * After split_body_by_bends and merge_bodies_with_bend the flat pattern should be T-shaped:
 *   y=200 ┌──────────┐
 *         │  Panel A │
 *   y=150 │          ├──────────┐
 *         │          │  Panel B │
 *   y=50  │          ├──────────┘
 *         │  Panel A │
 *   y=0   └──────────┘
 */
static bool genTabBracket90deg(const fs::path& outDir) {
  const double T      = 1.5;
  const double LA     = 100.0;   // horizontal panel length
  const double WA     = 200.0;   // horizontal panel width (full Y)
  const double LB     = 100.0;   // vertical flange depth
  const double WB     = 100.0;   // vertical flange width (partial Y, centered)
  const double yStart = (WA - WB) / 2.0;  // 50.0

  // 6-point cross-section in the XZ plane (Y=0), counter-clockwise.
  // Inner corner at (LA, 0), outer top-right at (LA+T, T).
  gp_Pnt P1(0.0,      0.0, 0.0);
  gp_Pnt P2(LA,       0.0, 0.0);
  gp_Pnt P3(LA,       0.0, -LB);
  gp_Pnt P4(LA + T,   0.0, -LB);
  gp_Pnt P5(LA + T,   0.0, T);
  gp_Pnt P6(0.0,      0.0, T);

  BRepBuilderAPI_MakeWire wireMaker;
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P1, P2).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P2, P3).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P3, P4).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P4, P5).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P5, P6).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P6, P1).Edge());

  if (!wireMaker.IsDone()) {
    std::cerr << "Tab bracket wire build failed\n";
    return false;
  }

  BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), true);
  if (!faceMaker.IsDone()) {
    std::cerr << "Tab bracket face build failed\n";
    return false;
  }

  // Extrude the full L-section 200mm in Y → both panels are 200mm wide.
  TopoDS_Shape fullBracket = BRepPrimAPI_MakePrism(faceMaker.Face(), gp_Vec(0.0, WA, 0.0)).Shape();

  // Cut Panel B (vertical flange, z=[-LB..0]) to only the center 100mm of Y.
  // Cut 1: remove y=[0..yStart] of the vertical portion.
  TopoDS_Shape cutBox1 = BRepPrimAPI_MakeBox(gp_Pnt(LA, 0.0, -LB), T, yStart, LB).Shape();
  BRepAlgoAPI_Cut c1(fullBracket, cutBox1);
  if (!c1.IsDone()) {
    std::cerr << "Tab bracket cut 1 failed\n";
    return false;
  }

  // Cut 2: remove y=[yStart+WB..WA] of the vertical portion.
  TopoDS_Shape cutBox2 = BRepPrimAPI_MakeBox(gp_Pnt(LA, yStart + WB, -LB), T, yStart, LB).Shape();
  BRepAlgoAPI_Cut c2(c1.Shape(), cutBox2);
  if (!c2.IsDone()) {
    std::cerr << "Tab bracket cut 2 failed\n";
    return false;
  }

  return writeStp(c2.Shape(), (outDir / "tab_bracket_90deg.stp").string());
}

/**
 * l_bracket_corner_90deg.stp — two flat panels at 90° forming an L-shaped flat pattern.
 *
 * Panel A (small): 1.5×100×100 mm vertical flange (X: 200–201.5, Y: 0–100, Z: -100–0)
 * Panel B (big):    200×200×1.5 mm horizontal plate (X: 0–200, Y: 0–200, Z: 0–1.5)
 *
 * Unlike tab_bracket_90deg (where the short flange is centered on the long panel's
 * edge, producing a T-shape), here Panel A is flush with one END of Panel B's 200mm
 * edge (yStart=0), producing an L-shape: the flat pattern fills X=[0,300] for
 * y=[0,100] but only X=[0,200] for y=[100,200] — a missing 100×100mm corner notch.
 *
 * Construction: extrude a full 90° L-bracket (both panels 200mm) in Y, then cut the
 * vertical flange at y=[100..200] to leave only the corner-flush 100mm of Panel A.
 *
 * After split_body_by_bends and merge_bodies_with_bend the flat pattern should be L-shaped:
 *   y=200 ┌──────────┐
 *         │ Panel B  │
 *   y=100 │          ├──────────┐
 *         │          │ Panel A  │
 *   y=0   └──────────┴──────────┘
 *         x=0        x=200      x=300
 */
static bool genLBracketCorner90deg(const fs::path& outDir) {
  const double T      = 1.5;
  const double LA     = 200.0;   // horizontal panel length
  const double WA     = 200.0;   // horizontal panel width (full Y)
  const double LB     = 100.0;   // vertical flange depth
  const double WB     = 100.0;   // vertical flange width (partial Y, flush at y=0)
  const double yStart = 0.0;     // flush with one end (corner) — produces L, not T

  // 6-point cross-section in the XZ plane (Y=0), counter-clockwise.
  // Inner corner at (LA, 0), outer top-right at (LA+T, T).
  gp_Pnt P1(0.0,      0.0, 0.0);
  gp_Pnt P2(LA,       0.0, 0.0);
  gp_Pnt P3(LA,       0.0, -LB);
  gp_Pnt P4(LA + T,   0.0, -LB);
  gp_Pnt P5(LA + T,   0.0, T);
  gp_Pnt P6(0.0,      0.0, T);

  BRepBuilderAPI_MakeWire wireMaker;
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P1, P2).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P2, P3).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P3, P4).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P4, P5).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P5, P6).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P6, P1).Edge());

  if (!wireMaker.IsDone()) {
    std::cerr << "L-bracket corner wire build failed\n";
    return false;
  }

  BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), true);
  if (!faceMaker.IsDone()) {
    std::cerr << "L-bracket corner face build failed\n";
    return false;
  }

  // Extrude the full L-section 200mm in Y → both panels are 200mm wide.
  TopoDS_Shape fullBracket = BRepPrimAPI_MakePrism(faceMaker.Face(), gp_Vec(0.0, WA, 0.0)).Shape();

  // Cut Panel A (vertical flange, z=[-LB..0]) down to the corner-flush 100mm of Y:
  // remove y=[yStart+WB..WA] = [100..200] of the vertical portion.
  TopoDS_Shape cutBox = BRepPrimAPI_MakeBox(gp_Pnt(LA, yStart + WB, -LB), T, WA - (yStart + WB), LB).Shape();
  BRepAlgoAPI_Cut cutter(fullBracket, cutBox);
  if (!cutter.IsDone()) {
    std::cerr << "L-bracket corner cut failed\n";
    return false;
  }

  return writeStp(cutter.Shape(), (outDir / "l_bracket_corner_90deg.stp").string());
}

/**
 * unequal_leg_bracket_90deg.stp — two simple, non-composite panels at a sharp
 * 90° dihedral, with DELIBERATELY UNEQUAL leg lengths sharing the full common
 * edge (no asymmetric Y-extent, no protrusions/fuse complexity at all):
 *
 * Panel A: 100mm × 100mm  (x=[0,100], z=[0,T])
 * Panel B: 100mm × 30mm   (x=[100,100+T], z=[-30,T])  — the SHORT leg
 * Both extruded the SAME 100mm in Y, so the only asymmetry is leg length.
 *
 * Purpose: catch orientation/axis-swap bugs in merge_bodies_with_bend. With
 * near-square fixtures (200×200 etc.) a U/V axis swap is invisible — both
 * axes measure ~200mm either way. Here, swapping which world axis the
 * combined 130mm (100 + 30 fold-perpendicular reach) lands on is immediately
 * visible: the correct merged 3D bbox extends 130mm along ONE specific axis
 * (matching panel A's own outward direction) and exactly 100mm along the
 * seam axis — get the orientation wrong and those numbers land on the wrong
 * axes, or a dimension comes out as 100 where 110 was expected.
 */
static bool genUnequalLegBracket90deg(const fs::path& outDir) {
  const double T  = 1.5;
  const double LA = 100.0;  // long leg (panel A) length
  const double LB = 30.0;   // short leg (panel B) length
  const double W  = 100.0;  // extrusion width (Y) — SAME for both legs, no cutting needed

  // 6-point cross-section in the XZ plane (Y=0), counter-clockwise.
  gp_Pnt P1(0.0,      0.0, 0.0);
  gp_Pnt P2(LA,       0.0, 0.0);
  gp_Pnt P3(LA,       0.0, -LB);
  gp_Pnt P4(LA + T,   0.0, -LB);
  gp_Pnt P5(LA + T,   0.0, T);
  gp_Pnt P6(0.0,      0.0, T);

  BRepBuilderAPI_MakeWire wireMaker;
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P1, P2).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P2, P3).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P3, P4).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P4, P5).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P5, P6).Edge());
  wireMaker.Add(BRepBuilderAPI_MakeEdge(P6, P1).Edge());

  if (!wireMaker.IsDone()) {
    std::cerr << "Unequal-leg bracket wire build failed\n";
    return false;
  }

  BRepBuilderAPI_MakeFace faceMaker(wireMaker.Wire(), true);
  if (!faceMaker.IsDone()) {
    std::cerr << "Unequal-leg bracket face build failed\n";
    return false;
  }

  TopoDS_Shape prism = BRepPrimAPI_MakePrism(faceMaker.Face(), gp_Vec(0.0, W, 0.0)).Shape();
  return writeStp(prism, (outDir / "unequal_leg_bracket_90deg.stp").string());
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
  ok &= genHollowCube(outDir);
  ok &= genCubeWithFlanges(outDir);
  ok &= genAngleBracket(outDir, 15.0);
  ok &= genAngleBracket(outDir, 30.0);
  ok &= genAngleBracket(outDir, 45.0);
  ok &= genTabBracket90deg(outDir);
  ok &= genLBracketCorner90deg(outDir);
  ok &= genUnequalLegBracket90deg(outDir);

  if (ok) {
    std::cout << "All fixtures generated successfully.\n";
    return 0;
  } else {
    std::cerr << "One or more fixtures failed to generate.\n";
    return 1;
  }
}
