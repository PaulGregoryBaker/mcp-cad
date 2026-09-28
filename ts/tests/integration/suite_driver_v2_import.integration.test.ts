/**
 * v2 suite driver for Phase 5 Slice 5 (rebuild/suite/, Level C) — T0 tier only.
 *
 * T0's own ops are `import, decompose, map_roundtrip_grid` — no merge, no
 * bend-tree reconciliation. The oracle is per-panel: does THIS ONE flat
 * panel's own measured frame+ring round-trip 2D->3D->2D within budget,
 * independent of how (or whether) it connects to any neighbour. That is
 * deliberately weaker than full multi-panel reconciliation (T1/T3's own
 * concern) — confirmed by running this against cauldron.step's 44 panels:
 * step_reconciliation correctly refuses to RECONCILE them (closest
 * candidate edge gap ~238mm — these panels are joined by curved bends, out
 * of this slice's declared sharp-fold-only scope), but each panel's OWN
 * frame+ring still round-trips fine in isolation, which is all T0 actually
 * asks.
 *
 * Each panel is evaluated via reconcilePieces with a SINGLE-element piece
 * array (n=1 is a valid, already-handled case: one region panel, zero
 * bends, anchor = that piece's own measured frame, built by the already-
 * tested C++ BuildPieceFrame) — reusing existing, tested C++ machinery
 * rather than hand-assembling a transform in TypeScript (constitution
 * v2.0.0 principle IV).
 *
 * T1/T3's cases (bracket90/45 merge_position_preserved, red_cauldron_*) all
 * use decompose+merge_pair/merge_next/merge_all_adjacent ops — Slice 4's
 * separate mergePartsWithBend pipeline, out of this driver's scope.
 *
 * Gated behind SUITE_V2_DRIVER=1:
 *   SUITE_V2_DRIVER=1 npx vitest run tests/integration/suite_driver_v2_import
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { geometryBinding } from '../../src/geometry/binding';
import type { NapiPanelPieceSpec, NapiPoint2 } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const SUITE_DIR = path.resolve(__dirname, '../../../rebuild/suite');
const REPO_ROOT = path.resolve(__dirname, '../../..');

interface Profile {
  closureMm: number;
  probeMm: number;
  outlineMm: number;
  lenMm: number;
  angleDeg: number;
}
const profiles: Record<string, Profile> = JSON.parse(
  fs.readFileSync(path.join(SUITE_DIR, 'profiles.json'), 'utf8'),
);

interface SuiteCase {
  id: string;
  toleranceProfile: string;
  expectation: 'pass' | 'known-fail-v1';
  fixture: { kind: string; path: string };
  ops: Array<Record<string, unknown>>;
  oracles: Array<Record<string, unknown>>;
}

function loadCases(tier: string): SuiteCase[] {
  const dir = path.join(SUITE_DIR, 'cases', tier);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SuiteCase);
}

d('v2 suite driver — T0 (Level C per-panel closure)', () => {
  for (const c of loadCases('T0')) {
    it(c.id, () => {
      const profile = profiles[c.toleranceProfile];
      const fixturePath = path.join(REPO_ROOT, c.fixture.path);

      const gridOp = c.ops.find((o) => o.op === 'map_roundtrip_grid') as
        | { gridN: number; insetMm: number }
        | undefined;
      expect(gridOp).toBeDefined();
      const gridN = gridOp!.gridN;
      const insetMm = gridOp!.insetMm;

      const solidId = geometryBinding.loadStep(fixturePath);
      geometryBinding.healGeometryEx(solidId, true, true);
      const split = geometryBinding.splitBodyByBends(solidId, 35, undefined, undefined, undefined);
      expect(split.panel_ids.length).toBeGreaterThan(0);

      let probed = 0;
      for (const shellId of split.panel_ids) {
        const frame = geometryBinding.getPanelFrame(shellId);
        const piece: NapiPanelPieceSpec = {
          origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
          uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
          vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
          normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
          ringLocal: frame.ring,
          thicknessMm: frame.thicknessMm,
        };
        const reconciled = geometryBinding.reconcilePieces([piece], frame.thicknessMm);
        if (!reconciled.ok) {
          throw new Error(`reconcilePieces failed for shell ${shellId}: ${reconciled.errorCode} ${reconciled.message}`);
        }
        const graph = reconciled.graph;
        const layout = geometryBinding.evaluatePartGraph(graph);
        expect(layout.ok).toBe(true);
        expect(layout.panels.length).toBe(1);
        const panel = layout.panels[0];

        const xs = panel.regionOuter.map((p) => p.x);
        const ys = panel.regionOuter.map((p) => p.y);
        const xMin = Math.min(...xs) + insetMm;
        const xMax = Math.max(...xs) - insetMm;
        const yMin = Math.min(...ys) + insetMm;
        const yMax = Math.max(...ys) - insetMm;
        if (xMax <= xMin || yMax <= yMin) continue; // panel too small for this inset

        for (let i = 0; i < gridN; i++) {
          for (let j = 0; j < gridN; j++) {
            const x = gridN === 1 ? (xMin + xMax) / 2 : xMin + ((xMax - xMin) * i) / (gridN - 1);
            const y = gridN === 1 ? (yMin + yMax) / 2 : yMin + ((yMax - yMin) * j) / (gridN - 1);
            const point2d: NapiPoint2 = { x, y };

            const toWorld = geometryBinding.mapPointToWorld(graph, layout, point2d);
            if (!toWorld.ok || toWorld.regionPanelId !== panel.regionPanelId) continue;

            const toFlat = geometryBinding.mapPointToFlat(graph, layout, toWorld.point3d);
            expect(toFlat.ok).toBe(true);
            expect(toFlat.regionPanelId).toBe(panel.regionPanelId);
            const residual = Math.hypot(toFlat.point2d.x - x, toFlat.point2d.y - y);
            expect(residual).toBeLessThanOrEqual(profile.probeMm);
            probed++;
          }
        }
      }
      expect(probed).toBeGreaterThan(0);
    });
  }
});
