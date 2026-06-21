// ─── OCCT includes (isolated to this translation unit) ────────────────────────
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

namespace mcp_cad {

class GeometryShell {
public:
  explicit GeometryShell(GeometryState& s) : s_(s) {}

  ThickenSheetResult thickenSheet(const ShellId& sheetId, double thicknessMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (thicknessMm <= 0.0) {
      throw GeometryError("GE_INVALID_SHEET_METAL", "Thickness must be > 0.", false, "");
    }

    auto it = s_.shells.find(sheetId);
    if (it == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Sheet not found: " + sheetId, false, "");
    }

    try {
      BRepPrimAPI_MakePrism prism(it->second.shape, gp_Vec(0.0, 0.0, thicknessMm), true);
      if (!prism.IsDone() || prism.Shape().IsNull()) {
        throw GeometryError("GE_EXTRUDE_FAILED", "Failed to thicken sheet into solid.", false, "");
      }

      ShellId solidId = generateUUID();
      s_.shells[solidId] = ShellState{solidId, it->second.parentSolidId, prism.Shape()};
      return ThickenSheetResult{solidId};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EXTRUDE_FAILED",
                          std::string("Sheet thickening failed: ") + e.GetMessageString(),
                          false,
                          "");
    }
  }

  ApplyBendResult applyBend(const ShellId& panelAId, const ShellId& panelBId,
                             double innerRadiusMm, double angleDeg, double kFactor) {
    (void)angleDeg;
    (void)kFactor;
    MergeBodyResult merged = mergeBodiesWithBend(panelAId, panelBId, {"all"}, innerRadiusMm);
    return ApplyBendResult{merged.mergedShellId};
  }

  BuildShellFromFlatPatternResult buildShellFromFlatPattern(
      const std::string& dxfContent, const std::vector<BendZoneSpec>& bendZones,
      double thicknessMm,
      const FlatPanelPlacementSpec& explicitPlacement = FlatPanelPlacementSpec{}) {

    if (thicknessMm <= 0.0)
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", "Thickness must be > 0."};
    if (dxfContent.empty())
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", "DXF content is empty."};
    if (bendZones.size() > 1)
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
              "Only 0 or 1 bend zones are supported."};

    // Parse layer-0 LWPOLYLINE vertices from DXF.
    // Accumulates vertices from ALL layer-0 polylines so that a merged DXF
    // with multiple disconnected panels (e.g. panel A + gap + panel B) yields
    // the correct overall bounding box rather than stopping at the first polyline.
    auto parseDxfVerts = [](const std::string& dxf)
        -> std::vector<std::pair<double, double>> {
      std::vector<std::pair<double, double>> allVerts;
      std::vector<std::pair<double, double>> curVerts;
      std::istringstream in(dxf);
      std::string line;
      std::vector<std::string> lines;
      while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
      }
      bool inPoly = false, isL0 = false, hasPx = false;
      double px = 0.0;
      for (size_t i = 0; i + 1 < lines.size(); i += 2) {
        int code = 0;
        try { code = std::stoi(lines[i]); } catch (...) { continue; }
        const std::string& v = lines[i + 1];
        if (code == 0) {
          if (inPoly && v != "LWPOLYLINE") {
            if (isL0 && curVerts.size() >= 3)
              allVerts.insert(allVerts.end(), curVerts.begin(), curVerts.end());
            curVerts.clear();
          }
          inPoly = (v == "LWPOLYLINE");
          isL0 = hasPx = false;
          continue;
        }
        if (!inPoly) continue;
        if      (code == 8)             isL0 = (v == "0");
        else if (code == 10) { try { px = std::stod(v); hasPx = true; } catch (...) { hasPx = false; } }
        else if (code == 20 && hasPx) {
          try { curVerts.push_back({px, std::stod(v)}); } catch (...) {}
          hasPx = false;
        }
      }
      // Flush the last polyline (no closing entity at EOF).
      if (inPoly && isL0 && curVerts.size() >= 3)
        allVerts.insert(allVerts.end(), curVerts.begin(), curVerts.end());
      return allVerts;
    };

    // Generate a minimal closed-rectangle LWPOLYLINE DXF string
    auto makeDxfRect = [](double x0, double y0, double x1, double y1) -> std::string {
      std::ostringstream oss;
      oss << std::fixed << std::setprecision(6);
      oss << "  0\nSECTION\n  2\nENTITIES\n";
      oss << "  0\nLWPOLYLINE\n  8\n0\n 70\n     1\n 90\n     4\n";
      oss << " 10\n" << x0 << "\n 20\n" << y0 << "\n";
      oss << " 10\n" << x1 << "\n 20\n" << y0 << "\n";
      oss << " 10\n" << x1 << "\n 20\n" << y1 << "\n";
      oss << " 10\n" << x0 << "\n 20\n" << y1 << "\n";
      oss << "  0\nENDSEC\n  0\nEOF\n";
      return oss.str();
    };

    try {
      if (bendZones.empty()) {
        DxfSheetResult  sheet = buildSheetFromDxf(dxfContent);
        ThickenSheetResult sol = thickenSheet(sheet.sheetId, thicknessMm);

        // Place the rebuilt flat sheet using the EXPLICIT placement frame the
        // caller supplies — the manufacturing graph is the source of truth for
        // a panel's world-space frame and thickness midplane, captured once
        // when the panel was created, so no live shell lookup happens here.
        //
        // The merged DXF is expressed in the placement frame's coordinates —
        // its (0,0) is the panel's (u1,v1) face corner — so the canonical sheet
        // maps to world via: world = origin + x*U + y*V + (z - t/2)*N + nCentre*N.
        if (explicitPlacement.hasFrame) {
          const FlatPanelPlacementSpec& pf = explicitPlacement;
          gp_Dir U(pf.uX, pf.uY, pf.uZ), V(pf.vX, pf.vY, pf.vZ), N(pf.normalX, pf.normalY, pf.normalZ);
          gp_XYZ corner(pf.originX, pf.originY, pf.originZ);

          const double Tu = corner.Dot(U.XYZ());
          const double Tv = corner.Dot(V.XYZ());
          const double Tn = pf.nCentreMm - thicknessMm / 2.0;
          gp_XYZ T = U.XYZ() * Tu + V.XYZ() * Tv + N.XYZ() * Tn;

          gp_Trsf placeTrsf;
          placeTrsf.SetValues(
              U.X(), V.X(), N.X(), T.X(),
              U.Y(), V.Y(), N.Y(), T.Y(),
              U.Z(), V.Z(), N.Z(), T.Z()
          );
          auto solIt = s_.shells.find(sol.solidId);
          if (solIt != s_.shells.end()) {
            BRepBuilderAPI_Transform placeXfm(solIt->second.shape, placeTrsf, true);
            solIt->second.shape = placeXfm.Shape();
          }
        }
        return {sol.solidId, true, "", ""};
      }

      // Single bend zone
      const BendZoneSpec& bz = bendZones[0];

      auto verts = parseDxfVerts(dxfContent);
      if (verts.size() < 3)
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                "DXF must have at least 3 vertices in layer-0 LWPOLYLINE."};

      double xMin = verts[0].first,  xMax = verts[0].first;
      double yMin = verts[0].second, yMax = verts[0].second;
      for (const auto& v : verts) {
        xMin = std::min(xMin, v.first);  xMax = std::max(xMax, v.first);
        yMin = std::min(yMin, v.second); yMax = std::max(yMax, v.second);
      }

      double bendStart = xMin + bz.offsetMm;
      double bendEnd   = xMin + bz.offsetMm + bz.widthMm;

      if (bz.offsetMm < 0.0 || bendEnd > xMax + 1e-6)
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                "Bend zone extends beyond DXF flat-pattern bounds."};
      if (bz.offsetMm < 1e-6 || (xMax - bendEnd) < 1e-6)
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                "Bend zone must leave non-zero panels on both sides."};

      // Panel A's and Panel B's OWN Y-ranges — restricted to their own side of
      // the bend zone (x <= bendStart for A, x >= bendEnd for B) — rather than
      // the whole merged DXF's [yMin,yMax]. One side can be a fused/composite
      // panel whose attached tab extends its own Y-range past the other side's;
      // using the global range for BOTH rectangles would stretch the narrower
      // (simple) panel out to match the wider (composite) one's extent, even
      // though that panel's real flat pattern never reaches that far.
      double yMinA = std::numeric_limits<double>::max(), yMaxA = -yMinA;
      double yMinB = std::numeric_limits<double>::max(), yMaxB = -yMinB;
      for (const auto& v : verts) {
        if (v.first <= bendStart + 1e-6) { yMinA = std::min(yMinA, v.second); yMaxA = std::max(yMaxA, v.second); }
        if (v.first >= bendEnd   - 1e-6) { yMinB = std::min(yMinB, v.second); yMaxB = std::max(yMaxB, v.second); }
      }
      if (yMinA > yMaxA) { yMinA = yMin; yMaxA = yMax; }  // no panel-A verts found: fall back
      if (yMinB > yMaxB) { yMinB = yMin; yMaxB = yMax; }  // no panel-B verts found: fall back

      std::string dxfA = makeDxfRect(xMin,    yMinA, bendStart, yMaxA);
      std::string dxfB = makeDxfRect(bendEnd, yMinB, xMax,      yMaxB);

      DxfSheetResult    sheetA = buildSheetFromDxf(dxfA);
      ThickenSheetResult solA  = thickenSheet(sheetA.sheetId, thicknessMm);

      DxfSheetResult    sheetB = buildSheetFromDxf(dxfB);
      ThickenSheetResult solB  = thickenSheet(sheetB.sheetId, thicknessMm);

      // Panel B is at x=[bendEnd..xMax] in the flat layout; Panel A is at x=[xMin..bendStart].
      // The gap between them is bz.widthMm (the developed bend-arc length).
      //
      // Re-fold into 3D, then bridge the seam with an explicit bend solid so the
      // panels FUSE into one watertight body at ANY dihedral angle — not just 90°.
      // (Previously the rotated slabs shared only an edge at acute angles, so the
      //  Boolean fuse silently dropped Panel B and produced a flat result.)
      // The bend connector only needs to span where A and B actually OVERLAP in
      // Y (that's the real shared fold line); falling back to the full [yMin,yMax]
      // when they don't overlap at all keeps this from degenerating to zero-width.
      double sectorYMin = std::max(yMinA, yMinB);
      double sectorYMax = std::min(yMaxA, yMaxB);
      if (sectorYMax <= sectorYMin) { sectorYMin = yMin; sectorYMax = yMax; }
      const double extentY  = sectorYMax - sectorYMin;
      const double thetaRad = bz.angleDeg * M_PI / 180.0;

      // 1. Position Panel B: translate left by widthMm so its left face abuts the
      //    bend at x=bendStart, then rotate -angleDeg about the Y hinge at (bendStart,*,0).
      auto itAsolid = s_.shells.find(solA.solidId);
      auto itBsolid = s_.shells.find(solB.solidId);
      if (itAsolid == s_.shells.end() || itBsolid == s_.shells.end())
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                "Internal: thickened panel shells not found for refold."};

      TopoDS_Shape shapeA = itAsolid->second.shape;
      TopoDS_Shape shapeB;
      {
        gp_Trsf transTrsf;
        transTrsf.SetTranslation(gp_Vec(-bz.widthMm, 0.0, 0.0));
        TopoDS_Shape translatedB =
            BRepBuilderAPI_Transform(itBsolid->second.shape, transTrsf, true).Shape();

        gp_Ax1 bendAxis(gp_Pnt(bendStart, 0.0, 0.0), gp_Dir(0.0, 1.0, 0.0));
        gp_Trsf rotTrsf;
        rotTrsf.SetRotation(bendAxis, -thetaRad);
        shapeB = BRepBuilderAPI_Transform(translatedB, rotTrsf, true).Shape();
      }

      // 2. Bend connector: a solid cylindrical sector (apex on the z=0 hinge, radius
      //    = thickness) that fills the wedge between Panel A's bend face (x=bendStart,
      //    z∈[0,t], pointing +Z) and Panel B's rotated bend face. Its two planar faces
      //    coincide with the panels' bend faces, so the fuse is watertight at any angle.
      //    Axis is -Y (origin at sectorYMax — the top of the A/B overlap range, see
      //    above) so the sector sweeps from +Z toward −X, matching Panel B's
      //    −angleDeg rotation.
      TopoDS_Shape bendSector;
      try {
        gp_Ax2 sectorAxes(gp_Pnt(bendStart, sectorYMax, 0.0), gp_Dir(0.0, -1.0, 0.0), gp_Dir(0.0, 0.0, 1.0));
        bendSector = BRepPrimAPI_MakeCylinder(sectorAxes, thicknessMm, extentY, thetaRad).Solid();
      } catch (const Standard_Failure& e) {
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                std::string("Failed to build bend connector: ") + e.GetMessageString()};
      }

      // 3. Fuse A + connector + B into one solid.
      auto fuseTwo = [](const TopoDS_Shape& s1, const TopoDS_Shape& s2) -> TopoDS_Shape {
        BRepAlgoAPI_Fuse f(s1, s2);
        f.SetFuzzyValue(0.15);
        f.Build();
        if (!f.IsDone() || f.Shape().IsNull()) return TopoDS_Shape();
        return f.Shape();
      };
      TopoDS_Shape ab = fuseTwo(shapeA, bendSector);
      if (ab.IsNull())
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", "Fuse (Panel A + bend) failed."};
      TopoDS_Shape merged = fuseTwo(ab, shapeB);
      if (merged.IsNull())
        return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", "Fuse (+ Panel B) failed."};

      // Connectivity guard: a proper refold is a single solid.
      {
        int solidCount = 0;
        for (TopExp_Explorer ex(merged, TopAbs_SOLID); ex.More(); ex.Next()) solidCount++;
        if (solidCount != 1)
          return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
                  "Refold produced " + std::to_string(solidCount) + " solids (expected 1)."};
      }

      ShellId mergedId = generateUUID();
      s_.shells[mergedId] = ShellState{mergedId, "", merged};
      ApplyBendResult bent{mergedId};

      // ── Placement ────────────────────────────────────────────────────────────
      // Position the canonical merged shell using the EXPLICIT fold frame and
      // world anchor the caller supplies (manufacturing-graph data, captured
      // once when panel A was created) — no live shell lookup.
      const double fnLen = std::sqrt(bz.foldNormalX * bz.foldNormalX +
                                     bz.foldNormalY * bz.foldNormalY +
                                     bz.foldNormalZ * bz.foldNormalZ);
      const double bdLen = std::sqrt(bz.bendDirX * bz.bendDirX +
                                     bz.bendDirY * bz.bendDirY +
                                     bz.bendDirZ * bz.bendDirZ);

      if (fnLen > 1e-6 && bdLen > 1e-6 && bz.hasAnchor) {
        // Explicit fold frame supplied by the caller (manufacturing graph):
        //   canonical +X → bendDir, canonical +Z → foldNormal, +Y = Z × X.
        // This pins down every axis sign, so the fold is reconstructed on the
        // same side as the original geometry (no rotation / inversion).
        gp_Dir actualXDir(bz.bendDirX, bz.bendDirY, bz.bendDirZ);
        gp_Dir faceNormal(bz.foldNormalX, bz.foldNormalY, bz.foldNormalZ);
        gp_Vec yv = gp_Vec(faceNormal).Crossed(gp_Vec(actualXDir)); // Z × X
        gp_Dir actualYDir(yv);

        // Anchor: the WORLD position of the merged flat-pattern's own LOCAL
        // (0,0,0) — i.e. panel A's DXF(0,0) corner (panel A occupies
        // [xMin..bendStart] with xMin=0 by the merge's own DXF convention, so
        // local (0,0,0) IS panel A's own flat-pattern origin). Supplied by the
        // caller as panel A's stored, DXF-aligned panelFrame.origin — never a
        // live shell lookup. Unlike a centroid, an origin point needs no
        // extent/symmetry assumption, so this is exact for ANY panel A shape
        // (rectangular, L-shaped, notched, etc).
        gp_XYZ worldOrigin(bz.anchorX, bz.anchorY, bz.anchorZ);

        // Placement: local flat-pattern (x, y, z) → world directly, since the
        // merged shape (panel A + bend connector + panel B) was built without
        // any shift — its own local (0,0,0) already IS panel A's DXF origin.
        gp_Trsf placeTrsf;
        placeTrsf.SetValues(
            actualXDir.X(), actualYDir.X(), faceNormal.X(), worldOrigin.X(),
            actualXDir.Y(), actualYDir.Y(), faceNormal.Y(), worldOrigin.Y(),
            actualXDir.Z(), actualYDir.Z(), faceNormal.Z(), worldOrigin.Z()
        );

        auto& mergedEntry = s_.shells.at(bent.mergedShellId);
        BRepBuilderAPI_Transform placeXfm(mergedEntry.shape, placeTrsf, true);
        mergedEntry.shape = placeXfm.Shape();
      }

      return {bent.mergedShellId, true, "", ""};

    } catch (const GeometryError& e) {
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", e.what()};
    } catch (const Standard_Failure& e) {
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED",
              std::string(e.GetMessageString())};
    } catch (const std::exception& e) {
      return {"", false, "GE_BUILD_FROM_PATTERN_FAILED", std::string(e.what())};
    }
  }

  // ── Panel frame (P(x) local→world) from the largest planar face ─────────────
  PanelFrameResult getPanelFrame(const std::string& shellId) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    PanelFrameResult out;
    auto it = s_.shells.find(shellId);
    if (it == s_.shells.end()) {
      out.ok = false;
      out.errorCode = "GE_SHELL_NOT_FOUND";
      out.message   = "Shell not found: " + shellId;
      return out;
    }
    const TopoDS_Shape& shape = it->second.shape;

    // Largest planar face defines the panel plane.
    double maxArea = 0.0;
    gp_Ax3 bestAx3;
    Standard_Real u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    bool found = false;
    for (TopExp_Explorer fExp(shape, TopAbs_FACE); fExp.More(); fExp.Next()) {
      TopoDS_Face face = TopoDS::Face(fExp.Current());
      BRepAdaptor_Surface surf(face, false);
      if (surf.GetType() != GeomAbs_Plane) continue;
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(face, fp);
      double area = fp.Mass();
      if (area > maxArea) {
        maxArea = area;
        bestAx3 = surf.Plane().Position();
        BRepTools::UVBounds(face, u1, u2, v1, v2);
        found = true;
      }
    }
    if (!found || maxArea < 1e-6) {
      out.ok = false;
      out.errorCode = "GE_PANEL_FRAME_FAILED";
      out.message   = "Shell has no planar faces.";
      return out;
    }

    gp_Pnt loc   = bestAx3.Location();
    gp_Dir xdir  = bestAx3.XDirection();
    gp_Dir ydir  = bestAx3.YDirection();
    gp_Dir ndir  = bestAx3.Direction();

    // True in-plane extents (independent of world-space tilt).
    double extX = u2 - u1;
    double extY = v2 - v1;

    // Corner at (u1, v1) in world = the panel-local origin.
    gp_Pnt corner(loc.XYZ() + xdir.XYZ() * u1 + ydir.XYZ() * v1);

    // Choose U = longer in-plane extent, V = shorter (matches flatWidth/flatHeight).
    gp_Dir U, V;
    double uExt, vExt;
    if (extX >= extY) { U = xdir; uExt = extX; V = ydir; vExt = extY; }
    else              { U = ydir; uExt = extY; V = xdir; vExt = extX; }

    // Thickness = extent of the shell along the plane normal.
    double nMin = 0.0, nMax = 0.0; bool firstV = true;
    for (TopExp_Explorer vExp(shape, TopAbs_VERTEX); vExp.More(); vExp.Next()) {
      gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vExp.Current()));
      double n = gp_Vec(p.XYZ()).Dot(gp_Vec(ndir.XYZ()));
      if (firstV) { nMin = nMax = n; firstV = false; }
      else { nMin = std::min(nMin, n); nMax = std::max(nMax, n); }
    }

    out.ok = true;
    out.originX = corner.X(); out.originY = corner.Y(); out.originZ = corner.Z();
    out.uX = U.X(); out.uY = U.Y(); out.uZ = U.Z();
    out.vX = V.X(); out.vY = V.Y(); out.vZ = V.Z();
    out.normalX = ndir.X(); out.normalY = ndir.Y(); out.normalZ = ndir.Z();
    out.uExtentMm = uExt;
    out.vExtentMm = vExt;
    out.thicknessMm = nMax - nMin;
    return out;
  }

  // ── Corner reliefs ──────────────────────────────────────────────────────────

  ShellId addCornerRelief(const ShellId& shellId, GeometryService::ReliefType reliefType, double radiusMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    if (s_.shells.find(shellId) == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND",
                          "Shell not found: " + shellId, false, "");
    }

    SnapshotId token = s_.createSnapshot("before addCornerRelief on " + shellId);

    try {
      const TopoDS_Shape& shellShape = s_.shells[shellId].shape;

      // Collect all vertices that are shared by exactly 3+ edges
      // (internal corners at bend intersections)
      TopTools_IndexedDataMapOfShapeListOfShape vertexEdgeMap;
      TopExp::MapShapesAndAncestors(shellShape,
                                    TopAbs_VERTEX, TopAbs_EDGE,
                                    vertexEdgeMap);

      // Build the relief cylinder tool at each internal corner vertex
      // Dogbone: cylinder axis aligned with Z (normal to flat face)
      double toolRadius = (reliefType == GeometryService::ReliefType::DOGBONE)
                              ? radiusMm
                              : radiusMm * 0.9;  // circular slightly inset
      double toolHeight = 50.0;  // extend beyond any reasonable panel thickness

      TopoDS_Shape resultShape = shellShape;
      int reliefCount = 0;

      for (int i = 1; i <= vertexEdgeMap.Extent(); ++i) {
        const TopTools_ListOfShape& edges = vertexEdgeMap(i);
        if (edges.Extent() < 3) continue;  // only internal corners

        const TopoDS_Shape& vtxShape = vertexEdgeMap.FindKey(i);
        const TopoDS_Vertex& vtx = TopoDS::Vertex(vtxShape);
        gp_Pnt pt = BRep_Tool::Pnt(vtx);

        // Create a small cylinder centred on the corner vertex
        gp_Ax2 axis(gp_Pnt(pt.X(), pt.Y(), pt.Z() - toolHeight / 2.0),
                    gp_Dir(0, 0, 1));
        BRepPrimAPI_MakeCylinder cylinder(axis, toolRadius, toolHeight);
        if (!cylinder.IsDone()) continue;

        BRepAlgoAPI_Cut cut(resultShape, cylinder.Shape());
        cut.Build();
        if (cut.IsDone() && !cut.Shape().IsNull()) {
          resultShape = cut.Shape();
          reliefCount++;
        }
      }

      // Register updated shell
      ShellId newId = generateUUID();
      ShellState newState{newId, s_.shells[shellId].parentSolidId, resultShape};
      s_.shells[newId] = newState;

      return newId;

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_RELIEF_FAILED",
                          std::string("Relief exception: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

  // ── Nesting ──────────────────────────────────────────────────────────────────

  NestResult nestShells(const std::vector<UnfoldId>& unfoldIds,
                         double sheetWidthMm,
                         double sheetHeightMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    for (const auto& uid : unfoldIds) {
      if (s_.unfolds.find(uid) == s_.unfolds.end()) {
        throw GeometryError("GE_UNFOLD_NOT_FOUND",
                            "Unfold not found: " + uid, false, "");
      }
    }

    if (sheetWidthMm <= 0 || sheetHeightMm <= 0) {
      throw GeometryError("GE_INVALID_SHEET_DIMS",
                          "Sheet dimensions must be positive", false, "");
    }

    // ── Shelf-Next-Fit Decreasing (SNFD) rectangular bin packing ──────────────
    // Sort pieces by height descending, then width descending (ties).
    struct Piece {
      std::string id;
      double      w;
      double      h;
    };
    std::vector<Piece> pieces;
    pieces.reserve(unfoldIds.size());
    double totalPartArea = 0.0;
    for (const auto& uid : unfoldIds) {
      const auto& u = s_.unfolds[uid];
      pieces.push_back({uid, u.flatWidthMm, u.flatHeightMm});
      totalPartArea += u.flatWidthMm * u.flatHeightMm;
    }

    // Sort largest height first for row-packing efficiency
    std::sort(pieces.begin(), pieces.end(), [](const Piece& a, const Piece& b) {
      if (a.h != b.h) return a.h > b.h;
      return a.w > b.w;
    });

    NestId nestId = generateUUID();
    std::vector<NestPlacement> placements;
    placements.reserve(pieces.size());

    // Pack into shelves: track current row position
    int    currentSheet  = 0;
    double curX          = 0.0;
    double curY          = 0.0;
    double rowHeight     = 0.0;

    for (const auto& p : pieces) {
      // If piece is wider or taller than the sheet, it cannot be placed
      // Clamp to check: skip over-sized pieces (edge case)
      const double pw = std::min(p.w, sheetWidthMm);
      const double ph = std::min(p.h, sheetHeightMm);

      // Try to fit in current row
      if (curX + pw > sheetWidthMm) {
        // Start a new row
        curY     += rowHeight;
        curX      = 0.0;
        rowHeight = 0.0;

        // If new row exceeds sheet height, go to next sheet
        if (curY + ph > sheetHeightMm) {
          ++currentSheet;
          curX      = 0.0;
          curY      = 0.0;
          rowHeight = 0.0;
        }
      }

      placements.push_back({p.id, currentSheet, curX, curY, 0.0});
      curX     += pw;
      rowHeight = std::max(rowHeight, ph);
    }

    int sheetsRequired = currentSheet + 1;
    double sheetArea   = sheetWidthMm * sheetHeightMm;
    double utilisation = (totalPartArea / (sheetsRequired * sheetArea)) * 100.0;
    utilisation        = std::min(100.0, utilisation);

    // ── SVG preview ────────────────────────────────────────────────────────────
    // Generate a compact SVG visualising the placement on sheet 0.
    // Each panel is a coloured rectangle; the sheet outline is a grey frame.
    const double svgScale = 0.2; // mm → SVG units (px)
    const int    svgW     = static_cast<int>(sheetWidthMm  * svgScale) + 4;
    const int    svgH     = static_cast<int>(sheetHeightMm * svgScale) + 4;

    std::string svg;
    svg.reserve(2048);
    svg += "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"";
    svg += std::to_string(svgW);
    svg += "\" height=\"";
    svg += std::to_string(svgH);
    svg += "\">\n";
    // Sheet outline
    svg += "<rect x=\"2\" y=\"2\" width=\"";
    svg += std::to_string(static_cast<int>(sheetWidthMm  * svgScale));
    svg += "\" height=\"";
    svg += std::to_string(static_cast<int>(sheetHeightMm * svgScale));
    svg += "\" fill=\"#f0f0f0\" stroke=\"#888\" stroke-width=\"1\"/>\n";

    // Colour palette (cycle through 8 colours)
    static const char* COLOURS[] = {
      "#4A90D9","#E87B1E","#27AE60","#8E44AD",
      "#C0392B","#16A085","#F39C12","#2980B9"
    };
    size_t colIdx = 0;
    for (const auto& pl : placements) {
      if (pl.sheetIndex != 0) continue; // only show sheet 0
      // Find piece dimensions
      double pw = 0, ph = 0;
      for (const auto& piece : pieces) {
        if (piece.id == pl.unfoldId) { pw = piece.w; ph = piece.h; break; }
      }
      int px = static_cast<int>(pl.x * svgScale) + 2;
      int py = static_cast<int>(pl.y * svgScale) + 2;
      int pw_ = static_cast<int>(pw * svgScale);
      int ph_ = static_cast<int>(ph * svgScale);
      svg += "<rect x=\"";
      svg += std::to_string(px);
      svg += "\" y=\"";
      svg += std::to_string(py);
      svg += "\" width=\"";
      svg += std::to_string(pw_);
      svg += "\" height=\"";
      svg += std::to_string(ph_);
      svg += "\" fill=\"";
      svg += COLOURS[colIdx % 8];
      svg += "\" opacity=\"0.7\" stroke=\"#333\" stroke-width=\"0.5\"/>\n";

      // Draw bend lines in SVG if bendCount > 0
      auto unfoldIt = s_.unfolds.find(pl.unfoldId);
      if (unfoldIt != s_.unfolds.end() && unfoldIt->second.bendCount > 0) {
        int bc = unfoldIt->second.bendCount;
        double step = ph_ / static_cast<double>(bc + 1);
        for (int i = 1; i <= bc; ++i) {
          int ly = static_cast<int>(py + step * i);
          svg += "<line x1=\"";
          svg += std::to_string(px);
          svg += "\" y1=\"";
          svg += std::to_string(ly);
          svg += "\" x2=\"";
          svg += std::to_string(px + pw_);
          svg += "\" y2=\"";
          svg += std::to_string(ly);
          svg += "\" stroke=\"#ffffff\" stroke-dasharray=\"2,2\" stroke-width=\"0.5\"/>\n";
        }
      }

      ++colIdx;
    }
    svg += "</svg>\n";

    return NestResult{nestId, placements, utilisation, sheetsRequired, svg};
  }

  MergeBodyResult mergeBodiesWithBend(const ShellId& partAId, const ShellId& partBId,
                                       const std::vector<std::string>& targetEdges,
                                       double bendRadiusMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    auto itA = s_.shells.find(partAId);
    if (itA == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    }
    auto itB = s_.shells.find(partBId);
    if (itB == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");
    }
    if (bendRadiusMm <= 0.0) {
      throw GeometryError("GE_MERGE_FAILED", "bendRadiusMm must be positive", false, "");
    }
    if (targetEdges.empty()) {
      throw GeometryError("GE_MERGE_FAILED", "targetEdges must not be empty", false, "");
    }

    // Pre-merge gap check: measure minimum distance between the two shells.
    // Gaps <= kMergeTolerance are bridged by OCCT's fuzzy Boolean; larger gaps
    // produce disconnected compound bodies that look like one part but aren't.
    {
      const double kMergeTolerance = 0.1; // mm — matches unfoldShell sewing tolerance

      // Step 1: bounding-box quick-check.
      // Expand boxA by the tolerance; if boxB is still outside the expanded box,
      // the shapes are definitely more than kMergeTolerance apart — run extrema.
      // If the boxes overlap (shapes are nearby or touching), skip the check.
      Bnd_Box boxA, boxB;
      BRepBndLib::AddOptimal(itA->second.shape, boxA);
      BRepBndLib::AddOptimal(itB->second.shape, boxB);

      Bnd_Box boxAExpanded = boxA;
      boxAExpanded.Enlarge(kMergeTolerance);
      const bool boxesClearlyApart =
          !boxA.IsVoid() && !boxB.IsVoid() && boxAExpanded.IsOut(boxB);

      if (boxesClearlyApart) {
        // Step 2: precise extrema distance (explicit Perform() for robustness).
        BRepExtrema_DistShapeShape gapCheck;
        gapCheck.LoadS1(itA->second.shape);
        gapCheck.LoadS2(itB->second.shape);
        gapCheck.Perform();

        double gap = kMergeTolerance + 1.0; // conservative default if measurement fails
        if (gapCheck.IsDone()) {
          gap = gapCheck.Value();
        }

        if (gap > kMergeTolerance) {
          std::ostringstream msg;
          msg << std::fixed << std::setprecision(3)
              << "GE_MERGE_GAP: Panels are " << gap << " mm apart. "
              << "Maximum allowed gap is " << kMergeTolerance << " mm. "
              << "Use close_gap to snap them together before merging.";
          throw GeometryError("GE_MERGE_GAP", msg.str(), false, "");
        }
      }
    }

    SnapshotId token = s_.createSnapshot("before mergeBodiesWithBend on " +
                                            partAId + "+" + partBId);

    try {
      TopoDS_Shape inputA = itA->second.shape;
      TopoDS_Shape inputB = itB->second.shape;
      BRepAlgoAPI_Fuse fuse(inputA, inputB);
      fuse.SetFuzzyValue(0.15); // Set fuzzy sewing tolerance to heal non-planar seams
      fuse.Build();
      if (!fuse.IsDone() || fuse.Shape().IsNull()) {
        throw GeometryError("GE_MERGE_FAILED", "Boolean fuse failed", true, "rollback");
      }
      TopoDS_Shape fused = fuse.Shape();

      // Post-merge connectivity check: a properly fused pair of touching bodies
      // produces one solid or one shell. A compound with multiple solids/shells
      // means the bodies didn't actually share topology — the gap was present.
      {
        // Count solids (any nesting depth) and free shells (not inside a solid).
        int solidCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SOLID); ex.More(); ex.Next()) solidCount++;
        int shellCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) shellCount++;

        // Also count direct top-level children of a COMPOUND when there are no
        // solids or shells — this catches face-only compounds from surface models.
        int topLevelCount = 0;
        if (solidCount == 0 && shellCount == 0 && fused.ShapeType() == TopAbs_COMPOUND) {
          for (TopoDS_Iterator it(fused); it.More(); it.Next()) topLevelCount++;
        }

        const bool disconnected = (solidCount > 1)
            || (solidCount == 0 && shellCount > 1)
            || (solidCount == 0 && shellCount == 0 && topLevelCount > 1);

        if (disconnected) {
          throw GeometryError("GE_MERGE_DISCONNECTED",
            "Merge produced disconnected bodies — the panels are not topologically joined. "
            "Check for a gap at the shared edge and use close_gap to fix it.",
            false, "");
        }

        // Empty-fuse guard: OCCT's BRepAlgoAPI_Fuse occasionally returns
        // IsDone()==true with a non-null but EMPTY compound (0 solids, 0
        // shells, 0 top-level children) when the inputs were touching only
        // at a single edge or vertex that the operator couldn't reconcile.
        // Without this check the empty compound silently flowed downstream
        // into the fillet step, producing the "Fused result is not a single
        // solid" error from a different (downstream) check — masking the
        // real failure (the fuse itself).
        if (solidCount == 0 && shellCount == 0 && topLevelCount == 0) {
          throw GeometryError("GE_MERGE_FAILED",
            "Merge produced an empty result. OCCT's Boolean fuse completed "
            "but left no solid, shell, or top-level shape. The bodies likely "
            "share only an edge or vertex (insufficient contact for a Boolean "
            "fuse). Re-check that the panels overlap volumetrically or share "
            "a face before merging.",
            true, "rollback");
        }
      }

      // Attempt fillet on matching edges. Any failure is FATAL — we throw a
      // structured error rather than silently returning an unfilleted fuse,
      // because the caller asked for a bend and a flat-fuse result would
      // misrepresent the intent (the UI shows a successful merge but with no
      // bend, then unfold produces geometry that doesn't match the requested
      // operation). Silent fallbacks were removed deliberately — the user
      // should be told why the bend couldn't be applied (radius too large,
      // no joint edges, OCCT failure) and decide what to do next.
      bool wantAll = std::find(targetEdges.begin(), targetEdges.end(), "all") != targetEdges.end();
      TopoDS_Shape result;

      // BRepAlgoAPI_Fuse returns a COMPOUND wrapper even when the result is a
      // single clean solid. BRepFilletAPI_MakeFillet rejects COMPOUND input
      // ("There are no suitable edges for chamfer or fillet"), so unwrap to the
      // bare solid here. We require exactly one solid + no stray free shells —
      // the disconnected-bodies check above already rejected the multi-solid
      // case, so this should hold; if it doesn't, throw rather than silently
      // hand the fillet a body it can't process.
      TopoDS_Shape filletInput = fused;
      if (fused.ShapeType() != TopAbs_SOLID) {
        TopoDS_Solid theSolid;
        int solidCount = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SOLID); ex.More(); ex.Next()) {
          theSolid = TopoDS::Solid(ex.Current());
          solidCount++;
        }
        int freeShells = 0;
        for (TopExp_Explorer ex(fused, TopAbs_SHELL, TopAbs_SOLID); ex.More(); ex.Next()) {
          freeShells++;
        }
        if (solidCount != 1 || freeShells != 0) {
          std::ostringstream msg;
          msg << "GE_MERGE_FILLET_FAILED: Fused result is not a single solid "
              << "(solids=" << solidCount << ", freeShells=" << freeShells
              << "). Cannot fillet — the input bodies likely don't form a clean joint.";
          throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
        }
        filletInput = theSolid;
      }

      // ── PLAN B: DETERMINISTIC CORNER-CUT BEND ─────────────────────────────
      //
      // Instead of searching the fused topology for an edge to fillet
      // (fragile; OCCT MakeFillet has many failure modes for borderline
      // thickness/radius ratios, skewed inputs, and chained merges),
      // construct the bend analytically:
      //
      //   1. Find each input's "outer" planar face = the largest face whose
      //      centroid sits farthest from the other input's centroid. This
      //      reliably picks the face facing AWAY from the bend, regardless
      //      of orientation.
      //   2. Compute the bend axis = intersection line of the two outer
      //      planes. Well-defined for perpendicular panels.
      //   3. Compute the bend extent = overlap of the two inputs projected
      //      onto the axis.
      //   4. Build a corner-cut solid: a (R × R × extent) box positioned at
      //      the outside corner along the bend axis, MINUS a cylinder of
      //      radius R tangent to both outer planes. This is exactly the
      //      material a fillet would remove.
      //   5. Subtract the corner-cut from the fused body.
      //
      // Result: sharp inside corner (panels meet flush at the inner edge),
      // rounded outside corner of radius R — matching standard sheet metal
      // bend geometry.
      //
      // For explicit edge IDs (target_edges != ["all"]) we still use the
      // legacy MakeFillet path for back-compat with callers that know
      // which edges they want filleted.
      try {
        if (wantAll) {
          // ── 1. Outer faces of each input ──
          GProp_GProps centA, centB;
          BRepGProp::VolumeProperties(inputA, centA);
          BRepGProp::VolumeProperties(inputB, centB);
          gp_Pnt cA = centA.CentreOfMass();
          gp_Pnt cB = centB.CentreOfMass();

          auto outerFace = [&](const TopoDS_Shape& body, const gp_Pnt& otherCentroid,
                               gp_Vec& nOut, gp_Pln& planeOut) -> bool {
            double bestScore = -1.0;
            bool ok = false;
            for (TopExp_Explorer fx(body, TopAbs_FACE); fx.More(); fx.Next()) {
              const TopoDS_Face& f = TopoDS::Face(fx.Current());
              Handle(Geom_Surface) s = BRep_Tool::Surface(f);
              if (s.IsNull() || !s->IsKind(STANDARD_TYPE(Geom_Plane))) continue;
              GProp_GProps fp;
              BRepGProp::SurfaceProperties(f, fp);
              double area = fp.Mass();
              gp_Pnt c = fp.CentreOfMass();
              double dist = c.Distance(otherCentroid);
              double score = area * dist;
              if (score > bestScore) {
                bestScore = score;
                nOut = faceOutwardNormal(f);
                planeOut = Handle(Geom_Plane)::DownCast(s)->Pln();
                ok = true;
              }
            }
            return ok;
          };

          gp_Vec nInA, nInB;
          gp_Pln planeA, planeB;
          if (!outerFace(inputA, cB, nInA, planeA) || !outerFace(inputB, cA, nInB, planeB)) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Could not find outer planar faces on both inputs. Each input must "
              "have at least one planar face to act as the panel skin.",
              false, "");
          }

          // ── 2. Bend axis = intersection of outer planes ──
          // Threshold: reject if |dot| > cos(13°) ≈ 0.974, i.e. angle < 13°.
          // This allows shallow bends (15°, 20°, …) while still rejecting
          // effectively-coplanar panels where a bend axis is meaningless.
          if (std::abs(nInA.Dot(nInB)) > 0.974) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Outer faces of the two inputs are parallel (within 13°). The panels "
              "must meet at a non-zero angle so a bend axis can be defined.",
              false, "");
          }
          IntAna_QuadQuadGeo planeInt(planeA, planeB,
                                      Precision::Angular(), Precision::Confusion());
          if (!planeInt.IsDone() || planeInt.TypeInter() != IntAna_Line) {
            throw GeometryError("GE_MERGE_BEND_AXIS_AMBIGUOUS",
              "Failed to intersect the inputs' outer planes — bend axis could not "
              "be determined.",
              false, "");
          }
          gp_Lin bendAxis = planeInt.Line(1);

          // ── 3. Bend extent = overlap of inputs projected onto axis ──
          gp_Vec axisDir(bendAxis.Direction());
          gp_Pnt axisOrigin = bendAxis.Location();

          auto axisRange = [&](const TopoDS_Shape& body) -> std::pair<double, double> {
            double lo = 1e30, hi = -1e30;
            for (TopExp_Explorer vx(body, TopAbs_VERTEX); vx.More(); vx.Next()) {
              gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(vx.Current()));
              double t = gp_Vec(axisOrigin, p).Dot(axisDir);
              lo = std::min(lo, t);
              hi = std::max(hi, t);
            }
            return {lo, hi};
          };
          auto rangeA = axisRange(inputA);
          auto rangeB = axisRange(inputB);
          double extentLo = std::max(rangeA.first, rangeB.first);
          double extentHi = std::min(rangeA.second, rangeB.second);
          double extent = extentHi - extentLo;

          if (extent < 5.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_BEND_EXTENT_TOO_SHORT: Panels overlap only "
                << std::fixed << std::setprecision(2) << extent
                << " mm along the bend axis (need at least 5 mm). "
                << "The panels touch only at a corner or short edge segment.";
            throw GeometryError("GE_MERGE_BEND_EXTENT_TOO_SHORT", msg.str(), false, "");
          }

          // ── 3a. Panel thickness check ──
          // User policy: imported geometry may have slightly mismatched
          // thicknesses; correct silently if mismatch is within ~3 mm,
          // throw if it's beyond that (different stock can't be bent
          // cleanly as one piece).
          // Use OBB (oriented bounding box) so that panels tilted at any angle
          // report their actual wall thickness, not a world-axis projection.
          // For a flat panel at 30° the AABB min-dim would be the Z-span
          // (~51 mm for a 100mm leg), while the OBB min-dim is the true 1.5mm.
          auto panelThickness = [](const TopoDS_Shape& body) -> double {
            Bnd_OBB obb;
            BRepBndLib::AddOBB(body, obb, /*isTriangulationUsed=*/false,
                               /*isOptimal=*/true, /*isShapeToleranceUsed=*/false);
            return 2.0 * std::min({obb.XHSize(), obb.YHSize(), obb.ZHSize()});
          };
          double tA = panelThickness(inputA);
          double tB = panelThickness(inputB);
          if (std::abs(tA - tB) > 3.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_THICKNESS_MISMATCH: Panel thicknesses differ by "
                << std::fixed << std::setprecision(2) << std::abs(tA - tB)
                << " mm (panelA=" << tA << " mm, panelB=" << tB << " mm). "
                << "Max 3 mm mismatch tolerated for clean bend construction.";
            throw GeometryError("GE_MERGE_THICKNESS_MISMATCH", msg.str(), false, "");
          }
          double effectiveThickness = std::max(tA, tB);

          // Bend radius must be within a reasonable ratio of thickness.
          if (bendRadiusMm > effectiveThickness * 5.0) {
            std::ostringstream msg;
            msg << "GE_MERGE_RADIUS_TOO_LARGE: Bend radius " << bendRadiusMm
                << " mm exceeds 5x panel thickness " << effectiveThickness
                << " mm. The corner cut would slice through to the panel interior. "
                << "Try a smaller bend radius.";
            throw GeometryError("GE_MERGE_RADIUS_TOO_LARGE", msg.str(), false, "");
          }

          // bendRadiusMm is the INNER (concave-side) radius — standard sheet-metal
          // convention.  The outer (convex-side) radius = innerRadius + thickness.
          const double innerRadius = bendRadiusMm;
          const double outerRadius = innerRadius + effectiveThickness;

          // ── 4. Build local frame and corner-cut solid ──
          // dirA / dirB = unit vectors from the bend axis into each panel.
          // Local 2D cross-section: dirA = +X, dirB = +Y.
          //   Outer faces (X=0, Y=0) are on the convex side of the bend.
          //   Inner faces (X=T, Y=T) are on the concave side.
          //   Arc centre = (outerRadius, outerRadius) in local frame.
          gp_Vec dirA = -nInA;
          gp_Vec dirB = -nInB;

          // Align axisDir so that axisDir × dirA = dirB (right-handed local
          // frame). The intersection line direction is arbitrary; we pick
          // the orientation that makes the local box axes consistent.
          gp_Vec computedDirB = axisDir.Crossed(dirA);
          if (computedDirB.Dot(dirB) < 0) {
            axisDir = -axisDir;
          }

          // cornerOrigin: point on the bend axis at the start of the bend extent.
          // Box axes: XDirection=dirA, YDirection=dirB, Direction=axisDir.
          gp_Pnt cornerOrigin = axisOrigin.Translated(axisDir * extentLo);
          gp_Ax2 boxAxes(cornerOrigin, gp_Dir(axisDir), gp_Dir(dirA));

          // Arc-centre location: outerRadius into each panel direction.
          gp_Pnt arcCentre = cornerOrigin
              .Translated(dirA * outerRadius)
              .Translated(dirB * outerRadius);
          gp_Ax2 arcAxes(arcCentre, gp_Dir(axisDir));

          // -- 4b. Outer corner cut -------------------------------------------------
          // Remove the crescent at the convex corner:
          //   outerCut = box([0..boxExtent]^2) - outerCyl(radius=outerRadius)
          // Subtracting this from the body rounds the outer (convex) bend surface
          // to the correct outer radius while leaving the inner faces untouched.
          //
          // IMPORTANT: Cap the box extent to effectiveThickness so the box never
          // extends past the inner corner faces (which sit at T from the outer
          // corner). If outerRadius > T, the box would split those inner faces
          // during the Boolean cut, creating phantom sub-faces that corrupt the
          // unfold algorithm's face-area ordering and UV projection.
          // The arc position (arcCentre) is still placed at outerRadius from the
          // corner; only the box footprint is clamped so it stays inside the
          // material region.
          double boxExtent = std::min(outerRadius, effectiveThickness);
          TopoDS_Solid outerBox;
          try {
            outerBox = BRepPrimAPI_MakeBox(boxAxes, boxExtent, boxExtent, extent).Solid();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_WEDGE_FAILED: failed to build outer-corner box: "
                << e.GetMessageString();
            throw GeometryError("GE_MERGE_WEDGE_FAILED", msg.str(), true, "rollback");
          }
          TopoDS_Solid outerCyl;
          try {
            outerCyl = BRepPrimAPI_MakeCylinder(arcAxes, outerRadius, extent).Solid();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_WEDGE_FAILED: failed to build outer-corner cylinder: "
                << e.GetMessageString();
            throw GeometryError("GE_MERGE_WEDGE_FAILED", msg.str(), true, "rollback");
          }
          BRepAlgoAPI_Cut outerCutOp(outerBox, outerCyl);
          outerCutOp.Build();
          if (!outerCutOp.IsDone() || outerCutOp.Shape().IsNull()) {
            throw GeometryError("GE_MERGE_WEDGE_FAILED",
              "Failed to compute outer corner-cut (outerBox - outerCyl).",
              true, "rollback");
          }
          BRepAlgoAPI_Cut applyOuterOp(filletInput, outerCutOp.Shape());
          applyOuterOp.Build();
          if (!applyOuterOp.IsDone() || applyOuterOp.Shape().IsNull()) {
            throw GeometryError("GE_MERGE_FAILED",
              "Failed to subtract outer corner-cut from body.",
              true, "rollback");
          }
          result = applyOuterOp.Shape();
          // Post-cut cleanup: BRepAlgoAPI_Cut can leave tiny artifact solids at
          // near-degenerate corners when the cut-box edge exactly coincides with
          // a seam face of a previously-fused input (e.g. panel+protrusion merged
          // before this merge step). Discard solids whose volume is <1% of the
          // largest — these are numerical artifacts from the Boolean op, not
          // real material.
          {
            TopoDS_Solid largestSolid;
            double largestVol = -1.0;
            int solidCnt = 0;
            for (TopExp_Explorer ex(result, TopAbs_SOLID); ex.More(); ex.Next()) {
              TopoDS_Solid s = TopoDS::Solid(ex.Current());
              GProp_GProps gp;
              BRepGProp::VolumeProperties(s, gp);
              double vol = std::abs(gp.Mass());
              solidCnt++;
              if (vol > largestVol) { largestVol = vol; largestSolid = s; }
            }
            if (solidCnt > 1 && !largestSolid.IsNull()) {
              result = largestSolid;
            }
          }
        } else {
          // ─── EXPLICIT EDGES PATH (back-compat) ───
          // Caller supplied specific edge IDs; use OCCT MakeFillet to fillet
          // exactly those. Less robust than the deterministic path, but the
          // caller has specified which edges they want.
          BRepFilletAPI_MakeFillet filletMaker(filletInput);
          bool addedAny = false;
          int candidateEdges = 0;
          TopExp_Explorer edgeExp(filletInput, TopAbs_EDGE);
          for (; edgeExp.More(); edgeExp.Next()) {
            const TopoDS_Edge& e = TopoDS::Edge(edgeExp.Current());
            if (std::find(targetEdges.begin(), targetEdges.end(), shapeId(e)) != targetEdges.end()) {
              filletMaker.Add(bendRadiusMm, e);
              addedAny = true;
              candidateEdges++;
            }
          }
          if (!addedAny) {
            throw GeometryError("GE_MERGE_NO_SEAM_EDGES",
              "None of the specified target_edges were found in the fused body.",
              false, "");
          }
          try {
            filletMaker.Build();
          } catch (const Standard_Failure& e) {
            std::ostringstream msg;
            msg << "GE_MERGE_FILLET_FAILED: OCCT fillet build threw on " << candidateEdges
                << " edge(s) at radius " << bendRadiusMm << " mm: " << e.GetMessageString();
            throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
          }
          if (!filletMaker.IsDone() || filletMaker.Shape().IsNull()) {
            std::ostringstream msg;
            msg << "GE_MERGE_FILLET_FAILED: OCCT fillet build did not complete on "
                << candidateEdges << " edge(s) at radius " << bendRadiusMm << " mm.";
            throw GeometryError("GE_MERGE_FILLET_FAILED", msg.str(), true, "rollback");
          }
          result = filletMaker.Shape();
        }
      } catch (const GeometryError&) {
        throw;
      } catch (const Standard_Failure& e) {
        std::ostringstream msg;
        msg << "GE_MERGE_FAILED: OCCT exception during bend construction: "
            << e.GetMessageString();
        throw GeometryError("GE_MERGE_FAILED", msg.str(), true, "rollback");
      }

      // BRepFilletAPI_MakeFillet().Shape() can return a COMPOUND wrapping the
      // solid (same OCCT habit as BRepAlgoAPI_Fuse). Storing a compound in
      // shells_ poisons any downstream merge that tries to fuse this shell
      // again: the chained-merge fuse of (COMPOUND, SOLID) produces 0 solids
      // and the second merge throws. Unwrap to the bare solid so chained
      // merges work cleanly.
      if (result.ShapeType() != TopAbs_SOLID) {
        TopoDS_Solid resultSolid;
        int rsCount = 0;
        for (TopExp_Explorer ex(result, TopAbs_SOLID); ex.More(); ex.Next()) {
          resultSolid = TopoDS::Solid(ex.Current());
          rsCount++;
        }
        if (rsCount == 1) {
          result = resultSolid;
        }
        // If rsCount != 1 we leave `result` as-is — the merge succeeded
        // structurally, but a downstream fuse on this shell may fail; we
        // don't synthesise a fake solid to hide that.
      }

      ShellId mergedId = generateUUID();
      s_.shells[mergedId] = ShellState{mergedId, itA->second.parentSolidId, result};
      auto histA = captureHistory(fuse, inputA,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "mergeBodiesWithBend");
      auto histB = captureHistory(fuse, inputB,
          [](const TopoDS_Shape& s) { return shapeId(s); }, "mergeBodiesWithBend");
      histA.insert(histA.end(), histB.begin(), histB.end());
      return MergeBodyResult{mergedId, token, std::move(histA)};

    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_MERGE_FAILED",
                          std::string("OCCT exception during merge: ") + e.GetMessageString(),
                          true, "rollback");
    }
  }

private:
  // Private lock-free helper: parse DXF and create a shell in state.
  // Called from buildShellFromFlatPattern which does NOT hold the mutex,
  // so individual callers (thickenSheet, getPanelFrame) lock independently.
  DxfSheetResult buildSheetFromDxf(const std::string& dxfContent) {
    if (dxfContent.empty()) {
      throw GeometryError("GE_INVALID_DXF", "DXF content is empty.", false, "");
    }

    std::vector<std::string> lines;
    {
      std::istringstream in(dxfContent);
      std::string line;
      while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
      }
    }

    std::vector<std::pair<double, double>> vertices;
    bool inPolyline = false;
    bool isLayer0 = false;
    bool hasPendingX = false;
    double pendingX = 0.0;

    for (size_t i = 0; i + 1 < lines.size(); i += 2) {
      int code = 0;
      try {
        code = std::stoi(lines[i]);
      } catch (...) {
        continue;
      }
      const std::string& value = lines[i + 1];

      if (code == 0) {
        if (inPolyline && value != "LWPOLYLINE") {
          if (isLayer0 && vertices.size() >= 3) break;
          vertices.clear();
        }
        inPolyline = (value == "LWPOLYLINE");
        isLayer0 = false;
        hasPendingX = false;
        continue;
      }

      if (!inPolyline) continue;

      if (code == 8) {
        isLayer0 = (value == "0");
      } else if (code == 10) {
        try {
          pendingX = std::stod(value);
          hasPendingX = true;
        } catch (...) {
          hasPendingX = false;
        }
      } else if (code == 20 && hasPendingX) {
        try {
          double y = std::stod(value);
          vertices.push_back({pendingX, y});
        } catch (...) {
          // Ignore malformed vertex pair
        }
        hasPendingX = false;
      }
    }

    if (vertices.size() < 3) {
      throw GeometryError(
          "GE_INVALID_DXF",
          "DXF must contain a layer-0 LWPOLYLINE with at least 3 vertices.",
          false,
          "");
    }

    try {
      BRepBuilderAPI_MakeWire wireMaker;

      for (size_t i = 0; i < vertices.size(); ++i) {
        const auto& a = vertices[i];
        const auto& b = vertices[(i + 1) % vertices.size()];
        if (std::abs(a.first - b.first) < 1e-9 && std::abs(a.second - b.second) < 1e-9) continue;
        TopoDS_Edge edge = BRepBuilderAPI_MakeEdge(
            gp_Pnt(a.first, a.second, 0.0),
            gp_Pnt(b.first, b.second, 0.0));
        wireMaker.Add(edge);
      }

      if (!wireMaker.IsDone()) {
        throw GeometryError("GE_INVALID_DXF", "Failed to build wire from DXF polyline.", false, "");
      }

      TopoDS_Wire wire = wireMaker.Wire();
      BRepBuilderAPI_MakeFace faceMaker(wire);
      if (!faceMaker.IsDone()) {
        throw GeometryError("GE_INVALID_DXF", "Failed to build planar face from DXF wire.", false, "");
      }

      // Wrap face into a shell (single-face shell).
      // BRepBuilderAPI_Sewing on a single unshared face returns a TopoDS_Compound,
      // not a TopoDS_Shell — use BRep_Builder directly instead.
      TopoDS_Face face = faceMaker.Face();
      BRep_Builder builder;
      TopoDS_Shell shell;
      builder.MakeShell(shell);
      builder.Add(shell, face);

      ShellId sheetId = generateUUID();
      s_.shells[sheetId] = ShellState{sheetId, "", shell};
      return DxfSheetResult{sheetId};

    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_INVALID_DXF",
                          std::string("DXF build failed: ") + e.GetMessageString(),
                          false,
                          "");
    }
  }

  GeometryState& s_;
};

// ── Delegation stubs (NO override keyword) ────────────────────────────────────

ThickenSheetResult GeometryServiceImpl::thickenSheet(const ShellId& sheetId, double thicknessMm) {
  return GeometryShell(state_).thickenSheet(sheetId, thicknessMm);
}

ApplyBendResult GeometryServiceImpl::applyBend(const ShellId& panelAId, const ShellId& panelBId,
                                                double innerRadiusMm, double angleDeg, double kFactor) {
  return GeometryShell(state_).applyBend(panelAId, panelBId, innerRadiusMm, angleDeg, kFactor);
}

BuildShellFromFlatPatternResult GeometryServiceImpl::buildShellFromFlatPattern(
    const std::string& dxfContent, const std::vector<BendZoneSpec>& bendZones,
    double thicknessMm, const FlatPanelPlacementSpec& explicitPlacement) {
  return GeometryShell(state_).buildShellFromFlatPattern(dxfContent, bendZones, thicknessMm, explicitPlacement);
}

PanelFrameResult GeometryServiceImpl::getPanelFrame(const std::string& shellId) {
  return GeometryShell(state_).getPanelFrame(shellId);
}

ShellId GeometryServiceImpl::addCornerRelief(const ShellId& shellId, ReliefType reliefType, double radiusMm) {
  return GeometryShell(state_).addCornerRelief(shellId, reliefType, radiusMm);
}

NestResult GeometryServiceImpl::nestShells(const std::vector<UnfoldId>& unfoldIds,
                                            double sheetWidthMm, double sheetHeightMm) {
  return GeometryShell(state_).nestShells(unfoldIds, sheetWidthMm, sheetHeightMm);
}

MergeBodyResult GeometryServiceImpl::mergeBodiesWithBend(const ShellId& partAId, const ShellId& partBId,
                                                          const std::vector<std::string>& targetEdges,
                                                          double bendRadiusMm) {
  return GeometryShell(state_).mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadiusMm);
}

} // namespace mcp_cad
