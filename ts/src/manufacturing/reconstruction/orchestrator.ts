import {
  type PanelNode,
  type BendNode,
  toNodeId,
  toBodyId,
  computeBendAllowance,
} from '../graph/types';
import { ManufacturingGraph } from '../graph/graph';
import { DrcChecker } from '../graph/drc';
import { FoldabilityChecker } from '../graph/foldability';
import { session } from '../../geometry/session';
import type { GeometryBinding } from '../../geometry/binding';
import { transactionRegistry } from '../../mcp/transactions';
import type { ManufacturingConfig } from '../../config/loader';
import type {
  ReconstructionReport,
  ReconstructedPart,
  UnmergedPart,
  SkippedJoint,
  PrioritizedJoint,
} from './types';

/**
 * Automatically partition a solid body, validate panels, and reconstruct them
 * using mergeBodiesWithBend along adjacent split pairs.
 */
export async function reconstructManufacturingPlan(
  partId: string,
  angleThresholdDeg: number,
  maxThicknessMm: number,
  defaultThicknessMm: number,
  config: ManufacturingConfig,
  binding: GeometryBinding,
  transactionId?: string,
): Promise<ReconstructionReport> {
  const defaultMaterial = config.materials[0];
  if (!defaultMaterial) {
    throw new Error('No materials defined in config.');
  }

  // 1. Decomposition via C++ splitBodyByBends
  const splitResult = binding.splitBodyByBends(
    partId,
    angleThresholdDeg,
    maxThicknessMm,
    defaultThicknessMm,
    1, // maxRecursionDepth
  );

  const {
    panel_ids,
    panel_bboxes,
    protrusion_ids,
    protrusion_bboxes,
    protrusion_parents,
    split_pairs,
  } = splitResult;

  if (transactionId && splitResult.shape_history) {
    transactionRegistry.appendHistory(transactionId, splitResult.shape_history);
  }

  const unmerged_parts: UnmergedPart[] = [];
  const skipped_joints: SkippedJoint[] = [];

  // 2. Classify Protrusions
  for (let i = 0; i < protrusion_ids.length; i++) {
    const pId = protrusion_ids[i]!;
    const bbox = protrusion_bboxes[i] ?? { x_min: 0, y_min: 0, z_min: 0, x_max: 0, y_max: 0, z_max: 0 };
    const pParent = protrusion_parents.find((pp) => pp.protrusion_id === pId);
    unmerged_parts.push({
      part_id: pId,
      reason: 'protrusion',
      bbox: {
        x_min: bbox.x_min,
        y_min: bbox.y_min,
        z_min: bbox.z_min,
        x_max: bbox.x_max,
        y_max: bbox.y_max,
        z_max: bbox.z_max,
      },
      parent_panel_id: pParent && pParent.parent_panel_id ? pParent.parent_panel_id : null,
    });
    session.registerShell(pId);
  }

  // 3. Validate panels and identify valid sheet metal panels
  const validPanelIds = new Set<string>();
  for (let i = 0; i < panel_ids.length; i++) {
    const panelId = panel_ids[i]!;
    const bbox = panel_bboxes[i] ?? { x_min: 0, y_min: 0, z_min: 0, x_max: 0, y_max: 0, z_max: 0 };
    const valResult = binding.isPanelValid(panelId);
    if (!valResult.isValid) {
      unmerged_parts.push({
        part_id: panelId,
        reason: 'panel_validation_failed',
        bbox: {
          x_min: bbox.x_min,
          y_min: bbox.y_min,
          z_min: bbox.z_min,
          x_max: bbox.x_max,
          y_max: bbox.y_max,
          z_max: bbox.z_max,
        },
        parent_panel_id: null,
      });
      session.registerShell(panelId);
    } else {
      validPanelIds.add(panelId);
    }
  }

  // Helper to compute dihedral angle based on face normals from panel topologies
  const computeAngle = (idA: string, idB: string): number => {
    try {
      const topoA = binding.getTopology(idA);
      const topoB = binding.getTopology(idB);

      const getMajorPlanarNormal = (topo: any) => {
        const planes = topo.faces.filter((f: any) => f.surfaceType === 'plane');
        if (planes.length === 0) return null;
        planes.sort((a: any, b: any) => b.areaMm2 - a.areaMm2);
        return planes[0];
      };

      const faceA = getMajorPlanarNormal(topoA);
      const faceB = getMajorPlanarNormal(topoB);

      if (faceA && faceB) {
        const dot = Math.abs(
          faceA.normalX * faceB.normalX +
            faceA.normalY * faceB.normalY +
            faceA.normalZ * faceB.normalZ
        );
        const rad = Math.acos(Math.min(1.0, Math.max(-1.0, dot)));
        return (rad * 180.0) / Math.PI;
      }
    } catch (_) {}
    return 90.0; // fallback to 90 degrees
  };

  // Helper to compute panel area (sum of areas of all planar faces)
  const panelAreas = new Map<string, number>();
  const getPanelArea = (id: string): number => {
    if (panelAreas.has(id)) return panelAreas.get(id)!;
    try {
      const topo = binding.getTopology(id);
      const planes = topo.faces.filter((f: any) => f.surfaceType === 'plane');
      const area = planes.reduce((sum: number, f: any) => sum + f.areaMm2, 0);
      panelAreas.set(id, area);
      return area;
    } catch (_) {}
    panelAreas.set(id, 0);
    return 0;
  };

  // Helper to calculate bend axis direction vector
  const jointAxes = new Map<string, { x: number; y: number; z: number } | null>();
  const getJointAxis = (idA: string, idB: string): { x: number; y: number; z: number } | null => {
    const key = `${idA}_${idB}`;
    if (jointAxes.has(key)) return jointAxes.get(key)!;
    try {
      const topoA = binding.getTopology(idA);
      const topoB = binding.getTopology(idB);

      const getMajorPlanarFace = (topo: any) => {
        const planes = topo.faces.filter((f: any) => f.surfaceType === 'plane');
        if (planes.length === 0) return null;
        planes.sort((a: any, b: any) => b.areaMm2 - a.areaMm2);
        return planes[0];
      };

      const faceA = getMajorPlanarFace(topoA);
      const faceB = getMajorPlanarFace(topoB);

      if (faceA && faceB) {
        // Cross product of normals gives the bend axis direction
        const ax = faceA.normalY * faceB.normalZ - faceA.normalZ * faceB.normalY;
        const ay = faceA.normalZ * faceB.normalX - faceA.normalX * faceB.normalZ;
        const az = faceA.normalX * faceB.normalY - faceA.normalY * faceB.normalX;
        
        const len = Math.sqrt(ax * ax + ay * ay + az * az);
        if (len > 1e-6) {
          const vec = { x: ax / len, y: ay / len, z: az / len };
          jointAxes.set(key, vec);
          return vec;
        }
      }
    } catch (_) {}
    jointAxes.set(key, null);
    return null;
  };

  // 4. Rate and Prioritize joints
  const prioritizedJoints: PrioritizedJoint[] = [];
  for (const pair of split_pairs) {
    const [pA, pB] = pair;
    if (validPanelIds.has(pA) && validPanelIds.has(pB)) {
      const angle = computeAngle(pA, pB);
      const isCoplanar = angle < 5.0; // coplanar threshold
      let priorityScore = 50.0; // default standard bend

      if (isCoplanar) {
        priorityScore = 90.0;
      } else if (Math.abs(angle - 90.0) < 5.0) {
        priorityScore = 100.0; // standard 90 degree bend
      }

      prioritizedJoints.push({
        part_a_id: pA,
        part_b_id: pB,
        priority_score: priorityScore,
        dihedral_angle: angle,
        is_coplanar: isCoplanar,
      });
    }
  }

  // Pre-calculate panel areas and joint axes for prioritized sorting
  for (const pId of validPanelIds) {
    getPanelArea(pId);
  }
  for (const pair of split_pairs) {
    const [pA, pB] = pair;
    if (validPanelIds.has(pA) && validPanelIds.has(pB)) {
      getJointAxis(pA, pB);
    }
  }

  const mergedAxes: Array<{ x: number; y: number; z: number }> = [];

  const getAlignmentScore = (axis: { x: number; y: number; z: number } | null): number => {
    if (!axis || mergedAxes.length === 0) return 0;
    let maxDot = 0;
    for (const mA of mergedAxes) {
      const dot = Math.abs(mA.x * axis.x + mA.y * axis.y + mA.z * axis.z);
      if (dot > maxDot) {
        maxDot = dot;
      }
    }
    return maxDot;
  };

  // Initialize Disjoint Set / Components
  const components: string[][] = Array.from(validPanelIds).map((id) => [id]);
  const findComponent = (pId: string): string[] => {
    return components.find((c) => c.includes(pId))!;
  };
  const unionComponents = (pIdA: string, pIdB: string) => {
    const compA = findComponent(pIdA);
    const compB = findComponent(pIdB);
    if (compA !== compB) {
      compA.push(...compB);
      const idxB = components.indexOf(compB);
      if (idxB >= 0) components.splice(idxB, 1);
    }
  };

  // Map panel ID to its current merged shell body ID
  const bodyMap = new Map<string, string>();
  for (const pId of validPanelIds) {
    bodyMap.set(pId, pId);
  }

  // Bootstrap manufacturing graph containing all valid panel nodes
  const graph = new ManufacturingGraph(partId, config.graph?.coplanarityThresholdDeg ?? 1.0);
  const panelPrefix = 'panel';
  const panelIdMap = new Map<string, string>(); // map original panelId to graph nodeId

  let panelIdx = 1;
  for (const pId of validPanelIds) {
    const nodeId = toNodeId(`${panelPrefix}-${panelIdx++}`);
    panelIdMap.set(pId, nodeId);

    const panelNode: PanelNode = {
      type: 'PanelNode',
      id: nodeId,
      bodyId: toBodyId(pId),
      dirty: false,
      materialType: defaultMaterial.id,
      nominalThickness: defaultMaterial.thicknessMm,
      flatWidth: null,
      flatHeight: null,
    };
    graph.addNode(panelNode);
  }

  // 5. Try merging prioritized joints dynamically
  const remainingJoints = [...prioritizedJoints];
  while (remainingJoints.length > 0) {
    // Sort remaining joints dynamically:
    // 1. priority_score (descending)
    // 2. combined area of panel being joined (descending, large first)
    // 3. alignment score with mergedAxes (descending, parallel first)
    remainingJoints.sort((jA, jB) => {
      // 1. Priority score
      if (jA.priority_score !== jB.priority_score) {
        return jB.priority_score - jA.priority_score;
      }
      // 2. Combined area (large first)
      const areaA = getPanelArea(jA.part_a_id) + getPanelArea(jA.part_b_id);
      const areaB = getPanelArea(jB.part_a_id) + getPanelArea(jB.part_b_id);
      if (Math.abs(areaA - areaB) > 1e-2) {
        return areaB - areaA;
      }
      // 3. Alignment score (same direction as previous joins)
      const axisA = getJointAxis(jA.part_a_id, jA.part_b_id);
      const axisB = getJointAxis(jB.part_a_id, jB.part_b_id);
      const alignA = getAlignmentScore(axisA);
      const alignB = getAlignmentScore(axisB);
      if (Math.abs(alignA - alignB) > 1e-4) {
        return alignB - alignA;
      }
      return 0;
    });

    const joint = remainingJoints.shift()!;
    const { part_a_id, part_b_id, dihedral_angle, is_coplanar } = joint;
    const bodyA = bodyMap.get(part_a_id)!;
    const bodyB = bodyMap.get(part_b_id)!;

    if (bodyA === bodyB) continue;

    // Create trial snapshot
    const trialSnapshotId = binding.createSnapshot(
      `trial_merge_${part_a_id}_${part_b_id}`
    );

    const bendId = toNodeId(`bend-${part_a_id}-${part_b_id}`);
    const bendNode: BendNode = {
      type: 'BendNode',
      id: bendId,
      dirty: false,
      panelAId: toNodeId(panelIdMap.get(part_a_id)!),
      panelBId: toNodeId(panelIdMap.get(part_b_id)!),
      innerRadius: defaultMaterial.thicknessMm,
      angle: dihedral_angle,
      kFactor: defaultMaterial.kFactor,
      bendAllowance: computeBendAllowance(
        dihedral_angle,
        defaultMaterial.thicknessMm,
        defaultMaterial.kFactor,
        defaultMaterial.thicknessMm
      ),
    };

    try {
      let mergedShellId: string;
      let shapeHistory: any[] = [];

      if (is_coplanar) {
        const fuseResult = binding.fuseBodies([bodyA, bodyB], 0.01);
        mergedShellId = fuseResult.solid_id;
        shapeHistory = fuseResult.shape_history ?? [];
      } else {
        const mergeResult = binding.mergeBodiesWithBend(
          bodyA,
          bodyB,
          ['all'],
          defaultMaterial.thicknessMm
        );
        mergedShellId = mergeResult.mergedShellId;
        shapeHistory = mergeResult.shape_history ?? [];
      }

      // Add to graph
      graph.addNode(bendNode);

      // Temporarily update bodyMap and graph panel body IDs for checking
      const componentA = findComponent(part_a_id);
      const componentB = findComponent(part_b_id);
      const mergedComponent = [...componentA, ...componentB];
      for (const pId of mergedComponent) {
        bodyMap.set(pId, mergedShellId);
        const node = graph.nodes.get(toNodeId(panelIdMap.get(pId)!)) as PanelNode;
        if (node) node.bodyId = toBodyId(mergedShellId);
      }

      // Run checkers
      const drc = new DrcChecker(new FoldabilityChecker());
      const checkResult = drc.check({
        graph,
        candidateNode: bendNode,
        materialConfig: {
          minBendRadiusMm: defaultMaterial.thicknessMm,
          minFlangeWidthMm: defaultMaterial.thicknessMm * 3,
          thicknessMm: defaultMaterial.thicknessMm,
        },
      });

      const errors = checkResult.violations.filter(
        (v) => v.severity === 'ERROR' && v.ruleId !== 'PRESS_BRAKE_ACCESSIBILITY'
      );
      if (errors.length > 0) {
        throw new Error(`DRC_VIOLATION:${JSON.stringify(errors)}`);
      }

      // Successful merge
      session.registerShell(mergedShellId);
      if (transactionId) {
        transactionRegistry.appendHistory(transactionId, shapeHistory);
      }
      unionComponents(part_a_id, part_b_id);

      const axis = getJointAxis(part_a_id, part_b_id);
      if (axis) {
        mergedAxes.push(axis);
      }

    } catch (err: any) {
      // Rollback C++ modifications
      binding.restoreSnapshot(trialSnapshotId);

      // Remove bend node from graph
      try {
        graph.removeNode(bendId);
      } catch (_) {}

      // Restore bodyMap and graph panel body IDs to pre-merge state
      const componentA = findComponent(part_a_id);
      for (const pId of componentA) {
        bodyMap.set(pId, bodyA);
        const node = graph.nodes.get(toNodeId(panelIdMap.get(pId)!)) as PanelNode;
        if (node) node.bodyId = toBodyId(bodyA);
      }
      const componentB = findComponent(part_b_id);
      for (const pId of componentB) {
        bodyMap.set(pId, bodyB);
        const node = graph.nodes.get(toNodeId(panelIdMap.get(pId)!)) as PanelNode;
        if (node) node.bodyId = toBodyId(bodyB);
      }

      // Log skipped joint
      let reason: 'collision' | 'foldability_violation' | 'drc_violation' = 'collision';
      let violations: any[] = [];

      if (err.message && err.message.startsWith('DRC_VIOLATION:')) {
        const rawViolations = JSON.parse(err.message.substring('DRC_VIOLATION:'.length));
        violations = rawViolations.map((v: any) => ({
          code: v.ruleId || v.errorCode,
          message: v.message,
          severity: v.severity,
        }));
        reason = violations.some((v) => v.code === 'DRC_FOLDABILITY_VIOLATION')
          ? 'foldability_violation'
          : 'drc_violation';
      } else {
        violations = [
          {
            code: 'GE_MERGE_FAILED',
            message: err.message || String(err),
            severity: 'ERROR',
          },
        ];
      }

      skipped_joints.push({
        part_a_id,
        part_b_id,
        reason,
        violations,
      });
    } finally {
      binding.clearSnapshot(trialSnapshotId);
    }
  }

  // 6. Construct final ReconstructedParts
  const reconstructed_parts: ReconstructedPart[] = [];
  for (const comp of components) {
    // If we have a single panel that failed validation, it's already in unmerged_parts
    // Any remaining panel component (size >= 1) is a reconstructed part
    if (comp.length > 0) {
      const firstPanelId = comp[0]!;
      const currentBodyId = bodyMap.get(firstPanelId)!;

      // Extract graph specific to this component
      const componentNodeIds = new Set<string>();
      for (const pId of comp) {
        componentNodeIds.add(panelIdMap.get(pId)!);
      }
      // Add bend nodes connecting these panels
      for (const node of graph.nodes.values()) {
        if (node.type === 'BendNode' && componentNodeIds.has(node.panelAId) && componentNodeIds.has(node.panelBId)) {
          componentNodeIds.add(node.id);
        }
      }

      const nodes = Array.from(graph.nodes.values()).filter((n) =>
        componentNodeIds.has(n.id)
      );

      const edges: Array<{ from: string; to: string }> = [];
      for (const [fromNodeId, toNodeIds] of graph.edges) {
        if (componentNodeIds.has(fromNodeId)) {
          for (const toNodeId of toNodeIds) {
            if (componentNodeIds.has(toNodeId)) {
              edges.push({ from: fromNodeId, to: toNodeId });
            }
          }
        }
      }

      reconstructed_parts.push({
        part_id: currentBodyId,
        graph: {
          part_id: currentBodyId,
          nodes,
          edges,
        },
      });
    }
  }

  return {
    success: true,
    reconstructed_parts,
    unmerged_parts,
    skipped_joints,
  };
}
