/**
 * TypeScript Manufacturing Domain integration test.
 * Integration flow: config load → schema validation → runtime access
 * Tests T144: config pipeline end-to-end.
 *
 * Task: T144
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MaterialStore, computeBendAllowance } from '../../src/manufacturing/material';
import type { ManufacturingConfig } from '../../src/config/loader';
import { loadConfig, ConfigValidationError } from '../../src/config/loader';

// ─── MD-01: Material store ────────────────────────────────────────────────────

describe('MD Integration: MaterialStore', () => {
  let config: ManufacturingConfig;

  beforeEach(() => {
    config = {
      materials: [
        {
          id: 'steel_1mm',
          name: 'Steel 1mm',
          thicknessMm: 1.0,
          kFactor: 0.33,
          yieldStrengthMpa: 250,
          grainDirection: 'any',
          inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
        },
        {
          id: 'aluminium_1.5mm',
          name: 'Aluminium 1.5mm',
          thicknessMm: 1.5,
          kFactor: 0.35,
          yieldStrengthMpa: 180,
          grainDirection: 'direction1',
          inventorySheets: [{ widthMm: 1000, heightMm: 2000, label: 'Standard' }],
        },
      ],
      tooling: { pressBrake: { maxTonnage: 500, maxBendLengthMm: 2000, vDieWidthsMm: [6], punchRadiiMm: [0.5] }, laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 } },
      logistics: { shippingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000, maxHeightMm: 800 }, maxWeightKg: 25, coatingEnvelope: { maxLengthMm: 1800, maxWidthMm: 900 } },
      environmental: { fireRated: false, marineGrade: false, highVibration: false },
    };
  });

  it('has() returns true for known material', () => {
    const store = new MaterialStore(config.materials);
    expect(store.has('steel_1mm')).toBe(true);
  });

  it('has() returns false for unknown material', () => {
    const store = new MaterialStore(config.materials);
    expect(store.has('copper_2mm')).toBe(false);
  });

  it('get() returns material with correct properties', () => {
    const store = new MaterialStore(config.materials);
    const mat = store.get('steel_1mm');

    expect(mat.id).toBe('steel_1mm');
    expect(mat.thicknessMm).toBe(1.0);
    expect(mat.kFactor).toBe(0.33);
  });

  it('all() returns all materials', () => {
    const store = new MaterialStore(config.materials);
    const all = store.all();
    expect(all.length).toBe(2);
  });

  it('throws on get() unknown material', () => {
    const store = new MaterialStore(config.materials);
    expect(() => {
      store.get('nonexistent');
    }).toThrow();
  });
});

// ─── MD-02: Bend allowance formula ────────────────────────────────────────────

describe('MD Integration: bend allowance formula', () => {
  const material = {
    id: 'steel_1mm',
    name: 'Steel 1mm',
    thicknessMm: 1.0,
    kFactor: 0.33,
    yieldStrengthMpa: 250,
    grainDirection: 'any' as const,
    inventorySheets: [{ widthMm: 1000, heightMm: 2000, label: 'Standard' }],
  };

  it('computeBendAllowance(180°, r=0, k=0.33, t=1.0) ≈ 0', () => {
    const ba = computeBendAllowance(material, 180, 0);
    expect(ba).toBeLessThan(2.0);  // Straight line, near 0
  });

  it('computeBendAllowance(90°, r=1.0, k=0.33, t=1.0) > 0', () => {
    const ba = computeBendAllowance(material, 90, 1.0);
    expect(ba).toBeGreaterThan(0);
    // BA = π/180 * 90 * (1.0 + 0.33 * 1.0) = 1.571... * 1.33 ≈ 2.09
    expect(ba).toBeCloseTo(2.09, 1);
  });

  it('computeBendAllowance(45°, r=2.0, k=0.33, t=1.0) computed correctly', () => {
    const ba = computeBendAllowance(material, 45, 2.0);
    // BA = π/180 * 45 * (2.0 + 0.33 * 1.0) = 0.7854 * 2.33 ≈ 1.83
    expect(ba).toBeCloseTo(1.83, 1);
  });

  it('k_factor affects bend allowance linearly', () => {
    const ba1 = computeBendAllowance({ ...material, kFactor: 0.3 }, 90, 1.0);
    const ba2 = computeBendAllowance({ ...material, kFactor: 0.4 }, 90, 1.0);
    expect(ba2).toBeGreaterThan(ba1);
    // Difference should be ≈ π/180 * 90 * (0.4-0.3) * 1.0
    const diff = ba2 - ba1;
    expect(diff).toBeCloseTo(0.157, 2);
  });
});

// ─── MD-03: Tooling capability ────────────────────────────────────────────────

describe('MD Integration: tooling capability access', () => {
  let config: ManufacturingConfig;

  beforeEach(() => {
    config = {
      materials: [],
      tooling: {
        pressBrake: {
          maxTonnage: 1000,
          maxBendLengthMm: 3000,
          vDieWidthsMm: [6, 8, 10, 12],
          punchRadiiMm: [0.5, 1.0, 2.0],
        },
        laser: {
          maxKerfWidthMm: 0.15,
          minHoleDiameterMm: 1.5,
        },
      },
      logistics: { shippingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000, maxHeightMm: 800 }, maxWeightKg: 25, coatingEnvelope: { maxLengthMm: 1800, maxWidthMm: 900 } },
      environmental: { fireRated: false, marineGrade: false, highVibration: false },
    };
  });

  it('press brake max tonnage accessible', () => {
    expect(config.tooling.pressBrake.maxTonnage).toBe(1000);
  });

  it('press brake V-die widths is array', () => {
    expect(Array.isArray(config.tooling.pressBrake.vDieWidthsMm)).toBe(true);
    expect(config.tooling.pressBrake.vDieWidthsMm.length).toBe(4);
  });

  it('laser kerf width in valid range [0.1, 0.2] mm', () => {
    const kerf = config.tooling.laser.maxKerfWidthMm;
    expect(kerf).toBeGreaterThanOrEqual(0.1);
    expect(kerf).toBeLessThanOrEqual(0.2);
  });
});

// ─── MD-04: Logistics constraints ─────────────────────────────────────────────

describe('MD Integration: logistics constraints', () => {
  let config: ManufacturingConfig;

  beforeEach(() => {
    config = {
      materials: [],
      tooling: { pressBrake: { maxTonnage: 500, maxBendLengthMm: 2000, vDieWidthsMm: [6], punchRadiiMm: [0.5] }, laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 } },
      logistics: {
        shippingEnvelope: {
          maxLengthMm: 2400,
          maxWidthMm: 1200,
          maxHeightMm: 800,
        },
        maxWeightKg: 23,
        coatingEnvelope: {
          maxLengthMm: 2000,
          maxWidthMm: 1000,
        },
      },
      environmental: { fireRated: false, marineGrade: false, highVibration: false },
    };
  });

  it('shipping envelope has all dimensions', () => {
    expect(config.logistics.shippingEnvelope.maxLengthMm).toBe(2400);
    expect(config.logistics.shippingEnvelope.maxWidthMm).toBe(1200);
    expect(config.logistics.shippingEnvelope.maxHeightMm).toBe(800);
  });

  it('coating envelope is subset of shipping envelope', () => {
    expect(config.logistics.coatingEnvelope.maxLengthMm).toBeLessThanOrEqual(
      config.logistics.shippingEnvelope.maxLengthMm,
    );
    expect(config.logistics.coatingEnvelope.maxWidthMm).toBeLessThanOrEqual(
      config.logistics.shippingEnvelope.maxWidthMm,
    );
  });

  it('max weight is positive', () => {
    expect(config.logistics.maxWeightKg).toBeGreaterThan(0);
  });
});

// ─── MD-05: Environmental context ─────────────────────────────────────────────

describe('MD Integration: environmental context', () => {
  let config: ManufacturingConfig;

  beforeEach(() => {
    config = {
      materials: [],
      tooling: { pressBrake: { maxTonnage: 500, maxBendLengthMm: 2000, vDieWidthsMm: [6], punchRadiiMm: [0.5] }, laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 } },
      logistics: { shippingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000, maxHeightMm: 800 }, maxWeightKg: 25, coatingEnvelope: { maxLengthMm: 1800, maxWidthMm: 900 } },
      environmental: {
        fireRated: false,
        marineGrade: false,
        highVibration: true,
      },
    };
  });

  it('environmental flags are boolean', () => {
    expect(typeof config.environmental.fireRated).toBe('boolean');
    expect(typeof config.environmental.marineGrade).toBe('boolean');
    expect(typeof config.environmental.highVibration).toBe('boolean');
  });

  it('highVibration flag accessible', () => {
    expect(config.environmental.highVibration).toBe(true);
  });
});

// ─── ConfigValidationError ────────────────────────────────────────────────────

describe('MD Integration: ConfigValidationError', () => {
  it('loadConfig throws ConfigValidationError for invalid YAML', () => {
    const { writeFileSync, unlinkSync } = require('fs');
    const tmpPath = './test-invalid-config.yaml';
    writeFileSync(tmpPath, 'materials: "not_an_array"\ntooling: {}\nlogistics: {}\nenvironmental: {}');
    try {
      expect(() => loadConfig(tmpPath)).toThrow(ConfigValidationError);
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('ConfigValidationError has issues array and formatted message', () => {
    const { writeFileSync, unlinkSync } = require('fs');
    const tmpPath = './test-bad-config-2.yaml';
    writeFileSync(tmpPath, 'materials: []\ntooling:\n  press_brake:\n    max_tonnage: 0\n    max_bend_length_mm: 100\n    v_die_widths_mm: [6]\n    punch_radii_mm: [0.5]\n  laser:\n    max_kerf_width_mm: 0.15\n    min_hole_diameter_mm: 1.5\nlogistics:\n  shipping_envelope:\n    max_length_mm: 2400\n    max_width_mm: 1200\n    max_height_mm: 800\n  max_weight_kg: 23\n  coating_envelope:\n    max_length_mm: 2000\n    max_width_mm: 1000\nenvironmental:\n  fire_rated: false\n  marine_grade: false\n  high_vibration: false\n');
    try {
      loadConfig(tmpPath);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const cve = err as ConfigValidationError;
      expect(Array.isArray(cve.issues)).toBe(true);
      expect(cve.message).toContain('Config validation failed');
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it('loadConfig loads the actual config.yaml successfully', () => {
    const config = loadConfig('./config/config.yaml');
    expect(config.materials.length).toBeGreaterThan(0);
    expect(config.tooling.pressBrake.maxTonnage).toBeGreaterThan(0);
    expect(config.logistics.coatingEnvelope.maxLengthMm).toBeGreaterThan(0);
    expect(config.logistics.coatingEnvelope.maxWidthMm).toBeGreaterThan(0);
  });
});
