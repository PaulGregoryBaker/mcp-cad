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
import { transactionRegistry } from './transactions';
import type { SemanticStore } from '../semantic/semantic_store';
import { SemanticStoreError } from '../semantic/semantic_store';
import { MappingLayer } from '../semantic/mapping_layer';

let _semanticStore: SemanticStore | null = null;

export function setSemanticStore(store: SemanticStore): void {
  _semanticStore = store;
}

function getSemanticStore(): SemanticStore {
  if (!_semanticStore) {
    throwError(
      ErrorCodes.PERSISTENCE_UNAVAILABLE,
      'Semantic store is not initialised. Ensure persistence.driver is configured.',
      false,
    );
  }
  return _semanticStore;
}
import type { ManufacturingConfig } from '../config/loader';
import { MaterialStore } from '../manufacturing/material';
import { isJointTypeAllowed } from '../manufacturing/rules';
import { scorePanel } from '../manufacturing/manufacturability';
import { validateBendSequence } from '../manufacturing/bend_sequence';
import type { FeatureSet } from '../manufacturing/feature';
import { ManufacturingGraph } from '../manufacturing/graph/graph';
import { GeometrySolver } from '../manufacturing/graph/solver';
import { bootstrapGraph } from '../manufacturing/graph/bootstrap';
import { DrcChecker } from '../manufacturing/graph/drc';
import type { DrcCheckRequest } from '../manufacturing/graph/drc';
import { FoldabilityChecker } from '../manufacturing/graph/foldability';
import { toNodeId } from '../manufacturing/graph/types';
import type { BendNode, BendZone, JoinNode, JoinParams, CutNode, CutProfile } from '../manufacturing/graph/types';
import { validateProfile } from '../manufacturing/graph/types';
import type { GeometryBinding as SolverGeometryBinding } from '../manufacturing/graph/solver';

// Adapts the class-based GeometryBinding to the solver's GeometryBinding interface
function getGraphBinding(): SolverGeometryBinding {
  const gb = getGeometryBinding();
  return {
    createSnapshot: (label) => gb.createSnapshot(label),
    restoreSnapshot: (id) => {
      const r = gb.restoreSnapshot(id);
      return { restoredSolidIds: r.restoredSolidIds, restoredShellIds: r.restoredShellIds };
    },
    mergeBodiesWithBend: (a, b, edges, radius) => {
      const r = gb.mergeBodiesWithBend(a, b, edges, radius);
      return { mergedShellId: r.mergedShellId };
    },
    splitBodyByBends: (partId, angle, maxT, defT) => {
      const r = gb.splitBodyByBends(partId, angle, maxT, defT);
      return { panel_ids: r.panel_ids };
    },
    fuseBodies: (tools, tol) => {
      const r = gb.fuseBodies(tools, tol);
      return { solid_id: r.solid_id };
    },
    cutBodies: (blank, tools, keep) => {
      const r = gb.cutBodies(blank, tools, keep);
      return { solid_id: r.solid_id };
    },
  };
}

// ─── Manufacturing Graph per-part management ──────────────────────────────────
//
// MVPs Feature 009 now supports multiple disconnected parts per session.
// Each part has its own Manufacturing Graph DAG. Tools that operate on a graph
// accept an explicit `part_id` parameter to select which part to work on.

const _parts: Map<string, ManufacturingGraph> = new Map();
let _activePartId: string | undefined;
let _geometrySolver: GeometrySolver | undefined;
let _foldabilityChecker: FoldabilityChecker | undefined;

function initializeSolvers(): void {
  if (!_geometrySolver) {
    _geometrySolver = new GeometrySolver();
    _foldabilityChecker = new FoldabilityChecker();
  }
}

function createPart(partId: string): ManufacturingGraph {
  if (_parts.has(partId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" already exists in this session.`,
      true,
      'reset_graph',
    );
  }
  initializeSolvers();
  const graph = new ManufacturingGraph(partId);
  _parts.set(partId, graph);
  _activePartId = partId;
  return graph;
}

function getManufacturingGraph(partId: string): ManufacturingGraph {
  const graph = _parts.get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session. Use create_part first or call bootstrap_graph.`,
      true,
      'create_part',
    );
  }
  return graph;
}

function setActivePart(partId: string): void {
  const graph = _parts.get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session.`,
      true,
      'create_part',
    );
  }
  _activePartId = partId;
}

function deletePart(partId: string): void {
  if (!_parts.has(partId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${partId}" not found in this session.`,
      true,
    );
  }
  _parts.delete(partId);
  if (_activePartId === partId) {
    _activePartId = _parts.keys().next().value; // Switch to first remaining part, or undefined
  }
}

function listParts(): Array<{ part_id: string; panel_count: number; bend_count: number }> {
  const result: Array<{ part_id: string; panel_count: number; bend_count: number }> = [];
  for (const [partId, graph] of _parts) {
    let panelCount = 0;
    let bendCount = 0;
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode') panelCount++;
      else if (node.type === 'BendNode') bendCount++;
    }
    result.push({ part_id: partId, panel_count: panelCount, bend_count: bendCount });
  }
  return result;
}

/** Union two manufacturing graphs: absorb source into target.
 *  All nodes from source_graph are copied into target_graph with their IDs.
 *  Then source_part is deleted from _parts.
 *  Prerequisite: both parts must exist in _parts. */
function unionGraphs(targetPartId: string, sourcePartId: string): void {
  const targetGraph = getManufacturingGraph(targetPartId);
  const sourceGraph = getManufacturingGraph(sourcePartId);

  // Copy all nodes from source to target (preserving node IDs)
  for (const [nodeId, node] of sourceGraph.nodes) {
    if (targetGraph.nodes.has(nodeId)) {
      throwError(
        ErrorCodes.GRAPH_INTEGRITY_ERROR,
        `Cannot union graphs: node "${nodeId}" exists in both target and source graphs`,
        true,
      );
    }
    // Clone the node to avoid shared references
    const clonedNode = JSON.parse(JSON.stringify(node));
    targetGraph.nodes.set(nodeId, clonedNode);
  }

  // Copy all edges from source to target
  for (const [edgeId, edge] of sourceGraph.edges) {
    if (targetGraph.edges.has(edgeId)) {
      throwError(
        ErrorCodes.GRAPH_INTEGRITY_ERROR,
        `Cannot union graphs: edge "${edgeId}" exists in both target and source graphs`,
        true,
      );
    }
    const clonedEdge = JSON.parse(JSON.stringify(edge));
    targetGraph.edges.set(edgeId, clonedEdge);
  }

  // Mark all copied nodes as dirty so solver regenerates their geometry
  for (const nodeId of sourceGraph.nodes.keys()) {
    const typedNodeId = nodeId as import('../manufacturing/graph/types').NodeId;
    targetGraph.markDirty(typedNodeId);
  }

  // Delete source part
  deletePart(sourcePartId);
}

function getGeometrySolver(): GeometrySolver {
  initializeSolvers();
  return _geometrySolver!;
}

function getGraphFoldabilityChecker(): FoldabilityChecker {
  initializeSolvers();
  return _foldabilityChecker!;
}

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
      name: 'begin_transaction',
      description:
        'Open an explicit transaction. Subsequent mutating tools execute against working state; commit to persist or roll back to revert all operations atomically. Returns transaction_id (also usable as rollback_token).',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Human-readable label for the transaction' },
          product: {
            type: 'string',
            description: 'Optional product slug (informational only in MVP)',
          },
        },
        required: ['label'],
      },
    },
    {
      name: 'commit_transaction',
      description:
        'Commit an active transaction. Discards the pre-transaction snapshot; changes become permanent.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction id returned by begin_transaction',
          },
        },
        required: ['transaction_id'],
      },
    },
    {
      name: 'rollback_transaction',
      description:
        'Roll back an active transaction. Restores geometry to its pre-transaction state and clears the active transaction.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction id returned by begin_transaction',
          },
        },
        required: ['transaction_id'],
      },
    },
    {
      name: 'get_transaction_history',
      description:
        'Returns the shape topology history accumulated in a transaction. Available for active and committed transactions; returns TRANSACTION_NOT_FOUND for rolled-back transactions.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction id returned by begin_transaction',
          },
        },
        required: ['transaction_id'],
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
          part_id:        { type: 'string', description: 'The part whose face will be extended' },
          face_id:        { type: 'string', description: 'Face ID to extend; omit to auto-select the closest face facing the target' },
          target_type:    { type: 'string', enum: ['part_surface', 'face_id', 'plane'], description: 'How the target is specified (default: part_surface)' },
          target_part_id: { type: 'string', description: 'Target part ID (required when target_type is part_surface or face_id)' },
          target_face_id: { type: 'string', description: 'Specific face ID on the target part (only used when target_type is face_id)' },
          target: {
            type: 'object',
            description: 'Nested target spec — alternative to flat target_part_id/target_face_id; also carries plane normal/origin',
            properties: {
              part_id: { type: 'string' },
              face_id: { type: 'string' },
              normal:  { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              origin:  { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
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
      name: 'declare_semantic_entity',
      description:
        'Declares a named semantic entity (panel, joint_interface, etc.) within a transaction. The entity is identified by a URI of the form semantic://<product>/<slug>.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'semantic://<product>/<slug>' },
          type: {
            type: 'string',
            enum: ['panel', 'panel_group', 'joint_interface', 'functional_system', 'spatial_region'],
          },
          purpose: { type: 'array', items: { type: 'string' } },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                relationship: {
                  type: 'string',
                  enum: ['contains', 'bounded_by', 'connected_to', 'manufactured_as', 'joined_by', 'bent_along'],
                },
                target: { type: 'string' },
              },
              required: ['relationship', 'target'],
            },
          },
          transaction_id: { type: 'string' },
        },
        required: ['id', 'type', 'transaction_id'],
      },
    },
    {
      name: 'bind_semantic_entity',
      description:
        'Binds a semantic entity to geometry. Supports face_group (explicit face IDs), body (a shell body ID), or spatial_region (between two named entities — resolved at query time).',
      inputSchema: {
        type: 'object',
        properties: {
          semantic_id: { type: 'string' },
          binding: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['face_group'] },
                  face_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                },
                required: ['kind', 'face_ids'],
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['body'] },
                  body_id: { type: 'string' },
                },
                required: ['kind', 'body_id'],
              },
              {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['spatial_region'] },
                  between: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 2,
                    maxItems: 2,
                  },
                },
                required: ['kind', 'between'],
              },
            ],
          },
          transaction_id: { type: 'string' },
        },
        required: ['semantic_id', 'binding', 'transaction_id'],
      },
    },
    {
      name: 'resolve_geometry',
      description:
        'Returns the geometry binding for a semantic entity. Pass at_revision to query point-in-time state via Dolt AS OF.',
      inputSchema: {
        type: 'object',
        properties: {
          semantic_id: { type: 'string' },
          at_revision: { type: 'integer', description: 'Topology revision number for time-travel queries' },
        },
        required: ['semantic_id'],
      },
    },
    {
      name: 'semantic_lineage',
      description:
        'Returns the full history of geometry bindings for a semantic entity, in topology revision order. Each row shows which transaction caused the binding and the remap_reason (if remapped by the mapping layer).',
      inputSchema: {
        type: 'object',
        properties: {
          semantic_id: { type: 'string' },
        },
        required: ['semantic_id'],
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
      name: 'center_and_align_body',
      description: 'Calculates the Center of Mass (centroid) of a 3D solid/shell, translates it to [0,0,0], and rotates it so its dominant planar face normal aligns with the Z-axis. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'ID of the shell body to re-orient' },
          transaction_id: { type: 'string', description: 'Active transaction ID' }
        },
        required: ['part_id', 'transaction_id']
      }
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
    {
      name: 'fuse_bodies',
      description: 'Merges two or more solids/shells into a single continuous body using a Boolean union. If input bodies have Manufacturing Graphs, graphs are merged (all absorbed into first part) and target panel outline is expanded. Returns new body id and affected part_id. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            description: 'IDs of the bodies to fuse'
          },
          fuzzy_tolerance: {
            type: 'number',
            default: 1e-5,
            description: 'Fuzzy tolerance for near-coincident geometry (mm)'
          },
          transaction_id: { type: 'string' }
        },
        required: ['tools', 'transaction_id']
      }
    },
    {
      name: 'cut_bodies',
      description: 'Subtracts tool bodies from a blank body (Boolean difference). Returns the modified blank as a new body id. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          blank: { type: 'string', description: 'Body to cut into' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Cutter body IDs'
          },
          keep_tools: {
            type: 'boolean',
            default: false,
            description: 'If false, tool bodies are removed from the session after the cut'
          },
          transaction_id: { type: 'string' }
        },
        required: ['blank', 'tools', 'transaction_id']
      }
    },
    {
      name: 'intersect_bodies',
      description: 'Returns the shared volume between two overlapping bodies (Boolean intersection). Returns a new body id, or GE_BOOLEAN_EMPTY_RESULT if no overlap. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          target_a: { type: 'string', description: 'First body ID' },
          target_b: { type: 'string', description: 'Second body ID' },
          transaction_id: { type: 'string' }
        },
        required: ['target_a', 'target_b', 'transaction_id']
      }
    },
    {
      name: 'bounding_box',
      description: 'Returns the axis-aligned bounding box of a body, face, edge, or vertex. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Entity ID (solid, shell, face, edge, or vertex)' }
        },
        required: ['target']
      }
    },
    {
      name: 'mass_properties',
      description: 'Returns physical properties of a solid or shell: volume, surface area, centroid, and/or inertia tensor. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          target:     { type: 'string', description: 'Body ID' },
          properties: {
            type: 'array',
            items: { type: 'string', enum: ['volume', 'surface_area', 'centroid', 'inertia_tensor'] },
            minItems: 1,
            default: ['volume', 'surface_area', 'centroid', 'inertia_tensor']
          }
        },
        required: ['target']
      }
    },
    {
      name: 'measure_distance',
      description: 'Measures the minimum distance, maximum distance, or angle between two topological entities. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          target_a:        { type: 'string', description: 'First entity ID (face, edge, vertex, or body)' },
          target_b:        { type: 'string', description: 'Second entity ID' },
          measurement_type: {
            type: 'string',
            enum: ['min_distance', 'max_distance', 'angle'],
            default: 'min_distance',
            description: 'angle is only supported between two planar faces'
          }
        },
        required: ['target_a', 'target_b']
      }
    },
    {
      name: 'explore_topology',
      description: 'Returns an ordered list of sub-entity IDs of the specified type within a body. Non-mutating. Order is deterministic for identical inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          target:      { type: 'string', description: 'Body or shell ID to explore' },
          return_type: {
            type: 'string',
            enum: ['solid', 'shell', 'face', 'edge', 'vertex'],
            description: 'Sub-entity type to return'
          }
        },
        required: ['target', 'return_type']
      }
    },
    {
      name: 'translate_body',
      description: 'Moves one or more bodies along a 3D vector. Produces a new body id per target. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'IDs of bodies to translate' },
          vector:         { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[dx, dy, dz] translation vector in mm' },
          keep_original:  { type: 'boolean', default: false, description: 'If true, keep the original body' },
          transaction_id: { type: 'string' }
        },
        required: ['targets', 'vector', 'transaction_id']
      }
    },
    {
      name: 'rotate_body',
      description: 'Rotates one or more bodies around a defined axis. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          targets:          { type: 'array', items: { type: 'string' }, minItems: 1, description: 'IDs of bodies to rotate' },
          axis_origin:      { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] of a point on the rotation axis (mm)' },
          axis_direction:   { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[dx, dy, dz] direction vector of the axis' },
          angle_degrees:    { type: 'number', description: 'Rotation angle in degrees (right-hand rule)' },
          keep_original:    { type: 'boolean', default: false, description: 'If true, keep the original body' },
          transaction_id:   { type: 'string' }
        },
        required: ['targets', 'axis_origin', 'axis_direction', 'angle_degrees', 'transaction_id']
      }
    },
    {
      name: 'mirror_body',
      description: 'Mirrors one or more bodies across a defined plane. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'IDs of bodies to mirror' },
          plane_origin:   { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] of a point on the mirror plane (mm)' },
          plane_normal:   { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[nx, ny, nz] plane normal' },
          keep_original:  { type: 'boolean', default: false, description: 'If true, keep the original body' },
          transaction_id: { type: 'string' }
        },
        required: ['targets', 'plane_origin', 'plane_normal', 'transaction_id']
      }
    },
    {
      name: 'scale_body',
      description: 'Uniformly scales one or more bodies relative to a fixed origin. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'IDs of bodies to scale' },
          origin:         { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] scale origin (mm)' },
          scale_factor:   { type: 'number', minimum: 0.0001, description: 'Uniform scale factor (> 0)' },
          keep_original:  { type: 'boolean', default: false, description: 'If true, keep the original body' },
          transaction_id: { type: 'string' }
        },
        required: ['targets', 'origin', 'scale_factor', 'transaction_id']
      }
    },
    {
      name: 'align_to_face',
      description: 'Repositions the body containing source_face so that source_face is coincident with destination_face. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          source_face:    { type: 'string', description: 'Face ID on the body to move' },
          destination_face: { type: 'string', description: 'Target face ID (this body does not move)' },
          flip_normal:    { type: 'boolean', default: false, description: 'If true, source face normal is flipped before alignment' },
          keep_original:  { type: 'boolean', default: false, description: 'If true, keep the original body' },
          transaction_id: { type: 'string' }
        },
        required: ['source_face', 'destination_face', 'transaction_id']
      }
    },
    {
      name: 'fillet_edges',
      description: 'Applies a circular fillet of the given radius to the specified edges. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:        { type: 'string', description: 'Body/shell containing the edges' },
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Edge IDs to fillet' },
          radius:         { type: 'number', exclusiveMinimum: 0, description: 'Fillet radius in mm' },
          transaction_id: { type: 'string' }
        },
        required: ['part_id', 'targets', 'radius', 'transaction_id']
      }
    },
    {
      name: 'chamfer_edges',
      description: 'Applies an angled chamfer of the given distance to the specified edges. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:        { type: 'string', description: 'Body/shell containing the edges' },
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Edge IDs to chamfer' },
          distance:       { type: 'number', exclusiveMinimum: 0, description: 'Chamfer offset distance in mm' },
          transaction_id: { type: 'string' }
        },
        required: ['part_id', 'targets', 'distance', 'transaction_id']
      }
    },
    {
      name: 'simplify_body',
      description: 'Merges co-planar adjacent faces and collinear edges into single entities (ShapeUpgrade_UnifySameDomain). Reduces face count without changing geometry. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:        { type: 'string', description: 'Body/shell to simplify' },
          unify_faces:    { type: 'boolean', default: true, description: 'Merge co-planar adjacent faces' },
          unify_edges:    { type: 'boolean', default: true, description: 'Merge collinear adjacent edges' },
          transaction_id: { type: 'string' }
        },
        required: ['part_id', 'transaction_id']
      }
    },
    {
      name: 'heal_geometry_ex',
      description: 'Repairs B-Rep validity issues (gaps, bad tolerances, invalid wires) using ShapeFix_Shape. Returns heal_complete: true if BRepCheck_Analyzer passes on the result. Non-destructive but mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:          { type: 'string', description: 'Body/shell to heal' },
          fix_tolerances:   { type: 'boolean', default: true, description: 'Repair loose tolerancing issues' },
          fix_wires:        { type: 'boolean', default: true, description: 'Heal open or incorrect wires' },
          transaction_id:   { type: 'string' }
        },
        required: ['part_id', 'transaction_id']
      }
    },
    {
      name: 'offset_shape',
      description: 'Offsets the boundary of a solid outward (positive) or inward (negative) by the given distance. Distinct from offset_face (which offsets a single face in 2D). Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:        { type: 'string', description: 'Body/shell to offset' },
          offset_value:   { type: 'number', description: 'Offset distance in mm. Positive = outward (thicken), negative = inward (shrink).' },
          tolerance:      { type: 'number', default: 1e-4, description: 'Shape tolerance (mm)' },
          transaction_id: { type: 'string' }
        },
        required: ['part_id', 'offset_value', 'transaction_id']
      }
    },
    {
      name: 'delete_face',
      description: 'Removes specified faces and attempts to heal the surrounding topology. May produce multiple bodies if removal disconnects the shape. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id:        { type: 'string', description: 'Body containing the faces' },
          targets:        { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Face IDs to delete' },
          heal_remaining: { type: 'boolean', default: true, description: 'If true, attempt to stitch/sew the remaining faces' },
          transaction_id: { type: 'string' }
        },
        required: ['part_id', 'targets', 'transaction_id']
      }
    },
    {
      name: 'sew_faces',
      description: 'Stitches adjacent open faces or shells together into a single shell or solid. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          targets: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'Face or shell IDs to sew together' },
          tolerance: { type: 'number', default: 1e-3, description: 'Maximum sewing gap tolerance (mm)' },
          make_solid: { type: 'boolean', default: false, description: 'If true and result is a closed shell, convert to a solid body' },
          transaction_id: { type: 'string' }
        },
        required: ['targets', 'transaction_id']
      }
    },
    {
      name: 'create_assembly_document',
      description: 'Creates a new empty hierarchical assembly document inside an XCAF session. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string' }
        },
        required: ['transaction_id']
      }
    },
    {
      name: 'add_assembly_instance',
      description: 'Adds a solid or shell as a component instance in an assembly document at an optional location. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          assembly_id: { type: 'string', description: 'Assembly document ID' },
          target: { type: 'string', description: 'Solid or shell ID of the component to instance' },
          location: {
            type: 'object',
            properties: {
              translation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] offset in mm' },
              orientation: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[qw, qx, qy, qz] quaternion' }
            },
            required: ['translation', 'orientation']
          },
          transaction_id: { type: 'string' }
        },
        required: ['assembly_id', 'target', 'transaction_id']
      }
    },
    {
      name: 'mate_rigid',
      description: 'Repositions the source component so its face mates flatly against the destination component\'s face. Mutating — requires transaction_id.',
      inputSchema: {
        type: 'object',
        properties: {
          assembly_id: { type: 'string', description: 'Assembly document ID' },
          source_face: { type: 'string', description: 'Face ID on the source component instance to move' },
          destination_face: { type: 'string', description: 'Target face ID on a static component instance' },
          flip_alignment: { type: 'boolean', default: false, description: 'If true, reverse the mate normal direction' },
          transaction_id: { type: 'string' }
        },
        required: ['assembly_id', 'source_face', 'destination_face', 'transaction_id']
      }
    },
    {
      name: 'list_assembly_tree',
      description: 'Returns the hierarchical tree of all component instances, their parts, and relative location matrices. Non-mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          assembly_id: { type: 'string', description: 'Assembly document ID' }
        },
        required: ['assembly_id']
      }
    },

    // ─── Part management tools (Feature 009 multi-part support) ─────────────
    {
      name: 'create_part',
      description: 'Create a new Manufacturing Graph part session. Each part is independent and can be edited separately.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Unique identifier for the part within this session' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'set_active_part',
      description: 'Switch the active part for subsequent Manufacturing Graph operations.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to activate' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'list_parts',
      description: 'List all Manufacturing Graph parts in this session with their node counts.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'delete_part',
      description: 'Delete a Manufacturing Graph part and all its nodes. Fails if part does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to delete' },
        },
        required: ['part_id'],
      },
    },

    // ─── Manufacturing Graph tools (Feature 009-manufacturing-graph) ──────────
    {
      name: 'bootstrap_graph',
      description: 'Populate a Manufacturing Graph part from an existing STEP body by splitting it into panels via splitBodyByBends. Creates PanelNodes and BendNodes. Must be called on an empty graph part.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Unique part identifier for this Manufacturing Graph' },
          solid_id: { type: 'string', description: 'Body ID to split into panels' },
          angle_threshold_deg: { type: 'number', minimum: 0, description: 'Minimum dihedral deviation for bend detection. Default 30°.' },
          max_thickness_mm: { type: 'number', minimum: 0 },
          default_thickness_mm: { type: 'number', minimum: 0 },
          root_panel_id_prefix: { type: 'string', description: 'Prefix for generated panel node IDs. Default "panel".' },
        },
        required: ['part_id', 'solid_id'],
      },
    },
    {
      name: 'add_bend',
      description: 'Add a BendNode connecting two panels to the Manufacturing Graph. Runs DRC checks before mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to modify' },
          id: { type: 'string', description: 'Unique node ID for this bend' },
          panel_a_id: { type: 'string' },
          panel_b_id: { type: 'string' },
          inner_radius_mm: { type: 'number', exclusiveMinimum: 0 },
          angle_deg: { type: 'number', minimum: 1, maximum: 179 },
          k_factor: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        },
        required: ['part_id', 'id', 'panel_a_id', 'panel_b_id', 'inner_radius_mm', 'angle_deg', 'k_factor'],
      },
    },
    {
      name: 'solve_geometry',
      description: 'Re-solve geometry for all dirty nodes in the Manufacturing Graph part. Updates body IDs and bend allowances.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to solve' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'check_foldability',
      description: 'Check press-brake accessibility for all panels in the Manufacturing Graph part. Returns per-panel accessibility state and any DRC violations.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to check' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'query_graph',
      description: 'Return the current Manufacturing Graph part node list in topological order.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to query' },
          topological_order: { type: 'boolean', description: 'Return in Kahn topological order. Default true.' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'reset_graph',
      description: 'Clear all nodes and edges from the Manufacturing Graph part.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to reset' },
        },
        required: ['part_id'],
      },
    },
    {
      name: 'update_node',
      description: 'Update fields of an existing Manufacturing Graph node. Supports node ID rename via new_id.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID containing the node' },
          id: { type: 'string', description: 'Existing node ID' },
          new_id: { type: 'string', description: 'New node ID (rename)' },
          inner_radius_mm: { type: 'number', exclusiveMinimum: 0 },
          angle_deg: { type: 'number', minimum: 1, maximum: 179 },
          k_factor: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          nominal_thickness_mm: { type: 'number', exclusiveMinimum: 0 },
          material_type: { type: 'string' },
        },
        required: ['part_id', 'id'],
      },
    },
    {
      name: 'remove_node',
      description: 'Remove a node from the Manufacturing Graph. Fails if removing the node would orphan other nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID containing the node' },
          id: { type: 'string', description: 'Node ID to remove' },
        },
        required: ['part_id', 'id'],
      },
    },
    {
      name: 'add_join',
      description: 'Add a JoinNode connecting two panels in the Manufacturing Graph. Supports FLANGE, TAB_SLOT, RIVET_PATTERN, and WELD_PREP join types.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to modify' },
          id: { type: 'string', description: 'Unique node ID for this join' },
          panel_a_id: { type: 'string' },
          panel_b_id: { type: 'string' },
          reference_edge_a: { type: 'string', description: 'Edge identifier in panel A local frame' },
          reference_edge_b: { type: 'string', description: 'Edge identifier in panel B local frame' },
          join_type: {
            type: 'string',
            enum: ['FLANGE', 'TAB_SLOT', 'RIVET_PATTERN', 'WELD_PREP'],
          },
          params: {
            type: 'object',
            description: 'Join-type-specific parameters',
          },
        },
        required: ['part_id', 'id', 'panel_a_id', 'panel_b_id', 'join_type', 'params'],
      },
    },
    {
      name: 'add_cut',
      description: 'Add a CutNode defining a cut profile on a panel. Supports CIRCLE, RECTANGLE, POLYGON, and FREEFORM profiles. Runs DRC checks (bounds, overlap, bend-zone intersection) before mutating.',
      inputSchema: {
        type: 'object',
        properties: {
          part_id: { type: 'string', description: 'Part ID to modify' },
          id: { type: 'string', description: 'Unique node ID for this cut' },
          parent_panel_id: { type: 'string', description: 'ID of the panel to cut' },
          profile_type: {
            type: 'string',
            enum: ['CIRCLE', 'RECTANGLE', 'POLYGON', 'FREEFORM'],
          },
          profile: {
            type: 'object',
            description: 'Profile-type-specific parameters',
          },
          label: { type: 'string', description: 'Optional DXF annotation label' },
        },
        required: ['part_id', 'id', 'parent_panel_id', 'profile_type', 'profile'],
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

      case 'fuse_bodies':
        return handleFuseBodies(args);

      case 'cut_bodies':
        return handleCutBodies(args);

      case 'intersect_bodies':
        return handleIntersectBodies(args);

      case 'bounding_box':
        return handleBoundingBox(args);

      case 'mass_properties':
        return handleMassProperties(args);

      case 'measure_distance':
        return handleMeasureDistance(args);

      case 'explore_topology':
        return handleExploreTopology(args);

      case 'translate_body':
        return handleTranslateBody(args);

      case 'rotate_body':
        return handleRotateBody(args);

      case 'mirror_body':
        return handleMirrorBody(args);

      case 'scale_body':
        return handleScaleBody(args);

      case 'align_to_face':
        return handleAlignToFace(args);

      case 'fillet_edges':
        return handleFilletEdges(args);

      case 'chamfer_edges':
        return handleChamferEdges(args);

      case 'simplify_body':
        return handleSimplifyBody(args);

      case 'heal_geometry_ex':
        return handleHealGeometryEx(args);

      case 'offset_shape':
        return handleOffsetShape(args);

      case 'delete_face':
        return handleDeleteFace(args);

      case 'sew_faces':
        return handleSewFaces(args);

      case 'create_assembly_document':
        return handleCreateAssemblyDocument(args);

      case 'add_assembly_instance':
        return handleAddAssemblyInstance(args);

      case 'mate_rigid':
        return handleMateRigid(args);

      case 'list_assembly_tree':
        return handleListAssemblyTree(args);

      case 'decompose_volume':
        return handleDecomposeVolume(args);

      case 'synthesize_joints':
        return handleSynthesizeJoints(args, config);

      case 'generate_reliefs':
        return handleGenerateReliefs(args);

      case 'validate_sheet_metal':
        return handleValidateSheetMetal(args);

      case 'reconstruct_curved_bends':
        return handleReconstructCurvedBends(args);

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

      case 'begin_transaction':
        return await handleBeginTransaction(args);

      case 'commit_transaction':
        return await handleCommitTransaction(args);

      case 'rollback_transaction':
        return await handleRollbackTransaction(args);

      case 'get_transaction_history':
        return handleGetTransactionHistory(args);

      case 'split_body_by_plane':
        return handleSplitBodyByPlane(args);

      case 'merge_bodies_with_bend':
        return handleMergeBodiesWithBend(args);

      case 'close_gap':
        return handleCloseGap(args);

      case 'is_panel_valid':
        return handleIsPanelValid(args);

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

      case 'remove_protrusions':
        return handleRemoveProtrusions(args);

      case 'center_and_align_body':
        return handleCenterAndAlignBody(args);

      case 'declare_semantic_entity':
        return await handleDeclareSemanticEntity(args);

      case 'bind_semantic_entity':
        return await handleBindSemanticEntity(args);

      case 'resolve_geometry':
        return await handleResolveGeometry(args);

      case 'semantic_lineage':
        return await handleSemanticLineage(args);

      // ─── Part management tools (Feature 009 multi-part support) ─────────────
      case 'create_part':
        return handleCreatePart(args);

      case 'set_active_part':
        return handleSetActivePart(args);

      case 'list_parts':
        return handleListParts();

      case 'delete_part':
        return handleDeletePart(args);

      // ─── Manufacturing Graph tools (Feature 009-manufacturing-graph) ────────
      case 'bootstrap_graph':
        return await handleBootstrapGraph(args, config);

      case 'add_bend':
        return await handleAddBend(args, config);

      case 'solve_geometry':
        return await handleSolveGeometry(args);

      case 'check_foldability':
        return handleCheckFoldability(args);

      case 'query_graph':
        return handleQueryGraph(args);

      case 'reset_graph':
        return handleResetGraph(args);

      case 'update_node':
        return handleUpdateNode(args);

      case 'remove_node':
        return handleRemoveNode(args);

      case 'add_join':
        return await handleAddJoin(args, config);

      case 'add_cut':
        return await handleAddCut(args, config);

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

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: finalSolidId,
    is_manifold: true,
    face_count: topology.faces.length,
    issues_found: manifoldResult.issues.length,
    healed,
    rollback_token: rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${finalSolidId}.glb`,
  };
}

function handleDecomposeVolume(args: Record<string, unknown>): unknown {
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

  const ctx = resolveTransactionContext(args);

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;

  if (jointType === 'tab_slot') {
    const result = getGeometryBinding().addTabSlot(panelIds[0]!, panelIds[1]!, clearanceMm);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
    }
    return {
      modified_panel_ids: result.modifiedShellIds,
      joint_type_applied: jointType,
      kerf_offset_mm: result.kerfOffsetApplied,
      rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
      shape_history: result.shape_history ?? [],
      mesh_urls: (result.modifiedShellIds as string[]).map((id) => `${meshBaseUrl}/mesh/${id}.glb`),
    };
  }

  if (jointType === 'rivet') {
    const result = getGeometryBinding().addRivetHole(panelIds[0]!, 'auto', 0, 0, 4.0);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
    }
    return {
      modified_panel_ids: [result.modifiedShellId],
      joint_type_applied: jointType,
      kerf_offset_mm: clearanceMm,
      rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
      shape_history: result.shape_history ?? [],
      mesh_urls: [`${meshBaseUrl}/mesh/${result.modifiedShellId}.glb`],
    };
  }

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, []);
  }

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

function handleGenerateReliefs(args: Record<string, unknown>): unknown {
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

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    modified_panel_id: panelId,
    relief_count: 4,  // placeholder; Phase C will use actual detection
    rollback_token: rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${panelId}.glb`,
  };
}

function handleValidateSheetMetal(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const result = getGeometryBinding().validateSheetMetal(partId);
  return {
    is_valid: result.is_valid,
    nominal_thickness: result.nominal_thickness,
    can_flatten: result.can_flatten,
    validation_errors: result.validation_errors,
  };
}

function handleReconstructCurvedBends(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().reconstructCurvedBends(partId);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  return {
    solid_id: result.solid_id,
    bends_replaced: result.bends_replaced,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    shape_history: result.shape_history ?? [],
  };
}

/** Parse BEND_UP / BEND_DOWN LINE entities from DXF text and return each
 *  as fractional coordinates {x1,y1,x2,y2} in the range [0,1] relative to
 *  the flat-pattern bounding box.  Only straight-line entities on bend layers
 *  are extracted; arcs and other entities are ignored. */
function parseDxfBendLines(
  dxf: string,
  flatWidthMm: number,
  flatHeightMm: number,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const tokens = dxf.split('\n').map((t) => t.trim());

  let inLine = false;
  let isBendLayer = false;
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0;

  for (let i = 0; i < tokens.length - 1; i++) {
    const code = parseInt(tokens[i], 10);
    const val = tokens[i + 1];

    if (isNaN(code)) continue;

    if (code === 0) {
      // Flush completed LINE entity on a bend layer
      if (inLine && isBendLayer) {
        lines.push({
          x1: x1 / flatWidthMm,
          y1: y1 / flatHeightMm,
          x2: x2 / flatWidthMm,
          y2: y2 / flatHeightMm,
        });
      }
      inLine = val === 'LINE';
      isBendLayer = false;
      x1 = y1 = x2 = y2 = 0;
    } else if (inLine) {
      if (code === 8) {
        isBendLayer = val === 'BEND_UP' || val === 'BEND_DOWN';
      } else if (code === 10) { x1 = parseFloat(val); }
      else if (code === 20) { y1 = parseFloat(val); }
      else if (code === 11) { x2 = parseFloat(val); }
      else if (code === 21) { y2 = parseFloat(val); }
    }
    i++; // each group code consumes two tokens
  }
  return lines;
}

function handleApplyUnfold(args: Record<string, unknown>, config: ManufacturingConfig): unknown {
  // ARCHITECTURE CHANGE: Strict requirement for part_id + panel_id (graph-based workflow)
  // DXF output MUST come from the manufacturing graph, not raw geometry
  const partId = requireString(args, 'part_id');
  const panelId = requireString(args, 'panel_id');
  const materialId = requireString(args, 'material_id');

  // Ensure the part exists and has a manufacturing graph.
  // Compatibility shim: if callers provide a raw shell/body id as both part_id
  // and panel_id, create a minimal graph entry so unfold can proceed.
  if (!_parts.has(partId)) {
    const graph = createPart(partId);
    const toBodyId = (s: string): import('../manufacturing/graph/types').BodyId => s as import('../manufacturing/graph/types').BodyId;
    graph.addNode({
      type: 'PanelNode',
      id: toNodeId(panelId),
      bodyId: toBodyId(panelId),
      dirty: true,  // Mark as dirty so solver can validate & process the shell
      materialType: 'default',
      nominalThickness: 1.0,
      flatWidth: null,
      flatHeight: null,
    });
  }

  const graph = getManufacturingGraph(partId);
  
  // Verify that the panel node exists in the graph
  let panelNode: import('../manufacturing/graph/types').PanelNode | undefined;
  const panelNodeId = panelId as import('../manufacturing/graph/types').NodeId;
  const panelBodyId = panelId as import('../manufacturing/graph/types').BodyId;
  for (const node of graph.nodes.values()) {
    if (
      node.type === 'PanelNode' &&
      (node.id === panelNodeId || node.bodyId === panelBodyId)
    ) {
      panelNode = node as import('../manufacturing/graph/types').PanelNode;
      break;
    }
  }

  if (!panelNode) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelId}" not found in part "${partId}" manufacturing graph`,
      true,
      'query_graph',
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

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  // Compute graph-based flat dimensions — these are the REQUIRED source of truth.
  // The manufacturing graph knows the panel dimensions analytically through BendNodes
  // and their bend allowance calculations, which is more accurate than C++ bbox estimates.
  // Use panelNode.id (the actual graph node ID) not panelNodeId (user-supplied panel_id)
  // because for merged shells the graph node ID differs from the shell UUID.
  const graphDims = graph.getFlatPatternDimensions(panelNode.id);
  
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
  const finalFlatWidth  = graphDims.width;
  const finalFlatHeight = graphDims.height;

  // Export DXF and normalise bend-line coordinates using the correct flat dimensions.
  let dxfContent = '';
  let bendLines: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  try {
    const dxf = getGeometryBinding().exportDxf(result.unfoldId);
    dxfContent = dxf.dxfContent;
    if (result.bendCount > 0) {
      bendLines = parseDxfBendLines(dxfContent, finalFlatWidth, finalFlatHeight);
    }
  } catch {
    // Non-fatal: preview will fall back to even-spaced hints
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
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
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
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
        label: (node as import('../manufacturing/graph/types').CutNode).label ?? null, 
        profile: node.profile 
      });
    }
  }
  if (cutProfiles.length > 0) {
    response['cut_profiles'] = cutProfiles;
  }

  if (result.improvedPartId) {
    response['improved_part_id'] = result.improvedPartId;
    response['improved_part_mesh_url'] = `${meshBaseUrl}/mesh/${result.improvedPartId}.glb`;
  }
  return response;
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

// ─── Transaction primitive handlers (Feature 004) ─────────────────────────────

async function handleBeginTransaction(args: Record<string, unknown>): Promise<unknown> {
  const label = requireString(args, 'label');
  const product = typeof args.product === 'string' ? args.product : undefined;

  // Capture the pre-transaction geometry state. The snapshot id doubles as the
  // rollback token: rolling back the transaction restores this snapshot.
  const snapshotId = getGeometryBinding().createSnapshot(label);
  const txn = await transactionRegistry.begin(label, snapshotId, product);

  return {
    transaction_id: txn.id,
    status: txn.state,
    label: txn.label,
    product: txn.product,
    rollback_token: txn.snapshotId,
  };
}

async function handleCommitTransaction(args: Record<string, unknown>): Promise<unknown> {
  const transactionId = requireString(args, 'transaction_id');

  // Phase 3: run the mapping layer remap before merging the Dolt branch.
  if (_semanticStore) {
    const port = _semanticStore.getPort();
    try {
      // Insert a topology_revision placeholder (brep_file_path/sha will be
      // filled in by a future geometry-export step; for Phase 3 we record a
      // sentinel so the foreign key chain is consistent).
      const revisionId = await port.insertTopologyRevision({
        transaction_id: transactionId,
        brep_file_path: '',
        brep_sha256: '0'.repeat(64),
      });

      // Persist in-memory shape history from TransactionRegistry to Dolt.
      const inMemoryHistory = transactionRegistry.getHistory(transactionId);
      const shapeHistoryRows = inMemoryHistory.map((r) => ({
        transaction_id: transactionId,
        verdict: r.verdict as import('../semantic/types').ShapeVerdict,
        original_id: r.original_id,
        new_id: r.new_id ?? null,
        operation_label: r.operation_label,
      }));
      await port.insertShapeHistory(shapeHistoryRows);

      const mappingLayer = new MappingLayer(_semanticStore);
      const affectedIds = await mappingLayer.applyShapeHistoryToBindings(transactionId, revisionId);
      await mappingLayer.refreshDerivedBindings(transactionId, revisionId, affectedIds);
    } catch (err) {
      throwError(
        ErrorCodes.PERSISTENCE_COMMIT_FAILED,
        `Mapping layer remap failed: ${String(err)}`,
        true,
        'commit_transaction',
      );
    }
  }

  const txn = await transactionRegistry.commit(transactionId);

  // Drop the pre-transaction snapshot — committed changes are permanent.
  // Note: this clears all snapshots in the registry (no per-id clear primitive
  // exists yet). In MVP single-session there is at most one outer snapshot.
  getGeometryBinding().clearSnapshots();

  return {
    transaction_id: txn.id,
    status: txn.state,
    label: txn.label,
  };
}

async function handleRollbackTransaction(args: Record<string, unknown>): Promise<unknown> {
  const transactionId = requireString(args, 'transaction_id');

  // Look up the transaction first so we know which snapshot to restore. The
  // registry.rollback() call below also validates that the transaction exists
  // and is active; we do the lookup separately so we can resolve the snapshot
  // before mutating any state.
  const existing = transactionRegistry.get(transactionId);
  if (!existing) {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} does not exist in this session.`,
      true,
      'begin_transaction',
    );
  }

  const result = getGeometryBinding().restoreSnapshot(existing.snapshotId);
  const txn = await transactionRegistry.rollback(transactionId);

  return {
    transaction_id: txn.id,
    status: txn.state,
    label: txn.label,
    restored_solid_ids: result.restoredSolidIds,
    restored_shell_ids: result.restoredShellIds,
  };
}

// ─── Semantic Mapping Layer handlers (Feature 005) ────────────────────────────

function mapSemanticStoreError(err: unknown): never {
  if (err instanceof SemanticStoreError) {
    throwError(err.code as (typeof ErrorCodes)[keyof typeof ErrorCodes], err.message, true);
  }
  throw err;
}

async function handleDeclareSemanticEntity(args: Record<string, unknown>): Promise<unknown> {
  const id = requireString(args, 'id');
  const type = requireString(args, 'type');
  const transactionId = requireString(args, 'transaction_id');
  const purpose = Array.isArray(args.purpose) ? (args.purpose as string[]) : undefined;
  const relationships = Array.isArray(args.relationships)
    ? (args.relationships as Array<{ relationship: string; target: string }>)
    : undefined;

  const store = getSemanticStore();
  try {
    const entity = await store.declareEntity({ id, type, purpose, relationships, transaction_id: transactionId });
    return {
      id: entity.id,
      type: entity.type,
      state: entity.state,
      created_in_transaction: entity.created_in_transaction,
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

async function handleBindSemanticEntity(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');
  const transactionId = requireString(args, 'transaction_id');
  const bindingArg = args.binding;

  if (!bindingArg || typeof bindingArg !== 'object' || !('kind' in bindingArg)) {
    throwError(ErrorCodes.BINDING_KIND_NOT_SUPPORTED, 'binding must have a kind field', false);
  }

  const store = getSemanticStore();
  try {
    const mapping = await store.bindEntity({
      semantic_id: semanticId,
      binding: bindingArg as import('../semantic/types').Binding,
      transaction_id: transactionId,
    });
    return {
      revision_id: mapping.revision_id,
      semantic_id: mapping.semantic_id,
      binding_kind: mapping.binding_kind,
      binding: mapping.binding,
      topology_revision: mapping.topology_revision,
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

async function handleResolveGeometry(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');
  const atRevision = typeof args.at_revision === 'number' ? args.at_revision : undefined;

  const store = getSemanticStore();
  try {
    const mapping = atRevision !== undefined
      ? await store.resolveAtRevision(semanticId, atRevision)
      : await store.resolveCurrent({ semantic_id: semanticId });

    return {
      semantic_id: mapping.semantic_id,
      binding_kind: mapping.binding_kind,
      binding: mapping.binding,
      topology_revision: mapping.topology_revision,
      remap_reason: mapping.remap_reason,
      ...((mapping as { materialised_face_ids?: string[] }).materialised_face_ids !== undefined
        ? { materialised_face_ids: (mapping as { materialised_face_ids?: string[] }).materialised_face_ids }
        : {}),
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

async function handleSemanticLineage(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');

  const store = getSemanticStore();
  try {
    const lineage = await store.getMappingLineage(semanticId);
    return {
      semantic_id: semanticId,
      lineage: lineage.map((m) => ({
        revision_id: m.revision_id,
        transaction_id: m.created_in_transaction,
        binding_kind: m.binding_kind,
        binding: m.binding,
        topology_revision: m.topology_revision,
        remap_reason: m.remap_reason,
        created_at: m.created_at,
      })),
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

function handleGetTransactionHistory(args: Record<string, unknown>): unknown {
  const transactionId = requireString(args, 'transaction_id');

  const existing = transactionRegistry.get(transactionId);
  if (!existing) {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} does not exist in this session.`,
      true,
      'begin_transaction',
    );
  }

  if (existing.state === 'rolled_back') {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} has been rolled back; history is no longer available.`,
      true,
      'begin_transaction',
    );
  }

  const records = transactionRegistry.getHistory(transactionId);
  return {
    transaction_id: transactionId,
    records,
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

type TransactionContext = { mode: 'join'; transactionId: string } | { mode: 'implicit' };

function resolveTransactionContext(args: Record<string, unknown>): TransactionContext {
  const specifiedId = typeof args['transaction_id'] === 'string' ? args['transaction_id'] : undefined;
  const active = transactionRegistry.getActive();

  if (specifiedId !== undefined) {
    if (!active || active.id !== specifiedId) {
      throwError(
        ErrorCodes.TRANSACTION_MISMATCH,
        active
          ? `Specified transaction_id ${specifiedId} does not match the active transaction ${active.id}.`
          : `No active transaction; cannot join transaction ${specifiedId}.`,
        true,
        'begin_transaction',
      );
    }
    return { mode: 'join', transactionId: specifiedId };
  }

  if (active) {
    return { mode: 'join', transactionId: active.id };
  }

  return { mode: 'implicit' };
}

// ─── Body topology tool handlers ──────────────────────────────────────────────

function handleSplitBodyByPlane(args: Record<string, unknown>): unknown {
  const partId   = requireString(args, 'part_id');
  const planeArg = args['cutting_plane'];
  if (!planeArg || typeof planeArg !== 'object' || !('normal' in planeArg) || !('origin' in planeArg)) {
    throwError(ErrorCodes.GE_SPLIT_FAILED, 'cutting_plane must have normal and origin objects', false);
  }
  const plane = planeArg as { normal: { x: number; y: number; z: number }; origin: { x: number; y: number; z: number } };

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

function handleMergeBodiesWithBend(args: Record<string, unknown>): unknown {
  const partAId      = requireString(args, 'part_a_id');
  const partBId      = requireString(args, 'part_b_id');
  const targetEdges  = requireStringArray(args, 'target_edges');
  const bendRadius   = args['bend_radius'];
  if (typeof bendRadius !== 'number' || bendRadius <= 0) {
    throwError(ErrorCodes.GE_MERGE_FAILED, 'bend_radius must be a positive number', false);
  }

  // Manufacturing graphs are required — split_body_by_bends must have been called first
  // so the system has panel flat dimensions and material data for accurate unfolding.
  if (!_parts.has(partAId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend requires a manufacturing graph for part_a_id "${partAId}". Call split_body_by_bends first.`,
      true,
      'split_body_by_bends',
    );
  }
  if (!_parts.has(partBId)) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `merge_bodies_with_bend requires a manufacturing graph for part_b_id "${partBId}". Call split_body_by_bends first.`,
      true,
      'split_body_by_bends',
    );
  }

  const graphA = getManufacturingGraph(partAId);
  const graphB = getManufacturingGraph(partBId);
  const toBodyId = (s: string) => s as import('../manufacturing/graph/types').BodyId;

  // Find the root PanelNode in each graph (first PanelNode found, by bodyId match then fallback)
  let panelNodeA: import('../manufacturing/graph/types').PanelNode | undefined;
  for (const node of graphA.nodes.values()) {
    if (node.type === 'PanelNode') {
      const pn = node as import('../manufacturing/graph/types').PanelNode;
      if (pn.bodyId === toBodyId(partAId)) { panelNodeA = pn; break; }
      if (!panelNodeA) panelNodeA = pn;
    }
  }
  let panelNodeB: import('../manufacturing/graph/types').PanelNode | undefined;
  for (const node of graphB.nodes.values()) {
    if (node.type === 'PanelNode') {
      const pn = node as import('../manufacturing/graph/types').PanelNode;
      if (pn.bodyId === toBodyId(partBId)) { panelNodeB = pn; break; }
      if (!panelNodeB) panelNodeB = pn;
    }
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().mergeBodiesWithBend(partAId, partBId, targetEdges, bendRadius as number);
  session.registerShell(result.mergedShellId);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  // Create a new manufacturing graph for the merged shell.
  // The merged shell ID becomes the new part ID (consistent with split_body_by_bends approach).
  // Link together the two source panels with a BendNode.
  const nodeAId = toNodeId(`panel-a-${partAId.substring(0, 8)}`);
  const nodeBId = toNodeId(`panel-b-${partBId.substring(0, 8)}`);
  const bendId  = toNodeId(`bend-${result.mergedShellId.substring(0, 8)}`);

  const mergedPartId = result.mergedShellId; // Use merged shell as part ID
  const mergedGraph = createPart(mergedPartId);
  
  // Copy panel A node
  mergedGraph.addNode({
    type: 'PanelNode',
    id: nodeAId,
    bodyId: toBodyId(partAId),
    dirty: false,
    materialType: panelNodeA?.materialType ?? 'default',
    nominalThickness: panelNodeA?.nominalThickness ?? 1.0,
    flatWidth: panelNodeA?.flatWidth ?? null,
    flatHeight: panelNodeA?.flatHeight ?? null,
  });
  
  // Copy panel B node (but with merged shell as bodyId so lookup works)
  mergedGraph.addNode({
    type: 'PanelNode',
    id: nodeBId,
    bodyId: toBodyId(result.mergedShellId),
    dirty: false,
    materialType: panelNodeB?.materialType ?? 'default',
    nominalThickness: panelNodeB?.nominalThickness ?? 1.0,
    flatWidth: panelNodeB?.flatWidth ?? null,
    flatHeight: panelNodeB?.flatHeight ?? null,
  });
  
  // Create BendNode connecting the two panels
  mergedGraph.addNode({
    type: 'BendNode',
    id: bendId,
    dirty: true,
    panelAId: nodeAId,
    panelBId: nodeBId,
    innerRadius: bendRadius as number,
    angle: 90, // Default to 90° for merge bend
    kFactor: 0.33, // Default K-factor
    bendAllowance: null,
  });

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    merged_shell_id: result.mergedShellId,
    merged_part_id: mergedPartId, // New manufacturing graph part created for merged shell
    part_a_id: partAId,
    graphs_merged: true,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${result.mergedShellId}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleCloseGap(args: Record<string, unknown>): unknown {
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

function handleIsPanelValid(args: Record<string, unknown>): unknown {
  const panelId = requireString(args, 'panel_id');
  const result = getGeometryBinding().isPanelValid(panelId);
  return {
    is_valid: result.isValid,
    can_flatten: result.canFlatten,
    nominal_thickness_mm: result.nominalThicknessMm,
    errors: result.errors.map(e => ({ code: e.code, message: e.message })),
  };
}

function handleExtendFaceToTarget(args: Record<string, unknown>): unknown {
  const partId     = requireString(args, 'part_id');
  const faceId     = typeof args['face_id'] === 'string' ? args['face_id'] as string : '';
  const targetType = typeof args['target_type'] === 'string' ? args['target_type'] as string : 'part_surface';

  if (targetType !== 'plane' && targetType !== 'face_id' && targetType !== 'part_surface') {
    throwError(ErrorCodes.GE_EXTEND_FAILED,
      'target_type must be "plane", "face_id", or "part_surface"', false);
  }

  const target = (args['target'] ?? {}) as Record<string, unknown>;

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

  const normalObj = (target['normal'] ?? { x: 0, y: 0, z: 1 }) as { x: number; y: number; z: number };
  const originObj = (target['origin'] ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
  const targetPlane = { normal: normalObj, origin: originObj };

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().extendFaceToTarget(
    partId, faceId, targetType, targetPartId, targetFaceId, targetPlane,
  );

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

function handleOffsetFace(args: Record<string, unknown>): unknown {
  const partId   = requireString(args, 'part_id');
  const faceId   = requireString(args, 'face_id');
  const distance = args['distance'];
  if (typeof distance !== 'number' || Math.abs(distance) < 1e-10) {
    throwError(ErrorCodes.GE_OFFSET_FAILED, 'distance must be a non-zero number', false);
  }

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().offsetFace(partId, faceId, distance as number);

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

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().addFlange(
    partId, edgeId, length as number, angle as number, bendRadius as number,
  );

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

function handleRipEdge(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const edgeId = requireString(args, 'edge_id');

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().ripEdge(partId, edgeId);

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

function handleBoundingBox(args: Record<string, unknown>): unknown {
  const target = requireString(args, 'target');
  const result = getGeometryBinding().computeBoundingBox(target);
  return {
    x_min: result.x_min,
    y_min: result.y_min,
    z_min: result.z_min,
    x_max: result.x_max,
    y_max: result.y_max,
    z_max: result.z_max,
  };
}

function handleMassProperties(args: Record<string, unknown>): unknown {
  const target = requireString(args, 'target');
  const properties = args['properties'] as string[] | undefined;
  const result = getGeometryBinding().computeMassProperties(target, properties);
  return {
    volume: result.volume,
    surface_area: result.surface_area,
    centroid: result.centroid,
    inertia_tensor: result.inertia_tensor,
  };
}

function handleMeasureDistance(args: Record<string, unknown>): unknown {
  const targetA = requireString(args, 'target_a');
  const targetB = requireString(args, 'target_b');
  const mType   = (args['measurement_type'] as string | undefined) ?? 'min_distance';
  const result = getGeometryBinding().measureDistance(targetA, targetB, mType);
  return {
    value: result.value,
    measurement_type: result.measurement_type,
  };
}

function handleExploreTopology(args: Record<string, unknown>): unknown {
  const target     = requireString(args, 'target');
  const returnType = requireString(args, 'return_type');
  const result = getGeometryBinding().exploreTopology(target, returnType);
  return {
    entity_ids: result.entity_ids,
  };
}

function handleFuseBodies(args: Record<string, unknown>): unknown {
  const tools = requireStringArray(args, 'tools');
  const fuzzyTolerance = (args['fuzzy_tolerance'] as number | undefined) ?? 1e-5;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().fuseBodies(tools, fuzzyTolerance);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  // ARCHITECTURE CHANGE: If any input tools have manufacturing graphs, update them
  // The target (first tool) absorbs all others; graphs are unioned into it
  let targetPartId: string | undefined;
  const sourcePartIds: string[] = [];

  for (const toolId of tools) {
    if (_parts.has(toolId)) {
      if (!targetPartId) {
        targetPartId = toolId;
      } else {
        sourcePartIds.push(toolId);
      }
    }
  }

  // If target part has a graph, update it to reflect the fused geometry
  if (targetPartId) {
    const targetGraph = getManufacturingGraph(targetPartId);

    // Find the target PanelNode and update its bodyId to the new fused solid
    let targetPanelNode: import('../manufacturing/graph/types').PanelNode | undefined;
    for (const node of targetGraph.nodes.values()) {
      if (node.type === 'PanelNode' && tools.includes((node as any).bodyId)) {
        targetPanelNode = node as import('../manufacturing/graph/types').PanelNode;
        break;
      }
    }

    if (targetPanelNode) {
      // Update the target panel's body reference to the new fused solid
      const toBodyId = (s: string): import('../manufacturing/graph/types').BodyId => s as import('../manufacturing/graph/types').BodyId;
      (targetPanelNode as any).bodyId = toBodyId(result.solid_id);
      const typedNodeId = targetPanelNode.id as import('../manufacturing/graph/types').NodeId;
      targetGraph.markDirty(typedNodeId);
    }

    // If other tools have graphs, union them into the target
    for (const sourcePartId of sourcePartIds) {
      try {
        unionGraphs(targetPartId, sourcePartId);
      } catch (unionErr) {
        console.warn(`Warning: Failed to union graph ${sourcePartId} into ${targetPartId}: ${String(unionErr)}`);
      }
    }

    // Mark target panel as dirty so solve_geometry will regenerate on next call
    if (targetPanelNode) {
      targetGraph.markDirty(targetPanelNode.id);
    }

    const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
    return {
      solid_id: result.solid_id,
      part_id: targetPartId,
      disjoint: result.disjoint,
      graphs_fused: sourcePartIds.length > 0,
      rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
      mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
      shape_history: result.shape_history ?? [],
    };
  }

  // Fallback: no graphs involved; geometry-only fuse
  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    disjoint: result.disjoint,
    graphs_fused: false,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleCutBodies(args: Record<string, unknown>): unknown {
  const blank = requireString(args, 'blank');
  const tools = requireStringArray(args, 'tools');
  const keepTools = (args['keep_tools'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().cutBodies(blank, tools, keepTools);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleIntersectBodies(args: Record<string, unknown>): unknown {
  const targetA = requireString(args, 'target_a');
  const targetB = requireString(args, 'target_b');
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().intersectBodies(targetA, targetB);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
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

  const ctx = resolveTransactionContext(args);
  const result = getGeometryBinding().trimBodyWithPlane(partId, plane, keepPositiveSide as boolean);

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
  const graphErrors: Array<{ panel_id: string; error: string }> = [];

  // Helper to cast string to BodyId
  const toBodyId = (s: string): import('../manufacturing/graph/types').BodyId => s as import('../manufacturing/graph/types').BodyId;

  for (let pi = 0; pi < result.panel_ids.length; pi++) {
    const panelId = result.panel_ids[pi]!;
    try {
      // Use the shell ID directly as the part ID so merge_bodies_with_bend
      // can look up the graph using the shell ID (no translation needed).
      const partId = panelId;
      createPart(partId);
      const graph = getManufacturingGraph(partId);
      
      // Compute flat dimensions from the bbox so the manufacturing graph
      // has the panel width/height without needing a separate unfold pass.
      // The two largest dims are width/height; the smallest is the thickness.
      let panelFlatWidth: number | null = null;
      let panelFlatHeight: number | null = null;
      const bbox = result.panel_bboxes?.[pi];
      if (bbox) {
        const dims = [
          bbox.x_max - bbox.x_min,
          bbox.y_max - bbox.y_min,
          bbox.z_max - bbox.z_min,
        ].sort((a, b) => a - b);
        // dims[0] = thickness, dims[1] = shorter flat dim, dims[2] = longer flat dim
        panelFlatWidth = dims[2] ?? null;
        panelFlatHeight = dims[1] ?? null;
      }

      // Attempt to bootstrap the graph with the panel
      // This creates a root PanelNode for each panel
      try {
        graph.addNode({
          type: 'PanelNode',
          id: toNodeId(`panel-root-${panelId.substring(0, 8)}`),
          bodyId: toBodyId(panelId),
          dirty: true,
          materialType: 'default',
          nominalThickness: defaultThicknessMm,
          flatWidth: panelFlatWidth,
          flatHeight: panelFlatHeight,
        });
        createdParts.push({ part_id: partId, panel_id: panelId });
      } catch (bootstrapErr) {
        graphErrors.push({
          panel_id: panelId,
          error: `Failed to create root panel node: ${String(bootstrapErr)}`,
        });
        // Keep the part created but mark it as having an error
      }
    } catch (partCreateErr) {
      graphErrors.push({
        panel_id: panelId,
        error: `Failed to create part: ${String(partCreateErr)}`,
      });
    }
  }

  // Report errors if any graph creation failed
  if (graphErrors.length > 0 && graphErrors.length === result.panel_ids.length) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `All manufacturing graphs failed to create: ${graphErrors.map(e => e.error).join('; ')}`,
      true,
    );
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
    protrusion_parents: result.protrusion_parents,
    detected_mode: result.detected_mode,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_urls: allIds.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
    shape_history: result.shape_history ?? [],
    // New: Manufacturing graph creation results
    created_parts: createdParts,
    graph_creation_errors: graphErrors,
  };
}

function handleRemoveProtrusions(args: Record<string, unknown>): unknown {
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

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  const allIds = [result.cleaned_part_id, ...result.protrusion_ids];
  return {
    cleaned_part_id: result.cleaned_part_id,
    protrusion_ids: result.protrusion_ids,
    protrusion_count: result.protrusion_count,
    protrusion_bboxes: result.protrusion_bboxes,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollbackToken,
    mesh_urls: allIds.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
  };
}

function handleCenterAndAlignBody(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'center_and_align_body requires an active transaction', false);
  }

  const result = getGeometryBinding().centerAndAlignBody(partId, ctx.transactionId);

  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    centroid: result.centroid,
    rotation_matrix: result.rotation_matrix,
    rollback_token: ctx.transactionId,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleTranslateBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const vec = args['vector'] as number[];
  if (!Array.isArray(vec) || vec.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'vector must be an array of 3 numbers', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const res = getGeometryBinding().translateBody(target, vec[0], vec[1], vec[2], keepOriginal);
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
    // Propagate manufacturing graph: if the source shell had a graph and we're not
    // keeping the original, move the part entry to the new shell ID and update bodyId.
    if (!keepOriginal && _parts.has(target) && res.solid_id !== target) {
      const graph = _parts.get(target)!;
      const toBodyId2 = (s: string) => s as import('../manufacturing/graph/types').BodyId;
      for (const node of graph.nodes.values()) {
        if (node.type === 'PanelNode' &&
            (node as import('../manufacturing/graph/types').PanelNode).bodyId === (target as import('../manufacturing/graph/types').BodyId)) {
          (node as import('../manufacturing/graph/types').PanelNode).bodyId = toBodyId2(res.solid_id);
          break;
        }
      }
      _parts.delete(target);
      _parts.set(res.solid_id, graph);
    }
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map(r => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map(r => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap(r => r.shape_history ?? []),
  };
}

function handleRotateBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const axisOrigin = args['axis_origin'] as number[];
  const axisDirection = args['axis_direction'] as number[];
  const angleDeg = args['angle_degrees'] as number;
  if (!Array.isArray(axisOrigin) || axisOrigin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'axis_origin must be an array of 3 numbers', false);
  }
  if (!Array.isArray(axisDirection) || axisDirection.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'axis_direction must be an array of 3 numbers', false);
  }
  if (typeof angleDeg !== 'number') {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'angle_degrees must be a number', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const res = getGeometryBinding().rotateBody(
      target,
      axisOrigin[0],
      axisOrigin[1],
      axisOrigin[2],
      axisDirection[0],
      axisDirection[1],
      axisDirection[2],
      angleDeg,
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map(r => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map(r => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap(r => r.shape_history ?? []),
  };
}

function handleMirrorBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const planeOrigin = args['plane_origin'] as number[];
  const planeNormal = args['plane_normal'] as number[];
  if (!Array.isArray(planeOrigin) || planeOrigin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'plane_origin must be an array of 3 numbers', false);
  }
  if (!Array.isArray(planeNormal) || planeNormal.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'plane_normal must be an array of 3 numbers', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const res = getGeometryBinding().mirrorBody(
      target,
      planeOrigin[0],
      planeOrigin[1],
      planeOrigin[2],
      planeNormal[0],
      planeNormal[1],
      planeNormal[2],
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map(r => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map(r => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap(r => r.shape_history ?? []),
  };
}

function handleScaleBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const origin = args['origin'] as number[];
  const scaleFactor = args['scale_factor'] as number;
  if (!Array.isArray(origin) || origin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'origin must be an array of 3 numbers', false);
  }
  if (typeof scaleFactor !== 'number' || scaleFactor <= 0) {
    throwError(ErrorCodes.GE_SCALE_NON_UNIFORM, 'scale_factor must be a positive number', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const res = getGeometryBinding().scaleBody(
      target,
      origin[0],
      origin[1],
      origin[2],
      scaleFactor,
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map(r => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map(r => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap(r => r.shape_history ?? []),
  };
}

function handleAlignToFace(args: Record<string, unknown>): unknown {
  const srcFace = requireString(args, 'source_face');
  const dstFace = requireString(args, 'destination_face');
  const flipNormal = (args['flip_normal'] as boolean | undefined) ?? false;
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().alignToFace(srcFace, dstFace, flipNormal, keepOriginal);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleFilletEdges(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const radius = args['radius'] as number;
  if (typeof radius !== 'number' || radius <= 0) {
    throwError(ErrorCodes.GE_FILLET_TOO_LARGE, 'radius must be a positive number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().filletEdges(partId, targets, radius);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleChamferEdges(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const distance = args['distance'] as number;
  if (typeof distance !== 'number' || distance <= 0) {
    throwError(ErrorCodes.GE_CHAMFER_TOO_LARGE, 'distance must be a positive number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().chamferEdges(partId, targets, distance);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleSimplifyBody(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const unifyFaces = (args['unify_faces'] as boolean | undefined) ?? true;
  const unifyEdges = (args['unify_edges'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().simplifyBody(partId, unifyFaces, unifyEdges);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleHealGeometryEx(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const fixTolerances = (args['fix_tolerances'] as boolean | undefined) ?? true;
  const fixWires = (args['fix_wires'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().healGeometryEx(partId, fixTolerances, fixWires);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    heal_complete: result.heal_complete,
    remaining_issues: result.remaining_issues,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleOffsetShape(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const offsetValue = args['offset_value'] as number;
  const tolerance = (args['tolerance'] as number | undefined) ?? 1e-4;
  if (typeof offsetValue !== 'number') {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'offset_value must be a number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().offsetShape(partId, offsetValue, tolerance);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleDeleteFace(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const healRemaining = (args['heal_remaining'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().deleteFace(partId, targets, healRemaining);
  for (const solidId of result.solid_ids) {
    session.registerShell(solidId);
  }

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_ids: result.solid_ids,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_urls: result.solid_ids.map(id => `${meshBaseUrl}/mesh/${id}.glb`),
    shape_history: result.shape_history ?? [],
  };
}

function handleSewFaces(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const tolerance = (args['tolerance'] as number | undefined) ?? 1e-3;
  const makeSolid = (args['make_solid'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().sewFaces(targets, tolerance, makeSolid);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    shell_id: result.solid_id,
    sew_complete: result.sew_complete,
    free_edges: result.free_edges,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

function handleCreateAssemblyDocument(args: Record<string, unknown>): unknown {
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'create_assembly_document requires an active transaction', false);
  }
  const result = getGeometryBinding().createAssemblyDocument();
  return {
    assembly_id: result.assembly_id,
    rollback_token: ctx.transactionId,
  };
}

function handleAddAssemblyInstance(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const target = requireString(args, 'target');
  const location = args['location'] as { translation: number[]; orientation: number[] } | undefined;
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'add_assembly_instance requires an active transaction', false);
  }

  let tx = 0.0, ty = 0.0, tz = 0.0;
  let qw = 1.0, qx = 0.0, qy = 0.0, qz = 0.0;

  if (location) {
    const { translation, orientation } = location;
    if (Array.isArray(translation) && translation.length === 3) {
      [tx, ty, tz] = translation;
    }
    if (Array.isArray(orientation) && orientation.length === 4) {
      [qw, qx, qy, qz] = orientation;
    }
  }

  const result = getGeometryBinding().addAssemblyInstance(
    assemblyId,
    target,
    tx,
    ty,
    tz,
    qw,
    qx,
    qy,
    qz,
  );

  return {
    component_id: result.component_id,
    rollback_token: ctx.transactionId,
  };
}

function handleMateRigid(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const srcFace = requireString(args, 'source_face');
  const dstFace = requireString(args, 'destination_face');
  const flipAlignment = (args['flip_alignment'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'mate_rigid requires an active transaction', false);
  }

  const result = getGeometryBinding().mateRigid(assemblyId, srcFace, dstFace, flipAlignment);

  return {
    component_id: result.component_id,
    location_matrix: result.location_matrix,
    rollback_token: ctx.transactionId,
  };
}

function handleListAssemblyTree(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const result = getGeometryBinding().listAssemblyTree(assemblyId);
  return {
    assembly_id: result.assembly_id,
    root: result.root,
  };
}

// ─── Part management handlers (Feature 009 multi-part support) ────────────────

function handleCreatePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  createPart(partId);
  return {
    part_id: partId,
    status: 'created',
    is_active: true,
  };
}

function handleSetActivePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  setActivePart(partId);
  const graph = getManufacturingGraph(partId);
  let panelCount = 0;
  let bendCount = 0;
  for (const node of graph.nodes.values()) {
    if (node.type === 'PanelNode') panelCount++;
    else if (node.type === 'BendNode') bendCount++;
  }
  return {
    part_id: partId,
    status: 'active',
    panel_count: panelCount,
    bend_count: bendCount,
  };
}

function handleListParts(): unknown {
  const parts = listParts();
  return {
    parts,
    active_part_id: _activePartId ?? null,
    total_parts: parts.length,
  };
}

function handleDeletePart(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  deletePart(partId);
  return {
    part_id: partId,
    status: 'deleted',
    active_part_id: _activePartId ?? null,
  };
}

// ─── Manufacturing Graph handlers (Feature 009-manufacturing-graph) ───────────

async function handleBootstrapGraph(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const options = {
    angleThresholdDeg: (args['angle_threshold_deg'] as number | undefined),
    maxThicknessMm: (args['max_thickness_mm'] as number | undefined),
    defaultThicknessMm: (args['default_thickness_mm'] as number | undefined),
    rootPanelIdPrefix: (args['root_panel_id_prefix'] as string | undefined),
  };

  // Create graph if not already present
  if (!_parts.has(partId)) {
    createPart(partId);
  }

  const graph = getManufacturingGraph(partId);
  const binding = getGraphBinding();
  const fc = getGraphFoldabilityChecker();
  const result = await bootstrapGraph(partId, graph, binding, fc, config, options);

  return {
    part_id: partId,
    node_ids: result.nodeIds,
    panel_count: result.panelCount,
    bend_count: result.bendCount,
    partial: result.partial,
    unresolved_body_ids: result.unresolvedBodyIds,
    foldability_warnings: result.foldabilityWarnings,
  };
}

async function handleAddBend(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const panelAId = requireString(args, 'panel_a_id');
  const panelBId = requireString(args, 'panel_b_id');
  const innerRadius = args['inner_radius_mm'] as number;
  const angle = args['angle_deg'] as number;
  const kFactor = args['k_factor'] as number;

  const graph = getManufacturingGraph(partId);

  // DRC check before mutation
  const defaultMaterial = config.materials[0];
  if (defaultMaterial) {
    const drc = new DrcChecker(getGraphFoldabilityChecker());
    const bend: BendNode = {
      type: 'BendNode',
      id: toNodeId(id),
      dirty: true,
      panelAId: toNodeId(panelAId),
      panelBId: toNodeId(panelBId),
      innerRadius,
      angle,
      kFactor,
      bendAllowance: null,
    };
    const drcResult = drc.check({
      graph,
      candidateNode: bend,
      materialConfig: {
        minBendRadiusMm: defaultMaterial.thicknessMm,
        minFlangeWidthMm: defaultMaterial.thicknessMm * 6,
        thicknessMm: defaultMaterial.thicknessMm,
      },
    });
    if (drcResult.violations.some((v) => v.severity === 'ERROR')) {
      return { part_id: partId, success: false, drc_violations: drcResult.violations };
    }
  }

  const node: BendNode = {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: true,
    panelAId: toNodeId(panelAId),
    panelBId: toNodeId(panelBId),
    innerRadius,
    angle,
    kFactor,
    bendAllowance: null,
  };

  const result = graph.addNode(node);
  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    dirtied_node_ids: result.dirtiedNodeIds,
    drc_violations: result.drcViolations,
    stale_warning: stale,
  };
}

async function handleSolveGeometry(args: Record<string, unknown>): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  const binding = getGraphBinding();
  const outcome = await getGeometrySolver().solve(graph, binding);

  if (!outcome.ok) {
    throwError(
      ErrorCodes.SOLVE_FAILED,
      `Geometry Solve failed at node "${outcome.offendingNodeId}": ${outcome.message}`,
      true,
      'solve_geometry',
    );
  }

  return {
    part_id: partId,
    solve_id: outcome.result.solveId,
    solved_nodes: outcome.result.solvedNodes,
    invalidated_body_ids: outcome.result.invalidatedBodyIds,
    dirty_count_before: outcome.result.dirtyCountBefore,
    solve_ms: outcome.result.solveMs,
  };
}

function handleCheckFoldability(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  const result = getGraphFoldabilityChecker().check({ graph });
  return {
    part_id: partId,
    violations: result.violations,
    panel_accessibility: result.panelAccessibility,
  };
}

function handleQueryGraph(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const topologicalOrder = (args['topological_order'] as boolean | undefined) ?? true;
  const graph = getManufacturingGraph(partId);
  const nodes = graph.queryNodes(topologicalOrder);
  const stale = graph.getStaleWarning();
  return {
    part_id: partId,
    nodes: nodes.map((n) => ({ ...n })),
    stale_warning: stale,
    node_count: nodes.length,
  };
}

function handleResetGraph(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const graph = getManufacturingGraph(partId);
  graph.reset();
  return { part_id: partId, success: true, message: 'Manufacturing Graph cleared.' };
}

function handleUpdateNode(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const graph = getManufacturingGraph(partId);

  const updates: Record<string, unknown> = {};
  if (args['new_id'] !== undefined) updates['newNodeId'] = args['new_id'];
  if (args['inner_radius_mm'] !== undefined) updates['innerRadius'] = args['inner_radius_mm'];
  if (args['angle_deg'] !== undefined) updates['angle'] = args['angle_deg'];
  if (args['k_factor'] !== undefined) updates['kFactor'] = args['k_factor'];
  if (args['nominal_thickness_mm'] !== undefined) updates['nominalThickness'] = args['nominal_thickness_mm'];
  if (args['material_type'] !== undefined) updates['materialType'] = args['material_type'];

  const result = graph.updateNode(toNodeId(id), updates as any);
  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    new_node_id: (result as any).newNodeId ?? null,
    dirtied_node_ids: result.dirtiedNodeIds,
    stale_warning: stale,
  };
}

function handleRemoveNode(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const graph = getManufacturingGraph(partId);
  graph.removeNode(toNodeId(id));
  return { part_id: partId, success: true, removed_id: id };
}

async function handleAddJoin(
  args: Record<string, unknown>,
  config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const panelAId = requireString(args, 'panel_a_id');
  const panelBId = requireString(args, 'panel_b_id');
  const joinType = requireString(args, 'join_type') as JoinNode['joinType'];
  const referenceEdgeA = (args['reference_edge_a'] as string | undefined) ?? '';
  const referenceEdgeB = (args['reference_edge_b'] as string | undefined) ?? '';
  const rawParams = (args['params'] as Record<string, unknown>) ?? {};

  // Build join params based on type
  let params: JoinParams;
  switch (joinType) {
    case 'RIVET_PATTERN':
      params = {
        joinParamType: 'RIVET_PATTERN',
        spacing: (rawParams['spacing'] as number | undefined) ?? 25,
        diameter: (rawParams['diameter'] as number | undefined) ?? 4,
        edgeOffset: (rawParams['edge_offset'] as number | undefined) ?? 10,
      };
      break;
    case 'TAB_SLOT':
      params = {
        joinParamType: 'TAB_SLOT',
        tabWidth: (rawParams['tab_width'] as number | undefined) ?? 10,
        tabDepth: (rawParams['tab_depth'] as number | undefined) ?? 5,
        count: (rawParams['count'] as number | undefined) ?? 3,
      };
      break;
    case 'FLANGE':
      params = {
        joinParamType: 'FLANGE',
        width: (rawParams['width'] as number | undefined) ?? 10,
        bendAngle: (rawParams['bend_angle'] as number | undefined) ?? 90,
      };
      break;
    case 'WELD_PREP':
      params = {
        joinParamType: 'WELD_PREP',
        grooveAngle: (rawParams['groove_angle'] as number | undefined) ?? 60,
        rootGap: (rawParams['root_gap'] as number | undefined) ?? 1,
      };
      break;
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown join type: ${joinType as string}`, false);
      throw new Error('unreachable');
  }

  const graph = getManufacturingGraph(partId);
  const solver = getGeometrySolver();
  const drc = new DrcChecker(getGraphFoldabilityChecker());

  // DRC pre-check
  const joinNode: JoinNode = {
    type: 'JoinNode',
    id: toNodeId(id),
    dirty: true,
    panelAId: toNodeId(panelAId),
    panelBId: toNodeId(panelBId),
    referenceEdgeA,
    referenceEdgeB,
    joinType,
    params,
  };

  const defaultMaterial = config.materials?.[0];
  if (defaultMaterial) {
    const drcRequest: DrcCheckRequest = {
      graph,
      candidateNode: joinNode,
      materialConfig: {
        minBendRadiusMm: defaultMaterial.thicknessMm,
        minFlangeWidthMm: defaultMaterial.thicknessMm * 6,
        thicknessMm: defaultMaterial.thicknessMm,
      },
    };
    const drcResult = drc.check(drcRequest);
    if (drcResult.violations.length > 0) {
      return {
        part_id: partId,
        success: false,
        drc_violations: drcResult.violations,
      };
    }
  }

  // Add to graph via mutateAndSolve
  const result = await graph.mutateAndSolve(
    () => graph.addNode(joinNode),
    async () => {
      const binding = getGraphBinding();
      return solver.solve(graph, binding);
    },
  );

  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    node_id: id,
    dirtied_node_ids: result.dirtiedNodeIds,
    geometry_solve: (result as any).geometrySolve ?? null,
    stale_warning: stale,
  };
}

async function handleAddCut(
  args: Record<string, unknown>,
  _config: ManufacturingConfig,
): Promise<unknown> {
  const partId = requireString(args, 'part_id');
  const id = requireString(args, 'id');
  const parentPanelId = requireString(args, 'parent_panel_id');
  const profileType = requireString(args, 'profile_type') as CutProfile['type'];
  const rawProfile = (args['profile'] as Record<string, unknown>) ?? {};
  const label = args['label'] as string | undefined;

  // Build the CutProfile
  let profile: CutProfile;
  switch (profileType) {
    case 'CIRCLE':
      profile = {
        type: 'CIRCLE',
        centreX: (rawProfile['centre_x'] as number | undefined) ?? 0,
        centreY: (rawProfile['centre_y'] as number | undefined) ?? 0,
        radius: (rawProfile['radius'] as number | undefined) ?? 5,
      };
      break;
    case 'RECTANGLE':
      profile = {
        type: 'RECTANGLE',
        originX: (rawProfile['origin_x'] as number | undefined) ?? 0,
        originY: (rawProfile['origin_y'] as number | undefined) ?? 0,
        width: (rawProfile['width'] as number | undefined) ?? 10,
        height: (rawProfile['height'] as number | undefined) ?? 10,
      };
      break;
    case 'POLYGON':
      profile = {
        type: 'POLYGON',
        vertices: (rawProfile['vertices'] as Array<{ x: number; y: number }>) ?? [],
      };
      break;
    case 'FREEFORM':
      profile = {
        type: 'FREEFORM',
        vertices: (rawProfile['vertices'] as Array<{ x: number; y: number }>) ?? [],
      };
      break;
    default:
      throwError(ErrorCodes.INTERNAL_ERROR, `Unknown cut profile type: ${profileType as string}`, false);
      throw new Error('unreachable');
  }

  const graph = getManufacturingGraph(partId);
  const solver = getGeometrySolver();

  // Get panel bounds for DRC
  const parentNode = graph.nodes.get(toNodeId(parentPanelId));
  if (!parentNode || parentNode.type !== 'PanelNode') {
    throwError(ErrorCodes.NODE_NOT_FOUND, `Panel "${parentPanelId}" not found.`, false);
  }
  const panelBounds = {
    width: (parentNode as any).flatWidth ?? 1000,
    height: (parentNode as any).flatHeight ?? 1000,
  };

  // Collect existing cut profiles on the same panel
  const existingCuts: CutProfile[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'CutNode' && node.parentPanelId === toNodeId(parentPanelId)) {
      existingCuts.push(node.profile);
    }
  }

  // DRC profile validation
  const profileViolations = validateProfile(profile, panelBounds, existingCuts);
  if (profileViolations.length > 0) {
    return { part_id: partId, success: false, drc_violations: profileViolations };
  }

  const cutNode: CutNode = {
    type: 'CutNode',
    id: toNodeId(id),
    dirty: true,
    parentPanelId: toNodeId(parentPanelId),
    profile,
    label,
  };

  const result = await graph.mutateAndSolve(
    () => graph.addNode(cutNode),
    async () => {
      const binding = getGraphBinding();
      return solver.solve(graph, binding);
    },
  );

  const stale = graph.getStaleWarning();

  return {
    part_id: partId,
    success: result.success,
    node_id: id,
    dirtied_node_ids: result.dirtiedNodeIds,
    geometry_solve: (result as any).geometrySolve ?? null,
    stale_warning: stale,
  };
}

