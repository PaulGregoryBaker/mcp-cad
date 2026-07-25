#pragma once

/**
 * PolygonBoolean — a general 2D polygon union/difference primitive, shared by
 * the v2 `fuse_bodies` (union: absorb a coplanar flat part's outline into
 * another's) and `remove_protrusions` (difference: subtract an extracted
 * protrusion's footprint from its host's outline) tools (rebuild/06-plan.md
 * Phase 5 Slice 6).
 *
 * Unlike step_reconciliation.cc/part_merge.hpp (genuinely pure — a rigid 2D
 * alignment derived from a single matched edge has an exact closed-form
 * solution), a GENERAL polygon boolean (arbitrary, possibly non-convex
 * input, touching or overlapping, possibly producing holes or multiple
 * disjoint output loops) does not — hand-rolling a robust clipper (e.g.
 * Weiler-Atherton/Greiner-Hormann, with all their degenerate-touching-edge
 * cases) is exactly the class of bug-prone, multi-day undertaking this
 * project's own history warns against (rebuild/01-lessons-learned.md).
 * OCCT already solves this reliably (the same BRepAlgoAPI_Fuse/Cut family
 * already used elsewhere in this codebase, e.g. part_solid_construction.cc),
 * so THIS module — unlike its pure translation-module siblings — is
 * deliberately an OCCT-touching adapter (matching part_solid_construction's
 * own "Port D adapter" precedent): build two planar faces from the input
 * rings in a shared local 2D frame, run the real kernel boolean, extract the
 * result back into plain Point2 rings. The v2 mutation layer above this
 * (GraphStore.fuseBodies/extractProtrusions) still only ever sees plain
 * point arrays in and out — the OCCT dependency is fully contained here.
 *
 * First-cut scope (matches the fuse_bodies/remove_protrusions plan): the
 * result must be exactly one simple closed outer loop with no holes and no
 * disjoint pieces — both operations' own callers already guard for the
 * physical preconditions (coplanar, touching/overlapping) that make this the
 * expected case; anything else is a typed error, not a silently-dropped
 * loop.
 */

#include "manufacturing_graph_evaluator.hpp"  // Point2

#include <string>
#include <vector>

namespace mcp_cad::translation {

enum class PolygonBooleanErrorCode {
  kNone,
  kDegenerateInput,       // fewer than 3 vertices, or zero-area, in either ring
  kOperationFailed,       // the underlying kernel boolean did not succeed
  kMultipleLoops,         // result has more than one face/wire (disjoint pieces)
  kHasHoles,              // result face has inner wires (a hole was produced)
  kNotCoplanar,           // FuseCoplanarParts only: B's outline, transformed into
                           // A's frame, does not lie at z=0 within tolerance
};

struct PolygonBooleanResult {
  bool ok = false;
  PolygonBooleanErrorCode errorCode = PolygonBooleanErrorCode::kNone;
  std::string message;
  std::vector<Point2> outer;  // valid only when ok == true; CCW, per this
                               // codebase's canonical winding convention
};

// Union (fuse_bodies): ringA and ringB, both already expressed in the SAME
// local 2D frame (the caller — GraphStore.fuseBodies — is responsible for
// transforming ringB into ringA's frame first, via each part's own anchor),
// must touch or overlap for a single-loop result to exist; a genuinely
// disjoint pair is a typed error here (kMultipleLoops), not silently
// returned as two loops — callers that want to allow disjoint results are
// not this slice's scope (see the plan's own deferred-scope note).
PolygonBooleanResult PolygonUnion(const std::vector<Point2>& ringA,
                                   const std::vector<Point2>& ringB);

// Difference (remove_protrusions' host cleanup): ringA minus ringB, same
// shared-frame precondition as PolygonUnion. ringB is expected to be
// entirely or partially within ringA's boundary (a protrusion's own
// footprint on its host); a difference that leaves a hole (ringB fully
// interior, not touching ringA's own boundary) is a typed error
// (kHasHoles) — a real, physically valid outcome in general, but out of
// this slice's scope (a protrusion detected by detectProtrusions always
// touches its host's boundary by construction, so this should not occur
// for the callers this module currently has).
PolygonBooleanResult PolygonDifference(const std::vector<Point2>& ringA,
                                        const std::vector<Point2>& ringB);

// fuse_bodies' own entry point: unlike PolygonUnion above (which assumes both
// rings are ALREADY in one shared 2D frame), this takes each part's own
// outline AND its anchor (13 §3.1's R, embedding the part's flat frame F into
// world) — the anchor-relative transform and coplanarity check are real
// geometric computation, so per constitution v2.0.0 principle IV ("no
// geometric computation in TypeScript, not even pure math") they belong
// here, not in GraphStore.fuseBodies. Internally: transforms B's outline by
// anchorA.Inverse().Compose(anchorB), verifies every resulting point's z is
// ~0 (coplanar with A's own z=0 flat frame) within kCoplanarToleranceMm, then
// calls PolygonUnion with the projected (x,y) ring.
PolygonBooleanResult FuseCoplanarParts(const std::vector<Point2>& outlineA,
                                        const Transform3& anchorA,
                                        const std::vector<Point2>& outlineB,
                                        const Transform3& anchorB);

}  // namespace mcp_cad::translation
