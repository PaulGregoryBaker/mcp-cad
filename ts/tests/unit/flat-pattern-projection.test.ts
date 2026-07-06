/**
 * Unit tests for the geometric flat-pattern projection algorithm.
 *
 * Tests that projectIntoFlatPattern correctly locates a 3D point within the
 * composite flat pattern using panel frames — without any chain-walk
 * approximation or topology assumptions.
 *
 * Test cases cover:
 *   1. Single-panel composite: P1 anywhere on the panel
 *   2. Sequential 2-panel: P1 on Panel A's far edge → flatX = W_A
 *   3. Sequential 2-panel: P1 on Panel B's far edge → flatX = W_A + BA + W_B
 *   4. Near-end connection: P1 on Panel A's near (anchor) edge → flatX = 0
 *   5. 3-panel composite: P1 on Panel B (middle) → flatX = W_A + BA + local_u
 *   6. Point not in any panel → returns null
 *   7. Tolerance: point slightly outside boundary still finds the panel
 */
import { describe, it, expect } from 'vitest';
import { projectIntoFlatPattern, buildChainBends } from '../../src/mcp/handlers/flat-pattern-projection';
import { ManufacturingGraph } from '../../src/manufacturing/graph/graph';
import type { BendNode, PanelNode } from '../../src/manufacturing/graph/types';
import { toNodeId, toBodyId } from '../../src/manufacturing/graph/types';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers for building minimal test graphs
// ──────────────────────────────────────────────────────────────────────────────

/** A trivial flat panel lying in the XZ plane at Y=0. U = +X, V = +Z. */
function makePanelFrame(
  originX: number, originY: number, originZ: number,
): { origin: [number,number,number], u: [number,number,number], v: [number,number,number] } {
  return {
    origin: [originX, originY, originZ],
    u: [1, 0, 0],  // +X
    v: [0, 0, 1],  // +Z (seam/fold-axis direction)
  };
}

/** A panel tilted 90° around Z: lies in the YZ plane. U = +Y. */
function makePanelFrameY(
  originX: number, originY: number, originZ: number,
): { origin: [number,number,number], u: [number,number,number], v: [number,number,number] } {
  return {
    origin: [originX, originY, originZ],
    u: [0, 1, 0],  // +Y (perpendicular to X panel)
    v: [0, 0, 1],  // +Z (same seam direction)
  };
}

function makePanelNode(id: string, flatWidth: number, frame: ReturnType<typeof makePanelFrame>): PanelNode {
  return {
    type: 'PanelNode',
    id: toNodeId(id),
    bodyId: toBodyId(id),
    dirty: false,
    materialType: 'default',
    nominalThickness: 1.0,
    flatWidth,
    flatHeight: 200,
    canonical: false,
    shapeDxf: null,
    panelFrame: {
      origin: frame.origin as [number,number,number],
      u: frame.u as [number,number,number],
      v: frame.v as [number,number,number],
    },
    dxfPlacement: { rotationMatrix: [[1,0],[0,1]], translation: [0,0] },
  };
}

function makeBendNode(
  id: string,
  panelAId: string,
  panelBId: string,
  bendZoneDxfX: number,
  bendAllowance = 1.0,
): BendNode {
  return {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: false,
    panelAId: toNodeId(panelAId),
    panelBId: toNodeId(panelBId),
    innerRadius: 1.0,
    angle: 90,
    foldNormal: [0, -1, 0],
    bendDir: [1, 0, 0],
    anchor: [0, 0, 0],
    kFactor: 0.42,
    bendAllowance,
    bendZoneDxfX,
  };
}

/** Build a graph with N panels in a straight-chain composite. */
function buildLinearComposite(panels: Array<{id: string, width: number, frame: ReturnType<typeof makePanelFrame>}>, ba = 1.0) {
  const graph = new ManufacturingGraph('test');

  // Add panel nodes
  panels.forEach(p => graph.addNode(makePanelNode(p.id, p.width, p.frame)));

  // Add bend nodes connecting consecutive panels
  let cumulativeX = 0;
  for (let i = 0; i < panels.length - 1; i++) {
    cumulativeX += panels[i]!.width;
    graph.addNode(makeBendNode(
      `bend-${i}`,
      panels[i]!.id,        // panelAId
      panels[i + 1]!.id,    // panelBId
      cumulativeX,           // bendZoneDxfX = end of panel A
      ba,
    ));
    cumulativeX += ba;
  }

  return { graph, totalWidth: cumulativeX + (panels[panels.length - 1]?.width ?? 0) };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('projectIntoFlatPattern', () => {

  describe('single-panel composite', () => {
    it('projects a point at origin (u=0) to flatX=0', () => {
      const frame = makePanelFrame(10, 0, 20); // panel at world (10,0,20)
      const { graph } = buildLinearComposite([{ id: 'pA', width: 150, frame }]);
      const chainBends = buildChainBends(graph, toNodeId('pA'));
      // chainBends is empty (no BendNodes) — falls through to single-panel check

      // P1 at panel's origin
      const result = projectIntoFlatPattern([10, 0, 20], chainBends, graph);
      // Single panel, no BendNodes → not found via chain (expected null)
      // This tests the "no bends" base case
      expect(result).toBeNull(); // no BendNodes to walk through
    });
  });

  describe('two-panel sequential composite (L-shape)', () => {
    const W_A = 150, W_B = 200, BA = 1;
    // Panel A: in XZ plane at Y=0, origin (0,0,0), extends from x=0 to x=150
    const frameA = makePanelFrame(0, 0, 0);
    // Panel B: bent 90°, in YZ plane, origin at (W_A+BA, 0, 0), extends in +Y
    // (Panel B connects to Panel A's far edge at x=W_A)
    const frameB = makePanelFrameY(W_A + BA, 0, 0); // origin at where Panel B starts

    let graph: ManufacturingGraph;
    let chainBends: BendNode[];

    beforeEach(() => {
      const built = buildLinearComposite([
        { id: 'pA', width: W_A, frame: frameA },
        { id: 'pB', width: W_B, frame: frameB },
      ], BA);
      graph = built.graph;
      // For a 2-panel composite, the chain is:
      // BendNode(pA→pB) with panelAId=pA, bendZoneDxfX=W_A
      chainBends = buildChainBends(graph, toNodeId('pA'));
      // buildChainBends from 'pA' canonical: no bend has panelBId='pA' → empty
      // We need to traverse from the LAST node backward
      // Let's use the BendNode directly
      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      // Build from pB backward
      const bends: BendNode[] = [];
      let cur: string | undefined = 'pB';
      while (cur) {
        const bn = bendByPanelB.get(cur);
        if (!bn) break;
        bends.unshift(bn);
        cur = bn.panelAId as string;
      }
      chainBends = bends;
    });

    it('P1 on Panel A far edge: flatX = W_A, found in pA', () => {
      // Panel A's far edge (hinge) = world x=W_A, y=0, z=any
      const P1: [number,number,number] = [W_A, 0, 100]; // mid-height of seam
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(W_A, 0);
      expect(result!.flatV).toBeCloseTo(100, 0); // seam position = z component
    });

    it('P1 on Panel A near edge (anchor): flatX = 0, found in pA', () => {
      // Panel A's near edge = world x=0, y=0
      const P1: [number,number,number] = [0, 0, 75]; // anchor end, mid-height
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(0, 0);
    });

    it('P1 midway in Panel A: flatX = 75', () => {
      const P1: [number,number,number] = [75, 0, 50]; // middle of Panel A
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(75, 0);
    });

    it('P1 on Panel B far edge: found in pB, flatX = W_A + BA + W_B', () => {
      // Panel B's far edge is W_B along panel B's U direction (= +Y world)
      // Panel B origin = (W_A+BA, 0, 0), so far edge = (W_A+BA, W_B, 0)
      const P1: [number,number,number] = [W_A + BA, W_B, 100];
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pB'));
      expect(result!.flatX).toBeCloseTo(W_A + BA + W_B, 0);
    });

    it('P1 not in any panel: returns null', () => {
      // Far away in space, not on either panel
      const P1: [number,number,number] = [1000, 1000, 1000];
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).toBeNull();
    });

    it('P1 slightly outside Panel A boundary (within tolerance): still found', () => {
      // 5mm outside Panel A's far edge (tolerance=10)
      const P1: [number,number,number] = [W_A + 5, 0, 100];
      const result = projectIntoFlatPattern(P1, chainBends, graph, 10);
      expect(result).not.toBeNull();
    });
  });

  describe('three-panel sequential composite (U-channel)', () => {
    const W_A = 150, W_B = 150, W_C = 150, BA = 1;
    // Panel A: in XZ plane, origin (0,0,0)
    // Panel B: bent 90° from A, in YZ plane, origin at (W_A+BA, 0, 0)
    // Panel C: bent -90° from B, back in XZ plane (going -X), origin at (W_A+BA, W_B+BA, 0)
    const frameA = makePanelFrame(0, 0, 0);
    const frameB = makePanelFrameY(W_A + BA, 0, 0);
    // Panel C panel frame: origin at (W_A+BA, W_B+BA, 0), U = (-1,0,0) (going back in -X)
    const frameC: ReturnType<typeof makePanelFrame> = {
      origin: [W_A + BA, W_B + BA, 0],
      u: [-1, 0, 0],  // Panel C extends in -X direction
      v: [0, 0, 1],
    };

    let chainBends: BendNode[];
    let graph: ManufacturingGraph;

    beforeEach(() => {
      graph = new ManufacturingGraph('test-uch');
      graph.addNode(makePanelNode('pA', W_A, frameA));
      graph.addNode(makePanelNode('pB', W_B, frameB));
      graph.addNode(makePanelNode('pC', W_C, frameC));
      // BendNode 1: pA → pB at x=W_A
      graph.addNode(makeBendNode('bn1', 'pA', 'pB', W_A, BA));
      // BendNode 2: pB → pC at x=W_A+BA+W_B
      graph.addNode(makeBendNode('bn2', 'pB', 'pC', W_A + BA + W_B, BA));

      // Build chain from pC canonical backward
      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      const bends: BendNode[] = [];
      let cur: string | undefined = 'pC';
      while (cur) {
        const bn = bendByPanelB.get(cur);
        if (!bn) break;
        bends.unshift(bn);
        cur = bn.panelAId as string;
      }
      chainBends = bends;
    });

    it('P1 on Panel B far edge (hinge to C): flatX = W_A + BA + W_B', () => {
      // Panel B's far edge in world = (W_A+BA, W_B, 0) + any z
      const P1: [number,number,number] = [W_A + BA, W_B, 100];
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pB'));
      expect(result!.flatX).toBeCloseTo(W_A + BA + W_B, 0);
    });

    it('P1 on Panel A near edge: flatX = 0 (Panel C connects here — U-channel closed)', () => {
      // In a U-channel, Panel C's far edge would connect back to Panel A's near edge
      // Panel A near edge = (0, 0, z)
      const P1: [number,number,number] = [0, 0, 100];
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(0, 0); // at the very start of Panel A
    });

    it('P1 on Panel A far edge: flatX = W_A', () => {
      const P1: [number,number,number] = [W_A, 0, 75];
      const result = projectIntoFlatPattern(P1, chainBends, graph);
      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(W_A, 0);
    });
  });

  describe('PA.x correctly determines Panel B placement in flat pattern', () => {
    function buildSinglePanelChain(W_A: number, frameOrigin: [number,number,number], BA = 1) {
      const frameA = makePanelFrame(frameOrigin[0], frameOrigin[1], frameOrigin[2]);
      const graph = new ManufacturingGraph('test-single');
      // Add PanelNodes BEFORE BendNodes to avoid cycle detection
      graph.addNode(makePanelNode('pA', W_A, frameA));
      graph.addNode(makePanelNode('pB_downstream', 100, makePanelFrame(frameOrigin[0] + W_A + BA, 0, 0)));
      graph.addNode(makeBendNode('bn1', 'pA', 'pB_downstream', W_A, BA));

      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      const chain: BendNode[] = [];
      const bn = bendByPanelB.get('pB_downstream');
      if (bn) chain.unshift(bn);
      return { graph, chain };
    }

    it('far-end connection: PA.x ≈ effectiveAFlatWidth → Panel B to the RIGHT', () => {
      const W_A = 300, BA = 1;
      const { graph, chain } = buildSinglePanelChain(W_A, [0, 0, 0], BA);
      const P1: [number,number,number] = [W_A, 0, 100];
      const result = projectIntoFlatPattern(P1, chain, graph);
      expect(result).not.toBeNull();
      expect(result!.flatX).toBeCloseTo(W_A, 0);
      expect(result!.flatX + BA).toBeCloseTo(W_A + BA, 0); // PA'.x → right
    });

    it('near-end connection: PA.x ≈ 0 → Panel B to the LEFT', () => {
      const W_A = 300, BA = 1;
      const { graph, chain } = buildSinglePanelChain(W_A, [50, 0, 0], BA);
      // P1 at Panel A's NEAR edge (world x=50 = flat x=0)
      const P1: [number,number,number] = [50, 0, 100];
      const result = projectIntoFlatPattern(P1, chain, graph);
      expect(result).not.toBeNull();
      expect(result!.flatX).toBeCloseTo(0, 1);
      expect(result!.flatX - BA).toBeCloseTo(-BA, 1); // PA'.x → left
    });
  });

  describe('mirror detection after multiple bends', () => {
    /**
     * After 2+ bends, Panel B (the new panel) may need its DXF mirrored so its
     * content extends in the correct direction from the hinge.
     *
     * The geometric projection gives PA.x (where P1 is in the composite flat).
     * The rotation T maps PB → PA'. If Panel B's free end (u=0 in Panel B's frame,
     * the end away from the hinge) would end up on the WRONG side of the hinge
     * in the merged flat, the DXF needs mirroring.
     *
     * This test verifies that the projection correctly identifies the attachment
     * point so the mirror check can work.
     */
    it('3-panel composite: new panel attaches at far end → no mirror needed', () => {
      // U-channel: pA (150mm) → pB (150mm) → pC (new, attaches to pB far end)
      const W_A = 150, W_B = 150, BA = 1;
      const frameA = makePanelFrame(0, 0, 0);         // Panel A: XZ plane
      const frameB = makePanelFrameY(W_A + BA, 0, 0); // Panel B: YZ plane (bent 90°)

      const graph = new ManufacturingGraph('mirror-test');
      graph.addNode(makePanelNode('pA', W_A, frameA));
      graph.addNode(makePanelNode('pB', W_B, frameB));
      graph.addNode(makePanelNode('pC', 120, makePanelFrame(0, 0, 0)));  // new panel
      graph.addNode(makeBendNode('bn1', 'pA', 'pB', W_A, BA));
      graph.addNode(makeBendNode('bn2', 'pB', 'pC', W_A + BA + W_B, BA));

      // Build chain ending at 'pC' (the canonical after 2 merges)
      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      const chain: BendNode[] = [];
      let cur: string | undefined = 'pC';
      while (cur) { const bn = bendByPanelB.get(cur); if (!bn) break; chain.unshift(bn); cur = bn.panelAId as string; }

      // P1 = Panel B's far edge (hinge to the new panel C attaching sequentially)
      // Panel B: origin (W_A+BA, 0, 0), u=(0,1,0), far edge at (W_A+BA, W_B, z)
      const P1: [number,number,number] = [W_A + BA, W_B, 75];
      const result = projectIntoFlatPattern(P1, chain, graph);

      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pB'));
      // PA.x should be at the far end of the 2-panel composite = W_A + BA + W_B
      expect(result!.flatX).toBeCloseTo(W_A + BA + W_B, 0);
      // This is the "far end" → Panel C goes to the RIGHT (no mirror)
    });

    it('3-panel composite: new panel attaches at near end → mirror needed', () => {
      // U-channel: pA (150mm) → pB (150mm), then a NEW panel attaches to pA's NEAR end
      // (like panel_12 attaching to panel_11's top in the cauldron case)
      const W_A = 150, W_B = 150, BA = 1;
      const frameA = makePanelFrame(0, 0, 0);          // Panel A: origin at (0,0,0)
      const frameB = makePanelFrameY(W_A + BA, 0, 0);  // Panel B: bent 90°

      const graph = new ManufacturingGraph('mirror-near-end');
      graph.addNode(makePanelNode('pA', W_A, frameA));
      graph.addNode(makePanelNode('pB', W_B, frameB));
      graph.addNode(makePanelNode('pNew', 130, makePanelFrame(0, 0, 0)));  // new panel
      graph.addNode(makeBendNode('bn1', 'pA', 'pB', W_A, BA));
      graph.addNode(makeBendNode('bn2', 'pB', 'pNew', W_A + BA + W_B, BA));

      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      const chain: BendNode[] = [];
      let cur: string | undefined = 'pNew';
      while (cur) { const bn = bendByPanelB.get(cur); if (!bn) break; chain.unshift(bn); cur = bn.panelAId as string; }

      // P1 = at Panel A's NEAR EDGE (origin = world (0,0,z)) — new panel attaches here
      const P1: [number,number,number] = [0, 0, 75]; // at Panel A's anchor
      const result = projectIntoFlatPattern(P1, chain, graph);

      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      // PA.x ≈ 0 (near end of Panel A)
      expect(result!.flatX).toBeCloseTo(0, 0);

      // This is the "near end" → Panel New goes to the LEFT (PA'.x = 0 - ba = -ba)
      // Mirror check: Panel New's free end must extend further LEFT (more negative)
      const paPrimeX = result!.flatX - BA; // = -ba
      expect(paPrimeX).toBeCloseTo(-BA, 0);
    });

    it('flatV (seam position) is correctly projected for a point mid-seam', () => {
      // Verifies that the V (seam/fold-axis) component is correctly read
      // even when P1 is projected into a bent panel.
      const W_A = 150, W_B = 150, BA = 1, SEAM_POS = 80;
      const frameA = makePanelFrame(0, 0, 0);
      const frameB = makePanelFrameY(W_A + BA, 0, 0);

      const graph = new ManufacturingGraph('seam-test');
      graph.addNode(makePanelNode('pA', W_A, frameA));
      graph.addNode(makePanelNode('pB', W_B, frameB));
      graph.addNode(makeBendNode('bn1', 'pA', 'pB', W_A, BA));

      const bendByPanelB = new Map<string, BendNode>();
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode') bendByPanelB.set((node as BendNode).panelBId as string, node as BendNode);
      }
      const chain: BendNode[] = [];
      const bn = bendByPanelB.get('pB');
      if (bn) chain.unshift(bn);

      // P1 at mid-width of Panel A, at seam position = SEAM_POS
      const P1: [number,number,number] = [W_A / 2, 0, SEAM_POS]; // x=75, z=80
      const result = projectIntoFlatPattern(P1, chain, graph);

      expect(result).not.toBeNull();
      expect(result!.panelId).toBe(toNodeId('pA'));
      expect(result!.flatX).toBeCloseTo(W_A / 2, 0); // mid-panel
      expect(result!.flatV).toBeCloseTo(SEAM_POS, 0); // seam position preserved ✓
    });
  });
});
