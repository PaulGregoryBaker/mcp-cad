/**
 * Integration test: explicit transaction primitive (Feature 004).
 *
 * Phase 1 covers the three lifecycle tools (begin_transaction,
 * commit_transaction, rollback_transaction) wrapping the existing snapshot
 * mechanism. No C++ changes; the mocked addon returns deterministic snapshot
 * ids per the existing pattern from cube_box_workflow.functional.test.ts.
 *
 * Phase 2 covers transaction_id acceptance by mutating tools, auto-join
 * behaviour, and TRANSACTION_MISMATCH when a wrong id is supplied.
 *
 * Tasks: T012, T017.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { dispatchTool, setGeometryBindingMock } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import type { GeometryAddon } from '../../src/geometry/binding';
import type { ManufacturingConfig } from '../../src/config/loader';
import { transactionRegistry } from '../../src/mcp/transactions';
import { ErrorCodes, type StructuredError } from '../../src/mcp/errors';

// ─── Mock addon factory ───────────────────────────────────────────────────────

/**
 * Minimal mock for the transaction tests — only the snapshot-related calls
 * matter. Returns sequential snap-N ids so a test can assert which snapshot
 * was created and restored.
 */
function buildMockAddon(): GeometryAddon {
  let snapCount = 0;
  const snap = () => `snap-${++snapCount}`;
  let cleared = false;

  return {
    loadStep:        vi.fn(() => 'cube-solid'),
    getTopology:     vi.fn(() => ({ solidId: 'cube-solid', faces: [], edges: [], adjacency: [] })),
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

    unfoldShell: vi.fn(() => ({
      unfoldId: 'unfold-1', flatWidthMm: 200, flatHeightMm: 200,
      kFactorUsed: 0.42, bendCount: 1, rollbackToken: snap(),
    })),

    exportDxf: vi.fn(() => ({
      dxfContent: '', wireCount: 0, bboxWidthMm: 0, bboxHeightMm: 0,
    })),

    exportGlb: vi.fn(() => Buffer.from('glb')),

    nestShells: vi.fn(() => ({
      nestId: 'nest-1', placements: [], utilisationPct: 0, sheetsRequired: 1,
    })),

    createSnapshot:  vi.fn(() => snap()),
    restoreSnapshot: vi.fn(() => ({ restoredSolidIds: ['cube-solid'], restoredShellIds: [] })),
    clearSnapshots:  vi.fn(() => { cleared = true; }),

    splitBodyByPlane: vi.fn(() => ({
      positiveShellId: 'cube-solid-pos', negativeShellId: 'cube-solid-neg', rollbackToken: snap(),
    })),
    mergeBodiesWithBend: vi.fn((a: string, b: string) => ({
      mergedShellId: `merged(${a}+${b})`, rollbackToken: snap(),
    })),
    extendFaceToTarget: vi.fn((id: string) => ({
      modifiedShellId: id, extensionDistanceMm: 0, rollbackToken: snap(),
    })),
    offsetFace: vi.fn((id: string) => ({ modifiedShellId: id, rollbackToken: snap() })),
    addFlange: vi.fn((id: string) => ({
      modifiedShellId: id, flangeFeatureId: 'flange', rollbackToken: snap(),
    })),
    ripEdge: vi.fn((id: string) => ({ modifiedShellId: id, rollbackToken: snap() })),
    computeIntersections: vi.fn(() => ({ intersects: false, clashes: [] })),
    computeGaps: vi.fn(() => ({
      hasGap: false, minimumDistanceMm: 0,
      closestElements: { partAFaceId: '', partBFaceId: '' },
      extensionVector: { x: 0, y: 0, z: 0 },
      gapBoundingBox: { origin: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } },
    })),
    trimBodyWithPlane: vi.fn((id: string) => ({ trimmedShellId: id, rollbackToken: snap() })),
    addRelief: vi.fn((id: string) => ({ modifiedShellId: id, rollbackToken: snap() })),
    checkBoundaryCompliance: vi.fn(() => ({ envelopeId: 'std', compliant: true, violations: [] })),
    splitBodyByBends: vi.fn(() => ({
      panel_ids: ['p1'], panel_bboxes: [],
      protrusion_ids: [], protrusion_bboxes: [],
      rollbackToken: snap(), detected_mode: 'thin_solid',
      shape_history: [
        { verdict: 'modified',  original_id: 'f1', new_id: 'f1a', operation_label: 'split_body_by_bends' },
        { verdict: 'generated', original_id: 'f2', new_id: 'f2a', operation_label: 'split_body_by_bends' },
        { verdict: 'deleted',   original_id: 'f3', new_id: '',    operation_label: 'split_body_by_bends' },
      ],
    })),
    validateSheetMetal: vi.fn(() => ({
      is_valid: true,
      nominal_thickness: 1.0,
      can_flatten: true,
      validation_errors: [],
    })),

    // Expose `cleared` to tests so they can assert clearSnapshots was called.
    _wasCleared: () => cleared,
  } as unknown as GeometryAddon;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(__dirname, '../../config/config.yaml');
const config: ManufacturingConfig = loadConfig(CONFIG_PATH);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Asserts the dispatchTool call throws a StructuredError with the given code.
 * dispatchTool wraps every throw via toStructuredError, so what reaches the
 * caller is a plain object with `{code, message, recoverable, suggestedTool}`,
 * not an McpToolError instance.
 */
async function expectStructuredError(
  promise: Promise<unknown>,
  code: keyof typeof ErrorCodes,
): Promise<StructuredError> {
  try {
    await promise;
  } catch (err) {
    const structured = err as StructuredError;
    expect(structured.code).toBe(ErrorCodes[code]);
    return structured;
  }
  throw new Error(`Expected ${code} but call resolved`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Transaction primitive (Feature 004 Phase 1)', () => {
  let mock: ReturnType<typeof buildMockAddon>;

  beforeEach(() => {
    mock = buildMockAddon();
    setGeometryBindingMock(mock);
    transactionRegistry.reset();
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    transactionRegistry.reset();
    vi.restoreAllMocks();
  });

  // ── Case (a): full multi-op transaction with rollback ────────────────────────

  it('begin → decompose → synthesise → rollback restores the pre-transaction state', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'test multi-op rollback',
      product: 'cube',
    }, config)) as { transaction_id: string; status: string; rollback_token: string };

    expect(begin.status).toBe('active');
    expect(begin.transaction_id).toMatch(/^transaction:\/\//);
    expect(begin.rollback_token).toBe('snap-1');
    expect(transactionRegistry.getActive()?.id).toBe(begin.transaction_id);

    // First mutating op — decompose_volume calls createSnapshot internally in
    // Phase 1 (suppression is Phase 2). The transaction continues to track its
    // own outer snapshot.
    await dispatchTool('decompose_volume', {
      solid_id: 'cube-solid', strategy: 'Integrity', max_panels: 4,
    }, config);

    // Second mutating op.
    await dispatchTool('synthesize_joints', {
      panel_ids: ['cube-solid-cut-a', 'cube-solid-cut-b'],
      joint_type: 'rivet',
    }, config);

    // Roll back the transaction. Should restore snap-1 (the outer snapshot).
    const rollback = (await dispatchTool('rollback_transaction', {
      transaction_id: begin.transaction_id,
    }, config)) as { transaction_id: string; status: string; restored_solid_ids: string[] };

    expect(rollback.status).toBe('rolled_back');
    expect(rollback.transaction_id).toBe(begin.transaction_id);
    expect(mock.restoreSnapshot).toHaveBeenCalledWith('snap-1');
    expect(rollback.restored_solid_ids).toEqual(['cube-solid']);
    expect(transactionRegistry.getActive()).toBeUndefined();
  });

  // ── Case (b): commit and then attempt rollback ───────────────────────────────

  it('begin → decompose → commit persists changes; subsequent rollback errors', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'test commit',
    }, config)) as { transaction_id: string };

    await dispatchTool('decompose_volume', {
      solid_id: 'cube-solid', strategy: 'Integrity', max_panels: 4,
    }, config);

    const commit = (await dispatchTool('commit_transaction', {
      transaction_id: begin.transaction_id,
    }, config)) as { transaction_id: string; status: string };

    expect(commit.status).toBe('committed');
    expect(commit.transaction_id).toBe(begin.transaction_id);
    expect(mock.clearSnapshots).toHaveBeenCalled();
    expect(mock.restoreSnapshot).not.toHaveBeenCalled();
    expect(transactionRegistry.getActive()).toBeUndefined();

    // The transaction record remains in the registry but is no longer active —
    // a subsequent rollback attempt errors with TRANSACTION_NOT_ACTIVE.
    await expectStructuredError(
      dispatchTool('rollback_transaction', {
        transaction_id: begin.transaction_id,
      }, config),
      'TRANSACTION_NOT_ACTIVE',
    );
  });

  // ── Case (c): second begin while one is active ───────────────────────────────

  it('a second begin_transaction while one is active returns TRANSACTION_ALREADY_ACTIVE', async () => {
    const first = (await dispatchTool('begin_transaction', {
      label: 'first',
    }, config)) as { transaction_id: string };

    const err = await expectStructuredError(
      dispatchTool('begin_transaction', { label: 'second' }, config),
      'TRANSACTION_ALREADY_ACTIVE',
    );

    // The error message includes the active transaction id (used by callers to
    // recover by committing or rolling back the existing one).
    expect(err.message).toContain(first.transaction_id);
    expect(err.suggestedTool).toBe('commit_transaction');
  });

  // ── Case (d): operating on a non-existent transaction ────────────────────────

  it('commit_transaction with an unknown id returns TRANSACTION_NOT_FOUND', async () => {
    await expectStructuredError(
      dispatchTool('commit_transaction', {
        transaction_id: 'transaction://does-not-exist',
      }, config),
      'TRANSACTION_NOT_FOUND',
    );

    expect(mock.clearSnapshots).not.toHaveBeenCalled();
  });

  it('rollback_transaction with an unknown id returns TRANSACTION_NOT_FOUND', async () => {
    await expectStructuredError(
      dispatchTool('rollback_transaction', {
        transaction_id: 'transaction://does-not-exist',
      }, config),
      'TRANSACTION_NOT_FOUND',
    );

    expect(mock.restoreSnapshot).not.toHaveBeenCalled();
  });
});

// ─── Phase 2: transaction_id acceptance by mutating tools ─────────────────────

describe('Transaction primitive Phase 2 — mutating tools accept transaction_id', () => {
  let mock: ReturnType<typeof buildMockAddon>;

  beforeEach(() => {
    mock = buildMockAddon();
    setGeometryBindingMock(mock);
    transactionRegistry.reset();
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    transactionRegistry.reset();
    vi.restoreAllMocks();
  });

  // ── Case (a): auto-join — no transaction_id passed, active txn present ───────

  it('begin → split_body_by_bends without transaction_id auto-joins the active transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'auto-join test',
    }, config)) as { transaction_id: string; rollback_token: string };

    // snap-1 created by begin_transaction; snap-2 will come from C++ splitBodyByBends
    expect(begin.rollback_token).toBe('snap-1');

    const result = (await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
    }, config)) as { rollback_token: string; panel_ids: string[] };

    // When auto-joining, rollback_token is the transaction_id, not the per-op snap
    expect(result.rollback_token).toBe(begin.transaction_id);
    expect(result.panel_ids).toEqual(['p1']);

    // The transaction is still active
    expect(transactionRegistry.getActive()?.id).toBe(begin.transaction_id);
  });

  // ── Case (b): explicit transaction_id — wrong id → TRANSACTION_MISMATCH ──────

  it('begin → split_body_by_bends with wrong transaction_id returns TRANSACTION_MISMATCH', async () => {
    await dispatchTool('begin_transaction', { label: 'mismatch test' }, config);

    await expectStructuredError(
      dispatchTool('split_body_by_bends', {
        part_id: 'cube-solid',
        transaction_id: 'transaction://wrong-id-entirely',
      }, config),
      'TRANSACTION_MISMATCH',
    );
  });

  // ── Case (c): explicit matching transaction_id → rollback_token is txn id ────

  it('begin → split_body_by_bends with matching transaction_id returns transaction_id as rollback_token', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'explicit-id test',
    }, config)) as { transaction_id: string };

    const result = (await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
      transaction_id: begin.transaction_id,
    }, config)) as { rollback_token: string };

    expect(result.rollback_token).toBe(begin.transaction_id);
  });

  // ── Backward-compat: no active txn → implicit mode (original behaviour) ──────

  it('split_body_by_bends without any active transaction returns per-op rollback_token', async () => {
    const result = (await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
    }, config)) as { rollback_token: string };

    // No active transaction; C++ op returns its own snap token
    expect(result.rollback_token).toMatch(/^snap-/);
    expect(transactionRegistry.getActive()).toBeUndefined();
  });

  // ── Backward-compat: decompose_volume without active txn creates its own snap ─

  it('decompose_volume without any active transaction creates its own snapshot', async () => {
    await dispatchTool('decompose_volume', {
      solid_id: 'cube-solid',
      strategy: 'Integrity',
    }, config);

    // In implicit mode, createSnapshot is called for decompose_volume
    expect(mock.createSnapshot).toHaveBeenCalled();
  });

  // ── No snapshot created for decompose_volume when joining a transaction ───────

  it('decompose_volume inside a transaction skips per-op snapshot creation', async () => {
    await dispatchTool('begin_transaction', { label: 'no-snap test' }, config);
    const snapCallsBefore = (mock.createSnapshot as ReturnType<typeof vi.fn>).mock.calls.length;

    await dispatchTool('decompose_volume', {
      solid_id: 'cube-solid',
      strategy: 'Integrity',
    }, config);

    // No additional createSnapshot call during the joined decompose_volume
    const snapCallsAfter = (mock.createSnapshot as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(snapCallsAfter).toBe(snapCallsBefore);
  });
});

// ─── Phase 3: shape history capture via get_transaction_history ───────────────

describe('Transaction primitive Phase 3 — shape history capture', () => {
  let mock: ReturnType<typeof buildMockAddon>;

  beforeEach(() => {
    mock = buildMockAddon();
    setGeometryBindingMock(mock);
    transactionRegistry.reset();
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    transactionRegistry.reset();
    vi.restoreAllMocks();
  });

  // ── Case (a): history accumulated after split ──────────────────────────────

  it('begin → split_body_by_bends → get_transaction_history returns 3 records', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'history test',
    }, config)) as { transaction_id: string };

    const splitResult = (await dispatchTool('split_body_by_bends', {
      part_id: 'cube-solid',
    }, config)) as { shape_history: unknown[] };

    // The handler should pass shape_history through in the response
    expect(splitResult.shape_history).toHaveLength(3);

    const history = (await dispatchTool('get_transaction_history', {
      transaction_id: begin.transaction_id,
    }, config)) as { transaction_id: string; records: Array<{ verdict: string; original_id: string; new_id: string; operation_label: string }> };

    expect(history.transaction_id).toBe(begin.transaction_id);
    expect(history.records).toHaveLength(3);
    expect(history.records[0]).toMatchObject({
      verdict: 'modified',
      original_id: 'f1',
      new_id: 'f1a',
      operation_label: 'split_body_by_bends',
    });
    expect(history.records[2]).toMatchObject({
      verdict: 'deleted',
      original_id: 'f3',
      new_id: '',
    });
  });

  // ── Case (b): history still available after commit ─────────────────────────

  it('begin → split → commit → get_transaction_history still returns records', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'history post-commit',
    }, config)) as { transaction_id: string };

    await dispatchTool('split_body_by_bends', { part_id: 'cube-solid' }, config);

    await dispatchTool('commit_transaction', {
      transaction_id: begin.transaction_id,
    }, config);

    const history = (await dispatchTool('get_transaction_history', {
      transaction_id: begin.transaction_id,
    }, config)) as { records: unknown[] };

    expect(history.records).toHaveLength(3);
  });

  // ── Case (c): history not available after rollback ─────────────────────────

  it('begin → split → rollback → get_transaction_history returns TRANSACTION_NOT_FOUND', async () => {
    const begin = (await dispatchTool('begin_transaction', {
      label: 'history post-rollback',
    }, config)) as { transaction_id: string };

    await dispatchTool('split_body_by_bends', { part_id: 'cube-solid' }, config);

    await dispatchTool('rollback_transaction', {
      transaction_id: begin.transaction_id,
    }, config);

    await expectStructuredError(
      dispatchTool('get_transaction_history', {
        transaction_id: begin.transaction_id,
      }, config),
      'TRANSACTION_NOT_FOUND',
    );
  });

  // ── Case (d): get_transaction_history on unknown id ──────────────────────────

  it('get_transaction_history with unknown id returns TRANSACTION_NOT_FOUND', async () => {
    await expectStructuredError(
      dispatchTool('get_transaction_history', {
        transaction_id: 'transaction://no-such-transaction',
      }, config),
      'TRANSACTION_NOT_FOUND',
    );
  });
});

// ─── Phase 4: shape_history surfaced for all 11 mutating ops ─────────────────

describe('Transaction primitive (Feature 004 Phase 4) — shape_history for all ops', () => {
  let mock: ReturnType<typeof buildMockAddon>;

  const histRec = (label: string) => ({
    verdict: 'modified' as const,
    original_id: `${label}-orig`,
    new_id: `${label}-new`,
    operation_label: label,
  });

  function buildPhase4Addon(): GeometryAddon {
    let snapCount = 0;
    const snap = () => `snap-${++snapCount}`;

    return {
      ...buildMockAddon(),
      // Override each op to return shape_history
      splitBodyByPlane: vi.fn(() => ({
        positiveShellId: 'pos', negativeShellId: 'neg', rollbackToken: snap(),
        shape_history: [histRec('splitBodyByPlane')],
      })),
      mergeBodiesWithBend: vi.fn(() => ({
        mergedShellId: 'merged', rollbackToken: snap(),
        shape_history: [histRec('mergeBodiesWithBend')],
      })),
      extendFaceToTarget: vi.fn((id: string) => ({
        modifiedShellId: id, extensionDistanceMm: 5.0, rollbackToken: snap(),
        shape_history: [histRec('extendFaceToTarget')],
      })),
      offsetFace: vi.fn((id: string) => ({
        modifiedShellId: id, rollbackToken: snap(),
        shape_history: [histRec('offsetFace')],
      })),
      addFlange: vi.fn((id: string) => ({
        modifiedShellId: id, flangeFeatureId: 'flange-1', rollbackToken: snap(),
        shape_history: [],  // sewing has no history API
      })),
      ripEdge: vi.fn((id: string) => ({
        modifiedShellId: id, rollbackToken: snap(),
        shape_history: [histRec('ripEdge'), histRec('ripEdge')],
      })),
      trimBodyWithPlane: vi.fn((id: string) => ({
        trimmedShellId: id, rollbackToken: snap(),
        shape_history: [histRec('trimBodyWithPlane')],
      })),
      addTabSlot: vi.fn((a: string, b: string) => ({
        modifiedShellIds: [a, b], kerfOffsetApplied: 0.15, rollbackToken: snap(),
        shape_history: [],  // stub — no real geometry
      })),
      addRivetHole: vi.fn((id: string, faceId: string) => ({
        modifiedShellId: id, holeFeatureId: `hole-${faceId}`, rollbackToken: snap(),
        shape_history: [],  // stub
      })),
      unfoldShell: vi.fn(() => ({
        unfoldId: 'unfold-1', flatWidthMm: 200, flatHeightMm: 200,
        kFactorUsed: 0.42, bendCount: 1, rollbackToken: snap(),
        shape_history: [],  // stub
      })),
    } as unknown as GeometryAddon;
  }

  beforeEach(() => {
    mock = buildPhase4Addon();
    setGeometryBindingMock(mock);
    transactionRegistry.reset();
  });

  afterEach(() => {
    setGeometryBindingMock(undefined);
    transactionRegistry.reset();
    vi.restoreAllMocks();
  });

  it('split_body_by_plane appends shape_history to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('split_body_by_plane', {
      transaction_id: begin.transaction_id,
      part_id: 'cube-solid',
      cutting_plane: { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 0 } },
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(1);
    expect(res.shape_history[0]).toMatchObject({ operation_label: 'splitBodyByPlane' });
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(1);
  });

  it('merge_bodies_with_bend appends shape_history to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('merge_bodies_with_bend', {
      transaction_id: begin.transaction_id,
      part_a_id: 'a', part_b_id: 'b', target_edges: ['e1'], bend_radius: 1.0,
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(1);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(1);
  });

  it('extend_face_to_target appends shape_history to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('extend_face_to_target', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', face_id: 'f1', target_type: 'plane',
      target: { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 100 } },
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(1);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(1);
  });

  it('offset_face appends shape_history to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('offset_face', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', face_id: 'f1', distance: 2.0,
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(1);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(1);
  });

  it('add_flange returns empty shape_history (sewing stub)', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('add_flange', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', edge_id: 'e1', length: 20, angle: 90, bend_radius: 1.0,
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(0);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(0);
  });

  it('rip_edge appends 2 shape_history records to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('rip_edge', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', edge_id: 'e1',
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(2);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(2);
  });

  it('trim_body_with_plane appends shape_history to transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('trim_body_with_plane', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', keep_positive_side: true,
      plane: { normal: { x: 0, y: 0, z: 1 }, origin: { x: 0, y: 0, z: 0 } },
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(1);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    expect(hist.records).toHaveLength(1);
  });

  it('synthesize_joints (tab_slot) returns empty shape_history (stub)', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('synthesize_joints', {
      transaction_id: begin.transaction_id,
      panel_ids: ['a', 'b'], joint_type: 'tab_slot',
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(0);
  });

  it('apply_unfold returns empty shape_history (stub)', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    const res = (await dispatchTool('apply_unfold', {
      transaction_id: begin.transaction_id,
      panel_id: 'shell-1', material_id: 'mild_steel_1.5mm',
    }, config)) as { shape_history: unknown[] };
    expect(res.shape_history).toHaveLength(0);
  });

  it('multiple ops accumulate shape_history in transaction', async () => {
    const begin = (await dispatchTool('begin_transaction', { label: 'p4', product: 'x' }, config)) as { transaction_id: string };
    await dispatchTool('offset_face', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', face_id: 'f1', distance: 2.0,
    }, config);
    await dispatchTool('rip_edge', {
      transaction_id: begin.transaction_id,
      part_id: 'shell-1', edge_id: 'e1',
    }, config);
    const hist = (await dispatchTool('get_transaction_history', { transaction_id: begin.transaction_id }, config)) as { records: unknown[] };
    // offset_face → 1 record; rip_edge → 2 records
    expect(hist.records).toHaveLength(3);
  });
});
