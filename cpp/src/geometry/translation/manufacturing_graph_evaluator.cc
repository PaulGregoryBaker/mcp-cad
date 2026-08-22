#include "manufacturing_graph_evaluator.hpp"
#include "ring_containment.hpp"

#include <algorithm>
#include <cmath>
#include <optional>
#include <unordered_map>
#include <unordered_set>

namespace mcp_cad::translation {

namespace {

// Locally-scoped geometric-robustness constants (not manufacturing tolerances —
// constitution v2.0.0 principle V's distinction: these never vary by project, they
// only guard against floating-point noise). A shared C++ numerical-policy module
// (mirroring ts/src/geometry/numerical-policy.ts) is future work once more than one
// C++ module needs these; for now they're named and documented here rather than
// scattered as bare literals, which is the substance of principle V even without a
// dedicated module yet.
constexpr double kGeometricEpsilon = 1e-9;
constexpr double kPi = 3.14159265358979323846;

double DegToRad(double deg) { return deg * kPi / 180.0; }

// ─── Unified bend-allowance / bottom-radius model (see header comment) ──────
// ONE formula each; radiusMm=0 is a normal input, never a separate code path.

// Whether this bend's bottom (z=0) reference is the concave side — i.e.
// whether the pivot touches it at radiusMm=0. bend.bottomIsConcave, when
// set, is authoritative (see its own doc comment in the header: it and
// angleDeg's sign are independent facts). Falls back to the old
// isMountain=(angleDeg>=0) rule when unset, for graphs authored before
// this field existed.
bool BottomIsConcave(const BendSpec& bend) {
  return bend.bottomIsConcave.has_value() ? *bend.bottomIsConcave : (bend.angleDeg >= 0.0);
}

// Radius of the BOTTOM surface (13 D3: what regionOf/DXF maps to). Concave
// bottom: r_b = radiusMm (touches the pivot exactly at radiusMm=0). Convex
// bottom: r_b = radiusMm + thicknessMm — never zero, since the material's
// own thickness can't occupy zero arc on the convex side.
double BottomRadiusMm(const BendSpec& bend, double thicknessMm) {
  return BottomIsConcave(bend) ? bend.radiusMm : bend.radiusMm + thicknessMm;
}

// ─── 2D vector helpers ───────────────────────────────────────────────────────

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Cross2(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
double Length2(const Point2& v) { return std::sqrt(v.x * v.x + v.y * v.y); }

// ─── 3D vector helpers ───────────────────────────────────────────────────────

Point3 Sub3(const Point3& a, const Point3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double Length3(const Point3& v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
Point3 Normalize3(const Point3& v) {
  double len = Length3(v);
  if (len < kGeometricEpsilon) return {0, 0, 0};
  return {v.x / len, v.y / len, v.z / len};
}

}  // namespace

// ─── Bend geometry (BA + setback, see BendGeometryMm's own doc comment) ─────

BendGeometryMm ComputeBendGeometry(double angleDeg, double radiusMm, double kFactor,
                                    double thicknessMm) {
  double angleRad = std::fabs(DegToRad(angleDeg));
  double reff = radiusMm + kFactor * thicknessMm;
  BendGeometryMm out;
  out.allowanceMm = angleRad * reff;
  out.setbackMm = reff * std::tan(angleRad / 2.0);
  return out;
}

BendGeometryMm ComputeBendGeometry(const BendSpec& bend, double thicknessMm) {
  return ComputeBendGeometry(bend.angleDeg, bend.radiusMm, bend.kFactor, thicknessMm);
}

// ─── Transform3 ──────────────────────────────────────────────────────────────

Transform3 Transform3::Identity() { return Transform3{}; }

Transform3 Transform3::Translation(double dx, double dy, double dz) {
  Transform3 out;
  out.t[0] = dx;
  out.t[1] = dy;
  out.t[2] = dz;
  return out;
}

Transform3 Transform3::RotationAboutAxis(const Point3& axisOrigin, const Point3& axisDirUnit,
                                          double angleDeg) {
  const double theta = DegToRad(angleDeg);
  const double c = std::cos(theta);
  const double s = std::sin(theta);
  const double dx = axisDirUnit.x, dy = axisDirUnit.y, dz = axisDirUnit.z;

  // Rodrigues' rotation formula: R = I + sin(theta)*K + (1-cos(theta))*K^2,
  // K = [[0,-dz,dy],[dz,0,-dx],[-dy,dx,0]] (right-hand rule about (dx,dy,dz)).
  double r[9];
  r[0] = c + dx * dx * (1 - c);
  r[1] = dx * dy * (1 - c) - dz * s;
  r[2] = dx * dz * (1 - c) + dy * s;
  r[3] = dy * dx * (1 - c) + dz * s;
  r[4] = c + dy * dy * (1 - c);
  r[5] = dy * dz * (1 - c) - dx * s;
  r[6] = dz * dx * (1 - c) - dy * s;
  r[7] = dz * dy * (1 - c) + dx * s;
  r[8] = c + dz * dz * (1 - c);

  Transform3 rot;
  for (int i = 0; i < 9; ++i) rot.r[i] = r[i];
  // rot currently rotates about the origin. Conjugate by translation to rotate about
  // the line through `axisOrigin`: p -> R*(p - O) + O = R*p + (O - R*O).
  Point3 rO = rot.ApplyVector(axisOrigin);
  rot.t[0] = axisOrigin.x - rO.x;
  rot.t[1] = axisOrigin.y - rO.y;
  rot.t[2] = axisOrigin.z - rO.z;
  return rot;
}

Point3 Transform3::Apply(const Point3& p) const {
  return {
      r[0] * p.x + r[1] * p.y + r[2] * p.z + t[0],
      r[3] * p.x + r[4] * p.y + r[5] * p.z + t[1],
      r[6] * p.x + r[7] * p.y + r[8] * p.z + t[2],
  };
}

Point3 Transform3::ApplyVector(const Point3& v) const {
  return {
      r[0] * v.x + r[1] * v.y + r[2] * v.z,
      r[3] * v.x + r[4] * v.y + r[5] * v.z,
      r[6] * v.x + r[7] * v.y + r[8] * v.z,
  };
}

Transform3 Transform3::Compose(const Transform3& inner) const {
  // (this ∘ inner).Apply(p) == this.Apply(inner.Apply(p))
  Transform3 out;
  // Rotation: R_out = R_this * R_inner (3x3 matrix product, row-major).
  for (int row = 0; row < 3; ++row) {
    for (int col = 0; col < 3; ++col) {
      double sum = 0.0;
      for (int k = 0; k < 3; ++k) {
        sum += r[row * 3 + k] * inner.r[k * 3 + col];
      }
      out.r[row * 3 + col] = sum;
    }
  }
  // Translation: t_out = R_this * t_inner + t_this.
  Point3 rotatedInnerT = ApplyVector({inner.t[0], inner.t[1], inner.t[2]});
  out.t[0] = rotatedInnerT.x + t[0];
  out.t[1] = rotatedInnerT.y + t[1];
  out.t[2] = rotatedInnerT.z + t[2];
  return out;
}

Transform3 Transform3::Inverse() const {
  // Rigid transform inverse: R^-1 = R^T, t^-1 = -R^T * t.
  Transform3 out;
  for (int row = 0; row < 3; ++row) {
    for (int col = 0; col < 3; ++col) {
      out.r[row * 3 + col] = r[col * 3 + row];
    }
  }
  Point3 negT = {-t[0], -t[1], -t[2]};
  Point3 rotatedNegT = out.ApplyVector(negT);
  out.t[0] = rotatedNegT.x;
  out.t[1] = rotatedNegT.y;
  out.t[2] = rotatedNegT.z;
  return out;
}

// ─── Polygon half-plane clip (Sutherland-Hodgman) ───────────────────────────

namespace {

// True if `p` is on the "keep" side of the directed line lineA->lineB.
// keepLeft=true keeps the left/CCW side (Cross(lineB-lineA, p-lineA) >= 0).
//
// STRICT at the boundary (excludes an epsilon band around the line itself from
// BOTH sides), not the inclusive `>= -eps` a textbook Sutherland-Hodgman clip
// normally uses. This matters for non-convex subject polygons whose "outside"
// excursion merely GRAZES the clip line (touches it at an isolated point or
// along a short run, without ever crossing below it) — e.g. a fold-tree net's
// root face, bounded on one side by a single bend, with sibling branches whose
// own base edges happen to sit exactly on that same clip line. An inclusive
// test treats those grazing touch-points as "inside," so the single-pass
// clip connects them directly into the kept polygon, producing a degenerate
// bridge edge that isn't part of the region's real boundary (confirmed via
// the cross-cube-net case: F0's own clip bridged out to its siblings L/R's
// far corners, entirely along y=50, before this fix). The strict test instead
// drops grazing points to "outside," and the ENTER/EXIT transitions still
// correctly reconstruct the region's own real boundary via LineIntersect
// (proven exact for F0 by hand and empirically before this change landed).
constexpr double kEndpointMatchToleranceMm = 1e-6;
bool NearlyEqual2Local(const Point2& a, const Point2& b) {
  return Length2(Sub2(a, b)) < kEndpointMatchToleranceMm;
}

// ─── Region extraction via bend-strip subtraction (2D, no OCCT) ────────────
//
// A bend's zone is not just an infinite dividing line — it's a bounded strip
// (the bend's own hinge segment, widened by its own real setbackMm on each
// side) that gets removed from the whole combined outline. Removing every
// bend's own strip disconnects the outline into exactly as many pieces as
// there are region panels; a panel's own region is simply "the piece
// containing its own known corner point." This replaces the old sequential
// half-plane intersection — that approach could only ever distinguish
// "which side of one infinite line," which cannot tell a panel's own
// material apart from an unrelated sibling's that happens to sit on the
// same side of the same line (confirmed on real cauldron.step data: a
// wall's own clipped region silently absorbed a fragment of a structurally
// unrelated neighboring wall, reachable only because BOTH satisfied the
// SAME single half-plane test with nothing to separate them). A bounded
// strip removal can't make that mistake, because it only ever affects
// material within its own local footprint.
//
// hingeA/hingeB are already exact vertices of `graph.outline.outer` for
// every STEP-reconciled graph (the combined outline is built vertex-by-
// vertex from real piece boundaries, so a bend's hinge is always literally
// a shared vertex.
//
// A hand-authored graph is a different story: a bend's hinge is often
// authored as an INFINITE LINE's direction+position only, with hingeA/hingeB
// themselves deliberately extended well past the panel's own real width
// (MakeStrip's own doc comment: "cosmetic," since the old infinite-
// half-plane clip never used the segment's bounded extent). For such a
// bend, hingeA/hingeB are not real ring vertices at all, so
// EnsureHingeVertices instead finds where the infinite line through them
// actually crosses the CURRENT ring's own boundary, and uses those two real
// crossings as this bend's EFFECTIVE hinge points from here on — this
// fallback only ever triggers when NEITHER given endpoint is already a
// genuine ring vertex, never as a general "is this point on the line" scan
// over an already-well-formed ring, so it can't reintroduce the original
// false-positive-tagging bug this whole rewrite replaces.
//
// The margin used is this bend's own real setbackMm (BridgeLayout's own,
// envelope-preserving signed value — see BuildBendCuts' own comment), not an
// arbitrary robustness constant: this function's job is to produce each
// panel's region already trimmed to its true tangent line, not a
// zero-offset placeholder trimmed again later.

struct EffectiveHinge {
  Point2 hingeA, hingeB;
};

std::pair<std::vector<Point2>, std::vector<EffectiveHinge>> EnsureHingeVertices(
    std::vector<Point2> ring, const PartGraphSpec& graph) {
  std::vector<EffectiveHinge> effective;
  effective.reserve(graph.bends.size());
  for (const auto& bend : graph.bends) {
    bool foundA = false, foundB = false;
    for (const auto& v : ring) {
      if (NearlyEqual2Local(v, bend.hingeA)) foundA = true;
      if (NearlyEqual2Local(v, bend.hingeB)) foundB = true;
    }
    if (foundA || foundB) {
      effective.push_back({bend.hingeA, bend.hingeB});
      continue;
    }

    size_t n = ring.size();
    std::vector<std::pair<size_t, Point2>> crossings;  // (edge index, crossing point)
    for (size_t i = 0; i < n; ++i) {
      const Point2& a = ring[i];
      const Point2& b = ring[(i + 1) % n];
      double crossA = Cross2(Sub2(bend.hingeB, bend.hingeA), Sub2(a, bend.hingeA));
      double crossB = Cross2(Sub2(bend.hingeB, bend.hingeA), Sub2(b, bend.hingeA));
      if (std::fabs(crossA) < kGeometricEpsilon || std::fabs(crossB) < kGeometricEpsilon) {
        continue;  // touches at (or right next to) an existing vertex — not a clean crossing
      }
      if ((crossA > 0.0) == (crossB > 0.0)) continue;  // doesn't cross this edge
      Point2 d1 = Sub2(b, a);
      Point2 d2 = Sub2(bend.hingeB, bend.hingeA);
      double denom = Cross2(d1, d2);
      if (std::fabs(denom) < kGeometricEpsilon) continue;  // parallel
      double t = Cross2(Sub2(bend.hingeA, a), d2) / denom;
      crossings.push_back({i, {a.x + d1.x * t, a.y + d1.y * t}});
    }

    if (crossings.size() == 2) {
      Point2 p0 = crossings[0].second;
      Point2 p1 = crossings[1].second;
      bool p0IsA = Length2(Sub2(p0, bend.hingeA)) <= Length2(Sub2(p1, bend.hingeA));
      effective.push_back(p0IsA ? EffectiveHinge{p0, p1} : EffectiveHinge{p1, p0});
      // Insert from the highest edge index down so earlier indices stay valid.
      std::sort(crossings.begin(), crossings.end(),
                [](const auto& x, const auto& y) { return x.first > y.first; });
      for (const auto& [edgeIdx, pt] : crossings) {
        ring.insert(ring.begin() + static_cast<long>(edgeIdx + 1), pt);
      }
      continue;
    }

    // No clean transversal crossing — the hinge may instead run COLLINEAR
    // with existing ring edges rather than through them (e.g. a wall
    // flap's own boundary already sits exactly on the hinge line, extended
    // past its real endpoints by an authored overhang, the same "cosmetic,
    // exaggerated span" convention as MakeStrip's — confirmed on a real
    // regression test, MakeTray's pinwheel-arranged wall flaps). Find every
    // ring vertex lying exactly on the infinite line AND within the given
    // (possibly exaggerated) hinge's own parametric span — excluding a
    // vertex that merely happens to sit on the SAME line but belongs to an
    // unrelated, further-out neighbor (confirmed: two DIFFERENT walls'
    // flaps can each contribute a collinear corner beyond this hinge's own
    // real endpoints). If exactly two survive, they ARE the true,
    // un-exaggerated hinge endpoints.
    {
      Point2 dir = Sub2(bend.hingeA, bend.hingeB);
      double dirLenSq = dir.x * dir.x + dir.y * dir.y;
      std::vector<size_t> onLine;
      if (dirLenSq >= kGeometricEpsilon) {
        for (size_t i = 0; i < n; ++i) {
          double cross = Cross2(dir, Sub2(ring[i], bend.hingeB));
          if (std::fabs(cross) >= kGeometricEpsilon) continue;
          double t = (Sub2(ring[i], bend.hingeB).x * dir.x + Sub2(ring[i], bend.hingeB).y * dir.y) /
                     dirLenSq;
          if (t >= -1e-6 && t <= 1.0 + 1e-6) onLine.push_back(i);
        }
      }
      if (onLine.size() == 2) {
        Point2 p0 = ring[onLine[0]];
        Point2 p1 = ring[onLine[1]];
        bool p0IsA = Length2(Sub2(p0, bend.hingeA)) <= Length2(Sub2(p1, bend.hingeA));
        effective.push_back(p0IsA ? EffectiveHinge{p0, p1} : EffectiveHinge{p1, p0});
      } else {
        // Unresolvable — leave as the original, ungrounded coordinates;
        // downstream match failure surfaces as the existing "region clip
        // failed" error rather than a guessed cut.
        effective.push_back({bend.hingeA, bend.hingeB});
      }
    }
  }
  return {ring, effective};
}

struct BendCut {
  std::string bendId;
  Point2 hingeA, hingeB;
  Point2 childShiftA, childShiftB;
  Point2 parentShiftA, parentShiftB;
  int iA = -1;
  int iB = -1;
};

std::vector<BendCut> BuildBendCuts(const PartGraphSpec& graph,
                                    const std::vector<EffectiveHinge>& effective,
                                    bool zeroOffset) {
  std::vector<BendCut> cuts;
  for (size_t bi = 0; bi < graph.bends.size(); ++bi) {
    const BendSpec& bend = graph.bends[bi];
    const Point2& hingeA = effective[bi].hingeA;
    const Point2& hingeB = effective[bi].hingeB;
    // Left-hand normal of hingeA->hingeB, same convention as the pose walk
    // and every other consumer of a bend's own hinge direction — points
    // toward the child side.
    Point2 dir = Sub2(hingeB, hingeA);
    double len = Length2(dir);
    Point2 nLeft{0.0, 0.0};
    if (len >= kGeometricEpsilon) {
      nLeft = {-dir.y / len, dir.x / len};
    }
    // Bit-for-bit the same signed value Evaluate()'s own pose walk derives
    // for BridgeLayout::setbackMm (docs/BUG_REPORT_reconstructed_envelope_
    // grows_with_bend_radius.md) — NOT ComputeBendGeometry's classic
    // reff*tan(angle/2) setback, a different (unsigned, kFactor-inclusive)
    // quantity that's never actually consumed downstream. Reusing this exact
    // value, rather than recomputing something that merely looks similar, is
    // deliberate: it's what keeps the reconstructed envelope from growing or
    // shrinking with bend radius, a previously-fixed bug this must not
    // reintroduce.
    //
    // `zeroOffset` forces a bare cut exactly at the hinge line, with no
    // width at all — the flat-pattern/DXF-facing region (RegionPanelLayout::
    // regionOuter, built from this): a bend's real allowance zone is grown
    // in by BuildFlatOutline/the pose walk's own cumulativeShift translation
    // instead, never by widening the clip itself (a parent may touch several
    // bends at once, so no single per-panel clip offset could be correct for
    // all of them simultaneously).
    bool concave = BottomIsConcave(bend);
    double signedD = concave ? bend.radiusMm : -bend.radiusMm;
    double sb = zeroOffset ? 0.0 : signedD * std::tan(DegToRad(bend.angleDeg) / 2.0);
    BendCut cut;
    cut.bendId = bend.id;
    cut.hingeA = hingeA;
    cut.hingeB = hingeB;
    // Bit-for-bit the same sideSign/offset convention already verified
    // elsewhere (part_solid_construction.cc's TrimToTangentLines, before its
    // own removal): child = -setbackMm along nLeft, parent = +setbackMm.
    cut.childShiftA = {hingeA.x - sb * nLeft.x, hingeA.y - sb * nLeft.y};
    cut.childShiftB = {hingeB.x - sb * nLeft.x, hingeB.y - sb * nLeft.y};
    cut.parentShiftA = {hingeA.x + sb * nLeft.x, hingeA.y + sb * nLeft.y};
    cut.parentShiftB = {hingeB.x + sb * nLeft.x, hingeB.y + sb * nLeft.y};
    cuts.push_back(cut);
  }
  return cuts;
}

struct TaggedEdge {
  Point2 from;
  Point2 to;
  std::string bendId;
  // Explicit successor index — NOT re-derived from `to`'s coordinate: at
  // zero setback (the flat-pattern-facing pass), a bend's child- and
  // parent-side shift points collapse to the exact same coordinate as each
  // other, so several logically distinct edges can share one physical
  // point. Matching by coordinate there is ambiguous and silently traces
  // the wrong loop (confirmed live: a simple 2-panel test's "parent" region
  // came back as the WHOLE combined outline, both panels merged). Since
  // this function is the one constructing every edge, it already knows
  // which one structurally follows which — recorded here instead of
  // re-discovered.
  size_t next = 0;
};

// Builds the directed-edge set representing the WHOLE outline with every
// bend's own strip removed simultaneously.
//
// A ring vertex can be hingeB (or hingeA) for MORE than one bend at once —
// not just the "two adjacent bends share a parent's corner" case, but also
// when a panel is fully interior (every one of its own edges is itself a
// bend to a further child, so it contributes NO edge of its own to the
// ring) — confirmed on a real regression test (Latin-cross cube net): a
// panel surrounded on all 4 sides has one of its own bends sharing a vertex
// with the bend that reaches its own subtree from the outside. Resolving
// this is interval nesting, not first-match-wins: among however many cuts
// share a vertex as hingeB, the one with the SMALLEST forward span
// (iB->iA) is the one whose own child material genuinely starts at this
// exact point (an inner, more-nested bend), so it claims the outgoing
// main-loop edge; the one with the LARGEST span is the outermost bend
// passing over everything nested inside it, so it claims the "unclaimed,
// jump past this whole subtree" redirect instead (same idea, mirrored, for
// hingeA and the incoming edge). A single match at a vertex is just the
// n=1 case of this same rule — nothing changes for the ordinary, non-shared
// case.
//   - hingeB present: innermost (min span) claims outgoing edge -> childShiftB;
//     outermost (max span) claims the "unclaimed" edge ending here -> parentShiftB,
//     continuing via its own parent bridge.
//   - hingeA present: innermost claims incoming edge -> childShiftA; outermost
//     claims the "unclaimed" edge starting here -> parentShiftA, reached from
//     its own parent bridge.
//   - both present (a vertex shared by an incoming and an outgoing bend, e.g.
//     two walls meeting at a parent's own corner): neither outermost bend has
//     a surviving main-loop edge here at all — a fresh connector edge
//     outermostA.parentShiftA -> outermostB.parentShiftB bridges the gap,
//     spliced between the two bends' own parent bridges.
// Every bend also gets its own parent-side bridge (always, since parent's
// sequence never directly connects hingeB to hingeA once a child exists
// there) and its own child-side closing bridge (only when hingeB/hingeA
// aren't already directly adjacent in the ring — when they are, the single
// modified original edge already IS that closing edge).
struct CutEdgesResult {
  std::vector<TaggedEdge> edges;
  // Parallel to `cuts`: the edge index that unambiguously belongs to that
  // bend's own child loop / parent loop — NOT a coordinate (see
  // TaggedEdge::next's own comment: at zero setback, a bend's child- and
  // parent-side shift points can be the exact same coordinate, so only
  // edge identity, never a point value, can tell the two loops apart).
  std::vector<size_t> childSeedEdge;
  std::vector<size_t> parentSeedEdge;
};

CutEdgesResult BuildCutEdges(const std::vector<Point2>& ring, std::vector<BendCut> cuts) {
  size_t n = ring.size();
  std::vector<std::vector<size_t>> hingeBAt(n);
  std::vector<std::vector<size_t>> hingeAAt(n);
  for (size_t c = 0; c < cuts.size(); ++c) {
    for (size_t i = 0; i < n; ++i) {
      if (NearlyEqual2Local(ring[i], cuts[c].hingeB)) {
        hingeBAt[i].push_back(c);
        cuts[c].iB = static_cast<int>(i);
        break;
      }
    }
    for (size_t i = 0; i < n; ++i) {
      if (NearlyEqual2Local(ring[i], cuts[c].hingeA)) {
        hingeAAt[i].push_back(c);
        cuts[c].iA = static_cast<int>(i);
        break;
      }
    }
  }
  // Each cut's own forward span (iB -> iA, in ring order) — the interval-
  // nesting metric: a smaller span is more deeply nested.
  std::vector<size_t> span(cuts.size(), 0);
  for (size_t c = 0; c < cuts.size(); ++c) {
    if (cuts[c].iA >= 0 && cuts[c].iB >= 0) {
      span[c] = (static_cast<size_t>(cuts[c].iA) - static_cast<size_t>(cuts[c].iB) + n) % n;
    }
  }
  auto minSpanOf = [&](const std::vector<size_t>& group) {
    size_t best = group[0];
    for (size_t c : group) {
      if (span[c] < span[best]) best = c;
    }
    return best;
  };
  auto maxSpanOf = [&](const std::vector<size_t>& group) {
    size_t best = group[0];
    for (size_t c : group) {
      if (span[c] > span[best]) best = c;
    }
    return best;
  };

  std::vector<TaggedEdge> edges(n);
  for (size_t i = 0; i < n; ++i) {
    size_t j = (i + 1) % n;
    edges[i].from = ring[i];
    edges[i].to = ring[j];
    edges[i].next = j;  // default: continue around the original ring
    if (!hingeBAt[i].empty()) {
      size_t ci = minSpanOf(hingeBAt[i]);
      edges[i].from = cuts[ci].childShiftB;
      // Tagging is separate from the endpoint shift above: this main-loop
      // edge is genuinely the bend's OWN zone-boundary edge only when it
      // directly spans hingeB to hingeA with nothing spliced in between
      // (the "directly adjacent" case — the same edge already used as the
      // whole cut). Otherwise this edge merely touches a hinge point from
      // an unrelated direction (e.g. a panel's own far edge happening to
      // end at its own hinge vertex) and must stay untagged — the real
      // zone-boundary tag lives on the dedicated bridge edges added below.
      if (NearlyEqual2Local(ring[j], cuts[ci].hingeA)) edges[i].bendId = cuts[ci].bendId;
    }
    if (!hingeAAt[j].empty()) {
      size_t ci = minSpanOf(hingeAAt[j]);
      edges[i].to = cuts[ci].childShiftA;
    }
  }

  // Parent bridges first, in their own pass — a child bridge's own "next"
  // (below) may need to point at ANOTHER cut's parent bridge instead of a
  // raw ring index (see this function's own header comment on interior
  // panels), so every parentBridgeIdx must already exist before any
  // childBridgeIdx is computed.
  std::vector<size_t> parentBridgeIdx(cuts.size());
  for (size_t ci = 0; ci < cuts.size(); ++ci) {
    const auto& cut = cuts[ci];
    parentBridgeIdx[ci] = edges.size();
    edges.push_back({cut.parentShiftB, cut.parentShiftA, cut.bendId, 0});
  }

  std::vector<size_t> childBridgeIdx(cuts.size(), SIZE_MAX);  // SIZE_MAX = none (directly adjacent)
  for (size_t ci = 0; ci < cuts.size(); ++ci) {
    const auto& cut = cuts[ci];
    bool directlyAdjacent =
        cut.iB >= 0 && cut.iA >= 0 &&
        static_cast<size_t>(cut.iA) == (static_cast<size_t>(cut.iB) + 1) % n;
    if (directlyAdjacent) continue;
    // Where this bend's OWN child material resumes after closing the loop
    // back at its own hingeB: ordinarily the raw main-loop edge there. But
    // if that same vertex is ALSO hingeB for a MORE nested cut (this one
    // isn't the innermost claim there — a fully-interior panel, surrounded
    // on all sides, sharing a vertex with the bend that reaches its own
    // subtree from outside), that main-loop edge was claimed by the inner
    // cut for ITS OWN, unrelated child material — this bend's own loop must
    // instead chain directly into the inner cut's own parent bridge,
    // bypassing the ring entirely.
    size_t resumeAt = cut.iB >= 0 ? static_cast<size_t>(cut.iB) : 0;
    if (cut.iB >= 0 && hingeBAt[static_cast<size_t>(cut.iB)].size() > 1 &&
        minSpanOf(hingeBAt[static_cast<size_t>(cut.iB)]) != ci) {
      resumeAt = parentBridgeIdx[minSpanOf(hingeBAt[static_cast<size_t>(cut.iB)])];
    }
    childBridgeIdx[ci] = edges.size();
    edges.push_back({cut.childShiftA, cut.childShiftB, cut.bendId, resumeAt});
  }

  for (size_t v = 0; v < n; ++v) {
    size_t prev = (v + n - 1) % n;
    bool isB = !hingeBAt[v].empty();
    bool isA = !hingeAAt[v].empty();
    if (isB && !isA) {
      size_t ci = maxSpanOf(hingeBAt[v]);
      edges[prev].to = cuts[ci].parentShiftB;
      edges[prev].next = parentBridgeIdx[ci];
    } else if (isA && !isB) {
      size_t outer = maxSpanOf(hingeAAt[v]);
      edges[v].from = cuts[outer].parentShiftA;
      edges[parentBridgeIdx[outer]].next = v;
      // Every OTHER (more nested) cut sharing this same hingeA vertex has no
      // main-loop edge of its own left to close through (the outer cut just
      // claimed it) — its own parent bridge instead closes directly back
      // into the outer cut's own entry point, the mirror image of
      // childBridgeIdx's own redirect above (a fully-interior panel's own
      // loop returning to where it started, e.g. F1 in the Latin-cross net).
      for (size_t inner : hingeAAt[v]) {
        if (inner == outer) continue;
        edges[parentBridgeIdx[inner]].next =
            childBridgeIdx[outer] != SIZE_MAX
                ? childBridgeIdx[outer]
                : (cuts[outer].iB >= 0 ? static_cast<size_t>(cuts[outer].iB) : v);
      }
    } else if (isA && isB) {
      size_t ciA = maxSpanOf(hingeAAt[v]);
      size_t ciB = maxSpanOf(hingeBAt[v]);
      size_t connectorIdx = edges.size();
      edges.push_back({cuts[ciA].parentShiftA, cuts[ciB].parentShiftB, std::string(),
                        parentBridgeIdx[ciB]});
      edges[parentBridgeIdx[ciA]].next = connectorIdx;
    }
  }

  for (size_t ci = 0; ci < cuts.size(); ++ci) {
    if (childBridgeIdx[ci] == SIZE_MAX) continue;  // directly adjacent — nothing more to wire up
    if (cuts[ci].iA < 0) continue;  // hinge never grounded in the ring — nothing to wire up here
    size_t iA = static_cast<size_t>(cuts[ci].iA);
    // Only the innermost cut at this hingeA vertex actually owns the
    // main-loop edge ending here (edges[prevA].to == childShiftA(ci)) — see
    // the main-edge-building pass above, which uses the same minSpanOf. A
    // more-outer cut sharing the same iA needs no wiring here at all: its
    // own childBridge closes elsewhere entirely (handled by the isA&&!isB
    // branch above, which redirects the true innermost cut's own parent
    // bridge back to it directly).
    if (hingeAAt[iA].size() > 1 && minSpanOf(hingeAAt[iA]) != ci) continue;
    size_t prevA = (iA + n - 1) % n;
    edges[prevA].next = childBridgeIdx[ci];
  }

  CutEdgesResult result;
  result.edges = std::move(edges);
  result.childSeedEdge.resize(cuts.size());
  result.parentSeedEdge.resize(cuts.size());
  for (size_t ci = 0; ci < cuts.size(); ++ci) {
    // Prefer this cut's own closing bridge as the seed — unambiguously its
    // own edge — over the raw main-loop edge at iB, which a more-nested
    // cut sharing the same hingeB vertex may have claimed for unrelated
    // material (a fully-interior panel's own parent bend, e.g. F1's own
    // b01 in the Latin-cross net — see this function's own header
    // comment). Tracing from either point reaches the identical cycle when
    // there's no such sharing, so this is safe in the ordinary case too.
    if (childBridgeIdx[ci] != SIZE_MAX) {
      result.childSeedEdge[ci] = childBridgeIdx[ci];
    } else {
      result.childSeedEdge[ci] = cuts[ci].iB >= 0 ? static_cast<size_t>(cuts[ci].iB) : SIZE_MAX;
    }
    result.parentSeedEdge[ci] = parentBridgeIdx[ci];
  }
  return result;
}

struct Loop {
  std::vector<Point2> points;
  // Parallel to `points`: edgeBendId[i] is the tag of edge (points[i],
  // points[(i+1)%n]).
  std::vector<std::string> edgeBendId;
};

// Every edge built above has an explicit, unambiguous successor (see
// TaggedEdge::next's own comment on why coordinate-matching can't be used
// here), so tracing a loop out of the edge set is a plain walk from a known
// starting edge (identified by INDEX, never by coordinate — see
// CutEdgesResult's own comment on why a bare point value can't
// disambiguate which loop it belongs to) until back at the loop's own
// start.
Loop TraceLoopFrom(const std::vector<TaggedEdge>& edges, size_t startEdge) {
  Loop loop;
  size_t cur = startEdge;
  std::vector<bool> visited(edges.size(), false);
  while (cur < edges.size() && !visited[cur]) {
    visited[cur] = true;
    loop.points.push_back(edges[cur].from);
    loop.edgeBendId.push_back(edges[cur].bendId);
    cur = edges[cur].next;
  }
  return loop;
}

struct RegionOfResult {
  // The panel's region trimmed to its own true tangent line at every
  // touching bend (this bend's own real, signed setbackMm) — what
  // ConstructPartSolid builds the panel wall from (RegionPanelLayout::
  // rawOuter).
  std::vector<Point2> outer;
  // Parallel to `outer`: edgeBendId[i] describes the edge (outer[i],
  // outer[(i+1)%n]) — see the field's doc comment on RegionPanelLayout for why this
  // is computed here (where the bend cuts already exist) and nowhere else.
  std::vector<std::string> edgeBendId;
  // The SAME panel's region cut with zero margin, exactly at each bend's raw
  // hinge line — the flat-pattern/DXF-facing shape (RegionPanelLayout::
  // regionOuter, after Evaluate()'s own cumulativeShift translation); this is
  // what BuildFlatOutline's own allowance-driven union math expects to union
  // against, unaffected by solid-construction's own setback trim.
  std::vector<Point2> outerZeroOffset;
  // Parallel to `outerZeroOffset` — see RegionPanelLayout::regionEdgeBendId.
  std::vector<std::string> zeroOffsetEdgeBendId;
  // Phase 5 Slice 9a: holes belonging to this region panel (see
  // RegionPanelLayout's own doc comment) — tested against `outer`.
  std::vector<std::vector<Point2>> polygonHoles;
  std::vector<CircleHoleSpec> circleHoles;
  // Same holes, tested against `outerZeroOffset` instead (RegionPanelLayout::
  // regionPolygonHoles/regionCircleHoles).
  std::vector<std::vector<Point2>> zeroOffsetPolygonHoles;
  std::vector<CircleHoleSpec> zeroOffsetCircleHoles;
};

// Runs the cut-edges/trace/select pipeline once for a given set of bend
// cuts, returning the one loop belonging to regionPanelId (see
// BuildCutEdges and TraceLoopFrom's own header comments) — shared by
// RegionOf's two passes (real setback, and zero-offset) since they differ
// only in which BendCut set feeds in.
std::optional<Loop> ExtractLoop(const PartGraphSpec& graph, const std::string& regionPanelId,
                                 const std::vector<Point2>& ring,
                                 const std::vector<BendCut>& cuts) {
  CutEdgesResult built = BuildCutEdges(ring, cuts);

  // Seed edge: whichever bend touches regionPanelId — as child, its own
  // childSeedEdge (the main-loop edge starting at that bend's own
  // childShiftB); as the root (no parent bend of its own), any of its own
  // bends' parentSeedEdge. Identified by EDGE INDEX, never by point value:
  // at zero setback, a bend's child- and parent-shift points can be the
  // exact same coordinate, so only edge identity can tell the two loops
  // apart (confirmed live: coordinate matching silently returned the wrong
  // panel's region for a simple 2-panel case).
  size_t seedEdge = SIZE_MAX;
  for (size_t bi = 0; bi < graph.bends.size(); ++bi) {
    if (graph.bends[bi].childRegionPanelId != regionPanelId) continue;
    seedEdge = built.childSeedEdge[bi];
    break;
  }
  if (seedEdge == SIZE_MAX) {
    for (size_t bi = 0; bi < graph.bends.size(); ++bi) {
      if (graph.bends[bi].parentRegionPanelId != regionPanelId) continue;
      seedEdge = built.parentSeedEdge[bi];
      break;
    }
  }
  if (seedEdge == SIZE_MAX) return std::nullopt;  // regionPanelId touches no bend at all — invalid graph

  Loop loop = TraceLoopFrom(built.edges, seedEdge);
  if (loop.points.size() < 3) return std::nullopt;  // malformed cut
  return loop;
}

std::optional<RegionOfResult> RegionOf(const PartGraphSpec& graph,
                                        const std::string& regionPanelId) {
  if (graph.bends.empty()) {
    // No bends anywhere — nothing to cut; the whole outline IS the (single)
    // region panel's own region, both views alike.
    RegionOfResult out;
    out.outer = graph.outline.outer;
    out.outerZeroOffset = graph.outline.outer;
    out.edgeBendId.assign(out.outer.size(), std::string());
    out.zeroOffsetEdgeBendId.assign(out.outerZeroOffset.size(), std::string());
    for (const auto& hole : graph.outline.polygonHoles) {
      if (RingFullyInsidePolygon(hole, out.outer)) {
        out.polygonHoles.push_back(hole);
        out.zeroOffsetPolygonHoles.push_back(hole);
      }
    }
    for (const auto& hole : graph.outline.circleHoles) {
      if (CircleFullyInsidePolygon(hole.center, hole.radiusMm, out.outer)) {
        out.circleHoles.push_back(hole);
        out.zeroOffsetCircleHoles.push_back(hole);
      }
    }
    return out;
  }

  auto [ring, effectiveHinges] = EnsureHingeVertices(graph.outline.outer, graph);
  std::vector<BendCut> cuts = BuildBendCuts(graph, effectiveHinges, /*zeroOffset=*/false);
  std::vector<BendCut> cutsZero = BuildBendCuts(graph, effectiveHinges, /*zeroOffset=*/true);

  std::optional<Loop> loop = ExtractLoop(graph, regionPanelId, ring, cuts);
  std::optional<Loop> loopZero = ExtractLoop(graph, regionPanelId, ring, cutsZero);
  if (!loop.has_value() || !loopZero.has_value()) return std::nullopt;

  RegionOfResult out;
  out.outer = loop->points;
  out.edgeBendId = loop->edgeBendId;
  out.outerZeroOffset = loopZero->points;
  out.zeroOffsetEdgeBendId = loopZero->edgeBendId;
  for (const auto& hole : graph.outline.polygonHoles) {
    if (RingFullyInsidePolygon(hole, out.outer)) out.polygonHoles.push_back(hole);
    if (RingFullyInsidePolygon(hole, out.outerZeroOffset)) out.zeroOffsetPolygonHoles.push_back(hole);
  }
  for (const auto& hole : graph.outline.circleHoles) {
    if (CircleFullyInsidePolygon(hole.center, hole.radiusMm, out.outer)) {
      out.circleHoles.push_back(hole);
    }
    if (CircleFullyInsidePolygon(hole.center, hole.radiusMm, out.outerZeroOffset)) {
      out.zeroOffsetCircleHoles.push_back(hole);
    }
  }
  return out;
}

}  // namespace

// ─── Tree walk / chain composition ──────────────────────────────────────────

namespace {

struct TreeValidation {
  bool ok = true;
  EvaluateErrorCode errorCode = EvaluateErrorCode::kNone;
  std::string message;
};

TreeValidation ValidateTree(const PartGraphSpec& graph) {
  for (const auto& bend : graph.bends) {
    if (bend.parentRegionPanelId == bend.childRegionPanelId) {
      return {false, EvaluateErrorCode::kBendSelfReference,
              "bend " + bend.id + " has identical parent/child region panel id"};
    }
  }
  // Every non-root region panel referenced as a child must have exactly one
  // incoming bend (tree invariant, 14 §5); detect duplicates.
  std::unordered_map<std::string, int> incomingCount;
  for (const auto& bend : graph.bends) {
    incomingCount[bend.childRegionPanelId]++;
  }
  for (const auto& [id, count] : incomingCount) {
    if (count > 1) {
      return {false, EvaluateErrorCode::kTreeCycleDetected,
              "region panel " + id + " has " + std::to_string(count) +
                  " incoming bends (tree invariant requires exactly 1)"};
    }
  }
  // Cycle detection: walk from root_region_panel via child edges; every bend's
  // childRegionPanelId must be reachable from root exactly once (no cycles).
  std::unordered_map<std::string, std::vector<const BendSpec*>> childrenOf;
  for (const auto& bend : graph.bends) {
    childrenOf[bend.parentRegionPanelId].push_back(&bend);
  }
  std::unordered_set<std::string> visited;
  std::vector<std::string> stack{graph.rootRegionPanelId};
  while (!stack.empty()) {
    std::string current = stack.back();
    stack.pop_back();
    if (visited.count(current)) {
      return {false, EvaluateErrorCode::kTreeCycleDetected,
              "cycle detected reaching region panel " + current + " twice"};
    }
    visited.insert(current);
    for (const auto* bend : childrenOf[current]) {
      stack.push_back(bend->childRegionPanelId);
    }
  }
  return {true, EvaluateErrorCode::kNone, ""};
}

}  // namespace

EvaluateResult Evaluate(const PartGraphSpec& graph) {
  EvaluateResult result;

  if (graph.outline.outer.size() < 3) {
    result.errorCode = EvaluateErrorCode::kDegenerateOutline;
    result.message = "part outline must have at least 3 vertices";
    return result;
  }

  TreeValidation validation = ValidateTree(graph);
  if (!validation.ok) {
    result.errorCode = validation.errorCode;
    result.message = validation.message;
    return result;
  }

  // Pose walk: parent-before-child order via BFS from root, per bend using its own
  // raw flat-frame hinge transformed through the ALREADY-COMPUTED parent pose (this
  // is what "B_i = intrinsic fold conjugated by preceding chain" (13 §4) computes to
  // concretely — no explicit inverse/conjugation needed, just forward composition).
  //
  // Also computed here, alongside the pose: `cumulativeShift[p]`, a running 2D
  // offset (in the shared flat frame F) that makes each region panel's own
  // territory land where it truly belongs once every bend it descends from
  // actually consumes real, inserted bend-allowance material — this is a
  // SEPARATE, 3D-placement-facing quantity (the full bend allowance, ba)
  // from RegionOf's own per-panel setback trim (each panel's flat region is
  // trimmed to its true tangent line at its own setbackMm, not this
  // allowance). `cumulativeShift[root] = 0`; each bend adds its own full bend
  // allowance, along the hinge's own outward (child-side) normal, to every
  // panel in its child's subtree — never HALF of it split across parent and
  // child, because the PARENT'S OWN territory is never touched by widening
  // (only what lies beyond, in the child's subtree, moves) — a single
  // cumulative running total can't be attributed per-panel-touching-bend any
  // other way once a panel touches more than one bend.
  std::unordered_map<std::string, Transform3> poseByRegionPanel;
  poseByRegionPanel[graph.rootRegionPanelId] = graph.anchor.transform;
  std::unordered_map<std::string, Point2> cumulativeShift;
  cumulativeShift[graph.rootRegionPanelId] = {0.0, 0.0};

  std::unordered_map<std::string, std::vector<const BendSpec*>> childrenOf;
  for (const auto& bend : graph.bends) {
    childrenOf[bend.parentRegionPanelId].push_back(&bend);
  }

  std::vector<std::string> queue{graph.rootRegionPanelId};
  size_t qi = 0;
  while (qi < queue.size()) {
    std::string current = queue[qi++];
    const Transform3& parentPose = poseByRegionPanel.at(current);
    const Point2& parentShift = cumulativeShift.at(current);
    for (const auto* bend : childrenOf[current]) {
      // Left-hand normal of hingeA->hingeB — same convention/formula RegionOf's
      // own bend cuts use (14's fixed "child = left side" rule) — points toward
      // the child side.
      Point2 hingeDir = Sub2(bend->hingeB, bend->hingeA);
      double hingeDirLen = Length2(hingeDir);
      Point2 nLeft{0.0, 0.0};
      if (hingeDirLen >= kGeometricEpsilon) {
        nLeft = {-hingeDir.y / hingeDirLen, hingeDir.x / hingeDirLen};
      }
      BendGeometryMm bendGeom = ComputeBendGeometry(*bend, graph.thicknessMm);
      double ba = bendGeom.allowanceMm;

      // The axis's in-plane position is the raw hinge, shifted by whatever the
      // PARENT's own territory has already accumulated (never anything of this
      // bend's own BA — the parent's own material is untouched by its own
      // outgoing bend, only the child's subtree moves, per the comment above).
      // This shifted pair is ONLY for the 2D bridge.hingeA/hingeB report
      // below (the F-frame, flat-pattern-consistent "where is this bend"
      // fact) — NOT for the 3D axis. parentPose now consumes each panel's
      // RAW (un-widened) coordinates directly (see childPose below), so the
      // axis must be positioned from the RAW hinge coordinate, never a
      // 2D-flat-pattern-shifted one — adding parentShift there was a stale
      // leftover from the old (pre-fix) model where parentPose consumed the
      // shifted frame instead, and silently corrupted every bend past the
      // first one in a chain (parentShift is always zero for a root's own
      // first bend, which is exactly why no single-bend test caught this —
      // only a multi-bend chain's own closure could, and did).
      Point2 hingeAShifted{bend->hingeA.x + parentShift.x, bend->hingeA.y + parentShift.y};
      Point2 hingeBShifted{bend->hingeB.x + parentShift.x, bend->hingeB.y + parentShift.y};

      // Pivot axis for the actual fold rotation is the hinge centreline offset off
      // the bottom (z=0) surface by the bottom-surface radius r_b. Derived from
      // requiring BOTH surfaces have the correct radius from one shared pivot point
      // p: bottom (z=0) at distance r_b, top (z=thicknessMm) at distance
      // r_b +/- thicknessMm (whichever is the other surface's true radius). Solving
      // |p|=r_b and |p-thicknessMm|=r_top for each direction gives p=-radiusMm for a
      // mountain fold (bottom=inner=radiusMm, top=outer=radiusMm+thicknessMm) and
      // p=+r_b for a valley fold (bottom=outer=r_b, top=inner=radiusMm) — i.e. the
      // pivot sits on the OPPOSITE side of the bottom surface from the direction the
      // fold's own material occupies for a mountain fold, and on the SAME side for a
      // valley fold. At radiusMm=0 this reduces to z=0 for mountain (matches the old
      // sharp-fold pivot exactly — no regression) but z=+thicknessMm for valley (r_b
      // is never zero there), which is the derived fix for the valley-fold gap.
      // "Concave" here uses BottomIsConcave (bend->bottomIsConcave when set,
      // else the same angleDeg-sign fallback) — see that function's own doc
      // comment for why this is independent of angleDeg's sign in general.
      bool concave = BottomIsConcave(*bend);
      double rBottom = BottomRadiusMm(*bend, graph.thicknessMm);
      double pivotZ = concave ? -rBottom : rBottom;

      // Axis in-plane position, plus a matching child-side extension
      // (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md).
      // This is a SEPARATE property from RegionOf's own per-panel setback
      // trim (confirmed by real test failures, not assumed): trimming each
      // panel's own rawOuter to its true tangent line makes THAT panel's own
      // wall edge locally tangent to its own bend's cylinder, but does
      // nothing to stop the CUMULATIVE 3D pose of a multi-bend chain (e.g. an
      // N-gon tube closing on itself) from drifting as radiusMm varies —
      // removing this block once, to test whether it had become redundant
      // with RegionOf's new trim, reintroduced exactly that drift (confirmed
      // via the N=4/5/6 closed-tube tests, off by an amount scaling with
      // radiusMm), while the single-bend tangency test stayed green either
      // way. The two corrections address different scopes and both stay.
      //
      // A wall built from the raw, un-widened hinge coordinate is tangent to
      // the bend's own cylinder (pivotZ above) but that alone does not keep
      // the part's overall envelope fixed as radiusMm changes — proved
      // algebraically: for ANY in-plane axis offset, with height held at
      // pivotZ, rotating a fixed-length child by exactly angleDeg about that
      // axis reproduces the sharp-corner (radiusMm=0) target only in the
      // trivial radiusMm=0 case itself. (A rotation about a parallel axis
      // always differs from one about the true, radiusMm=0 axis by exactly
      // one constant translation; cancelling that translation for every
      // point at once forces pivotZ back to its own radiusMm=0 value — so
      // axis position alone, or a translation added afterward alone, can
      // never do it while pivotZ stays real.) The only way to keep a real,
      // tangent pivotZ AND the sharp-corner envelope is to also change how
      // far the child's own local frame reaches: a per-bend, purely local
      // setback — a function of this bend's own radiusMm and angleDeg only,
      // never anything upstream — both moves the axis and extends the
      // child's effective local origin by twice that amount. This composes
      // correctly down an arbitrarily deep chain with no extra running
      // total: each bend reads only its own raw hinge and the pose its
      // parent already carries (which already carries every ancestor's own
      // correction), so nothing needs threading through cumulativeShift or
      // any other side channel. Verified exactly (0 residual, both fold
      // directions, five bend angles, chained two deep) in the bug report
      // above. The general, fully-signed formula is D*tan(angleRad/2), where
      // D = pivotZ_true - pivotZ = concave ? +radiusMm : -radiusMm and
      // angleRad uses angleDeg's OWN sign (not its magnitude) — this must
      // NOT be simplified to a magnitude-only |angleDeg| shortcut: concave
      // and angleDeg's sign are independent facts (BottomIsConcave's own doc
      // comment), not always aligned — a real, reconciled graph can and does
      // set bottomIsConcave true with a negative angleDeg (or vice versa),
      // which the |angleDeg| shortcut silently gets backwards (a real bug
      // this exact case caught, see the bug report above). When concave and
      // angleDeg's sign DO happen to align (the common authored case), D and
      // angleRad's signs cancel and this reduces to the simpler
      // radiusMm*tan(|angleRad|/2), always toward the child — but that's a
      // consequence of this formula, not a separate rule.
      double signedD = concave ? bend->radiusMm : -bend->radiusMm;
      double axisInPlaneOffset = signedD * std::tan(DegToRad(bend->angleDeg) / 2.0);

      Point3 hingeA3{bend->hingeA.x + axisInPlaneOffset * nLeft.x,
                      bend->hingeA.y + axisInPlaneOffset * nLeft.y, pivotZ};
      Point3 hingeB3{bend->hingeB.x + axisInPlaneOffset * nLeft.x,
                      bend->hingeB.y + axisInPlaneOffset * nLeft.y, pivotZ};
      Point3 hingeAWorld = parentPose.Apply(hingeA3);
      Point3 hingeBWorld = parentPose.Apply(hingeB3);
      Point3 axis = Normalize3(Sub3(hingeBWorld, hingeAWorld));
      if (Length3(axis) < kGeometricEpsilon) {
        result.errorCode = EvaluateErrorCode::kDegenerateOutline;
        result.message = "bend " + bend->id + " has a zero-length hinge";
        return result;
      }
      Transform3 worldFold = Transform3::RotationAboutAxis(hingeAWorld, axis, bend->angleDeg);

      // Child-side extension: every point of the child's own subtree is
      // translated by 2x this bend's own in-plane offset, along nLeft, in
      // the shared flat frame, BEFORE the fold above is applied — composed
      // as the innermost transform so ancestor corrections (already baked
      // into parentPose) carry through first, and this bend's own
      // correction is added on top, once.
      Transform3 childExtension = Transform3::Translation(
          2.0 * axisInPlaneOffset * nLeft.x, 2.0 * axisInPlaneOffset * nLeft.y, 0.0);
      Transform3 childPose = worldFold.Compose(parentPose).Compose(childExtension);
      poseByRegionPanel[bend->childRegionPanelId] = childPose;
      cumulativeShift[bend->childRegionPanelId] = {parentShift.x + ba * nLeft.x,
                                                     parentShift.y + ba * nLeft.y};
      queue.push_back(bend->childRegionPanelId);

      // The bend's true 2D position: the CENTER of its allowance zone, not
      // its start. hingeAShifted/hingeBShifted already sit at the zone's
      // start (the parent's own edge); the center is exactly half the
      // zone's own width (ba*nLeft) further along, toward the child. This
      // is a purely 2D, flat-pattern-facing fact, unrelated to the 3D pose.
      BridgeLayout bridge;
      bridge.bendId = bend->id;
      bridge.parentRegionPanelId = bend->parentRegionPanelId;
      bridge.childRegionPanelId = bend->childRegionPanelId;
      bridge.pivotOriginWorld = hingeAWorld;
      bridge.pivotAxisWorld = axis;
      bridge.angleDeg = bend->angleDeg;
      bridge.hingeA = {hingeAShifted.x + 0.5 * ba * nLeft.x, hingeAShifted.y + 0.5 * ba * nLeft.y};
      bridge.hingeB = {hingeBShifted.x + 0.5 * ba * nLeft.x, hingeBShifted.y + 0.5 * ba * nLeft.y};

      // Setback + world-space directions (see this struct's own header
      // comment) — RegionOf's own bend cuts derive each side's own tangent
      // points from this exact same value (BuildBendCuts), not from any
      // hingeA/hingeB-based absolute position. Signed — never abs().
      bridge.setbackMm = axisInPlaneOffset;
      bridge.nLeftWorld = parentPose.ApplyVector({nLeft.x, nLeft.y, 0.0});
      bridge.childNLeftWorld = worldFold.ApplyVector(bridge.nLeftWorld);
      bridge.rawHingeA = bend->hingeA;
      bridge.rawHingeB = bend->hingeB;
      bridge.nLeftFlat = nLeft;
      result.bridges.push_back(std::move(bridge));
    }
  }

  // regionOf + bottomFace/topFace per visited region panel. RegionOf clips the
  // raw, zero-allowance outline (BoundingBends' zero-offset lines) — every
  // panel's own straight territory, un-shrunk; each panel's own cumulativeShift
  // (computed above) then translates it to where it truly belongs once the
  // bend-allowance material its own ancestors consume is actually accounted
  // for — the ONE derivation this whole file's header comment requires,
  // applied uniformly to regionOuter (and any holes) here rather than smeared
  // across a widened outline polygon and clip-line offsets both.
  for (const auto& regionPanelId : queue) {
    auto regionResult = RegionOf(graph, regionPanelId);
    if (!regionResult.has_value()) {
      result.errorCode = EvaluateErrorCode::kRegionClipFailed;
      result.message = "region clip failed (degenerate) for region panel " + regionPanelId;
      return result;
    }
    const Point2& shift = cumulativeShift.at(regionPanelId);
    // rawOuter is the panel's raw, zero-offset region — cut exactly at each
    // bend's raw hinge line, no setback — the shape bottomFace/topFace,
    // point_mapping.cc, and the bridge-construction loop's own tangent-point
    // math (which already adds this same setbackMm ON TOP of rawOuter's
    // bottomFace/topFace itself, via BridgeLayout::setbackMm) all expect.
    // wallOuter is the SEPARATE setback-trimmed region (RegionOf's own
    // non-zero-margin pass) — solid-wall polygon construction alone uses
    // this, for the same reason TrimToTangentLines used to operate on a
    // purely LOCAL copy rather than rawOuter itself: rawOuter is a shared
    // field with independent consumers that all expect the raw shape (one
    // that already needing setback bakes it in explicitly, never implicitly
    // via a shifted rawOuter — confirmed by real test failures when this was
    // tried the other way: bottomFace/topFace being setback-shifted made the
    // "wall sits sqrt(setback^2+radius^2) from the axis" invariant silently
    // cancel to the bare radius, since the axis ALSO carries this same
    // in-plane offset (axisInPlaneOffset, this file's own pose-walk
    // comment)). regionOuter is rawOuter's own further-shifted (by
    // cumulativeShift below) flat-pattern/DXF-only view.
    std::vector<Point2> rawOuter = regionResult->outerZeroOffset;
    std::vector<std::vector<Point2>> rawPolygonHoles = regionResult->zeroOffsetPolygonHoles;
    std::vector<CircleHoleSpec> rawCircleHoles = regionResult->zeroOffsetCircleHoles;

    std::vector<Point2> regionOuter = rawOuter;
    for (auto& v : regionOuter) {
      v.x += shift.x;
      v.y += shift.y;
    }
    std::vector<std::vector<Point2>> regionPolygonHoles = rawPolygonHoles;
    for (auto& ring : regionPolygonHoles) {
      for (auto& v : ring) {
        v.x += shift.x;
        v.y += shift.y;
      }
    }
    std::vector<CircleHoleSpec> regionCircleHoles = rawCircleHoles;
    for (auto& hole : regionCircleHoles) {
      hole.center.x += shift.x;
      hole.center.y += shift.y;
    }
    const Transform3& pose = poseByRegionPanel.at(regionPanelId);

    RegionPanelLayout layout;
    layout.regionPanelId = regionPanelId;
    layout.regionOuter = regionOuter;
    layout.rawOuter = rawOuter;
    layout.wallOuter = regionResult->outer;
    layout.wallPolygonHoles = regionResult->polygonHoles;
    layout.wallCircleHoles = regionResult->circleHoles;
    layout.pose = pose;
    layout.edgeBendId = regionResult->zeroOffsetEdgeBendId;
    layout.regionEdgeBendId = regionResult->zeroOffsetEdgeBendId;
    layout.regionPolygonHoles = regionPolygonHoles;
    layout.regionCircleHoles = regionCircleHoles;
    layout.rawPolygonHoles = rawPolygonHoles;
    layout.rawCircleHoles = rawCircleHoles;
    layout.bottomFace.reserve(rawOuter.size());
    layout.topFace.reserve(rawOuter.size());
    for (const auto& v : rawOuter) {
      // Offset BEFORE pose (z=0 vs z=thickness), equivalent to offsetting along the
      // transformed normal after pose since Pose is rigid (13 §3.3).
      layout.bottomFace.push_back(pose.Apply({v.x, v.y, 0.0}));
      layout.topFace.push_back(pose.Apply({v.x, v.y, graph.thicknessMm}));
    }
    result.panels.push_back(std::move(layout));
  }

  result.ok = true;
  return result;
}

}  // namespace mcp_cad::translation
