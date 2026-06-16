/**
 * geometry_service_measurement.cc — Measurement and clash/gap detection operations.
 *
 * Contains: computeBoundingBox, computeMassProperties, measureDistance,
 *           exploreTopology, computeIntersections, checkAssemblyClashes,
 *           computeGaps (delegated from GeometryServiceImpl).
 */

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

class GeometryMeasurement {
public:
  explicit GeometryMeasurement(GeometryState& s) : s_(s) {}

  BoundingBoxResult computeBoundingBox(const std::string& entityId) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    try {
      TopoDS_Shape shape = lookupEntityIn(s_, entityId);
      Bnd_Box box;
      BRepBndLib::AddOptimal(shape, box);
      double xMin, yMin, zMin, xMax, yMax, zMax;
      box.Get(xMin, yMin, zMin, xMax, yMax, zMax);
      return BoundingBoxResult{xMin, yMin, zMin, xMax, yMax, zMax};
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT bounding box exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  MassPropertiesResult computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    try {
      TopoDS_Shape shape = lookupEntityIn(s_, entityId);
      MassPropertiesResult result;
      bool reqVol = false, reqSurf = false, reqCent = false, reqInert = false;
      if (properties.empty()) {
        reqVol = reqSurf = reqCent = reqInert = true;
      } else {
        for (const auto& p : properties) {
          if (p == "volume") reqVol = true;
          else if (p == "surface_area") reqSurf = true;
          else if (p == "centroid") reqCent = true;
          else if (p == "inertia_tensor") reqInert = true;
        }
      }
      if (reqVol || reqCent || reqInert) {
        GProp_GProps volProps;
        BRepGProp::VolumeProperties(shape, volProps);
        if (reqVol) result.volume = volProps.Mass();
        if (reqCent) {
          gp_Pnt c = volProps.CentreOfMass();
          result.centroid = std::array<double, 3>{c.X(), c.Y(), c.Z()};
        }
        if (reqInert) {
          gp_Mat inertia = volProps.MatrixOfInertia();
          std::array<double, 9> tensor{
            inertia(1,1), inertia(1,2), inertia(1,3),
            inertia(2,1), inertia(2,2), inertia(2,3),
            inertia(3,1), inertia(3,2), inertia(3,3)
          };
          result.inertiaTensor = tensor;
        }
      }
      if (reqSurf) {
        GProp_GProps surfProps;
        BRepGProp::SurfaceProperties(shape, surfProps);
        result.surfaceArea = surfProps.Mass();
      }
      return result;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT mass properties exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  MeasureResult measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    try {
      TopoDS_Shape shapeA = lookupEntityIn(s_, entityA);
      TopoDS_Shape shapeB = lookupEntityIn(s_, entityB);

      if (measurementType == "angle") {
        if (shapeA.ShapeType() != TopAbs_FACE || shapeB.ShapeType() != TopAbs_FACE) {
          throw GeometryError("GE_ALIGN_UNSUPPORTED", "Angle measurement only supported between two planar faces", true, "");
        }
        const TopoDS_Face& faceA = TopoDS::Face(shapeA);
        const TopoDS_Face& faceB = TopoDS::Face(shapeB);
        Handle(Geom_Surface) surfA = BRep_Tool::Surface(faceA);
        Handle(Geom_Surface) surfB = BRep_Tool::Surface(faceB);
        if (surfA.IsNull() || !surfA->IsKind(STANDARD_TYPE(Geom_Plane)) ||
            surfB.IsNull() || !surfB->IsKind(STANDARD_TYPE(Geom_Plane))) {
          throw GeometryError("GE_ALIGN_UNSUPPORTED", "Both faces must be planar for angle measurement", true, "");
        }
        Handle(Geom_Plane) planeA = Handle(Geom_Plane)::DownCast(surfA);
        Handle(Geom_Plane) planeB = Handle(Geom_Plane)::DownCast(surfB);
        gp_Dir dirA = planeA->Position().Direction();
        gp_Dir dirB = planeB->Position().Direction();
        double dot = std::clamp(dirA.Dot(dirB), -1.0, 1.0);
        double angleRad = std::acos(dot);
        double angleDeg = angleRad * 180.0 / M_PI;
        if (angleDeg > 180.0) angleDeg = 360.0 - angleDeg;
        return MeasureResult{angleDeg, "angle"};
      } else {
        BRepExtrema_DistShapeShape distCalc(shapeA, shapeB);
        distCalc.Perform();
        if (!distCalc.IsDone()) {
          throw GeometryError("GE_EMPTY_RESULT", "Distance computation failed", true, "");
        }
        double val = distCalc.Value();
        return MeasureResult{val, measurementType};
      }
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT measure distance exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  ExploreResult exploreTopology(const std::string& entityId, const std::string& returnType) {
    std::lock_guard<std::mutex> lock(s_.mutex);
    try {
      TopoDS_Shape shape = lookupEntityIn(s_, entityId);
      ExploreResult result;

      TopAbs_ShapeEnum typeEnum;
      if (returnType == "solid") typeEnum = TopAbs_SOLID;
      else if (returnType == "shell") typeEnum = TopAbs_SHELL;
      else if (returnType == "face") typeEnum = TopAbs_FACE;
      else if (returnType == "edge") typeEnum = TopAbs_EDGE;
      else if (returnType == "vertex") typeEnum = TopAbs_VERTEX;
      else {
        throw GeometryError("GE_EMPTY_RESULT", "Invalid return type: " + returnType, false, "");
      }

      TopExp_Explorer exp(shape, typeEnum);
      TopTools_IndexedMapOfShape subShapeMap;
      for (; exp.More(); exp.Next()) {
        subShapeMap.Add(exp.Current());
      }
      for (int i = 1; i <= subShapeMap.Extent(); ++i) {
        result.entityIds.push_back(shapeId(subShapeMap(i)));
      }
      return result;
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_EMPTY_RESULT",
                          std::string("OCCT explore topology exception: ") + e.GetMessageString(),
                          true, "");
    }
  }

  ClashReport computeIntersections(const std::vector<ShellId>& partIds) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    ClashReport report;
    report.intersects = false;

    // Resolve all shells to shapes first
    std::vector<std::pair<ShellId, TopoDS_Shape>> parts;
    parts.reserve(partIds.size());
    for (const auto& id : partIds) {
      auto it = s_.shells.find(id);
      if (it == s_.shells.end()) {
        throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + id, false, "");
      }
      parts.emplace_back(id, it->second.shape);
    }

    try {
      for (size_t i = 0; i < parts.size(); ++i) {
        for (size_t j = i + 1; j < parts.size(); ++j) {
          BRepAlgoAPI_Common common(parts[i].second, parts[j].second);
          common.Build();

          if (!common.IsDone()) {
            throw GeometryError("GE_CLASH_DETECTION_FAILED",
                                "Intersection computation failed between " +
                                    parts[i].first + " and " + parts[j].first,
                                false, "");
          }

          TopoDS_Shape intersection = common.Shape();
          if (intersection.IsNull()) continue;

          // Check if intersection has non-zero volume
          GProp_GProps props;
          BRepGProp::VolumeProperties(intersection, props);
          double vol = props.Mass();
          if (vol < 1e-9) continue;  // Touching faces, not a volumetric clash

          report.intersects = true;

          ClashPair clash;
          clash.partIdA = parts[i].first;
          clash.partIdB = parts[j].first;
          clash.intersectionVolumeMm3 = vol;

          // Compute bounding box of the intersection
          Bnd_Box bbox;
          BRepBndLib::Add(intersection, bbox);
          double xmin, ymin, zmin, xmax, ymax, zmax;
          bbox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
          clash.clashBoundingBox = {xmin, ymin, zmin,
                                    xmax - xmin, ymax - ymin, zmax - zmin};

          // Suggest a cutting plane through the centre of the clash bbox
          // with normal pointing from partA centroid to partB centroid
          GProp_GProps propsA, propsB;
          BRepGProp::VolumeProperties(parts[i].second, propsA);
          BRepGProp::VolumeProperties(parts[j].second, propsB);
          gp_Pnt cA = propsA.CentreOfMass();
          gp_Pnt cB = propsB.CentreOfMass();
          gp_Vec dir(cA, cB);
          if (dir.Magnitude() < 1e-10) dir = gp_Vec(0, 0, 1);
          dir.Normalize();
          clash.suggestedCuttingPlane.normalX = dir.X();
          clash.suggestedCuttingPlane.normalY = dir.Y();
          clash.suggestedCuttingPlane.normalZ = dir.Z();
          clash.suggestedCuttingPlane.originX = (xmin + xmax) * 0.5;
          clash.suggestedCuttingPlane.originY = (ymin + ymax) * 0.5;
          clash.suggestedCuttingPlane.originZ = (zmin + zmax) * 0.5;

          report.clashes.push_back(std::move(clash));
        }
      }
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_CLASH_DETECTION_FAILED",
                          std::string("OCCT exception during clash detection: ") +
                              e.GetMessageString(),
                          false, "");
    }

    return report;
  }

  std::vector<ClashPair> checkAssemblyClashes(
      const std::vector<ShellId>& partIds,
      const std::vector<std::pair<ShellId, ShellId>>& adjacentPairs) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    std::vector<ClashPair> clashes;

    std::unordered_set<ShellId> allowedParts;
    if (!partIds.empty()) {
      allowedParts.insert(partIds.begin(), partIds.end());
    }

    for (const auto& pair : adjacentPairs) {
      const ShellId& idA = pair.first;
      const ShellId& idB = pair.second;

      if (!partIds.empty()) {
        if (allowedParts.find(idA) == allowedParts.end() ||
            allowedParts.find(idB) == allowedParts.end()) {
          continue;
        }
      }

      TopoDS_Shape shapeA;
      auto itA = s_.shells.find(idA);
      if (itA != s_.shells.end()) {
        shapeA = itA->second.shape;
      } else {
        auto solidItA = s_.solids.find(idA);
        if (solidItA != s_.solids.end()) {
          shapeA = solidItA->second.shape;
        } else {
          throw GeometryError("GE_SHELL_NOT_FOUND", "Shell or solid not found: " + idA, false, "");
        }
      }

      TopoDS_Shape shapeB;
      auto itB = s_.shells.find(idB);
      if (itB != s_.shells.end()) {
        shapeB = itB->second.shape;
      } else {
        auto solidItB = s_.solids.find(idB);
        if (solidItB != s_.solids.end()) {
          shapeB = solidItB->second.shape;
        } else {
          throw GeometryError("GE_SHELL_NOT_FOUND", "Shell or solid not found: " + idB, false, "");
        }
      }

      try {
        Bnd_Box boxA;
        Bnd_Box boxB;
        BRepBndLib::AddOptimal(shapeA, boxA);
        BRepBndLib::AddOptimal(shapeB, boxB);

        if (boxA.IsOut(boxB)) {
          continue;
        }

        BRepAlgoAPI_Common common(shapeA, shapeB);
        common.Build();

        if (!common.IsDone()) {
          throw GeometryError("GE_CLASH_FAILED",
                              "Intersection computation failed between " +
                                  idA + " and " + idB,
                              false, "");
        }

        TopoDS_Shape intersection = common.Shape();
        if (intersection.IsNull()) continue;

        GProp_GProps props;
        BRepGProp::VolumeProperties(intersection, props);
        double vol = props.Mass();
        if (vol < 1e-9) continue;

        ClashPair clash;
        clash.partIdA = idA;
        clash.partIdB = idB;
        clash.intersectionVolumeMm3 = vol;

        Bnd_Box bbox;
        BRepBndLib::Add(intersection, bbox);
        double xmin, ymin, zmin, xmax, ymax, zmax;
        bbox.Get(xmin, ymin, zmin, xmax, ymax, zmax);
        clash.clashBoundingBox = {xmin, ymin, zmin,
                                  xmax - xmin, ymax - ymin, zmax - zmin};

        GProp_GProps propsA, propsB;
        BRepGProp::VolumeProperties(shapeA, propsA);
        BRepGProp::VolumeProperties(shapeB, propsB);
        gp_Pnt cA = propsA.CentreOfMass();
        gp_Pnt cB = propsB.CentreOfMass();
        gp_Vec dir(cA, cB);
        if (dir.Magnitude() < 1e-10) dir = gp_Vec(0, 0, 1);
        dir.Normalize();
        clash.suggestedCuttingPlane.normalX = dir.X();
        clash.suggestedCuttingPlane.normalY = dir.Y();
        clash.suggestedCuttingPlane.normalZ = dir.Z();
        double dx = (xmax - xmin) * 0.5;
        double dy = (ymax - ymin) * 0.5;
        double dz = (zmax - zmin) * 0.5;
        double half_size = dx * std::abs(dir.X()) + dy * std::abs(dir.Y()) + dz * std::abs(dir.Z());

        clash.suggestedCuttingPlane.originX = (xmin + xmax) * 0.5 + dir.X() * half_size;
        clash.suggestedCuttingPlane.originY = (ymin + ymax) * 0.5 + dir.Y() * half_size;
        clash.suggestedCuttingPlane.originZ = (zmin + zmax) * 0.5 + dir.Z() * half_size;

        clashes.push_back(std::move(clash));
      } catch (const GeometryError&) {
        throw;
      } catch (const Standard_Failure& e) {
        throw GeometryError("GE_CLASH_FAILED",
                            std::string("OCCT exception during clash detection: ") +
                                e.GetMessageString(),
                            false, "");
      }
    }

    return clashes;
  }

  GapReport computeGaps(const ShellId& partAId,
                        const ShellId& partBId,
                        double maxDistanceThresholdMm) {
    std::lock_guard<std::mutex> lock(s_.mutex);

    auto itA = s_.shells.find(partAId);
    if (itA == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partAId, false, "");
    }
    auto itB = s_.shells.find(partBId);
    if (itB == s_.shells.end()) {
      throw GeometryError("GE_SHELL_NOT_FOUND", "Shell not found: " + partBId, false, "");
    }

    try {
      BRepExtrema_DistShapeShape distCalc(itA->second.shape, itB->second.shape);
      distCalc.Perform();

      if (!distCalc.IsDone()) {
        throw GeometryError("GE_GAP_DETECTION_FAILED",
                            "Distance computation failed between " + partAId +
                                " and " + partBId,
                            false, "");
      }

      GapReport report;
      report.minimumDistanceMm = distCalc.Value();
      report.hasGap = report.minimumDistanceMm > 1e-6 &&
                      report.minimumDistanceMm <= maxDistanceThresholdMm;

      if (distCalc.NbSolution() > 0) {
        // Closest point pair — used to identify the faces involved
        gp_Pnt pA = distCalc.PointOnShape1(1);
        gp_Pnt pB = distCalc.PointOnShape2(1);

        // Walk faces of each shell and find the one containing the closest point
        auto findFaceId = [&](const TopoDS_Shape& shape, const gp_Pnt& pt) -> std::string {
          double bestDist = 1e18;
          std::string bestId;
          TopExp_Explorer exp(shape, TopAbs_FACE);
          for (; exp.More(); exp.Next()) {
            const TopoDS_Face& f = TopoDS::Face(exp.Current());
            Handle(Geom_Surface) surf = BRep_Tool::Surface(f);
            if (surf.IsNull()) continue;
            Standard_Real u1, u2, v1, v2;
            BRepTools::UVBounds(f, u1, u2, v1, v2);
            gp_Pnt mid;
            surf->D0((u1 + u2) * 0.5, (v1 + v2) * 0.5, mid);
            double d = mid.Distance(pt);
            if (d < bestDist) {
              bestDist = d;
              bestId   = shapeId(f);
            }
          }
          return bestId;
        };

        report.partAFaceId = findFaceId(itA->second.shape, pA);
        report.partBFaceId = findFaceId(itB->second.shape, pB);

        // Extension vector: from pA toward pB, magnitude = gap distance
        gp_Vec ext(pA, pB);
        if (ext.Magnitude() > 1e-10) ext.Normalize();
        report.extensionVector = {ext.X(), ext.Y(), ext.Z()};

        // Bounding box enclosing both closest points
        double xmin = std::min(pA.X(), pB.X()) - 1.0;
        double ymin = std::min(pA.Y(), pB.Y()) - 1.0;
        double zmin = std::min(pA.Z(), pB.Z()) - 1.0;
        double xmax = std::max(pA.X(), pB.X()) + 1.0;
        double ymax = std::max(pA.Y(), pB.Y()) + 1.0;
        double zmax = std::max(pA.Z(), pB.Z()) + 1.0;
        report.gapBoundingBox = {xmin, ymin, zmin,
                                 xmax - xmin, ymax - ymin, zmax - zmin};
      }

      return report;
    } catch (const GeometryError&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw GeometryError("GE_GAP_DETECTION_FAILED",
                          std::string("OCCT exception during gap detection: ") +
                              e.GetMessageString(),
                          false, "");
    }
  }

private:
  GeometryState& s_;
};

// ─── Delegation stubs ────────────────────────────────────────────────────────

BoundingBoxResult GeometryServiceImpl::computeBoundingBox(const std::string& entityId) {
  return GeometryMeasurement(state_).computeBoundingBox(entityId);
}

MassPropertiesResult GeometryServiceImpl::computeMassProperties(const std::string& entityId, const std::vector<std::string>& properties) {
  return GeometryMeasurement(state_).computeMassProperties(entityId, properties);
}

MeasureResult GeometryServiceImpl::measureDistance(const std::string& entityA, const std::string& entityB, const std::string& measurementType) {
  return GeometryMeasurement(state_).measureDistance(entityA, entityB, measurementType);
}

ExploreResult GeometryServiceImpl::exploreTopology(const std::string& entityId, const std::string& returnType) {
  return GeometryMeasurement(state_).exploreTopology(entityId, returnType);
}

ClashReport GeometryServiceImpl::computeIntersections(const std::vector<ShellId>& partIds) {
  return GeometryMeasurement(state_).computeIntersections(partIds);
}

std::vector<ClashPair> GeometryServiceImpl::checkAssemblyClashes(
    const std::vector<ShellId>& partIds,
    const std::vector<std::pair<ShellId, ShellId>>& adjacentPairs) {
  return GeometryMeasurement(state_).checkAssemblyClashes(partIds, adjacentPairs);
}

GapReport GeometryServiceImpl::computeGaps(const ShellId& partAId, const ShellId& partBId, double maxDistanceThresholdMm) {
  return GeometryMeasurement(state_).computeGaps(partAId, partBId, maxDistanceThresholdMm);
}

}  // namespace mcp_cad
