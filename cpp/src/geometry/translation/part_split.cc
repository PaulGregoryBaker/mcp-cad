#include "geometry/translation/part_split.hpp"

#include <algorithm>
#include <cmath>
#include <optional>

namespace mcp_cad::translation {

namespace {

constexpr double kGeometricEpsilon = 1e-9;
constexpr double kVertexMatchEpsilonMm = 1e-6;
constexpr double kPi = 3.14159265358979323846;

double DegToRad(double deg) { return deg * kPi / 180.0; }

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Dot2(const Point2& a, const Point2& b) { return a.x * b.x + a.y * b.y; }
double Length2(const Point2& v) { return std::sqrt(v.x * v.x + v.y * v.y); }

bool NearlyEqual2(const Point2& a, const Point2& b) {
  return Length2(Sub2(a, b)) <= kVertexMatchEpsilonMm;
}

// Whether this bend's bottom (z=0) reference is the concave side — same rule
// as manufacturing_graph_evaluator.cc's BottomIsConcave (mirrored, not
// shared — see this module's own header comment on why).
bool BottomIsConcave(const BendSpec& bend) {
  return bend.bottomIsConcave.has_value() ? *bend.bottomIsConcave : (bend.angleDeg >= 0.0);
}

struct GroundedLine {
  std::vector<Point2> ring;  // possibly with 2 new vertices inserted
  Point2 crossA, crossB;     // real ring-boundary points, nearer-to-lineA first
};

// Finds where the infinite line through (lineA, lineB) crosses `ring`'s own
// boundary — transversally (through the interior of some edge, the ordinary
// case: inserts the 2 new crossing points as real ring vertices) or, failing
// that, collinearly (the line runs exactly along part of the ring's own
// boundary, e.g. a wall flap already sitting on this exact line: no
// insertion needed, the two ring vertices bounding `[spanA, spanB]` on the
// line ARE the answer). Mirrors manufacturing_graph_evaluator.cc's
// EnsureHingeVertices, single-line/single-ring only (see this module's
// header comment on why that coupling isn't reused directly). Returns
// nullopt if neither search finds exactly 2 points — an ambiguous or
// degenerate cut, reported as a typed error by the caller rather than
// guessed.
std::optional<GroundedLine> GroundLine(const std::vector<Point2>& ring, Point2 lineA, Point2 lineB,
                                        Point2 spanA, Point2 spanB) {
  const size_t n = ring.size();
  std::vector<std::pair<size_t, Point2>> crossings;  // (edge index, crossing point)
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    double crossA = Cross2(Sub2(lineB, lineA), Sub2(a, lineA));
    double crossB = Cross2(Sub2(lineB, lineA), Sub2(b, lineA));
    if (std::fabs(crossA) < kGeometricEpsilon || std::fabs(crossB) < kGeometricEpsilon) {
      continue;  // touches at (or right next to) an existing vertex — not a clean crossing
    }
    if ((crossA > 0.0) == (crossB > 0.0)) continue;  // doesn't cross this edge
    Point2 d1 = Sub2(b, a);
    Point2 d2 = Sub2(lineB, lineA);
    double denom = Cross2(d1, d2);
    if (std::fabs(denom) < kGeometricEpsilon) continue;  // parallel
    double t = Cross2(Sub2(lineA, a), d2) / denom;
    crossings.push_back({i, {a.x + d1.x * t, a.y + d1.y * t}});
  }

  if (crossings.size() == 2) {
    Point2 p0 = crossings[0].second;
    Point2 p1 = crossings[1].second;
    bool p0IsNearA = Length2(Sub2(p0, lineA)) <= Length2(Sub2(p1, lineA));
    GroundedLine out;
    out.crossA = p0IsNearA ? p0 : p1;
    out.crossB = p0IsNearA ? p1 : p0;
    // Insert from the highest edge index down so earlier indices stay valid.
    std::sort(crossings.begin(), crossings.end(),
              [](const auto& x, const auto& y) { return x.first > y.first; });
    out.ring = ring;
    for (const auto& [edgeIdx, pt] : crossings) {
      out.ring.insert(out.ring.begin() + static_cast<long>(edgeIdx + 1), pt);
    }
    return out;
  }

  // No clean transversal crossing — look for the line running collinear with
  // existing ring edges instead (see GroundLine's own header comment).
  Point2 dir = Sub2(spanA, spanB);
  double dirLenSq = dir.x * dir.x + dir.y * dir.y;
  std::vector<size_t> onLine;
  if (dirLenSq >= kGeometricEpsilon) {
    for (size_t i = 0; i < n; ++i) {
      double cross = Cross2(dir, Sub2(ring[i], spanB));
      if (std::fabs(cross) >= kGeometricEpsilon) continue;
      double t = Dot2(Sub2(ring[i], spanB), dir) / dirLenSq;
      if (t >= -1e-6 && t <= 1.0 + 1e-6) onLine.push_back(i);
    }
  }
  if (onLine.size() != 2) return std::nullopt;

  Point2 p0 = ring[onLine[0]];
  Point2 p1 = ring[onLine[1]];
  bool p0IsNearA = Length2(Sub2(p0, lineA)) <= Length2(Sub2(p1, lineA));
  GroundedLine out;
  out.ring = ring;
  out.crossA = p0IsNearA ? p0 : p1;
  out.crossB = p0IsNearA ? p1 : p0;
  return out;
}

}  // namespace

SplitAtBendResult SplitPartAtBend(const std::vector<Point2>& outline, const BendSpec& bend,
                                   double thicknessMm, CornerSide keepCornerOn) {
  SplitAtBendResult result;

  auto groundedHinge = GroundLine(outline, bend.hingeA, bend.hingeB, bend.hingeA, bend.hingeB);
  if (!groundedHinge) {
    result.errorCode = SplitErrorCode::kHingeNotGrounded;
    result.message = "bend hinge does not cross the part outline at exactly 2 points";
    return result;
  }

  // Left-hand normal of hingeA->hingeB, pointing toward the child side — same
  // convention as manufacturing_graph_evaluator.cc's BuildBendCuts.
  Point2 dir = Sub2(groundedHinge->crossB, groundedHinge->crossA);
  double len = Length2(dir);
  Point2 nLeft{0.0, 0.0};
  if (len >= kGeometricEpsilon) nLeft = {-dir.y / len, dir.x / len};

  // Bit-for-bit the same signed setback manufacturing_graph_evaluator.cc's
  // BuildBendCuts uses to trim RegionPanelLayout::wallOuter (NOT
  // ComputeBendGeometry's kFactor-inclusive setbackMm — see that file's own
  // comment on why these are two different, both-real quantities). This is
  // the true physical tangent-line offset; kFactor never enters it, which is
  // exactly why the flush side ends up carrying none of the kFactor-driven
  // bend-allowance stretch.
  bool concave = BottomIsConcave(bend);
  double signedD = concave ? bend.radiusMm : -bend.radiusMm;
  double sb = signedD * std::tan(DegToRad(bend.angleDeg) / 2.0);

  // Cutting at a side's OWN natural tangent line (BuildBendCuts' childShift/
  // parentShift — hinge -+ sb*nLeft, the same real, corner-reaching extent
  // wallOuter would trim that side to) leaves THAT side with its normal
  // shape and gives the OTHER side everything else — which, since the two
  // tangent lines straddle the raw hinge in OPPOSITE directions, is LESS
  // than that other side's own natural extent (it loses the whole 2*sb
  // band, ending up trimmed past even a raw-hinge cut). So: cut at CHILD's
  // own tangent (hinge - sb*nLeft) to give child its normal, corner-
  // reaching shape and leave parent harshly trimmed; cut at PARENT's own
  // tangent (hinge + sb*nLeft) for the reverse.
  Point2 shift = keepCornerOn == CornerSide::kChild ? Point2{-sb * nLeft.x, -sb * nLeft.y}
                                                     : Point2{sb * nLeft.x, sb * nLeft.y};
  Point2 cutA = {groundedHinge->crossA.x + shift.x, groundedHinge->crossA.y + shift.y};
  Point2 cutB = {groundedHinge->crossB.x + shift.x, groundedHinge->crossB.y + shift.y};

  auto groundedCut = GroundLine(outline, cutA, cutB, cutA, cutB);
  if (!groundedCut) {
    result.errorCode = SplitErrorCode::kCornerZoneNotGrounded;
    result.message =
        "the corner-biased cut line does not cross the part outline at exactly 2 points — "
        "the flush side's own material may be narrower than the bend's setback";
    return result;
  }

  const std::vector<Point2>& ring = groundedCut->ring;
  const size_t n = ring.size();
  auto findVertex = [&](const Point2& p) -> std::optional<size_t> {
    for (size_t i = 0; i < n; ++i) {
      if (NearlyEqual2(ring[i], p)) return i;
    }
    return std::nullopt;
  };
  auto iA = findVertex(groundedCut->crossA);
  auto iB = findVertex(groundedCut->crossB);
  if (!iA || !iB || *iA == *iB) {
    result.errorCode = SplitErrorCode::kDegenerateResult;
    result.message = "cut points could not be located as distinct ring vertices";
    return result;
  }

  std::vector<Point2> chainAB;  // ring order from iA to iB (inclusive)
  for (size_t i = *iA;; i = (i + 1) % n) {
    chainAB.push_back(ring[i]);
    if (i == *iB) break;
  }
  std::vector<Point2> chainBA;  // ring order from iB to iA (inclusive)
  for (size_t i = *iB;; i = (i + 1) % n) {
    chainBA.push_back(ring[i]);
    if (i == *iA) break;
  }

  if (chainAB.size() < 3 || chainBA.size() < 3) {
    result.errorCode = SplitErrorCode::kDegenerateResult;
    result.message = "split would produce a ring with fewer than 3 vertices";
    return result;
  }

  // Classify chainAB by which side of the cut line its own (non-endpoint)
  // material sits on — nLeft points toward the child.
  Point2 sample = chainAB[1];
  double side = Dot2(Sub2(sample, groundedCut->crossA), nLeft);
  bool chainABIsChild = side > 0.0;

  result.ok = true;
  result.childOutline = chainABIsChild ? chainAB : chainBA;
  result.parentOutline = chainABIsChild ? chainBA : chainAB;
  return result;
}

}  // namespace mcp_cad::translation
