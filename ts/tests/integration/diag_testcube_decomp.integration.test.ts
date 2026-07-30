/**
 * Diagnostic: testcube.step decomposition detail dump.
 * Run: $env:SUITE_V2_DRIVER='1'; npx vitest run tests/integration/diag_testcube_decomp.integration.test.ts
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { geometryBinding } from '../../src/geometry/binding';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'cpp', 'tests', 'fixtures');

d('[diag] testcube decomposition', () => {
  it('dumps panel and protrusion dimensions', () => {
    const fixturePath = path.join(FIXTURES, 'testcube.step');
    const solidId = geometryBinding.loadStep(fixturePath);
    geometryBinding.healGeometryEx(solidId, true, true);
    const split = geometryBinding.splitBodyByBends(solidId, 35);

    console.log('=== testcube.step decomposition ===');
    console.log('Panels:', split.panel_ids.length, 'Protrusions:', split.protrusion_ids.length);
    console.log('Panel thicknesses:', JSON.stringify(split.panel_thickness_mm));

    for (let i = 0; i < split.panel_ids.length; i++) {
      const f = geometryBinding.getPanelFrame(split.panel_ids[i]);
      console.log(`Panel[${i}] ring_len=${f.ring?.length ?? 0} thickness=${f.thicknessMm?.toFixed(2)}`);
    }

    for (let i = 0; i < split.protrusion_ids.length; i++) {
      const f = geometryBinding.getPanelFrame(split.protrusion_ids[i]);
      console.log(`Protrusion[${i}] ring_len=${f.ring?.length ?? 0} thickness=${f.thicknessMm?.toFixed(2)} uExt=${f.uExtentMm?.toFixed(2)} vExt=${f.vExtentMm?.toFixed(2)}`);
      if (f.ring) {
        for (const pt of f.ring) console.log(`  ring pt: (${pt.x?.toFixed(2)}, ${pt.y?.toFixed(2)})`);
      }
    }

    expect(split.panel_ids.length).toBeGreaterThan(0);
  });
});
