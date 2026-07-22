/**
 * Central numerical policy module (rebuild/17-numerical-policy.md).
 *
 * The ONLY place a bare tolerance/epsilon literal is allowed in this codebase
 * (enforced by eslint-local-rules.cjs's no-tolerance-literal rule) — every other
 * comparison against a small numeric threshold must import a named constant or
 * helper from here instead of inlining a new one (constitution v2.0.0 principle V).
 *
 * Minimal for Phase 5 Slice 1: just what the replay-invariant harness needs (a
 * position-comparison epsilon). The full policy (BOOLEAN_FUZZ_MM, WINDING,
 * COLLINEARITY_EPSILON, withinProfile bridging to N11 tolerance profiles, ...) is
 * deferred until a real consumer needs it — see rebuild/17 for the full design
 * this module is expected to grow into, and its §0 table for why a *replay*
 * epsilon (below) is this module's concern while a *manufacturing* budget is a
 * separate, project-configurable N11 profile value, not this module's.
 */

// Position-comparison epsilon (mm): "are these two 3D points the SAME point,
// allowing only for floating-point/replay noise" — never a manufacturing
// tolerance. Matches the epsilon the C++ translation module's own closure tests
// use throughout (manufacturing_graph_evaluator_test.cc).
export const REPLAY_POSITION_EPSILON_MM = 1e-6;

// Angle-comparison epsilon (degrees): same "replay noise, not manufacturing
// tolerance" role as REPLAY_POSITION_EPSILON_MM, for scalar bend angles
// carried verbatim through serialize/deserialize (no trig recomputation).
export const REPLAY_ANGLE_EPSILON_DEG = 1e-9;

export interface Point3Like {
  x: number;
  y: number;
  z: number;
}

/** Euclidean distance between two 3D points. */
export function distance3(a: Point3Like, b: Point3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** True if `a` and `b` are the same 3D point, within REPLAY_POSITION_EPSILON_MM. */
export function pointsNearlyEqual(a: Point3Like, b: Point3Like): boolean {
  return distance3(a, b) < REPLAY_POSITION_EPSILON_MM;
}
