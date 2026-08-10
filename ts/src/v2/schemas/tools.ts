/**
 * v2 MCP-boundary schema validation — tool input shapes (rebuild's
 * "receiving evaluates against the schema" half, 2026-08-07).
 *
 * These Zod schemas are the real validation source of truth — dispatchGraphTool
 * (v2/tools/graph.ts) validates `args` against the matching entry here before
 * the switch/handler ever runs. The JSON-Schema `inputSchema` objects in
 * graphToolDefinitions stay as the wire shape MCP's tools/list capability
 * needs; they're hand-aligned wherever this pass found a real mismatch, but
 * are documentation from here on, not enforcement.
 *
 * Every constraint below encodes what each tool's own description/inputSchema
 * already CLAIMS — a full inventory (reading every handler, not assuming from
 * the schema) found several places the old ad-hoc requireX/optX helpers
 * (mcp/tools/helpers.ts) didn't actually check what the declared inputSchema
 * promised (edge_index accepting negative/non-integer values, relief_type
 * accepting any string, split_body_by_plane silently NaN-coercing missing
 * fields, update_node accepting a missing/invalid patch despite it being
 * schema-required) — those are real bugs, fixed here, not preserved.
 */

import { z } from 'zod';
import { Point2Schema, Point3Schema, Transform3RowSchema, EdgeRefSchema } from './shared';

const ToolSchemas = {
  create_part: z.object({
    name: z.string().min(1),
    outline: z.array(Point2Schema).min(3),
    thickness_mm: z.number().positive(),
    material_id: z.string().optional(),
    k_factor: z.number().min(0).max(1).optional(),
    anchor: Transform3RowSchema.optional(),
  }),

  create_node: z.object({
    kind: z.literal('bend'),
    part_id: z.string().min(1),
    parent_region_panel_id: z.string().min(1),
    hinge_a: Point2Schema,
    hinge_b: Point2Schema,
    angle_deg: z.number(),
    radius_mm: z.number().min(0).optional(),
    k_factor: z.number().min(0).max(1).optional(),
    label: z.string().optional(),
  }),

  merge_bodies_with_bend: z.object({
    part_a_id: z.string().min(1),
    part_b_id: z.string().min(1),
    edge_a: EdgeRefSchema,
    edge_b: EdgeRefSchema,
    angle_deg: z.number(),
    radius_mm: z.number().min(0).optional(),
    k_factor: z.number().min(0).max(1).optional(),
    bottom_is_concave: z.boolean().optional(),
  }),

  import_part: z.object({
    file: z.string().min(1),
    angle_threshold_deg: z.number().optional(),
    max_thickness_mm: z.number().optional(),
    default_thickness_mm: z.number().optional(),
    max_recursion_depth: z.number().optional(),
    // Loose/best-effort on purpose, matching optManufacturingProfile's own
    // tolerance (tools/graph.ts): only the fields it recognizes are read,
    // everything else defaults — no need to reject an otherwise-valid
    // profile object over an extra/unknown field.
    profile: z
      .object({
        profile_id: z.string().optional(),
        name: z.string().optional(),
        rules: z.record(z.unknown()).optional(),
      })
      .optional(),
  }),

  fuse_bodies: z.object({
    part_a_id: z.string().min(1),
    part_b_id: z.string().min(1),
    target_region_panel_id: z.string().optional(),
  }),

  // patch must be a real object — the handler used to silently substitute {}
  // for a missing/invalid patch despite the schema declaring it required.
  update_node: z.object({
    kind: z.enum(['part', 'bend', 'region_panel']),
    id: z.string().min(1),
    patch: z.record(z.unknown()),
  }),

  delete_node: z.object({
    kind: z.literal('bend'),
    id: z.string().min(1),
  }),

  move_edge: z.object({
    part_id: z.string().min(1),
    vertex_range: z.object({
      start_index: z.number(),
      end_index: z.number(),
    }),
    new_points: z.array(Point2Schema),
  }),

  split_body_by_bends: z.object({
    file: z.string().min(1),
    angle_threshold_deg: z.number().optional(),
    max_thickness_mm: z.number().optional(),
    default_thickness_mm: z.number().optional(),
    max_recursion_depth: z.number().optional(),
  }),

  // circle required iff kind=circle, polygon_ring required iff kind=polygon —
  // today's declared JSON Schema only says this in prose; the handler enforces
  // it, the schema didn't capture it. Encoded for real here via superRefine.
  cut_panel: z
    .object({
      part_id: z.string().min(1),
      kind: z.enum(['circle', 'polygon']),
      circle: z
        .object({
          center: Point2Schema,
          radius_mm: z.number().positive(),
        })
        .optional(),
      polygon_ring: z.array(Point2Schema).min(3).optional(),
      region_panel_id: z.string().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.kind === 'circle' && !v.circle) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"circle" is required when kind=circle', path: ['circle'] });
      }
      if (v.kind === 'polygon' && !v.polygon_ring) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '"polygon_ring" is required when kind=polygon', path: ['polygon_ring'] });
      }
    }),

  close_gap: z.object({
    part_id: z.string().min(1),
    edge_a: EdgeRefSchema,
    edge_b: EdgeRefSchema,
  }),

  add_flange: z.object({
    part_id: z.string().min(1),
    edge: EdgeRefSchema,
    length_mm: z.number().positive(),
    angle_deg: z.number(),
    radius_mm: z.number().min(0).optional(),
  }),

  rip_edge: z.object({
    part_id: z.string().min(1),
    edge: EdgeRefSchema,
    gap_mm: z.number().min(0).optional(),
  }),

  generate_reliefs: z.object({
    part_id: z.string().min(1),
    bend_ids: z.array(z.string()).min(1),
    relief_type: z.enum(['dogbone', 'circular']),
    radius_mm: z.number().min(0.5),
  }),

  // Strict: rejects missing/non-numeric fields instead of the handler's old
  // silent Number(...) coercion (a missing field became a NaN fed straight
  // into the geometry call, no error).
  split_body_by_plane: z.object({
    part_id: z.string().min(1),
    plane: z.object({
      normal: Point3Schema,
      origin: Point3Schema,
    }),
  }),

  commit: z.object({
    part_id: z.string().min(1),
    message: z.string().min(1),
  }),

  restore: z.object({
    part_id: z.string().min(1),
    commit_hash: z.string().min(1),
  }),

  // Dispatchable today (dispatchGraphTool's switch has live cases) but absent
  // from graphToolDefinitions entirely — added there too as part of this pass.
  branch: z.object({
    name: z.string().min(1),
    from_commit: z.string().optional(),
  }),

  merge_branch: z.object({
    source_branch: z.string().min(1),
  }),

  simulate_nesting: z.object({
    part_ids: z.array(z.string()).min(1),
    sheet_width_mm: z.number().optional(),
    sheet_height_mm: z.number().optional(),
  }),

  // format is accepted here (matches the declared inputSchema) but the
  // handler never reads it — this tool is a hard-coded stub that always
  // fails regardless of input (rebuild/07-engineering-drawings.md not built
  // yet), so wiring format through a stub that ignores everything is left
  // alone deliberately, not an oversight.
  export_production_pack: z.object({
    part_ids: z.array(z.string()).min(1),
    format: z.enum(['dxf', 'step', 'pdf']).optional(),
  }),

  get_job: z.object({
    job_id: z.string().min(1),
  }),
} as const;

export type ToolName = keyof typeof ToolSchemas;

export function toolSchemaFor(name: string): z.ZodTypeAny | undefined {
  return (ToolSchemas as Record<string, z.ZodTypeAny>)[name];
}
