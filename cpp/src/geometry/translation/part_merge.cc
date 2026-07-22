#include "geometry/translation/part_merge.hpp"

#include <algorithm>
#include <cmath>

namespace mcp_cad::translation {

namespace {

// Internal consistency epsilon: edgeA0/edgeA1 are read back from the SAME
// stored outline they're being matched against, so any gap here is float
// round-trip noise, not a real-world tolerance.
constexpr double kExactMatchEpsilonMm = 1e-6;

// The adjacency gate for "close enough to call two authored edges the same
// seam" (rebuild/17-numerical-policy.md OPEN-17.1) — kept a fixed constant
// for this slice rather than a profile-configurable budget, matching v1
// evidence (~2mm) and the doc's own "simplest thing that resolves the open
// point" framing.
constexpr double kMergeEdgeAlignmentToleranceMm = 2.0;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Length2(const Point2& v) { return std::hypot(v.x, v.y); }

bool NearlyEqual2(const Point2& a, const Point2& b, double eps) {
  return Length2(Sub2(a, b)) <= eps;
}

// Locates k such that outline[k] ~= p0 and outline[(k+1)%n] ~= p1 (order
// preserved) — a free edge is always an untouched, order-preserved copy of
// some edge of the part's one stored outline (regionOf's clip only ever
// replaces edges that cross a bend's hinge line), so this must succeed for
// any legitimately-resolved edge_ref.
int FindConsecutiveEdgeIndex(const std::vector<Point2>& outline, const Point2& p0, const Point2& p1) {
  const size_t n = outline.size();
  for (size_t i = 0; i < n; ++i) {
    if (NearlyEqual2(outline[i], p0, kExactMatchEpsilonMm) &&
        NearlyEqual2(outline[(i + 1) % n], p1, kExactMatchEpsilonMm)) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

// A rigid 2D transform: p -> R(p - pivot) + offset, R a pure rotation.
struct Rigid2 {
  double cosT = 1.0;
  double sinT = 0.0;
  Point2 pivot;
  Point2 offset;

  Point2 Apply(const Point2& p) const {
    Point2 v = Sub2(p, pivot);
    return {cosT * v.x - sinT * v.y + offset.x, sinT * v.x + cosT * v.y + offset.y};
  }
};

double Orient(const Point2& a, const Point2& b, const Point2& c) { return Cross2(Sub2(b, a), Sub2(c, a)); }

bool OnSegmentInclusive(const Point2& a, const Point2& b, const Point2& p) {
  double minX = std::min(a.x, b.x) - kExactMatchEpsilonMm;
  double maxX = std::max(a.x, b.x) + kExactMatchEpsilonMm;
  double minY = std::min(a.y, b.y) - kExactMatchEpsilonMm;
  double maxY = std::max(a.y, b.y) + kExactMatchEpsilonMm;
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

double Dot2(const Point2& a, const Point2& b) { return a.x * b.x + a.y * b.y; }

bool NearlyOnAllowedPoint(const Point2& p, const Point2& allowed0, const Point2& allowed1) {
  return NearlyEqual2(p, allowed0, kExactMatchEpsilonMm) || NearlyEqual2(p, allowed1, kExactMatchEpsilonMm);
}

// True if segments (p1,p2) and (p3,p4) meet anywhere OTHER than a single
// point at one of the two designated splice vertices (allowed0/allowed1 —
// edgeA0/edgeA1). A proper crossing is always bad; a collinear overlap of
// positive length is always bad EVEN IF it touches a splice vertex too
// (adjacent edges at a splice vertex must diverge immediately, not run on
// top of each other); touching at exactly one point is only fine if that
// point is a splice vertex.
bool SegmentsBadOverlap(const Point2& p1, const Point2& p2, const Point2& p3, const Point2& p4,
                         const Point2& allowed0, const Point2& allowed1) {
  constexpr double kOrientEps = 1e-9;
  const double d1 = Orient(p1, p2, p3);
  const double d2 = Orient(p1, p2, p4);
  const double d3 = Orient(p3, p4, p1);
  const double d4 = Orient(p3, p4, p2);

  const bool collinear = std::fabs(d1) < kOrientEps && std::fabs(d2) < kOrientEps;
  if (!collinear) {
    // General position: a proper interior crossing is always bad.
    if (((d1 > 0) != (d2 > 0)) && d1 != 0 && d2 != 0 && ((d3 > 0) != (d4 > 0)) && d3 != 0 && d4 != 0) {
      return true;
    }
    // Otherwise check for a touch (one segment's endpoint landing on the
    // other) — bad unless it's exactly a designated splice vertex.
    if (std::fabs(d1) < kOrientEps && OnSegmentInclusive(p1, p2, p3) && !NearlyOnAllowedPoint(p3, allowed0, allowed1)) return true;
    if (std::fabs(d2) < kOrientEps && OnSegmentInclusive(p1, p2, p4) && !NearlyOnAllowedPoint(p4, allowed0, allowed1)) return true;
    if (std::fabs(d3) < kOrientEps && OnSegmentInclusive(p3, p4, p1) && !NearlyOnAllowedPoint(p1, allowed0, allowed1)) return true;
    if (std::fabs(d4) < kOrientEps && OnSegmentInclusive(p3, p4, p2) && !NearlyOnAllowedPoint(p2, allowed0, allowed1)) return true;
    return false;
  }

  // Collinear: project all 4 points onto (p1,p2)'s own direction and compare
  // 1D intervals — this is the only reliable way to distinguish "overlaps
  // along a positive length" (always bad) from "touches at one point"
  // (fine only at a splice vertex).
  const Point2 dir = Sub2(p2, p1);
  const double dirLen = Length2(dir);
  if (dirLen < 1e-9) return false;
  const Point2 dHat{dir.x / dirLen, dir.y / dirLen};
  const double t1 = 0.0;
  const double t2 = dirLen;
  const double t3 = Dot2(Sub2(p3, p1), dHat);
  const double t4 = Dot2(Sub2(p4, p1), dHat);
  const double lo1 = std::min(t1, t2), hi1 = std::max(t1, t2);
  const double lo2 = std::min(t3, t4), hi2 = std::max(t3, t4);
  const double overlapLo = std::max(lo1, lo2);
  const double overlapHi = std::min(hi1, hi2);
  if (overlapHi - overlapLo < -kExactMatchEpsilonMm) return false;  // no overlap at all
  if (overlapHi - overlapLo > kExactMatchEpsilonMm) return true;    // positive-length overlap
  // Touches at (approximately) a single point — fine only at a splice vertex.
  Point2 touchPoint{p1.x + dHat.x * overlapLo, p1.y + dHat.y * overlapLo};
  return !NearlyOnAllowedPoint(touchPoint, allowed0, allowed1);
}

}  // namespace

ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineA, const Point2& edgeA0,
                                           const Point2& edgeA1, const std::vector<Point2>& outlineB,
                                           const Point2& edgeB0, const Point2& edgeB1) {
  ReconcileOutlinesResult result;

  const int k = FindConsecutiveEdgeIndex(outlineA, edgeA0, edgeA1);
  const int j = FindConsecutiveEdgeIndex(outlineB, edgeB0, edgeB1);
  if (k < 0 || j < 0) {
    result.errorCode = MergeErrorCode::kInvalidEdgeRef;
    result.message = "edge endpoints are not a consecutive pair in their own outline";
    return result;
  }

  const Point2 dA = Sub2(edgeA1, edgeA0);
  const Point2 dB = Sub2(edgeB1, edgeB0);
  const double lenA = Length2(dA);
  const double lenB = Length2(dB);
  if (std::fabs(lenA - lenB) > kMergeEdgeAlignmentToleranceMm) {
    result.errorCode = MergeErrorCode::kMergeEdgeMismatch;
    result.message = "edge lengths differ by more than the merge alignment tolerance";
    return result;
  }
  if (lenA < 1e-9 || lenB < 1e-9) {
    result.errorCode = MergeErrorCode::kInvalidEdgeRef;
    result.message = "degenerate (zero-length) seam edge";
    return result;
  }

  // T(edgeB0) = edgeA1, T(edgeB1) = edgeA0 — reversed correspondence, the one
  // rule that makes two CCW polygons share a boundary edge validly (see
  // part_merge.hpp).
  const double thetaB = std::atan2(dB.y, dB.x);
  const double thetaTarget = std::atan2(-dA.y, -dA.x);
  const double rot = thetaTarget - thetaB;
  Rigid2 xform;
  xform.cosT = std::cos(rot);
  xform.sinT = std::sin(rot);
  xform.pivot = edgeB0;
  xform.offset = edgeA1;

  std::vector<Point2> transformedB;
  transformedB.reserve(outlineB.size());
  for (const auto& v : outlineB) transformedB.push_back(xform.Apply(v));

  const size_t n = outlineA.size();
  const size_t m = outlineB.size();

  std::vector<Point2> combined;
  combined.reserve(n + m - 2);
  for (size_t i = 0; i <= static_cast<size_t>(k); ++i) combined.push_back(outlineA[i]);
  for (size_t t = 1; t + 1 < m; ++t) {
    size_t idx = (static_cast<size_t>(j) + 1 + t) % m;
    combined.push_back(transformedB[idx]);
  }
  for (size_t i = static_cast<size_t>(k) + 1; i < n; ++i) combined.push_back(outlineA[i]);

  // Self-intersection guard: A's edges (excluding the now-shared one) against
  // B's transformed edges (excluding the now-shared one). The only geometry
  // allowed to touch is exactly the two splice vertices (edgeA0/edgeA1),
  // and only as a single point — anything else (a proper crossing, or a
  // collinear run of positive length even if it also touches a splice
  // vertex) means the caller picked a mismatched/wrong edge pair.
  for (size_t i = 0; i < n; ++i) {
    if (i == static_cast<size_t>(k)) continue;
    const Point2& a1 = outlineA[i];
    const Point2& a2 = outlineA[(i + 1) % n];
    for (size_t b = 0; b < m; ++b) {
      if (b == static_cast<size_t>(j)) continue;
      const Point2& b1 = transformedB[b];
      const Point2& b2 = transformedB[(b + 1) % m];
      if (SegmentsBadOverlap(a1, a2, b1, b2, edgeA0, edgeA1)) {
        result.errorCode = MergeErrorCode::kMergeSelfIntersecting;
        result.message = "spliced outline would self-intersect — mismatched or wrong edge pair";
        return result;
      }
    }
  }

  result.ok = true;
  result.combinedOutline = std::move(combined);
  // Reversed from the literal edgeA0->edgeA1 order — see part_merge.hpp's
  // ReconcileOutlinesResult::hingeA/hingeB doc comment for why: A's own
  // material (always LEFT of its own directed edge, CCW) must land on the
  // RIGHT (parent) side of the bend the caller creates from this hinge.
  result.hingeA = edgeA1;
  result.hingeB = edgeA0;
  return result;
}

}  // namespace mcp_cad::translation
