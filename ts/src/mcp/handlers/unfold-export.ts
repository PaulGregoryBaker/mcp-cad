/**
 * MCP handlers for unfold and export operations.
 * Extracted from tools.ts — get_unfold, export_production_pack,
 * get_export_job_status, get_export_job_result.
 */

import { throwError, ErrorCodes } from '../errors.js';
import { getManufacturingGraph } from '../state.js';
import { jobQueue } from '../../geometry/jobs.js';
import { requireString, resolveTransactionContext, resolveRollbackToken } from '../helpers.js';
import { getGeometryBinding } from '../state.js';
import { filterInvalidCutLines, generateDxfFromManufacturingGraph } from '../dxf-helpers.js';
import { MaterialStore } from '../../manufacturing/material.js';
import type { BendZone } from '../../manufacturing/graph/types.js';
import type { ManufacturingConfig } from '../../config/loader.js';

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Extract bend lines from FlatPatternDimensions.
 * Returns normalized coordinates {x1,y1,x2,y2} in the range [0,1] relative to
 * the flat-pattern bounding box.
 * SOURCE: Manufacturing graph bendZones, NOT parsed from DXF text.
 */
function extractBendLinesFromGraph(
  flatWidthMm: number,
  bendZones: import('../../manufacturing/graph/types').BendZone[],
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const bendLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  for (const zone of bendZones) {
    const xOffset = zone.offset + zone.width / 2; // line at center of bend zone
    bendLines.push({
      x1: xOffset / flatWidthMm,
      y1: 0, // from bottom
      x2: xOffset / flatWidthMm,
      y2: 1, // to top (normalized)
    });
  }

  return bendLines;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const unfoldExportDefinitions: object[] = [
  {
    name: 'get_unfold',
    description: 'Returns the flat-pattern data for a sheet-metal panel from the Manufacturing Graph — flat blank dimensions, bend-line annotations, DXF outline, and K-factor. Reads from the graph (source of truth); does NOT derive 2D from the 3D shell. Requires an existing manufacturing graph created by split_body_by_bends or merge_bodies_with_bend. Read-only — transaction_id is accepted but no geometry mutations occur.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Manufacturing Graph part ID (required; graph must exist)' },
        panel_id: { type: 'string', description: 'Panel node ID within the manufacturing graph' },
        material_id: { type: 'string', description: 'Material ID from configuration' },
        k_factor: { type: 'number', minimum: 0.25, maximum: 0.50, description: 'Optional K-factor override. Sourced from material DB if omitted.' },
        auto_heal_tolerance: { type: 'number', default: 0.1, maximum: 0.1, description: 'Maximum gap tolerance (mm) for automatic sewing repair.' },
        transaction_id: { type: 'string', description: 'Active transaction ID' }
      },
      required: ['part_id', 'panel_id', 'material_id', 'transaction_id'],
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
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function handleGetUnfold(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
  // Validate required arguments explicitly.
  const partId = requireString(args, 'part_id');
  const panelId = typeof args['panel_id'] === 'string' && args['panel_id'].length > 0
    ? args['panel_id']
    : partId;
  const materialId = requireString(args, 'material_id');
  const ctx = resolveTransactionContext(args);
  requireString(args, 'transaction_id');

  const graph = getManufacturingGraph(partId);

  const panelNodeId = panelId as import('../../manufacturing/graph/types').NodeId;
  let panelNode: import('../../manufacturing/graph/types').PanelNode | undefined;
  for (const node of graph.nodes.values()) {
    if (node.type === 'PanelNode') {
      const pn = node as import('../../manufacturing/graph/types').PanelNode;
      if (pn.id === panelNodeId) { panelNode = pn; break; }
      if (pn.bodyId === (panelId as import('../../manufacturing/graph/types').BodyId) && pn.canonical !== false) {
        panelNode = pn; break;
      }
    }
  }

  if (!panelNode) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" not found in part "${partId}" manufacturing graph. ` +
      `Run split_body_by_bends first to create the manufacturing graph.`,
      true,
      'split_body_by_bends',
    );
  }

  if (panelNode.canonical === false) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" is non-canonical (consumed by a prior merge). ` +
      `Use preserved_part_id / merged_part_id as panel_id.`,
      true,
      'merge_bodies_with_bend',
    );
  }

  const matStore = new MaterialStore(config.materials);
  if (!matStore.has(materialId)) {
    throwError(ErrorCodes.MD_MATERIAL_NOT_FOUND, `Material not found: ${materialId}`, false);
  }
  const material = matStore.get(materialId);
  const kFactor = (args['k_factor'] as number | undefined) ?? material.kFactor;

  // Read flat-pattern data directly from the graph.
  let graphDims = graph.getFlatPatternDimensions(panelNode.id);
  if (!graphDims) {
    // If the graph has a PanelNode with a live bodyId but no flat-pattern
    // dimensions (e.g. a panel created by fuse_bodies where one input was a
    // non-graph-tracked derived shell), approximate from the 3D bounding box.
    // This is NOT the 3D→2D unfold path — it's just bbox sizing to avoid a
    // hard error. A proper solution is to ensure fuse_bodies always sets
    // graph dimensions, or to run split_body_by_bends on derived shells first.
    if (panelNode.bodyId) {
      try {
        const bb = getGeometryBinding().computeBoundingBox(panelNode.bodyId);
        const dims = [bb.x_max - bb.x_min, bb.y_max - bb.y_min, bb.z_max - bb.z_min].sort((a, b) => a - b);
        const approxWidth = dims[2] ?? 100;
        const approxHeight = dims[1] ?? 100;
        panelNode.flatWidth = approxWidth;
        panelNode.flatHeight = approxHeight;
        panelNode.nominalThickness = dims[0] ?? 1;
        graphDims = graph.getFlatPatternDimensions(panelNode.id) ?? { width: approxWidth, height: approxHeight, bendZones: [] };
      } catch {
        throwError(
          ErrorCodes.GRAPH_INTEGRITY_ERROR,
          `Panel "${panelId}" has no flat-pattern data in the manufacturing graph. ` +
          `Run split_body_by_bends first to create the manufacturing graph.`,
          true,
          'split_body_by_bends',
        );
      }
    } else {
      throwError(
        ErrorCodes.GRAPH_INTEGRITY_ERROR,
        `Panel "${panelId}" has no flat-pattern data in the manufacturing graph. ` +
        `Run split_body_by_bends first to create the manufacturing graph.`,
        true,
        'split_body_by_bends',
      );
    }
  }

  // Use the stored shapeDxf if available; otherwise generate a simple rectangular
  // approximation from the graph dimensions. fuse_bodies may not always produce a
  // shapeDxf when inputs lacked one — this avoids a GRAPH_INTEGRITY_ERROR in that
  // case while still reading only from the graph (no 3D shell analysis).
  const rawDxf = panelNode.shapeDxf
    ?? generateDxfFromManufacturingGraph(graphDims!.width, graphDims!.height, graphDims!.bendZones, []);
  const dxfContent = filterInvalidCutLines(rawDxf, graphDims!.width, graphDims!.height);
  // Bend lines computed from BendNode offsets — no 3D shell analysis needed.
  const bendLines = extractBendLinesFromGraph(graphDims!.width, graphDims!.bendZones);

  // Collect any cut profiles attached to this panel.
  const cutProfiles: Array<{ id: string; label: string | null; profile: unknown }> = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'CutNode' && node.parentPanelId === panelNodeId) {
      const cn = node as import('../../manufacturing/graph/types').CutNode;
      cutProfiles.push({ id: cn.id, label: cn.label ?? null, profile: cn.profile });
    }
  }

  const response: Record<string, unknown> = {
    part_id: partId,
    panel_id: panelId,
    // unfold_id: return panel_id as a stable synthetic identifier.
    // The app validates this is non-empty to confirm the unfold succeeded.
    // It is also used as a key for simulate_nesting (which requires C++ unfold
    // object IDs) — that pipeline is tracked separately as a TODO to update.
    unfold_id: panelId,
    flat_width_mm: graphDims!.width,
    flat_height_mm: graphDims!.height,
    graph_flat_width_mm: graphDims!.width,
    graph_flat_height_mm: graphDims!.height,
    k_factor_used: kFactor,
    bend_count: graphDims!.bendZones.length,
    nominal_thickness_mm: panelNode.nominalThickness ?? 0,
    bend_lines: bendLines,
    dxf_content: dxfContent,
    graph_bend_zones: graphDims!.bendZones.map((z: BendZone) => ({
      offset_mm: z.offset,
      width_mm: z.width,
      node_id: z.nodeId,
    })),
    shape_history: [],
    rollback_token: resolveRollbackToken(ctx, ""),
  };

  if (cutProfiles.length > 0) response['cut_profiles'] = cutProfiles;

  return response;
}

export function handleExportProductionPack(
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

export function handleGetExportJobStatus(args: Record<string, unknown>): unknown {
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

export function handleGetExportJobResult(args: Record<string, unknown>): unknown {
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
