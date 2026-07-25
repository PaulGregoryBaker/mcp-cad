// ─── OCCT includes (isolated to this translation unit) ───────────────────────
#include <Standard_Failure.hxx>
#include <Standard_ErrorHandler.hxx>

#include <STEPControl_Reader.hxx>
#include <Interface_Static.hxx>
#include <IFSelect_ReturnStatus.hxx>

#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <BRepTools.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepAdaptor_Surface.hxx>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Wire.hxx>

#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ShapeMapHasher.hxx>

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>

#include <Bnd_Box.hxx>
#include <Bnd_OBB.hxx>
#include <BRepBndLib.hxx>

#include <BRepMesh_IncrementalMesh.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>

#include <BRepOffsetAPI_MakeOffset.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Sewing.hxx>

#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Edge.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Wire.hxx>

#include <Geom_Surface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <Geom_BSplineSurface.hxx>

#include <Geom_Curve.hxx>
#include <Geom_Line.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Ellipse.hxx>
#include <Geom_BSplineCurve.hxx>

#include <GProp_GProps.hxx>
#include <BRepGProp.hxx>

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <IntAna_QuadQuadGeo.hxx>
#include <IntAna_ResultType.hxx>
#include <Precision.hxx>
#include <gp_Circ.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <BRepOffset_Mode.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepTools_ReShape.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <TDataStd_Name.hxx>
#include <TCollection_AsciiString.hxx>

#include <BRepBuilderAPI_Transform.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_Location.hxx>
#include <TDF_Label.hxx>
#include <gp_Quaternion.hxx>
#include <BinXCAFDrivers.hxx>

#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>

#include "geometry_service_impl.hpp"
#include "geometry_service_utils.hpp"

// ─── Standard library ─────────────────────────────────────────────────────────
#include <map>
#include <unordered_map>
#include <unordered_set>
#include <memory>
#include <mutex>
#include <sstream>
#include <cmath>
#include <chrono>
#include <random>
#include <algorithm>
#include <array>
#include <set>
#include <iomanip>
#include <functional>
#include <limits>
#include <cstring>
#include <iostream>

namespace mcp_cad {

class GeometrySheetMetal {
public:
  explicit GeometrySheetMetal(GeometryState& s) : s_(s) {}

  // ÔöÇÔöÇ Split body by plane ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  SplitBodyResult splitBodyByPlane(const ShellId& partId,
                                   const CuttingPlane& plane) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto it = s_.shells.find(partId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
    }

    SnapshotId token = s_.createSnapshot("before splitBodyByPlane on " + partId);

    try {
      gp_Pnt origin(plane.originX, plane.originY, plane.originZ);
      double normLen = std::sqrt(plane.normalX * plane.normalX +
                                  plane.normalY * plane.normalY +
                                  plane.normalZ * plane.normalZ);
      if (normLen < 1e-10) {
        throw GeometryError("GE_SPLIT_FAILED", "Plane normal is zero", false, "");
      }
      gp_Dir normal(plane.normalX / normLen, plane.normalY / normLen, plane.normalZ / normLen);
      gp_Pln gPlane(origin, normal);
      BRepBuilderAPI_MakeFace faceMaker(gPlane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face planeFace = faceMaker.Face();
      gp_Vec n(normal);

      TopoDS_Shape inputForHistory = it->second.shape;

      // Positive side = shape minus negative half-space
      gp_Pnt negRefPt = origin.Translated(n * -100.0);
      BRepPrimAPI_MakeHalfSpace negHS(planeFace, negRefPt);
      BRepAlgoAPI_Cut cutPos(it->second.shape, negHS.Solid());
      cutPos.Build();
      if (!cutPos.IsDone() || cutPos.Shape().IsNull()) {
        throw GeometryError("GE_SPLIT_FAILED", "Split positive side failed", true, "rollback");
      }

      // Negative side = shape minus positive half-space
      gp_Pnt posRefPt = origin.Translated(n * 100.0);
      BRepPrimAPI_MakeHalfSpace posHS(planeFace, posRefPt);
      BRepAlgoAPI_Cut cutNeg(it->second.shape, posHS.Solid());
      cutNeg.Build();
      if (!cutNeg.IsDone() || cutNeg.Shape().IsNull()) {
        throw GeometryError("GE_SPLIT_FAILED", "Split negative side failed", true, "rollback");
      }

      GProp_GProps props;
      BRepGProp::VolumeProperties(cutPos.Shape(), props);
      if (props.Mass() < 1e-6) {
        throw GeometryError("GE_SPLIT_FAILED",
                            "Positive side is empty ÔÇö plane may not intersect the body",
                            true, "rollback");
      }
      BRepGProp::VolumeProperties(cutNeg.Shape(), props);
      if (props.Mass() < 1e-6) {
        throw GeometryError("GE_SPLIT_FAILED",
                            "Negative side is empty ÔÇö plane may not intersect the body",
                            true, "rollback");
      }

      ShellId posId = generateUUID();
      ShellId negId = generateUUID();
      s_.shells[posId] = ShellState{posId, it->second.parentSolidId, cutPos.Shape()};
      s_.shells[negId] = ShellState{negId, it->second.parentSolidId, cutNeg.Shape()};

      auto histPos = captureHistory(cutPos, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "splitBodyByPlane");
      auto histNeg = captureHistory(cutNeg, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "splitBodyByPlane");
      histPos.insert(histPos.end(), histNeg.begin(), histNeg.end());
      return SplitBodyResult{posId, negId, token, std::move(histPos)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_SPLIT_FAILED",
                          std::string("OCCT exception during split: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ÔöÇÔöÇ Split body by bends ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  // ÔöÇÔöÇ Helpers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  static double computeDihedralAngle(const TopoDS_Face& fA,
                                      const TopoDS_Face& fB,
                                      const TopoDS_Edge& /*edge*/) {
    // Approximate dihedral via face normals at midpoint
    auto getNormal = [](const TopoDS_Face& f) -> gp_Vec {
      Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
      if (surf.IsNull()) return gp_Vec(0, 0, 1);
      Standard_Real u1, u2, v1, v2;
      BRepTools::UVBounds(f, u1, u2, v1, v2);
      gp_Pnt p; gp_Vec du, dv;
      surf->D1((u1+u2)*0.5, (v1+v2)*0.5, p, du, dv);
      gp_Vec n = du.Crossed(dv);
      if (n.Magnitude() > 1e-10) n.Normalize();
      return n;
    };

    gp_Vec nA = getNormal(fA);
    gp_Vec nB = getNormal(fB);
    double dot = std::clamp(nA.Dot(nB), -1.0, 1.0);
    double angleDeg = std::acos(dot) * 180.0 / M_PI;
    return angleDeg;
  }

  // Detect whether the solid should use Mode 2 (thin-solid cutting) or
  // Mode 1 (surface/conceptual extrusion).
  // Returns "thin_solid" or "surface".
  static std::string detectObjectMode(const TopoDS_Shape& shape, double maxThicknessMm) {
    GProp_GProps volProps;
    BRepGProp::VolumeProperties(shape, volProps);
    if (std::abs(volProps.Mass()) < 1e-6) return "surface";

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);

    for (int i = 1; i <= faceMap.Extent(); ++i) {
      const TopoDS_Face& fA = TopoDS::Face(faceMap(i));
      gp_Vec nA = faceOutwardNormal(fA);
      for (int j = i + 1; j <= faceMap.Extent(); ++j) {
        const TopoDS_Face& fB = TopoDS::Face(faceMap(j));
        gp_Vec nB = faceOutwardNormal(fB);
        if (nA.Dot(nB) >= -0.95) continue;  // not anti-parallel
        BRepExtrema_DistShapeShape dist(fA, fB);
        if (dist.IsDone() && dist.Value() <= maxThicknessMm) return "thin_solid";
      }
    }
    return "surface";
  }

  // BFS face group, returning one coplanar component per entry.
  struct FaceGroup {
    std::vector<int> faceIndices;  // 1-based into faceMap
    gp_Vec  normal;
    gp_Pnt  centroid;
    double  area;
    bool    isOuter;  // N ┬À (centroid - solidCentroid) > 0
  };

  // A candidate face joins a group iff it is COPLANAR with the group's own
  // FIXED seed plane (established once, from the group's first/start face —
  // never re-derived per BFS step): perpendicular distance from every one
  // of the candidate's own vertices to that fixed plane must stay within
  // kCoplanarLinearToleranceMm. This is the physically correct test, not a
  // proxy: two faces genuinely belonging to the SAME flat panel (split by
  // STEP tessellation/faceting) lie on the identical plane to
  // floating-point precision, while two DIFFERENT panels joined at a real
  // fold diverge measurably in perpendicular distance across the panel's
  // own size — even a shallow few-degree fold on a real, human-scale panel
  // produces tens of mm of deviation by its far edge, far beyond this
  // tolerance. An angle-only threshold (the previous approach) can't
  // distinguish that from "same panel, split by tessellation" once a
  // design intentionally uses many panels at shallow (well under any
  // single global angle threshold) mutual folds — confirmed on a real
  // fixture (cauldron.step, a vessel built from many flat panels wrapping
  // its own circumference): several genuinely separate, intentionally-flat
  // panels at shallow mutual angles got transitively flooded into one
  // "panel" group spanning a huge chunk of the vessel, corrupting every
  // downstream panel-face measurement that touched it. Comparing against
  // the group's own FIXED seed plane (not the immediately-preceding BFS
  // neighbour) additionally makes gradual multi-step drift accumulation
  // structurally impossible, not just less likely.
  static bool IsCoplanarWithSeed(const gp_Pnt& seedPoint, const gp_Dir& seedNormal,
                                  const TopoDS_Face& candidate,
                                  double coplanarToleranceMm) {
    for (TopExp_Explorer vExp(candidate, TopAbs_VERTEX); vExp.More(); vExp.Next()) {
      gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vExp.Current()));
      double dist = std::abs(gp_Vec(seedPoint, p).Dot(gp_Vec(seedNormal.XYZ())));
      if (dist > coplanarToleranceMm) return false;
    }
    return true;
  }

  static std::vector<FaceGroup> buildFaceGroups(
      const TopoDS_Shape& shape,
      const TopTools_IndexedMapOfShape& faceMap,
      double angleThresholdDeg,
      const gp_Pnt& solidCentroid)
  {
    constexpr double kCoplanarLinearToleranceMm = 0.1;

    int nFaces = faceMap.Extent();
    TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

    // Topology only here (which faces share an edge with which) — no angle
    // or coplanarity judgment yet; that's decided per-candidate against
    // each GROUP's own fixed seed plane inside the BFS below, not
    // precomputed pairwise between immediate neighbours (see this
    // function's own doc comment above).
    std::vector<std::vector<int>> adjacency(nFaces + 1);
    for (int i = 1; i <= edgeToFaces.Extent(); ++i) {
      const TopTools_ListOfShape& fl = edgeToFaces(i);
      if (fl.Extent() != 2) continue;
      int idxA = faceMap.FindIndex(fl.First());
      int idxB = faceMap.FindIndex(fl.Last());
      if (idxA > 0 && idxB > 0) {
        adjacency[idxA].push_back(idxB);
        adjacency[idxB].push_back(idxA);
      }
    }

    std::vector<bool> visited(nFaces + 1, false);
    std::vector<FaceGroup> groups;

    for (int start = 1; start <= nFaces; ++start) {
      if (visited[start]) continue;
      FaceGroup grp;
      visited[start] = true;

      const TopoDS_Face& seedFace = TopoDS::Face(faceMap(start));
      BRepAdaptor_Surface seedSurf(seedFace, false);
      gp_Pnt seedPoint = seedSurf.Plane().Location();
      gp_Dir seedNormal(faceOutwardNormal(seedFace).XYZ());

      std::vector<int> queue = {start};
      while (!queue.empty()) {
        int cur = queue.back(); queue.pop_back();
        grp.faceIndices.push_back(cur);
        for (int nbr : adjacency[cur]) {
          if (visited[nbr]) continue;
          // Angle kept as an outer sanity gate (still respects the
          // caller's own bend-sharpness intent — e.g. protrusion
          // detection's own semantics elsewhere) but is no longer the
          // primary discriminator; coplanarity below is.
          double angle = computeDihedralAngle(TopoDS::Face(faceMap(cur)),
                                               TopoDS::Face(faceMap(nbr)),
                                               TopoDS_Edge());
          if (angle > angleThresholdDeg) continue;
          if (!IsCoplanarWithSeed(seedPoint, seedNormal, TopoDS::Face(faceMap(nbr)),
                                   kCoplanarLinearToleranceMm)) {
            continue;
          }
          visited[nbr] = true;
          queue.push_back(nbr);
        }
      }

      // Compute normal, area-weighted centroid
      gp_XYZ wc(0, 0, 0);
      double totalArea = 0.0;
      for (int idx : grp.faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        GProp_GProps fp;
        BRepGProp::SurfaceProperties(f, fp);
        double a = fp.Mass();
        totalArea += a;
        wc += fp.CentreOfMass().XYZ().Multiplied(a);
      }
      grp.area = totalArea;
      grp.centroid = (totalArea > 1e-10)
          ? gp_Pnt(wc.Multiplied(1.0 / totalArea))
          : gp_Pnt(0, 0, 0);

      grp.normal = faceOutwardNormal(TopoDS::Face(faceMap(grp.faceIndices[0])));

      // Outer face: outward normal points away from solid centroid
      gp_Vec toCenter(solidCentroid, grp.centroid);
      grp.isOuter = (grp.normal.Dot(toCenter) > 0.0);

      groups.push_back(std::move(grp));
    }
    return groups;
  }

  // ÔöÇÔöÇ Protrusion detection ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  // A connected region of non-primary faces qualifying as a thin localised
  // feature (flange / tab) on a primary panel face.
  struct ProtrusionCandidate {
    std::vector<int> faceIndices;    // 1-based into faceMap
    gp_Pnt           panelCentroid;  // centroid of the hosting primary group
    gp_Vec           panelNormal;    // outward normal of the hosting primary group
    // For plate-style protrusions, the back-face plane bounds the slab on the
    // other side; extractProtrusion uses both planes to isolate the slab.
    bool             hasBackPlane = false;
    gp_Pnt           backCentroid;
    gp_Vec           backNormal;     // points away from the protrusion body

    // For Option-2 interior-host tabs: bounded box scoped to the cap's footprint.
    // When useBoundedTabBox=true, extractProtrusion ignores hasBackPlane and builds
    // a box in the (tabU, tabV, panelNormal) frame, sized to the cap's 2D footprint
    // ├ù tabHeight along panelNormal. This avoids the over-extraction that a half-space
    // would cause when the host is interior to the solid.
    bool             useBoundedTabBox = false;
    gp_Vec           tabU;            // in-plane axis 1 (perpendicular to panelNormal)
    gp_Vec           tabV;            // in-plane axis 2 (perpendicular to panelNormal)
    double           tabUMin = 0.0;
    double           tabUMax = 0.0;
    double           tabVMin = 0.0;
    double           tabVMax = 0.0;
    double           tabHeight = 0.0; // cap-to-host offset along panelNormal
    // When >=0, override the default 0.5 mm pad/bleed used by extractProtrusion.
    // Option-3 bridge flanges sit flush against neighbouring panels; the default
    // pad bleeds into those panels and inflates the extracted protrusion bbox.
    double           tightPad   = -1.0;
    double           tightBleed = -1.0;
  };

  // T017 ÔÇö Detect protrusion candidates before any panel cutting.
  // Applies three tests per connected non-primary-face region:
  //   1. Extent   : attachment edge length < 50% of primary panel perimeter
  //   2. Orientation: cap face normal ┬À panel normal > 0.85
  //   3. Thickness: min face-pair distance in the region Ôëñ maxThicknessMm
  static std::vector<ProtrusionCandidate> detectProtrusions(
      const TopoDS_Shape&              shape,
      const TopTools_IndexedMapOfShape& faceMap,
      const std::vector<FaceGroup>&    groups,
      double                           maxThicknessMm)
  {
    int nFaces = faceMap.Extent();

    // faceToGroup[i] = primary group index for face i, or -1 if non-primary
    std::vector<int> faceToGroup(nFaces + 1, -1);
    for (int g = 0; g < (int)groups.size(); ++g) {
      if (!groups[g].isOuter) continue;
      for (int idx : groups[g].faceIndices)
        faceToGroup[idx] = g;
    }

    // ÔöÇÔöÇ AABB + hull-ratio classification (used by both detection passes) ÔöÇÔöÇ
    // Compute the solid's tight AABB and, for each face group, the fraction of
    // its vertices that touch the AABB boundary. Groups with low hullRatio are
    // "interior" ÔÇö sitting inside the solid rather than on its outer hull.
    // For interior hosts, half-space extraction over-extracts; bounded-box
    // extraction must be used instead.
    double sxMin = 1e30, syMin = 1e30, szMin = 1e30;
    double sxMax = -1e30, syMax = -1e30, szMax = -1e30;
    for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
      gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
      sxMin = std::min(sxMin, p.X()); sxMax = std::max(sxMax, p.X());
      syMin = std::min(syMin, p.Y()); syMax = std::max(syMax, p.Y());
      szMin = std::min(szMin, p.Z()); szMax = std::max(szMax, p.Z());
    }
    constexpr double kHullTol = 0.5;  // mm ÔÇö vertex this close to AABB face = on hull
    auto vertexOnHull = [&](const gp_Pnt& p) {
      return std::abs(p.X() - sxMin) <= kHullTol || std::abs(p.X() - sxMax) <= kHullTol
          || std::abs(p.Y() - syMin) <= kHullTol || std::abs(p.Y() - syMax) <= kHullTol
          || std::abs(p.Z() - szMin) <= kHullTol || std::abs(p.Z() - szMax) <= kHullTol;
    };
    std::vector<double> hullRatio(groups.size(), 0.0);
    for (int g = 0; g < (int)groups.size(); ++g) {
      int onHull = 0, total = 0;
      for (int fi : groups[g].faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
        for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
          ++total;
          if (vertexOnHull(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())))) ++onHull;
        }
      }
      hullRatio[g] = total > 0 ? (double)onHull / total : 0.0;
    }
    constexpr double kInteriorThreshold = 0.50;

    // Helper: project a face's vertices onto a (u, v) plane through `origin`,
    // return the 2D bounding box in (u, v).
    auto projectFootprint = [&](const TopoDS_Face& face, const gp_Pnt& origin,
                                const gp_Vec& u, const gp_Vec& v,
                                double& uMin, double& uMax,
                                double& vMin, double& vMax) {
      uMin = 1e30; uMax = -1e30; vMin = 1e30; vMax = -1e30;
      for (TopExp_Explorer ex(face, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        gp_Vec toP(origin, p);
        double uc = u.Dot(toP);
        double vc = v.Dot(toP);
        uMin = std::min(uMin, uc); uMax = std::max(uMax, uc);
        vMin = std::min(vMin, vc); vMax = std::max(vMax, vc);
      }
    };

    // Helper: build (tabU, tabV) perpendicular to a given normal.
    auto buildInPlaneAxes = [](const gp_Vec& n, gp_Vec& u, gp_Vec& v) -> bool {
      gp_Vec seed = (std::abs(n.X()) < 0.9) ? gp_Vec(1, 0, 0) : gp_Vec(0, 1, 0);
      u = seed - n.Multiplied(n.Dot(seed));
      if (u.Magnitude() < 1e-6) return false;
      u.Normalize();
      v = n.Crossed(u);
      if (v.Magnitude() < 1e-6) return false;
      v.Normalize();
      return true;
    };

    // Build edge-to-faces and face-to-adjacent-faces maps
    TopTools_IndexedDataMapOfShapeListOfShape edgeToFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeToFaces);

    std::vector<std::vector<int>> faceAdj(nFaces + 1);
    for (int e = 1; e <= edgeToFaces.Extent(); ++e) {
      const TopTools_ListOfShape& fl = edgeToFaces(e);
      if (fl.Extent() != 2) continue;
      int idxA = faceMap.FindIndex(fl.First());
      int idxB = faceMap.FindIndex(fl.Last());
      if (idxA > 0 && idxB > 0) {
        faceAdj[idxA].push_back(idxB);
        faceAdj[idxB].push_back(idxA);
      }
    }

    // Per-group: boundary perimeter and attachment edges to non-primary faces
    struct AttachEdge { int nonPrimaryFaceIdx; double length; };
    std::vector<double>                   groupPerimeter(groups.size(), 0.0);
    std::vector<std::vector<AttachEdge>>  groupAttach(groups.size());

    for (int e = 1; e <= edgeToFaces.Extent(); ++e) {
      const TopTools_ListOfShape& fl = edgeToFaces(e);
      if (fl.Extent() != 2) continue;
      int idxA = faceMap.FindIndex(fl.First());
      int idxB = faceMap.FindIndex(fl.Last());
      if (idxA <= 0 || idxB <= 0) continue;
      int gA = faceToGroup[idxA];
      int gB = faceToGroup[idxB];
      if (gA == gB) continue;  // interior to same group or both non-primary

      GProp_GProps lp;
      BRepGProp::LinearProperties(edgeToFaces.FindKey(e), lp);
      double edgeLen = lp.Mass();

      if (gA >= 0) {
        groupPerimeter[gA] += edgeLen;
        if (gB < 0) groupAttach[gA].push_back({idxB, edgeLen});
      }
      if (gB >= 0) {
        groupPerimeter[gB] += edgeLen;
        if (gA < 0) groupAttach[gB].push_back({idxA, edgeLen});
      }
    }

    std::vector<ProtrusionCandidate> candidates;
    std::vector<bool> claimed(nFaces + 1, false);
    std::vector<bool> claimedPanelGroup(groups.size(), false);

    // Precompute face centroids once for use in distance-bounded BFS
    std::vector<gp_Pnt> faceCentroid(nFaces + 1);
    for (int i = 1; i <= nFaces; ++i) {
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(TopoDS::Face(faceMap(i)), fp);
      faceCentroid[i] = fp.CentreOfMass();
    }

    for (int g = 0; g < (int)groups.size(); ++g) {
      if (!groups[g].isOuter || groupAttach[g].empty()) continue;
      if (claimedPanelGroup[g]) continue;

      // Map: non-primary face index ÔåÆ total attachment edge length from group g
      std::unordered_map<int, double> attachLen;
      std::set<int> seeds;
      for (const auto& ae : groupAttach[g]) {
        attachLen[ae.nonPrimaryFaceIdx] += ae.length;
        seeds.insert(ae.nonPrimaryFaceIdx);
      }

      // Flood-fill connected components through non-primary faces
      std::vector<bool> visited(nFaces + 1, false);
      for (int idx : groups[g].faceIndices) visited[idx] = true;  // block primary faces

      for (int seed : seeds) {
        if (visited[seed] || claimed[seed]) continue;

        // BFS bounded by panel-plane distance: only expand into non-outer faces
        // within maxThicknessMm of the outer group's plane (in either direction).
        // This prevents the flood fill from spreading across the entire connected
        // void region and isolates each protrusion's faces.
        const gp_Vec& pNorm = groups[g].normal;
        std::vector<int> component;
        std::vector<int> queue = {seed};
        visited[seed] = true;
        while (!queue.empty()) {
          int cur = queue.back(); queue.pop_back();
          component.push_back(cur);
          for (int nbr : faceAdj[cur]) {
            if (!visited[nbr] && faceToGroup[nbr] < 0 && !claimed[nbr]) {
              gp_Vec toNbr(groups[g].centroid, faceCentroid[nbr]);
              double dist = std::abs(pNorm.Dot(toNbr));
              if (dist > maxThicknessMm + 1.0) continue;
              visited[nbr] = true;
              queue.push_back(nbr);
            }
          }
        }

        // Test 1: Extent ÔÇö total attachment < 50% of primary panel perimeter
        double totalAttach = 0.0;
        for (int fi : component) {
          auto it = attachLen.find(fi);
          if (it != attachLen.end()) totalAttach += it->second;
        }
        double extentRatio = groupPerimeter[g] > 1e-6 ? totalAttach / groupPerimeter[g] : 0.0;
        if (extentRatio >= 0.50) continue;

        // Test 2: Orientation ÔÇö cap face normal ÔêÑ panel normal (dot > 0.85)
        int    capIdx = -1;
        double maxProj = -1e9;
        for (int fi : component) {
          gp_Vec toFace(groups[g].centroid, faceCentroid[fi]);
          double proj = pNorm.Dot(toFace);
          if (proj > maxProj) { maxProj = proj; capIdx = fi; }
        }
        if (capIdx < 0) continue;
        gp_Vec capNorm = faceOutwardNormal(TopoDS::Face(faceMap(capIdx)));

        // Test 3: Thickness ÔÇö protrusion dimension along panel normal Ôëñ maxThicknessMm.
        // Strategy:
        //   (a) Anti-parallel pairs within the component (tab between two opposite faces)
        //   (b) Cap face vs primary panel faces ÔÇö parallel (tab) or anti-parallel (plate)
        //   (c) Cap face vs any other outer group's faces ÔÇö plate-style where the
        //       opposite wide face is in a different group than the entered edge face
        // For (b) and (c), record the matched panel group so the extraction step uses
        // the correct panel orientation (along the plate's thickness, not the edge).
        bool thinEnough = false;
        int matchedPanelGroup = g;
        const TopoDS_Face& capFace = TopoDS::Face(faceMap(capIdx));
        gp_Vec capNormVec = faceOutwardNormal(capFace);
        for (int i = 0; i < (int)component.size() && !thinEnough; ++i) {
          const TopoDS_Face& fI = TopoDS::Face(faceMap(component[i]));
          gp_Vec nI = faceOutwardNormal(fI);
          for (int j = i + 1; j < (int)component.size(); ++j) {
            const TopoDS_Face& fJ = TopoDS::Face(faceMap(component[j]));
            if (nI.Dot(faceOutwardNormal(fJ)) >= -0.95) continue;
            BRepExtrema_DistShapeShape d(fI, fJ);
            if (d.IsDone() && d.Value() <= maxThicknessMm) { thinEnough = true; break; }
          }
        }
        if (!thinEnough) {
          for (int fi : groups[g].faceIndices) {
            const TopoDS_Face& panelF = TopoDS::Face(faceMap(fi));
            gp_Vec pnNorm = faceOutwardNormal(panelF);
            if (std::abs(capNormVec.Dot(pnNorm)) <= 0.85) continue;
            BRepExtrema_DistShapeShape d(capFace, panelF);
            if (d.IsDone() && d.Value() <= maxThicknessMm) { thinEnough = true; break; }
          }
        }
        if (!thinEnough) {
          for (int gi = 0; gi < (int)groups.size() && !thinEnough; ++gi) {
            if (!groups[gi].isOuter || gi == g || claimedPanelGroup[gi]) continue;
            for (int fi : groups[gi].faceIndices) {
              const TopoDS_Face& panelF = TopoDS::Face(faceMap(fi));
              gp_Vec pnNorm = faceOutwardNormal(panelF);
              if (std::abs(capNormVec.Dot(pnNorm)) <= 0.85) continue;
              BRepExtrema_DistShapeShape d(capFace, panelF);
              if (d.IsDone() && d.Value() <= maxThicknessMm) {
                thinEnough = true;
                matchedPanelGroup = gi;
                break;
              }
            }
          }
        }
        if (!thinEnough) continue;

        ProtrusionCandidate pc;
        pc.faceIndices   = component;
        pc.panelCentroid = groups[matchedPanelGroup].centroid;
        pc.panelNormal   = groups[matchedPanelGroup].normal;
        // For plate-style protrusions (when the cap face is anti-parallel to the
        // panel face), we need a back plane to bound the slab thickness.
        // Otherwise the half-space cut takes the entire half-solid.
        if (capNormVec.Dot(pc.panelNormal) < -0.85) {
          pc.hasBackPlane = true;
          pc.backCentroid = faceCentroid[capIdx];
          pc.backNormal   = capNormVec;
        } else if (hullRatio[matchedPanelGroup] < kInteriorThreshold) {
          // Tab-style on an INTERIOR host: half-space extraction would over-extract
          // everything on the +panelNormal side (including outer-hull material that
          // happens to lie beyond the host plane). Use a bounded box scoped to the
          // cap face's footprint instead.
          gp_Vec tabU, tabV;
          if (buildInPlaneAxes(pc.panelNormal, tabU, tabV)) {
            const TopoDS_Face& capFace2 = TopoDS::Face(faceMap(capIdx));
            double uMin, uMax, vMin, vMax;
            projectFootprint(capFace2, pc.panelCentroid, tabU, tabV,
                             uMin, uMax, vMin, vMax);
            if (uMax > uMin && vMax > vMin) {
              gp_Vec hostToCap(pc.panelCentroid, faceCentroid[capIdx]);
              double offset = std::abs(pc.panelNormal.Dot(hostToCap));
              pc.useBoundedTabBox = true;
              pc.tabU      = tabU;
              pc.tabV      = tabV;
              pc.tabUMin   = uMin;
              pc.tabUMax   = uMax;
              pc.tabVMin   = vMin;
              pc.tabVMax   = vMax;
              pc.tabHeight = offset;
            }
          }
        }
        candidates.push_back(std::move(pc));
        for (int fi : component) claimed[fi] = true;
        claimedPanelGroup[matchedPanelGroup] = true;
        if (matchedPanelGroup != g) claimedPanelGroup[g] = true;
        // Claim all faces parallel/anti-parallel to the cap face and within
        // maxThicknessMm of it. For a triangulated mesh, each plate face is split
        // into multiple coplanar triangles; without this, each triangle would
        // produce a duplicate protrusion candidate.
        for (int fi = 1; fi <= nFaces; ++fi) {
          if (claimed[fi]) continue;
          const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
          gp_Vec fn = faceOutwardNormal(f);
          if (std::abs(capNormVec.Dot(fn)) <= 0.85) continue;
          BRepExtrema_DistShapeShape d(capFace, f);
          if (d.IsDone() && d.Value() <= maxThicknessMm) {
            claimed[fi] = true;
            if (faceToGroup[fi] >= 0) claimedPanelGroup[faceToGroup[fi]] = true;
          }
        }
      }
    }

    // ÔöÇÔöÇ Option-2 pass: detect tabs/bosses whose cap face is itself a primary
    // face group sitting on an interior host (missed by the BFS, which only
    // seeds from non-primary faces). Uses the AABB-derived hullRatio computed
    // at the top of this function.
    for (int cap = 0; cap < (int)groups.size(); ++cap) {
      if (!groups[cap].isOuter || claimedPanelGroup[cap]) continue;
      if (hullRatio[cap] >= kInteriorThreshold) continue;  // cap must be interior

      int    bestHost     = -1;
      double bestHostArea = 0.0;

      for (int host = 0; host < (int)groups.size(); ++host) {
        if (host == cap || !groups[host].isOuter || claimedPanelGroup[host]) continue;
        if (hullRatio[host] >= kInteriorThreshold) continue;  // host must also be interior

        double dotProd = groups[cap].normal.Dot(groups[host].normal);
        if (dotProd < 0.85) continue;                          // tab-style only
        if (groups[cap].area >= 0.30 * groups[host].area) continue;

        gp_Vec hostToCap(groups[host].centroid, groups[cap].centroid);
        double offset = std::abs(groups[host].normal.Dot(hostToCap));
        if (offset < 1e-3 || offset > maxThicknessMm) continue;

        if (groups[host].area > bestHostArea) {
          bestHost     = host;
          bestHostArea = groups[host].area;
        }
      }

      if (bestHost < 0) continue;

      gp_Vec tabU, tabV;
      if (!buildInPlaneAxes(groups[bestHost].normal, tabU, tabV)) continue;

      // Project all cap-group face vertices onto the (tabU, tabV) plane.
      double uMin = 1e30, uMax = -1e30, vMin = 1e30, vMax = -1e30;
      for (int fi : groups[cap].faceIndices) {
        double u0, u1, v0, v1;
        projectFootprint(TopoDS::Face(faceMap(fi)), groups[bestHost].centroid,
                         tabU, tabV, u0, u1, v0, v1);
        uMin = std::min(uMin, u0); uMax = std::max(uMax, u1);
        vMin = std::min(vMin, v0); vMax = std::max(vMax, v1);
      }
      if (uMax <= uMin || vMax <= vMin) continue;

      gp_Vec hostToCap(groups[bestHost].centroid, groups[cap].centroid);
      double offset = std::abs(groups[bestHost].normal.Dot(hostToCap));

      ProtrusionCandidate pc;
      pc.faceIndices      = groups[cap].faceIndices;
      pc.panelCentroid    = groups[bestHost].centroid;
      pc.panelNormal      = groups[bestHost].normal;
      pc.useBoundedTabBox = true;
      pc.tabU             = tabU;
      pc.tabV             = tabV;
      pc.tabUMin          = uMin;
      pc.tabUMax          = uMax;
      pc.tabVMin          = vMin;
      pc.tabVMax          = vMax;
      pc.tabHeight        = offset;

      candidates.push_back(std::move(pc));
      for (int fi : groups[cap].faceIndices) claimed[fi] = true;
      claimedPanelGroup[cap]      = true;
      claimedPanelGroup[bestHost] = true;
    }

    // ÔöÇÔöÇ Option-3 pass: detect bridge/flange protrusions ÔÇö anti-parallel
    // interior face groups that form a thin slab (e.g. connecting flanges
    // between two concentric hollow cubes). Neither BFS nor Option-2 can
    // detect these because both exposed faces are primary groups and they
    // are anti-parallel, not parallel. We pair them by:
    //   1. Both interior (hullRatio < kInteriorThreshold)
    //   2. Anti-parallel normals (dot < -0.85)
    //   3. Normal-direction offset Ôëñ maxThicknessMm
    //   4. Similar areas (within 3:1)
    //   5. Overlapping 2-D footprints (rules out false pairs at same Y but
    //      different X, e.g. flanges on opposite sides of the solid)
    // Helper: find all interior groups coplanar AND topologically connected
    // to group g (same normal, same plane within 0.5 mm, and reachable via
    // shared edges between member faces). A meshed/triangulated flange face
    // is often emitted as two coplanar triangles that buildFaceGroups can't
    // merge if their shared diagonal is treated as a non-coplanar edge ÔÇö
    // without this consolidation Option-3 would produce one candidate per
    // triangle. Topology (not just coplanarity) ensures we don't pull in
    // physically separate flanges that happen to lie on the same plane.
    auto coplanarSiblings = [&](int g) -> std::vector<int> {
      std::vector<int> out = {g};
      const gp_Vec& n = groups[g].normal;
      const gp_Pnt& c = groups[g].centroid;
      std::set<int> inSet{g};
      std::set<int> faceSet(groups[g].faceIndices.begin(),
                            groups[g].faceIndices.end());
      bool grew = true;
      while (grew) {
        grew = false;
        for (int s = 0; s < (int)groups.size(); ++s) {
          if (inSet.count(s)) continue;
          if (!groups[s].isOuter || claimedPanelGroup[s]) continue;
          if (hullRatio[s] >= kInteriorThreshold) continue;
          if (groups[s].normal.Dot(n) < 0.95) continue;
          gp_Vec delta(c, groups[s].centroid);
          if (std::abs(n.Dot(delta)) > 0.5) continue;
          bool adj = false;
          for (int fi : groups[s].faceIndices) {
            for (int nbr : faceAdj[fi]) {
              if (faceSet.count(nbr)) { adj = true; break; }
            }
            if (adj) break;
          }
          if (!adj) continue;
          out.push_back(s);
          inSet.insert(s);
          for (int fi : groups[s].faceIndices) faceSet.insert(fi);
          grew = true;
        }
      }
      return out;
    };

    for (int capIdx3 = 0; capIdx3 < (int)groups.size(); ++capIdx3) {
      if (!groups[capIdx3].isOuter || claimedPanelGroup[capIdx3]) continue;
      if (hullRatio[capIdx3] >= kInteriorThreshold) continue;

      for (int backIdx = capIdx3 + 1; backIdx < (int)groups.size(); ++backIdx) {
        if (!groups[backIdx].isOuter || claimedPanelGroup[backIdx]) continue;
        if (hullRatio[backIdx] >= kInteriorThreshold) continue;

        double dp = groups[capIdx3].normal.Dot(groups[backIdx].normal);
        if (dp > -0.85) continue;  // must be anti-parallel

        gp_Vec c2b(groups[capIdx3].centroid, groups[backIdx].centroid);
        double slabOffset = std::abs(groups[capIdx3].normal.Dot(c2b));
        if (slabOffset < 1e-3 || slabOffset > maxThicknessMm) continue;

        // Consolidate coplanar siblings into the cap-side and back-side
        // logical faces, then aggregate their areas and footprints.
        auto capSibs  = coplanarSiblings(capIdx3);
        auto backSibs = coplanarSiblings(backIdx);

        double capArea = 0.0, backArea = 0.0;
        for (int s : capSibs)  capArea  += groups[s].area;
        for (int s : backSibs) backArea += groups[s].area;

        double minA = std::min(capArea, backArea);
        double maxA = std::max(capArea, backArea);
        if (maxA < 1e-6 || minA / maxA < 0.30) continue;

        gp_Vec tabU3, tabV3;
        if (!buildInPlaneAxes(groups[capIdx3].normal, tabU3, tabV3)) continue;

        // CRITICAL: use back centroid as the footprint reference so the
        // (tabUMin..tabUMax) bounds line up with panelCentroid (also set to
        // back centroid) when extractProtrusion builds the bounded box.
        // Mixing cap and back centroids here shifts the extraction box by
        // the in-plane offset between the two triangulated face centroids.
        const gp_Pnt& orig3 = groups[backIdx].centroid;
        auto unionFootprint = [&](const std::vector<int>& sibs,
                                  double& uMin, double& uMax,
                                  double& vMin, double& vMax) {
          uMin = 1e30; uMax = -1e30; vMin = 1e30; vMax = -1e30;
          for (int s : sibs) {
            for (int fi : groups[s].faceIndices) {
              double u0, u1, v0, v1;
              projectFootprint(TopoDS::Face(faceMap(fi)), orig3, tabU3, tabV3,
                               u0, u1, v0, v1);
              uMin = std::min(uMin, u0); uMax = std::max(uMax, u1);
              vMin = std::min(vMin, v0); vMax = std::max(vMax, v1);
            }
          }
        };

        double cUMin, cUMax, cVMin, cVMax;
        double bUMin, bUMax, bVMin, bVMax;
        unionFootprint(capSibs,  cUMin, cUMax, cVMin, cVMax);
        unionFootprint(backSibs, bUMin, bUMax, bVMin, bVMax);

        double overlapU = std::min(cUMax, bUMax) - std::max(cUMin, bUMin);
        double overlapV = std::min(cVMax, bVMax) - std::max(cVMin, bVMin);
        if (overlapU <= 0.0 || overlapV <= 0.0) continue;

        ProtrusionCandidate pc3;
        for (int s : capSibs)  for (int fi : groups[s].faceIndices)  pc3.faceIndices.push_back(fi);
        for (int s : backSibs) for (int fi : groups[s].faceIndices)  pc3.faceIndices.push_back(fi);
        pc3.panelCentroid    = groups[backIdx].centroid;
        pc3.panelNormal      = groups[capIdx3].normal;
        pc3.useBoundedTabBox = true;
        pc3.tabU             = tabU3;
        pc3.tabV             = tabV3;
        pc3.tabUMin          = std::max(cUMin, bUMin);
        pc3.tabUMax          = std::min(cUMax, bUMax);
        pc3.tabVMin          = std::max(cVMin, bVMin);
        pc3.tabVMax          = std::min(cVMax, bVMax);
        pc3.tabHeight        = slabOffset;
        // Bridge flanges butt directly against adjacent cube walls; the
        // default 0.5 mm pad/bleed catches a sliver of those walls and
        // inflates the extracted bbox. 0.05 mm is enough for boolean
        // robustness without crossing into adjacent material.
        pc3.tightPad         = 0.05;
        pc3.tightBleed       = 0.05;

        candidates.push_back(std::move(pc3));
        for (int s : capSibs)  claimedPanelGroup[s] = true;
        for (int s : backSibs) claimedPanelGroup[s] = true;
        break;
      }
    }

    return candidates;
  }

  // T018 ÔÇö Extract one protrusion from the solid by cutting at the primary
  // panel's outer face plane. Updates remainder (solid minus protrusion).
  // planeHalfSize: symmetric UV half-extent for the cutting planeFace.
  //   Must be large enough to span the entire solid cross-section at the cut plane.
  //   Computed once from the original solid's diagonal (vertex-iterated) so it is
  //   geometrically correct without ballooning to the ┬▒200 km values that
  //   BRepBndLib::Add can report for STEP-imported planar faces.
  static TopoDS_Shape extractProtrusion(
      const TopoDS_Shape&        solid,
      const ProtrusionCandidate& pc,
      TopoDS_Shape&              remainder,
      double                     planeHalfSize)
  {
    gp_Dir planeDir(pc.panelNormal.X(), pc.panelNormal.Y(), pc.panelNormal.Z());
    gp_Pln outerPlane(pc.panelCentroid, planeDir);

    BRepBuilderAPI_MakeFace planeFaceMaker(
        outerPlane,
        -planeHalfSize, planeHalfSize,
        -planeHalfSize, planeHalfSize);
    if (!planeFaceMaker.IsDone())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Could not build cutting plane for protrusion", true, "rollback");

    // Reference point on the protrusion side.
    //   - Tab-style: panel is on the solid bulk side, normal points toward the tab
    //     body. Reference goes in +panelNormal direction.
    //   - Plate-style (hasBackPlane): panel is the outer wide face, normal points
    //     AWAY from the slab body. Reference goes in -panelNormal direction.
    double refSign = pc.hasBackPlane ? -1.0 : 1.0;
    gp_Pnt outerRef(
        pc.panelCentroid.X() + refSign * pc.panelNormal.X() * 1e4,
        pc.panelCentroid.Y() + refSign * pc.panelNormal.Y() * 1e4,
        pc.panelCentroid.Z() + refSign * pc.panelNormal.Z() * 1e4);

    TopoDS_Shape cutter;
    if (pc.useBoundedTabBox) {
      // Option-2 interior-host tab: build a box scoped to the cap's 2D
      // footprint (precomputed in (tabU, tabV)) ├ù tab height along panelNormal.
      // The box brackets the tab volume exactly, so the boolean Common
      // captures only the tab and not the surrounding solid.
      const double pad   = (pc.tightPad   >= 0.0) ? pc.tightPad   : 0.5;
      const double bleed = (pc.tightBleed >= 0.0) ? pc.tightBleed : 0.5;
      double uSize = (pc.tabUMax - pc.tabUMin) + 2.0 * pad;
      double vSize = (pc.tabVMax - pc.tabVMin) + 2.0 * pad;
      double hSize = pc.tabHeight + 2.0 * bleed;

      // Box origin: low-(u,v) corner, dropped slightly below the host plane.
      gp_Pnt origin(
          pc.panelCentroid.X()
            + pc.tabU.X() * (pc.tabUMin - pad)
            + pc.tabV.X() * (pc.tabVMin - pad)
            - pc.panelNormal.X() * bleed,
          pc.panelCentroid.Y()
            + pc.tabU.Y() * (pc.tabUMin - pad)
            + pc.tabV.Y() * (pc.tabVMin - pad)
            - pc.panelNormal.Y() * bleed,
          pc.panelCentroid.Z()
            + pc.tabU.Z() * (pc.tabUMin - pad)
            + pc.tabV.Z() * (pc.tabVMin - pad)
            - pc.panelNormal.Z() * bleed);

      gp_Dir zAxis(pc.panelNormal.X(), pc.panelNormal.Y(), pc.panelNormal.Z());
      gp_Dir xAxis(pc.tabU.X(), pc.tabU.Y(), pc.tabU.Z());
      gp_Ax2 ax(origin, zAxis, xAxis);

      BRepPrimAPI_MakeBox boxMaker(ax, uSize, vSize, hSize);
      try {
        boxMaker.Build();
        if (!boxMaker.IsDone())
          throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                              "Could not build bounded tab box", true, "rollback");
        cutter = boxMaker.Solid();
      } catch (const Standard_Failure&) {
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Bounded tab box construction threw", true, "rollback");
      }
    } else if (pc.hasBackPlane) {
      // Plate-style: build a bounded slab box between the back plane and the
      // panel plane. Half-space intersection produces a fragile cutter that
      // can corrupt the solid; a real bounded box is robust.
      gp_Vec slabAxis = pc.panelNormal;  // points away from slab body
      // Slab thickness along the panel normal: distance between the two planes
      gp_Vec backToPanel(pc.backCentroid, pc.panelCentroid);
      double slabThickness = std::abs(slabAxis.Dot(backToPanel)) + 0.1; // small over-extend
      // Slab origin: walk from back centroid in -slabAxis to be just past it.
      // backNormal points AWAY from slab body, so slab body is on -backNormal side.
      gp_Pnt slabCorner = pc.backCentroid;
      // Build axes perpendicular to slab axis (any two orthogonal directions).
      gp_Vec perpA;
      if (std::abs(slabAxis.X()) < 0.9) perpA = gp_Vec(1, 0, 0);
      else                              perpA = gp_Vec(0, 1, 0);
      perpA = perpA.Crossed(slabAxis);
      if (perpA.Magnitude() < 1e-6) perpA = gp_Vec(0, 0, 1);
      perpA.Normalize();
      gp_Vec perpB = slabAxis.Crossed(perpA);
      perpB.Normalize();
      // Move corner so the box brackets the slab and extends past the solid in
      // the perpendicular directions.
      gp_Pnt origin(
          slabCorner.X() - perpA.X() * planeHalfSize - perpB.X() * planeHalfSize - pc.backNormal.X() * 0.05,
          slabCorner.Y() - perpA.Y() * planeHalfSize - perpB.Y() * planeHalfSize - pc.backNormal.Y() * 0.05,
          slabCorner.Z() - perpA.Z() * planeHalfSize - perpB.Z() * planeHalfSize - pc.backNormal.Z() * 0.05);
      gp_Dir xAxis(perpA.X(), perpA.Y(), perpA.Z());
      // Box Z-axis points into the slab body: -backNormal direction.
      // (Equivalent to +panelNormal when back & panel are anti-parallel, but
      // we anchor on the back plane so we use backNormal directly.)
      gp_Dir zAxis(-pc.backNormal.X(), -pc.backNormal.Y(), -pc.backNormal.Z());
      gp_Ax2 ax(origin, zAxis, xAxis);
      BRepPrimAPI_MakeBox boxMaker(ax,
          2.0 * planeHalfSize, 2.0 * planeHalfSize, slabThickness);
      try {
        boxMaker.Build();
        if (!boxMaker.IsDone())
          throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                              "Could not build plate slab box", true, "rollback");
        cutter = boxMaker.Solid();
      } catch (const Standard_Failure&) {
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Plate slab box construction threw", true, "rollback");
      }
    } else {
      // Tab-style: use the original half-space cutter.
      BRepPrimAPI_MakeHalfSpace hs(planeFaceMaker.Face(), outerRef);
      hs.Build();
      if (!hs.IsDone())
        throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                            "Could not build half-space for protrusion extraction", true, "rollback");
      cutter = hs.Solid();
    }

    BRepAlgoAPI_Common extract(solid, cutter);
    extract.Build();
    if (!extract.IsDone() || extract.Shape().IsNull())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Protrusion intersection produced null result", true, "rollback");

    GProp_GProps ep;
    BRepGProp::VolumeProperties(extract.Shape(), ep);
    if (std::abs(ep.Mass()) < 1e-6)
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Protrusion extraction has zero volume (degenerate)", true, "rollback");

    BRepAlgoAPI_Cut cutRemainder(solid, cutter);
    cutRemainder.Build();
    if (!cutRemainder.IsDone() || cutRemainder.Shape().IsNull())
      throw GeometryError(GE_DECOMPOSE_PROTRUSION_EXTRACT_FAILED,
                          "Could not trim remainder after protrusion extraction", true, "rollback");

    remainder = cutRemainder.Shape();
    return extract.Shape();
  }

  // Sanity check: a real protrusion (tab/boss/flange) is a localized feature,
  // small in at least two of three axes relative to the host solid. A "panel-
  // sized" candidate spans > 80% of the solid in 2+ axes ÔÇö that's a wall slab
  // misdetected as a protrusion (e.g. when nested-cube topology lets BFS
  // wrap a plate-style candidate around a full outer face). Reject those so
  // the geometry stays in workShape for splitMode2 to handle as a panel.
  static bool isPanelSized(const TopoDS_Shape& candidate, const TopoDS_Shape& solid) {
    auto extentVia = [](const TopoDS_Shape& s,
                        double& dx, double& dy, double& dz) -> bool {
      double xMin = 1e30, yMin = 1e30, zMin = 1e30;
      double xMax = -1e30, yMax = -1e30, zMax = -1e30;
      bool any = false;
      for (TopExp_Explorer ex(s, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        xMin = std::min(xMin, p.X()); xMax = std::max(xMax, p.X());
        yMin = std::min(yMin, p.Y()); yMax = std::max(yMax, p.Y());
        zMin = std::min(zMin, p.Z()); zMax = std::max(zMax, p.Z());
        any = true;
      }
      if (!any) return false;
      dx = xMax - xMin; dy = yMax - yMin; dz = zMax - zMin;
      return true;
    };

    double cx, cy, cz, sx, sy, sz;
    if (!extentVia(candidate, cx, cy, cz)) return false;
    if (!extentVia(solid, sx, sy, sz))     return false;

    constexpr double kPanelThreshold = 0.80;
    int largeAxes = 0;
    if (sx > 1e-6 && cx / sx > kPanelThreshold) ++largeAxes;
    if (sy > 1e-6 && cy / sy > kPanelThreshold) ++largeAxes;
    if (sz > 1e-6 && cz / sz > kPanelThreshold) ++largeAxes;
    return largeAxes >= 2;
  }

  // Mode 1: BFS + extrusion (surface/conceptual model).
  // Each coplanar face group is extruded by defaultThicknessMm along its outward normal.
  void splitMode1BFS(const TopoDS_Shape& shape,
                     const SolidId& parentId,
                     double angleThresholdDeg,
                     double defaultThicknessMm,
                     std::vector<ShellId>& panelIds,
                     std::vector<ShapeHistoryRecord>* historyOut = nullptr)
  {
    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
    if (faceMap.Extent() == 0) return;

    // Dummy centroid for isOuter classification (not used in Mode 1 extrusion)
    auto groups = buildFaceGroups(shape, faceMap, angleThresholdDeg, gp_Pnt(0,0,0));

    for (const auto& grp : groups) {
      // Collect boundary edges: edges adjacent to only one face in this group.
      // Build a set of face indices for fast membership test.
      std::set<int> groupSet(grp.faceIndices.begin(), grp.faceIndices.end());

      // Gather all edges from the group faces and count how many group faces share each edge.
      TopTools_IndexedDataMapOfShapeListOfShape edgeFaceMap;
      for (int idx : grp.faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        for (TopExp_Explorer edgeEx(f, TopAbs_EDGE); edgeEx.More(); edgeEx.Next()) {
          const TopoDS_Shape& e = edgeEx.Current();
          if (!edgeFaceMap.Contains(e)) {
            edgeFaceMap.Add(e, TopTools_ListOfShape());
          }
          // Only add if not already in list for this face
          TopTools_ListOfShape& lst = edgeFaceMap.ChangeFromKey(e);
          bool found = false;
          for (const TopoDS_Shape& s : lst) {
            if (s.IsEqual(f)) { found = true; break; }
          }
          if (!found) lst.Append(f);
        }
      }

      // Boundary edges are those touching exactly one group face
      BRepBuilderAPI_MakeWire wireMaker;
      bool hasEdge = false;
      for (int i = 1; i <= edgeFaceMap.Extent(); ++i) {
        if (edgeFaceMap(i).Size() == 1) {
          const TopoDS_Edge& e = TopoDS::Edge(edgeFaceMap.FindKey(i));
          wireMaker.Add(e);
          hasEdge = true;
        }
      }

      if (!hasEdge || !wireMaker.IsDone()) {
        // Fallback: store as a zero-thickness shell (e.g. closed surface)
        BRep_Builder builder;
        TopoDS_Shell sh;
        builder.MakeShell(sh);
        for (int idx : grp.faceIndices)
          builder.Add(sh, faceMap(idx));
        ShellId sid = generateUUID();
        s_.shells[sid] = ShellState{sid, parentId, sh};
        panelIds.push_back(sid);
        continue;
      }

      // Build a planar face from the boundary wire using the group's plane
      gp_Pln grpPlane(grp.centroid, gp_Dir(grp.normal));
      TopoDS_Wire rawWire = wireMaker.Wire();
      TopoDS_Wire fixedWire = rawWire;

      try {
        Handle(ShapeFix_Wire) sfw = new ShapeFix_Wire();
        sfw->Load(rawWire);
        BRepBuilderAPI_MakeFace tempFaceMaker(grpPlane);
        if (tempFaceMaker.IsDone()) {
          sfw->SetFace(tempFaceMaker.Face());
        }
        sfw->SetPrecision(0.15); // fuzzy tolerance for wire healing
        sfw->FixReorder();
        sfw->FixConnected();
        sfw->FixClosed();
        fixedWire = sfw->Wire();
      } catch (...) {
        // Keep rawWire if ShapeFix_Wire fails
      }

      TopoDS_Face finalFace;
      BRepBuilderAPI_MakeFace faceMaker(grpPlane, fixedWire, Standard_True);
      if (faceMaker.IsDone()) {
        finalFace = faceMaker.Face();
      } else {
        // If first attempt failed, try BRepBuilderAPI_Sewing to heal the edges!
        try {
          BRepBuilderAPI_Sewing sewer(0.15);
          for (int i = 1; i <= edgeFaceMap.Extent(); ++i) {
            if (edgeFaceMap(i).Size() == 1) {
              const TopoDS_Edge& e = TopoDS::Edge(edgeFaceMap.FindKey(i));
              sewer.Add(e);
            }
          }
          sewer.Perform();
          TopoDS_Shape sewed = sewer.SewedShape();
          TopoDS_Wire sewedWire;
          if (sewed.ShapeType() == TopAbs_WIRE) {
            sewedWire = TopoDS::Wire(sewed);
          } else {
            TopExp_Explorer wireEx(sewed, TopAbs_WIRE);
            if (wireEx.More()) {
              sewedWire = TopoDS::Wire(wireEx.Current());
            }
          }
          if (!sewedWire.IsNull()) {
            BRepBuilderAPI_MakeFace faceMaker2(grpPlane, sewedWire, Standard_True);
            if (faceMaker2.IsDone()) {
              finalFace = faceMaker2.Face();
            }
          }
        } catch (...) {
          // Sewer failed
        }
      }

      if (finalFace.IsNull()) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Could not build planar face from boundary wire", true, "rollback");
      }

      // Extrude along the group's outward normal
      gp_Vec extVec(grp.normal.X() * defaultThicknessMm,
                    grp.normal.Y() * defaultThicknessMm,
                    grp.normal.Z() * defaultThicknessMm);
      BRepPrimAPI_MakePrism prism(finalFace, extVec);
      prism.Build();
      if (!prism.IsDone() || prism.Shape().IsNull()) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Extrusion failed for panel group", true, "rollback");
      }

      // Basic manifold check: shape must have a non-degenerate volume
      GProp_GProps volProps;
      BRepGProp::VolumeProperties(prism.Shape(), volProps);
      if (std::abs(volProps.Mass()) < 1e-6) {
        throw GeometryError(GE_DECOMPOSE_EXTRUDE_FAILED,
                            "Extruded panel has zero volume (non-manifold result)", true, "rollback");
      }

      if (historyOut) {
        auto records = captureHistory(prism, finalFace,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }

      ShellId sid = generateUUID();
      s_.shells[sid] = ShellState{sid, parentId, prism.Shape()};
      panelIds.push_back(sid);
    }
  }

  // Mode 2: Thin-solid cutting. For each outer/inner panel pair, use the
  // inner face plane to slice a slab off the remainder solid.
  // planeHalfSize: symmetric UV half-extent for every cutting planeFace.
  //   Large enough to span the entire solid so each cut fully consumes all
  //   material on one side (keeping panel count correct and remainder small).
  //   Cap-face rectangle corners from OCCT Boolean ops will lie outside the
  //   original solid's true bounding box; the caller's computeBboxes filters
  //   those out when reporting panel extents.
  // remainderOut (optional): receives the solid left after all panel cuts.
  void splitMode2(const TopoDS_Shape& solid,
                  double              planeHalfSize,
                  const SolidId& parentId,
                  double angleThresholdDeg,
                  double maxThicknessMm,
                  std::vector<ShellId>& panelIds,
                  std::vector<ShellId>& protrusionIds,
                  std::vector<ProtrusionParent>& protrusionParents,
                  TopoDS_Shape* remainderOut = nullptr,
                  std::vector<ShapeHistoryRecord>* historyOut = nullptr)
  {
    GProp_GProps solidProps;
    BRepGProp::VolumeProperties(solid, solidProps);
    gp_Pnt solidCentroid = solidProps.CentreOfMass();

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(solid, TopAbs_FACE, faceMap);
    if (faceMap.Extent() == 0) {
      throw GeometryError(GE_DECOMPOSE_CUT_FAILED, "Solid has no faces", true, "rollback");
    }

    auto groups = buildFaceGroups(solid, faceMap, angleThresholdDeg, solidCentroid);

    // For each outer group, find its closest anti-parallel inner group
    struct PanelCut {
      int                 groupI;
      int                 groupJ;
      double              bestDist;
      double              distFromCenter;
      std::vector<int>    allGroupsI;
      std::vector<int>    allGroupsJ;
    };

    std::vector<PanelCut> cuts;
    cuts.reserve(groups.size());

    for (int i = 0; i < (int)groups.size(); ++i) {
      if (!groups[i].isOuter) continue;

      // Skip non-planar face groups (rounded bends / corners)
      const TopoDS_Face& fOut = TopoDS::Face(faceMap(groups[i].faceIndices[0]));
      Handle(Geom_Surface) surfOut = BRep_Tool::Surface(fOut);
      if (surfOut.IsNull() || !surfOut->IsKind(STANDARD_TYPE(Geom_Plane))) continue;

      // Compute bounding box for group i safely using vertices
      Bnd_Box boxI;
      for (int idx : groups[i].faceIndices) {
        const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
        for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
          boxI.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
        }
      }

      double bestDist = std::numeric_limits<double>::max();
      int    bestJ    = -1;

      for (int j = 0; j < (int)groups.size(); ++j) {
        if (i == j || groups[j].isOuter) continue;
        if (groups[i].normal.Dot(groups[j].normal) > -0.95) continue;

        // Compute bounding box for group j safely using vertices
        Bnd_Box boxJ;
        for (int idx : groups[j].faceIndices) {
          const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
          for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
            boxJ.Add(BRep_Tool::Pnt(TopoDS::Vertex(ex.Current())));
          }
        }

        // Check if group i and group j overlap transversely by inflating boxI
        Bnd_Box boxI_inflated = boxI;
        boxI_inflated.Enlarge(maxThicknessMm * 1.5);
        if (boxI_inflated.IsOut(boxJ)) continue;

        // Measure face-to-face distance using plane-to-plane projection
        double dist = std::abs(gp_Vec(groups[i].centroid, groups[j].centroid).Dot(groups[i].normal));
        if (dist > maxThicknessMm) continue;
        if (dist < bestDist) { bestDist = dist; bestJ = j; }
      }

      if (bestJ < 0) continue;

      double distFromCenter = groups[i].normal.Dot(gp_Vec(solidCentroid, groups[i].centroid));
      cuts.push_back({i, bestJ, bestDist, distFromCenter, {}, {}});
    }

    // Merge coplanar cuts (belonging to same wall plane but split by holes)
    std::vector<PanelCut> mergedCuts;
    for (const auto& cut : cuts) {
      bool foundCoplanar = false;
      for (auto& mCut : mergedCuts) {
        gp_Dir n1 = groups[cut.groupI].normal;
        gp_Dir n2 = groups[mCut.groupI].normal;
        if (n1.Dot(n2) > 0.95) {
          double dist = std::abs(gp_Vec(groups[cut.groupI].centroid, groups[mCut.groupI].centroid).Dot(n1));
          if (dist < 1.0) {
            mCut.allGroupsI.push_back(cut.groupI);
            mCut.allGroupsJ.push_back(cut.groupJ);
            mCut.bestDist = std::min(mCut.bestDist, cut.bestDist);
            foundCoplanar = true;
            break;
          }
        }
      }
      if (!foundCoplanar) {
        PanelCut newMCut = cut;
        newMCut.allGroupsI = {cut.groupI};
        newMCut.allGroupsJ = {cut.groupJ};
        mergedCuts.push_back(newMCut);
      }
    }
    cuts = std::move(mergedCuts);

    // Process outermost panels first (minimises corner-ownership artefacts)
    std::sort(cuts.begin(), cuts.end(), [](const PanelCut& a, const PanelCut& b) {
      return a.distFromCenter > b.distFromCenter;
    });

    TopoDS_Shape remainder = solid;

    for (const auto& cut : cuts) {
      if (remainder.IsNull()) break;

      int i = cut.groupI;
      double bestDist = cut.bestDist;

      // Define local coordinate system (U, V, N) for the flat face group i
      gp_Dir N(groups[i].normal);
      gp_Dir U;
      if (std::abs(N.X()) < 0.9) U = gp_Dir(1, 0, 0).Crossed(N);
      else U = gp_Dir(0, 1, 0).Crossed(N);
      gp_Dir V = N.Crossed(U);

      // Find min/max of all vertices of group i in local axes
      double uMin = 1e30, uMax = -1e30;
      double vMin = 1e30, vMax = -1e30;
      double nValue = 0.0;
      bool firstPt = true;

      for (int gIdx : cut.allGroupsI) {
        for (int idx : groups[gIdx].faceIndices) {
          const TopoDS_Face& f = TopoDS::Face(faceMap(idx));
          for (TopExp_Explorer ex(f, TopAbs_VERTEX); ex.More(); ex.Next()) {
            gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
            double u = gp_Vec(p.XYZ()).Dot(U.XYZ());
            double v = gp_Vec(p.XYZ()).Dot(V.XYZ());
            double n = gp_Vec(p.XYZ()).Dot(N.XYZ());
            uMin = std::min(uMin, u); uMax = std::max(uMax, u);
            vMin = std::min(vMin, v); vMax = std::max(vMax, v);
            if (firstPt) { nValue = n; firstPt = false; }
          }
        }
      }

      double dx = uMax - uMin;
      double dy = vMax - vMin;
      double dz = bestDist + 1.0; // 0.5 mm bleed on each side

      if (dx <= 1e-3 || dy <= 1e-3 || dz <= 1e-3) continue;

      // Origin at local U*uMin + V*vMin + N*(nValue - bestDist - 0.5)
      gp_Pnt origin(U.XYZ() * uMin + V.XYZ() * vMin + N.XYZ() * (nValue - bestDist - 0.5));
      gp_Ax2 localSystem(origin, N, U);

      BRepPrimAPI_MakeBox boxMaker(localSystem, dx, dy, dz);
      boxMaker.Build();
      if (!boxMaker.IsDone()) continue;
      TopoDS_Solid cutterSolid = boxMaker.Solid();

      // Extract panel slab = ORIGINAL_SOLID ∩ cutterSolid (not remainder).
      //
      // Extracting from the remainder caused successive panels to be trimmed
      // at the corners where earlier panels had already been cut out. The
      // resulting panels only touched along an edge (no volumetric overlap),
      // which broke merge_bodies_with_bend: the strict 0.1mm proximity
      // seam-detection filter couldn't find the outer corner edge because
      // it sat one wall-thickness away from the trimmed input. Panels that
      // overlap at corners (as adjacent sheet metal walls physically do)
      // give a clean fuse with the corner absorbed into the merged solid,
      // and the seam edge sits right on both inputs.
      BRepAlgoAPI_Common extract(solid, cutterSolid);
      extract.Build();
      if (!extract.IsDone() || extract.Shape().IsNull()) continue;

      GProp_GProps ep;
      BRepGProp::VolumeProperties(extract.Shape(), ep);
      if (std::abs(ep.Mass()) < 1e-6) continue;  // empty slab ÔÇö skip

      if (historyOut) {
        auto records = captureHistory(extract, remainder,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }

      ShellId panelId = generateUUID();
      s_.shells[panelId] = ShellState{panelId, parentId, extract.Shape()};
      panelIds.push_back(panelId);
      (void)protrusionIds;       // reserved for future post-cut handling
      (void)protrusionParents;   // reserved for future post-cut handling

      // Remainder = remainder minus the cutterSolid
      BRepAlgoAPI_Cut cutRemainder(remainder, cutterSolid);
      cutRemainder.Build();
      if (historyOut && cutRemainder.IsDone()) {
        auto records = captureHistory(cutRemainder, remainder,
                                      [](const TopoDS_Shape& s){ return shapeId(s); },
                                      "split_body_by_bends");
        historyOut->insert(historyOut->end(), records.begin(), records.end());
      }
      if (!cutRemainder.IsDone() || cutRemainder.Shape().IsNull()) break;
      remainder = cutRemainder.Shape();
    }

    if (remainderOut) *remainderOut = remainder;
  }

  // T022 ÔÇö Recursive decomposition. Operates on an arbitrary solid shape
  // (not a registered shell), with the mutex already held by the caller.
  void recursiveDecompose(
      const TopoDS_Shape&  shape,
      const SolidId&       parentId,
      double               angleThresholdDeg,
      double               maxThicknessMm,
      double               defaultThicknessMm,
      int                  remainingDepth,
      std::vector<ShellId>&        panelIds,
      std::vector<ShellId>&        protrusionIds,
      std::vector<ProtrusionParent>& protrusionParents)
  {
    if (remainingDepth <= 0 || shape.IsNull()) return;

    GProp_GProps rp;
    BRepGProp::VolumeProperties(shape, rp);
    if (std::abs(rp.Mass()) < 1.0) return;  // < 1 mm┬│ ÔÇö nothing meaningful left

    TopTools_IndexedMapOfShape faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
    if (faceMap.Extent() < 2) return;  // degenerate

    std::string mode = detectObjectMode(shape, maxThicknessMm);

    gp_Pnt solidCentroid(0, 0, 0);
    if (mode == "thin_solid") {
      GProp_GProps vp;
      BRepGProp::VolumeProperties(shape, vp);
      solidCentroid = vp.CentreOfMass();
    }

    auto faceGroups     = buildFaceGroups(shape, faceMap, angleThresholdDeg, solidCentroid);
    auto protrCandidates = detectProtrusions(shape, faceMap, faceGroups, maxThicknessMm);

    // Termination: no primary panel groups found in this component
    bool hasPrimaryGroup = false;
    for (const auto& g : faceGroups) { if (g.isOuter) { hasPrimaryGroup = true; break; } }
    if (!hasPrimaryGroup) return;

    // Compute planeHalfSize from this component's vertex bounds (vertex iteration,
    // not BRepBndLib::Add which can report ┬▒200 km for STEP-imported planar faces).
    double localHalfSize = 1000.0;
    {
      double lxMin = 1e30, lxMax = -1e30;
      double lyMin = 1e30, lyMax = -1e30;
      double lzMin = 1e30, lzMax = -1e30;
      for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        lxMin = std::min(lxMin, p.X()); lxMax = std::max(lxMax, p.X());
        lyMin = std::min(lyMin, p.Y()); lyMax = std::max(lyMax, p.Y());
        lzMin = std::min(lzMin, p.Z()); lzMax = std::max(lzMax, p.Z());
      }
      double d2 = (lxMax-lxMin)*(lxMax-lxMin)
                + (lyMax-lyMin)*(lyMax-lyMin)
                + (lzMax-lzMin)*(lzMax-lzMin);
      if (d2 > 0) localHalfSize = std::sqrt(d2) * 1.1 + 10.0;
    }

    TopoDS_Shape workShape = shape;
    for (const auto& pc : protrCandidates) {
      TopoDS_Shape newRemainder;
      try {
        TopoDS_Shape ps = extractProtrusion(workShape, pc, newRemainder, localHalfSize);
        if (isPanelSized(ps, workShape)) continue;  // false positive ÔÇö leave for splitMode2
        ShellId pid = generateUUID();
        s_.shells[pid] = ShellState{pid, parentId, ps};
        protrusionIds.push_back(pid);
        protrusionParents.push_back({pid, ""});  // pre-cut: panel not yet determined
        workShape = std::move(newRemainder);
      } catch (const GeometryError&) {}
    }

    // If protrusion extraction disconnected workShape into multiple solids
    // (e.g., testcube's bridge flanges connected the inner and outer hollow
    // cubes; removing them leaves two separate solids), splitMode2 would
    // bundle the inner and outer walls into mixed panels because each outer
    // face would find an anti-parallel match across the void. Recurse on each
    // component separately so each cube is decomposed in isolation.
    {
      std::vector<TopoDS_Shape> components;
      for (TopExp_Explorer ex(workShape, TopAbs_SOLID); ex.More(); ex.Next()) {
        components.push_back(ex.Current());
      }
      if (components.size() > 1) {
        for (const auto& comp : components) {
          recursiveDecompose(comp, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, remainingDepth, panelIds,
                             protrusionIds, protrusionParents);
        }
        return;
      }
    }

    TopoDS_Shape childRemainder;
    if (mode == "thin_solid") {
      splitMode2(workShape, localHalfSize, parentId, angleThresholdDeg, maxThicknessMm,
                 panelIds, protrusionIds, protrusionParents, &childRemainder);
    } else {
      splitMode1BFS(workShape, parentId, angleThresholdDeg, defaultThicknessMm, panelIds);
      return;  // surface mode has no structured remainder
    }

    if (childRemainder.IsNull()) return;

    // Recurse on each connected solid component of the remainder
    bool hadSolid = false;
    for (TopExp_Explorer ex(childRemainder, TopAbs_SOLID); ex.More(); ex.Next()) {
      recursiveDecompose(ex.Current(), parentId, angleThresholdDeg, maxThicknessMm,
                         defaultThicknessMm, remainingDepth - 1, panelIds, protrusionIds,
                         protrusionParents);
      hadSolid = true;
    }
    if (!hadSolid) {
      recursiveDecompose(childRemainder, parentId, angleThresholdDeg, maxThicknessMm,
                         defaultThicknessMm, remainingDepth - 1, panelIds, protrusionIds,
                         protrusionParents);
    }
  }
  // ÔöÇÔöÇ Main entry point ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  DecomposedByBendsResult splitBodyByBends(const ShellId& partId,
                                            double angleThresholdDeg,
                                            double maxThicknessMm    = 5.0,
                                            double defaultThicknessMm = 1.0,
                                            int    maxRecursionDepth  = 1) {

    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != s_.solids.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }
    if (angleThresholdDeg < 0.0) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          "angle_threshold_deg must be non-negative", true, "");
    }

    SnapshotId token = s_.createSnapshot("before splitBodyByBends on " + partId);

    try {
      // Copy shape: protrusion extraction adds shells to s_.shells, which can
      // rehash the map and invalidate iterators. Copying avoids a dangling ref.
      TopoDS_Shape shape    = inputShape;
      SolidId      parentId = inputParentId;

      TopTools_IndexedMapOfShape faceMapInput;
      TopExp::MapShapes(shape, TopAbs_FACE, faceMapInput);

      // US1: Facet Unification Pass - Merge adjacent coplanar/planar triangular facets
      // of complex segmented models (like cauldron.step) before decomposition.
      //
      // Uses a small, FIXED tolerance (0.5deg) rather than angleThresholdDeg
      // itself. angleThresholdDeg is a BEND-detection threshold (how sharp a
      // fold must be to count as a real fold, typically tens of degrees) —
      // a wholly different question from "are these adjacent STEP facets
      // just tessellation noise that should merge into one clean face"
      // (which should be tiny — real STEP tessellation seams are near-exact
      // coplanar, not off by tens of degrees). Reusing angleThresholdDeg
      // here silently let a real fixture's default 35deg bend threshold act
      // as the UNIFICATION tolerance too — confirmed on a real fixture
      // (cauldron.step) to merge a wide swath of a curved dome's genuinely
      // separate, only-shallowly-angled facets into one abnormally large
      // (~5.5 million mm2) face, corrupting every downstream panel-face
      // selection (getPanelFrame) that touched it. A real fold this pass
      // should NOT swallow is always far sharper than a tessellation seam,
      // so a small fixed tolerance safely serves both cases.
      constexpr double kFacetUnifyAngularToleranceRad = 0.0087;  // ~0.5 degrees
      try {
        ShapeUpgrade_UnifySameDomain unifier(shape, Standard_True, Standard_True, Standard_True);
        unifier.SetAngularTolerance(kFacetUnifyAngularToleranceRad);
        unifier.SetLinearTolerance(0.05); // slightly looser linear tol to heal facets
        unifier.Build();
        TopoDS_Shape unifiedShape = unifier.Shape();
        if (!unifiedShape.IsNull()) {
          shape = unifiedShape;
        }
      } catch (const Standard_Failure&) {
      } catch (const std::exception&) {
      } catch (...) {
      }

      std::string mode = detectObjectMode(shape, maxThicknessMm);

      TopTools_IndexedMapOfShape faceMapPre;
      TopExp::MapShapes(shape, TopAbs_FACE, faceMapPre);
      
      int planeCount = 0;
      int cylCount = 0;
      int otherCount = 0;
      for (int i = 1; i <= faceMapPre.Extent(); ++i) {
        TopoDS_Face f = TopoDS::Face(faceMapPre(i));
        Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
        if (!surf.IsNull()) {
          if (surf->IsKind(STANDARD_TYPE(Geom_Plane))) planeCount++;
          else if (surf->IsKind(STANDARD_TYPE(Geom_CylindricalSurface))) cylCount++;
          else otherCount++;
        }
      }
      
      // Build face groups now (needed for protrusion detection).
      // For surface mode isOuter classification is irrelevant; pass dummy centroid.
      gp_Pnt solidCentroid(0, 0, 0);
      if (mode == "thin_solid") {
        GProp_GProps vp;
        BRepGProp::VolumeProperties(shape, vp);
        solidCentroid = vp.CentreOfMass();
      }
      auto faceGroupsPre = buildFaceGroups(shape, faceMapPre, angleThresholdDeg, solidCentroid);

      // Compute the original solid's tight bounding box via vertex iteration.
      // BRepBndLib::Add is NOT used here: for STEP-imported shapes it samples the
      // underlying surface's full UV domain and can report ┬▒200 km for a planar face
      // whose untrimmed surface extends far beyond the actual wire boundary.
      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }
      double diagSq = (bxMax-bxMin)*(bxMax-bxMin)
                    + (byMax-byMin)*(byMax-byMin)
                    + (bzMax-bzMin)*(bzMax-bzMin);
      // planeHalfSize: large enough to span the entire solid at any cut plane.
      // The resulting cap-face rectangle corners end up outside the original bbox;
      // computeBboxes filters them out using bxMin/bxMax etc. + 1 mm tolerance.
      double planeHalfSize = (diagSq > 0 ? std::sqrt(diagSq) : 1000.0) * 1.1 + 10.0;

      // T019 ÔÇö Detect and extract protrusions before panel cutting.
      std::vector<ShellId>         panelIds;
      std::vector<ShellId>         protrusionIds;
      std::vector<ProtrusionParent> protrusionParents;

      auto protrCandidates = detectProtrusions(shape, faceMapPre, faceGroupsPre, maxThicknessMm);
      TopoDS_Shape workShape = shape;
      for (const auto& pc : protrCandidates) {
        TopoDS_Shape newRemainder;
        try {
          TopoDS_Shape protrusionSolid = extractProtrusion(workShape, pc, newRemainder, planeHalfSize);
          // Reject panel-sized extractions: those are false positives from
          // detection misfiring on wall slabs (see isPanelSized). Leave the
          // geometry in workShape so splitMode2 handles it as a panel.
          if (isPanelSized(protrusionSolid, workShape)) continue;
          ShellId pid = generateUUID();
          s_.shells[pid] = ShellState{pid, parentId, protrusionSolid};
          protrusionIds.push_back(pid);
          protrusionParents.push_back({pid, ""});  // pre-cut: no panel assigned yet
          workShape = std::move(newRemainder);
        } catch (const GeometryError&) {
          // Non-fatal: skip this protrusion if extraction fails
        }
      }

      // If protrusion extraction disconnected workShape into multiple solids
      // (e.g., the four bridge flanges in testcube.step were the only links
      // between the inner and outer hollow cubes ÔÇö removing them leaves two
      // separate solids), splitMode2 run on the combined shape would pair
      // inner-cube and outer-cube outer faces across the void and produce
      // 25 mm-thick "panels" that wrap both walls plus the gap. OCCT may
      // keep the disconnected result as one Solid with multiple Shells, so
      // TopAbs_SOLID iteration alone misses it ÔÇö run a face-level BFS via
      // shared edges to find connected components, then rebuild a Solid
      // per component using the original Shells inside it.
      auto splitConnectedComponents = [](const TopoDS_Shape& s) -> std::vector<TopoDS_Shape> {
        // Find connected face components via shared edges. Each component is
        // one closed surface; for nested hollow shapes (hollow cube), one
        // component is the outer surface and another is the inner void
        // surface. Then group components into solids by bbox containment:
        // each "outer envelope" pairs with the largest other component that
        // fits inside it (its immediate void). Smaller nested components
        // belong to subsequent solids.
        TopTools_IndexedMapOfShape faceMap;
        TopExp::MapShapes(s, TopAbs_FACE, faceMap);
        int nF = faceMap.Extent();
        if (nF == 0) return {};

        TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
        TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

        std::vector<int> comp(nF + 1, -1);
        int nComp = 0;
        for (int seed = 1; seed <= nF; ++seed) {
          if (comp[seed] >= 0) continue;
          comp[seed] = nComp;
          std::vector<int> q{seed};
          while (!q.empty()) {
            int cur = q.back(); q.pop_back();
            const TopoDS_Face& f = TopoDS::Face(faceMap(cur));
            for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next()) {
              const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
              if (!edgeFaces.Contains(e)) continue;
              const TopTools_ListOfShape& adj = edgeFaces.FindFromKey(e);
              for (TopTools_ListIteratorOfListOfShape it(adj); it.More(); it.Next()) {
                int nb = faceMap.FindIndex(it.Value());
                if (nb > 0 && comp[nb] < 0) { comp[nb] = nComp; q.push_back(nb); }
              }
            }
          }
          ++nComp;
        }
        if (nComp <= 1) return {};

        // Build a Shell per component and compute its bbox.
        std::vector<TopoDS_Shell> compShells(nComp);
        std::vector<std::array<double,6>> compBox(nComp,
            {1e30, -1e30, 1e30, -1e30, 1e30, -1e30});
        BRep_Builder builder;
        for (int c = 0; c < nComp; ++c) builder.MakeShell(compShells[c]);
        for (int fi = 1; fi <= nF; ++fi) {
          int c = comp[fi];
          const TopoDS_Face& f = TopoDS::Face(faceMap(fi));
          builder.Add(compShells[c], f);
          for (TopExp_Explorer vx(f, TopAbs_VERTEX); vx.More(); vx.Next()) {
            gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vx.Current()));
            compBox[c][0] = std::min(compBox[c][0], p.X());
            compBox[c][1] = std::max(compBox[c][1], p.X());
            compBox[c][2] = std::min(compBox[c][2], p.Y());
            compBox[c][3] = std::max(compBox[c][3], p.Y());
            compBox[c][4] = std::min(compBox[c][4], p.Z());
            compBox[c][5] = std::max(compBox[c][5], p.Z());
          }
        }

        // Sort components by bbox volume (largest first).
        auto vol = [](const std::array<double,6>& b) {
          return (b[1]-b[0]) * (b[3]-b[2]) * (b[5]-b[4]);
        };
        std::vector<int> order(nComp);
        for (int c = 0; c < nComp; ++c) order[c] = c;
        std::sort(order.begin(), order.end(),
                  [&](int a, int b){ return vol(compBox[a]) > vol(compBox[b]); });

        // Helper: does box b contain box i (with tolerance)?
        auto contains = [&](int outer, int inner) {
          const auto& bo = compBox[outer]; const auto& bi = compBox[inner];
          constexpr double tol = 1e-3;
          return bi[0] >= bo[0] - tol && bi[1] <= bo[1] + tol
              && bi[2] >= bo[2] - tol && bi[3] <= bo[3] + tol
              && bi[4] >= bo[4] - tol && bi[5] <= bo[5] + tol;
        };

        // Determine each component's "containment depth": how many other
        // components strictly contain it. Depth 0 = outermost. Depth 1 =
        // immediate void of a depth-0. Depth 2 = outermost of nested solid
        // (contained by depth-0 and depth-1). Depth 3 = void of that. So
        // even-depth components are outer envelopes; odd-depth components
        // are the voids of the next-shallower outer.
        std::vector<int> depth(nComp, 0);
        for (int a = 0; a < nComp; ++a) {
          for (int b = 0; b < nComp; ++b) {
            if (a == b) continue;
            if (contains(b, a)) ++depth[a];
          }
        }
        // Group: each even-depth component is an outer. Its immediate void
        // is the odd-depth component that it directly contains with no
        // intervening even-depth component between them.
        std::vector<std::pair<int, std::vector<int>>> groups;
        for (int o = 0; o < nComp; ++o) {
          if (depth[o] % 2 != 0) continue;  // skip voids
          std::vector<int> voids;
          for (int v = 0; v < nComp; ++v) {
            if (v == o) continue;
            if (depth[v] != depth[o] + 1) continue;  // must be direct child
            if (!contains(o, v)) continue;
            voids.push_back(v);
          }
          groups.push_back({o, std::move(voids)});
        }

        if (groups.size() <= 1) return {};

        std::vector<TopoDS_Shape> result;
        for (const auto& g : groups) {
          BRepBuilderAPI_MakeSolid mk(compShells[g.first]);
          for (int vi : g.second) mk.Add(compShells[vi]);
          mk.Build();
          if (mk.IsDone()) result.push_back(mk.Solid());
        }
        return result;
      };

      std::vector<TopoDS_Shape> wsComponents = splitConnectedComponents(workShape);
      if (wsComponents.empty()) {
        for (TopExp_Explorer ex(workShape, TopAbs_SOLID); ex.More(); ex.Next()) {
          wsComponents.push_back(ex.Current());
        }
      }

      std::vector<ShapeHistoryRecord> shapeHistory;
      TopoDS_Shape firstPassRemainder;
      if (wsComponents.size() > 1) {
        // Each component is now a simple closed solid (a hollow cube after
        // flange extraction); a single splitMode2 pass produces the panels.
        // depth=1 ensures recursiveDecompose runs once but does not recurse
        // on its own remainder ÔÇö the bleed from protrusion extraction
        // leaves 0.05 mm-thick face slivers in the workShape that deeper
        // recursion would emit as spurious extra panels.
        for (const auto& comp : wsComponents) {
          recursiveDecompose(comp, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, /*depth=*/1,
                             panelIds, protrusionIds, protrusionParents);
        }
      } else if (mode == "thin_solid") {
        splitMode2(workShape, planeHalfSize, parentId, angleThresholdDeg, maxThicknessMm,
                   panelIds, protrusionIds, protrusionParents, &firstPassRemainder, &shapeHistory);
      } else {
        splitMode1BFS(workShape, parentId, angleThresholdDeg, defaultThicknessMm, panelIds,
                      &shapeHistory);
      }

      // T022 ÔÇö Recursive decomposition into remainder solid(s)
      if (maxRecursionDepth > 0 && !firstPassRemainder.IsNull()) {
        bool hadSolid = false;
        for (TopExp_Explorer ex(firstPassRemainder, TopAbs_SOLID); ex.More(); ex.Next()) {
          recursiveDecompose(ex.Current(), parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, maxRecursionDepth - 1, panelIds,
                             protrusionIds, protrusionParents);
          hadSolid = true;
        }
        if (!hadSolid) {
          recursiveDecompose(firstPassRemainder, parentId, angleThresholdDeg, maxThicknessMm,
                             defaultThicknessMm, maxRecursionDepth - 1, panelIds,
                             protrusionIds, protrusionParents);
        }
      }

      // Compute AABB for each panel/protrusion by iterating vertices and filtering
      // out cap-face rectangle corners.  Boolean ops with a large planeFace leave
      // those rectangle corners as real OCCT vertices, but they always lie outside
      // the original solid's bounding box (bxMin..bxMax etc.).  Skipping any vertex
      // more than 1 mm outside that box gives geometrically correct panel extents
      // without any extra Boolean operations.
      auto computeBboxes = [&](const std::vector<ShellId>& ids) {
        std::vector<BBox3D> bboxes;
        bboxes.reserve(ids.size());
        constexpr double kTol = 1.0;  // mm ÔÇö tolerance for on-boundary vertices
        for (const auto& id : ids) {
          auto it = s_.shells.find(id);
          if (it != s_.shells.end()) {
            Bnd_Box b;
            for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX);
                 ex.More(); ex.Next()) {
              gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
              // Discard planeFace rectangle corners: they always lie outside the
              // original solid's bounding box by more than kTol.
              if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
              if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
              if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
              b.Add(p);
            }
            if (!b.IsVoid()) {
              double xMin, yMin, zMin, xMax, yMax, zMax;
              b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
              bboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
            } else {
              bboxes.push_back({0, 0, 0, 0, 0, 0});
            }
          } else {
            bboxes.push_back({0, 0, 0, 0, 0, 0});
          }
        }
        return bboxes;
      };

      // US1: Facet Unification Pass - Merge adjacent coplanar/planar triangular facets
      // of complex segmented models (like cauldron.step) into flat panels.
      for (const auto& pid : panelIds) {
        auto shellIt = s_.shells.find(pid);
        if (shellIt != s_.shells.end() && !shellIt->second.shape.IsNull()) {
          try {
            ShapeUpgrade_UnifySameDomain unifier(shellIt->second.shape, Standard_True, Standard_True, Standard_True);
            double angTolRad = angleThresholdDeg * M_PI / 180.0;
            if (angTolRad < 1e-6) angTolRad = 0.0087; // default 0.5 degrees
            unifier.SetAngularTolerance(angTolRad);
            unifier.SetLinearTolerance(0.05); // slightly looser linear tol to heal facets
            unifier.Build();
            TopoDS_Shape unifiedShape = unifier.Shape();
            if (!unifiedShape.IsNull()) {
              shellIt->second.shape = unifiedShape;
            }
          } catch (...) {
            // Keep original shape if unification fails
          }
        }
      }

      auto panelBboxes      = computeBboxes(panelIds);
      auto protrusionBboxes = computeBboxes(protrusionIds);

      return DecomposedByBendsResult{
          std::move(panelIds), std::move(panelBboxes),
          std::move(protrusionIds), std::move(protrusionBboxes),
          std::move(protrusionParents),
          token, mode, std::move(shapeHistory)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          true, "");
    }
  }
  // ÔöÇÔöÇ Remove protrusions ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  RemoveProtrusionsResult removeProtrusions(
      const ShellId& partId,
      double angleThresholdDeg = 30.0,
      double maxThicknessMm   = 5.0) {

    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != s_.solids.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }

    if (inputShape.IsNull()) {
      throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Null shape provided for protrusion removal", false, "");
    }

    SnapshotId token = s_.createSnapshot("before removeProtrusions (loop_traversal) on " + partId);

    try {
      // 1. Compute Center of Mass & Face Groups
      GProp_GProps vp;
      BRepGProp::VolumeProperties(inputShape, vp);
      gp_Pnt solidCentroid = vp.CentreOfMass();

      TopTools_IndexedMapOfShape faceMap;
      TopExp::MapShapes(inputShape, TopAbs_FACE, faceMap);
      int nFaces = faceMap.Extent();

      auto faceGroups = buildFaceGroups(inputShape, faceMap, angleThresholdDeg, solidCentroid);
      auto candidates = detectProtrusions(inputShape, faceMap, faceGroups, maxThicknessMm);

      std::vector<ShellId> protrusionIds;
      std::vector<ShapeHistoryRecord> shapeHistory;
      
      // We will build the cleaned host shape by removing protrusion faces and capping the boundary loops.
      std::vector<TopoDS_Face> hostFaces;
      std::vector<bool> isRemovedFace(nFaces + 1, false);

      for (const auto& pc : candidates) {
        for (int idx : pc.faceIndices) {
          if (idx > 0 && idx <= nFaces) {
            isRemovedFace[idx] = true;
          }
        }
      }

      for (int i = 1; i <= nFaces; ++i) {
        if (!isRemovedFace[i]) {
          hostFaces.push_back(TopoDS::Face(faceMap(i)));
        }
      }

      // Map edges to faces to find boundary edges
      TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
      TopExp::MapShapesAndAncestors(inputShape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);

      // Process each candidate protrusion
      for (size_t cIdx = 0; cIdx < candidates.size(); ++cIdx) {
        const auto& pc = candidates[cIdx];
        std::vector<bool> isProtFace(nFaces + 1, false);
        for (int idx : pc.faceIndices) {
          isProtFace[idx] = true;
        }

        std::vector<TopoDS_Edge> boundaryEdges;
        for (int e = 1; e <= edgeFaces.Extent(); ++e) {
          const TopoDS_Edge& edge = TopoDS::Edge(edgeFaces.FindKey(e));
          const TopTools_ListOfShape& fl = edgeFaces(e);
          int protCount = 0;
          int hostCount = 0;
          for (TopTools_ListIteratorOfListOfShape it(fl); it.More(); it.Next()) {
            int fIdx = faceMap.FindIndex(it.Value());
            if (fIdx > 0) {
              if (isProtFace[fIdx]) {
                protCount++;
              } else {
                hostCount++;
              }
            }
          }
          if (protCount == 1 && hostCount >= 1) {
            boundaryEdges.push_back(edge);
          }
        }

        if (boundaryEdges.empty()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "No boundary edges found for protrusion", false, "");
        }

        BRepBuilderAPI_MakeWire wireMaker;
        for (const auto& edge : boundaryEdges) {
          wireMaker.Add(edge);
        }

        if (!wireMaker.IsDone()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Failed to build closed seam wire for protrusion", false, "");
        }

        TopoDS_Wire wire = wireMaker.Wire();

        // Build cap face on host plane
        gp_Pln hostPlane(pc.panelCentroid, gp_Dir(pc.panelNormal));
        BRepBuilderAPI_MakeFace faceMaker(hostPlane, wire, Standard_True);
        if (!faceMaker.IsDone()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Failed to build planar cap face for protrusion wire", false, "");
        }

        TopoDS_Face capFace = faceMaker.Face();

        // Build protrusion solid by sewing protrusion faces + cap face
        BRepBuilderAPI_Sewing sewer;
        sewer.Init();
        sewer.SetTolerance(0.1);
        for (int idx : pc.faceIndices) {
          sewer.Add(faceMap(idx));
        }
        sewer.Add(capFace);
        sewer.Perform();
        
        TopoDS_Shape sewedProtrusion = sewer.SewedShape();
        if (sewedProtrusion.IsNull()) {
          throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Sewing failed for protrusion", false, "");
        }

        TopoDS_Solid protrusionSolid;
        BRepBuilderAPI_MakeSolid solidMaker;
        TopExp_Explorer shellExp(sewedProtrusion, TopAbs_SHELL);
        if (shellExp.More()) {
          solidMaker.Add(TopoDS::Shell(shellExp.Current()));
          if (solidMaker.Solid().IsNull() == Standard_False && solidMaker.IsDone()) {
            protrusionSolid = solidMaker.Solid();
          }
        }
        
        TopoDS_Shape finalProtrusion = protrusionSolid.IsNull() ? sewedProtrusion : protrusionSolid;

        ShellId pid = generateUUID();
        s_.shells[pid] = ShellState{pid, inputParentId, finalProtrusion};
        protrusionIds.push_back(pid);

        TopoDS_Face reversedCap = TopoDS::Face(capFace.Reversed());
        hostFaces.push_back(reversedCap);
        
        for (int idx : pc.faceIndices) {
          shapeHistory.push_back({
            "replace",
            shapeId(faceMap(idx)),
            pid,
            "removeProtrusions"
          });
        }
      }

      BRepBuilderAPI_Sewing hostSewer;
      hostSewer.Init();
      hostSewer.SetTolerance(0.1);
      for (const auto& f : hostFaces) {
        hostSewer.Add(f);
      }
      hostSewer.Perform();
      TopoDS_Shape sewedHost = hostSewer.SewedShape();
      if (sewedHost.IsNull()) {
        throw GeometryError("GE_PROTRUSION_LOOP_FAILED", "Sewing failed for cleaned host shape", false, "");
      }

      TopoDS_Solid hostSolid;
      BRepBuilderAPI_MakeSolid solidMaker;
      TopExp_Explorer shellExp(sewedHost, TopAbs_SHELL);
      if (shellExp.More()) {
        solidMaker.Add(TopoDS::Shell(shellExp.Current()));
        if (solidMaker.Solid().IsNull() == Standard_False && solidMaker.IsDone()) {
          hostSolid = solidMaker.Solid();
        }
      }
      TopoDS_Shape finalHost = hostSolid.IsNull() ? sewedHost : hostSolid;

      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        shellIt->second.shape = finalHost;
      } else if (solidIt != s_.solids.end()) {
        solidIt->second.shape = finalHost;
      }

      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(inputShape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }

      constexpr double kTol = 1.0;
      std::vector<BBox3D> protrusionBboxes;
      protrusionBboxes.reserve(protrusionIds.size());
      for (const auto& pid : protrusionIds) {
        auto it = s_.shells.find(pid);
        if (it == s_.shells.end()) { protrusionBboxes.push_back({0,0,0,0,0,0}); continue; }
        Bnd_Box b;
        for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
          gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
          if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
          if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
          if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
          b.Add(p);
        }
        if (!b.IsVoid()) {
          double xMin, yMin, zMin, xMax, yMax, zMax;
          b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
          protrusionBboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
        } else {
          protrusionBboxes.push_back({0,0,0,0,0,0});
        }
      }

      return RemoveProtrusionsResult{partId, std::move(protrusionIds),
                                     std::move(protrusionBboxes), token, std::move(shapeHistory)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_PROTRUSION_LOOP_FAILED",
                          std::string("OCCT exception during loop protrusion removal: ") + e.GetMessageString(),
                          true, "");
    }
  }
  RemoveProtrusionsResult removeProtrusionsLegacy(
      const ShellId& partId,
      double angleThresholdDeg = 30.0,
      double maxThicknessMm   = 5.0) {

    std::lock_guard<std::mutex> lock(s_.mutex);
    TopoDS_Shape inputShape;
    SolidId      inputParentId;
    {
      auto shellIt = s_.shells.find(partId);
      auto solidIt = s_.solids.find(partId);
      if (shellIt != s_.shells.end()) {
        inputShape    = shellIt->second.shape;
        inputParentId = shellIt->second.parentSolidId;
      } else if (solidIt != s_.solids.end()) {
        inputShape    = solidIt->second.shape;
        inputParentId = partId;
      } else {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partId, false, "");
      }
    }

    SnapshotId token = s_.createSnapshot("before removeProtrusions on " + partId);

    try {
      double bxMin = 1e30, bxMax = -1e30;
      double byMin = 1e30, byMax = -1e30;
      double bzMin = 1e30, bzMax = -1e30;
      for (TopExp_Explorer ex(inputShape, TopAbs_VERTEX); ex.More(); ex.Next()) {
        gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
        bxMin = std::min(bxMin, p.X()); bxMax = std::max(bxMax, p.X());
        byMin = std::min(byMin, p.Y()); byMax = std::max(byMax, p.Y());
        bzMin = std::min(bzMin, p.Z()); bzMax = std::max(bzMax, p.Z());
      }
      double diagSq = (bxMax-bxMin)*(bxMax-bxMin)
                    + (byMax-byMin)*(byMax-byMin)
                    + (bzMax-bzMin)*(bzMax-bzMin);
      double planeHalfSize = (diagSq > 0 ? std::sqrt(diagSq) : 1000.0) * 1.1 + 10.0;

      GProp_GProps vp;
      BRepGProp::VolumeProperties(inputShape, vp);
      gp_Pnt solidCentroid = vp.CentreOfMass();

      TopTools_IndexedMapOfShape faceMap;
      TopExp::MapShapes(inputShape, TopAbs_FACE, faceMap);
      auto faceGroups = buildFaceGroups(inputShape, faceMap, angleThresholdDeg, solidCentroid);
      auto candidates = detectProtrusions(inputShape, faceMap, faceGroups, maxThicknessMm);

      std::vector<ShellId> protrusionIds;
      TopoDS_Shape workShape = inputShape;
      for (const auto& pc : candidates) {
        TopoDS_Shape newRemainder;
        try {
          TopoDS_Shape ps = extractProtrusion(workShape, pc, newRemainder, planeHalfSize);
          ShellId pid = generateUUID();
          s_.shells[pid] = ShellState{pid, inputParentId, ps};
          protrusionIds.push_back(pid);
          workShape = std::move(newRemainder);
        } catch (const GeometryError&) {}
      }

      auto shellIt = s_.shells.find(partId);
      if (shellIt != s_.shells.end()) {
        shellIt->second.shape = workShape;
      }

      constexpr double kTol = 1.0;
      std::vector<BBox3D> protrusionBboxes;
      protrusionBboxes.reserve(protrusionIds.size());
      for (const auto& pid : protrusionIds) {
        auto it = s_.shells.find(pid);
        if (it == s_.shells.end()) { protrusionBboxes.push_back({0,0,0,0,0,0}); continue; }
        Bnd_Box b;
        for (TopExp_Explorer ex(it->second.shape, TopAbs_VERTEX); ex.More(); ex.Next()) {
          gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(ex.Current()));
          if (p.X() < bxMin - kTol || p.X() > bxMax + kTol) continue;
          if (p.Y() < byMin - kTol || p.Y() > byMax + kTol) continue;
          if (p.Z() < bzMin - kTol || p.Z() > bzMax + kTol) continue;
          b.Add(p);
        }
        if (!b.IsVoid()) {
          double xMin, yMin, zMin, xMax, yMax, zMax;
          b.Get(xMin, yMin, zMin, xMax, yMax, zMax);
          protrusionBboxes.push_back({xMin, yMin, zMin, xMax, yMax, zMax});
        } else {
          protrusionBboxes.push_back({0,0,0,0,0,0});
        }
      }

      return RemoveProtrusionsResult{partId, std::move(protrusionIds),
                                     std::move(protrusionBboxes), token};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_DECOMPOSE_BY_BENDS_FAILED",
                          std::string("OCCT exception: ") + e.GetMessageString(),
                          true, "");
    }
  }
  // ÔöÇÔöÇ Trim body with plane ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

  TrimBodyResult trimBodyWithPlane(const ShellId&      partId,
                                   const CuttingPlane& plane,
                                   bool                keepPositiveSide) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    ResolvedShape resolved = resolveShellOrSolidIn(s_, partId, "Shell or solid not found: " + partId);
    TopoDS_Shape originalShape = resolved.shape;
    bool isSolid = resolved.isSolid;

    // Snapshot before mutation (Constitution Principle IV)
    SnapshotId token = s_.createSnapshot("before trimBodyWithPlane on " + partId);

    try {
      gp_Pnt origin(plane.originX, plane.originY, plane.originZ);
      double normLength = std::sqrt(plane.normalX * plane.normalX +
                                    plane.normalY * plane.normalY +
                                    plane.normalZ * plane.normalZ);
      if (normLength < 1e-10) {
        throw GeometryError("GE_TRIM_FAILED", "Cutting plane normal is zero", false, "");
      }
      gp_Dir normal(plane.normalX / normLength,
                    plane.normalY / normLength,
                    plane.normalZ / normLength);
      gp_Pln gPlane(origin, normal);

      // Build half-space on the side to keep
      BRepBuilderAPI_MakeFace faceMaker(gPlane, -1e6, 1e6, -1e6, 1e6);
      TopoDS_Face planeFace = faceMaker.Face();

      // Reference point on the side the tool occupies (opposite to keep side)
      gp_Vec n(normal);
      gp_Pnt refPt = keepPositiveSide
          ? origin.Translated(n * -100.0)   // tool on negative side Æ keep positive
          : origin.Translated(n * 100.0);   // tool on positive side Æ keep negative

      BRepPrimAPI_MakeHalfSpace halfSpace(planeFace, refPt);
      TopoDS_Solid halfSpaceSolid = halfSpace.Solid();

      TopoDS_Shape inputForHistory = originalShape;
      BRepAlgoAPI_Cut cutter(originalShape, halfSpaceSolid);
      cutter.Build();

      if (!cutter.IsDone()) {
        throw GeometryError("GE_TRIM_FAILED",
                            "Plane trim failed for part: " + partId, true, "rollback");
      }

      TopoDS_Shape result = cutter.Shape();
      if (result.IsNull()) {
        throw GeometryError("GE_TRIM_FAILED",
                            "Plane trim produced empty result", true, "rollback");
      }

      // Replace the shape in-place
      if (isSolid) {
        s_.solids[partId].shape = result;
      } else {
        s_.shells[partId].shape = result;
      }

      auto history = captureHistory(cutter, inputForHistory,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "trimBodyWithPlane");
      return TrimBodyResult{partId, token, std::move(history)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_TRIM_FAILED",
                          std::string("OCCT exception during trim: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

private:
  GeometryState& s_;
};

// ─── Delegation stubs ────────────────────────────────────────────────────────

SplitBodyResult GeometryServiceImpl::splitBodyByPlane(const ShellId& partId, const CuttingPlane& plane) {
  return GeometrySheetMetal(state_).splitBodyByPlane(partId, plane);
}

DecomposedByBendsResult GeometryServiceImpl::splitBodyByBends(const ShellId& partId,
                                                                double angleThresholdDeg,
                                                                double maxThicknessMm,
                                                                double defaultThicknessMm,
                                                                int    maxRecursionDepth) {
  return GeometrySheetMetal(state_).splitBodyByBends(partId, angleThresholdDeg, maxThicknessMm,
                                                       defaultThicknessMm, maxRecursionDepth);
}

RemoveProtrusionsResult GeometryServiceImpl::removeProtrusions(const ShellId& partId,
                                                                  double angleThresholdDeg,
                                                                  double maxThicknessMm) {
  return GeometrySheetMetal(state_).removeProtrusions(partId, angleThresholdDeg, maxThicknessMm);
}

RemoveProtrusionsResult GeometryServiceImpl::removeProtrusionsLegacy(const ShellId& partId,
                                                                        double angleThresholdDeg,
                                                                        double maxThicknessMm) {
  return GeometrySheetMetal(state_).removeProtrusionsLegacy(partId, angleThresholdDeg, maxThicknessMm);
}

TrimBodyResult GeometryServiceImpl::trimBodyWithPlane(const ShellId& partId, const CuttingPlane& plane,
                                                        bool keepPositiveSide) {
  return GeometrySheetMetal(state_).trimBodyWithPlane(partId, plane, keepPositiveSide);
}

} // namespace mcp_cad
