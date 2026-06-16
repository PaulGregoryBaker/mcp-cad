/**
 * Functional test: hollow cube box sheet-metal decomposition workflow.
 *
 * Scenario: A 200 × 200 × 200 mm hollow cube (1 mm wall thickness) is
 * decomposed into four sheet-metal panels via repeated split_body_by_plane
 * calls, inner faces are recessed with offset_face, panels are validated for
 * logistics compliance, gaps are detected and closed, adjacent pairs are merged
 * with a bend radius, flanges are added to open edges, and interior edges are
 * ripped to enable downstream unfold.
 *
 * Uses setGeometryBindingMock — no C++ addon or real STEP file required.
 * All ten new gap-closure and body-topology tools are exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { dispatchTool, setGeometryBindingMock, registerTestPart, resetMcpGraphStateForTests } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import type { GeometryAddon } from '../../src/geometry/binding';
import type { TopologyGraph } from '../../src/geometry/types';

// ─── Topology helper ──────────────────────────────────────────────────────────

/**
 * Returns a synthetic topology for a 200 × 200 mm, 1 mm thick sheet panel.
 * Two large planar faces (40 000 mm²) plus four narrow edge faces (200 mm²).
 * The interior edge shared by both large faces enables rip_edge tests.
 */
function sheetTopology(shellId: string): TopologyGraph {
  return {
    solidId: shellId,
    faces: [
      { faceId: 'f-outer', surfaceType: 'plane', areaMm2: 40_000, normalX: 0, normalY: 0, normalZ:  1 },
      { faceId: 'f-inner', surfaceType: 'plane', areaMm2: 40_000, normalX: 0, normalY: 0, normalZ: -1 },
      { faceId: 'f-e1',    surfaceType: 'plane', areaMm2:    200, normalX:  1, normalY: 0, normalZ:  0 },
      { faceId: 'f-e2',    surfaceType: 'plane', areaMm2:    200, normalX: -1, normalY: 0, normalZ:  0 },
      { faceId: 'f-e3',    surfaceType: 'plane', areaMm2:    200, normalX:  0, normalY:  1, normalZ: 0 },
      { faceId: 'f-e4',    surfaceType: 'plane', areaMm2:    200, normalX:  0, normalY: -1, normalZ: 0 },
    ],
    edges: [
      { edgeId: 'e-boundary-1', curveType: 'line', lengthMm: 200 },
      { edgeId: 'e-boundary-2', curveType: 'line', lengthMm: 200 },
      { edgeId: 'e-boundary-3', curveType: 'line', lengthMm: 200 },
      { edgeId: 'e-boundary-4', curveType: 'line', lengthMm: 200 },
      { edgeId: 'e-interior-1', curveType: 'line', lengthMm: 200 },
    ],
    adjacency: [
      { faceIdA: 'f-outer', faceIdB: 'f-e1', sharedEdgeId: 'e-boundary-1', dihedralAngleDeg:  90 },
      { faceIdA: 'f-outer', faceIdB: 'f-e2', sharedEdgeId: 'e-boundary-2', dihedralAngleDeg:  90 },
      { faceIdA: 'f-outer', faceIdB: 'f-e3', sharedEdgeId: 'e-boundary-3', dihedralAngleDeg:  90 },
      { faceIdA: 'f-outer', faceIdB: 'f-e4', sharedEdgeId: 'e-boundary-4', dihedralAngleDeg:  90 },
      { faceIdA: 'f-outer', faceIdB: 'f-inner', sharedEdgeId: 'e-interior-1', dihedralAngleDeg: 180 },
    ],
  };
}

// ─── Mock addon factory ───────────────────────────────────────────────────────

/**
 * Builds a stateful mock GeometryAddon.
 *
 * Snapshot counter increments on every mutating operation so each rollback
 * token is unique and in order. Split/merge return shell IDs derived from their
 * input IDs — allowing the test to predict IDs without maintaining a registry.
 */
function buildMockAddon(): GeometryAddon {
  let snapCount = 0;
  const snap = () => `snap-${++snapCount}`;

  return {
    loadStep:        vi.fn(() => 'cube-solid'),
    getTopology:     vi.fn((shellId: string): TopologyGraph => sheetTopology(shellId)),
    checkManifold:   vi.fn(() => ({ isManifold: true, issues: [] })),
    healGeometry:    vi.fn((id: string) => id),
    separateSolids:  vi.fn((id: string) => [id]),

    booleanCut: vi.fn((id: string) => ({
      shellIds: [`${id}-cut-a`, `${id}-cut-b`],
      rollbackToken: snap(),
    })),

    addTabSlot: vi.fn((a: string, b: string) => ({
      modifiedShellIds: [a, b],
      kerfOffsetApplied: 0.15,
      rollbackToken: snap(),
    })),

    addRivetHole: vi.fn((id: string, faceId: string) => ({
      modifiedShellId: id,
      holeFeatureId: `hole-${faceId}`,
      rollbackToken: snap(),
    })),

    unfoldShell: vi.fn((id: string) => ({
      unfoldId: `unfold-${id}`,
      flatWidthMm: 200,
      flatHeightMm: 200,
      kFactorUsed: 0.42,
      bendCount: 1,
      rollbackToken: snap(),
    })),

    exportDxf: vi.fn(() => ({
      dxfContent: 'SECTION\n0\nHEADER\n0\nEOF\n',
      wireCount: 4,
      bboxWidthMm: 200,
      bboxHeightMm: 200,
    })),

    exportGlb: vi.fn(() => Buffer.from('glb')),

    nestShells: vi.fn((_ids: string[]) => ({
      nestId: 'nest-1',
      placements: [],
      utilisationPct: 85,
      sheetsRequired: 1,
    })),

    createSnapshot:  vi.fn(() => snap()),
    restoreSnapshot: vi.fn(() => ({ restoredSolidIds: [], restoredShellIds: [] })),
    clearSnapshots:  vi.fn(),

    // ── New tools ──────────────────────────────────────────────────────────────

    splitBodyByPlane: vi.fn((id: string) => ({
      positiveShellId: `${id}-pos`,
      negativeShellId: `${id}-neg`,
      rollbackToken:   snap(),
    })),

    mergeBodiesWithBend: vi.fn((a: string, b: string) => ({
      mergedShellId: `merged(${a}+${b})`,
      rollbackToken: snap(),
    })),

    extendFaceToTarget: vi.fn((id: string) => ({
      modifiedShellId:     id,
      extensionDistanceMm: 2.0,
      rollbackToken:       snap(),
    })),

    offsetFace: vi.fn((id: string) => ({
      modifiedShellId: id,
      rollbackToken:   snap(),
    })),

    addFlange: vi.fn((id: string, edgeId: string) => ({
      modifiedShellId:  id,
      flangeFeatureId:  `flange(${id}@${edgeId})`,
      rollbackToken:    snap(),
    })),

    ripEdge: vi.fn((id: string) => ({
      modifiedShellId: id,
      rollbackToken:   snap(),
    })),

    computeIntersections: vi.fn((_partIds: string[]) => ({
      intersects: false,
      clashes:    [],
    })),

    computeGaps: vi.fn((_a: string, _b: string, _maxDist: number) => ({
      hasGap:             true,
      minimumDistanceMm:  2.0,
      closestElements:    { partAFaceId: 'f-e1', partBFaceId: 'f-e2' },
      extensionVector:    { x: 0, y: 1, z: 0 },
      gapBoundingBox: {
        origin:     { x: 0, y: 100, z: 0 },
        dimensions: { x: 200, y: 2, z: 200 },
      },
    })),

    trimBodyWithPlane: vi.fn((id: string) => ({
      trimmedShellId: id,
      rollbackToken:  snap(),
    })),

    splitBodyByBends: vi.fn((id: string, _threshold: number) => ({
      panel_ids:      Array.from({ length: 6 }, (_, i) => `${id}-panel-${i + 1}`),
      protrusion_ids: [],
      detected_mode:  'thin_solid',
      rollbackToken:  snap(),
    })),
    validateSheetMetal: vi.fn(() => ({
      is_valid: true,
      nominal_thickness: 1.5,
      can_flatten: true,
      validation_errors: [],
    })),
    getPanelFrame: vi.fn((_id: string) => ({
      originX: 0, originY: 0, originZ: 0,
      uX: 1, uY: 0, uZ: 0,
      vX: 0, vY: 1, vZ: 0,
      normalX: 0, normalY: 0, normalZ: 1,
      uExtentMm: 200, vExtentMm: 200, thicknessMm: 1.0,
    })),
    computeBoundingBox: vi.fn(() => ({
      x_min: 0, y_min: 0, z_min: 0,
      x_max: 200, y_max: 200, z_max: 1,
    })),
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(__dirname, '../../config/config.yaml');
const config = loadConfig(CONFIG_PATH);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Cube Box Sheet Metal Workflow', () => {
  let mock: ReturnType<typeof buildMockAddon>;

  beforeEach(() => {
    mock = buildMockAddon();
    setGeometryBindingMock(mock);
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    resetMcpGraphStateForTests();
    vi.restoreAllMocks();
  });

  // ── Main scenario ────────────────────────────────────────────────────────────

  it('decomposes a 200 mm hollow cube into panels, adjusts geometry, merges into L-assemblies, and adds flanges', async () => {

    // ── Phase 1: Split the cube body into four panels ─────────────────────────
    //
    //  cube-solid
    //    ├─ cut at z=199mm → top-panel (pos) + lower-body (neg)
    //    └─ lower-body
    //         ├─ cut at y=1mm  → front-panel (pos) + mid-body (neg)
    //         └─ mid-body
    //              ├─ cut at y=199mm → back-panel (pos) + bottom-panel (neg)
    //
    // Four panels: top, front, back, bottom.

    type SplitResult = { positive_shell_id: string; negative_shell_id: string; rollback_token: string };

    const cut1 = await dispatchTool('split_body_by_plane', {
      part_id: 'cube-solid',
      cutting_plane: { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 199 } },
      output_names: ['top-panel', 'lower-body'],
    }, config) as SplitResult;

    expect(cut1.positive_shell_id).toBe('cube-solid-pos');
    expect(cut1.negative_shell_id).toBe('cube-solid-neg');
    expect(cut1.rollback_token).toMatch(/^snap-\d+$/);

    const topPanel  = cut1.positive_shell_id;  // 'cube-solid-pos'
    const lowerBody = cut1.negative_shell_id;  // 'cube-solid-neg'

    const cut2 = await dispatchTool('split_body_by_plane', {
      part_id: lowerBody,
      cutting_plane: { normal: { x: 0, y: 1, z: 0 }, origin: { x: 0, y: 1, z: 0 } },
      output_names: ['front-panel', 'mid-body'],
    }, config) as SplitResult;

    const frontPanel = cut2.positive_shell_id;  // 'cube-solid-neg-pos'
    const midBody    = cut2.negative_shell_id;  // 'cube-solid-neg-neg'

    const cut3 = await dispatchTool('split_body_by_plane', {
      part_id: midBody,
      cutting_plane: { normal: { x: 0, y: 1, z: 0 }, origin: { x: 0, y: 199, z: 0 } },
      output_names: ['back-panel', 'bottom-panel'],
    }, config) as SplitResult;

    const backPanel   = cut3.positive_shell_id;  // 'cube-solid-neg-neg-pos'
    const bottomPanel = cut3.negative_shell_id;  // 'cube-solid-neg-neg-neg'

    expect(mock.splitBodyByPlane).toHaveBeenCalledTimes(3);
    // Verify the binding received the cutting planes correctly
    expect(mock.splitBodyByPlane).toHaveBeenNthCalledWith(
      1,
      'cube-solid',
      { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 199 } },
    );

    // ── Phase 2: Recess inner faces by 1 mm to remove panel overlap ───────────

    type OffsetResult = { modified_shell_id: string; rollback_token: string };

    const recessTop = await dispatchTool('offset_face', {
      part_id: topPanel,
      face_id: 'f-inner',
      distance: -1,
    }, config) as OffsetResult;
    expect(recessTop.modified_shell_id).toBe(topPanel);

    const recessFront = await dispatchTool('offset_face', {
      part_id: frontPanel,
      face_id: 'f-inner',
      distance: -1,
    }, config) as OffsetResult;
    expect(recessFront.modified_shell_id).toBe(frontPanel);

    expect(mock.offsetFace).toHaveBeenCalledTimes(2);
    expect(mock.offsetFace).toHaveBeenCalledWith(topPanel,   'f-inner', -1);
    expect(mock.offsetFace).toHaveBeenCalledWith(frontPanel, 'f-inner', -1);

    // ── Phase 3: Logistics compliance check ───────────────────────────────────
    //
    // A 200 × 200 mm panel (sqrt(40000) = 200 mm) must fit within the
    // configured shipping envelope (2400 × 1200 × 800 mm).

    type ComplianceResult = {
      compliant: boolean;
      envelope_type: string;
      violations: string[];
      checked_dimensions: { length_mm: number; width_mm: number; height_mm: number };
    };

    const compliance = await dispatchTool('check_boundary_compliance', {
      part_id: topPanel,
      envelope_type: 'shipping',
    }, config) as ComplianceResult;

    expect(compliance.compliant).toBe(true);
    expect(compliance.violations).toHaveLength(0);
    expect(compliance.envelope_type).toBe('shipping');
    // Approximate dimension from face area: sqrt(40000) ≈ 200 mm
    expect(compliance.checked_dimensions.length_mm).toBeCloseTo(200, 0);
    expect(mock.getTopology).toHaveBeenCalledWith(topPanel);

    // ── Phase 4: Detect gap between top and front panels ─────────────────────

    type GapResult = {
      has_gap: boolean;
      minimum_distance_mm: number;
      closest_elements: { part_a_face_id: string; part_b_face_id: string };
      extension_vector: { x: number; y: number; z: number };
    };

    const gap = await dispatchTool('compute_gaps', {
      part_a_id: topPanel,
      part_b_id: frontPanel,
      max_distance_threshold_mm: 5,
    }, config) as GapResult;

    expect(gap.has_gap).toBe(true);
    expect(gap.minimum_distance_mm).toBeCloseTo(2.0);
    expect(gap.closest_elements.part_a_face_id).toBe('f-e1');
    expect(gap.closest_elements.part_b_face_id).toBe('f-e2');
    expect(mock.computeGaps).toHaveBeenCalledWith(topPanel, frontPanel, 5);

    // ── Phase 5: Extend top panel edge to close the gap ──────────────────────

    type ExtendResult = { modified_shell_id: string; extension_distance_mm: number; rollback_token: string };

    const extended = await dispatchTool('extend_face_to_target', {
      part_id:     topPanel,
      face_id:     'f-e1',
      target_type: 'face_id',
      target: {
        part_id: frontPanel,
        face_id: 'f-e2',
      },
    }, config) as ExtendResult;

    expect(extended.modified_shell_id).toBe(topPanel);
    expect(extended.extension_distance_mm).toBeCloseTo(2.0);
    expect(extended.rollback_token).toMatch(/^snap-\d+$/);
    expect(mock.extendFaceToTarget).toHaveBeenCalledWith(
      topPanel, 'f-e1', 'face_id', frontPanel, 'f-e2',
      { normal: { x: -1, y: 0, z: 0 }, origin: { x: 0, y: 0, z: 0 } },
    );

    // ── Phase 6: Verify no volumetric clashes across all four panels ──────────

    type ClashResult = { intersects: boolean; clashes: unknown[] };

    const clashReport = await dispatchTool('compute_intersections', {
      part_ids: [topPanel, frontPanel, backPanel, bottomPanel],
    }, config) as ClashResult;

    expect(clashReport.intersects).toBe(false);
    expect(clashReport.clashes).toHaveLength(0);
    expect(mock.computeIntersections).toHaveBeenCalledWith(
      [topPanel, frontPanel, backPanel, bottomPanel],
    );

    // ── Phase 7: Merge adjacent panels into two L-shaped assemblies ───────────

    type MergeResult = { merged_shell_id: string; rollback_token: string };

    // Register test parts with manufacturing graphs to satisfy prerequisite checks.
    // A minimal closed LWPOLYLINE DXF is required for the merge shapeDxf guard.
    const panelDxf = '0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0.0\n20\n0.0\n10\n200.0\n20\n0.0\n10\n200.0\n20\n200.0\n10\n0.0\n20\n200.0\n0\nENDSEC\n0\nEOF';
    registerTestPart(topPanel, [topPanel], panelDxf);
    registerTestPart(frontPanel, [frontPanel], panelDxf);
    registerTestPart(bottomPanel, [bottomPanel], panelDxf);
    registerTestPart(backPanel, [backPanel], panelDxf);

    const topFront = await dispatchTool('merge_bodies_with_bend', {
      part_a_id:    topPanel,
      part_b_id:    frontPanel,
      target_edges: ['e-boundary-3'],
      bend_radius:  1.5,
    }, config) as MergeResult;

    expect(topFront.merged_shell_id).toBe(`merged(${topPanel}+${frontPanel})`);
    expect(topFront.rollback_token).toMatch(/^snap-\d+$/);

    const bottomBack = await dispatchTool('merge_bodies_with_bend', {
      part_a_id:    bottomPanel,
      part_b_id:    backPanel,
      target_edges: ['e-boundary-1'],
      bend_radius:  1.5,
    }, config) as MergeResult;

    expect(bottomBack.merged_shell_id).toBe(`merged(${bottomPanel}+${backPanel})`);
    expect(mock.mergeBodiesWithBend).toHaveBeenCalledTimes(2);
    expect(mock.mergeBodiesWithBend).toHaveBeenCalledWith(
      topPanel, frontPanel, ['e-boundary-3'], 1.5,
    );

    // ── Phase 8: Add 15 mm return flanges to open edges ───────────────────────

    type FlangeResult = { modified_shell_id: string; flange_feature_id: string; rollback_token: string };

    const flangeA = await dispatchTool('add_flange', {
      part_id:     topFront.merged_shell_id,
      edge_id:     'e-boundary-2',
      length:      15,
      angle:       90,
      bend_radius: 1.0,
    }, config) as FlangeResult;

    expect(flangeA.modified_shell_id).toBe(topFront.merged_shell_id);
    expect(flangeA.flange_feature_id).toContain('flange(');
    expect(flangeA.rollback_token).toMatch(/^snap-\d+$/);

    const flangeB = await dispatchTool('add_flange', {
      part_id:     bottomBack.merged_shell_id,
      edge_id:     'e-boundary-4',
      length:      15,
      angle:       90,
      bend_radius: 1.0,
    }, config) as FlangeResult;

    expect(flangeB.modified_shell_id).toBe(bottomBack.merged_shell_id);
    expect(mock.addFlange).toHaveBeenCalledTimes(2);
    expect(mock.addFlange).toHaveBeenCalledWith(
      topFront.merged_shell_id, 'e-boundary-2', 15, 90, 1.0,
    );

    // ── Phase 9: Rip interior seam edge to enable flat-pattern unfold ─────────

    type RipResult = { modified_shell_id: string; rollback_token: string };

    const ripped = await dispatchTool('rip_edge', {
      part_id: topFront.merged_shell_id,
      edge_id: 'e-interior-1',
    }, config) as RipResult;

    expect(ripped.modified_shell_id).toBe(topFront.merged_shell_id);
    expect(ripped.rollback_token).toMatch(/^snap-\d+$/);
    expect(mock.ripEdge).toHaveBeenCalledWith(topFront.merged_shell_id, 'e-interior-1');

    // ── Phase 10: Trim bottom-back assembly to remove overhanging material ─────

    type TrimResult = { trimmed_shell_id: string; rollback_token: string };

    const trimmed = await dispatchTool('trim_body_with_plane', {
      part_id:           bottomBack.merged_shell_id,
      plane:             { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 1 } },
      keep_positive_side: true,
    }, config) as TrimResult;

    expect(trimmed.trimmed_shell_id).toBe(bottomBack.merged_shell_id);
    expect(trimmed.rollback_token).toMatch(/^snap-\d+$/);
    expect(mock.trimBodyWithPlane).toHaveBeenCalledTimes(1);

    // ── Summary: confirm all ten new tools were exercised ─────────────────────

    expect(mock.splitBodyByPlane).toHaveBeenCalledTimes(3);
    expect(mock.offsetFace).toHaveBeenCalledTimes(2);
    // 1 explicit compute_gaps call (Phase 4) + 2 internal calls from merge edge-alignment checks
    expect(mock.computeGaps).toHaveBeenCalledTimes(3);
    expect(mock.extendFaceToTarget).toHaveBeenCalledTimes(1);
    expect(mock.computeIntersections).toHaveBeenCalledTimes(1);
    expect(mock.mergeBodiesWithBend).toHaveBeenCalledTimes(2);
    expect(mock.addFlange).toHaveBeenCalledTimes(2);
    expect(mock.ripEdge).toHaveBeenCalledTimes(1);
    expect(mock.trimBodyWithPlane).toHaveBeenCalledTimes(1);
    // 1 from check_boundary_compliance + 1 from extend_face_to_target (target_type: 'face_id')
    expect(mock.getTopology).toHaveBeenCalledTimes(2);
  });

  // ── Edge case: compliance failure ─────────────────────────────────────────────

  it('check_boundary_compliance reports violations for an oversized panel', async () => {
    // Return a face so large that sqrt(areaMm2) > all envelope limits
    (mock.getTopology as ReturnType<typeof vi.fn>).mockReturnValue({
      solidId: 'big-panel',
      faces: [
        { faceId: 'f-big', surfaceType: 'plane', areaMm2: 36_000_000,
          normalX: 0, normalY: 0, normalZ: 1 },   // sqrt = 6000 mm
      ],
      edges: [],
      adjacency: [],
    });

    type ComplianceResult = {
      compliant: boolean;
      violations: string[];
      checked_dimensions: { length_mm: number };
    };

    const result = await dispatchTool('check_boundary_compliance', {
      part_id:       'big-panel',
      envelope_type: 'shipping',
    }, config) as ComplianceResult;

    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    // 6000 mm >> 2400 mm shipping envelope
    expect(result.checked_dimensions.length_mm).toBeCloseTo(6000, 0);
  });

  // ── Edge case: zero-distance offset rejected ───────────────────────────────────

  it('offset_face rejects zero distance', async () => {
    await expect(
      dispatchTool('offset_face', {
        part_id:  'some-shell',
        face_id:  'f-outer',
        distance: 0,
      }, config),
    ).rejects.toMatchObject({ code: 'GE_OFFSET_FAILED' });
  });

  // ── Edge case: split_body_by_plane requires a valid cutting_plane ─────────────

  it('split_body_by_plane rejects missing cutting_plane', async () => {
    await expect(
      dispatchTool('split_body_by_plane', {
        part_id:      'some-shell',
        output_names: ['a', 'b'],
        // cutting_plane intentionally omitted
      }, config),
    ).rejects.toBeDefined();
  });

  // ── Edge case: compute_intersections requires at least two parts ──────────────

  it('compute_intersections rejects a single-part array', async () => {
    await expect(
      dispatchTool('compute_intersections', {
        part_ids: ['only-one'],
      }, config),
    ).rejects.toMatchObject({ code: 'GE_CLASH_DETECTION_FAILED' });
  });

  // ── Edge case: merge_bodies_with_bend requires a positive bend_radius ─────────

  it('merge_bodies_with_bend rejects zero bend radius', async () => {
    await expect(
      dispatchTool('merge_bodies_with_bend', {
        part_a_id:    'shell-a',
        part_b_id:    'shell-b',
        target_edges: ['e-1'],
        bend_radius:  0,
      }, config),
    ).rejects.toMatchObject({ code: 'GE_MERGE_FAILED' });
  });

  // ── Edge case: add_flange rejects angle outside (0, 180] ─────────────────────

  it('add_flange rejects angle of 0', async () => {
    await expect(
      dispatchTool('add_flange', {
        part_id:     'shell-a',
        edge_id:     'e-boundary-1',
        length:      10,
        angle:       0,
        bend_radius: 1.0,
      }, config),
    ).rejects.toMatchObject({ code: 'GE_FLANGE_FAILED' });
  });

  // ── split_body_by_bends: dispatches to C++ and returns panel IDs with mesh URLs ──

  it('split_body_by_bends decomposes a closed cube into 6 flat panels', async () => {
    type BendsResult = {
      panel_ids: string[];
      panel_count: number;
      protrusion_ids: string[];
      protrusion_count: number;
      detected_mode: string;
      rollback_token: string;
      mesh_urls: string[];
    };

    const result = await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
    }, config) as BendsResult;

    expect(result.panel_count).toBe(6);
    expect(result.panel_ids).toHaveLength(6);
    expect(result.panel_ids[0]).toBe('cube-solid-panel-1');
    expect(result.panel_ids[5]).toBe('cube-solid-panel-6');
    expect(result.protrusion_count).toBe(0);
    expect(result.protrusion_ids).toHaveLength(0);
    expect(result.detected_mode).toBe('thin_solid');
    expect(result.rollback_token).toMatch(/^snap-\d+$/);
    expect(result.mesh_urls[0]).toMatch(/\/mesh\/cube-solid-panel-1\.glb$/);
    expect(mock.splitBodyByBends).toHaveBeenCalledWith('cube-solid', 1.0, 5.0, 1.0, 1);
  });

  // ── split_body_by_bends: surface mode returns detected_mode 'surface' ─────────

  it('split_body_by_bends in surface mode extrudes panels by default_thickness_mm', async () => {
    type BendsResult = {
      panel_ids: string[];
      panel_count: number;
      protrusion_ids: string[];
      protrusion_count: number;
      detected_mode: string;
      rollback_token: string;
      mesh_urls: string[];
    };

    // Override just the next call to return surface-mode result
    vi.mocked(mock.splitBodyByBends).mockReturnValueOnce({
      panel_ids:      Array.from({ length: 6 }, (_, i) => `surface-solid-panel-${i + 1}`),
      protrusion_ids: [],
      detected_mode:  'surface',
      rollbackToken:  'snap-surface',
    });

    const result = await dispatchTool('split_body_by_bends', {
      part_id: 'surface-solid',
      default_thickness_mm: 2.0,
    }, config) as BendsResult;

    expect(result.detected_mode).toBe('surface');
    expect(result.panel_count).toBe(6);
    expect(result.panel_ids).toHaveLength(6);
    expect(result.panel_ids[0]).toBe('surface-solid-panel-1');
    expect(result.protrusion_count).toBe(0);
    expect(result.rollback_token).toBe('snap-surface');
    expect(result.mesh_urls[0]).toMatch(/\/mesh\/surface-solid-panel-1\.glb$/);
    // Verify defaultThicknessMm was forwarded to the binding
    expect(mock.splitBodyByBends).toHaveBeenCalledWith('surface-solid', 1.0, 5.0, 2.0, 1);
  });

  // ── split_body_by_bends: protrusions returned separately ─────────────────────

  it('split_body_by_bends returns protrusions separately from panels', async () => {
    type BendsResult = {
      panel_ids: string[];
      panel_count: number;
      protrusion_ids: string[];
      protrusion_count: number;
      detected_mode: string;
      rollback_token: string;
      mesh_urls: string[];
    };

    vi.mocked(mock.splitBodyByBends).mockReturnValueOnce({
      panel_ids:      ['flanged-solid-panel-1', 'flanged-solid-panel-2',
                       'flanged-solid-panel-3', 'flanged-solid-panel-4',
                       'flanged-solid-panel-5', 'flanged-solid-panel-6'],
      protrusion_ids: ['flange-1', 'flange-2'],
      detected_mode:  'thin_solid',
      rollbackToken:  'snap-flanged',
    });

    const result = await dispatchTool('split_body_by_bends', {
      part_id: 'flanged-solid',
    }, config) as BendsResult;

    expect(result.panel_count).toBe(6);
    expect(result.protrusion_count).toBe(2);
    expect(result.protrusion_ids).toEqual(['flange-1', 'flange-2']);
    expect(result.detected_mode).toBe('thin_solid');
    // mesh_urls covers both panels and protrusions
    expect(result.mesh_urls).toHaveLength(8);
    expect(result.mesh_urls.some(u => u.includes('flange-1'))).toBe(true);
    expect(result.mesh_urls.some(u => u.includes('flange-2'))).toBe(true);
  });

  // ── split_body_by_bends: recursive decomposition accumulates all IDs ─────────

  it('split_body_by_bends with max_recursion_depth accumulates panels from all levels', async () => {
    type BendsResult = {
      panel_ids: string[];
      panel_count: number;
      protrusion_ids: string[];
      protrusion_count: number;
      detected_mode: string;
      rollback_token: string;
      mesh_urls: string[];
    };

    // Simulate a deeply-nested solid: 12 outer panels + 8 protrusions (flanges + inner cube)
    vi.mocked(mock.splitBodyByBends).mockReturnValueOnce({
      panel_ids:      Array.from({ length: 12 }, (_, i) => `nested-panel-${i + 1}`),
      protrusion_ids: Array.from({ length: 8 },  (_, i) => `nested-protrusion-${i + 1}`),
      detected_mode:  'thin_solid',
      rollbackToken:  'snap-nested',
    });

    const result = await dispatchTool('split_body_by_bends', {
      part_id: 'nested-solid',
      max_recursion_depth: 5,
    }, config) as BendsResult;

    expect(result.panel_count).toBe(12);
    expect(result.protrusion_count).toBe(8);
    expect(result.panel_ids).toHaveLength(12);
    expect(result.protrusion_ids).toHaveLength(8);
    // All 20 IDs appear in mesh_urls
    expect(result.mesh_urls).toHaveLength(20);
    // max_recursion_depth is clamped to 0–10 and forwarded
    expect(mock.splitBodyByBends).toHaveBeenCalledWith('nested-solid', 1.0, 5.0, 1.0, 5);
  });

  // ── split_body_by_bends: max_recursion_depth=0 is backward-compatible ────────

  it('split_body_by_bends with max_recursion_depth=0 returns only first-pass panels', async () => {
    const result = await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
      max_recursion_depth: 0,
    }, config) as any;

    // Default mock returns 6 panels, 0 protrusions — unchanged from single-pass behaviour
    expect(result.panel_count).toBe(6);
    expect(result.protrusion_count).toBe(0);
    expect(mock.splitBodyByBends).toHaveBeenCalledWith('cube-solid', 1.0, 5.0, 1.0, 0);
  });

  // ── split_body_by_bends: negative threshold rejected ─────────────────────────

  it('split_body_by_bends rejects a negative angle_threshold_deg', async () => {
    await expect(
      dispatchTool('split_body_by_bends', { part_id: 'some-shell', angle_threshold_deg: -1 }, config),
    ).rejects.toMatchObject({ code: 'GE_DECOMPOSE_BY_BENDS_FAILED' });
  });
});
