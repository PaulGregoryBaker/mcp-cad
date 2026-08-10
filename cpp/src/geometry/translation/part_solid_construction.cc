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

// Below this, the parent panel's own (BA/2-clipped) boundary and the true
// tangent line at the raw hinge are considered coincident — no collar is
// needed (see the bridge-loop comment below). A geometric-robustness floor
// (floating-point noise), not a manufacturing tolerance: real bend
// allowance at any authored radiusMm>0 is orders of magnitude above this.
constexpr double kCollarGapEpsilonMm = 1e-6;

double Dist2(const Point2& a, const Point2& b) {
  return std::hypot(a.x - b.x, a.y - b.y);
}

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
    std::unordered_map<std::string, TopoDS_Shape> panelSolidById;
    for (const auto& panel : layout.panels) {
      BRepBuilderAPI_MakePolygon polyMaker;
      for (const auto& v : panel.regionOuter) {
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
      for (const auto& holeRing : panel.regionPolygonHoles) {
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
      for (const auto& circleHole : panel.regionCircleHoles) {
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
      panelSolidById[panel.regionPanelId] = placed.Shape();
    }

    // Each bend contributes a real bridge solid: the zone's own material, built
    // by revolving a zone-boundary quad about the bend's own pivot axis through
    // the full bend angle. That quad is anchored at the TRUE tangent line — the
    // raw hinge (bridge.hingeA/hingeB), transformed by the parent panel's own
    // pose — not at the parent's own (BA/2-clipped) region boundary. The child
    // panel's pose was derived from this exact same pivot (manufacturing_graph_
    // evaluator.cc's Evaluate(), via its childShift cancellation), so the
    // revolve's end-cap coincides exactly with the child's own zone-boundary
    // quad at any radius, not just radiusMm=0.
    //
    // The parent's own panel solid, though, is built from its BA/2-clipped
    // regionOuter (unchanged, above) — which stops SHORT of the true tangent
    // line by that same half-width whenever BA>0 (radiusMm>0 or kFactor>0).
    // Unlike the child side, a panel can be parent to more than one bend, so
    // there's no single per-panel pose shift that could close this gap for all
    // of them at once — each bridge instead gets its own small flat COLLAR
    // solid, spanning from the parent's clipped edge to the true tangent line,
    // closing that gap locally. At BA=0 (sharp fold) the gap is exactly zero and
    // no collar is built (docs/BUG_REPORT_nonzero_default_bend_radius_breaks_
    // mesh_construction.md — a nonzero radius previously left this gap open,
    // producing disconnected solids for any panel with more than one child).
    std::unordered_map<std::string, TopoDS_Shape> bridgeSolidByBendId;
    std::unordered_map<std::string, TopoDS_Shape> collarSolidByBendId;
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

      size_t i0 = static_cast<size_t>(edgeIdx);
      size_t i1 = (i0 + 1) % parent.regionOuter.size();
      const Point2& e0 = parent.regionOuter[i0];
      const Point2& e1 = parent.regionOuter[i1];

      // The true tangent line, at the SAME along-hinge position as e0/e1 —
      // found by undoing the parent-side BA/2 perpendicular offset
      // BoundingBends applied when clipping the parent's own region (never
      // by using BendSpec::hingeA/hingeB's own endpoints directly, which are
      // deliberately authored longer than the panel they bound and have no
      // per-vertex correspondence to e0/e1).
      Point2 tangentAtE0{e0.x + bridge.parentTangentOffsetLocal.x,
                          e0.y + bridge.parentTangentOffsetLocal.y};
      Point2 tangentAtE1{e1.x + bridge.parentTangentOffsetLocal.x,
                          e1.y + bridge.parentTangentOffsetLocal.y};

      Point3 tb0 = parent.pose.Apply({tangentAtE0.x, tangentAtE0.y, 0.0});
      Point3 tb1 = parent.pose.Apply({tangentAtE1.x, tangentAtE1.y, 0.0});
      Point3 tt1 = parent.pose.Apply({tangentAtE1.x, tangentAtE1.y, thicknessMm});
      Point3 tt0 = parent.pose.Apply({tangentAtE0.x, tangentAtE0.y, thicknessMm});

      BRepBuilderAPI_MakePolygon quadMaker;
      quadMaker.Add(gp_Pnt(tb0.x, tb0.y, tb0.z));
      quadMaker.Add(gp_Pnt(tb1.x, tb1.y, tb1.z));
      quadMaker.Add(gp_Pnt(tt1.x, tt1.y, tt1.z));
      quadMaker.Add(gp_Pnt(tt0.x, tt0.y, tt0.z));
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

      // BRepPrimAPI_MakeRevol requires a non-negative angle in [0, 2*Pi] — a
      // negative bend angle (valley fold) is realized by reversing the axis
      // direction instead, which is the identical rotation (RH-rule about -axis
      // by +angle == RH-rule about +axis by -angle).
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

      if (Dist2(e0, tangentAtE0) > kCollarGapEpsilonMm) {
        BRepBuilderAPI_MakePolygon collarPolyMaker;
        collarPolyMaker.Add(gp_Pnt(e0.x, e0.y, 0.0));
        collarPolyMaker.Add(gp_Pnt(e1.x, e1.y, 0.0));
        collarPolyMaker.Add(gp_Pnt(tangentAtE1.x, tangentAtE1.y, 0.0));
        collarPolyMaker.Add(gp_Pnt(tangentAtE0.x, tangentAtE0.y, 0.0));
        collarPolyMaker.Close();
        if (!collarPolyMaker.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to build the parent-side collar wire for bend " + bridge.bendId;
          return result;
        }

        BRepBuilderAPI_MakeFace collarFace(collarPolyMaker.Wire());
        if (!collarFace.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to build the parent-side collar face for bend " + bridge.bendId;
          return result;
        }

        BRepPrimAPI_MakePrism collarPrism(collarFace.Face(), gp_Vec(0.0, 0.0, thicknessMm), true);
        if (!collarPrism.IsDone() || collarPrism.Shape().IsNull()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to thicken the parent-side collar for bend " + bridge.bendId;
          return result;
        }

        gp_Trsf parentTrsf = ToGpTrsf(parent.pose);
        BRepBuilderAPI_Transform placedCollar(collarPrism.Shape(), parentTrsf, /*Copy=*/true);
        collarSolidByBendId[bridge.bendId] = placedCollar.Shape();
      }
    }

    // Fuse in parent-panel -> bridge -> child-panel order (not "all panels then
    // all bridges") — an un-bridged panel pair may not touch or overlap at all
    // once BA>0, so fusing two panels before their connecting bridge exists would
    // spuriously report a disconnected result. `layout.panels[0]` is the root
    // (Evaluate()'s own BFS always visits it first); walking `layout.bridges` in
    // parent-before-child order (also guaranteed by that same BFS) interleaves
    // each bridge between its parent and child panel correctly, including for a
    // tree with branching, not just a straight chain.
    std::vector<TopoDS_Shape> orderedPieces;
    orderedPieces.reserve(layout.panels.size() + layout.bridges.size() +
                           collarSolidByBendId.size());
    orderedPieces.push_back(panelSolidById.at(layout.panels[0].regionPanelId));
    for (const auto& bridge : layout.bridges) {
      auto collarIt = collarSolidByBendId.find(bridge.bendId);
      if (collarIt != collarSolidByBendId.end()) {
        orderedPieces.push_back(collarIt->second);
      }
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
                            " of " + std::to_string(orderedPieces.size()) +
                            " (collars=" + std::to_string(collarSolidByBendId.size()) +
                            ") — every panel/bridge pair is expected to share a coincident face";
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
