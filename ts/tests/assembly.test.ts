/**
 * Vitest tests for assembly instruction generator.
 *
 * Tasks: T098
 */

import { describe, it, expect } from 'vitest';
import { generateAssembly, generateMultiPartAssembly } from '../src/manufacturing/assembly';
import type { FeatureSet } from '../src/manufacturing/feature';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSimplePanel(shellId: string): FeatureSet {
  return {
    shellId,
    bends: [
      { featureId: 'bend-0', angleDeg: 90, radiusMm: 3.0, lengthMm: 100, kFactor: 0.33, bendAllowanceMm: 5.17, faceIds: ['face-0', 'face-1'] },
      { featureId: 'bend-1', angleDeg: 45, radiusMm: 3.0, lengthMm: 80, kFactor: 0.33, bendAllowanceMm: 2.58, faceIds: ['face-2', 'face-3'] },
    ],
    holes: [
      { featureId: 'hole-0', centerX: 50, centerY: 50, diameterMm: 8.0, throughHole: true, faceId: 'face-top' },
    ],
    flanges: [
      { featureId: 'flange-0', widthMm: 20, lengthMm: 100, adjacentBendId: 'bend-0', faceId: 'face-flange-a' },
    ],
    reliefs: [
      { featureId: 'relief-0', type: 'dogbone', radiusMm: 3.0, locationX: 10, locationY: 10 },
    ],
  };
}

function makeNoBendPanel(shellId: string): FeatureSet {
  return {
    shellId,
    bends: [],
    holes: [],
    flanges: [],
    reliefs: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateAssembly (single panel)', () => {
  it('ASM-01: holes appear before bends in step sequence', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    // Find first hole step and first bend step
    const firstHoleIdx = result.steps.findIndex((s) => s.operation === 'punch_hole' && !s.description.includes('relief'));
    const firstBendIdx = result.steps.findIndex((s) => s.operation === 'bend');

    expect(firstHoleIdx).toBeGreaterThanOrEqual(0);
    expect(firstBendIdx).toBeGreaterThan(firstHoleIdx);
  });

  it('ASM-02: reliefs appear before bends', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    const reliefStepIdx = result.steps.findIndex(
      (s) => s.operation === 'punch_hole' && s.description.toLowerCase().includes('relief'),
    );
    const firstBendIdx = result.steps.findIndex((s) => s.operation === 'bend');

    expect(reliefStepIdx).toBeGreaterThanOrEqual(0);
    expect(firstBendIdx).toBeGreaterThan(reliefStepIdx);
  });

  it('ASM-03: bends are ordered outside-in (largest angle first)', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    const bendSteps = result.steps.filter((s) => s.operation === 'bend');
    expect(bendSteps).toHaveLength(2);
    // Outside-in: 90° then 45°
    expect(bendSteps[0]!.description).toContain('90°');
    expect(bendSteps[1]!.description).toContain('45°');
  });

  it('ASM-04: step indices are sequential starting from 0', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    result.steps.forEach((step, i) => {
      expect(step.stepIndex).toBe(i);
    });
  });

  it('ASM-05: totalSteps matches steps array length', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    expect(result.totalSteps).toBe(result.steps.length);
  });

  it('ASM-06: empty panel yields zero steps', () => {
    const fs = makeNoBendPanel('shell-empty');
    const result = generateAssembly(fs);

    expect(result.totalSteps).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.bendSequenceWarnings).toHaveLength(0);
  });

  it('ASM-07: partId on all steps matches shellId', () => {
    const fs = makeSimplePanel('shell-abc');
    const result = generateAssembly(fs);

    for (const step of result.steps) {
      expect(step.partId).toBe('shell-abc');
    }
  });

  it('ASM-08: toolingHint is non-empty for all steps', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);

    for (const step of result.steps) {
      expect(step.toolingHint).toBeTruthy();
    }
  });
});

describe('generateMultiPartAssembly', () => {
  it('ASM-09: multi-part step count is sum of all parts + join steps', () => {
    const fs1 = makeSimplePanel('shell-1');
    const fs2 = makeSimplePanel('shell-2');

    const single1 = generateAssembly(fs1);
    const single2 = generateAssembly(fs2);
    const multi = generateMultiPartAssembly([fs1, fs2]);

    // Each part with flanges adds 1 join step
    const expectedSteps = single1.totalSteps + 1 + single2.totalSteps + 1;
    expect(multi.totalSteps).toBe(expectedSteps);
  });

  it('ASM-10: multi-part step indices are globally sequential', () => {
    const panels = ['shell-1', 'shell-2', 'shell-3'].map(makeSimplePanel);
    const result = generateMultiPartAssembly(panels);

    result.steps.forEach((step, i) => {
      expect(step.stepIndex).toBe(i);
    });
  });

  it('ASM-11: JSON serialization round-trips correctly', () => {
    const fs = makeSimplePanel('shell-1');
    const result = generateAssembly(fs);
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json) as typeof result;

    expect(parsed.totalSteps).toBe(result.totalSteps);
    expect(parsed.steps).toHaveLength(result.steps.length);
  });
});
