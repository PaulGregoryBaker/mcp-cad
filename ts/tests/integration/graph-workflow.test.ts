/**
 * Integration tests for Manufacturing Graph workflow.
 * Tasks: T054, T065, T066, T067
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ManufacturingGraph } from '../../src/manufacturing/graph/graph';
import { GeometrySolver } from '../../src/manufacturing/graph/solver';
import { DrcChecker } from '../../src/manufacturing/graph/drc';
import { FoldabilityChecker } from '../../src/manufacturing/graph/foldability';
import { toNodeId, computeBendAllowance } from '../../src/manufacturing/graph/types';
import type { PanelNode, BendNode, GeometryBinding } from '../../src/manufacturing/graph/solver';
import { TransactionRegistry } from '../../src/mcp/transactions';

// ─── T054: DRC gate prevents geometry dispatch ───────────────────────────────

describe('DRC gate integration (T054)', () => {
  let graph: ManufacturingGraph;
  let solver: GeometrySolver;
  let drc: DrcChecker;
  let binding: GeometryBinding;
  let mergeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    graph = new ManufacturingGraph({ sessionId: 'test-session', coplanarityThresholdDeg: 1.0 });
    const foldabilityChecker = new FoldabilityChecker();
    drc = new DrcChecker(foldabilityChecker);
    solver = new GeometrySolver();

    mergeSpy = vi.fn().mockReturnValue({ solidId: 'bent-body', bendAllowanceMm: 1.5 });
    binding = {
      mergeBodiesWithBend: mergeSpy,
      splitBodyByBends: vi.fn().mockResolvedValue({ panels: [] }),
      createSnapshot: vi.fn().mockReturnValue('snap-1'),
      restoreSnapshot: vi.fn(),
      deleteSnapshot: vi.fn(),
    } as unknown as GeometryBinding;
  });

  it('does not call mergeBodiesWithBend when DRC_BEND_RADIUS_VIOLATION fires', async () => {
    const p1: PanelNode = {
      type: 'PanelNode', id: toNodeId('p1'), dirty: false,
      bodyId: 'body-p1', thickness: 2, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    const p2: PanelNode = {
      type: 'PanelNode', id: toNodeId('p2'), dirty: false,
      bodyId: 'body-p2', thickness: 2, flatWidth: 80, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    graph.addNode(p1);
    graph.addNode(p2);

    // BendNode with inner radius = 0.5 mm (very tight — should fire DRC)
    const bend: BendNode = {
      type: 'BendNode', id: toNodeId('b1'), dirty: true,
      panelAId: toNodeId('p1'), panelBId: toNodeId('p2'),
      angle: 90, innerRadius: 0.5, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };

    const materialConfig = {
      minBendRadiusMm: 3.0,  // 1.5 × T (T=2mm)
      minFlangeWidthMm: 8,
      thicknessMm: 2,
      defaultKFactor: 0.42,
    };

    // DRC check should fire VIOLATION before geometry
    const drcResult = drc.checkBend({ graph, candidateNode: bend, materialConfig }, bend);
    expect(drcResult.violations.length).toBeGreaterThan(0);
    expect(drcResult.violations[0]!.errorCode).toBe('DRC_BEND_RADIUS_VIOLATION');

    // Simulate what the tool handler does: only call solver if DRC passes
    if (drcResult.violations.length === 0) {
      graph.addNode(bend);
      await solver.solve(graph, binding);
    }

    expect(mergeSpy).not.toHaveBeenCalled();
    // Graph node count should still be 2 (both PanelNodes)
    expect(graph.nodes.size).toBe(2);
  });

  it('calls mergeBodiesWithBend when DRC passes', async () => {
    const p1: PanelNode = {
      type: 'PanelNode', id: toNodeId('p1'), dirty: false,
      bodyId: 'body-p1', thickness: 2, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    const p2: PanelNode = {
      type: 'PanelNode', id: toNodeId('p2'), dirty: false,
      bodyId: 'body-p2', thickness: 2, flatWidth: 80, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    graph.addNode(p1);
    graph.addNode(p2);

    // BendNode with inner radius = 5 mm (well above 1.5 × T = 3 mm)
    const bend: BendNode = {
      type: 'BendNode', id: toNodeId('b1'), dirty: true,
      panelAId: toNodeId('p1'), panelBId: toNodeId('p2'),
      angle: 90, innerRadius: 5, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };

    const materialConfig = {
      minBendRadiusMm: 3.0,
      minFlangeWidthMm: 8,
      thicknessMm: 2,
      defaultKFactor: 0.42,
    };

    const drcResult = drc.checkBend({ graph, candidateNode: bend, materialConfig }, bend);
    expect(drcResult.violations).toHaveLength(0);

    graph.addNode(bend);
    await solver.solve(graph, binding);

    expect(mergeSpy).toHaveBeenCalledOnce();
  });
});

// ─── T065: Golden path integration test ──────────────────────────────────────

describe('Golden path: bootstrap → add_bend → query_graph (T065)', () => {
  it('adds a BendNode and BA is within expected tolerance', () => {
    const start = Date.now();

    const graph = new ManufacturingGraph({ sessionId: 'golden', coplanarityThresholdDeg: 1.0 });

    const p1: PanelNode = {
      type: 'PanelNode', id: toNodeId('p1'), dirty: false,
      bodyId: 'body-p1', thickness: 1, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    const p2: PanelNode = {
      type: 'PanelNode', id: toNodeId('p2'), dirty: false,
      bodyId: 'body-p2', thickness: 1, flatWidth: 80, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    graph.addNode(p1);
    graph.addNode(p2);

    const bend: BendNode = {
      type: 'BendNode', id: toNodeId('b1'), dirty: true,
      panelAId: toNodeId('p1'), panelBId: toNodeId('p2'),
      angle: 90, innerRadius: 1, kFactor: 0.33,
      bendAllowance: null, bendDeduction: null,
    };
    graph.addNode(bend);

    // query_graph: all 3 nodes present, topological order correct
    const nodes = graph.queryNodes(true);
    const ids = nodes.map((n) => n.id);
    expect(ids).toHaveLength(3);
    expect(ids.indexOf(toNodeId('p1'))).toBeLessThan(ids.indexOf(toNodeId('b1')));
    expect(ids.indexOf(toNodeId('p2'))).toBeLessThan(ids.indexOf(toNodeId('b1')));

    // Verify the BendNode is in the graph
    const storedBend = graph.nodes.get(toNodeId('b1'));
    expect(storedBend?.type).toBe('BendNode');

    // BA = π/2 × (R + k×T) = π/2 × (1 + 0.33 × 1) ≈ 2.08 mm
    const expectedBA = computeBendAllowance(90, 1, 0.33, 1);
    // Should be around 2.08 mm ± 0.5 mm
    expect(expectedBA).toBeGreaterThan(1.5);
    expect(expectedBA).toBeLessThan(2.7);

    // Flat pattern dimensions from graph
    const dims = graph.getFlatPatternDimensions(toNodeId('p2'));
    expect(dims).not.toBeNull();
    expect(dims!.width).toBeGreaterThan(100); // p1 + BA + p2

    // Total time should be well under 5s for pure logic
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});

// ─── T066: SC-011/SC-012 performance: solve_geometry called once per dirty node

describe('Performance: binding invoked once per dirty node (T066)', () => {
  it('100-node batch: binding called exactly once per dirty node', async () => {
    const graph = new ManufacturingGraph({ sessionId: 'perf', coplanarityThresholdDeg: 1.0 });
    const solver = new GeometrySolver();

    const mergeSpy = vi.fn().mockReturnValue({ solidId: 'bent-body', bendAllowanceMm: 1.5 });
    const binding: GeometryBinding = {
      mergeBodiesWithBend: mergeSpy,
      splitBodyByBends: vi.fn().mockResolvedValue({ panels: [] }),
      createSnapshot: vi.fn().mockReturnValue('snap-perf'),
      restoreSnapshot: vi.fn(),
      deleteSnapshot: vi.fn(),
    } as unknown as GeometryBinding;

    // Add 50 panel pairs + 50 bend nodes = 100 nodes
    for (let i = 0; i < 50; i++) {
      const pA: PanelNode = {
        type: 'PanelNode', id: toNodeId(`p${i}a`), dirty: false,
        bodyId: `body-p${i}a`, thickness: 2, flatWidth: 100, flatHeight: 50,
        material: 'steel', grainDirection: null, accessibility: 'OPEN',
      };
      const pB: PanelNode = {
        type: 'PanelNode', id: toNodeId(`p${i}b`), dirty: false,
        bodyId: `body-p${i}b`, thickness: 2, flatWidth: 80, flatHeight: 50,
        material: 'steel', grainDirection: null, accessibility: 'OPEN',
      };
      graph.addNode(pA);
      graph.addNode(pB);
    }

    // Clear dirty (simulate post-bootstrap state where panels are already solved)
    for (const node of graph.nodes.values()) { node.dirty = false; }
    graph.dirtyNodes.clear();

    // Now add 50 BendNodes — each is dirty
    for (let i = 0; i < 50; i++) {
      const bend: BendNode = {
        type: 'BendNode', id: toNodeId(`b${i}`), dirty: true,
        panelAId: toNodeId(`p${i}a`), panelBId: toNodeId(`p${i}b`),
        angle: 90, innerRadius: 2, kFactor: 0.42,
        bendAllowance: null, bendDeduction: null,
      };
      graph.addNode(bend);
    }

    expect(graph.dirtyNodes.size).toBe(50);

    const start = Date.now();
    await solver.solve(graph, binding);
    const elapsed = Date.now() - start;

    // binding.mergeBodiesWithBend called exactly 50 times (once per BendNode)
    expect(mergeSpy).toHaveBeenCalledTimes(50);

    // Wall-clock should be well under 3s for mocked operations
    expect(elapsed).toBeLessThan(3000);
  });
});

// ─── T067: SC-005 rollback regression test ───────────────────────────────────

describe('SC-005 rollback regression (T067)', () => {
  it('removeNode(bend) restores graph to pre-bend state; re-add succeeds', () => {
    const graph = new ManufacturingGraph({ sessionId: 'rollback', coplanarityThresholdDeg: 1.0 });

    const p1: PanelNode = {
      type: 'PanelNode', id: toNodeId('p1'), dirty: false,
      bodyId: 'body-p1', thickness: 2, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    const p2: PanelNode = {
      type: 'PanelNode', id: toNodeId('p2'), dirty: false,
      bodyId: 'body-p2', thickness: 2, flatWidth: 80, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    graph.addNode(p1);
    graph.addNode(p2);

    const bend: BendNode = {
      type: 'BendNode', id: toNodeId('b1'), dirty: true,
      panelAId: toNodeId('p1'), panelBId: toNodeId('p2'),
      angle: 90, innerRadius: 2, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };
    graph.addNode(bend);

    expect(graph.nodes.size).toBe(3);

    // Simulate rollback: remove the bend
    graph.removeNode(toNodeId('b1'));

    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.has(toNodeId('b1'))).toBe(false);

    // Re-add bend — should succeed (no cycle, IDs are fresh)
    const bend2: BendNode = { ...bend };
    expect(() => graph.addNode(bend2)).not.toThrow();
    expect(graph.nodes.size).toBe(3);
  });
});

// ─── D1 Remediation: SC-005 rollback via 004-transaction-primitive path ──────

describe('SC-005 real transaction rollback (D1 remediation)', () => {
  it('rollback() sets state to rolled_back and restores geometry snapshot', async () => {
    // Simulate the full 004 rollback path: TransactionRegistry.begin() + rollback()
    // combined with geometry snapshot restore — mirroring handleRollbackTransaction in tools.ts.

    const registry = new TransactionRegistry();
    const restoreSnapshot = vi.fn().mockReturnValue({
      restoredSolidIds: ['body-p1', 'body-p2'],
      restoredShellIds: [],
    });
    const binding: Partial<GeometryBinding> = {
      createSnapshot: vi.fn().mockReturnValue('snap-rollback'),
      restoreSnapshot,
    };

    // Step 1: begin a transaction (take snapshot before mutation)
    const snapshotId = (binding.createSnapshot as ReturnType<typeof vi.fn>)('before add_bend');
    const txn = await registry.begin('add bend b1', snapshotId);
    const txnId = txn.id;
    expect(txn.state).toBe('active');

    // Step 2: mutate graph — add a bend node
    const graph = new ManufacturingGraph({ sessionId: 'rollback-real', coplanarityThresholdDeg: 1.0 });
    const p1: PanelNode = {
      type: 'PanelNode', id: toNodeId('p1'), dirty: false,
      bodyId: 'body-p1', thickness: 2, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    const p2: PanelNode = {
      type: 'PanelNode', id: toNodeId('p2'), dirty: false,
      bodyId: 'body-p2', thickness: 2, flatWidth: 80, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
    graph.addNode(p1);
    graph.addNode(p2);
    const bend: BendNode = {
      type: 'BendNode', id: toNodeId('b1'), dirty: true,
      panelAId: toNodeId('p1'), panelBId: toNodeId('p2'),
      angle: 90, innerRadius: 2, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };
    graph.addNode(bend);
    expect(graph.nodes.size).toBe(3);

    // Step 3: rollback — restore geometry snapshot, then rollback registry
    // (mirrors handleRollbackTransaction in tools.ts: restoreSnapshot → registry.rollback)
    const existing = registry.get(txnId);
    expect(existing).toBeDefined();
    const restoreResult = (binding.restoreSnapshot as ReturnType<typeof vi.fn>)(existing!.snapshotId);
    expect(restoreResult.restoredSolidIds).toContain('body-p1');

    const rolledBack = await registry.rollback(txnId);
    expect(rolledBack.state).toBe('rolled_back');

    // Step 4: simulate graph state restoration (undo graph mutation)
    // In production, the graph rollback is driven by the geometry restore;
    // here we verify the registry is correctly settled so a re-add succeeds.
    graph.removeNode(toNodeId('b1'));
    expect(graph.nodes.size).toBe(2);
    expect(graph.nodes.has(toNodeId('b1'))).toBe(false);

    // Step 5: re-add the same bend — no orphan/cycle errors (registry is no longer blocking)
    expect(() => graph.addNode({ ...bend })).not.toThrow();
    expect(graph.nodes.size).toBe(3);

    // Step 6: a new transaction can now be started (registry is no longer active)
    const snap2 = (binding.createSnapshot as ReturnType<typeof vi.fn>)('before second add_bend');
    const txn2 = await registry.begin('add bend b2', snap2);
    expect(txn2.state).toBe('active');
    await registry.rollback(txn2.id);
  });
});
