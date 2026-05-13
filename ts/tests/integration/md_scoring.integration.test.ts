/**
 * BC Integration test: Manufacturing Domain Phase C — bend sequence + scoring.
 *
 * Tests MD-JTBD-02, MD-JTBD-05:
 *   - FeatureSet with known violations → scorePanel → score < 0.5, violations match rule codes
 *   - Passing FeatureSet → score > 0.9
 *   - Bend sequence integration with scoring report
 *
 * Task: T153
 */

import { describe, it, expect } from 'vitest';
import { scorePanel } from '../../src/manufacturing/manufacturability';
import type { FeatureSet } from '../../src/manufacturing/feature';
import type { MaterialSpec } from '../../src/manufacturing/material';
import type { ToolingCapability } from '../../src/manufacturing/tooling';
import { loadConfig } from '../../src/config/loader';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load real config for integration-level accuracy ─────────────────────────

const configPath = path.join(__dirname, '../../../config/config.yaml');
let config: Awaited<ReturnType<typeof loadConfig>>;
try {
  config = loadConfig(configPath);
} catch {
  // fallback if config unavailable in CI
  config = null as unknown as typeof config;
}

const material: MaterialSpec = config?.materials?.[0] ?? {
  id: 'mild_steel_1.5mm',
  name: 'Mild Steel 1.5mm',
  thicknessMm: 1.5,
  kFactor: 0.33,
  yieldStrengthMpa: 250,
  grainDirection: 'any',
  inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
};

const tooling: ToolingCapability = config?.tooling ?? {
  pressBrake: { maxTonnage: 500, maxBendLengthMm: 2500, vDieWidthsMm: [6, 8], punchRadiiMm: [0.5, 1.0] },
  laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeViolatingFeatureSet(): FeatureSet {
  return {
    shellId: 'shell-violations',
    bends: [
      // Bend 1: radius too small, tonnage OK
      { featureId: 'b1', angleDeg: 90, radiusMm: 0.1, lengthMm: 100, kFactor: 0.33, bendAllowanceMm: 0.5, faceIds: ['f1'] },
      // Bend 2: radius too small, large tonnage (long bend)
      { featureId: 'b2', angleDeg: 90, radiusMm: 0.1, lengthMm: 5000, kFactor: 0.33, bendAllowanceMm: 0.5, faceIds: ['f2'] },
      // Bend 3: angle out of range
      { featureId: 'b3', angleDeg: -5, radiusMm: 2.0, lengthMm: 100, kFactor: 0.33, bendAllowanceMm: 0.5, faceIds: ['f3'] },
    ],
    holes: [
      // Hole: too small
      { featureId: 'h1', centerX: 50, centerY: 50, diameterMm: 0.3, throughHole: true, faceId: 'face1' },
    ],
    flanges: [
      // Flange: too narrow
      { featureId: 'fl1', widthMm: 1.0, lengthMm: 100, adjacentBendId: 'b1', faceId: 'face2' },
    ],
    reliefs: [],
  };
}

function makePassingFeatureSet(): FeatureSet {
  return {
    shellId: 'shell-passing',
    bends: [
      { featureId: 'b1', angleDeg: 90, radiusMm: 2.0, lengthMm: 200, kFactor: 0.33, bendAllowanceMm: 3.1, faceIds: ['f1'] },
      { featureId: 'b2', angleDeg: 45, radiusMm: 3.0, lengthMm: 150, kFactor: 0.33, bendAllowanceMm: 2.4, faceIds: ['f2'] },
    ],
    holes: [
      { featureId: 'h1', centerX: 50, centerY: 50, diameterMm: 6.0, throughHole: true, faceId: 'face1' },
    ],
    flanges: [
      { featureId: 'fl1', widthMm: 20.0, lengthMm: 200, adjacentBendId: 'b1', faceId: 'face3' },
    ],
    reliefs: [],
  };
}

// ─── MD-JTBD-02: Violations detected ─────────────────────────────────────────

describe('MD Scoring Integration: MD-JTBD-02 violations', () => {
  it('score < 0.5 for heavily violating feature set', () => {
    const report = scorePanel(makeViolatingFeatureSet(), material, tooling);
    expect(report.score).toBeLessThan(0.5);
  });

  it('feasible=false for heavily violating feature set', () => {
    const report = scorePanel(makeViolatingFeatureSet(), material, tooling);
    expect(report.feasible).toBe(false);
  });

  it('detects MIN_BEND_RADIUS violations', () => {
    const report = scorePanel(makeViolatingFeatureSet(), material, tooling);
    const radiusViolations = report.violations.filter(v => v.ruleCode === 'MIN_BEND_RADIUS');
    expect(radiusViolations.length).toBeGreaterThanOrEqual(2);
  });

  it('detects MIN_HOLE_DIAMETER violation', () => {
    const report = scorePanel(makeViolatingFeatureSet(), material, tooling);
    expect(report.violations.some(v => v.ruleCode === 'MIN_HOLE_DIAMETER')).toBe(true);
  });

  it('detects MIN_FLANGE_WIDTH violation', () => {
    const report = scorePanel(makeViolatingFeatureSet(), material, tooling);
    expect(report.violations.some(v => v.ruleCode === 'MIN_FLANGE_WIDTH')).toBe(true);
  });
});

// ─── MD-JTBD-05: Passing feature set ─────────────────────────────────────────

describe('MD Scoring Integration: MD-JTBD-05 passing feature set', () => {
  it('score > 0.9 for fully valid feature set', () => {
    const report = scorePanel(makePassingFeatureSet(), material, tooling);
    expect(report.score).toBeGreaterThan(0.9);
  });

  it('feasible=true for valid feature set', () => {
    const report = scorePanel(makePassingFeatureSet(), material, tooling);
    expect(report.feasible).toBe(true);
  });

  it('violations array is empty for valid feature set', () => {
    const report = scorePanel(makePassingFeatureSet(), material, tooling);
    expect(report.violations).toHaveLength(0);
  });

  it('bend sequence is feasible for valid feature set', () => {
    const report = scorePanel(makePassingFeatureSet(), material, tooling);
    expect(report.bendSequence.feasible).toBe(true);
    expect(report.bendSequence.sequence).toHaveLength(2);
  });

  it('outside-in order: 90deg bend before 45deg bend', () => {
    const report = scorePanel(makePassingFeatureSet(), material, tooling);
    const seq = report.bendSequence.sequence;
    expect(seq[0]!.angleDeg).toBeGreaterThan(seq[1]!.angleDeg);
  });
});
