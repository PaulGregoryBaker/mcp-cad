/**
 * Test fixture helpers for MCP-CAD test suite.
 * Resolves STEP file paths and provides canonical fixture paths for INF-03.
 *
 * Task: T137
 */

import * as path from 'path';
import * as fs from 'fs';

// ─── Fixture root resolution ────────────────────────────────────────────────

/**
 * Resolves the absolute path to the C++ test fixtures directory.
 * Contains STEP files used across both C++ and TypeScript integration tests.
 */
export function getFixturesDir(): string {
  // Traverse from ts/tests/helpers/ → ts/ → mcp-cad root → cpp/tests/fixtures/
  const dir = path.resolve(__dirname, '..', '..', '..', 'cpp', 'tests', 'fixtures');
  if (!fs.existsSync(dir)) {
    throw new Error(`Fixtures directory not found: ${dir}. Run cmake build first.`);
  }
  return dir;
}

/**
 * Resolves an absolute path to a named STEP fixture file.
 */
export function getFixturePath(filename: string): string {
  const filePath = path.join(getFixturesDir(), filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture file not found: ${filePath}`);
  }
  return filePath;
}

// ─── Canonical INF-03 Fixture ────────────────────────────────────────────────

/**
 * The canonical fixture for the INF-03 golden-path integration test.
 * This is a 3-panel sheet metal design with a known decomposition path.
 *
 * IMPORTANT: Do not modify this file or rename it without a review,
 * as it is the canonical tier-1 fixture referenced by T120 and INF-03.
 */
export const INF03_FIXTURE = 'sheet_3panel.stp';

/**
 * Returns the absolute path to the INF-03 canonical fixture.
 */
export function getInf03FixturePath(): string {
  return getFixturePath(INF03_FIXTURE);
}

// ─── Fixture sets ────────────────────────────────────────────────────────────

/**
 * Tier-1 fixtures: simple geometries, stable, never changed without review.
 * Used for baseline and regression testing.
 */
export const TIER1_FIXTURES = [
  'simple_box.stp',
  'sheet_3panel.stp',
  'sheet_1panel.stp',
  'bracket_simple.stp',
  'panel_ribbed.stp',
] as const;

/**
 * Tier-2 fixtures: moderate complexity, used for accuracy validation.
 */
export const TIER2_FIXTURES = [
  'flange_complex.stp',
  'bracket_deep.stp',
  'enclosure_box.stp',
  'multi_bend.stp',
  'chassis_frame.stp',
] as const;

/**
 * Returns absolute paths to all tier-1 fixtures.
 */
export function getTier1FixturePaths(): string[] {
  return TIER1_FIXTURES.map((f) => getFixturePath(f));
}

/**
 * Returns absolute paths to all tier-2 fixtures.
 */
export function getTier2FixturePaths(): string[] {
  return TIER2_FIXTURES.map((f) => getFixturePath(f));
}
