/**
 * Integration test: explicit transaction primitive (Feature 004).
 *
 * Phase 1 covers the three lifecycle tools (begin_transaction,
 * commit_transaction, rollback_transaction) wrapping the existing snapshot
 * mechanism. No C++ changes; the mocked addon returns deterministic snapshot
 * ids per the existing pattern from cube_box_workflow.functional.test.ts.
 *
 * Tasks: T012.
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
    trimBodyWithPlane: vi.fn((id: string) => ({ modifiedShellId: id, rollbackToken: snap() })),
    addRelief: vi.fn((id: string) => ({ modifiedShellId: id, rollbackToken: snap() })),
    checkBoundaryCompliance: vi.fn(() => ({ envelopeId: 'std', compliant: true, violations: [] })),
    splitBodyByBends: vi.fn(() => ({
      panel_ids: ['p1'], panel_bboxes: [],
      protrusion_ids: [], protrusion_bboxes: [],
      rollbackToken: snap(), detected_mode: 'thin_solid',
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
