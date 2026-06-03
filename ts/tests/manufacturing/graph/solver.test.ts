/**
 * Unit tests for GeometrySolver.
 * Tasks: T025
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeometrySolver, addonToBinding } from '../../../src/manufacturing/graph/solver';
import { ManufacturingGraph } from '../../../src/manufacturing/graph/graph';
import { toNodeId, toBodyId } from '../../../src/manufacturing/graph/types';
import type { GeometryBinding } from '../../../src/manufacturing/graph/solver';
import type { PanelNode, BendNode } from '../../../src/manufacturing/graph/types';
// ─── Mock binding ─────────────────────────────────────────────────────────────

function makeMockBinding(overrides: Partial<GeometryBinding> = {}): GeometryBinding {
  return {
    createSnapshot: vi.fn().mockReturnValue('snap-1'),
    restoreSnapshot: vi.fn().mockReturnValue({ restoredSolidIds: [], restoredShellIds: [] }),
    mergeBodiesWithBend: vi.fn().mockReturnValue({ mergedShellId: 'merged-shell' }),
    splitBodyByBends: vi.fn().mockReturnValue({ panel_ids: ['body-a', 'body-b'] }),
    fuseBodies: vi.fn().mockReturnValue({ solid_id: 'fused-solid' }),
    cutBodies: vi.fn().mockReturnValue({ solid_id: 'cut-solid' }),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePanel(id: string, bodyId?: string): PanelNode {
  return {
    type: 'PanelNode',
    id: toNodeId(id),
    bodyId: bodyId ? toBodyId(bodyId) : null,
    dirty: true,
    materialType: 'mild_steel',
    nominalThickness: 1.5,
    flatWidth: 100,
    flatHeight: 50,
  };
}

function makeBend(id: string, panelA: string, panelB: string): BendNode {
  return {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: true,
    panelAId: toNodeId(panelA),
    panelBId: toNodeId(panelB),
    innerRadius: 2.0,
    angle: 90,
    kFactor: 0.42,
    bendAllowance: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GeometrySolver', () => {
  let graph: ManufacturingGraph;
  let solver: GeometrySolver;

  beforeEach(() => {
    graph = new ManufacturingGraph('test-session');
    solver = new GeometrySolver();
  });

  it('returns early when no dirty nodes', async () => {
    const binding = makeMockBinding();
    graph.addNode(makePanel('p1'));
    graph.dirtyNodes.clear();

    const outcome = await solver.solve(graph, binding);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.dirtyCountBefore).toBe(0);
      expect(outcome.result.solvedNodes).toHaveLength(0);
    }
    expect(binding.createSnapshot).not.toHaveBeenCalled();
  });

  it('creates snapshot and clears dirty nodes on success', async () => {
    const binding = makeMockBinding();
    graph.addNode(makePanel('p1', 'body-p1'));
    graph.addNode(makePanel('p2', 'body-p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    const outcome = await solver.solve(graph, binding);
    expect(outcome.ok).toBe(true);
    expect(binding.createSnapshot).toHaveBeenCalled();
    expect(graph.dirtyNodes.size).toBe(0);
  });

  it('calls mergeBodiesWithBend for a BendNode', async () => {
    const binding = makeMockBinding();
    const p1 = makePanel('p1', 'body-p1');
    const p2 = makePanel('p2', 'body-p2');
    graph.addNode(p1);
    graph.addNode(p2);
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    await solver.solve(graph, binding);
    expect(binding.mergeBodiesWithBend).toHaveBeenCalledWith(
      'body-p1', 'body-p2', [], 2.0,
    );
  });

  it('restores snapshot and marks dirty on node failure', async () => {
    const binding = makeMockBinding({
      mergeBodiesWithBend: vi.fn().mockImplementation(() => {
        throw new Error('NAPI error');
      }),
    });
    graph.addNode(makePanel('p1', 'body-p1'));
    graph.addNode(makePanel('p2', 'body-p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    const outcome = await solver.solve(graph, binding);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('SOLVE_FAILED');
      expect(outcome.offendingNodeId).toBe('b1');
    }
    expect(binding.restoreSnapshot).toHaveBeenCalled();
    // dirty flags should be restored
    expect(graph.dirtyNodes.size).toBeGreaterThan(0);
  });

  it('computes bendAllowance on BendNode dispatch', async () => {
    const binding = makeMockBinding();
    graph.addNode(makePanel('p1', 'body-p1'));
    graph.addNode(makePanel('p2', 'body-p2'));
    const bend = makeBend('b1', 'p1', 'p2');
    graph.addNode(bend);

    await solver.solve(graph, binding);
    const updatedBend = graph.nodes.get(toNodeId('b1')) as BendNode;
    expect(updatedBend.bendAllowance).not.toBeNull();
    // BA = π × (90/180) × (2.0 + 0.42 × 1.5)
    const expected = Math.PI * 0.5 * (2.0 + 0.42 * 1.5);
    expect(updatedBend.bendAllowance).toBeCloseTo(expected, 4);
  });
});

// ─── JoinNode dispatch tests (T047) ──────────────────────────────────────────

describe('GeometrySolver — JoinNode dispatch', () => {
  let graph: ManufacturingGraph;
  let solver: GeometrySolver;

  beforeEach(() => {
    graph = new ManufacturingGraph('join-test-session');
    solver = new GeometrySolver();
  });

  it('RIVET_PATTERN solve completes without calling binding geometry methods', async () => {
    const addTabSlotSpy = vi.fn().mockReturnValue({ solidIdA: 'a-new', solidIdB: 'b-new' });
    const binding = makeMockBinding({ addTabSlot: addTabSlotSpy });

    graph.addNode(makePanel('p1', 'body-p1'));
    graph.addNode(makePanel('p2', 'body-p2'));

    const joinNode = {
      type: 'JoinNode' as const,
      id: toNodeId('j1'),
      dirty: true,
      panelAId: toNodeId('p1'),
      panelBId: toNodeId('p2'),
      referenceEdgeA: 'edge-a',
      referenceEdgeB: 'edge-b',
      joinType: 'RIVET_PATTERN' as const,
      params: { joinParamType: 'RIVET_PATTERN' as const, spacing: 25, diameter: 4, edgeOffset: 10 },
    };
    graph.addNode(joinNode);

    const outcome = await solver.solve(graph, binding);
    expect(outcome.ok).toBe(true);
    // RIVET_PATTERN is a no-op stub — addTabSlot should NOT be called
    expect(addTabSlotSpy).not.toHaveBeenCalled();
  });

  it('TAB_SLOT solve dispatches to binding.addTabSlot', async () => {
    const addTabSlotSpy = vi.fn().mockReturnValue({ solidIdA: 'a-new', solidIdB: 'b-new' });
    const binding = makeMockBinding({ addTabSlot: addTabSlotSpy });

    graph.addNode(makePanel('p1', 'body-p1'));
    graph.addNode(makePanel('p2', 'body-p2'));

    const joinNode = {
      type: 'JoinNode' as const,
      id: toNodeId('j1'),
      dirty: true,
      panelAId: toNodeId('p1'),
      panelBId: toNodeId('p2'),
      referenceEdgeA: 'edge-a',
      referenceEdgeB: 'edge-b',
      joinType: 'TAB_SLOT' as const,
      params: { joinParamType: 'TAB_SLOT' as const, tabWidth: 10, tabDepth: 5, count: 3 },
    };
    graph.addNode(joinNode);

    const outcome = await solver.solve(graph, binding);
    expect(outcome.ok).toBe(true);
    expect(addTabSlotSpy).toHaveBeenCalledWith('body-p1', 'body-p2', 0.1);
  });
});

describe('addonToBinding', () => {
  it('adapts GeometryAddon to GeometryBinding correctly', () => {
    const fakeAddon = {
      createSnapshot: vi.fn().mockReturnValue('snap'),
      restoreSnapshot: vi.fn().mockReturnValue({ restoredSolidIds: ['a'], restoredShellIds: [] }),
      mergeBodiesWithBend: vi.fn().mockReturnValue({ mergedShellId: 'shell', rollbackToken: 'tok' }),
      splitBodyByBends: vi.fn().mockReturnValue({ panel_ids: ['x', 'y'] }),
      fuseBodies: vi.fn().mockReturnValue({ solid_id: 's', disjoint: false, rollback_token: 't' }),
      cutBodies: vi.fn().mockReturnValue({ solid_id: 's2', rollback_token: 't2' }),
    };

    const binding = addonToBinding(fakeAddon as any);
    expect(binding.createSnapshot('test')).toBe('snap');
    expect(binding.restoreSnapshot('snap').restoredSolidIds).toEqual(['a']);
    expect(binding.mergeBodiesWithBend('a', 'b', [], 2).mergedShellId).toBe('shell');
    expect(binding.splitBodyByBends('a', 30).panel_ids).toEqual(['x', 'y']);
    expect(binding.fuseBodies(['a', 'b'], 0.1).solid_id).toBe('s');
    expect(binding.cutBodies('blank', ['tool'], false).solid_id).toBe('s2');
  });
});
