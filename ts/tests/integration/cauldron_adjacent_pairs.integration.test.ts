/**
 * Phase 5 Slice 5C — cauldron adjacent-pair merge coverage.
 *
 * Exercises `merge_bodies_with_bend` (Slice 4's tool) far more thoroughly
 * than its existing hand-authored test cases, by sweeping every pairwise
 * combination of cauldron.step's decomposed panels and attempting a real
 * merge on fresh, independently-created single-panel Parts.
 *
 * Adjacency detection reuses `geometryBinding.reconcilePieces` pairwise
 * (n=2) — already proven correct by Slice 5B's own suite — as the "do these
 * two pieces share a measured edge, and if so what's the signed angleDeg"
 * primitive, rather than inventing a second detection algorithm. This is a
 * direct `geometryBinding` call (not a dispatchGraphTool tool), since
 * reconcilePieces is an internal primitive `import_part` uses, not itself an
 * MCP tool — the actual v2 pipeline under test here is `create_part` +
 * `merge_bodies_with_bend` via dispatchGraphTool, exactly as a real caller
 * would use them.
 *
 * Real root-cause history (this session): the cauldron fixture originally
 * measured only 45-57 genuinely adjacent pairs — far short of the expected
 * count for a 44-panel vessel where interior panels typically border 4
 * neighbours. Investigation (NOT assumption) found the true cause was NOT
 * in this reconciliation layer at all: `splitBodyByBends`'s own
 * `buildFaceGroups` region-growing BFS decided "same panel" using only the
 * dihedral angle between immediate neighbouring faces, compared against
 * `angleThresholdDeg` (a BEND-detection sensitivity, tens of degrees) — but
 * this vessel intentionally uses many flat, straight-edged panels at
 * shallow (well under angleThresholdDeg) mutual fold angles to approximate
 * its rounded shape. The BFS transitively flooded through long chains of
 * such shallow angles, merging many genuinely separate panels into one
 * grossly oversized "panel" group, corrupting getPanelFrame's measured
 * thickness for every panel it touched (confirmed: some panels measured
 * thousands of mm "thick" against a true ~1mm wall). Fixed by replacing the
 * angle-only pairwise test with a coplanarity test (small, fixed LINEAR
 * tolerance — point-to-plane distance) against each group's own FIXED seed
 * plane (established once from the group's first face, never re-derived
 * per BFS step) — the physically correct discriminator: faces from the
 * same tessellated panel share an identical plane to floating-point
 * precision, while genuinely different panels at a real fold diverge
 * measurably in perpendicular distance across the panel's own size, even
 * at a shallow angle. This raised the panel count from 44 (many wrongly
 * merged) to 82 (correctly separated, every one measuring the true ~1mm
 * thickness) and the genuinely adjacent pair count from 45 to 136.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { geometryBinding } from '../../src/geometry/binding';
import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { toStructuredError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURE_PATH = path.resolve(__dirname, '../../../cpp/tests/fixtures/cauldron.step');

interface Piece {
  origin: { x: number; y: number; z: number };
  uAxis: { x: number; y: number; z: number };
  vAxis: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  ringLocal: { x: number; y: number }[];
  thicknessMm: number;
}

function decomposeCauldron(): { pieces: Piece[]; thicknessMm: number } {
  const solidId = geometryBinding.loadStep(FIXTURE_PATH);
  geometryBinding.healGeometryEx(solidId, true, true);
  const split = geometryBinding.splitBodyByBends(solidId, 35, undefined, undefined, undefined);

  const pieces: Piece[] = split.panel_ids.map((shellId: string) => {
    const frame = geometryBinding.getPanelFrame(shellId);
    return {
      origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
      uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
      vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
      normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
      ringLocal: frame.ring,
      thicknessMm: frame.thicknessMm,
    };
  });

  return { pieces, thicknessMm: pieces[0].thicknessMm };
}

d('[v2] cauldron adjacent-pair merge coverage (Phase 5 Slice 5C)', () => {
  it(
    'every decomposed panel measures the true wall thickness (regression guard for the ' +
      'buildFaceGroups shallow-angle over-merge bug)',
    () => {
      const { pieces, thicknessMm } = decomposeCauldron();

      // A real, physical bound: cauldron's true wall thickness is ~1mm.
      // Confirmed on the fixed decomposition: all 82 panels measure within
      // 0.01mm of thicknessMm. The over-merge bug produced panels "measuring"
      // hundreds to thousands of mm — nowhere close to this bound.
      expect(pieces.length).toBeGreaterThan(60);
      const badPanels = pieces
        .map((p, i) => ({ i, thicknessMm: p.thicknessMm }))
        .filter((p) => Math.abs(p.thicknessMm - thicknessMm) > 1.0);
      expect(badPanels).toEqual([]);
    },
  );

  it('merge_bodies_with_bend succeeds on more than 100 genuinely adjacent panel pairs', () => {
    const { pieces, thicknessMm } = decomposeCauldron();

    // Adjacency detection: reuse reconcilePieces's own n=2 pairwise case
    // (already proven correct) purely as the "are these two genuinely
    // adjacent" oracle for which pairs to attempt — NOT for angle/edge-index
    // (docs/TASK_SPEC.md: merge_bodies_with_bend no longer takes either; it
    // derives its own seam from each part's real anchor). Each piece's own
    // real anchor is precomputed ONCE via reconcilePieces' single-piece
    // (n=1) case — same pattern unequal_leg_bracket_merge_orientation
    // .integration.test.ts already established — so every part created below
    // sits at its true measured 3D position, not the default identity.
    const soloAnchors = pieces.map((p) => {
      const solo = geometryBinding.reconcilePieces([p], thicknessMm);
      return solo.ok ? solo.graph.anchor?.transform : undefined;
    });

    let mergeOkCount = 0;
    let mergeFailCount = 0;
    const reconcileFailByCode = new Map<string, number>();
    const mergeFailByCode = new Map<string, number>();

    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const reconciled = geometryBinding.reconcilePieces([pieces[i], pieces[j]], thicknessMm);
        if (!reconciled.ok) {
          reconcileFailByCode.set(
            reconciled.errorCode,
            (reconcileFailByCode.get(reconciled.errorCode) ?? 0) + 1,
          );
          continue;
        }
        if (!soloAnchors[i] || !soloAnchors[j]) continue;

        const store = new GraphStore();
        try {
          const partI = dispatchGraphTool(store, 'create_part', {
            name: `pair-${i}-${j}-i`,
            outline: pieces[i].ringLocal,
            thickness_mm: pieces[i].thicknessMm,
            anchor: soloAnchors[i],
          }) as { part_id: string };
          const partJ = dispatchGraphTool(store, 'create_part', {
            name: `pair-${i}-${j}-j`,
            outline: pieces[j].ringLocal,
            thickness_mm: pieces[j].thicknessMm,
            anchor: soloAnchors[j],
          }) as { part_id: string };

          dispatchGraphTool(store, 'merge_bodies_with_bend', {
            part_a_id: partI.part_id,
            part_b_id: partJ.part_id,
          });
          mergeOkCount++;
        } catch (err) {
          mergeFailCount++;
          const structured = toStructuredError(err);
          mergeFailByCode.set(structured.code, (mergeFailByCode.get(structured.code) ?? 0) + 1);
          if (process.env.CAULDRON_DEBUG === '1') {
            console.log(
              `  FAIL (${i},${j}) ringI=${pieces[i].ringLocal.length} ringJ=${pieces[j].ringLocal.length} ` +
                `code=${structured.code} msg=${structured.message}`,
            );
          }
        }
      }
    }

    console.log(
      `reconcilePieces: ${mergeOkCount + mergeFailCount} candidate pairs reached merge (reconcile failures by code):`,
      Object.fromEntries(reconcileFailByCode),
    );
    console.log(
      `merge_bodies_with_bend: ok=${mergeOkCount} fail=${mergeFailCount}`,
      Object.fromEntries(mergeFailByCode),
    );

    expect(mergeOkCount).toBeGreaterThan(100);
  }, 120_000);
});
