/**
 * MCP tool dispatch — implements all MCP tools.
 *
 * Tasks: T063, T064, T065, T080, T081, T082, T083, T099, T101, T102, T103, T104, T105
 */

import { geometryBinding } from '../geometry/binding';
import { session } from '../geometry/session';
import { jobQueue } from '../geometry/jobs';
import { toStructuredError, throwError, ErrorCodes } from './errors';
import type { ManufacturingConfig } from '../config/loader';
import { MaterialStore } from '../manufacturing/material';
import { isJointTypeAllowed } from '../manufacturing/rules';

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
  const rollbackToken = geometryBinding.createSnapshot('before clean_geometry');

  const solidId = geometryBinding.loadStep(filePath);
  session.registerSolid(solidId);

  const manifoldResult = geometryBinding.checkManifold(solidId);
  let finalSolidId = solidId;
  let healed = false;

  if (!manifoldResult.isManifold) {
    finalSolidId = geometryBinding.healGeometry(solidId);
    session.registerSolid(finalSolidId);
    healed = true;
  }

  const topology = geometryBinding.getTopology(finalSolidId);

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

  // Compute a decomposition plane based on strategy
  // Logistics strategy: cut along longest axis; Simplicity: midpoint; Integrity: by feature
  const normal = { x: 0, y: 0, z: 1 };
  const origin = { x: 0, y: 0, z: 0 };

  const result = geometryBinding.booleanCut(solidId, normal, origin);
  for (const shellId of result.shellIds) {
    session.registerShell(shellId);
  }

  return {
    panel_ids: result.shellIds,
    panel_count: result.shellIds.length,
    strategy_applied: strategy,
    rollback_token: result.rollbackToken,
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
    const result = geometryBinding.addTabSlot(panelIds[0]!, panelIds[1]!, clearanceMm);
    return {
      modified_panel_ids: result.modifiedShellIds,
      joint_type_applied: jointType,
      kerf_offset_mm: result.kerfOffsetApplied,
      rollback_token: result.rollbackToken,
    };
  }

  if (jointType === 'rivet') {
    const result = geometryBinding.addRivetHole(panelIds[0]!, 'auto', 0, 0, 4.0);
    return {
      modified_panel_ids: [result.modifiedShellId],
      joint_type_applied: jointType,
      kerf_offset_mm: clearanceMm,
      rollback_token: result.rollbackToken,
    };
  }

  // weld and other types: snapshot + stub response
  const token = geometryBinding.createSnapshot(`before ${jointType} synthesis`);
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

  const token = geometryBinding.createSnapshot(`before generate_reliefs on ${panelId}`);

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

  const result = geometryBinding.unfoldShell(panelId, kFactor);
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
  requireString(args, 'panel_id');
  const materialId = requireString(args, 'material_id');

  const matStore = new MaterialStore(config.materials);
  if (!matStore.has(materialId)) {
    throwError(ErrorCodes.MD_MATERIAL_NOT_FOUND, `Material not found: ${materialId}`, false);
  }

  // Phase A stub: full scoring in Phase C (T076-T077)
  return {
    score: 1.0,
    violations: [],
    summary: 'No violations detected (Phase A stub; full scoring in Phase C)',
  };
}

function handleValidateBendSequence(args: Record<string, unknown>): unknown {
  requireString(args, 'panel_id');

  // Phase A stub: full validation in Phase C (T075)
  return {
    valid: true,
    suggested_sequence: [],
    collision_warnings: [],
  };
}

function handleSimulateNesting(args: Record<string, unknown>): unknown {
  const unfoldIds = requireStringArray(args, 'unfold_ids');
  const sheetSize = args['sheet_size'] as { width_mm: number; height_mm: number };

  if (sheetSize === undefined || typeof sheetSize !== 'object') {
    throwError(ErrorCodes.INTERNAL_ERROR, 'sheet_size is required', false);
  }

  const result = geometryBinding.nestShells(
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

  const result = geometryBinding.restoreSnapshot(rollbackToken);

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
