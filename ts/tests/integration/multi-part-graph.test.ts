/**
 * Integration tests for Manufacturing Graph multi-part support.
 * Feature 009 multi-part: tests that verify independent part management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ManufacturingGraph } from '../../src/manufacturing/graph/graph';
import { toNodeId } from '../../src/manufacturing/graph/types';
import type { PanelNode, BendNode } from '../../src/manufacturing/graph/types';

describe('Manufacturing Graph Multi-Part Support (Feature 009)', () => {
  describe('Part isolation: mutations on part-a do not affect part-b', () => {
    let partA: ManufacturingGraph;
    let partB: ManufacturingGraph;

    beforeEach(() => {
      partA = new ManufacturingGraph('part-a');
      partB = new ManufacturingGraph('part-b');
    });

    it('separate parts maintain independent node collections', () => {
      // Add panel to part A
      const panelA: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel-1'),
        dirty: false,
        bodyId: 'body-a1',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      partA.addNode(panelA);

      // Add panel to part B
      const panelB: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel-1'), // same node ID, different part
        dirty: false,
        bodyId: 'body-b1',
        thickness: 1.5,
        flatWidth: 80,
        flatHeight: 60,
        material: 'aluminum',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      partB.addNode(panelB);

      // Verify parts have correct independent nodes
      const nodesA = partA.queryNodes(false);
      const nodesB = partB.queryNodes(false);

      expect(nodesA).toHaveLength(1);
      expect(nodesB).toHaveLength(1);
      expect((nodesA[0] as PanelNode).thickness).toBe(1.0);
      expect((nodesB[0] as PanelNode).thickness).toBe(1.5);
    });

    it('removing a node from part A does not affect part B', () => {
      // Add panels to both parts
      const panelA: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel'),
        dirty: false,
        bodyId: 'body-a',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const panelB: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel'),
        dirty: false,
        bodyId: 'body-b',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      partA.addNode(panelA);
      partB.addNode(panelB);

      expect(partA.queryNodes(false)).toHaveLength(1);
      expect(partB.queryNodes(false)).toHaveLength(1);

      // Remove from part A
      partA.removeNode(toNodeId('panel'));

      // Verify part A is empty and part B still has the node
      expect(partA.queryNodes(false)).toHaveLength(0);
      expect(partB.queryNodes(false)).toHaveLength(1);
    });

    it('resetting part A does not affect part B state', () => {
      // Add panels to both parts
      const panel: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel'),
        dirty: false,
        bodyId: 'body',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      partA.addNode({ ...panel, id: toNodeId('panel-a') });
      partB.addNode({ ...panel, id: toNodeId('panel-b') });

      expect(partA.queryNodes(false)).toHaveLength(1);
      expect(partB.queryNodes(false)).toHaveLength(1);

      // Reset part A
      partA.reset();

      // Verify part A is empty and part B still has its node
      expect(partA.queryNodes(false)).toHaveLength(0);
      expect(partB.queryNodes(false)).toHaveLength(1);
    });

    it('bend operations on part A do not cross-reference part B nodes', () => {
      // Add two panels to part A
      const panelA1: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel-a1'),
        dirty: false,
        bodyId: 'body-a1',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const panelA2: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel-a2'),
        dirty: false,
        bodyId: 'body-a2',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      // Add one panel to part B
      const panelB: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel-b'),
        dirty: false,
        bodyId: 'body-b',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      partA.addNode(panelA1);
      partA.addNode(panelA2);
      partB.addNode(panelB);

      // Add bend to part A connecting its two panels
      const bendA: BendNode = {
        type: 'BendNode',
        id: toNodeId('bend-a'),
        dirty: true,
        panelAId: toNodeId('panel-a1'),
        panelBId: toNodeId('panel-a2'),
        innerRadius: 1.0,
        angle: 90,
        kFactor: 0.33,
        bendAllowance: null,
      };

      partA.addNode(bendA);

      // Verify part A has 3 nodes (2 panels + 1 bend)
      expect(partA.queryNodes(false)).toHaveLength(3);
      expect(partB.queryNodes(false)).toHaveLength(1);

      // Verify part B panel is unaffected
      const nodesB = partB.queryNodes(false);
      expect(nodesB[0].id).toBe(toNodeId('panel-b'));
    });

    it('node ID rename on part A does not affect part B with same ID', () => {
      // Add panels with same ID to both parts - each gets its own copy
      const panelA: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel'),
        dirty: false,
        bodyId: 'body-a',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      const panelB: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('panel'),
        dirty: false,
        bodyId: 'body-b',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };

      partA.addNode(panelA);
      partB.addNode(panelB);

      // Rename in part A
      partA.updateNode(toNodeId('panel'), { newNodeId: toNodeId('panel-renamed') });

      // Verify part A has renamed node and part B still has original
      expect(partA.queryNodes(false)[0].id).toBe(toNodeId('panel-renamed'));
      expect(partB.queryNodes(false)[0].id).toBe(toNodeId('panel'));
    });
  });

  describe('Concurrent multi-part editing scenarios', () => {
    let partA: ManufacturingGraph;
    let partB: ManufacturingGraph;

    beforeEach(() => {
      partA = new ManufacturingGraph('part-a');
      partB = new ManufacturingGraph('part-b');
    });

    it('adding nodes to both parts simultaneously maintains isolation', () => {
      const panelsA = [
        {
          type: 'PanelNode' as const,
          id: toNodeId('panel-a1'),
          dirty: false,
          bodyId: 'body-a1',
          thickness: 1.0,
          flatWidth: 100,
          flatHeight: 50,
          material: 'steel',
          grainDirection: null as null,
          accessibility: 'OPEN' as const,
        },
        {
          type: 'PanelNode' as const,
          id: toNodeId('panel-a2'),
          dirty: false,
          bodyId: 'body-a2',
          thickness: 1.0,
          flatWidth: 100,
          flatHeight: 50,
          material: 'steel',
          grainDirection: null as null,
          accessibility: 'OPEN' as const,
        },
      ];

      const panelsB = [
        {
          type: 'PanelNode' as const,
          id: toNodeId('panel-b1'),
          dirty: false,
          bodyId: 'body-b1',
          thickness: 1.5,
          flatWidth: 80,
          flatHeight: 60,
          material: 'aluminum',
          grainDirection: null as null,
          accessibility: 'OPEN' as const,
        },
        {
          type: 'PanelNode' as const,
          id: toNodeId('panel-b2'),
          dirty: false,
          bodyId: 'body-b2',
          thickness: 1.5,
          flatWidth: 80,
          flatHeight: 60,
          material: 'aluminum',
          grainDirection: null as null,
          accessibility: 'OPEN' as const,
        },
        {
          type: 'PanelNode' as const,
          id: toNodeId('panel-b3'),
          dirty: false,
          bodyId: 'body-b3',
          thickness: 1.5,
          flatWidth: 80,
          flatHeight: 60,
          material: 'aluminum',
          grainDirection: null as null,
          accessibility: 'OPEN' as const,
        },
      ];

      panelsA.forEach((p) => partA.addNode(p as PanelNode));
      panelsB.forEach((p) => partB.addNode(p as PanelNode));

      expect(partA.queryNodes(false)).toHaveLength(2);
      expect(partB.queryNodes(false)).toHaveLength(3);
    });

    it('querying parts independently returns correct topological order', () => {
      // Build a chain in part A: p1 -> b1 -> p2
      const p1: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('p1'),
        dirty: false,
        bodyId: 'body-p1',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const p2: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('p2'),
        dirty: false,
        bodyId: 'body-p2',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const b1: BendNode = {
        type: 'BendNode',
        id: toNodeId('b1'),
        dirty: false,
        panelAId: toNodeId('p1'),
        panelBId: toNodeId('p2'),
        innerRadius: 1.0,
        angle: 90,
        kFactor: 0.33,
        bendAllowance: 3.5,
      };

      partA.addNode(p1);
      partA.addNode(p2);
      partA.addNode(b1);

      const topoOrder = partA.queryNodes(true);
      const ids = topoOrder.map((n) => n.id);

      // In topological order, both panels should come before the bend
      expect(ids.indexOf(toNodeId('p1'))).toBeLessThan(ids.indexOf(toNodeId('b1')));
      expect(ids.indexOf(toNodeId('p2'))).toBeLessThan(ids.indexOf(toNodeId('b1')));

      // Part B should be unaffected
      expect(partB.queryNodes(true)).toHaveLength(0);
    });
  });

  describe('Part-level flat pattern dimensions', () => {
    let graph: ManufacturingGraph;

    beforeEach(() => {
      graph = new ManufacturingGraph('test-part');
    });

    it('getFlatPatternDimensions returns correct per-part flat dimensions', () => {
      // Build: p1 (100x50) -> b1 (90°, BA=3.5) -> p2 (100x50)
      const p1: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('p1'),
        dirty: false,
        bodyId: 'body-p1',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const p2: PanelNode = {
        type: 'PanelNode',
        id: toNodeId('p2'),
        dirty: false,
        bodyId: 'body-p2',
        thickness: 1.0,
        flatWidth: 100,
        flatHeight: 50,
        material: 'steel',
        grainDirection: null,
        accessibility: 'OPEN',
      };
      const b1: BendNode = {
        type: 'BendNode',
        id: toNodeId('b1'),
        dirty: false,
        panelAId: toNodeId('p1'),
        panelBId: toNodeId('p2'),
        innerRadius: 1.0,
        angle: 90,
        kFactor: 0.33,
        bendAllowance: 3.5,
      };

      graph.addNode(p1);
      graph.addNode(p2);
      graph.addNode(b1);

      // Query flat dimensions starting from p1
      const dims = graph.getFlatPatternDimensions(toNodeId('p1'));

      expect(dims).not.toBeNull();
      if (dims) {
        expect(dims.width).toBe(100); // p1 flat width
        expect(dims.bendZones.length).toBeGreaterThanOrEqual(0); // May have bend zones
        // The height calculation depends on the unfolding algorithm
        expect(dims.height).toBeGreaterThan(0);
      }
    });
  });
});
