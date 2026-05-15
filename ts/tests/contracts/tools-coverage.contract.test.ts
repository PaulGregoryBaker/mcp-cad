import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ManufacturingConfig } from '../../src/config/loader';
import type { GeometryAddon } from '../../src/geometry/binding';
import { GeometryBinding } from '../../src/geometry/binding';
import { dispatchTool, setGeometryBindingMock } from '../../src/mcp/tools';
import { session } from '../../src/geometry/session';

const config: ManufacturingConfig = {
  materials: [
    {
      id: 'mild_steel_1.5mm',
      name: 'Mild Steel',
      thicknessMm: 1.5,
      kFactor: 0.33,
      yieldStrengthMpa: 250,
      grainDirection: 'any',
      inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
    },
  ],
  tooling: {
    pressBrake: {
      maxTonnage: 500,
      maxBendLengthMm: 2500,
      vDieWidthsMm: [6, 8],
      punchRadiiMm: [0.5, 1.0],
    },
    laser: {
      maxKerfWidthMm: 0.15,
      minHoleDiameterMm: 1.5,
    },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 23,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

function makeAddon(overrides: Partial<GeometryAddon> = {}): GeometryAddon {
  return {
    loadStep: vi.fn(() => 'solid-1'),
    getTopology: vi.fn(() => ({
      solidId: 'solid-1',
      faces: [{ faceId: 'f1', surfaceType: 'plane' as const, areaMm2: 100, normalX: 0, normalY: 0, normalZ: 1 }],
      edges: [],
      adjacency: [],
      bends: [],
      holes: [],
      flanges: [],
    })),
    checkManifold: vi.fn(() => ({ isManifold: true, issues: [] })),
    healGeometry: vi.fn(() => 'solid-healed'),
    booleanCut: vi.fn(() => ({ shellIds: ['shell-1', 'shell-2'], rollbackToken: 'tok-1' })),
    addTabSlot: vi.fn((_a: string, _b: string, kerf: number) => ({
      modifiedShellIds: ['shell-1', 'shell-2'],
      kerfOffsetApplied: kerf,
      rollbackToken: 'tok-tab',
    })),
    addRivetHole: vi.fn(() => ({ modifiedShellId: 'shell-1', holeFeatureId: 'hole-1', rollbackToken: 'tok-rivet' })),
    unfoldShell: vi.fn((_shell: string, kFactor: number) => ({
      unfoldId: 'unfold-1',
      flatWidthMm: 200,
      flatHeightMm: 120,
      kFactorUsed: kFactor,
      bendCount: 2,
      rollbackToken: 'tok-unfold',
    })),
    exportDxf: vi.fn(() => ({ dxfContent: 'DXF...', wireCount: 4, bboxWidthMm: 200, bboxHeightMm: 120 })),
    nestShells: vi.fn(() => ({
      nestId: 'nest-1',
      utilisationPct: 77,
      sheetsRequired: 1,
      placements: [{ unfoldId: 'unfold-1', sheetIndex: 0, x: 1, y: 2, rotationDeg: 0 }],
    })),
    createSnapshot: vi.fn((label: string) => `snap-${label}`),
    restoreSnapshot: vi.fn((snapshotId: string) => ({ restoredSolidIds: ['solid-1'], restoredShellIds: ['shell-1'], snapshotId })),
    clearSnapshots: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('MCP tools: branch coverage for handlers', () => {
  beforeEach(() => {
    session.reset();
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    session.reset();
  });

  it('covers clean_geometry healing path when manifold check fails', async () => {
    const addon = makeAddon({
      checkManifold: vi.fn(() => ({ isManifold: false, issues: ['non-manifold'] })),
      healGeometry: vi.fn(() => 'solid-healed'),
      getTopology: vi.fn(() => ({
        solidId: 'solid-healed',
        faces: [{ faceId: 'f1', surfaceType: 'plane' as const, areaMm2: 10, normalX: 0, normalY: 0, normalZ: 1 }],
        edges: [],
        adjacency: [],
        bends: [],
        holes: [],
        flanges: [],
      })),
    });
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool('clean_geometry', { file_path: 'fake.stp' }, config) as Record<string, unknown>;
    expect(result['healed']).toBe(true);
    expect(result['solid_id']).toBe('solid-healed');
  });

  it('covers synthesize_joints rivet branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool(
      'synthesize_joints',
      { panel_ids: ['shell-1', 'shell-2'], joint_type: 'rivet' },
      config,
    ) as Record<string, unknown>;

    expect(result['joint_type_applied']).toBe('rivet');
    expect(result['rollback_token']).toBe('tok-rivet');
  });

  it('covers synthesize_joints weld snapshot fallback branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool(
      'synthesize_joints',
      { panel_ids: ['shell-1', 'shell-2'], joint_type: 'weld' },
      config,
    ) as Record<string, unknown>;

    expect(result['joint_type_applied']).toBe('weld');
    expect(typeof result['rollback_token']).toBe('string');
    expect(addon.createSnapshot).toHaveBeenCalled();
  });

  it('covers generate_reliefs success branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool(
      'generate_reliefs',
      { panel_id: 'shell-1', relief_type: 'dogbone', radius_mm: 1.2 },
      config,
    ) as Record<string, unknown>;

    expect(result['modified_panel_id']).toBe('shell-1');
    expect(result['relief_count']).toBe(4);
  });

  it('covers generate_reliefs radius type validation branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    await expect(
      dispatchTool(
        'generate_reliefs',
        { panel_id: 'shell-1', relief_type: 'dogbone', radius_mm: 'bad' as unknown as number },
        config,
      ),
    ).rejects.toThrow(/radius_mm/i);
  });

  it('covers evaluate_manufacturability violation mapping fields', async () => {
    const addon = makeAddon({
      getTopology: vi.fn(() => ({
        solidId: 'shell-1',
        faces: [{ faceId: 'f1', surfaceType: 'plane' as const, areaMm2: 10, normalX: 0, normalY: 0, normalZ: 1 }],
        edges: [],
        adjacency: [],
        bends: [{ featureId: 'b1', angleDeg: 200, radiusMm: 0.1, lengthMm: 10, kFactor: 0.3, bendAllowanceMm: 1, faceIds: ['f1'] }],
        holes: [{ featureId: 'h1', centerX: 0, centerY: 0, diameterMm: 0.5, throughHole: true, faceId: 'f1' }],
        flanges: [{ featureId: 'fl1', widthMm: 1, lengthMm: 9999, adjacentBendId: 'b1', faceId: 'f1' }],
      })),
    });
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool(
      'evaluate_manufacturability',
      { panel_id: 'shell-1', material_id: 'mild_steel_1.5mm' },
      config,
    ) as Record<string, unknown>;

    const violations = result['violations'] as Array<Record<string, unknown>>;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toHaveProperty('rule_code');
    expect(violations[0]).toHaveProperty('severity');
    expect(violations[0]).toHaveProperty('feature_id');
    expect(violations[0]).toHaveProperty('description');
    expect(violations[0]).toHaveProperty('measured_value_mm');
    expect(violations[0]).toHaveProperty('limit_value_mm');
  });

  it('covers validate_bend_sequence mappings for sequence and warnings', async () => {
    const addon = makeAddon({
      getTopology: vi.fn(() => ({
        solidId: 'shell-1',
        faces: [{ faceId: 'f1', surfaceType: 'plane' as const, areaMm2: 10, normalX: 0, normalY: 0, normalZ: 1 }],
        edges: [],
        adjacency: [],
        bends: [
          { featureId: 'b1', angleDeg: 90, radiusMm: 1, lengthMm: 10, kFactor: 0.3, bendAllowanceMm: 1, faceIds: ['fA'] },
          { featureId: 'b2', angleDeg: 45, radiusMm: 1, lengthMm: 10, kFactor: 0.3, bendAllowanceMm: 1, faceIds: ['fB'] },
        ],
        holes: [],
        flanges: [
          { featureId: 'fl1', widthMm: 10, lengthMm: 20, adjacentBendId: 'b1', faceId: 'shared-face' },
          { featureId: 'fl2', widthMm: 10, lengthMm: 20, adjacentBendId: 'b2', faceId: 'shared-face' },
        ],
      })),
    });
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool('validate_bend_sequence', { panel_id: 'shell-1' }, config) as Record<string, unknown>;

    const seq = result['suggested_sequence'] as Array<Record<string, unknown>>;
    const warnings = result['collision_warnings'] as Array<Record<string, unknown>>;
    expect(seq.length).toBeGreaterThan(0);
    expect(seq[0]).toHaveProperty('step_index');
    expect(seq[0]).toHaveProperty('can_parallel');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toHaveProperty('bend_id_a');
    expect(warnings[0]).toHaveProperty('shared_face_id');
  });

  it('covers simulate_nesting missing sheet_size error branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    await expect(
      dispatchTool('simulate_nesting', { unfold_ids: ['u1'] }, config),
    ).rejects.toThrow(/sheet_size/i);
  });

  it('covers requireStringArray empty array error branch', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    await expect(
      dispatchTool(
        'simulate_nesting',
        {
          unfold_ids: [],
          sheet_size: { width_mm: 100, height_mm: 100, label: 's' },
        },
        config,
      ),
    ).rejects.toThrow(/array parameter: unfold_ids/i);
  });

  it('covers generate_reliefs dispatch switch case explicitly', async () => {
    const addon = makeAddon();
    setGeometryBindingMock(new GeometryBinding(addon));

    const result = await dispatchTool(
      'generate_reliefs',
      { panel_id: 'shell-1', relief_type: 'circular' },
      config,
    ) as Record<string, unknown>;

    expect(result['modified_panel_id']).toBe('shell-1');
  });
});
