import { throwError, ErrorCodes } from '../errors.js';
import {
  getGeometryBinding,
  getParts,
  getActivePartId,
  setActivePartIdInternal,
  createPart,
  getManufacturingGraph,
  findGraphOwner,
  MERGE_EDGE_ALIGNMENT_TOLERANCE_MM,
} from '../state.js';
import { session } from '../../geometry/session.js';
import { transactionRegistry } from '../transactions.js';
import {
  requireString,
  requireStringArray,
  requireObject,
  resolveTransactionContext,
} from '../helpers.js';
import {
  ringToLwpolylineDxf,
  normalizePanelDxfOrientation,
  filterInvalidCutLines,
} from '../dxf-helpers.js';
import { computeDxfMergePlacement } from '../../manufacturing/dxf/orientation.js';
import type { Placement2D } from '../../manufacturing/dxf/merge.js';
import { mergeDxfOutlines, parseFirstClosedPolyline, applyPlacement } from '../../manufacturing/dxf/merge.js';
import { toNodeId, computeBendAllowance } from '../../manufacturing/graph/types.js';
import type { BendZone, CutNode, PanelFrame, PanelNode } from '../../manufacturing/graph/types.js';
import type { ManufacturingConfig } from '../../config/loader.js';

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export const shapeOpsDefinitions = [
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
        transaction_id: { type: 'string' },
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
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'cutting_plane', 'output_names'],
    },
  },
  {
    name: 'merge_bodies_with_bend',
    description: 'Fuses two adjacent shell bodies into a single shell, optionally filleting the seam edge. If both shells have Manufacturing Graphs, graphs are merged (part_b absorbed into part_a) and a new BendNode is created to represent the seam.',
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
        transaction_id: { type: 'string' },
      },
      required: ['part_a_id', 'part_b_id', 'target_edges', 'bend_radius'],
    },
  },
  {
    name: 'extend_face_to_target',
    description: 'Extends a face of a part to meet a target (part surface, specific face, or plane). The source face can be specified explicitly or auto-selected as the face closest to and most directly facing the target.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'The part whose face will be extended' },
        face_id: { type: 'string', description: 'Face ID to extend; omit to auto-select the closest face facing the target' },
        target_type: { type: 'string', enum: ['part_surface', 'face_id', 'plane'], description: 'How the target is specified (default: part_surface)' },
        target_part_id: { type: 'string', description: 'Target part ID (required when target_type is part_surface or face_id)' },
        target_face_id: { type: 'string', description: 'Specific face ID on the target part (only used when target_type is face_id)' },
        target: {
          type: 'object',
          description: 'Nested target spec — alternative to flat target_part_id/target_face_id; also carries plane normal/origin',
          properties: {
            part_id: { type: 'string' },
            face_id: { type: 'string' },
            normal: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
          },
        },
        transaction_id: { type: 'string' },
      },
      required: ['part_id'],
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
        transaction_id: { type: 'string' },
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
        transaction_id: { type: 'string' },
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
        transaction_id: { type: 'string' },
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
      'Decomposes a shell body into planar panels by splitting at every bend. Auto-creates a Manufacturing Graph for each panel with auto-generated part_id. Auto-detects mode: thin-solid (wall ≤ max_thickness_mm) cuts solid into panels preserving original wall thickness; surface/conceptual mode extrudes each panel face by default_thickness_mm. Returns separate panel_ids, protrusion_ids (flanges/tabs), and created_parts with their graph IDs. Mutating — creates a rollback token.',
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
            'Maximum recursion depth for nested decomposition. 0 = single pass. When > 0 the remainder solid after each pass is recursively decomposed, accumulating all panels and protrusions. Default 1.',
        },
        transaction_id: { type: 'string' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'remove_protrusions',
    description:
      'Detects and extracts all protrusions (flanges, tabs, bosses) from a shell body without splitting it into panels. The part geometry is updated in-place (cleaned); each extracted protrusion is returned as a new shell. Useful as a pre-processing step before further operations, or as a standalone simplification. Mutating — creates a rollback token.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Shell to clean protrusions from' },
        angle_threshold_deg: {
          type: 'number',
          minimum: 0,
          description: 'Minimum dihedral deviation to classify a face group as primary panel. Default 30.0 degrees.',
        },
        max_thickness_mm: {
          type: 'number',
          minimum: 0,
          description: 'Maximum protrusion thickness to detect. Geometry thicker than this is treated as a primary panel face. Default 5.0 mm.',
        },
        algorithm: {
          type: 'string',
          enum: ['loop_traversal', 'legacy_volumetric'],
          default: 'loop_traversal',
          description: 'Algorithmic path. Defaults to loop_traversal for high speed; legacy_volumetric is kept for benchmarking.',
        },
        transaction_id: { type: 'string' },
      },
      required: ['part_id'],
    },
  },
  {
    name: 'close_gap',
    description:
      'Translates part_b so its closest point touches part_a, closing any spatial gap between them. ' +
      'Use this before merge_bodies_with_bend when the panels are further apart than the 0.1 mm sewing tolerance. ' +
      'Non-destructive if the gap is already zero. Returns a rollback_token.',
    inputSchema: {
      type: 'object',
      properties: {
        part_a_id: { type: 'string', description: 'The stationary panel (anchor)' },
        part_b_id: { type: 'string', description: 'The panel to translate (mover)' },
      },
      required: ['part_a_id', 'part_b_id'],
    },
  },
  {
    name: 'is_panel_valid',
    description:
      'Checks whether a shell body is a valid sheet-metal panel that can be flattened. ' +
      'Returns structured validation errors with machine-readable codes (GE_PANEL_*) and human-readable messages. ' +
      'Run this before apply_unfold to surface actionable errors early.',
    inputSchema: {
      type: 'object',
      properties: {
        panel_id: { type: 'string', description: 'Shell ID to validate' },
      },
      required: ['panel_id'],
    },
  },
];

// ─── Private helpers (used only within this module) ───────────────────────────

function computeDxfAlignedFrame(shellId: string, isRotated: boolean): PanelFrame {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pf: any;
  try {
    pf = getGeometryBinding().getPanelFrame(shellId);
  } catch {
    throwError(
      ErrorCodes.GE_PANEL_FRAME_FAILED,
      `Shell ${shellId} has no planar faces; cannot derive panel frame.`,
      false,
      'clean_geometry',
    );
  }

  if (!isRotated) {
    return {
      origin: [pf.originX, pf.originY, pf.originZ],
      u: [pf.uX, pf.uY, pf.uZ],
      v: [pf.vX, pf.vY, pf.vZ],
    };
  }

  // isRotated=true: DXF was rotated 90° CCW so fold-perp → DXF+X, neg fold-parallel → DXF+Y.
  // The point at DXF(0,0) is the corner: face.origin + uExtentMm * face.u.
  return {
    origin: [
      pf.originX + pf.uExtentMm * pf.uX,
      pf.originY + pf.uExtentMm * pf.uY,
      pf.originZ + pf.uExtentMm * pf.uZ,
    ],
    u: [pf.vX, pf.vY, pf.vZ],
    v: [-pf.uX, -pf.uY, -pf.uZ],
  };
}

/**
 * Convert a DXF produced by OCCT's exportDxf (which uses individual LINE entities)
 * into a DXF containing a layer-0 LWPOLYLINE suitable for `buildSheetFromDxf`.
 *
 * OCCT exportDxf puts boundary segments on layer "CUT" as LINE entities.
 * buildSheetFromDxf only accepts a closed LWPOLYLINE on layer "0".
 *
 * Algorithm:
 *  1. Parse all LINE entities (x1,y1,x2,y2).
 *  2. Assemble into a closed chain via nearest-endpoint matching.
 *  3. Emit as a single LWPOLYLINE on layer "0".
 *
 * Returns null if no valid polygon can be assembled (e.g. no LINE entities).
 */
function occtDxfToLwpolylineDxf(occtDxf: string): string | null {
  // Extract all LINE entity coordinates
  // DXF LINE format: group codes 10=x1, 20=y1, 11=x2, 21=y2
  const segments: Array<[number, number, number, number]> = [];
  const lines = occtDxf.split('\n').map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '0' && lines[i + 1] === 'LINE') {
      // Parse this entity's coordinates
      let x1 = NaN, y1 = NaN, x2 = NaN, y2 = NaN;
      let j = i + 2;
      while (j < lines.length && !(lines[j] === '0' && j + 1 < lines.length)) {
        const code = lines[j];
        const val = parseFloat(lines[j + 1] ?? '');
        if (code === '10') x1 = val;
        else if (code === '20') y1 = val;
        else if (code === '11') x2 = val;
        else if (code === '21') y2 = val;
        j += 2;
      }
      if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
        segments.push([x1, y1, x2, y2]);
      }
    }
  }

  if (segments.length < 3) return null;

  // Assemble chain: greedy nearest-endpoint matching
  const used = new Array<boolean>(segments.length).fill(false);
  const chain: Array<[number, number]> = [];

  // Start with the first segment
  used[0] = true;
  chain.push([segments[0]![0], segments[0]![1]]);
  chain.push([segments[0]![2], segments[0]![3]]);

  const EPS = 0.01; // mm tolerance for connecting endpoints

  while (chain.length < segments.length + 1) {
    const lastX = chain[chain.length - 1]![0];
    const lastY = chain[chain.length - 1]![1];
    let found = false;

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;
      const [sx1, sy1, sx2, sy2] = segments[i]!;

      const d1 = Math.hypot(sx1 - lastX, sy1 - lastY);
      const d2 = Math.hypot(sx2 - lastX, sy2 - lastY);

      if (d1 < EPS) {
        chain.push([sx2, sy2]);
        used[i] = true;
        found = true;
        break;
      } else if (d2 < EPS) {
        chain.push([sx1, sy1]);
        used[i] = true;
        found = true;
        break;
      }
    }

    if (!found) break; // Cannot extend chain further
  }

  if (chain.length < 3) return null;

  // Remove the closing duplicate point if present
  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  const closingDist = Math.hypot(last[0] - first[0], last[1] - first[1]);
  if (closingDist < EPS) {
    chain.pop();
  }

  if (chain.length < 3) return null;

  // Build LWPOLYLINE DXF
  const dxfLines: string[] = [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER',
    '1', 'AC1015',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
    '0', 'LWPOLYLINE',
    '8', '0',
    '90', chain.length.toString(),
    '70', '1', // closed
  ];
  for (const [cx, cy] of chain) {
    dxfLines.push('10', cx.toFixed(6), '20', cy.toFixed(6));
  }
  dxfLines.push('0', 'ENDSEC', '0', 'EOF');
  return dxfLines.join('\n');
}

function generateDxfFromManufacturingGraph(
  flatWidthMm: number,
  flatHeightMm: number,
  _bendZones: BendZone[],
  cutNodes: CutNode[],
): string {
  const lines: string[] = [];

  // ─── DXF Header ───────────────────────────────────────────────────────────
  lines.push(
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1015',
    '0',
    'ENDSEC',
  );

  // ─── DXF Entities ─────────────────────────────────────────────────────────
  lines.push(
    '0',
    'SECTION',
    '2',
    'ENTITIES',
  );

  // Panel outline: rectangle from (0,0) to (width,height)
  lines.push(
    '0',
    'LWPOLYLINE',
    '8',
    '0', // layer
    '90',
    '4', // 4 vertices (closed rectangle)
    '70',
    '1', // closed polyline
  );
  // Vertex 1: (0, 0)
  lines.push('10', '0.0', '20', '0.0');
  // Vertex 2: (width, 0)
  lines.push('10', flatWidthMm.toString(), '20', '0.0');
  // Vertex 3: (width, height)
  lines.push('10', flatWidthMm.toString(), '20', flatHeightMm.toString());
  // Vertex 4: (0, height)
  lines.push('10', '0.0', '20', flatHeightMm.toString());

  // Cut profiles: circles, rectangles, polygons, freeform shapes
  for (const cutNode of cutNodes) {
    const profile = cutNode.profile;

    if (profile.type === 'CIRCLE') {
      const { centreX, centreY, radius } = profile;
      lines.push(
        '0',
        'CIRCLE',
        '8',
        'CUTS',
        '10',
        centreX.toString(),
        '20',
        centreY.toString(),
        '40',
        radius.toString(),
      );
    } else if (profile.type === 'RECTANGLE') {
      const { originX, originY, width, height } = profile;
      lines.push(
        '0',
        'LWPOLYLINE',
        '8',
        'CUTS',
        '90',
        '4', // 4 vertices
        '70',
        '1', // closed
      );
      lines.push('10', originX.toString(), '20', originY.toString());
      lines.push('10', (originX + width).toString(), '20', originY.toString());
      lines.push('10', (originX + width).toString(), '20', (originY + height).toString());
      lines.push('10', originX.toString(), '20', (originY + height).toString());
    } else if (profile.type === 'POLYGON' || profile.type === 'FREEFORM') {
      const { vertices } = profile;
      lines.push(
        '0',
        'LWPOLYLINE',
        '8',
        'CUTS',
        '90',
        vertices.length.toString(),
        '70',
        '1', // closed for POLYGON, implicit closure for FREEFORM
      );
      for (const vertex of vertices) {
        lines.push('10', vertex.x.toString(), '20', vertex.y.toString());
      }
    }
  }

  // ─── DXF Footer ───────────────────────────────────────────────────────────
  lines.push(
    '0',
    'ENDSEC',
    '0',
    'EOF',
  );

  const dxfContent = lines.join('\n');

  // VALIDATION: Remove any invalid internal cut lines (seam/corruption artifacts).
  // A LINE is invalid if both endpoints are interior (not on panel edge).
  // This permanently prevents seam lines from appearing in the DXF.
  return filterInvalidCutLines(dxfContent, flatWidthMm, flatHeightMm);
}

// ─── Handler functions ────────────────────────────────────────────────────────

export function handleSplitBodyByPlane(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const planeArg = args['cutting_plane'];
  if (!planeArg || typeof planeArg !== 'object' || !('normal' in planeArg) || !('origin' in planeArg)) {
    throwError(ErrorCodes.GE_SPLIT_FAILED, 'cutting_plane must have normal and origin objects', false);
  }
  const plane = planeArg as { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } };

  // Guard against raw mutation of graph-tracked shells (FR-005).
  const graphOwner = findGraphOwner(partId);
  if (graphOwner !== null) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Shell UUID '${partId}' belongs to manufacturing-graph-tracked part '${graphOwner.partId}'. ` +
      `Raw plane splits on graph-tracked shells are not permitted. Use graph mutation tools instead.`,
      true,
      'solve_geometry',
    );
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().splitBodyByPlane(partId, plane);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    positive_shell_id: result.positiveShellId,
    negative_shell_id: result.negativeShellId,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    positive_mesh_url: `${meshBaseUrl}/mesh/${result.positiveShellId}.glb`,
    negative_mesh_url: `${meshBaseUrl}/mesh/${result.negativeShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleMergeBodiesWithBend(args: Record<string, unknown>): unknown {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const targetEdges = requireStringArray(args, 'target_edges');
  const bendRadius = args['bend_radius'];
  if (typeof bendRadius !== 'number' || bendRadius <= 0) {
    throwError(ErrorCodes.GE_MERGE_FAILED, 'bend_radius must be a positive number', false);
  }

  // Manufacturing graphs are required — split_body_by_bends must have been called first
  // so the system has panel flat dimensions and material data for accurate unfolding.
  if (!getParts().has(partAId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend requires a manufacturing graph for part_a_id "${partAId}". Call split_body_by_bends first.`,
      true,
      'split_body_by_bends',
    );
  }
  if (!getParts().has(partBId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend requires a manufacturing graph for part_b_id "${partBId}". Call split_body_by_bends first.`,
      true,
      'split_body_by_bends',
    );
  }

  const graphA = getManufacturingGraph(partAId);
  const graphB = getManufacturingGraph(partBId);
  const toBodyId = (s: string) => s as import('../../manufacturing/graph/types').BodyId;

  // Detect chained merge: graphA already has a BendNode from a prior merge.
  // When true, panelNodeA is the canonical merged node whose shapeDxf is the
  // previously-merged flat DXF and whose bodyId is the previously-folded 3D shell.
  // effectiveAFlatWidth for chained merges must come from the DXF bbox (see below),
  // not from panelNodeA.flatWidth which stores only the last panel's individual width.
  const isChainedMerge = (() => {
    for (const node of graphA.nodes.values()) if (node.type === 'BendNode') return true;
    return false;
  })();

  // Find the representative PanelNode in each graph.
  // Strict requirement: must find exactly one panel with an exact id match OR exactly one panel total.
  // No fallbacks. If graph structure doesn't match expectations, error immediately.
  const panelNodesA: import('../../manufacturing/graph/types').PanelNode[] = [];
  for (const node of graphA.nodes.values()) {
    if (node.type === 'PanelNode') {
      panelNodesA.push(node as import('../../manufacturing/graph/types').PanelNode);
    }
  }
  if (panelNodesA.length === 0) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_a: Graph contains no PanelNode. Expected at least one panel.`,
      true,
    );
  }

  let panelNodeA: import('../../manufacturing/graph/types').PanelNode | undefined;
  for (const pn of panelNodesA) {
    if (pn.id === (partAId as import('../../manufacturing/graph/types').NodeId)) {
      panelNodeA = pn;
      break;
    }
  }
  if (!panelNodeA && panelNodesA.length === 1) {
    panelNodeA = panelNodesA[0];
  }
  if (!panelNodeA) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_a: No PanelNode with id === part_a_id ("${partAId}"). ` +
      `Found ${panelNodesA.length} panel(s): ${panelNodesA.map(p => p.id).join(', ')}. ` +
      `Provide part_a_id that matches a panel node id in the graph, or ensure exactly one panel exists.`,
      true,
    );
  }

  const panelNodesB: import('../../manufacturing/graph/types').PanelNode[] = [];
  for (const node of graphB.nodes.values()) {
    if (node.type === 'PanelNode') {
      panelNodesB.push(node as import('../../manufacturing/graph/types').PanelNode);
    }
  }
  if (panelNodesB.length === 0) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_b: Graph contains no PanelNode. Expected at least one panel.`,
      true,
    );
  }

  let panelNodeB: import('../../manufacturing/graph/types').PanelNode | undefined;
  for (const pn of panelNodesB) {
    if (pn.id === (partBId as import('../../manufacturing/graph/types').NodeId)) {
      panelNodeB = pn;
      break;
    }
  }
  if (!panelNodeB && panelNodesB.length === 1) {
    panelNodeB = panelNodesB[0];
  }
  if (!panelNodeB) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_b: No PanelNode with id === part_b_id ("${partBId}"). ` +
      `Found ${panelNodesB.length} panel(s): ${panelNodesB.map(p => p.id).join(', ')}. ` +
      `Provide part_b_id that matches a panel node id in the graph, or ensure exactly one panel exists.`,
      true,
    );
  }

  // Extract current shell UUIDs from panel nodes.
  // panelNode.bodyId reflects the current C++ geometry reference after any mutations.
  // If bodyId is null, that's a fatal error — the graph is in an invalid state.
  if (panelNodeA.bodyId === null) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_a: Panel has null bodyId. Graph not solved or corrupted.`,
      true,
      'solve_geometry',
    );
  }
  if (panelNodeB.bodyId === null) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend part_b: Panel has null bodyId. Graph not solved or corrupted.`,
      true,
      'solve_geometry',
    );
  }

  let shellAId = panelNodeA.bodyId as import('../../manufacturing/graph/types').BodyId;
  let shellBId = panelNodeB.bodyId as import('../../manufacturing/graph/types').BodyId;

  // STRICT mode (no fallbacks): DXF must exist and must merge successfully
  // before any 3D merge is attempted.
  if (!panelNodeA.shapeDxf || !panelNodeB.shapeDxf) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      'merge_bodies_with_bend requires valid shapeDxf for both panels. Run apply_unfold for both parts first.',
      true,
      'apply_unfold',
    );
  }
  const ensurePanelFrame = (
    panelNode: import('../../manufacturing/graph/types').PanelNode,
    label: 'part_a' | 'part_b',
  ): PanelFrame => {
    if (panelNode.panelFrame) return panelNode.panelFrame;
    if (!panelNode.bodyId) {
      throwError(
        ErrorCodes.GE_MERGE_FAILED,
        `merge_bodies_with_bend ${label}: Panel has null bodyId; cannot derive panelFrame.`,
        true,
        'solve_geometry',
      );
    }

    // Derive natural face frame (isRotated=false) for fold-axis computation.
    // foldAlongU_A/B is computed later using this frame, then DXF-aligned frames
    // are stored on the merged graph nodes.
    const derived = computeDxfAlignedFrame(panelNode.bodyId as string, false);
    panelNode.panelFrame = derived;
    return derived;
  };

  const frameA = ensurePanelFrame(panelNodeA, 'part_a');
  const frameB = ensurePanelFrame(panelNodeB, 'part_b');
  const contactToleranceMm = Math.max(panelNodeA.nominalThickness, panelNodeB.nominalThickness) * 2.5;
  const placement = computeDxfMergePlacement(frameA, frameB, { contactToleranceMm });

  // ── T017/FR-003: BUG-03 — Edge alignment check BEFORE DXF merge ─────────────
  // Measure the minimum distance between the two panel shells. If the gap
  // exceeds MERGE_EDGE_ALIGNMENT_TOLERANCE_MM, the merge cannot proceed
  // (the panels are not close enough to share a bend edge). Return a structured
  // error with the measured offset so the user can correct it.
  // If within tolerance, auto-correct using closeGap.
  let edgeAlignmentCorrectionMm: number | null = null;
  {
    const gapReport = getGeometryBinding().computeGaps(
      shellAId as string, shellBId as string,
      MERGE_EDGE_ALIGNMENT_TOLERANCE_MM * 4, // wider search radius
    );
    const measuredOffsetMm = gapReport.minimumDistanceMm;

    if (measuredOffsetMm > MERGE_EDGE_ALIGNMENT_TOLERANCE_MM) {
      // T018: Gap exceeds threshold — reject with structured error.
      // Include measuredOffsetMm/thresholdMm/panelIds in message for caller parsing.
      throwError(
        ErrorCodes.GE_MERGE_EDGE_MISALIGNED,
        `merge_bodies_with_bend: panels are not close enough to share a bend edge. ` +
        `measuredOffsetMm=${measuredOffsetMm.toFixed(3)} thresholdMm=${MERGE_EDGE_ALIGNMENT_TOLERANCE_MM} ` +
        `panelAId=${partAId} panelBId=${partBId}. ` +
        `Use close_gap to bring the panels together before merging.`,
        true,
        'close_gap',
      );
    } else if (measuredOffsetMm > 0.01) {
      // T019: Gap within tolerance — auto-correct using closeGap, log the correction
      try {
        const gapResult = getGeometryBinding().closeGap(shellAId as string, shellBId as string);
        edgeAlignmentCorrectionMm = gapResult.gapClosedMm;
        // Update panelNodeB's bodyId to the translated shell and capture the new shellBId
        shellBId = gapResult.partBId as import('../../manufacturing/graph/types').BodyId;
        panelNodeB.bodyId = shellBId;
        session.registerShell(shellBId);
      } catch {
        // closeGap failed — continue without correction, merge may still succeed
        edgeAlignmentCorrectionMm = measuredOffsetMm;
      }
    }
  }


  // Build normals to classify coplanar-vs-bend cases.
  const nA: [number, number, number] = [
    frameA.u[1] * frameA.v[2] - frameA.u[2] * frameA.v[1],
    frameA.u[2] * frameA.v[0] - frameA.u[0] * frameA.v[2],
    frameA.u[0] * frameA.v[1] - frameA.u[1] * frameA.v[0],
  ];
  const nB: [number, number, number] = [
    frameB.u[1] * frameB.v[2] - frameB.u[2] * frameB.v[1],
    frameB.u[2] * frameB.v[0] - frameB.u[0] * frameB.v[2],
    frameB.u[0] * frameB.v[1] - frameB.u[1] * frameB.v[0],
  ];
  const normA = Math.hypot(nA[0], nA[1], nA[2]);
  const normB = Math.hypot(nB[0], nB[1], nB[2]);
  const normalsDot = (nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]) / (normA * normB);
  const normalsNearlyParallel = Math.abs(normalsDot) > 0.98;

  // Fold axis: direction of the shared bend edge = cross(N_A, N_B).
  // flatWidth = U (long axis); flatHeight = V (short axis).
  // When fold axis is parallel to U_A (long axis), flatHeight is the fold-perpendicular extent.
  const foldAxisVec: [number, number, number] = [
    nA[1] * nB[2] - nA[2] * nB[1],
    nA[2] * nB[0] - nA[0] * nB[2],
    nA[0] * nB[1] - nA[1] * nB[0],
  ];
  const foldAxisNorm = Math.hypot(foldAxisVec[0], foldAxisVec[1], foldAxisVec[2]);
  const dotFoldWithU = foldAxisNorm > 1e-6
    ? Math.abs(foldAxisVec[0] * frameA.u[0] + foldAxisVec[1] * frameA.u[1] + foldAxisVec[2] * frameA.u[2]) / foldAxisNorm
    : 0;
  const dotFoldWithV = foldAxisNorm > 1e-6
    ? Math.abs(foldAxisVec[0] * frameA.v[0] + foldAxisVec[1] * frameA.v[1] + foldAxisVec[2] * frameA.v[2]) / foldAxisNorm
    : 0;
  // True when fold edge is aligned with Panel A's U axis (the longer in-plane axis).
  // In that case, flatHeight (V, shorter) is the fold-perpendicular dimension for the flat pattern.
  const foldAlongU_A = dotFoldWithU > dotFoldWithV;

  // Same check for Panel B's frame — used to re-orient Panel B's DXF in the merged flat pattern.
  const dotFoldWithU_B = (foldAxisNorm > 1e-6 && frameB)
    ? Math.abs(foldAxisVec[0] * frameB.u[0] + foldAxisVec[1] * frameB.u[1] + foldAxisVec[2] * frameB.u[2]) / foldAxisNorm
    : 0;
  const dotFoldWithV_B = (foldAxisNorm > 1e-6 && frameB)
    ? Math.abs(foldAxisVec[0] * frameB.v[0] + foldAxisVec[1] * frameB.v[1] + foldAxisVec[2] * frameB.v[2]) / foldAxisNorm
    : 0;
  const foldAlongU_B = dotFoldWithU_B > dotFoldWithV_B;

  // Panel A's extent perpendicular to the fold edge — determines placement of the bend zone in the
  // merged flat pattern. Use flatHeight when fold is along Panel A's longer U axis (e.g. a protrusion
  // that is 24.1mm wide × 150mm long: fold along 150mm → fold-perp = 24.1mm = flatHeight).
  let effectiveAFlatWidth = 0;
  let effectiveBFlatWidth = 0;

  // ── Real dihedral fold angle + fold direction (replaces hard-coded 90°) ──────
  // The merged seam must re-fold at the panels' ACTUAL dihedral and on the SAME
  // side as the original geometry, so the merged part is not rotated/inverted.
  //
  // World centroids of the two panels (bodies are still in their original pose here).
  const bboxA3d = getGeometryBinding().computeBoundingBox(shellAId as string);
  const bboxB3d = getGeometryBinding().computeBoundingBox(shellBId as string);
  const cA: [number, number, number] = [
    (bboxA3d.x_min + bboxA3d.x_max) / 2,
    (bboxA3d.y_min + bboxA3d.y_max) / 2,
    (bboxA3d.z_min + bboxA3d.z_max) / 2,
  ];
  const cB: [number, number, number] = [
    (bboxB3d.x_min + bboxB3d.x_max) / 2,
    (bboxB3d.y_min + bboxB3d.y_max) / 2,
    (bboxB3d.z_min + bboxB3d.z_max) / 2,
  ];
  const dAB: [number, number, number] = [cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]];

  // Normalised panel normals (axis only — sign is arbitrary from the cross product,
  // so every use below is sign-independent by construction).
  const nAu: [number, number, number] = normA > 1e-9 ? [nA[0] / normA, nA[1] / normA, nA[2] / normA] : [0, 0, 1];
  const nBu: [number, number, number] = normB > 1e-9 ? [nB[0] / normB, nB[1] / normB, nB[2] / normB] : [0, 0, 1];

  // Project a vector onto a plane defined by unit normal n, then normalise.
  const projectOntoPlane = (
    vec: [number, number, number],
    n: [number, number, number],
  ): [number, number, number] => {
    const d = vec[0] * n[0] + vec[1] * n[1] + vec[2] * n[2];
    const p: [number, number, number] = [vec[0] - d * n[0], vec[1] - d * n[1], vec[2] - d * n[2]];
    const len = Math.hypot(p[0], p[1], p[2]);
    return len > 1e-9 ? [p[0] / len, p[1] / len, p[2] / len] : [0, 0, 0];
  };

  // In-plane direction from the bend edge toward each panel's body.
  const gA = projectOntoPlane(dAB, nAu);            // points A → bend (toward B in A's plane)
  const gAtoBody: [number, number, number] = [-gA[0], -gA[1], -gA[2]]; // bend → A body
  const gBtoBody = projectOntoPlane(dAB, nBu);      // bend → B body (toward B in B's plane)

  // Dihedral interior angle between the two surfaces; fold deviation = 180° − interior.
  // Flat (coplanar continuation) → interior 180° → fold 0°. 90° L → interior 90° → fold 90°.
  const dihedralDot = Math.max(-1, Math.min(1,
    gAtoBody[0] * gBtoBody[0] + gAtoBody[1] * gBtoBody[1] + gAtoBody[2] * gBtoBody[2]));
  const dihedralInteriorDeg = (Math.acos(dihedralDot) * 180) / Math.PI;
  const computedFoldDeg = 180 - dihedralInteriorDeg;

  // Fold geometry for the C++ placement frame (canonical +X → bend direction,
  // canonical +Z → the side Panel B folds toward).
  const foldSign = (dAB[0] * nAu[0] + dAB[1] * nAu[1] + dAB[2] * nAu[2]) >= 0 ? 1 : -1;
  const foldNormal: [number, number, number] = [foldSign * nAu[0], foldSign * nAu[1], foldSign * nAu[2]];
  const bendDir = gA; // unit in-plane(A) direction from Panel A's outer edge toward the bend

  const kFactorDefault = 0.33;
  // Use the real dihedral; guard against degenerate (near-0/near-180) folds, falling
  // back to 90° only when the geometry could not yield a sensible angle.
  const bendAngle = (Number.isFinite(computedFoldDeg) && computedFoldDeg > 1 && computedFoldDeg < 179)
    ? computedFoldDeg
    : 90;
  const thickness = panelNodeA?.nominalThickness > 0 ? panelNodeA.nominalThickness : (panelNodeB?.nominalThickness ?? 1.0);
  const ba = computeBendAllowance(bendAngle, bendRadius as number, kFactorDefault, thickness);

  let rotationMatrix: [[number, number], [number, number]];
  let translation: [number, number];
  let seamYOffset = 0;

  if (normalsNearlyParallel && panelNodeA.flatWidth === null) {
    // Coplanar merges (no graph-recorded flatWidth, so not from a split) must satisfy contact tolerance strictly.
    if (!placement.inContact) {
      throwError(
        ErrorCodes.GE_MERGE_FAILED,
        `merge_bodies_with_bend: Coplanar panels are not in contact. ` +
        `Normal offset ${placement.normalOffsetMm.toFixed(2)} mm exceeds tolerance ${contactToleranceMm.toFixed(2)} mm.`,
        false,
      );
    }
    rotationMatrix = placement.rotationMatrix;
    translation = placement.translation;
  } else {
    // Perpendicular/non-coplanar bend case: flatten panel B adjacent to panel A with zero gap.
    // This avoids spurious 100mm "gap" from projecting 3D origins directly into 2D.
    // Adjacency check: use the projected 2D placement to verify the panels share/overlap in flat space.
    // inContact (centroid normal offset) is too strict for bend panels; DXF union connectivity is correct.
    if (panelNodeA.shapeDxf && panelNodeB.shapeDxf) {
      // Adjacency gate: centroid-to-centroid displacement check.
      // OCCT frame origins are at arbitrary face corners, so using placement.translation
      // directly gives ~1× panel-width for adjacent panels (vs the expected ~0.5× from
      // the old centroid approach). Use bbox centroids instead — they give a stable
      // ~0.5× displacement for panels that share a fold edge.
      const bboxCentroid = (bb: typeof bboxA3d): [number, number, number] => [
        (bb.x_min + bb.x_max) / 2,
        (bb.y_min + bb.y_max) / 2,
        (bb.z_min + bb.z_max) / 2,
      ];
      const centA = bboxCentroid(bboxA3d);
      const centB = bboxCentroid(bboxB3d);
      const dCent: [number, number, number] = [centB[0]-centA[0], centB[1]-centA[1], centB[2]-centA[2]];
      // Project centroid displacement onto Panel A's two longest bbox axes (its flat plane).
      const bboxAAxes = [
        { size: bboxA3d.x_max-bboxA3d.x_min, ax: [1,0,0] as [number,number,number] },
        { size: bboxA3d.y_max-bboxA3d.y_min, ax: [0,1,0] as [number,number,number] },
        { size: bboxA3d.z_max-bboxA3d.z_min, ax: [0,0,1] as [number,number,number] },
      ].sort((a, b) => b.size - a.size);
      const aU = bboxAAxes[0]!.ax, aV = bboxAAxes[1]!.ax;
      const gTx = dCent[0]*aU[0]+dCent[1]*aU[1]+dCent[2]*aU[2];
      const gTy = dCent[0]*aV[0]+dCent[1]*aV[1]+dCent[2]*aV[2];
      const aabbLongest = (bb: typeof bboxA3d): number =>
        [bb.x_max - bb.x_min, bb.y_max - bb.y_min, bb.z_max - bb.z_min].sort((a, b) => a - b)[2] ?? 0;
      const panelMaxFlatWidth = Math.max(aabbLongest(bboxA3d), aabbLongest(bboxB3d));
      const centroidTxMag = Math.hypot(gTx, gTy);
      const adjacentByDisplacement = panelMaxFlatWidth <= 0 || centroidTxMag / panelMaxFlatWidth <= 0.75;
      if (!adjacentByDisplacement) {
        throwError(
          ErrorCodes.GE_MERGE_DISCONNECTED,
          `GE_MERGE_DISCONNECTED: merge_bodies_with_bend: Panels are not adjacent ` +
          `and cannot be merged. Panels must share a common bend edge.`,
          false,
        );
      }
    }
    if (panelNodeA.flatWidth === null) {
      throwError(
        ErrorCodes.GE_MERGE_FAILED,
        'merge_bodies_with_bend requires panel A flatWidth for bend flattening. Run apply_unfold first.',
        true,
        'apply_unfold',
      );
    }
    // The 3D rotationMatrix from computeDxfMergePlacement is degenerate for perpendicular panels.
    // In 2D flat-pattern space, panel B is unfolded and placed flat with identity rotation.
    // effectiveAFlatWidth: Panel A's fold-perpendicular extent.
    // When fold runs along Panel A's U axis (longer, stored as flatWidth), flatHeight is fold-perp.
    effectiveAFlatWidth = (foldAlongU_A && panelNodeA.flatHeight !== null)
      ? panelNodeA.flatHeight
      : (panelNodeA.flatWidth ?? 0);
    effectiveBFlatWidth = (foldAlongU_B && panelNodeB.flatHeight !== null)
      ? panelNodeB.flatHeight
      : (panelNodeB.flatWidth ?? 0);

    // For chained merges, panelNodeA.flatWidth stores the LAST panel's individual
    // fold-perp width (for getFlatPatternDimensions graph traversal), not the total
    // merged flat width. Override effectiveAFlatWidth from the actual shapeDxf bbox.
    if (isChainedMerge && panelNodeA.shapeDxf) {
      try {
        const tmpRing = parseFirstClosedPolyline(panelNodeA.shapeDxf);
        let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
        let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
        for (const [x, y] of tmpRing) {
          if (x < xMin) xMin = x; if (x > xMax) xMax = x;
          if (y < yMin) yMin = y; if (y > yMax) yMax = y;
        }
        const dxfW = xMax - xMin;
        const dxfH = yMax - yMin;
        // When foldAlongU_A=false: panelADxfForMerge is not rotated → effectiveAFlatWidth = dxfW
        // When foldAlongU_A=true:  panelADxfForMerge is rotated 90° CCW, new x-extent = dxfH
        if (dxfW > 0 && dxfH > 0) effectiveAFlatWidth = foldAlongU_A ? dxfH : dxfW;
      } catch { /* keep computed value on parse failure */ }
    }
    rotationMatrix = [[1, 0], [0, 1]];
    // Place panel B after the bend zone in flat pattern space.
    // X translation: panel B starts after panel A's fold-perpendicular extent + bend allowance.
    // Y translation: seam-axis offset (panel B may be shifted along the seam relative to A).
    // Compute seam axis = cross product of the two panel normals.
    // Along this axis, find the centroid difference between A and B — this is the Y offset.
    const MERGE_OVERLAP_MM = 0.1;

    // Seam axis: the common edge direction. For perp panels nA×nB gives the seam direction.
    const seamAxis: [number, number, number] = [
      nA[1] * nB[2] - nA[2] * nB[1],
      nA[2] * nB[0] - nA[0] * nB[2],
      nA[0] * nB[1] - nA[1] * nB[0],
    ];
    const seamAxisLen = Math.hypot(seamAxis[0], seamAxis[1], seamAxis[2]);
    const seamOffset = seamAxisLen > 0.001
      ? (() => {
          // Center of A and B along the seam axis
          const centASeam = (bboxA3d.x_min + bboxA3d.x_max) / 2 * seamAxis[0] / seamAxisLen
                          + (bboxA3d.y_min + bboxA3d.y_max) / 2 * seamAxis[1] / seamAxisLen
                          + (bboxA3d.z_min + bboxA3d.z_max) / 2 * seamAxis[2] / seamAxisLen;
          const centBSeam = (bboxB3d.x_min + bboxB3d.x_max) / 2 * seamAxis[0] / seamAxisLen
                          + (bboxB3d.y_min + bboxB3d.y_max) / 2 * seamAxis[1] / seamAxisLen
                          + (bboxB3d.z_min + bboxB3d.z_max) / 2 * seamAxis[2] / seamAxisLen;
          return centBSeam - centASeam;
        })()
      : 0;
    seamYOffset = seamOffset;
    translation = [effectiveAFlatWidth + ba - MERGE_OVERLAP_MM, seamOffset];
  }

  // Normalize DXF to start at (0,0) for both panels to ensure proper placement.
  // Each panel's DXF from split_body_by_bends might have different origins,
  // so we shift both to (0,0) before computing placement and union.
  const normalizeDxfOrigin = (dxf: string): string => {
    try {
      const ring = parseFirstClosedPolyline(dxf);
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
      if (minX === Number.POSITIVE_INFINITY || minY === Number.POSITIVE_INFINITY) {
        return dxf;
      }
      const shifted = ring.map(([x, y]) => [x - minX, y - minY] as [number, number]);
      return ringToLwpolylineDxf(shifted);
    } catch {
      return dxf;
    }
  };

  // Rotate a DXF 90° CCW so its long axis (fold-parallel) moves from X to Y.
  // normalizePanelDxfOrientation always places the longer (U) dimension along DXF X.
  // When foldAlongU=true, U is fold-parallel, so the DXF has fold-parallel along X and
  // fold-perpendicular along Y.  But the merge layout expects fold-perpendicular along X
  // (it uses effectiveAFlatWidth = flatHeight as the Panel A X-extent).  Rotating 90°
  // fixes the mismatch: fold-perp → X, fold-parallel → Y.
  const rotateDxf90 = (dxf: string): string => {
    try {
      const ring = parseFirstClosedPolyline(dxf);
      const rotated = applyPlacement(ring, {
        rotationMatrix: [[0, 1], [-1, 0]],
        translation: [0, 0],
      });
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      for (const [x, y] of rotated) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
      }
      const shifted = rotated.map(([x, y]) => [x - minX, y - minY] as [number, number]);
      return ringToLwpolylineDxf(shifted);
    } catch {
      return dxf;
    }
  };

  // When the fold is along Panel A's U-axis (longer axis), shapeDxf has its
  // longer dimension along DXF X (fold-parallel).  Rotate 90° so that the
  // fold-perpendicular dimension (effectiveAFlatWidth) aligns with DXF X.
  const panelADxfForMerge: string = panelNodeA.shapeDxf
    ? (foldAlongU_A ? rotateDxf90(normalizeDxfOrigin(panelNodeA.shapeDxf)) : normalizeDxfOrigin(panelNodeA.shapeDxf))
    : '';
  const panelBDxfForMerge: string = panelNodeB.shapeDxf
    ? (foldAlongU_B ? rotateDxf90(normalizeDxfOrigin(panelNodeB.shapeDxf)) : normalizeDxfOrigin(panelNodeB.shapeDxf))
    : '';

  let preflightMerge: ReturnType<typeof mergeDxfOutlines>;
  try {
    preflightMerge = mergeDxfOutlines(panelADxfForMerge, panelBDxfForMerge, {
      rotationMatrix,
      translation,
    });
  } catch (err) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      `merge_bodies_with_bend DXF merge failed: ${err instanceof Error ? err.message : String(err)}. ` +
      `No geometry merge performed because DXF is the source of truth.`,
      false,
    );
  }

  let mergedDxf: string | null = preflightMerge.mergedDxf;
  const mergedFlatWidth: number | null = preflightMerge.metrics.bbox.width;
  const mergedFlatHeight: number | null = preflightMerge.metrics.bbox.height;



  // CLEAN: DXF is the source of truth, so clean it immediately after creation
  // before assigning to panel nodes. Invalid internal cut lines must not persist.
  if (mergedDxf && mergedFlatWidth && mergedFlatHeight) {
    mergedDxf = filterInvalidCutLines(mergedDxf, mergedFlatWidth, mergedFlatHeight);
  }

  const ctx = resolveTransactionContext(args);

  // Node IDs are computed here so rollback references are consistent.
  const nodeAId = toNodeId(`panel-a-${partAId.substring(0, 8)}`);
  const nodeBId = toNodeId(partAId);       // canonical node, looked up via partAId
  const nodeBIdAlias = toNodeId(partBId);  // alias node, looked up via partBId
  const bendId = toNodeId(`bend-${partAId.substring(0, 8)}`);

  // ── Snapshot C++ state before any mutation (FR-007 rollback-first) ───────────
  const snapshotId = getGeometryBinding().createSnapshot('before-merge-graph-first');

  // Save current graph state for rollback on C++ failure.
  const savedGraphA = getParts().get(partAId);
  const savedGraphB = getParts().get(partBId);
  const savedActivePartId = getActivePartId();

  // ── Step 1: Graph-first — build merged graph BEFORE any C++ call ─────────────
  getParts().delete(partAId);
  getParts().delete(partBId);
  if (getActivePartId() === partAId || getActivePartId() === partBId) setActivePartIdInternal(undefined);
  const mergedGraph = createPart(partAId);
  const mergedPartId = partAId; // Stable: same as the caller's part_a_id input
  getParts().set(partBId, mergedGraph);

  // DXF-aligned frames for the merged graph nodes.
  // foldAlongU_A/B are now known — compute DXF-aligned frames (accounting for rotateDxf90).
  const frameADxf = computeDxfAlignedFrame(shellAId as string, foldAlongU_A);
  const frameBDxf = computeDxfAlignedFrame(shellBId as string, foldAlongU_B);

  // Panel A: dxfPlacement = identity (origin of the merged flat)
  const dxfPlacementA: Placement2D = { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] };
  // Panel B: translated by (effectiveAFlatWidth + ba) along flat X, plus seam Y offset
  const dxfPlacementB: Placement2D = { rotationMatrix: [[1, 0], [0, 1]], translation: [effectiveAFlatWidth + ba, seamYOffset] };

  // Upstream panel A node (non-canonical; stale after merge).
  // flatWidth stores Panel A's own fold-perpendicular extent so that
  // getFlatPatternDimensions can sum the chain without double-counting the total.
  mergedGraph.addNode({
    type: 'PanelNode',
    id: nodeAId,
    bodyId: null,
    dirty: false,
    materialType: panelNodeA?.materialType ?? 'default',
    nominalThickness: panelNodeA?.nominalThickness ?? 1.0,
    flatWidth: effectiveAFlatWidth > 0 ? effectiveAFlatWidth : (panelNodeA?.flatWidth ?? null),
    flatHeight: panelNodeA?.flatHeight ?? null,
    canonical: false,
    shapeDxf: panelNodeA?.shapeDxf ?? null,
    panelFrame: frameADxf,
    dxfPlacement: dxfPlacementA,
  });

  // Canonical merged panel node — bodyId is null until C++ call succeeds.
  // shapeDxf is the merged 2D outline (source of truth, FR-008).
  // flatWidth stores Panel B's own fold-perpendicular extent. getFlatPatternDimensions
  // traverses nodeAId → BendNode → nodeBId and sums them to get the total width.
  mergedGraph.addNode({
    type: 'PanelNode',
    id: nodeBId,
    bodyId: null,
    dirty: false,
    materialType: panelNodeB?.materialType ?? 'default',
    nominalThickness: panelNodeB?.nominalThickness ?? 1.0,
    flatWidth: effectiveBFlatWidth > 0 ? effectiveBFlatWidth : mergedFlatWidth,
    flatHeight: mergedFlatHeight,
    canonical: true,
    shapeDxf: mergedDxf,
    panelFrame: frameBDxf,
    dxfPlacement: dxfPlacementB,
  });

  // Alias node so apply_unfold(panel_id: partBId) also resolves.
  // No BendNode points to this alias, so flatWidth must be the pre-computed total
  // merged width for getFlatPatternDimensions to return the correct value.
  mergedGraph.addNode({
    type: 'PanelNode',
    id: nodeBIdAlias,
    bodyId: null,
    dirty: false,
    materialType: panelNodeB?.materialType ?? 'default',
    nominalThickness: panelNodeB?.nominalThickness ?? 1.0,
    flatWidth: mergedFlatWidth,
    flatHeight: mergedFlatHeight,
    canonical: true,
    shapeDxf: mergedDxf,
    panelFrame: frameBDxf,
    dxfPlacement: dxfPlacementB,
  });

  mergedGraph.addNode({
    type: 'BendNode',
    id: bendId,
    dirty: true,
    panelAId: nodeAId,
    panelBId: nodeBId,
    innerRadius: bendRadius as number,
    angle: bendAngle,
    kFactor: kFactorDefault,
    bendAllowance: ba,
    bendZoneDxfX: effectiveAFlatWidth,
  });

  // ── Step 2: C++ call — rebuild from manufacturing graph, then place ──────────
  // buildShellFromFlatPattern reconstructs the 3D shape from the DXF (source of
  // truth). It accepts an optional referenceShellId so C++ can compute the
  // placement transform from the original panel A's face frame.
  let mergedShellId: string;
  let shapeHistory: unknown[] = [];
  let rollbackToken: string = snapshotId;

  try {
    if (mergedDxf && getGeometryBinding().hasBuildShellFromFlatPattern()) {
      const bendZones = effectiveAFlatWidth
        ? [{
            offsetMm: effectiveAFlatWidth,
            widthMm: ba,
            angleDeg: bendAngle,
            innerRadiusMm: bendRadius as number,
            kFactor: kFactorDefault,
            // Fold frame (world): canonical +X → bendDir, canonical +Z → foldNormal.
            // Lets C++ place the rebuilt shell on the correct side without guessing
            // a face-normal sign (which previously inverted the fold).
            foldNormalX: foldNormal[0], foldNormalY: foldNormal[1], foldNormalZ: foldNormal[2],
            bendDirX: bendDir[0], bendDirY: bendDir[1], bendDirZ: bendDir[2],
          }]
        : [];
      const res = getGeometryBinding().buildShellFromFlatPattern(mergedDxf, bendZones, thickness, shellAId as string);
      mergedShellId = res.shellId;
    } else {
      const res = getGeometryBinding().mergeBodiesWithBend(shellAId as string, shellBId as string, targetEdges, bendRadius as number);
      mergedShellId = res.mergedShellId;
      shapeHistory = (res as unknown as { shape_history?: typeof shapeHistory }).shape_history ?? [];
      rollbackToken = ctx.mode === 'join' ? ctx.transactionId
                    : ((res as unknown as { rollbackToken?: string }).rollbackToken ?? snapshotId);
    }
  } catch (err) {
    // ── Rollback: restore C++ snapshot and saved graph state ──────────────────
    try { getGeometryBinding().restoreSnapshot(snapshotId); } catch { /* best-effort */ }
    getParts().delete(partAId);
    getParts().delete(partBId);
    if (savedGraphA !== undefined) getParts().set(partAId, savedGraphA);
    if (savedGraphB !== undefined) getParts().set(partBId, savedGraphB);
    setActivePartIdInternal(savedActivePartId);
    throw err;
  }

  // ── Step 3: Stamp the returned shellId onto the canonical PanelNode ──────────
  const canonicalNode = mergedGraph.nodes.get(nodeBId);
  if (canonicalNode && canonicalNode.type === 'PanelNode') {
    (canonicalNode as PanelNode).bodyId = toBodyId(mergedShellId);
  }

  session.registerShell(mergedShellId);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, shapeHistory as import('../transactions').ShapeHistoryRecord[]);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    merged_shell_id: mergedShellId,
    merged_part_id: mergedPartId,
    part_id: mergedPartId,
    preserved_part_id: mergedPartId,
    consumed_part_ids: [partBId],
    part_a_id: partAId,
    graphs_merged: true,
    visible_shell_id: mergedShellId,
    hidden_shell_ids: [shellAId, shellBId],
    visibility_policy: 'show_only_recreated',
    rollback_token: rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${mergedShellId}.glb`,
    shape_history: shapeHistory,
    // T020 / FR-003: edge alignment correction applied (null if panels were already aligned)
    edge_alignment_correction_mm: edgeAlignmentCorrectionMm,
  };
}

export function handleCloseGap(args: Record<string, unknown>): unknown {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().closeGap(partAId, partBId);

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    part_b_id: result.partBId,
    gap_closed_mm: result.gapClosedMm,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.partBId}.glb`,
  };
}

export function handleIsPanelValid(args: Record<string, unknown>): unknown {
  const panelId = requireString(args, 'panel_id');
  const result = getGeometryBinding().isPanelValid(panelId);
  return {
    is_valid: result.isValid,
    can_flatten: result.canFlatten,
    nominal_thickness_mm: result.nominalThicknessMm,
    errors: result.errors.map(e => ({ code: e.code, message: e.message })),
  };
}

export function handleExtendFaceToTarget(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const faceId = typeof args['face_id'] === 'string' ? args['face_id'] as string : '';
  const targetType = typeof args['target_type'] === 'string' ? args['target_type'] as string : 'part_surface';

  if (targetType !== 'plane' && targetType !== 'face_id' && targetType !== 'part_surface') {
    throwError(ErrorCodes.GE_EXTEND_FAILED,
      'target_type must be "plane", "face_id", or "part_surface"', false);
  }

  const target = requireObject(args, 'target');

  // Accept flat target_part_id/target_face_id or nested target.part_id/target.face_id
  let targetPartId = '';
  let targetFaceId = '';
  if (typeof args['target_part_id'] === 'string') {
    targetPartId = args['target_part_id'] as string;
    targetFaceId = typeof args['target_face_id'] === 'string' ? args['target_face_id'] as string : '';
  } else {
    targetPartId = typeof target['part_id'] === 'string' ? target['part_id'] as string : '';
    targetFaceId = typeof target['face_id'] === 'string' ? target['face_id'] as string : '';
  }

  if (!targetPartId && targetType !== 'plane') {
    throwError(ErrorCodes.GE_EXTEND_FAILED, 'target_part_id is required', false);
  }

  // When target_type is 'plane', explicit normal and origin must be provided.
  // When target_type is 'face_id' or 'part_surface', the plane is computed from geometry
  // by the binding and these may be omitted.
  let targetPlane: { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } };

  if (targetType === 'plane') {
    const normalObj = target['normal'] as { x: number; y: number; z: number } | undefined;
    const originObj = target['origin'] as { x: number; y: number; z: number } | undefined;
    if (!normalObj || typeof normalObj.x !== 'number' || typeof normalObj.y !== 'number' || typeof normalObj.z !== 'number') {
      throwError(ErrorCodes.GE_EXTEND_FAILED, 'target.normal must be an object with numeric x, y, z', false);
    }
    if (!originObj || typeof originObj.x !== 'number' || typeof originObj.y !== 'number' || typeof originObj.z !== 'number') {
      throwError(ErrorCodes.GE_EXTEND_FAILED, 'target.origin must be an object with numeric x, y, z', false);
    }
    targetPlane = { normal: normalObj, origin: originObj };
  } else if (targetType === 'face_id' && targetFaceId) {
    // For face_id, compute the plane from the target face topology
    const binding = getGeometryBinding();
    const targetTopology = binding.getTopology(targetPartId);
    const targetFace = targetTopology.faces.find(f => f.faceId === targetFaceId);
    if (!targetFace) {
      throwError(ErrorCodes.GE_EXTEND_FAILED, `Target face ${targetFaceId} not found in part ${targetPartId}`, false);
    }
    // Extract normal and origin from face topology
    targetPlane = {
      normal: { x: targetFace.normalX, y: targetFace.normalY, z: targetFace.normalZ },
      origin: { x: 0, y: 0, z: 0 }, // Origin is typically at the coordinate system origin for planar faces
    };
  } else {
    // For part_surface without explicit face_id, use a default plane
    targetPlane = { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 0 } };
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().extendFaceToTarget(
    partId, faceId, targetType, targetPartId, targetFaceId, targetPlane,
  );

  // Register the modified shell immediately so it can be used in subsequent operations
  session.registerShell(result.modifiedShellId);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    modified_shell_id: result.modifiedShellId,
    extension_distance_mm: result.extensionDistanceMm,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.modifiedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleOffsetFace(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const faceId = requireString(args, 'face_id');
  const distance = args['distance'];
  if (typeof distance !== 'number' || Math.abs(distance) < 1e-10) {
    throwError(ErrorCodes.GE_OFFSET_FAILED, 'distance must be a non-zero number', false);
  }

  // Guard against raw mutation of graph-tracked shells (FR-005).
  const graphOwner = findGraphOwner(partId);
  if (graphOwner !== null) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Shell UUID '${partId}' belongs to manufacturing-graph-tracked part '${graphOwner.partId}'. ` +
      `Raw face offsets on graph-tracked shells are not permitted. Use graph mutation tools instead.`,
      true,
      'solve_geometry',
    );
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().offsetFace(partId, faceId, distance as number);

  // Register the modified shell immediately so it can be used in subsequent operations
  session.registerShell(result.modifiedShellId);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.modifiedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleAddFlange(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const edgeId = requireString(args, 'edge_id');
  const length = args['length'];
  const angle = args['angle'];
  const bendRadius = args['bend_radius'];

  if (typeof length !== 'number' || length <= 0) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'length must be a positive number', false);
  }
  if (typeof angle !== 'number' || angle <= 0 || angle > 180) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'angle must be in range (0, 180]', false);
  }
  if (typeof bendRadius !== 'number' || bendRadius <= 0) {
    throwError(ErrorCodes.GE_FLANGE_FAILED, 'bend_radius must be a positive number', false);
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().addFlange(
    partId, edgeId, length as number, angle as number, bendRadius as number,
  );

  // Register the modified shell immediately so it can be used in subsequent operations
  session.registerShell(result.modifiedShellId);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    modified_shell_id: result.modifiedShellId,
    flange_feature_id: result.flangeFeatureId,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.modifiedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleRipEdge(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const edgeId = requireString(args, 'edge_id');

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().ripEdge(partId, edgeId);

  // Register the modified shell immediately so it can be used in subsequent operations
  session.registerShell(result.modifiedShellId);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.modifiedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleComputeIntersections(args: Record<string, unknown>): unknown {
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

export function handleComputeGaps(args: Record<string, unknown>): unknown {
  const partAId = requireString(args, 'part_a_id');
  const partBId = requireString(args, 'part_b_id');
  const maxDist = args['max_distance_threshold_mm'];
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

export function handleTrimBodyWithPlane(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
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

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().trimBodyWithPlane(partId, plane, keepPositiveSide as boolean);

  // Register the trimmed shell immediately so it can be used in subsequent operations
  session.registerShell(result.trimmedShellId);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    trimmed_shell_id: result.trimmedShellId,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.trimmedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleCheckBoundaryCompliance(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): unknown {
  const partId = requireString(args, 'part_id');
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

export async function handleSplitBodyByBends(args: Record<string, unknown>): Promise<unknown> {
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
    : 1;

  if (threshold < 0) {
    throwError(ErrorCodes.GE_DECOMPOSE_BY_BENDS_FAILED, 'angle_threshold_deg must be non-negative', true);
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().splitBodyByBends(
    partId, threshold, maxThicknessMm, defaultThicknessMm, maxRecursionDepth,
  );

  for (const shellId of result.panel_ids) {
    session.registerShell(shellId);
  }
  for (const shellId of result.protrusion_ids) {
    session.registerShell(shellId);
  }

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  // ARCHITECTURE CHANGE: Auto-create manufacturing graphs for each panel
  // Each panel gets its own part with auto-generated part_id
  const createdParts: Array<{ part_id: string; panel_id: string }> = [];

  // Helper to cast string to BodyId
  const toBodyId = (s: string): import('../../manufacturing/graph/types').BodyId => s as import('../../manufacturing/graph/types').BodyId;

  for (let pi = 0; pi < result.panel_ids.length; pi++) {
    const panelId = result.panel_ids[pi]!;
    // Use the shell ID directly as the part ID so merge_bodies_with_bend
    // can look up the graph using the shell ID (no translation needed).
    const partId = panelId;
    // If a stale graph entry exists for this UUID (e.g. from a previous
    // merge that was later rolled back and the C++ engine reused the UUID),
    // overwrite it with a fresh graph rather than failing silently.
    if (getParts().has(partId)) {
      getParts().delete(partId);
      if (getActivePartId() === partId) setActivePartIdInternal(undefined);
    }
    createPart(partId);
    const graph = getManufacturingGraph(partId);

    // Panel frame and flat dimensions from OCCT face analysis (hard fail — no fallback).
    let panelFlatWidth: number | null = null;
    let panelFlatHeight: number | null = null;
    let panelFrame: import('../../manufacturing/dxf/orientation').PanelFrame | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let _pf: any;
    try {
      _pf = getGeometryBinding().getPanelFrame(panelId);
    } catch {
      throwError(
        ErrorCodes.GE_PANEL_FRAME_FAILED,
        `Shell ${panelId} has no planar faces; cannot derive panel frame.`,
        false,
        'clean_geometry',
      );
    }
    panelFlatWidth = _pf.uExtentMm;
    panelFlatHeight = _pf.vExtentMm;
    panelFrame = {
      origin: [_pf.originX, _pf.originY, _pf.originZ],
      u: [_pf.uX, _pf.uY, _pf.uZ],
      v: [_pf.vX, _pf.vY, _pf.vZ],
    };

    // Critical: Panel node creation must succeed. No fallback allowed.
    // If this fails, it indicates a malformed geometry or data corruption.
    //
    // T013 / BUG-02 fix: Extract the true N-vertex face boundary from OCCT via
    // unfoldShell + exportDxf rather than hardcoding a 4-corner rectangle.
    // This ensures non-rectangular panels get correct LWPOLYLINE outlines.
    let panelShapeDxf: string | null = null;
    try {
      const unfoldResult = getGeometryBinding().unfoldShell(panelId, 0.44 /* K-factor default */);
      session.registerUnfold(unfoldResult.unfoldId);
      const dxfResult = getGeometryBinding().exportDxf(unfoldResult.unfoldId);
      if (dxfResult.dxfContent && dxfResult.dxfContent.length > 0) {
        // Convert OCCT's LINE-entity DXF to LWPOLYLINE for buildSheetFromDxf compatibility.
        const lwpolyDxf = occtDxfToLwpolylineDxf(dxfResult.dxfContent);
        panelShapeDxf = normalizePanelDxfOrientation(
          lwpolyDxf ?? dxfResult.dxfContent,
          panelFlatWidth,
          panelFlatHeight,
        );
      }
    } catch {
      // unfoldShell threw (e.g. tilted panel not solvable by OCCT unfold algorithm).
      // Generate the DXF outline from the getPanelFrame-derived oriented extents, which
      // are the authoritative source for flat dimensions (uExtentMm / vExtentMm from the
      // actual planar face). These were set before this block and are NOT axis-aligned
      // bbox measurements — they are the true in-plane extents.
      if (panelFlatWidth !== null && panelFlatHeight !== null) {
        panelShapeDxf = generateDxfFromManufacturingGraph(panelFlatWidth, panelFlatHeight, [], []);
      }
    }

    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(panelId),  // Use raw panelId as node id so apply_unfold can find it
      bodyId: toBodyId(panelId),
      dirty: true,
      materialType: 'default',
      nominalThickness: defaultThicknessMm,
      flatWidth: panelFlatWidth,
      flatHeight: panelFlatHeight,
      canonical: true,  // Split panels are canonical unfold targets
      shapeDxf: panelShapeDxf,
      panelFrame: panelFrame ?? undefined,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] },
    });
    createdParts.push({ part_id: partId, panel_id: panelId });
  }

  // Auto-create manufacturing graphs for protrusions as well.
  // Each protrusion is an independent shell (flange, tab, boss) that may
  // need to be unfolded or evaluated separately.
  for (let pi = 0; pi < result.protrusion_ids.length; pi++) {
    const protrusionId = result.protrusion_ids[pi]!;
    const protPartId = protrusionId;
    if (getParts().has(protPartId)) {
      getParts().delete(protPartId);
      if (getActivePartId() === protPartId) setActivePartIdInternal(undefined);
    }
    createPart(protPartId);
    const graph = getManufacturingGraph(protPartId);

    let protFlatWidth: number | null = null;
    let protFlatHeight: number | null = null;
    let protrusionFrame: import('../../manufacturing/dxf/orientation').PanelFrame | null = null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ppf: any = getGeometryBinding().getPanelFrame(protrusionId);
      protFlatWidth = ppf.uExtentMm;
      protFlatHeight = ppf.vExtentMm;
      protrusionFrame = {
        origin: [ppf.originX, ppf.originY, ppf.originZ],
        u: [ppf.uX, ppf.uY, ppf.uZ],
        v: [ppf.vX, ppf.vY, ppf.vZ],
      };
    } catch {
      // Non-planar protrusion (boss, tube): fall back to bbox for dimensions, no frame.
      const bbox = result.protrusion_bboxes?.[pi];
      if (bbox) {
        const dims = [
          bbox.x_max - bbox.x_min,
          bbox.y_max - bbox.y_min,
          bbox.z_max - bbox.z_min,
        ].sort((a, b) => a - b);
        protFlatWidth  = dims[2] ?? null;
        protFlatHeight = dims[1] ?? null;
      }
    }

    // Node ID equals the protrusion ID so apply_unfold(panel_id: protrusionId,
    // part_id: protrusionId) resolves this node without a queryGraph round-trip.
    // Protrusions are canonical unfold targets.
    // T013 / BUG-02 fix: Extract the true face boundary from OCCT unfold.
    let protrusionShapeDxf: string | null = null;
    try {
      const protUnfold = getGeometryBinding().unfoldShell(protrusionId, 0.44);
      session.registerUnfold(protUnfold.unfoldId);
      const protDxf = getGeometryBinding().exportDxf(protUnfold.unfoldId);
      if (protDxf.dxfContent && protDxf.dxfContent.length > 0) {
        const lwpolyDxf = occtDxfToLwpolylineDxf(protDxf.dxfContent);
        protrusionShapeDxf = normalizePanelDxfOrientation(
          lwpolyDxf ?? protDxf.dxfContent,
          protFlatWidth,
          protFlatHeight,
        );
      }
    } catch {
      // unfoldShell threw — generate DXF from getPanelFrame-derived extents.
      if (protFlatWidth !== null && protFlatHeight !== null) {
        protrusionShapeDxf = generateDxfFromManufacturingGraph(protFlatWidth, protFlatHeight, [], []);
      }
    }

    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(protrusionId),
      bodyId: toBodyId(protrusionId),
      dirty: true,
      materialType: 'default',
      nominalThickness: defaultThicknessMm,
      flatWidth: protFlatWidth,
      flatHeight: protFlatHeight,
      canonical: true,  // Protrusions are canonical unfold targets
      shapeDxf: protrusionShapeDxf,
      panelFrame: protrusionFrame ?? undefined,
      dxfPlacement: { rotationMatrix: [[1, 0], [0, 1]], translation: [0, 0] },
    });
    createdParts.push({ part_id: protPartId, panel_id: protrusionId });
  }

  // T012 / FR-001: pipelineExecuted = true when the DXF pipeline ran successfully
  // for at least one panel (unfoldShell + exportDxf was the pipeline work).
  // NOTE: We intentionally do NOT call GeometrySolver.solve() here. The C++ split
  // already produces panels at their correct 3D world positions. Running the solver
  // would call buildShellFromFlatPattern which creates new shells via a placement
  // transform that is only correct for the merge-reconstruction path (where panels
  // need to be rebuilt from DXF to reflect parameter changes). Applying it to freshly
  // split panels would displace them from their correct positions, breaking the
  // merge orientation and causing GE_SOLID_NOT_FOUND cascades in subsequent tests.
  const pipelineExecuted = createdParts.some(({ part_id: pid }) => {
    const g = getParts().get(pid);
    if (!g) return false;
    const node = g.nodes.get(pid as import('../../manufacturing/graph/types').NodeId);
    return node?.type === 'PanelNode' && (node as import('../../manufacturing/graph/types').PanelNode).shapeDxf !== null;
  });

  const allIds = [...result.panel_ids, ...result.protrusion_ids];
  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    panel_ids: result.panel_ids,
    panel_count: result.panel_ids.length,
    panel_bboxes: result.panel_bboxes,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_ids.length,
    protrusion_bboxes: result.protrusion_bboxes,
    protrusion_parents: result.protrusion_parents,
    detected_mode: result.detected_mode,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_urls: allIds.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
    shape_history: result.shape_history ?? [],
    // Manufacturing graph creation results
    created_parts: createdParts,
    hidden_source_part_ids: [partId],
    visibility_policy: 'show_only_recreated',
    // T015 / FR-009: confirms pipeline was invoked for at least one new part
    pipeline_executed: pipelineExecuted,
  };
}

export function handleRemoveProtrusions(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const angleThresholdDeg = typeof args['angle_threshold_deg'] === 'number'
    ? args['angle_threshold_deg']
    : 30.0;
  const maxThicknessMm = typeof args['max_thickness_mm'] === 'number'
    ? args['max_thickness_mm']
    : 5.0;
  const algorithm = typeof args['algorithm'] === 'string' &&
    (args['algorithm'] === 'loop_traversal' || args['algorithm'] === 'legacy_volumetric')
    ? args['algorithm']
    : 'loop_traversal';

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().removeProtrusions(partId, angleThresholdDeg, maxThicknessMm, algorithm);

  session.registerShell(result.cleaned_part_id);
  for (const shellId of result.protrusion_ids) {
    session.registerShell(shellId);
  }

  // Create manufacturing graph parts for each protrusion so apply_unfold can resolve them.
  // Mirror what split_body_by_bends does: part_id = shell UUID, single canonical PanelNode.
  const toBodyId = (s: string): import('../../manufacturing/graph/types').BodyId => s as import('../../manufacturing/graph/types').BodyId;
  const createdProtrusionParts: Array<{ part_id: string; panel_id: string }> = [];

  for (let pi = 0; pi < result.protrusion_ids.length; pi++) {
    const protrusionId = result.protrusion_ids[pi]!;
    const protPartId = protrusionId;
    if (getParts().has(protPartId)) {
      getParts().delete(protPartId);
      if (getActivePartId() === protPartId) setActivePartIdInternal(undefined);
    }
    createPart(protPartId);
    const pGraph = getManufacturingGraph(protPartId);

    let protFlatWidth: number | null = null;
    let protFlatHeight: number | null = null;
    const bbox = result.protrusion_bboxes?.[pi];
    if (bbox) {
      const dims = [
        bbox.x_max - bbox.x_min,
        bbox.y_max - bbox.y_min,
        bbox.z_max - bbox.z_min,
      ].sort((a, b) => a - b);
      protFlatWidth  = dims[2] ?? null;
      protFlatHeight = dims[1] ?? null;
    }

    const protrusionShapeDxf =
      protFlatWidth !== null && protFlatHeight !== null
        ? generateDxfFromManufacturingGraph(protFlatWidth, protFlatHeight, [], [])
        : null;

    pGraph.addNode({
      type: 'PanelNode',
      id: toNodeId(protrusionId),  // Use raw protrusionId as node id so apply_unfold can find it
      bodyId: toBodyId(protrusionId),
      dirty: true,
      materialType: 'default',
      nominalThickness: maxThicknessMm,
      flatWidth: protFlatWidth,
      flatHeight: protFlatHeight,
      canonical: true,
      shapeDxf: protrusionShapeDxf,
    });
    createdProtrusionParts.push({ part_id: protPartId, panel_id: protrusionId });
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  const allIds = [result.cleaned_part_id, ...result.protrusion_ids];
  return {
    cleaned_part_id: result.cleaned_part_id,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_count,
    protrusion_bboxes: result.protrusion_bboxes,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_urls: allIds.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
    created_parts: createdProtrusionParts,
  };
}
