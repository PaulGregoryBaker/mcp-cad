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

Napi::Object WriteRegionPanelLayout(Napi::Env env, const RegionPanelLayout& panel) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("regionPanelId", Napi::String::New(env, panel.regionPanelId));
  obj.Set("regionOuter", WritePoint2Array(env, panel.regionOuter));
  obj.Set("bottomFace", WritePoint3Array(env, panel.bottomFace));
  obj.Set("topFace", WritePoint3Array(env, panel.topFace));
  obj.Set("pose", WriteTransform3(env, panel.pose));
  obj.Set("edgeBendId", WriteStringArray(env, panel.edgeBendId));
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

void RegisterTranslationMethods(Napi::Env env, Napi::Object exports) {
  exports.Set("evaluatePartGraph", Napi::Function::New(env, EvaluatePartGraph));
  exports.Set("constructPartSolid", Napi::Function::New(env, ConstructPartSolidBinding));
  exports.Set("mapPointToWorld", Napi::Function::New(env, MapPointToWorldBinding));
  exports.Set("mapPointToFlat", Napi::Function::New(env, MapPointToFlatBinding));
  exports.Set("reconcileOutlines", Napi::Function::New(env, ReconcileOutlinesBinding));
  exports.Set("reconcilePieces", Napi::Function::New(env, ReconcilePiecesBinding));
}

}  // namespace mcp_cad
