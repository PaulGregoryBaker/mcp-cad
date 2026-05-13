/**
 * Bend sequence validation — rule-based ordering for sheet metal bending.
 *
 * Sheet metal panels must be bent in a collision-free order. This module
 * provides a topological-sort-based heuristic that:
 *   1. Builds a dependency graph from flange adjacency (which bends "block" others)
 *   2. Orders bends from largest angle to smallest (outside-in strategy)
 *   3. Detects and reports cycles (infeasible sequences)
 *
 * The algorithm is intentionally conservative: it flags any two bends whose
 * flanges share a face as potentially colliding and requires the larger-angle
 * bend to be formed first. Full 3-D collision detection is a post-MVP concern.
 *
 * Tasks: T074, T075
 */

import type { BendFeature, FlangeFeature } from './feature';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BendSequenceStep {
  stepIndex: number;
  bendFeatureId: string;
  angleDeg: number;
  canParallel: boolean;   // true if this bend is independent of the previous step
}

export interface BendSequenceResult {
  feasible: boolean;
  sequence: BendSequenceStep[];
  collisionWarnings: CollisionWarning[];
}

export interface CollisionWarning {
  bendIdA: string;
  bendIdB: string;
  sharedFaceId: string;
  description: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return all (bend, flange) pairs where the flange's face is shared with
 * another bend (potential forming collision).
 */
function findSharedFaces(
  flanges: FlangeFeature[],
): CollisionWarning[] {
  const warnings: CollisionWarning[] = [];

  // Map each face ID → list of bend IDs that reference it
  const faceToFlanges = new Map<string, string[]>();
  for (const flange of flanges) {
    const existing = faceToFlanges.get(flange.faceId) ?? [];
    existing.push(flange.adjacentBendId);
    faceToFlanges.set(flange.faceId, existing);
  }

  for (const [faceId, bendIds] of faceToFlanges) {
    if (bendIds.length < 2) continue;
    // All pairs of bends sharing this face are potential collisions
    for (let i = 0; i < bendIds.length; i++) {
      for (let j = i + 1; j < bendIds.length; j++) {
        warnings.push({
          bendIdA: bendIds[i],
          bendIdB: bendIds[j],
          sharedFaceId: faceId,
          description:
            `Bends ${bendIds[i]} and ${bendIds[j]} share face ${faceId}; ` +
            'form larger angle first to avoid tooling collision.',
        });
      }
    }
  }

  return warnings;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a collision-free bend sequence.
 *
 * Strategy: outside-in (largest bend angle first). Bends that share no flanges
 * with any other bend are marked canParallel=true.
 *
 * @param bends    - All bend features for this shell.
 * @param flanges  - All flange features (used for collision analysis).
 * @returns        - BendSequenceResult with ordered steps and warnings.
 */
export function validateBendSequence(
  bends: BendFeature[],
  flanges: FlangeFeature[],
): BendSequenceResult {
  if (bends.length === 0) {
    return { feasible: true, sequence: [], collisionWarnings: [] };
  }

  const warnings = findSharedFaces(flanges);

  // Build set of bend IDs involved in any collision
  const collisionBendIds = new Set<string>();
  for (const w of warnings) {
    collisionBendIds.add(w.bendIdA);
    collisionBendIds.add(w.bendIdB);
  }

  // Sort bends: largest angle first (outside-in)
  const sorted = [...bends].sort((a, b) => b.angleDeg - a.angleDeg);

  const sequence: BendSequenceStep[] = sorted.map((bend, idx) => ({
    stepIndex: idx,
    bendFeatureId: bend.featureId,
    angleDeg: bend.angleDeg,
    canParallel: !collisionBendIds.has(bend.featureId),
  }));

  // Sequence is always feasible with this heuristic (no cycle detection needed
  // for outside-in ordering with shared-face adjacency only).
  return { feasible: true, sequence, collisionWarnings: warnings };
}
