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
    result.Set("rollbackToken", Napi::String::New(env, res.rollbackToken));
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

// ─── Registration ─────────────────────────────────────────────────────────────

void RegisterGeometryMethods(Napi::Env env, Napi::Object exports) {
  exports.Set("loadStep",        Napi::Function::New(env, LoadStep));
  exports.Set("getTopology",     Napi::Function::New(env, GetTopology));
  exports.Set("checkManifold",   Napi::Function::New(env, CheckManifold));
  exports.Set("healGeometry",    Napi::Function::New(env, HealGeometry));
  exports.Set("booleanCut",      Napi::Function::New(env, BooleanCut));
  exports.Set("addTabSlot",      Napi::Function::New(env, AddTabSlot));
  exports.Set("addRivetHole",    Napi::Function::New(env, AddRivetHole));
  exports.Set("unfoldShell",     Napi::Function::New(env, UnfoldShell));
  exports.Set("exportDxf",       Napi::Function::New(env, ExportDxf));
  exports.Set("nestShells",      Napi::Function::New(env, NestShells));
  exports.Set("createSnapshot",  Napi::Function::New(env, CreateSnapshot));
  exports.Set("restoreSnapshot", Napi::Function::New(env, RestoreSnapshot));
  exports.Set("clearSnapshots",  Napi::Function::New(env, ClearSnapshots));
}

}  // namespace mcp_cad
