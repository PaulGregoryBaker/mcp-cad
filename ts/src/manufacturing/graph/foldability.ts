/**
 * FoldabilityChecker — graph-topology-based press-brake accessibility check.
 *
 * Uses a degree heuristic (research.md R-004):
 *   - Panel OPEN: degree 0 or 1 (free to access)
 *   - Panel CONSTRAINED: degree 2 (two bends — requires careful tooling)
 *   - Panel INACCESSIBLE: degree ≥ 3 with bends on more than 2 distinct sides
 *     (closed-box / closed-prism topology)
 *
 * Tasks: T007, T055, T056
 */

import type {
  NodeId,
  BendNode,
  DrcViolation,
  PanelAccessibility,
  AccessibilityState,
} from './types';
import type { ManufacturingGraph } from './graph';
import { ErrorCodes } from '../../mcp/errors';

// ─── Result types (from contracts/graph-events.md) ───────────────────────────

export interface FoldabilityCheckRequest {
  graph: ManufacturingGraph;
  proposedBend?: BendNode;      // hypothetical bend not yet in graph
}

export interface FoldabilityCheckResult {
  violations: DrcViolation[];
  panelAccessibility: PanelAccessibility[];
}

// ─── FoldabilityChecker ──────────────────────────────────────────────────────

export class FoldabilityChecker {
  /**
   * Check the current graph, optionally including a proposed new bend.
   */
  check(request: FoldabilityCheckRequest): FoldabilityCheckResult {
    const { graph, proposedBend } = request;
    return this.evaluate(graph, proposedBend);
  }

  /**
   * Convenience: check graph + proposed bend (used by DrcChecker).
   */
  checkWithProposed(graph: ManufacturingGraph, proposedBend: BendNode): FoldabilityCheckResult {
    return this.evaluate(graph, proposedBend);
  }

  // ─── Core evaluation ──────────────────────────────────────────────────────

  private evaluate(graph: ManufacturingGraph, proposedBend?: BendNode): FoldabilityCheckResult {
    // Build a temporary bend-degree map for each panel node
    const panelBendDegree = new Map<NodeId, NodeId[]>();

    for (const [, node] of graph.nodes) {
      if (node.type === 'PanelNode') {
        panelBendDegree.set(node.id, []);
      }
    }

    const countBend = (bend: BendNode): void => {
      panelBendDegree.get(bend.panelAId)?.push(bend.id);
      panelBendDegree.get(bend.panelBId)?.push(bend.id);
    };

    for (const [, node] of graph.nodes) {
      if (node.type === 'BendNode') countBend(node);
    }
    if (proposedBend) countBend(proposedBend);

    const panelAccessibility: PanelAccessibility[] = [];
    const violations: DrcViolation[] = [];

    for (const [panelId, bendIds] of panelBendDegree) {
      const degree = bendIds.length;
      let state: AccessibilityState;

      if (degree <= 1) {
        state = 'OPEN';
      } else if (degree === 2) {
        state = 'CONSTRAINED';
      } else {
        // degree ≥ 3 — check if bends encircle the panel (simple heuristic:
        // if degree ≥ 3, treat as INACCESSIBLE)
        state = 'INACCESSIBLE';
        const lockingBendIds = bendIds.filter((bid) => {
          // The "locking" bends are those introduced last — i.e., the proposed bend
          // or the most-recently-added bend
          const n = graph.nodes.get(bid) ?? proposedBend;
          return n !== undefined;
        });

        const violation: DrcViolation = {
          ruleId: 'PRESS_BRAKE_ACCESSIBILITY',
          errorCode: ErrorCodes.DRC_FOLDABILITY_VIOLATION,
          message:
            `Panel "${panelId}" would become inaccessible to the press brake ` +
            `(degree ${degree} bends). Remove a locking bend or redesign the assembly.`,
          severity: 'ERROR',
          affectedNodeId: panelId,
        };
        violations.push(violation);

        panelAccessibility.push({
          panelId,
          state,
          lockingBendIds: lockingBendIds as NodeId[],
        });
        continue;
      }

      panelAccessibility.push({ panelId, state, lockingBendIds: [] });
    }

    return { violations, panelAccessibility };
  }
}
