/**
 * Minimal v2 configuration loader — reads `config.yaml` once and exposes the
 * `nesting` block (rebuild/21-nesting-libnest2d.md §4.3). Deliberately scoped
 * to what `simulate_nesting` needs today; the full Zod-validated loader
 * documented in docs/CONFIG.md can replace this without changing callers.
 *
 * Shop policy (cutting width, kerf ceiling, margins, rotations) lives in the
 * config; per-job overrides are validated against it by the caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface NestingConfig {
  cuttingWidthMm: number;
  maxKerfWidthMm: number;
  safetyGapMm: number;
  sheetMarginMm: number;
  placementAccuracy: number;
  rotationsDeg: number[];
}

const DEFAULTS: NestingConfig = {
  cuttingWidthMm: 0.15,
  maxKerfWidthMm: 0.2,
  safetyGapMm: 0.0,
  sheetMarginMm: 2.0,
  placementAccuracy: 0.65,
  rotationsDeg: [0, 90, 180, 270],
};

let cached: NestingConfig | null = null;

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export function getNestingConfig(): NestingConfig {
  if (cached) return cached;

  const envPath = process.env.MCPCAD_CONFIG;
  const configPath = envPath || path.resolve(__dirname, '../../config/config.yaml');

  try {
    if (fs.existsSync(configPath)) {
      const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const nesting = (raw.nesting ?? {}) as Record<string, unknown>;
      const tooling = (raw.tooling ?? {}) as Record<string, unknown>;
      const laser = (tooling.laser ?? {}) as Record<string, unknown>;
      const optimizer = (nesting.optimizer ?? {}) as Record<string, unknown>;

      const maxKerfWidthMm = num(laser.max_kerf_width_mm, DEFAULTS.maxKerfWidthMm);
      cached = {
        // default cutting width = tooling kerf ceiling, per §4.2
        cuttingWidthMm: num(nesting.cutting_width_mm, maxKerfWidthMm),
        maxKerfWidthMm,
        safetyGapMm: num(nesting.safety_gap_mm, DEFAULTS.safetyGapMm),
        sheetMarginMm: num(nesting.sheet_margin_mm, DEFAULTS.sheetMarginMm),
        placementAccuracy: num(optimizer.placement_accuracy, DEFAULTS.placementAccuracy),
        rotationsDeg: Array.isArray(nesting.rotations_deg)
          ? (nesting.rotations_deg as number[])
          : DEFAULTS.rotationsDeg,
      };
      return cached;
    }
  } catch {
    // Unreadable/absent config → defaults. Shop policy is best-effort here;
    // the per-job cutting-width override is still validated by the caller.
  }

  cached = { ...DEFAULTS };
  return cached;
}
