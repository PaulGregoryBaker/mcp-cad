import { describe, expect, it } from 'vitest';

import { computeDxfMergePlacement, type PanelFrame } from '../src/manufacturing/dxf/orientation';
import { mergeDxfOutlines } from '../src/manufacturing/dxf/merge';

function rectDxf(width: number, height: number): string {
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', '4',
    '70', '1',
    '10', '0', '20', '0',
    '10', String(width), '20', '0',
    '10', String(width), '20', String(height),
    '10', '0', '20', String(height),
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function lShapeDxf(): string {
  // 100x100 square with top-right 40x40 notch removed.
  return [
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', '6',
    '70', '1',
    '10', '0', '20', '0',
    '10', '100', '20', '0',
    '10', '100', '20', '60',
    '10', '60', '20', '60',
    '10', '60', '20', '100',
    '10', '0', '20', '100',
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n');
}

function frame(origin: [number, number, number], u: [number, number, number], v: [number, number, number]): PanelFrame {
  return { origin, u, v };
}

describe('DXF merge unit scenarios', () => {
  it('A: merge-by-bend flatten placement of two full panels yields one rectangular outline', () => {
    const a = rectDxf(100, 100);
    const b = rectDxf(100, 100);

    const placement = {
      rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      translation: [100, 0] as [number, number],
    };

    const merged = mergeDxfOutlines(a, b, placement);

    expect(merged.metrics.vertexCount).toBe(4);
    expect(merged.metrics.bbox.width).toBeCloseTo(200, 6);
    expect(merged.metrics.bbox.height).toBeCloseTo(100, 6);
    expect(merged.metrics.areaMm2).toBeCloseTo(20_000, 6);
  });

  it('B1: smaller side panel fuse preserves non-rectangular shape across within-thickness z offsets', () => {
    const base = rectDxf(100, 100);
    const small = rectDxf(40, 30);

    const refFrame = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const thickness = 1.5;
    const offsets = [0, 0.15, 0.5, 1.0, 1.35];

    for (const zOffset of offsets) {
      const movingFrame = frame([80, 35, zOffset], [1, 0, 0], [0, 1, 0]);
      const placement = computeDxfMergePlacement(refFrame, movingFrame, { contactToleranceMm: thickness });

      expect(placement.inContact).toBe(true);

      const merged = mergeDxfOutlines(base, small, {
        rotationMatrix: placement.rotationMatrix,
        translation: placement.translation,
      });

      expect(merged.metrics.vertexCount).toBeGreaterThan(4);
      // Base 100x100 + small 40x30 with a 20x30 overlap => 10_000 + 1_200 - 600 = 10_600
      expect(merged.metrics.areaMm2).toBeCloseTo(10_600, 6);
    }
  });

  it('B2: fuse with alternate base shape (L-shape) keeps non-rectangular topology', () => {
    const base = lShapeDxf();
    const small = rectDxf(25, 20);

    const merged = mergeDxfOutlines(base, small, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [55, 70],
    });

    expect(merged.metrics.vertexCount).toBeGreaterThan(6);
    // L-shape area = 8_400. Small 25x20 panel adds 400 beyond notch => 8_800 total.
    expect(merged.metrics.areaMm2).toBeCloseTo(8_800, 6);
  });

  it('B3: merge-by-bend style second merge on B2 result remains non-rectangular with larger area', () => {
    const base = lShapeDxf();
    const small = rectDxf(25, 20);
    const b2 = mergeDxfOutlines(base, small, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [55, 70],
    });

    const bendPanel = rectDxf(60, 40);

    // Simulated flatten placement from a 90deg companion panel to the right edge.
    const b3 = mergeDxfOutlines(b2.mergedDxf, bendPanel, {
      rotationMatrix: [[1, 0], [0, 1]],
      translation: [100, 20],
    });

    expect(b3.metrics.vertexCount).toBeGreaterThan(6);
    expect(b3.metrics.areaMm2).toBeGreaterThan(b2.metrics.areaMm2);
  });
});
