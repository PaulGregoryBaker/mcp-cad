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
#include <iostream>
#include <unordered_map>

namespace mcp_cad::translation {

namespace {

// Local, named numerical-robustness constant (constitution v2.0.0 principle V's
// distinction: this never varies by project). Matches the corrected (post-
// 0.15mm-bug) relative-fuzz value documented in rebuild/12-domain-notes.md §2 /
// rebuild/17-numerical-policy.md §2.1.
constexpr double kBooleanFuzzMm = 1e-5;
constexpr double kPi = 3.14159265358979323846;

double Dist3(const Point3& a, const Point3& b) {
  double dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return std::sqrt(dx * dx + dy * dy + dz * dz);
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
      for (const auto& v : panel.rawOuter) {
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
      panelSolidById[panel.regionPanelId] = placed.Shape();
    }

    // Each bend contributes a real bridge solid, built in three pieces
    // (docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md):
    // the parent's and child's own real walls are deliberately left
    // un-trimmed (RegionOf/BoundingBends stay zero-offset, for the flat-
    // pattern/DXF side), but the axis now sits `setbackMm` in-plane off the
    // raw hinge, so those real walls no longer reach the axis's own tangent
    // points. A flat "collar" slab closes each side's own gap: one from the
    // parent's real edge out to its true tangent quad
    // (parentTangent{Bottom,Top}{A,B}), the real tangent-preserving revolve
    // between the parent and child tangent quads, and a matching collar
    // from the child's true tangent quad to the child's own real edge.
    // Skipped (falls back to the direct revolve, as before) at radiusMm=0 /
    // kFactor=0, where every tangent quad coincides exactly with its real
    // edge and a collar would be a degenerate, zero-volume slab.
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
      Point3 ct1 = child.topFace[j1];
      Point3 ct0 = child.topFace[j0];

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

      // Extrude a planar quad (given in perimeter order) by a world-space
      // vector — the same "2D outline + thickness vector" shape the panel
      // prisms above use, just built directly in world space (these
      // corners are already-posed panel/tangent points, not a fresh local
      // 2D outline needing its own pose transform afterward).
      auto extrudeQuad = [&](const Point3& p0, const Point3& p1, const Point3& p2, const Point3& p3,
                              const Point3& vec, const char* label) -> TopoDS_Shape {
        BRepBuilderAPI_MakePolygon quadMaker;
        quadMaker.Add(gp_Pnt(p0.x, p0.y, p0.z));
        quadMaker.Add(gp_Pnt(p1.x, p1.y, p1.z));
        quadMaker.Add(gp_Pnt(p2.x, p2.y, p2.z));
        quadMaker.Add(gp_Pnt(p3.x, p3.y, p3.z));
        quadMaker.Close();
        if (!quadMaker.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = std::string("failed to build the ") + label + " quad wire for bend " +
                            bridge.bendId;
          return {};
        }
        BRepBuilderAPI_MakeFace quadFace(quadMaker.Wire());
        if (!quadFace.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = std::string("failed to build the ") + label + " quad face for bend " +
                            bridge.bendId;
          return {};
        }
        BRepPrimAPI_MakePrism prism(quadFace.Face(), gp_Vec(vec.x, vec.y, vec.z), true);
        if (!prism.IsDone() || prism.Shape().IsNull()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = std::string("failed to extrude the ") + label + " for bend " + bridge.bendId;
          return {};
        }
        return prism.Shape();
      };

      constexpr double kCollarLengthEpsilon = 1e-9;
      bool parentCollarNeeded = Dist3(b0, parentTanB0) > kCollarLengthEpsilon;
      bool childCollarNeeded = Dist3(childTanB0, cb0) > kCollarLengthEpsilon;

      std::vector<TopoDS_Shape> bridgePieces;

      if (parentCollarNeeded) {
        Point3 vec{t0.x - b0.x, t0.y - b0.y, t0.z - b0.z};
        TopoDS_Shape collar = extrudeQuad(b0, b1, parentTanB1, parentTanB0, vec, "parent collar");
        if (collar.IsNull()) return result;
        bridgePieces.push_back(collar);
      }

      // Real, tangent-preserving revolve between the parent and child
      // tangent quads — BRepPrimAPI_MakeRevol requires a non-negative angle
      // in [0, 2*Pi]; a negative bend angle (valley fold) is realized by
      // reversing the axis direction instead (RH-rule about -axis by
      // +angle == RH-rule about +axis by -angle).
      {
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
        bridgePieces.push_back(revol.Shape());
      }

      if (childCollarNeeded) {
        Point3 vec{ct0.x - cb0.x, ct0.y - cb0.y, ct0.z - cb0.z};
        TopoDS_Shape collar = extrudeQuad(childTanB0, childTanB1, cb1, cb0, vec, "child collar");
        if (collar.IsNull()) return result;
        bridgePieces.push_back(collar);
      }

      TopoDS_Shape bridgeShape = bridgePieces[0];
      for (size_t k = 1; k < bridgePieces.size(); ++k) {
        BRepAlgoAPI_Fuse fuser(bridgeShape, bridgePieces[k]);
        fuser.SetFuzzyValue(kBooleanFuzzMm);
        fuser.Build();
        if (!fuser.IsDone()) {
          result.errorCode = "GE_BRIDGE_BUILD_FAILED";
          result.message = "failed to fuse the collar/revolve pieces for bend " + bridge.bendId;
          return result;
        }
        bridgeShape = fuser.Shape();
      }
      bridgeSolidByBendId[bridge.bendId] = bridgeShape;
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
