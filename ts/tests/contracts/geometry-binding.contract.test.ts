/**
 * TypeScript contract test: NAPI wrapper (GeometryBinding).
 * Asserts wrapper enforces kerf range and error conversion.
 *
 * Task: T140
 */

import { describe, it, expect, vi } from 'vitest';
import type { GeometryAddon } from '../../src/geometry/binding';
import { GeometryBinding, kerfOffsetMm } from '../../src/geometry/binding';

// ─── Mock addon for testing ───────────────────────────────────────────────────

const mockAddon: GeometryAddon = {
  loadStep: vi.fn((filePath: string) => 'solid-uuid'),
  getTopology: vi.fn((solidId: string) => ({
    solidId: 'solid-uuid',
    faces: [{ faceId: 'f1', surfaceType: 'plane', areaMm2: 100, normalX: 0, normalY: 0, normalZ: 1 }],
    edges: [],
    adjacency: [],
  })),
  checkManifold: vi.fn((solidId: string) => ({
    isManifold: true,
    issues: [],
  })),
  healGeometry: vi.fn((solidId: string) => 'healed-uuid'),
  booleanCut: vi.fn((solidId: string, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number) => ({
    shellIds: ['shell1'],
    rollbackToken: 'token1',
  })),
  addTabSlot: vi.fn((shellIdA: string, shellIdB: string, kerfMm: number) => ({
    modifiedShellIds: ['shell1', 'shell2'],
    kerfOffsetApplied: kerfMm,
    rollbackToken: 'token2',
  })),
  addRivetHole: vi.fn((shellId: string, faceId: string, cx: number, cy: number, diamMm: number) => ({
    modifiedShellId: shellId,
    holeFeatureId: 'hole1',
    rollbackToken: 'token3',
  })),
  unfoldShell: vi.fn((shellId: string, kFactor: number) => ({
    unfoldId: 'unfold1',
    flatWidthMm: 200,
    flatHeightMm: 300,
    kFactorUsed: kFactor,
    bendCount: 2,
    rollbackToken: 'token4',
  })),
  exportDxf: vi.fn((unfoldId: string) => ({
    dxfContent: 'DXF...',
    wireCount: 4,
    bboxWidthMm: 200,
    bboxHeightMm: 300,
  })),
  nestShells: vi.fn((unfoldIds: string[], sheetW: number, sheetH: number) => ({
    nestId: 'nest1',
    utilisationPct: 85,
    sheetsRequired: 1,
    placements: [
      { unfoldId: 'unfold1', sheetIndex: 0, x: 10, y: 10, rotationDeg: 0 },
    ],
  })),
  createSnapshot: vi.fn((label: string) => 'snapshot-uuid'),
  restoreSnapshot: vi.fn((snapshotId: string) => ({
    restoredSolidIds: ['solid1'],
    restoredShellIds: [],
  })),
  clearSnapshots: vi.fn(() => undefined),
};

// ─── Kerf offset validation ───────────────────────────────────────────────────

describe('GeometryBinding: kerf offset validation', () => {
  it('defines kerf range as [0.1, 0.2] mm', () => {
    expect(kerfOffsetMm.min).toBe(0.1);
    expect(kerfOffsetMm.max).toBe(0.2);
  });

  it('rejects kerf < 0.1 mm', () => {
    const binding = new GeometryBinding(mockAddon);
    expect(() => {
      binding.addTabSlot('shell1', 'shell2', 0.05);
    }).toThrow(/kerf|range|0\.1/i);
  });

  it('rejects kerf > 0.2 mm', () => {
    const binding = new GeometryBinding(mockAddon);
    expect(() => {
      binding.addTabSlot('shell1', 'shell2', 0.25);
    }).toThrow(/kerf|range|0\.2/i);
  });

  it('accepts kerf = 0.1 (boundary)', () => {
    const binding = new GeometryBinding(mockAddon);
    expect(() => {
      binding.addTabSlot('shell1', 'shell2', 0.1);
    }).not.toThrow();
  });

  it('accepts kerf = 0.2 (boundary)', () => {
    const binding = new GeometryBinding(mockAddon);
    expect(() => {
      binding.addTabSlot('shell1', 'shell2', 0.2);
    }).not.toThrow();
  });

  it('accepts kerf = 0.15 (middle)', () => {
    const binding = new GeometryBinding(mockAddon);
    expect(() => {
      binding.addTabSlot('shell1', 'shell2', 0.15);
    }).not.toThrow();
  });
});

// ─── Error conversion ─────────────────────────────────────────────────────────

describe('GeometryBinding: NAPI error conversion', () => {
  it('wraps addon errors with toStructuredError', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      loadStep: vi.fn(() => {
        throw new Error('{"code":"GE_IMPORT_FAILED","message":"Bad file"}');
      }),
    };

    const binding = new GeometryBinding(failingAddon);
    expect(() => {
      binding.loadStep('/fake.stp');
    }).toThrow();
  });

  it('converts plain Error to StructuredError in wrapper', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      checkManifold: vi.fn(() => {
        throw new Error('Segfault');
      }),
    };

    const binding = new GeometryBinding(failingAddon);
    expect(() => {
      binding.checkManifold('solid1');
    }).toThrow();
  });
});

// ─── Pass-through behavior ───────────────────────────────────────────────────

describe('GeometryBinding: wrapper pass-through correctness', () => {
  it('loadStep returns addon result unchanged', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.loadStep('/path/file.stp');
    expect(result).toBe('solid-uuid');
    expect(mockAddon.loadStep).toHaveBeenCalledWith('/path/file.stp');
  });

  it('addTabSlot passes all args to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    binding.addTabSlot('shellA', 'shellB', 0.15);
    expect(mockAddon.addTabSlot).toHaveBeenCalledWith('shellA', 'shellB', 0.15);
  });

  it('unfoldShell returns addon result with kFactor preserved', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.unfoldShell('shell1', 0.45);
    expect(result.kFactorUsed).toBe(0.45);
  });
});

// ─── Snapshot lifecycle ───────────────────────────────────────────────────────

describe('GeometryBinding: snapshot methods', () => {
  it('createSnapshot forwards label to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    binding.createSnapshot('my-state');
    expect(mockAddon.createSnapshot).toHaveBeenCalledWith('my-state');
  });

  it('restoreSnapshot forwards snapshot ID to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    binding.restoreSnapshot('snap-uuid');
    expect(mockAddon.restoreSnapshot).toHaveBeenCalledWith('snap-uuid');
  });

  it('clearSnapshots calls addon clearSnapshots', () => {
    const binding = new GeometryBinding(mockAddon);
    binding.clearSnapshots();
    expect(mockAddon.clearSnapshots).toHaveBeenCalled();
  });
});

// ─── Additional wrapper method coverage ──────────────────────────────────────

describe('GeometryBinding: remaining wrapper methods and error paths', () => {
  it('healGeometry forwards to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.healGeometry('solid-uuid');
    expect(result).toBe('healed-uuid');
    expect(mockAddon.healGeometry).toHaveBeenCalledWith('solid-uuid');
  });

  it('addRivetHole forwards all args to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.addRivetHole('shell1', 'faceA', 1.25, 2.5, 4.0);
    expect(result.modifiedShellId).toBe('shell1');
    expect(mockAddon.addRivetHole).toHaveBeenCalledWith('shell1', 'faceA', 1.25, 2.5, 4.0);
  });

  it('exportDxf forwards to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.exportDxf('unfold1');
    expect(result.wireCount).toBe(4);
    expect(mockAddon.exportDxf).toHaveBeenCalledWith('unfold1');
  });

  it('nestShells forwards to addon', () => {
    const binding = new GeometryBinding(mockAddon);
    const result = binding.nestShells(['u1', 'u2'], 1000, 500);
    expect(result.nestId).toBe('nest1');
    expect(mockAddon.nestShells).toHaveBeenCalledWith(['u1', 'u2'], 1000, 500);
  });

  it('healGeometry converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      healGeometry: vi.fn(() => {
        throw new Error('{"code":"GE_HEAL_FAILED","message":"heal failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.healGeometry('solid1')).toThrow(/GE_HEAL_FAILED|heal failed/);
  });

  it('addRivetHole converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      addRivetHole: vi.fn(() => {
        throw new Error('{"code":"GE_TAB_SLOT_FAILED","message":"rivet failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.addRivetHole('s', 'f', 0, 0, 4)).toThrow(/failed|GE_TAB_SLOT_FAILED/i);
  });

  it('unfoldShell converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      unfoldShell: vi.fn(() => {
        throw new Error('{"code":"GE_UNFOLD_FAILED","message":"unfold failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.unfoldShell('shell1', 0.33)).toThrow(/GE_UNFOLD_FAILED|unfold failed/);
  });

  it('exportDxf converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      exportDxf: vi.fn(() => {
        throw new Error('{"code":"GE_NEST_FAILED","message":"export failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.exportDxf('unfold1')).toThrow(/failed|GE_NEST_FAILED/i);
  });

  it('nestShells converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      nestShells: vi.fn(() => {
        throw new Error('{"code":"GE_NEST_FAILED","message":"nest failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.nestShells(['u1'], 100, 100)).toThrow(/GE_NEST_FAILED|nest failed/);
  });

  it('createSnapshot converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      createSnapshot: vi.fn(() => {
        throw new Error('{"code":"GE_RESTORE_FAILED","message":"snapshot failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.createSnapshot('x')).toThrow(/GE_RESTORE_FAILED|snapshot failed/);
  });

  it('restoreSnapshot converts addon errors to structured errors', () => {
    const failingAddon: GeometryAddon = {
      ...mockAddon,
      restoreSnapshot: vi.fn(() => {
        throw new Error('{"code":"GE_RESTORE_FAILED","message":"restore failed"}');
      }),
    };
    const binding = new GeometryBinding(failingAddon);
    expect(() => binding.restoreSnapshot('snap-1')).toThrow(/GE_RESTORE_FAILED|restore failed/);
  });
});
