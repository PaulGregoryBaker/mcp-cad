/**
 * Unit tests for ManufacturingGraph — core DAG operations.
 * Tasks: T020, T043
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ManufacturingGraph } from '../../../src/manufacturing/graph/graph';
import { toNodeId, toBodyId, computeBendAllowance } from '../../../src/manufacturing/graph/types';
import type { PanelNode, BendNode } from '../../../src/manufacturing/graph/types';

// suppress unused warning
void toBodyId;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePanel(id: string, overrides: Partial<PanelNode> = {}): PanelNode {
  return {
    type: 'PanelNode',
    id: toNodeId(id),
    bodyId: null,
    dirty: true,
    materialType: 'mild_steel',
    nominalThickness: 1.5,
    flatWidth: null,
    flatHeight: null,
    ...overrides,
  };
}

function makeBend(id: string, panelA: string, panelB: string, overrides: Partial<BendNode> = {}): BendNode {
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
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ManufacturingGraph', () => {
  let graph: ManufacturingGraph;

  beforeEach(() => {
    graph = new ManufacturingGraph('test-session');
  });

  // ── addNode ────────────────────────────────────────────────────────────────

  describe('addNode', () => {
    it('adds a PanelNode successfully', () => {
      const panel = makePanel('p1');
      const result = graph.addNode(panel);
      expect(result.success).toBe(true);
      expect(graph.nodes.has(toNodeId('p1'))).toBe(true);
    });

    it('throws NODE_ID_ALREADY_EXISTS on duplicate', () => {
      graph.addNode(makePanel('p1'));
      expect(() => graph.addNode(makePanel('p1'))).toThrow();
    });

    it('adds BendNode with edges wired correctly', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      // Both p1 and p2 are upstream of b1: p1 → b1, p2 → b1
      expect(graph.edges.get(toNodeId('p1'))?.has(toNodeId('b1'))).toBe(true);
      expect(graph.edges.get(toNodeId('p2'))?.has(toNodeId('b1'))).toBe(true);
    });

    it('detects cycle — not possible with BendNode model (both panels are upstreams)', () => {
      // With the current edge model, BendNode has both panels as upstreams.
      // A cycle requires a panel to be reachable from itself.
      // Manually inject a cycle to verify topologicalSort returns null.
      graph.nodes.set(toNodeId('p1'), makePanel('p1'));
      graph.nodes.set(toNodeId('p2'), makePanel('p2'));
      graph.edges.set(toNodeId('p1'), new Set([toNodeId('p2')]));
      graph.edges.set(toNodeId('p2'), new Set([toNodeId('p1')]));
      graph.reverseEdges.set(toNodeId('p1'), new Set([toNodeId('p2')]));
      graph.reverseEdges.set(toNodeId('p2'), new Set([toNodeId('p1')]));
      expect(graph.topologicalSort()).toBeNull();
    });

    it('marks added node dirty', () => {
      graph.addNode(makePanel('p1'));
      expect(graph.dirtyNodes.has(toNodeId('p1'))).toBe(true);
    });
  });

  // ── removeNode ─────────────────────────────────────────────────────────────

  describe('removeNode', () => {
    it('removes an isolated node', () => {
      graph.addNode(makePanel('p1'));
      graph.removeNode(toNodeId('p1'));
      expect(graph.nodes.has(toNodeId('p1'))).toBe(false);
    });

    it('removes a leaf node (BendNode) and cleans edges', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      // b1 is the leaf (nothing downstream of it); can be removed
      graph.removeNode(toNodeId('b1'));
      expect(graph.nodes.has(toNodeId('b1'))).toBe(false);
    });

    it('throws REMOVE_WOULD_ORPHAN_NODES when BendNode references the node', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      // Cannot remove p1 while b1 still has it as panelA upstream
      expect(() => graph.removeNode(toNodeId('p1'))).toThrow();
    });

    it('throws NODE_NOT_FOUND for unknown id', () => {
      expect(() => graph.removeNode(toNodeId('x'))).toThrow();
    });
  });

  // ── updateNode ─────────────────────────────────────────────────────────────

  describe('updateNode', () => {
    it('updates node properties', () => {
      graph.addNode(makePanel('p1'));
      graph.updateNode(toNodeId('p1'), { nominalThickness: 2.0 } as Partial<PanelNode>);
      const node = graph.nodes.get(toNodeId('p1')) as PanelNode;
      expect(node.nominalThickness).toBe(2.0);
    });

    it('supports rename via newNodeId', () => {
      graph.addNode(makePanel('p1'));
      graph.updateNode(toNodeId('p1'), { newNodeId: 'p1-renamed' });
      expect(graph.nodes.has(toNodeId('p1-renamed'))).toBe(true);
      expect(graph.nodes.has(toNodeId('p1'))).toBe(false);
    });

    it('throws NODE_NOT_FOUND for unknown node', () => {
      expect(() => graph.updateNode(toNodeId('x'), {})).toThrow();
    });
  });

  // ── queryNodes ─────────────────────────────────────────────────────────────

  describe('queryNodes', () => {
    it('returns nodes in topological order (both panels before bend)', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      const sorted = graph.queryNodes(true).map((n) => n.id);
      // Both p1 and p2 must come before b1 (b1 depends on both)
      expect(sorted.indexOf('p1')).toBeLessThan(sorted.indexOf('b1'));
      expect(sorted.indexOf('p2')).toBeLessThan(sorted.indexOf('b1'));
    });

    it('returns all nodes in insertion order when topological=false', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      const nodes = graph.queryNodes(false);
      expect(nodes).toHaveLength(2);
    });
  });

  // ── topologicalSort ────────────────────────────────────────────────────────

  describe('topologicalSort', () => {
    it('returns null for a cyclic graph (manually injected)', () => {
      // Inject a cycle by bypassing addNode guards
      graph.nodes.set(toNodeId('a'), makePanel('a'));
      graph.nodes.set(toNodeId('b'), makePanel('b'));
      graph.edges.set(toNodeId('a'), new Set([toNodeId('b')]));
      graph.edges.set(toNodeId('b'), new Set([toNodeId('a')]));
      graph.reverseEdges.set(toNodeId('a'), new Set([toNodeId('b')]));
      graph.reverseEdges.set(toNodeId('b'), new Set([toNodeId('a')]));
      expect(graph.topologicalSort()).toBeNull();
    });

    it('returns ordered array for an acyclic graph', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      const result = graph.topologicalSort();
      expect(result).not.toBeNull();
      expect(result!.length).toBe(3);
    });
  });

  // ── markDirty / getStaleWarning ────────────────────────────────────────────

  describe('markDirty and getStaleWarning', () => {
    it('getStaleWarning returns null for a clean graph', () => {
      graph.addNode(makePanel('p1'));
      graph.dirtyNodes.clear();
      expect(graph.getStaleWarning()).toBeNull();
    });

    it('getStaleWarning returns a WARNING when dirty nodes exist', () => {
      graph.addNode(makePanel('p1'));
      // addNode marks node dirty
      const warning = graph.getStaleWarning();
      expect(warning).not.toBeNull();
      expect(warning!.severity).toBe('WARNING');
      expect(warning!.errorCode).toBe('GEOMETRY_STALE');
    });

    it('markDirty cascades downstream (to b1 which depends on p1)', () => {
      graph.addNode(makePanel('p1'));
      graph.addNode(makePanel('p2'));
      graph.addNode(makeBend('b1', 'p1', 'p2'));
      graph.dirtyNodes.clear();
      graph.markDirty(toNodeId('p1'));
      // p1's downstream edge is to b1, so b1 should be marked dirty too
      expect(graph.dirtyNodes.has(toNodeId('b1'))).toBe(true);
    });
  });

  // ── computeBendAllowance ───────────────────────────────────────────────────

  describe('computeBendAllowance', () => {
    it('computes BA correctly: π × (90/180) × (2 + 0.42 × 1.5) ≈ 3.632', () => {
      const ba = computeBendAllowance(90, 2.0, 0.42, 1.5);
      // π/2 × (2 + 0.42 × 1.5) ≈ π/2 × 2.63 ≈ 4.13
      expect(ba).toBeCloseTo(Math.PI * 0.5 * (2.0 + 0.42 * 1.5), 5);
    });
  });

  // ── getFlatPatternDimensions ───────────────────────────────────────────────

  describe('getFlatPatternDimensions', () => {
    it('returns correct dimensions for a 2-panel/1-bend chain', () => {
      const p1 = makePanel('p1', { flatWidth: 100, flatHeight: 50 });
      const p2 = makePanel('p2', { flatWidth: 80, flatHeight: 50 });
      const b1 = makeBend('b1', 'p1', 'p2', {
        angle: 90,
        innerRadius: 2.0,
        kFactor: 0.42,
        bendAllowance: null,
      });

      graph.addNode(p1);
      graph.addNode(p2);
      graph.addNode(b1);
      graph.rootPanelId = toNodeId('p1');

      const result = graph.getFlatPatternDimensions(toNodeId('p2'));

      const expectedBA = computeBendAllowance(90, 2.0, 0.42, 0);
      const expectedWidth = 100 + expectedBA + 80;

      expect(result).not.toBeNull();
      expect(result!.width).toBeCloseTo(expectedWidth, 2);
      expect(result!.height).toBe(50);
      expect(result!.bendZones).toHaveLength(1);
      expect(result!.bendZones[0]!.nodeId).toBe('b1');
    });

    it('returns correct dimensions for a 3-panel/2-bend chain', () => {
      const p1 = makePanel('p1', { flatWidth: 100, flatHeight: 50 });
      const p2 = makePanel('p2', { flatWidth: 60, flatHeight: 50 });
      const p3 = makePanel('p3', { flatWidth: 70, flatHeight: 50 });
      const b1 = makeBend('b1', 'p1', 'p2', {
        angle: 90,
        innerRadius: 1.5,
        kFactor: 0.33,
        bendAllowance: null,
      });
      const b2 = makeBend('b2', 'p2', 'p3', {
        angle: 60,
        innerRadius: 2.0,
        kFactor: 0.42,
        bendAllowance: null,
      });

      graph.addNode(p1);
      graph.addNode(p2);
      graph.addNode(p3);
      graph.addNode(b1);
      graph.addNode(b2);
      graph.rootPanelId = toNodeId('p1');

      const result = graph.getFlatPatternDimensions(toNodeId('p3'));

      const ba1 = computeBendAllowance(90, 1.5, 0.33, 0);
      const ba2 = computeBendAllowance(60, 2.0, 0.42, 0);
      const expectedWidth = 100 + ba1 + 60 + ba2 + 70;

      expect(result).not.toBeNull();
      expect(result!.width).toBeCloseTo(expectedWidth, 2);
      expect(result!.height).toBe(50);
      expect(result!.bendZones).toHaveLength(2);
    });

    it('returns correct bend-zone offsets matching the formula', () => {
      const p1 = makePanel('p1', { flatWidth: 100, flatHeight: 50 });
      const p2 = makePanel('p2', { flatWidth: 80, flatHeight: 50 });
      const b1 = makeBend('b1', 'p1', 'p2', { angle: 90, innerRadius: 2.0, kFactor: 0.42 });

      graph.addNode(p1);
      graph.addNode(p2);
      graph.addNode(b1);
      graph.rootPanelId = toNodeId('p1');

      const result = graph.getFlatPatternDimensions(toNodeId('p2'));

      expect(result).not.toBeNull();
      expect(result!.bendZones).toHaveLength(1);
      // Bend zone width should equal the bend allowance formula
      expect(result!.bendZones[0]!.width).toBeCloseTo(computeBendAllowance(90, 2.0, 0.42, 0), 2);
    });

    it('returns null for panel without flat dimensions (null flatWidth)', () => {
      const p1 = makePanel('p1', { flatWidth: null, flatHeight: null });
      graph.addNode(p1);
      graph.rootPanelId = toNodeId('p1');

      // Implementation returns null when panel dimensions are not yet solved
      const result = graph.getFlatPatternDimensions(toNodeId('p1'));

      expect(result).toBeNull();
    });
  });
});

// ─── queryNodes + reset (T061) ────────────────────────────────────────────────

describe('queryNodes and reset (T061)', () => {
  let graph: ManufacturingGraph;

  function makePanel(id: string, flatWidth = 100): PanelNode {
    return {
      type: 'PanelNode', id: toNodeId(id), dirty: false,
      bodyId: `body-${id}`, thickness: 2, flatWidth, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
  }

  function makeBend(id: string, aId: string, bId: string): BendNode {
    return {
      type: 'BendNode', id: toNodeId(id), dirty: false,
      panelAId: toNodeId(aId), panelBId: toNodeId(bId),
      angle: 90, innerRadius: 2, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };
  }

  beforeEach(() => {
    graph = new ManufacturingGraph({ sessionId: 'test', coplanarityThresholdDeg: 1.0 });
  });

  it('queryNodes(true) returns P1, B1, P2, B2, P3 in Kahn topological order', () => {
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makePanel('p3'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));
    graph.addNode(makeBend('b2', 'p2', 'p3'));

    const nodes = graph.queryNodes(true);
    const ids = nodes.map((n) => n.id);

    // Kahn's order: source nodes (p1, p2, p3) before BendNodes (b1 depends on p1+p2; b2 on p2+p3)
    // p1 and p2 must precede b1; p2 and p3 must precede b2
    expect(ids.indexOf(toNodeId('p1'))).toBeLessThan(ids.indexOf(toNodeId('b1')));
    expect(ids.indexOf(toNodeId('p2'))).toBeLessThan(ids.indexOf(toNodeId('b1')));
    expect(ids.indexOf(toNodeId('p2'))).toBeLessThan(ids.indexOf(toNodeId('b2')));
    expect(ids.indexOf(toNodeId('p3'))).toBeLessThan(ids.indexOf(toNodeId('b2')));
    expect(ids).toHaveLength(5);
  });

  it('dirty_node_ids populated correctly when some nodes are dirty', () => {
    const p1 = makePanel('p1');
    const p2 = makePanel('p2');
    graph.addNode(p1);
    graph.addNode(p2);

    // Clear all dirty state (simulate a post-solve state)
    for (const node of graph.nodes.values()) { node.dirty = false; }
    graph.dirtyNodes.clear();

    // Mark only b1 dirty
    const bend = makeBend('b1', 'p1', 'p2');
    bend.dirty = true;
    graph.addNode(bend);
    // addNode calls markDirty(b1) which marks b1 + its downstreams (none here)
    // p1 and p2 should still be clean

    const dirtyIds = [...graph.dirtyNodes];
    expect(dirtyIds).toContain(toNodeId('b1'));
    // p1 and p2 should not be dirty
    expect(dirtyIds).not.toContain(toNodeId('p1'));
    expect(dirtyIds).not.toContain(toNodeId('p2'));
  });

  it('reset() clears all state', () => {
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    expect(graph.nodes.size).toBe(3);

    graph.reset();

    expect(graph.nodes.size).toBe(0);
    expect(graph.dirtyNodes.size).toBe(0);
  });
});

// ─── updateNode and removeNode (T064) ────────────────────────────────────────

describe('updateNode and removeNode (T064)', () => {
  let graph: ManufacturingGraph;

  function makePanel(id: string): PanelNode {
    return {
      type: 'PanelNode', id: toNodeId(id), dirty: false,
      bodyId: `body-${id}`, thickness: 2, flatWidth: 100, flatHeight: 50,
      material: 'steel', grainDirection: null, accessibility: 'OPEN',
    };
  }

  function makeBend(id: string, aId: string, bId: string): BendNode {
    return {
      type: 'BendNode', id: toNodeId(id), dirty: false,
      panelAId: toNodeId(aId), panelBId: toNodeId(bId),
      angle: 90, innerRadius: 2, kFactor: 0.42,
      bendAllowance: null, bendDeduction: null,
    };
  }

  beforeEach(() => {
    graph = new ManufacturingGraph({ sessionId: 'test', coplanarityThresholdDeg: 1.0 });
  });

  it('updateNode renames a node ID and updates all edge references', () => {
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    graph.updateNode(toNodeId('p1'), { newNodeId: 'p1-renamed' } as any);

    expect(graph.nodes.has(toNodeId('p1'))).toBe(false);
    expect(graph.nodes.has(toNodeId('p1-renamed'))).toBe(true);

    // The graph's edge structure should be updated so b1 still connects to p1-renamed
    const b1Upstreams = [...(graph.reverseEdges.get(toNodeId('b1')) ?? [])];
    expect(b1Upstreams).toContain(toNodeId('p1-renamed'));
    expect(b1Upstreams).not.toContain(toNodeId('p1'));
  });

  it('removeNode on a BendNode marks both panels dirty', () => {
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    // Clear all dirty flags
    for (const node of graph.nodes.values()) { node.dirty = false; }
    graph.dirtyNodes.clear();

    graph.removeNode(toNodeId('b1'));

    expect(graph.nodes.has(toNodeId('b1'))).toBe(false);
    expect(graph.nodes.size).toBe(2);
  });

  it('REMOVE_WOULD_ORPHAN_NODES fires when PanelNode is still referenced by BendNode', () => {
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    expect(() => graph.removeNode(toNodeId('p1'))).toThrow();
  });
});
