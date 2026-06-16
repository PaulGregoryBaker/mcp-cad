import { describe, expect, it } from 'vitest';

import {
  type PanelFrame,
  computeDxfMergePlacement,
} from '../src/manufacturing/dxf/orientation';

function frame(origin: [number, number, number], u: [number, number, number], v: [number, number, number]): PanelFrame {
  return { origin, u, v };
}

describe('DXF orientation contract', () => {
  it('maps identical frames to identity transform', () => {
    const a = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const b = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);

    const p = computeDxfMergePlacement(a, b, { contactToleranceMm: 0.01 });

    expect(p.translation[0]).toBeCloseTo(0, 8);
    expect(p.translation[1]).toBeCloseTo(0, 8);
    expect(p.rotationRadians).toBeCloseTo(0, 8);
    expect(p.normalOffsetMm).toBeCloseTo(0, 8);
    expect(p.inContact).toBe(true);
  });

  it('captures in-plane translation in reference coordinates', () => {
    const ref = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const mov = frame([12.5, -3.25, 0], [1, 0, 0], [0, 1, 0]);

    const p = computeDxfMergePlacement(ref, mov, { contactToleranceMm: 0.01 });

    expect(p.translation[0]).toBeCloseTo(12.5, 8);
    expect(p.translation[1]).toBeCloseTo(-3.25, 8);
    expect(p.normalOffsetMm).toBeCloseTo(0, 8);
    expect(p.inContact).toBe(true);
  });

  it('captures in-plane 90deg rotation', () => {
    const ref = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const mov = frame([0, 0, 0], [0, 1, 0], [-1, 0, 0]);

    const p = computeDxfMergePlacement(ref, mov, { contactToleranceMm: 0.01 });

    expect(p.rotationRadians).toBeCloseTo(Math.PI / 2, 8);
    expect(p.normalOffsetMm).toBeCloseTo(0, 8);
    expect(p.inContact).toBe(true);
  });

  it('treats small normal offset as in contact', () => {
    const ref = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const mov = frame([0, 0, 0.9], [1, 0, 0], [0, 1, 0]);

    const p = computeDxfMergePlacement(ref, mov, { contactToleranceMm: 1.0 });

    expect(p.normalOffsetMm).toBeCloseTo(0.9, 8);
    expect(p.inContact).toBe(true);
  });

  it('flags large normal offset as out of contact', () => {
    const ref = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    const mov = frame([0, 0, 2.1], [1, 0, 0], [0, 1, 0]);

    const p = computeDxfMergePlacement(ref, mov, { contactToleranceMm: 1.0 });

    expect(p.normalOffsetMm).toBeCloseTo(2.1, 8);
    expect(p.inContact).toBe(false);
  });

  it('rejects non-orthogonal frames', () => {
    const invalid = frame([0, 0, 0], [1, 0, 0], [1, 0, 0]);
    const valid = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);

    expect(() => computeDxfMergePlacement(valid, invalid, { contactToleranceMm: 0.1 }))
      .toThrow(/orthogonal/);
  });
});
