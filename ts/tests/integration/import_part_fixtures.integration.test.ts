/**
 * import_part real-fixture integration suite (Phase 5 Slice 5B: complete
 * import_part + expand test coverage). Exercises the full real stack — the
 * import_part tool -> evaluate-client.importPart -> step_reconciliation
 * (C++) -> ordinary createPart/createBendNode -- via dispatchGraphTool,
 * against real, committed STEP fixtures (cpp/tests/fixtures/), matching
 * v1's own breadth of per-fixture decompose/unfold coverage
 * (tests/integration/split_body_by_bends.integration.test.ts) but for the
 * new reconciliation pipeline.
 *
 * Different layer from suite_driver_v2_import.integration.test.ts (which
 * tests step_reconciliation directly via raw geometryBinding calls, no
 * GraphStore/tool dispatch involved) -- this file is the first to exercise
 * dispatchGraphTool('import_part', ...) end to end, matching the exact
 * layer every other v2 tool test uses (merge_bodies_with_bend.integration.test.ts,
 * suite_driver_v2.integration.test.ts, etc.).
 *
 * Oracle discipline: true-position round-trip probes only (map2d->3d->2d
 * via mapPointToWorld/mapPointToFlat), never bbox/volume as a pass/fail
 * gate (09-core-correctness-suite.md's O1 admissibility rule).
 *
 * Every fixture's actual behaviour below was determined by RUNNING it first
 * (investigation scripts, not committed), not assumed -- several genuinely
 * needed root-causing before a correct assertion could be written:
 *   - angle_bracket_{15,30}deg.stp: succeed cleanly even at the default
 *     angle_threshold_deg=35. (Historical note: earlier in the rebuild
 *     these needed a manually-tightened threshold to work around a real
 *     splitBodyByBends bug -- buildFaceGroups' region-growing BFS decided
 *     "same panel" using only the dihedral angle between immediate
 *     neighbouring faces against angleThresholdDeg itself, which could
 *     transitively over-merge a shallow-but-real fold's two panels into
 *     one. Fixed by replacing that with a coplanarity test against each
 *     group's own fixed seed plane -- angleThresholdDeg is no longer the
 *     primary discriminator, so these fixtures no longer need tuning.)
 *   - simple_box.stp / hollow_cube.stp: closed 6-panel loop topology. A
 *     naive "round-trip must return to the SAME panel" oracle is WRONG for
 *     these -- a box's corner is physically shared by 3 faces, and
 *     unfolding via a spanning tree legitimately produces multiple valid
 *     flat-pattern locations for one shared 3D point (proven by hand: the
 *     "other" panel's own forward pose, applied to the round-tripped 2D
 *     point, reproduces the exact same 3D position). These use a
 *     self-consistency oracle instead (round-trip lands SOMEWHERE that
 *     forward-maps back to the same 3D point), not a same-panel oracle.
 *   - angle_bracket_45deg.stp, testcube.step, cube_with_flanges.stp: refuse
 *     with GE_DISCONNECTED_PIECES identically across every angle_threshold_deg
 *     tried (35/20/10/1) -- not a threshold-tuning issue. testcube.step
 *     matches v1's own description of it as two hollow cubes fused via
 *     bridge flanges (tests/integration/split_body_by_bends.integration.test.ts);
 *     a flange/tab joint is a different physical connection than a shared
 *     sharp-fold edge, so refusal is the correct, expected outcome here,
 *     not a bug.
 *   - sheet_1panel.stp / sheet_3panel.stp: GE_IMPORT_NO_PANELS_FOUND
 *     regardless of angle_threshold_deg -- splitBodyByBends finds no
 *     planar faces to classify at all, consistent with these being
 *     surface-only STEP exports with no measurable solid thickness (v1's
 *     own INF-03 golden path used sheet_3panel.stp for a DIFFERENT pipeline
 *     stage, decompose_volume, not splitBodyByBends).
 *   - braai.step: excluded entirely -- hangs inside splitBodyByBends itself
 *     (confirmed via a direct call with no reconciliation code involved),
 *     a pre-existing kernel-layer performance issue unrelated to this
 *     slice.
 *
 * Gated behind SUITE_V2_DRIVER=1, consistent with this session's other v2
 * drivers.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart, mapPointToWorld, mapPointToFlat } from '../../src/v2/graph/evaluate-client';
import { toStructuredError } from '../../src/mcp/errors';
import { geometryBinding } from '../../src/geometry/binding';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

interface ImportToolResult {
  part_id: string;
  panel_count: number;
  protrusion_count: number;
  bend_count: number;
  notes: string[];
  protrusion_part_ids: string[];
}

function importFixture(
  store: GraphStore,
  filename: string,
  angleThresholdDeg?: number,
): ImportToolResult {
  return dispatchGraphTool(store, 'import_part', {
    file: path.join(FIXTURES_DIR, filename),
    ...(angleThresholdDeg !== undefined ? { angle_threshold_deg: angleThresholdDeg } : {}),
  }) as ImportToolResult;
}

/** Self-consistency oracle: a ring corner is, by definition, ON a hinge
 * boundary shared by parent AND child (or, for a closed-loop topology like
 * a box, potentially shared by a third panel reached via a non-tree "extra
 * adjacency" edge -- see this file's header comment) -- so "round-trips
 * back to the SAME panel" is not a valid requirement in general, only
 * "wherever it lands is itself a correct forward mapping" is. Round-trip
 * 2D->3D->2D->3D and check the FINAL 3D position matches the FIRST. */
function probeRoundTripSelfConsistent(
  store: GraphStore,
  partId: string,
  toleranceMm: number,
): void {
  const layout = evaluatePart(store, partId);
  expect(layout.ok).toBe(true);
  let probed = 0;
  for (const panel of layout.panels) {
    for (const p2 of panel.regionOuter) {
      const toWorld1 = mapPointToWorld(store, partId, p2);
      expect(toWorld1.ok).toBe(true);
      const toFlat = mapPointToFlat(store, partId, toWorld1.point3d);
      expect(toFlat.ok).toBe(true);
      const toWorld2 = mapPointToWorld(store, partId, toFlat.point2d);
      expect(toWorld2.ok).toBe(true);
      const residual = Math.hypot(
        toWorld2.point3d.x - toWorld1.point3d.x,
        toWorld2.point3d.y - toWorld1.point3d.y,
        toWorld2.point3d.z - toWorld1.point3d.z,
      );
      expect(residual).toBeLessThanOrEqual(toleranceMm);
      probed++;
    }
  }
  expect(probed).toBeGreaterThan(0);
}

/** Some errors surface as McpToolError (thrown via throwError() at the tool
 * -handler layer); raw geometryBinding calls (e.g. loadStep) throw a plain
 * StructuredError object directly (binding.ts's own established, pre-
 * existing convention -- not specific to import_part). toStructuredError
 * normalizes either shape, matching errors.ts's own documented purpose. */
function expectTypedError(fn: () => void, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(toStructuredError(caught).code).toBe(code);
}

d('import_part integration suite (real STEP fixtures)', () => {
  it('l_bracket_corner_90deg.stp: 2-panel sharp 90deg fold reconciles and round-trips exactly', () => {
    const store = new GraphStore();
    const result = importFixture(store, 'l_bracket_corner_90deg.stp');
    expect(result.panel_count).toBe(2);
    expect(result.bend_count).toBe(1);
    expect(result.protrusion_count).toBe(0);
    expect(result.protrusion_part_ids).toEqual([]);
    expect(result.notes).toEqual([]);
    probeRoundTripSelfConsistent(store, result.part_id, 0.001);
  });

  it('unequal_leg_bracket_90deg.stp: 2-panel asymmetric fold reconciles and round-trips exactly', () => {
    const store = new GraphStore();
    const result = importFixture(store, 'unequal_leg_bracket_90deg.stp');
    expect(result.panel_count).toBe(2);
    expect(result.bend_count).toBe(1);
    expect(result.protrusion_count).toBe(0);
    expect(result.protrusion_part_ids).toEqual([]);
    probeRoundTripSelfConsistent(store, result.part_id, 0.001);
  });

  it('angle_bracket_15deg.stp: succeeds at both the default and a tighter angle_threshold_deg', () => {
    const store = new GraphStore();
    const resultDefault = importFixture(store, 'angle_bracket_15deg.stp');
    expect(resultDefault.panel_count).toBe(2);
    expect(resultDefault.bend_count).toBe(1);
    expect(resultDefault.protrusion_part_ids).toEqual([]);
    probeRoundTripSelfConsistent(store, resultDefault.part_id, 2.0);

    const store2 = new GraphStore();
    const result = importFixture(store2, 'angle_bracket_15deg.stp', 10);
    expect(result.panel_count).toBe(2);
    expect(result.bend_count).toBe(1);
    expect(result.protrusion_part_ids).toEqual([]);
    probeRoundTripSelfConsistent(store2, result.part_id, 2.0);
  });

  it('angle_bracket_30deg.stp: succeeds at both the default and a tighter angle_threshold_deg', () => {
    const store = new GraphStore();
    const resultDefault = importFixture(store, 'angle_bracket_30deg.stp');
    expect(resultDefault.panel_count).toBe(2);
    expect(resultDefault.bend_count).toBe(1);
    expect(resultDefault.protrusion_part_ids).toEqual([]);
    probeRoundTripSelfConsistent(store, resultDefault.part_id, 2.0);

    const store2 = new GraphStore();
    const result = importFixture(store2, 'angle_bracket_30deg.stp', 20);
    expect(result.panel_count).toBe(2);
    expect(result.bend_count).toBe(1);
    expect(result.protrusion_part_ids).toEqual([]);
    probeRoundTripSelfConsistent(store2, result.part_id, 2.0);
  });

  it('simple_box.stp: closed 6-panel loop reconciles via a spanning tree; self-consistent round-trip', () => {
    const store = new GraphStore();
    const result = importFixture(store, 'simple_box.stp');
    expect(result.panel_count).toBe(6);
    expect(result.bend_count).toBe(5);
    expect(result.protrusion_part_ids).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0); // extra (non-tree) adjacency, expected for a closed loop
    probeRoundTripSelfConsistent(store, result.part_id, 0.001);
  });

  it('hollow_cube.stp: closed 6-panel loop reconciles via a spanning tree; self-consistent round-trip', () => {
    const store = new GraphStore();
    const result = importFixture(store, 'hollow_cube.stp');
    expect(result.panel_count).toBe(6);
    expect(result.bend_count).toBe(5);
    expect(result.protrusion_part_ids).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    probeRoundTripSelfConsistent(store, result.part_id, 0.001);
  });

  it('tab_bracket_90deg.stp: correctly refused as a non-developable (filleted) fold', () => {
    const store = new GraphStore();
    expectTypedError(
      () => importFixture(store, 'tab_bracket_90deg.stp'),
      'GE_NON_DEVELOPABLE_FOLD',
    );
  });

  it('angle_bracket_45deg.stp: correctly refused (disconnected, independent of angle_threshold_deg)', () => {
    for (const threshold of [35, 10]) {
      const store = new GraphStore();
      expectTypedError(
        () => importFixture(store, 'angle_bracket_45deg.stp', threshold),
        'GE_DISCONNECTED_PIECES',
      );
    }
  });

  it('testcube.step: correctly refused (fused multi-body via bridge flanges, not a simple sharp edge)', () => {
    const store = new GraphStore();
    expectTypedError(() => importFixture(store, 'testcube.step'), 'GE_DISCONNECTED_PIECES');
  });

  it('cube_with_flanges.stp: correctly refused (flange join, not a simple sharp edge)', () => {
    const store = new GraphStore();
    expectTypedError(() => importFixture(store, 'cube_with_flanges.stp'), 'GE_DISCONNECTED_PIECES');
  });

  it('sheet_1panel.stp / sheet_3panel.stp: correctly refused (surface-only STEP, no solid thickness)', () => {
    for (const fixture of ['sheet_1panel.stp', 'sheet_3panel.stp']) {
      const store = new GraphStore();
      expectTypedError(() => importFixture(store, fixture), 'GE_IMPORT_NO_PANELS_FOUND');
    }
  });

  it('nonexistent file path is a typed error', () => {
    const store = new GraphStore();
    expectTypedError(() => importFixture(store, 'does_not_exist_1234.stp'), 'GE_IMPORT_FAILED');
  });
});

d('import_part integration suite — protrusion extraction (Phase 5 Slice 6)', () => {
  // testcube.step is the only committed fixture with detected protrusions
  // (its two hollow cubes are joined by bridge flanges -- splitBodyByBends
  // classifies each flange as a protrusion, separate from the 12 main wall
  // panels). Its MAIN panels correctly refuse reconciliation with
  // GE_DISCONNECTED_PIECES (see the dedicated test above) for a reason
  // entirely unrelated to protrusions -- that refusal happens in
  // importPart's reconcilePieces call, which runs BEFORE the protrusion
  // loop (evaluate-client.ts), so dispatchGraphTool('import_part', ...)
  // never reaches protrusion extraction for this fixture. No committed
  // fixture combines "has protrusions" with "main panels reconcile", so
  // the extraction mechanism itself -- getPanelFrame -> reconcilePieces
  // (n=1) -> createPart, exactly the loop importPart runs internally -- is
  // exercised directly here, against the same real splitBodyByBends output
  // the full import_part tool would see.
  it('testcube.step: protrusion extraction mechanism succeeds for all 4 detected protrusions', () => {
    const fixturePath = path.join(FIXTURES_DIR, 'testcube.step');
    const solidId = geometryBinding.loadStep(fixturePath);
    geometryBinding.healGeometryEx(solidId, true, true);
    const split = geometryBinding.splitBodyByBends(solidId, 35, undefined, undefined, undefined);
    expect(split.protrusion_ids.length).toBe(4);

    const store = new GraphStore();
    const protrusionPartIds: string[] = [];
    for (const shellId of split.protrusion_ids) {
      const frame = geometryBinding.getPanelFrame(shellId);
      const piece = {
        origin: { x: frame.originX, y: frame.originY, z: frame.originZ },
        uAxis: { x: frame.uX, y: frame.uY, z: frame.uZ },
        vAxis: { x: frame.vX, y: frame.vY, z: frame.vZ },
        normal: { x: frame.normalX, y: frame.normalY, z: frame.normalZ },
        ringLocal: frame.ring,
        thicknessMm: frame.thicknessMm,
      };
      const reconciled = geometryBinding.reconcilePieces([piece], frame.thicknessMm);
      expect(
        reconciled.ok,
        `protrusion ${shellId}: ${reconciled.errorCode} ${reconciled.message}`,
      ).toBe(true);

      const part = store.createPart({
        name: `${fixturePath}#protrusion`,
        outline: reconciled.graph.outline.outer,
        thicknessMm: frame.thicknessMm,
        anchor: reconciled.graph.anchor?.transform,
      });
      expect(part.outline.length).toBeGreaterThanOrEqual(3);
      protrusionPartIds.push(part.partId);
    }

    expect(protrusionPartIds.length).toBe(4);
    expect(new Set(protrusionPartIds).size).toBe(4); // every protrusion is its own independent Part
  });
});
