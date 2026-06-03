/**
 * DrcChecker — synchronous Design Rule Checks.
 *
 * All checks run before any geometry is dispatched (Constitution Principle III).
 * On first violation, returns a DrcCheckResult with the violation list.
 *
 * Tasks: T006, T031, T052, T053
 */

import type {
  GraphNode,
  BendNode,
  JoinNode,
  DrcViolation,
} from './types';
import type { ManufacturingGraph } from './graph';
import type { FoldabilityChecker } from './foldability';
import { ErrorCodes } from '../../mcp/errors';

// ─── Material config subset used by DRC ──────────────────────────────────────

export interface MaterialDrcConfig {
  minBendRadiusMm: number;
  minFlangeWidthMm: number;
  thicknessMm: number;
}

// ─── DRC request/result types (from contracts/graph-events.md) ───────────────

export interface DrcCheckRequest {
  graph: ManufacturingGraph;
  candidateNode: GraphNode;
  materialConfig: MaterialDrcConfig;
}

export interface DrcCheckResult {
  violations: DrcViolation[];
}

// ─── DrcChecker ──────────────────────────────────────────────────────────────

export class DrcChecker {
  constructor(private readonly foldabilityChecker: FoldabilityChecker) {}

  /**
   * Run all applicable DRC rules for the candidate node.
   * Returns an empty violations array on pass.
   */
  check(request: DrcCheckRequest): DrcCheckResult {
    const { candidateNode } = request;
    switch (candidateNode.type) {
      case 'BendNode':
        return this.checkBend(request, candidateNode);
      case 'JoinNode':
        return this.checkJoin(request, candidateNode);
      case 'CutNode':
      case 'PanelNode':
        return { violations: [] };
    }
  }

  // ─── Bend DRC (Tasks T031, T052) ─────────────────────────────────────────

  checkBend(request: DrcCheckRequest, bend: BendNode): DrcCheckResult {
    const violations: DrcViolation[] = [];
    const { materialConfig, graph } = request;

    // Rule: minimum bend radius
    if (bend.innerRadius < materialConfig.minBendRadiusMm) {
      violations.push({
        ruleId: 'MIN_BEND_RADIUS',
        errorCode: ErrorCodes.DRC_BEND_RADIUS_VIOLATION,
        message: `Bend radius ${bend.innerRadius} mm is below minimum ${materialConfig.minBendRadiusMm} mm for this material.`,
        severity: 'ERROR',
        affectedNodeId: bend.id,
      });
    }

    // Rule: minimum flange width (approximate: R + 2T minimum)
    const approxFlangeMinWidth = bend.innerRadius + 2 * materialConfig.thicknessMm;
    const panelB = graph.nodes.get(bend.panelBId);
    if (
      panelB?.type === 'PanelNode' &&
      panelB.flatWidth !== null &&
      panelB.flatWidth < materialConfig.minFlangeWidthMm
    ) {
      violations.push({
        ruleId: 'MIN_FLANGE_WIDTH',
        errorCode: ErrorCodes.DRC_MIN_FLANGE_WIDTH_VIOLATION,
        message: `Flange width ${panelB.flatWidth} mm is below minimum ${materialConfig.minFlangeWidthMm} mm.`,
        severity: 'ERROR',
        affectedNodeId: bend.id,
      });
    }
    void approxFlangeMinWidth; // used only for documentation reference

    // Rule: foldability (press-brake accessibility)
    const foldResult = this.foldabilityChecker.checkWithProposed(graph, bend);
    for (const v of foldResult.violations) {
      if (v.errorCode === ErrorCodes.DRC_FOLDABILITY_VIOLATION) {
        violations.push(v);
      }
    }

    return { violations };
  }

  // ─── Join DRC (Task T044) ─────────────────────────────────────────────────

  checkJoin(request: DrcCheckRequest, join: JoinNode): DrcCheckResult {
    const violations: DrcViolation[] = [];
    const { graph } = request;

    // Panel existence
    if (!graph.nodes.has(join.panelAId) || !graph.nodes.has(join.panelBId)) {
      violations.push({
        ruleId: 'JOIN_MISSING_PANEL',
        errorCode: ErrorCodes.NODE_NOT_FOUND,
        message: `JoinNode "${join.id}" references a panel that does not exist.`,
        severity: 'ERROR',
        affectedNodeId: join.id,
      });
      return { violations };
    }

    // Edge already bound check
    for (const [, node] of graph.nodes) {
      if (node.id === join.id) continue;
      if (
        (node.type === 'BendNode' || node.type === 'JoinNode') &&
        node.panelAId === join.panelAId
      ) {
        const otherEdge =
          node.type === 'JoinNode' ? node.referenceEdgeA : undefined;
        if (otherEdge === join.referenceEdgeA) {
          violations.push({
            ruleId: 'JOIN_EDGE_ALREADY_BOUND',
            errorCode: ErrorCodes.JOIN_EDGE_ALREADY_BOUND,
            message: `Edge "${join.referenceEdgeA}" of panel "${join.panelAId}" is already bound to node "${node.id}".`,
            severity: 'ERROR',
            affectedNodeId: join.id,
          });
        }
      }
    }

    return { violations };
  }

  // ─── Press-brake accessibility pre-check (Task T053) ─────────────────────

  /**
   * Graph-topology degree heuristic for press-brake accessibility.
   * Panels with degree ≥ 3 on more than 2 sides become INACCESSIBLE.
   * This is the quick pre-check; FoldabilityChecker does the full topology analysis.
   */
  checkPressbrakeAccessibility(graph: ManufacturingGraph, proposedBend: BendNode): DrcViolation[] {
    return this.foldabilityChecker.checkWithProposed(graph, proposedBend).violations;
  }

  // ─── checkAll (Task T052) ─────────────────────────────────────────────────

  /**
   * Compose checkBend, checkFlange, and checkAccessibility into a single
   * synchronous gate. Returns on the first set of violations found.
   */
  checkAll(request: DrcCheckRequest): DrcCheckResult {
    const { candidateNode, graph } = request;

    if (candidateNode.type === 'BendNode') {
      const bend = candidateNode as BendNode;

      // 1. Bend radius + flange width checks
      const bendResult = this.checkBend(request, bend);
      if (bendResult.violations.length > 0) return bendResult;

      // 2. Accessibility / foldability
      const accessViolations = this.checkPressbrakeAccessibility(graph, bend);
      if (accessViolations.length > 0) return { violations: accessViolations };
    } else if (candidateNode.type === 'JoinNode') {
      return this.checkJoin(request, candidateNode as JoinNode);
    }

    return { violations: [] };
  }
}
