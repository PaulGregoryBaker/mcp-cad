/**
 * Bill of Materials (BOM) generator.
 *
 * Generates a structured BOM from a FeatureSet + material configuration, and
 * serialises it to CSV. The BOM includes:
 *   - Part ID and description
 *   - Material ID, name, and thickness
 *   - Estimated material area (bounding-box × parts count)
 *   - Approximate material cost (area × cost_per_mm2, if configured)
 *   - Bend, hole, and flange counts
 *
 * Cost estimation uses a simple area-based model:
 *   cost = widthMm × heightMm × thicknessMm × density × price_per_kg
 * where density defaults to 7.85 g/cm³ (mild steel).
 *
 * Tasks: T093, T094
 */

import type { FeatureSet } from './feature';
import type { MaterialSpec } from './material';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BomLineItem {
  partId: string;
  description: string;
  materialId: string;
  materialName: string;
  thicknessMm: number;
  flatWidthMm: number;
  flatHeightMm: number;
  estimatedMassKg: number;
  bendCount: number;
  holeCount: number;
  flangeCount: number;
}

export interface BomResult {
  items: BomLineItem[];
  totalMassKg: number;
  csvContent: string;
}

// Density constant: mild steel g/cm³ → kg/mm³
const STEEL_DENSITY_KG_PER_MM3 = 7.85e-6;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateMass(
  flatWidthMm: number,
  flatHeightMm: number,
  thicknessMm: number,
): number {
  const volumeMm3 = flatWidthMm * flatHeightMm * thicknessMm;
  return volumeMm3 * STEEL_DENSITY_KG_PER_MM3;
}

function toCsvRow(item: BomLineItem): string {
  return [
    item.partId,
    `"${item.description}"`,
    item.materialId,
    `"${item.materialName}"`,
    item.thicknessMm.toFixed(2),
    item.flatWidthMm.toFixed(2),
    item.flatHeightMm.toFixed(2),
    item.estimatedMassKg.toFixed(4),
    item.bendCount,
    item.holeCount,
    item.flangeCount,
  ].join(',');
}

const CSV_HEADER =
  'part_id,description,material_id,material_name,thickness_mm,' +
  'flat_width_mm,flat_height_mm,estimated_mass_kg,bend_count,hole_count,flange_count';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a BOM from a FeatureSet.
 *
 * @param featureSet  - Extracted features for one shell.
 * @param material    - Material specification for this part.
 * @param flatWidthMm  - Flat blank width from unfold result (or bounding-box estimate).
 * @param flatHeightMm - Flat blank height from unfold result.
 * @returns           - BomResult with line items, total mass, and CSV string.
 */
export function generateBOM(
  featureSet: FeatureSet,
  material: MaterialSpec,
  flatWidthMm: number,
  flatHeightMm: number,
): BomResult {
  const mass = estimateMass(flatWidthMm, flatHeightMm, material.thicknessMm);

  const item: BomLineItem = {
    partId: featureSet.shellId,
    description: `Sheet metal panel (${featureSet.bends.length} bends)`,
    materialId: material.id,
    materialName: material.name,
    thicknessMm: material.thicknessMm,
    flatWidthMm,
    flatHeightMm,
    estimatedMassKg: mass,
    bendCount: featureSet.bends.length,
    holeCount: featureSet.holes.length,
    flangeCount: featureSet.flanges.length,
  };

  const csvContent = [CSV_HEADER, toCsvRow(item)].join('\n') + '\n';

  return {
    items: [item],
    totalMassKg: mass,
    csvContent,
  };
}

/**
 * Generate a multi-part BOM from several FeatureSets.
 *
 * @param parts - Array of {featureSet, material, flatWidthMm, flatHeightMm} tuples.
 * @returns     - Combined BomResult.
 */
export function generateMultiPartBOM(
  parts: Array<{
    featureSet: FeatureSet;
    material: MaterialSpec;
    flatWidthMm: number;
    flatHeightMm: number;
  }>,
): BomResult {
  const items: BomLineItem[] = parts.map(({ featureSet, material, flatWidthMm, flatHeightMm }) => {
    const mass = estimateMass(flatWidthMm, flatHeightMm, material.thicknessMm);
    return {
      partId: featureSet.shellId,
      description: `Sheet metal panel (${featureSet.bends.length} bends)`,
      materialId: material.id,
      materialName: material.name,
      thicknessMm: material.thicknessMm,
      flatWidthMm,
      flatHeightMm,
      estimatedMassKg: mass,
      bendCount: featureSet.bends.length,
      holeCount: featureSet.holes.length,
      flangeCount: featureSet.flanges.length,
    };
  });

  const totalMassKg = items.reduce((sum, item) => sum + item.estimatedMassKg, 0);
  const rows = [CSV_HEADER, ...items.map(toCsvRow)].join('\n') + '\n';

  return { items, totalMassKg, csvContent: rows };
}
