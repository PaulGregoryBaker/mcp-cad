#include "geometry/translation/step_reconciliation.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <unordered_map>

namespace mcp_cad::translation {

namespace {

// Confirmed empirically (real STEP fixture investigation, not a guess): a
// sharp (zero-radius) folded corner's inner/outer surfaces genuinely differ
// in measured footprint by up to a couple mm — present in the ORIGINAL,
// unsplit solid itself (the outer/convex surface spans a slightly larger
// area than the inner/concave one, the same physical fact behind
// manufacturing_graph_evaluator.hpp's own "bottom-surface radius is never
// exactly zero for a valley fold"). This is real geometry, not measurement
// noise to chase out of getPanelFrame/splitBodyByBends — matches the
// already-established MERGE_EDGE_ALIGNMENT_TOLERANCE_MM precedent
// (part_merge.hpp, ~2mm, rebuild/17-numerical-policy.md OPEN-17.1) for
// exactly this "how close is close enough to call two edges the same seam"
// question, reused here rather than inventing a separate number.
constexpr double kPieceEdgeMatchToleranceMm = 2.0;
constexpr double kSelfConsistencyToleranceMm = 2.0;
// Ring vertices closer together than this are collapsed before
// reconciliation (see SimplifyRing) — the same sharp-corner discrepancy
// above shows up WITHIN a single panel's own ring as a spurious short edge
// (confirmed: exactly a ~1.5mm step at a fold corner), not just between two
// panels' matched edges.
constexpr double kRingSimplifyToleranceMm = 2.0;
constexpr double kPi = 3.14159265358979323846;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Length2(const Point2& v) { return std::hypot(v.x, v.y); }

Point3 Sub3(const Point3& a, const Point3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double Dot3(const Point3& a, const Point3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Point3 Cross3(const Point3& a, const Point3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
double Length3(const Point3& v) { return std::sqrt(Dot3(v, v)); }
Point3 Normalize3(const Point3& v) {
  double len = Length3(v);
  if (len < 1e-12) return {0, 0, 0};
  return {v.x / len, v.y / len, v.z / len};
}

bool NearlyEqual3(const Point3& a, const Point3& b, double eps) {
  return Length3(Sub3(a, b)) <= eps;
}

double PolygonArea2(const std::vector<Point2>& ring) {
  double sum = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return std::fabs(sum) / 2.0;
}

// Collapses consecutive ring vertices closer together than toleranceMm into
// one — confirmed empirically (real STEP fixture): a sharp folded corner's
// genuinely-slightly-different inner/outer footprint shows up as a spurious
// short edge (a couple mm) within a single panel's own measured ring, not
// just as a mismatch between two panels' matched edges. Never simplifies
// below a triangle (3 vertices) — if that would happen, the ORIGINAL ring
// is returned unchanged rather than degenerating the polygon.
std::vector<Point2> SimplifyRing(const std::vector<Point2>& ring, double toleranceMm) {
  if (ring.size() <= 3) return ring;
  std::vector<Point2> out;
  out.reserve(ring.size());
  for (const auto& p : ring) {
    if (!out.empty() && Length2(Sub2(p, out.back())) < toleranceMm) continue;
    out.push_back(p);
  }
  if (out.size() > 3 && Length2(Sub2(out.front(), out.back())) < toleranceMm) {
    out.pop_back();
  }
  if (out.size() < 3) return ring;
  return out;
}

// Builds the rigid transform R=[uAxis vAxis normal | origin] (D4/13 §3.1's
// own convention: columns are the axes) — Transform3's row-major layout
// means Apply({1,0,0})=uAxis, Apply({0,1,0})=vAxis, Apply({0,0,1})=normal.
Transform3 BuildPieceFrame(const PanelPieceSpec& piece) {
  Transform3 t;
  t.r[0] = piece.uAxis.x; t.r[1] = piece.vAxis.x; t.r[2] = piece.normal.x;
  t.r[3] = piece.uAxis.y; t.r[4] = piece.vAxis.y; t.r[5] = piece.normal.y;
  t.r[6] = piece.uAxis.z; t.r[7] = piece.vAxis.z; t.r[8] = piece.normal.z;
  t.t[0] = piece.origin.x; t.t[1] = piece.origin.y; t.t[2] = piece.origin.z;
  return t;
}

// A rigid 2D transform: p -> R(p - pivot) + offset, R a pure rotation — same
// shape as part_merge.cc's own Rigid2 (duplicated locally, not shared,
// matching this codebase's established "no shared 2D-geometry header"
// convention across every translation-module file).
struct Rigid2 {
  double cosT = 1.0, sinT = 0.0;
  Point2 pivot, offset;
  Point2 Apply(const Point2& p) const {
    Point2 v = Sub2(p, pivot);
    return {cosT * v.x - sinT * v.y + offset.x, sinT * v.x + cosT * v.y + offset.y};
  }
};

// The exact same alignment rule part_merge.hpp::ReconcileOutlines uses:
// T(childP0) = parentP1, T(childP1) = parentP0 (reversed correspondence —
// the one rule that makes two CCW rings share a boundary edge validly).
Rigid2 BuildAlignment(const Point2& parentP0, const Point2& parentP1, const Point2& childP0,
                       const Point2& childP1) {
  Point2 dParent = Sub2(parentP1, parentP0);
  Point2 dChild = Sub2(childP1, childP0);
  double thetaChild = std::atan2(dChild.y, dChild.x);
  double thetaTarget = std::atan2(-dParent.y, -dParent.x);
  double rot = thetaTarget - thetaChild;
  Rigid2 xform;
  xform.cosT = std::cos(rot);
  xform.sinT = std::sin(rot);
  xform.pivot = childP0;
  xform.offset = parentP1;
  return xform;
}

// General "no two non-adjacent edges of this simple closed polygon
// intersect" check — simpler than part_merge's own guard, which needed an
// "allowed touch points" allowlist for a single pairwise splice; here any
// two edges sharing a common vertex are automatically index-adjacent (a
// purely combinatorial condition over the FINAL traced polygon), so no
// allowlist is needed.
double Orient2(const Point2& a, const Point2& b, const Point2& c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
bool OnSegmentInclusive2(const Point2& a, const Point2& b, const Point2& p, double eps) {
  double minX = std::min(a.x, b.x) - eps, maxX = std::max(a.x, b.x) + eps;
  double minY = std::min(a.y, b.y) - eps, maxY = std::max(a.y, b.y) + eps;
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}
bool SegmentsIntersectAny(const Point2& p1, const Point2& p2, const Point2& p3, const Point2& p4) {
  constexpr double kEps = 1e-9;
  double d1 = Orient2(p1, p2, p3), d2 = Orient2(p1, p2, p4);
  double d3 = Orient2(p3, p4, p1), d4 = Orient2(p3, p4, p2);
  if (((d1 > 0) != (d2 > 0)) && d1 != 0 && d2 != 0 && ((d3 > 0) != (d4 > 0)) && d3 != 0 && d4 != 0) {
    return true;
  }
  if (std::fabs(d1) < kEps && OnSegmentInclusive2(p1, p2, p3, kEps)) return true;
  if (std::fabs(d2) < kEps && OnSegmentInclusive2(p1, p2, p4, kEps)) return true;
  if (std::fabs(d3) < kEps && OnSegmentInclusive2(p3, p4, p1, kEps)) return true;
  if (std::fabs(d4) < kEps && OnSegmentInclusive2(p3, p4, p2, kEps)) return true;
  return false;
}

bool HasSelfIntersection(const std::vector<Point2>& ring) {
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    for (size_t j = i + 1; j < n; ++j) {
      bool adjacent = (j == i + 1) || (i == 0 && j == n - 1);
      if (adjacent) continue;
      if (SegmentsIntersectAny(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

}  // namespace

ReconcilePiecesResult ReconcilePieces(const std::vector<PanelPieceSpec>& pieces,
                                       double thicknessMm,
                                       double defaultBendRadiusMm) {
  ReconcilePiecesResult result;
  const size_t n = pieces.size();
  if (n < 1) {
    result.errorCode = ReconcileErrorCode::kTooFewPieces;
    result.message = "at least 1 panel piece is required";
    return result;
  }

  // 0. Simplify every piece's own ring first — collapses the spurious short
  // edges a sharp folded corner's genuine inner/outer footprint difference
  // introduces (see SimplifyRing's own doc comment) before ANY downstream
  // step (root selection, edge matching, splicing) can be thrown off by
  // them. A local copy — the caller's own PanelPieceSpec data is untouched.
  std::vector<PanelPieceSpec> simplifiedPieces = pieces;
  for (auto& piece : simplifiedPieces) {
    piece.ringLocal = SimplifyRing(piece.ringLocal, kRingSimplifyToleranceMm);
  }

  // 1. Pick root: largest local-frame area, arbitrary but deterministic.
  size_t rootIndex = 0;
  double bestArea = -1.0;
  for (size_t i = 0; i < n; ++i) {
    double area = PolygonArea2(simplifiedPieces[i].ringLocal);
    if (area > bestArea) {
      bestArea = area;
      rootIndex = i;
    }
  }

  Transform3 rootFrame = BuildPieceFrame(simplifiedPieces[rootIndex]);
  Transform3 rootFrameInv = rootFrame.Inverse();

  // 2. Every piece's TRUE position expressed in root-local space (root's own
  // flat frame treated as the literal z=0 plane) — a one-time relabeling,
  // not a re-derivation: pieceInRootLocal = rootFrameInv.Compose(pieceFrame).
  std::vector<std::vector<Point3>> trueRootLocalRing(n);
  for (size_t i = 0; i < n; ++i) {
    Transform3 pieceFrame = BuildPieceFrame(simplifiedPieces[i]);
    Transform3 toRootLocal = rootFrameInv.Compose(pieceFrame);
    trueRootLocalRing[i].reserve(simplifiedPieces[i].ringLocal.size());
    for (const auto& v : simplifiedPieces[i].ringLocal) {
      trueRootLocalRing[i].push_back(toRootLocal.Apply({v.x, v.y, 0.0}));
    }
  }

  // 3. Find every pairwise shared edge (reversed-correspondence match, real
  // CCW panels meeting at a real fold always traverse their shared edge in
  // opposite order — same fact part_merge.hpp relies on).
  struct AdjacencyEdge {
    size_t pieceA, edgeA, pieceB, edgeB;
  };
  std::vector<AdjacencyEdge> edges;
  for (size_t i = 0; i < n; ++i) {
    size_t ni = simplifiedPieces[i].ringLocal.size();
    for (size_t j = i + 1; j < n; ++j) {
      size_t nj = simplifiedPieces[j].ringLocal.size();
      for (size_t ea = 0; ea < ni; ++ea) {
        const Point3& a0 = trueRootLocalRing[i][ea];
        const Point3& a1 = trueRootLocalRing[i][(ea + 1) % ni];
        for (size_t eb = 0; eb < nj; ++eb) {
          const Point3& b0 = trueRootLocalRing[j][eb];
          const Point3& b1 = trueRootLocalRing[j][(eb + 1) % nj];
          // Reversed correspondence: a0~b1 and a1~b0.
          if (NearlyEqual3(a0, b1, kPieceEdgeMatchToleranceMm) &&
              NearlyEqual3(a1, b0, kPieceEdgeMatchToleranceMm)) {
            edges.push_back({i, ea, j, eb});
          }
        }
      }
    }
  }

  // 4. Spanning tree via BFS from root; extra edges are non-fatal notes
  // (real physical seams, 14 §2, not auto-detected/driven this slice).
  std::vector<bool> visited(n, false);
  std::vector<int> parentOf(n, -1);
  std::vector<int> edgeInParent(n, -1);  // parent's own ring-edge-index
  std::vector<int> edgeInChild(n, -1);   // this piece's own ring-edge-index
  std::vector<size_t> bfsOrder;
  std::unordered_map<size_t, std::vector<size_t>> adjList;  // pieceIndex -> indices into `edges`
  for (size_t e = 0; e < edges.size(); ++e) {
    adjList[edges[e].pieceA].push_back(e);
    adjList[edges[e].pieceB].push_back(e);
  }

  // Tracks which `edges` entries were consumed as tree edges — needed to
  // avoid a false-positive "extra adjacency" note: a single physical edge
  // between piece p and its child c is naturally visited TWICE during BFS
  // (once from each endpoint's own adjacency list), and only the first
  // encounter is a genuine tree edge — the second is the SAME edge seen
  // from the other side, not a distinct extra adjacency.
  std::vector<bool> usedAsTreeEdge(edges.size(), false);

  visited[rootIndex] = true;
  bfsOrder.push_back(rootIndex);
  std::vector<size_t> queue = {rootIndex};
  for (size_t qi = 0; qi < queue.size(); ++qi) {
    size_t cur = queue[qi];
    for (size_t eIdx : adjList[cur]) {
      const AdjacencyEdge& ae = edges[eIdx];
      size_t other = (ae.pieceA == cur) ? ae.pieceB : ae.pieceA;
      if (visited[other]) {
        if (other != cur && !usedAsTreeEdge[eIdx]) {
          result.notes.push_back("extra (non-tree) adjacency between piece " +
                                  std::to_string(std::min(cur, other)) + " and piece " +
                                  std::to_string(std::max(cur, other)) +
                                  " — not used for placement (checked-not-driven seam candidate)");
        }
        continue;
      }
      usedAsTreeEdge[eIdx] = true;
      visited[other] = true;
      parentOf[other] = static_cast<int>(cur);
      if (ae.pieceA == cur) {
        edgeInParent[other] = static_cast<int>(ae.edgeA);
        edgeInChild[other] = static_cast<int>(ae.edgeB);
      } else {
        edgeInParent[other] = static_cast<int>(ae.edgeB);
        edgeInChild[other] = static_cast<int>(ae.edgeA);
      }
      bfsOrder.push_back(other);
      queue.push_back(other);
    }
  }

  for (size_t i = 0; i < n; ++i) {
    if (!visited[i]) {
      result.notes.push_back(
          "piece " + std::to_string(i) + " shares no measured edge with the "
          "root component (piece " + std::to_string(rootIndex) +
          ") — returned as a separate, standalone part");
    }
  }

  // If the initial root is in a small component and a larger connected
  // component exists among the unvisited pieces, swap: the largest
  // component becomes the main graph, and the old root's component
  // becomes a set of disconnected solo graphs.
  {
    size_t visitedCount = 0;
    for (size_t i = 0; i < n; ++i) if (visited[i]) ++visitedCount;

    // Find connected components among unvisited pieces via BFS.
    std::vector<bool> unvisitedSeen(n, false);
    std::vector<std::vector<size_t>> unvisitedComponents;
    for (size_t start = 0; start < n; ++start) {
      if (visited[start] || unvisitedSeen[start]) continue;
      std::vector<size_t> comp;
      std::vector<size_t> q = {start};
      unvisitedSeen[start] = true;
      for (size_t qi = 0; qi < q.size(); ++qi) {
        size_t cur = q[qi];
        comp.push_back(cur);
        auto it = adjList.find(cur);
        if (it == adjList.end()) continue;
        for (size_t eIdx : it->second) {
          size_t other = (edges[eIdx].pieceA == cur) ? edges[eIdx].pieceB : edges[eIdx].pieceA;
          if (!visited[other] && !unvisitedSeen[other]) {
            unvisitedSeen[other] = true;
            q.push_back(other);
          }
        }
      }
      unvisitedComponents.push_back(std::move(comp));
    }

    // If any unvisited component is larger than the visited component,
    // swap: the largest becomes the new main graph.
    size_t largestCompIdx = SIZE_MAX;
    size_t largestCompSize = visitedCount;
    for (size_t ci = 0; ci < unvisitedComponents.size(); ++ci) {
      if (unvisitedComponents[ci].size() > largestCompSize) {
        largestCompSize = unvisitedComponents[ci].size();
        largestCompIdx = ci;
      }
    }

    if (largestCompIdx != SIZE_MAX) {
      // Mark old visited as disconnected, clear old graph state.
      result.notes.push_back(
          "switching main component from piece " + std::to_string(rootIndex) +
          " (size " + std::to_string(visitedCount) + ") to component of size " +
          std::to_string(largestCompSize));
      for (size_t i = 0; i < n; ++i) visited[i] = false;

      // New root: piece with most edges in the largest unvisited component.
      rootIndex = unvisitedComponents[largestCompIdx][0];
      size_t bestEdgeCount = 0;
      for (size_t ci : unvisitedComponents[largestCompIdx]) {
        auto it = adjList.find(ci);
        size_t ec = (it != adjList.end()) ? it->second.size() : 0;
        if (ec > bestEdgeCount) { bestEdgeCount = ec; rootIndex = ci; }
      }
      rootFrame = BuildPieceFrame(simplifiedPieces[rootIndex]);
      rootFrameInv = rootFrame.Inverse();

      // Re-relabel true positions into new root-local space.
      for (size_t i = 0; i < n; ++i) {
        Transform3 pieceFrame = BuildPieceFrame(simplifiedPieces[i]);
        Transform3 inRootLocal = rootFrameInv.Compose(pieceFrame);
        for (size_t k = 0; k < simplifiedPieces[i].ringLocal.size(); ++k) {
          Point3 local{simplifiedPieces[i].ringLocal[k].x,
                       simplifiedPieces[i].ringLocal[k].y, 0.0};
          trueRootLocalRing[i][k] = inRootLocal.Apply(local);
        }
      }

      // Redo BFS from new root.
      visited[rootIndex] = true;
      bfsOrder.clear();
      bfsOrder.push_back(rootIndex);
      queue.clear();
      queue.push_back(rootIndex);
      for (size_t qi = 0; qi < queue.size(); ++qi) {
        size_t cur = queue[qi];
        for (size_t eIdx : adjList[cur]) {
          const AdjacencyEdge& ae = edges[eIdx];
          size_t other = (ae.pieceA == cur) ? ae.pieceB : ae.pieceA;
          if (visited[other]) {
            if (other != cur && !usedAsTreeEdge[eIdx]) {
              result.notes.push_back("extra (non-tree) adjacency between piece " +
                                     std::to_string(std::min(cur, other)) + " and piece " +
                                     std::to_string(std::max(cur, other)) +
                                     " — not used for placement (checked-not-driven seam candidate)");
            }
            continue;
          }
          usedAsTreeEdge[eIdx] = true;
          visited[other] = true;
          parentOf[other] = static_cast<int>(cur);
          if (ae.pieceA == cur) {
            edgeInParent[other] = static_cast<int>(ae.edgeA);
            edgeInChild[other] = static_cast<int>(ae.edgeB);
          } else {
            edgeInParent[other] = static_cast<int>(ae.edgeB);
            edgeInChild[other] = static_cast<int>(ae.edgeA);
          }
          bfsOrder.push_back(other);
          queue.push_back(other);
        }
      }
    }
  }

  // Emit solo graphs for all unvisited pieces.
  for (size_t i = 0; i < n; ++i) {
    if (!visited[i]) {
      PartGraphSpec soloGraph;
      soloGraph.partId = "reconciled";
      soloGraph.rootRegionPanelId = "piece" + std::to_string(i);
      soloGraph.thicknessMm = thicknessMm;
      soloGraph.anchor.transform = BuildPieceFrame(simplifiedPieces[i]);
      soloGraph.outline.outer = simplifiedPieces[i].ringLocal;
      result.graphs.push_back(std::move(soloGraph));
    }
  }

  // 5. For each non-root piece (BFS order = parent-before-child, guaranteed):
  // align it into root-local flat space, derive its bend's signed angleDeg
  // from the TRUE measured position (never a hand-derived trig formula —
  // see this file's header comment), and record the tree structure needed
  // for the final recursive boundary trace.
  std::vector<std::vector<Point2>> flattenedRing(n);
  flattenedRing[rootIndex] = simplifiedPieces[rootIndex].ringLocal;
  std::vector<std::unordered_map<int, int>> childAtParentEdge(n);
  std::vector<int> childSharedEdgeIndex(n, -1);

  // accumulatedPose[i]: the chain of folds from the root down to piece i,
  // composed (13 §4.1's own chain formula) — root's is identity since
  // everything here is already relabeled into root-local space. A flat-
  // pattern point on piece i's own ring becomes its TRUE (root-local) 3D
  // position via accumulatedPose[i].Apply({flat.x, flat.y, 0}). Needed to
  // derive/verify each bend's angle correctly at depth >= 2: the hinge axis
  // and a piece's sample point must be compared in the SAME frame (the
  // piece's parent's own already-accumulated fold), never the flat pattern
  // frame directly — embedding the flat hinge/sample raw as z=0 in root-
  // local space is only valid for a piece whose PARENT is the root itself
  // (where accumulatedPose[parent] is identity, silently masking this exact
  // bug for depth-1 children — caught here by a real depth-2 test case).
  std::vector<Transform3> accumulatedPose(n);
  accumulatedPose[rootIndex] = Transform3::Identity();

  PartGraphSpec graph;
  graph.partId = "reconciled";
  graph.rootRegionPanelId = "piece" + std::to_string(rootIndex);
  graph.thicknessMm = thicknessMm;
  graph.anchor.transform = rootFrame;

  for (size_t idx = 1; idx < bfsOrder.size(); ++idx) {
    size_t i = bfsOrder[idx];
    size_t p = static_cast<size_t>(parentOf[i]);
    int pEdgeIdx = edgeInParent[i];
    int cEdgeIdx = edgeInChild[i];
    const auto& pRing = flattenedRing[p];
    size_t np = pRing.size();
    Point2 pEdgeP0 = pRing[static_cast<size_t>(pEdgeIdx)];
    Point2 pEdgeP1 = pRing[(static_cast<size_t>(pEdgeIdx) + 1) % np];

    const auto& cRingLocal = simplifiedPieces[i].ringLocal;
    size_t nc = cRingLocal.size();
    Point2 cEdgeP0 = cRingLocal[static_cast<size_t>(cEdgeIdx)];
    Point2 cEdgeP1 = cRingLocal[(static_cast<size_t>(cEdgeIdx) + 1) % nc];

    double lenP = Length2(Sub2(pEdgeP1, pEdgeP0));
    double lenC = Length2(Sub2(cEdgeP1, cEdgeP0));
    if (std::fabs(lenP - lenC) > kPieceEdgeMatchToleranceMm) {
      result.errorCode = ReconcileErrorCode::kNonDevelopableFold;
      result.message = "matched edge lengths disagree at piece " + std::to_string(i);
      return result;
    }

    Rigid2 xform = BuildAlignment(pEdgeP0, pEdgeP1, cEdgeP0, cEdgeP1);
    std::vector<Point2>& cFlat = flattenedRing[i];
    cFlat.resize(nc);
    for (size_t k = 0; k < nc; ++k) cFlat[k] = xform.Apply(cRingLocal[k]);

    // hingeA/hingeB reversed from the literal parent-edge order — same rule
    // part_merge.hpp discovered: BoundingBends' fixed "child = left of
    // hingeA->hingeB" convention requires this to keep the parent's own
    // material on the parent side.
    Point2 hingeALocal = pEdgeP1;
    Point2 hingeBLocal = pEdgeP0;

    // The hinge axis must be compared in a SHARED frame — piece p's own
    // accumulated fold, i.e. "true 3D position if only bends up to and
    // including p had been applied" — never the flat pattern frame directly
    // (see accumulatedPose's own doc comment above).
    const Transform3& parentPose = accumulatedPose[p];

    // The hinge axis DIRECTION (as opposed to its pivot-height POSITION,
    // searched below) doesn't depend on pivotZ at all: hingeA3/hingeB3 both
    // get the SAME z offset, which cancels in their difference. Computed
    // once, reused for both the angle derivation and every pivotZ candidate.
    Point3 hingeA3Flat{hingeALocal.x, hingeALocal.y, 0.0};
    Point3 hingeB3Flat{hingeBLocal.x, hingeBLocal.y, 0.0};
    Point3 axisDir = Normalize3(parentPose.ApplyVector(Sub3(hingeB3Flat, hingeA3Flat)));
    if (Length3(axisDir) < 1e-9) {
      result.errorCode = ReconcileErrorCode::kNonDevelopableFold;
      result.message = "bend at piece " + std::to_string(i) + " has a zero-length hinge";
      return result;
    }

    // Derive angleDeg from the two panels' own already-measured face
    // normals (getPanelFrame's whole-face plane fit), not from how far a
    // single ring vertex moved. A lone vertex — especially the one
    // furthest from the hinge, which is exactly what a short leg's own far
    // tip is — converts the couple-mm sharp-corner surface noise this
    // file's own header comment already documents into a proportionally
    // large ANGULAR error (angle ≈ noise / distance-from-hinge): confirmed
    // on unequal_leg_bracket_90deg.stp, where a real STEP file with an
    // exact, axis-aligned 90° design angle (verified directly against the
    // file's own raw face topology) was being measured as -91.878° this
    // way, purely from ~1mm of that documented corner noise landing on the
    // one sampled vertex, 31.5mm from the hinge. A face normal, by
    // contrast, is already a whole-face fit (P3: reuse getPanelFrame's own
    // robust measurement rather than re-deriving orientation from one
    // corner's position) — far less sensitive to any single vertex's own
    // noise, and (a bonus) angle-independent of pivotZ, so it only needs
    // deriving once per bend, not once per pivot candidate below.
    Point3 parentNormalRootLocal = parentPose.ApplyVector({0.0, 0.0, 1.0});
    Point3 childNormalRootLocal = rootFrameInv.ApplyVector(simplifiedPieces[i].normal);
    auto perpVecFromAxis = [&](const Point3& v) -> Point3 {
      double along = Dot3(v, axisDir);
      return {v.x - along * axisDir.x, v.y - along * axisDir.y, v.z - along * axisDir.z};
    };
    Point3 perpParentN = perpVecFromAxis(parentNormalRootLocal);
    Point3 perpChildN = perpVecFromAxis(childNormalRootLocal);
    double magParentN = Length3(perpParentN);
    double magChildN = Length3(perpChildN);
    if (magParentN < 1e-9 || magChildN < 1e-9) {
      result.errorCode = ReconcileErrorCode::kNonDevelopableFold;
      result.message = "fold at piece " + std::to_string(i) +
                        " has a panel normal parallel to its own hinge axis — angle undefined";
      return result;
    }
    double cosAngle = Dot3(perpParentN, perpChildN) / (magParentN * magChildN);
    Point3 crossN = Cross3(perpParentN, perpChildN);
    double sinAngle = Dot3(crossN, axisDir) / (magParentN * magChildN);
    double angleDeg = std::atan2(sinAngle, cosAngle) * 180.0 / kPi;

    // manufacturing_graph_evaluator.cc's own bend physics: the rotation axis
    // sits at the flat hinge's own z=0 when this bend's bottom reference is
    // the CONCAVE side of the fold (touches the pivot exactly at
    // radiusMm=0), or at z=+thicknessMm when bottom is the CONVEX side
    // (never touches, always offset — BottomRadiusMm/pivotZ). Persisted
    // explicitly via bend.bottomIsConcave rather than left for Evaluate()
    // to re-derive from angleDeg's sign: a part's single, part-wide bottom
    // reference is not guaranteed concave at every bend whose natural
    // rotation direction is positive and convex at every negative one —
    // confirmed on a real mitered-corner fixture, where BOTH pieces' TRUE
    // 3D edges only coincide when referenced from their convex/outer face
    // (shifting either to the concave face breaks edge-matching entirely,
    // so outer is the physically required, consistent reference for this
    // part) — and that same fold's own true rotation, verified against
    // every vertex, needs a touching (concave-style) pivot at z=0 even
    // though its natural angle sign comes out negative. The OLD sign-only
    // rule (mountain iff angleDeg>=0) could not represent that combination
    // at all; this measures which pivot actually fits (using the ALREADY-
    // derived angleDeg above, unchanged by pivotZ) and records it directly.
    //
    // hingeA/hingeB order (pEdgeP1, pEdgeP0 — reversed from the literal
    // parent-edge order, see above) is FIXED, never varied here: it also
    // defines BoundingBends' 2D "child = left of hingeA->hingeB"
    // classification (manufacturing_graph_evaluator.cc), which is
    // independent of — and must not be perturbed by — this pivot search.
    struct FoldCandidate {
      bool ok = false;
      Point3 axisOrigin;
      bool bottomIsConcave = true;
    };
    auto tryPivotZ = [&](double pivotZ, bool bottomIsConcave) -> FoldCandidate {
      FoldCandidate cand;
      Point3 hingeA3{hingeALocal.x, hingeALocal.y, pivotZ};
      Point3 axisOrigin = parentPose.Apply(hingeA3);

      Transform3 fold = Transform3::RotationAboutAxis(axisOrigin, axisDir, angleDeg);
      Transform3 candidatePose = fold.Compose(parentPose);
      for (size_t k = 0; k < nc; ++k) {
        Point3 flatK{cFlat[k].x, cFlat[k].y, 0.0};
        Point3 predicted = candidatePose.Apply(flatK);
        if (!NearlyEqual3(predicted, trueRootLocalRing[i][k], kSelfConsistencyToleranceMm)) {
          return cand;
        }
      }
      cand.ok = true;
      cand.axisOrigin = axisOrigin;
      cand.bottomIsConcave = bottomIsConcave;
      return cand;
    };

    // The pivot search is ALWAYS at radiusMm=0 — the true fact reconciled
    // here is a sharp, zero-gap fold (this module's own documented scope,
    // see header comment); a flat-panel decomposition never measures a
    // real bend radius (only two flat faces meeting at a fold are ever
    // seen), so there is nothing else to search over. defaultBendRadiusMm
    // (the org's ManufacturingProfile assumption) is deliberately NOT used
    // here: coupling the search to it would make reconciliation of
    // genuinely-flush measured geometry spuriously fail for any nonzero
    // default (self-consistency below can only ever hold at the TRUE
    // pivot). It is stamped onto bend.radiusMm separately, after Step 7's
    // replay validation confirms this reconciliation's own construction is
    // sound — see that stamping pass's own comment for why decoupling the
    // two is correct, not a masked inconsistency.
    FoldCandidate winner = tryPivotZ(0.0, /*bottomIsConcave=*/true);
    if (!winner.ok) winner = tryPivotZ(thicknessMm, /*bottomIsConcave=*/false);
    if (!winner.ok) {
      result.errorCode = ReconcileErrorCode::kNonDevelopableFold;
      result.message = "fold at piece " + std::to_string(i) +
                        " is not reproducible by a single rigid rotation under either bottom-"
                        "surface pivot — likely a curved/filleted fold, out of this slice's "
                        "scope";
      return result;
    }

    Transform3 fold = Transform3::RotationAboutAxis(winner.axisOrigin, axisDir, angleDeg);
    accumulatedPose[i] = fold.Compose(parentPose);

    BendSpec bend;
    bend.id = "bend" + std::to_string(i);
    bend.parentRegionPanelId = "piece" + std::to_string(p);
    bend.childRegionPanelId = "piece" + std::to_string(i);
    bend.hingeA = hingeALocal;
    bend.hingeB = hingeBLocal;
    bend.angleDeg = angleDeg;
    // 0.0 on BOTH branches — matches the r=0 pivot search above exactly
    // (concave: pivotZ=-0=0; convex: pivotZ=0+thicknessMm=thicknessMm),
    // unlike the old convex-branch value of thicknessMm, which did not
    // round-trip through Evaluate()'s own BottomRadiusMm formula (would
    // recompute rBottom=thicknessMm+thicknessMm, not thicknessMm). Replaced
    // with the profile's assumed defaultBendRadiusMm in a final pass below,
    // once Step 7 has confirmed this (r=0-consistent) reconciliation itself
    // is sound.
    bend.radiusMm = 0.0;
    bend.kFactor = 0.0;
    bend.bottomIsConcave = winner.bottomIsConcave;
    graph.bends.push_back(bend);
    result.pieceEdgeMatches.push_back({pEdgeIdx, cEdgeIdx});

    childAtParentEdge[p][pEdgeIdx] = static_cast<int>(i);
    childSharedEdgeIndex[i] = cEdgeIdx;
  }

  // 6. Recursive boundary trace — see this file's header comment: a
  // generalization of part_merge.hpp's single pairwise splice to the whole
  // tree, substituting each child's own (recursively substituted) boundary
  // in place of its shared edge.
  std::function<void(size_t, int, std::vector<Point2>&)> emitMiddle =
      [&](size_t pieceIndex, int startEdgeIdx, std::vector<Point2>& out) {
        const auto& ring = flattenedRing[pieceIndex];
        int n2 = static_cast<int>(ring.size());
        for (int k = 0; k < n2 - 1; ++k) {
          int edgeIdx = (startEdgeIdx + 1 + k) % n2;
          auto childIt = childAtParentEdge[pieceIndex].find(edgeIdx);
          if (childIt != childAtParentEdge[pieceIndex].end()) {
            emitMiddle(static_cast<size_t>(childIt->second),
                       childSharedEdgeIndex[static_cast<size_t>(childIt->second)], out);
          }
          if (k + 1 < n2 - 1) {
            int farVertex = (edgeIdx + 1) % n2;
            out.push_back(ring[static_cast<size_t>(farVertex)]);
          }
        }
      };

  std::vector<Point2> combined;
  {
    const auto& rootRing = flattenedRing[rootIndex];
    for (int e = 0; e < static_cast<int>(rootRing.size()); ++e) {
      combined.push_back(rootRing[static_cast<size_t>(e)]);
      auto childIt = childAtParentEdge[rootIndex].find(e);
      if (childIt != childAtParentEdge[rootIndex].end()) {
        emitMiddle(static_cast<size_t>(childIt->second),
                   childSharedEdgeIndex[static_cast<size_t>(childIt->second)], combined);
      }
    }
  }

  if (HasSelfIntersection(combined)) {
    result.errorCode = ReconcileErrorCode::kSelfIntersecting;
    result.message = "reconciled outline self-intersects";
    return result;
  }
  graph.outline.outer = std::move(combined);

  // 7. Validate against the REAL downstream consumer, not just this
  // module's own math: replay the graph through Evaluate() (the exact
  // machinery every other v2 tool uses) and confirm every piece's true
  // measured position is reproduced. This is a materially stronger check
  // than the per-fold self-consistency test above — that test can only
  // ever verify internal agreement with this module's OWN rotation
  // formula, so it is blind to an input defect where every individual
  // piece is well-formed on its own but pieces disagree with EACH OTHER
  // about which physical surface they reference. Evaluate()'s bend-
  // direction-dependent pose chain (mountain vs valley bottom-surface
  // radius) exposes exactly that kind of disagreement.
  EvaluateResult layout = Evaluate(graph);
  if (!layout.ok) {
    result.errorCode = ReconcileErrorCode::kDownstreamPoseMismatch;
    result.message = "reconciled graph failed Evaluate(): " + layout.message;
    return result;
  }
  for (size_t i = 0; i < n; ++i) {
    // Disconnected pieces already have their own solo graphs above;
    // only validate the pieces that are actually in this graph.
    if (!visited[i]) continue;

    const RegionPanelLayout* panel = nullptr;
    for (const auto& p : layout.panels) {
      if (p.regionPanelId == "piece" + std::to_string(i)) {
        panel = &p;
        break;
      }
    }
    if (panel == nullptr) {
      result.errorCode = ReconcileErrorCode::kDownstreamPoseMismatch;
      result.message = "Evaluate() produced no region panel for piece " + std::to_string(i);
      return result;
    }
    for (size_t k = 0; k < flattenedRing[i].size(); ++k) {
      Point3 trueWorld = rootFrame.Apply(trueRootLocalRing[i][k]);
      Point3 flatK{flattenedRing[i][k].x, flattenedRing[i][k].y, 0.0};
      Point3 predictedWorld = panel->pose.Apply(flatK);
      if (!NearlyEqual3(predictedWorld, trueWorld, kSelfConsistencyToleranceMm)) {
        result.errorCode = ReconcileErrorCode::kDownstreamPoseMismatch;
        result.message =
            "piece " + std::to_string(i) +
            " vertex " + std::to_string(k) +
            " does not round-trip through Evaluate()'s own pose chain — pieces likely "
            "disagree about which physical surface they reference (e.g. a bottom/top "
            "surface mismatch between panels from the same decomposed part)";
        return result;
      }
    }
  }

  // Stamp the org's assumed bend radius onto every bend NOW, only after the
  // replay above has confirmed this reconciliation's own construction
  // (edge matching, splice, pivot side) is sound at the TRUE r=0 pivot —
  // never before, and never fed back into the search or replay themselves
  // (see the pivot-search comment above for why coupling the two would
  // make reconciliation of genuinely-flush measured geometry spuriously
  // fail for any nonzero default). No radius is directly measurable from a
  // flat-panel decomposition, so this is a deliberate, bounded
  // approximation — like the sharp-corner discrepancies this module
  // already tolerates elsewhere (kPieceEdgeMatchToleranceMm/
  // kSelfConsistencyToleranceMm) — not a masked defect: a caller that
  // later re-Evaluate()s this graph gets a solid built from the ASSUMED
  // radius, consistent with every other v2 Part's own semantics (a bend's
  // radiusMm is always a manufacturing fact/assumption applied on top of a
  // flat pattern, never re-derived from 3D each time).
  for (auto& bend : graph.bends) {
    bend.radiusMm = defaultBendRadiusMm;
  }

  result.ok = true;
  result.graph = std::move(graph);
  // Populate graphs list: root component first, then any disconnected pieces.
  // The solo-graph loop above (step 4) already appended one entry per
  // disconnected piece to result.graphs — insert the root component at the
  // front rather than appending, so result.graphs[0] is always the main
  // component regardless of how many disconnected pieces were found.
  result.graphs.insert(result.graphs.begin(), result.graph);
  return result;
}

}  // namespace mcp_cad::translation
