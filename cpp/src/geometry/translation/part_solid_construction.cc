#include "part_solid_construction.hpp"
#include "../geometry_service_impl.hpp"
#include "../geometry_service_utils.hpp"

#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>
#include <TopExp_Explorer.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <Standard_Failure.hxx>

#include <cmath>
#include <unordered_map>

namespace mcp_cad::translation {

namespace {

// Local, named numerical-robustness constant (constitution v2.0.0 principle V's
// distinction: this never varies by project). Matches the corrected (post-
// 0.15mm-bug) relative-fuzz value documented in rebuild/12-domain-notes.md §2 /
// rebuild/17-numerical-policy.md §2.1.
constexpr double kBooleanFuzzMm = 1e-5;
constexpr double kPi = 3.14159265358979323846;

gp_Trsf ToGpTrsf(const Transform3& t) {
  gp_Trsf trsf;
  trsf.SetValues(t.r[0], t.r[1], t.r[2], t.t[0], t.r[3], t.r[4], t.r[5], t.t[1], t.r[6], t.r[7],
                 t.r[8], t.t[2]);
  return trsf;
}

// Locates the single regionOuter edge of `panel` whose edgeBendId matches
// `bendId` — the parent panel's own zone-boundary quad, which the bridge's
// revolve profile is built from. Returns -1 if no such edge exists, -2 if the
// zone boundary spans more than one edge (a general polygon, not yet supported —
// this slice's own scope is straight chains only, where a rectangular clip
// always yields exactly one edge per bend).
int FindZoneEdge(const RegionPanelLayout& panel, const std::string& bendId) {
  int found = -1;
  for (size_t i = 0; i < panel.edgeBendId.size(); ++i) {
    if (panel.edgeBendId[i] == bendId) {
      if (found != -1) return -2;
      found = static_cast<int>(i);
    }
  }
  return found;
}

// ─── Wall-solid trim (see BridgeLayout's own doc comment on rawHingeA/B/
// nLeftFlat) ──────────────────────────────────────────────────────────────
// A standalone half-plane clip, deliberately duplicated here rather than
// shared with manufacturing_graph_evaluator.cc's own ClipHalfPlane/RegionOf:
// this trim is a solid-construction-only fact (it must NEVER feed back into
// the flat-pattern/DXF-facing region clip, which stays at zero offset), so
// it has no business living in, or depending on, that file.
constexpr double kClipEpsilon = 1e-9;

double Cross2Local(const Point2& a, const Point2& b) { return a.x * b.y - a.y * b.x; }
Point2 Sub2Local(const Point2& a, const Point2& b) { return {a.x - b.x, a.y - b.y}; }

bool IsInsideLocal(const Point2& p, const Point2& lineA, const Point2& lineB, bool keepLeft) {
  double cross = Cross2Local(Sub2Local(lineB, lineA), Sub2Local(p, lineA));
  return keepLeft ? (cross > kClipEpsilon) : (cross < -kClipEpsilon);
}

Point2 LineIntersectLocal(const Point2& a, const Point2& b, const Point2& lineA,
                           const Point2& lineB) {
  Point2 d1 = Sub2Local(b, a);
  Point2 d2 = Sub2Local(lineB, lineA);
  double denom = Cross2Local(d1, d2);
  if (std::fabs(denom) < kClipEpsilon) return a;
  Point2 diff = Sub2Local(lineA, a);
  double t = Cross2Local(diff, d2) / denom;
  return {a.x + d1.x * t, a.y + d1.y * t};
}

// Standard Sutherland-Hodgman single-clip pass, keeping the `keepLeft` side
// of directed line lineA->lineB.
std::vector<Point2> ClipHalfPlaneLocal(const std::vector<Point2>& polygon, const Point2& lineA,
                                        const Point2& lineB, bool keepLeft) {
  if (polygon.empty()) return polygon;
  std::vector<Point2> out;
  out.reserve(polygon.size() + 1);
  for (size_t i = 0; i < polygon.size(); ++i) {
    const Point2& current = polygon[i];
    const Point2& prev = polygon[(i + polygon.size() - 1) % polygon.size()];
    bool currentIn = IsInsideLocal(current, lineA, lineB, keepLeft);
    bool prevIn = IsInsideLocal(prev, lineA, lineB, keepLeft);
    if (currentIn) {
      if (!prevIn) out.push_back(LineIntersectLocal(prev, current, lineA, lineB));
      out.push_back(current);
    } else if (prevIn) {
      out.push_back(LineIntersectLocal(prev, current, lineA, lineB));
    }
  }
  return out;
}

// Same "child = left side" convention BoundingBends uses (manufacturing_
// graph_evaluator.cc) — fixed and shared in spirit, not by code, since this
// file deliberately doesn't depend on that one.
constexpr bool kChildSideIsLeftLocal = true;

// Trims `outer` back to each bridge's true tangent line, wherever `panel`
// touches one (as parent OR child) — so the wall solid's own edge lands
// exactly where the bridge's own tangent quad does, instead of reaching out
// to the sharp-corner position the envelope fix (docs/BUG_REPORT_
// reconstructed_envelope_grows_with_bend_radius.md) requires for the
// UNtrimmed pose. Operates on a plain point list — callable for a panel's
// own outer ring or any of its polygon holes alike.
//
// Parent and child do NOT clip against the same line: the child's own local
// frame already carries the pose walk's `childExtension` (2*setbackMm along
// nLeft, applied before the fold — manufacturing_graph_evaluator.cc), so a
// child-local point p lands in the shared pre-fold frame at p+2*setbackMm,
// not at p. Solving for which child-local F reaches the true tangent point
// (shared-F = rawHinge+setbackMm) gives rawHinge-setbackMm — the mirror of
// the parent's own rawHinge+setbackMm. Verified numerically, simulating the
// full childExtension-then-rotate pose, before this code was written: both
// give exact tangency (zero residual) on both the bottom and top surfaces,
// across every angle/radius/concavity combination tried, including the
// "mixed" concave-vs-signed-angle cases real STEP data produces.
std::vector<Point2> TrimToTangentLines(std::vector<Point2> outer,
                                        const RegionPanelLayout& panel,
                                        const std::vector<BridgeLayout>& bridges) {
  for (const auto& bridge : bridges) {
    bool isParent = panel.regionPanelId == bridge.parentRegionPanelId;
    bool isChild = panel.regionPanelId == bridge.childRegionPanelId;
    if (!isParent && !isChild) continue;
    double sideSign = isChild ? -1.0 : 1.0;
    double offset = sideSign * bridge.setbackMm;
    Point2 lineA{bridge.rawHingeA.x + offset * bridge.nLeftFlat.x,
                 bridge.rawHingeA.y + offset * bridge.nLeftFlat.y};
    Point2 lineB{bridge.rawHingeB.x + offset * bridge.nLeftFlat.x,
                 bridge.rawHingeB.y + offset * bridge.nLeftFlat.y};
    bool keepLeft = isChild ? kChildSideIsLeftLocal : !kChildSideIsLeftLocal;
    outer = ClipHalfPlaneLocal(outer, lineA, lineB, keepLeft);
    if (outer.size() < 3) break;  // clipped away to nothing — leave degenerate, caller handles
  }
  return outer;
}

// The flat sliver between a panel's own real (already-clipped) hinge-
// adjacent edge and its own true tangent line (that edge + sideSign*
// setbackMm*nLeftFlat, sideSign=+1 parent/-1 child — the exact line
// TrimToTangentLines clips against, see that function's own header
// comment), for whichever side(s) TrimToTangentLines' clip is a no-op
// because the panel's real material never reaches that line in the first
// place. That happens for a given side exactly when its own signed
// target-F falls OUTSIDE the panel's existing [raw-hinge, far-edge) range —
// which, worked through both sides' own sign conventions, reduces to the
// SAME condition for both: setbackMm > 0 means BOTH parent and child fall
// short and need this extension; setbackMm < 0 means BOTH already overlap
// the tangent line and only need TrimToTangentLines' clip (this mirrors the
// standard sheet-metal fact that bend allowance and 2x setback are
// generally different quantities — the flat pattern can need to be either
// longer or shorter than the sharp-corner sum, never one leg longer and the
// other shorter).
//
// Deliberately built from `panel.rawOuter`'s OWN hinge-adjacent edge
// (located the same way the bridge quad above locates it, via
// FindZoneEdge), never from bridge.rawHingeA/B directly — those carry an
// intentionally exaggerated half-span (BridgeLayout's own header comment)
// so the infinite trim LINE reaches across the whole panel even with a Y
// offset, which is fine for a half-plane clip but wrong for a solid corner:
// using them here once produced an extension box wider (in Y) than the
// panel's own real edge, leaving a genuine step at the seam instead of a
// flush union — confirmed by a live vertex dump (a spurious 98mm-scale
// "excess" traced to exactly this box's own oversized corners) before this
// was fixed.
std::vector<Point2> BuildSetbackExtensionRing(const RegionPanelLayout& panel,
                                               const BridgeLayout& bridge) {
  bool isParent = panel.regionPanelId == bridge.parentRegionPanelId;
  bool isChild = panel.regionPanelId == bridge.childRegionPanelId;
  if (!isParent && !isChild) return {};
  if (bridge.setbackMm <= kClipEpsilon) return {};
  int edgeIdx = FindZoneEdge(panel, bridge.bendId);
  if (edgeIdx < 0) return {};  // no single-edge zone boundary found — caller's main
                                // FindZoneEdge call (bridge construction) already
                                // surfaces this as a proper error; nothing to add here
  size_t i0 = static_cast<size_t>(edgeIdx);
  size_t i1 = (i0 + 1) % panel.rawOuter.size();
  const Point2& realA = panel.rawOuter[i0];
  const Point2& realB = panel.rawOuter[i1];
  double sideSign = isChild ? -1.0 : 1.0;
  double offset = sideSign * bridge.setbackMm;
  Point2 farA{realA.x + offset * bridge.nLeftFlat.x, realA.y + offset * bridge.nLeftFlat.y};
  Point2 farB{realB.x + offset * bridge.nLeftFlat.x, realB.y + offset * bridge.nLeftFlat.y};
  return {realA, realB, farB, farA};
}

}  // namespace

ConstructPartSolidResult ConstructPartSolid(GeometryState& state, const EvaluateResult& layout,
                                             double thicknessMm) {
  ConstructPartSolidResult result;

  if (!layout.ok) {
    result.errorCode = "GE_INVALID_LAYOUT";
    result.message = "cannot construct from a failed Evaluate() result";
    return result;
  }
  if (layout.panels.empty()) {
    result.errorCode = "GE_EMPTY_LAYOUT";
    result.message = "no panels to construct";
    return result;
  }
  if (thicknessMm <= 0.0) {
    result.errorCode = "GE_INVALID_SHEET_METAL";
    result.message = "thickness must be > 0";
    return result;
  }

  try {
    std::unordered_map<std::string, const RegionPanelLayout*> panelById;
    for (const auto& panel : layout.panels) {
      panelById[panel.regionPanelId] = &panel;
    }

    // Each panel becomes its own independently-thickened solid, placed via its
    // already-computed pose (never re-derived here — see this file's header).
    // The wall itself is built from `trimmedOuter`, not `panel.rawOuter`
    // directly — trimmed back to each touching bend's true tangent line
    // (TrimToTangentLines, above) so the wall's own edge lands where the
    // bridge's tangent quad does, not out at the sharp-corner position the
    // envelope fix's (untrimmed) pose alone would place it. `panel.rawOuter`
    // itself is untouched — this trim is solid-construction-only.
    std::unordered_map<std::string, TopoDS_Shape> panelSolidById;
    for (const auto& panel : layout.panels) {
      std::vector<Point2> trimmedOuter = TrimToTangentLines(panel.rawOuter, panel, layout.bridges);
      if (trimmedOuter.size() < 3) {
        result.errorCode = "GE_POLYGON_BUILD_FAILED";
        result.message = "region panel " + panel.regionPanelId +
                          " was clipped away to nothing trimming to its own tangent line(s)";
        return result;
      }
      BRepBuilderAPI_MakePolygon polyMaker;
      for (const auto& v : trimmedOuter) {
        polyMaker.Add(gp_Pnt(v.x, v.y, 0.0));
      }
      polyMaker.Close();
      if (!polyMaker.IsDone()) {
        result.errorCode = "GE_POLYGON_BUILD_FAILED";
        result.message = "failed to build a closed wire for region panel " + panel.regionPanelId;
        return result;
      }

      BRepBuilderAPI_MakeFace faceMaker(polyMaker.Wire());
      if (!faceMaker.IsDone()) {
        result.errorCode = "GE_POLYGON_BUILD_FAILED";
        result.message = "failed to build a face for region panel " + panel.regionPanelId;
        return result;
      }

      // Phase 5 Slice 9a: punch each hole belonging to this panel (already
      // resolved by RegionOf, never re-derived here) into the same face,
      // before thickening — so the constructed 3D solid matches the flat
      // pattern it was cut from exactly (constitution P3/L1: one geometric
      // solution, never a solid that silently disagrees with its own flat
      // pattern). Hole wires are stored/generated with the opposite winding
      // from the outer wire, OCCT's own convention for a face's inner loops.
      for (const auto& holeRing : panel.rawPolygonHoles) {
        BRepBuilderAPI_MakePolygon holePolyMaker;
        for (const auto& v : holeRing) {
          holePolyMaker.Add(gp_Pnt(v.x, v.y, 0.0));
        }
        holePolyMaker.Close();
        if (!holePolyMaker.IsDone()) {
          result.errorCode = "GE_POLYGON_BUILD_FAILED";
          result.message = "failed to build a hole wire for region panel " + panel.regionPanelId;
          return result;
        }
        faceMaker.Add(holePolyMaker.Wire());
      }
      for (const auto& circleHole : panel.rawCircleHoles) {
        // -Z axis direction winds the circle CW as seen from +Z, opposite the
        // outer wire's CCW — a true circular wire, never tessellated.
        gp_Circ circ(gp_Ax2(gp_Pnt(circleHole.center.x, circleHole.center.y, 0.0),
                             gp_Dir(0.0, 0.0, -1.0)),
                     circleHole.radiusMm);
        BRepBuilderAPI_MakeEdge edgeMaker(circ);
        if (!edgeMaker.IsDone()) {
          result.errorCode = "GE_POLYGON_BUILD_FAILED";
          result.message = "failed to build a circular hole edge for region panel " +
                            panel.regionPanelId;
          return result;
        }
        BRepBuilderAPI_MakeWire circleWireMaker(edgeMaker.Edge());
        if (!circleWireMaker.IsDone()) {
          result.errorCode = "GE_POLYGON_BUILD_FAILED";
          result.message = "failed to build a circular hole wire for region panel " +
                            panel.regionPanelId;
          return result;
        }
        faceMaker.Add(circleWireMaker.Wire());
      }

      BRepPrimAPI_MakePrism prism(faceMaker.Face(), gp_Vec(0.0, 0.0, thicknessMm), true);
      if (!prism.IsDone() || prism.Shape().IsNull()) {
        result.errorCode = "GE_EXTRUDE_FAILED";
        result.message = "failed to thicken region panel " + panel.regionPanelId;
        return result;
      }

      gp_Trsf worldTrsf = ToGpTrsf(panel.pose);
      BRepBuilderAPI_Transform placed(prism.Shape(), worldTrsf, /*Copy=*/true);
      TopoDS_Shape panelSolid = placed.Shape();

      // Fuse on the setback-extension sliver for any bend where this panel's
      // own material falls short of the true tangent line (see
      // BuildSetbackExtensionRing's own header comment) — built in the same
      // local frame and posed with the exact same transform as the wall
      // above, so the two meet exactly, no seam.
      for (const auto& bridge : layout.bridges) {
        std::vector<Point2> extRing = BuildSetbackExtensionRing(panel, bridge);
        if (extRing.empty()) continue;

        BRepBuilderAPI_MakePolygon extPolyMaker;
        for (const auto& v : extRing) {
          extPolyMaker.Add(gp_Pnt(v.x, v.y, 0.0));
        }
        extPolyMaker.Close();
        if (!extPolyMaker.IsDone()) {
          result.errorCode = "GE_POLYGON_BUILD_FAILED";
          result.message = "failed to build the setback-extension wire for region panel " +
                            panel.regionPanelId + " on bend " + bridge.bendId;
          return result;
        }
        BRepBuilderAPI_MakeFace extFaceMaker(extPolyMaker.Wire());
        if (!extFaceMaker.IsDone()) {
          result.errorCode = "GE_POLYGON_BUILD_FAILED";
          result.message = "failed to build the setback-extension face for region panel " +
                            panel.regionPanelId + " on bend " + bridge.bendId;
          return result;
        }
        BRepPrimAPI_MakePrism extPrism(extFaceMaker.Face(), gp_Vec(0.0, 0.0, thicknessMm), true);
        if (!extPrism.IsDone() || extPrism.Shape().IsNull()) {
          result.errorCode = "GE_EXTRUDE_FAILED";
          result.message = "failed to thicken the setback-extension for region panel " +
                            panel.regionPanelId + " on bend " + bridge.bendId;
          return result;
        }
        BRepBuilderAPI_Transform extPlaced(extPrism.Shape(), worldTrsf, /*Copy=*/true);

        BRepAlgoAPI_Fuse extFuser(panelSolid, extPlaced.Shape());
        extFuser.SetFuzzyValue(kBooleanFuzzMm);
        extFuser.Build();
        if (!extFuser.IsDone()) {
          result.errorCode = "GE_CONSTRUCTION_FAILED";
          result.message = "failed to fuse the setback-extension onto region panel " +
                            panel.regionPanelId + " for bend " + bridge.bendId;
          return result;
        }
        panelSolid = extFuser.Shape();
      }

      panelSolidById[panel.regionPanelId] = panelSolid;
    }

    // Each bend contributes a real bridge solid: the tangent-preserving
    // revolve between the parent's and child's true tangent quads
    // (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md).
    // No separate "collar" piece — the panel walls above are already
    // trimmed back to their own true tangent line (TrimToTangentLines), so
    // the wall's own edge lands exactly where this revolve starts/ends, on
    // both sides, with nothing left to fill. (A previous version of this
    // fix used a flat collar to close the gap left by an UN-trimmed wall —
    // once the wall trim landed, that collar became not just redundant but
    // actively wrong: it kept using the wall's own OLD, untrimmed edge
    // point as one of its corners, which sits farther from the axis than
    // the true radius, so the collar itself protruded past the bend's real
    // rounded surface — confirmed live, visually, in Form.AI.tion, and by
    // the permanent regression test below that subtracts the bend's own
    // true-radius cylinder and checks exactly two solids remain.)
    std::unordered_map<std::string, TopoDS_Shape> bridgeSolidByBendId;
    for (const auto& bridge : layout.bridges) {
      auto parentIt = panelById.find(bridge.parentRegionPanelId);
      if (parentIt == panelById.end()) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "bridge " + bridge.bendId + " references unknown parent region panel " +
                          bridge.parentRegionPanelId;
        return result;
      }
      const RegionPanelLayout& parent = *parentIt->second;
      int edgeIdx = FindZoneEdge(parent, bridge.bendId);
      if (edgeIdx == -1) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "no zone-boundary edge tagged for bend " + bridge.bendId +
                          " on region panel " + parent.regionPanelId;
        return result;
      }
      if (edgeIdx == -2) {
        result.errorCode = "GE_BRIDGE_UNSUPPORTED_TOPOLOGY";
        result.message = "bend " + bridge.bendId + "'s zone boundary spans more than one edge "
                          "on region panel " + parent.regionPanelId + " — only a single-edge "
                          "zone boundary is supported this slice";
        return result;
      }

      auto parentChildIt = panelById.find(bridge.childRegionPanelId);
      if (parentChildIt == panelById.end()) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "bridge " + bridge.bendId + " references unknown child region panel " +
                          bridge.childRegionPanelId;
        return result;
      }
      const RegionPanelLayout& child = *parentChildIt->second;
      int childEdgeIdx = FindZoneEdge(child, bridge.bendId);
      if (childEdgeIdx == -1) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "no zone-boundary edge tagged for bend " + bridge.bendId +
                          " on region panel " + child.regionPanelId;
        return result;
      }
      if (childEdgeIdx == -2) {
        result.errorCode = "GE_BRIDGE_UNSUPPORTED_TOPOLOGY";
        result.message = "bend " + bridge.bendId + "'s zone boundary spans more than one edge "
                          "on region panel " + child.regionPanelId + " — only a single-edge "
                          "zone boundary is supported this slice";
        return result;
      }

      size_t i0 = static_cast<size_t>(edgeIdx);
      size_t i1 = (i0 + 1) % parent.rawOuter.size();
      Point3 b0 = parent.bottomFace[i0];
      Point3 b1 = parent.bottomFace[i1];
      Point3 t1 = parent.topFace[i1];
      Point3 t0 = parent.topFace[i0];

      size_t j0 = static_cast<size_t>(childEdgeIdx);
      size_t j1 = (j0 + 1) % child.rawOuter.size();
      Point3 cb0 = child.bottomFace[j0];
      Point3 cb1 = child.bottomFace[j1];

      // Each side's tangent points, derived directly from its own REAL
      // (RegionOf-clipped) edge corners — see BridgeLayout's own header
      // comment on why hingeA/hingeB-based absolute positions can't be
      // used here (exaggerated half-span, doesn't match a real edge).
      auto plus = [](const Point3& p, const Point3& v, double s) -> Point3 {
        return {p.x + s * v.x, p.y + s * v.y, p.z + s * v.z};
      };
      Point3 parentTanB0 = plus(b0, bridge.nLeftWorld, bridge.setbackMm);
      Point3 parentTanB1 = plus(b1, bridge.nLeftWorld, bridge.setbackMm);
      Point3 parentTanT0 = plus(t0, bridge.nLeftWorld, bridge.setbackMm);
      Point3 parentTanT1 = plus(t1, bridge.nLeftWorld, bridge.setbackMm);
      Point3 childTanB0 = plus(cb0, bridge.childNLeftWorld, -bridge.setbackMm);
      Point3 childTanB1 = plus(cb1, bridge.childNLeftWorld, -bridge.setbackMm);

      // Tangent-preserving revolve between the parent and child tangent
      // quads — BRepPrimAPI_MakeRevol requires a non-negative angle in
      // [0, 2*Pi]; a negative bend angle (valley fold) is realized by
      // reversing the axis direction instead (RH-rule about -axis by
      // +angle == RH-rule about +axis by -angle).
      BRepBuilderAPI_MakePolygon quadMaker;
      quadMaker.Add(gp_Pnt(parentTanB0.x, parentTanB0.y, parentTanB0.z));
      quadMaker.Add(gp_Pnt(parentTanB1.x, parentTanB1.y, parentTanB1.z));
      quadMaker.Add(gp_Pnt(parentTanT1.x, parentTanT1.y, parentTanT1.z));
      quadMaker.Add(gp_Pnt(parentTanT0.x, parentTanT0.y, parentTanT0.z));
      quadMaker.Close();
      if (!quadMaker.IsDone()) {
        result.errorCode = "GE_BRIDGE_BUILD_FAILED";
        result.message = "failed to build the zone-boundary quad wire for bend " + bridge.bendId;
        return result;
      }
      BRepBuilderAPI_MakeFace quadFace(quadMaker.Wire());
      if (!quadFace.IsDone()) {
        result.errorCode = "GE_BRIDGE_BUILD_FAILED";
        result.message = "failed to build the zone-boundary quad face for bend " + bridge.bendId;
        return result;
      }
      double angleRad = bridge.angleDeg * kPi / 180.0;
      gp_Pnt axisOrigin(bridge.pivotOriginWorld.x, bridge.pivotOriginWorld.y,
                         bridge.pivotOriginWorld.z);
      gp_Dir axisDir(bridge.pivotAxisWorld.x, bridge.pivotAxisWorld.y, bridge.pivotAxisWorld.z);
      if (angleRad < 0.0) {
        axisDir.Reverse();
        angleRad = -angleRad;
      }
      gp_Ax1 axis(axisOrigin, axisDir);
      BRepPrimAPI_MakeRevol revol(quadFace.Face(), axis, angleRad, /*Copy=*/Standard_False);
      if (!revol.IsDone() || revol.Shape().IsNull()) {
        result.errorCode = "GE_BRIDGE_BUILD_FAILED";
        result.message = "failed to revolve the bridge solid for bend " + bridge.bendId;
        return result;
      }
      bridgeSolidByBendId[bridge.bendId] = revol.Shape();
    }

    // Fuse in parent-panel -> bridge -> child-panel order (not "all panels
    // then all bridges") — an un-bridged panel pair may not touch or overlap
    // at all, so fusing two panels before their connecting bridge exists
    // would spuriously report a disconnected result. `layout.panels[0]` is
    // the root (Evaluate()'s own BFS always visits it first); walking
    // `layout.bridges` in parent-before-child order (also guaranteed by that
    // same BFS) interleaves each bridge between its parent and child panel
    // correctly, including for a tree with branching, not just a straight
    // chain.
    std::vector<TopoDS_Shape> orderedPieces;
    orderedPieces.reserve(layout.panels.size() + layout.bridges.size());
    orderedPieces.push_back(panelSolidById.at(layout.panels[0].regionPanelId));
    for (const auto& bridge : layout.bridges) {
      orderedPieces.push_back(bridgeSolidByBendId.at(bridge.bendId));
      orderedPieces.push_back(panelSolidById.at(bridge.childRegionPanelId));
    }

    TopoDS_Shape currentShape = orderedPieces[0];
    for (size_t i = 1; i < orderedPieces.size(); ++i) {
      BRepAlgoAPI_Fuse fuser(currentShape, orderedPieces[i]);
      fuser.SetFuzzyValue(kBooleanFuzzMm);
      fuser.Build();
      if (!fuser.IsDone()) {
        result.errorCode = "GE_CONSTRUCTION_FAILED";
        result.message = "boolean fuse failed joining piece index " + std::to_string(i);
        return result;
      }

      TopoDS_Shape nextShape = fuser.Shape();
      BRepCheck_Analyzer checker(nextShape);
      if (!checker.IsValid()) {
        result.errorCode = "GE_CONSTRUCTION_FAILED";
        result.message = "fuse result is invalid after joining piece index " + std::to_string(i);
        return result;
      }

      // BRepAlgoAPI_Fuse always returns a COMPOUND wrapper, even for a single
      // connected solid result — unwrap to the bare solid, matching the existing
      // fuseBodies() reference pattern (geometry_service_booleans.cc).
      if (nextShape.ShapeType() != TopAbs_SOLID) {
        TopoDS_Solid theSolid;
        int solidCount = 0;
        for (TopExp_Explorer ex(nextShape, TopAbs_SOLID); ex.More(); ex.Next()) {
          theSolid = TopoDS::Solid(ex.Current());
          ++solidCount;
        }
        if (solidCount == 1) {
          nextShape = theSolid;
        } else {
          result.errorCode = "GE_CONSTRUCTION_FAILED";
          result.message = "fuse produced " + std::to_string(solidCount) +
                            " disconnected solid(s) joining piece index " + std::to_string(i) +
                            " — every panel/bridge pair is expected to share a coincident face";
          return result;
        }
      }
      currentShape = nextShape;
    }

    // Merge coplanar face fragments the fuse sequence leaves behind at internal
    // seams — matches the existing fuseBodies() reference pattern exactly
    // (unifyFaces=true, unifyEdges=false; geometry_service_booleans.cc).
    ShapeUpgrade_UnifySameDomain unifier(currentShape, /*unifyEdges=*/Standard_False,
                                          /*unifyFaces=*/Standard_True,
                                          /*concatBSplines=*/Standard_False);
    unifier.Build();
    currentShape = unifier.Shape();

    std::string id = generateUUID();
    std::lock_guard<std::mutex> lock(state.mutex);
    if (currentShape.ShapeType() == TopAbs_SOLID) {
      state.solids[id] = SolidState{id, currentShape};
    } else {
      state.shells[id] = ShellState{id, "", currentShape};
    }

    result.ok = true;
    result.shellId = id;
    return result;

  } catch (const Standard_Failure& e) {
    result.errorCode = "GE_CONSTRUCTION_FAILED";
    result.message = std::string("part solid construction failed: ") + e.GetMessageString();
    return result;
  }
}

}  // namespace mcp_cad::translation
