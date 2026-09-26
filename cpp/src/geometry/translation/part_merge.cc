#include "geometry/translation/part_merge.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <optional>

namespace mcp_cad::translation {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Float noise only: two coordinates that came from the same stored value
// (panel rings are copied from the part outline) are "the same point" within
// this, and never anything farther apart.
constexpr double kExactMatchEpsilonMm = 1e-6;

// The one real-world tolerance: how far apart two independently-anchored
// parts' boundaries may be and still be the same physical seam
// (numerical-policy.ts MERGE_EDGE_ALIGNMENT_TOLERANCE_MM). Used for exactly
// two questions: is a B boundary point on A's panel line (in 3D, via A's
// panel frame), and are A's and B's corners at a seam end the same corner.
constexpr double kMergeContactToleranceMm = 2.0;

// Below this dihedral angle a contact is a flush absorb (fuse_bodies), not a
// fold (TASK_SPEC.md F7).
constexpr double kCoplanarAngleEpsilonDeg = 1.0;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Length2(const Point2& v) { return std::hypot(v.x, v.y); }
double Dot2(const Point2& a, const Point2& b) { return a.x * b.x + a.y * b.y; }
bool NearlyEqual2(const Point2& a, const Point2& b, double eps) { return Length2(Sub2(a, b)) <= eps; }
Point2 Lerp2(const Point2& a, const Point2& b, double f) {
  return {a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f};
}

Point3 Sub3(const Point3& a, const Point3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double Dot3(const Point3& a, const Point3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Point3 Cross3(const Point3& a, const Point3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
double Length3(const Point3& v) { return std::sqrt(Dot3(v, v)); }

// ─── Outline references ─────────────────────────────────────────────────────

Point2 RefPoint(const std::vector<Point2>& outline, const OutlineRef& r) {
  const Point2& a = outline[static_cast<size_t>(r.edgeIndex)];
  if (r.t == 0.0) return a;
  return Lerp2(a, outline[(static_cast<size_t>(r.edgeIndex) + 1) % outline.size()], r.t);
}

bool PointOnSegment(const Point2& p, const Point2& a, const Point2& b) {
  const Point2 d = Sub2(b, a);
  const double len = Length2(d);
  if (len < kExactMatchEpsilonMm) return NearlyEqual2(p, a, kExactMatchEpsilonMm);
  const double along = Dot2(Sub2(p, a), d) / len;
  if (along < -kExactMatchEpsilonMm || along > len + kExactMatchEpsilonMm) return false;
  return std::fabs(Cross2(d, Sub2(p, a))) / len <= kExactMatchEpsilonMm;
}

// Where point p (known to lie on the outline boundary) sits, as a ref.
// Vertices win over mid-edge so a vertex is always t == 0 on its own edge.
std::optional<OutlineRef> RefOf(const std::vector<Point2>& outline, const Point2& p) {
  const size_t n = outline.size();
  for (size_t i = 0; i < n; ++i) {
    if (NearlyEqual2(outline[i], p, kExactMatchEpsilonMm)) return OutlineRef{static_cast<int>(i), 0.0};
  }
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = outline[i];
    const Point2& b = outline[(i + 1) % n];
    if (!PointOnSegment(p, a, b)) continue;
    const Point2 d = Sub2(b, a);
    return OutlineRef{static_cast<int>(i), Dot2(Sub2(p, a), d) / Dot2(d, d)};
  }
  return std::nullopt;
}

// A panel ring edge is FREE if it lies along the part's outline boundary
// (both endpoints on the boundary, and its midpoint too — which rules out a
// hinge chord whose two endpoints are boundary vertices but which cuts across
// the interior). Hinge edges are internal and can never be a seam.
std::vector<bool> FreeEdges(const std::vector<Point2>& ring, const std::vector<Point2>& outline) {
  std::vector<bool> free(ring.size(), false);
  for (size_t i = 0; i < ring.size(); ++i) {
    const Point2& p = ring[i];
    const Point2& q = ring[(i + 1) % ring.size()];
    const Point2 mid = Lerp2(p, q, 0.5);
    for (size_t k = 0; k < outline.size(); ++k) {
      const Point2& a = outline[k];
      const Point2& b = outline[(k + 1) % outline.size()];
      if (PointOnSegment(mid, a, b)) {
        free[i] = RefOf(outline, p).has_value() && RefOf(outline, q).has_value();
        break;
      }
    }
  }
  return free;
}

// ─── DetectContact ──────────────────────────────────────────────────────────

struct FoundRegion {
  Point2 aStart2D;  // A-panel frame (== A's flat frame F), A's forward-walk order
  Point2 aEnd2D;
  Point2 bStartLocal;  // B's flat frame: B's point at A's END (opposite order)
  Point2 bEndLocal;    // B's point at A's START
  double lengthMm = 0.0;
  bool flipped = false;  // B walks the seam the same way as A (B's normal reversed)
};

// One (panelA, panelB) pair. Transforms B's panel ring into A's panel frame,
// finds each straight run of B's FREE edges lying on A's panel plane, and
// matches it against A's FREE edges collinear with it. Each seam end is the
// INNER corner — the one both parts reach. The other part's closest vertex to
// that corner (3D distance), if any lies within kMergeContactToleranceMm, is
// the same physical corner, so each side keeps its own exact vertex.
// Otherwise the other part gets that corner's position on its own real edge.
void DetectContactForPanelPair(const std::vector<Point2>& ringA, const std::vector<bool>& freeA,
                                const Transform3& poseA, const std::vector<Point2>& ringB,
                                const std::vector<bool>& freeB, const Transform3& poseB,
                                std::vector<FoundRegion>& outFound, bool& outCoplanar) {
  const size_t n = ringA.size();
  const size_t m = ringB.size();

  const Transform3 bToA = poseA.Inverse().Compose(poseB);
  std::vector<Point3> bInA(m);
  for (size_t i = 0; i < m; ++i) bInA[i] = bToA.Apply({ringB[i].x, ringB[i].y, 0.0});

  std::vector<bool> onPlane(m);
  bool allOnPlane = true;
  for (size_t i = 0; i < m; ++i) {
    onPlane[i] = std::fabs(bInA[i].z) <= kMergeContactToleranceMm;
    allOnPlane = allOnPlane && onPlane[i];
  }
  if (allOnPlane) {
    outCoplanar = true;
    return;
  }

  std::vector<bool> edgeOnPlane(m);
  for (size_t i = 0; i < m; ++i) edgeOnPlane[i] = freeB[i] && onPlane[i] && onPlane[(i + 1) % m];

  // Some vertex is off the plane, so some edge is not on it: start the walk
  // just after one, so no run wraps across the walk's own start.
  size_t start = 0;
  while (edgeOnPlane[start]) ++start;
  std::vector<std::pair<size_t, size_t>> runs;  // (first vertex, last vertex) walking B forward
  for (size_t step = 1; step <= m;) {
    const size_t i = (start + step) % m;
    if (!edgeOnPlane[i]) {
      ++step;
      continue;
    }
    size_t last = i;
    size_t edges = 0;
    while (edgeOnPlane[(i + edges) % m]) {
      ++edges;
      last = (i + edges) % m;
    }
    runs.push_back({i, last});
    step += edges;
  }

  // A seam is a straight line: split each on-plane run wherever it turns a
  // corner (a vertex farther than the tolerance from the line so far).
  auto xyB = [&](size_t k) { return Point2{bInA[k].x, bInA[k].y}; };
  std::vector<std::pair<size_t, size_t>> straightRuns;
  for (const auto& [r0, r1] : runs) {
    size_t s = r0;
    while (s != r1) {
      size_t e = (s + 1) % m;
      while (e != r1) {
        const size_t next = (e + 1) % m;
        const Point2 d = Sub2(xyB(next), xyB(s));
        const double len = Length2(d);
        bool straight = len > kExactMatchEpsilonMm;
        for (size_t k = (s + 1) % m; straight && k != next; k = (k + 1) % m) {
          straight = std::fabs(Cross2(d, Sub2(xyB(k), xyB(s)))) / len <= kMergeContactToleranceMm;
        }
        if (!straight) break;
        e = next;
      }
      straightRuns.push_back({s, e});
      s = e;
    }
  }

  for (const auto& [r0, r1] : straightRuns) {
    const Point2 runStart = xyB(r0);
    const Point2 runEnd = xyB(r1);
    const double runLen = Length2(Sub2(runEnd, runStart));
    if (runLen <= kExactMatchEpsilonMm) continue;
    const Point2 runDir{(runEnd.x - runStart.x) / runLen, (runEnd.y - runStart.y) / runLen};
    auto along = [&](const Point2& p) { return Dot2(Sub2(p, runStart), runDir); };
    auto offLine = [&](const Point2& p) { return std::fabs(Cross2(runDir, Sub2(p, runStart))); };

    // A's free edges collinear with the run and overlapping it, grouped by
    // which way A walks them. Two CCW outlines sharing a seam walk it in
    // opposite directions; A walking WITH B's run means B's sheet normal is
    // reversed relative to A there (a flipped seam) — still a real contact.
    struct Cover {
      size_t edge;
      double t1, t2;  // along-run params of ringA[edge], ringA[edge+1]
    };
    std::vector<Cover> againstRun, withRun;
    for (size_t i = 0; i < n; ++i) {
      if (!freeA[i]) continue;
      const Point2& a1 = ringA[i];
      const Point2& a2 = ringA[(i + 1) % n];
      if (offLine(a1) > kMergeContactToleranceMm || offLine(a2) > kMergeContactToleranceMm) continue;
      const double t1 = along(a1);
      const double t2 = along(a2);
      const double overlap = std::min(std::max(t1, t2), runLen) - std::max(std::min(t1, t2), 0.0);
      if (overlap <= kExactMatchEpsilonMm) continue;
      (t2 < t1 ? againstRun : withRun).push_back({i, t1, t2});
    }

    for (const bool flipped : {false, true}) {
    const std::vector<Cover>& covers = flipped ? withRun : againstRun;
    if (covers.empty()) continue;

    double aLo = std::numeric_limits<double>::infinity();
    double aHi = -std::numeric_limits<double>::infinity();
    size_t aLoVertex = 0, aHiVertex = 0;
    for (const auto& c : covers) {
      const size_t v1 = c.edge;
      const size_t v2 = (c.edge + 1) % n;
      if (c.t1 < aLo) { aLo = c.t1; aLoVertex = v1; }
      if (c.t2 < aLo) { aLo = c.t2; aLoVertex = v2; }
      if (c.t1 > aHi) { aHi = c.t1; aHiVertex = v1; }
      if (c.t2 > aHi) { aHi = c.t2; aHiVertex = v2; }
    }

    // A's point at along-run param t, on the real A edge containing it.
    auto aPointAt = [&](double t) -> std::optional<Point2> {
      for (const auto& c : covers) {
        const double lo = std::min(c.t1, c.t2);
        const double hi = std::max(c.t1, c.t2);
        if (t >= lo - kExactMatchEpsilonMm && t <= hi + kExactMatchEpsilonMm) {
          return Lerp2(ringA[c.edge], ringA[(c.edge + 1) % n], (t - c.t1) / (c.t2 - c.t1));
        }
      }
      return std::nullopt;
    };
    // B's point (in B's own frame) at along-run param t, on the real B edge.
    auto bPointAt = [&](double t) -> std::optional<Point2> {
      for (size_t k = r0; k != r1; k = (k + 1) % m) {
        const size_t k2 = (k + 1) % m;
        const double tk = along({bInA[k].x, bInA[k].y});
        const double tk2 = along({bInA[k2].x, bInA[k2].y});
        if (t >= tk - kExactMatchEpsilonMm && t <= tk2 + kExactMatchEpsilonMm && tk2 > tk) {
          return Lerp2(ringB[k], ringB[k2], (t - tk) / (tk2 - tk));
        }
      }
      return std::nullopt;
    };

    // Candidate corners on each side, in A's panel frame (3D).
    std::vector<size_t> bVerts;  // B ring indices along this run
    for (size_t k = r0;; k = (k + 1) % m) {
      bVerts.push_back(k);
      if (k == r1) break;
    }
    std::vector<size_t> aVerts;  // A ring indices at the ends of covering edges
    for (const auto& c : covers) {
      aVerts.push_back(c.edge);
      aVerts.push_back((c.edge + 1) % n);
    }
    auto aIn = [&](size_t i) { return Point3{ringA[i].x, ringA[i].y, 0.0}; };
    auto closestWithinTolerance = [&](const std::vector<size_t>& verts, auto&& at,
                                      const Point3& p) -> std::optional<size_t> {
      std::optional<size_t> best;
      double bestDist = kMergeContactToleranceMm;
      for (size_t v : verts) {
        const double d = Length3(Sub3(at(v), p));
        if (d <= bestDist) {
          bestDist = d;
          best = v;
        }
      }
      return best;
    };

    struct End {
      Point2 a, b;
      bool ok = true;
    };
    // tA/aVertex: A's outermost covering corner at this end; tB/bVertex:
    // B's run corner. The inner one (reached by both) is the seam end.
    auto resolveEnd = [&](double tA, size_t aVertex, double tB, size_t bVertex, bool loEnd) {
      End e;
      const bool aInner = loEnd ? tA >= tB : tA <= tB;
      if (aInner) {
        e.a = ringA[aVertex];
        if (auto k = closestWithinTolerance(bVerts, [&](size_t v) { return bInA[v]; }, aIn(aVertex))) {
          e.b = ringB[*k];
        } else if (auto b = bPointAt(tA)) {
          e.b = *b;
        } else {
          e.ok = false;
        }
      } else {
        e.b = ringB[bVertex];
        if (auto k = closestWithinTolerance(aVerts, aIn, bInA[bVertex])) {
          e.a = ringA[*k];
        } else if (auto a = aPointAt(tB)) {
          e.a = *a;
        } else {
          e.ok = false;
        }
      }
      return e;
    };
    const End lo = resolveEnd(aLo, aLoVertex, 0.0, r0, /*loEnd=*/true);
    const End hi = resolveEnd(aHi, aHiVertex, runLen, r1, /*loEnd=*/false);
    // An end over a gap in A's coverage: A doesn't actually reach there.
    if (!lo.ok || !hi.ok) continue;
    const double seamLen = Length2(Sub2(hi.a, lo.a));
    if (seamLen <= kExactMatchEpsilonMm || NearlyEqual2(hi.b, lo.b, kExactMatchEpsilonMm)) continue;

    // aStart is where A's own walk enters the seam; bStart is B's point at
    // A's END (the physical correspondence ReconcileOutlines relies on).
    FoundRegion region;
    const End& aEntry = flipped ? lo : hi;
    const End& aExit = flipped ? hi : lo;
    region.aStart2D = aEntry.a;
    region.aEnd2D = aExit.a;
    region.bStartLocal = aExit.b;
    region.bEndLocal = aEntry.b;
    region.lengthMm = seamLen;
    region.flipped = flipped;
    outFound.push_back(region);
    }  // for flipped
  }
}

}  // namespace

DetectContactResult DetectContact(const std::vector<Point2>& outlineA,
                                   const std::vector<ContactPanelCandidate>& panelsA,
                                   const std::vector<Point2>& outlineB,
                                   const std::vector<ContactPanelCandidate>& panelsB) {
  DetectContactResult result;
  if (outlineA.size() < 3 || outlineB.size() < 3 || panelsA.empty() || panelsB.empty()) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "both parts need an outline of at least 3 vertices and at least one panel";
    return result;
  }
  auto freeEdgesOf = [&](const std::vector<ContactPanelCandidate>& panels, const std::vector<Point2>& outline,
                         const char* side, std::vector<std::vector<bool>>& out) -> bool {
    for (const auto& panel : panels) {
      if (panel.outline.size() < 3) {
        result.errorCode = MergeErrorCode::kInternalInconsistency;
        result.message = std::string("panel ") + panel.regionPanelId + " (part " + side +
                         ") outline must have at least 3 vertices";
        return false;
      }
      out.push_back(FreeEdges(panel.outline, outline));
    }
    return true;
  };
  std::vector<std::vector<bool>> freeA, freeB;
  if (!freeEdgesOf(panelsA, outlineA, "A", freeA) || !freeEdgesOf(panelsB, outlineB, "B", freeB)) return result;

  // B's outline as FlipPart (manufacturing_graph_evaluator.hpp) re-expresses
  // it: reversed and mirrored, so vertex i becomes vertex n-1-i.
  const size_t nB = outlineB.size();
  std::vector<Point2> flippedOutlineB(outlineB.rbegin(), outlineB.rend());
  for (auto& p : flippedOutlineB) p.x = -p.x;
  auto flippedRef = [nB](const OutlineRef& r) {
    const size_t e = static_cast<size_t>(r.edgeIndex);
    if (r.t == 0.0) return OutlineRef{static_cast<int>(nB - 1 - e), 0.0};
    return OutlineRef{static_cast<int>((2 * nB - 2 - e) % nB), 1.0 - r.t};
  };

  bool sawCoplanarPair = false;
  for (size_t ia = 0; ia < panelsA.size(); ++ia) {
    const auto& panelA = panelsA[ia];
    for (size_t ib = 0; ib < panelsB.size(); ++ib) {
      const auto& panelB = panelsB[ib];
      std::vector<FoundRegion> pairFound;
      bool pairCoplanar = false;
      DetectContactForPanelPair(panelA.outline, freeA[ia], panelA.pose, panelB.outline, freeB[ib], panelB.pose,
                                 pairFound, pairCoplanar);
      if (pairCoplanar) sawCoplanarPair = true;

      for (const auto& fr : pairFound) {
        // Signed dihedral angle about the REAL bend's hinge axis (hingeA =
        // aRunEnd -> hingeB = aRunStart, ReconcileOutlines' reversed order),
        // the axis convention Evaluate's pose walk uses, from THIS pair's own
        // panel poses. For a flipped seam, B's normal as FlipPart leaves it
        // (reversed) — the fold the merge will actually create.
        const Point3 hingeAWorld = panelA.pose.Apply({fr.aEnd2D.x, fr.aEnd2D.y, 0.0});
        const Point3 hingeBWorld = panelA.pose.Apply({fr.aStart2D.x, fr.aStart2D.y, 0.0});
        Point3 axis = Sub3(hingeBWorld, hingeAWorld);
        const double axisLen = Length3(axis);
        axis = {axis.x / axisLen, axis.y / axisLen, axis.z / axisLen};
        const Point3 nA = panelA.pose.ApplyVector({0.0, 0.0, 1.0});
        const double sign = fr.flipped ? -1.0 : 1.0;
        const Point3 nB = panelB.pose.ApplyVector({0.0, 0.0, sign});
        const double angleDeg = std::atan2(Dot3(Cross3(nA, nB), axis), Dot3(nA, nB)) * 180.0 / kPi;
        if (std::fabs(angleDeg) < kCoplanarAngleEpsilonDeg) {
          sawCoplanarPair = true;
          continue;
        }

        const auto aStart = RefOf(outlineA, fr.aStart2D);
        const auto aEnd = RefOf(outlineA, fr.aEnd2D);
        const auto bStart = RefOf(outlineB, fr.bStartLocal);
        const auto bEnd = RefOf(outlineB, fr.bEndLocal);
        if (!aStart || !aEnd || !bStart || !bEnd) {
          result.regions.clear();
          result.errorCode = MergeErrorCode::kInternalInconsistency;
          result.message = "a seam end found on a free panel edge of " + panelA.regionPanelId + "/" +
                           panelB.regionPanelId + " is not on its part's outline";
          return result;
        }

        ContactRegion region;
        region.flipped = fr.flipped;
        region.aStart = *aStart;
        region.aEnd = *aEnd;
        region.bStart = fr.flipped ? flippedRef(*bStart) : *bStart;
        region.bEnd = fr.flipped ? flippedRef(*bEnd) : *bEnd;
        const std::vector<Point2>& bOutline = fr.flipped ? flippedOutlineB : outlineB;
        region.aRunStart = RefPoint(outlineA, region.aStart);
        region.aRunEnd = RefPoint(outlineA, region.aEnd);
        region.bRunStart = RefPoint(bOutline, region.bStart);
        region.bRunEnd = RefPoint(bOutline, region.bEnd);
        region.angleDeg = angleDeg;
        region.lengthMm = fr.lengthMm;
        region.regionPanelIdA = panelA.regionPanelId;
        region.regionPanelIdB = panelB.regionPanelId;
        result.regions.push_back(region);
      }
    }
  }

  if (result.regions.empty()) {
    if (sawCoplanarPair) {
      result.errorCode = MergeErrorCode::kCoplanarSeam;
      result.message = "the only real contact between these parts is genuinely coplanar (angle ~= 0) — "
                        "this is a flush absorb (fuse_bodies), not a fold";
    } else {
      result.errorCode = MergeErrorCode::kNoContact;
      result.message = "no real boundary contact found between the two parts' panels, within " +
                        std::to_string(kMergeContactToleranceMm) + "mm";
    }
    return result;
  }
  result.ok = true;
  return result;
}

// ─── ReconcileOutlines ───────────────────────────────────────────────────────

namespace {

double Orient(const Point2& a, const Point2& b, const Point2& c) { return Cross2(Sub2(b, a), Sub2(c, a)); }

bool OnSegmentInclusive(const Point2& a, const Point2& b, const Point2& p) {
  double minX = std::min(a.x, b.x) - kExactMatchEpsilonMm;
  double maxX = std::max(a.x, b.x) + kExactMatchEpsilonMm;
  double minY = std::min(a.y, b.y) - kExactMatchEpsilonMm;
  double maxY = std::max(a.y, b.y) + kExactMatchEpsilonMm;
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

bool NearlyOnAllowedPoint(const Point2& p, const Point2& allowed0, const Point2& allowed1) {
  return NearlyEqual2(p, allowed0, kExactMatchEpsilonMm) || NearlyEqual2(p, allowed1, kExactMatchEpsilonMm);
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

// True if segments (p1,p2) and (p3,p4) meet anywhere other than a single
// point at one of the two splice vertices. A proper crossing, or a collinear
// overlap of positive length, is always bad.
bool SegmentsBadOverlap(const Point2& p1, const Point2& p2, const Point2& p3, const Point2& p4,
                         const Point2& allowed0, const Point2& allowed1) {
  constexpr double kOrientEps = 1e-9;
  const double d1 = Orient(p1, p2, p3);
  const double d2 = Orient(p1, p2, p4);
  const double d3 = Orient(p3, p4, p1);
  const double d4 = Orient(p3, p4, p2);

  const bool collinear = std::fabs(d1) < kOrientEps && std::fabs(d2) < kOrientEps;
  if (!collinear) {
    if (((d1 > 0) != (d2 > 0)) && d1 != 0 && d2 != 0 && ((d3 > 0) != (d4 > 0)) && d3 != 0 && d4 != 0) {
      return true;
    }
    if (std::fabs(d1) < kOrientEps && OnSegmentInclusive(p1, p2, p3) && !NearlyOnAllowedPoint(p3, allowed0, allowed1)) return true;
    if (std::fabs(d2) < kOrientEps && OnSegmentInclusive(p1, p2, p4) && !NearlyOnAllowedPoint(p4, allowed0, allowed1)) return true;
    if (std::fabs(d3) < kOrientEps && OnSegmentInclusive(p3, p4, p1) && !NearlyOnAllowedPoint(p1, allowed0, allowed1)) return true;
    if (std::fabs(d4) < kOrientEps && OnSegmentInclusive(p3, p4, p2) && !NearlyOnAllowedPoint(p2, allowed0, allowed1)) return true;
    return false;
  }

  const Point2 dir = Sub2(p2, p1);
  const double dirLen = Length2(dir);
  if (dirLen < 1e-9) return false;
  const Point2 dHat{dir.x / dirLen, dir.y / dirLen};
  const double t3 = Dot2(Sub2(p3, p1), dHat);
  const double t4 = Dot2(Sub2(p4, p1), dHat);
  const double overlapLo = std::max(0.0, std::min(t3, t4));
  const double overlapHi = std::min(dirLen, std::max(t3, t4));
  if (overlapHi - overlapLo < -kExactMatchEpsilonMm) return false;
  if (overlapHi - overlapLo > kExactMatchEpsilonMm) return true;
  Point2 touchPoint{p1.x + dHat.x * overlapLo, p1.y + dHat.y * overlapLo};
  return !NearlyOnAllowedPoint(touchPoint, allowed0, allowed1);
}

bool ValidRef(const OutlineRef& r, size_t n) {
  return r.edgeIndex >= 0 && static_cast<size_t>(r.edgeIndex) < n && r.t >= 0.0 && r.t < 1.0;
}

// `outline` with any mid-edge refs' points inserted; idx0/idx1 are the two
// refs' vertex indices in the returned ring.
std::vector<Point2> WithRefVertices(const std::vector<Point2>& outline, const OutlineRef& r0,
                                    const OutlineRef& r1, size_t& idx0, size_t& idx1) {
  std::vector<Point2> out;
  out.reserve(outline.size() + 2);
  for (size_t e = 0; e < outline.size(); ++e) {
    out.push_back(outline[e]);
    if (static_cast<size_t>(r0.edgeIndex) == e && r0.t == 0.0) idx0 = out.size() - 1;
    if (static_cast<size_t>(r1.edgeIndex) == e && r1.t == 0.0) idx1 = out.size() - 1;
    std::vector<std::pair<double, int>> mids;
    if (static_cast<size_t>(r0.edgeIndex) == e && r0.t > 0.0) mids.push_back({r0.t, 0});
    if (static_cast<size_t>(r1.edgeIndex) == e && r1.t > 0.0) mids.push_back({r1.t, 1});
    std::sort(mids.begin(), mids.end());
    for (const auto& [t, which] : mids) {
      out.push_back(Lerp2(outline[e], outline[(e + 1) % outline.size()], t));
      (which == 0 ? idx0 : idx1) = out.size() - 1;
    }
  }
  return out;
}

}  // namespace

ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineAIn, const OutlineRef& a0,
                                           const OutlineRef& a1, const std::vector<Point2>& outlineBIn,
                                           const OutlineRef& b0, const OutlineRef& b1,
                                           const std::vector<Point2>& carryB) {
  ReconcileOutlinesResult result;
  if (!ValidRef(a0, outlineAIn.size()) || !ValidRef(a1, outlineAIn.size()) || !ValidRef(b0, outlineBIn.size()) ||
      !ValidRef(b1, outlineBIn.size())) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "seam reference out of range for its outline";
    return result;
  }

  size_t kFinalU = 0, a1IdxU = 0, jFinalU = 0, b1IdxU = 0;
  const std::vector<Point2> outlineA = WithRefVertices(outlineAIn, a0, a1, kFinalU, a1IdxU);
  const std::vector<Point2> outlineB = WithRefVertices(outlineBIn, b0, b1, jFinalU, b1IdxU);
  const size_t n = outlineA.size();
  const size_t m = outlineB.size();
  if (kFinalU == a1IdxU || jFinalU == b1IdxU) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "degenerate (zero-length) seam";
    return result;
  }
  const Point2 edgeA0 = outlineA[kFinalU];
  const Point2 edgeA1 = outlineA[a1IdxU];
  const Point2 edgeB0 = outlineB[jFinalU];
  const Point2 edgeB1 = outlineB[b1IdxU];

  // Each seam end may be a shared corner that A and B place up to
  // kMergeContactToleranceMm apart, so the two seam lengths can differ by at
  // most twice that; anything more means the refs don't describe one seam.
  const Point2 dA = Sub2(edgeA1, edgeA0);
  const Point2 dB = Sub2(edgeB1, edgeB0);
  const double lenA = Length2(dA);
  const double lenB = Length2(dB);
  if (std::fabs(lenA - lenB) > 2.0 * kMergeContactToleranceMm) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "seam lengths disagree between A and B (" + std::to_string(lenA) + "mm vs " +
                      std::to_string(lenB) + "mm)";
    return result;
  }

  // T(edgeB0) = edgeA1, T(edgeB1) = edgeA0 — two CCW polygons share a
  // boundary edge in opposite directions.
  const double rot = std::atan2(-dA.y, -dA.x) - std::atan2(dB.y, dB.x);
  Rigid2 xform;
  xform.cosT = std::cos(rot);
  xform.sinT = std::sin(rot);
  xform.pivot = edgeB0;
  xform.offset = edgeA1;

  // B as it lands in the combined outline: its two seam corners ARE A's.
  std::vector<Point2> placedB;
  placedB.reserve(m);
  for (const auto& v : outlineB) placedB.push_back(xform.Apply(v));
  placedB[jFinalU] = edgeA1;
  placedB[b1IdxU] = edgeA0;

  auto inSeamArc = [](size_t i, size_t start, size_t end, size_t count) {
    return ((i + count - start) % count) < ((end + count - start) % count);
  };

  // A's kept material runs from a1Idx forward to kFinal; B's from b1Idx
  // forward to jFinal. Copy each exactly once, keeping A's own vertex order
  // from index 0 when A's kept material wraps the array boundary.
  std::vector<Point2> combined;
  combined.reserve(n + m);
  auto appendB = [&] {
    for (size_t idx = (b1IdxU + 1) % m; idx != jFinalU; idx = (idx + 1) % m) combined.push_back(placedB[idx]);
  };
  if (a1IdxU > kFinalU) {
    for (size_t i = 0; i <= kFinalU; ++i) combined.push_back(outlineA[i]);
    appendB();
    for (size_t i = a1IdxU; i < n; ++i) combined.push_back(outlineA[i]);
  } else {
    for (size_t i = a1IdxU; i <= kFinalU; ++i) combined.push_back(outlineA[i]);
    appendB();
  }

  // Self-intersection guard on the geometry actually produced: A's kept
  // edges against B's kept edges as placed. Only the two splice vertices may
  // touch, and only at a single point.
  for (size_t i = 0; i < n; ++i) {
    if (inSeamArc(i, kFinalU, a1IdxU, n)) continue;
    const Point2& p1 = outlineA[i];
    const Point2& p2 = outlineA[(i + 1) % n];
    for (size_t b = 0; b < m; ++b) {
      if (inSeamArc(b, jFinalU, b1IdxU, m)) continue;
      if (SegmentsBadOverlap(p1, p2, placedB[b], placedB[(b + 1) % m], edgeA0, edgeA1)) {
        result.errorCode = MergeErrorCode::kMergeSelfIntersecting;
        result.message = "spliced outline would self-intersect — detected contact interval was wrong";
        return result;
      }
    }
  }

  result.ok = true;
  result.combinedOutline = std::move(combined);
  result.carriedB.reserve(carryB.size());
  for (const auto& p : carryB) result.carriedB.push_back(xform.Apply(p));
  // Reversed from edgeA0->edgeA1 so A's material lands on the bend's parent
  // (right) side and B's on the child (left) side.
  result.hingeA = edgeA1;
  result.hingeB = edgeA0;
  return result;
}

}  // namespace mcp_cad::translation
