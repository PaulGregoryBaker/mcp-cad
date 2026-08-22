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

// Local, named numerical-robustness constant, shared by FindZoneEdges below
// and the wall-solid trim section further down (see that section's own
// header comment for why this file deliberately doesn't share code with
// manufacturing_graph_evaluator.cc's own version of the same idea).
constexpr double kClipEpsilon = 1e-9;

// Locates every rawOuter edge of `panel` whose edgeBendId matches `bendId` —
// the parent panel's own zone-boundary quads, which the bridge's revolve
// profiles are built from (one quad per edge; RegionOf's own tagging pass
// already established that a bend's true zone can legitimately span several
// edges — a faceted ring touching another faceted ring along more than one
// facet — not just the single straight edge a simple rectangular clip
// happens to yield). Zero-length edges (RegionOf's clip can leave a
// duplicate-point, zero-length edge tagged at a seam between two other
// bends) are skipped — they carry no real material, and a quad built from a
// zero-length edge would be degenerate. Returned in `panel.rawOuter`'s own
// winding order.
std::vector<size_t> FindZoneEdges(const RegionPanelLayout& panel, const std::string& bendId) {
  std::vector<size_t> found;
  size_t n = panel.rawOuter.size();
  for (size_t i = 0; i < panel.edgeBendId.size(); ++i) {
    if (panel.edgeBendId[i] != bendId) continue;
    const Point2& a = panel.rawOuter[i];
    const Point2& b = panel.rawOuter[(i + 1) % n];
    double dx = b.x - a.x, dy = b.y - a.y;
    if (dx * dx + dy * dy < kClipEpsilon * kClipEpsilon) continue;  // zero-length, skip
    found.push_back(i);
  }
  return found;
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
    // The wall itself is built from `panel.wallOuter` — RegionOf's own
    // setback-trimmed region — not `panel.rawOuter` (which stays the raw,
    // zero-offset shape for its own separate consumers: bottomFace/topFace,
    // point_mapping.cc, and this file's own bridge-construction loop below,
    // which already adds setback on top of rawOuter's bottomFace/topFace
    // explicitly — see RegionPanelLayout's own header comment). wallOuter's
    // own edge lands where the bridge's tangent quad does, not out at the
    // sharp-corner position an untrimmed wall would sit at.
    std::unordered_map<std::string, TopoDS_Shape> panelSolidById;
    for (const auto& panel : layout.panels) {
      if (panel.wallOuter.size() < 3) {
        result.errorCode = "GE_POLYGON_BUILD_FAILED";
        result.message = "region panel " + panel.regionPanelId + " has fewer than 3 vertices";
        return result;
      }
      BRepBuilderAPI_MakePolygon polyMaker;
      for (const auto& v : panel.wallOuter) {
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
      for (const auto& holeRing : panel.wallPolygonHoles) {
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
      for (const auto& circleHole : panel.wallCircleHoles) {
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

      panelSolidById[panel.regionPanelId] = panelSolid;
    }

    // Each bend contributes a real bridge solid: the tangent-preserving
    // revolve between the parent's and child's true tangent quads
    // (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md).
    // No separate "collar" piece — the panel walls above are already
    // trimmed back to their own true tangent line (RegionOf's own bend-cut
    // extraction now does this at the source, in manufacturing_graph_
    // evaluator.cc, rather than as a separate later pass), so the wall's own
    // edge lands exactly where this revolve starts/ends, on both sides, with
    // nothing left to fill. (A previous version of this
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
      std::vector<size_t> parentEdges = FindZoneEdges(parent, bridge.bendId);
      if (parentEdges.empty()) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "no zone-boundary edge tagged for bend " + bridge.bendId +
                          " on region panel " + parent.regionPanelId;
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

      // Presence-only check: the child must border this bend SOMEWHERE, but
      // its own edge(s) aren't used for geometry below — every bridge
      // segment is built purely from the parent's own tangent quad, and the
      // revolve produces the correctly-positioned child-side connection via
      // rotation (the two are guaranteed coincident by construction — the
      // pose walk derived the child's own pose from this SAME axis/angle).
      if (FindZoneEdges(child, bridge.bendId).empty()) {
        result.errorCode = "GE_BRIDGE_EDGE_NOT_FOUND";
        result.message = "no zone-boundary edge tagged for bend " + bridge.bendId +
                          " on region panel " + child.regionPanelId;
        return result;
      }

      // One revolve segment per real tagged edge on the parent — a bend's
      // true zone can legitimately span several edges (two faceted rings
      // touching along more than one facet, not just the single straight
      // edge a simple rectangular clip happens to yield), each fused
      // together into this bend's own combined bridge solid below.
      double angleRad0 = bridge.angleDeg * kPi / 180.0;
      gp_Pnt axisOrigin(bridge.pivotOriginWorld.x, bridge.pivotOriginWorld.y,
                         bridge.pivotOriginWorld.z);
      gp_Dir axisDir0(bridge.pivotAxisWorld.x, bridge.pivotAxisWorld.y, bridge.pivotAxisWorld.z);
      if (angleRad0 < 0.0) {
        axisDir0.Reverse();
        angleRad0 = -angleRad0;
      }
      gp_Ax1 axis(axisOrigin, axisDir0);

      TopoDS_Shape bridgeSolid;
      bool bridgeSolidSet = false;
      for (size_t i0 : parentEdges) {
        size_t i1 = (i0 + 1) % parent.rawOuter.size();
        Point3 b0 = parent.bottomFace[i0];
        Point3 b1 = parent.bottomFace[i1];
        Point3 t1 = parent.topFace[i1];
        Point3 t0 = parent.topFace[i0];

        // This edge's own tangent points, derived directly from its own
        // REAL (RegionOf-clipped) edge corners — see BridgeLayout's own
        // header comment on why hingeA/hingeB-based absolute positions
        // can't be used here (exaggerated half-span, doesn't match a real
        // edge).
        auto plus = [](const Point3& p, const Point3& v, double s) -> Point3 {
          return {p.x + s * v.x, p.y + s * v.y, p.z + s * v.z};
        };
        Point3 parentTanB0 = plus(b0, bridge.nLeftWorld, bridge.setbackMm);
        Point3 parentTanB1 = plus(b1, bridge.nLeftWorld, bridge.setbackMm);
        Point3 parentTanT0 = plus(t0, bridge.nLeftWorld, bridge.setbackMm);
        Point3 parentTanT1 = plus(t1, bridge.nLeftWorld, bridge.setbackMm);

        // Tangent-preserving revolve of this edge's own quad —
        // BRepPrimAPI_MakeRevol requires a non-negative angle in
        // [0, 2*Pi]; a negative bend angle (valley fold) is realized by
        // reversing the axis direction instead (RH-rule about -axis by
        // +angle == RH-rule about +axis by -angle) — already folded into
        // `axis` above, shared by every segment of this same bend.
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
        BRepPrimAPI_MakeRevol revol(quadFace.Face(), axis, angleRad0, /*Copy=*/Standard_False);
        if (!revol.IsDone() || revol.Shape().IsNull()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to revolve the bridge solid for bend " + bridge.bendId;
          return result;
        }

        if (!bridgeSolidSet) {
          bridgeSolid = revol.Shape();
          bridgeSolidSet = true;
          continue;
        }
        BRepAlgoAPI_Fuse segFuser(bridgeSolid, revol.Shape());
        segFuser.SetFuzzyValue(kBooleanFuzzMm);
        segFuser.Build();
        if (!segFuser.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to fuse bridge segments together for bend " + bridge.bendId;
          return result;
        }
        bridgeSolid = segFuser.Shape();
      }
      bridgeSolidByBendId[bridge.bendId] = bridgeSolid;
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

    // kJoinRetryFuzzMm: fallback fuzzy value tried only when the tight
    // kBooleanFuzzMm leaves a join's fuse result invalid. Root cause (verified
    // on real cauldron.step data): sub-micron floating-point noise (~2e-4mm at
    // this model's ~3000mm scale) accumulated through a long chained-bend pose
    // walk, not a real geometric feature — ShapeFix_Shape post-hoc healing was
    // tried and empirically does not touch this defect (the shape is already
    // one connected solid, not the free/disconnected sub-shapes it targets).
    // Sheet-metal fabrication can't hold better than ~0.1mm in practice, so
    // 1e-3mm stays ~100x under any achievable real tolerance, and ~150x below
    // the previously-documented 0.15mm value that discarded real kerf-notch
    // detail — retried once, only for the specific join that failed, so every
    // other join keeps the tight kBooleanFuzzMm untouched.
    constexpr double kJoinRetryFuzzMm = 1e-3;

    auto fuseJoin = [](double fuzzMm, const TopoDS_Shape& a, const TopoDS_Shape& b,
                        TopoDS_Shape* outShape, bool* built) -> bool {
      BRepAlgoAPI_Fuse f(a, b);
      f.SetFuzzyValue(fuzzMm);
      f.Build();
      *built = f.IsDone();
      if (!*built) return false;
      *outShape = f.Shape();
      return BRepCheck_Analyzer(*outShape).IsValid();
    };

    TopoDS_Shape currentShape = orderedPieces[0];
    for (size_t i = 1; i < orderedPieces.size(); ++i) {
      TopoDS_Shape nextShape;
      bool built = false;
      bool valid = fuseJoin(kBooleanFuzzMm, currentShape, orderedPieces[i], &nextShape, &built);
      if (built && !valid) {
        valid = fuseJoin(kJoinRetryFuzzMm, currentShape, orderedPieces[i], &nextShape, &built);
      }
      if (!built) {
        result.errorCode = "GE_CONSTRUCTION_FAILED";
        result.message = "boolean fuse failed joining piece index " + std::to_string(i);
        return result;
      }

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
