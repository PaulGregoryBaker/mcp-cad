/**
 * Assembly instruction generator.
 *
 * Produces a step-by-step assembly plan from a collection of FeatureSets,
 * ordered topologically by bend sequence and joint dependencies.
 *
 * Each step specifies:
 *   - A part (shell ID)
 *   - The operation type (bend, join, install_hardware)
 *   - The feature ID being operated on
 *   - Tooling setup instructions
 *
 * The output is a JSON document suitable for display in CAM/assembly software
 * or inclusion in a production pack.
 *
 * Tasks: T095, T096
 */

import type { FeatureSet } from './feature';
import type { BendSequenceResult } from './bend_sequence';
import { validateBendSequence } from './bend_sequence';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OperationType = 'bend' | 'punch_hole' | 'join' | 'install_hardware';

export interface AssemblyStep {
  stepIndex: number;
  partId: string;
  operation: OperationType;
  featureId: string;
  description: string;
  toolingHint: string;
  canParallel: boolean;
}

export interface AssemblyInstructions {
  totalSteps: number;
  steps: AssemblyStep[];
  bendSequenceWarnings: string[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate assembly instructions for a single panel.
 *
 * Step ordering:
 *   1. Holes (punched before bending to maintain flat registration)
 *   2. Reliefs (cut before bending)
 *   3. Bends (outside-in order from validateBendSequence)
 *   4. Hardware / joints (after forming)
 *
 * @param featureSet  - Extracted features for one panel.
 * @returns           - AssemblyInstructions with ordered steps.
 */
export function generateAssembly(featureSet: FeatureSet): AssemblyInstructions {
  const steps: AssemblyStep[] = [];
  let idx = 0;
  const warnings: string[] = [];

  // 1. Hole operations (flat state — punch before bending)
  for (const hole of featureSet.holes) {
    steps.push({
      stepIndex: idx++,
      partId: featureSet.shellId,
      operation: 'punch_hole',
      featureId: hole.featureId,
      description: `Punch hole ${hole.featureId} (Ø${hole.diameterMm.toFixed(1)} mm) at (${hole.centerX.toFixed(1)}, ${hole.centerY.toFixed(1)})`,
      toolingHint: `Laser cut or punch press: Ø${hole.diameterMm.toFixed(1)} mm punch`,
      canParallel: true,
    });
  }

  // 2. Relief operations (flat state — cut before bending)
  for (const relief of featureSet.reliefs) {
    steps.push({
      stepIndex: idx++,
      partId: featureSet.shellId,
      operation: 'punch_hole',
      featureId: relief.featureId,
      description: `Cut corner relief ${relief.featureId} (type: ${relief.type}, r=${relief.radiusMm.toFixed(1)} mm)`,
      toolingHint: `Laser: circular cutout r=${relief.radiusMm.toFixed(1)} mm at corner`,
      canParallel: true,
    });
  }

  // 3. Bend operations (ordered outside-in)
  const seqResult: BendSequenceResult = validateBendSequence(
    featureSet.bends,
    featureSet.flanges,
  );

  for (const w of seqResult.collisionWarnings) {
    warnings.push(w.description);
  }

  for (const seq of seqResult.sequence) {
    const bend = featureSet.bends.find(b => b.featureId === seq.bendFeatureId);
    if (bend === undefined) continue;

    steps.push({
      stepIndex: idx++,
      partId: featureSet.shellId,
      operation: 'bend',
      featureId: bend.featureId,
      description: `Bend ${bend.featureId}: ${bend.angleDeg.toFixed(0)}° at r=${bend.radiusMm.toFixed(1)} mm (BA=${bend.bendAllowanceMm.toFixed(2)} mm)`,
      toolingHint: `Press brake: ${bend.angleDeg.toFixed(0)}° die, radius ${bend.radiusMm.toFixed(1)} mm`,
      canParallel: seq.canParallel,
    });
  }

  return {
    totalSteps: steps.length,
    steps,
    bendSequenceWarnings: warnings,
  };
}

/**
 * Generate multi-part assembly instructions, ordered by assembly sequence.
 * Panels with no inter-part dependencies are assembled in parallel.
 *
 * @param featureSets - All panels in assembly order.
 * @returns           - Combined assembly instructions with join steps.
 */
export function generateMultiPartAssembly(featureSets: FeatureSet[]): AssemblyInstructions {
  const allSteps: AssemblyStep[] = [];
  const allWarnings: string[] = [];
  let globalIdx = 0;

  for (const fs of featureSets) {
    const partInstructions = generateAssembly(fs);
    allWarnings.push(...partInstructions.bendSequenceWarnings);

    // Re-index steps across all parts
    for (const step of partInstructions.steps) {
      allSteps.push({ ...step, stepIndex: globalIdx++ });
    }

    // Add inter-part join step if there are adjacent flanges
    if (fs.flanges.length > 0) {
      allSteps.push({
        stepIndex: globalIdx++,
        partId: fs.shellId,
        operation: 'join',
        featureId: fs.flanges[0]!.featureId,
        description: `Join panel ${fs.shellId} to adjacent panel via ${fs.flanges.length} flange(s)`,
        toolingHint: 'Tab-slot, rivet, or weld per joint specification',
        canParallel: false,
      });
    }
  }

  return {
    totalSteps: allSteps.length,
    steps: allSteps,
    bendSequenceWarnings: allWarnings,
  };
}
