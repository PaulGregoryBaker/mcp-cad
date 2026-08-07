/**
 * validation/rules tests — aligned 1:1 with the TS integration test
 * (ts/tests/integration/findings_resource.integration.test.ts).
 *
 * Every scenario below has a matching TS test that creates the same geometry
 * through GraphStore → NAPI → C++.  A failure in one can be reproduced in the
 * other by copying the same coordinates, thickness, and profile parameters.
 */

#include <catch2/catch_test_macros.hpp>

#include "geometry/translation/manufacturing_graph_evaluator.hpp"
#include "geometry/validation/rules_engine.hpp"
#include "geometry/validation/profile.hpp"
#include "geometry/validation/rules/bend_radius.hpp"
#include "geometry/validation/rules/bend_angle.hpp"
#include "geometry/validation/rules/hole_diameter.hpp"
#include "geometry/validation/rules/hole_to_bend.hpp"
#include "geometry/validation/rules/hole_to_edge.hpp"
#include "geometry/validation/rules/hole_to_hole.hpp"
#include "geometry/validation/rules/flange_width.hpp"

using namespace mcp_cad::translation;
using namespace mcp_cad::validation;

namespace {

// ── Shared geometry helpers ─────────────────────────────────────────────────

// A simple CCW rectangle outline. All scenarios use this as the part's one
// shared outline (14 §0) — matches what the TS side's createPart does.
std::vector<Point2> Outline(double w, double h) {
  return {{0, 0}, {w, 0}, {w, h}, {0, h}};
}

// A part with one outline, no bends, no holes — the clean baseline.
PartGraphSpec MakePart(double thicknessMm = 2.0,
                       double w = 100.0, double h = 50.0) {
  PartGraphSpec g;
  g.partId = "test-part";
  g.rootRegionPanelId = "root";
  g.thicknessMm = thicknessMm;
  g.outline.outer = Outline(w, h);
  // One region panel row — the root, always present.
  return g;
}

// Adds one bend to the part.  Returns the bend's id and child panel id so
// callers can reference them in assertions.
struct AddedBend {
  std::string bendId;
  std::string childPanelId;
};
AddedBend AddBend(PartGraphSpec& g,
                  const std::string& parentPanel,
                  Point2 hingeA, Point2 hingeB,
                  double angleDeg, double radiusMm = 0.0,
                  double kFactor = 0.0) {
  BendSpec b;
  b.id = "bend-" + std::to_string(g.bends.size());
  b.parentRegionPanelId = parentPanel;
  b.childRegionPanelId = "panel-" + std::to_string(g.bends.size());
  b.hingeA = hingeA;
  b.hingeB = hingeB;
  b.angleDeg = angleDeg;
  b.radiusMm = radiusMm;
  b.kFactor = kFactor;
  g.bends.push_back(b);
  return {b.id, b.childRegionPanelId};
}

// Adds a circle hole to the part.
void AddCircleHole(PartGraphSpec& g, double cx, double cy, double radiusMm) {
  CircleHoleSpec h;
  h.center = {cx, cy};
  h.radiusMm = radiusMm;
  g.outline.circleHoles.push_back(h);
}

ManufacturingProfile DefaultProfile() {
  ManufacturingProfile p;
  p.profileId = "test-default";
  p.name = "Test Profile";
  return p;
}

// ── Helpers to find a finding by code ──────────────────────────────────────

bool HasCode(const std::vector<Finding>& findings, const std::string& code) {
  for (const auto& f : findings) {
    if (f.code == code) return true;
  }
  return false;
}

const Finding* FindByCode(const std::vector<Finding>& findings, const std::string& code) {
  for (const auto& f : findings) {
    if (f.code == code) return &f;
  }
  return nullptr;
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 0 — Clean part (baseline, all rules pass)
// ═══════════════════════════════════════════════════════════════════════════

TEST_CASE("Findings: clean part produces no findings", "[validation]") {
  auto g = MakePart(2.0);
  auto findings = EvaluateFindings(g, nullptr, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 1 — Bend radius below minimum
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: createPart(100×50, thickness=2) + createNode(bend,
//   hinge=(50,0)-(50,50), angle=90, radius=1.5) → findings includes
//   MIN_BEND_RADIUS (1.5 < 2.0 × 1.0).

TEST_CASE("BendRadius: below minimum produces MIN_BEND_RADIUS", "[validation][bend_radius]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/1.5);
  auto findings = rules::CheckBendRadius(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MIN_BEND_RADIUS");
  CHECK(findings[0].severity == FindingSeverity::kError);
  // Anchor points to the offending bend.
  CHECK(findings[0].anchors.size() >= 1);
  CHECK(findings[0].anchors[0].kind == "bend");
  CHECK(findings[0].anchors[0].id == "bend-0");
}

TEST_CASE("BendRadius: at or above minimum produces no finding", "[validation][bend_radius]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/2.0);  // exactly at threshold
  auto findings = rules::CheckBendRadius(g, DefaultProfile());
  CHECK(findings.empty());
}

// docs/BUG_REPORT_import_bend_radius_always_zero_or_thickness.md — a bend
// reconciliation produced (radiusMeasured=false) must never assert
// MIN_BEND_RADIUS against its placeholder radiusMm=0.0; it gets the
// advisory BEND_RADIUS_NOT_MEASURED finding instead, with a recommendedFix
// pointing at update_node.
TEST_CASE("BendRadius: unmeasured (reconciliation-derived) bend produces "
          "BEND_RADIUS_NOT_MEASURED, not MIN_BEND_RADIUS",
          "[validation][bend_radius]") {
  auto g = MakePart(2.0);
  auto added = AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/0.0);
  g.bends[0].radiusMeasured = false;

  auto findings = rules::CheckBendRadius(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "BEND_RADIUS_NOT_MEASURED");
  CHECK(findings[0].severity == FindingSeverity::kWarning);
  CHECK(findings[0].anchors[0].id == added.bendId);
  REQUIRE(findings[0].recommendedFix.has_value());
  CHECK(findings[0].recommendedFix->tool == "update_node");
  CHECK(findings[0].recommendedFix->paramsJson.find(added.bendId) != std::string::npos);
  CHECK(findings[0].recommendedFix->paramsJson.find("radius_mm") != std::string::npos);
  CHECK_FALSE(HasCode(findings, "MIN_BEND_RADIUS"));
}

TEST_CASE("BendRadius: an explicit radiusMm=0 (radiusMeasured=true, the "
          "default) still produces MIN_BEND_RADIUS as before - a real, "
          "authored sharp fold is a real design choice",
          "[validation][bend_radius]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/0.0);
  auto findings = rules::CheckBendRadius(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MIN_BEND_RADIUS");
  CHECK(findings[0].severity == FindingSeverity::kError);
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 2 — Bend angle negative
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: createNode(bend, angleDeg=-30) → MAX_BEND_ANGLE

TEST_CASE("BendAngle: negative angle produces MAX_BEND_ANGLE", "[validation][bend_angle]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, /*angleDeg=*/-30.0);
  auto findings = rules::CheckBendAngle(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MAX_BEND_ANGLE");
  CHECK(findings[0].severity == FindingSeverity::kError);
}

TEST_CASE("BendAngle: angle 0-180 passes", "[validation][bend_angle]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0);
  auto findings = rules::CheckBendAngle(g, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 3 — Bend angle above max
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: createNode(bend, angleDeg=200) → MAX_BEND_ANGLE

TEST_CASE("BendAngle: above max produces MAX_BEND_ANGLE", "[validation][bend_angle]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, /*angleDeg=*/200.0);
  auto findings = rules::CheckBendAngle(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MAX_BEND_ANGLE");
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 4 — Hole diameter below minimum
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: cut_panel(kind=circle, center=(25,25), radius=0.8) on a
//   2mm-thick part → MIN_HOLE_DIAMETER (1.6mm < 2.0mm)

TEST_CASE("HoleDiameter: too small produces MIN_HOLE_DIAMETER", "[validation][hole_diameter]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 25.0, 25.0, /*radiusMm=*/0.8);  // diameter 1.6 < 2.0 × 1.0
  auto findings = rules::CheckHoleDiameter(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MIN_HOLE_DIAMETER");
  CHECK(findings[0].severity == FindingSeverity::kError);
  CHECK(findings[0].anchors[0].kind == "part");
}

TEST_CASE("HoleDiameter: large enough passes", "[validation][hole_diameter]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 25.0, 25.0, /*radiusMm=*/3.0);  // diameter 6.0 > 2.0
  auto findings = rules::CheckHoleDiameter(g, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 5 — Hole too close to bend hinge
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: cut_panel(circle, center=(50, 3), radius=0.5) on a part
//   with a bend hinge at (50,0)-(50,50) → centre is 3mm from hinge,
//   clearance=2mm+0.5mm=2.5mm required, 3mm ≥ 2.5mm → passes.
//   Move to centre=(50, 2) → distance=2.0mm < 2.5mm → HOLE_TOO_CLOSE_TO_BEND.

TEST_CASE("HoleToBend: too close produces HOLE_TOO_CLOSE_TO_BEND", "[validation][hole_to_bend]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0);
  // Hole centre at (50, 2) — distance from hinge = |50-50| horizontally = 0,
  // vertically the hinge runs from y=0..50, so point-to-segment distance is
  // horizontal distance = 0.  Wait — hinge is vertical at x=50, hole at x=50
  // with y=2, so the projection of (50,2) onto the segment (50,0)-(50,50) is
  // exactly (50,2) — distance = 0.  That's definitely too close.
  AddCircleHole(g, 50.0, 2.0, /*radiusMm=*/0.5);
  auto findings = rules::CheckHoleToBendClearance(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "HOLE_TOO_CLOSE_TO_BEND");
}

TEST_CASE("HoleToBend: far enough passes", "[validation][hole_to_bend]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0);
  // Hole at x=30 — 20mm from the vertical hinge at x=50.
  AddCircleHole(g, 30.0, 25.0, /*radiusMm=*/0.5);
  auto findings = rules::CheckHoleToBendClearance(g, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 6 — Hole too close to outline edge
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: cut_panel(circle, center=(2,25), radius=1.0) on 100×50
//   rect → distance from centre to left edge (x=0) = 2mm,
//   clearance=1.5mm+1.0mm=2.5mm → 2.0 < 2.5 → HOLE_TOO_CLOSE_TO_EDGE.

TEST_CASE("HoleToEdge: too close produces HOLE_TOO_CLOSE_TO_EDGE", "[validation][hole_to_edge]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 2.0, 25.0, /*radiusMm=*/1.0);
  auto findings = rules::CheckHoleToEdgeClearance(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "HOLE_TOO_CLOSE_TO_EDGE");
}

TEST_CASE("HoleToEdge: far enough passes", "[validation][hole_to_edge]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 50.0, 25.0, /*radiusMm=*/1.0);
  auto findings = rules::CheckHoleToEdgeClearance(g, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 7 — Two holes too close
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: two cut_panel(circle) calls, centres 1mm apart →
//   HOLE_TOO_CLOSE_TO_HOLE.

TEST_CASE("HoleToHole: too close produces HOLE_TOO_CLOSE_TO_HOLE", "[validation][hole_to_hole]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 25.0, 25.0, 1.0);
  AddCircleHole(g, 26.0, 25.0, 1.0);  // centres 1mm apart, min is 3mm
  auto findings = rules::CheckHoleToHoleDistance(g, DefaultProfile());
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "HOLE_TOO_CLOSE_TO_HOLE");
}

TEST_CASE("HoleToHole: far enough apart passes", "[validation][hole_to_hole]") {
  auto g = MakePart(2.0);
  AddCircleHole(g, 10.0, 25.0, 1.0);
  AddCircleHole(g, 20.0, 25.0, 1.0);  // centres 10mm apart > 3mm
  auto findings = rules::CheckHoleToHoleDistance(g, DefaultProfile());
  CHECK(findings.empty());
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 8 — Flange too short
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: createNode(bend, hinge=(0,0)-(0,50), angle=90) on a
//   100×50mm part → child panel ("flange") is the left half (0..50, 0..50),
//   max distance from hinge to region vertices = 50mm,
//   minFlange=4.0×2.0=8.0mm → 50 ≥ 8 → passes.
//   But with a narrower part (20×50): flange width = 20mm, still passes.
//   With a very narrow part (5×50): flange width = 5mm < 8mm → MIN_FLANGE_WIDTH.
//
// This rule needs the EvaluateResult (region polygons), so we must call
// Evaluate() first, then pass the layout to CheckFlangeWidth.

TEST_CASE("FlangeWidth: too short produces MIN_FLANGE_WIDTH", "[validation][flange_width]") {
  // Part: 10mm wide × 50mm tall, 2mm thick.  Bend splits it at x=5.
  auto g = MakePart(/*thicknessMm=*/2.0, /*w=*/10.0, /*h=*/50.0);
  AddBend(g, "root", {5, 0}, {5, 50}, 90.0, /*radiusMm=*/2.0);

  auto layout = Evaluate(g);
  REQUIRE(layout.ok);

  auto findings = rules::CheckFlangeWidth(g, layout, DefaultProfile());
  // Default minFlangeWidthFactor = 4.0 × 2.0mm = 8.0mm.
  // The child panel (flange) spans x=5..10, width=5mm → below 8mm.
  REQUIRE_FALSE(findings.empty());
  CHECK(findings[0].code == "MIN_FLANGE_WIDTH");
  CHECK(findings[0].severity == FindingSeverity::kError);
}

TEST_CASE("FlangeWidth: wide enough passes", "[validation][flange_width]") {
  auto g = MakePart(/*thicknessMm=*/2.0, /*w=*/100.0, /*h=*/50.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/2.0);

  auto layout = Evaluate(g);
  REQUIRE(layout.ok);

  auto findings = rules::CheckFlangeWidth(g, layout, DefaultProfile());
  // Flange width = min(50, 50) = 50mm > 8mm → passes.
  CHECK(findings.empty());
}

TEST_CASE("FlangeWidth: skipped when layout is null", "[validation][flange_width]") {
  auto g = MakePart(/*thicknessMm=*/2.0, /*w=*/10.0, /*h=*/50.0);
  AddBend(g, "root", {5, 0}, {5, 50}, 90.0);
  // layout = nullptr → CheckFlangeWidth never runs from EvaluateFindings.
  auto findings = EvaluateFindings(g, nullptr, DefaultProfile());
  // May still get structural findings, but not MIN_FLANGE_WIDTH.
  CHECK_FALSE(HasCode(findings, "MIN_FLANGE_WIDTH"));
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 9 — Multiple violations on one part
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: create a part with a thin bend (radius=1.5mm on 2mm
//   thickness) AND a small hole (radius=0.8mm) → at least MIN_BEND_RADIUS
//   and MIN_HOLE_DIAMETER both appear.

TEST_CASE("EvaluateFindings: multi-violation part returns all findings", "[validation]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/1.5);
  AddCircleHole(g, 25.0, 25.0, /*radiusMm=*/0.8);

  auto layout = Evaluate(g);
  REQUIRE(layout.ok);

  auto findings = EvaluateFindings(g, &layout, DefaultProfile());
  CHECK(HasCode(findings, "MIN_BEND_RADIUS"));
  CHECK(HasCode(findings, "MIN_HOLE_DIAMETER"));
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenario 10 — Custom profile changes findings
// ═══════════════════════════════════════════════════════════════════════════
// TS equivalent: same part as scenario 9, but with a relaxed profile
//   (minBendRadiusFactor=0.5, minHoleDiameterFactor=0.5) → fewer findings.

TEST_CASE("Profile: relaxed profile produces fewer findings", "[validation][profile]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/1.5);
  AddCircleHole(g, 25.0, 25.0, /*radiusMm=*/0.8);

  auto layout = Evaluate(g);
  REQUIRE(layout.ok);

  // Default profile: both violations present.
  auto strict = EvaluateFindings(g, &layout, DefaultProfile());
  CHECK(HasCode(strict, "MIN_BEND_RADIUS"));
  CHECK(HasCode(strict, "MIN_HOLE_DIAMETER"));

  // Relaxed profile: bend radius threshold = 0.5×2.0=1.0mm, 1.5≥1.0 → OK.
  // Hole diameter threshold = 0.5×2.0=1.0mm, diameter=1.6≥1.0 → OK.
  ManufacturingProfile relaxed;
  relaxed.minBendRadiusFactor = 0.5;
  relaxed.minHoleDiameterFactor = 0.5;
  auto relaxedFindings = EvaluateFindings(g, &layout, relaxed);
  CHECK_FALSE(HasCode(relaxedFindings, "MIN_BEND_RADIUS"));
  CHECK_FALSE(HasCode(relaxedFindings, "MIN_HOLE_DIAMETER"));
}

TEST_CASE("Profile: stricter profile produces more findings", "[validation][profile]") {
  auto g = MakePart(2.0);
  AddBend(g, "root", {50, 0}, {50, 50}, 90.0, /*radiusMm=*/3.0);
  AddCircleHole(g, 25.0, 25.0, /*radiusMm=*/2.0);

  auto layout = Evaluate(g);
  REQUIRE(layout.ok);

  // Default: both pass.
  auto def = EvaluateFindings(g, &layout, DefaultProfile());
  CHECK_FALSE(HasCode(def, "MIN_BEND_RADIUS"));
  CHECK_FALSE(HasCode(def, "MIN_HOLE_DIAMETER"));

  // Strict: bend radius threshold = 2.0×2.0=4.0mm, 3.0<4.0 → MIN_BEND_RADIUS.
  // Hole diameter threshold = 2.0×2.0=4.0mm, diameter=4.0≥4.0 → borderline pass.
  ManufacturingProfile strict;
  strict.minBendRadiusFactor = 2.0;
  strict.minHoleDiameterFactor = 2.0;
  auto strictFindings = EvaluateFindings(g, &layout, strict);
  CHECK(HasCode(strictFindings, "MIN_BEND_RADIUS"));
}

}  // namespace
