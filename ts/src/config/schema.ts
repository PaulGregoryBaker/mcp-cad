/**
 * JSON Schema for config.yaml validation.
 *
 * This schema mirrors the Zod schemas in loader.ts and can be used by:
 * - IDE plugins for YAML validation (yaml.schemas in VS Code settings)
 * - CI config-lint tools (ajv, jsonschema, etc.)
 * - The config validator in loader.ts uses Zod; this schema is for external tools
 *
 * Task: T109
 */

export const configJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'MCP-CAD Manufacturing Configuration',
  description: 'Schema for config.yaml — defines materials, tooling, logistics, and environmental constraints.',
  type: 'object',
  required: ['materials', 'tooling', 'logistics', 'environmental'],
  additionalProperties: false,

  properties: {
    materials: {
      type: 'array',
      minItems: 1,
      description: 'List of available sheet metal materials.',
      items: {
        type: 'object',
        required: ['id', 'name', 'thickness_mm', 'k_factor', 'yield_strength_mpa', 'grain_direction', 'inventory_sheets'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          thickness_mm: { type: 'number', exclusiveMinimum: 0 },
          k_factor: { type: 'number', minimum: 0, maximum: 1 },
          yield_strength_mpa: { type: 'number', exclusiveMinimum: 0 },
          grain_direction: { type: 'string', enum: ['x', 'y', 'any'] },
          inventory_sheets: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['width_mm', 'height_mm', 'label'],
              additionalProperties: false,
              properties: {
                width_mm: { type: 'number', exclusiveMinimum: 0 },
                height_mm: { type: 'number', exclusiveMinimum: 0 },
                label: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },

    tooling: {
      type: 'object',
      required: ['press_brake', 'laser'],
      additionalProperties: false,
      properties: {
        press_brake: {
          type: 'object',
          required: ['max_tonnage', 'max_bend_length_mm', 'v_die_widths_mm', 'punch_radii_mm'],
          additionalProperties: false,
          properties: {
            max_tonnage: { type: 'number', exclusiveMinimum: 0 },
            max_bend_length_mm: { type: 'number', exclusiveMinimum: 0 },
            v_die_widths_mm: {
              type: 'array',
              minItems: 1,
              items: { type: 'number', exclusiveMinimum: 0 },
            },
            punch_radii_mm: {
              type: 'array',
              minItems: 1,
              items: { type: 'number', exclusiveMinimum: 0 },
            },
          },
        },
        laser: {
          type: 'object',
          required: ['max_kerf_width_mm', 'min_hole_diameter_mm'],
          additionalProperties: false,
          properties: {
            max_kerf_width_mm: { type: 'number', exclusiveMinimum: 0 },
            min_hole_diameter_mm: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    },

    logistics: {
      type: 'object',
      required: ['shipping_envelope', 'max_weight_kg'],
      additionalProperties: false,
      properties: {
        shipping_envelope: {
          type: 'object',
          required: ['max_length_mm', 'max_width_mm'],
          additionalProperties: false,
          properties: {
            max_length_mm: { type: 'number', exclusiveMinimum: 0 },
            max_width_mm: { type: 'number', exclusiveMinimum: 0 },
            max_height_mm: { type: 'number', exclusiveMinimum: 0 },
          },
        },
        max_weight_kg: { type: 'number', exclusiveMinimum: 0 },
        coating_envelope: {
          type: 'object',
          additionalProperties: false,
          properties: {
            max_length_mm: { type: 'number', exclusiveMinimum: 0 },
            max_width_mm: { type: 'number', exclusiveMinimum: 0 },
          },
        },
        shipping_regions: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },

    environmental: {
      type: 'object',
      required: ['fire_rated', 'marine_grade'],
      additionalProperties: false,
      properties: {
        fire_rated: { type: 'boolean' },
        marine_grade: { type: 'boolean' },
        high_vibration: { type: 'boolean' },
        outdoor_exposed: { type: 'boolean' },
      },
    },
  },
} as const;

export type ConfigJsonSchema = typeof configJsonSchema;
