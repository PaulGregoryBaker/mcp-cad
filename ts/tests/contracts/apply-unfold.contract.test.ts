/**
 * Contract test: apply_unfold tool output schema.
 * Asserts apply_unfold returns required fields with correct types.
 *
 * Task: T150
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GeometryAddon } from '../../src/geometry/binding';
import { GeometryBinding, kerfOffsetMm } from '../../src/geometry/binding';
import { dispatchTool, setGeometryBindingMock } from '../../src/mcp/tools';
import type { ManufacturingConfig } from '../../src/config/loader';

// ─── Mock addon ───────────────────────────────────────────────────────────────

const mockAddon: GeometryAddon = {
  loadStep: vi.fn(() => 'solid-1'),
  getTopology: vi.fn(() => ({
    solidId: 'solid-1',
    faces: [{ faceId: 'f1', surfaceType: 'plane' as const, areaMm2: 100, normalX: 0, normalY: 0, normalZ: 1 }],
    edges: [],
    adjacency: [],
  })),
  checkManifold: vi.fn(() => ({ isManifold: true, issues: [] })),
  healGeometry: vi.fn(() => 'solid-healed'),
  booleanCut: vi.fn(() => ({ shellIds: ['shell-1'], rollbackToken: 'tok-1' })),
  addTabSlot: vi.fn(() => ({ modifiedShellIds: ['shell-1', 'shell-2'], kerfOffsetApplied: 0.15, rollbackToken: 'tok-2' })),
  addRivetHole: vi.fn(() => ({ modifiedShellId: 'shell-1', holeFeatureId: 'hole-1', rollbackToken: 'tok-3' })),
  unfoldShell: vi.fn((_shellId: string, kFactor: number) => ({
    unfoldId: 'unfold-abc123',
    flatWidthMm: 250.0,
    flatHeightMm: 180.0,
    kFactorUsed: kFactor,
    bendCount: 2,
    rollbackToken: 'tok-4',
  })),
  exportDxf: vi.fn(() => ({ dxfContent: 'DXF...', wireCount: 4, widthMm: 250.0, heightMm: 180.0 })),
  addCornerRelief: vi.fn(() => 'shell-relief-1'),
  nestShells: vi.fn(() => ({
    nestId: 'nest-1',
    placements: [],
    utilisationPct: 75.0,
    sheetsRequired: 1,
  })),
  createSnapshot: vi.fn(() => 'snap-1'),
  restoreSnapshot: vi.fn(() => ({ restoredSolidIds: [], restoredShellIds: [], snapshotId: 'snap-1' })),
  clearSnapshots: vi.fn(() => undefined),
  extractFeatures: vi.fn(() => ({
    shellId: 'shell-1',
    bends: [],
    holes: [],
    flanges: [],
    reliefs: [],
  })),
};

// ─── Test config ─────────────────────────────────────────────────────────────

const config: ManufacturingConfig = {
  materials: [{
    id: 'mild_steel_1.5mm',
    name: 'Mild Steel',
    thicknessMm: 1.5,
    kFactor: 0.33,
    yieldStrengthMpa: 250,
    grainDirection: 'any',
    inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
  }],
  tooling: {
    pressBrake: { maxTonnage: 500, maxBendLengthMm: 2500, vDieWidthsMm: [6, 8], punchRadiiMm: [0.5, 1.0] },
    laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 23,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

// ─── apply_unfold schema contract ─────────────────────────────────────────────

describe('apply_unfold: output schema contract', () => {
  let binding: GeometryBinding;

  beforeEach(() => {
    binding = new GeometryBinding(mockAddon);
    setGeometryBindingMock(binding);
    // Register a shell in the session so apply_unfold doesn't throw SHELL_NOT_FOUND
    binding.booleanCut('solid-1', { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 });
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
  });

  it('result has required fields: unfold_id, flat_width_mm, flat_height_mm, k_factor_used, bend_count', async () => {
    const result = await dispatchTool(
      'apply_unfold',
      { panel_id: 'shell-1', material_id: 'mild_steel_1.5mm' },
      config,
    ) as Record<string, unknown>;

    expect(typeof result['unfold_id']).toBe('string');
    expect(typeof result['flat_width_mm']).toBe('number');
    expect(typeof result['flat_height_mm']).toBe('number');
    expect(typeof result['k_factor_used']).toBe('number');
    expect(typeof result['bend_count']).toBe('number');
  });

  it('k_factor_used reflects material default when not overridden', async () => {
    const result = await dispatchTool(
      'apply_unfold',
      { panel_id: 'shell-1', material_id: 'mild_steel_1.5mm' },
      config,
    ) as Record<string, unknown>;

    expect(result['k_factor_used']).toBe(0.33);
  });

  it('k_factor_used respects override when provided', async () => {
    const result = await dispatchTool(
      'apply_unfold',
      { panel_id: 'shell-1', material_id: 'mild_steel_1.5mm', k_factor: 0.42 },
      config,
    ) as Record<string, unknown>;

    expect(result['k_factor_used']).toBe(0.42);
  });

  it('throws structured error for unknown material_id', async () => {
    await expect(
      dispatchTool(
        'apply_unfold',
        { panel_id: 'shell-1', material_id: 'unknown_material' },
        config,
      ),
    ).rejects.toMatchObject({ code: 'MD_MATERIAL_NOT_FOUND' });
  });

  it('includes rollback_token in response', async () => {
    const result = await dispatchTool(
      'apply_unfold',
      { panel_id: 'shell-1', material_id: 'mild_steel_1.5mm' },
      config,
    ) as Record<string, unknown>;

    expect(typeof result['rollback_token']).toBe('string');
  });
});

// ─── apply_unfold error model ──────────────────────────────────────────────────

describe('apply_unfold: error model contract', () => {
  it('throws McpToolError with code when panel_id is missing', async () => {
    await expect(
      dispatchTool(
        'apply_unfold',
        { material_id: 'mild_steel_1.5mm' },
        config,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('throws McpToolError with code when material_id is missing', async () => {
    await expect(
      dispatchTool(
        'apply_unfold',
        { panel_id: 'shell-1' },
        config,
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
