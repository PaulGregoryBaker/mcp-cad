#include "flat_outline.hpp"
#include "polygon_boolean.hpp"

#include <algorithm>
#include <cmath>

namespace mcp_cad::translation {

namespace {

constexpr double kGeometricEpsilon = 1e-9;

// Finds every maximal run of consecutive `true` indices in a cyclic
// (wraparound) boolean array — e.g. edgeBendId[i] == someBendId flags
// around a region panel's own ring. Starts scanning from a known `false`
// index so a run spanning the array's start/end boundary is captured as
// one run, not split into two. Mirrors RegionOf's own tagging traversal.
std::vector<std::vector<size_t>> FindCyclicRuns(const std::vector<bool>& flags) {
  std::vector<std::vector<size_t>> runs;
  size_t n = flags.size();
  if (n == 0) return runs;

  bool anyTrue = false;
  for (bool f : flags) {
    if (f) { anyTrue = true; break; }
  }
  if (!anyTrue) return runs;

  bool allTrue = true;
  for (bool f : flags) {
    if (!f) { allTrue = false; break; }
  }
  if (allTrue) {
    std::vector<size_t> all;
    all.reserve(n);
    for (size_t i = 0; i < n; ++i) all.push_back(i);
    runs.push_back(std::move(all));
    return runs;
  }

  size_t start = 0;
  for (size_t i = 0; i < n; ++i) {
    if (!flags[i]) { start = i; break; }
  }
  std::vector<size_t> current;
  for (size_t k = 0; k < n; ++k) {
    size_t i = (start + k) % n;
    if (flags[i]) {
      current.push_back(i);
    } else if (!current.empty()) {
      runs.push_back(current);
      current.clear();
    }
  }
  if (!current.empty()) runs.push_back(current);
  return runs;
}

const RegionPanelLayout* FindPanel(const EvaluateResult& evaluated, const std::string& regionPanelId) {
  for (const auto& p : evaluated.panels) {
    if (p.regionPanelId == regionPanelId) return &p;
  }
  return nullptr;
}

// The run's own vertex chain: the tagged edges' points, in the panel's own
// (CCW) traversal order — a run of edges [i, i+1, ..., j] contributes
// vertices [i, i+1, ..., j, j+1].
std::vector<Point2> RunPoints(const RegionPanelLayout& panel, const std::vector<size_t>& run) {
  std::vector<Point2> points;
  size_t n = panel.regionOuter.size();
  points.reserve(run.size() + 1);
  for (size_t idx : run) points.push_back(panel.regionOuter[idx]);
  points.push_back(panel.regionOuter[(run.back() + 1) % n]);
  return points;
}

Point2 Centroid(const std::vector<Point2>& points) {
  Point2 c{0.0, 0.0};
  for (const auto& p : points) {
    c.x += p.x;
    c.y += p.y;
  }
  c.x /= static_cast<double>(points.size());
  c.y /= static_cast<double>(points.size());
  return c;
}

}  // namespace

FlatOutlineResult BuildFlatOutline(const PartGraphSpec& graph, const EvaluateResult& evaluated) {
  FlatOutlineResult result;

  const RegionPanelLayout* rootPanel = FindPanel(evaluated, graph.rootRegionPanelId);
  if (!rootPanel || rootPanel->regionOuter.size() < 3) {
    result.errorCode = FlatOutlineErrorCode::kDegenerateInput;
    result.message = "root region panel missing or degenerate in evaluated result";
    return result;
  }

  std::vector<Point2> outline = rootPanel->regionOuter;

  for (const auto& bridge : evaluated.bridges) {
    const RegionPanelLayout* parentPanel = FindPanel(evaluated, bridge.parentRegionPanelId);
    const RegionPanelLayout* childPanel = FindPanel(evaluated, bridge.childRegionPanelId);
    if (!parentPanel || !childPanel) {
      result.errorCode = FlatOutlineErrorCode::kDegenerateInput;
      result.message =
          "bridge " + bridge.bendId + " references a region panel missing from evaluated result";
      return result;
    }

    std::vector<bool> parentTagged(parentPanel->regionEdgeBendId.size(), false);
    for (size_t i = 0; i < parentPanel->regionEdgeBendId.size(); ++i) {
      parentTagged[i] = (parentPanel->regionEdgeBendId[i] == bridge.bendId);
    }
    std::vector<bool> childTagged(childPanel->regionEdgeBendId.size(), false);
    for (size_t i = 0; i < childPanel->regionEdgeBendId.size(); ++i) {
      childTagged[i] = (childPanel->regionEdgeBendId[i] == bridge.bendId);
    }
    auto parentRuns = FindCyclicRuns(parentTagged);
    auto childRuns = FindCyclicRuns(childTagged);

    if (parentRuns.empty() || parentRuns.size() != childRuns.size()) {
      result.errorCode = FlatOutlineErrorCode::kDegenerateInput;
      result.message = "bridge " + bridge.bendId + " has " + std::to_string(parentRuns.size()) +
                        " parent-side tagged edge run(s) but " + std::to_string(childRuns.size()) +
                        " child-side run(s) — cannot pair them unambiguously";
      return result;
    }

    for (size_t runIdx = 0; runIdx < parentRuns.size(); ++runIdx) {
      std::vector<Point2> parentPoints = RunPoints(*parentPanel, parentRuns[runIdx]);
      std::vector<Point2> childPoints = RunPoints(*childPanel, childRuns[runIdx]);

      // Skip a degenerate (zero-width) strip — BA≈0, parent and child
      // edges already coincide (Evaluate()'s own no-op case at BA=0);
      // PolygonUnion would reject a zero-area strip as degenerate input.
      Point2 pc = Centroid(parentPoints);
      Point2 cc = Centroid(childPoints);
      double gap = std::hypot(pc.x - cc.x, pc.y - cc.y);
      if (gap < kGeometricEpsilon) continue;

      // The strip's own interior lies between parent's and child's — i.e.
      // on the OPPOSITE side of each edge from that panel's own interior.
      // Each panel's own tagged edge is stored in ITS OWN CCW traversal
      // order (interior on the left of that direction), so the strip must
      // traverse both edges in the REVERSE of their owning panel's order to
      // keep the strip's own interior consistently on the strip's own left
      // (this codebase's canonical CCW convention) — verified directly
      // against PolygonUnion (the naive un-reversed order produces a
      // clockwise-wound quad, which PolygonUnion — a real OCCT face build,
      // not winding-agnostic — then reports as two disjoint faces even
      // though the rings genuinely touch; see flat_outline_test.cc).
      std::vector<Point2> strip;
      strip.reserve(parentPoints.size() + childPoints.size());
      strip.insert(strip.end(), parentPoints.rbegin(), parentPoints.rend());
      strip.insert(strip.end(), childPoints.rbegin(), childPoints.rend());

      PolygonBooleanResult stripUnion = PolygonUnion(outline, strip);
      if (!stripUnion.ok) {
        result.errorCode = FlatOutlineErrorCode::kUnionFailed;
        result.message = "polygonUnion failed building the flat allowance strip for bend " +
                          bridge.bendId + ": " + stripUnion.message;
        return result;
      }
      outline = stripUnion.outer;
    }

    PolygonBooleanResult childUnion = PolygonUnion(outline, childPanel->regionOuter);
    if (!childUnion.ok) {
      result.errorCode = FlatOutlineErrorCode::kUnionFailed;
      result.message = "polygonUnion failed merging region panel " + childPanel->regionPanelId +
                        " into the flat outline: " + childUnion.message;
      return result;
    }
    outline = childUnion.outer;
  }

  result.ok = true;
  result.outer = std::move(outline);
  return result;
}

}  // namespace mcp_cad::translation
