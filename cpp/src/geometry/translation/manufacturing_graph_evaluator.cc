#include "manufacturing_graph_evaluator.hpp"

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

// Flat-pattern width the bend zone consumes (neutral-fibre arc length).
double BendAllowanceMm(const BendSpec& bend, double thicknessMm) {
  double angleRad = std::fabs(DegToRad(bend.angleDeg));
  return angleRad * (bend.radiusMm + bend.kFactor * thicknessMm);
}

// Radius of the BOTTOM surface (13 D3: what regionOf/DXF maps to). Positive
// angleDeg = "mountain" (bottom = inner/concave, r_b = radiusMm); negative =
// "valley" (bottom = outer/convex, r_b = radiusMm + thicknessMm — never zero,
// since the material's own thickness can't occupy zero arc on the outer side).
double BottomRadiusMm(const BendSpec& bend, double thicknessMm) {
  bool isMountain = bend.angleDeg >= 0.0;
  return isMountain ? bend.radiusMm : bend.radiusMm + thicknessMm;
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
// bend-ZONE boundary line for this side (hinge centreline offset by BA/2 toward this
// region's own territory), not the raw centreline — a real-width zone, not a
// zero-width cut.
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
    // Left-hand normal of hingeA->hingeB — points toward the child side (14's fixed
    // convention above), used to push the zero-width centreline out to the real-width
    // zone boundary on whichever side this region panel sits.
    Point2 dir = Sub2(bend.hingeB, bend.hingeA);
    double dirLen = Length2(dir);
    Point2 nLeft{0.0, 0.0};
    if (dirLen >= kGeometricEpsilon) {
      nLeft = {-dir.y / dirLen, dir.x / dirLen};
    }
    double halfBa = BendAllowanceMm(bend, graph.thicknessMm) / 2.0;

    if (bend.childRegionPanelId == regionPanelId) {
      // Shrink the child's region: push the boundary INTO the child's own
      // territory (along +nLeft) by half the zone width.
      Point2 a{bend.hingeA.x + nLeft.x * halfBa, bend.hingeA.y + nLeft.y * halfBa};
      Point2 b{bend.hingeB.x + nLeft.x * halfBa, bend.hingeB.y + nLeft.y * halfBa};
      out.push_back({a, b, kChildSideIsLeft, bend.id});
    } else {
      // p is the parent of this bend: push the boundary INTO the parent's own
      // territory (along -nLeft) by half the zone width, keep the OTHER side.
      Point2 a{bend.hingeA.x - nLeft.x * halfBa, bend.hingeA.y - nLeft.y * halfBa};
      Point2 b{bend.hingeB.x - nLeft.x * halfBa, bend.hingeB.y - nLeft.y * halfBa};
      out.push_back({a, b, !kChildSideIsLeft, bend.id});
    }
  }
  return out;
}

struct RegionOfResult {
  std::vector<Point2> outer;
  // Parallel to `outer`: edgeBendId[i] describes the edge (outer[i],
  // outer[(i+1)%n]) — see the field's doc comment on RegionPanelLayout for why this
  // is computed here (where boundingBends() already exists) and nowhere else.
  std::vector<std::string> edgeBendId;
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
  std::unordered_map<std::string, Transform3> poseByRegionPanel;
  poseByRegionPanel[graph.rootRegionPanelId] = graph.anchor.transform;

  std::unordered_map<std::string, std::vector<const BendSpec*>> childrenOf;
  for (const auto& bend : graph.bends) {
    childrenOf[bend.parentRegionPanelId].push_back(&bend);
  }

  std::vector<std::string> queue{graph.rootRegionPanelId};
  size_t qi = 0;
  while (qi < queue.size()) {
    std::string current = queue[qi++];
    const Transform3& parentPose = poseByRegionPanel.at(current);
    for (const auto* bend : childrenOf[current]) {
      // Left-hand normal of hingeA->hingeB — same convention/formula BoundingBends
      // uses (14's fixed "child = left side" rule) — points toward the child side,
      // needed below for the child-coordinate zone-width shift.
      Point2 hingeDir = Sub2(bend->hingeB, bend->hingeA);
      double hingeDirLen = Length2(hingeDir);
      Point2 nLeft{0.0, 0.0};
      if (hingeDirLen >= kGeometricEpsilon) {
        nLeft = {-hingeDir.y / hingeDirLen, hingeDir.x / hingeDirLen};
      }

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
      bool isMountain = bend->angleDeg >= 0.0;
      double rBottom = BottomRadiusMm(*bend, graph.thicknessMm);
      double pivotZ = isMountain ? -rBottom : rBottom;

      Point3 hingeA3{bend->hingeA.x, bend->hingeA.y, pivotZ};
      Point3 hingeB3{bend->hingeB.x, bend->hingeB.y, pivotZ};
      Point3 hingeAWorld = parentPose.Apply(hingeA3);
      Point3 hingeBWorld = parentPose.Apply(hingeB3);
      Point3 axis = Normalize3(Sub3(hingeBWorld, hingeAWorld));
      if (Length3(axis) < kGeometricEpsilon) {
        result.errorCode = EvaluateErrorCode::kDegenerateOutline;
        result.message = "bend " + bend->id + " has a zero-length hinge";
        return result;
      }
      Transform3 worldFold = Transform3::RotationAboutAxis(hingeAWorld, axis, bend->angleDeg);

      // The child's own F-frame coordinates are raw flat-pattern values, e.g. a
      // corner at x=200 — but that raw value is NOT "distance from the zone's own
      // far tangent point", which is what a rigid rotation about the (raw-hinge,
      // pivotZ) axis actually models geometrically once the zone has real width
      // (BA>0). A point-by-point trig derivation (rotating the true bottom/top
      // surface arcs through the zone, matching tangents at both ends) shows the
      // two only agree once the child's coordinate is first shifted by half the
      // zone's own width (BA/2) toward the child, in the flat F-frame, BEFORE the
      // pivot rotation — not by moving the pivot itself (no fixed pivot position
      // reproduces the correct result without this shift; verified algebraically).
      // At BA=0 (sharp fold) this shift vanishes and nothing changes.
      double halfBa = BendAllowanceMm(*bend, graph.thicknessMm) / 2.0;
      Transform3 childShift =
          Transform3::Translation(-halfBa * nLeft.x, -halfBa * nLeft.y, 0.0);
      Transform3 childPose = worldFold.Compose(parentPose.Compose(childShift));
      poseByRegionPanel[bend->childRegionPanelId] = childPose;
      queue.push_back(bend->childRegionPanelId);

      BridgeLayout bridge;
      bridge.bendId = bend->id;
      bridge.parentRegionPanelId = bend->parentRegionPanelId;
      bridge.childRegionPanelId = bend->childRegionPanelId;
      bridge.pivotOriginWorld = hingeAWorld;
      bridge.pivotAxisWorld = axis;
      bridge.angleDeg = bend->angleDeg;
      result.bridges.push_back(std::move(bridge));
    }
  }

  // regionOf + bottomFace/topFace per visited region panel.
  for (const auto& regionPanelId : queue) {
    auto regionResult = RegionOf(graph, regionPanelId);
    if (!regionResult.has_value()) {
      result.errorCode = EvaluateErrorCode::kRegionClipFailed;
      result.message = "region clip failed (degenerate) for region panel " + regionPanelId;
      return result;
    }
    const auto& regionOuter = regionResult->outer;
    const Transform3& pose = poseByRegionPanel.at(regionPanelId);

    RegionPanelLayout layout;
    layout.regionPanelId = regionPanelId;
    layout.regionOuter = regionOuter;
    layout.pose = pose;
    layout.edgeBendId = regionResult->edgeBendId;
    layout.bottomFace.reserve(regionOuter.size());
    layout.topFace.reserve(regionOuter.size());
    for (const auto& v : regionOuter) {
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
