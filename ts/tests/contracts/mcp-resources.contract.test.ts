/**
 * TypeScript contract test: MCP resource handlers.
 * Asserts resource URI handlers return correct schema.
 *
 * Task: T142
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextResources,
  buildLogisticsResources,
  buildManufacturingResources,
  buildGeometryResources,
  getAllResources,
  RESOURCE_URIS,
} from '../../src/mcp/resources';
import type { ManufacturingConfig } from '../../src/config/loader';

// ─── Test fixture config ──────────────────────────────────────────────────────

const testConfig: ManufacturingConfig = {
  materials: [
    {
      id: 'mild_steel_1.5mm',
      name: 'Mild Steel 1.5mm',
      thicknessMm: 1.5,
      kFactor: 0.33,
      yieldStrengthMpa: 250,
      grainDirection: 'any',
      inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
    },
  ],
  tooling: {
    pressBrake: {
      maxTonnage: 1000,
      maxBendLengthMm: 3000,
      vDieWidthsMm: [6, 8, 10],
      punchRadiiMm: [0.5, 1.0],
    },
    laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 23,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

// ─── Context resource tests ───────────────────────────────────────────────────

describe('context:// resource contract', () => {
  it('returns environmental context with required fields', () => {
    const resources = buildContextResources(testConfig);
    const env = resources[RESOURCE_URIS.ENVIRONMENTAL_CONTEXT] as Record<string, unknown>;

    expect(env).toBeDefined();
    expect(typeof env['fireRated']).toBe('boolean');
    expect(typeof env['marineGrade']).toBe('boolean');
    expect(typeof env['highVibration']).toBe('boolean');
  });

  it('reflects fire_rated=false from config', () => {
    const resources = buildContextResources(testConfig);
    const env = resources[RESOURCE_URIS.ENVIRONMENTAL_CONTEXT] as Record<string, unknown>;
    expect(env['fireRated']).toBe(false);
  });

  it('reflects fire_rated=true from config', () => {
    const fireRatedConfig = {
      ...testConfig,
      environmental: { ...testConfig.environmental, fireRated: true },
    };
    const resources = buildContextResources(fireRatedConfig);
    const env = resources[RESOURCE_URIS.ENVIRONMENTAL_CONTEXT] as Record<string, unknown>;
    expect(env['fireRated']).toBe(true);
  });
});

// ─── Logistics resource tests ─────────────────────────────────────────────────

describe('logistics:// resource contract', () => {
  it('returns shipping envelope with required dimensions', () => {
    const resources = buildLogisticsResources(testConfig);
    const envelope = resources[RESOURCE_URIS.SHIPPING_ENVELOPE] as Record<string, unknown>;

    expect(typeof envelope['maxLengthMm']).toBe('number');
    expect(typeof envelope['maxWidthMm']).toBe('number');
    expect(typeof envelope['maxHeightMm']).toBe('number');
  });

  it('returns max_weight resource', () => {
    const resources = buildLogisticsResources(testConfig);
    const weight = resources[RESOURCE_URIS.MAX_WEIGHT] as Record<string, unknown>;
    expect(typeof weight['maxWeightKg']).toBe('number');
    expect(weight['maxWeightKg']).toBe(23);
  });

  it('returns coating envelope', () => {
    const resources = buildLogisticsResources(testConfig);
    const coating = resources[RESOURCE_URIS.COATING_ENVELOPE] as Record<string, unknown>;
    expect(typeof coating['maxLengthMm']).toBe('number');
    expect(typeof coating['maxWidthMm']).toBe('number');
  });
});

// ─── Manufacturing resource tests ─────────────────────────────────────────────

describe('manufacturing:// resource contract', () => {
  it('returns press brake spec with required fields', () => {
    const resources = buildManufacturingResources(testConfig);
    const pb = resources[RESOURCE_URIS.PRESS_BRAKE] as Record<string, unknown>;

    expect(typeof pb['maxTonnage']).toBe('number');
    expect(typeof pb['maxBendLengthMm']).toBe('number');
    expect(Array.isArray(pb['vDieWidthsMm'])).toBe(true);
    expect(Array.isArray(pb['punchRadiiMm'])).toBe(true);
  });

  it('returns material inventory as array', () => {
    const resources = buildManufacturingResources(testConfig);
    const inventory = resources[RESOURCE_URIS.MATERIAL_INVENTORY] as unknown[];

    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.length).toBeGreaterThan(0);

    const mat = inventory[0] as Record<string, unknown>;
    expect(typeof mat['id']).toBe('string');
    expect(typeof mat['thicknessMm']).toBe('number');
    expect(typeof mat['kFactor']).toBe('number');
  });

  it('returns manufacturing rules with kerf range', () => {
    const resources = buildManufacturingResources(testConfig);
    const rules = resources[RESOURCE_URIS.MANUFACTURING_RULES] as Record<string, unknown>;

    expect(Array.isArray(rules['kerfOffsetRange'])).toBe(true);
    const range = rules['kerfOffsetRange'] as number[];
    expect(range[0]).toBe(0.1);
    expect(range[1]).toBe(0.2);
  });
});

// ─── getAllResources contract ──────────────────────────────────────────────────

describe('getAllResources: returns all required URIs', () => {
  it('contains all expected resource URIs', () => {
    const resources = getAllResources(testConfig);
    const uris = Object.keys(resources);

    expect(uris).toContain(RESOURCE_URIS.ENVIRONMENTAL_CONTEXT);
    expect(uris).toContain(RESOURCE_URIS.ASSEMBLY_CONTEXT);
    expect(uris).toContain(RESOURCE_URIS.SHIPPING_ENVELOPE);
    expect(uris).toContain(RESOURCE_URIS.MAX_WEIGHT);
    expect(uris).toContain(RESOURCE_URIS.COATING_ENVELOPE);
    expect(uris).toContain(RESOURCE_URIS.PRESS_BRAKE);
    expect(uris).toContain(RESOURCE_URIS.MATERIAL_INVENTORY);
    expect(uris).toContain(RESOURCE_URIS.MANUFACTURING_RULES);
  });

  it('returns no null/undefined values', () => {
    const resources = getAllResources(testConfig);
    for (const [uri, value] of Object.entries(resources)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
  });
});
