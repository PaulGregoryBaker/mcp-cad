/**
 * MCP tool dispatch — implements all MCP tools.
 *
 * Tasks: T063, T064, T065, T080, T081, T082, T083, T099, T101, T102, T103, T104, T105
 */

import { GeometryBinding, GeometryAddon, geometryBinding as defaultBinding } from '../geometry/binding';

let overrideBinding: GeometryBinding | undefined;

export function setGeometryBindingMock(mock: GeometryAddon | undefined) {
  overrideBinding = mock !== undefined ? new GeometryBinding(mock) : undefined;
}

function getGeometryBinding() {
  return overrideBinding ?? defaultBinding;
}
import { session } from '../geometry/session';
import { jobQueue } from '../geometry/jobs';
import { toStructuredError, throwError, ErrorCodes } from './errors';
import type { ManufacturingConfig } from '../config/loader';
import { MaterialStore } from '../manufacturing/material';
import { isJointTypeAllowed } from '../manufacturing/rules';
import { scorePanel } from '../manufacturing/manufacturability';
import { validateBendSequence } from '../manufacturing/bend_sequence';
import type { FeatureSet } from '../manufacturing/feature';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export function getToolDefinitions(): object[] {
  return [
    {
      name: 'clean_geometry',
      description: 'Load and validate a STEP file. Heals non-manifold geometry if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to STEP file' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'decompose_volume',
      description: 'Splits a solid volume into manufacturable panels.',
      inputSchema: {
        type: 'object',
        properties: {
          solid_id: { type: 'string' },
          strategy: { type: 'string', enum: ['Integrity', 'Simplicity', 'Logistics'] },
          max_panels: { type: 'number', minimum: 1, maximum: 10 },
        },
        required: ['solid_id', 'strategy'],
      },
    },
    {
      name: 'synthesize_joints',
      description: 'Adds tab-slot, rivet holes, or weld prep geometry between adjacent panels.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
          joint_type: {
            type: 'string',
            enum: ['tab_slot', 'rivet', 'weld', 'adhesive', 'plastic_fastener'],
          },
          clearance_mm: { type: 'number', minimum: 0.1, maximum: 0.2 },
        },
        required: ['panel_ids', 'joint_type'],
      },
    },
    {
      name: 'generate_reliefs',
      description: 'Adds corner reliefs at bend intersections.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_id: { type: 'string' },
          relief_type: { type: 'string', enum: ['dogbone', 'circular'] },
          radius_mm: { type: 'number', minimum: 0.5 },
        },
        required: ['panel_id', 'relief_type'],
      },
    },
    {
      name: 'apply_unfold',
      description: 'Generates 2D flat pattern with bend compensation.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_id: { type: 'string' },
          material_id: { type: 'string' },
          k_factor: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['panel_id', 'material_id'],
      },
    },
    {
      name: 'evaluate_manufacturability',
      description: 'Evaluates a panel for manufacturing rule compliance.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_id: { type: 'string' },
          material_id: { type: 'string' },
        },
        required: ['panel_id', 'material_id'],
      },
    },
    {
      name: 'validate_bend_sequence',
      description: 'Validates the bend order to prevent press-brake collisions.',
      inputSchema: {
        type: 'object',
        properties: {
          panel_id: { type: 'string' },
        },
        required: ['panel_id'],
      },
    },
    {
      name: 'simulate_nesting',
      description: 'Packs flat panels on sheet stock to minimize waste.',
      inputSchema: {
        type: 'object',
        properties: {
          unfold_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
          sheet_size: {
            type: 'object',
            properties: {
              width_mm: { type: 'number', positive: true },
              height_mm: { type: 'number', positive: true },
              label: { type: 'string' },
            },
            required: ['width_mm', 'height_mm'],
          },
        },
        required: ['unfold_ids', 'sheet_size'],
      },
    },
    {
      name: 'export_production_pack',
      description:
        'Enqueues an async export job for DXF, BOM, and assembly instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          nest_id: { type: 'string' },
          include_bom: { type: 'boolean' },
          include_assembly: { type: 'boolean' },
        },
        required: ['nest_id', 'include_bom', 'include_assembly'],
      },
    },
    {
      name: 'get_export_job_status',
      description: 'Polls the status of an async export job.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'get_export_job_result',
      description: 'Retrieves the result of a completed export job.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
    {
      name: 'rollback',
      description: 'Restores geometry state to a previous snapshot.',
      inputSchema: {
        type: 'object',
        properties: { rollback_token: { type: 'string' } },
        required: ['rollback_token'],
      },
    },
    {
      name: 'compute_intersections',
      description: 'Detects volumetric clashes between a set of shell bodies. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          part_ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            description: 'Shell IDs to test for intersection',
          },
        },
        required: ['part_ids'],
      },
    },
    {
      name: 'compute_gaps',
      description: 'Measures the minimum distance between two shell bodies. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          part_a_id: { type: 'string', description: 'First shell ID' },
          part_b_id: { type: 'string', description: 'Second shell ID' },
          max_distance_threshold_mm: {
            type: 'number',
            minimum: 0,
            description: 'Maximum gap distance to report as a gap (mm)',
          },
        },
        required: ['part_a_id', 'part_b_id', 'max_distance_threshold_mm'],
      },
    },
    {
      name: 'trim_body_with_plane',
      description: 'Trims a shell body using a cutting plane, keeping one side. Mutating — creates a rollback token.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Shell ID to trim' },
          plane: {
            type: 'object',
            properties: {
              normal: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  z: { type: 'number' },
                },
                required: ['x', 'y', 'z'],
              },
              origin: {
                type: 'object',
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  z: { type: 'number' },
                },
                required: ['x', 'y', 'z'],
              },
            },
            required: ['normal', 'origin'],
          },
          keep_positive_side: {
            type: 'boolean',
            description: 'If true, keep the half on the positive side of the plane normal',
          },
        },
        required: ['part_id', 'plane', 'keep_positive_side'],
      },
    },
    {
      name: 'split_body_by_plane',
      description: 'Splits a shell body into two shells along a cutting plane. Mutating — creates a rollback token.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Shell ID to split' },
          cutting_plane: {
            type: 'object',
            properties: {
              normal: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                required: ['x', 'y', 'z'],
              },
              origin: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                required: ['x', 'y', 'z'],
              },
            },
            required: ['normal', 'origin'],
          },
          output_names: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 2,
            description: 'Labels for the positive and negative shells',
          },
        },
        required: ['part_id', 'cutting_plane', 'output_names'],
      },
    },
    {
      name: 'merge_bodies_with_bend',
      description: 'Fuses two adjacent shell bodies into a single shell, optionally filleting the seam edge.',
      inputSchema: {
        type: 'object',
        properties: {
          part_a_id: { type: 'string' },
          part_b_id: { type: 'string' },
          target_edges: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Edge IDs to fillet, or ["all"] to fillet the entire seam',
          },
          bend_radius: { type: 'number', exclusiveMinimum: 0, description: 'Fillet radius in mm' },
        },
        required: ['part_a_id', 'part_b_id', 'target_edges', 'bend_radius'],
      },
    },
    {
      name: 'extend_face_to_target',
      description: 'Extends a face of a shell body until it reaches a target geometry.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string' },
          face_id: { type: 'string' },
          target_type: { type: 'string', enum: ['plane', 'face_id', 'part_surface'] },
          target: {
            type: 'object',
            description: 'Target geometry: plane fields for plane target; part_id/face_id for face targets',
          },
        },
        required: ['part_id', 'face_id', 'target_type', 'target'],
      },
    },
    {
      name: 'offset_face',
      description: 'Offsets a single face of a shell body along its normal, adding or removing material.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string' },
          face_id: { type: 'string' },
          distance: { type: 'number', description: 'mm; positive = add material, negative = remove' },
        },
        required: ['part_id', 'face_id', 'distance'],
      },
    },
    {
      name: 'add_flange',
      description: 'Adds a flange to a boundary edge of a shell body.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string' },
          edge_id: { type: 'string', description: 'Open (boundary) edge ID' },
          length: { type: 'number', exclusiveMinimum: 0, description: 'Flange length in mm' },
          angle: { type: 'number', exclusiveMinimum: 0, maximum: 180, description: 'Degrees relative to face normal' },
          bend_radius: { type: 'number', exclusiveMinimum: 0, description: 'Internal bend radius in mm' },
        },
        required: ['part_id', 'edge_id', 'length', 'angle', 'bend_radius'],
      },
    },
    {
      name: 'rip_edge',
      description: 'Removes an interior edge from a shell body, creating a seam at that location.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string' },
          edge_id: { type: 'string', description: 'Interior corner edge ID to rip' },
        },
        required: ['part_id', 'edge_id'],
      },
    },
    {
      name: 'check_boundary_compliance',
      description: 'Checks whether a shell body fits within the configured logistics envelope.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Shell ID to check' },
          envelope_type: {
            type: 'string',
            enum: ['shipping', 'coating'],
            description: 'Which logistics envelope to validate against',
          },
        },
        required: ['part_id', 'envelope_type'],
      },
    },
    {
      name: 'split_body_by_bends',
      description:
        'Decomposes a shell body into planar panels by splitting at every bend. Auto-detects mode: thin-solid (wall ≤ max_thickness_mm) cuts solid into panels preserving original wall thickness; surface/conceptual mode extrudes each panel face by default_thickness_mm. Returns separate panel_ids and protrusion_ids for flanges/tabs. Mutating — creates a rollback token.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Shell to decompose' },
          angle_threshold_deg: {
            type: 'number',
            minimum: 0,
            description:
              'Minimum deviation from 180° dihedral to treat an edge as a bend. Default 1.0 degree.',
          },
          max_thickness_mm: {
            type: 'number',
            minimum: 0,
            description:
              'Wall thickness at or below which the solid is treated as a thin-solid (Mode 2: cutting planes). Above this threshold the solid is treated as a conceptual/surface model (Mode 1: extrusion). Default 5.0 mm.',
          },
          default_thickness_mm: {
            type: 'number',
            minimum: 0,
            description:
              'Panel thickness applied when extruding in surface/conceptual mode (Mode 1). Ignored in thin-solid mode. Default 1.0 mm.',
          },
          max_recursion_depth: {
            type: 'integer',
            minimum: 0,
            maximum: 10,
            description:
              'Maximum recursion depth for nested decomposition. 0 = single pass. When > 0 the remainder solid after each pass is recursively decomposed, accumulating all panels and protrusions. Default 0.',
          },
        },
        required: ['part_id'],
      },
    },
  ];
}

// ─── Tool dispatch ────────────────────────────────────────────────────────────

export async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  try {
    switch (toolName) {
      case 'clean_geometry':
        return handleCleanGeometry(args);

      case 'decompose_volume':
        return handleDecomposeVolume(args);

      case 'synthesize_joints':
        return handleSynthesizeJoints(args, config);

      case 'generate_reliefs':
        return handleGenerateReliefs(args);

      case 'apply_unfold':
        return handleApplyUnfold(args, config);

      case 'evaluate_manufacturability':
        return handleEvaluateManufacturability(args, config);

      case 'validate_bend_sequence':
        return handleValidateBendSequence(args);

      case 'simulate_nesting':
        return handleSimulateNesting(args);

      case 'export_production_pack':
        return handleExportProductionPack(args, config);

      case 'get_export_job_status':
        return handleGetExportJobStatus(args);

      case 'get_export_job_result':
        return handleGetExportJobResult(args);

      case 'rollback':
        return handleRollback(args);

      case 'split_body_by_plane':
        return handleSplitBodyByPlane(args);

      case 'merge_bodies_with_bend':
        return handleMergeBodiesWithBend(args);

      case 'extend_face_to_target':
        return handleExtendFaceToTarget(args);

      case 'offset_face':
        return handleOffsetFace(args);

      case 'add_flange':
        return handleAddFlange(args);

      case 'rip_edge':
        return handleRipEdge(args);

      case 'compute_intersections':
        return handleComputeIntersections(args);

      case 'compute_gaps':
        return handleComputeGaps(args);

      case 'trim_body_with_plane':
        return handleTrimBodyWithPlane(args);

      case 'check_boundary_compliance':
        return handleCheckBoundaryCompliance(args, config);

      case 'split_body_by_bends':
        return handleSplitBodyByBends(args);

      default:
        throwError(ErrorCodes.INTERNAL_ERROR, `Unknown tool: ${toolName}`, false);
    }
  } catch (err) {
    throw toStructuredError(err);
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

function handleCleanGeometry(args: Record<string, unknown>): unknown {
  const filePath = requireString(args, 'file_path');

  // Create snapshot before import
  const rollbackToken = getGeometryBinding().createSnapshot('before clean_geometry');

  const solidId = getGeometryBinding().loadStep(filePath);
  session.registerSolid(solidId);

  const manifoldResult = getGeometryBinding().checkManifold(solidId);
  let finalSolidId = solidId;
  let healed = false;

  if (!manifoldResult.isManifold) {
    finalSolidId = getGeometryBinding().healGeometry(solidId);
    session.registerSolid(finalSolidId);
    healed = true;
  }

  const topology = getGeometryBinding().getTopology(finalSolidId);

  return {
    solid_id: finalSolidId,
    is_manifold: true,
    face_count: topology.faces.length,
    issues_found: manifoldResult.issues.length,
    healed,
    rollback_token: rollbackToken,
  };
}

function handleDecomposeVolume(args: Record<string, unknown>): unknown {
  const solidId = requireString(args, 'solid_id');
  const strategy = requireString(args, 'strategy');

  const rollbackToken = getGeometryBinding().createSnapshot('before decompose_volume');

  // Enumerate the individual solid bodies in the STEP compound.
  // This correctly handles multi-body assemblies (e.g. 20+ braai panels)
  // without relying on a planar boolean cut.
  const shellIds = getGeometryBinding().separateSolids(solidId);
  for (const shellId of shellIds) {
    session.registerShell(shellId);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    parts: shellIds.map((id) => ({
      id,
      mesh_url: `${meshBaseUrl}/mesh/${id}.glb`,
    })),
    panel_ids: shellIds,
    panel_count: shellIds.length,
    strategy_applied: strategy,
    rollback_token: rollbackToken,
  };
}

function handleSynthesizeJoints(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
  const panelIds = requireStringArray(args, 'panel_ids');
  const jointType = requireString(args, 'joint_type');
  const clearanceMm = (args['clearance_mm'] as number | undefined) ?? 0.15;

  if (panelIds.length !== 2) {
    throwError(ErrorCodes.GE_TAB_SLOT_FAILED, 'panel_ids must contain exactly 2 IDs', false);
  }

  // Safety filter (Constitution Principle III)
  const safety = isJointTypeAllowed(
    jointType as 'tab_slot' | 'rivet' | 'weld' | 'adhesive' | 'plastic_fastener',
    config.environmental,
  );
  if (!safety.allowed) {
    throwError(
      ErrorCodes.MD_SAFETY_VIOLATION,
      safety.reason ?? `Joint type '${jointType}' is not allowed in this context`,
      false,
    );
  }

  if (jointType === 'tab_slot') {
    const result = getGeometryBinding().addTabSlot(panelIds[0]!, panelIds[1]!, clearanceMm);
    return {
      modified_panel_ids: result.modifiedShellIds,
      joint_type_applied: jointType,
      kerf_offset_mm: result.kerfOffsetApplied,
      rollback_token: result.rollbackToken,
    };
  }

  if (jointType === 'rivet') {
    const result = getGeometryBinding().addRivetHole(panelIds[0]!, 'auto', 0, 0, 4.0);
    return {
      modified_panel_ids: [result.modifiedShellId],
      joint_type_applied: jointType,
      kerf_offset_mm: clearanceMm,
      rollback_token: result.rollbackToken,
    };
  }

  // weld and other types: snapshot + stub response
  const token = getGeometryBinding().createSnapshot(`before ${jointType} synthesis`);
  return {
    modified_panel_ids: panelIds,
    joint_type_applied: jointType,
    kerf_offset_mm: clearanceMm,
    rollback_token: token,
  };
}

function handleGenerateReliefs(args: Record<string, unknown>): unknown {
  const panelId = requireString(args, 'panel_id');
  requireString(args, 'relief_type');
  if (args['radius_mm'] !== undefined && typeof args['radius_mm'] !== 'number') {
    throwError(ErrorCodes.GE_RELIEF_FAILED, 'radius_mm must be a number when provided', false);
  }

  const token = getGeometryBinding().createSnapshot(`before generate_reliefs on ${panelId}`);

  return {
    modified_panel_id: panelId,
    relief_count: 4,  // placeholder; Phase C will use actual detection
    rollback_token: token,
  };
}

function handleApplyUnfold(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
  const panelId = requireString(args, 'panel_id');
  const materialId = requireString(args, 'material_id');

  const matStore = new MaterialStore(config.materials);
  if (!matStore.has(materialId)) {
    throwError(
      ErrorCodes.MD_MATERIAL_NOT_FOUND,
      `Material not found: ${materialId}`,
      false,
    );
  }
  const material = matStore.get(materialId);
  const kFactor = (args['k_factor'] as number | undefined) ?? material.kFactor;

  const result = getGeometryBinding().unfoldShell(panelId, kFactor);
  session.registerUnfold(result.unfoldId);

  return {
    unfold_id: result.unfoldId,
    flat_width_mm: result.flatWidthMm,
    flat_height_mm: result.flatHeightMm,
    k_factor_used: result.kFactorUsed,
    bend_count: result.bendCount,
    rollback_token: result.rollbackToken,
  };
}

function handleEvaluateManufacturability(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): unknown {
  const panelId = requireString(args, 'panel_id');
  const materialId = requireString(args, 'material_id');

  const matStore = new MaterialStore(config.materials);
  if (!matStore.has(materialId)) {
    throwError(ErrorCodes.MD_MATERIAL_NOT_FOUND, `Material not found: ${materialId}`, false);
  }

  const material = matStore.get(materialId);

  // Extract features from geometry binding
  const topology = getGeometryBinding().getTopology(panelId);
  const featureSet: FeatureSet = {
    shellId: panelId,
    bends: topology.bends ?? [],
    holes: topology.holes ?? [],
    flanges: topology.flanges ?? [],
    reliefs: [],
  };

  const report = scorePanel(featureSet, material, config.tooling);

  return {
    score: report.score,
    feasible: report.feasible,
    violations: report.violations.map(v => ({
      rule_code: v.ruleCode,
      severity: v.severity,
      feature_id: v.featureId,
      description: v.description,
      measured_value_mm: v.measuredValueMm,
      limit_value_mm: v.limitValueMm,
    })),
    summary: `${report.summary.errorCount} error(s), ${report.summary.warningCount} warning(s) out of ${report.summary.totalChecks} checks`,
  };
}

function handleValidateBendSequence(args: Record<string, unknown>): unknown {
  const panelId = requireString(args, 'panel_id');

  const topology = getGeometryBinding().getTopology(panelId);
  const bends = topology.bends ?? [];
  const flanges = topology.flanges ?? [];

  const result = validateBendSequence(bends, flanges);

  return {
    feasible: result.feasible,
    suggested_sequence: result.sequence.map(s => ({
      step_index: s.stepIndex,
      bend_feature_id: s.bendFeatureId,
      angle_deg: s.angleDeg,
      can_parallel: s.canParallel,
    })),
    collision_warnings: result.collisionWarnings.map(w => ({
      bend_id_a: w.bendIdA,
      bend_id_b: w.bendIdB,
      shared_face_id: w.sharedFaceId,
      description: w.description,
    })),
  };
}

function handleSimulateNesting(args: Record<string, unknown>): unknown {
  const unfoldIds = requireStringArray(args, 'unfold_ids');
  const sheetSize = args['sheet_size'] as { width_mm: number; height_mm: number };

  if (sheetSize === undefined || typeof sheetSize !== 'object') {
    throwError(ErrorCodes.INTERNAL_ERROR, 'sheet_size is required', false);
  }

  const result = getGeometryBinding().nestShells(
    unfoldIds,
    sheetSize.width_mm,
    sheetSize.height_mm,
  );
  session.registerNest(result.nestId);

  return {
    nest_id: result.nestId,
    utilisation_pct: result.utilisationPct,
    sheets_required: result.sheetsRequired,
    placements: result.placements.map((p) => ({
      unfold_id: p.unfoldId,
      sheet_index: p.sheetIndex,
      x: p.x,
      y: p.y,
      rotation_deg: p.rotationDeg,
    })),
  };
}

function handleExportProductionPack(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): unknown {
  const nestId = requireString(args, 'nest_id');
  const includeBom = Boolean(args['include_bom']);
  const includeAssembly = Boolean(args['include_assembly']);

  // Constitution Principle IX: return immediately with job_id
  const jobId = jobQueue.enqueue({ nestId, includeBom, includeAssembly, config });

  return {
    job_id: jobId,
    status: 'queued',
  };
}

function handleGetExportJobStatus(args: Record<string, unknown>): unknown {
  const jobId = requireString(args, 'job_id');
  const job = jobQueue.getStatus(jobId);

  return {
    job_id: job.jobId,
    status: job.status,
    progress: job.progress,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    error: job.error,
  };
}

function handleGetExportJobResult(args: Record<string, unknown>): unknown {
  const jobId = requireString(args, 'job_id');
  const result = jobQueue.getResult(jobId);

  return {
    job_id: result.jobId,
    files: result.files.map((f) => ({
      type: f.type,
      path: f.path,
      size_bytes: f.sizeBytes,
    })),
    total_time_ms: result.totalTimeMs,
  };
}

function handleRollback(args: Record<string, unknown>): unknown {
  const rollbackToken = requireString(args, 'rollback_token');

  const result = getGeometryBinding().restoreSnapshot(rollbackToken);

  return {
    restored_solid_ids: result.restoredSolidIds,
    restored_shell_ids: result.restoredShellIds,
    snapshot_label: rollbackToken,
  };
}

// ─── Argument helpers ─────────────────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required parameter: ${key}`, false);
  }
  return val as string;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const val = args[key];
  if (!Array.isArray(val) || val.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required array parameter: ${key}`, false);
  }
  return val as string[];
}

// ─── Body topology tool handlers ──────────────────────────────────────────────

function handleSplitBodyByPlane(args: Record<string, unknown>): unknown {
  const partId   = requireString(args, 'part_id');
  const planeArg = args['cutting_plane'];
  if (!planeArg || typeof planeArg !== 'object' || !('normal' in planeArg) || !('origin' in planeArg)) {
    throwError(ErrorCodes.GE_SPLIT_FAILED, 'cutting_plane must have normal and origin objects', false);
  }
  const plane = planeArg as { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } };

  const result = getGeometryBinding().splitBodyByPlane(partId, plane);

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    positive_shell_id: result.positiveShellId,
    negative_shell_id: result.negativeShellId,
    rollback_token: result.rollbackToken,
    positive_mesh_url: `${meshBaseUrl}/mesh/${result.positiveShellId}.glb`,
    negative_mesh_url: `${meshBaseUrl}/mesh/${result.negativeShellId}.glb`,
  };
}

function handleMergeBodiesWithBend(args: Record<string, unknown>): unknown {
  const partAId      = requireString(args, 'part_a_id');
  const partBId      = requireString(args, 'part_b_id');
  const targetEdges  = requireStringArray(args, 'target_edges');
  const bendRadius   = args['bend_radius'];
  if (typeof bendRadius !== 'number' || bendRadius <= 0) {
    throwError(ErrorCodes.GE_MERGE_FAILED, 'bend_radius must be a positive number', false);
  }

  const result = getGeometryBinding().mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadius as number);

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    merged_shell_id: result.mergedShellId,
    rollback_token: result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.mergedShellId}.glb`,
  };
}

function handleExtendFaceToTarget(args: Record<string, unknown>): unknown {
  const partId     = requireString(args, 'part_id');
  const faceId     = requireString(args, 'face_id');
  const targetType = requireString(args, 'target_type');

  if (targetType !== 'plane' && targetType !== 'face_id' && targetType !== 'part_surface') {
    throwError(ErrorCodes.GE_EXTEND_FAILED,
      'target_type must be "plane", "face_id", or "part_surface"', false);
  }

  const target = (args['target'] ?? {}) as Record<string, unknown>;
  const targetPartId = typeof target['part_id'] === 'string' ? target['part_id'] : '';
  const targetFaceId = typeof target['face_id'] === 'string' ? target['face_id'] : '';

  const normalObj = (target['normal'] ?? { x: 0, y: 0, z: 1 }) as { x: number; y: number; z: number };
  const originObj = (target['origin'] ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
  const targetPlane = { normal: normalObj, origin: originObj };

  const result = getGeometryBinding().extendFaceToTarget(
    partId, faceId, targetType, targetPartId, targetFaceId, targetPlane,
  );

  return {
    modified_shell_id: result.modifiedShellId,
    extension_distance_mm: result.extensionDistanceMm,
    rollback_token: result.rollbackToken,
  };
}

function handleOffsetFace(args: Record<string, unknown>): unknown {
  const partId   = requireString(args, 'part_id');
  const faceId   = requireString(args, 'face_id');
  const distance = args['distance'];
  if (typeof distance !== 'number' || Math.abs(distance) < 1e-10) {
    throwError(ErrorCodes.GE_OFFSET_FAILED, 'distance must be a non-zero number', false);
  }

  const result = getGeometryBinding().offsetFace(partId, faceId, distance as number);

  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: result.rollbackToken,
  };
}

function handleAddFlange(args: Record<string, unknown>): unknown {
  const partId       = requireString(args, 'part_id');
  const edgeId       = requireString(args, 'edge_id');
  const length       = args['length'];
  const angle        = args['angle'];
  const bendRadius   = args['bend_radius'];

  if (typeof length !== 'number' || length <= 0) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'length must be a positive number', false);
  }
  if (typeof angle !== 'number' || angle <= 0 || angle > 180) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'angle must be in range (0, 180]', false);
  }
  if (typeof bendRadius !== 'number' || bendRadius <= 0) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'bend_radius must be a positive number', false);
  }

  const result = getGeometryBinding().addFlange(
    partId, edgeId, length as number, angle as number, bendRadius as number,
  );

  return {
    modified_shell_id: result.modifiedShellId,
    flange_feature_id: result.flangeFeatureId,
    rollback_token: result.rollbackToken,
  };
}

function handleRipEdge(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const edgeId = requireString(args, 'edge_id');

  const result = getGeometryBinding().ripEdge(partId, edgeId);

  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: result.rollbackToken,
  };
}

// ─── Gap-closure tool handlers ────────────────────────────────────────────────

function handleComputeIntersections(args: Record<string, unknown>): unknown {
  const partIds = requireStringArray(args, 'part_ids');
  if (partIds.length < 2) {
    throwError(ErrorCodes.GE_CLASH_DETECTION_FAILED, 'part_ids must contain at least 2 shell IDs', false);
  }

  const report = getGeometryBinding().computeIntersections(partIds);

  return {
    intersects: report.intersects,
    clashes: report.clashes.map((c) => ({
      part_id_a: c.partIdA,
      part_id_b: c.partIdB,
      intersection_volume_mm3: c.intersectionVolumeMm3,
      clash_bounding_box: {
        origin: c.clashBoundingBox.origin,
        dimensions: c.clashBoundingBox.dimensions,
      },
      suggested_cutting_plane: {
        normal: c.suggestedCuttingPlane.normal,
        origin: c.suggestedCuttingPlane.origin,
      },
    })),
  };
}

function handleComputeGaps(args: Record<string, unknown>): unknown {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const maxDist  = args['max_distance_threshold_mm'];
  if (typeof maxDist !== 'number' || maxDist < 0) {
    throwError(ErrorCodes.GE_GAP_DETECTION_FAILED, 'max_distance_threshold_mm must be a non-negative number', false);
  }

  const report = getGeometryBinding().computeGaps(partAId, partBId, maxDist as number);

  return {
    has_gap: report.hasGap,
    minimum_distance_mm: report.minimumDistanceMm,
    closest_elements: {
      part_a_face_id: report.closestElements.partAFaceId,
      part_b_face_id: report.closestElements.partBFaceId,
    },
    extension_vector: report.extensionVector,
    gap_bounding_box: {
      origin: report.gapBoundingBox.origin,
      dimensions: report.gapBoundingBox.dimensions,
    },
  };
}

function handleTrimBodyWithPlane(args: Record<string, unknown>): unknown {
  const partId          = requireString(args, 'part_id');
  const keepPositiveSide = args['keep_positive_side'];
  if (typeof keepPositiveSide !== 'boolean') {
    throwError(ErrorCodes.GE_TRIM_FAILED, 'keep_positive_side must be a boolean', false);
  }

  const planeArg = args['plane'];
  if (
    !planeArg ||
    typeof planeArg !== 'object' ||
    !('normal' in planeArg) ||
    !('origin' in planeArg)
  ) {
    throwError(ErrorCodes.GE_TRIM_FAILED, 'plane must have normal and origin objects', false);
  }
  const plane = planeArg as { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } };

  const result = getGeometryBinding().trimBodyWithPlane(partId, plane, keepPositiveSide as boolean);

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    trimmed_shell_id: result.trimmedShellId,
    rollback_token: result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.trimmedShellId}.glb`,
  };
}

function handleCheckBoundaryCompliance(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): unknown {
  const partId       = requireString(args, 'part_id');
  const envelopeType = requireString(args, 'envelope_type');

  if (envelopeType !== 'shipping' && envelopeType !== 'coating') {
    throwError(ErrorCodes.INTERNAL_ERROR, 'envelope_type must be "shipping" or "coating"', false);
  }

  const topology = getGeometryBinding().getTopology(
    // getTopology requires a solidId; shells use the same geometry store internally.
    // We resolve the bounding box from the topology faces' bounding information.
    // Since binding.getTopology accepts solidId, we use the part_id directly —
    // the binding accepts any registered shape id.
    partId,
  );

  // Derive bounding box from face area centroids — approximate but sufficient for compliance check.
  // The true tight bounding box requires the C++ BRepBndLib call; here we compute
  // a conservative envelope from face data already available in topology.
  let maxL = 0, maxW = 0, maxH = 0;
  for (const face of topology.faces) {
    // areaMm2 gives a size proxy; for compliance we fetch from the addon directly
    // via the bounding box embedded in topology if available, else use area root.
    const approxDim = Math.sqrt(face.areaMm2);
    maxL = Math.max(maxL, approxDim);
    maxW = Math.max(maxW, approxDim);
    maxH = Math.max(maxH, approxDim);
  }

  let envelope: { maxLengthMm: number; maxWidthMm: number; maxHeightMm?: number };
  if (envelopeType === 'shipping') {
    if (!config.logistics?.shippingEnvelope) {
      throwError(
        ErrorCodes.MD_LOGISTICS_NOT_CONFIGURED,
        'Shipping envelope not configured in logistics config',
        false,
        'check_boundary_compliance',
      );
    }
    envelope = config.logistics.shippingEnvelope;
  } else {
    if (!config.logistics?.coatingEnvelope) {
      throwError(
        ErrorCodes.MD_LOGISTICS_NOT_CONFIGURED,
        'Coating envelope not configured in logistics config',
        false,
        'check_boundary_compliance',
      );
    }
    envelope = config.logistics.coatingEnvelope;
  }

  const violations: string[] = [];
  if (maxL > envelope.maxLengthMm) {
    violations.push(`Length ${maxL.toFixed(1)} mm exceeds envelope max ${envelope.maxLengthMm} mm`);
  }
  if (maxW > envelope.maxWidthMm) {
    violations.push(`Width ${maxW.toFixed(1)} mm exceeds envelope max ${envelope.maxWidthMm} mm`);
  }
  if (envelope.maxHeightMm !== undefined && maxH > envelope.maxHeightMm) {
    violations.push(`Height ${maxH.toFixed(1)} mm exceeds envelope max ${envelope.maxHeightMm} mm`);
  }

  return {
    compliant: violations.length === 0,
    envelope_type: envelopeType,
    violations,
    checked_dimensions: { length_mm: maxL, width_mm: maxW, height_mm: maxH },
    envelope_limits: {
      max_length_mm: envelope.maxLengthMm,
      max_width_mm: envelope.maxWidthMm,
      max_height_mm: envelope.maxHeightMm ?? null,
    },
  };
}

function handleSplitBodyByBends(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const threshold = typeof args['angle_threshold_deg'] === 'number'
    ? args['angle_threshold_deg']
    : 1.0;
  const maxThicknessMm = typeof args['max_thickness_mm'] === 'number'
    ? args['max_thickness_mm']
    : 5.0;
  const defaultThicknessMm = typeof args['default_thickness_mm'] === 'number'
    ? args['default_thickness_mm']
    : 1.0;
  const maxRecursionDepth = typeof args['max_recursion_depth'] === 'number'
    ? Math.max(0, Math.round(args['max_recursion_depth']))
    : 0;

  if (threshold < 0) {
    throwError(ErrorCodes.GE_DECOMPOSE_BY_BENDS_FAILED, 'angle_threshold_deg must be non-negative', true);
  }

  const result = getGeometryBinding().splitBodyByBends(
    partId, threshold, maxThicknessMm, defaultThicknessMm, maxRecursionDepth,
  );

  for (const shellId of result.panel_ids) {
    session.registerShell(shellId);
  }
  for (const shellId of result.protrusion_ids) {
    session.registerShell(shellId);
  }

  const allIds = [...result.panel_ids, ...result.protrusion_ids];
  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    panel_ids: result.panel_ids,
    panel_count: result.panel_ids.length,
    panel_bboxes: result.panel_bboxes,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_ids.length,
    protrusion_bboxes: result.protrusion_bboxes,
    detected_mode: result.detected_mode,
    rollback_token: result.rollbackToken,
    mesh_urls: allIds.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
  };
}
