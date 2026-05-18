/**
 * CONTRACT: decompose_volume returns parts[].mesh_url
 *
 * The Form·AI·tion Flutter client needs each decomposed panel to carry a
 * loadable GLB URL so the Three.js viewport can stream geometry via
 * GLTFLoader.  The required response shape is:
 *
 *   {
 *     parts: [{ id: string, mesh_url: string }, ...],
 *     panel_ids: string[],
 *     panel_count: number,
 *     strategy_applied: string,
 *     rollback_token: string,
 *   }
 *
 * handleDecomposeVolume (src/mcp/tools.ts) returns both parts[] and panel_ids.
 *
 * To run only these tests:
 *   npx vitest run --project e2e-mesh-url-contract
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadConfig } from '../../src/config/loader';
import { dispatchTool, setGeometryBindingMock } from '../../src/mcp/tools';
import { session } from '../../src/geometry/session';
import type { GeometryAddon } from '../../src/geometry/binding';

function fixturePath(): string {
  return path.resolve(__dirname, 'fixtures', 'braai.step');
}

// Minimal mock — only the operations exercised by clean_geometry +
// decompose_volume are used.  Remaining methods satisfy the interface.
const mockAddon: GeometryAddon = {
  loadStep: (_filePath: string) => 'solid-braai',
  checkManifold: (_solidId: string) => ({ isManifold: true, issues: [] }),
  healGeometry: (solidId: string) => solidId,
  getTopology: (solidId: string) => ({
    solidId,
    faces: [
      {
        faceId: 'f-0',
        surfaceType: 'plane' as const,
        areaMm2: 900,
        normalX: 0,
        normalY: 0,
        normalZ: 1,
      },
    ],
    edges: [{ edgeId: 'e-0', curveType: 'line' as const, lengthMm: 30 }],
    adjacency: [],
    bends: [],
    holes: [],
    flanges: [],
  }),
  booleanCut: () => ({
    shellIds: ['shell-0', 'shell-1'],
    rollbackToken: 'rb-decompose',
  }),
  addTabSlot: (shellIdA, shellIdB, kerfOffsetMm) => ({
    modifiedShellIds: [shellIdA, shellIdB],
    kerfOffsetApplied: kerfOffsetMm,
    rollbackToken: 'rb-tabslot',
  }),
  addRivetHole: (shellId) => ({
    modifiedShellId: shellId,
    holeFeatureId: 'hole-0',
    rollbackToken: 'rb-rivet',
  }),
  unfoldShell: (shellId, kFactor) => ({
    unfoldId: `unfold-${shellId}`,
    flatWidthMm: 300,
    flatHeightMm: 120,
    kFactorUsed: kFactor,
    bendCount: 0,
    rollbackToken: 'rb-unfold',
  }),
  exportDxf: () => ({
    dxfContent: '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n',
    wireCount: 0,
    bboxWidthMm: 300,
    bboxHeightMm: 120,
  }),
  exportGlb: (_shellId: string) => Buffer.from('glTF'),
  nestShells: (unfoldIds) => ({
    nestId: 'nest-0',
    placements: unfoldIds.map((id, i) => ({
      unfoldId: id,
      sheetIndex: 0,
      x: i * 20,
      y: 0,
      rotationDeg: 0,
    })),
    utilisationPct: 70,
    sheetsRequired: 1,
  }),
  createSnapshot: (label: string) => `snap-${label}`,
  restoreSnapshot: () => ({
    restoredSolidIds: ['solid-braai'],
    restoredShellIds: ['shell-0', 'shell-1'],
  }),
  clearSnapshots: () => undefined,
  separateSolids: (_solidId: string) => ['shell-0', 'shell-1'],
  computeIntersections: (_partIds: string[]) => ({ intersects: false, clashes: [] }),
  computeGaps: (_partAId: string, _partBId: string, _maxDistanceThresholdMm: number) => ({
    hasGap: false,
    minimumDistanceMm: 0,
    closestElements: { partAFaceId: 'f-0', partBFaceId: 'f-1' },
    extensionVector: { x: 0, y: 0, z: 0 },
    gapBoundingBox: { origin: { x: 0, y: 0, z: 0 }, dimensions: { x: 0, y: 0, z: 0 } },
  }),
  trimBodyWithPlane: (_partId: string, _plane: unknown, _keepPositiveSide: boolean) => ({
    trimmedShellId: 'trimmed-shell',
    rollbackToken: 'rb-trim',
  }),
  splitBodyByPlane: (_partId: string, _plane: unknown) => ({
    positiveShellId: 'pos-shell',
    negativeShellId: 'neg-shell',
    rollbackToken: 'rb-split',
  }),
  mergeBodiesWithBend: (_partAId: string, _partBId: string, _targetEdges: string[], _bendRadiusMm: number) => ({
    mergedShellId: 'merged-shell',
    rollbackToken: 'rb-merge',
  }),
  extendFaceToTarget: (_partId: string, _faceId: string, _targetType: string, _targetPartId: string, _targetFaceId: string, _targetPlane: unknown) => ({
    modifiedShellId: 'extended-shell',
    extensionDistanceMm: 0,
    rollbackToken: 'rb-extend',
  }),
  offsetFace: (_partId: string, _faceId: string, _distanceMm: number) => ({
    modifiedShellId: 'offset-shell',
    rollbackToken: 'rb-offset',
  }),
  addFlange: (_partId: string, _edgeId: string, _lengthMm: number, _angleDeg: number, _bendRadiusMm: number) => ({
    modifiedShellId: 'flanged-shell',
    flangeFeatureId: 'flange-0',
    rollbackToken: 'rb-flange',
  }),
  ripEdge: (_partId: string, _edgeId: string) => ({
    modifiedShellId: 'ripped-shell',
    rollbackToken: 'rb-rip',
  }),
  splitBodyByBends: (_partId: string, _angleThresholdDeg: number) => ({
    panel_ids: ['shell-0', 'shell-1'],
    protrusion_ids: [],
    rollbackToken: 'rb-bends',
    detected_mode: 'thin_solid',
  }),
};

describe('CONTRACT GAP: decompose_volume must return parts[].mesh_url', () => {
  const config = loadConfig('./config/config.yaml');

  beforeEach(() => {
    session.reset();
    setGeometryBindingMock(undefined);
  });

  it('fixture file braai.step exists', () => {
    expect(fs.existsSync(fixturePath())).toBe(true);
  });

  it(
    'decompose_volume result contains parts[] with a non-empty mesh_url per panel',
    async () => {
      setGeometryBindingMock(mockAddon);

      // Step 1 — clean_geometry (required to obtain a solidId)
      const clean = (await dispatchTool(
        'clean_geometry',
        { file_path: fixturePath() },
        config,
      )) as Record<string, unknown>;

      const solidId = clean['solid_id'] as string;
      expect(solidId).toBeTruthy();

      // Step 2 — decompose_volume
      const decompose = (await dispatchTool(
        'decompose_volume',
        { solid_id: solidId, strategy: 'Integrity' },
        config,
      )) as Record<string, unknown>;

      // ── Required shape assertions ─────────────────────────────────────────

      expect(
        decompose,
        'decompose_volume response must include a parts array',
      ).toHaveProperty('parts');

      const parts = decompose['parts'] as Array<Record<string, unknown>>;

      expect(Array.isArray(parts), 'parts must be an array').toBe(true);
      expect(parts.length, 'parts must contain at least one panel').toBeGreaterThan(0);

      for (const [i, part] of parts.entries()) {
        expect(
          typeof part['id'],
          `parts[${i}].id must be a string`,
        ).toBe('string');

        expect(
          (part['id'] as string).length,
          `parts[${i}].id must be non-empty`,
        ).toBeGreaterThan(0);

        expect(
          typeof part['mesh_url'],
          `parts[${i}].mesh_url must be a string — the Three.js viewport needs a loadable GLB URL`,
        ).toBe('string');

        expect(
          (part['mesh_url'] as string).length,
          `parts[${i}].mesh_url must be non-empty`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it('panel_count matches the number of parts returned', async () => {
    setGeometryBindingMock(mockAddon);

    const clean = (await dispatchTool(
      'clean_geometry',
      { file_path: fixturePath() },
      config,
    )) as Record<string, unknown>;

    const decompose = (await dispatchTool(
      'decompose_volume',
      { solid_id: clean['solid_id'] as string, strategy: 'Integrity' },
      config,
    )) as Record<string, unknown>;

    // Once parts[] is implemented, panel_count must equal parts.length.
    const parts = decompose['parts'] as Array<unknown> | undefined;
    expect(parts, 'parts array must be present').toBeDefined();
    expect(
      decompose['panel_count'],
      'panel_count must equal parts.length',
    ).toBe((parts ?? []).length);
  });
});
