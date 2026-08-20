#include "manufacturing_graph_evaluator.hpp"
#include "ring_containment.hpp"

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
bool IsInside(const Point2& p, const Point2& lineA, const Point2& lineB, bool keepLeft) {
  double cross = Cross2(Sub2(lineB, lineA), Sub2(p, lineA));
  return keepLeft ? (cross > kGeometricEpsilon) : (cross < -kGeometricEpsilon);
}

Point2 LineIntersect(const Point2& a, const Point2& b, const Point2& lineA, const Point2& lineB) {
  // Intersection of segment (a,b) with the infinite line (lineA,lineB).
  Point2 d1 = Sub2(b, a);
  Point2 d2 = Sub2(lineB, lineA);
  double denom = Cross2(d1, d2);
  if (std::fabs(denom) < kGeometricEpsilon) return a;  // parallel — degenerate, caller handles
  Point2 diff = Sub2(lineA, a);
  double t = Cross2(diff, d2) / denom;
  return {a.x + d1.x * t, a.y + d1.y * t};
}

// Clips `polygon` to the half-plane on the `keepLeft` side of directed line
// lineA->lineB. Standard Sutherland-Hodgman single-clip pass.
std::vector<Point2> ClipHalfPlane(const std::vector<Point2>& polygon, const Point2& lineA,
                                   const Point2& lineB, bool keepLeft) {
  if (polygon.empty()) return polygon;
  std::vector<Point2> out;
  out.reserve(polygon.size() + 1);
  for (size_t i = 0; i < polygon.size(); ++i) {
    const Point2& current = polygon[i];
    const Point2& prev = polygon[(i + polygon.size() - 1) % polygon.size()];
    bool currentIn = IsInside(current, lineA, lineB, keepLeft);
    bool prevIn = IsInside(prev, lineA, lineB, keepLeft);
    if (currentIn) {
      if (!prevIn) {
        out.push_back(LineIntersect(prev, current, lineA, lineB));
      }
      out.push_back(current);
    } else if (prevIn) {
      out.push_back(LineIntersect(prev, current, lineA, lineB));
    }
  }
  return out;
}

// One touching-bend constraint for boundingBends(p) (14 §2.1's formula, verified by
// hand in that doc against linear chains, branching roots, and merge compatibility —
// NOT a tree walk, just p's own immediately-touching bends). `lineA`/`lineB` is the
// bend's own raw hinge centreline — region clipping happens at zero offset from it
// (both parent and child side clip at the SAME line, keeping opposite sides); the
// real-width bend-allowance zone this leaves neither side "owning" is inserted, and
// each panel's territory beyond it translated outward to make room, by the pose
// walk's own cumulative-shift pass in Evaluate() — never by widening the clip itself
// (see that pass's own comment for why: a parent may touch several bends at once, so
// no single per-panel clip offset could be correct for all of them simultaneously).
struct HalfPlaneConstraint {
  Point2 lineA;
  Point2 lineB;
  bool keepLeft;
  std::string bendId;
};

// Convention (arbitrary but fixed, and self-consistent with the 3D fold rotation's
// axis direction hingeA->hingeB in Evaluate()): the CHILD side of a bend is the LEFT
// side of the directed line hingeA->hingeB.
constexpr bool kChildSideIsLeft = true;

std::vector<HalfPlaneConstraint> BoundingBends(const PartGraphSpec& graph,
                                                const std::string& regionPanelId) {
  std::vector<HalfPlaneConstraint> out;
  for (const auto& bend : graph.bends) {
    if (bend.childRegionPanelId != regionPanelId && bend.parentRegionPanelId != regionPanelId) {
      continue;
    }
    bool isChild = bend.childRegionPanelId == regionPanelId;
    out.push_back({bend.hingeA, bend.hingeB, isChild == kChildSideIsLeft, bend.id});
  }
  return out;
}

struct RegionOfResult {
  std::vector<Point2> outer;
  // Parallel to `outer`: edgeBendId[i] describes the edge (outer[i],
  // outer[(i+1)%n]) — see the field's doc comment on RegionPanelLayout for why this
  // is computed here (where boundingBends() already exists) and nowhere else.
  std::vector<std::string> edgeBendId;
  // Phase 5 Slice 9a: holes belonging to this region panel (see
  // RegionPanelLayout's own doc comment).
  std::vector<std::vector<Point2>> polygonHoles;
  std::vector<CircleHoleSpec> circleHoles;
};

// True if point `p` lies on the infinite line through (lineA, lineB), within
// kGeometricEpsilon (scaled by line length, since Cross2's magnitude grows with it).
bool PointOnLine(const Point2& p, const Point2& lineA, const Point2& lineB) {
  Point2 dir = Sub2(lineB, lineA);
  double lineLen = Length2(dir);
  if (lineLen < kGeometricEpsilon) return false;
  double cross = Cross2(dir, Sub2(p, lineA));
  return std::fabs(cross) / lineLen < 1e-6;  // distance-from-line, in the same units as coordinates
}

std::optional<RegionOfResult> RegionOf(const PartGraphSpec& graph,
                                        const std::string& regionPanelId) {
  auto constraints = BoundingBends(graph, regionPanelId);
  std::vector<Point2> region = graph.outline.outer;
  for (const auto& constraint : constraints) {
    region = ClipHalfPlane(region, constraint.lineA, constraint.lineB, constraint.keepLeft);
    if (region.size() < 3) return std::nullopt;  // clipped away to nothing — degenerate
  }

  RegionOfResult out;
  out.outer = region;
  out.edgeBendId.assign(region.size(), std::string());
  for (size_t i = 0; i < region.size(); ++i) {
    const Point2& a = region[i];
    const Point2& b = region[(i + 1) % region.size()];
    Point2 mid{(a.x + b.x) / 2.0, (a.y + b.y) / 2.0};
    for (const auto& constraint : constraints) {
      if (PointOnLine(a, constraint.lineA, constraint.lineB) &&
          PointOnLine(b, constraint.lineA, constraint.lineB) &&
          PointOnLine(mid, constraint.lineA, constraint.lineB)) {
        out.edgeBendId[i] = constraint.bendId;
        break;
      }
    }
  }

  // Phase 5 Slice 9a: a hole belongs to this region panel iff it's fully
  // contained in THIS panel's own just-clipped `region` — the same
  // containment primitive cut_panel's own write-time validation uses (never
  // a second, independently-derived containment test).
  for (const auto& hole : graph.outline.polygonHoles) {
    if (RingFullyInsidePolygon(hole, region)) out.polygonHoles.push_back(hole);
  }
  for (const auto& hole : graph.outline.circleHoles) {
    if (CircleFullyInsidePolygon(hole.center, hole.radiusMm, region)) {
      out.circleHoles.push_back(hole);
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
  // actually consumes real, inserted bend-allowance material — rather than the
  // zero-offset clip below (BoundingBends) carving that material OUT of a
  // panel's own measured length. `cumulativeShift[root] = 0`; each bend adds
  // its own full bend allowance, along the hinge's own outward (child-side)
  // normal, to every panel in its child's subtree — never HALF of it split
  // across parent and child, because the PARENT'S OWN territory is never
  // touched by widening (only what lies beyond, in the child's subtree, moves)
  // — see the zero-offset clip's own comment for why a per-panel offset at the
  // clip itself can't work once a panel touches more than one bend.
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
      // Left-hand normal of hingeA->hingeB — same convention/formula BoundingBends
      // uses (14's fixed "child = left side" rule) — points toward the child side.
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
      // comment) — ConstructPartSolid derives each side's own tangent
      // points from these, applied to the REAL (RegionOf-clipped) edge
      // points it has, not from any hingeA/hingeB-based absolute position.
      // Signed (see axisInPlaneOffset's own comment above) — never abs().
      bridge.setbackMm = axisInPlaneOffset;
      bridge.nLeftWorld = parentPose.ApplyVector({nLeft.x, nLeft.y, 0.0});
      bridge.childNLeftWorld = worldFold.ApplyVector(bridge.nLeftWorld);
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
    // Raw copies BEFORE the shift below mutates them — the same clip
    // topology as regionOuter/regionPolygonHoles/regionCircleHoles, just
    // without the 2D flat-pattern shift. bottomFace/topFace and solid-wall
    // construction use these (see header comment); regionOuter (shifted,
    // below) stays the flat-pattern/DXF-only view.
    std::vector<Point2> rawOuter = regionResult->outer;
    std::vector<std::vector<Point2>> rawPolygonHoles = regionResult->polygonHoles;
    std::vector<CircleHoleSpec> rawCircleHoles = regionResult->circleHoles;

    std::vector<Point2> regionOuter = std::move(regionResult->outer);
    for (auto& v : regionOuter) {
      v.x += shift.x;
      v.y += shift.y;
    }
    for (auto& ring : regionResult->polygonHoles) {
      for (auto& v : ring) {
        v.x += shift.x;
        v.y += shift.y;
      }
    }
    for (auto& hole : regionResult->circleHoles) {
      hole.center.x += shift.x;
      hole.center.y += shift.y;
    }
    const Transform3& pose = poseByRegionPanel.at(regionPanelId);

    RegionPanelLayout layout;
    layout.regionPanelId = regionPanelId;
    layout.regionOuter = regionOuter;
    layout.rawOuter = rawOuter;
    layout.pose = pose;
    layout.edgeBendId = regionResult->edgeBendId;
    layout.regionPolygonHoles = regionResult->polygonHoles;
    layout.regionCircleHoles = regionResult->circleHoles;
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
