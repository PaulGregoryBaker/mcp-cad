#include "geometry/translation/point_mapping.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>

namespace mcp_cad::translation {

namespace {

constexpr double kMappingEpsilonMm = 1e-6;
// How far a query point may sit off a panel's own flat plane (MapPointToFlat)
// or off its expected pivot-axis radius (the bridge-zone branch) and still
// count as "on" that surface. This is a physical-noise tolerance, not a
// numerical-robustness one (contrast kMappingEpsilonMm above, which stays
// tiny) — matches the established ~2mm precedent
// (MERGE_EDGE_ALIGNMENT_TOLERANCE_MM, part_merge.hpp;
// kSelfConsistencyToleranceMm, step_reconciliation.cc) for real STEP-
// imported panels, whose measured geometry can genuinely differ from a
// perfectly flat/developable model by up to a couple mm at a sharp-fold
// corner relief (confirmed on a real fixture, not measurement noise to
// chase out). The old 1e-6*100=1e-4mm value only ever suited hand-authored,
// exactly-flat synthetic graphs (Slices 1-4) and silently rejected valid
// points on real imported geometry (Slice 5) as "not on the part" rather
// than reporting a position with some residual.
constexpr double kSurfaceResidualToleranceMm = 2.0;

Point2 Sub2(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }
double Dot2(const Point2& a, const Point2& b) { return a.x * b.x + a.y * b.y; }
Point3 Sub3(const Point3& a, const Point3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double Norm3(const Point3& v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

double PointSegmentDistance2(const Point2& p, const Point2& a, const Point2& b) {
  Point2 ab = Sub2(b, a);
  double lenSq = Dot2(ab, ab);
  if (lenSq < 1e-18) return std::hypot(p.x - a.x, p.y - a.y);
  double t = Dot2(Sub2(p, a), ab) / lenSq;
  t = std::max(0.0, std::min(1.0, t));
  Point2 proj{a.x + ab.x * t, a.y + ab.y * t};
  return std::hypot(p.x - proj.x, p.y - proj.y);
}

// Inclusive membership (a point on the boundary — e.g. a shared hinge line —
// belongs to both neighbours, 13 §4.2/§5.1) via boundary-distance short
// circuit, then a standard crossing-number test for the strict interior
// (the crossing test itself has no tolerance concept — the boundary
// short-circuit is the only part physical-noise tolerance can widen).
// `tolerance` defaults to the tiny numerical-robustness epsilon (existing
// callers, exact synthetic graphs); MapPointToFlat's real-STEP-fixture path
// below passes the wider kSurfaceResidualToleranceMm explicitly.
bool PointInPolygon2(const Point2& p, const std::vector<Point2>& poly,
                      double tolerance = kMappingEpsilonMm) {
  if (poly.size() < 3) return false;
  for (size_t i = 0; i < poly.size(); ++i) {
    const Point2& a = poly[i];
    const Point2& b = poly[(i + 1) % poly.size()];
    if (PointSegmentDistance2(p, a, b) < tolerance) return true;
  }
  bool inside = false;
  for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    const Point2& pi = poly[i];
    const Point2& pj = poly[j];
    bool crosses = ((pi.y > p.y) != (pj.y > p.y)) &&
                   (p.x < (pj.x - pi.x) * (p.y - pi.y) / (pj.y - pi.y) + pi.x);
    if (crosses) inside = !inside;
  }
  return inside;
}

// The constant 2D translation between a panel's regionOuter (F, the shared
// flat frame this module's own header documents as its external contract —
// the SAME widened frame flat_outline.cc's combined outline lives in) and
// its rawOuter (what panel.pose actually consumes, per manufacturing_graph_
// evaluator.cc's own corrected pose walk). regionOuter[i] == rawOuter[i] +
// shift for every i on a given panel (a single per-panel translation, never
// per-vertex) — so any one index suffices. A point expressed in F must have
// this SUBTRACTED before being handed to panel.pose; a point read back OUT
// of panel.pose (its inverse) must have this ADDED before being reported as
// an F-frame result — this module's entire job is bridging that boundary
// (13 §4/§5's own "2D point in F" contract), so every pose.Apply/Inverse
// call site below goes through this, never panel.pose directly on an F
// value or straight off panel.pose.Inverse() without re-adding it.
Point2 PanelShift(const RegionPanelLayout& panel) {
  if (panel.rawOuter.empty() || panel.regionOuter.empty()) return {0.0, 0.0};
  return Sub2(panel.regionOuter[0], panel.rawOuter[0]);
}

const RegionPanelLayout* FindPanel(const EvaluateResult& layout, const std::string& id) {
  for (const auto& p : layout.panels) {
    if (p.regionPanelId == id) return &p;
  }
  return nullptr;
}

const BridgeLayout* FindBridge(const EvaluateResult& layout, const std::string& bendId) {
  for (const auto& b : layout.bridges) {
    if (b.bendId == bendId) return &b;
  }
  return nullptr;
}

// A bend's flat-frame bridge zone: the quad between its parent's own
// zone-boundary edge and its child's own zone-boundary edge, both already
// computed by Evaluate() and tagged via edgeBendId — never re-derived from
// the raw hinge span independently (constitution principle III: BoundingBends'
// own offset-by-BA/2 computation is the one place that fact is derived).
struct BridgeZone {
  bool found = false;
  Point2 parentA, parentB;  // the parent's own tagged edge (zone boundary at u=0)
  Point2 childA, childB;    // the child's own tagged edge (zone boundary at u=BA)
};

BridgeZone FindBridgeZone(const EvaluateResult& layout, const BendSpec& bend) {
  BridgeZone zone;
  const RegionPanelLayout* parent = FindPanel(layout, bend.parentRegionPanelId);
  const RegionPanelLayout* child = FindPanel(layout, bend.childRegionPanelId);
  if (!parent || !child) return zone;

  auto findTaggedEdge = [&](const RegionPanelLayout* panel, Point2* a, Point2* b) -> bool {
    size_t n = panel->regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      if (panel->regionEdgeBendId[i] == bend.id) {
        *a = panel->regionOuter[i];
        *b = panel->regionOuter[(i + 1) % n];
        return true;
      }
    }
    return false;
  };
  if (!findTaggedEdge(parent, &zone.parentA, &zone.parentB)) return zone;
  if (!findTaggedEdge(child, &zone.childA, &zone.childB)) return zone;
  zone.found = true;
  return zone;
}

// Local (s, u) coordinates of `p` within `zone`: s is the axial position along
// the hinge direction (measured from parentA), u in [0, BA] is the
// perpendicular position from the parent-side boundary (0) to the child-side
// boundary (BA). Also returns whether p falls within the zone's own finite
// lateral (s) extent and perpendicular (u) band.
struct ZoneLocal {
  double s = 0.0;
  double u = 0.0;
  double ba = 0.0;
  Point2 hingeOrigin;  // parentA, offset back to the true hinge centreline at s=0
  Point2 dHat;         // unit axial direction
  Point2 nHat;         // unit perpendicular direction, parent(u=0) -> child(u=BA)
  bool inBand = false;
};

ZoneLocal ResolveZoneLocal(const Point2& p, const BridgeZone& zone) {
  ZoneLocal z;
  Point2 axial = Sub2(zone.parentB, zone.parentA);
  double axialLen = std::hypot(axial.x, axial.y);
  if (axialLen < 1e-9) return z;
  z.dHat = {axial.x / axialLen, axial.y / axialLen};
  Point2 perp = Sub2(zone.childA, zone.parentA);
  // nHat is the component of (childA - parentA) perpendicular to dHat.
  double alongAxial = Dot2(perp, z.dHat);
  Point2 perpVec{perp.x - alongAxial * z.dHat.x, perp.y - alongAxial * z.dHat.y};
  double perpLen = std::hypot(perpVec.x, perpVec.y);
  if (perpLen < 1e-9) return z;
  z.nHat = {perpVec.x / perpLen, perpVec.y / perpLen};
  z.ba = perpLen;
  z.hingeOrigin = zone.parentA;

  Point2 rel = Sub2(p, zone.parentA);
  z.s = Dot2(rel, z.dHat);
  z.u = Dot2(rel, z.nHat);

  double sMin = 0.0;
  double sMax = Dot2(Sub2(zone.parentB, zone.parentA), z.dHat);
  if (sMin > sMax) std::swap(sMin, sMax);
  z.inBand = (z.s >= sMin - kMappingEpsilonMm) && (z.s <= sMax + kMappingEpsilonMm) &&
             (z.u >= -kMappingEpsilonMm) && (z.u <= z.ba + kMappingEpsilonMm);
  return z;
}

}  // namespace

namespace {

// Builds the world-space fold result for a query point already resolved to
// (zone, local) — the exact same construction MapPointToWorld's exact pass
// and its widened fallback pass both need, factored out rather than
// duplicated.
Point3 ApplyBridgeFold(const PartGraphSpec& graph, const BendSpec& bend, const ZoneLocal& local,
                        const RegionPanelLayout& parentPanel, const BridgeLayout& bridge) {
  Point2 aFlat{local.hingeOrigin.x + local.s * local.dHat.x,
               local.hingeOrigin.y + local.s * local.dHat.y};
  Point2 shift = PanelShift(parentPanel);
  Point3 aWorld = parentPanel.pose.Apply({aFlat.x - shift.x, aFlat.y - shift.y, 0.0});

  // Rotate "a" about the SAME axis (pivotOriginWorld/pivotAxisWorld) the
  // evaluator itself used to fold the child (manufacturing_graph_evaluator.cc's
  // own worldFold = RotationAboutAxis(hingeAWorld, axis, bend->angleDeg) —
  // bridge.pivotOriginWorld/pivotAxisWorld ARE hingeAWorld/axis, verbatim),
  // by whatever FRACTION of the full angle this query's u represents. This
  // reuses an already-tested primitive instead of hand-deriving a sin/cos
  // decomposition of the hinge frame — an earlier attempt at the latter had
  // a real sign bug (n_hat/z_hat roles swapped) that this sidesteps entirely.
  double rho = bend.radiusMm + bend.kFactor * graph.thicknessMm;
  double phi = rho > 1e-9 ? local.u / rho : 0.0;
  double phiDeg = phi * 180.0 / 3.14159265358979323846;
  double signedPhiDeg = bend.angleDeg >= 0.0 ? phiDeg : -phiDeg;

  Transform3 partialFold =
      Transform3::RotationAboutAxis(bridge.pivotOriginWorld, bridge.pivotAxisWorld, signedPhiDeg);
  return partialFold.Apply(aWorld);
}

// How far (s, u) sits outside the zone's own [sMin,sMax]x[0,ba] rectangle —
// 0 exactly at/inside the tight band, growing outward. The widened fallback
// pass's bridge-side residual, directly comparable to the panel-side
// boundary-distance residual below (both are "how far outside the exact
// membership test", in mm).
double ZoneOutsideDistanceMm(const ZoneLocal& local, double sMin, double sMax) {
  double dS = std::max({sMin - local.s, local.s - sMax, 0.0});
  double dU = std::max({-local.u, local.u - local.ba, 0.0});
  return std::hypot(dS, dU);
}

}  // namespace

MapToWorldResult MapPointToWorld(const PartGraphSpec& graph, const EvaluateResult& layout,
                                  const Point2& point2d, double zMm) {
  MapToWorldResult result;
  if (!layout.ok) {
    result.errorCode = MapErrorCode::kInvalidLayout;
    result.message = "supplied layout is not ok";
    return result;
  }

  // Pass 1 — exact membership, tight tolerance, panels before bridges: BYTE
  // FOR BYTE the original (pre-Slice-5) behavior, so every graph this ran
  // correctly on before (Slices 1-4's own hand-authored, exactly-flat
  // synthetic graphs) is completely unaffected by anything below.
  for (const auto& panel : layout.panels) {
    if (PointInPolygon2(point2d, panel.regionOuter)) {
      Point2 shift = PanelShift(panel);
      result.ok = true;
      result.regionPanelId = panel.regionPanelId;
      result.point3d = panel.pose.Apply({point2d.x - shift.x, point2d.y - shift.y, zMm});
      return result;
    }
  }
  for (const auto& bend : graph.bends) {
    BridgeZone zone = FindBridgeZone(layout, bend);
    if (!zone.found) continue;
    ZoneLocal local = ResolveZoneLocal(point2d, zone);
    if (local.ba < 1e-9 || !local.inBand) continue;
    const RegionPanelLayout* parentPanel = FindPanel(layout, bend.parentRegionPanelId);
    const BridgeLayout* bridge = FindBridge(layout, bend.id);
    if (!parentPanel || !bridge) continue;
    result.ok = true;
    result.bendId = bend.id;
    result.point3d = ApplyBridgeFold(graph, bend, local, *parentPanel, *bridge);
    return result;
  }

  // Pass 2 — nothing matched exactly: widen to kSurfaceResidualToleranceMm
  // and pick whichever candidate (panel edge or bridge-zone boundary) sits
  // CLOSEST, across both kinds together — never "first panel found," which
  // is what let a widened panel tolerance alone swallow a point that
  // actually belongs to an adjacent bridge zone (the real regression this
  // two-pass structure exists to prevent). Real STEP-imported panels
  // (Slice 5) can genuinely miss pass 1 by up to a couple mm at a
  // sharp-fold corner relief — see kSurfaceResidualToleranceMm's own doc
  // comment.
  bool found = false;
  double bestResidual = -1.0;
  std::string bestRegionPanelId;
  Point3 bestPoint3d{};
  std::string bestBendId;

  for (const auto& panel : layout.panels) {
    double best = std::numeric_limits<double>::infinity();
    size_t n = panel.regionOuter.size();
    for (size_t i = 0; i < n; ++i) {
      best = std::min(best, PointSegmentDistance2(point2d, panel.regionOuter[i],
                                                    panel.regionOuter[(i + 1) % n]));
    }
    if (best > kSurfaceResidualToleranceMm) continue;
    if (!found || best < bestResidual) {
      found = true;
      bestResidual = best;
      bestRegionPanelId = panel.regionPanelId;
      bestBendId.clear();
      Point2 shift = PanelShift(panel);
      bestPoint3d = panel.pose.Apply({point2d.x - shift.x, point2d.y - shift.y, zMm});
    }
  }
  for (const auto& bend : graph.bends) {
    BridgeZone zone = FindBridgeZone(layout, bend);
    if (!zone.found) continue;
    ZoneLocal local = ResolveZoneLocal(point2d, zone);
    if (local.ba < 1e-9) continue;
    double sMin = 0.0;
    double sMax = Dot2(Sub2(zone.parentB, zone.parentA), local.dHat);
    if (sMin > sMax) std::swap(sMin, sMax);
    double outside = ZoneOutsideDistanceMm(local, sMin, sMax);
    if (outside > kSurfaceResidualToleranceMm) continue;
    const RegionPanelLayout* parentPanel = FindPanel(layout, bend.parentRegionPanelId);
    const BridgeLayout* bridge = FindBridge(layout, bend.id);
    if (!parentPanel || !bridge) continue;
    if (!found || outside < bestResidual) {
      found = true;
      bestResidual = outside;
      bestRegionPanelId.clear();
      bestBendId = bend.id;
      bestPoint3d = ApplyBridgeFold(graph, bend, local, *parentPanel, *bridge);
    }
  }

  if (found) {
    result.ok = true;
    result.regionPanelId = bestRegionPanelId;
    result.bendId = bestBendId;
    result.point3d = bestPoint3d;
    return result;
  }

  result.errorCode = MapErrorCode::kPointNotOnPart;
  result.message = "point is not on any region panel or bridge";
  return result;
}

MapToFlatResult MapPointToFlat(const PartGraphSpec& graph, const EvaluateResult& layout,
                                const Point3& point3d) {
  MapToFlatResult result;
  if (!layout.ok) {
    result.errorCode = MapErrorCode::kInvalidLayout;
    result.message = "supplied layout is not ok";
    return result;
  }

  double bestResidual = -1.0;
  bool found = false;

  for (const auto& panel : layout.panels) {
    Transform3 inv = panel.pose.Inverse();
    Point3 local = inv.Apply(point3d);
    double residual = std::fabs(local.z);
    // pose maps rawOuter <-> world; local.xy is therefore in the raw frame —
    // add the shift back to report the F-frame (regionOuter-consistent)
    // point this module's own contract requires (see PanelShift's comment).
    Point2 shift = PanelShift(panel);
    Point2 flat{local.x + shift.x, local.y + shift.y};
    if (residual <= kSurfaceResidualToleranceMm &&
        PointInPolygon2(flat, panel.regionOuter, kSurfaceResidualToleranceMm)) {
      if (!found || residual < bestResidual) {
        found = true;
        bestResidual = residual;
        result.regionPanelId = panel.regionPanelId;
        result.bendId.clear();
        result.point2d = flat;
        result.residualMm = residual;
      }
    }
  }

  for (const auto& bend : graph.bends) {
    BridgeZone zone = FindBridgeZone(layout, bend);
    if (!zone.found) continue;
    const RegionPanelLayout* parentPanel = FindPanel(layout, bend.parentRegionPanelId);
    const BridgeLayout* bridge = FindBridge(layout, bend.id);
    if (!parentPanel || !bridge) continue;

    Point2 axial = Sub2(zone.parentB, zone.parentA);
    double axialLen = std::hypot(axial.x, axial.y);
    if (axialLen < 1e-9) continue;
    Point2 dHat{axial.x / axialLen, axial.y / axialLen};
    Point2 perp = Sub2(zone.childA, zone.parentA);
    double alongAxial = Dot2(perp, dHat);
    Point2 perpVec{perp.x - alongAxial * dHat.x, perp.y - alongAxial * dHat.y};
    double ba = std::hypot(perpVec.x, perpVec.y);
    if (ba < 1e-9) continue;
    Point2 nHat{perpVec.x / ba, perpVec.y / ba};

    // Same construction as MapPointToWorld: find the query's own axial
    // position s by projecting onto the parent edge's own line (dHatWorld),
    // then compare its perpendicular offset from the TRUE pivot axis against
    // "a"'s own offset (rotation preserves distance-to-axis exactly — this
    // is the residual/ownership test) and its ANGLE from "a" around that
    // axis (which recovers phi, and hence u) — both via the exact same
    // already-tested RotationAboutAxis geometry the forward map uses, never
    // a hand-derived sin/cos frame (see MapPointToWorld's own comment for
    // why that was abandoned).
    Point2 parentShift = PanelShift(*parentPanel);
    Point3 aRefWorld = parentPanel->pose.Apply(
        {zone.parentA.x - parentShift.x, zone.parentA.y - parentShift.y, 0.0});
    Point3 dHatWorld = parentPanel->pose.ApplyVector({dHat.x, dHat.y, 0.0});
    Point3 relToARef = Sub3(point3d, aRefWorld);
    double s = relToARef.x * dHatWorld.x + relToARef.y * dHatWorld.y + relToARef.z * dHatWorld.z;
    Point3 aAtS = {aRefWorld.x + s * dHatWorld.x, aRefWorld.y + s * dHatWorld.y,
                   aRefWorld.z + s * dHatWorld.z};

    const Point3& pivotOrigin = bridge->pivotOriginWorld;
    const Point3& axisDir = bridge->pivotAxisWorld;
    auto perpFromAxis = [&](const Point3& p) -> Point3 {
      Point3 rel = Sub3(p, pivotOrigin);
      double along = rel.x * axisDir.x + rel.y * axisDir.y + rel.z * axisDir.z;
      return {rel.x - along * axisDir.x, rel.y - along * axisDir.y, rel.z - along * axisDir.z};
    };
    Point3 perpA = perpFromAxis(aAtS);
    Point3 perpX = perpFromAxis(point3d);
    double radA = Norm3(perpA);
    double radX = Norm3(perpX);
    if (radA < 1e-9 || radX < 1e-9) continue;

    double residual = std::fabs(radX - radA);
    if (residual > kSurfaceResidualToleranceMm) continue;

    double cosAngle = (perpA.x * perpX.x + perpA.y * perpX.y + perpA.z * perpX.z) / (radA * radX);
    Point3 cross = {perpA.y * perpX.z - perpA.z * perpX.y, perpA.z * perpX.x - perpA.x * perpX.z,
                     perpA.x * perpX.y - perpA.y * perpX.x};
    double sinAngle =
        (cross.x * axisDir.x + cross.y * axisDir.y + cross.z * axisDir.z) / (radA * radX);
    double angleDeg = std::atan2(sinAngle, cosAngle) * 180.0 / 3.14159265358979323846;

    // phiDeg must be non-negative (u ranges 0..BA) — matches the SAME sign
    // convention MapPointToWorld uses to go from phiDeg to a signed rotation.
    double phiDeg = bend.angleDeg >= 0.0 ? angleDeg : -angleDeg;
    if (phiDeg < -kMappingEpsilonMm) continue;
    if (phiDeg < 0.0) phiDeg = 0.0;

    double rho = bend.radiusMm + bend.kFactor * graph.thicknessMm;
    double phiRad = phiDeg * 3.14159265358979323846 / 180.0;
    double u = rho > 1e-9 ? phiRad * rho : 0.0;

    Point2 flat{zone.parentA.x + s * dHat.x + u * nHat.x, zone.parentA.y + s * dHat.y + u * nHat.y};

    double sMin = 0.0;
    double sMax = Dot2(Sub2(zone.parentB, zone.parentA), dHat);
    if (sMin > sMax) std::swap(sMin, sMax);
    bool inBand = (s >= sMin - kMappingEpsilonMm) && (s <= sMax + kMappingEpsilonMm) &&
                  (u >= -kMappingEpsilonMm) && (u <= ba + kMappingEpsilonMm);
    if (!inBand) continue;

    if (!found || residual < bestResidual) {
      found = true;
      bestResidual = residual;
      result.regionPanelId.clear();
      result.bendId = bend.id;
      result.point2d = flat;
      result.residualMm = residual;
    }
  }

  if (!found) {
    result.errorCode = MapErrorCode::kPointNotOnPart;
    result.message = "point is not on any region panel or bridge";
    return result;
  }
  result.ok = true;
  return result;
}

}  // namespace mcp_cad::translation
