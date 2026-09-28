#pragma once

/**
 * RingContainment — "is this candidate shape entirely inside this container
 * polygon" primitives, shared by `cut_panel.cc` (validating a new hole at
 * write time, against a live region panel's own `regionOuter`) and
 * `manufacturing_graph_evaluator.cc`'s `RegionOf` (deciding which region
 * panel an already-stored hole belongs to, against that same panel's own
 * just-computed `regionOuter`) — ONE primitive, two call sites, never two
 * independently-derived containment checks (constitution v2.0.0 principle
 * III/P3).
 *
 * Deliberately pure (no OCCT): point-in-polygon (ray casting) and point-to-
 * segment distance are standard, well-known, non-bug-prone algorithms —
 * unlike general polygon boolean/clipping, hand-writing these here carries
 * none of the risk this codebase avoids by delegating booleans to OCCT
 * (polygon_boolean.hpp's own stated rationale).
 *
 * "Fully inside" means every vertex is inside AND no boundary crossing
 * occurs — a candidate edge that bulges outside a non-convex container
 * despite both its endpoints being inside is correctly rejected, not just a
 * vertex-only check.
 */

#include "manufacturing_graph_evaluator.hpp"  // Point2

#include <vector>

namespace mcp_cad::translation {

// True iff a circle of the given radius, centred at `center`, lies entirely
// within `container` (a simple polygon, any winding) with no part of its
// boundary touching or crossing `container`'s own boundary. Exact — no
// tessellation: computed via point-in-polygon for the centre plus a minimum
// point-to-segment distance (>= radiusMm) check against every edge.
bool CircleFullyInsidePolygon(const Point2& center, double radiusMm,
                               const std::vector<Point2>& container);

// True iff every point of `ring` lies entirely within `container`, with no
// edge of `ring` crossing any edge of `container`.
bool RingFullyInsidePolygon(const std::vector<Point2>& ring,
                             const std::vector<Point2>& container);

}  // namespace mcp_cad::translation
