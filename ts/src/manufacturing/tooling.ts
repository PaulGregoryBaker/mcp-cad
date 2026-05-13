/**
 * ToolingCapability store.
 *
 * Task: T029
 */

export interface PressBrakeSpec {
  maxTonnage: number;
  maxBendLengthMm: number;
  vDieWidthsMm: number[];
  punchRadiiMm: number[];
}

export interface LaserSpec {
  maxKerfWidthMm: number;
  minHoleDiameterMm: number;
}

export interface ToolingCapability {
  pressBrake: PressBrakeSpec;
  laser: LaserSpec;
}
