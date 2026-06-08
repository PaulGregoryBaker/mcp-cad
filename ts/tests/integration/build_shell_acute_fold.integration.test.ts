/**
 * Isolation test for buildShellFromFlatPattern's acute-angle refold.
 *
 * Calls the binding directly with a flat rectangle + a single bend zone, in
 * CANONICAL space (no referenceShellId), and checks the refolded bbox. This
 * exercises only the C++ bend-sector reconstruction — independent of panel
 * frames, adjacency, and placement.
 *
 * Flat pattern: 200 × 100 rectangle. Bend at offset 100 (Panel A = 0..100),
 * width ~2 (developed bend), so Panel B ≈ 98 mm wide. Panel B folds UP into +Z.
 *   - 90°: Panel B stands vertical → x_max ≈ 100, z_max ≈ 98.
 *   - 45°: Panel B leans → x_max ≈ 100 + 98·cos45 ≈ 169, z_max ≈ 98·sin45 ≈ 69.
 */

import { describe, expect, it } from 'vitest';

import { geometryBinding } from '../../src/geometry/binding';

function flatRectDxf(w: number, h: number): string {
  return [
    '  0', 'SECTION', '  2', 'ENTITIES',
    '  0', 'LWPOLYLINE', '  8', '0', ' 70', '     1', ' 90', '     4',
    ' 10', '0', ' 20', '0',
    ' 10', String(w), ' 20', '0',
    ' 10', String(w), ' 20', String(h),
    ' 10', '0', ' 20', String(h),
    '  0', 'ENDSEC', '  0', 'EOF', '',
  ].join('\n');
}

describe('buildShellFromFlatPattern: acute-angle refold (canonical)', () => {
  if (!geometryBinding.hasBuildShellFromFlatPattern()) {
    it.skip('addon missing buildShellFromFlatPattern', () => {});
    return;
  }

  const dxf = flatRectDxf(200, 100);
  const thickness = 1.5;
  const baseZone = { offsetMm: 100, widthMm: 2, innerRadiusMm: 1.0, kFactor: 0.33 };

  it('folds 90° → Panel B stands vertical (+Z)', () => {
    const res = geometryBinding.buildShellFromFlatPattern(dxf, [{ ...baseZone, angleDeg: 90 }], thickness);
    const b = geometryBinding.computeBoundingBox(res.shellId);
    console.log(`[acute 90] x[${b.x_min.toFixed(1)}..${b.x_max.toFixed(1)}] z[${b.z_min.toFixed(1)}..${b.z_max.toFixed(1)}]`);
    expect(b.z_max).toBeGreaterThan(90);          // Panel B folded up ~98mm
    expect(b.x_max).toBeLessThan(115);            // negligible X extension at 90°
  });

  it('folds 45° → Panel B leans (X and Z both ~69mm)', () => {
    const res = geometryBinding.buildShellFromFlatPattern(dxf, [{ ...baseZone, angleDeg: 45 }], thickness);
    const b = geometryBinding.computeBoundingBox(res.shellId);
    console.log(`[acute 45] x[${b.x_min.toFixed(1)}..${b.x_max.toFixed(1)}] z[${b.z_min.toFixed(1)}..${b.z_max.toFixed(1)}]`);
    // Panel B (~98mm) folded 45°: extends ~69mm in both +X (beyond x=100) and +Z.
    expect(b.x_max).toBeGreaterThan(150);
    expect(b.x_max).toBeLessThan(185);
    expect(b.z_max).toBeGreaterThan(55);
    expect(b.z_max).toBeLessThan(85);
  });
});
