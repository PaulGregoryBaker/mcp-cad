/**
 * Manufacturing tool definitions and handler functions.
 */

import { throwError, ErrorCodes } from '../errors.js';
import {
  getGeometryBinding,
  getParts,
  createPart,
  getManufacturingGraph,
} from '../state.js';
import { session } from '../../geometry/session.js';
import { transactionRegistry } from '../transactions.js';
import {
  requireString,
  requireStringArray,
  resolveTransactionContext,
  buildMeshUrl,
  buildMeshUrls,
  resolveRollbackToken,
  appendHistoryIfJoined,
} from '../helpers.js';
import { MaterialStore } from '../../manufacturing/material.js';
import { isJointTypeAllowed } from '../../manufacturing/rules.js';
import { scorePanel } from '../../manufacturing/manufacturability.js';
import { validateBendSequence } from '../../manufacturing/bend_sequence.js';
import type { FeatureSet } from '../../manufacturing/feature.js';
import { toNodeId } from '../../manufacturing/graph/types.js';
import type { PanelFrame } from '../../manufacturing/graph/types.js';
import type { ManufacturingConfig } from '../../config/loader.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const manufacturingDefinitions: object[] = [
  {
    name: 'decompose_volume',
    description: 'Splits a solid volume into manufacturable panels.',
    inputSchema: {
      type: 'object',
      properties: {
        solid_id: { type: 'string' },
        strategy: { type: 'string', enum: ['Integrity', 'Simplicity', 'Logistics'] },
        max_panels: { type: 'number', minimum: 1, maximum: 10 },
        transaction_id: { type: 'string' },
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
        transaction_id: { type: 'string' },
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
        transaction_id: { type: 'string' },
      },
      required: ['panel_id', 'relief_type'],
    },
  },
  {
    name: 'validate_sheet_metal',
    description: 'Inspects a 3D solid/shell and validates if it conforms to standard sheet metal constraints: uniform thickness and unfoldability (no T-junctions, no closed cycles). Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'ID of the body/shell to validate' }
      },
      required: ['part_id']
    }
  },
  {
    name: 'reconstruct_curved_bends',
    description: 'Replaces infinitely sharp joint edges in a 3D CAD model with realistic rounded cylindrical bends based on material thickness (inner radius = t, outer radius = 2t). Returns a new replacement solid ID. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'ID of the sharp-edge part to reconstruct' },
        transaction_id: { type: 'string', description: 'Active transaction ID' }
      },
      required: ['part_id', 'transaction_id']
    }
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
];

// ─── Handler implementations ──────────────────────────────────────────────────

export function handleDecomposeVolume(args: Record<string, unknown>): unknown {
  const solidId = requireString(args, 'solid_id');
  const strategy = requireString(args, 'strategy');

  const ctx = resolveTransactionContext(args);
  let rollbackToken: string;
  if (ctx.mode === 'implicit') {
    rollbackToken = getGeometryBinding().createSnapshot('before decompose_volume');
  } else {
    transactionRegistry.appendHistory(ctx.transactionId, []);
    rollbackToken = ctx.transactionId;
  }

  // Enumerate the individual solid bodies in the STEP compound.
  // This correctly handles multi-body assemblies (e.g. 20+ braai panels)
  // without relying on a planar boolean cut.
  const shellIds = getGeometryBinding().separateSolids(solidId);
  for (const shellId of shellIds) {
    session.registerShell(shellId);
  }

  // Auto-create manufacturing graphs for each decomposed shell so that
  // apply_unfold works uniformly after decompose_volume (same as split_body_by_bends).
  const toBodyId = (s: string) => s as import('../../manufacturing/graph/types').BodyId;
  for (const shellId of shellIds) {
    if (getParts().has(shellId)) continue;  // already registered (e.g. from a previous decompose)
    createPart(shellId);
    const graph = getManufacturingGraph(shellId);
    let flatWidth: number | null = null;
    let flatHeight: number | null = null;
    let panelFrame: PanelFrame | null = null;
    let nominalThickness = 1.0;
    try {
      // getPanelFrame gives accurate OCCT face frame + dimensions for planar shells.
      // For non-planar decomposed solids it may throw; fall back to bbox for dims only.
      const pf = getGeometryBinding().getPanelFrame(shellId);
      nominalThickness = pf.thicknessMm > 0 ? pf.thicknessMm : 1.0;
      flatWidth = pf.uExtentMm;
      flatHeight = pf.vExtentMm;
      panelFrame = {
        origin: [pf.originX, pf.originY, pf.originZ],
        u: [pf.uX, pf.uY, pf.uZ],
        v: [pf.vX, pf.vY, pf.vZ],
      };
    } catch {
      try {
        const bbox = getGeometryBinding().computeBoundingBox(shellId);
        const dims = [
          bbox.x_max - bbox.x_min,
          bbox.y_max - bbox.y_min,
          bbox.z_max - bbox.z_min,
        ].sort((a, b) => a - b);
        nominalThickness = dims[0] ?? 1.0;
        flatWidth = dims[2] ?? null;
        flatHeight = dims[1] ?? null;
      } catch { /* skip dim derivation if bbox also fails */ }
    }
    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(shellId),
      bodyId: toBodyId(shellId),
      dirty: true,
      materialType: 'default',
      nominalThickness,
      flatWidth,
      flatHeight,
      canonical: true,
      shapeDxf: null,
      panelFrame: panelFrame ?? undefined,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] },
    });
  }

  return {
    parts: shellIds.map((id) => ({
      id,
      mesh_url: buildMeshUrl(id),
    })),
    panel_ids: shellIds,
    panel_count: shellIds.length,
    strategy_applied: strategy,
    rollback_token: rollbackToken,
  };
}

export function handleSynthesizeJoints(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
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

  const ctx = resolveTransactionContext(args);

  if (jointType === 'tab_slot') {
    const result = getGeometryBinding().addTabSlot(panelIds[0]!, panelIds[1]!, clearanceMm);
    appendHistoryIfJoined(ctx, result.shape_history);
    return {
      modified_panel_ids: result.modifiedShellIds,
      joint_type_applied: jointType,
      kerf_offset_mm: result.kerfOffsetApplied,
      rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
      shape_history: result.shape_history ?? [],
      mesh_urls: buildMeshUrls(result.modifiedShellIds as string[]),
    };
  }

  if (jointType === 'rivet') {
    const result = getGeometryBinding().addRivetHole(panelIds[0]!, 'auto', 0, 0, 4.0);
    appendHistoryIfJoined(ctx, result.shape_history);
    return {
      modified_panel_ids: [result.modifiedShellId],
      joint_type_applied: jointType,
      kerf_offset_mm: clearanceMm,
      rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
      shape_history: result.shape_history ?? [],
      mesh_urls: buildMeshUrls([result.modifiedShellId]),
    };
  }

  appendHistoryIfJoined(ctx, []);

  // weld and other types: snapshot + stub response
  const token = ctx.mode === 'implicit'
    ? getGeometryBinding().createSnapshot(`before ${jointType} synthesis`)
    : ctx.transactionId;
  return {
    modified_panel_ids: panelIds,
    joint_type_applied: jointType,
    kerf_offset_mm: clearanceMm,
    rollback_token: token,
  };
}

export function handleGenerateReliefs(args: Record<string, unknown>): unknown {
  const panelId = requireString(args, 'panel_id');
  requireString(args, 'relief_type');
  if (args['radius_mm'] !== undefined && typeof args['radius_mm'] !== 'number') {
    throwError(ErrorCodes.GE_RELIEF_FAILED, 'radius_mm must be a number when provided', false);
  }

  const ctx = resolveTransactionContext(args);
  let rollbackToken: string;
  if (ctx.mode === 'implicit') {
    rollbackToken = getGeometryBinding().createSnapshot(`before generate_reliefs on ${panelId}`);
  } else {
    transactionRegistry.appendHistory(ctx.transactionId, []);
    rollbackToken = ctx.transactionId;
  }

  return {
    modified_panel_id: panelId,
    relief_count: 4,  // placeholder; Phase C will use actual detection
    rollback_token: rollbackToken,
    mesh_url: buildMeshUrl(panelId),
  };
}

export function handleValidateSheetMetal(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const result = getGeometryBinding().validateSheetMetal(partId);
  return {
    is_valid: result.is_valid,
    nominal_thickness: result.nominal_thickness,
    can_flatten: result.can_flatten,
    validation_errors: result.validation_errors,
  };
}

export function handleReconstructCurvedBends(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().reconstructCurvedBends(partId);
  session.registerShell(result.solid_id);
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    solid_id: result.solid_id,
    bends_replaced: result.bends_replaced,
    rollback_token: resolveRollbackToken(ctx, result.rollback_token),
    shape_history: result.shape_history ?? [],
  };
}

export function handleEvaluateManufacturability(
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

export function handleValidateBendSequence(args: Record<string, unknown>): unknown {
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

export function handleSimulateNesting(args: Record<string, unknown>): unknown {
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
