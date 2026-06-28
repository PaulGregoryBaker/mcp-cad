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
import {
  requireString,
  requireStringArray,
  requireObject,
  resolveTransactionContext,
  buildMeshUrl,
  buildMeshUrls,
  resolveRollbackToken,
  appendHistoryIfJoined,
  measurePanelMidplaneOffsetMm,
} from '../helpers.js';
import {
  ringToLwpolylineDxf,
  normalizePanelDxfOrientation,
  filterInvalidCutLines,
  generateDxfFromManufacturingGraph,
} from '../dxf-helpers.js';
import { computeDxfMergePlacement, napiFrameToPanelFrame } from '../../manufacturing/dxf/orientation.js';
import type { MergePlacement2D } from '../../manufacturing/dxf/orientation.js';
import type { Placement2D } from '../../manufacturing/dxf/merge.js';
import { mergeDxfOutlines, parseFirstClosedPolyline, applyPlacement } from '../../manufacturing/dxf/merge.js';
import { toNodeId, computeBendAllowance } from '../../manufacturing/graph/types.js';
import type { PanelFrame, PanelNode, BendNode, BodyId, NodeId, ManufacturingGraphData } from '../../manufacturing/graph/types.js';
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

// Re-expresses a panel's STORED frame (graph data — never a live shell query)
// so DXF+X aligns with the fold-perpendicular direction. isRotated=true means
// the panel's natural u-axis is along the FOLD direction rather than
// perpendicular to it, so the DXF itself gets rotated 90° (rotateDxf90)
// elsewhere — this must rotate the frame the SAME way, or placement and DXF
// content disagree on which world direction is DXF+X.
/**
 * Fixes panel chirality (mirrors the DXF + frame if cross(u,v) points away
 * from the OTHER panel instead of toward it) and normalizes the result so
 * its bbox-minimum corner sits at local (0,0) — both are preconditions for
 * later computations that assume "frame.normal points toward the other
 * panel" and "the DXF already starts at (0,0)" (e.g. computeDxfAlignedFrame
 * and computeBendAlignedFrame below).
 *
 * getPanelFrame's U/V tie-break (longer in-plane axis as U) is purely a
 * convention for WHICH of a panel's two equal-and-opposite faces (u, v,
 * normal=u×v) describes — it has no relationship to which side of this
 * panel's plane the OTHER panel actually sits on. When the two disagree,
 * this panel's own flat-pattern DXF (generated by apply_unfold by
 * projecting through exactly this u/v) was effectively unfolded "looking
 * from the wrong side" — the bend reconstruction always refolds using the
 * bend's true (always-toward-the-other-panel) fold direction, so an
 * uncorrected DXF comes back as a MIRROR IMAGE of the real shape, not a
 * simple sign/placement error (confirmed: no choice of placement-transform
 * basis can fix this without itself mirroring the whole rebuilt composite —
 * Y is fully determined once X=bendDir and Z=foldNormal are fixed, and
 * foldNormal can never flip without breaking the bend's own direction).
 *
 * Mirroring flips v (never u): u-flip and v-flip both fix chirality but
 * differ by a 180° rotation about the normal — invisible for a symmetric
 * panel, but it changes which edge the bend's hinge lands on for an
 * asymmetric one. Always flipping v keeps that ambiguity resolved the same,
 * validated way every time.
 */
function mirrorAndNormalizePanelDxf(
  shapeDxf: string,
  frame: PanelFrame,
  selfShellId: string,
  otherShellId: string,
): { shapeDxf: string; frame: PanelFrame } {
  let resultDxf = shapeDxf;
  let resultFrame = frame;

  const bboxSelf = getGeometryBinding().computeBoundingBox(selfShellId);
  const bboxOther = getGeometryBinding().computeBoundingBox(otherShellId);
  const dSelfToOther: [number, number, number] = [
    (bboxOther.x_min + bboxOther.x_max) / 2 - (bboxSelf.x_min + bboxSelf.x_max) / 2,
    (bboxOther.y_min + bboxOther.y_max) / 2 - (bboxSelf.y_min + bboxSelf.y_max) / 2,
    (bboxOther.z_min + bboxOther.z_max) / 2 - (bboxSelf.z_min + bboxSelf.z_max) / 2,
  ];
  const nRaw: [number, number, number] = [
    frame.u[1] * frame.v[2] - frame.u[2] * frame.v[1],
    frame.u[2] * frame.v[0] - frame.u[0] * frame.v[2],
    frame.u[0] * frame.v[1] - frame.u[1] * frame.v[0],
  ];
  const pointsTowardOther = dSelfToOther[0] * nRaw[0] + dSelfToOther[1] * nRaw[1] + dSelfToOther[2] * nRaw[2] >= 0;
  if (!pointsTowardOther) {
    const ring = parseFirstClosedPolyline(shapeDxf);
    let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
    for (const [, y] of ring) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
    const yMinPlusMax = yMin + yMax;
    const mirroredRing = ring.map(([x, y]) => [x, yMinPlusMax - y] as [number, number]);
    resultDxf = ringToLwpolylineDxf(mirroredRing);
    resultFrame = {
      origin: [
        frame.origin[0] + yMinPlusMax * frame.v[0],
        frame.origin[1] + yMinPlusMax * frame.v[1],
        frame.origin[2] + yMinPlusMax * frame.v[2],
      ],
      u: frame.u,
      v: [-frame.v[0], -frame.v[1], -frame.v[2]],
      vExtentMm: frame.vExtentMm,
      normal: frame.normal ? [-frame.normal[0], -frame.normal[1], -frame.normal[2]] : undefined,
    };
  }

  // computeDxfAlignedFrame's formula is only valid when the DXF it's
  // describing already has its bbox-minimum corner at local (0,0) — its own
  // doc comment assumes normalizeDxfOrigin has already run. A composite
  // panel whose fused-on feature extends past the main panel's own (0,0)
  // corner (e.g. an overhang sitting at negative Y) violates that
  // precondition before normalizeDxfOrigin is ever applied (it only runs
  // later, when building panelADxfForMerge/panelBDxfForMerge). Normalize
  // here instead, immediately, with a matching origin shift — a pure
  // translation, always safe regardless of content — so every later
  // computation already sees a (0,0)-anchored DXF and frame, and
  // normalizeDxfOrigin's later call on this same content is a no-op.
  const ring = parseFirstClosedPolyline(resultDxf);
  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
  for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; }
  if (minX !== 0 || minY !== 0) {
    resultDxf = ringToLwpolylineDxf(ring.map(([x, y]) => [x - minX, y - minY] as [number, number]));
    resultFrame = {
      origin: [
        resultFrame.origin[0] + minX * resultFrame.u[0] + minY * resultFrame.v[0],
        resultFrame.origin[1] + minX * resultFrame.u[1] + minY * resultFrame.v[1],
        resultFrame.origin[2] + minX * resultFrame.u[2] + minY * resultFrame.v[2],
      ],
      u: resultFrame.u,
      v: resultFrame.v,
      vExtentMm: resultFrame.vExtentMm,
      normal: resultFrame.normal,
    };
  }

  return { shapeDxf: resultDxf, frame: resultFrame };
}

/**
 * Finds the single PanelNode in a graph that represents the given part.
 * Strict requirement: exactly one panel with an exact id match, OR exactly
 * one panel total. No fallbacks — a mismatched/ambiguous graph is an error,
 * not something to silently guess at.
 */
function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function findRepresentativePanelNode(
  graph: ManufacturingGraphData,
  partId: string,
  label: 'part_a' | 'part_b',
): PanelNode {
  const panelNodes: PanelNode[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'PanelNode') panelNodes.push(node as PanelNode);
  }
  if (panelNodes.length === 0) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend ${label}: Graph contains no PanelNode. Expected at least one panel.`,
      true,
    );
  }
  let panelNode = panelNodes.find((pn) => pn.id === (partId as NodeId));
  if (!panelNode && panelNodes.length === 1) {
    panelNode = panelNodes[0];
  }
  if (!panelNode) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend ${label}: No PanelNode with id === ${label}_id ("${partId}"). ` +
      `Found ${panelNodes.length} panel(s): ${panelNodes.map((p) => p.id).join(', ')}. ` +
      `Provide ${label}_id that matches a panel node id in the graph, or ensure exactly one panel exists.`,
      true,
    );
  }
  return panelNode;
}

interface MergePanelLookup {
  panelNodeA: PanelNode;
  panelNodeB: PanelNode;
  shellAId: BodyId;
  shellBId: BodyId;
  /** panelNodeA.shapeDxf, narrowed non-null (lookupMergePanels already validated this). */
  shapeDxfA: string;
  /** panelNodeB.shapeDxf, narrowed non-null (lookupMergePanels already validated this). */
  shapeDxfB: string;
  /** True when panel A's graph already has a BendNode from a prior merge_bodies_with_bend call. */
  isChainedMerge: boolean;
  /**
   * The prior merge's own BendNode (not just isChainedMerge's boolean) —
   * needed later to re-fold panel A's OWN prior bend alongside the new one,
   * and to reuse its persisted placement basis for an aligned chain.
   */
  priorBendNodeA: BendNode | undefined;
}

/**
 * Resolves part_a_id/part_b_id into their manufacturing-graph PanelNodes and
 * current C++ shell IDs, with all the strict validation merge_bodies_with_bend
 * requires before any geometry computation starts: both parts must have a
 * manufacturing graph (from split_body_by_bends), each must resolve to
 * exactly one PanelNode, that node's bodyId must be non-null (graph solved),
 * and its shapeDxf must exist (apply_unfold already run) — no fallbacks.
 */
function lookupMergePanels(partAId: string, partBId: string): MergePanelLookup {
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

  // Detect chained merge: graphA already has a BendNode from a prior merge.
  // When true, panelNodeA is the canonical merged node whose shapeDxf is the
  // previously-merged flat DXF and whose bodyId is the previously-folded 3D shell.
  let priorBendNodeA: BendNode | undefined;
  for (const node of graphA.nodes.values()) {
    if (node.type === 'BendNode') { priorBendNodeA = node as BendNode; break; }
  }
  const isChainedMerge = priorBendNodeA !== undefined;

  const panelNodeA = findRepresentativePanelNode(graphA, partAId, 'part_a');
  const panelNodeB = findRepresentativePanelNode(graphB, partBId, 'part_b');

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

  return {
    panelNodeA, panelNodeB,
    shellAId: panelNodeA.bodyId as BodyId,
    shellBId: panelNodeB.bodyId as BodyId,
    shapeDxfA: panelNodeA.shapeDxf,
    shapeDxfB: panelNodeB.shapeDxf,
    isChainedMerge, priorBendNodeA,
  };
}

/**
 * Returns panelNode's existing panelFrame, or derives and persists one from
 * a live getPanelFrame query when missing entirely (should only happen for
 * panels created before this field existed) — once derived, it's stored
 * back on the node so every later read uses graph data only.
 */
function ensurePanelFrame(panelNode: PanelNode, label: 'part_a' | 'part_b'): PanelFrame {
  if (panelNode.panelFrame) return panelNode.panelFrame;
  if (!panelNode.bodyId) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      `merge_bodies_with_bend ${label}: Panel has null bodyId; cannot derive panelFrame.`,
      true,
      'solve_geometry',
    );
  }
  let pf: import('../../geometry/types').PanelFrameResult;
  try {
    pf = getGeometryBinding().getPanelFrame(panelNode.bodyId as string);
  } catch {
    throwError(
      ErrorCodes.GE_PANEL_FRAME_FAILED,
      `Shell ${panelNode.bodyId} has no planar faces; cannot derive panel frame.`,
      false,
      'clean_geometry',
    );
  }
  const derived: PanelFrame = napiFrameToPanelFrame(pf);
  panelNode.panelFrame = derived;
  return derived;
}

interface PreparedMergePanels {
  frameA: PanelFrame;
  frameB: PanelFrame;
  effectiveShapeDxfA: string;
  effectiveShapeDxfB: string;
  placement: MergePlacement2D;
  contactToleranceMm: number;
  /** Distance auto-corrected by close_gap before merging, or null if panels were already aligned. */
  edgeAlignmentCorrectionMm: number | null;
  /** shellBId, possibly updated in place if an automatic gap-closing correction moved panel B. */
  shellBId: BodyId;
}

/**
 * Derives both panels' frames (deriving from a live query if missing),
 * fixes chirality and normalizes each panel's DXF origin to (0,0) (see
 * mirrorAndNormalizePanelDxf), computes the 2D merge placement, and runs the
 * pre-merge edge-alignment check — rejecting if panel A and B are too far
 * apart to share a bend edge, or auto-correcting with close_gap if the gap
 * is small enough to be unintentional misalignment rather than a real design
 * gap (BUG-03 / T017-T019).
 */
function prepareMergePanelFrames(
  partAId: string,
  partBId: string,
  panelNodeA: PanelNode,
  panelNodeB: PanelNode,
  shapeDxfA: string,
  shapeDxfB: string,
  shellAId: BodyId,
  shellBId: BodyId,
): PreparedMergePanels {
  let frameA = ensurePanelFrame(panelNodeA, 'part_a');
  let frameB = ensurePanelFrame(panelNodeB, 'part_b');

  // Fixes chirality (mirrors if cross(u,v) points away from the other panel)
  // and normalizes the DXF origin to (0,0) for both panels — see
  // mirrorAndNormalizePanelDxf's own doc comment for why both steps are
  // needed before any later computation (foldAlongU_A/B, frameADxf,
  // computeBendAlignedFrame, panelADxfForMerge/panelBDxfForMerge, ...) can
  // assume "frame.normal points toward the other panel" and "the DXF
  // already starts at (0,0)". Each panel's chirality is an independent
  // coin-flip from getPanelFrame's own U/V tie-break — not correlated with
  // the other panel's — so both need the check separately.
  const mirroredA = mirrorAndNormalizePanelDxf(shapeDxfA, frameA, shellAId as string, shellBId as string);
  const effectiveShapeDxfA = mirroredA.shapeDxf;
  frameA = mirroredA.frame;

  const mirroredB = mirrorAndNormalizePanelDxf(shapeDxfB, frameB, shellBId as string, shellAId as string);
  const effectiveShapeDxfB = mirroredB.shapeDxf;
  frameB = mirroredB.frame;

  const contactToleranceMm = Math.max(panelNodeA.nominalThickness, panelNodeB.nominalThickness) * 2.5;
  const placement = computeDxfMergePlacement(frameA, frameB, { contactToleranceMm });

  // ── T017/FR-003: BUG-03 — Edge alignment check BEFORE DXF merge ─────────────
  // Measure the minimum distance between the two panel shells. If the gap
  // exceeds MERGE_EDGE_ALIGNMENT_TOLERANCE_MM, the merge cannot proceed
  // (the panels are not close enough to share a bend edge). Return a structured
  // error with the measured offset so the user can correct it.
  // If within tolerance, auto-correct using closeGap.
  let edgeAlignmentCorrectionMm: number | null = null;
  let resolvedShellBId = shellBId;
  {
    const gapReport = getGeometryBinding().computeGaps(
      shellAId as string, resolvedShellBId as string,
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
        const gapResult = getGeometryBinding().closeGap(shellAId as string, resolvedShellBId as string);
        edgeAlignmentCorrectionMm = gapResult.gapClosedMm;
        // Update panelNodeB's bodyId to the translated shell and capture the new shellBId
        resolvedShellBId = gapResult.partBId as BodyId;
        panelNodeB.bodyId = resolvedShellBId;
        session.registerShell(resolvedShellBId);
      } catch {
        // closeGap failed — continue without correction, merge may still succeed
        edgeAlignmentCorrectionMm = measuredOffsetMm;
      }
    }
  }

  return {
    frameA, frameB, effectiveShapeDxfA, effectiveShapeDxfB, placement,
    contactToleranceMm, edgeAlignmentCorrectionMm, shellBId: resolvedShellBId,
  };
}

interface BendGeometry {
  normalsNearlyParallel: boolean;
  foldAlongU_A: boolean;
  foldAlongU_B: boolean;
  bboxA3d: import('../../geometry/types').BoundingBoxResult;
  bboxB3d: import('../../geometry/types').BoundingBoxResult;
  foldAxisVec: [number, number, number];
  foldAxisNorm: number;
  /** Exact bend-aligned frame/content for panel A — null for coplanar or chained merges (see skipBendAlignedFrame). */
  frameAAligned: ReturnType<typeof computeBendAlignedFrame> | null;
  /** Exact bend-aligned frame/content for panel B — null for coplanar or chained merges (see skipBendAlignedFrame). */
  frameBAligned: ReturnType<typeof computeBendAlignedFrame> | null;
  /** Always the OLD computeDxfAlignedFrame convention — what gets persisted onto the resulting graph nodes' panelFrame. */
  frameADxfForGraph: PanelFrame;
  frameBDxfForGraph: PanelFrame;
  bendDirSimple: [number, number, number];
  foldNormalSimple: [number, number, number];
  anchorPointSimple: [number, number, number];
  bendDirPayload: [number, number, number];
  foldNormalPayload: [number, number, number];
  anchorPoint: [number, number, number];
  actualYDir: [number, number, number];
  kFactorDefault: number;
  bendAngle: number;
  thickness: number;
  /** Bend allowance (mm). */
  ba: number;
  priorBendDirAligned: boolean;
  /** Panel B's normalized outward normal (sign arbitrary from the cross product — every use is sign-independent by construction). */
  nBu: [number, number, number];
}

/**
 * Computes everything about the bend ITSELF — fold axis/angle/direction,
 * each panel's exact bend-aligned flat-pattern frame (or the graceful
 * fallback for coplanar/chained merges), and the world-space placement
 * basis (bendDirPayload/foldNormalPayload/anchorPoint) the C++ rebuild call
 * and the persisted BendNode both need. Independent of how the two panels'
 * flat patterns then get bridged together into one merged DXF — see
 * buildMergedFlatPattern, which consumes this.
 */
function computeBendGeometry(
  frameA: PanelFrame,
  frameB: PanelFrame,
  effectiveShapeDxfA: string,
  effectiveShapeDxfB: string,
  shellAId: BodyId,
  shellBId: BodyId,
  panelNodeA: PanelNode,
  panelNodeB: PanelNode,
  isChainedMerge: boolean,
  priorBendNodeA: BendNode | undefined,
  bendRadiusMm: number,
): BendGeometry {
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
  // For a CHAINED merge this initial value gets OVERRIDDEN below, right
  // after bendDir is known — see that override's own comment for why a
  // frame-based comparison doesn't even apply in that case.
  let foldAlongU_A = dotFoldWithU > dotFoldWithV;

  // Same check for Panel B's frame — used to re-orient Panel B's DXF in the merged flat pattern.
  const dotFoldWithU_B = (foldAxisNorm > 1e-6 && frameB)
    ? Math.abs(foldAxisVec[0] * frameB.u[0] + foldAxisVec[1] * frameB.u[1] + foldAxisVec[2] * frameB.u[2]) / foldAxisNorm
    : 0;
  const dotFoldWithV_B = (foldAxisNorm > 1e-6 && frameB)
    ? Math.abs(foldAxisVec[0] * frameB.v[0] + foldAxisVec[1] * frameB.v[1] + foldAxisVec[2] * frameB.v[2]) / foldAxisNorm
    : 0;
  const foldAlongU_B = dotFoldWithU_B > dotFoldWithV_B;

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

  // Zero out dAB's component along the fold/seam axis (cross(nA, nB)). dAB only
  // exists to derive bendDir/foldNormal/the dihedral angle — the fold direction
  // and angle of a straight bend line are, physically, entirely independent of
  // where along that line the two panels sit (a 90° corner is 90° regardless of
  // how far the bend extends or whether the panels are flush at one end). Using
  // the raw full-bbox centroid difference leaks a spurious seam-axis component
  // into dAB whenever panel A is a fused/composite shape (e.g. a wall with an
  // attached protrusion tab extending its bbox along the seam) — its centroid
  // shifts away from the true shared edge with B even though that shift has
  // nothing to do with the fold direction, tilting bendDir and skewing the
  // computed dihedral angle away from the panels' true 90°. Removing the
  // seam-axis component entirely (rather than trying to compute a "corrected"
  // replacement value) sidesteps any sign ambiguity in the cross product.
  if (foldAxisNorm > 1e-6) {
    const foldUnit: [number, number, number] = [
      foldAxisVec[0] / foldAxisNorm, foldAxisVec[1] / foldAxisNorm, foldAxisVec[2] / foldAxisNorm,
    ];
    const seamComponent = dAB[0] * foldUnit[0] + dAB[1] * foldUnit[1] + dAB[2] * foldUnit[2];
    dAB[0] -= seamComponent * foldUnit[0];
    dAB[1] -= seamComponent * foldUnit[1];
    dAB[2] -= seamComponent * foldUnit[2];
  }

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

  // For a CHAINED merge (Panel A is itself an earlier merge_bodies_with_bend
  // result), whether this NEW bend needs to rotate effectiveShapeDxfA isn't
  // a question frameA (=panelNodeA's own panelFrame) can answer at all:
  // because the prior merge's canonical-node id is partAId itself (nodeBId
  // = toNodeId(partAId)), frameA here is actually that prior call's PANEL
  // B's frame — describing a DIFFERENT plane (panel A's immediate neighbour
  // in the chain) than whatever "Panel A's own content axes" would mean for
  // the combined, multi-segment flat pattern. Comparing the new fold's axis
  // against frameA.u/v (the original dotFoldWithU/V above) answers a
  // question about the wrong plane.
  //
  // The robust check instead: does THIS merge's own fold AXIS (foldAxisVec —
  // the hinge LINE direction, i.e. cross(nA,nB), computed above) run
  // parallel to the PRIOR merge's own fold axis? NOT bendDir — bendDir is
  // the IN-PLANE "across the panel, toward the bend" direction, which
  // legitimately rotates from segment to segment even along a perfectly
  // straight channel (e.g. a U-channel's two walls are both perpendicular
  // to the floor, so each wall's own "toward the bend" direction points a
  // different way, even though both bend LINES run the same direction down
  // the channel's length) — confirmed empirically: comparing bendDir against
  // priorBendNodeA.bendDir for a real U-channel gave a 0 dot product
  // (perpendicular), incorrectly refusing a case that should be supported.
  // The fold AXIS (the hinge line itself), by contrast, genuinely IS the
  // same line for every bend along a straight channel. The prior merge's
  // own fold axis is recoverable from its persisted placement basis as
  // foldNormal × bendDir (= local Y, the C++ build's hinge-rotation axis,
  // in world terms — see actualYDir's identical formula above).
  const priorFoldAxis: [number, number, number] | null = (priorBendNodeA?.foldNormal && priorBendNodeA.bendDir)
    ? [
        priorBendNodeA.foldNormal[1] * priorBendNodeA.bendDir[2] - priorBendNodeA.foldNormal[2] * priorBendNodeA.bendDir[1],
        priorBendNodeA.foldNormal[2] * priorBendNodeA.bendDir[0] - priorBendNodeA.foldNormal[0] * priorBendNodeA.bendDir[2],
        priorBendNodeA.foldNormal[0] * priorBendNodeA.bendDir[1] - priorBendNodeA.foldNormal[1] * priorBendNodeA.bendDir[0],
      ]
    : null;
  const priorFoldAxisNorm = priorFoldAxis ? Math.hypot(priorFoldAxis[0], priorFoldAxis[1], priorFoldAxis[2]) : 0;
  const priorBendDirAligned = (priorFoldAxis && priorFoldAxisNorm > 1e-6 && foldAxisNorm > 1e-6)
    ? Math.abs(dot3(foldAxisVec, priorFoldAxis)) / (foldAxisNorm * priorFoldAxisNorm) > 0.99
    : false;
  // Only the ALIGNED (parallel-fold-line) case gets the more accurate
  // multi-zone treatment below — reusing the prior merge's basis as-is
  // requires Panel A's content to stay unrotated for THIS merge.
  // Deliberately NOT a hard refusal when unaligned (a cube-corner-style
  // chain, not a straight channel): merge_bodies_with_bend already
  // supported chaining onto a perpendicular-fold composite before today's
  // fix (treating Panel A's prior content as one flat, unbent rectangle —
  // see the existing single-zone path below, taken whenever priorZone ends
  // up empty) — confirmed still relied on by
  // unfold_roundtrip.integration.test.ts's CASE 2 (3 mutually-perpendicular
  // cube faces), which only asserts the merge succeeds, not that the
  // result's 3D position is exact. Refusing outright would regress an
  // already-shipped, already-tested capability; this fix only ADDS
  // correctness for the case it can actually solve (parallel chains),
  // leaving the perpendicular case exactly as it was.
  if (isChainedMerge && priorBendDirAligned) {
    foldAlongU_A = false;
  }

  // DXF-aligned frames for both panels, computed early (everything they need
  // is already available) so the seam-offset calculation below can use the
  // ACTUAL placement basis instead of guessing at it from raw 3D bboxes.
  //
  // For the true bend case, align +X EXACTLY to bendDir/gBtoBody (see
  // computeBendAlignedFrame's own doc comment) instead of
  // computeDxfAlignedFrame's 0°-or-90° approximation — the two are
  // numerically identical for a rectangular panel (bendDir is then exactly
  // ±u or ±v already), but only the exact version is correct for a
  // non-rectangular panel (e.g. a skewed quad facet), where neither stored
  // axis is generally perpendicular to the true shared edge.
  //
  // The coplanar branch below (normalsNearlyParallel && flatWidth === null)
  // never reads frameADxf/frameBDxf for its own placement decision (it uses
  // `placement` from computeDxfMergePlacement instead) — kept on the old,
  // unconditional computeDxfAlignedFrame path regardless, since bendDir's
  // "toward the bend" meaning doesn't cleanly apply without an actual fold
  // axis, and this avoids changing behavior for an already-validated case
  // this fix isn't targeting.
  // Also skip for a chained merge: dAB (bendDir/gBtoBody's basis) is derived
  // from panel A's FULL shell bbox — for a chained merge that bbox covers
  // the whole existing composite (e.g. an L-shaped bracket from a prior
  // bend), not just the immediate-neighbour sub-panel frameA actually
  // describes. That mismatch can make the "toward the bend" signal
  // genuinely degenerate (confirmed: both a parallel-chain and a
  // perpendicular-chain case hit this, so it's not corner-specific). Chained
  // merges already have their own separate, validated placement mechanism
  // (priorBendNodeA reuse when aligned; graceful single-zone fallback
  // otherwise — see isChainedMerge's other uses below) that this fix isn't
  // targeting — defer to the existing computeDxfAlignedFrame path unchanged.
  const skipBendAlignedFrame = isChainedMerge || (normalsNearlyParallel && panelNodeA.flatWidth === null);
  const frameAAligned = skipBendAlignedFrame ? null : computeBendAlignedFrame(
    effectiveShapeDxfA, frameA, bendDir,
    { flatWidth: panelNodeA.flatWidth, flatHeight: panelNodeA.flatHeight },
  );
  const frameBAligned = skipBendAlignedFrame ? null : computeBendAlignedFrame(
    effectiveShapeDxfB, frameB, gBtoBody,
    { flatWidth: panelNodeB.flatWidth, flatHeight: panelNodeB.flatHeight },
  );
  const frameADxf = frameAAligned ? frameAAligned.alignedFrame : computeDxfAlignedFrame(frameA, panelNodeA.flatWidth ?? 0, foldAlongU_A);
  // What gets PERSISTED onto the resulting graph nodes' own panelFrame is
  // intentionally always the OLD computeDxfAlignedFrame convention, even
  // when frameADxf above used the new bend-aligned one for THIS merge's
  // own placement (panel B's own placement/content never reads a "frameBDxf"
  // at all — only frameADxf feeds anchorPointSimple/xAgreesDxf below). A
  // future chained merge reads the canonical
  // node's panelFrame back as ITS OWN frameA — computeBendAlignedFrame's
  // convention (B's axis always pointing away from the bend) isn't
  // guaranteed to match what computeDxfAlignedFrame would have produced
  // (confirmed: a real cube-corner chain's panel B came out with the exact
  // opposite axis direction and a different origin between the two), and
  // the chain-reuse logic (priorBendDirAligned, priorZone, etc.) was built
  // and validated entirely against the old convention. Keeping the
  // persisted frame on the old convention regardless of which one placed
  // THIS merge avoids redesigning that separate, already-validated
  // mechanism — chained merges already skip computeBendAlignedFrame
  // entirely (skipBendAlignedFrame above), so this only matters for
  // whatever a LATER merge might chain onto, not this one's own placement.
  const frameADxfForGraph = computeDxfAlignedFrame(frameA, panelNodeA.flatWidth ?? 0, foldAlongU_A);
  const frameBDxfForGraph = computeDxfAlignedFrame(frameB, panelNodeB.flatWidth ?? 0, foldAlongU_B);

  // Placement basis (see the long derivation at the buildShellFromFlatPattern
  // call site, where bendDirPayload/foldNormalPayload/anchorPoint feed the
  // C++ payload). bendDirPayload is ALWAYS the true physical bendDir (never
  // flipped to match frameADxf.u — getPanelFrame's U/V tie-break has no
  // relationship to bendDir, especially for a symmetric panel A where the
  // tie-break is arbitrary either way). The merge always attaches the bend
  // zone — and Panel B — AFTER Panel A's own content in DXF-local terms (at
  // local x=effectiveAFlatWidth), which only lands on A's TRUE hinge edge in
  // world space if local x=0 (frameADxf.origin) is A's FAR (non-hinge)
  // corner. When bendDir disagrees with frameADxf.u, frameADxf.origin is
  // actually the NEAR (hinge) corner instead — shift the anchor to the
  // diagonally-opposite (far) corner of A's content (origin + W*u + H*v) so
  // local x=effectiveAFlatWidth still lands back exactly on frameADxf.origin,
  // the real hinge. Both W (fold-perpendicular) and H (fold-parallel) extents
  // are needed: flipping the X axis (bendDirPayload vs frameADxf.u) FORCES
  // local-Y's effective world direction to flip too (Y is mechanically Z×X;
  // Z=foldNormalPayload never flips, so flipping X flips Y as an unavoidable
  // side effect of keeping a valid right-handed basis) — shifting the anchor
  // by W alone fixes only the X axis, leaving Panel A's content shifted a
  // full H off to the wrong side along the seam axis instead of correctly
  // reflected within its own footprint. (An earlier attempt fixed the X-only
  // case by 180°-rotating Panel A's own DXF content/frame instead of
  // adjusting the placement anchor — mathematically valid for the merge's
  // own placement, but it altered the merged 3D shell's geometry in a way
  // that broke an unrelated, independent unfoldShell re-derivation
  // downstream; this anchor-only fix changes nothing about Panel A's actual
  // shape or content, only the placement transform.)
  // W must match whatever effectiveAFlatWidth (computed later, in the
  // bend-case branch below) will actually use — since the bridge/translation
  // placement that the anchor has to stay consistent with is keyed off THAT
  // value, not an independently re-derived one. (An earlier version of this
  // fix used effectiveShapeDxfA's raw DXF bbox unconditionally, reasoning
  // that "a plain panel's DXF bbox already agrees with its stored
  // flatWidth/flatHeight" — false in practice: even a plain split panel's
  // raw DXF bbox can differ from its graph-stored flatWidth by a couple mm,
  // e.g. from neutral-axis/thickness accounting.) H is the analogous
  // fold-PARALLEL extent, which effectiveAFlatWidth never needed before this
  // fix — derived the same way: panelNodeA's OTHER stored dimension.
  //
  // For a CHAINED merge whose new fold ISN'T parallel to Panel A's own prior
  // one (priorBendDirAligned false, below — the cube-corner case, which
  // falls back to treating Panel A's content as one flat rectangle).
  // panelNodeA.flatWidth/flatHeight store only the LAST individual panel's
  // own extent, not the cumulative combined flat pattern's — the actual DXF
  // content is the only reliable ground truth (same reasoning as
  // effectiveAFlatWidth's own isChainedMerge override, just needed here too
  // since this anchor-shift computation runs before that point). When the
  // ALIGNED case applies instead, this is moot — see the isChainedMerge
  // branch below, which replaces the whole placement basis with values
  // reused directly from the prior merge and never reads these.
  const aDxfBboxForAnchor = isChainedMerge ? (() => {
    try {
      const ring = parseFirstClosedPolyline(effectiveShapeDxfA);
      let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
      let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
      for (const [x, y] of ring) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
      const w = xMax - xMin, h = yMax - yMin;
      return w > 0 && h > 0 ? { w, h } : null;
    } catch { return null; }
  })() : null;
  const aFlatWidthForAnchor = aDxfBboxForAnchor
    ? (foldAlongU_A ? aDxfBboxForAnchor.h : aDxfBboxForAnchor.w)
    : ((foldAlongU_A && panelNodeA.flatHeight !== null) ? panelNodeA.flatHeight : (panelNodeA.flatWidth ?? 0));
  const aFlatHeightForAnchor = aDxfBboxForAnchor
    ? (foldAlongU_A ? aDxfBboxForAnchor.w : aDxfBboxForAnchor.h)
    : ((foldAlongU_A && panelNodeA.flatHeight !== null) ? (panelNodeA.flatWidth ?? 0) : (panelNodeA.flatHeight ?? 0));
  const xAgreesDxf = dot3(bendDir, frameADxf.u) >= 0;

  // A CHAINED merge (Panel A is itself an earlier merge_bodies_with_bend
  // result) needs an entirely different placement basis. The "is
  // frameADxf.u the content's own fold-perpendicular axis" question that
  // xAgreesDxf/the anchor-shift above answer for a SIMPLE panel doesn't even
  // apply: frameADxf is derived from frameA = panelNodeA's own panelFrame,
  // which — because the prior merge's canonical-node id is partAId itself
  // (nodeBId = toNodeId(partAId), see the prior call) — is actually that
  // prior call's PANEL B's frame, describing where PANEL B's own local
  // (0,0) sits, which is OFFSET from the combined flat pattern's TRUE local
  // (0,0) by exactly that prior merge's own (effectiveAFlatWidth+ba,
  // seamYOffset) placement shift. Re-deriving a correct content frame from
  // graph data (tried: substituting the prior merge's non-canonical
  // "panel-a-..." node's frame for frameA) doesn't work either — bendDir is
  // computed relative to panel A's IMMEDIATE neighbour in the chain (the
  // prior merge's Panel B — physically the side actually touching the NEW
  // Panel B), not its root, so frameADxf (content-rooted) and bendDir
  // (immediate-neighbour-rooted) end up describing DIFFERENT planes —
  // comparing them via xAgreesDxf no longer has the clean
  // parallel/antiparallel meaning that check assumes for a simple panel.
  //
  // The robust fix: skip re-deriving the content's coordinate system from
  // frames entirely. The prior merge ALREADY computed and persisted
  // (BendNode.bendDir/foldNormal/anchor) the exact world directions/origin
  // its own local+X/+Z/(0,0,0) mapped to — and because this merge's new
  // bend zone is placed AFTER all of Panel A's existing content along that
  // SAME established local-X (Panel A's content is never moved or
  // re-rotated by adding a new bend zone past its far end), those same
  // values are STILL exactly correct for this merge's placement. Reuse them
  // directly instead of recomputing anything frame-based. priorBendDirAligned
  // was already computed above (and used there to refuse the unsupported
  // perpendicular-fold case) — reused here verbatim.
  // "As if this were a simple (non-chained) merge" placement basis — i.e.
  // exactly what bendDirPayload/foldNormalPayload/anchorPoint computed
  // before this whole chained-merge investigation. Still needed even when
  // chained: the hinge-offset calculation below (bHingeOffsetMm) finds
  // where THIS NEW bend's true hinge sits inside Panel B's own flat
  // pattern, by walking from an anchor KNOWN to sit exactly at THIS bend's
  // own attachment point, along THIS bend's own true direction, until it
  // hits B's plane. anchorPoint/bendDirPayload (below, chain-aware) describe
  // the COMBINED assembly's local origin/X-axis, which for a chained merge
  // is rooted at panel A's distant root (ghost), not at this specific new
  // bend at all — walking from there along the chain's established
  // direction does not reach Panel B's plane in any geometrically
  // meaningful way (confirmed: it degenerates to "parallel to B's plane",
  // the formula's own degenerate fallback, producing a wildly wrong offset
  // for a real 3-panel chain repro). These "simple" values are always
  // correctly rooted at THIS merge's own bend, chained or not.
  const bendDirSimple: [number, number, number] = bendDir;
  const foldNormalSimple: [number, number, number] = foldNormal;
  const anchorPointSimple: [number, number, number] = xAgreesDxf
    ? [...frameADxf.origin]
    : [
        frameADxf.origin[0] + aFlatWidthForAnchor * frameADxf.u[0] + aFlatHeightForAnchor * frameADxf.v[0],
        frameADxf.origin[1] + aFlatWidthForAnchor * frameADxf.u[1] + aFlatHeightForAnchor * frameADxf.v[1],
        frameADxf.origin[2] + aFlatWidthForAnchor * frameADxf.u[2] + aFlatHeightForAnchor * frameADxf.v[2],
      ];
  const bendDirPayload: [number, number, number] = (isChainedMerge && priorBendDirAligned && priorBendNodeA?.bendDir)
    ? priorBendNodeA.bendDir
    : bendDirSimple;
  const foldNormalPayload: [number, number, number] = (isChainedMerge && priorBendDirAligned && priorBendNodeA?.foldNormal)
    ? priorBendNodeA.foldNormal
    : foldNormalSimple;
  const anchorPoint: [number, number, number] = (isChainedMerge && priorBendDirAligned && priorBendNodeA?.anchor)
    ? priorBendNodeA.anchor
    : anchorPointSimple;
  const actualYDir: [number, number, number] = [
    foldNormalPayload[1] * bendDirPayload[2] - foldNormalPayload[2] * bendDirPayload[1],
    foldNormalPayload[2] * bendDirPayload[0] - foldNormalPayload[0] * bendDirPayload[2],
    foldNormalPayload[0] * bendDirPayload[1] - foldNormalPayload[1] * bendDirPayload[0],
  ];

  const kFactorDefault = 0.33;
  // Use the real dihedral; guard against degenerate (near-0/near-180) folds, falling
  // back to 90° only when the geometry could not yield a sensible angle.
  const bendAngle = (Number.isFinite(computedFoldDeg) && computedFoldDeg > 1 && computedFoldDeg < 179)
    ? computedFoldDeg
    : 90;
  const thickness = panelNodeA?.nominalThickness > 0 ? panelNodeA.nominalThickness : (panelNodeB?.nominalThickness ?? 1.0);
  const ba = computeBendAllowance(bendAngle, bendRadiusMm, kFactorDefault, thickness);

  return {
    normalsNearlyParallel, foldAlongU_A, foldAlongU_B, bboxA3d, bboxB3d,
    foldAxisVec, foldAxisNorm, frameAAligned, frameBAligned,
    frameADxfForGraph, frameBDxfForGraph,
    bendDirSimple, foldNormalSimple, anchorPointSimple,
    bendDirPayload, foldNormalPayload, anchorPoint, actualYDir,
    kFactorDefault, bendAngle, thickness, ba, priorBendDirAligned, nBu,
  };
}

interface MergedFlatPattern {
  mergedDxf: string | null;
  mergedFlatWidth: number | null;
  mergedFlatHeight: number | null;
  /** Panel A's extent along its own exact bend-aligned (or fallback) X axis. */
  effectiveAFlatWidth: number;
  /** Panel B's extent along its own exact bend-aligned (or fallback) X axis. */
  effectiveBFlatWidth: number;
  /** Seam-axis (Y) offset panel B is placed at within the merged flat pattern. */
  seamYOffset: number;
}

/**
 * Builds the merged flat pattern: classifies coplanar-vs-bend placement,
 * derives each panel's fold-perpendicular extent and the seam-axis offset
 * panel B sits at, then unions panel A + an explicit bend-allowance bridge
 * rectangle + panel B into one DXF outline (the merge's actual source of
 * truth — see bendZoneBridgeDxf's own comment for why an explicit bridge
 * instead of relying on mergeDxfOutlines's gap-nudge).
 */
function buildMergedFlatPattern(
  panelNodeA: PanelNode,
  panelNodeB: PanelNode,
  effectiveShapeDxfA: string,
  effectiveShapeDxfB: string,
  placement: MergePlacement2D,
  contactToleranceMm: number,
  isChainedMerge: boolean,
  bend: BendGeometry,
): MergedFlatPattern {
  const {
    normalsNearlyParallel, bboxA3d, bboxB3d, frameAAligned, frameBAligned,
    foldAlongU_A, foldAlongU_B, foldAxisVec, foldAxisNorm, actualYDir,
    anchorPoint, ba, kFactorDefault, thickness,
  } = bend;

  let effectiveAFlatWidth = 0;
  let effectiveBFlatWidth = 0;
  let rotationMatrix: [[number, number], [number, number]];
  let translation: [number, number];
  let seamYOffset = 0;
  // Overlap used to guarantee robust polygon-union connectivity at each seam
  // (touching-but-not-overlapping edges can register as disconnected under
  // floating-point noise). Derived from the neutral-axis offset (kFactor *
  // thickness) rather than a fixed constant, so it scales with the panel's
  // actual material properties instead of an arbitrary magic number.
  const MERGE_OVERLAP_MM = kFactorDefault * thickness;

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
    // effectiveAFlatWidth/effectiveBFlatWidth: each panel's extent along its
    // OWN exact bend-aligned X axis (frameAAligned/frameBAligned — see
    // computeBendAlignedFrame). This is the panel's actual flat-pattern
    // content extent up to its true shared edge with the other panel,
    // correct for ANY panel shape — a strict improvement over the old
    // foldAlongU_A-gated flatWidth/flatHeight lookup, which is only valid
    // for a rectangle (where the fold is necessarily parallel to one stored
    // axis).
    //
    // For a chained merge, frameAAligned/frameBAligned are null (see
    // skipBendAlignedFrame above) — fall back to the pre-existing
    // foldAlongU_A-gated lookup plus its own chained-merge DXF-bbox override
    // (panelNodeA.flatWidth only stores the LAST panel's own extent for a
    // chained merge, not the cumulative combined width), unchanged from
    // before this fix.
    if (frameAAligned && frameBAligned) {
      effectiveAFlatWidth = frameAAligned.flatExtentMm;
      effectiveBFlatWidth = frameBAligned.flatExtentMm;
    } else {
      effectiveAFlatWidth = (foldAlongU_A && panelNodeA.flatHeight !== null)
        ? panelNodeA.flatHeight
        : (panelNodeA.flatWidth ?? 0);
      effectiveBFlatWidth = (foldAlongU_B && panelNodeB.flatHeight !== null)
        ? panelNodeB.flatHeight
        : (panelNodeB.flatWidth ?? 0);
      if (isChainedMerge && effectiveShapeDxfA) {
        try {
          const tmpRing = parseFirstClosedPolyline(effectiveShapeDxfA);
          let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
          let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
          for (const [x, y] of tmpRing) {
            if (x < xMin) xMin = x; if (x > xMax) xMax = x;
            if (y < yMin) yMin = y; if (y > yMax) yMax = y;
          }
          const dxfW = xMax - xMin;
          const dxfH = yMax - yMin;
          if (dxfW > 0 && dxfH > 0) effectiveAFlatWidth = foldAlongU_A ? dxfH : dxfW;
        } catch { /* keep computed value on parse failure */ }
      }
    }
    rotationMatrix = [[1, 0], [0, 1]];
    // Place panel B after the bend zone in flat pattern space.
    // X translation: panel B starts after panel A's fold-perpendicular extent + bend allowance.
    // Y translation: seam-axis offset, chosen so panel B's OWN true 3D
    // seam-axis range (rangeB, from its live bbox — never panel B's DXF
    // frame, which only describes B in isolation and isn't validated against
    // A's actual position) lands correctly once mapped through anchorPoint +
    // actualYDir, the SAME basis the whole merged pattern's placement uses.
    //
    // The previous formula compared raw bbox-min projections for BOTH panels
    // (rangeB.min - rangeA.min, with a containment shortcut for composite
    // panels). That broke whenever computeDxfAlignedFrame's rotation
    // (foldAlongU_A) was in effect: the rotation moves panel A's own local
    // (0,0) — anchorPoint — to a DIFFERENT corner of its range than
    // rangeA.min assumed (confirmed: off by exactly panel A's full seam-axis
    // extent whenever the composite/fused side's appendage is what triggers
    // the rotation). Using anchorPoint directly (the ACTUAL reference point,
    // already correct for panel A's own placement) instead of re-deriving it
    // from rangeA sidesteps that blind spot entirely, and folds the
    // containment shortcut in naturally: aligning B's bbox-min-or-max
    // (whichever actualYDir's sign says corresponds to local Y=0) with
    // anchorPoint reduces to the old "offset=0" case exactly when
    // anchorPoint already sits at that point, with no separate check needed.
    const seamOffset = foldAxisNorm > 1e-6
      ? (() => {
          const seamUnit: [number, number, number] = [
            foldAxisVec[0] / foldAxisNorm, foldAxisVec[1] / foldAxisNorm, foldAxisVec[2] / foldAxisNorm,
          ];
          const actualYDirSeamProj = dot3(actualYDir, seamUnit);
          if (Math.abs(actualYDirSeamProj) < 1e-6) return 0; // degenerate: actualYDir ⟂ seam axis
          const projectBboxRange = (b: typeof bboxA3d): { min: number; max: number } => {
            const axes: Array<[number, number, number]> = [
              [b.x_min, b.x_max, seamUnit[0]],
              [b.y_min, b.y_max, seamUnit[1]],
              [b.z_min, b.z_max, seamUnit[2]],
            ];
            let min = 0, max = 0;
            for (const [lo, hi, a] of axes) {
              if (a >= 0) { min += lo * a; max += hi * a; }
              else { min += hi * a; max += lo * a; }
            }
            return { min, max };
          };
          const rangeB = projectBboxRange(bboxB3d);
          const target = actualYDirSeamProj > 0 ? rangeB.min : rangeB.max;
          const anchorSeamProj = dot3(anchorPoint, seamUnit);
          return (target - anchorSeamProj) / actualYDirSeamProj;
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

  // For the bend case, use the already-computed exact bend-aligned DXF
  // directly (frameAAligned/frameBAligned — DXF X is already exactly
  // bendDir/gBtoBody, and the polygon is already normalized to start at
  // (0,0)). The coplanar branch never set frameAAligned/frameBAligned (see
  // their computation above) — fall back to the old foldAlongU_A-gated
  // 90°-or-not rotation for that case, unchanged.
  const panelADxfForMerge: string = frameAAligned
    ? frameAAligned.alignedDxf
    : (effectiveShapeDxfA
        ? (foldAlongU_A ? rotateDxf90(normalizeDxfOrigin(effectiveShapeDxfA)) : normalizeDxfOrigin(effectiveShapeDxfA))
        : '');
  const panelBDxfForMerge: string = frameBAligned
    ? frameBAligned.alignedDxf
    : (effectiveShapeDxfB
        ? (foldAlongU_B ? rotateDxf90(normalizeDxfOrigin(effectiveShapeDxfB)) : normalizeDxfOrigin(effectiveShapeDxfB))
        : '');
  // The flat-pattern gap between Panel A's rectangle and Panel B's placed
  // rectangle is the bend-allowance zone (width = ba): real, continuous sheet
  // material in the unfolded flat pattern, not empty space. mergeDxfOutlines's
  // gap-nudge (meant to auto-correct small UNINTENTIONAL misalignments, per the
  // "misalignment less than panel thickness gets adjusted" rule) cannot tell
  // this deliberate ba-wide gap apart from one of those — and silently
  // collapses it, shrinking Panel B's reconstructed length by ~ba. Bridging the
  // gap with an explicit bend-allowance rectangle keeps A/bridge/B contiguous
  // (overlapping by MERGE_OVERLAP_MM at each seam) so the union always connects
  // on its own, without ever invoking the nudge.
  // The bend zone only physically exists where A and B actually share the
  // fold edge — the INTERSECTION of their own seam-axis (Y) extents, not the
  // union. A composite/fused panel A (e.g. a wall with an attached
  // protrusion extending past the seam) can be WIDER than B along this
  // axis — the protrusion sticks out past B's own edge and has no
  // continuation on B's side at all. Using the union here let that extra
  // width leak into the bridge rectangle; once unioned with B's own
  // (correctly-sized) rectangle next, B's reconstructed region appeared to
  // inherit A's full extra width (e.g. showing 174mm instead of its own
  // 150mm) — exactly the user-reported "top panel extends to 174x150
  // instead of 150x150" bug. Falls back to the union only if A and B don't
  // overlap along the seam at all (a degenerate case that shouldn't
  // normally arise for a real bend, but avoids ever building a
  // zero/negative-height bridge).
  const bridgeYRange = (() => {
    const ringAForBridge = parseFirstClosedPolyline(panelADxfForMerge);
    const ringBForBridge = parseFirstClosedPolyline(panelBDxfForMerge);
    let yMinA = Infinity, yMaxA = -Infinity, yMinB = Infinity, yMaxB = -Infinity;
    for (const [, y] of ringAForBridge) { yMinA = Math.min(yMinA, y); yMaxA = Math.max(yMaxA, y); }
    for (const [, y] of ringBForBridge) { yMinB = Math.min(yMinB, y); yMaxB = Math.max(yMaxB, y); }
    const yMinBShifted = yMinB + seamYOffset;
    const yMaxBShifted = yMaxB + seamYOffset;
    const intersectMin = Math.max(yMinA, yMinBShifted);
    const intersectMax = Math.min(yMaxA, yMaxBShifted);
    if (intersectMax > intersectMin) {
      return { min: intersectMin, max: intersectMax };
    }
    return {
      min: Math.min(yMinA, yMinBShifted),
      max: Math.max(yMaxA, yMaxBShifted),
    };
  })();
  const bendZoneBridgeDxf = ringToLwpolylineDxf([
    [effectiveAFlatWidth - MERGE_OVERLAP_MM, bridgeYRange.min],
    [effectiveAFlatWidth + ba + MERGE_OVERLAP_MM, bridgeYRange.min],
    [effectiveAFlatWidth + ba + MERGE_OVERLAP_MM, bridgeYRange.max],
    [effectiveAFlatWidth - MERGE_OVERLAP_MM, bridgeYRange.max],
  ]);

  let preflightMerge: ReturnType<typeof mergeDxfOutlines>;
  try {
    const identityPlacement = { rotationMatrix: [[1, 0], [0, 1]] as [[number, number], [number, number]], translation: [0, 0] as [number, number] };
    const aPlusBridge = mergeDxfOutlines(panelADxfForMerge, bendZoneBridgeDxf, identityPlacement);
    preflightMerge = mergeDxfOutlines(aPlusBridge.mergedDxf, panelBDxfForMerge, {
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

  return {
    mergedDxf: preflightMerge.mergedDxf,
    mergedFlatWidth: preflightMerge.metrics.bbox.width,
    mergedFlatHeight: preflightMerge.metrics.bbox.height,
    effectiveAFlatWidth, effectiveBFlatWidth, seamYOffset,
  };
}

function computeDxfAlignedFrame(frame: PanelFrame, uExtentMm: number, isRotated: boolean): PanelFrame {
  if (!isRotated) return frame;

  // isRotated=true: DXF was rotated 90° CCW so fold-perp → DXF+X, neg fold-parallel → DXF+Y.
  // The point at DXF(0,0) is the corner: frame.origin + uExtentMm * frame.u.
  const [ox, oy, oz] = frame.origin;
  const [ux, uy, uz] = frame.u;
  const [vx, vy, vz] = frame.v;
  return {
    origin: [ox + uExtentMm * ux, oy + uExtentMm * uy, oz + uExtentMm * uz],
    u: [vx, vy, vz],
    v: [-ux, -uy, -uz],
    // Swapping u→v, v→-u preserves u×v (cross(v,-u) = cross(u,v)), so the
    // panel's actual normal is unchanged by this rotation — carry it through
    // rather than letting it silently become undefined.
    normal: frame.normal,
  };
}

/**
 * Re-express a panel's flat DXF + frame in a basis whose +X axis is EXACTLY
 * the panel's true in-plane "toward the bend" direction (bendDirForPanel),
 * instead of computeDxfAlignedFrame's 0°-or-90° approximation (which only
 * coincides with the true bend direction for a rectangular panel, where the
 * fold is necessarily parallel to one of getPanelFrame's two stored axes).
 *
 * For a non-rectangular panel (e.g. a skewed quad facet from a faceted
 * curved-surface decomposition), neither stored axis is generally
 * perpendicular to the actual shared edge with the other panel — treating
 * "distance to that edge" as a single scalar along either axis produces a
 * meaningless cut position, corrupting the bend-zone bridge (confirmed: a
 * bowtie-shaped merged outline, far outside either input panel's own bbox).
 * Aligning +X to the exact, already-computed bendDir (provably perpendicular
 * to the true fold line — see its derivation above, dAB's seam-axis
 * component is explicitly zeroed before this projection) restores "distance
 * along X" as a single, exact scalar for ANY panel shape, rectangular or not.
 *
 * bendDirForPanel/u/v/normal must already lie in a common plane (true for
 * frame.u/frame.v/frame.normal plus a bendDir derived from THIS panel's own
 * plane normal) — bendDirForPanel's projection onto (u, v) must therefore
 * already be unit-length; this is checked, not assumed.
 *
 * For a rectangular panel, the ROTATION this computes is provably identical
 * to the existing 0°/90° convention: bendDir is then exactly ±u or ±v
 * already, so the rotation is exactly 0° or a multiple of 90°. The reported
 * EXTENT, though, deliberately prefers storedExtents (panelNode.flatWidth/
 * flatHeight) over the rotated polygon's own raw bbox extent whenever the
 * rotation is axis-aligned — the two are not interchangeable even for a
 * perfect rectangle (flatWidth/flatHeight carry neutral-axis/thickness
 * corrections the raw exported polygon doesn't), and a chained merge
 * persists this exact value for a later merge to reuse verbatim, where even
 * a couple-mm disagreement corrupts the chain. The raw extent is only used
 * when the panel genuinely isn't rectangular, where no stored value applies
 * to the bend-perpendicular direction at all.
 */
function computeBendAlignedFrame(
  shapeDxf: string,
  frame: PanelFrame,
  bendDirForPanel: [number, number, number],
  storedExtents: { flatWidth: number | null; flatHeight: number | null },
): { alignedDxf: string; alignedFrame: PanelFrame; flatExtentMm: number } {
  const ring = parseFirstClosedPolyline(shapeDxf);
  if (ring.length < 3) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      'merge_bodies_with_bend: panel DXF has fewer than 3 vertices; cannot align to the bend direction.',
      false,
    );
  }
  const dx = bendDirForPanel[0] * frame.u[0] + bendDirForPanel[1] * frame.u[1] + bendDirForPanel[2] * frame.u[2];
  const dy = bendDirForPanel[0] * frame.v[0] + bendDirForPanel[1] * frame.v[1] + bendDirForPanel[2] * frame.v[2];
  const dNorm = Math.hypot(dx, dy);
  if (dNorm < 0.5) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      'merge_bodies_with_bend: the bend direction has no measurable in-plane component for this panel; ' +
      'cannot determine a fold-perpendicular axis.',
      false,
    );
  }
  let a = dx / dNorm, b = dy / dNorm;
  // Snap to an EXACT cardinal rotation when within tolerance of one, rather
  // than leaving a near-zero-but-not-exactly-zero residual from the
  // floating-point centroid/projection arithmetic bendDir is derived from.
  // For a true rectangle this makes the rotation bit-identical to the old
  // rotateDxf90-or-identity convention (not just numerically close) — a
  // chained merge re-derives its OWN placement from this panel's resulting
  // DXF content, and even a sub-degree residual skew was enough to push an
  // already-marginal union connectivity check (a corner-chain case) over
  // the edge (confirmed: snapping here restores it).
  const AXIS_ALIGN_TOL = 0.02; // ~1.1°
  if (Math.abs(b) < AXIS_ALIGN_TOL) { a = Math.sign(a) || 1; b = 0; }
  else if (Math.abs(a) < AXIS_ALIGN_TOL) { a = 0; b = Math.sign(b) || 1; }
  // Rotation mapping unit vector (a, b) -> (1, 0): [[a, b], [-b, a]].
  const rotated = applyPlacement(ring, { rotationMatrix: [[a, b], [-b, a]], translation: [0, 0] });
  let xMin = Number.POSITIVE_INFINITY, xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY, yMax = Number.NEGATIVE_INFINITY;
  for (const [x, y] of rotated) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const rawFlatExtentMm = xMax - xMin;
  if (!(rawFlatExtentMm > 0)) {
    throwError(
      ErrorCodes.GE_MERGE_FAILED,
      'merge_bodies_with_bend: panel has zero extent along the bend-perpendicular direction.',
      false,
    );
  }
  // For an (effectively) rectangular panel — bendDir already exactly ±u or
  // ±v, i.e. this rotation is the identity or a multiple of 90° — prefer the
  // graph-stored flatWidth/flatHeight over the raw DXF polygon's own bbox
  // extent. The two are NOT interchangeable even for a perfect rectangle:
  // flatWidth/flatHeight carry neutral-axis/thickness corrections that the
  // exported polygon's raw vertices don't (confirmed: differs by a couple
  // mm for an ordinary split panel) — and a chained merge persists THIS
  // value as bendZoneDxfX for a later merge to reuse verbatim, where even a
  // couple-mm disagreement with the placement basis it was originally
  // computed alongside corrupts the chain. Only fall back to the raw extent
  // when the panel genuinely isn't rectangular (no stored value applies to
  // the bend-perpendicular direction at all in that case).
  const flatExtentMm =
    Math.abs(b) < AXIS_ALIGN_TOL && storedExtents.flatWidth !== null ? storedExtents.flatWidth
    : Math.abs(a) < AXIS_ALIGN_TOL && storedExtents.flatHeight !== null ? storedExtents.flatHeight
    : rawFlatExtentMm;
  const shifted = rotated.map(([x, y]) => [x - xMin, y - yMin] as [number, number]);
  const alignedDxf = ringToLwpolylineDxf(shifted);
  // newU = a*u + b*v, newV = -b*u + a*v — a pure in-plane rotation, so it
  // preserves u×v exactly (the panel's normal is unaffected).
  const newU: [number, number, number] = [
    a * frame.u[0] + b * frame.v[0],
    a * frame.u[1] + b * frame.v[1],
    a * frame.u[2] + b * frame.v[2],
  ];
  const newV: [number, number, number] = [
    -b * frame.u[0] + a * frame.v[0],
    -b * frame.u[1] + a * frame.v[1],
    -b * frame.u[2] + a * frame.v[2],
  ];
  const newOrigin: [number, number, number] = [
    frame.origin[0] + xMin * newU[0] + yMin * newV[0],
    frame.origin[1] + xMin * newU[1] + yMin * newV[1],
    frame.origin[2] + xMin * newU[2] + yMin * newV[2],
  ];
  return {
    alignedDxf,
    alignedFrame: { origin: newOrigin, u: newU, v: newV, vExtentMm: frame.vExtentMm, normal: frame.normal },
    flatExtentMm,
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    positive_shell_id: result.positiveShellId,
    negative_shell_id: result.negativeShellId,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    positive_mesh_url: buildMeshUrl(result.positiveShellId),
    negative_mesh_url: buildMeshUrl(result.negativeShellId),
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

  const toBodyId = (s: string) => s as BodyId;

  // Resolves both parts' manufacturing-graph PanelNodes + current C++ shell
  // IDs, with all the strict graph/bodyId/shapeDxf validation this tool
  // requires. effectiveAFlatWidth for a chained merge must come from the DXF
  // bbox (see below), not from panelNodeA.flatWidth, which stores only the
  // last panel's individual width — priorBendNodeA (the actual node, not
  // just isChainedMerge's boolean) is needed later to re-fold panel A's OWN
  // prior bend alongside the new one, and to reuse its persisted placement
  // basis for an aligned chain — see the buildShellFromFlatPattern call
  // site's multi-zone bendZones construction.
  const lookup = lookupMergePanels(partAId, partBId);
  const { panelNodeA, panelNodeB, isChainedMerge, priorBendNodeA } = lookup;
  let shellAId = lookup.shellAId;
  let shellBId = lookup.shellBId;
  // Derives both panels' frames, fixes chirality, normalizes DXF origins,
  // computes the 2D merge placement, and runs the pre-merge edge-alignment
  // check (rejecting or auto-correcting with close_gap as needed) — see
  // prepareMergePanelFrames's own doc comment.
  const prepared = prepareMergePanelFrames(
    partAId, partBId, panelNodeA, panelNodeB,
    lookup.shapeDxfA, lookup.shapeDxfB, shellAId, shellBId,
  );
  let frameA = prepared.frameA;
  let frameB = prepared.frameB;
  let effectiveShapeDxfA = prepared.effectiveShapeDxfA;
  let effectiveShapeDxfB = prepared.effectiveShapeDxfB;
  const placement = prepared.placement;
  const contactToleranceMm = prepared.contactToleranceMm;
  const edgeAlignmentCorrectionMm = prepared.edgeAlignmentCorrectionMm;
  shellBId = prepared.shellBId;

  // Computes everything about the bend itself — fold axis/angle/direction,
  // each panel's exact bend-aligned flat-pattern frame (or the graceful
  // fallback for coplanar/chained merges), and the world-space placement
  // basis the C++ rebuild call and the persisted BendNode both need — see
  // computeBendGeometry's own doc comment.
  const bend = computeBendGeometry(
    frameA, frameB, effectiveShapeDxfA, effectiveShapeDxfB,
    shellAId, shellBId, panelNodeA, panelNodeB,
    isChainedMerge, priorBendNodeA, bendRadius as number,
  );
  const foldAlongU_B = bend.foldAlongU_B;
  const frameADxfForGraph = bend.frameADxfForGraph;
  const frameBDxfForGraph = bend.frameBDxfForGraph;
  const bendDirSimple = bend.bendDirSimple;
  const anchorPointSimple = bend.anchorPointSimple;
  const bendDirPayload = bend.bendDirPayload;
  const foldNormalPayload = bend.foldNormalPayload;
  const anchorPoint = bend.anchorPoint;
  const kFactorDefault = bend.kFactorDefault;
  const bendAngle = bend.bendAngle;
  const thickness = bend.thickness;
  const ba = bend.ba;
  const priorBendDirAligned = bend.priorBendDirAligned;
  const nBu = bend.nBu;

  // Classifies coplanar-vs-bend placement, derives each panel's
  // fold-perpendicular extent and seam offset, and unions panel A + an
  // explicit bend-allowance bridge + panel B into the merged flat
  // pattern (the merge's actual source of truth) — see
  // buildMergedFlatPattern's own doc comment.
  const flatPattern = buildMergedFlatPattern(
    panelNodeA, panelNodeB, effectiveShapeDxfA, effectiveShapeDxfB,
    placement, contactToleranceMm, isChainedMerge, bend,
  );
  const effectiveAFlatWidth = flatPattern.effectiveAFlatWidth;
  const effectiveBFlatWidth = flatPattern.effectiveBFlatWidth;
  const seamYOffset = flatPattern.seamYOffset;
  let mergedDxf = flatPattern.mergedDxf;
  const mergedFlatWidth = flatPattern.mergedFlatWidth;
  const mergedFlatHeight = flatPattern.mergedFlatHeight;

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

  // frameADxfForGraph/frameBDxfForGraph were already computed earlier
  // (right after bendDir) for the graph-persisted panelFrame fields below.

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
    panelFrame: frameADxfForGraph,
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
    panelFrame: frameBDxfForGraph,
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
    panelFrame: frameBDxfForGraph,
    dxfPlacement: dxfPlacementB,
  });

  const bendNode: import('../../manufacturing/graph/types').BendNode = {
    type: 'BendNode',
    id: bendId,
    dirty: true,
    panelAId: nodeAId,
    panelBId: nodeBId,
    innerRadius: bendRadius as number,
    angle: bendAngle,
    foldNormal: foldNormalPayload,
    bendDir: bendDirPayload,
    anchor: anchorPoint,
    kFactor: kFactorDefault,
    bendAllowance: ba,
    bendZoneDxfX: effectiveAFlatWidth,
  };
  mergedGraph.addNode(bendNode);

  // ── Step 2: C++ call — rebuild from manufacturing graph, then place ──────────
  // buildShellFromFlatPattern reconstructs the 3D shape from the DXF (source of
  // truth). Placement uses an explicit world anchor for panel A — its own
  // oriented-bbox centre, computed from STORED graph data (panelFrame,
  // flatWidth/flatHeight, midplaneOffsetMm) — never a live shell query.
  let mergedShellId: string;
  let shapeHistory: unknown[] = [];
  let rollbackToken: string = snapshotId;

  try {
    if (mergedDxf && getGeometryBinding().hasBuildShellFromFlatPattern()) {
      // Anchor: world position of the merged flat-pattern's own local (0,0,0).
      // Panel A occupies local x∈[0..effectiveAFlatWidth] by the merge's own
      // DXF convention, with local-X/-Y always panelADxfForMerge's actual
      // +X/+Y world directions — bendDirPayload is ALWAYS the true physical
      // bendDir (never flipped), so this holds unconditionally, independent
      // of frameADxf.u's sign.
      //
      // Local (0,0,0) is panel A's own DXF(0,0) corner ONLY when bendDir
      // agrees with frameADxf.u (xAgreesDxf, computed above alongside
      // anchorPoint) — i.e. only when frameADxf.origin happens to be A's
      // FAR-from-the-bend corner. When it disagrees, frameADxf.origin is
      // actually A's NEAR (hinge-adjacent) corner, and using it directly as
      // local (0,0,0) would place the bend zone (always attached AFTER A's
      // content, at local x=effectiveAFlatWidth) on A's far edge instead of
      // the hinge — the merged bbox still looks like a sane union (confirmed
      // by a bbox check) but B's actual material ends up mirrored through A's
      // own footprint, landing on the wrong side entirely (confirmed via a
      // real two-cube-wall repro: B ended up on its own opposite cube face).
      // anchorPoint compensates by using A's diagonally-opposite (far) corner
      // instead (origin + W*frameADxf.u + H*frameADxf.v) in that case, so
      // local x=effectiveAFlatWidth still lands back exactly on
      // frameADxf.origin, the real hinge — see anchorPoint's own derivation,
      // above, for why BOTH the W and H terms are needed (flipping which end
      // of local-X is "near" mechanically flips local-Y's world direction too,
      // since Y=foldNormalPayload×bendDirPayload and foldNormalPayload never
      // flips).
      //
      // foldNormalPayload is NEVER flipped: it's placed directly as the
      // local-Z → world basis vector, and panel B's local-Z range after its
      // fold rotation is NOT just material thickness — folding swings B's
      // in-plane extent out of the flat plane into Z, so flipping foldNormal
      // would reverse B's own (possibly asymmetric) content along that swing.
      //
      // bendDirPayload/foldNormalPayload/anchorPoint/actualYDir were already
      // computed earlier (right after bendDir), so the seam-offset fix above
      // could use them.
      //
      // (An earlier version of this fix 180°-rotated Panel A's own DXF
      // content/frame instead of adjusting the anchor — mathematically valid
      // for the merge's own placement, but it altered the merged 3D shell's
      // geometry in a way that broke an unrelated, independent unfoldShell
      // re-derivation downstream. This anchor-only approach changes nothing
      // about Panel A's actual shape or content, only the placement
      // transform.)
      const anchor = {
        anchorX: anchorPoint[0], anchorY: anchorPoint[1], anchorZ: anchorPoint[2],
        hasAnchor: true,
      };
      // Where Panel B's TRUE hinge edge sits inside its OWN flat pattern,
      // measured from B's local x=0 (its DXF origin, panelBDxfForMerge) along
      // B's own local-x axis. Zero for an ordinary panel (hinge IS the
      // origin — every panel this merge has handled until now). Nonzero
      // when B is a composite with material continuing PAST its hinge with
      // A (e.g. a flange tab fused onto a wall, overhanging the wall's own
      // bend line with A) — B's origin then sits at its far/free edge
      // instead, with the hinge an interior point.
      //
      // The hinge's position along bendDir can't come from EITHER panel's own
      // bbox/reported-width: whichever side is a composite panel with its
      // own overhang past the hinge (the wall-with-flange-tab case) has that
      // overhang running along this exact axis BY CONSTRUCTION (the tab
      // overhangs the wall's own bend line with the other panel) — so a
      // bbox-extreme or flatWidth read from the composite side overshoots by
      // the overhang's length regardless of which side (A or B) is the
      // composite one. The hinge IS, however, exactly the line where A's and
      // B's planes intersect — a purely geometric fact unaffected by either
      // panel's in-plane extent. Solve for t in
      // anchorPoint + t*bendDirPayload landing on B's plane (dot(·, nBu) = 0
      // relative to frameB.origin, a known point on that plane): sign
      // ambiguity in nBu cancels in the ratio, so this is robust regardless
      // of which way either panel's face-normal convention happens to point.
      // Uses bendDirSimple/anchorPointSimple (NEVER the chain-aware
      // bendDirPayload/anchorPoint) — this is a ray/plane intersection that
      // must start from an anchor truly rooted at THIS bend, walking along
      // THIS bend's own true direction; for a chained merge, anchorPoint/
      // bendDirPayload describe the WHOLE assembly's distant root instead
      // (see their own derivation above), which doesn't reach Panel B's
      // plane in any geometrically meaningful way.
      const planeDenom = dot3(bendDirSimple, nBu);
      const hingeShiftAlongBendDir = Math.abs(planeDenom) > 1e-9
        ? -dot3(
            [anchorPointSimple[0] - frameB.origin[0], anchorPointSimple[1] - frameB.origin[1], anchorPointSimple[2] - frameB.origin[2]],
            nBu,
          ) / planeDenom
        : effectiveAFlatWidth; // degenerate (B's plane ~parallel to bendDir): fall back to the old assumption
      const hingeWorldPoint: [number, number, number] = [
        anchorPointSimple[0] + hingeShiftAlongBendDir * bendDirSimple[0],
        anchorPointSimple[1] + hingeShiftAlongBendDir * bendDirSimple[1],
        anchorPointSimple[2] + hingeShiftAlongBendDir * bendDirSimple[2],
      ];
      const bAxisVec = foldAlongU_B ? frameB.v : frameB.u;
      const bHingeOffsetRaw = dot3(
        [hingeWorldPoint[0] - frameB.origin[0], hingeWorldPoint[1] - frameB.origin[1], hingeWorldPoint[2] - frameB.origin[2]],
        bAxisVec,
      );
      // bAxisVec's sign (frameB.u or .v) doesn't necessarily agree with
      // panelBDxfForMerge's actual +x direction — that depends on whatever
      // convention B's own (merge-unaware) apply_unfold used when it built
      // shapeDxf, which can differ from getPanelFrame's u/v tie-break. But
      // frameB.origin can only be at ONE of two places: local-x=0, or
      // local-x=effectiveBFlatWidth (the far end) — so bHingeOffsetRaw
      // (measured from local-x=0) is either already correct, or needs
      // mirroring about the width. A genuine overhang's correction is always
      // small relative to the panel's own width (bounded by the overhang
      // feature's own size) — so whichever of the two candidates is closer
      // to zero is the right one.
      const bHingeOffsetMirrored = effectiveBFlatWidth - bHingeOffsetRaw;
      let bHingeOffsetMm = Math.abs(bHingeOffsetRaw) <= Math.abs(bHingeOffsetMirrored)
        ? bHingeOffsetRaw
        : bHingeOffsetMirrored;
      // Snap small values to exactly zero: a genuine overhang (a real
      // manufacturing feature) is on the order of several mm or more, while
      // residual noise from material thickness / neutral-axis bend-allowance
      // accounting on an ordinary (non-overhanging) panel is sub-mm to a
      // couple mm — comparable to MERGE_OVERLAP_MM below — and applying it
      // as a real pivot shift can pull an otherwise-flush fold edge just far
      // enough apart to break the watertight fuse.
      const HINGE_SNAP_TOL_MM = Math.max(2.0, thickness * 2);
      if (Math.abs(bHingeOffsetMm) < HINGE_SNAP_TOL_MM) bHingeOffsetMm = 0;
      bendNode.bHingeOffsetMm = bHingeOffsetMm;
      // When Panel A is itself the result of an earlier merge_bodies_with_bend
      // AND this new bend's fold line is parallel to Panel A's own prior one
      // (priorBendDirAligned — a straight channel, not a cube corner), A's
      // OWN prior bend has to be re-folded HERE too, as an EARLIER entry in
      // this bendZones array — otherwise buildShellFromFlatPattern treats
      // all of A's content as one flat, unbent rectangle, silently
      // flattening A's existing dihedral (see Bug 11 follow-up). When NOT
      // aligned (cube-corner case), priorZone is deliberately left empty —
      // see priorBendDirAligned's own derivation above for why falling back
      // to the pre-existing single-zone (flatten Panel A) behavior, instead
      // of attempting a 1-D re-fold this case can't represent, is the right
      // call here. foldAlongU_A is only forced false (so
      // priorBendNodeA.bendZoneDxfX, an offset along A's OWN un-rotated
      // local-X, stays valid as-is) when priorBendDirAligned, matching this
      // same gate.
      const priorZone = (isChainedMerge && priorBendDirAligned && priorBendNodeA && priorBendNodeA.bendZoneDxfX !== undefined && priorBendNodeA.bendAllowance !== null)
        ? [{
            offsetMm: priorBendNodeA.bendZoneDxfX,
            widthMm: priorBendNodeA.bendAllowance,
            angleDeg: priorBendNodeA.angle,
            innerRadiusMm: priorBendNodeA.innerRadius,
            kFactor: priorBendNodeA.kFactor,
            // Unused: only the LAST zone (the new bend, below) is read for
            // world placement — see buildShellFromFlatPattern's own comment.
            foldNormalX: 0, foldNormalY: 0, foldNormalZ: 0,
            bendDirX: 0, bendDirY: 0, bendDirZ: 0,
            bHingeOffsetMm: priorBendNodeA.bHingeOffsetMm ?? 0,
            hasAnchor: false, anchorX: 0, anchorY: 0, anchorZ: 0,
          }]
        : [];
      const bendZones = effectiveAFlatWidth
        ? [...priorZone, {
            offsetMm: effectiveAFlatWidth,
            widthMm: ba,
            angleDeg: bendAngle,
            innerRadiusMm: bendRadius as number,
            kFactor: kFactorDefault,
            // Fold frame (world): canonical +X → bendDir, canonical +Z → foldNormal.
            // Lets C++ place the rebuilt shell on the correct side without guessing
            // a face-normal sign (which previously inverted the fold). bendDirPayload
            // is always the true physical bendDir; anchorPoint (not these directions)
            // is what's adjusted to keep the C++ placement's local↔world
            // correspondence matching frameADxf exactly — see anchorPoint's
            // derivation, above, for why. This is also the LAST entry in
            // bendZones (X-sorted), so it's the one buildShellFromFlatPattern
            // actually reads for world placement.
            foldNormalX: foldNormalPayload[0], foldNormalY: foldNormalPayload[1], foldNormalZ: foldNormalPayload[2],
            bendDirX: bendDirPayload[0], bendDirY: bendDirPayload[1], bendDirZ: bendDirPayload[2],
            bHingeOffsetMm,
            ...anchor,
          }]
        : [];
      const res = getGeometryBinding().buildShellFromFlatPattern(mergedDxf, bendZones, thickness);
      mergedShellId = res.shellId;
    } else {
      const res = getGeometryBinding().mergeBodiesWithBend(shellAId as string, shellBId as string, targetEdges, bendRadius as number);
      mergedShellId = res.mergedShellId;
      shapeHistory = (res as unknown as { shape_history?: typeof shapeHistory }).shape_history ?? [];
      rollbackToken = resolveRollbackToken(
        ctx,
        (res as unknown as { rollbackToken?: string }).rollbackToken ?? snapshotId,
      );
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
  appendHistoryIfJoined(ctx, shapeHistory as import('../transactions').ShapeHistoryRecord[]);

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
    mesh_url: buildMeshUrl(mergedShellId),
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

  return {
    part_b_id: result.partBId,
    gap_closed_mm: result.gapClosedMm,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.partBId),
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    modified_shell_id: result.modifiedShellId,
    extension_distance_mm: result.extensionDistanceMm,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.modifiedShellId),
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.modifiedShellId),
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    modified_shell_id: result.modifiedShellId,
    flange_feature_id: result.flangeFeatureId,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.modifiedShellId),
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    modified_shell_id: result.modifiedShellId,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.modifiedShellId),
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
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    trimmed_shell_id: result.trimmedShellId,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_url: buildMeshUrl(result.trimmedShellId),
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

// ─── Cross-panel midplane-offset correction ──────────────────────────────────

interface RawPanelMeasurement {
  id: string;
  normal: [number, number, number];
  thicknessRawMm: number;
  // Signed offset along `normal` (NOT the dominant face's own normal — see
  // measurePanelMidplaneOffsetMm), from measurePanelThickness run directly
  // on this panel's own (possibly contaminated) split-time shell.
  centerRawMm: number;
}

// Measures a single panel/protrusion's frame + raw thickness in one shot, for
// the cross-panel correction pass below. Returns null for non-planar shapes
// (e.g. a boss/tube protrusion) — those are simply not corrected.
function measureRawPanel(id: string): RawPanelMeasurement | null {
  try {
    const gb = getGeometryBinding();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pf: any = gb.getPanelFrame(id);
    const pt = gb.measurePanelThickness(id);
    if (!pt.ok) return null;
    const normal: [number, number, number] = [pf.normalX, pf.normalY, pf.normalZ];
    const dot = pt.dominant_normal_x * normal[0] + pt.dominant_normal_y * normal[1] + pt.dominant_normal_z * normal[2];
    const sign = dot >= 0 ? 1 : -1;
    return { id, normal, thicknessRawMm: pt.thickness_mm, centerRawMm: sign * pt.midplane_offset_mm };
  } catch {
    return null;
  }
}

// A panel's own thin-solid-mode extraction can be contaminated when it's
// coplanar with, and boolean-fused (zero gap) to, an adjacent panel of the
// SAME thickness: the fuse erases the seam between them, so
// measurePanelThickness can only find faces at the OUTER extremes of the
// combined material — reporting double the true thickness, centred on the
// midpoint of BOTH panels' material instead of just this panel's own.
//
// This can't be fixed by re-measuring the contaminated panel alone (no face
// exists at the true seam to find). But the OTHER panel sharing that fused
// boundary measures cleanly on its own (no tie/ambiguity for ITS dominant
// face), so its already-correct range can be subtracted from the
// contaminated panel's range to recover the true one — same principle as
// the median-thickness vote: trust the values that agree with each other,
// not any single panel's isolated measurement.
function correctContaminatedMidplaneOffsets(
  measurements: RawPanelMeasurement[],
  resolvedThicknessMm: number,
): Map<string, number> {
  const corrections = new Map<string, number>();
  const RELIABLE_TOL_MM = Math.max(0.15, resolvedThicknessMm * 0.1);
  const CONTAMINATION_FACTOR = 1.3;
  const EDGE_TOL_MM = Math.max(0.05, resolvedThicknessMm * 0.05);

  const reliable = measurements.filter((m) => Math.abs(m.thicknessRawMm - resolvedThicknessMm) <= RELIABLE_TOL_MM);
  const contaminated = measurements.filter((m) => m.thicknessRawMm > resolvedThicknessMm * CONTAMINATION_FACTOR);

  for (const p of contaminated) {
    const pMin = p.centerRawMm - p.thicknessRawMm / 2;
    const pMax = p.centerRawMm + p.thicknessRawMm / 2;

    for (const q of reliable) {
      if (q.id === p.id) continue;
      const dot = p.normal[0] * q.normal[0] + p.normal[1] * q.normal[1] + p.normal[2] * q.normal[2];
      if (Math.abs(dot) < 0.99) continue; // not coplanar with p

      // Express q's range along p's own normal direction.
      const flip = dot < 0 ? -1 : 1;
      const qCenterInP = flip * q.centerRawMm;
      const qMin = qCenterInP - q.thicknessRawMm / 2;
      const qMax = qCenterInP + q.thicknessRawMm / 2;

      // q's range must sit (almost) fully inside p's contaminated range,
      // flush against one of its edges — that's what marks q as "the other
      // panel whose material p's measurement accidentally swallowed".
      if (qMin < pMin - EDGE_TOL_MM || qMax > pMax + EDGE_TOL_MM) continue;

      let correctedMin = pMin;
      let correctedMax = pMax;
      if (Math.abs(qMax - pMax) <= EDGE_TOL_MM) {
        correctedMax = qMin; // q occupies p's "+" side; p's true material is on the "-" side.
      } else if (Math.abs(qMin - pMin) <= EDGE_TOL_MM) {
        correctedMin = qMax; // q occupies p's "-" side; p's true material is on the "+" side.
      } else {
        continue; // q overlaps p but isn't flush against either edge — not the host.
      }

      corrections.set(p.id, (correctedMin + correctedMax) / 2);
      break;
    }
  }

  return corrections;
}

export async function handleSplitBodyByBends(args: Record<string, unknown>): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const threshold = typeof args['angle_threshold_deg'] === 'number'
    ? args['angle_threshold_deg']
    : 1.0;
  const maxThicknessMm = typeof args['max_thickness_mm'] === 'number'
    ? args['max_thickness_mm']
    : 5.0;
  const maxRecursionDepth = typeof args['max_recursion_depth'] === 'number'
    ? Math.max(0, Math.round(args['max_recursion_depth']))
    : 1;

  if (threshold < 0) {
    throwError(ErrorCodes.GE_DECOMPOSE_BY_BENDS_FAILED, 'angle_threshold_deg must be non-negative', true);
  }

  // default_thickness_mm: only matters to splitBodyByBends itself when the
  // input is a genuinely thin shell with no real 3D thickness to find (it
  // gets extruded by this amount). When the input already has real
  // thickness, this value is irrelevant to the split, and overridden below
  // anyway by measuring the result.
  const defaultThicknessMm = typeof args['default_thickness_mm'] === 'number'
    ? args['default_thickness_mm']
    : 1.0;
  // Did the caller explicitly choose a thickness? If so, that choice wins
  // outright for every resulting panel/protrusion below — no measurement.
  const callerProvidedThickness = typeof args['default_thickness_mm'] === 'number';

  // Measure the whole, INTACT part now, before splitBodyByBends consumes
  // partId below. Folded into the vote computed after splitting (see there
  // for why a single measurement on its own isn't reliable enough).
  let wholePartThicknessMm = 0;
  if (!callerProvidedThickness) {
    try {
      const measured = getGeometryBinding().measurePanelThickness(partId);
      if (measured.ok && measured.thickness_mm > 0) wholePartThicknessMm = measured.thickness_mm;
    } catch { /* leave unmeasured */ }
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

  appendHistoryIfJoined(ctx, result.shape_history);

  // Resolve the single, shared nominalThickness for every resulting
  // panel/protrusion below (a sheet-metal part has one uniform thickness by
  // definition). Take the MEDIAN of: the whole-part measurement, plus
  // measurePanelThickness on each individual result. No single one of these
  // is reliable alone — split_body_by_bends's thin-solid-mode extraction can
  // leave a thin sliver artifact at a panel's cut boundary (from an
  // attached feature like a flange, or the bend line itself) that a
  // closest-anti-parallel-pair search mistakes for the real thickness on
  // THAT one panel — but such an artifact is specific to whichever panel
  // happens to have been cut that way, not shared across the whole part, so
  // it never has enough votes to beat the genuine, uniform thickness shared
  // by the whole part and every other panel.
  let resolvedThicknessMm = defaultThicknessMm;
  if (!callerProvidedThickness) {
    const measurements: number[] = [];
    if (wholePartThicknessMm > 0) measurements.push(wholePartThicknessMm);
    for (const id of [...result.panel_ids, ...result.protrusion_ids]) {
      try {
        const measured = getGeometryBinding().measurePanelThickness(id);
        if (measured.ok && measured.thickness_mm > 0) measurements.push(measured.thickness_mm);
      } catch { /* leave out of the vote */ }
    }
    if (measurements.length > 0) {
      measurements.sort((a, b) => a - b);
      const mid = Math.floor(measurements.length / 2);
      resolvedThicknessMm = measurements.length % 2 === 0
        ? (measurements[mid - 1]! + measurements[mid]!) / 2
        : measurements[mid]!;
    }
  }

  // Cross-panel correction: a panel coplanar-fused (zero gap) to a same-
  // thickness neighbour measures double thickness on its own (see
  // correctContaminatedMidplaneOffsets above) — recover its true midplane
  // offset by subtracting whichever neighbour's OWN clean measurement
  // explains the excess, rather than trusting its own ambiguous reading.
  const rawMeasurements: RawPanelMeasurement[] = [];
  for (const id of [...result.panel_ids, ...result.protrusion_ids]) {
    const m = measureRawPanel(id);
    if (m) rawMeasurements.push(m);
  }
  const midplaneCorrections = correctContaminatedMidplaneOffsets(rawMeasurements, resolvedThicknessMm);

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
    let _pf: import('../../geometry/types').PanelFrameResult;
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
    panelFrame = napiFrameToPanelFrame(_pf);
    const panelMidplaneOffsetMm = midplaneCorrections.get(panelId)
      ?? measurePanelMidplaneOffsetMm(panelId, [_pf.normalX, _pf.normalY, _pf.normalZ]);

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
      nominalThickness: resolvedThicknessMm,
      flatWidth: panelFlatWidth,
      flatHeight: panelFlatHeight,
      canonical: true,  // Split panels are canonical unfold targets
      shapeDxf: panelShapeDxf,
      panelFrame: panelFrame ?? undefined,
      midplaneOffsetMm: panelMidplaneOffsetMm,
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
    let protMidplaneOffsetMm: number | null = null;

    try {
      const ppf = getGeometryBinding().getPanelFrame(protrusionId);
      protFlatWidth = ppf.uExtentMm;
      protFlatHeight = ppf.vExtentMm;
      protrusionFrame = napiFrameToPanelFrame(ppf);
      protMidplaneOffsetMm = midplaneCorrections.get(protrusionId)
        ?? measurePanelMidplaneOffsetMm(protrusionId, [ppf.normalX, ppf.normalY, ppf.normalZ]);
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
      nominalThickness: resolvedThicknessMm,
      flatWidth: protFlatWidth,
      flatHeight: protFlatHeight,
      canonical: true,  // Protrusions are canonical unfold targets
      shapeDxf: protrusionShapeDxf,
      panelFrame: protrusionFrame ?? undefined,
      midplaneOffsetMm: protMidplaneOffsetMm,
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
  return {
    panel_ids: result.panel_ids,
    panel_count: result.panel_ids.length,
    panel_bboxes: result.panel_bboxes,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_ids.length,
    protrusion_bboxes: result.protrusion_bboxes,
    protrusion_parents: result.protrusion_parents,
    detected_mode: result.detected_mode,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_urls: buildMeshUrls(allIds),
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

  const allIds = [result.cleaned_part_id, ...result.protrusion_ids];
  return {
    cleaned_part_id: result.cleaned_part_id,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_count,
    protrusion_bboxes: result.protrusion_bboxes,
    rollback_token: resolveRollbackToken(ctx, result.rollbackToken),
    mesh_urls: buildMeshUrls(allIds),
    created_parts: createdProtrusionParts,
  };
}
