/**
 * Config loader — YAML schema validation and parsing.
 * Loads config.yaml and produces a validated ManufacturingConfig.
 *
 * Task: T033
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { MaterialSpec, SheetSize } from '../manufacturing/material';
import type { ToolingCapability } from '../manufacturing/tooling';
import type { LogisticsConstraints } from '../manufacturing/logistics';
import type { EnvironmentalContext } from '../manufacturing/environmental';

// ─── Config aggregate type ──────────────────────────────────────────────────

export interface PersistenceConfig {
  driver: 'dolt';
  host: string;
  port: number;
  database: string;
  data_dir: string;
}

export interface GraphConfig {
  coplanarityThresholdDeg: number;
}

export interface ManufacturingConfig {
  materials: MaterialSpec[];
  tooling: ToolingCapability;
  logistics: LogisticsConstraints;
  environmental: EnvironmentalContext;
  persistence?: PersistenceConfig;
  graph: GraphConfig;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const SheetSizeSchema = z.object({
  width_mm: z.number().positive(),
  height_mm: z.number().positive(),
  label: z.string().min(1),
});

const MaterialSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  thickness_mm: z.number().positive(),
  k_factor: z.number().min(0).max(1),
  yield_strength_mpa: z.number().positive(),
  grain_direction: z.enum(['x', 'y', 'any']),
  inventory_sheets: z.array(SheetSizeSchema).min(1),
});

const PressBrakeSchema = z.object({
  max_tonnage: z.number().positive(),
  max_bend_length_mm: z.number().positive(),
  v_die_widths_mm: z.array(z.number().positive()).min(1),
  punch_radii_mm: z.array(z.number().positive()).min(1),
});

const LaserSchema = z.object({
  max_kerf_width_mm: z.number().positive(),
  min_hole_diameter_mm: z.number().positive(),
});

const ToolingSchema = z.object({
  press_brake: PressBrakeSchema,
  laser: LaserSchema,
});

const ShippingEnvelopeSchema = z.object({
  max_length_mm: z.number().positive(),
  max_width_mm: z.number().positive(),
  max_height_mm: z.number().positive(),
});

const CoatingEnvelopeSchema = z.object({
  max_length_mm: z.number().positive(),
  max_width_mm: z.number().positive(),
});

const LogisticsSchema = z.object({
  shipping_envelope: ShippingEnvelopeSchema,
  max_weight_kg: z.number().positive(),
  coating_envelope: CoatingEnvelopeSchema,
});

const EnvironmentalSchema = z.object({
  fire_rated: z.boolean(),
  marine_grade: z.boolean(),
  high_vibration: z.boolean(),
});

const PersistenceSchema = z.object({
  driver: z.literal('dolt'),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().default(3306),
  database: z.string().min(1),
  data_dir: z.string().min(1).default('./state/dolt'),
});

const GraphSchema = z.object({
  coplanarity_threshold_deg: z.number().positive().default(1.0),
});

const ConfigSchema = z.object({
  materials: z.array(MaterialSchema).min(1),
  tooling: ToolingSchema,
  logistics: LogisticsSchema,
  environmental: EnvironmentalSchema,
  persistence: PersistenceSchema.optional(),
  graph: GraphSchema.default({ coplanarity_threshold_deg: 1.0 }),
});

// ─── Config validation error ──────────────────────────────────────────────────

export class ConfigValidationError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    const summary = issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    super(`Config validation failed: ${summary}`);
    this.issues = issues;
    this.name = 'ConfigValidationError';
  }
}

// ─── Loader ──────────────────────────────────────────────────────────────────

function mapSheetSize(raw: z.infer<typeof SheetSizeSchema>): SheetSize {
  return {
    widthMm: raw.width_mm,
    heightMm: raw.height_mm,
    label: raw.label,
  };
}

function mapMaterial(raw: z.infer<typeof MaterialSchema>): MaterialSpec {
  return {
    id: raw.id,
    name: raw.name,
    thicknessMm: raw.thickness_mm,
    kFactor: raw.k_factor,
    yieldStrengthMpa: raw.yield_strength_mpa,
    grainDirection: raw.grain_direction,
    inventorySheets: raw.inventory_sheets.map(mapSheetSize),
  };
}

function mapTooling(raw: z.infer<typeof ToolingSchema>): ToolingCapability {
  return {
    pressBrake: {
      maxTonnage: raw.press_brake.max_tonnage,
      maxBendLengthMm: raw.press_brake.max_bend_length_mm,
      vDieWidthsMm: raw.press_brake.v_die_widths_mm,
      punchRadiiMm: raw.press_brake.punch_radii_mm,
    },
    laser: {
      maxKerfWidthMm: raw.laser.max_kerf_width_mm,
      minHoleDiameterMm: raw.laser.min_hole_diameter_mm,
    },
  };
}

function mapLogistics(raw: z.infer<typeof LogisticsSchema>): LogisticsConstraints {
  return {
    shippingEnvelope: {
      maxLengthMm: raw.shipping_envelope.max_length_mm,
      maxWidthMm: raw.shipping_envelope.max_width_mm,
      maxHeightMm: raw.shipping_envelope.max_height_mm,
    },
    maxWeightKg: raw.max_weight_kg,
    coatingEnvelope: {
      maxLengthMm: raw.coating_envelope.max_length_mm,
      maxWidthMm: raw.coating_envelope.max_width_mm,
    },
  };
}

function mapEnvironmental(raw: z.infer<typeof EnvironmentalSchema>): EnvironmentalContext {
  return {
    fireRated: raw.fire_rated,
    marineGrade: raw.marine_grade,
    highVibration: raw.high_vibration,
  };
}

function mapPersistence(
  raw: z.infer<typeof PersistenceSchema>,
): PersistenceConfig {
  return {
    driver: raw.driver,
    host: raw.host,
    port: raw.port,
    database: raw.database,
    data_dir: raw.data_dir,
  };
}

/**
 * Loads and validates config.yaml.
 * Throws ConfigValidationError if the schema is invalid.
 */
export function loadConfig(configPath: string): ManufacturingConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw);

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues);
  }

  const data = result.data;
  return {
    materials: data.materials.map(mapMaterial),
    tooling: mapTooling(data.tooling),
    logistics: mapLogistics(data.logistics),
    environmental: mapEnvironmental(data.environmental),
    persistence: data.persistence ? mapPersistence(data.persistence) : undefined,
    graph: {
      coplanarityThresholdDeg: data.graph.coplanarity_threshold_deg,
    },
  };
}
