#include "geometry/translation/part_merge.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace mcp_cad::translation {

namespace {

// Matches manufacturing_graph_evaluator.cc's own kPi — avoids relying on the
// non-standard M_PI macro.
constexpr double kPi = 3.14159265358979323846;

// Internal consistency epsilon: points passed between this module's own two
// functions (DetectContact's output, fed straight into ReconcileOutlines) are
// derived from the SAME detected interval, so any gap here is float
// round-trip noise, not a real-world tolerance.
constexpr double kExactMatchEpsilonMm = 1e-6;

// TASK_SPEC.md §8.4: the real-world contact-detection tolerance — how close
// two independently-anchored parts' boundaries must be to call them "the same
// seam." Reuses the same fixed constant/value this codebase already
// established for this exact question (numerical-policy.ts's
// MERGE_EDGE_ALIGNMENT_TOLERANCE_MM, matching v1 evidence and
// step_reconciliation.cc's kPieceEdgeMatchToleranceMm precedent) — kept here
// as its own named constant since this module has no dependency on the
// TypeScript-side numerical-policy module, per 13 §8 ("no shared mutable
// state" / no cross-language constant coupling for a pure C++ module).
constexpr double kMergeContactToleranceMm = 2.0;

// Below this angle magnitude, two touching planes are "the same plane" for
// this tool's purposes — TASK_SPEC.md F7: a genuinely coplanar contact is
// fuse_bodies' job (a flush absorb, no bend), not a degenerate zero-angle
// bend here.
constexpr double kCoplanarAngleEpsilonDeg = 1.0;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Length2(const Point2& v) { return std::hypot(v.x, v.y); }
double Dot2(const Point2& a, const Point2& b) { return a.x * b.x + a.y * b.y; }

bool NearlyEqual2(const Point2& a, const Point2& b, double eps) {
  return Length2(Sub2(a, b)) <= eps;
}

Point2 Lerp2(const Point2& a, const Point2& b, double f) {
  return {a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f};
}

// ─── Point3/Transform3 helpers (DetectContact only) ─────────────────────────

Point3 Sub3(const Point3& a, const Point3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double Dot3(const Point3& a, const Point3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Point3 Cross3(const Point3& a, const Point3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
double Length3(const Point3& v) { return std::sqrt(Dot3(v, v)); }

// ─── DetectContact ───────────────────────────────────────────────────────────

// Locates p's position on `outline`'s own boundary, mutating it to insert a
// new vertex if p falls strictly inside an existing edge rather than on an
// existing vertex — TASK_SPEC.md F3's "insert a vertex where the interval's
// endpoint falls mid-edge." Returns the index at which outline[index] == p
// holds after the call, or -1 if p is not within perpTolMm of the boundary at
// all (an internal-consistency failure — see kInternalInconsistency).
//
// Three DIFFERENT tolerance roles, deliberately kept separate:
//  - vertexTolMm gates "is this already the SAME vertex" — must stay tight
//    (kExactMatchEpsilonMm) even for real/noisy geometry, since the caller
//    passes an EXACT copy of the original outline vertex whenever the
//    boundary genuinely IS that vertex; a loose tolerance here would wrongly
//    snap a real, distinct nearby feature onto it instead.
//  - The along-edge RANGE check (is t within this edge's own [0,len]) MUST
//    also stay tight (kExactMatchEpsilonMm, not perpTolMm): a point genuinely
//    belongs to whichever edge's true [0,len] extent contains it, and two
//    edges always share an endpoint — extending the range loosely lets a
//    point that's actually 1-2mm PAST edge i's own end get wrongly claimed
//    by edge i instead of the adjacent edge i+1 it truly falls on, purely
//    because edge i happened to be checked first (confirmed live: a
//    synthetic asymmetric-seam point 1mm inside the correct edge was claimed
//    by the WRONG neighboring edge under a 2mm range tolerance, producing a
//    non-consecutive edgeA0/edgeA1 pair downstream).
//  - perpTolMm (kMergeContactToleranceMm) is the only place real-world slack
//    belongs: how far the point may sit OFF the edge's true line, since the
//    point itself was only ever computed to that precision by DetectContact.
int LocateOrInsertVertex(std::vector<Point2>& outline, const Point2& p, double vertexTolMm,
                          double perpTolMm) {
  const size_t n = outline.size();
  for (size_t i = 0; i < n; ++i) {
    if (NearlyEqual2(outline[i], p, vertexTolMm)) return static_cast<int>(i);
  }
  // Two adjacent edges share an endpoint, so a point near a corner can pass
  // BOTH edges' t-range/perpendicular checks at once (e.g. sitting exactly
  // on edge i+1's own line, but also within perpTolMm of edge i's line
  // extended to its own shared endpoint) — evaluate every edge and take the
  // one with the smallest perpendicular distance, not the first one found in
  // index order, or a point can be wrongly claimed by its neighbor
  // (confirmed live: this exact corner-adjacency case on a synthetic
  // asymmetric-seam fixture).
  int bestEdge = -1;
  double bestPerpDist = perpTolMm;
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = outline[i];
    const Point2& b = outline[(i + 1) % n];
    const Point2 dir = Sub2(b, a);
    const double len = Length2(dir);
    if (len < 1e-9) continue;
    const Point2 dHat{dir.x / len, dir.y / len};
    const double t = Dot2(Sub2(p, a), dHat);
    if (t < -kExactMatchEpsilonMm || t > len + kExactMatchEpsilonMm) continue;
    const Point2 proj{a.x + dHat.x * t, a.y + dHat.y * t};
    const double perpDist = Length2(Sub2(proj, p));
    if (perpDist <= bestPerpDist) {
      bestPerpDist = perpDist;
      bestEdge = static_cast<int>(i);
    }
  }
  if (bestEdge >= 0) {
    const size_t insertAt = (static_cast<size_t>(bestEdge) + 1) % n;
    if (insertAt == 0) {
      outline.push_back(p);
      return static_cast<int>(n);
    }
    outline.insert(outline.begin() + static_cast<long>(insertAt), p);
    return static_cast<int>(insertAt);
  }
  return -1;
}

// One physically-disjoint region where a run of B's boundary (already
// verified to lie, both endpoints, within tolerance of A's z=0 plane) overlaps
// a run of A's own boundary — TASK_SPEC.md §9 step 1's "walk both outlines'
// boundaries to find the contact interval."
struct FoundRegion {
  Point2 aStart2D;  // A's local 2D frame — earlier along A's own CCW walk
  Point2 aEnd2D;
  Point2 bStartLocal;  // B's OWN local 2D frame, same physical points as aStart2D/aEnd2D
  Point2 bEndLocal;
  double lengthMm = 0.0;
};

}  // namespace

DetectContactResult DetectContact(const std::vector<Point2>& outlineA, const Transform3& anchorA,
                                   const std::vector<Point2>& outlineB, const Transform3& anchorB) {
  DetectContactResult result;
  const size_t n = outlineA.size();
  const size_t m = outlineB.size();
  if (n < 3 || m < 3) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "both outlines must have at least 3 vertices";
    return result;
  }

  // Project every B vertex into A's own local 3D frame (13 §3.1's R, composed
  // exactly as FuseCoplanarParts already does for the coplanar case).
  const Transform3 bToA = anchorA.Inverse().Compose(anchorB);
  std::vector<Point3> bInA(m);
  for (size_t i = 0; i < m; ++i) {
    bInA[i] = bToA.Apply({outlineB[i].x, outlineB[i].y, 0.0});
  }

  // F7: genuinely coplanar (every point of B lies in A's own plane) is
  // fuse_bodies' job, not this tool's.
  bool allCoplanar = true;
  for (const auto& p : bInA) {
    if (std::fabs(p.z) > kMergeContactToleranceMm) {
      allCoplanar = false;
      break;
    }
  }
  if (allCoplanar) {
    result.errorCode = MergeErrorCode::kCoplanarSeam;
    result.message =
        "part B lies entirely in part A's own plane — this is a flush absorb (fuse_bodies), not a fold";
    return result;
  }

  // Group B's boundary into maximal runs of consecutive vertices lying (both
  // endpoints of each edge) within tolerance of A's z=0 plane — each run is a
  // candidate seam: a real physical panel touches another along a run of its
  // OWN boundary vertices sitting exactly on the fold line, by construction
  // (authored or STEP-imported), not merely crossing it at an isolated point
  // (a crossing with no real run alongside it is a genuine non-touch, not a
  // seam — same "positive-length overlap vs single-point touch" distinction
  // this module's own SegmentsBadOverlap already relies on elsewhere).
  std::vector<bool> zZero(m);
  for (size_t i = 0; i < m; ++i) zZero[i] = std::fabs(bInA[i].z) <= kMergeContactToleranceMm;
  std::vector<bool> edgeIsFlat(m);
  for (size_t i = 0; i < m; ++i) edgeIsFlat[i] = zZero[i] && zZero[(i + 1) % m];

  std::vector<std::pair<size_t, size_t>> runs;  // (startVertex, endVertex), walking B forward
  {
    size_t breakAt = m;
    for (size_t i = 0; i < m; ++i) {
      if (!edgeIsFlat[i]) {
        breakAt = i;
        break;
      }
    }
    if (breakAt == m) {
      // Every edge is flat — B's boundary never leaves A's plane, yet not
      // ALL of B's vertices were flat (else allCoplanar above would have
      // caught it) — a self-contradiction given edgeIsFlat[i] requires BOTH
      // endpoints flat for every i. Defensive only; cannot occur.
      runs.push_back({0, m - 1});
    } else {
      size_t i = (breakAt + 1) % m;
      while (i != breakAt) {
        if (edgeIsFlat[i]) {
          size_t runStart = i;
          size_t runEnd = (i + 1) % m;
          while (edgeIsFlat[runEnd]) {
            runEnd = (runEnd + 1) % m;
            i = (i + 1) % m;
          }
          runs.push_back({runStart, runEnd});
          i = (i + 1) % m;
        } else {
          i = (i + 1) % m;
        }
      }
    }
  }

  std::vector<FoundRegion> found;
  for (const auto& run : runs) {
    const Point2 runStart2D{bInA[run.first].x, bInA[run.first].y};
    const Point2 runEnd2D{bInA[run.second].x, bInA[run.second].y};
    const Point2 runDirRaw = Sub2(runEnd2D, runStart2D);
    const double runLen = Length2(runDirRaw);
    if (runLen < 1e-9) continue;  // degenerate (zero-length) run — not a real seam
    const Point2 runDir{runDirRaw.x / runLen, runDirRaw.y / runLen};

    // Accumulate A's own boundary coverage along this run's infinite line, as
    // a 1D interval in the run's own [0, runLen] parametrization (a direction
    // arbitrarily tied to B's own forward walk — NOT assumed to agree with
    // A's own forward walk direction on this same physical line; the two
    // CCW polygons meeting here traverse their shared boundary in OPPOSITE
    // senses precisely when the seam is real, so they generally disagree —
    // aForwardIsIncreasingT (below) resolves which is which).
    double aLo = std::numeric_limits<double>::infinity();
    double aHi = -std::numeric_limits<double>::infinity();
    // The EXACT A-outline vertex that set aLo/aHi (bit-identical to
    // outlineA's own stored data — never recomputed) — used below instead of
    // reconstructing the point via a second, independent interpolation path,
    // which would only agree with A's own stored value up to floating noise
    // and (for real STEP-derived coordinates) real import-noise at the
    // millimeter scale, not float epsilon (confirmed live against
    // unequal_leg_bracket_90deg.stp: reconstructing via lerp caused
    // ReconcileOutlines' own vertex-resolution to spuriously miss the exact
    // A vertex it should have reused).
    Point2 aLoPoint{};
    Point2 aHiPoint{};
    // A's OWN line (origin + direction, from whichever real A edge first
    // qualified) — real STEP-reconciled geometry means A's true edge and B's
    // true edge, even at the same physical seam, can genuinely disagree by
    // up to kMergeContactToleranceMm (the same "sharp-corner footprint"
    // precedent numerical-policy.ts's own MERGE_EDGE_ALIGNMENT_TOLERANCE_MM
    // documents, and FuseCoplanarParts' own gap-closing already acts on) —
    // when B's own run boundary is what limits the overlap (loClampedByB/
    // hiClampedByRun below), the output point must be B's boundary point
    // PROJECTED onto A's true line, never B's raw (possibly ~mm-off)
    // coordinate used as if it were already exactly on A's boundary
    // (confirmed live: unequal_leg_bracket_90deg.stp's real ~1mm A/B
    // disagreement produced an aRunStart that matched neither part's actual
    // stored edge before this fix).
    Point2 aLineOrigin{};
    Point2 aLineDirHat{};
    bool anyACoverage = false;
    bool aForwardIsIncreasingT = true;
    // The edge that sets aLineOrigin/aLineDirHat is chosen by which
    // qualifying edge has the GREATEST positive-length overlap with this
    // run's own [0, runLen] window — never simply "whichever edge is
    // first in outlineA's own array order" (the earlier design). A
    // completely different physical feature (e.g. a fused protrusion's
    // own edge) can pass the perpendicular-distance check by coincidence
    // whenever it happens to run near-parallel to the seam's line,
    // without actually being part of the same contact run — confirmed
    // live (testcube.step, a fused Protrusion2): a wing edge overlapped
    // this run's window by only 0.05mm (real STEP-fixture noise, not a
    // rejection-worthy amount) while the TRUE seam edge overlapped it by
    // the full ~150mm run length. Under "first found," the wing edge
    // (checked first in array order) won by accident, and B's boundary
    // got projected onto its own slightly-tilted line instead of the
    // true seam's, landing the detected contact interval ~0.05mm off the
    // panel's real corner and producing a spurious
    // GE_MERGE_SELF_INTERSECTION. "Largest overlap wins" picks whichever
    // edge is actually, overwhelmingly responsible for this run's A-side
    // coverage, which a coincidental sliver from an unrelated edge can
    // never outweigh.
    double bestLineOverlapMm = 0.0;
    for (size_t i = 0; i < n; ++i) {
      const Point2& a1 = outlineA[i];
      const Point2& a2 = outlineA[(i + 1) % n];
      // Both endpoints must sit on the run's infinite line (perpendicular
      // distance within tolerance) for this A edge to count as collinear
      // coverage of the same seam.
      auto perpDist = [&](const Point2& p) {
        const Point2 v = Sub2(p, runStart2D);
        const double along = Dot2(v, runDir);
        const Point2 onLine{runStart2D.x + runDir.x * along, runStart2D.y + runDir.y * along};
        return Length2(Sub2(onLine, p));
      };
      if (perpDist(a1) > kMergeContactToleranceMm || perpDist(a2) > kMergeContactToleranceMm) continue;
      const double t1 = Dot2(Sub2(a1, runStart2D), runDir);
      const double t2 = Dot2(Sub2(a2, runStart2D), runDir);
      // This edge's own [t1,t2] extent must have a genuine positive-
      // length overlap with the run's own [0, runLen] window — an edge
      // that merely touches or misses that window entirely (its whole
      // extent on one side) isn't coverage of THIS run at all, the same
      // "positive-length overlap, not just a touch" distinction
      // SegmentsBadOverlap (below) already relies on elsewhere.
      const double edgeLo = std::min(t1, t2);
      const double edgeHi = std::max(t1, t2);
      const double coverageOverlap = std::min(edgeHi, runLen) - std::max(edgeLo, 0.0);
      if (coverageOverlap <= kExactMatchEpsilonMm) continue;
      if (t1 < aLo) { aLo = t1; aLoPoint = a1; }
      if (t2 < aLo) { aLo = t2; aLoPoint = a2; }
      if (t1 > aHi) { aHi = t1; aHiPoint = a1; }
      if (t2 > aHi) { aHi = t2; aHiPoint = a2; }
      anyACoverage = true;
      if (coverageOverlap > bestLineOverlapMm) {
        // A's own forward walk on THIS edge goes a1 -> a2; record whether
        // that is increasing or decreasing t, to orient the final output,
        // and this edge's own true line for the gap-closing projection above.
        bestLineOverlapMm = coverageOverlap;
        aForwardIsIncreasingT = t2 > t1;
        aLineOrigin = a1;
        const Point2 aDir = Sub2(a2, a1);
        const double aDirLen = Length2(aDir);
        aLineDirHat = aDirLen > 1e-9 ? Point2{aDir.x / aDirLen, aDir.y / aDirLen} : runDir;
      }
    }
    if (!anyACoverage) continue;

    auto projectOntoALine = [&](const Point2& p) {
      const double along = Dot2(Sub2(p, aLineOrigin), aLineDirHat);
      return Point2{aLineOrigin.x + aLineDirHat.x * along, aLineOrigin.y + aLineDirHat.y * along};
    };

    const bool loClampedByB = aLo <= 0.0;
    const bool hiClampedByRun = aHi >= runLen;
    const double overlapLo = std::max(0.0, aLo);
    const double overlapHi = std::min(runLen, aHi);
    if (overlapHi - overlapLo <= kExactMatchEpsilonMm) continue;  // no positive-length overlap

    // The lo/hi boundary's own EXACT point on each side — B's own stored
    // vertex, projected onto A's true line, when the run itself is the
    // limiting factor; A's own stored vertex when A's material is shorter.
    // B's own-frame point is always B's stored vertex when the run itself
    // limits that boundary, otherwise lerped along B's own edge — this side
    // never needs the gap-closing projection since it's already expressed in
    // B's own frame by construction.
    const Point2 loPointA = loClampedByB ? projectOntoALine(runStart2D) : aLoPoint;
    const Point2 loPointB = loClampedByB ? outlineB[run.first] : Lerp2(outlineB[run.first], outlineB[run.second], overlapLo / runLen);
    const Point2 hiPointA = hiClampedByRun ? projectOntoALine(runEnd2D) : aHiPoint;
    const Point2 hiPointB = hiClampedByRun ? outlineB[run.second] : Lerp2(outlineB[run.first], outlineB[run.second], overlapHi / runLen);

    // tAStart/tAEnd: the interval's endpoints IN A's OWN forward-walk order
    // (tAStart precedes tAEnd walking A forward) — swapped from lo/hi
    // whenever A's forward direction runs opposite the run's own
    // t-parametrization.
    const Point2& aStartPoint = aForwardIsIncreasingT ? loPointA : hiPointA;
    const Point2& aEndPoint = aForwardIsIncreasingT ? hiPointA : loPointA;
    const Point2& bAtAEnd = aForwardIsIncreasingT ? hiPointB : loPointB;
    const Point2& bAtAStart = aForwardIsIncreasingT ? loPointB : hiPointB;

    FoundRegion region;
    region.aStart2D = aStartPoint;
    region.aEnd2D = aEndPoint;
    // B's own local point at the SAME physical location as aEnd2D/aStart2D —
    // T(edgeB0)=edgeA1 means the point ReconcileOutlines will call "edgeB0"
    // must be B's local point at A's LATER (aEnd2D) position, and "edgeB1" at
    // A's EARLIER (aStart2D) position (part_merge.hpp's "opposite order" rule).
    region.bStartLocal = bAtAEnd;
    region.bEndLocal = bAtAStart;
    region.lengthMm = overlapHi - overlapLo;
    found.push_back(region);
  }

  if (found.empty()) {
    result.errorCode = MergeErrorCode::kNoContact;
    result.message =
        "no real boundary contact found between the two parts' own anchors, within " +
        std::to_string(kMergeContactToleranceMm) + "mm";
    return result;
  }

  // TASK_SPEC.md §8.3 phase 1: deterministically pick the longest region.
  // Phase 2 (a caller-facing contact_point_hint + rich per-candidate
  // geometry in the error) is deferred — contactRegionCount is surfaced now
  // so a caller/test can already see when this placeholder rule fired.
  size_t bestIdx = 0;
  for (size_t i = 1; i < found.size(); ++i) {
    if (found[i].lengthMm > found[bestIdx].lengthMm) bestIdx = i;
  }
  const FoundRegion& chosen = found[bestIdx];

  // aStart2D/aEnd2D are already in A's own forward-walk order (the
  // aForwardIsIncreasingT resolution above). bStartLocal/bEndLocal are
  // already the physically-corresponding B points in the "opposite order"
  // ReconcileOutlines' T(edgeB0)=edgeA1 convention requires (part_merge.hpp)
  // — bStartLocal sits at aEnd2D's location, bEndLocal at aStart2D's.
  result.ok = true;
  result.aRunStart = chosen.aStart2D;
  result.aRunEnd = chosen.aEnd2D;
  result.bRunStart = chosen.bStartLocal;
  result.bRunEnd = chosen.bEndLocal;
  result.contactRegionCount = static_cast<int>(found.size());

  // Signed dihedral angle: the rotation, about axis (hingeB_world -
  // hingeA_world) — the SAME axis convention manufacturing_graph_evaluator.cc's
  // own pose walk uses (RotationAboutAxis(hingeAWorld, axis, angleDeg)) — that
  // carries A's own plane normal onto B's own plane normal. Using each
  // panel's normal (rather than some other in-plane reference vector) as the
  // rotated quantity is valid because a fold, by definition, rotates the
  // child panel's plane (hence its normal) by exactly angleDeg about the
  // hinge axis; using the normal also sidesteps needing to know which
  // in-plane "left" direction to reference. Both normals are guaranteed
  // perpendicular to the hinge axis (the axis lies IN both panels' own
  // planes, by construction, since it is exactly their shared boundary run).
  //
  // hingeA/hingeB here MUST match the REAL BendRow's own hingeA/hingeB —
  // ReconcileOutlines sets bend.hingeA = edgeA1 (= aRunEnd) and
  // bend.hingeB = edgeA0 (= aRunStart), reversed from aRunStart/aRunEnd's own
  // order (part_merge.hpp's "opposite order" rule) — using aRunStart/aRunEnd
  // directly here would compute the angle about the OPPOSITE axis direction,
  // silently flipping mountain/valley on every fold (confirmed live: this
  // exact bug against unequal_leg_bracket_90deg.stp, a ~30-100mm systematic
  // bbox error matching the wrong-fold-direction signature exactly).
  const Point3 hingeAWorld = anchorA.Apply({result.aRunEnd.x, result.aRunEnd.y, 0.0});
  const Point3 hingeBWorld = anchorA.Apply({result.aRunStart.x, result.aRunStart.y, 0.0});
  Point3 axis = Sub3(hingeBWorld, hingeAWorld);
  const double axisLen = Length3(axis);
  if (axisLen < 1e-9) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "detected contact interval has zero length";
    return result;
  }
  axis = {axis.x / axisLen, axis.y / axisLen, axis.z / axisLen};

  const Point3 nA = anchorA.ApplyVector({0.0, 0.0, 1.0});
  const Point3 nB = anchorB.ApplyVector({0.0, 0.0, 1.0});
  const double angleRad = std::atan2(Dot3(Cross3(nA, nB), axis), Dot3(nA, nB));
  result.angleDeg = angleRad * 180.0 / kPi;

  if (std::fabs(result.angleDeg) < kCoplanarAngleEpsilonDeg) {
    result.ok = false;
    result.errorCode = MergeErrorCode::kCoplanarSeam;
    result.message = "the only real contact between these parts is genuinely coplanar (angle ~= 0) — "
                      "this is a flush absorb (fuse_bodies), not a fold";
    return result;
  }

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

ReconcileOutlinesResult ReconcileOutlines(const std::vector<Point2>& outlineAIn, const Point2& edgeA0,
                                           const Point2& edgeA1, const std::vector<Point2>& outlineBIn,
                                           const Point2& edgeB0, const Point2& edgeB1) {
  ReconcileOutlinesResult result;

  std::vector<Point2> outlineA = outlineAIn;
  std::vector<Point2> outlineB = outlineBIn;

  // Insert (or find) all four points first — an insertion can shift the
  // index of a point already located earlier in this same outline, so every
  // index is re-resolved (a cheap find-only scan, since all four points
  // already exist by then) after all insertions are done, rather than
  // trusted from its own first call.
  //
  // vertexTolMm stays kExactMatchEpsilonMm (tight): DetectContact passes an
  // EXACT copy of the original outline vertex whenever the boundary genuinely
  // IS that vertex — a loose match here would wrongly snap a real, distinct
  // nearby feature onto it instead (confirmed live on a synthetic asymmetric-
  // seam fixture: an unrelated corner 1mm away was wrongly reused). edgeTolMm
  // uses kMergeContactToleranceMm: the mid-edge insertion path's point IS
  // only known to that precision (real STEP-derived coordinates carry real
  // import-noise at this scale, numerical-policy.ts's own
  // MERGE_EDGE_ALIGNMENT_TOLERANCE_MM precedent) — confirmed live against
  // unequal_leg_bracket_90deg.stp needing this slack.
  if (LocateOrInsertVertex(outlineA, edgeA0, kExactMatchEpsilonMm, kMergeContactToleranceMm) < 0 ||
      LocateOrInsertVertex(outlineA, edgeA1, kExactMatchEpsilonMm, kMergeContactToleranceMm) < 0 ||
      LocateOrInsertVertex(outlineB, edgeB0, kExactMatchEpsilonMm, kMergeContactToleranceMm) < 0 ||
      LocateOrInsertVertex(outlineB, edgeB1, kExactMatchEpsilonMm, kMergeContactToleranceMm) < 0) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "detected contact points do not lie on their own outline's boundary";
    return result;
  }
  const size_t n = outlineA.size();
  const size_t m = outlineB.size();
  const int kFinal = LocateOrInsertVertex(outlineA, edgeA0, kExactMatchEpsilonMm, kMergeContactToleranceMm);
  const int a1Idx = LocateOrInsertVertex(outlineA, edgeA1, kExactMatchEpsilonMm, kMergeContactToleranceMm);
  const int jFinal = LocateOrInsertVertex(outlineB, edgeB0, kExactMatchEpsilonMm, kMergeContactToleranceMm);
  const int b1Idx = LocateOrInsertVertex(outlineB, edgeB1, kExactMatchEpsilonMm, kMergeContactToleranceMm);

  // edgeA0/edgeA1 (and edgeB0/edgeB1) need not be literally adjacent: a real
  // outline can carry extra vertices strictly between them — a collinear
  // subdivision point (e.g. a relief-cut midpoint) or a genuine small corner
  // (e.g. a staggered-seam step left over from an earlier fuse_bodies union)
  // — and both are equally real material sitting exactly on the interval
  // DetectContact identified as the shared seam. Whatever lies strictly
  // between the two resolved indices is, by construction, part of that
  // vanishing seam (about to be replaced by the fold), not a reason to
  // reject the merge. See the combining-loop split below (kFinal/a1Idx
  // ordering) and inSeamArc, which every downstream use of
  // kFinal/a1Idx/jFinal/b1Idx must respect instead of assuming a fixed +1
  // offset — an earlier attempt at this generalization used a single
  // `for (i = a1Idx; i < n; ++i)` loop that assumed a1Idx always comes AFTER
  // kFinal in array order; when the seam instead wraps across the outline's
  // own physical start/end boundary (kFinal resolves near n-1, a1Idx
  // resolves near 0 — exactly what LocateOrInsertVertex's own
  // insertAt==0 -> push_back branch produces), that assumption is false and
  // the loop re-walks part of A's outline a second time, corrupting the
  // result with duplicate vertices (confirmed live: reproduced a 17-vertex
  // outline that was literally A's 5 vertices emitted twice, which the
  // downstream region-panel evaluator turned into a visible extra panel).
  // The two-branch split below handles both orderings explicitly instead of
  // assuming one.
  const Point2 dA = Sub2(edgeA1, edgeA0);
  const Point2 dB = Sub2(edgeB1, edgeB0);
  const double lenA = Length2(dA);
  const double lenB = Length2(dB);
  if (std::fabs(lenA - lenB) > kMergeContactToleranceMm) {
    // The two lengths are derived from the SAME physical interval (via
    // DetectContact) through two independent rigid maps — any real gap here
    // is a bug in this module, not a caller-triggerable mismatch (unlike the
    // old caller-supplied-edges design, TASK_SPEC.md F3 explicitly supports
    // unequal edge lengths at the OUTLINE level; this checks the two
    // sub-interval lengths, which must always agree).
    result.errorCode = MergeErrorCode::kInternalInconsistency;
    result.message = "resolved seam lengths disagree between A and B (" + std::to_string(lenA) + "mm vs " +
                      std::to_string(lenB) + "mm)";
    return result;
  }
  if (lenA < 1e-9) {
    result.errorCode = MergeErrorCode::kInternalInconsistency;
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
  transformedB.reserve(m);
  for (const auto& v : outlineB) transformedB.push_back(xform.Apply(v));

  const size_t kFinalU = static_cast<size_t>(kFinal);
  const size_t a1IdxU = static_cast<size_t>(a1Idx);
  const size_t jFinalU = static_cast<size_t>(jFinal);
  const size_t b1IdxU = static_cast<size_t>(b1Idx);

  // True if walking forward (cyclically, mod `count`) from `start`, index i
  // is reached strictly before `end` — i.e. i is one of the (possibly zero)
  // vertices consumed by the vanishing seam between a resolved contact pair.
  auto inSeamArc = [](size_t i, size_t start, size_t end, size_t count) {
    return ((i + count - start) % count) < ((end + count - start) % count);
  };

  std::vector<Point2> combined;
  combined.reserve(n + m - 2);
  // Which side of the (kFinal, a1Idx) pair wraps depends on array order, not
  // just adjacency: whenever a1Idx > kFinal, the vanishing seam is the
  // simple range (kFinal, a1Idx) and A's KEPT material wraps around the
  // array's own start/end boundary — copy it in the same two pieces the
  // original (adjacency-only) code always used. Whenever a1Idx <= kFinal
  // instead (the seam itself wraps across that boundary — e.g.
  // LocateOrInsertVertex's insertAt==0 -> push_back path landed edgeA0 at
  // the very end while edgeA1 resolved near the start), A's KEPT material is
  // the single simple range [a1Idx, kFinal] and does NOT wrap — copying it
  // as two separate pieces here would re-walk part of A's outline a second
  // time (confirmed live: this exact bug produced a duplicate-vertex,
  // corrupted outline that a downstream evaluator turned into a visible
  // extra panel).
  if (a1IdxU > kFinalU) {
    for (size_t i = 0; i <= kFinalU; ++i) combined.push_back(outlineA[i]);
    for (size_t idx = (b1IdxU + 1) % m; idx != jFinalU; idx = (idx + 1) % m) {
      combined.push_back(transformedB[idx]);
    }
    for (size_t i = a1IdxU; i < n; ++i) combined.push_back(outlineA[i]);
  } else {
    for (size_t i = a1IdxU; i <= kFinalU; ++i) combined.push_back(outlineA[i]);
    for (size_t idx = (b1IdxU + 1) % m; idx != jFinalU; idx = (idx + 1) % m) {
      combined.push_back(transformedB[idx]);
    }
  }

  // Self-intersection guard: A's edges (excluding every edge inside the
  // vanishing [kFinal, a1Idx) arc) against B's transformed edges (excluding
  // every edge inside the vanishing [jFinal, b1Idx) arc) — none of those
  // edges survive into `combined` (see above), so checking them against the
  // other side is meaningless. The only geometry allowed to touch is exactly
  // the two splice vertices (edgeA0/edgeA1), and only as a single point —
  // anything else (a proper crossing, or a collinear run of positive length
  // even if it also touches a splice vertex) means the detected contact
  // interval was wrong.
  for (size_t i = 0; i < n; ++i) {
    if (inSeamArc(i, kFinalU, a1IdxU, n)) continue;
    const Point2& a1 = outlineA[i];
    const Point2& a2 = outlineA[(i + 1) % n];
    for (size_t b = 0; b < m; ++b) {
      if (inSeamArc(b, jFinalU, b1IdxU, m)) continue;
      const Point2& b1 = transformedB[b];
      const Point2& b2 = transformedB[(b + 1) % m];
      if (SegmentsBadOverlap(a1, a2, b1, b2, edgeA0, edgeA1)) {
        result.errorCode = MergeErrorCode::kMergeSelfIntersecting;
        result.message = "spliced outline would self-intersect — detected contact interval was wrong";
        return result;
      }
    }
  }

  result.ok = true;
  result.combinedOutline = std::move(combined);
  // Reversed from the literal edgeA0->edgeA1 order — see part_merge.hpp's
  // ReconcileOutlinesResult doc comment for why: A's own material (always
  // LEFT of its own directed edge, CCW) must land on the RIGHT (parent) side
  // of the bend the caller creates from this hinge.
  result.hingeA = edgeA1;
  result.hingeB = edgeA0;
  return result;
}

}  // namespace mcp_cad::translation
