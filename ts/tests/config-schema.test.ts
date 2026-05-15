/**
 * Unit tests for config/schema.ts — JSON Schema export.
 * Validates the exported configJsonSchema structure used by IDE and CI validators.
 *
 * Task: T109
 */

import { describe, it, expect } from 'vitest';
import { configJsonSchema } from '../src/config/schema';

describe('configJsonSchema: top-level structure', () => {
  it('exports a valid JSON Schema draft-07 object', () => {
    expect(configJsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(configJsonSchema.type).toBe('object');
  });

  it('requires the four top-level sections', () => {
    expect(configJsonSchema.required).toContain('materials');
    expect(configJsonSchema.required).toContain('tooling');
    expect(configJsonSchema.required).toContain('logistics');
    expect(configJsonSchema.required).toContain('environmental');
  });

  it('disallows additional top-level properties', () => {
    expect(configJsonSchema.additionalProperties).toBe(false);
  });

  it('materials is an array with minItems: 1', () => {
    const mat = configJsonSchema.properties.materials;
    expect(mat.type).toBe('array');
    expect(mat.minItems).toBe(1);
  });

  it('material item requires id, name, thickness_mm, k_factor, grain_direction, inventory_sheets', () => {
    const matItem = configJsonSchema.properties.materials.items;
    const required: readonly string[] = matItem.required;
    expect(required).toContain('id');
    expect(required).toContain('name');
    expect(required).toContain('thickness_mm');
    expect(required).toContain('k_factor');
    expect(required).toContain('grain_direction');
    expect(required).toContain('inventory_sheets');
  });

  it('grain_direction is an enum of x, y, any', () => {
    const gd = configJsonSchema.properties.materials.items.properties.grain_direction;
    expect(gd.enum).toEqual(['x', 'y', 'any']);
  });

  it('tooling requires press_brake and laser', () => {
    const tooling = configJsonSchema.properties.tooling;
    expect(tooling.required).toContain('press_brake');
    expect(tooling.required).toContain('laser');
  });

  it('press_brake requires max_tonnage and v_die_widths_mm', () => {
    const pb = configJsonSchema.properties.tooling.properties.press_brake;
    expect(pb.required).toContain('max_tonnage');
    expect(pb.required).toContain('v_die_widths_mm');
  });

  it('laser has max_kerf_width_mm with exclusiveMinimum: 0', () => {
    const laser = configJsonSchema.properties.tooling.properties.laser;
    expect(laser.properties.max_kerf_width_mm.exclusiveMinimum).toBe(0);
  });

  it('logistics requires shipping_envelope and max_weight_kg', () => {
    const log = configJsonSchema.properties.logistics;
    expect(log.required).toContain('shipping_envelope');
    expect(log.required).toContain('max_weight_kg');
  });

  it('shipping_envelope has max_length_mm, max_width_mm, max_height_mm', () => {
    const env = configJsonSchema.properties.logistics.properties.shipping_envelope;
    expect(env.properties.max_length_mm).toBeDefined();
    expect(env.properties.max_width_mm).toBeDefined();
    expect(env.properties.max_height_mm).toBeDefined();
  });

  it('environmental requires fire_rated and marine_grade as booleans', () => {
    const envProps = configJsonSchema.properties.environmental.properties;
    expect(envProps.fire_rated.type).toBe('boolean');
    expect(envProps.marine_grade.type).toBe('boolean');
  });
});
