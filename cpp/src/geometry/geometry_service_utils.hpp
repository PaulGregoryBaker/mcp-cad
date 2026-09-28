#pragma once

/**
 * geometry_service_utils.hpp — helpers shared across two or more
 * geometry_service_*.cc domain files.
 *
 * Anything used by only one domain file belongs in that file, not here.
 */

#include "geometry_service_impl.hpp"

#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <string>
#include <vector>

namespace mcp_cad {

// ─── ID / time helpers ────────────────────────────────────────────────────────

std::string generateUUID();
long long    nowMs();
std::string  shapeId(const TopoDS_Shape& shape);

// ─── Face geometry helpers ────────────────────────────────────────────────────

// Outward-pointing normal of a face at its UV centre.
gp_Vec faceOutwardNormal(const TopoDS_Face& face);

// Centre of mass of a face's surface.
gp_Pnt faceCenter(const TopoDS_Face& face);

// Smaller of a planar face's two local (in-plane) bounding extents.
// Returns 0.0 for non-planar faces.
double minLocalDimension(const TopoDS_Face& face);

// ─── Graph helpers ─────────────────────────────────────────────────────────────

bool detectCycleDFS(int u, int parent, const std::vector<std::vector<int>>& adj,
                     std::vector<bool>& visited);

// ─── Session state lookups (caller must hold state.mutex) ────────────────────

// Looks up a solid/shell/face/edge/vertex by ID across the whole session.
// Throws GE_SOLID_NOT_FOUND if no match exists.
TopoDS_Shape lookupEntityIn(const GeometryState& state, const std::string& entityId);

// Finds the shell/solid ID that owns a given sub-shape (face/edge) ID.
// Throws GE_SOLID_NOT_FOUND if no owner exists.
ShellId findParentShellIdIn(const GeometryState& state, const std::string& subShapeId);

struct ResolvedShape {
  TopoDS_Shape shape;
  bool         isSolid = false;
};

// Looks up `id` in state.shells, then state.solids. Throws GE_SHELL_NOT_FOUND
// (with notFoundMessage) if neither map contains it.
ResolvedShape resolveShellOrSolidIn(const GeometryState& state, const std::string& id,
                                     const std::string& notFoundMessage);

// ─── Sheet metal validation ────────────────────────────────────────────────────

// Pure function of the shape: thin-sheet skin pairing, thickness-uniformity
// check, T-junction detection, and bend-loop cycle detection.
SheetMetalValidationResult validateSheetMetalShape(const TopoDS_Shape& shape);

// Dominant Face Method: thickness = perpendicular distance between the
// shape's single largest planar face and its best anti-parallel, overlapping
// partner. See the definition in geometry_service_utils.cc for rationale.
PanelThicknessResult measurePanelThickness(const TopoDS_Shape& shape);

}  // namespace mcp_cad
