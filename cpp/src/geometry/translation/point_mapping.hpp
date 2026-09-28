#pragma once

/**
 * Point mapping (rebuild/13-translation-module-design.md §4/§5) — Phase 5 Slice 3.
 *
 * Forward (2D->3D): a query point in F (the part's one shared flat frame) is
 * owned by whichever region panel's region OR bend's bridge zone contains it
 * (13 §4.2); the owning node's already-cached chain (RegionPanelLayout::pose,
 * or the bridge's own Z_i cylindrical development map) places it in world
 * space. No new evaluation — this module reads an already-computed
 * EvaluateResult, it never re-derives a region panel's pose or shape.
 *
 * Reverse (3D->2D): 13 §5.1's resolution procedure — every candidate node's
 * inverse chain is tried; a candidate wins only if BOTH its residual
 * (out-of-surface distance) is small AND the resulting 2D point falls inside
 * that SAME candidate's own region/bridge on the flat pattern. This dual
 * requirement is what makes v1's association-swap defect structurally
 * impossible: a point can only be attributed to the node whose own inverse
 * lands inside its own boundary, not merely the geometrically nearest one.
 *
 * This module has NO OCCT dependency (same isolation rationale as
 * manufacturing_graph_evaluator.hpp) and reuses PartGraphSpec/EvaluateResult
 * directly — no new graph input type, no new evaluation pass.
 */

#include "manufacturing_graph_evaluator.hpp"

namespace mcp_cad::translation {

enum class MapErrorCode {
  kNone,
  kPointNotOnPart,     // GE_POINT_NOT_ON_PART (13 §5.1, N5) — no candidate chain matched
  kInvalidLayout,       // the supplied EvaluateResult was not itself ok
};

struct MapToWorldResult {
  bool ok = false;
  MapErrorCode errorCode = MapErrorCode::kNone;
  std::string message;
  Point3 point3d;
  // Exactly one of these is non-empty on success — whichever node owns the query point.
  std::string regionPanelId;
  std::string bendId;
};

struct MapToFlatResult {
  bool ok = false;
  MapErrorCode errorCode = MapErrorCode::kNone;
  std::string message;
  Point2 point2d;
  std::string regionPanelId;
  std::string bendId;
  double residualMm = 0.0;  // out-of-surface distance (13 §5.1's D3 thickness note)
};

// 2D point in F -> 3D world point, via whichever region panel or bridge zone
// contains it. `zMm` is the query height above the region's own bottom
// surface (13 D3), 0 by default (the bottom surface itself); a bridge-zone
// query ignores zMm's exact value beyond validating it's within [0, thicknessMm]
// and always returns a point on the bottom-face arc (13 §4.3).
MapToWorldResult MapPointToWorld(const PartGraphSpec& graph, const EvaluateResult& layout,
                                  const Point2& point2d, double zMm = 0.0);

// 3D world point -> 2D point in F, resolving ownership per 13 §5.1.
MapToFlatResult MapPointToFlat(const PartGraphSpec& graph, const EvaluateResult& layout,
                                const Point3& point3d);

}  // namespace mcp_cad::translation
