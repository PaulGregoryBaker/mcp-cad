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
  splitPartAtBend,
  splitPartByAllBends,
  cutPanel,
  closeGap,
  addFlange,
  ripEdge,
  generateReliefs,
  splitBodyByPlane,
} from '../graph/evaluate-client';
import { V2DoltStore, type V2DoltStoreOptions } from '../persistence/dolt-store';
import { v2JobQueue } from '../jobs/queue';
import { throwError, ErrorCodes, type ErrorCode } from '../../mcp/errors';
import { geometryBinding } from '../../geometry/binding';
import { getNestingConfig } from '../../config/loader';
import { buildNestedSheetDxf, type NestedSheetPlacement } from '../resources/dxf';
import {
  requireString,
  requireStringArray,
  requireNumber,
  optNumber,
  optString,
  optBoolean,
  optTransform,
  requirePoint2,
  optPoint2,
  requirePoint2Array,
  requirePoint2ArrayAllowEmpty,
  requireEdgeRef,
  requireVertexRange,
  optNullableNumber,
  optNullableBoolean,
} from './helpers';
import { toolSchemaFor } from '../schemas/tools';
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
        bend_process: {
          type: 'string',
          description:
            'Which manufacturing process forms this bend — an unvalidated free string; the app client sends its own BendProcess enum name (e.g. airBend, bottoming, coining, hemming, rollBend, grooving). Omitted: not tracked.',
        },
      },
      required: ['kind', 'part_id', 'parent_region_panel_id', 'hinge_a', 'hinge_b', 'angle_deg'],
    },
  },
  {
    name: 'merge_bodies_with_bend',
    description:
      "Join two independently-authored parts into one, connected by a new bend at their own real, anchor-derived seam (docs/TASK_SPEC.md — no edge refs, no angle_deg: both are found from every region panel of part_a and part_b, including panels reached through a part's own existing bends, not just its root anchor). Not a distinct primitive: detects every real contact interval between the two parts' panels, reconciles B's outline into A's frame at the chosen seam, re-parents B's rows onto A, then an ordinary create_node(bend, ...) with the detected angle. B is aliased via merged_into_part_id, never deleted. Fails with a typed error if the two parts don't actually touch anywhere (GE_MERGE_NO_CONTACT) or their only contact is genuinely coplanar (GE_MERGE_COPLANAR_SEAM — use fuse_bodies instead for a flush, no-bend absorb). If the two parts touch along MORE than one real seam at once, this fails with GE_MERGE_AMBIGUOUS_CONTACT listing every candidate (region_panel_id_a/b, angle_deg, length_mm) — retry passing region_panel_id_a/region_panel_id_b to pick one; nothing is picked automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        part_a_id: { type: 'string' },
        part_b_id: { type: 'string' },
        radius_mm: { type: 'number', minimum: 0 },
        k_factor: { type: 'number', minimum: 0, maximum: 1 },
        bottom_is_concave: {
          type: 'boolean',
          description:
            "Overrides the detected-angle-sign-derived mountain/valley pivot-side default (see BendRow.bottomIsConcave's own doc comment) — a caller that already knows the true pivot side should pass it explicitly; the sign-derived rule is a default, not an invariant.",
        },
        region_panel_id_a: {
          type: 'string',
          description:
            'Picks a specific contact region when the two parts touch along more than one real seam at once — pass together with region_panel_id_b, using the ids from a prior GE_MERGE_AMBIGUOUS_CONTACT error. Omit when there is only one real contact (the common case).',
        },
        region_panel_id_b: { type: 'string' },
      },
      required: ['part_a_id', 'part_b_id'],
    },
  },
  {
    name: 'import_part',
    description:
      "Ingest a STEP file into a v2 manufacturing graph (rebuild/15 §4.1, Level C): heal, decompose into flat panel pieces (Port A/B), then reconcile them into one outline + bend tree (13 §6) — the same graph shape create_part/create_node build directly. Synchronous this slice (no job/progress polling yet). Each detected protrusion (flange/tab) becomes its own simple, independent v2 Part — see protrusion_part_ids in the result — rather than being represented within the main part's own outline/bend tree. reconcilePieces cannot measure a real bend radius from a flat-panel decomposition (only two flat faces meeting at a fold are ever seen), so every reconciled bend's radius_mm is assumed to equal profile.rules.default_bend_radius_mm; when that's omitted entirely it falls back to the part's own thickness_mm (a real, manufacturable minimum — matching this profile's own default min_bend_radius_factor=1.0), not a literal 0 — pass default_bend_radius_mm:0 explicitly to request a genuinely sharp fold instead. radius_measured=false records that this is a default, not a confirmation; MIN_BEND_RADIUS still checks the actual value normally. Call update_node(kind=bend, patch:{radius_mm}) to confirm/change it later.",
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
            "The org's manufacturing profile — {profile_id?, name?, rules?: {default_bend_radius_mm, min_bend_radius_factor, ...}}, same shape the findings/manufacturability resource's ManufacturingProfile uses. Defaults to the built-in sheet-metal default profile when omitted; that profile leaves default_bend_radius_mm unset, which reconcilePieces resolves to the part's own thickness_mm rather than a literal sharp fold — pass default_bend_radius_mm:0 explicitly for a genuinely sharp fold.",
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
      "Update an existing v2 manufacturing-graph entity's fields in place (rebuild/06 Slice 8, rebuild/15 §4.3). kind=part: patch may include name, material_id, k_factor, thickness_mm, anchor (a whole-part move — v2's replacement for v1's translate_body). kind=bend: patch may include angle_deg, radius_mm, k_factor_override (number or null to clear), bottom_is_concave (boolean or null to clear), hinge_a, hinge_b ({x,y} — repositions the fold line in place; the bend keeps its own id and existing parent/child region panels, unlike delete_node+create_node), radius_measured (boolean), bend_process (unvalidated free string — the app client sends its own BendProcess enum name, e.g. airBend/bottoming/rollBend). Setting radius_mm implicitly sets radius_measured=true (an explicit edit is by definition no longer import_part's unmeasured placeholder) — pass radius_measured explicitly only to override that. kind=region_panel: patch may include label, k_factor_override (number or null). Only fields present in patch are changed.",
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
    name: 'split_part_at_bend',
    description:
      "Split a LIVE graph part into two independent parts at one of its own bends — the graph-level inverse of merge_bodies_with_bend. The bend is removed entirely (not flattened in place like delete_node(bend); a fresh part_id is minted for the bend's own child subtree). A real bend meets a real bend-allowance corner at TWO tangent lines (one per leg) bracketing the curved zone between them; keep_corner_on picks which side is cut at ITS OWN tangent line (keeping its normal, full corner-reaching shape, kFactor's stretch included) while the OTHER side is cut at that SAME line and ends up trimmed past even a raw-hinge cut, losing the whole allowance band. Omit bend_id to split every bend on the part in one call (an N-bend part becomes N+1 flat parts); keep_corner_on then applies uniformly to every bend split. The original part_id survives as the PARENT side of each split; every split-off child gets a new part_id. Both resulting parts keep the original part's own anchor unchanged, since every region panel already shares one flat frame — this is what keeps each piece exactly where it was, no 3D re-derivation. First-cut scope: a part with holes is not yet supported (which side a hole belongs to after the cut isn't resolved).",
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string' },
        bend_id: {
          type: 'string',
          description: 'Omit to split every bend on the part at once.',
        },
        keep_corner_on: {
          type: 'string',
          enum: ['parent', 'child'],
          description:
            'Which side is cut at its own tangent line and keeps its full, corner-reaching shape; the other side is cut at that same line and loses the whole bend-allowance band.',
        },
      },
      required: ['part_id', 'keep_corner_on'],
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
          minItems: 1,
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
      "Split a part by a 3D plane (in world coordinates), producing one or more new parts (rebuild/15 §4.2, Phase 5 Slice 9b). Graph-first: projects the plane to per-panel 2D cut lines via the part's own real anchor, clips region polygons, groups fragments by bend connectivity, unions outlines, reassigns bends and holes, and creates new PartRows — each keeping the original part's own anchor, since fragment coordinates stay in that same flat frame. The original part is unchanged. Fails with GE_SPLIT_BY_PLANE_NO_INTERSECTION if the plane doesn't touch the part at all (every region panel landed entirely on one side) — it does not silently return the whole part as a redundant copy.",
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
      'Reset this part\'s live working state in place to a prior Dolt commit (rebuild/15 §4.6, B5b) — same part_id, not a new one. This is also the rollback/discard operation (B5d): call commit() as a checkpoint before a sequence of edits, then restore(part_id, that_commit_hash) to discard them.',
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
    name: 'branch',
    description:
      'Create a named Dolt branch pointer (rebuild/15 §4.6, B5). Does not touch the in-memory GraphStore or any part\'s working state — a pure Dolt version-control operation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Branch name' },
        from_commit: { type: 'string', description: 'Commit hash to branch from; defaults to the current HEAD' },
      },
      required: ['name'],
    },
  },
  {
    name: 'merge_branch',
    description:
      'Merge a Dolt branch into the current branch (rebuild/15 §4.6, B5). A pure Dolt version-control operation, same scope note as branch above.',
    inputSchema: {
      type: 'object',
      properties: {
        source_branch: { type: 'string', description: 'Branch name to merge from' },
      },
      required: ['source_branch'],
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
          minItems: 1,
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
      'Export a production pack (rebuild/15 §4.5). Async job. format="dxf" (default): nests one copy of each part deterministically and returns per-sheet DXF strings, each placement on a <part_id>#<copy_index> layer. Other formats require the drawings resource, which is not yet built and fail with an error.',
    inputSchema: {
      type: 'object',
      properties: {
        part_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
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

/** Validates `args` against the tool's own schema (schemas/tools.ts) before
 * any handler runs — "receiving evaluates against the schema." A tool with
 * no registered schema is a registry gap (a mistake in this codebase, not
 * the caller's), so it's a hard error, not a silent pass-through. On a real
 * validation failure, INVALID_TOOL_ARGS is recoverable: the caller can fix
 * the request and retry. */
function validateToolArgs(name: string, args: Record<string, unknown>): void {
  const schema = toolSchemaFor(name);
  if (!schema) {
    // Same wording as the switch's own default case below, which this
    // makes unreachable for any name lacking a registered schema — every
    // real tool has one (see schemas/tools.ts's own registry), so this
    // path is "unknown tool name," not "known tool, missing schema."
    throwError(ErrorCodes.INTERNAL_ERROR, `Unknown v2 tool: ${name}`, false);
  }
  const result = schema.safeParse(args);
  if (!result.success) {
    throwError(
      ErrorCodes.INVALID_TOOL_ARGS,
      `${name}: ${result.error.message}`,
      true,
    );
  }
}

export function dispatchGraphTool(
  store: GraphStore,
  name: string,
  args: Record<string, unknown>,
): unknown {
  validateToolArgs(name, args);
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
    case 'split_part_at_bend':
      return handleSplitPartAtBend(store, args);
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
  const bendProcess = optString(args, 'bend_process');
  const bottomIsConcave = optBoolean(args, 'bottom_is_concave');

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
      bendProcess,
      bottomIsConcave,
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
  const radiusMm = optNumber(args, 'radius_mm');
  const kFactor = optNumber(args, 'k_factor');
  const bottomIsConcave = optBoolean(args, 'bottom_is_concave');
  const regionPanelIdA = optString(args, 'region_panel_id_a');
  const regionPanelIdB = optString(args, 'region_panel_id_b');

  try {
    const { bend, childRegionPanel } = mergePartsWithBend(store, {
      partAId,
      partBId,
      radiusMm,
      kFactor,
      bottomIsConcave,
      regionPanelIdA,
      regionPanelIdB,
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

function handleSplitPartAtBend(
  store: GraphStore,
  args: Record<string, unknown>,
): { part_id: string; new_part_ids: string[] } {
  const partId = requireString(args, 'part_id');
  const bendId = optString(args, 'bend_id');
  const keepCornerOnRaw = requireString(args, 'keep_corner_on');
  if (keepCornerOnRaw !== 'parent' && keepCornerOnRaw !== 'child') {
    throwError(
      ErrorCodes.INTERNAL_ERROR,
      `keep_corner_on must be 'parent' or 'child', got '${keepCornerOnRaw}'`,
      false,
    );
  }
  const keepCornerOn = keepCornerOnRaw as 'parent' | 'child';

  try {
    if (bendId !== undefined) {
      const { childPart } = splitPartAtBend(store, { partId, bendId, keepCornerOn });
      return { part_id: partId, new_part_ids: [childPart.partId] };
    }
    const { partIds } = splitPartByAllBends(store, { partId, keepCornerOn });
    return { part_id: partId, new_part_ids: partIds.filter((id) => id !== partId) };
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
          thicknessMm: optNumber(patch, 'thickness_mm'),
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
          hingeA: optPoint2(patch, 'hinge_a'),
          hingeB: optPoint2(patch, 'hinge_b'),
          radiusMeasured: optBoolean(patch, 'radius_measured'),
          bendProcess: optString(patch, 'bend_process'),
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

  const snapshot = await doltStore.loadPartAtCommit(partId, commitHash);
  if (!snapshot) {
    throwError(
      ErrorCodes.GRAPH_PART_NOT_FOUND,
      `part ${partId} not found in commit ${commitHash}`,
      true,
    );
  }

  const restored = store.restorePart(snapshot);
  return { part_id: restored.partId };
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

  // copies: a positive integer (explicit count of each part) or "fill" (as
  // many complete kits as fit). -1 is the C++ fill-mode sentinel.
  const rawCopies = args['copies'];
  let copies = 1;
  if (typeof rawCopies === 'number' && Number.isInteger(rawCopies) && rawCopies >= 1) {
    copies = rawCopies;
  } else if (rawCopies === 'fill') {
    copies = -1;
  } else if (rawCopies !== undefined) {
    throwError(ErrorCodes.INTERNAL_ERROR, "copies must be a positive integer or 'fill'", false);
  }

  const cfg = getNestingConfig();
  const cuttingWidthMm = optNumber(args, 'cutting_width_mm') ?? cfg.cuttingWidthMm;

  const jobId = v2JobQueue.enqueue(async () => {
    // Cutting-width validation runs inside the job so an invalid override
    // surfaces as a failed job with a typed code (get_job → status: "failed",
    // error.code === "NEST_INVALID_CUTTING_WIDTH"), not a synchronous throw
    // (rebuild/21 §9.4).
    if (cuttingWidthMm <= 0 || cuttingWidthMm > cfg.maxKerfWidthMm) {
      throwError(
        ErrorCodes.NEST_INVALID_CUTTING_WIDTH,
        `cutting_width_mm must be > 0 and <= ${cfg.maxKerfWidthMm}`,
        false,
      );
    }

    const inputs = partIds.map((pid) => {
      const part = store.getPart(pid)!;
      const holes: Array<Array<{ x: number; y: number }>> = [];
      const circleHoles: Array<{ cx: number; cy: number; radiusMm: number }> = [];
      for (const h of part.holes) {
        if (h.kind === 'polygon') holes.push(h.ring);
        else circleHoles.push({ cx: h.center.x, cy: h.center.y, radiusMm: h.radiusMm });
      }
      return { id: pid, outer: part.outline, holes, circleHoles };
    });

    const result = geometryBinding.nestPolygons(inputs, sheetW, sheetH, {
      cuttingWidthMm,
      maxKerfWidthMm: cfg.maxKerfWidthMm,
      safetyGapMm: cfg.safetyGapMm,
      sheetMarginMm: cfg.sheetMarginMm,
      placementAccuracy: cfg.placementAccuracy,
      rotationsDeg: cfg.rotationsDeg,
      copies,
    });

    if (!result.ok) {
      throwError(
        (result.errorCode || ErrorCodes.GE_NEST_FAILED) as ErrorCode,
        result.message,
        false,
      );
    }

    // Wire convention: job results reach the client opaquely via get_job, so
    // the snake_case conversion happens here (see the Dart-client regression
    // test in slice_11_async_jobs.integration.test.ts).
    return {
      placements: result.placements.map((p) => ({
        part_id: p.id,
        copy_index: p.copyIndex,
        sheet_index: p.sheetIndex,
        x: p.x,
        y: p.y,
        rotation_deg: p.rotationDeg,
        outline: p.outline,
        holes: p.holes,
        circle_holes: p.circleHoles.map((c) => ({ cx: c.cx, cy: c.cy, radius_mm: c.radiusMm })),
      })),
      utilisation_pct: result.utilisationPct,
      sheets_required: result.sheetsRequired,
    };
  });

  return { job_id: jobId };
}

async function handleExportProductionPack(
  store: GraphStore,
  args: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const partIds = requireStringArray(args, 'part_ids');
  const format = optString(args, 'format') ?? 'dxf';

  for (const pid of partIds) {
    if (!store.getPart(pid)) {
      throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part with id ${pid}`, false);
    }
  }

  const jobId = v2JobQueue.enqueue(async () => {
    // Only the per-sheet DXF nesting export is implemented (rebuild/21
    // Phase 5). Drawings/BOM/assembly-instructions still depend on the
    // drawing pipeline (rebuild/07-engineering-drawings.md), which is not
    // built — every other format fails with a typed, actionable error rather
    // than silently producing a partial pack.
    if (format !== 'dxf') {
      throw new Error(
        `export_production_pack format "${format}" requires the drawings ` +
          'resource, which is not yet built. Only "dxf" is supported ' +
          '(rebuild/07-engineering-drawings.md).',
      );
    }

    const inputs = partIds.map((pid) => {
      const part = store.getPart(pid)!;
      const holes: Array<Array<{ x: number; y: number }>> = [];
      const circleHoles: Array<{ cx: number; cy: number; radiusMm: number }> = [];
      for (const h of part.holes) {
        if (h.kind === 'polygon') holes.push(h.ring);
        else circleHoles.push({ cx: h.center.x, cy: h.center.y, radiusMm: h.radiusMm });
      }
      return { id: pid, outer: part.outline, holes, circleHoles };
    });

    // A production pack is one copy of each part, nested deterministically on
    // the default stock sheet (same 2440×1220 default as simulate_nesting).
    // No sheet/copies args exist on this tool; the pack is the BOM set, not a
    // fill-everything layout.
    const cfg = getNestingConfig();
    const result = geometryBinding.nestPolygons(inputs, 2440, 1220, {
      cuttingWidthMm: cfg.cuttingWidthMm,
      maxKerfWidthMm: cfg.maxKerfWidthMm,
      safetyGapMm: cfg.safetyGapMm,
      sheetMarginMm: cfg.sheetMarginMm,
      placementAccuracy: cfg.placementAccuracy,
      rotationsDeg: cfg.rotationsDeg,
      copies: 1,
    });

    if (!result.ok) {
      throwError(
        (result.errorCode || ErrorCodes.GE_NEST_FAILED) as ErrorCode,
        result.message,
        false,
      );
    }

    const bySheet = new Map<number, NestedSheetPlacement[]>();
    for (const p of result.placements) {
      const list = bySheet.get(p.sheetIndex) ?? [];
      list.push({
        partId: p.id,
        copyIndex: p.copyIndex,
        outline: p.outline,
        holes: p.holes,
        circleHoles: p.circleHoles,
      });
      bySheet.set(p.sheetIndex, list);
    }

    const dxfs: string[] = [];
    for (let s = 0; s < result.sheetsRequired; ++s) {
      dxfs.push(buildNestedSheetDxf(bySheet.get(s) ?? []));
    }

    return { dxfs, sheets_required: result.sheetsRequired };
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
