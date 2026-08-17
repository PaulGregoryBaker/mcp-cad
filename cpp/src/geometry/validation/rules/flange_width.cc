#include "flange_width.hpp"
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>
#include <unordered_map>
#include <unordered_set>

namespace mcp_cad::validation::rules {

namespace {

// Signed distance from point p to the infinite line through a->b.
// Positive = p is to the left of the ray a->b (CCW convention).
double SignedDistanceToLine(
    const translation::Point2& p,
    const translation::Point2& a,
    const translation::Point2& b) {
  double dx = b.x - a.x;
  double dy = b.y - a.y;
  return (dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / std::hypot(dx, dy);
}

}  // namespace

std::vector<Finding> CheckFlangeWidth(
    const translation::PartGraphSpec& graph,
    const translation::EvaluateResult& layout,
    const ManufacturingProfile& profile) {
  std::vector<Finding> findings;
  const double minWidth = profile.minFlangeWidthFactor * graph.thicknessMm;

  // A "flange" in v2 terms: a region panel with exactly ONE inbound bend
  // (i.e. a leaf in the fold tree — child of exactly one bend, with zero
  // children of its own).  Under the single-outline model (14 §0), the
  // flange's width is the max perpendicular distance from its bounding
  // hinge to any vertex of the region polygon.
  //
  // Build the child-of set from the bend table.
  std::unordered_set<std::string> isChild;
  for (const auto& bend : graph.bends) {
    isChild.insert(bend.childRegionPanelId);
  }
  // Build parent-of: which region panels have outgoing bends.
  std::unordered_set<std::string> isParent;
  for (const auto& bend : graph.bends) {
    isParent.insert(bend.parentRegionPanelId);
  }

  // Build a lookup: child region panel -> its inbound bend
  std::unordered_map<std::string, const translation::BendSpec*> childBend;
  for (const auto& bend : graph.bends) {
    childBend[bend.childRegionPanelId] = &bend;
  }

  for (const auto& panel : layout.panels) {
    // A flange is a leaf: it is a child (has an inbound bend) but is NOT
    // a parent (has no children of its own).
    if (!isChild.count(panel.regionPanelId)) continue;
    if (isParent.count(panel.regionPanelId)) continue;
    if (panel.regionOuter.size() < 3) continue;

    auto it = childBend.find(panel.regionPanelId);
    if (it == childBend.end()) continue;
    const auto& hinge = *it->second;

    // The flange's own width is its span along the hinge-perpendicular
    // direction (max signed distance minus min signed distance) — not the
    // max distance from the bend's own (stored, un-widened) hinge line,
    // which no longer sits at the panel's own boundary once a real bend
    // allowance has shifted the panel outward from it (Evaluate()'s own
    // cumulative-shift pass, docs/BUG_REPORT_outline_never_grows_for_bend_
    // allowance.md) — the span is translation-invariant, so it measures the
    // flange's true size regardless of where the panel currently sits
    // relative to that line.
    double minSigned = 0.0, maxSigned = 0.0;
    bool first = true;
    for (const auto& v : panel.regionOuter) {
      double d = SignedDistanceToLine(v, hinge.hingeA, hinge.hingeB);
      if (first) {
        minSigned = maxSigned = d;
        first = false;
      } else {
        minSigned = std::min(minSigned, d);
        maxSigned = std::max(maxSigned, d);
      }
    }
    double maxDist = maxSigned - minSigned;

    if (maxDist < minWidth) {
      std::ostringstream msg;
      msg << "Region panel " << panel.regionPanelId
          << " flange width " << std::fixed << std::setprecision(2)
          << maxDist << " mm is below minimum " << minWidth
          << " mm (thickness " << graph.thicknessMm
          << " mm × factor " << profile.minFlangeWidthFactor << ")";
      findings.push_back({
        "MIN_FLANGE_WIDTH",
        FindingSeverity::kError,
        msg.str(),
        {{"region_panel", panel.regionPanelId}, {"bend", hinge.id}},
        std::nullopt  // no auto-fix — flange width is a design choice
      });
    }
  }
  return findings;
}

}  // namespace
