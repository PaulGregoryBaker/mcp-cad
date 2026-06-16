import { throwError, ErrorCodes } from '../errors.js';
import { getGeometryBinding, tryGetSemanticStore } from '../state.js';
import { requireString } from '../helpers.js';
import { transactionRegistry } from '../transactions.js';
import { MappingLayer } from '../../semantic/mapping_layer.js';

export const transactionDefinitions = [
  {
    name: 'rollback',
    description: 'Restores geometry state to a previous snapshot.',
    inputSchema: {
      type: 'object',
      properties: { rollback_token: { type: 'string' } },
      required: ['rollback_token'],
    },
  },
  {
    name: 'begin_transaction',
    description:
      'Open an explicit transaction. Subsequent mutating tools execute against working state; commit to persist or roll back to revert all operations atomically. Returns transaction_id (also usable as rollback_token).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable label for the transaction' },
        product: { type: 'string', description: 'Optional product slug (informational only in MVP)' },
      },
      required: ['label'],
    },
  },
  {
    name: 'commit_transaction',
    description:
      'Commit an active transaction. Discards the pre-transaction snapshot; changes become permanent.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string', description: 'Transaction id returned by begin_transaction' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'rollback_transaction',
    description:
      'Roll back an active transaction. Restores geometry to its pre-transaction state and clears the active transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string', description: 'Transaction id returned by begin_transaction' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'get_transaction_history',
    description:
      'Returns the shape topology history accumulated in a transaction. Available for active and committed transactions; returns TRANSACTION_NOT_FOUND for rolled-back transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string', description: 'Transaction id returned by begin_transaction' },
      },
      required: ['transaction_id'],
    },
  },
];

export function handleRollback(args: Record<string, unknown>): unknown {
  const rollbackToken = requireString(args, 'rollback_token');
  const result = getGeometryBinding().restoreSnapshot(rollbackToken);
  return {
    restored_solid_ids: result.restoredSolidIds,
    restored_shell_ids: result.restoredShellIds,
    snapshot_label: rollbackToken,
  };
}

export async function handleBeginTransaction(args: Record<string, unknown>): Promise<unknown> {
  const label = requireString(args, 'label');
  const product = typeof args.product === 'string' ? args.product : undefined;
  const snapshotId = getGeometryBinding().createSnapshot(label);
  const txn = await transactionRegistry.begin(label, snapshotId, product);
  return {
    transaction_id: txn.id,
    status: txn.state,
    label: txn.label,
    product: txn.product,
    rollback_token: txn.snapshotId,
  };
}

export async function handleCommitTransaction(args: Record<string, unknown>): Promise<unknown> {
  const transactionId = requireString(args, 'transaction_id');

  const store = tryGetSemanticStore();
  if (store) {
    const port = store.getPort();
    try {
      const revisionId = await port.insertTopologyRevision({
        transaction_id: transactionId,
        brep_file_path: '',
        brep_sha256: '0'.repeat(64),
      });

      const inMemoryHistory = transactionRegistry.getHistory(transactionId);
      const shapeHistoryRows = inMemoryHistory.map((r) => ({
        transaction_id: transactionId,
        verdict: r.verdict as import('../../semantic/types.js').ShapeVerdict,
        original_id: r.original_id,
        new_id: r.new_id ?? null,
        operation_label: r.operation_label,
      }));
      await port.insertShapeHistory(shapeHistoryRows);

      const mappingLayer = new MappingLayer(store);
      const affectedIds = await mappingLayer.applyShapeHistoryToBindings(transactionId, revisionId);
      await mappingLayer.refreshDerivedBindings(transactionId, revisionId, affectedIds);
    } catch (err) {
      throwError(
        ErrorCodes.PERSISTENCE_COMMIT_FAILED,
        `Mapping layer remap failed: ${String(err)}`,
        true,
        'commit_transaction',
      );
    }
  }

  const txn = await transactionRegistry.commit(transactionId);
  getGeometryBinding().clearSnapshots();
  return { transaction_id: txn.id, status: txn.state, label: txn.label };
}

export async function handleRollbackTransaction(args: Record<string, unknown>): Promise<unknown> {
  const transactionId = requireString(args, 'transaction_id');

  const existing = transactionRegistry.get(transactionId);
  if (!existing) {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} does not exist in this session.`,
      true,
      'begin_transaction',
    );
  }

  let restoredSolidIds: string[] = [];
  let restoredShellIds: string[] = [];

  try {
    const result = getGeometryBinding().restoreSnapshot(existing.snapshotId);
    restoredSolidIds = result.restoredSolidIds;
    restoredShellIds = result.restoredShellIds;
  } catch (err) {
    const maybeCode = err as { code?: string; message?: string };
    const snapshotMissing =
      maybeCode.code === 'GE_SNAPSHOT_NOT_FOUND' || /Snapshot not found/i.test(maybeCode.message ?? '');
    if (!snapshotMissing) throw err;
  }

  const txn = await transactionRegistry.rollback(transactionId);
  return {
    transaction_id: txn.id,
    status: txn.state,
    label: txn.label,
    restored_solid_ids: restoredSolidIds,
    restored_shell_ids: restoredShellIds,
  };
}

export function handleGetTransactionHistory(args: Record<string, unknown>): unknown {
  const transactionId = requireString(args, 'transaction_id');

  const existing = transactionRegistry.get(transactionId);
  if (!existing) {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} does not exist in this session.`,
      true,
      'begin_transaction',
    );
  }

  if (existing.state === 'rolled_back') {
    throwError(
      ErrorCodes.TRANSACTION_NOT_FOUND,
      `Transaction ${transactionId} has been rolled back; history is no longer available.`,
      true,
      'begin_transaction',
    );
  }

  const records = transactionRegistry.getHistory(transactionId);
  return { transaction_id: transactionId, records };
}
