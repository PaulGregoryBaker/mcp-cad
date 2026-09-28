/**
 * Replay-invariant harness (Phase 5 Slice 1, rebuild/14 §6, constitution
 * v2.0.0 principle II): replay(graph) === current geometry, for every
 * mutating verb. Scoped to exactly the two Slice 1 mutating tools —
 * create_part and create_node(kind=bend) — via a table-driven scenario
 * registry, structured so later slices add scenarios/verbs here rather than
 * rewriting this module.
 *
 * Each scenario builds a GraphStore purely through the v2 tool dispatcher
 * (the same code path a real MCP client uses, not direct store calls), so
 * the check also exercises create_part/create_node end to end. The check
 * itself is: evaluate once, serialize -> deserialize into a fresh store,
 * evaluate again, and assert the two Layouts agree — proving the store's row
 * schema captures everything evaluatePartGraph needs (no hidden in-memory
 * state Slice 2's Dolt-backed store would need to reproduce).
 */

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart } from '../../src/v2/graph/evaluate-client';
import { pointsNearlyEqual, REPLAY_ANGLE_EPSILON_DEG } from '../../src/geometry/numerical-policy';
import type {
  EvaluatePartGraphResult,
  NapiRegionPanelLayout,
  NapiBridgeLayout,
  NapiTransform3,
} from '../../src/geometry/types';

export interface ReplayScenario {
  name: string;
  /** Builds a fresh store and returns the part id to replay-check. */
  build: () => { store: GraphStore; partId: string };
}

function createPart(store: GraphStore, args: Record<string, unknown>): string {
  const result = dispatchGraphTool(store, 'create_part', args) as { part_id: string };
  return result.part_id;
}

function createBendNode(store: GraphStore, args: Record<string, unknown>): void {
  dispatchGraphTool(store, 'create_node', args);
}

export const REPLAY_SCENARIOS: ReplayScenario[] = [
  {
    name: 'single-panel-no-bend',
    build: (): { store: GraphStore; partId: string } => {
      const store = new GraphStore();
      const partId = createPart(store, {
        name: 'replay-single-panel',
        outline: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 50 },
          { x: 0, y: 50 },
        ],
        thickness_mm: 1.0,
      });
      return { store, partId };
    },
  },
  {
    name: 'two-panel-one-bend',
    build: (): { store: GraphStore; partId: string } => {
      const store = new GraphStore();
      const partId = createPart(store, {
        name: 'replay-two-panel',
        outline: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 50 },
          { x: 0, y: 50 },
        ],
        thickness_mm: 1.0,
      });
      const part = store.getPart(partId);
      if (!part) throw new Error('replay scenario setup: part not found after create_part');
      createBendNode(store, {
        kind: 'bend',
        part_id: partId,
        parent_region_panel_id: part.rootRegionPanelId,
        hinge_a: { x: 50, y: -10 },
        hinge_b: { x: 50, y: 60 },
        angle_deg: 90,
        radius_mm: 2.0,
        k_factor: 0.44,
      });
      return { store, partId };
    },
  },
];

export interface ReplayCheckResult {
  ok: boolean;
  mismatches: string[];
}

function transformsNearlyEqual(a: NapiTransform3, b: NapiTransform3): boolean {
  for (let i = 0; i < 9; i++) {
    if (!pointsNearlyEqual({ x: a.r[i], y: 0, z: 0 }, { x: b.r[i], y: 0, z: 0 })) return false;
  }
  return pointsNearlyEqual(
    { x: a.t[0], y: a.t[1], z: a.t[2] },
    { x: b.t[0], y: b.t[1], z: b.t[2] },
  );
}

function comparePanels(
  before: NapiRegionPanelLayout[],
  after: NapiRegionPanelLayout[],
  mismatches: string[],
): void {
  if (before.length !== after.length) {
    mismatches.push(`panel count differs: before=${before.length} after=${after.length}`);
    return;
  }
  const afterById = new Map(after.map((p) => [p.regionPanelId, p]));
  for (const b of before) {
    const a = afterById.get(b.regionPanelId);
    if (!a) {
      mismatches.push(`panel ${b.regionPanelId} missing after replay`);
      continue;
    }
    if (!transformsNearlyEqual(b.pose, a.pose)) {
      mismatches.push(`panel ${b.regionPanelId} pose differs after replay`);
    }
    if (b.bottomFace.length !== a.bottomFace.length || b.topFace.length !== a.topFace.length) {
      mismatches.push(`panel ${b.regionPanelId} face vertex count differs after replay`);
      continue;
    }
    for (let i = 0; i < b.bottomFace.length; i++) {
      if (!pointsNearlyEqual(b.bottomFace[i], a.bottomFace[i])) {
        mismatches.push(`panel ${b.regionPanelId} bottomFace[${i}] differs after replay`);
      }
      if (!pointsNearlyEqual(b.topFace[i], a.topFace[i])) {
        mismatches.push(`panel ${b.regionPanelId} topFace[${i}] differs after replay`);
      }
    }
  }
}

function compareBridges(
  before: NapiBridgeLayout[],
  after: NapiBridgeLayout[],
  mismatches: string[],
): void {
  if (before.length !== after.length) {
    mismatches.push(`bridge count differs: before=${before.length} after=${after.length}`);
    return;
  }
  const afterById = new Map(after.map((b) => [b.bendId, b]));
  for (const b of before) {
    const a = afterById.get(b.bendId);
    if (!a) {
      mismatches.push(`bridge ${b.bendId} missing after replay`);
      continue;
    }
    if (!pointsNearlyEqual(b.pivotOriginWorld, a.pivotOriginWorld)) {
      mismatches.push(`bridge ${b.bendId} pivotOriginWorld differs after replay`);
    }
    if (!pointsNearlyEqual(b.pivotAxisWorld, a.pivotAxisWorld)) {
      mismatches.push(`bridge ${b.bendId} pivotAxisWorld differs after replay`);
    }
    if (Math.abs(b.angleDeg - a.angleDeg) > REPLAY_ANGLE_EPSILON_DEG) {
      mismatches.push(`bridge ${b.bendId} angleDeg differs after replay`);
    }
  }
}

function compareLayouts(before: EvaluatePartGraphResult, after: EvaluatePartGraphResult): string[] {
  const mismatches: string[] = [];
  if (before.ok !== after.ok) {
    mismatches.push(`ok differs: before=${before.ok} after=${after.ok}`);
    return mismatches;
  }
  if (!before.ok) return mismatches;
  comparePanels(before.panels, after.panels, mismatches);
  compareBridges(before.bridges, after.bridges, mismatches);
  return mismatches;
}

/** Runs one scenario's build -> evaluate -> serialize -> deserialize -> evaluate -> compare. */
export function runReplayInvariantCheck(scenario: ReplayScenario): ReplayCheckResult {
  const { store, partId } = scenario.build();

  const before = evaluatePart(store, partId);
  if (!before.ok) {
    return { ok: false, mismatches: [`initial evaluate failed: ${before.message}`] };
  }

  const replayedStore = GraphStore.deserialize(store.serialize());
  const after = evaluatePart(replayedStore, partId);
  if (!after.ok) {
    return { ok: false, mismatches: [`post-replay evaluate failed: ${after.message}`] };
  }

  const mismatches = compareLayouts(before, after);
  return { ok: mismatches.length === 0, mismatches };
}
