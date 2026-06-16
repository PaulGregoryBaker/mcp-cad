/**
 * MCP handlers for unfold and export operations.
 * Extracted from tools.ts — apply_unfold, export_production_pack,
 * get_export_job_status, get_export_job_result.
 */

import { throwError, ErrorCodes } from '../errors.js';
import { getGeometryBinding, getManufacturingGraph } from '../state.js';
import { session } from '../../geometry/session.js';
import { jobQueue } from '../../geometry/jobs.js';
import {
  requireString,
  resolveTransactionContext,
  buildMeshUrl,
  resolveRollbackToken,
  appendHistoryIfJoined,
} from '../helpers.js';
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
    name: 'apply_unfold',
    description: 'Validates, heals minor gaps (up to 0.1 mm), and flattens a 3D sheet metal shell using analytical K-factor calculations. Produces flat blank dimensions, bend annotations, and a DXF engineering drawing derived from the Manufacturing Graph. Requires active manufacturing graph (part_id). Mutating — requires transaction_id.',
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

export function handleApplyUnfold(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
  // DXF output MUST come from the manufacturing graph, not raw geometry.
  // panel_id defaults to part_id — in every workflow they are identical.
  // Callers should pass part_id as both; the distinction is kept only for
  // backward compatibility.
  const partId = requireString(args, 'part_id');
  const panelId = typeof args['panel_id'] === 'string' && args['panel_id'].length > 0
    ? args['panel_id']
    : partId;
  const materialId = requireString(args, 'material_id');
  requireString(args, 'transaction_id');

  const graph = getManufacturingGraph(partId);

  // Find the canonical panel node in the graph.
  // Match priority:
  //   1. node.id === panelId (stable node ID)
  //   2. node.bodyId === panelId AND canonical !== false (current shell UUID after a transform)
  // No fallbacks. If neither matches, the caller has the wrong ID.
  const panelNodeId = panelId as import('../../manufacturing/graph/types').NodeId;
  let panelNode: import('../../manufacturing/graph/types').PanelNode | undefined;
  for (const node of graph.nodes.values()) {
    if (node.type === 'PanelNode') {
      const pn = node as import('../../manufacturing/graph/types').PanelNode;
      if (pn.id === panelNodeId) {
        panelNode = pn;
        break;
      }
      if (pn.bodyId === (panelId as import('../../manufacturing/graph/types').BodyId) && pn.canonical !== false) {
        panelNode = pn;
        break;
      }
    }
  }

  if (!panelNode) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" not found in part "${partId}" manufacturing graph. ` +
      `panel_id must be a stable node ID from the manufacturing graph, not a volatile shell UUID.`,
      true,
      'query_graph',
    );
  }

  // Reject explicit non-canonical panel IDs to prevent unfolding stale upstream panels
  // in merged containers. UI should always pass preserved_part_id as panel_id.
  if (panelNode.canonical === false) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" is non-canonical in part "${partId}". ` +
      `Use preserved_part_id as panel_id for unfold operations.`,
      true,
      'merge_bodies_with_bend',
    );
  }

  // Use the panel node's body ID for geometry operations
  // panelNode.bodyId may be null before first solve; in that case, we cannot unfold
  if (panelNode.bodyId === null) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" has not been solved yet; bodyId is null. Call solve_geometry first.`,
      true,
      'solve_geometry',
    );
  }

  const shellId = panelNode.bodyId;

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

  const ctx = resolveTransactionContext(args);

  // Validate the panel structure (sheet metal constraints)
  const validation = getGeometryBinding().isPanelValid(shellId);
  if (!validation.isValid || !validation.canFlatten) {
    throwError(
      ErrorCodes.GE_PANEL_INVALID,
      `Panel ${panelId} (shell ${shellId}) is not a valid sheet-metal panel: ` +
      validation.errors.map(e => `[${e.code}] ${e.message}`).join('; '),
      false,
    );
  }

  let result = getGeometryBinding().unfoldShell(shellId, kFactor);
  session.registerUnfold(result.unfoldId);
  if (result.improvedPartId) {
    session.registerShell(result.improvedPartId);
  }

  appendHistoryIfJoined(ctx, result.shape_history);

  // Compute graph-based flat dimensions — these are the preferred source of truth.
  // The manufacturing graph knows the panel dimensions analytically through BendNodes
  // and their bend allowance calculations.
  // Use panelNode.id (the actual graph node ID) not panelNodeId (user-supplied panel_id)
  // because for merged shells the graph node ID differs from the shell UUID.
  let graphDims = graph.getFlatPatternDimensions(panelNode.id);

  // Bootstrap: when graphDims is null the panel node has no pre-computed flat dimensions
  // (e.g. immediately after fuse_bodies, before any prior unfold).  The C++ unfold has
  // already succeeded above, so the geometry IS valid.  Use the C++ result to seed the
  // graph node so downstream callers (flat-pattern export, BOM, etc.) see consistent data.
  if (!graphDims) {
    if (result.flatWidthMm > 0 && result.flatHeightMm > 0) {
      panelNode.flatWidth = result.flatWidthMm;
      panelNode.flatHeight = result.flatHeightMm;
      if ((result.detectedThickness ?? 0) > 0) {
        panelNode.nominalThickness = result.detectedThickness as number;
      }
      panelNode.dirty = false;
      panelNode.shapeDxf = generateDxfFromManufacturingGraph(
        result.flatWidthMm,
        result.flatHeightMm,
        [],
        [],
      );
      // Re-read dims now that the node is hydrated
      graphDims = graph.getFlatPatternDimensions(panelNode.id);
    }
  }

  if (!graphDims) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" cannot provide flat pattern dimensions from the manufacturing graph. ` +
      `The panel may be disconnected from the root or contain dirty nodes. ` +
      `Call solve_geometry first to resolve the manufacturing graph.`,
      true,
      'solve_geometry',
    );
  }

  // Use graph dimensions exclusively (no C++ bbox fallback)
  const finalFlatWidth = graphDims!.width;
  const finalFlatHeight = graphDims!.height;

  // Graph-authored shapeDxf is the source of truth for merged/fused panels and must
  // not be replaced by geometry-export seam edges.
  let dxfContent = '';
  let bendLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const hasGraphShapeDxf = typeof panelNode.shapeDxf === 'string' && panelNode.shapeDxf.trim().length > 0;
  if (hasGraphShapeDxf) {
    // Clean pre-existing graph-authored DXF: remove invalid internal cut lines
    // This ensures the source of truth (DXF) is valid for geometry recalculation
    dxfContent = filterInvalidCutLines(panelNode.shapeDxf!, finalFlatWidth, finalFlatHeight);
  } else {
    try {
      const exported = getGeometryBinding().exportDxf(result.unfoldId);
      dxfContent = exported.dxfContent;
      // VALIDATION: Remove any invalid internal cut lines from geometry export.
      // Geometry export may include seam/corruption artifacts as LINE entities.
      // This is the permanent filter to prevent seam lines from appearing.
      dxfContent = filterInvalidCutLines(dxfContent, finalFlatWidth, finalFlatHeight);
    } catch (exportErr) {
      const exportMsg = exportErr instanceof Error ? exportErr.message : String(exportErr);
      try {
        // Collect CutNodes for the unfolded panel (only those with parentPanelId matching this panel)
        const cutNodesForPanel: import('../../manufacturing/graph/types').CutNode[] = [];
        for (const node of graph.nodes.values()) {
          if (node.type === 'CutNode' && node.parentPanelId === panelNode.id) {
            cutNodesForPanel.push(node as import('../../manufacturing/graph/types').CutNode);
          }
        }

        dxfContent = generateDxfFromManufacturingGraph(
          finalFlatWidth,
          finalFlatHeight,
          graphDims!.bendZones,
          cutNodesForPanel,
        );
        // Note: generateDxfFromManufacturingGraph already applies filterInvalidCutLines internally
      } catch (fallbackErr) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.error(
          `[apply_unfold] DXF export failed for panel "${panelId}": ${exportMsg}. ` +
          `Graph fallback also failed: ${fallbackMsg}. ` +
          `Geometry is valid (${finalFlatWidth}×${finalFlatHeight}mm, ${result.bendCount} bends).`
        );
      }
    }
  }

  // Always populate bend guide lines from graph when bends are present.
  // Merged panel DXFs contain only the outer outline (no embedded bend lines),
  // so bend_lines must be derived from graph bend zones in all cases.
  if (result.bendCount > 0) {
    bendLines = extractBendLinesFromGraph(finalFlatWidth, graphDims!.bendZones);
  }

  // Persist the engineering drawing on the graph node.
  // This is the canonical 2D manufacturing representation for subsequent graph operations.
    // Persist the CLEANED engineering drawing on the graph node.
    // DXF is the canonical 2D manufacturing representation (source of truth).
    // It is used for geometry recalculation, so it must be free of invalid artifacts.
  panelNode.shapeDxf = dxfContent;

  const response: Record<string, unknown> = {
    part_id: partId,
    panel_id: panelId,
    unfold_id: result.unfoldId,
    flat_width_mm: finalFlatWidth,
    flat_height_mm: finalFlatHeight,
    k_factor_used: result.kFactorUsed,
    bend_count: result.bendCount,
    nominal_thickness_mm: result.detectedThickness ?? 0,
    bend_lines: bendLines,
    dxf_content: dxfContent,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    shape_history: result.shape_history ?? [],
  };

  if (graphDims) {
    response['graph_flat_width_mm'] = graphDims.width;
    response['graph_flat_height_mm'] = graphDims.height;
    response['graph_bend_zones'] = graphDims.bendZones.map((z: BendZone) => ({
      offset_mm: z.offset,
      width_mm: z.width,
      node_id: z.nodeId,
    }));
  }

  // Collect CutNode profiles for DXF rendering
  const cutProfiles: Array<{ id: string; label: string | null; profile: unknown }> = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'CutNode' && node.parentPanelId === panelNodeId) {
      cutProfiles.push({
        id: node.id,
        label: (node as import('../../manufacturing/graph/types').CutNode).label ?? null,
        profile: node.profile
      });
    }
  }
  if (cutProfiles.length > 0) {
    response['cut_profiles'] = cutProfiles;
  }

  if (result.improvedPartId) {
    response['improved_part_id'] = result.improvedPartId;
    response['improved_part_mesh_url'] = buildMeshUrl(result.improvedPartId);
  }
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
