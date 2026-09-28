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
#include <limits>

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

Point2 ClosestPointOnSegment(const Point2& p, const Point2& a, const Point2& b) {
  double abx = b.x - a.x;
  double aby = b.y - a.y;
  double abLenSq = abx * abx + aby * aby;
  if (abLenSq < 1e-18) return a;  // degenerate (zero-length) segment
  double t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / abLenSq;
  t = std::clamp(t, 0.0, 1.0);
  return {a.x + t * abx, a.y + t * aby};
}

struct ClosestRingPointsResult {
  Point2 onA{0.0, 0.0};
  Point2 onB{0.0, 0.0};
  double distMm = 0.0;
};

// The minimum-distance point pair between two closed 2D rings — checked as
// every vertex of one ring against every EDGE of the other (both
// directions), which covers every true segment-segment closest-point case
// (vertex-to-edge projection or vertex-to-vertex) without a separate full
// segment-segment-distance routine. O(nA*nB); both rings here are small,
// authored/reconciled outlines, not tessellated curves.
ClosestRingPointsResult NearestPointsBetweenRings(const std::vector<Point2>& ringA,
                                                   const std::vector<Point2>& ringB) {
  ClosestRingPointsResult best;
  best.distMm = std::numeric_limits<double>::infinity();
  size_t nA = ringA.size();
  size_t nB = ringB.size();
  if (nA == 0 || nB == 0) return best;

  auto consider = [&](const Point2& onA, const Point2& onB) {
    double dx = onA.x - onB.x;
    double dy = onA.y - onB.y;
    double d = std::sqrt(dx * dx + dy * dy);
    if (d < best.distMm) {
      best.distMm = d;
      best.onA = onA;
      best.onB = onB;
    }
  };

  for (const auto& pb : ringB) {
    for (size_t i = 0; i < nA; ++i) {
      consider(ClosestPointOnSegment(pb, ringA[i], ringA[(i + 1) % nA]), pb);
    }
  }
  for (const auto& pa : ringA) {
    for (size_t j = 0; j < nB; ++j) {
      consider(pa, ClosestPointOnSegment(pa, ringB[j], ringB[(j + 1) % nB]));
    }
  }
  return best;
}

struct ClosestPointOnRingResult {
  Point2 point{0.0, 0.0};
  double distMm = std::numeric_limits<double>::infinity();
  // True iff `point` coincides with one of ring's own VERTICES rather than
  // landing on an edge's interior — see ClosestPointOnRing's own comment on
  // why this distinction matters for the per-vertex snap.
  bool isAtRingVertex = false;
};

// The single closest point on ring's own boundary to p — checked against
// every edge of ring. Used to snap ONE vertex of a touching outline onto the
// other outline independently (see FuseCoplanarParts): real STEP-imported
// outlines carry per-vertex noise, not a shared rigid offset, so each
// touching vertex needs its own nearest-point correction rather than one
// delta applied to the whole ring.
//
// Also reports whether the closest point landed exactly on one of ring's
// own vertices (a corner) rather than an edge's interior — real touching-
// seam noise lands on an edge INTERIOR (the corresponding real feature is
// somewhere along that edge, not at its endpoint); landing on a ring's own
// corner instead is the signature of a genuinely different feature (e.g. a
// real corner/overhang of the OTHER outline that legitimately extends past
// this ring's own extent) being close only by coincidence, not because it's
// the same seam. FuseCoplanarParts' per-vertex snap uses this to leave a
// genuine overhang alone instead of clipping it off (confirmed live: a
// hand-authored "staggered shared edge" regression test — B's own corner
// legitimately sits 0.3mm past A's corner — was silently losing that real
// area before this distinction was added).
ClosestPointOnRingResult ClosestPointOnRing(const Point2& p, const std::vector<Point2>& ring) {
  ClosestPointOnRingResult best;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    Point2 candidate = ClosestPointOnSegment(p, a, b);
    double dx = candidate.x - p.x;
    double dy = candidate.y - p.y;
    double d = std::sqrt(dx * dx + dy * dy);
    if (d < best.distMm) {
      best.distMm = d;
      best.point = candidate;
      constexpr double kVertexEps = 1e-6;
      auto nearVertex = [&](const Point2& v) {
        return std::fabs(candidate.x - v.x) < kVertexEps && std::fabs(candidate.y - v.y) < kVertexEps;
      };
      best.isAtRingVertex = nearVertex(a) || nearVertex(b);
    }
  }
  return best;
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
  // Same "typed AND actionable" bar as FuseCoplanarParts' own gap-distance
  // report: "N faces" alone doesn't say whether they're touching-but-not-
  // merged, genuinely far apart, or one of them is a sliver — each is a
  // different fix. Report each face's own area and centroid so a real
  // failure (this session's own testcube.step live repro attempts) is
  // diagnosable from the error message alone, not by re-instrumenting this
  // function by hand again.
  std::string faceSummary;
  for (TopExp_Explorer fExp(shape, TopAbs_FACE); fExp.More(); fExp.Next()) {
    onlyFace = TopoDS::Face(fExp.Current());
    faceCount++;
    GProp_GProps props;
    BRepGProp::SurfaceProperties(onlyFace, props);
    gp_Pnt c = props.CentreOfMass();
    faceSummary += " face[" + std::to_string(faceCount) + "]: area=" +
                    std::to_string(props.Mass()) + "mm^2 centroid=(" + std::to_string(c.X()) +
                    "," + std::to_string(c.Y()) + ")";
  }
  if (faceCount != 1) {
    result.errorCode = PolygonBooleanErrorCode::kMultipleLoops;
    result.message = "boolean result has " + std::to_string(faceCount) +
                      " faces (expected exactly 1) — disjoint or empty result;" + faceSummary;
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

// Reverses ring in place if its shoelace signed area is negative (CW),
// leaving a CCW-wound ring untouched. Same vertices, same shape, same
// position — only traversal direction changes, so this can never move or
// distort anything; it only fixes which way MakeFace's own winding-derived
// normal ends up facing.
//
// BuildFace/BRepBuilderAPI_MakeFace does not itself require CCW input (its
// own comment says so — any single closed wire makes a valid standalone
// face), but that guarantee stops mattering once TWO such faces are hair-
// coplanar and fed to BRepAlgoAPI_Fuse: a caller-supplied ring's winding is
// never normalized before this point, so two rings arriving with OPPOSITE
// windings (a face-normal mismatch, not a position or shape defect) can
// build faces whose normals point opposite ways in the same plane —
// confirmed live (2026-09): FuseCoplanarParts' own anchor-relative
// projection can flip a ring's winding whenever the projection's in-plane
// rotation has determinant -1 (a real, correct fact about two independently
// -chosen local frames, not an error — see this session's own reverted
// "mirror correction" attempt, which wrongly tried to fix this one level up
// by moving vertices instead of just re-ordering them). The fix belongs
// here: two CLEANLY overlapping real testcube.step rings (a uniform 0.05mm
// overlap, verified by hand) reproducibly failed BRepAlgoAPI_Fuse with
// "2 faces" until both inputs were canonicalized to the SAME winding —
// confirmed independent of kBooleanFuzzMm (still failed at a 10,000x looser
// fuzz value), isolating this as a winding/orientation defect, not a
// numerical-tolerance one.
void CanonicalizeCCW(std::vector<Point2>& ring) {
  double signedArea = 0.0;
  size_t n = ring.size();
  for (size_t i = 0; i < n; ++i) {
    const Point2& a = ring[i];
    const Point2& b = ring[(i + 1) % n];
    signedArea += a.x * b.y - b.x * a.y;
  }
  if (signedArea < 0.0) {
    std::reverse(ring.begin(), ring.end());
  }
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
    std::vector<Point2> ccwA = ringA;
    std::vector<Point2> ccwB = ringB;
    CanonicalizeCCW(ccwA);
    CanonicalizeCCW(ccwB);
    TopoDS_Face faceA = BuildFace(ccwA);
    TopoDS_Face faceB = BuildFace(ccwB);

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
    std::vector<Point2> ccwA = ringA;
    std::vector<Point2> ccwB = ringB;
    CanonicalizeCCW(ccwA);
    CanonicalizeCCW(ccwB);
    TopoDS_Face faceA = BuildFace(ccwA);
    TopoDS_Face faceB = BuildFace(ccwB);

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
  //
  // For any part with REAL material thickness, also floored at the
  // established ~2mm STEP-import-noise precedent this codebase already uses
  // everywhere else two independently-reconciled pieces of the same real
  // fixture are compared for "close enough to call the same seam/surface"
  // — kMergeEdgeAlignmentToleranceMm (part_merge.cc),
  // kPieceEdgeMatchToleranceMm/kSelfConsistencyToleranceMm
  // (step_reconciliation.cc), the MapPointToFlat precedent (point_mapping.cc).
  // A thin-material fuse (thicknessMm < 2mm, the common case) was otherwise
  // held to a TIGHTER bar here than every other STEP-reconciliation check in
  // the pipeline, for no principled reason — confirmed live (2026-08-26): a
  // real testcube.step panel+protrusion fuse failed at a 1.025mm gap against
  // a 0.95mm (thickness-only) tolerance, well inside this already-accepted
  // 2mm noise floor. Gated on thicknessMm > 0 (not applied unconditionally)
  // so a deliberately zero-thickness input — this module's own test for "no
  // thickness-based leniency" — stays exactly as strict as before; only
  // parts with real material get the import-noise allowance.
  constexpr double kCoplanarToleranceMm = 0.05;
  constexpr double kImportNoiseToleranceMm = 2.0;
  const double coplanarToleranceMm = thicknessMm > 0.0
      ? std::max({kCoplanarToleranceMm, thicknessMm, kImportNoiseToleranceMm})
      : kCoplanarToleranceMm;

  // B's outline lives in B's own flat frame (z=0 there); embed each point at
  // z=0, map into WORLD via anchorB, then into A's LOCAL frame via
  // anchorA.Inverse() — the same "relabel into another frame" pattern
  // step_reconciliation.cc already uses (rootFrameInv.Compose(pieceFrame)).
  Transform3 worldToA = anchorA.Inverse();
  Transform3 bToA = worldToA.Compose(anchorB);

  // REVERTED (2026-09): an earlier version of this function detected an
  // axis-aligned in-plane mirror between B's and A's rotations and
  // "corrected" it by reinterpreting B's local (x,y) through a different
  // rotation before projecting. That was wrong: it changed which SHAPE gets
  // unioned while leaving B's anchor translation untouched — the
  // translation was set (by a real "Translate Body" edit) against the
  // TRUE, uncorrected outline the user actually sees rendered, so
  // substituting a different-shaped B at that same position produced a
  // silently wrong result (confirmed live: the fused material landed on
  // top of A instead of beside it, so the protrusion visually vanished —
  // worse than the typed rejection this replaced, since it gave no error
  // at all). Reverted to the faithful projection below pending a proper
  // investigation of whether the flat-pattern outline's local axes are
  // even meant to align with the anchor's rotation the way that fix
  // assumed.
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

  // Snap B's projected outline to close any small residual XY gap against
  // A — NOT a tolerance override on the boolean itself. v2's constitution
  // (principle III/VI) deliberately rejects a "gap tolerance" fallback for
  // this exact disjoint-result case (see fuse_bodies.integration.test.ts's
  // own header comment on why v1's DXF-drift compensation was not ported):
  // v2 measures each panel's outline once, from one real ring, so two
  // panels genuinely meant to touch in 3D should never show a fake gap. A
  // real one (e.g. a manually-entered alignment translate landing a hair
  // off) is a real position error, not measurement drift — so this closes
  // it exactly, the same "move the part to its true touching position"
  // idea close_gap.hpp already applies WITHIN one part (close_gap.cc,
  // ComputeCloseGapDelta), extended here across two independently-anchored
  // parts.
  //
  // Two DIFFERENT physical error sources land here and need different
  // corrections:
  //  1. B's own ANCHOR (its rigid 3D pose) is a hair off — B's outline
  //     itself is clean, the whole part is uniformly mispositioned (e.g. a
  //     manually-entered alignment translate landing a hair short). The fix
  //     is a single rigid shift of ALL of B — moving only the near edge and
  //     leaving the far edge behind would stretch a physically rigid part.
  //  2. B's own OUTLINE carries real per-vertex noise baked in during STEP
  //     reconciliation (confirmed against real testcube.step protrusion
  //     dumps: each vertex individually off by a fraction of a mm — not a
  //     rigid translate/rotate of the whole ring). One shared delta zeroes
  //     out the closest pair and leaves every OTHER near-touching vertex
  //     with a residual gap the boolean's fuzzy value (kBooleanFuzzMm =
  //     1e-5) cannot bridge.
  // These are not alternatives to pick between — both can be true on the
  // same part at once — so both corrections apply unconditionally, in a
  // fixed order: first the single rigid best-fit shift (closest point pair,
  // applied to the whole ring, same as ever), then a per-vertex residual
  // snap that closes whatever the rigid shift alone could not (any vertex
  // still within tolerance of A's boundary, individually — but never onto
  // one of A's own CORNERS specifically: that's the signature of a
  // genuinely different feature landing close by coincidence, not the same
  // touching seam, see ClosestPointOnRing's own comment). A genuinely
  // large gap (unrelated parts) is left untouched by both steps —
  // PolygonUnion still rejects it exactly as before.
  double measuredGapMm = -1.0;  // -1: not measured (empty ringBInA)
  if (!ringBInA.empty()) {
    ClosestRingPointsResult nearest = NearestPointsBetweenRings(outlineA, ringBInA);
    measuredGapMm = nearest.distMm;
    if (nearest.distMm > 1e-9 && nearest.distMm <= coplanarToleranceMm) {
      double dx = nearest.onA.x - nearest.onB.x;
      double dy = nearest.onA.y - nearest.onB.y;
      for (auto& p : ringBInA) {
        p.x += dx;
        p.y += dy;
      }
    }
    for (auto& p : ringBInA) {
      ClosestPointOnRingResult onA = ClosestPointOnRing(p, outlineA);
      if (onA.distMm > 1e-9 && onA.distMm <= coplanarToleranceMm && !onA.isAtRingVertex) {
        p = onA.point;
      }
    }
  }

  PolygonBooleanResult result = PolygonUnion(outlineA, ringBInA);
  // The generic "N faces" message from ExtractSingleLoop says nothing about
  // WHY — a caller debugging a real "disjoint" result (this session's own
  // testcube.step live repro attempts) has no way to tell "off by a hair,
  // investigate the gap-close threshold" from "off by 150mm, wrong parts
  // entirely" without instrumenting this function themselves. The in-plane
  // gap was already measured above (and IS the reason when it exceeds
  // coplanarToleranceMm — the snap above only ever applies to a smaller
  // one), so report it directly instead of making every caller re-derive it.
  if (!result.ok && result.errorCode == PolygonBooleanErrorCode::kMultipleLoops &&
      measuredGapMm >= 0.0) {
    result.message += " (closest in-plane XY gap between the two outlines: " +
                       std::to_string(measuredGapMm) + "mm; gap-close tolerance: " +
                       std::to_string(coplanarToleranceMm) + "mm)";
  }
  return result;
}

}  // namespace mcp_cad::translation
