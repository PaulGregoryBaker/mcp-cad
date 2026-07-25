#include "cut_panel.hpp"
#include "ring_containment.hpp"

#include <algorithm>
#include <string>

namespace mcp_cad::translation {
namespace {

// Shoelace signed area — positive means CCW, negative means CW. Same formula
// already inlined at geometry_service_shell.cc:850 and polygon_boolean.cc:116
// (no single shared helper exists to call instead; a third small inline copy
// of this one-line, universally-known formula follows the same established
// pattern those two already use, not a new divergence).
double SignedArea(const std::vector<Point2>& ring) {
  double area = 0.0;
  const size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

int FindContainingRegion(const std::vector<Point2>& ring,
                          const std::vector<std::vector<Point2>>& candidateRegions) {
  for (size_t i = 0; i < candidateRegions.size(); ++i) {
    if (RingFullyInsidePolygon(ring, candidateRegions[i])) return static_cast<int>(i);
  }
  return -1;
}

int FindContainingRegionForCircle(const Point2& center, double radiusMm,
                                   const std::vector<std::vector<Point2>>& candidateRegions) {
  for (size_t i = 0; i < candidateRegions.size(); ++i) {
    if (CircleFullyInsidePolygon(center, radiusMm, candidateRegions[i])) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

}  // namespace

CutPanelResult PrepareCircleCut(const Point2& center, double radiusMm,
                                 const std::vector<std::vector<Point2>>& candidateRegions) {
  CutPanelResult result;
  if (radiusMm <= 0.0) {
    result.errorCode = CutPanelErrorCode::kDegenerateInput;
    result.message = "circle cut radius must be positive, got " + std::to_string(radiusMm);
    return result;
  }

  const int regionIndex = FindContainingRegionForCircle(center, radiusMm, candidateRegions);
  if (regionIndex < 0) {
    result.errorCode = CutPanelErrorCode::kHoleNotContained;
    result.message = "circle cut does not fit fully within any candidate region panel";
    return result;
  }

  result.ok = true;
  result.regionIndex = regionIndex;
  return result;
}

CutPanelResult PreparePolygonCut(const std::vector<Point2>& ring,
                                  const std::vector<std::vector<Point2>>& candidateRegions) {
  CutPanelResult result;
  if (ring.size() < 3) {
    result.errorCode = CutPanelErrorCode::kDegenerateInput;
    result.message = "polygon cut ring must have at least 3 vertices, got " +
                      std::to_string(ring.size());
    return result;
  }

  // Canonicalize to CW (holes are CW, opposite the outer ring's CCW — same
  // convention ConstructPartSolid's hole-wire orientation relies on).
  std::vector<Point2> canonical = ring;
  if (SignedArea(canonical) > 0.0) {
    std::reverse(canonical.begin(), canonical.end());
  }

  const int regionIndex = FindContainingRegion(canonical, candidateRegions);
  if (regionIndex < 0) {
    result.errorCode = CutPanelErrorCode::kHoleNotContained;
    result.message = "polygon cut does not fit fully within any candidate region panel";
    return result;
  }

  result.ok = true;
  result.canonicalRing = std::move(canonical);
  result.regionIndex = regionIndex;
  return result;
}

}  // namespace mcp_cad::translation
