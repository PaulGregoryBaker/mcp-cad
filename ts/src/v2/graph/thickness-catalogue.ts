/**
 * Standard sheet thicknesses per material (spec 010 T063) — a port of the
 * client's catalogue (Form·AI·tion lib/core/data/standard_thickness_catalog.dart)
 * so import_part can refuse a thickness the project could never buy
 * (IMPORT_THICKNESS_NOT_IN_CATALOGUE). Both gauge systems are listed; the
 * client filters by the project's unit system for display.
 *
 * Keep in sync with the client file; contract fixtures carry the values.
 */

export type MaterialId = 'mildSteel' | 'stainlessSteel' | 'aluminum';

/** AISI/MSG gauges 7–30 (imperial projects). */
const AISI_MSG: Record<MaterialId, number[]> = {
  mildSteel: [4.55, 4.18, 3.8, 3.42, 3.04, 2.66, 2.28, 1.9, 1.71, 1.52, 1.37, 1.21, 1.06, 0.91, 0.84, 0.76, 0.68, 0.61, 0.53, 0.45, 0.42, 0.38, 0.34, 0.3],
  stainlessSteel: [4.76, 4.37, 3.97, 3.57, 3.18, 2.78, 2.39, 1.98, 1.78, 1.59, 1.42, 1.27, 1.12, 0.95, 0.86, 0.79, 0.71, 0.64, 0.56, 0.48, 0.43, 0.41, 0.36, 0.33],
  aluminum: [3.67, 3.26, 2.91, 2.59, 2.3, 2.05, 1.83, 1.63, 1.45, 1.29, 1.15, 1.02, 0.91, 0.81, 0.72, 0.64, 0.57, 0.51, 0.45, 0.4, 0.36, 0.32, 0.29, 0.25],
};

/** ISO/EN metric steps (metric projects), same list for every material. */
const ISO_EN = [0.3, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.5];

const TOLERANCE_MM = 1e-6;

export function isMaterialId(id: string): id is MaterialId {
  return id === 'mildSteel' || id === 'stainlessSteel' || id === 'aluminum';
}

export function catalogueThicknesses(material: MaterialId): number[] {
  return [...AISI_MSG[material], ...ISO_EN];
}

export function isCatalogueThickness(material: string, thicknessMm: number): boolean {
  if (!isMaterialId(material)) return false;
  return catalogueThicknesses(material).some((t) => Math.abs(t - thicknessMm) <= TOLERANCE_MM);
}

/**
 * K-factor for a bend process: the midpoint of the client's suggested range
 * (lib/core/data/bend_type.dart). Processes without a published range →
 * null (the caller reports it; never a silent guess).
 */
const K_FACTOR_RANGES: Record<string, [number, number]> = {
  airBend: [0.33, 0.45],
  bottoming: [0.28, 0.32],
  coining: [0.28, 0.32],
};

export function kFactorForProcess(process: string | undefined): number | null {
  const r = process ? K_FACTOR_RANGES[process] : undefined;
  return r ? (r[0] + r[1]) / 2 : null;
}
