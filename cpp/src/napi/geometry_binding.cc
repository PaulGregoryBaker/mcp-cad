/**
 * NAPI geometry binding — TypeScript ↔ C++ serialization.
 * Implements all geometry operations as NAPI methods.
 *
 * Task: T043
 */

#include <napi.h>
#include "../geometry/geometry_service.hpp"

#include <memory>
#include <string>
#include <vector>
#include <sstream>

namespace mcp_cad {

// Forward declarations
static const char* surfaceTypeToString(SurfaceType t);
static const char* curveTypeToString(CurveType t);
static const char* manifoldIssueTypeToString(ManifoldIssue::Type t);

// ─── Global geometry service instance ────────────────────────────────────────
// Single-session: one service instance per Node.js process (Constitution VII).

static std::unique_ptr<GeometryService> g_service;

static GeometryService& svc() {
  if (!g_service) {
    g_service = GeometryService::create();
  }
  return *g_service;
}

// ─── Error conversion helpers ─────────────────────────────────────────────────

static Napi::Error makeNapiError(Napi::Env env, const GeometryError& e) {
  std::ostringstream oss;
  oss << "{\"code\":\"" << e.code << "\",\"message\":\""
      << e.what() << "\",\"recoverable\":"
      << (e.recoverable ? "true" : "false");
  if (!e.suggestedTool.empty()) {
    oss << ",\"suggestedTool\":\"" << e.suggestedTool << "\"";
  }
  oss << "}";

  Napi::Error err = Napi::Error::New(env, oss.str());
  err.Value().Set("code", Napi::String::New(env, e.code));
  return err;
}

#define TRY_GEOMETRY(env, body)             \
  try {                                     \
    body                                    \
  } catch (const GeometryError& e) {        \
    makeNapiError(env, e).ThrowAsJavaScriptException(); \
    return env.Undefined();                 \
  } catch (const std::exception& e) {       \
    Napi::Error::New(env, e.what()).ThrowAsJavaScriptException(); \
    return env.Undefined();                 \
  }

// ─── NAPI method implementations ─────────────────────────────────────────────

Napi::Value LoadStep(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "loadStep(filePath: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string filePath = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    std::string id = svc().loadStep(filePath);
    return Napi::String::New(env, id);
  })
  return env.Undefined();
}

Napi::Value GetTopology(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "getTopology(solidId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    TopologyGraph graph = svc().getTopology(solidId);

    Napi::Object result = Napi::Object::New(env);
    result.Set("solidId", Napi::String::New(env, graph.solidId));

    // Build faces array
    Napi::Array faces = Napi::Array::New(env, graph.faces.size());
    for (size_t i = 0; i < graph.faces.size(); ++i) {
      const auto& f = graph.faces[i];
      Napi::Object face = Napi::Object::New(env);
      face.Set("faceId", Napi::String::New(env, f.faceId));
      face.Set("surfaceType", Napi::String::New(env, surfaceTypeToString(f.surfaceType)));
      face.Set("areaMm2", Napi::Number::New(env, f.areaMm2));
      face.Set("normalX", Napi::Number::New(env, f.normalX));
      face.Set("normalY", Napi::Number::New(env, f.normalY));
      face.Set("normalZ", Napi::Number::New(env, f.normalZ));
      faces.Set(i, face);
    }
    result.Set("faces", faces);

    // Build edges array
    Napi::Array edges = Napi::Array::New(env, graph.edges.size());
    for (size_t i = 0; i < graph.edges.size(); ++i) {
      const auto& e = graph.edges[i];
      Napi::Object edge = Napi::Object::New(env);
      edge.Set("edgeId", Napi::String::New(env, e.edgeId));
      edge.Set("curveType", Napi::String::New(env, curveTypeToString(e.curveType)));
      edge.Set("lengthMm", Napi::Number::New(env, e.lengthMm));
      edges.Set(i, edge);
    }
    result.Set("edges", edges);

    // Build adjacency array
    Napi::Array adj = Napi::Array::New(env, graph.adjacency.size());
    for (size_t i = 0; i < graph.adjacency.size(); ++i) {
      const auto& a = graph.adjacency[i];
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("faceIdA", Napi::String::New(env, a.faceIdA));
      entry.Set("faceIdB", Napi::String::New(env, a.faceIdB));
      entry.Set("sharedEdgeId", Napi::String::New(env, a.sharedEdgeId));
      entry.Set("dihedralAngleDeg", Napi::Number::New(env, a.dihedralAngleDeg));
      adj.Set(i, entry);
    }
    result.Set("adjacency", adj);

    return result;
  })
  return env.Undefined();
}

Napi::Value CheckManifold(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "checkManifold(solidId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    ManifoldResult mr = svc().checkManifold(solidId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("isManifold", Napi::Boolean::New(env, mr.isManifold));
    Napi::Array issues = Napi::Array::New(env, mr.issues.size());
    for (size_t i = 0; i < mr.issues.size(); ++i) {
      Napi::Object issue = Napi::Object::New(env);
      issue.Set("type", Napi::String::New(env, manifoldIssueTypeToString(mr.issues[i].type)));
      issue.Set("faceId", Napi::String::New(env, mr.issues[i].faceId));
      issue.Set("description", Napi::String::New(env, mr.issues[i].description));
      issues.Set(i, issue);
    }
    result.Set("issues", issues);
    return result;
  })
  return env.Undefined();
}

Napi::Value HealGeometry(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "healGeometry(solidId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    std::string newId = svc().healGeometry(solidId);
    return Napi::String::New(env, newId);
  })
  return env.Undefined();
}

Napi::Value BooleanCut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "booleanCut(solidId, normal, origin)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  Napi::Object normal = info[1].As<Napi::Object>();
  Napi::Object origin = info[2].As<Napi::Object>();

  double nx = normal.Get("x").As<Napi::Number>().DoubleValue();
  double ny = normal.Get("y").As<Napi::Number>().DoubleValue();
  double nz = normal.Get("z").As<Napi::Number>().DoubleValue();
  double ox = origin.Get("x").As<Napi::Number>().DoubleValue();
  double oy = origin.Get("y").As<Napi::Number>().DoubleValue();
  double oz = origin.Get("z").As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    BooleanCutResult res = svc().booleanCut(solidId, nx, ny, nz, ox, oy, oz);
    Napi::Object result = Napi::Object::New(env);
    Napi::Array shells = Napi::Array::New(env, res.shellIds.size());
    for (size_t i = 0; i < res.shellIds.size(); ++i) {
      shells.Set(i, Napi::String::New(env, res.shellIds[i]));
    }
    result.Set("shellIds", shells);
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value SeparateSolids(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "separateSolids(solidId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    std::vector<ShellId> ids = svc().separateSolids(solidId);
    Napi::Array result = Napi::Array::New(env, ids.size());
    for (size_t i = 0; i < ids.size(); ++i) {
      result.Set(i, Napi::String::New(env, ids[i]));
    }
    return result;
  })
  return env.Undefined();
}

Napi::Value AddTabSlot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "addTabSlot(shellIdA, shellIdB, kerfMm)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string shellIdA   = info[0].As<Napi::String>().Utf8Value();
  std::string shellIdB   = info[1].As<Napi::String>().Utf8Value();
  double      kerfOffset = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    TabSlotResult res = svc().addTabSlot(shellIdA, shellIdB, kerfOffset);
    Napi::Object result = Napi::Object::New(env);
    Napi::Array shells = Napi::Array::New(env, res.modifiedShellIds.size());
    for (size_t i = 0; i < res.modifiedShellIds.size(); ++i) {
      shells.Set(i, Napi::String::New(env, res.modifiedShellIds[i]));
    }
    result.Set("modifiedShellIds", shells);
    result.Set("kerfOffsetApplied", Napi::Number::New(env, res.kerfOffsetApplied));
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value AddRivetHole(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "addRivetHole(shellId, faceId, cx, cy, diam)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string shellId    = info[0].As<Napi::String>().Utf8Value();
  std::string faceId     = info[1].As<Napi::String>().Utf8Value();
  double      cx         = info[2].As<Napi::Number>().DoubleValue();
  double      cy         = info[3].As<Napi::Number>().DoubleValue();
  double      diameterMm = info[4].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    RivetHoleResult res = svc().addRivetHole(shellId, faceId, cx, cy, diameterMm);
    Napi::Object result = Napi::Object::New(env);
    result.Set("modifiedShellId",  Napi::String::New(env, res.modifiedShellId));
    result.Set("holeFeatureId",    Napi::String::New(env, res.holeFeatureId));
    result.Set("rollbackToken",    Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value UnfoldShell(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "unfoldShell(shellId, kFactor)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string shellId = info[0].As<Napi::String>().Utf8Value();
  double      kFactor = info[1].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    UnfoldResult res = svc().unfoldShell(shellId, kFactor);
    Napi::Object result = Napi::Object::New(env);
    result.Set("unfoldId",     Napi::String::New(env, res.unfoldId));
    result.Set("flatWidthMm",  Napi::Number::New(env, res.flatWidthMm));
    result.Set("flatHeightMm", Napi::Number::New(env, res.flatHeightMm));
    result.Set("kFactorUsed",  Napi::Number::New(env, res.kFactorUsed));
    result.Set("bendCount",    Napi::Number::New(env, res.bendCount));
    result.Set("validated",    Napi::Boolean::New(env, res.validated));
    result.Set("detectedThickness", Napi::Number::New(env, res.detectedThickness));
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    result.Set("improvedPartId", Napi::String::New(env, res.improvedPartId));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value ExportDxf(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "exportDxf(unfoldId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string unfoldId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    DxfExportResult res = svc().exportDxf(unfoldId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("dxfContent",   Napi::String::New(env, res.dxfContent));
    result.Set("wireCount",    Napi::Number::New(env, res.wireCount));
    result.Set("bboxWidthMm",  Napi::Number::New(env, res.bboxWidthMm));
    result.Set("bboxHeightMm", Napi::Number::New(env, res.bboxHeightMm));
    return result;
  })
  return env.Undefined();
}

Napi::Value ExportGlb(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "exportGlb(shellId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string shellId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    std::vector<uint8_t> glbData = svc().exportGlb(shellId);
    return Napi::Buffer<uint8_t>::Copy(env, glbData.data(), glbData.size());
  })
  return env.Undefined();
}

Napi::Value NestShells(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "nestShells(unfoldIds[], sheetW, sheetH)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Array unfoldArr = info[0].As<Napi::Array>();
  std::vector<std::string> unfoldIds;
  unfoldIds.reserve(unfoldArr.Length());
  for (uint32_t i = 0; i < unfoldArr.Length(); ++i) {
    unfoldIds.push_back(unfoldArr.Get(i).As<Napi::String>().Utf8Value());
  }

  double sheetW = info[1].As<Napi::Number>().DoubleValue();
  double sheetH = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    NestResult res = svc().nestShells(unfoldIds, sheetW, sheetH);
    Napi::Object result = Napi::Object::New(env);
    result.Set("nestId",         Napi::String::New(env, res.nestId));
    result.Set("utilisationPct", Napi::Number::New(env, res.utilisationPct));
    result.Set("sheetsRequired", Napi::Number::New(env, res.sheetsRequired));

    Napi::Array placements = Napi::Array::New(env, res.placements.size());
    for (size_t i = 0; i < res.placements.size(); ++i) {
      const auto& p = res.placements[i];
      Napi::Object placement = Napi::Object::New(env);
      placement.Set("unfoldId",    Napi::String::New(env, p.unfoldId));
      placement.Set("sheetIndex",  Napi::Number::New(env, p.sheetIndex));
      placement.Set("x",           Napi::Number::New(env, p.x));
      placement.Set("y",           Napi::Number::New(env, p.y));
      placement.Set("rotationDeg", Napi::Number::New(env, p.rotationDeg));
      placements.Set(i, placement);
    }
    result.Set("placements", placements);
    result.Set("svgPreview",  Napi::String::New(env, res.svgPreview));
    return result;
  })
  return env.Undefined();
}

Napi::Value CreateSnapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string label = info.Length() >= 1 && info[0].IsString()
                      ? info[0].As<Napi::String>().Utf8Value()
                      : "snapshot";
  TRY_GEOMETRY(env, {
    SnapshotId id = svc().createSnapshot(label);
    return Napi::String::New(env, id);
  })
  return env.Undefined();
}

Napi::Value RestoreSnapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "restoreSnapshot(snapshotId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string snapshotId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    RestoreResult res = svc().restoreSnapshot(snapshotId);
    Napi::Object result = Napi::Object::New(env);
    Napi::Array solids = Napi::Array::New(env, res.restoredSolidIds.size());
    for (size_t i = 0; i < res.restoredSolidIds.size(); ++i) {
      solids.Set(i, Napi::String::New(env, res.restoredSolidIds[i]));
    }
    result.Set("restoredSolidIds", solids);
    Napi::Array shells = Napi::Array::New(env, res.restoredShellIds.size());
    for (size_t i = 0; i < res.restoredShellIds.size(); ++i) {
      shells.Set(i, Napi::String::New(env, res.restoredShellIds[i]));
    }
    result.Set("restoredShellIds", shells);
    return result;
  })
  return env.Undefined();
}

Napi::Value ClearSnapshots(const Napi::CallbackInfo& info) {
  svc().clearSnapshots();
  return info.Env().Undefined();
}

// ─── Body topology ───────────────────────────────────────────────────────────

Napi::Value SplitBodyByPlane(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "splitBodyByPlane(partId, plane)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId    = info[0].As<Napi::String>().Utf8Value();
  Napi::Object planeObj = info[1].As<Napi::Object>();

  Napi::Object normalObj = planeObj.Get("normal").As<Napi::Object>();
  Napi::Object originObj = planeObj.Get("origin").As<Napi::Object>();
  CuttingPlane plane;
  plane.normalX = normalObj.Get("x").As<Napi::Number>().DoubleValue();
  plane.normalY = normalObj.Get("y").As<Napi::Number>().DoubleValue();
  plane.normalZ = normalObj.Get("z").As<Napi::Number>().DoubleValue();
  plane.originX = originObj.Get("x").As<Napi::Number>().DoubleValue();
  plane.originY = originObj.Get("y").As<Napi::Number>().DoubleValue();
  plane.originZ = originObj.Get("z").As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    SplitBodyResult res = svc().splitBodyByPlane(partId, plane);
    Napi::Object result = Napi::Object::New(env);
    result.Set("positiveShellId", Napi::String::New(env, res.positiveShellId));
    result.Set("negativeShellId", Napi::String::New(env, res.negativeShellId));
    result.Set("rollbackToken",   Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value MergeBodiesWithBend(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "mergeBodiesWithBend(partAId, partBId, targetEdges[], bendRadiusMm)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partAId       = info[0].As<Napi::String>().Utf8Value();
  std::string partBId       = info[1].As<Napi::String>().Utf8Value();
  Napi::Array edgesArr      = info[2].As<Napi::Array>();
  double      bendRadiusMm  = info[3].As<Napi::Number>().DoubleValue();

  std::vector<std::string> targetEdges;
  targetEdges.reserve(edgesArr.Length());
  for (uint32_t i = 0; i < edgesArr.Length(); ++i) {
    targetEdges.push_back(edgesArr.Get(i).As<Napi::String>().Utf8Value());
  }

  TRY_GEOMETRY(env, {
    MergeBodyResult res = svc().mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadiusMm);
    Napi::Object result = Napi::Object::New(env);
    result.Set("mergedShellId", Napi::String::New(env, res.mergedShellId));
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

// ─── Close gap ───────────────────────────────────────────────────────────────

Napi::Value CloseGap(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "closeGap(partAId, partBId)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partAId = info[0].As<Napi::String>();
  std::string partBId = info[1].As<Napi::String>();
  TRY_GEOMETRY(env, {
    CloseGapResult res = svc().closeGap(partAId, partBId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("partBId",       Napi::String::New(env, res.partBId));
    result.Set("gapClosedMm",   Napi::Number::New(env, res.gapClosedMm));
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    return result;
  })
  return env.Undefined();
}

// ─── Extended direct modeling ─────────────────────────────────────────────────

Napi::Value ExtendFaceToTarget(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6) {
    Napi::TypeError::New(env,
        "extendFaceToTarget(partId, faceId, targetType, targetPartId, targetFaceId, targetPlane)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId       = info[0].As<Napi::String>().Utf8Value();
  std::string faceId       = info[1].As<Napi::String>().Utf8Value();
  std::string targetType   = info[2].As<Napi::String>().Utf8Value();
  std::string targetPartId = info[3].As<Napi::String>().Utf8Value();
  std::string targetFaceId = info[4].As<Napi::String>().Utf8Value();
  Napi::Object planeObj    = info[5].As<Napi::Object>();

  CuttingPlane targetPlane;
  if (!planeObj.IsNull() && !planeObj.IsUndefined()) {
    Napi::Object nObj = planeObj.Get("normal").As<Napi::Object>();
    Napi::Object oObj = planeObj.Get("origin").As<Napi::Object>();
    targetPlane.normalX = nObj.Get("x").As<Napi::Number>().DoubleValue();
    targetPlane.normalY = nObj.Get("y").As<Napi::Number>().DoubleValue();
    targetPlane.normalZ = nObj.Get("z").As<Napi::Number>().DoubleValue();
    targetPlane.originX = oObj.Get("x").As<Napi::Number>().DoubleValue();
    targetPlane.originY = oObj.Get("y").As<Napi::Number>().DoubleValue();
    targetPlane.originZ = oObj.Get("z").As<Napi::Number>().DoubleValue();
  }

  TRY_GEOMETRY(env, {
    ExtendFaceResult res = svc().extendFaceToTarget(partId, faceId, targetType,
                                                     targetPartId, targetFaceId, targetPlane);
    Napi::Object result = Napi::Object::New(env);
    result.Set("modifiedShellId",     Napi::String::New(env, res.modifiedShellId));
    result.Set("extensionDistanceMm", Napi::Number::New(env, res.extensionDistanceMm));
    result.Set("rollbackToken",       Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value OffsetFace(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "offsetFace(partId, faceId, distanceMm)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId     = info[0].As<Napi::String>().Utf8Value();
  std::string faceId     = info[1].As<Napi::String>().Utf8Value();
  double      distanceMm = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    OffsetFaceResult res = svc().offsetFace(partId, faceId, distanceMm);
    Napi::Object result = Napi::Object::New(env);
    result.Set("modifiedShellId", Napi::String::New(env, res.modifiedShellId));
    result.Set("rollbackToken",   Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

// ─── Sheet metal detailing ────────────────────────────────────────────────────

Napi::Value AddFlange(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "addFlange(partId, edgeId, lengthMm, angleDeg, bendRadiusMm)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId       = info[0].As<Napi::String>().Utf8Value();
  std::string edgeId       = info[1].As<Napi::String>().Utf8Value();
  double      lengthMm     = info[2].As<Napi::Number>().DoubleValue();
  double      angleDeg     = info[3].As<Napi::Number>().DoubleValue();
  double      bendRadiusMm = info[4].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    AddFlangeResult res = svc().addFlange(partId, edgeId, lengthMm, angleDeg, bendRadiusMm);
    Napi::Object result = Napi::Object::New(env);
    result.Set("modifiedShellId",  Napi::String::New(env, res.modifiedShellId));
    result.Set("flangeFeatureId",  Napi::String::New(env, res.flangeFeatureId));
    result.Set("rollbackToken",    Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value RipEdge(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "ripEdge(partId, edgeId)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  std::string edgeId = info[1].As<Napi::String>().Utf8Value();

  TRY_GEOMETRY(env, {
    RipEdgeResult res = svc().ripEdge(partId, edgeId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("modifiedShellId", Napi::String::New(env, res.modifiedShellId));
    result.Set("rollbackToken",   Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

// ─── Clash and gap detection ─────────────────────────────────────────────────

Napi::Value ComputeIntersections(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "computeIntersections(partIds: string[])").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array arr = info[0].As<Napi::Array>();
  std::vector<ShellId> partIds;
  partIds.reserve(arr.Length());
  for (uint32_t i = 0; i < arr.Length(); ++i) {
    partIds.push_back(arr.Get(i).As<Napi::String>().Utf8Value());
  }
  TRY_GEOMETRY(env, {
    ClashReport report = svc().computeIntersections(partIds);
    Napi::Object result = Napi::Object::New(env);
    result.Set("intersects", Napi::Boolean::New(env, report.intersects));
    Napi::Array clashes = Napi::Array::New(env, report.clashes.size());
    for (size_t i = 0; i < report.clashes.size(); ++i) {
      const ClashPair& cp = report.clashes[i];
      Napi::Object clash = Napi::Object::New(env);
      clash.Set("partIdA", Napi::String::New(env, cp.partIdA));
      clash.Set("partIdB", Napi::String::New(env, cp.partIdB));
      clash.Set("intersectionVolumeMm3", Napi::Number::New(env, cp.intersectionVolumeMm3));

      Napi::Object bbox = Napi::Object::New(env);
      Napi::Object bboxOrigin = Napi::Object::New(env);
      bboxOrigin.Set("x", Napi::Number::New(env, cp.clashBoundingBox.ox));
      bboxOrigin.Set("y", Napi::Number::New(env, cp.clashBoundingBox.oy));
      bboxOrigin.Set("z", Napi::Number::New(env, cp.clashBoundingBox.oz));
      Napi::Object bboxDims = Napi::Object::New(env);
      bboxDims.Set("x", Napi::Number::New(env, cp.clashBoundingBox.dx));
      bboxDims.Set("y", Napi::Number::New(env, cp.clashBoundingBox.dy));
      bboxDims.Set("z", Napi::Number::New(env, cp.clashBoundingBox.dz));
      bbox.Set("origin", bboxOrigin);
      bbox.Set("dimensions", bboxDims);
      clash.Set("clashBoundingBox", bbox);

      Napi::Object plane = Napi::Object::New(env);
      Napi::Object planeNormal = Napi::Object::New(env);
      planeNormal.Set("x", Napi::Number::New(env, cp.suggestedCuttingPlane.normalX));
      planeNormal.Set("y", Napi::Number::New(env, cp.suggestedCuttingPlane.normalY));
      planeNormal.Set("z", Napi::Number::New(env, cp.suggestedCuttingPlane.normalZ));
      Napi::Object planeOrigin = Napi::Object::New(env);
      planeOrigin.Set("x", Napi::Number::New(env, cp.suggestedCuttingPlane.originX));
      planeOrigin.Set("y", Napi::Number::New(env, cp.suggestedCuttingPlane.originY));
      planeOrigin.Set("z", Napi::Number::New(env, cp.suggestedCuttingPlane.originZ));
      plane.Set("normal", planeNormal);
      plane.Set("origin", planeOrigin);
      clash.Set("suggestedCuttingPlane", plane);

      clashes.Set(static_cast<uint32_t>(i), clash);
    }
    result.Set("clashes", clashes);
    return result;
  })
  return env.Undefined();
}

Napi::Value ComputeGaps(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "computeGaps(partAId, partBId, maxDistanceMm)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partAId = info[0].As<Napi::String>().Utf8Value();
  std::string partBId = info[1].As<Napi::String>().Utf8Value();
  double maxDist      = info[2].As<Napi::Number>().DoubleValue();
  TRY_GEOMETRY(env, {
    GapReport report = svc().computeGaps(partAId, partBId, maxDist);
    Napi::Object result = Napi::Object::New(env);
    result.Set("hasGap", Napi::Boolean::New(env, report.hasGap));
    result.Set("minimumDistanceMm", Napi::Number::New(env, report.minimumDistanceMm));

    Napi::Object closest = Napi::Object::New(env);
    closest.Set("partAFaceId", Napi::String::New(env, report.partAFaceId));
    closest.Set("partBFaceId", Napi::String::New(env, report.partBFaceId));
    result.Set("closestElements", closest);

    Napi::Object extVec = Napi::Object::New(env);
    extVec.Set("x", Napi::Number::New(env, report.extensionVector.x));
    extVec.Set("y", Napi::Number::New(env, report.extensionVector.y));
    extVec.Set("z", Napi::Number::New(env, report.extensionVector.z));
    result.Set("extensionVector", extVec);

    Napi::Object bbox = Napi::Object::New(env);
    Napi::Object bboxOrigin = Napi::Object::New(env);
    bboxOrigin.Set("x", Napi::Number::New(env, report.gapBoundingBox.ox));
    bboxOrigin.Set("y", Napi::Number::New(env, report.gapBoundingBox.oy));
    bboxOrigin.Set("z", Napi::Number::New(env, report.gapBoundingBox.oz));
    Napi::Object bboxDims = Napi::Object::New(env);
    bboxDims.Set("x", Napi::Number::New(env, report.gapBoundingBox.dx));
    bboxDims.Set("y", Napi::Number::New(env, report.gapBoundingBox.dy));
    bboxDims.Set("z", Napi::Number::New(env, report.gapBoundingBox.dz));
    bbox.Set("origin", bboxOrigin);
    bbox.Set("dimensions", bboxDims);
    result.Set("gapBoundingBox", bbox);

    return result;
  })
  return env.Undefined();
}

Napi::Value TrimBodyWithPlane(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "trimBodyWithPlane(partId, plane, keepPositiveSide)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId      = info[0].As<Napi::String>().Utf8Value();
  Napi::Object planeObj   = info[1].As<Napi::Object>();
  bool keepPositiveSide   = info[2].As<Napi::Boolean>().Value();

  Napi::Object normalObj = planeObj.Get("normal").As<Napi::Object>();
  Napi::Object originObj = planeObj.Get("origin").As<Napi::Object>();

  CuttingPlane plane;
  plane.normalX = normalObj.Get("x").As<Napi::Number>().DoubleValue();
  plane.normalY = normalObj.Get("y").As<Napi::Number>().DoubleValue();
  plane.normalZ = normalObj.Get("z").As<Napi::Number>().DoubleValue();
  plane.originX = originObj.Get("x").As<Napi::Number>().DoubleValue();
  plane.originY = originObj.Get("y").As<Napi::Number>().DoubleValue();
  plane.originZ = originObj.Get("z").As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    TrimBodyResult res = svc().trimBodyWithPlane(partId, plane, keepPositiveSide);
    Napi::Object result = Napi::Object::New(env);
    result.Set("trimmedShellId", Napi::String::New(env, res.trimmedShellId));
    result.Set("rollbackToken",  Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value SplitBodyByBends(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "splitBodyByBends(partId, angleThresholdDeg?, maxThicknessMm?, defaultThicknessMm?, maxRecursionDepth?)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId            = info[0].As<Napi::String>().Utf8Value();
  double      angleThreshold    = 1.0;
  double      maxThicknessMm    = 5.0;
  double      defaultThicknessMm = 1.0;
  int         maxRecursionDepth  = 0;
  if (info.Length() >= 2 && info[1].IsNumber())
    angleThreshold = info[1].As<Napi::Number>().DoubleValue();
  if (info.Length() >= 3 && info[2].IsNumber())
    maxThicknessMm = info[2].As<Napi::Number>().DoubleValue();
  if (info.Length() >= 4 && info[3].IsNumber())
    defaultThicknessMm = info[3].As<Napi::Number>().DoubleValue();
  if (info.Length() >= 5 && info[4].IsNumber())
    maxRecursionDepth = static_cast<int>(info[4].As<Napi::Number>().Int32Value());

  TRY_GEOMETRY(env, {
    DecomposedByBendsResult res = svc().splitBodyByBends(
        partId, angleThreshold, maxThicknessMm, defaultThicknessMm, maxRecursionDepth);
    Napi::Object result = Napi::Object::New(env);

    Napi::Array panelArr = Napi::Array::New(env, res.panelIds.size());
    for (size_t i = 0; i < res.panelIds.size(); ++i)
      panelArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.panelIds[i]));

    Napi::Array protrusionArr = Napi::Array::New(env, res.protrusionIds.size());
    for (size_t i = 0; i < res.protrusionIds.size(); ++i)
      protrusionArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.protrusionIds[i]));

    Napi::Array parentArr = Napi::Array::New(env, res.protrusionParents.size());
    for (size_t i = 0; i < res.protrusionParents.size(); ++i) {
      Napi::Object pair = Napi::Object::New(env);
      pair.Set("protrusion_id", Napi::String::New(env, res.protrusionParents[i].protrusionId));
      const std::string& ppId = res.protrusionParents[i].parentPanelId;
      pair.Set("parent_panel_id", ppId.empty()
                                    ? env.Null()
                                    : Napi::Value(Napi::String::New(env, ppId)));
      parentArr.Set(static_cast<uint32_t>(i), pair);
    }

    auto serializeBboxes = [&](const std::vector<BBox3D>& bboxes) {
      Napi::Array arr = Napi::Array::New(env, bboxes.size());
      for (size_t i = 0; i < bboxes.size(); ++i) {
        Napi::Object b = Napi::Object::New(env);
        b.Set("x_min", Napi::Number::New(env, bboxes[i].xMin));
        b.Set("y_min", Napi::Number::New(env, bboxes[i].yMin));
        b.Set("z_min", Napi::Number::New(env, bboxes[i].zMin));
        b.Set("x_max", Napi::Number::New(env, bboxes[i].xMax));
        b.Set("y_max", Napi::Number::New(env, bboxes[i].yMax));
        b.Set("z_max", Napi::Number::New(env, bboxes[i].zMax));
        arr.Set(static_cast<uint32_t>(i), b);
      }
      return arr;
    };

    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }

    result.Set("panel_ids",           panelArr);
    result.Set("panel_bboxes",        serializeBboxes(res.panelBboxes));
    result.Set("protrusion_ids",      protrusionArr);
    result.Set("protrusion_bboxes",   serializeBboxes(res.protrusionBboxes));
    result.Set("protrusion_parents",  parentArr);
    result.Set("detected_mode",       Napi::String::New(env, res.detectedMode));
    result.Set("rollbackToken",       Napi::String::New(env, res.rollbackToken));
    result.Set("shape_history",       histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value RemoveProtrusions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "removeProtrusions(partId, angleThresholdDeg?, maxThicknessMm?)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId           = info[0].As<Napi::String>().Utf8Value();
  double      angleThresholdDeg = info.Length() >= 2 && info[1].IsNumber()
                                    ? info[1].As<Napi::Number>().DoubleValue() : 30.0;
  double      maxThicknessMm   = info.Length() >= 3 && info[2].IsNumber()
                                    ? info[2].As<Napi::Number>().DoubleValue() : 5.0;

  TRY_GEOMETRY(env, {
    RemoveProtrusionsResult res = svc().removeProtrusions(partId, angleThresholdDeg, maxThicknessMm);
    Napi::Object result = Napi::Object::New(env);

    Napi::Array protrusionArr = Napi::Array::New(env, res.protrusionIds.size());
    for (size_t i = 0; i < res.protrusionIds.size(); ++i)
      protrusionArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.protrusionIds[i]));

    Napi::Array bboxArr = Napi::Array::New(env, res.protrusionBboxes.size());
    for (size_t i = 0; i < res.protrusionBboxes.size(); ++i) {
      Napi::Object b = Napi::Object::New(env);
      b.Set("x_min", Napi::Number::New(env, res.protrusionBboxes[i].xMin));
      b.Set("y_min", Napi::Number::New(env, res.protrusionBboxes[i].yMin));
      b.Set("z_min", Napi::Number::New(env, res.protrusionBboxes[i].zMin));
      b.Set("x_max", Napi::Number::New(env, res.protrusionBboxes[i].xMax));
      b.Set("y_max", Napi::Number::New(env, res.protrusionBboxes[i].yMax));
      b.Set("z_max", Napi::Number::New(env, res.protrusionBboxes[i].zMax));
      bboxArr.Set(static_cast<uint32_t>(i), b);
    }

    result.Set("cleaned_part_id",    Napi::String::New(env, res.cleanedPartId));
    result.Set("protrusion_ids",     protrusionArr);
    result.Set("protrusion_bboxes",  bboxArr);
    result.Set("protrusion_count",   Napi::Number::New(env, static_cast<double>(res.protrusionIds.size())));
    result.Set("rollbackToken",      Napi::String::New(env, res.rollbackToken));
    return result;
  })
  return env.Undefined();
}

// ─── Enum string helpers ──────────────────────────────────────────────────────

static const char* surfaceTypeToString(SurfaceType t) {
  switch (t) {
    case SurfaceType::PLANE:    return "plane";
    case SurfaceType::CYLINDER: return "cylinder";
    case SurfaceType::CONE:     return "cone";
    case SurfaceType::SPHERE:   return "sphere";
    case SurfaceType::TORUS:    return "torus";
    case SurfaceType::BSPLINE:  return "bspline";
    default:                    return "other";
  }
}

static const char* curveTypeToString(CurveType t) {
  switch (t) {
    case CurveType::LINE:    return "line";
    case CurveType::CIRCLE:  return "circle";
    case CurveType::ELLIPSE: return "ellipse";
    case CurveType::BSPLINE: return "bspline";
    default:                 return "other";
  }
}

static const char* manifoldIssueTypeToString(ManifoldIssue::Type t) {
  switch (t) {
    case ManifoldIssue::Type::FREE_EDGE:         return "free_edge";
    case ManifoldIssue::Type::NON_MANIFOLD_EDGE: return "non_manifold_edge";
    case ManifoldIssue::Type::DEGENERATE_FACE:   return "degenerate_face";
    case ManifoldIssue::Type::SLIVER_FACE:       return "sliver_face";
    default:                                     return "unknown";
  }
}

// ─── Feature 006-geometry-primitives US2 (Interrogation) ────────────────────

Napi::Value ComputeBoundingBox(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "computeBoundingBox(entityId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string entityId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    BoundingBoxResult res = svc().computeBoundingBox(entityId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("x_min", Napi::Number::New(env, res.xMin));
    result.Set("y_min", Napi::Number::New(env, res.yMin));
    result.Set("z_min", Napi::Number::New(env, res.zMin));
    result.Set("x_max", Napi::Number::New(env, res.xMax));
    result.Set("y_max", Napi::Number::New(env, res.yMax));
    result.Set("z_max", Napi::Number::New(env, res.zMax));
    return result;
  })
  return env.Undefined();
}

Napi::Value ComputeMassProperties(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "computeMassProperties(entityId: string, properties?: string[])").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string entityId = info[0].As<Napi::String>().Utf8Value();
  std::vector<std::string> properties;
  if (info.Length() >= 2 && info[1].IsArray()) {
    Napi::Array propsArr = info[1].As<Napi::Array>();
    properties.reserve(propsArr.Length());
    for (uint32_t i = 0; i < propsArr.Length(); ++i) {
      properties.push_back(propsArr.Get(i).As<Napi::String>().Utf8Value());
    }
  }

  TRY_GEOMETRY(env, {
    MassPropertiesResult res = svc().computeMassProperties(entityId, properties);
    Napi::Object result = Napi::Object::New(env);
    if (res.volume.has_value()) {
      result.Set("volume", Napi::Number::New(env, *res.volume));
    }
    if (res.surfaceArea.has_value()) {
      result.Set("surface_area", Napi::Number::New(env, *res.surfaceArea));
    }
    if (res.centroid.has_value()) {
      Napi::Array centroidArr = Napi::Array::New(env, 3);
      centroidArr.Set(0u, Napi::Number::New(env, (*res.centroid)[0]));
      centroidArr.Set(1u, Napi::Number::New(env, (*res.centroid)[1]));
      centroidArr.Set(2u, Napi::Number::New(env, (*res.centroid)[2]));
      result.Set("centroid", centroidArr);
    }
    if (res.inertiaTensor.has_value()) {
      Napi::Array inertiaArr = Napi::Array::New(env, 9);
      for (uint32_t i = 0; i < 9; ++i) {
        inertiaArr.Set(i, Napi::Number::New(env, (*res.inertiaTensor)[i]));
      }
      result.Set("inertia_tensor", inertiaArr);
    }
    return result;
  })
  return env.Undefined();
}

Napi::Value MeasureDistance(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "measureDistance(entityA: string, entityB: string, measurementType: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string entityA = info[0].As<Napi::String>().Utf8Value();
  std::string entityB = info[1].As<Napi::String>().Utf8Value();
  std::string mType   = info[2].As<Napi::String>().Utf8Value();

  TRY_GEOMETRY(env, {
    MeasureResult res = svc().measureDistance(entityA, entityB, mType);
    Napi::Object result = Napi::Object::New(env);
    result.Set("value", Napi::Number::New(env, res.value));
    result.Set("measurement_type", Napi::String::New(env, res.measurementType));
    return result;
  })
  return env.Undefined();
}

Napi::Value ExploreTopology(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "exploreTopology(entityId: string, returnType: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string entityId   = info[0].As<Napi::String>().Utf8Value();
  std::string returnType = info[1].As<Napi::String>().Utf8Value();

  TRY_GEOMETRY(env, {
    ExploreResult res = svc().exploreTopology(entityId, returnType);
    Napi::Object result = Napi::Object::New(env);
    Napi::Array entityArr = Napi::Array::New(env, res.entityIds.size());
    for (size_t i = 0; i < res.entityIds.size(); ++i) {
      entityArr.Set(i, Napi::String::New(env, res.entityIds[i]));
    }
    result.Set("entity_ids", entityArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value FuseBodies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "fuseBodies(tools: Array<string>, fuzzyTolerance: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array toolsArr = info[0].As<Napi::Array>();
  std::vector<std::string> tools;
  tools.reserve(toolsArr.Length());
  for (uint32_t i = 0; i < toolsArr.Length(); ++i) {
    tools.push_back(toolsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  double fuzzyTolerance = info[1].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    FuseResult res = svc().fuseBodies(tools, fuzzyTolerance);
    Napi::Object result = Napi::Object::New(env);
    result.Set("solid_id",       Napi::String::New(env, res.solidId));
    result.Set("disjoint",      Napi::Boolean::New(env, res.disjoint));
    result.Set("rollback_token",  Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value CutBodies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "cutBodies(blank: string, tools: Array<string>, keepTools: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string blank = info[0].As<Napi::String>().Utf8Value();
  Napi::Array toolsArr = info[1].As<Napi::Array>();
  std::vector<std::string> tools;
  tools.reserve(toolsArr.Length());
  for (uint32_t i = 0; i < toolsArr.Length(); ++i) {
    tools.push_back(toolsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  bool keepTools = info[2].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    CutResult res = svc().cutBodies(blank, tools, keepTools);
    Napi::Object result = Napi::Object::New(env);
    result.Set("solid_id",       Napi::String::New(env, res.solidId));
    result.Set("rollback_token",  Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

Napi::Value IntersectBodies(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "intersectBodies(a: string, b: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string a = info[0].As<Napi::String>().Utf8Value();
  std::string b = info[1].As<Napi::String>().Utf8Value();

  TRY_GEOMETRY(env, {
    IntersectResult res = svc().intersectBodies(a, b);
    Napi::Object result = Napi::Object::New(env);
    result.Set("solid_id",       Napi::String::New(env, res.solidId));
    result.Set("rollback_token",  Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

static Napi::Object makeTransformResultObject(Napi::Env env, const TransformResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeStandardResultObject(Napi::Env env, const FilletResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeStandardResultObject(Napi::Env env, const ChamferResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeStandardResultObject(Napi::Env env, const SimplifyResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeStandardResultObject(Napi::Env env, const OffsetShapeResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeHealExResultObject(Napi::Env env, const HealExResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("solid_id",        Napi::String::New(env, res.solidId));
  result.Set("heal_complete",   Napi::Boolean::New(env, res.healComplete));
  
  Napi::Array issuesArr = Napi::Array::New(env, res.remainingIssues.size());
  for (size_t i = 0; i < res.remainingIssues.size(); ++i) {
    issuesArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.remainingIssues[i]));
  }
  result.Set("remaining_issues", issuesArr);
  
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeDeleteFaceResultObject(Napi::Env env, const DeleteFaceResult& res) {
  Napi::Object result = Napi::Object::New(env);
  
  Napi::Array solidsArr = Napi::Array::New(env, res.solidIds.size());
  for (size_t i = 0; i < res.solidIds.size(); ++i) {
    solidsArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.solidIds[i]));
  }
  result.Set("solid_ids", solidsArr);
  
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

Napi::Value FilletEdges(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "filletEdges(partId: string, edgeIds: string[], radiusMm: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  Napi::Array edgeIdsArr = info[1].As<Napi::Array>();
  std::vector<std::string> edgeIds;
  for (uint32_t i = 0; i < edgeIdsArr.Length(); ++i) {
    edgeIds.push_back(edgeIdsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  double radiusMm = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    FilletResult res = svc().filletEdges(partId, edgeIds, radiusMm);
    return makeStandardResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value ChamferEdges(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "chamferEdges(partId: string, edgeIds: string[], distanceMm: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  Napi::Array edgeIdsArr = info[1].As<Napi::Array>();
  std::vector<std::string> edgeIds;
  for (uint32_t i = 0; i < edgeIdsArr.Length(); ++i) {
    edgeIds.push_back(edgeIdsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  double distanceMm = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    ChamferResult res = svc().chamferEdges(partId, edgeIds, distanceMm);
    return makeStandardResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value SimplifyBody(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "simplifyBody(partId: string, unifyFaces: boolean, unifyEdges: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  bool unifyFaces = info[1].As<Napi::Boolean>().Value();
  bool unifyEdges = info[2].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    SimplifyResult res = svc().simplifyBody(partId, unifyFaces, unifyEdges);
    return makeStandardResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value HealGeometryEx(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "healGeometryEx(partId: string, fixTolerances: boolean, fixWires: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  bool fixTolerances = info[1].As<Napi::Boolean>().Value();
  bool fixWires = info[2].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    HealExResult res = svc().healGeometryEx(partId, fixTolerances, fixWires);
    return makeHealExResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value OffsetShape(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "offsetShape(partId: string, offsetValue: number, tolerance: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  double offsetValue = info[1].As<Napi::Number>().DoubleValue();
  double tolerance = info[2].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    OffsetShapeResult res = svc().offsetShape(partId, offsetValue, tolerance);
    return makeStandardResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value DeleteFace(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "deleteFace(partId: string, faceIds: string[], healRemaining: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  Napi::Array faceIdsArr = info[1].As<Napi::Array>();
  std::vector<std::string> faceIds;
  for (uint32_t i = 0; i < faceIdsArr.Length(); ++i) {
    faceIds.push_back(faceIdsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  bool healRemaining = info[2].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    DeleteFaceResult res = svc().deleteFace(partId, faceIds, healRemaining);
    return makeDeleteFaceResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value TranslateBody(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5) {
    Napi::TypeError::New(env, "translateBody(solidId: string, dx: number, dy: number, dz: number, keepOriginal: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  double dx = info[1].As<Napi::Number>().DoubleValue();
  double dy = info[2].As<Napi::Number>().DoubleValue();
  double dz = info[3].As<Napi::Number>().DoubleValue();
  bool keepOriginal = info[4].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    TransformResult res = svc().translateBody(solidId, dx, dy, dz, keepOriginal);
    return makeTransformResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value RotateBody(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 9) {
    Napi::TypeError::New(env, "rotateBody(solidId: string, px: number, py: number, pz: number, dx: number, dy: number, dz: number, angleDeg: number, keepOriginal: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  double px = info[1].As<Napi::Number>().DoubleValue();
  double py = info[2].As<Napi::Number>().DoubleValue();
  double pz = info[3].As<Napi::Number>().DoubleValue();
  double dx = info[4].As<Napi::Number>().DoubleValue();
  double dy = info[5].As<Napi::Number>().DoubleValue();
  double dz = info[6].As<Napi::Number>().DoubleValue();
  double angleDeg = info[7].As<Napi::Number>().DoubleValue();
  bool keepOriginal = info[8].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    TransformResult res = svc().rotateBody(solidId, px, py, pz, dx, dy, dz, angleDeg, keepOriginal);
    return makeTransformResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value MirrorBody(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 8) {
    Napi::TypeError::New(env, "mirrorBody(solidId: string, ox: number, oy: number, oz: number, nx: number, ny: number, nz: number, keepOriginal: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  double ox = info[1].As<Napi::Number>().DoubleValue();
  double oy = info[2].As<Napi::Number>().DoubleValue();
  double oz = info[3].As<Napi::Number>().DoubleValue();
  double nx = info[4].As<Napi::Number>().DoubleValue();
  double ny = info[5].As<Napi::Number>().DoubleValue();
  double nz = info[6].As<Napi::Number>().DoubleValue();
  bool keepOriginal = info[7].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    TransformResult res = svc().mirrorBody(solidId, ox, oy, oz, nx, ny, nz, keepOriginal);
    return makeTransformResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value ScaleBody(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6) {
    Napi::TypeError::New(env, "scaleBody(solidId: string, ox: number, oy: number, oz: number, factor: number, keepOriginal: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string solidId = info[0].As<Napi::String>().Utf8Value();
  double ox = info[1].As<Napi::Number>().DoubleValue();
  double oy = info[2].As<Napi::Number>().DoubleValue();
  double oz = info[3].As<Napi::Number>().DoubleValue();
  double factor = info[4].As<Napi::Number>().DoubleValue();
  bool keepOriginal = info[5].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    TransformResult res = svc().scaleBody(solidId, ox, oy, oz, factor, keepOriginal);
    return makeTransformResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value AlignToFace(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "alignToFace(srcFaceId: string, dstFaceId: string, flipNormal: boolean, keepOriginal: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string srcFaceId = info[0].As<Napi::String>().Utf8Value();
  std::string dstFaceId = info[1].As<Napi::String>().Utf8Value();
  bool flipNormal = info[2].As<Napi::Boolean>().Value();
  bool keepOriginal = info[3].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    TransformResult res = svc().alignToFace(srcFaceId, dstFaceId, flipNormal, keepOriginal);
    return makeTransformResultObject(env, res);
  })
  return env.Undefined();
}


static Napi::Object makeSewResultObject(Napi::Env env, const SewResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("shell_id",       Napi::String::New(env, res.solidId));
  result.Set("sew_complete",   Napi::Boolean::New(env, res.sewComplete));
  
  Napi::Array freeArr = Napi::Array::New(env, res.freeEdges.size());
  for (size_t i = 0; i < res.freeEdges.size(); ++i) {
    freeArr.Set(static_cast<uint32_t>(i), Napi::String::New(env, res.freeEdges[i]));
  }
  result.Set("free_edges", freeArr);

  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  
  Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
  for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
    Napi::Object rec = Napi::Object::New(env);
    rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
    rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
    rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
    rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
    histArr.Set(static_cast<uint32_t>(i), rec);
  }
  result.Set("shape_history", histArr);
  return result;
}

static Napi::Object makeAssemblyNodeObject(Napi::Env env, const AssemblyNode& node) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("component_id", Napi::String::New(env, node.componentId));
  obj.Set("shape_id", Napi::String::New(env, node.shapeId));
  
  Napi::Array matrixArr = Napi::Array::New(env, 16);
  for (uint32_t i = 0; i < 16; ++i) {
    matrixArr.Set(i, Napi::Number::New(env, node.locationMatrix.m[i]));
  }
  obj.Set("location_matrix", matrixArr);
  
  Napi::Array childrenArr = Napi::Array::New(env, node.children.size());
  for (size_t i = 0; i < node.children.size(); ++i) {
    childrenArr.Set(static_cast<uint32_t>(i), makeAssemblyNodeObject(env, node.children[i]));
  }
  obj.Set("children", childrenArr);
  return obj;
}

static Napi::Object makeListAssemblyResultObject(Napi::Env env, const ListAssemblyResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("assembly_id", Napi::String::New(env, res.assemblyId));
  result.Set("root", makeAssemblyNodeObject(env, res.root));
  return result;
}

static Napi::Object makeMateRigidResultObject(Napi::Env env, const MateRigidResult& res) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("component_id", Napi::String::New(env, res.componentId));
  
  Napi::Array matrixArr = Napi::Array::New(env, 16);
  for (uint32_t i = 0; i < 16; ++i) {
    matrixArr.Set(i, Napi::Number::New(env, res.locationMatrix.m[i]));
  }
  result.Set("location_matrix", matrixArr);
  result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
  return result;
}

Napi::Value SewFaces(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3) {
    Napi::TypeError::New(env, "sewFaces(entityIds: string[], tolerance: number, makeSolid: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array entityIdsArr = info[0].As<Napi::Array>();
  std::vector<std::string> entityIds;
  for (uint32_t i = 0; i < entityIdsArr.Length(); ++i) {
    entityIds.push_back(entityIdsArr.Get(i).As<Napi::String>().Utf8Value());
  }
  double tolerance = info[1].As<Napi::Number>().DoubleValue();
  bool makeSolid = info[2].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    SewResult res = svc().sewFaces(entityIds, tolerance, makeSolid);
    return makeSewResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value CreateAssemblyDocument(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  TRY_GEOMETRY(env, {
    CreateAssemblyResult res = svc().createAssemblyDocument();
    Napi::Object result = Napi::Object::New(env);
    result.Set("assembly_id", Napi::String::New(env, res.assemblyId));
    return result;
  })
  return env.Undefined();
}

Napi::Value AddAssemblyInstance(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 9) {
    Napi::TypeError::New(env, "addAssemblyInstance(assemblyId: string, shapeId: string, tx: number, ty: number, tz: number, qw: number, qx: number, qy: number, qz: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string assemblyId = info[0].As<Napi::String>().Utf8Value();
  std::string shapeId = info[1].As<Napi::String>().Utf8Value();
  double tx = info[2].As<Napi::Number>().DoubleValue();
  double ty = info[3].As<Napi::Number>().DoubleValue();
  double tz = info[4].As<Napi::Number>().DoubleValue();
  double qw = info[5].As<Napi::Number>().DoubleValue();
  double qx = info[6].As<Napi::Number>().DoubleValue();
  double qy = info[7].As<Napi::Number>().DoubleValue();
  double qz = info[8].As<Napi::Number>().DoubleValue();

  TRY_GEOMETRY(env, {
    AddInstanceResult res = svc().addAssemblyInstance(assemblyId, shapeId, tx, ty, tz, qw, qx, qy, qz);
    Napi::Object result = Napi::Object::New(env);
    result.Set("component_id", Napi::String::New(env, res.componentId));
    result.Set("rollback_token", Napi::String::New(env, res.rollbackToken));
    return result;
  })
  return env.Undefined();
}

Napi::Value MateRig(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "mateRigid(assemblyId: string, srcEntityId: string, dstEntityId: string, flipAlignment: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string assemblyId = info[0].As<Napi::String>().Utf8Value();
  std::string srcEntityId = info[1].As<Napi::String>().Utf8Value();
  std::string dstEntityId = info[2].As<Napi::String>().Utf8Value();
  bool flipAlignment = info[3].As<Napi::Boolean>().Value();

  TRY_GEOMETRY(env, {
    MateRigidResult res = svc().mateRigid(assemblyId, srcEntityId, dstEntityId, flipAlignment);
    return makeMateRigidResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value ListAssemblyTree(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "listAssemblyTree(assemblyId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string assemblyId = info[0].As<Napi::String>().Utf8Value();

  TRY_GEOMETRY(env, {
    ListAssemblyResult res = svc().listAssemblyTree(assemblyId);
    return makeListAssemblyResultObject(env, res);
  })
  return env.Undefined();
}

Napi::Value ValidateSheetMetal(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "validateSheetMetal(partId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    SheetMetalValidationResult res = svc().validateSheetMetal(partId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("is_valid", Napi::Boolean::New(env, res.isValid));
    result.Set("nominal_thickness", Napi::Number::New(env, res.nominalThickness));
    result.Set("can_flatten", Napi::Boolean::New(env, res.canFlatten));
    Napi::Array errs = Napi::Array::New(env, res.validationErrors.size());
    for (size_t i = 0; i < res.validationErrors.size(); ++i) {
      errs.Set(i, Napi::String::New(env, res.validationErrors[i]));
    }
    result.Set("validation_errors", errs);
    return result;
  })
  return env.Undefined();
}

Napi::Value ReconstructCurvedBends(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "reconstructCurvedBends(partId: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string partId = info[0].As<Napi::String>().Utf8Value();
  TRY_GEOMETRY(env, {
    CurvedRebuildResult res = svc().reconstructCurvedBends(partId);
    Napi::Object result = Napi::Object::New(env);
    result.Set("solidId", Napi::String::New(env, res.solidId));
    result.Set("bendsReplaced", Napi::Number::New(env, res.bendsReplaced));
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
    Napi::Array histArr = Napi::Array::New(env, res.shapeHistory.size());
    for (size_t i = 0; i < res.shapeHistory.size(); ++i) {
      Napi::Object rec = Napi::Object::New(env);
      rec.Set("verdict",         Napi::String::New(env, res.shapeHistory[i].verdict));
      rec.Set("original_id",     Napi::String::New(env, res.shapeHistory[i].originalId));
      rec.Set("new_id",          Napi::String::New(env, res.shapeHistory[i].newId));
      rec.Set("operation_label", Napi::String::New(env, res.shapeHistory[i].operationLabel));
      histArr.Set(static_cast<uint32_t>(i), rec);
    }
    result.Set("shape_history", histArr);
    return result;
  })
  return env.Undefined();
}

// ─── Registration ─────────────────────────────────────────────────────────────

void RegisterGeometryMethods(Napi::Env env, Napi::Object exports) {
  exports.Set("loadStep",        Napi::Function::New(env, LoadStep));
  exports.Set("getTopology",     Napi::Function::New(env, GetTopology));
  exports.Set("checkManifold",   Napi::Function::New(env, CheckManifold));
  exports.Set("healGeometry",    Napi::Function::New(env, HealGeometry));
  exports.Set("separateSolids",  Napi::Function::New(env, SeparateSolids));
  exports.Set("booleanCut",      Napi::Function::New(env, BooleanCut));
  exports.Set("addTabSlot",      Napi::Function::New(env, AddTabSlot));
  exports.Set("addRivetHole",    Napi::Function::New(env, AddRivetHole));
  exports.Set("unfoldShell",     Napi::Function::New(env, UnfoldShell));
  exports.Set("exportDxf",       Napi::Function::New(env, ExportDxf));
  exports.Set("exportGlb",       Napi::Function::New(env, ExportGlb));
  exports.Set("nestShells",      Napi::Function::New(env, NestShells));
  exports.Set("createSnapshot",        Napi::Function::New(env, CreateSnapshot));
  exports.Set("restoreSnapshot",       Napi::Function::New(env, RestoreSnapshot));
  exports.Set("clearSnapshots",        Napi::Function::New(env, ClearSnapshots));
  exports.Set("computeIntersections",  Napi::Function::New(env, ComputeIntersections));
  exports.Set("computeGaps",           Napi::Function::New(env, ComputeGaps));
  exports.Set("trimBodyWithPlane",     Napi::Function::New(env, TrimBodyWithPlane));
  exports.Set("splitBodyByPlane",      Napi::Function::New(env, SplitBodyByPlane));
  exports.Set("mergeBodiesWithBend",   Napi::Function::New(env, MergeBodiesWithBend));
  exports.Set("closeGap",             Napi::Function::New(env, CloseGap));
  exports.Set("extendFaceToTarget",    Napi::Function::New(env, ExtendFaceToTarget));
  exports.Set("offsetFace",            Napi::Function::New(env, OffsetFace));
  exports.Set("addFlange",             Napi::Function::New(env, AddFlange));
  exports.Set("ripEdge",               Napi::Function::New(env, RipEdge));
  exports.Set("splitBodyByBends",      Napi::Function::New(env, SplitBodyByBends));
  exports.Set("removeProtrusions",     Napi::Function::New(env, RemoveProtrusions));

  // Feature 006
  exports.Set("computeBoundingBox",    Napi::Function::New(env, ComputeBoundingBox));
  exports.Set("computeMassProperties", Napi::Function::New(env, ComputeMassProperties));
  exports.Set("measureDistance",       Napi::Function::New(env, MeasureDistance));
  exports.Set("exploreTopology",       Napi::Function::New(env, ExploreTopology));
  exports.Set("fuseBodies",            Napi::Function::New(env, FuseBodies));
  exports.Set("cutBodies",             Napi::Function::New(env, CutBodies));
  exports.Set("intersectBodies",       Napi::Function::New(env, IntersectBodies));

  exports.Set("translateBody",         Napi::Function::New(env, TranslateBody));
  exports.Set("rotateBody",            Napi::Function::New(env, RotateBody));
  exports.Set("mirrorBody",            Napi::Function::New(env, MirrorBody));
  exports.Set("scaleBody",             Napi::Function::New(env, ScaleBody));
  exports.Set("alignToFace",           Napi::Function::New(env, AlignToFace));

  // Feature 006 - US4
  exports.Set("filletEdges",           Napi::Function::New(env, FilletEdges));
  exports.Set("chamferEdges",          Napi::Function::New(env, ChamferEdges));
  exports.Set("simplifyBody",          Napi::Function::New(env, SimplifyBody));
  exports.Set("healGeometryEx",        Napi::Function::New(env, HealGeometryEx));
  exports.Set("offsetShape",           Napi::Function::New(env, OffsetShape));
  exports.Set("deleteFace",            Napi::Function::New(env, DeleteFace));

  // Feature 006 - US5 / US6
  exports.Set("sewFaces",              Napi::Function::New(env, SewFaces));
  exports.Set("createAssemblyDocument", Napi::Function::New(env, CreateAssemblyDocument));
  exports.Set("addAssemblyInstance",   Napi::Function::New(env, AddAssemblyInstance));
  exports.Set("mateRigid",             Napi::Function::New(env, MateRig));
  exports.Set("listAssemblyTree",      Napi::Function::New(env, ListAssemblyTree));

  // Feature 007
  exports.Set("validateSheetMetal",    Napi::Function::New(env, ValidateSheetMetal));
  exports.Set("reconstructCurvedBends", Napi::Function::New(env, ReconstructCurvedBends));
}

}  // namespace mcp_cad
