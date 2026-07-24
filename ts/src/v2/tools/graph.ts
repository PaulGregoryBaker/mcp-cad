/**
 * v2 graph tools (Phase 5 Slice 1) — create_part, create_node(kind=bend).
 *
 * Pure bookkeeping via GraphStore: neither tool calls the geometry addon at
 * creation time (Layout stays lazy, computed only when a resource or
 * construct call reads it — 14 §2.1's "only region panel geometry is
 * derived"). Name collision with v1's own `create_part` tool is intentional
 * and safe: this module is registered on a separate v2 Server instance with
 * its own tool registry (ts/src/v2/server.ts), never merged with v1's.
 */

import { GraphStore, GraphStoreError } from '../graph/store';
import { mergePartsWithBend, importPart } from '../graph/evaluate-client';
import { throwError, ErrorCodes } from '../../mcp/errors';
import {
  requireString,
  requireNumber,
  optNumber,
  optString,
  optTransform,
  requirePoint2,
  requirePoint2Array,
  requireEdgeRef,
} from './helpers';

export const graphToolDefinitions = [
  {
    name: 'create_part',
    description:
      'Create a new v2 manufacturing-graph part: one flat outline, one thickness, one material. Pure bookkeeping — no geometry is computed until a resource or construct call reads this part.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable part name' },
        outline: {
          type: 'array',
          description: "The part's flat cut outline, CCW winding, at least 3 vertices.",
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          minItems: 3,
        },
        thickness_mm: { type: 'number', exclusiveMinimum: 0 },
        material_id: { type: 'string' },
        k_factor: { type: 'number', minimum: 0, maximum: 1 },
        anchor: {
          type: 'object',
          description:
            'R (embeds the flat frame F into world, row-major 3x3) + t. Defaults to identity.',
          properties: {
            r: { type: 'array', items: { type: 'number' }, minItems: 9, maxItems: 9 },
            t: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          },
          required: ['r', 't'],
        },
      },
      required: ['name', 'outline', 'thickness_mm'],
    },
  },
  {
    name: 'create_node',
    description:
      'Add a node to a v2 manufacturing-graph part. Slice 1 supports kind="bend" only: creates the bend row and its new child region panel atomically (rebuild/14 §2.1.1).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bend'] },
        part_id: { type: 'string' },
        parent_region_panel_id: { type: 'string' },
        hinge_a: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        hinge_b: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        angle_deg: {
          type: 'number',
          description: 'Signed; positive = mountain, negative = valley.',
        },
        radius_mm: { type: 'number', minimum: 0 },
        k_factor: { type: 'number', minimum: 0, maximum: 1 },
        label: { type: 'string' },
      },
      required: ['kind', 'part_id', 'parent_region_panel_id', 'hinge_a', 'hinge_b', 'angle_deg'],
    },
  },
  {
    name: 'merge_bodies_with_bend',
    description:
      "Join two independently-authored parts into one, connected by a new bend at a caller-specified seam (rebuild/14 §2.1.2). Not a distinct primitive: reconciles B's outline into A's frame, re-parents B's rows onto A, then an ordinary create_node(bend, ...) at the seam. B is aliased via merged_into_part_id, never deleted.",
    inputSchema: {
      type: 'object',
      properties: {
        part_a_id: { type: 'string' },
        part_b_id: { type: 'string' },
        edge_a: {
          type: 'object',
          description:
            "The free (non-bend) boundary edge on A's live region panel to use as the seam.",
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'number' },
          },
          required: ['region_panel_id', 'edge_index'],
        },
        edge_b: {
          type: 'object',
          description: "The matching free boundary edge on B's live region panel.",
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'number' },
          },
          required: ['region_panel_id', 'edge_index'],
        },
        angle_deg: {
          type: 'number',
          description: 'Signed; positive = mountain, negative = valley.',
        },
        radius_mm: { type: 'number', minimum: 0 },
        k_factor: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['part_a_id', 'part_b_id', 'edge_a', 'edge_b', 'angle_deg'],
    },
  },
  {
    name: 'import_part',
    description:
      'Ingest a STEP file into a v2 manufacturing graph (rebuild/15 §4.1, Level C): heal, decompose into flat panel pieces (Port A/B), then reconcile them into one outline + bend tree (13 §6) — the same graph shape create_part/create_node build directly. Synchronous this slice (no job/progress polling yet). Protrusions are detected and excluded from the graph, not represented.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a STEP file.' },
        angle_threshold_deg: {
          type: 'number',
          description:
            'Coplanarity threshold for panel-vs-bend face grouping (splitBodyByBends). Default 35; use a much tighter value (e.g. 0.5) for faceted/tessellated STEP exports where many nearly-coplanar triangles must merge without absorbing real fold boundaries.',
        },
        max_thickness_mm: { type: 'number' },
        default_thickness_mm: { type: 'number' },
        max_recursion_depth: { type: 'number' },
      },
      required: ['file'],
    },
  },
];

export function dispatchGraphTool(
  store: GraphStore,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'create_part':
      return handleCreatePart(store, args);
    case 'create_node':
      return handleCreateNode(store, args);
    case 'merge_bodies_with_bend':
      return handleMergeBodiesWithBend(store, args);
    case 'import_part':
      return handleImportPart(store, args);
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown v2 tool: ${name}`, false);
  }
}

function handleCreatePart(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; root_region_panel_id: string } {
  const name = requireString(args, 'name');
  const outline = requirePoint2Array(args, 'outline');
  const thicknessMm = requireNumber(args, 'thickness_mm');
  const materialId = optString(args, 'material_id');
  const kFactor = optNumber(args, 'k_factor');
  const anchor = optTransform(args, 'anchor');

  try {
    const part = store.createPart({ name, outline, thicknessMm, materialId, kFactor, anchor });
    return { part_id: part.partId, root_region_panel_id: part.rootRegionPanelId };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleCreateNode(
  store: GraphStore,
  args: Record<string, unknown>,
): { bend_id: string; child_region_panel_id: string } {
  const kind = requireString(args, 'kind');
  if (kind !== 'bend') {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Unsupported create_node kind "${kind}" — Slice 1 supports "bend" only`,
      false,
    );
  }
  const partId = requireString(args, 'part_id');
  const parentRegionPanelId = requireString(args, 'parent_region_panel_id');
  const hingeA = requirePoint2(args, 'hinge_a');
  const hingeB = requirePoint2(args, 'hinge_b');
  const angleDeg = requireNumber(args, 'angle_deg');
  const radiusMm = optNumber(args, 'radius_mm');
  const kFactor = optNumber(args, 'k_factor');
  const label = optString(args, 'label');

  try {
    const { bend, childRegionPanel } = store.createBendNode({
      partId,
      parentRegionPanelId,
      hingeA,
      hingeB,
      angleDeg,
      radiusMm,
      kFactor,
      label,
    });
    return { bend_id: bend.bendId, child_region_panel_id: childRegionPanel.regionPanelId };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleMergeBodiesWithBend(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; bend_id: string; child_region_panel_id: string } {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const edgeA = requireEdgeRef(args, 'edge_a');
  const edgeB = requireEdgeRef(args, 'edge_b');
  const angleDeg = requireNumber(args, 'angle_deg');
  const radiusMm = optNumber(args, 'radius_mm');
  const kFactor = optNumber(args, 'k_factor');

  try {
    const { bend, childRegionPanel } = mergePartsWithBend(store, {
      partAId,
      partBId,
      edgeA,
      edgeB,
      angleDeg,
      radiusMm,
      kFactor,
    });
    return {
      part_id: partAId,
      bend_id: bend.bendId,
      child_region_panel_id: childRegionPanel.regionPanelId,
    };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleImportPart(
  store: GraphStore,
  args: Record<string, unknown>,
): {
  part_id: string;
  panel_count: number;
  protrusion_count: number;
  bend_count: number;
  notes: string[];
} {
  const file = requireString(args, 'file');
  const angleThresholdDeg = optNumber(args, 'angle_threshold_deg');
  const maxThicknessMm = optNumber(args, 'max_thickness_mm');
  const defaultThicknessMm = optNumber(args, 'default_thickness_mm');
  const maxRecursionDepth = optNumber(args, 'max_recursion_depth');

  try {
    const result = importPart(store, file, {
      angleThresholdDeg,
      maxThicknessMm,
      defaultThicknessMm,
      maxRecursionDepth,
    });
    return {
      part_id: result.partId,
      panel_count: result.panelCount,
      protrusion_count: result.protrusionCount,
      bend_count: result.bendCount,
      notes: result.notes,
    };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}
