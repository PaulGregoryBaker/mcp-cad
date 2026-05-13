/**
 * Unit tests for manufacturability.ts — scorePanel() accuracy and edge cases.
 *
 * Tests MF-04 (empty feature set), MF-05 (tonnage overload), MF-06 (hole too small).
 * Core MF-01, MF-02, MF-03 tests live in bend_sequence.test.ts (co-located with bend scoring).
 *
 * Tasks: T079
 */

import { describe, it, expect } from 'vitest';
import { scorePanel } from '../src/manufacturing/manufacturability';
import type { FeatureSet } from '../src/manufacturing/feature';
import type { MaterialSpec } from '../src/manufacturing/material';
import type { ToolingCapability } from '../src/manufacturing/tooling';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const material: MaterialSpec = {
  id: 'mild_steel_1.5mm',
  name: 'Mild Steel 1.5mm',
  thicknessMm: 1.5,
  kFactor: 0.33,
  yieldStrengthMpa: 250,
  grainDirection: 'any',
  inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
};

const tooling: ToolingCapability = {
  pressBrake: { maxTonnage: 80, maxBendLengthMm: 2000, vDieWidthsMm: [6, 8], punchRadiiMm: [1.5, 2.0] },
  laser: { minHoleDiameterMm: 2.0, maxKerfWidthMm: 0.1 },
};

// ─── MF-04: Empty feature set ─────────────────────────────────────────────────

describe('scorePanel: MF-04 empty feature set', () => {
  it('returns score 1.0 for a feature set with no features', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-empty',
      bends: [],
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);

    expect(report.score).toBe(1.0);
    expect(report.feasible).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('summary reflects zero checks', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-empty',
      bends: [],
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);
    expect(report.summary.totalChecks).toBe(0);
    expect(report.summary.errorCount).toBe(0);
    expect(report.summary.warningCount).toBe(0);
  });
});

// ─── MF-05: Tonnage overload ──────────────────────────────────────────────────

describe('scorePanel: MF-05 press brake tonnage overload', () => {
  it('detects PRESS_BRAKE_TONNAGE violation for very long thick bends', () => {
    // tonnage_estimate = (lengthMm × thicknessMm × yieldStrength) / 5000
    // = (10000 × 1.5 × 250) / 5000 = 750 > maxTonnage=80
    const featureSet: FeatureSet = {
      shellId: 'shell-heavy',
      bends: [{
        featureId: 'b-heavy',
        angleDeg: 90,
        radiusMm: 2.0,
        lengthMm: 10000,  // very long bend → huge tonnage
        kFactor: 0.33,
        bendAllowanceMm: 3.1,
        faceIds: ['f1'],
      }],
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);
    expect(report.violations.some(v => v.ruleCode === 'PRESS_BRAKE_TONNAGE')).toBe(true);
  });
});

// ─── MF-06: Hole too small ────────────────────────────────────────────────────

describe('scorePanel: MF-06 hole diameter below minimum', () => {
  it('detects MIN_HOLE_DIAMETER violation for tiny holes', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-holes',
      bends: [],
      holes: [{
        featureId: 'h-tiny',
        centerX: 50,
        centerY: 50,
        diameterMm: 0.5,  // below minHoleDiameterMm=2.0 and thicknessMm×factor=1.5
        throughHole: true,
        faceId: 'face1',
      }],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);
    expect(report.violations.some(v => v.ruleCode === 'MIN_HOLE_DIAMETER')).toBe(true);
  });
});
