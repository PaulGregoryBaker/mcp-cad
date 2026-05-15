/**
 * MaterialSpec store — loads material configuration from YAML.
 * Computes bend allowance using K-factor formula.
 *
 * Tasks: T028, T051
 */

export interface SheetSize {
  widthMm: number;
  heightMm: number;
  label: string;
}

export interface MaterialSpec {
  id: string;
  name: string;
  thicknessMm: number;
  kFactor: number;
  yieldStrengthMpa: number;
  grainDirection: 'x' | 'y' | 'any';
  inventorySheets: SheetSize[];
}

/**
 * Computes bend allowance in mm using the K-factor formula:
 *   BA = (π / 180) × angle × (radius + k × thickness)
 *
 * @param material   Material specification
 * @param angleDeg   Bend angle in degrees (0–180)
 * @param radiusMm   Inner bend radius in mm
 * @returns          Bend allowance in mm
 */
export function computeBendAllowance(
  material: MaterialSpec,
  angleDeg: number,
  radiusMm: number,
): number {
  if (angleDeg < 0 || angleDeg > 180) {
    throw new RangeError(`Bend angle must be between 0 and 180 degrees; got ${angleDeg}`);
  }
  if (radiusMm < 0) {
    throw new RangeError(`Bend radius must be non-negative; got ${radiusMm}`);
  }
  return (Math.PI / 180.0) * angleDeg * (radiusMm + material.kFactor * material.thicknessMm);
}

/**
 * MaterialStore provides access to material specifications.
 * Populated from config.yaml by ConfigLoader.
 */
export class MaterialStore {
  private readonly materials: Map<string, MaterialSpec>;

  constructor(materials: MaterialSpec[]) {
    this.materials = new Map(materials.map((m) => [m.id, m]));
  }

  get(id: string): MaterialSpec {
    const mat = this.materials.get(id);
    if (mat === undefined) {
      throw new Error(`Material not found: ${id}`);
    }
    return JSON.parse(JSON.stringify(mat));
  }

  has(id: string): boolean {
    return this.materials.has(id);
  }

  all(): MaterialSpec[] {
    return Array.from(this.materials.values()).map(m => JSON.parse(JSON.stringify(m)));
  }
}
