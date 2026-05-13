/**
 * MCP static resource handlers.
 * Resources: context://, logistics://, manufacturing://, geometry://
 *
 * Task: T036
 */

import type { ManufacturingConfig } from '../config/loader';
import { session } from '../geometry/session';

// ─── Resource URIs ────────────────────────────────────────────────────────────

export const RESOURCE_URIS = {
  ENVIRONMENTAL_CONTEXT: 'context://intent/environmental',
  ASSEMBLY_CONTEXT: 'context://intent/assembly',
  SHIPPING_ENVELOPE: 'logistics://envelope/shipping',
  MAX_WEIGHT: 'logistics://handling/max_weight',
  COATING_ENVELOPE: 'logistics://envelope/coating',
  PRESS_BRAKE: 'manufacturing://tooling/press_brake',
  MATERIAL_INVENTORY: 'manufacturing://material/inventory',
  MANUFACTURING_RULES: 'manufacturing://rules',
} as const;

// ─── Resource content builders ────────────────────────────────────────────────

export function buildContextResources(config: ManufacturingConfig): Record<string, unknown> {
  return {
    [RESOURCE_URIS.ENVIRONMENTAL_CONTEXT]: {
      fireRated: config.environmental.fireRated,
      marineGrade: config.environmental.marineGrade,
      highVibration: config.environmental.highVibration,
    },
    [RESOURCE_URIS.ASSEMBLY_CONTEXT]: {
      preferredMethod: 'unspecified',
    },
  };
}

export function buildLogisticsResources(config: ManufacturingConfig): Record<string, unknown> {
  return {
    [RESOURCE_URIS.SHIPPING_ENVELOPE]: config.logistics.shippingEnvelope,
    [RESOURCE_URIS.MAX_WEIGHT]: {
      maxWeightKg: config.logistics.maxWeightKg,
    },
    [RESOURCE_URIS.COATING_ENVELOPE]: config.logistics.coatingEnvelope,
  };
}

export function buildManufacturingResources(
  config: ManufacturingConfig,
): Record<string, unknown> {
  return {
    [RESOURCE_URIS.PRESS_BRAKE]: config.tooling.pressBrake,
    [RESOURCE_URIS.MATERIAL_INVENTORY]: config.materials.map((m) => ({
      id: m.id,
      name: m.name,
      thicknessMm: m.thicknessMm,
      kFactor: m.kFactor,
      inventorySheets: m.inventorySheets,
    })),
    [RESOURCE_URIS.MANUFACTURING_RULES]: {
      minHoleDiameter: 'material_thickness',
      minFlangeWidth: '4x_material_thickness',
      kerfOffsetRange: [0.1, 0.2],
      minBendRadius: 'material_thickness',
    },
  };
}

export function buildGeometryResources(solidId?: string): Record<string, unknown> {
  if (solidId === undefined) {
    return {};
  }

  return {
    [`geometry://part/${solidId}/topology`]: {
      solidId,
      available: session.hasSolid(solidId),
      sessionSummary: session.getSummary(),
    },
  };
}

/**
 * Returns all static resource content for the MCP server.
 */
export function getAllResources(
  config: ManufacturingConfig,
  activeSolidId?: string,
): Record<string, unknown> {
  return {
    ...buildContextResources(config),
    ...buildLogisticsResources(config),
    ...buildManufacturingResources(config),
    ...buildGeometryResources(activeSolidId),
  };
}
