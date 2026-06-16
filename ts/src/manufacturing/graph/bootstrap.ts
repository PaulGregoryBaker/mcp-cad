/**
 * bootstrapGraph — populate the Manufacturing Graph from an existing STEP body
 * by calling splitBodyByBends via the NAPI binding.
 *
 * Tasks: T008, T026, T027, T028
 */

import type { NodeId, BodyId } from './types';
import { toNodeId, toBodyId } from './types';
import type { PanelNode, BendNode } from './types';
import type { ManufacturingGraph } from './graph';
import type { GeometryBinding } from './solver';
import type { FoldabilityChecker } from './foldability';
import type { ManufacturingConfig } from '../../config/loader';
import { ErrorCodes, throwError } from '../../mcp/errors';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BootstrapOptions {
  rootPanelIdPrefix?: string;   // default 'panel'
  angleThresholdDeg?: number;   // default 30
  maxThicknessMm?: number;
  defaultThicknessMm?: number;
}

export interface BootstrapResult {
  nodeIds: NodeId[];
  panelCount: number;
  bendCount: number;
  foldabilityWarnings: import('./types').DrcViolation[];
  geometrySolve?: import('./types').GeometrySolveResult;
  partial: boolean;
  unresolvedBodyIds: BodyId[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Estimate dihedral angle between two adjacent panel bodies.
 * For now, uses a heuristic based on panel surface normals measured via
 * the binding. Returns angle in degrees.
 *
 * In a production implementation, this would:
 * 1. Extract surface normals from both panels
 * 2. Compute the angle between them
 * 3. Return the dihedral angle (0° = coplanar, 90° = right angle, etc.)
 *
 * For testing, this is mocked to return configurable angles.
 */
async function estimateDihedralAngle(
  _binding: GeometryBinding,
  _panelBodyIdA: string,
  _panelBodyIdB: string,
): Promise<number> {
  // TODO: Replace with actual NAPI call once binding.measureDihedralAngle() is available
  // For now, return a default heuristic: measure distance or use mock
  // This is a placeholder; production code would call the binding's angle measurement
  return 90; // assume 90° by default (will be refined in production)
}

/**
 * Classify whether two adjacent panels should be fused (coplanar) or bent.
 * Returns the measured angle and a classification decision.
 */
async function classifyPanelJunction(
  binding: GeometryBinding,
  panelBodyIdA: string,
  panelBodyIdB: string,
  coplanarityThresholdDeg: number,
): Promise<{ angle: number; shouldFuse: boolean }> {
  const angle = await estimateDihedralAngle(binding, panelBodyIdA, panelBodyIdB);
  const shouldFuse = angle < coplanarityThresholdDeg;
  return { angle, shouldFuse };
}

// ─── bootstrapGraph ───────────────────────────────────────────────────────────

// ─── bootstrapGraph ───────────────────────────────────────────────────────────

export async function bootstrapGraph(
  partId: string,
  graph: ManufacturingGraph,
  binding: GeometryBinding,
  foldabilityChecker: FoldabilityChecker,
  config: ManufacturingConfig,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const prefix = options.rootPanelIdPrefix ?? 'panel';
  const angleThreshold = options.angleThresholdDeg ?? 30;

  // Validate graph is empty
  if (graph.nodes.size > 0) {
    throwError(
      ErrorCodes.GRAPH_ALREADY_POPULATED,
      'The manufacturing graph already contains nodes. Call reset_graph before bootstrapping.',
      true,
      'reset_graph',
    );
  }

  // Call splitBodyByBends via NAPI
  const splitResult = binding.splitBodyByBends(
    partId,
    angleThreshold,
    options.maxThicknessMm,
    options.defaultThicknessMm,
  );

  const panelIds = splitResult.panel_ids;
  const partial = panelIds.length === 0;
  const unresolvedBodyIds: BodyId[] = [];

  // Use default material from config
  const defaultMaterial = config.materials[0];
  if (!defaultMaterial) {
    throwError(
      ErrorCodes.CONFIG_INVALID,
      'No materials defined in config.yaml.',
      false,
    );
  }

  const nodeIds: NodeId[] = [];
  const createdPanels: PanelNode[] = [];

  // Create a PanelNode for each detected panel body
  for (let i = 0; i < panelIds.length; i++) {
    const panelBodyId = panelIds[i]!;
    const nodeId = toNodeId(`${prefix}-${i + 1}`);
    const panelNode: PanelNode = {
      type: 'PanelNode',
      id: nodeId,
      bodyId: toBodyId(panelBodyId),
      dirty: true,
      materialType: defaultMaterial.id,
      nominalThickness: defaultMaterial.thicknessMm,
      flatWidth: null,
      flatHeight: null,
      canonical: true,  // Bootstrapped panels are canonical unfold targets
      shapeDxf: null,   // Will be populated by split_body_by_bends or other operations
    };

    try {
      graph.addNode(panelNode);
      createdPanels.push(panelNode);
      nodeIds.push(nodeId);
    } catch (_err) {
      unresolvedBodyIds.push(toBodyId(panelBodyId));
    }
  }

  let bendCount = 0;

  // Classify junctions and create BendNodes or fuse coplanar panels
  // Heuristic: sequential panels (i → i+1) are classified for coplanarity
  for (let i = 0; i < createdPanels.length - 1; i++) {
    const panelA = createdPanels[i]!;
    const panelB = createdPanels[i + 1]!;

    // Skip if either panel lacks a body ID
    if (!panelA.bodyId || !panelB.bodyId) {
      continue;
    }

    // Classify the junction between panels A and B
    const junction = await classifyPanelJunction(
      binding,
      panelA.bodyId,
      panelB.bodyId,
      graph.coplanarityThresholdDeg,
    );

    if (junction.shouldFuse && panelA.bodyId && panelB.bodyId) {
      // Fuse coplanar panels into one
      try {
        const fuseResult = binding.fuseBodies([panelA.bodyId, panelB.bodyId], 0.01);
        // Update panelB to have the fused body ID
        panelB.bodyId = toBodyId(fuseResult.solid_id);
        panelB.dirty = true;
        // Mark panelA as unresolved (will be cleaned up)
        unresolvedBodyIds.push(panelA.bodyId);
      } catch (_err) {
        // If fusion fails, create a BendNode as fallback
        const bendId = toNodeId(`bend-${i + 1}`);
        const bendNode: BendNode = {
          type: 'BendNode',
          id: bendId,
          dirty: true,
          panelAId: panelA.id,
          panelBId: panelB.id,
          innerRadius: defaultMaterial.thicknessMm,
          angle: junction.angle,
          kFactor: defaultMaterial.kFactor,
          bendAllowance: null,
        };
        try {
          graph.addNode(bendNode);
          nodeIds.push(bendId);
          bendCount++;
        } catch (_err2) {
          // Non-fatal
        }
      }
    } else {
      // Create a BendNode with the measured angle
      const bendId = toNodeId(`bend-${i + 1}`);
      const bendNode: BendNode = {
        type: 'BendNode',
        id: bendId,
        dirty: true,
        panelAId: panelA.id,
        panelBId: panelB.id,
        innerRadius: defaultMaterial.thicknessMm,
        angle: junction.angle,
        kFactor: defaultMaterial.kFactor,
        bendAllowance: null,
      };

      try {
        graph.addNode(bendNode);
        nodeIds.push(bendId);
        bendCount++;
      } catch (_err) {
        // Non-fatal for bootstrap
      }
    }
  }

  // Foldability warnings (advisory at bootstrap time, not errors per FR-016)
  const foldResult = foldabilityChecker.check({ graph });
  const foldabilityWarnings = foldResult.violations.map((v) => ({
    ...v,
    severity: 'WARNING' as const,
  }));

  const result: BootstrapResult = {
    nodeIds,
    panelCount: createdPanels.length,
    bendCount,
    foldabilityWarnings,
    partial: unresolvedBodyIds.length > 0 || partial,
    unresolvedBodyIds,
  };

  if (partial || unresolvedBodyIds.length > 0) {
    // Return BOOTSTRAP_PARTIAL — caller must handle
    return { ...result, partial: true };
  }

  return result;
}
