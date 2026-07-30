/**
 * NAPI translation binding — TypeScript <-> C++ marshaling for the pure
 * translation module (manufacturing_graph_evaluator) and its Port D-lite
 * solid construction (part_solid_construction).
 *
 * Two entry points, matching rebuild's Slice 1 plan:
 *   - evaluatePartGraph: a free function, NOT routed through GeometryService —
 *     translation::Evaluate() is pure/stateless (no OCCT, no shared state), so
 *     there is nothing for the service layer to add here.
 *   - constructPartSolid: routed through GeometryService (svc().constructPartSolid),
 *     since the resulting shape is registered in the SAME shared GeometryState
 *     every other geometry operation uses — the returned shellId must be usable
 *     by exportDxf/measurement/etc. exactly like any other constructed shell.
 */

#include <napi.h>
#include "../geometry/geometry_service.hpp"
#include "../geometry/translation/manufacturing_graph_evaluator.hpp"
#include "../geometry/translation/point_mapping.hpp"
#include "../geometry/translation/part_merge.hpp"
#include "../geometry/translation/step_reconciliation.hpp"
#include "../geometry/translation/polygon_boolean.hpp"
#include "../geometry/translation/cut_panel.hpp"
#include "../geometry/translation/close_gap.hpp"
#include "../geometry/translation/add_flange.hpp"
#include "../geometry/translation/rip_edge.hpp"
#include "../geometry/translation/generate_reliefs.hpp"
#include "../geometry/translation/split_by_plane.hpp"
#include "../geometry/validation/rules_engine.hpp"
#include "../geometry/validation/profile.hpp"

#include <string>
#include <vector>

namespace mcp_cad {

using translation::BendSpec;
using translation::BridgeLayout;
using translation::EvaluateErrorCode;
using translation::EvaluateResult;
using translation::MapErrorCode;
using translation::MapToFlatResult;
using translation::MapToWorldResult;
using translation::MergeErrorCode;
using translation::PartGraphSpec;
using translation::ReconcileOutlinesResult;
using translation::Point2;
using translation::Point3;
using translation::RegionPanelLayout;
using translation::Transform3;
using translation::PanelPieceSpec;
using translation::ReconcileErrorCode;
using translation::ReconcilePiecesResult;
using translation::PolygonBooleanErrorCode;
using translation::PolygonBooleanResult;
using translation::CircleHoleSpec;
using translation::CutPanelErrorCode;
using translation::CutPanelResult;

// svc() (the single-session-per-process GeometryService instance) is already
// declared+defined, `static`, in geometry_binding.cc — addon.cc #includes that
// file BEFORE this one into a single translation unit (the established
// single-TU NAPI build pattern), so it is already in scope here; no
// declaration of our own is needed (and re-declaring it — even as a forward
// declaration — would conflict with its internal `static` linkage). Reusing
// the SAME instance is what's wanted anyway: a shellId built here must be
// visible to every other existing geometry operation.

namespace {

// ─── EvaluateErrorCode <-> string ─────────────────────────────────────────────

const char* ErrorCodeToString(EvaluateErrorCode code) {
  switch (code) {
    case EvaluateErrorCode::kNone: return "";
    case EvaluateErrorCode::kTreeCycleDetected: return "GE_TREE_CYCLE_DETECTED";
    case EvaluateErrorCode::kBendSelfReference: return "GE_BEND_SELF_REFERENCE";
    case EvaluateErrorCode::kDanglingBendReference: return "GE_DANGLING_BEND_REFERENCE";
    case EvaluateErrorCode::kRegionClipFailed: return "GE_REGION_CLIP_FAILED";
    case EvaluateErrorCode::kDegenerateOutline: return "GE_DEGENERATE_OUTLINE";
  }
  return "GE_UNKNOWN_ERROR";
}

const char* MapErrorCodeToString(MapErrorCode code) {
  switch (code) {
    case MapErrorCode::kNone: return "";
    case MapErrorCode::kPointNotOnPart: return "GE_POINT_NOT_ON_PART";
    case MapErrorCode::kInvalidLayout: return "GE_INVALID_LAYOUT";
  }
  return "GE_UNKNOWN_ERROR";
}

const char* MergeErrorCodeToString(MergeErrorCode code) {
  switch (code) {
    case MergeErrorCode::kNone: return "";
    case MergeErrorCode::kInvalidEdgeRef: return "GE_INVALID_EDGE_REF";
    case MergeErrorCode::kMergeEdgeMismatch: return "GE_MERGE_EDGE_MISMATCH";
    case MergeErrorCode::kMergeSelfIntersecting: return "GE_MERGE_SELF_INTERSECTION";
  }
  return "GE_UNKNOWN_ERROR";
}

const char* ReconcileErrorCodeToString(ReconcileErrorCode code) {
  switch (code) {
    case ReconcileErrorCode::kNone: return "";
    case ReconcileErrorCode::kTooFewPieces: return "GE_TOO_FEW_PIECES";
    case ReconcileErrorCode::kDisconnectedPieces: return "GE_DISCONNECTED_PIECES";
    case ReconcileErrorCode::kNonDevelopableFold: return "GE_NON_DEVELOPABLE_FOLD";
    case ReconcileErrorCode::kSelfIntersecting: return "GE_RECONCILE_SELF_INTERSECTION";
    case ReconcileErrorCode::kDownstreamPoseMismatch: return "GE_DOWNSTREAM_POSE_MISMATCH";
  }
  return "GE_UNKNOWN_ERROR";
}

const char* PolygonBooleanErrorCodeToString(PolygonBooleanErrorCode code) {
  switch (code) {
    case PolygonBooleanErrorCode::kNone: return "";
    case PolygonBooleanErrorCode::kDegenerateInput: return "GE_DEGENERATE_OUTLINE";
    case PolygonBooleanErrorCode::kOperationFailed: return "GE_POLYGON_BOOLEAN_FAILED";
    // Reuses v1's own name (ts/src/mcp/errors.ts) for the identical concept —
    // a boolean result that came out as more than one disjoint piece —
    // rather than inventing a second name for the same fact.
    case PolygonBooleanErrorCode::kMultipleLoops: return "GE_FUSE_DISJOINT_RESULT";
    case PolygonBooleanErrorCode::kHasHoles: return "GE_POLYGON_HAS_HOLES";
    case PolygonBooleanErrorCode::kNotCoplanar: return "GE_FUSE_NOT_COPLANAR";
  }
  return "GE_UNKNOWN_ERROR";
}

const char* CutPanelErrorCodeToString(CutPanelErrorCode code) {
  switch (code) {
    case CutPanelErrorCode::kNone: return "";
    // Exact semantic match with the existing outline-degeneracy code — same
    // reuse discipline as PolygonBooleanErrorCodeToString above.
    case CutPanelErrorCode::kDegenerateInput: return "GE_DEGENERATE_OUTLINE";
    case CutPanelErrorCode::kHoleNotContained: return "GE_CUT_HOLE_NOT_CONTAINED";
  }
  return "GE_UNKNOWN_ERROR";
}

// ─── JS -> C++ ────────────────────────────────────────────────────────────────

Point2 ReadPoint2(const Napi::Object& obj) {
  Point2 p;
  p.x = obj.Get("x").As<Napi::Number>().DoubleValue();
  p.y = obj.Get("y").As<Napi::Number>().DoubleValue();
  return p;
}

Point3 ReadPoint3(const Napi::Object& obj) {
  Point3 p;
  p.x = obj.Get("x").As<Napi::Number>().DoubleValue();
  p.y = obj.Get("y").As<Napi::Number>().DoubleValue();
  p.z = obj.Get("z").As<Napi::Number>().DoubleValue();
  return p;
}

// Transform3 is JS-facing as { r: number[9], t: number[3] } — the same
// row-major 3x3 rotation + translation layout Transform3 itself uses, so this
// is a direct field-for-field copy, not a re-derivation of anything.
Transform3 ReadTransform3(const Napi::Object& obj) {
  Transform3 t = Transform3::Identity();
  Napi::Array rArr = obj.Get("r").As<Napi::Array>();
  Napi::Array tArr = obj.Get("t").As<Napi::Array>();
  for (uint32_t i = 0; i < 9 && i < rArr.Length(); ++i) {
    t.r[i] = rArr.Get(i).As<Napi::Number>().DoubleValue();
  }
  for (uint32_t i = 0; i < 3 && i < tArr.Length(); ++i) {
    t.t[i] = tArr.Get(i).As<Napi::Number>().DoubleValue();
  }
  return t;
}

std::vector<Point2> ReadPoint2Array(const Napi::Array& arr) {
  std::vector<Point2> pts;
  pts.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    pts.push_back(ReadPoint2(arr.Get(i).As<Napi::Object>()));
  }
  return pts;
}

std::vector<Point3> ReadPoint3Array(const Napi::Array& arr) {
  std::vector<Point3> pts;
  pts.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    pts.push_back(ReadPoint3(arr.Get(i).As<Napi::Object>()));
  }
  return pts;
}

PartGraphSpec ReadPartGraphSpec(const Napi::Object& obj) {
  PartGraphSpec graph;
  graph.partId = obj.Get("partId").As<Napi::String>().Utf8Value();
  graph.rootRegionPanelId = obj.Get("rootRegionPanelId").As<Napi::String>().Utf8Value();
  graph.thicknessMm = obj.Get("thicknessMm").As<Napi::Number>().DoubleValue();

  Napi::Object outlineObj = obj.Get("outline").As<Napi::Object>();
  Napi::Array outerArr = outlineObj.Get("outer").As<Napi::Array>();
  for (uint32_t i = 0; i < outerArr.Length(); ++i) {
    graph.outline.outer.push_back(ReadPoint2(outerArr.Get(i).As<Napi::Object>()));
  }
  // Phase 5 Slice 9a: polygonHoles/circleHoles are additive — default empty
  // when the JS side omits them, so every pre-Slice-9a caller/test that
  // constructs a NapiPartGraphSpec without holes keeps working unchanged.
  Napi::Value polygonHolesV = outlineObj.Get("polygonHoles");
  if (polygonHolesV.IsArray()) {
    Napi::Array polygonHolesArr = polygonHolesV.As<Napi::Array>();
    for (uint32_t i = 0; i < polygonHolesArr.Length(); ++i) {
      graph.outline.polygonHoles.push_back(
          ReadPoint2Array(polygonHolesArr.Get(i).As<Napi::Array>()));
    }
  }
  Napi::Value circleHolesV = outlineObj.Get("circleHoles");
  if (circleHolesV.IsArray()) {
    Napi::Array circleHolesArr = circleHolesV.As<Napi::Array>();
    for (uint32_t i = 0; i < circleHolesArr.Length(); ++i) {
      Napi::Object circleObj = circleHolesArr.Get(i).As<Napi::Object>();
      CircleHoleSpec circle;
      circle.center = ReadPoint2(circleObj.Get("center").As<Napi::Object>());
      circle.radiusMm = circleObj.Get("radiusMm").As<Napi::Number>().DoubleValue();
      graph.outline.circleHoles.push_back(circle);
    }
  }

  Napi::Value anchorV = obj.Get("anchor");
  if (anchorV.IsObject()) {
    Napi::Object anchorObj = anchorV.As<Napi::Object>();
    Napi::Value transformV = anchorObj.Get("transform");
    if (transformV.IsObject()) {
      graph.anchor.transform = ReadTransform3(transformV.As<Napi::Object>());
    }
  }

  Napi::Array bendsArr = obj.Get("bends").As<Napi::Array>();
  for (uint32_t i = 0; i < bendsArr.Length(); ++i) {
    Napi::Object bendObj = bendsArr.Get(i).As<Napi::Object>();
    BendSpec bend;
    bend.id = bendObj.Get("id").As<Napi::String>().Utf8Value();
    bend.parentRegionPanelId = bendObj.Get("parentRegionPanelId").As<Napi::String>().Utf8Value();
    bend.childRegionPanelId = bendObj.Get("childRegionPanelId").As<Napi::String>().Utf8Value();
    bend.hingeA = ReadPoint2(bendObj.Get("hingeA").As<Napi::Object>());
    bend.hingeB = ReadPoint2(bendObj.Get("hingeB").As<Napi::Object>());
    bend.angleDeg = bendObj.Get("angleDeg").As<Napi::Number>().DoubleValue();
    Napi::Value radiusV = bendObj.Get("radiusMm");
    bend.radiusMm = radiusV.IsNumber() ? radiusV.As<Napi::Number>().DoubleValue() : 0.0;
    Napi::Value kFactorV = bendObj.Get("kFactor");
    bend.kFactor = kFactorV.IsNumber() ? kFactorV.As<Napi::Number>().DoubleValue() : 0.0;
    Napi::Value bottomIsConcaveV = bendObj.Get("bottomIsConcave");
    if (bottomIsConcaveV.IsBoolean()) {
      bend.bottomIsConcave = bottomIsConcaveV.As<Napi::Boolean>().Value();
    }
    graph.bends.push_back(std::move(bend));
  }

  return graph;
}

PanelPieceSpec ReadPanelPieceSpec(const Napi::Object& obj) {
  PanelPieceSpec piece;
  piece.origin = ReadPoint3(obj.Get("origin").As<Napi::Object>());
  piece.uAxis = ReadPoint3(obj.Get("uAxis").As<Napi::Object>());
  piece.vAxis = ReadPoint3(obj.Get("vAxis").As<Napi::Object>());
  piece.normal = ReadPoint3(obj.Get("normal").As<Napi::Object>());
  piece.ringLocal = ReadPoint2Array(obj.Get("ringLocal").As<Napi::Array>());
  piece.thicknessMm = obj.Get("thicknessMm").As<Napi::Number>().DoubleValue();
  return piece;
}

std::vector<PanelPieceSpec> ReadPanelPieceSpecArray(const Napi::Array& arr) {
  std::vector<PanelPieceSpec> pieces;
  pieces.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    pieces.push_back(ReadPanelPieceSpec(arr.Get(i).As<Napi::Object>()));
  }
  return pieces;
}

// ─── C++ -> JS ────────────────────────────────────────────────────────────────

Napi::Object WritePoint2(Napi::Env env, const Point2& p) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("x", Napi::Number::New(env, p.x));
  obj.Set("y", Napi::Number::New(env, p.y));
  return obj;
}

Napi::Object WritePoint3(Napi::Env env, const Point3& p) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("x", Napi::Number::New(env, p.x));
  obj.Set("y", Napi::Number::New(env, p.y));
  obj.Set("z", Napi::Number::New(env, p.z));
  return obj;
}

Napi::Object WriteTransform3(Napi::Env env, const Transform3& t) {
  Napi::Object obj = Napi::Object::New(env);
  Napi::Array rArr = Napi::Array::New(env, 9);
  for (int i = 0; i < 9; ++i) rArr.Set(i, Napi::Number::New(env, t.r[i]));
  Napi::Array tArr = Napi::Array::New(env, 3);
  for (int i = 0; i < 3; ++i) tArr.Set(i, Napi::Number::New(env, t.t[i]));
  obj.Set("r", rArr);
  obj.Set("t", tArr);
  return obj;
}

Napi::Array WritePoint2Array(Napi::Env env, const std::vector<Point2>& pts) {
  Napi::Array arr = Napi::Array::New(env, pts.size());
  for (size_t i = 0; i < pts.size(); ++i) arr.Set(i, WritePoint2(env, pts[i]));
  return arr;
}

Napi::Array WritePoint3Array(Napi::Env env, const std::vector<Point3>& pts) {
  Napi::Array arr = Napi::Array::New(env, pts.size());
  for (size_t i = 0; i < pts.size(); ++i) arr.Set(i, WritePoint3(env, pts[i]));
  return arr;
}

Napi::Array WriteStringArray(Napi::Env env, const std::vector<std::string>& strs) {
  Napi::Array arr = Napi::Array::New(env, strs.size());
  for (size_t i = 0; i < strs.size(); ++i) arr.Set(i, Napi::String::New(env, strs[i]));
  return arr;
}

Napi::Object WriteCircleHoleSpec(Napi::Env env, const CircleHoleSpec& circle) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("center", WritePoint2(env, circle.center));
  obj.Set("radiusMm", Napi::Number::New(env, circle.radiusMm));
  return obj;
}

Napi::Array WritePolygonHoleArray(Napi::Env env, const std::vector<std::vector<Point2>>& holes) {
  Napi::Array arr = Napi::Array::New(env, holes.size());
  for (size_t i = 0; i < holes.size(); ++i) arr.Set(i, WritePoint2Array(env, holes[i]));
  return arr;
}

Napi::Array WriteCircleHoleArray(Napi::Env env, const std::vector<CircleHoleSpec>& holes) {
  Napi::Array arr = Napi::Array::New(env, holes.size());
  for (size_t i = 0; i < holes.size(); ++i) arr.Set(i, WriteCircleHoleSpec(env, holes[i]));
  return arr;
}

Napi::Object WriteRegionPanelLayout(Napi::Env env, const RegionPanelLayout& panel) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("regionPanelId", Napi::String::New(env, panel.regionPanelId));
  obj.Set("regionOuter", WritePoint2Array(env, panel.regionOuter));
  obj.Set("bottomFace", WritePoint3Array(env, panel.bottomFace));
  obj.Set("topFace", WritePoint3Array(env, panel.topFace));
  obj.Set("pose", WriteTransform3(env, panel.pose));
  obj.Set("edgeBendId", WriteStringArray(env, panel.edgeBendId));
  obj.Set("regionPolygonHoles", WritePolygonHoleArray(env, panel.regionPolygonHoles));
  obj.Set("regionCircleHoles", WriteCircleHoleArray(env, panel.regionCircleHoles));
  return obj;
}

Napi::Object WriteBridgeLayout(Napi::Env env, const BridgeLayout& bridge) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("bendId", Napi::String::New(env, bridge.bendId));
  obj.Set("parentRegionPanelId", Napi::String::New(env, bridge.parentRegionPanelId));
  obj.Set("childRegionPanelId", Napi::String::New(env, bridge.childRegionPanelId));
  obj.Set("pivotOriginWorld", WritePoint3(env, bridge.pivotOriginWorld));
  obj.Set("pivotAxisWorld", WritePoint3(env, bridge.pivotAxisWorld));
  obj.Set("angleDeg", Napi::Number::New(env, bridge.angleDeg));
  return obj;
}

Napi::Object WriteEvaluateResult(Napi::Env env, const EvaluateResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, ErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));

  Napi::Array panelsArr = Napi::Array::New(env, result.panels.size());
  for (size_t i = 0; i < result.panels.size(); ++i) {
    panelsArr.Set(i, WriteRegionPanelLayout(env, result.panels[i]));
  }
  obj.Set("panels", panelsArr);

  Napi::Array bridgesArr = Napi::Array::New(env, result.bridges.size());
  for (size_t i = 0; i < result.bridges.size(); ++i) {
    bridgesArr.Set(i, WriteBridgeLayout(env, result.bridges[i]));
  }
  obj.Set("bridges", bridgesArr);

  return obj;
}

// evaluatePartGraph's own JS-facing EvaluateResult shape (above) is also what
// constructPartSolid's caller is expected to pass BACK in — this reader is the
// exact inverse of WriteEvaluateResult, field for field.
EvaluateResult ReadEvaluateResult(const Napi::Object& obj) {
  EvaluateResult result;
  result.ok = obj.Get("ok").As<Napi::Boolean>().Value();
  result.message = obj.Get("message").As<Napi::String>().Utf8Value();
  // errorCode is round-tripped as a plain string on the JS side; not parsed
  // back into the enum here since ConstructPartSolid never reads it.

  Napi::Array panelsArr = obj.Get("panels").As<Napi::Array>();
  for (uint32_t i = 0; i < panelsArr.Length(); ++i) {
    Napi::Object panelObj = panelsArr.Get(i).As<Napi::Object>();
    RegionPanelLayout panel;
    panel.regionPanelId = panelObj.Get("regionPanelId").As<Napi::String>().Utf8Value();

    Napi::Array regionOuterArr = panelObj.Get("regionOuter").As<Napi::Array>();
    for (uint32_t j = 0; j < regionOuterArr.Length(); ++j) {
      panel.regionOuter.push_back(ReadPoint2(regionOuterArr.Get(j).As<Napi::Object>()));
    }
    Napi::Array bottomFaceArr = panelObj.Get("bottomFace").As<Napi::Array>();
    for (uint32_t j = 0; j < bottomFaceArr.Length(); ++j) {
      panel.bottomFace.push_back(ReadPoint3(bottomFaceArr.Get(j).As<Napi::Object>()));
    }
    Napi::Array topFaceArr = panelObj.Get("topFace").As<Napi::Array>();
    for (uint32_t j = 0; j < topFaceArr.Length(); ++j) {
      panel.topFace.push_back(ReadPoint3(topFaceArr.Get(j).As<Napi::Object>()));
    }
    panel.pose = ReadTransform3(panelObj.Get("pose").As<Napi::Object>());
    Napi::Array edgeBendIdArr = panelObj.Get("edgeBendId").As<Napi::Array>();
    for (uint32_t j = 0; j < edgeBendIdArr.Length(); ++j) {
      panel.edgeBendId.push_back(edgeBendIdArr.Get(j).As<Napi::String>().Utf8Value());
    }
    // Phase 5 Slice 9a: this is the exact round trip ConstructPartSolid relies
    // on (evaluatePartGraph's JS result is passed straight back in as
    // constructPartSolid's own input) — omitting these here would silently
    // drop every hole RegionOf already correctly computed, producing a solid
    // that disagrees with its own flat pattern (constitution P3/L1). Default
    // empty if absent, for the same pre-Slice-9a backward-compatibility
    // reason as ReadPartGraphSpec above.
    Napi::Value regionPolygonHolesV = panelObj.Get("regionPolygonHoles");
    if (regionPolygonHolesV.IsArray()) {
      Napi::Array holesArr = regionPolygonHolesV.As<Napi::Array>();
      for (uint32_t j = 0; j < holesArr.Length(); ++j) {
        panel.regionPolygonHoles.push_back(ReadPoint2Array(holesArr.Get(j).As<Napi::Array>()));
      }
    }
    Napi::Value regionCircleHolesV = panelObj.Get("regionCircleHoles");
    if (regionCircleHolesV.IsArray()) {
      Napi::Array circleArr = regionCircleHolesV.As<Napi::Array>();
      for (uint32_t j = 0; j < circleArr.Length(); ++j) {
        Napi::Object circleObj = circleArr.Get(j).As<Napi::Object>();
        CircleHoleSpec circle;
        circle.center = ReadPoint2(circleObj.Get("center").As<Napi::Object>());
        circle.radiusMm = circleObj.Get("radiusMm").As<Napi::Number>().DoubleValue();
        panel.regionCircleHoles.push_back(circle);
      }
    }
    result.panels.push_back(std::move(panel));
  }

  Napi::Array bridgesArr = obj.Get("bridges").As<Napi::Array>();
  for (uint32_t i = 0; i < bridgesArr.Length(); ++i) {
    Napi::Object bridgeObj = bridgesArr.Get(i).As<Napi::Object>();
    BridgeLayout bridge;
    bridge.bendId = bridgeObj.Get("bendId").As<Napi::String>().Utf8Value();
    bridge.parentRegionPanelId =
        bridgeObj.Get("parentRegionPanelId").As<Napi::String>().Utf8Value();
    bridge.childRegionPanelId =
        bridgeObj.Get("childRegionPanelId").As<Napi::String>().Utf8Value();
    bridge.pivotOriginWorld = ReadPoint3(bridgeObj.Get("pivotOriginWorld").As<Napi::Object>());
    bridge.pivotAxisWorld = ReadPoint3(bridgeObj.Get("pivotAxisWorld").As<Napi::Object>());
    bridge.angleDeg = bridgeObj.Get("angleDeg").As<Napi::Number>().DoubleValue();
    result.bridges.push_back(std::move(bridge));
  }

  return result;
}

Napi::Object WriteMapToWorldResult(Napi::Env env, const MapToWorldResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, MapErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("point3d", WritePoint3(env, result.point3d));
  obj.Set("regionPanelId", Napi::String::New(env, result.regionPanelId));
  obj.Set("bendId", Napi::String::New(env, result.bendId));
  return obj;
}

Napi::Object WriteMapToFlatResult(Napi::Env env, const MapToFlatResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, MapErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("point2d", WritePoint2(env, result.point2d));
  obj.Set("regionPanelId", Napi::String::New(env, result.regionPanelId));
  obj.Set("bendId", Napi::String::New(env, result.bendId));
  obj.Set("residualMm", Napi::Number::New(env, result.residualMm));
  return obj;
}

Napi::Object WriteReconcileOutlinesResult(Napi::Env env, const ReconcileOutlinesResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, MergeErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("combinedOutline", WritePoint2Array(env, result.combinedOutline));
  obj.Set("hingeA", WritePoint2(env, result.hingeA));
  obj.Set("hingeB", WritePoint2(env, result.hingeB));
  return obj;
}

// The exact inverse of ReadPartGraphSpec, field for field — the caller
// (import_part's TS orchestration) walks the returned bends and re-issues
// them through the ordinary create_node(bend)/GraphStore path (temp
// "piece{N}" ids remapped onto real UUIDs there); it never round-trips this
// object back through evaluatePartGraph directly using ITS OWN ids.
Napi::Object WriteBendSpec(Napi::Env env, const BendSpec& bend) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("id", Napi::String::New(env, bend.id));
  obj.Set("parentRegionPanelId", Napi::String::New(env, bend.parentRegionPanelId));
  obj.Set("childRegionPanelId", Napi::String::New(env, bend.childRegionPanelId));
  obj.Set("hingeA", WritePoint2(env, bend.hingeA));
  obj.Set("hingeB", WritePoint2(env, bend.hingeB));
  obj.Set("angleDeg", Napi::Number::New(env, bend.angleDeg));
  obj.Set("radiusMm", Napi::Number::New(env, bend.radiusMm));
  obj.Set("kFactor", Napi::Number::New(env, bend.kFactor));
  if (bend.bottomIsConcave.has_value()) {
    obj.Set("bottomIsConcave", Napi::Boolean::New(env, *bend.bottomIsConcave));
  }
  return obj;
}

Napi::Object WritePartGraphSpec(Napi::Env env, const PartGraphSpec& graph) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("partId", Napi::String::New(env, graph.partId));
  obj.Set("rootRegionPanelId", Napi::String::New(env, graph.rootRegionPanelId));
  Napi::Object outlineObj = Napi::Object::New(env);
  outlineObj.Set("outer", WritePoint2Array(env, graph.outline.outer));
  obj.Set("outline", outlineObj);
  Napi::Array bendsArr = Napi::Array::New(env, graph.bends.size());
  for (size_t i = 0; i < graph.bends.size(); ++i) bendsArr.Set(i, WriteBendSpec(env, graph.bends[i]));
  obj.Set("bends", bendsArr);
  obj.Set("thicknessMm", Napi::Number::New(env, graph.thicknessMm));
  Napi::Object anchorObj = Napi::Object::New(env);
  anchorObj.Set("transform", WriteTransform3(env, graph.anchor.transform));
  obj.Set("anchor", anchorObj);
  return obj;
}

Napi::Object WriteReconcilePiecesResult(Napi::Env env, const ReconcilePiecesResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, ReconcileErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("graph", WritePartGraphSpec(env, result.graph));
  Napi::Array graphsArr = Napi::Array::New(env, result.graphs.size());
  for (size_t i = 0; i < result.graphs.size(); ++i) {
    graphsArr.Set(static_cast<uint32_t>(i), WritePartGraphSpec(env, result.graphs[i]));
  }
  obj.Set("graphs", graphsArr);
  obj.Set("notes", WriteStringArray(env, result.notes));
  Napi::Array matchesArr = Napi::Array::New(env, result.pieceEdgeMatches.size());
  for (size_t i = 0; i < result.pieceEdgeMatches.size(); ++i) {
    Napi::Object m = Napi::Object::New(env);
    m.Set("parentEdgeIndex", Napi::Number::New(env, result.pieceEdgeMatches[i].parentEdgeIndex));
    m.Set("childEdgeIndex", Napi::Number::New(env, result.pieceEdgeMatches[i].childEdgeIndex));
    matchesArr.Set(static_cast<uint32_t>(i), m);
  }
  obj.Set("pieceEdgeMatches", matchesArr);
  return obj;
}

}  // namespace

// ─── NAPI method implementations ─────────────────────────────────────────────

Napi::Value EvaluatePartGraph(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "evaluatePartGraph(graph: PartGraphSpec)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    PartGraphSpec graph = ReadPartGraphSpec(info[0].As<Napi::Object>());
    EvaluateResult result = translation::Evaluate(graph);
    return WriteEvaluateResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value ConstructPartSolidBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "constructPartSolid(layout: EvaluateResult, thicknessMm: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    EvaluateResult layout = ReadEvaluateResult(info[0].As<Napi::Object>());
    double thicknessMm = info[1].As<Napi::Number>().DoubleValue();

    ConstructPartSolidResultDTO result = svc().constructPartSolid(layout, thicknessMm);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("ok", Napi::Boolean::New(env, result.ok));
    obj.Set("shellId", Napi::String::New(env, result.shellId));
    obj.Set("errorCode", Napi::String::New(env, result.errorCode));
    obj.Set("message", Napi::String::New(env, result.message));
    return obj;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value MapPointToWorldBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsObject() || !info[2].IsObject()) {
    Napi::TypeError::New(
        env, "mapPointToWorld(graph: PartGraphSpec, layout: EvaluateResult, "
             "point2d: {x,y}, zMm?: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    PartGraphSpec graph = ReadPartGraphSpec(info[0].As<Napi::Object>());
    EvaluateResult layout = ReadEvaluateResult(info[1].As<Napi::Object>());
    Point2 point2d = ReadPoint2(info[2].As<Napi::Object>());
    double zMm = (info.Length() >= 4 && info[3].IsNumber()) ? info[3].As<Napi::Number>().DoubleValue() : 0.0;

    MapToWorldResult result = translation::MapPointToWorld(graph, layout, point2d, zMm);
    return WriteMapToWorldResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value MapPointToFlatBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsObject() || !info[2].IsObject()) {
    Napi::TypeError::New(
        env, "mapPointToFlat(graph: PartGraphSpec, layout: EvaluateResult, point3d: {x,y,z})")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    PartGraphSpec graph = ReadPartGraphSpec(info[0].As<Napi::Object>());
    EvaluateResult layout = ReadEvaluateResult(info[1].As<Napi::Object>());
    Point3 point3d = ReadPoint3(info[2].As<Napi::Object>());

    MapToFlatResult result = translation::MapPointToFlat(graph, layout, point3d);
    return WriteMapToFlatResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value ReconcileOutlinesBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6 || !info[0].IsArray() || !info[1].IsObject() || !info[2].IsObject() ||
      !info[3].IsArray() || !info[4].IsObject() || !info[5].IsObject()) {
    Napi::TypeError::New(
        env, "reconcileOutlines(outlineA: {x,y}[], edgeA0: {x,y}, edgeA1: {x,y}, "
             "outlineB: {x,y}[], edgeB0: {x,y}, edgeB1: {x,y})")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> outlineA = ReadPoint2Array(info[0].As<Napi::Array>());
    Point2 edgeA0 = ReadPoint2(info[1].As<Napi::Object>());
    Point2 edgeA1 = ReadPoint2(info[2].As<Napi::Object>());
    std::vector<Point2> outlineB = ReadPoint2Array(info[3].As<Napi::Array>());
    Point2 edgeB0 = ReadPoint2(info[4].As<Napi::Object>());
    Point2 edgeB1 = ReadPoint2(info[5].As<Napi::Object>());

    ReconcileOutlinesResult result =
        translation::ReconcileOutlines(outlineA, edgeA0, edgeA1, outlineB, edgeB0, edgeB1);
    return WriteReconcileOutlinesResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Object WritePolygonBooleanResult(Napi::Env env, const PolygonBooleanResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, PolygonBooleanErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("outer", WritePoint2Array(env, result.outer));
  return obj;
}

Napi::Value PolygonUnionBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "polygonUnion(ringA: Point2[], ringB: Point2[])")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> ringA = ReadPoint2Array(info[0].As<Napi::Array>());
    std::vector<Point2> ringB = ReadPoint2Array(info[1].As<Napi::Array>());
    PolygonBooleanResult result = translation::PolygonUnion(ringA, ringB);
    return WritePolygonBooleanResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value PolygonDifferenceBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "polygonDifference(ringA: Point2[], ringB: Point2[])")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> ringA = ReadPoint2Array(info[0].As<Napi::Array>());
    std::vector<Point2> ringB = ReadPoint2Array(info[1].As<Napi::Array>());
    PolygonBooleanResult result = translation::PolygonDifference(ringA, ringB);
    return WritePolygonBooleanResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value FuseCoplanarPartsBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsObject() || !info[2].IsArray() ||
      !info[3].IsObject()) {
    Napi::TypeError::New(
        env, "fuseCoplanarParts(outlineA: Point2[], anchorA: Transform3, outlineB: "
             "Point2[], anchorB: Transform3)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> outlineA = ReadPoint2Array(info[0].As<Napi::Array>());
    Transform3 anchorA = ReadTransform3(info[1].As<Napi::Object>());
    std::vector<Point2> outlineB = ReadPoint2Array(info[2].As<Napi::Array>());
    Transform3 anchorB = ReadTransform3(info[3].As<Napi::Object>());
    PolygonBooleanResult result =
        translation::FuseCoplanarParts(outlineA, anchorA, outlineB, anchorB);
    return WritePolygonBooleanResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Object WriteCutPanelResult(Napi::Env env, const CutPanelResult& result) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, result.ok));
  obj.Set("errorCode", Napi::String::New(env, CutPanelErrorCodeToString(result.errorCode)));
  obj.Set("message", Napi::String::New(env, result.message));
  obj.Set("canonicalRing", WritePoint2Array(env, result.canonicalRing));
  obj.Set("regionIndex", Napi::Number::New(env, result.regionIndex));
  return obj;
}

std::vector<std::vector<Point2>> ReadPoint2ArrayArray(const Napi::Array& arr) {
  std::vector<std::vector<Point2>> rings;
  rings.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    rings.push_back(ReadPoint2Array(arr.Get(i).As<Napi::Array>()));
  }
  return rings;
}

Napi::Value PrepareCircleCutBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsNumber() || !info[2].IsArray()) {
    Napi::TypeError::New(
        env, "prepareCircleCut(center: Point2, radiusMm: number, candidateRegions: Point2[][])")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    Point2 center = ReadPoint2(info[0].As<Napi::Object>());
    double radiusMm = info[1].As<Napi::Number>().DoubleValue();
    std::vector<std::vector<Point2>> candidateRegions =
        ReadPoint2ArrayArray(info[2].As<Napi::Array>());
    CutPanelResult result = translation::PrepareCircleCut(center, radiusMm, candidateRegions);
    return WriteCutPanelResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value PreparePolygonCutBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsArray()) {
    Napi::TypeError::New(env, "preparePolygonCut(ring: Point2[], candidateRegions: Point2[][])")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> ring = ReadPoint2Array(info[0].As<Napi::Array>());
    std::vector<std::vector<Point2>> candidateRegions =
        ReadPoint2ArrayArray(info[1].As<Napi::Array>());
    CutPanelResult result = translation::PreparePolygonCut(ring, candidateRegions);
    return WriteCutPanelResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Napi::Value ReconcilePiecesBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsArray() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "reconcilePieces(pieces: PanelPieceSpec[], thicknessMm: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<PanelPieceSpec> pieces = ReadPanelPieceSpecArray(info[0].As<Napi::Array>());
    double thicknessMm = info[1].As<Napi::Number>().DoubleValue();

    ReconcilePiecesResult result = translation::ReconcilePieces(pieces, thicknessMm);
    return WriteReconcilePiecesResult(env, result);
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── evaluateFindings ───────────────────────────────────────────────────────

namespace {

validation::ManufacturingProfile ReadProfile(const Napi::Object& obj) {
  validation::ManufacturingProfile profile;
  // profileId and name are optional — defaults are fine
  Napi::Value idV = obj.Get("profileId");
  if (idV.IsString()) profile.profileId = idV.As<Napi::String>().Utf8Value();
  Napi::Value nameV = obj.Get("name");
  if (nameV.IsString()) profile.name = nameV.As<Napi::String>().Utf8Value();

  Napi::Value rulesV = obj.Get("rules");
  if (rulesV.IsObject()) {
    Napi::Object rules = rulesV.As<Napi::Object>();
    auto readD = [&](const char* key, double& out) {
      Napi::Value v = rules.Get(key);
      if (v.IsNumber()) out = v.As<Napi::Number>().DoubleValue();
    };
    readD("minBendRadiusFactor", profile.minBendRadiusFactor);
    readD("maxBendAngleDeg", profile.maxBendAngleDeg);
    readD("minHoleDiameterFactor", profile.minHoleDiameterFactor);
    readD("minHoleToBendClearanceMm", profile.minHoleToBendClearanceMm);
    readD("minHoleToEdgeClearanceMm", profile.minHoleToEdgeClearanceMm);
    readD("minHoleToHoleDistanceMm", profile.minHoleToHoleDistanceMm);
    readD("minFlangeWidthFactor", profile.minFlangeWidthFactor);
  }
  return profile;
}

const char* SeverityToString(validation::FindingSeverity severity) {
  switch (severity) {
    case validation::FindingSeverity::kError: return "error";
    case validation::FindingSeverity::kWarning: return "warning";
    case validation::FindingSeverity::kInfo: return "info";
  }
  return "error";
}

Napi::Object WriteFinding(Napi::Env env, const validation::Finding& f) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("code", Napi::String::New(env, f.code));
  obj.Set("severity", Napi::String::New(env, SeverityToString(f.severity)));
  obj.Set("message", Napi::String::New(env, f.message));

  Napi::Array anchorsArr = Napi::Array::New(env, f.anchors.size());
  for (size_t i = 0; i < f.anchors.size(); ++i) {
    Napi::Object anchorObj = Napi::Object::New(env);
    anchorObj.Set("kind", Napi::String::New(env, f.anchors[i].kind));
    anchorObj.Set("id", Napi::String::New(env, f.anchors[i].id));
    anchorsArr.Set(i, anchorObj);
  }
  obj.Set("anchors", anchorsArr);

  if (f.recommendedFix.has_value()) {
    Napi::Object fixObj = Napi::Object::New(env);
    fixObj.Set("tool", Napi::String::New(env, f.recommendedFix->tool));
    // paramsJson is a JSON string — parse on the TS side
    fixObj.Set("params", Napi::String::New(env, f.recommendedFix->paramsJson));
    obj.Set("recommendedFix", fixObj);
  } else {
    obj.Set("recommendedFix", env.Null());
  }

  return obj;
}

}  // namespace

Napi::Value EvaluateFindingsBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsObject()) {
    Napi::TypeError::New(
        env, "evaluateFindings(graph: PartGraphSpec, profile: ManufacturingProfile, "
             "layout?: EvaluateResult | null)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    PartGraphSpec graph = ReadPartGraphSpec(info[0].As<Napi::Object>());
    auto profile = ReadProfile(info[1].As<Napi::Object>());

    // layout is optional (3rd arg) — null means geometry-dependent rules skip
    const EvaluateResult* layoutPtr = nullptr;
    EvaluateResult layoutCopy;
    if (info.Length() >= 3 && !info[2].IsNull() && !info[2].IsUndefined()) {
      layoutCopy = ReadEvaluateResult(info[2].As<Napi::Object>());
      layoutPtr = &layoutCopy;
    }

    auto findings = validation::EvaluateFindings(graph, layoutPtr, profile);

    Napi::Object result = Napi::Object::New(env);
    Napi::Array findingsArr = Napi::Array::New(env, findings.size());
    for (size_t i = 0; i < findings.size(); ++i) {
      findingsArr.Set(i, WriteFinding(env, findings[i]));
    }
    result.Set("findings", findingsArr);
    return result;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── computeCloseGapDelta ────────────────────────────────────────────────────

Napi::Value ComputeCloseGapDeltaBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsArray() || !info[2].IsObject()) {
    Napi::TypeError::New(env, "computeCloseGapDelta(edgeA3d: Point3[], edgeB3d: Point3[], "
                             "panelBPose: Transform3)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point3> edgeA = ReadPoint3Array(info[0].As<Napi::Array>());
    std::vector<Point3> edgeB = ReadPoint3Array(info[1].As<Napi::Array>());
    Transform3 pose = ReadTransform3(info[2].As<Napi::Object>());

    auto result = translation::ComputeCloseGapDelta(edgeA, edgeB, pose);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("deltaX", Napi::Number::New(env, result.deltaX));
    obj.Set("deltaY", Napi::Number::New(env, result.deltaY));
    obj.Set("gapMm", Napi::Number::New(env, result.gapMm));
    return obj;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── computeFlangeOutline ────────────────────────────────────────────────────

Napi::Value ComputeFlangeOutlineBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "computeFlangeOutline(outline: Point2[], edgeIndex: number, "
                             "flangeLengthMm: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<Point2> outline = ReadPoint2Array(info[0].As<Napi::Array>());
    int edgeIndex = info[1].As<Napi::Number>().Int32Value();
    double flangeLengthMm = info[2].As<Napi::Number>().DoubleValue();

    auto result = translation::ComputeFlangeOutline(outline, edgeIndex, flangeLengthMm);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("newOutline", WritePoint2Array(env, result.newOutline));
    obj.Set("hingeA", WritePoint2(env, result.hingeA));
    obj.Set("hingeB", WritePoint2(env, result.hingeB));
    return obj;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── computeRipEdge ──────────────────────────────────────────────────────────

Napi::Value ComputeRipEdgeBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "computeRipEdge(outline: Point2[], edgeIndex: number, gapMm: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    auto outline = ReadPoint2Array(info[0].As<Napi::Array>());
    int edgeIndex = info[1].As<Napi::Number>().Int32Value();
    double gapMm = info[2].As<Napi::Number>().DoubleValue();
    auto result = translation::ComputeRipEdge(outline, edgeIndex, gapMm);
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("newOutline", WritePoint2Array(env, result.newOutline));
    return obj;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── computeReliefPolygons ───────────────────────────────────────────────────

Napi::Value ComputeReliefPolygonsBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsString() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(env, "computeReliefPolygons(bends: BendSpec[], reliefType: string, "
                             "radiusMm: number, thicknessMm: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    std::vector<BendSpec> bends;
    Napi::Array bendsArr = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < bendsArr.Length(); ++i) {
      Napi::Object bendObj = bendsArr.Get(i).As<Napi::Object>();
      BendSpec b;
      b.id = bendObj.Get("id").As<Napi::String>().Utf8Value();
      b.parentRegionPanelId = bendObj.Get("parentRegionPanelId").As<Napi::String>().Utf8Value();
      b.childRegionPanelId = bendObj.Get("childRegionPanelId").As<Napi::String>().Utf8Value();
      b.hingeA = ReadPoint2(bendObj.Get("hingeA").As<Napi::Object>());
      b.hingeB = ReadPoint2(bendObj.Get("hingeB").As<Napi::Object>());
      bends.push_back(b);
    }
    std::string reliefType = info[1].As<Napi::String>().Utf8Value();
    double radiusMm = info[2].As<Napi::Number>().DoubleValue();
    double thicknessMm = info[3].As<Napi::Number>().DoubleValue();

    auto results = translation::ComputeReliefPolygons(bends, reliefType, radiusMm, thicknessMm);

    Napi::Array arr = Napi::Array::New(env, results.size());
    for (size_t i = 0; i < results.size(); ++i) {
      arr.Set(i, WritePoint2Array(env, results[i].polygon));
    }
    return arr;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// ─── computeSplitByPlane ─────────────────────────────────────────────────────

Napi::Value ComputeSplitByPlaneBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 || !info[0].IsObject() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber() || !info[4].IsNumber()) {
    Napi::TypeError::New(env, "computeSplitByPlane(layout: EvaluateResult, "
                             "nx: number, ny: number, nz: number, d: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  try {
    EvaluateResult layout = ReadEvaluateResult(info[0].As<Napi::Object>());
    double nx = info[1].As<Napi::Number>().DoubleValue();
    double ny = info[2].As<Napi::Number>().DoubleValue();
    double nz = info[3].As<Napi::Number>().DoubleValue();
    double d = info[4].As<Napi::Number>().DoubleValue();

    auto result = translation::ComputeSplitByPlane(layout, nx, ny, nz, d);

    Napi::Array arr = Napi::Array::New(env, result.fragments.size());
    for (size_t i = 0; i < result.fragments.size(); ++i) {
      Napi::Object frag = Napi::Object::New(env);
      frag.Set("regionPanelId", Napi::String::New(env, result.fragments[i].regionPanelId));
      frag.Set("positiveSide", Napi::Boolean::New(env, result.fragments[i].positiveSide));
      frag.Set("polygon", WritePoint2Array(env, result.fragments[i].polygon));
      arr.Set(i, frag);
    }
    return arr;
  } catch (const std::exception& e) {
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

void RegisterTranslationMethods(Napi::Env env, Napi::Object exports) {
  exports.Set("evaluatePartGraph", Napi::Function::New(env, EvaluatePartGraph));
  exports.Set("constructPartSolid", Napi::Function::New(env, ConstructPartSolidBinding));
  exports.Set("mapPointToWorld", Napi::Function::New(env, MapPointToWorldBinding));
  exports.Set("mapPointToFlat", Napi::Function::New(env, MapPointToFlatBinding));
  exports.Set("reconcileOutlines", Napi::Function::New(env, ReconcileOutlinesBinding));
  exports.Set("reconcilePieces", Napi::Function::New(env, ReconcilePiecesBinding));
  exports.Set("polygonUnion", Napi::Function::New(env, PolygonUnionBinding));
  exports.Set("polygonDifference", Napi::Function::New(env, PolygonDifferenceBinding));
  exports.Set("fuseCoplanarParts", Napi::Function::New(env, FuseCoplanarPartsBinding));
  exports.Set("prepareCircleCut", Napi::Function::New(env, PrepareCircleCutBinding));
  exports.Set("preparePolygonCut", Napi::Function::New(env, PreparePolygonCutBinding));
  exports.Set("evaluateFindings", Napi::Function::New(env, EvaluateFindingsBinding));
  exports.Set("computeCloseGapDelta", Napi::Function::New(env, ComputeCloseGapDeltaBinding));
  exports.Set("computeFlangeOutline", Napi::Function::New(env, ComputeFlangeOutlineBinding));
  exports.Set("computeRipEdge", Napi::Function::New(env, ComputeRipEdgeBinding));
  exports.Set("computeReliefPolygons", Napi::Function::New(env, ComputeReliefPolygonsBinding));
  exports.Set("computeSplitByPlane", Napi::Function::New(env, ComputeSplitByPlaneBinding));
}

}  // namespace mcp_cad
