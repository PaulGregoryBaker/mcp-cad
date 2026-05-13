/**
 * Vitest tests for BOM generator.
 *
 * Tasks: T097
 */

import { describe, it, expect } from 'vitest';
import { generateBOM, generateMultiPartBOM } from '../src/manufacturing/bom';
import type { FeatureSet } from '../src/manufacturing/feature';
import type { MaterialSpec } from '../src/manufacturing/material';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MILD_STEEL: MaterialSpec = {
  id: 'ms-1.5',
  name: 'Mild Steel 1.5mm',
  thicknessMm: 1.5,
  kFactor: 0.33,
  yieldStrengthMpa: 250,
  grainDirection: 'any',
  inventorySheets: [{ widthMm: 2440, heightMm: 1220, label: 'full' }],
};

function makeFeatureSet(shellId: string, bendCount = 2): FeatureSet {
  const bends = Array.from({ length: bendCount }, (_, i) => ({
    featureId: `bend-${i}`,
    angleDeg: 90,
    radiusMm: 3.0,
    lengthMm: 100,
    kFactor: 0.33,
    bendAllowanceMm: 5.17,
    faceIds: [`face-${i * 2}`, `face-${i * 2 + 1}`],
  }));

  return {
    shellId,
    bends,
    holes: [
      { featureId: 'hole-0', centerX: 50, centerY: 50, diameterMm: 8.0, throughHole: true, faceId: 'face-top' },
    ],
    flanges: [
      { featureId: 'flange-0', widthMm: 20, lengthMm: 100, adjacentBendId: 'bend-0', faceId: 'face-flange' },
    ],
    reliefs: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateBOM', () => {
  it('BOM-01: produces valid CSV with header row', () => {
    const fs = makeFeatureSet('shell-1');
    const result = generateBOM(fs, MILD_STEEL, 300, 200);

    expect(result.csvContent).toContain('part_id');
    expect(result.csvContent).toContain('material_id');
    expect(result.csvContent).toContain('thickness_mm');
    expect(result.csvContent).toContain('flat_width_mm');
    expect(result.csvContent).toContain('flat_height_mm');
    expect(result.csvContent).toContain('estimated_mass_kg');
    expect(result.csvContent).toContain('bend_count');
  });

  it('BOM-02: CSV has correct data row for part', () => {
    const fs = makeFeatureSet('shell-1');
    const result = generateBOM(fs, MILD_STEEL, 300, 200);
    const lines = result.csvContent.trim().split('\n');

    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[1]).toContain('shell-1');
    expect(lines[1]).toContain('ms-1.5');
    expect(lines[1]).toContain('1.50'); // thickness
    expect(lines[1]).toContain('300.00'); // width
    expect(lines[1]).toContain('200.00'); // height
  });

  it('BOM-03: estimated mass is positive and physically plausible', () => {
    const fs = makeFeatureSet('shell-1');
    // 300mm × 200mm × 1.5mm steel
    // volume = 90000 mm³; density = 7.85e-6 kg/mm³ → mass ≈ 0.707 kg
    const result = generateBOM(fs, MILD_STEEL, 300, 200);

    expect(result.totalMassKg).toBeGreaterThan(0.5);
    expect(result.totalMassKg).toBeLessThan(1.5);
  });

  it('BOM-04: bend count matches FeatureSet', () => {
    const fs = makeFeatureSet('shell-1', 3);
    const result = generateBOM(fs, MILD_STEEL, 300, 200);

    expect(result.items[0]!.bendCount).toBe(3);
  });

  it('BOM-05: zero dimensions yields near-zero mass', () => {
    const fs = makeFeatureSet('shell-1');
    const result = generateBOM(fs, MILD_STEEL, 0, 0);

    expect(result.totalMassKg).toBe(0);
  });
});

describe('generateMultiPartBOM', () => {
  it('BOM-06: multi-part BOM aggregates mass correctly', () => {
    const fs1 = makeFeatureSet('shell-1');
    const fs2 = makeFeatureSet('shell-2');
    const result = generateMultiPartBOM([
      { featureSet: fs1, material: MILD_STEEL, flatWidthMm: 300, flatHeightMm: 200 },
      { featureSet: fs2, material: MILD_STEEL, flatWidthMm: 150, flatHeightMm: 100 },
    ]);

    expect(result.items).toHaveLength(2);
    // Total mass should be close to sum of individual masses
    const m1 = generateBOM(fs1, MILD_STEEL, 300, 200).totalMassKg;
    const m2 = generateBOM(fs2, MILD_STEEL, 150, 100).totalMassKg;
    expect(result.totalMassKg).toBeCloseTo(m1 + m2, 6);
  });

  it('BOM-07: CSV has correct number of data rows for multi-part', () => {
    const parts = [1, 2, 3].map((n) => ({
      featureSet: makeFeatureSet(`shell-${n}`),
      material: MILD_STEEL,
      flatWidthMm: 200,
      flatHeightMm: 150,
    }));

    const result = generateMultiPartBOM(parts);
    const lines = result.csvContent.trim().split('\n');

    expect(lines).toHaveLength(4); // header + 3 data rows
  });

  it('BOM-08: empty parts array returns empty BOM', () => {
    const result = generateMultiPartBOM([]);

    expect(result.items).toHaveLength(0);
    expect(result.totalMassKg).toBe(0);
    const lines = result.csvContent.trim().split('\n');
    expect(lines).toHaveLength(1); // header only
  });
});
