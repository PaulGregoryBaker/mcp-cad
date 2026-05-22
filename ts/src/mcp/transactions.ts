/**
 * TransactionRegistry — explicit transaction lifecycle (Feature 004-transaction-primitive).
 *
 * Wraps the existing snapshot-based rollback model in named transactions so a
 * multi-tool sequence can be committed or rolled back atomically. The registry
 * is a singleton bound to the process (single-session MVP per Constitution
 * Principle VII).
 *
 * Tasks: T003, T004.
 */

import { randomUUID } from 'node:crypto';
import { ErrorCodes, throwError } from './errors';

export type TransactionId = string; // `transaction://<uuid-v4>`
export type SnapshotId = string;

export type TransactionState = 'active' | 'committed' | 'rolled_back';

export interface Transaction {
  id: TransactionId;
  label: string;
  product?: string;
  snapshotId: SnapshotId;
  startedAt: number;
  state: TransactionState;
  endedAt?: number;
}

export class TransactionRegistry {
  private transactions: Map<TransactionId, Transaction> = new Map();
  private activeId: TransactionId | undefined;

  begin(label: string, snapshotId: SnapshotId, product?: string): Transaction {
    if (this.activeId !== undefined) {
      const active = this.transactions.get(this.activeId);
      throwError(
        ErrorCodes.TRANSACTION_ALREADY_ACTIVE,
        `Transaction ${active?.id ?? this.activeId} is already active. ` +
          `Commit or roll it back before starting another.`,
        true,
        'commit_transaction',
      );
    }

    const id: TransactionId = `transaction://${randomUUID()}`;
    const txn: Transaction = {
      id,
      label,
      product,
      snapshotId,
      startedAt: Date.now(),
      state: 'active',
    };
    this.transactions.set(id, txn);
    this.activeId = id;
    return txn;
  }

  commit(id: TransactionId): Transaction {
    const txn = this.requireActive(id);
    txn.state = 'committed';
    txn.endedAt = Date.now();
    this.activeId = undefined;
    return txn;
  }

  rollback(id: TransactionId): Transaction {
    const txn = this.requireActive(id);
    txn.state = 'rolled_back';
    txn.endedAt = Date.now();
    this.activeId = undefined;
    return txn;
  }

  getActive(): Transaction | undefined {
    return this.activeId !== undefined ? this.transactions.get(this.activeId) : undefined;
  }

  get(id: TransactionId): Transaction | undefined {
    return this.transactions.get(id);
  }

  reset(): void {
    this.transactions.clear();
    this.activeId = undefined;
  }

  private requireActive(id: TransactionId): Transaction {
    const txn = this.transactions.get(id);
    if (!txn) {
      throwError(
        ErrorCodes.TRANSACTION_NOT_FOUND,
        `Transaction ${id} does not exist in this session.`,
        true,
        'begin_transaction',
      );
    }
    if (txn.state !== 'active') {
      throwError(
        ErrorCodes.TRANSACTION_NOT_ACTIVE,
        `Transaction ${id} is in state '${txn.state}'; expected 'active'.`,
        true,
        'begin_transaction',
      );
    }
    if (this.activeId !== id) {
      throwError(
        ErrorCodes.TRANSACTION_MISMATCH,
        `Transaction ${id} is not the active transaction ` +
          `(active is ${this.activeId ?? 'none'}).`,
        true,
      );
    }
    return txn;
  }
}

// Singleton bound to the process — matches the existing `session` pattern in
// ts/src/geometry/session.ts.
export const transactionRegistry = new TransactionRegistry();
