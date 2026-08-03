#include "geometry/translation/polygon_boolean.hpp"

#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <BRepGProp.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Pnt.hxx>
#include <Standard_Failure.hxx>

#include <algorithm>
#include <cmath>

namespace mcp_cad::translation {

namespace {

// Same relative-fuzz precedent as part_solid_construction.cc's own
// kBooleanFuzzMm (rebuild/12-domain-notes.md §2 / rebuild/17-numerical-
// policy.md §2.1) — reused rather than inventing a second number for the
// same "how close is close enough for a kernel boolean" question.
constexpr double kBooleanFuzzMm = 1e-5;

double PolygonArea2(const std::vector<Point2>& ring) {
  double sum = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return std::fabs(sum) / 2.0;
}

// Builds a planar face in the z=0 plane from a CCW (or CW — MakeFace/
// MakePolygon do not require a specific winding for a single closed wire)
// ring of 2D points.
TopoDS_Face BuildFace(const std::vector<Point2>& ring) {
  BRepBuilderAPI_MakePolygon polyMaker;
  for (const auto& p : ring) {
    polyMaker.Add(gp_Pnt(p.x, p.y, 0.0));
  }
  polyMaker.Close();
  TopoDS_Wire wire = polyMaker.Wire();
  BRepBuilderAPI_MakeFace faceMaker(wire, /*OnlyPlane=*/true);
  return faceMaker.Face();
}

// BRepAlgoAPI_Fuse/Cut preserve each input's own original face boundaries as
// an internal seam in the result rather than merging coplanar fragments —
// correct topological behaviour, but not what a "single combined outline"
// caller wants. ShapeUpgrade_UnifySameDomain merges same-plane adjacent
// faces (and collinear adjacent edges) back into one — the same fix this
// codebase already applies post-boolean elsewhere (e.g.
// geometry_service_sheet_metal.cc's own facet-unification pass).
TopoDS_Shape UnifyCoplanarFaces(const TopoDS_Shape& shape) {
  ShapeUpgrade_UnifySameDomain unifier(shape, /*UnifyEdges=*/true, /*UnifyFaces=*/true,
                                        /*ConcatBSplines=*/false);
  unifier.Build();
  return unifier.Shape();
}

// Extracts the result's single outer-wire ring, failing with a typed error
// if the shape isn't exactly one hole-free face — see this module's own
// header comment on why that's this slice's deliberate scope boundary.
PolygonBooleanResult ExtractSingleLoop(const TopoDS_Shape& shape) {
  PolygonBooleanResult result;

  int faceCount = 0;
  TopoDS_Face onlyFace;
  for (TopExp_Explorer fExp(shape, TopAbs_FACE); fExp.More(); fExp.Next()) {
    onlyFace = TopoDS::Face(fExp.Current());
    faceCount++;
  }
  if (faceCount != 1) {
    result.errorCode = PolygonBooleanErrorCode::kMultipleLoops;
    result.message = "boolean result has " + std::to_string(faceCount) +
                      " faces (expected exactly 1) — disjoint or empty result";
    return result;
  }

  int wireCount = 0;
  TopoDS_Wire onlyWire;
  for (TopExp_Explorer wExp(onlyFace, TopAbs_WIRE); wExp.More(); wExp.Next()) {
    onlyWire = TopoDS::Wire(wExp.Current());
    wireCount++;
  }
  if (wireCount != 1) {
    result.errorCode = PolygonBooleanErrorCode::kHasHoles;
    result.message = "boolean result face has " + std::to_string(wireCount) +
                      " wires (expected exactly 1 outer, no holes)";
    return result;
  }

  std::vector<Point2> outer;
  for (BRepTools_WireExplorer wExp(onlyWire); wExp.More(); wExp.Next()) {
    gp_Pnt p = BRep_Tool::Pnt(wExp.CurrentVertex());
    outer.push_back({p.X(), p.Y()});
  }
  if (outer.size() < 3) {
    result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
    result.message = "boolean result outer wire has fewer than 3 vertices";
    return result;
  }

  // Canonicalize to CCW (shoelace sign) — same convention this codebase
  // enforces everywhere a ring crosses a module boundary (e.g.
  // getPanelFrame, step_reconciliation.cc), since BRepTools_WireExplorer's
  // own traversal direction is not guaranteed consistent.
  double signedArea = 0.0;
  for (size_t i = 0; i < outer.size(); ++i) {
    const auto& a = outer[i];
    const auto& b = outer[(i + 1) % outer.size()];
    signedArea += a.x * b.y - b.x * a.y;
  }
  if (signedArea < 0.0) {
    std::reverse(outer.begin(), outer.end());
  }

  result.ok = true;
  result.outer = std::move(outer);
  return result;
}

PolygonBooleanResult ValidateInputs(const std::vector<Point2>& ringA,
                                     const std::vector<Point2>& ringB) {
  PolygonBooleanResult result;
  if (ringA.size() < 3 || ringB.size() < 3) {
    result.errorCode = PolygonBooleanErrorCode::kDegenerateInput;
    result.message = "both rings must have at least 3 vertices";
    return result;
  }
  if (PolygonArea2(ringA) < 1e-9 || PolygonArea2(ringB) < 1e-9) {
    result.errorCode = PolygonBooleanErrorCode::kDegenerateInput;
    result.message = "both rings must have non-zero area";
    return result;
  }
  result.ok = true;
  return result;
}

}  // namespace

PolygonBooleanResult PolygonUnion(const std::vector<Point2>& ringA,
                                   const std::vector<Point2>& ringB) {
  PolygonBooleanResult pre = ValidateInputs(ringA, ringB);
  if (!pre.ok) return pre;

  try {
    TopoDS_Face faceA = BuildFace(ringA);
    TopoDS_Face faceB = BuildFace(ringB);

    BRepAlgoAPI_Fuse fuse(faceA, faceB);
    fuse.SetFuzzyValue(kBooleanFuzzMm);
    fuse.Build();
    if (!fuse.IsDone() || fuse.Shape().IsNull()) {
      PolygonBooleanResult result;
      result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
      result.message = "BRepAlgoAPI_Fuse did not produce a result";
      return result;
    }
    BRepCheck_Analyzer analyzer(fuse.Shape());
    if (!analyzer.IsValid()) {
      PolygonBooleanResult result;
      result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
      result.message = "fused shape failed BRepCheck_Analyzer validity check";
      return result;
    }
    return ExtractSingleLoop(UnifyCoplanarFaces(fuse.Shape()));
  } catch (const Standard_Failure& e) {
    PolygonBooleanResult result;
    result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
    result.message = std::string("OCCT exception during union: ") + e.GetMessageString();
    return result;
  }
}

PolygonBooleanResult PolygonDifference(const std::vector<Point2>& ringA,
                                        const std::vector<Point2>& ringB) {
  PolygonBooleanResult pre = ValidateInputs(ringA, ringB);
  if (!pre.ok) return pre;

  try {
    TopoDS_Face faceA = BuildFace(ringA);
    TopoDS_Face faceB = BuildFace(ringB);

    BRepAlgoAPI_Cut cut(faceA, faceB);
    cut.SetFuzzyValue(kBooleanFuzzMm);
    cut.Build();
    if (!cut.IsDone() || cut.Shape().IsNull()) {
      PolygonBooleanResult result;
      result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
      result.message = "BRepAlgoAPI_Cut did not produce a result";
      return result;
    }
    BRepCheck_Analyzer analyzer(cut.Shape());
    if (!analyzer.IsValid()) {
      PolygonBooleanResult result;
      result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
      result.message = "difference shape failed BRepCheck_Analyzer validity check";
      return result;
    }
    return ExtractSingleLoop(UnifyCoplanarFaces(cut.Shape()));
  } catch (const Standard_Failure& e) {
    PolygonBooleanResult result;
    result.errorCode = PolygonBooleanErrorCode::kOperationFailed;
    result.message = std::string("OCCT exception during difference: ") + e.GetMessageString();
    return result;
  }
}

PolygonBooleanResult FuseCoplanarParts(const std::vector<Point2>& outlineA,
                                        const Transform3& anchorA,
                                        const std::vector<Point2>& outlineB,
                                        const Transform3& anchorB,
                                        double thicknessMm) {
  // Same tolerance family as this module's own kBooleanFuzzMm-adjacent
  // precedents (rebuild/17-numerical-policy.md §2.1) — how far out of true
  // coplanarity two independently-anchored parts may sit and still be
  // treated as "the same plane" for fusing. Widened to the parts' own
  // material thickness when that's larger than the base floor: real
  // STEP-import misalignment well under a panel's own thickness is expected
  // noise, not a defect (docs/BUG_REPORT_fuse_bodies_coplanar_tolerance_too_strict.md).
  constexpr double kCoplanarToleranceMm = 0.05;
  const double coplanarToleranceMm = std::max(kCoplanarToleranceMm, thicknessMm);

  // B's outline lives in B's own flat frame (z=0 there); embed each point at
  // z=0, map into WORLD via anchorB, then into A's LOCAL frame via
  // anchorA.Inverse() — the same "relabel into another frame" pattern
  // step_reconciliation.cc already uses (rootFrameInv.Compose(pieceFrame)).
  Transform3 worldToA = anchorA.Inverse();
  Transform3 bToA = worldToA.Compose(anchorB);

  std::vector<Point2> ringBInA;
  ringBInA.reserve(outlineB.size());
  for (const auto& p : outlineB) {
    Point3 inA = bToA.Apply({p.x, p.y, 0.0});
    if (std::fabs(inA.z) > coplanarToleranceMm) {
      PolygonBooleanResult result;
      result.errorCode = PolygonBooleanErrorCode::kNotCoplanar;
      result.message = "part B's outline, transformed into part A's frame, is " +
                        std::to_string(inA.z) + "mm out of A's own z=0 plane (tolerance " +
                        std::to_string(coplanarToleranceMm) + "mm) — not coplanar";
      return result;
    }
    ringBInA.push_back({inA.x, inA.y});
  }

  return PolygonUnion(outlineA, ringBInA);
}

}  // namespace mcp_cad::translation
