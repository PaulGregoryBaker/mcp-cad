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
  cutPanel,
  closeGap,
  addFlange,
  ripEdge,
  generateReliefs,
  splitBodyByPlane,
} from '../graph/evaluate-client';
import { V2DoltStore, type V2DoltStoreOptions } from '../persistence/dolt-store';
import { v2JobQueue } from '../jobs/queue';
import { throwError, ErrorCodes } from '../../mcp/errors';
import {
  requireString,
  requireStringArray,
  requireNumber,
  optNumber,
  optString,
  optBoolean,
  optTransform,
  requirePoint2,
  requirePoint2Array,
  requirePoint2ArrayAllowEmpty,
  requireEdgeRef,
  requireVertexRange,
  optNullableNumber,
  optNullableBoolean,
} from './helpers';
import type { NestingResult } from '../jobs/queue';
import type { NapiManufacturingProfile } from '../../geometry/types';

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
        bottom_is_concave: {
          type: 'boolean',
          description:
            "Overrides the angle_deg-sign-derived mountain/valley pivot-side default (see BendRow.bottomIsConcave's own doc comment) — a caller that already knows the true pivot side (e.g. from reconcilePieces' own measured bend) should pass it explicitly; the sign-derived rule is a default, not an invariant.",
        },
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
        profile: {
          type: 'object',
          description:
            "The org's manufacturing profile — {profile_id?, name?, rules?: {default_bend_radius_mm, min_bend_radius_factor, ...}}, same shape the findings/manufacturability resource's ManufacturingProfile uses. reconcilePieces cannot measure a real bend radius from a flat-panel decomposition (only two flat faces meeting at a fold are ever seen), so every reconciled bend's radius_mm is assumed to equal rules.default_bend_radius_mm from this profile. Defaults to the built-in sheet-metal default profile (default_bend_radius_mm: 0, i.e. a sharp fold) when omitted.",
        },
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
  {
    name: 'cut_panel',
    description:
      "Cut a hole into a part's outline (rebuild/06 Slice 9a, rebuild/15 §4.2). kind=circle: an exact center+radius primitive — never tessellated into a polygon, all the way through to the constructed 3D solid (a true OCCT circular wire). kind=polygon: an exact ring, winding-canonicalized automatically. The hole is validated against every live region panel's own current outline and must fit fully within exactly one (optionally narrowed to region_panel_id); it must not straddle a bend zone. kind=slot and kind=boolean are not supported this slice (see rebuild/06-plan.md's own deferred-scope note).",
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        kind: { type: 'string', enum: ['circle', 'polygon'] },
        circle: {
          type: 'object',
          description: 'Required when kind=circle.',
          properties: {
            center: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y'],
            },
            radius_mm: { type: 'number', exclusiveMinimum: 0 },
          },
          required: ['center', 'radius_mm'],
        },
        polygon_ring: {
          type: 'array',
          description: 'Required when kind=polygon. At least 3 {x,y} points.',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
          minItems: 3,
        },
        region_panel_id: {
          type: 'string',
          description:
            "Optional: narrow the containment search to just one of the part's region panels.",
        },
      },
      required: ['part_id', 'kind'],
    },
  },
  {
    name: 'close_gap',
    description:
      'Close a 3D gap between two free edges on the same part (rebuild/15 §4.2, Phase 5 Slice 9b). Graph-first: measures the 3D gap via evaluatePart, computes the 2D outline delta via C++, then applies move_edge. No OCCT mutations — the solid is reconstructed from the updated graph.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        edge_a: {
          type: 'object',
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'integer', minimum: 0 },
          },
          required: ['region_panel_id', 'edge_index'],
        },
        edge_b: {
          type: 'object',
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'integer', minimum: 0 },
          },
          required: ['region_panel_id', 'edge_index'],
        },
      },
      required: ['part_id', 'edge_a', 'edge_b'],
    },
  },
  {
    name: 'add_flange',
    description:
      'Add a rectangular flange to a free edge of the part (rebuild/15 §4.2, Phase 5 Slice 9b). Graph-first: C++ computes the extended outline, then the mutation is pure graph bookkeeping (replace outline, create bend, create child panel).',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        edge: {
          type: 'object',
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'integer', minimum: 0 },
          },
          required: ['region_panel_id', 'edge_index'],
        },
        length_mm: { type: 'number', exclusiveMinimum: 0, description: 'Flange length in mm' },
        angle_deg: { type: 'number', description: 'Bend angle in degrees' },
        radius_mm: { type: 'number', minimum: 0, description: 'Bend radius in mm' },
      },
      required: ['part_id', 'edge', 'length_mm', 'angle_deg'],
    },
  },
  {
    name: 'rip_edge',
    description:
      'Split material along a free edge, creating a seam gap (rebuild/15 §4.2, Phase 5 Slice 9b). Graph-first: C++ computes the new outline with a gap, then replaceOutline applies it.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        edge: {
          type: 'object',
          properties: {
            region_panel_id: { type: 'string' },
            edge_index: { type: 'integer', minimum: 0 },
          },
          required: ['region_panel_id', 'edge_index'],
        },
        gap_mm: { type: 'number', minimum: 0, description: 'Seam gap width in mm (default: 0.5)' },
      },
      required: ['part_id', 'edge'],
    },
  },
  {
    name: 'generate_reliefs',
    description:
      'Add corner reliefs at bend intersections (rebuild/15 §4.2, Phase 5 Slice 9b). Computes relief polygons via C++, then applies them as polygon cuts via cut_panel.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        bend_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bend IDs whose intersections should receive reliefs',
        },
        relief_type: { type: 'string', enum: ['dogbone', 'circular'] },
        radius_mm: { type: 'number', minimum: 0.5 },
      },
      required: ['part_id', 'bend_ids', 'relief_type', 'radius_mm'],
    },
  },
  {
    name: 'split_body_by_plane',
    description:
      'Split a part by a 3D plane, producing one or more new parts (rebuild/15 §4.2, Phase 5 Slice 9b). Graph-first: projects the plane to per-panel 2D cut lines, clips region polygons, groups fragments by bend connectivity, unions outlines, reassigns bends and holes, and creates new PartRows. The original part is unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
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
      },
      required: ['part_id', 'plane'],
    },
  },
  {
    name: 'commit',
    description:
      'Record the current graph as a named version in Dolt (rebuild/15 §4.6, B5a). Saves the part\'s entire graph snapshot to the Dolt-backed v2_part table and creates a Dolt commit.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['part_id', 'message'],
    },
  },
  {
    name: 'restore',
    description:
      'Reset the working state to a prior Dolt commit (rebuild/15 §4.6, B5b). Checks out the commit, loads the part from Dolt, and replaces the in-memory GraphStore state.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        commit_hash: { type: 'string', description: 'Dolt commit hash to restore to' },
      },
      required: ['part_id', 'commit_hash'],
    },
  },
  {
    name: 'simulate_nesting',
    description:
      'Nest parts\' flat outlines on stock sheets (rebuild/15 §4.5, Phase 5 Slice 11). Async job — returns a job_id immediately; poll with get_job for the result.',
    inputSchema: {
      type: 'object',
      properties: {
        part_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Part IDs to nest',
        },
        sheet_width_mm: { type: 'number', description: 'Sheet width in mm (default: 2440)' },
        sheet_height_mm: { type: 'number', description: 'Sheet height in mm (default: 1220)' },
      },
      required: ['part_ids'],
    },
  },
  {
    name: 'export_production_pack',
    description:
      'Export a production pack: drawings + DXF + BOM + assembly instructions (rebuild/15 §4.5). Async job. NOTE: drawings resource is not yet built — this tool is a stub returning an error until the drawing pipeline exists.',
    inputSchema: {
      type: 'object',
      properties: {
        part_ids: {
          type: 'array',
          items: { type: 'string' },
        },
        format: { type: 'string', enum: ['dxf', 'step', 'pdf'] },
      },
      required: ['part_ids'],
    },
  },
  {
    name: 'get_job',
    description:
      'Poll any async job (import_part, simulate_nesting, export_production_pack) by job_id. Returns {status, progress, result?, error?}.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
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
    case 'cut_panel':
      return handleCutPanel(store, args);
    case 'close_gap':
      return handleCloseGap(store, args);
    case 'add_flange':
      return handleAddFlange(store, args);
    case 'rip_edge':
      return handleRipEdge(store, args);
    case 'generate_reliefs':
      return handleGenerateReliefs(store, args);
    case 'split_body_by_plane':
      return handleSplitBodyByPlane(store, args);
    case 'commit':
      return handleCommit(store, args);
    case 'restore':
      return handleRestore(store, args);
    case 'branch':
      return handleBranch(store, args);
    case 'merge_branch':
      return handleMergeBranch(store, args);
    case 'simulate_nesting':
      return handleSimulateNesting(store, args);
    case 'export_production_pack':
      return handleExportProductionPack(store, args);
    case 'get_job':
      return handleGetJob(args);
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
  const bottomIsConcave = optBoolean(args, 'bottom_is_concave');

  try {
    const { bend, childRegionPanel } = mergePartsWithBend(store, {
      partAId,
      partBId,
      edgeA,
      edgeB,
      angleDeg,
      radiusMm,
      kFactor,
      bottomIsConcave,
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

/** import_part's optional `profile` arg, snake_case on the wire like every
 * other v2 tool param — converts to the camelCase NapiManufacturingProfile
 * shape evaluate-client.ts/the NAPI binding expect. Unknown/omitted fields
 * are simply absent from the result; the C++ side's own ReadProfile only
 * ever reads the fields it knows and defaults the rest. */
function optManufacturingProfile(
  args: Record<string, unknown>,
  key: string,
): NapiManufacturingProfile | undefined {
  const val = args[key];
  if (typeof val !== 'object' || val === null) return undefined;
  const obj = val as Record<string, unknown>;
  const profile: NapiManufacturingProfile = {};
  if (typeof obj['profile_id'] === 'string') profile.profileId = obj['profile_id'];
  if (typeof obj['name'] === 'string') profile.name = obj['name'];
  const rulesVal = obj['rules'];
  if (typeof rulesVal === 'object' && rulesVal !== null) {
    const rules = rulesVal as Record<string, unknown>;
    const out: NonNullable<NapiManufacturingProfile['rules']> = {};
    const copyD = (snakeKey: string, camelKey: keyof NonNullable<NapiManufacturingProfile['rules']>) => {
      const v = rules[snakeKey];
      if (typeof v === 'number' && Number.isFinite(v)) out[camelKey] = v;
    };
    copyD('min_bend_radius_factor', 'minBendRadiusFactor');
    copyD('max_bend_angle_deg', 'maxBendAngleDeg');
    copyD('default_bend_radius_mm', 'defaultBendRadiusMm');
    copyD('min_hole_diameter_factor', 'minHoleDiameterFactor');
    copyD('min_hole_to_bend_clearance_mm', 'minHoleToBendClearanceMm');
    copyD('min_hole_to_edge_clearance_mm', 'minHoleToEdgeClearanceMm');
    copyD('min_hole_to_hole_distance_mm', 'minHoleToHoleDistanceMm');
    copyD('min_flange_width_factor', 'minFlangeWidthFactor');
    profile.rules = out;
  }
  return profile;
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
  component_part_ids: string[];
} {
  const file = requireString(args, 'file');
  const angleThresholdDeg = optNumber(args, 'angle_threshold_deg');
  const maxThicknessMm = optNumber(args, 'max_thickness_mm');
  const defaultThicknessMm = optNumber(args, 'default_thickness_mm');
  const maxRecursionDepth = optNumber(args, 'max_recursion_depth');
  const profile = optManufacturingProfile(args, 'profile');

  try {
    const result = importPart(store, file, {
      angleThresholdDeg,
      maxThicknessMm,
      defaultThicknessMm,
      maxRecursionDepth,
      profile,
    });
    return {
      part_id: result.partId,
      panel_count: result.panelCount,
      protrusion_count: result.protrusionCount,
      bend_count: result.bendCount,
      notes: result.notes,
      protrusion_part_ids: result.protrusionPartIds,
      component_part_ids: result.componentPartIds,
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

function handleCutPanel(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; region_panel_id: string } {
  const partId = requireString(args, 'part_id');
  const kind = requireString(args, 'kind');
  if (kind !== 'circle' && kind !== 'polygon') {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `Unsupported cut_panel kind "${kind}" — Slice 9a supports "circle" and "polygon" only ` +
        `("slot" and "boolean" are deferred, see rebuild/06-plan.md)`,
      false,
    );
  }
  const regionPanelId = optString(args, 'region_panel_id');

  let circle: { center: { x: number; y: number }; radiusMm: number } | undefined;
  if (kind === 'circle') {
    const circleArg = args['circle'];
    if (typeof circleArg !== 'object' || circleArg === null) {
      throwError(ErrorCodes.INTERNAL_ERROR, 'cut_panel(kind=circle) requires a circle spec', false);
    }
    const circleObj = circleArg as Record<string, unknown>;
    circle = {
      center: requirePoint2(circleObj, 'center'),
      radiusMm: requireNumber(circleObj, 'radius_mm'),
    };
  }
  const polygonRing = kind === 'polygon' ? requirePoint2Array(args, 'polygon_ring') : undefined;

  try {
    const { part, regionPanelId: resolvedRegionPanelId } = cutPanel(store, {
      partId,
      kind,
      circle,
      polygonRing,
      regionPanelId,
    });
    return { part_id: part.partId, region_panel_id: resolvedRegionPanelId };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleCloseGap(
  store: GraphStore,
  args: Record<string, unknown>,
): { gap_mm: number } {
  const partId = requireString(args, 'part_id');
  const edgeA = requireEdgeRef(args, 'edge_a');
  const edgeB = requireEdgeRef(args, 'edge_b');

  try {
    const result = closeGap(store, { partId, edgeA, edgeB });
    return { gap_mm: result.gapMm };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleAddFlange(
  store: GraphStore,
  args: Record<string, unknown>,
): { bend_id: string; child_region_panel_id: string } {
  const partId = requireString(args, 'part_id');
  const edge = requireEdgeRef(args, 'edge');
  const lengthMm = requireNumber(args, 'length_mm');
  const angleDeg = requireNumber(args, 'angle_deg');
  const radiusMm = optNumber(args, 'radius_mm');

  try {
    const result = addFlange(store, {
      partId,
      edge,
      lengthMm,
      angleDeg,
      radiusMm,
    });
    return {
      bend_id: result.bend.bendId,
      child_region_panel_id: result.childRegionPanel.regionPanelId,
    };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleRipEdge(
  store: GraphStore,
  args: Record<string, unknown>,
): Record<string, never> {
  const partId = requireString(args, 'part_id');
  const edge = requireEdgeRef(args, 'edge');
  const gapMm = optNumber(args, 'gap_mm') ?? 0.5;

  try {
    ripEdge(store, { partId, edge, gapMm });
    return {};
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleGenerateReliefs(
  store: GraphStore,
  args: Record<string, unknown>,
): Record<string, never> {
  const partId = requireString(args, 'part_id');
  const bendIds = requireStringArray(args, 'bend_ids');
  const reliefType = requireString(args, 'relief_type') as 'dogbone' | 'circular';
  const radiusMm = requireNumber(args, 'radius_mm');

  try {
    generateReliefs(store, { partId, bendIds, reliefType, radiusMm });
    return {};
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

function handleSplitBodyByPlane(
  store: GraphStore,
  args: Record<string, unknown>,
): { new_part_ids: string[] } {
  const partId = requireString(args, 'part_id');
  const plane = args['plane'] as Record<string, unknown>;
  if (!plane || typeof plane !== 'object') {
    throwError(ErrorCodes.INTERNAL_ERROR, 'split_body_by_plane requires a plane object', false);
  }
  const normal = plane['normal'] as Record<string, unknown>;
  const origin = plane['origin'] as Record<string, unknown>;
  if (!normal || !origin) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'plane requires normal and origin', false);
  }
  const nx = Number(normal['x']);
  const ny = Number(normal['y']);
  const nz = Number(normal['z']);
  const ox = Number(origin['x']);
  const oy = Number(origin['y']);
  const oz = Number(origin['z']);
  const offsetD = nx * ox + ny * oy + nz * oz;

  try {
    const result = splitBodyByPlane(store, {
      partId,
      normalX: nx,
      normalY: ny,
      normalZ: nz,
      offsetD,
    });
    return { new_part_ids: result.newPartIds };
  } catch (err) {
    if (err instanceof GraphStoreError) {
      throwError(err.code, err.message, false);
    }
    throw err;
  }
}

// ── Dolt persistence (Slice 10) ─────────────────────────────────────────────

let doltStore: V2DoltStore | null = null;

export function initDoltStore(options: V2DoltStoreOptions): V2DoltStore {
  doltStore = new V2DoltStore(options);
  return doltStore;
}

export async function connectDoltStore(): Promise<void> {
  if (doltStore) await doltStore.connect();
}

export async function disconnectDoltStore(): Promise<void> {
  if (doltStore) await doltStore.disconnect();
}

export function getDoltStore(): V2DoltStore | null {
  return doltStore;
}

async function handleCommit(
  store: GraphStore,
  args: Record<string, unknown>,
): Promise<{ commit_hash: string }> {
  if (!doltStore) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'Dolt persistence is not configured', false);
  }
  const partId = requireString(args, 'part_id');
  const message = requireString(args, 'message');

  if (!store.getPart(partId)) {
    throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${partId}`, false);
  }

  const snapshot = store.snapshotPart(partId);
  await doltStore.savePart(partId, snapshot);
  const hash = await doltStore.doltCommit(message);
  return { commit_hash: hash };
}

async function handleRestore(
  store: GraphStore,
  args: Record<string, unknown>,
): Promise<{ part_id: string }> {
  if (!doltStore) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'Dolt persistence is not configured', false);
  }
  const partId = requireString(args, 'part_id');
  const commitHash = requireString(args, 'commit_hash');

  await doltStore.doltCheckout(commitHash);
  const snapshot = await doltStore.loadPart(partId);
  if (!snapshot) {
    throwError(ErrorCodes.INTERNAL_ERROR, `part ${partId} not found in commit ${commitHash}`, true);
  }

  const newPart = store.createPart({
    name: snapshot.part.name,
    outline: snapshot.part.outline,
    thicknessMm: snapshot.part.thicknessMm,
    materialId: snapshot.part.materialId,
    kFactor: snapshot.part.kFactor,
    anchor: snapshot.part.anchor,
  });

  for (const bend of snapshot.bends) {
    store.createBendNode({
      partId: newPart.partId,
      parentRegionPanelId: bend.parentRegionPanelId,
      hingeA: bend.hingeA,
      hingeB: bend.hingeB,
      angleDeg: bend.angleDeg,
      radiusMm: bend.radiusMm,
      kFactor: bend.kFactorOverride ?? undefined,
      bottomIsConcave: bend.bottomIsConcave ?? undefined,
    });
  }

  return { part_id: newPart.partId };
}

async function handleBranch(
  _store: GraphStore,
  args: Record<string, unknown>,
): Promise<Record<string, never>> {
  if (!doltStore) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'Dolt persistence is not configured', false);
  }
  const name = requireString(args, 'name');
  const fromRef = optString(args, 'from_commit');
  await doltStore.doltBranch(name, fromRef);
  return {};
}

async function handleMergeBranch(
  _store: GraphStore,
  args: Record<string, unknown>,
): Promise<Record<string, never>> {
  if (!doltStore) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'Dolt persistence is not configured', false);
  }
  const branch = requireString(args, 'source_branch');
  await doltStore.doltMerge(branch);
  return {};
}

// ── Produce / async jobs (Slice 11) ──────────────────────────────────────────

async function handleSimulateNesting(
  store: GraphStore,
  args: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const partIds = requireStringArray(args, 'part_ids');
  const sheetW = optNumber(args, 'sheet_width_mm') ?? 2440;
  const sheetH = optNumber(args, 'sheet_height_mm') ?? 1220;

  for (const pid of partIds) {
    if (!store.getPart(pid)) {
      throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${pid}`, false);
    }
  }

  const jobId = v2JobQueue.enqueue(async () => {
    // Collect flat outline bounding boxes for each part
    const rectangles: Array<{ partId: string; width: number; height: number }> = [];
    for (const pid of partIds) {
      const part = store.getPart(pid)!;
      // Compute bounding box of the flat outline
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of part.outline) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      rectangles.push({ partId: pid, width: maxX - minX, height: maxY - minY });
    }

    // Simple shelf-next-fit decreasing algorithm
    rectangles.sort((a, b) => b.height - a.height || b.width - a.width);

    const result: NestingResult = {
      placements: [],
      utilisationPct: 0,
      sheetsRequired: 1,
    };

    let sheetIndex = 0;
    let xCursor = 0;
    let yCursor = 0;
    let rowHeight = 0;
    let totalArea = 0;

    for (const rect of rectangles) {
      totalArea += rect.width * rect.height;

      // If this piece doesn't fit in the current row, start a new row
      if (xCursor + rect.width > sheetW) {
        xCursor = 0;
        yCursor += rowHeight;
        rowHeight = 0;
      }

      // If this piece doesn't fit on the current sheet, start a new sheet
      if (yCursor + rect.height > sheetH) {
        sheetIndex++;
        xCursor = 0;
        yCursor = 0;
        rowHeight = 0;
        result.sheetsRequired = sheetIndex + 1;
      }

      result.placements.push({
        partId: rect.partId,
        sheetIndex,
        x: xCursor,
        y: yCursor,
        rotationDeg: 0,
      });

      xCursor += rect.width;
      if (rect.height > rowHeight) rowHeight = rect.height;
    }

    const sheetArea = sheetW * sheetH;
    result.utilisationPct = totalArea / (sheetArea * result.sheetsRequired) * 100;

    return result;
  });

  return { job_id: jobId };
}

async function handleExportProductionPack(
  store: GraphStore,
  args: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const partIds = requireStringArray(args, 'part_ids');

  for (const pid of partIds) {
    if (!store.getPart(pid)) {
      throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${pid}`, false);
    }
  }

  const jobId = v2JobQueue.enqueue(async () => {
    // Stub: drawings resource is not built yet (Slice 11 MVP)
    throw new Error(
      'export_production_pack requires the drawings resource, which is not yet built. ' +
      'Revisit when the drawing pipeline (rebuild/07-engineering-drawings.md) is implemented.',
    );
  });

  return { job_id: jobId };
}

async function handleGetJob(
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const jobId = requireString(args, 'job_id');
  const job = v2JobQueue.getJob(jobId);
  if (!job) {
    throwError(ErrorCodes.INTERNAL_ERROR, `job not found: ${jobId}`, false);
  }
  return {
    job_id: job.jobId,
    status: job.status,
    progress: job.progress,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
  };
}
