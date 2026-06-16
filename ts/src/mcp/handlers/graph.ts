import { throwError, ErrorCodes } from '../errors.js';
import {
  getGraphBinding,
  getGeometrySolver,
  getGraphFoldabilityChecker,
  getActivePartId,
  getParts,
  createPart,
  getManufacturingGraph,
  setActivePart,
  deletePart,
  listParts,
} from '../state.js';
import { requireString, requireObject } from '../helpers.js';
import type { ManufacturingConfig } from '../../config/loader.js';
import { bootstrapGraph } from '../../manufacturing/graph/bootstrap.js';
import { DrcChecker } from '../../manufacturing/graph/drc.js';
import type { DrcCheckRequest } from '../../manufacturing/graph/drc.js';
import { toNodeId, validateProfile } from '../../manufacturing/graph/types.js';
import type { BendNode, JoinNode, JoinParams, CutNode, CutProfile } from '../../manufacturing/graph/types.js';

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export const graphDefinitions = [
  // ─── Part management tools (Feature 009 multi-part support) ─────────────
  {
    name: 'create_part',
    description: 'Create a new Manufacturing Graph part session. Each part is independent and can be edited separately.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Unique identifier for the part within this session' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'set_active_part',
    description: 'Switch the active part for subsequent Manufacturing Graph operations.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to activate' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'list_parts',
    description: 'List all Manufacturing Graph parts in this session with their node counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'delete_part',
    description: 'Delete a Manufacturing Graph part and all its nodes. Fails if part does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to delete' },
      },
      required: ['part_id'],
    },
  },

  // ─── Manufacturing Graph tools (Feature 009-manufacturing-graph) ──────────
  {
    name: 'bootstrap_graph',
    description: 'Populate a Manufacturing Graph part from an existing STEP body by splitting it into panels via splitBodyByBends. Creates PanelNodes and BendNodes. Must be called on an empty graph part.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Unique part identifier for this Manufacturing Graph' },
        solid_id: { type: 'string', description: 'Body ID to split into panels' },
        angle_threshold_deg: { type: 'number', minimum: 0, description: 'Minimum dihedral deviation for bend detection. Default 30°.' },
        max_thickness_mm: { type: 'number', minimum: 0 },
        default_thickness_mm: { type: 'number', minimum: 0 },
        root_panel_id_prefix: { type: 'string', description: 'Prefix for generated panel node IDs. Default "panel".' },
      },
      required: ['part_id', 'solid_id'],
    },
  },
  {
    name: 'add_bend',
    description: 'Add a BendNode connecting two panels to the Manufacturing Graph. Runs DRC checks before mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to modify' },
        id: { type: 'string', description: 'Unique node ID for this bend' },
        panel_a_id: { type: 'string' },
        panel_b_id: { type: 'string' },
        inner_radius_mm: { type: 'number', exclusiveMinimum: 0 },
        angle_deg: { type: 'number', minimum: 1, maximum: 179 },
        k_factor: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
      },
      required: ['part_id', 'id', 'panel_a_id', 'panel_b_id', 'inner_radius_mm', 'angle_deg', 'k_factor'],
    },
  },
  {
    name: 'solve_geometry',
    description: 'Re-solve geometry for all dirty nodes in the Manufacturing Graph part. Updates body IDs and bend allowances.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to solve' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'check_foldability',
    description: 'Check press-brake accessibility for all panels in the Manufacturing Graph part. Returns per-panel accessibility state and any DRC violations.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to check' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'query_graph',
    description: 'Return the current Manufacturing Graph part node list in topological order.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to query' },
        topological_order: { type: 'boolean', description: 'Return in Kahn topological order. Default true.' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'reset_graph',
    description: 'Clear all nodes and edges from the Manufacturing Graph part.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to reset' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'update_node',
    description: 'Update fields of an existing Manufacturing Graph node. Supports node ID rename via new_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID containing the node' },
        id: { type: 'string', description: 'Existing node ID' },
        new_id: { type: 'string', description: 'New node ID (rename)' },
        inner_radius_mm: { type: 'number', exclusiveMinimum: 0 },
        angle_deg: { type: 'number', minimum: 1, maximum: 179 },
        k_factor: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        nominal_thickness_mm: { type: 'number', exclusiveMinimum: 0 },
        material_type: { type: 'string' },
      },
      required: ['part_id', 'id'],
    },
  },
  {
    name: 'remove_node',
    description: 'Remove a node from the Manufacturing Graph. Fails if removing the node would orphan other nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID containing the node' },
        id: { type: 'string', description: 'Node ID to remove' },
      },
      required: ['part_id', 'id'],
    },
  },
  {
    name: 'add_join',
    description: 'Add a JoinNode connecting two panels in the Manufacturing Graph. Supports FLANGE, TAB_SLOT, RIVET_PATTERN, and WELD_PREP join types.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to modify' },
        id: { type: 'string', description: 'Unique node ID for this join' },
        panel_a_id: { type: 'string' },
        panel_b_id: { type: 'string' },
        reference_edge_a: { type: 'string', description: 'Edge identifier in panel A local frame' },
        reference_edge_b: { type: 'string', description: 'Edge identifier in panel B local frame' },
        join_type: {
          type: 'string',
          enum: ['FLANGE', 'TAB_SLOT', 'RIVET_PATTERN', 'WELD_PREP'],
        },
        params: {
          type: 'object',
          description: 'Join-type-specific parameters',
        },
      },
      required: ['part_id', 'id', 'panel_a_id', 'panel_b_id', 'join_type', 'params'],
    },
  },
  {
    name: 'add_cut',
    description: 'Add a CutNode defining a cut profile on a panel. Supports CIRCLE, RECTANGLE, POLYGON, and FREEFORM profiles. Runs DRC checks (bounds, overlap, bend-zone intersection) before mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Part ID to modify' },
        id: { type: 'string', description: 'Unique node ID for this cut' },
        parent_panel_id: { type: 'string', description: 'ID of the panel to cut' },
        profile_type: {
          type: 'string',
          enum: ['CIRCLE', 'RECTANGLE', 'POLYGON', 'FREEFORM'],
        },
        profile: {
          type: 'object',
          description: 'Profile-type-specific parameters',
        },
        label: { type: 'string', description: 'Optional DXF annotation label' },
      },
      required: ['part_id', 'id', 'parent_panel_id', 'profile_type', 'profile'],
    },
  },
];

// ─── Part management handlers (Feature 009 multi-part support) ────────────────

export function handleCreatePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  createPart(partId);
  return {
    part_id: partId,
    status: 'created',
    is_active: true,
  };
}

export function handleSetActivePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  setActivePart(partId);
  const graph = getManufacturingGraph(partId);
  let panelCount = 0;
  let bendCount = 0;
  for (const node of graph.nodes.values()) {
    if (node.type === 'PanelNode') panelCount++;
    else if (node.type === 'BendNode') bendCount++;
  }
  return {
    part_id: partId,
    status: 'active',
    panel_count: panelCount,
    bend_count: bendCount,
  };
}

export function handleListParts(): unknown {
  const parts = listParts();
  return {
    parts,
    active_part_id: getActivePartId() ?? null,
    total_parts: parts.length,
  };
}

export function handleDeletePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  deletePart(partId);
  return {
    part_id: partId,
    status: 'deleted',
    active_part_id: getActivePartId() ?? null,
  };
}

// ─── Manufacturing Graph handlers (Feature 009-manufacturing-graph) ───────────

export async function handleBootstrapGraph(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const options = {
    angleThresholdDeg: (args['angle_threshold_deg'] as number | undefined),
    maxThicknessMm: (args['max_thickness_mm'] as number | undefined),
    defaultThicknessMm: (args['default_thickness_mm'] as number | undefined),
    rootPanelIdPrefix: (args['root_panel_id_prefix'] as string | undefined),
  };

  // Create graph if not already present
  if (!getParts().has(partId)) {
    createPart(partId);
  }

  const graph = getManufacturingGraph(partId);
  const binding = getGraphBinding();
  const fc = getGraphFoldabilityChecker();
  const result = await bootstrapGraph(partId, graph, binding, fc, config, options);

  return {
    part_id: partId,
    node_ids: result.nodeIds,
    panel_count: result.panelCount,
    bend_count: result.bendCount,
    partial: result.partial,
    unresolved_body_ids: result.unresolvedBodyIds,
    foldability_warnings: result.foldabilityWarnings,
  };
}

export async function handleAddBend(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const panelAId = requireString(args, 'panel_a_id');
  const panelBId = requireString(args, 'panel_b_id');
  const innerRadius = args['inner_radius_mm'] as number;
  const angle = args['angle_deg'] as number;
  const kFactor = args['k_factor'] as number;

  const graph = getManufacturingGraph(partId);

  // DRC check before mutation
  const defaultMaterial = config.materials[0];
  if (defaultMaterial) {
    const drc = new DrcChecker(getGraphFoldabilityChecker());
    const bend: BendNode = {
      type: 'BendNode',
      id: toNodeId(id),
      dirty: true,
      panelAId: toNodeId(panelAId),
      panelBId: toNodeId(panelBId),
      innerRadius,
      angle,
      kFactor,
      bendAllowance: null,
    };
    const drcResult = drc.check({
      graph,
      candidateNode: bend,
      materialConfig: {
        minBendRadiusMm: defaultMaterial.thicknessMm,
        minFlangeWidthMm: defaultMaterial.thicknessMm * 6,
        thicknessMm: defaultMaterial.thicknessMm,
      },
    });
    if (drcResult.violations.some((v) => v.severity === 'ERROR')) {
      return { part_id: partId, success: false, drc_violations: drcResult.violations };
    }
  }

  const node: BendNode = {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: true,
    panelAId: toNodeId(panelAId),
    panelBId: toNodeId(panelBId),
    innerRadius,
    angle,
    kFactor,
    bendAllowance: null,
  };

  const result = graph.addNode(node);
  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    dirtied_node_ids: result.dirtiedNodeIds,
    drc_violations: result.drcViolations,
    stale_warning: stale,
  };
}

export async function handleSolveGeometry(args: Record<string, unknown>): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  const binding = getGraphBinding();
  const reconstructionPlan = getGeometrySolver().buildReconstructionPlan(graph, partId);
  const outcome = await getGeometrySolver().solve(graph, binding);

  if (!outcome.ok) {
    throwError(
      ErrorCodes.SOLVE_FAILED,
      `Geometry Solve failed at node "${outcome.offendingNodeId}": ${outcome.message}`,
      true,
      'solve_geometry',
    );
  }

  return {
    part_id: partId,
    solve_id: outcome.result.solveId,
    solved_nodes: outcome.result.solvedNodes,
    invalidated_body_ids: outcome.result.invalidatedBodyIds,
    dirty_count_before: outcome.result.dirtyCountBefore,
    solve_ms: outcome.result.solveMs,
    reconstruction_plan: reconstructionPlan,
  };
}

export function handleCheckFoldability(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  const result = getGraphFoldabilityChecker().check({ graph });
  return {
    part_id: partId,
    violations: result.violations,
    panel_accessibility: result.panelAccessibility,
  };
}

export function handleQueryGraph(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const topologicalOrder = (args['topological_order'] as boolean | undefined) ?? true;
  const graph = getManufacturingGraph(partId);
  const nodes = graph.queryNodes(topologicalOrder);
  const stale = graph.getStaleWarning();
  return {
    part_id: partId,
    nodes: nodes.map((n) => ({ ...n })),
    stale_warning: stale,
    node_count: nodes.length,
  };
}

export function handleResetGraph(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  graph.reset();
  return { part_id: partId, success: true, message: 'Manufacturing Graph cleared.' };
}

export function handleUpdateNode(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const graph = getManufacturingGraph(partId);

  const updates: Record<string, unknown> = {};
  if (args['new_id'] !== undefined) updates['newNodeId'] = args['new_id'];
  if (args['inner_radius_mm'] !== undefined) updates['innerRadius'] = args['inner_radius_mm'];
  if (args['angle_deg'] !== undefined) updates['angle'] = args['angle_deg'];
  if (args['k_factor'] !== undefined) updates['kFactor'] = args['k_factor'];
  if (args['nominal_thickness_mm'] !== undefined) updates['nominalThickness'] = args['nominal_thickness_mm'];
  if (args['material_type'] !== undefined) updates['materialType'] = args['material_type'];

  const result = graph.updateNode(toNodeId(id), updates as any);
  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    new_node_id: (result as any).newNodeId ?? null,
    dirtied_node_ids: result.dirtiedNodeIds,
    stale_warning: stale,
  };
}

export function handleRemoveNode(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const graph = getManufacturingGraph(partId);
  graph.removeNode(toNodeId(id));
  return { part_id: partId, success: true, removed_id: id };
}

export async function handleAddJoin(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const panelAId = requireString(args, 'panel_a_id');
  const panelBId = requireString(args, 'panel_b_id');
  const joinType = requireString(args, 'join_type') as JoinNode['joinType'];
  const referenceEdgeA = (args['reference_edge_a'] as string | undefined) ?? '';
  const referenceEdgeB = (args['reference_edge_b'] as string | undefined) ?? '';
  const rawParams = requireObject(args, 'params');

  // Build join params based on type
  let params: JoinParams;
  switch (joinType) {
    case 'RIVET_PATTERN':
      params = {
        joinParamType: 'RIVET_PATTERN',
        spacing: (rawParams['spacing'] as number | undefined) ?? 25,
        diameter: (rawParams['diameter'] as number | undefined) ?? 4,
        edgeOffset: (rawParams['edge_offset'] as number | undefined) ?? 10,
      };
      break;
    case 'TAB_SLOT':
      params = {
        joinParamType: 'TAB_SLOT',
        tabWidth: (rawParams['tab_width'] as number | undefined) ?? 10,
        tabDepth: (rawParams['tab_depth'] as number | undefined) ?? 5,
        count: (rawParams['count'] as number | undefined) ?? 3,
      };
      break;
    case 'FLANGE':
      params = {
        joinParamType: 'FLANGE',
        width: (rawParams['width'] as number | undefined) ?? 10,
        bendAngle: (rawParams['bend_angle'] as number | undefined) ?? 90,
      };
      break;
    case 'WELD_PREP':
      params = {
        joinParamType: 'WELD_PREP',
        grooveAngle: (rawParams['groove_angle'] as number | undefined) ?? 60,
        rootGap: (rawParams['root_gap'] as number | undefined) ?? 1,
      };
      break;
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown join type: ${joinType as string}`, false);
      throw new Error('unreachable');
  }

  const graph = getManufacturingGraph(partId);
  const solver = getGeometrySolver();
  const drc = new DrcChecker(getGraphFoldabilityChecker());

  // DRC pre-check
  const joinNode: JoinNode = {
    type: 'JoinNode',
    id: toNodeId(id),
    dirty: true,
    panelAId: toNodeId(panelAId),
    panelBId: toNodeId(panelBId),
    referenceEdgeA,
    referenceEdgeB,
    joinType,
    params,
  };

  const defaultMaterial = config.materials?.[0];
  if (defaultMaterial) {
    const drcRequest: DrcCheckRequest = {
      graph,
      candidateNode: joinNode,
      materialConfig: {
        minBendRadiusMm: defaultMaterial.thicknessMm,
        minFlangeWidthMm: defaultMaterial.thicknessMm * 6,
        thicknessMm: defaultMaterial.thicknessMm,
      },
    };
    const drcResult = drc.check(drcRequest);
    if (drcResult.violations.length > 0) {
      return {
        part_id: partId,
        success: false,
        drc_violations: drcResult.violations,
      };
    }
  }

  // Add to graph via mutateAndSolve
  const result = await graph.mutateAndSolve(
    () => graph.addNode(joinNode),
    async () => {
      const binding = getGraphBinding();
      return solver.solve(graph, binding);
    },
  );

  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    node_id: id,
    dirtied_node_ids: result.dirtiedNodeIds,
    geometry_solve: (result as any).geometrySolve ?? null,
    stale_warning: stale,
  };
}

export async function handleAddCut(
  args: Record<string, unknown>,
  _config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const parentPanelId = requireString(args, 'parent_panel_id');
  const profileType = requireString(args, 'profile_type') as CutProfile['type'];
  const rawProfile = requireObject(args, 'profile');
  const label = args['label'] as string | undefined;

  // Build the CutProfile
  let profile: CutProfile;
  switch (profileType) {
    case 'CIRCLE':
      profile = {
        type: 'CIRCLE',
        centreX: (rawProfile['centre_x'] as number | undefined) ?? 0,
        centreY: (rawProfile['centre_y'] as number | undefined) ?? 0,
        radius: (rawProfile['radius'] as number | undefined) ?? 5,
      };
      break;
    case 'RECTANGLE':
      profile = {
        type: 'RECTANGLE',
        originX: (rawProfile['origin_x'] as number | undefined) ?? 0,
        originY: (rawProfile['origin_y'] as number | undefined) ?? 0,
        width: (rawProfile['width'] as number | undefined) ?? 10,
        height: (rawProfile['height'] as number | undefined) ?? 10,
      };
      break;
    case 'POLYGON':
      profile = {
        type: 'POLYGON',
        vertices: (rawProfile['vertices'] as Array<{ x: number; y: number }>) ?? [],
      };
      break;
    case 'FREEFORM':
      profile = {
        type: 'FREEFORM',
        vertices: (rawProfile['vertices'] as Array<{ x: number; y: number }>) ?? [],
      };
      break;
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown cut profile type: ${profileType as string}`, false);
      throw new Error('unreachable');
  }

  const graph = getManufacturingGraph(partId);
  const solver = getGeometrySolver();

  // Get panel bounds for DRC
  const parentNode = graph.nodes.get(toNodeId(parentPanelId));
  if (!parentNode || parentNode.type !== 'PanelNode') {
    throwError(ErrorCodes.NODE_NOT_FOUND, `Panel "${parentPanelId}" not found.`, false);
  }
  const panelBounds = {
    width: (parentNode as any).flatWidth ?? 1000,
    height: (parentNode as any).flatHeight ?? 1000,
  };

  // Collect existing cut profiles on the same panel
  const existingCuts: CutProfile[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'CutNode' && node.parentPanelId === toNodeId(parentPanelId)) {
      existingCuts.push(node.profile);
    }
  }

  // DRC profile validation
  const profileViolations = validateProfile(profile, panelBounds, existingCuts);
  if (profileViolations.length > 0) {
    return { part_id: partId, success: false, drc_violations: profileViolations };
  }

  const cutNode: CutNode = {
    type: 'CutNode',
    id: toNodeId(id),
    dirty: true,
    parentPanelId: toNodeId(parentPanelId),
    profile,
    label,
  };

  const result = await graph.mutateAndSolve(
    () => graph.addNode(cutNode),
    async () => {
      const binding = getGraphBinding();
      return solver.solve(graph, binding);
    },
  );

  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    node_id: id,
    dirtied_node_ids: result.dirtiedNodeIds,
    geometry_solve: (result as any).geometrySolve ?? null,
    stale_warning: stale,
  };
}
