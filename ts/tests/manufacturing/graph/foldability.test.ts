/**
 * Unit tests for FoldabilityChecker.
 * Tasks: T058
 */

import { describe, it, expect } from 'vitest';
import { FoldabilityChecker } from '../../../src/manufacturing/graph/foldability';
import { ManufacturingGraph } from '../../../src/manufacturing/graph/graph';
import { toNodeId } from '../../../src/manufacturing/graph/types';
import type { PanelNode, BendNode } from '../../../src/manufacturing/graph/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePanel(id: string): PanelNode {
  return {
    type: 'PanelNode',
    id: toNodeId(id),
    bodyId: null,
    dirty: false,
    materialType: 'mild_steel',
    nominalThickness: 1.5,
    flatWidth: 50,
    flatHeight: 100,
  };
}

function makeBend(id: string, panelA: string, panelB: string): BendNode {
  return {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: false,
    panelAId: toNodeId(panelA),
    panelBId: toNodeId(panelB),
    innerRadius: 2.0,
    angle: 90,
    kFactor: 0.42,
    bendAllowance: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FoldabilityChecker', () => {
  it('returns OPEN for a panel with no bends', () => {
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1'));

    const checker = new FoldabilityChecker();
    const result = checker.check({ graph });
    const p1Accessibility = result.panelAccessibility.find((pa) => pa.panelId === 'p1');
    expect(p1Accessibility?.state).toBe('OPEN');
    expect(result.violations).toHaveLength(0);
  });

  it('returns OPEN for a panel with one bend', () => {
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    const checker = new FoldabilityChecker();
    const result = checker.check({ graph });
    const p1Acc = result.panelAccessibility.find((pa) => pa.panelId === 'p1');
    expect(p1Acc?.state).toBe('OPEN');
    expect(result.violations).toHaveLength(0);
  });

  it('returns CONSTRAINED for a panel with two bends', () => {
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makePanel('p3'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));
    graph.addNode(makeBend('b2', 'p1', 'p3'));

    const checker = new FoldabilityChecker();
    const result = checker.check({ graph });
    const p1Acc = result.panelAccessibility.find((pa) => pa.panelId === 'p1');
    expect(p1Acc?.state).toBe('CONSTRAINED');
  });

  it('returns INACCESSIBLE and emits violation for a panel with 3+ bends', () => {
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makePanel('p3'));
    graph.addNode(makePanel('p4'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));
    graph.addNode(makeBend('b2', 'p1', 'p3'));
    graph.addNode(makeBend('b3', 'p1', 'p4'));

    const checker = new FoldabilityChecker();
    const result = checker.check({ graph });
    const p1Acc = result.panelAccessibility.find((pa) => pa.panelId === 'p1');
    expect(p1Acc?.state).toBe('INACCESSIBLE');
    const violationCodes = result.violations.map((v) => v.errorCode);
    expect(violationCodes).toContain('DRC_FOLDABILITY_VIOLATION');
  });

  it('checkWithProposed includes the proposed bend in accessibility', () => {
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1'));
    graph.addNode(makePanel('p2'));
    graph.addNode(makePanel('p3'));
    graph.addNode(makeBend('b1', 'p1', 'p2'));

    // p1 already has 1 bend; proposed bend b2 would make it CONSTRAINED
    const proposed = makeBend('b2', 'p1', 'p3');
    const checker = new FoldabilityChecker();
    const result = checker.checkWithProposed(graph, proposed);
    const p1Acc = result.panelAccessibility.find((pa) => pa.panelId === 'p1');
    expect(p1Acc?.state).toBe('CONSTRAINED');
  });
});
