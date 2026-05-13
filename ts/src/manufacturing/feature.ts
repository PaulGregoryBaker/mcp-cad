/**
 * Feature entity definitions for the Manufacturing Domain.
 * These types mirror the C++ ACL FeatureSet structs.
 *
 * Task: T055
 */

export interface BendFeature {
  featureId: string;
  angleDeg: number;
  radiusMm: number;
  lengthMm: number;
  kFactor: number;
  bendAllowanceMm: number;
  faceIds: string[];
}

export interface HoleFeature {
  featureId: string;
  centerX: number;
  centerY: number;
  diameterMm: number;
  throughHole: boolean;
  faceId: string;
}

export interface FlangeFeature {
  featureId: string;
  widthMm: number;
  lengthMm: number;
  adjacentBendId: string;
  faceId: string;
}

export interface ReliefFeature {
  featureId: string;
  type: 'dogbone' | 'circular';
  radiusMm: number;
  locationX: number;
  locationY: number;
}

export interface FeatureSet {
  shellId: string;
  bends: BendFeature[];
  holes: HoleFeature[];
  flanges: FlangeFeature[];
  reliefs: ReliefFeature[];
}
