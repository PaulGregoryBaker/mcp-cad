import { describe, expect, it } from 'vitest';
import type { FeatureSet, BendFeature, HoleFeature, FlangeFeature } from '../src/manufacturing/feature';
import type { ManufacturingConfig } from '../src/config/loader';
import {
  MANUFACTURING_RULES,
  isJointTypeAllowed,
  validateBend,
  validateFlange,
  validateHole,
} from '../src/manufacturing/rules';
import { validateFeatureSet } from '../src/manufacturing/rules_engine';

const config: ManufacturingConfig = {
  materials: [
    {
      id: 'mild_steel_1.5mm',
      name: 'Mild Steel',
      thicknessMm: 1.5,
      kFactor: 0.33,
      yieldStrengthMpa: 250,
      grainDirection: 'any',
      inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8' }],
    },
  ],
  tooling: {
    pressBrake: {
      maxTonnage: 500,
      maxBendLengthMm: 2500,
      vDieWidthsMm: [6, 8, 10],
      punchRadiiMm: [0.5, 1.0],
    },
    laser: {
      maxKerfWidthMm: 0.15,
      minHoleDiameterMm: 1.5,
    },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 23,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

function bend(overrides: Partial<BendFeature> = {}): BendFeature {
  return {
    featureId: 'b1',
    angleDeg: 90,
    radiusMm: 2,
    lengthMm: 100,
    kFactor: 0.33,
    bendAllowanceMm: 2.0,
    faceIds: ['f1', 'f2'],
    ...overrides,
  };
}

function hole(overrides: Partial<HoleFeature> = {}): HoleFeature {
  return {
    featureId: 'h1',
    centerX: 10,
    centerY: 20,
    diameterMm: 2,
    throughHole: true,
    faceId: 'f1',
    ...overrides,
  };
}

function flange(overrides: Partial<FlangeFeature> = {}): FlangeFeature {
  return {
    featureId: 'fl1',
    widthMm: 10,
    lengthMm: 100,
    adjacentBendId: 'b1',
    faceId: 'f3',
    ...overrides,
  };
}

describe('manufacturing rules', () => {
  const material = config.materials[0];

  it('exposes kerf range constants', () => {
    expect(MANUFACTURING_RULES.KERF_OFFSET_MIN_MM).toBe(0.1);
    expect(MANUFACTURING_RULES.KERF_OFFSET_MAX_MM).toBe(0.2);
  });

  it('validateBend flags radius below thickness', () => {
    const res = validateBend(bend({ radiusMm: 0.5 }), material, config.tooling);
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.ruleCode === 'MIN_BEND_RADIUS')).toBe(true);
  });

  it('validateHole flags diameter below minimum', () => {
    const res = validateHole(hole({ diameterMm: 1.0 }), material, config.tooling);
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.ruleCode === 'MIN_HOLE_DIAMETER')).toBe(true);
  });

  it('validateFlange flags width below minimum', () => {
    const res = validateFlange(flange({ widthMm: 2 }), material, config.tooling);
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.ruleCode === 'MIN_FLANGE_WIDTH')).toBe(true);
  });

  it('isJointTypeAllowed blocks adhesive in fire-rated context', () => {
    const res = isJointTypeAllowed('adhesive', {
      fireRated: true,
      marineGrade: false,
      highVibration: false,
    });
    expect(res.allowed).toBe(false);
    expect(res.overrideable).toBe(false);
  });

  it('isJointTypeAllowed allows tab_slot in restrictive contexts', () => {
    const res = isJointTypeAllowed('tab_slot', {
      fireRated: true,
      marineGrade: true,
      highVibration: true,
    });
    expect(res.allowed).toBe(true);
  });

  it('isJointTypeAllowed blocks adhesive in marine-grade context', () => {
    const res = isJointTypeAllowed('adhesive', {
      fireRated: false,
      marineGrade: true,
      highVibration: false,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/marine/i);
  });

  it('isJointTypeAllowed blocks plastic_fastener in high-vibration context', () => {
    const res = isJointTypeAllowed('plastic_fastener', {
      fireRated: false,
      marineGrade: false,
      highVibration: true,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/high-vibration/i);
  });

  it('validateFlange flags MAX_FLANGE_LENGTH when length exceeds press brake limit', () => {
    // maxBendLengthMm in config is 2500; use a flange longer than that
    const longFlange = flange({ lengthMm: 3000 });
    const res = validateFlange(longFlange, config.materials[0], config.tooling);
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.ruleCode === 'MAX_FLANGE_LENGTH')).toBe(true);
  });

  it('validateFeatureSet aggregates violations from bends/holes/flanges', () => {
    const fs: FeatureSet = {
      shellId: 'shell1',
      bends: [bend({ radiusMm: 0.5 })],
      holes: [hole({ diameterMm: 1.0 })],
      flanges: [flange({ widthMm: 2 })],
      reliefs: [],
    };

    const res = validateFeatureSet(fs, 'mild_steel_1.5mm', config);
    expect(res.valid).toBe(false);
    expect(res.violations.length).toBeGreaterThanOrEqual(3);
  });
});
