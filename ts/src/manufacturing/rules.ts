/**
 * Manufacturing rule definitions and validators.
 *
 * Tasks: T049, T052, T053
 */

import type { BendFeature, FlangeFeature, HoleFeature } from './feature';
import type { EnvironmentalContext } from './environmental';
import type { MaterialSpec } from './material';
import type { ToolingCapability } from './tooling';

export type JointType = 'tab_slot' | 'rivet' | 'weld' | 'adhesive' | 'plastic_fastener';

export interface RuleViolation {
  ruleCode: string;
  severity: 'error' | 'warning';
  featureId: string;
  description: string;
  measuredValueMm?: number;
  limitValueMm?: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: RuleViolation[];
}

export interface SafetyFilterResult {
  allowed: boolean;
  reason?: string;
  overrideable: boolean;
}

export const MANUFACTURING_RULES = {
  MIN_HOLE_DIAMETER_FACTOR: 1.0,
  MIN_FLANGE_WIDTH_FACTOR: 4.0,
  MIN_BEND_RADIUS_FACTOR: 1.0,
  MAX_BEND_ANGLE_DEG: 180,
  KERF_OFFSET_MIN_MM: 0.1,
  KERF_OFFSET_MAX_MM: 0.2,
} as const;

export function validateBend(
  feature: BendFeature,
  material: MaterialSpec,
  tooling: ToolingCapability,
): ValidationResult {
  const violations: RuleViolation[] = [];

  const minRadius = material.thicknessMm * MANUFACTURING_RULES.MIN_BEND_RADIUS_FACTOR;
  if (feature.radiusMm < minRadius) {
    violations.push({
      ruleCode: 'MIN_BEND_RADIUS',
      severity: 'error',
      featureId: feature.featureId,
      description: `Bend radius ${feature.radiusMm}mm is below minimum ${minRadius}mm`,
      measuredValueMm: feature.radiusMm,
      limitValueMm: minRadius,
    });
  }

  if (feature.angleDeg > MANUFACTURING_RULES.MAX_BEND_ANGLE_DEG || feature.angleDeg < 0) {
    violations.push({
      ruleCode: 'MAX_BEND_ANGLE',
      severity: 'error',
      featureId: feature.featureId,
      description: `Bend angle ${feature.angleDeg}deg is outside [0, ${MANUFACTURING_RULES.MAX_BEND_ANGLE_DEG}]`,
    });
  }

  const tonnageEstimate = (feature.lengthMm * material.thicknessMm * material.yieldStrengthMpa) / 5000;
  if (tonnageEstimate > tooling.pressBrake.maxTonnage) {
    violations.push({
      ruleCode: 'PRESS_BRAKE_TONNAGE',
      severity: 'error',
      featureId: feature.featureId,
      description: `Estimated tonnage ${tonnageEstimate.toFixed(2)} exceeds tooling max ${tooling.pressBrake.maxTonnage}`,
    });
  }

  return { valid: violations.length === 0, violations };
}

export function validateHole(
  feature: HoleFeature,
  material: MaterialSpec,
  tooling: ToolingCapability,
): ValidationResult {
  const violations: RuleViolation[] = [];

  const minHole = Math.max(
    material.thicknessMm * MANUFACTURING_RULES.MIN_HOLE_DIAMETER_FACTOR,
    tooling.laser.minHoleDiameterMm,
  );

  if (feature.diameterMm < minHole) {
    violations.push({
      ruleCode: 'MIN_HOLE_DIAMETER',
      severity: 'error',
      featureId: feature.featureId,
      description: `Hole diameter ${feature.diameterMm}mm is below minimum ${minHole}mm`,
      measuredValueMm: feature.diameterMm,
      limitValueMm: minHole,
    });
  }

  return { valid: violations.length === 0, violations };
}

export function validateFlange(
  feature: FlangeFeature,
  material: MaterialSpec,
  tooling?: ToolingCapability,
): ValidationResult {
  const violations: RuleViolation[] = [];

  const minWidth = material.thicknessMm * MANUFACTURING_RULES.MIN_FLANGE_WIDTH_FACTOR;
  if (feature.widthMm < minWidth) {
    violations.push({
      ruleCode: 'MIN_FLANGE_WIDTH',
      severity: 'error',
      featureId: feature.featureId,
      description: `Flange width ${feature.widthMm}mm is below minimum ${minWidth}mm`,
      measuredValueMm: feature.widthMm,
      limitValueMm: minWidth,
    });
  }

  if (tooling !== undefined && feature.lengthMm > tooling.pressBrake.maxBendLengthMm) {
    violations.push({
      ruleCode: 'MAX_FLANGE_LENGTH',
      severity: 'error',
      featureId: feature.featureId,
      description: `Flange length ${feature.lengthMm}mm exceeds max bend length ${tooling.pressBrake.maxBendLengthMm}mm`,
      measuredValueMm: feature.lengthMm,
      limitValueMm: tooling.pressBrake.maxBendLengthMm,
    });
  }

  return { valid: violations.length === 0, violations };
}

export function isJointTypeAllowed(
  jointType: JointType,
  env: EnvironmentalContext,
): SafetyFilterResult {
  if (env.fireRated && (jointType === 'adhesive' || jointType === 'plastic_fastener')) {
    return {
      allowed: false,
      reason: `Joint type '${jointType}' is blocked for fire-rated context`,
      overrideable: false,
    };
  }

  if (env.marineGrade && jointType === 'adhesive') {
    return {
      allowed: false,
      reason: "Joint type 'adhesive' is blocked for marine-grade context",
      overrideable: false,
    };
  }

  if (env.highVibration && (jointType === 'adhesive' || jointType === 'plastic_fastener')) {
    return {
      allowed: false,
      reason: `Joint type '${jointType}' is blocked for high-vibration context`,
      overrideable: false,
    };
  }

  return { allowed: true, overrideable: false };
}
