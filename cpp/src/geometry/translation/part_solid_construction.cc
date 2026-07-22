#include "part_solid_construction.hpp"
#include "../geometry_service_impl.hpp"
#include "../geometry_service_utils.hpp"

#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
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
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>
#include <Standard_Failure.hxx>

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
    // by revolving the parent panel's zone-boundary quad (bottomFace/topFace at
    // the edge tagged with this bend's id — both already world-space, no further
    // transform needed) about the bend's own pivot axis through the full bend
    // angle. The child panel's pose was derived from this exact same pivot/shift
    // (manufacturing_graph_evaluator.cc's Evaluate()), so the revolve's end-cap
    // coincides exactly with the child's own zone-boundary quad — not an
    // approximate overlap, a shared face.
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

      size_t i0 = static_cast<size_t>(edgeIdx);
      size_t i1 = (i0 + 1) % parent.regionOuter.size();
      const Point3& b0 = parent.bottomFace[i0];
      const Point3& b1 = parent.bottomFace[i1];
      const Point3& t1 = parent.topFace[i1];
      const Point3& t0 = parent.topFace[i0];

      BRepBuilderAPI_MakePolygon quadMaker;
      quadMaker.Add(gp_Pnt(b0.x, b0.y, b0.z));
      quadMaker.Add(gp_Pnt(b1.x, b1.y, b1.z));
      quadMaker.Add(gp_Pnt(t1.x, t1.y, t1.z));
      quadMaker.Add(gp_Pnt(t0.x, t0.y, t0.z));
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
