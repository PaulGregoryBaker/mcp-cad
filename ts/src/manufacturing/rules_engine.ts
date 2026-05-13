/**
 * Manufacturing rule aggregation and scoring.
 *
 * Task: T050
 */

import type { FeatureSet } from './feature';
import type { ManufacturingConfig } from '../config/loader';
import { MaterialStore } from './material';
import { validateBend, validateFlange, validateHole, type RuleViolation } from './rules';

export interface RulesEngineResult {
  valid: boolean;
  violations: RuleViolation[];
}

export function validateFeatureSet(
  featureSet: FeatureSet,
  materialId: string,
  config: ManufacturingConfig,
): RulesEngineResult {
  const materials = new MaterialStore(config.materials);
  const material = materials.get(materialId);
  const tooling = config.tooling;

  const violations: RuleViolation[] = [];

  for (const bend of featureSet.bends) {
    const res = validateBend(bend, material, tooling);
    violations.push(...res.violations);
  }

  for (const hole of featureSet.holes) {
    const res = validateHole(hole, material, tooling);
    violations.push(...res.violations);
  }

  for (const flange of featureSet.flanges) {
    const res = validateFlange(flange, material, tooling);
    violations.push(...res.violations);
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
