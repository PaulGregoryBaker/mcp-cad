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
// shared — see this module's own header comment on why). Fallback polarity
// must track that function's own exactly: it was found backward there
// (rebuild/20-bend-bridge-geometry.md) and fixed to angleDeg<0 — this
// mirrored copy was missed in that fix, which silently desynced this
// module's own tangent-shift formula from Evaluate()'s wallOuter for any
// bend relying on the fallback (caught by this file's own
// "flush side matches Evaluate()'s own wallOuter" cross-check test).
bool BottomIsConcave(const BendSpec& bend) {
  return bend.bottomIsConcave.has_value() ? *bend.bottomIsConcave : (bend.angleDeg < 0.0);
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

  // No clean transversal crossing — first check directly whether spanA and
  // spanB (the hinge's own true endpoints) are themselves real ring
  // vertices. This is the ordinary case once a SIBLING bend sharing this
  // same corner has already been split off: that split's own local notch
  // (see BuildEndpoint) can leave a new vertex sitting collinear with THIS
  // hinge's line too, purely because both bends meet at one right-angle
  // corner — a real, common shape, not a rare one. A direct match on the
  // hinge's own known coordinates settles it unambiguously without ever
  // needing the broader scan below, which can't tell that extra point
  // apart from a genuine ambiguity and would otherwise reject a perfectly
  // ordinary hinge as ungrounded.
  auto exactIdx = [&](const Point2& p) -> std::optional<size_t> {
    for (size_t i = 0; i < n; ++i) {
      if (NearlyEqual2(ring[i], p)) return i;
    }
    return std::nullopt;
  };
  auto idxSpanA = exactIdx(spanA);
  auto idxSpanB = exactIdx(spanB);
  if (idxSpanA && idxSpanB && *idxSpanA != *idxSpanB) {
    Point2 pA = ring[*idxSpanA];
    Point2 pB = ring[*idxSpanB];
    bool aIsNearLineA = Length2(Sub2(pA, lineA)) <= Length2(Sub2(pB, lineA));
    GroundedLine out;
    out.ring = ring;
    out.crossA = aIsNearLineA ? pA : pB;
    out.crossB = aIsNearLineA ? pB : pA;
    return out;
  }

  // Look for the line running collinear with existing ring edges instead
  // (see GroundLine's own header comment) — the hinge's own endpoints
  // aren't real ring vertices at all (an authored/exaggerated span).
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

// Removes a vertex wherever the ring folds back on itself — either a
// zero-length edge (two consecutive points coincide) or a 180-degree spike
// (the incoming and outgoing edges are collinear but point in OPPOSITE
// directions, i.e. cross ~ 0 and dot < 0). Runs to a fixed point: erasing
// one such vertex can newly expose another right behind it (see
// SplitPartAtBend's own comment on why this matters — this is the ONE
// place a corner-biased cut ever gets cleaned up, not a per-case special
// rule). A polygon with no such fold is returned unchanged.
std::vector<Point2> Simplify(std::vector<Point2> ring) {
  bool changed = true;
  while (changed && ring.size() >= 3) {
    changed = false;
    size_t n = ring.size();
    for (size_t i = 0; i < n; ++i) {
      size_t prev = (i + n - 1) % n;
      size_t next = (i + 1) % n;
      if (NearlyEqual2(ring[i], ring[prev])) {
        ring.erase(ring.begin() + static_cast<long>(i));
        changed = true;
        break;
      }
      Point2 inDir = Sub2(ring[i], ring[prev]);
      Point2 outDir = Sub2(ring[next], ring[i]);
      double inLen = Length2(inDir);
      double outLen = Length2(outDir);
      if (inLen < kGeometricEpsilon || outLen < kGeometricEpsilon) continue;
      double sinAngle = Cross2(inDir, outDir) / (inLen * outLen);
      double dotSign = Dot2(inDir, outDir);
      if (std::fabs(sinAngle) < 1e-6 && dotSign < 0.0) {
        ring.erase(ring.begin() + static_cast<long>(i));
        changed = true;
        break;
      }
    }
  }
  return ring;
}

double ShoelaceArea(const std::vector<Point2>& poly) {
  double sum = 0.0;
  const size_t n = poly.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = poly[i];
    const Point2& b = poly[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2.0;
}

// Resolves a self-crossing between two NON-adjacent edges — a genuinely
// different fold than Simplify's own (that one collapses a spike at ONE
// shared vertex; this one splits the ring where two edges that don't
// share a vertex at all cross each other). This is what two SEPARATE
// bends splitting off in sequence can leave behind even when EACH one's
// own cap and cut-line were entirely local and valid on their own: the
// second split's own bend line spans its own hinge's own full length,
// with no way to know a FIRST, already-departed bend's own notch wall now
// sits somewhere in the middle of that span (see SplitPartAtBend's own
// comment). Splitting the ring at the crossing point produces exactly two
// loops; the one whose own signed area still matches the ring's original
// orientation is the real remaining material — the other is the sliver
// two independently-correct local edits happened to carve out of each
// other. Runs to a fixed point, same discipline as Simplify, since
// resolving one crossing can expose another.
std::vector<Point2> ResolveCrossings(std::vector<Point2> ring) {
  bool changed = true;
  while (changed && ring.size() >= 4) {
    changed = false;
    const size_t n = ring.size();
    const double expectedSign = ShoelaceArea(ring) >= 0.0 ? 1.0 : -1.0;
    for (size_t i = 0; i < n && !changed; ++i) {
      size_t i2 = (i + 1) % n;
      for (size_t j = i + 2; j < n; ++j) {
        size_t j2 = (j + 1) % n;
        if (j2 == i) continue;  // adjacent via wraparound — shares vertex i, not a crossing case
        Point2 d1 = Sub2(ring[i2], ring[i]);
        Point2 d2 = Sub2(ring[j2], ring[j]);
        double denom = Cross2(d1, d2);
        if (std::fabs(denom) < kGeometricEpsilon) continue;  // parallel — no crossing
        double t = Cross2(Sub2(ring[j], ring[i]), d2) / denom;
        double u = Cross2(Sub2(ring[j], ring[i]), d1) / denom;
        // Strictly interior to BOTH segments — a shared endpoint isn't a
        // crossing (Simplify's own job if it's degenerate).
        if (t <= kGeometricEpsilon || t >= 1.0 - kGeometricEpsilon) continue;
        if (u <= kGeometricEpsilon || u >= 1.0 - kGeometricEpsilon) continue;
        Point2 p = {ring[i].x + d1.x * t, ring[i].y + d1.y * t};

        std::vector<Point2> loop1{p};
        for (size_t k = i2;; k = (k + 1) % n) {
          loop1.push_back(ring[k]);
          if (k == j) break;
        }
        std::vector<Point2> loop2{p};
        for (size_t k = j2;; k = (k + 1) % n) {
          loop2.push_back(ring[k]);
          if (k == i) break;
        }

        bool loop1Matches = loop1.size() >= 3 && (ShoelaceArea(loop1) >= 0.0 ? 1.0 : -1.0) == expectedSign;
        bool loop2Matches = loop2.size() >= 3 && (ShoelaceArea(loop2) >= 0.0 ? 1.0 : -1.0) == expectedSign;
        if (loop1Matches && !loop2Matches) {
          ring = std::move(loop1);
        } else if (loop2Matches && !loop1Matches) {
          ring = std::move(loop2);
        } else {
          // Ambiguous (both or neither match) — leave as-is; the caller's
          // own winding/degeneracy check reports this typed rather than
          // guessing which half is real.
          return ring;
        }
        changed = true;
        break;
      }
    }
  }
  return ring;
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

  const std::vector<Point2>& hingeRing = groundedHinge->ring;
  const size_t n = hingeRing.size();
  auto findVertex = [&](const Point2& p) -> std::optional<size_t> {
    for (size_t i = 0; i < n; ++i) {
      if (NearlyEqual2(hingeRing[i], p)) return i;
    }
    return std::nullopt;
  };
  auto iA = findVertex(groundedHinge->crossA);
  auto iB = findVertex(groundedHinge->crossB);
  if (!iA || !iB || *iA == *iB) {
    result.errorCode = SplitErrorCode::kDegenerateResult;
    result.message = "hinge cut points could not be located as distinct ring vertices";
    return result;
  }

  // Raw split at the hinge's own two grounded points — no allowance band
  // yet. chainAB runs crossA -> ... -> crossB; chainBA runs the other way.
  std::vector<Point2> chainAB;
  for (size_t i = *iA;; i = (i + 1) % n) {
    chainAB.push_back(hingeRing[i]);
    if (i == *iB) break;
  }
  std::vector<Point2> chainBA;
  for (size_t i = *iB;; i = (i + 1) % n) {
    chainBA.push_back(hingeRing[i]);
    if (i == *iA) break;
  }
  if (chainAB.size() < 3 || chainBA.size() < 3) {
    result.errorCode = SplitErrorCode::kDegenerateResult;
    result.message = "split would produce a ring with fewer than 3 vertices";
    return result;
  }

  // Left-hand normal of hingeA->hingeB, pointing toward the child side — same
  // convention as manufacturing_graph_evaluator.cc's BuildBendCuts.
  Point2 dir = Sub2(groundedHinge->crossB, groundedHinge->crossA);
  double len = Length2(dir);
  Point2 nLeft{0.0, 0.0};
  if (len >= kGeometricEpsilon) nLeft = {-dir.y / len, dir.x / len};

  // Classify chainAB by which side of the raw hinge its own (non-endpoint)
  // material sits on. Always local — doesn't depend on the corner shift, so
  // it can't be fooled by a concave/branching outline the way a cut-line
  // half-plane test could.
  Point2 sample = chainAB[1];
  double side = Dot2(Sub2(sample, groundedHinge->crossA), nLeft);
  bool chainABIsChild = side > 0.0;

  // manufacturing_graph_evaluator.cc's BuildBendCuts uses this exact SIGNED
  // value (NOT ComputeBendGeometry's kFactor-inclusive setbackMm — see that
  // file's own comment on why these are two different, both-real
  // quantities) to independently clip each region panel to its own role's
  // shift (child panels always at childShift, parent panels always at
  // parentShift) — sb's sign there just encodes which literal formula-side
  // a given fold direction puts each shift on, and Evaluate() never has to
  // choose between them since the real curved bend material still exists
  // between the two flat panels. SplitPartAtBend has no such luxury: once
  // the bend is gone, ONE side must absorb that whole curved zone, and
  // `keepCornerOn` is the caller's CHOICE of which — a choice about
  // fabrication intent, unrelated to fold direction. Only the MAGNITUDE
  // (the true physical tangent-line offset; kFactor never enters it) is
  // shared with BuildBendCuts here; the direction is fixed by keepCornerOn
  // alone, via nLeft (which always points toward child, independent of
  // sb's sign) — so kParent always means "parent grows to keep the corner,
  // child is cut back" and vice versa, regardless of which literal fold
  // direction this bend happens to be.
  bool concave = BottomIsConcave(bend);
  double signedD = concave ? bend.radiusMm : -bend.radiusMm;
  double sb = std::fabs(signedD * std::tan(DegToRad(bend.angleDeg) / 2.0));

  Point2 shift = keepCornerOn == CornerSide::kChild ? Point2{-sb * nLeft.x, -sb * nLeft.y}
                                                     : Point2{sb * nLeft.x, sb * nLeft.y};
  bool trimChild = keepCornerOn == CornerSide::kParent;

  std::vector<Point2>& childChain = chainABIsChild ? chainAB : chainBA;
  std::vector<Point2>& parentChain = chainABIsChild ? chainBA : chainAB;
  std::vector<Point2>& trimmed = trimChild ? childChain : parentChain;
  std::vector<Point2>& grown = trimChild ? parentChain : childChain;

  Point2 cutA = {groundedHinge->crossA.x + shift.x, groundedHinge->crossA.y + shift.y};
  Point2 cutB = {groundedHinge->crossB.x + shift.x, groundedHinge->crossB.y + shift.y};
  // Which offset point sits next to which raw endpoint is fixed purely by
  // which hinge endpoint that raw point IS — crossA's own cap is always
  // cutA, crossB's is always cutB, on EITHER chain, EITHER role. No search.
  auto cutNear = [&](const Point2& p) -> Point2 {
    return NearlyEqual2(p, groundedHinge->crossA) ? cutA : cutB;
  };

  double trimmedSignBefore = ShoelaceArea(trimmed) >= 0.0 ? 1.0 : -1.0;

  std::vector<Point2> trimmedOut = trimmed;
  std::vector<Point2> grownOut = grown;

  // sb == 0 (radius 0, or a real-but-currently-unmeasured bend) means the
  // offset line IS the hinge line — nothing to place, both sides already
  // meet exactly at crossA/crossB. Leave both untouched (Simplify below
  // would be a no-op here anyway, since front()/back() already equal their
  // own cutNear).
  if (Length2(shift) >= kVertexMatchEpsilonMm) {
    // ONE construction for both sides, no branch on local edge shape:
    // insert each endpoint's own cap point right next to it — front's own
    // cap before front, back's own cap after back — leaving the endpoint
    // itself untouched. When the cap lands squarely on this endpoint's own
    // adjacent edge (the ordinary case — that edge runs perpendicular to
    // the hinge, ordinary sheet-metal geometry), the insertion creates a
    // 180-degree spike there that Simplify collapses right back down to a
    // plain in-place replacement — the exact same point CrossSegment used
    // to find by search, reached here without ever searching. When the
    // cap instead lands beside a corner shared with ANOTHER live bend
    // (that edge runs parallel to the hinge, continuing straight through
    // this corner instead), nothing collapses: the insertion IS the
    // answer, a small local notch or bump, still never touching anything
    // beyond this one corner.
    Point2 cutNearFront = cutNear(trimmed.front());
    Point2 cutNearBack = cutNear(trimmed.back());

    trimmedOut.insert(trimmedOut.begin(), cutNearFront);
    trimmedOut.push_back(cutNearBack);
    trimmedOut = Simplify(trimmedOut);
    // A sibling bend split off earlier can have left its OWN notch wall
    // sitting somewhere in the middle of trimmed's own material — this
    // cut's own bend line, spanning its own full hinge length with no
    // knowledge of that, can cross it (see ResolveCrossings' own comment).
    trimmedOut = ResolveCrossings(trimmedOut);

    // Grown side: the SAME two points bound the band it gains — splice
    // them onto its matching ends (grown.front() == trimmed.back() and
    // vice versa, since the two raw chains share endpoints in swapped
    // order). Same construction, same cleanup — one path, not a mirrored
    // second copy of it.
    grownOut.insert(grownOut.begin(), cutNearBack);
    grownOut.push_back(cutNearFront);
    grownOut = Simplify(grownOut);
    grownOut = ResolveCrossings(grownOut);
  }

  // Validity falls out of the result itself rather than a separate
  // upfront gate: a cap that lands well past where this side's own
  // material actually reaches (the setback wider than the flush side —
  // see the "corner bias wider than material" test) simplifies away
  // FURTHER real vertices than it should, flipping the trimmed side's own
  // winding relative to what it started as. That flip — not a bounds
  // check on any one edge — is the general, single signal that this cut
  // isn't locally representable on this side.
  bool trimmedSignFlipped = trimmedOut.size() >= 3 &&
                             (ShoelaceArea(trimmedOut) >= 0.0 ? 1.0 : -1.0) != trimmedSignBefore;
  if (trimmedOut.size() < 3 || grownOut.size() < 3 || trimmedSignFlipped) {
    result.errorCode = SplitErrorCode::kCornerZoneNotGrounded;
    result.message =
        "the corner-biased cut is not locally representable on the flush side — its own material "
        "is narrower than the setback";
    return result;
  }

  std::vector<Point2>& childOut = trimChild ? trimmedOut : grownOut;
  std::vector<Point2>& parentOut = trimChild ? grownOut : trimmedOut;

  result.ok = true;
  result.childOutline = childOut;
  result.parentOutline = parentOut;
  return result;
}

}  // namespace mcp_cad::translation
