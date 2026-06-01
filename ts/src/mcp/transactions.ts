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
import type { SemanticPersistencePort } from '../semantic/port';

export type TransactionId = string; // `transaction://<uuid-v4>`
export type SnapshotId = string;

export type TransactionState = 'active' | 'committed' | 'rolled_back';

export interface ShapeHistoryRecord {
  verdict: 'modified' | 'generated' | 'deleted';
  original_id: string;
  new_id: string;
  operation_label: string;
}

export interface Transaction {
  id: TransactionId;
  label: string;
  product?: string;
  snapshotId: SnapshotId;
  startedAt: number;
  state: TransactionState;
  endedAt?: number;
  shapeHistory: ShapeHistoryRecord[];
}

export class TransactionRegistry {
  private transactions: Map<TransactionId, Transaction> = new Map();
  private activeId: TransactionId | undefined;
  private port: SemanticPersistencePort | null = null;

  /** Wire in a Dolt port once session.ts has initialised it (T026). */
  setPort(port: SemanticPersistencePort): void {
    this.port = port;
  }

  /** Dolt branch name for a transaction id (strips the URI scheme prefix). */
  private branchName(id: TransactionId): string {
    return `txn/${id.replace('transaction://', '')}`;
  }

  async begin(label: string, snapshotId: SnapshotId, product?: string): Promise<Transaction> {
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
      shapeHistory: [],
    };
    this.transactions.set(id, txn);
    this.activeId = id;

    if (this.port) {
      try {
        await this.port.checkoutBranch(this.branchName(id), true);
        await this.port.insertTransaction({
          id,
          label,
          product: product ?? '',
          state: 'active',
          started_at: new Date(),
        });
      } catch (err) {
        this.transactions.delete(id);
        this.activeId = undefined;
        throwError(
          ErrorCodes.PERSISTENCE_UNAVAILABLE,
          `Failed to create Dolt branch for transaction ${id}: ${String(err)}`,
          true,
          'begin_transaction',
        );
      }
    }

    return txn;
  }

  async commit(id: TransactionId): Promise<Transaction> {
    const txn = this.requireActive(id);
    txn.state = 'committed';
    txn.endedAt = Date.now();
    this.activeId = undefined;

    if (this.port) {
      try {
        await this.port.updateTransactionState(id, 'committed', new Date(txn.endedAt!));
        await this.port.mergeBranch(this.branchName(id));
        await this.port.deleteBranch(this.branchName(id));
      } catch (err) {
        throwError(
          ErrorCodes.PERSISTENCE_COMMIT_FAILED,
          `Dolt commit failed for transaction ${id}: ${String(err)}`,
          true,
          'commit_transaction',
        );
      }
    }

    return txn;
  }

  async rollback(id: TransactionId): Promise<Transaction> {
    const txn = this.requireActive(id);
    txn.state = 'rolled_back';
    txn.endedAt = Date.now();
    this.activeId = undefined;

    if (this.port) {
      try {
        await this.port.updateTransactionState(id, 'rolled_back', new Date(txn.endedAt!));
        await this.port.deleteBranch(this.branchName(id), true);
      } catch (err) {
        throwError(
          ErrorCodes.PERSISTENCE_UNAVAILABLE,
          `Dolt rollback failed for transaction ${id}: ${String(err)}`,
          true,
          'rollback_transaction',
        );
      }
    }

    return txn;
  }

  getActive(): Transaction | undefined {
    return this.activeId !== undefined ? this.transactions.get(this.activeId) : undefined;
  }

  get(id: TransactionId): Transaction | undefined {
    return this.transactions.get(id);
  }

  appendHistory(id: TransactionId, records: ShapeHistoryRecord[]): void {
    const txn = this.transactions.get(id);
    if (!txn) {
      throwError(
        ErrorCodes.TRANSACTION_NOT_FOUND,
        `Transaction ${id} does not exist in this session.`,
        true,
        'begin_transaction',
      );
    }
    txn.shapeHistory.push(...records);
  }

  getHistory(id: TransactionId): ShapeHistoryRecord[] {
    const txn = this.transactions.get(id);
    if (!txn) {
      throwError(
        ErrorCodes.TRANSACTION_NOT_FOUND,
        `Transaction ${id} does not exist in this session.`,
        true,
        'begin_transaction',
      );
    }
    return txn.shapeHistory;
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
