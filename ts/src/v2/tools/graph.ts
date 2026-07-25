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
import {
  mergePartsWithBend,
  importPart,
  fuseBodies,
  splitBodyByBendsStandalone,
} from '../graph/evaluate-client';
import { throwError, ErrorCodes } from '../../mcp/errors';
import {
  requireString,
  requireNumber,
  optNumber,
  optString,
  optTransform,
  requirePoint2,
  requirePoint2Array,
  requirePoint2ArrayAllowEmpty,
  requireEdgeRef,
  requireVertexRange,
  optNullableNumber,
  optNullableBoolean,
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
      "Ingest a STEP file into a v2 manufacturing graph (rebuild/15 §4.1, Level C): heal, decompose into flat panel pieces (Port A/B), then reconcile them into one outline + bend tree (13 §6) — the same graph shape create_part/create_node build directly. Synchronous this slice (no job/progress polling yet). Each detected protrusion (flange/tab) becomes its own simple, independent v2 Part — see protrusion_part_ids in the result — rather than being represented within the main part's own outline/bend tree.",
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
  {
    name: 'fuse_bodies',
    description:
      "Absorb a simple flat part B (no bends of its own) into part A by boolean-unioning their outlines (rebuild/06 Slice 6, rebuild/15 §4.2). Coplanar-only first cut: A and B's own anchors must place them in the same plane, touching or overlapping. Unlike merge_bodies_with_bend, no new bend is created and no edge_refs are needed — the two parts are matched by their own 3D anchors, not a caller-specified seam. B is aliased via merged_into_part_id, never deleted.",
    inputSchema: {
      type: 'object',
      properties: {
        part_a_id: { type: 'string' },
        part_b_id: { type: 'string' },
        target_region_panel_id: {
          type: 'string',
          description:
            "Which of A's region panels the fused material belongs to. Defaults to A's root region panel.",
        },
      },
      required: ['part_a_id', 'part_b_id'],
    },
  },
  {
    name: 'update_node',
    description:
      "Update an existing v2 manufacturing-graph entity's fields in place (rebuild/06 Slice 8, rebuild/15 §4.3). kind=part: patch may include name, material_id, k_factor, anchor (a whole-part move — v2's replacement for v1's translate_body). kind=bend: patch may include angle_deg, radius_mm, k_factor_override (number or null to clear), bottom_is_concave (boolean or null to clear). kind=region_panel: patch may include label, k_factor_override (number or null). Only fields present in patch are changed.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['part', 'bend', 'region_panel'] },
        id: { type: 'string', description: 'part_id, bend_id, or region_panel_id, matching kind.' },
        patch: {
          type: 'object',
          description: 'Fields to change — see description for which apply to which kind.',
        },
      },
      required: ['kind', 'id', 'patch'],
    },
  },
  {
    name: 'delete_node',
    description:
      "Delete a v2 manufacturing-graph entity (rebuild/06 Slice 8, rebuild/15 §4.3). This slice supports kind=\"bend\" only: the PANEL-level merge (14 §2.1.1) — the exact inverse of create_node(kind=bend). Deletes the bend row, re-parents any bends that hung directly off its child region panel onto the removed bend's own parent, and aliases the child region panel onto that parent (merged_into_region_panel_id) so existing references keep resolving. No outline change: removing a fold doesn't change the part's one shared cut boundary, only which bend tree divides it.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['bend'] },
        id: { type: 'string', description: 'bend_id to delete.' },
      },
      required: ['kind', 'id'],
    },
  },
  {
    name: 'move_edge',
    description:
      "K2 (rebuild/06 Slice 8, rebuild/15 §4.3, rebuild/14 §2.2): replace vertices [start_index, end_index] (inclusive) of a part's ONE shared outline with new_points — never a per-region-panel copy (14 §0). new_points may be a different length than the replaced range (covers inserting/removing vertices, not just translating existing ones). A pure edit: the result is not pre-validated for self-intersection or winding here — a broken outline surfaces as a typed geometry error the next time the part is evaluated or constructed.",
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        vertex_range: {
          type: 'object',
          properties: {
            start_index: { type: 'number' },
            end_index: { type: 'number' },
          },
          required: ['start_index', 'end_index'],
        },
        new_points: {
          type: 'array',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
      },
      required: ['part_id', 'vertex_range', 'new_points'],
    },
  },
  {
    name: 'split_body_by_bends',
    description:
      "Standalone STEP decomposition (rebuild/06 Slice 8): loads, heals, and splits a STEP file into flat panel/protrusion pieces (the same Port A/B pipeline import_part uses internally) but stops there — no reconciliation, no graph mutation. Takes a file path, not a part_id; useful for inspecting a fixture's raw per-piece decomposition even when its main panels would refuse import_part's own reconcilePieces step (e.g. multi-body or flange-joined STEP files) for reasons unrelated to any individual piece's own measurement.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a STEP file.' },
        angle_threshold_deg: { type: 'number' },
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
    case 'fuse_bodies':
      return handleFuseBodies(store, args);
    case 'update_node':
      return handleUpdateNode(store, args);
    case 'delete_node':
      return handleDeleteNode(store, args);
    case 'move_edge':
      return handleMoveEdge(store, args);
    case 'split_body_by_bends':
      return handleSplitBodyByBends(args);
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

function handleFuseBodies(store: GraphStore, args: Record<string, unknown>): { part_id: string } {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const targetRegionPanelId = optString(args, 'target_region_panel_id');

  try {
    const { part } = fuseBodies(store, { partAId, partBId, targetRegionPanelId });
    return { part_id: part.partId };
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
  protrusion_part_ids: string[];
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
      protrusion_part_ids: result.protrusionPartIds,
    };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleUpdateNode(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string } | { bend_id: string } | { region_panel_id: string } {
  const kind = requireString(args, 'kind');
  const id = requireString(args, 'id');
  const patchRaw = args['patch'];
  const patch: Record<string, unknown> =
    typeof patchRaw === 'object' && patchRaw !== null ? (patchRaw as Record<string, unknown>) : {};

  try {
    switch (kind) {
      case 'part': {
        const part = store.updatePart({
          partId: id,
          name: optString(patch, 'name'),
          materialId: optString(patch, 'material_id'),
          kFactor: optNumber(patch, 'k_factor'),
          anchor: optTransform(patch, 'anchor'),
        });
        return { part_id: part.partId };
      }
      case 'bend': {
        const bend = store.updateBendNode({
          bendId: id,
          angleDeg: optNumber(patch, 'angle_deg'),
          radiusMm: optNumber(patch, 'radius_mm'),
          kFactorOverride: optNullableNumber(patch, 'k_factor_override'),
          bottomIsConcave: optNullableBoolean(patch, 'bottom_is_concave'),
        });
        return { bend_id: bend.bendId };
      }
      case 'region_panel': {
        const panel = store.updateRegionPanel({
          regionPanelId: id,
          label: optString(patch, 'label'),
          kFactorOverride: optNullableNumber(patch, 'k_factor_override'),
        });
        return { region_panel_id: panel.regionPanelId };
      }
      default:
        throwError(
          ErrorCodes.INTERNAL_ERROR,
          `Unsupported update_node kind "${kind}" — expected "part", "bend", or "region_panel"`,
          false,
        );
    }
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleDeleteNode(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; merged_region_panel_id: string; onto_region_panel_id: string } {
  const kind = requireString(args, 'kind');
  if (kind !== 'bend') {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Unsupported delete_node kind "${kind}" — Slice 8 supports "bend" only (the panel-level merge)`,
      false,
    );
  }
  const id = requireString(args, 'id');

  try {
    const result = store.deleteBendNode(id);
    return {
      part_id: result.partId,
      merged_region_panel_id: result.mergedRegionPanelId,
      onto_region_panel_id: result.ontoRegionPanelId,
    };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleMoveEdge(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; outline: Array<{ x: number; y: number }> } {
  const partId = requireString(args, 'part_id');
  const range = requireVertexRange(args, 'vertex_range');
  const newPoints = requirePoint2ArrayAllowEmpty(args, 'new_points');

  try {
    const { part } = store.moveEdge({
      partId,
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      newPoints,
    });
    return { part_id: part.partId, outline: part.outline };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

interface SplitPieceJson {
  shell_id: string;
  origin: { x: number; y: number; z: number };
  u_axis: { x: number; y: number; z: number };
  v_axis: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  ring_local: Array<{ x: number; y: number }>;
  thickness_mm: number;
}

function handleSplitBodyByBends(args: Record<string, unknown>): {
  panel_count: number;
  protrusion_count: number;
  panels: SplitPieceJson[];
  protrusions: SplitPieceJson[];
} {
  const file = requireString(args, 'file');
  const angleThresholdDeg = optNumber(args, 'angle_threshold_deg');
  const maxThicknessMm = optNumber(args, 'max_thickness_mm');
  const defaultThicknessMm = optNumber(args, 'default_thickness_mm');
  const maxRecursionDepth = optNumber(args, 'max_recursion_depth');

  const toJson = (p: {
    shellId: string;
    origin: { x: number; y: number; z: number };
    uAxis: { x: number; y: number; z: number };
    vAxis: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    ringLocal: Array<{ x: number; y: number }>;
    thicknessMm: number;
  }): SplitPieceJson => ({
    shell_id: p.shellId,
    origin: p.origin,
    u_axis: p.uAxis,
    v_axis: p.vAxis,
    normal: p.normal,
    ring_local: p.ringLocal,
    thickness_mm: p.thicknessMm,
  });

  const result = splitBodyByBendsStandalone(file, {
    angleThresholdDeg,
    maxThicknessMm,
    defaultThicknessMm,
    maxRecursionDepth,
  });

  return {
    panel_count: result.panels.length,
    protrusion_count: result.protrusions.length,
    panels: result.panels.map(toJson),
    protrusions: result.protrusions.map(toJson),
  };
}
