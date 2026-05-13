#pragma once

/**
 * TopologyGraph — Face, Edge, and Adjacency data structures.
 *
 * This header is included by geometry_service.hpp and used by the NAPI
 * binding for serialization. No OCCT types are exposed here.
 *
 * Task: T023
 */

#include <string>
#include <vector>

namespace mcp_cad {

// ─── Face node ────────────────────────────────────────────────────────────────

enum class SurfaceType {
  PLANE,
  CYLINDER,
  CONE,
  SPHERE,
  TORUS,
  BSPLINE,
  OTHER,
};

struct FaceNode {
  std::string faceId;
  SurfaceType surfaceType;
  double      areaMm2;
  double      normalX;
  double      normalY;
  double      normalZ;
};

// ─── Edge node ────────────────────────────────────────────────────────────────

enum class CurveType {
  LINE,
  CIRCLE,
  ELLIPSE,
  BSPLINE,
  OTHER,
};

struct EdgeNode {
  std::string edgeId;
  CurveType   curveType;
  double      lengthMm;
};

// ─── Adjacency entry ──────────────────────────────────────────────────────────

struct AdjacencyEntry {
  std::string faceIdA;
  std::string faceIdB;
  std::string sharedEdgeId;
  double      dihedralAngleDeg;  // 0–180°
};

// ─── Topology graph ───────────────────────────────────────────────────────────

struct TopologyGraph {
  std::string                solidId;
  std::vector<FaceNode>      faces;
  std::vector<EdgeNode>      edges;
  std::vector<AdjacencyEntry> adjacency;
};

}  // namespace mcp_cad
