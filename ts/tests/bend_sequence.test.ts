/**
 * Unit tests for bend_sequence.ts and manufacturability.ts.
 * Tests BS-01 (empty input), BS-02 (no collisions), BS-03 (collision ordering),
 *       MF-01 (perfect score), MF-02 (violations reduce score), MF-03 (threshold).
 *
 * Tasks: T075, T077
 */

import { describe, it, expect } from 'vitest';
import { validateBendSequence } from '../src/manufacturing/bend_sequence';
import { scorePanel } from '../src/manufacturing/manufacturability';
import type { BendFeature, FlangeFeature, FeatureSet } from '../src/manufacturing/feature';
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

function makeBend(id: string, angleDeg: number, radiusMm = 2.0): BendFeature {
  return {
    featureId: id,
    angleDeg,
    radiusMm,
    lengthMm: 100,
    kFactor: 0.33,
    bendAllowanceMm: (Math.PI / 180) * angleDeg * (radiusMm + 0.33 * 1.5),
    faceIds: [id + '-face'],
  };
}

function makeFlange(id: string, bendId: string, faceId: string): FlangeFeature {
  return { featureId: id, widthMm: 20, lengthMm: 100, adjacentBendId: bendId, faceId };
}

// ─── BS-01: Empty bend list ────────────────────────────────────────────────────

describe('validateBendSequence: BS-01 empty input', () => {
  it('returns feasible with empty sequence for zero bends', () => {
    const result = validateBendSequence([], []);
    expect(result.feasible).toBe(true);
    expect(result.sequence).toHaveLength(0);
    expect(result.collisionWarnings).toHaveLength(0);
  });
});

// ─── BS-02: No shared faces ────────────────────────────────────────────────────

describe('validateBendSequence: BS-02 independent bends', () => {
  it('returns all steps canParallel=true when no faces are shared', () => {
    const bends = [makeBend('b1', 90), makeBend('b2', 45)];
    // Flanges with distinct face IDs
    const flanges = [
      makeFlange('f1', 'b1', 'face-A'),
      makeFlange('f2', 'b2', 'face-B'),
    ];

    const result = validateBendSequence(bends, flanges);

    expect(result.feasible).toBe(true);
    expect(result.collisionWarnings).toHaveLength(0);
    expect(result.sequence.every(s => s.canParallel)).toBe(true);
  });

  it('orders bends largest angle first (outside-in)', () => {
    const bends = [makeBend('b1', 30), makeBend('b2', 90), makeBend('b3', 60)];
    const result = validateBendSequence(bends, []);

    const angles = result.sequence.map(s => s.angleDeg);
    expect(angles).toEqual([90, 60, 30]);
  });
});

// ─── BS-03: Shared faces trigger collision warning ─────────────────────────────

describe('validateBendSequence: BS-03 collision ordering', () => {
  it('emits collision warning when two flanges share a face', () => {
    const bends = [makeBend('b1', 90), makeBend('b2', 45)];
    const flanges = [
      makeFlange('f1', 'b1', 'shared-face'),
      makeFlange('f2', 'b2', 'shared-face'), // same face!
    ];

    const result = validateBendSequence(bends, flanges);

    expect(result.collisionWarnings).toHaveLength(1);
    expect(result.collisionWarnings[0].sharedFaceId).toBe('shared-face');
  });

  it('marks colliding bends as canParallel=false', () => {
    const bends = [makeBend('b1', 90), makeBend('b2', 45)];
    const flanges = [
      makeFlange('f1', 'b1', 'shared-face'),
      makeFlange('f2', 'b2', 'shared-face'),
    ];

    const result = validateBendSequence(bends, flanges);

    const step = result.sequence.find(s => s.bendFeatureId === 'b1');
    expect(step?.canParallel).toBe(false);
  });
});

// ─── MF-01: Perfect score ─────────────────────────────────────────────────────

describe('scorePanel: MF-01 perfect score', () => {
  it('returns score 1.0 for a fully valid feature set', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-001',
      bends: [makeBend('b1', 90, 2.0)],
      holes: [{ featureId: 'h1', centerX: 50, centerY: 50, diameterMm: 5.0, throughHole: true, faceId: 'f1' }],
      flanges: [makeFlange('fl1', 'b1', 'face-A')],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);

    expect(report.score).toBe(1.0);
    expect(report.feasible).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

// ─── MF-02: Violations reduce score ──────────────────────────────────────────

describe('scorePanel: MF-02 violations reduce score', () => {
  it('score < 1.0 when a bend radius is too small', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-002',
      bends: [makeBend('b1', 90, 0.1)], // radiusMm=0.1 < min 1.5
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);

    expect(report.score).toBeLessThan(1.0);
    expect(report.violations.some(v => v.ruleCode === 'MIN_BEND_RADIUS')).toBe(true);
  });

  it('score drops further with more violations', () => {
    // Mix of bad (radiusMm=0.1) and good bends so the ratio differs
    const featureSet: FeatureSet = {
      shellId: 'shell-003',
      bends: [makeBend('b1', 90, 0.1), makeBend('b2', 90, 0.1), makeBend('b3', 90, 2.0)], // 2 bad, 1 good
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const featureSetOne: FeatureSet = {
      shellId: 'shell-004',
      bends: [makeBend('b1', 90, 0.1), makeBend('b2', 90, 2.0)], // 1 bad, 1 good
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const reportTwo = scorePanel(featureSet, material, tooling);
    const reportOne = scorePanel(featureSetOne, material, tooling);

    expect(reportTwo.score).toBeLessThan(reportOne.score);
  });
});

// ─── MF-03: Feasibility threshold ────────────────────────────────────────────

describe('scorePanel: MF-03 feasibility threshold', () => {
  it('feasible=false when score is below 0.7', () => {
    // Create many bad bends to drive score below threshold
    const bads = Array.from({ length: 10 }, (_, i) => makeBend(`b${i}`, 90, 0.1));
    const featureSet: FeatureSet = {
      shellId: 'shell-005',
      bends: bads,
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);
    expect(report.feasible).toBe(false);
  });

  it('includes bend sequence result in report', () => {
    const featureSet: FeatureSet = {
      shellId: 'shell-006',
      bends: [makeBend('b1', 90), makeBend('b2', 45)],
      holes: [],
      flanges: [],
      reliefs: [],
    };

    const report = scorePanel(featureSet, material, tooling);
    expect(report.bendSequence).toBeDefined();
    expect(report.bendSequence.sequence).toHaveLength(2);
  });
});
