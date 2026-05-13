/**
 * Manufacturability scoring.
 *
 * Aggregates all rule violations across a FeatureSet into a normalised score:
 *   1.0 = fully manufacturable, 0.0 = completely infeasible.
 *
 * Score formula:
 *   score = 1.0 - (errorCount + 0.5 × warningCount) / totalRuleChecks
 *   clamped to [0.0, 1.0]
 *
 * Tasks: T076, T077
 */

import type { FeatureSet } from './feature';
import type { MaterialSpec } from './material';
import type { ToolingCapability } from './tooling';
import type { RuleViolation, ValidationResult } from './rules';
import { validateBend, validateHole, validateFlange } from './rules';
import { validateBendSequence } from './bend_sequence';
import type { BendSequenceResult } from './bend_sequence';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ManufacturabilityReport {
  score: number;              // 0.0 – 1.0
  feasible: boolean;          // true when score >= 0.7 (configurable threshold)
  violations: RuleViolation[];
  bendSequence: BendSequenceResult;
  summary: {
    totalChecks: number;
    errorCount: number;
    warningCount: number;
  };
}

// ─── Score threshold ──────────────────────────────────────────────────────────

const FEASIBILITY_THRESHOLD = 0.7;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a complete FeatureSet against manufacturing constraints.
 *
 * @param featureSet  - Extracted features for one shell.
 * @param material    - Material specification from config.
 * @param tooling     - Tooling capability from config.
 * @returns           - ManufacturabilityReport with score, violations, and bend sequence.
 */
export function scorePanel(
  featureSet: FeatureSet,
  material: MaterialSpec,
  tooling: ToolingCapability,
): ManufacturabilityReport {
  const allViolations: RuleViolation[] = [];
  let totalChecks = 0;

  // Validate bends
  for (const bend of featureSet.bends) {
    totalChecks++;
    const result: ValidationResult = validateBend(bend, material, tooling);
    allViolations.push(...result.violations);
  }

  // Validate holes
  for (const hole of featureSet.holes) {
    totalChecks++;
    const result: ValidationResult = validateHole(hole, material, tooling);
    allViolations.push(...result.violations);
  }

  // Validate flanges
  for (const flange of featureSet.flanges) {
    totalChecks++;
    const result: ValidationResult = validateFlange(flange, material, tooling);
    allViolations.push(...result.violations);
  }

  // Bend sequence feasibility
  const bendSequence = validateBendSequence(featureSet.bends, featureSet.flanges);
  if (!bendSequence.feasible) {
    allViolations.push({
      ruleCode: 'INFEASIBLE_BEND_SEQUENCE',
      severity: 'error',
      featureId: '',
      description: 'No collision-free bend sequence could be determined.',
    });
    totalChecks++;
  }

  // Score calculation
  const errorCount   = allViolations.filter(v => v.severity === 'error').length;
  const warningCount = allViolations.filter(v => v.severity === 'warning').length;

  const effectiveChecks = Math.max(totalChecks, 1);
  const rawScore = 1.0 - (errorCount + 0.5 * warningCount) / effectiveChecks;
  const score = Math.max(0.0, Math.min(1.0, rawScore));

  return {
    score,
    feasible: score >= FEASIBILITY_THRESHOLD,
    violations: allViolations,
    bendSequence,
    summary: { totalChecks, errorCount, warningCount },
  };
}
