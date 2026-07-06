/**
 * Geometric projection of a 3D point into a composite panel's flat pattern.
 *
 * A composite flat pattern has N panels joined by N-1 bend zones. Each panel
 * is a flat surface in 3D with a known 3D frame (origin, u, v). To find where
 * a 3D point P1 (e.g., the hinge between the composite and a new panel) maps
 * in the flat pattern:
 *
 *   For each panel in the chain (root→leaf):
 *     local_u = dot(P1 - panel.frame.origin, panel.frame.u)
 *     local_v = dot(P1 - panel.frame.origin, panel.frame.v)
 *     if 0 ≤ local_u ≤ panel.flatWidth → P1 is in this panel
 *       flat_x = cumulative_offset + local_u
 *       flat_v = local_v
 *
 * Since each panel is flat in 3D (just bent relative to the others), the dot
 * product correctly gives the local position without any unfolding. The
 * cumulative_offset comes from the BendNode.bendZoneDxfX values stored in the
 * manufacturing graph.
 *
 * This is topology-independent: it correctly handles the case where the new
 * panel connects to any position in the composite (start, end, or middle),
 * not just the end (which is the common case for sequential merges).
 */

import type { BendNode, NodeId, PanelNode } from '../../manufacturing/graph/types.js';
import type { ManufacturingGraph } from '../../manufacturing/graph/graph.js';

/** Result of projecting a 3D point into a composite flat pattern. */
export interface FlatProjection {
  /** X position in the flat pattern (0 = start of first panel). */
  flatX: number;
  /** V (seam-axis) position in the flat pattern. */
  flatV: number;
  /** The panel the point was found in. */
  panelId: NodeId;
}

/**
 * Projects P1 into the composite flat pattern using the stored panel frames.
 *
 * @param P1 - 3D point to project (e.g. the hinge between composite and new panel).
 * @param chainBends - BendNode chain from root to leaf (root = oldest merge, leaf = newest).
 * @param graph - The composite's manufacturing graph.
 * @param tolerance - mm tolerance for panel boundary checks (default 10mm).
 * @returns The flat pattern coordinates, or null if P1 is not in any known panel.
 */
export function projectIntoFlatPattern(
  P1: [number, number, number],
  chainBends: BendNode[],
  graph: ManufacturingGraph,
  tolerance = 10,
): FlatProjection | null {
  const dot = (a: [number,number,number], b: [number,number,number]) =>
    a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

  // Collect all candidate panels with their flat-start positions and local projections.
  // Then return the best match: prefer the panel where P1 is most clearly inside
  // (smallest absolute overshoot), using tolerance only as a tie-breaker.
  interface Candidate { panelId: NodeId; flatX: number; flatV: number; overshoot: number; }
  const candidates: Candidate[] = [];

  const checkPanel = (
    panelId: NodeId,
    flatStart: number,
  ) => {
    const panelNode = graph.nodes.get(panelId);
    if (!panelNode || panelNode.type !== 'PanelNode') return;
    const pn = panelNode as PanelNode;
    if (!pn.panelFrame || !pn.flatWidth) return;

    const pf = pn.panelFrame;
    const diff: [number,number,number] = [P1[0]-pf.origin[0], P1[1]-pf.origin[1], P1[2]-pf.origin[2]];
    const localU = dot(diff, pf.u as [number,number,number]);
    const localV = dot(diff, pf.v as [number,number,number]);
    const W = pn.flatWidth;

    // overshoot: 0 = perfectly inside, >0 = outside by this much
    const overshoot = localU < 0 ? -localU : (localU > W ? localU - W : 0);

    if (overshoot <= tolerance) {
      candidates.push({
        panelId,
        flatX: flatStart + Math.max(0, Math.min(W, localU)),
        flatV: localV,
        overshoot,
      });
    }
  };

  // Check each panel (panelAId of each BendNode = upstream panel for that bend)
  for (const bn of chainBends) {
    const panelStart = (bn.bendZoneDxfX ?? 0) - ((graph.nodes.get(bn.panelAId) as PanelNode | undefined)?.flatWidth ?? 0);
    checkPanel(bn.panelAId, panelStart);
  }

  // Check the last downstream panel (panelBId of the last BendNode)
  if (chainBends.length > 0) {
    const lastBn = chainBends[chainBends.length - 1]!;
    const lastPanelStart = (lastBn.bendZoneDxfX ?? 0) + (lastBn.bendAllowance ?? 0);
    checkPanel(lastBn.panelBId, lastPanelStart);
  }

  if (candidates.length === 0) return null;
  // Return the best match (minimum overshoot; ties broken by order = earlier in chain wins)
  candidates.sort((a, b) => a.overshoot - b.overshoot);
  return candidates[0]!;
}

/**
 * Builds the ordered BendNode chain (root-first) from a composite's manufacturing graph.
 * Used by both projectIntoFlatPattern and the chain-hinge walk.
 */
export function buildChainBends(
  graph: ManufacturingGraph,
  canonicalNodeId: NodeId,
): BendNode[] {
  const bendByPanelB = new Map<NodeId, BendNode>();
  for (const node of graph.nodes.values()) {
    if (node.type === 'BendNode') {
      bendByPanelB.set((node as BendNode).panelBId, node as BendNode);
    }
  }
  const chain: BendNode[] = [];
  let cur: NodeId | undefined = canonicalNodeId;
  while (cur !== undefined) {
    const bn = bendByPanelB.get(cur);
    if (!bn) break;
    chain.unshift(bn);
    cur = bn.panelAId;
  }
  return chain;
}
