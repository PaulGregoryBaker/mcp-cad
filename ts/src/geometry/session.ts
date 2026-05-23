/**
 * Session state management — GeometrySnapshot and RollbackToken tracking.
 * Constitution Principle IV: every mutating tool produces a rollback_token.
 *
 * Task: T039
 */

export interface GeometrySnapshot {
  snapshotId: string;
  solidIds: string[];
  shellIds: string[];
  timestamp: number;
  operationLabel: string;
}

export type RollbackToken = string;

/**
 * SessionState tracks the active geometry IDs for the current session.
 * There is one session per process (single-session MVP).
 */
export class SessionState {
  private solidIds: Set<string> = new Set();
  private shellIds: Set<string> = new Set();
  private unfoldIds: Set<string> = new Set();
  private nestIds: Set<string> = new Set();
  private snapshots: Map<string, GeometrySnapshot> = new Map();

  registerSolid(id: string): void {
    this.solidIds.add(id);
  }

  registerShell(id: string): void {
    this.shellIds.add(id);
  }

  registerUnfold(id: string): void {
    this.unfoldIds.add(id);
  }

  registerNest(id: string): void {
    this.nestIds.add(id);
  }

  hasSolid(id: string): boolean {
    return this.solidIds.has(id);
  }

  hasShell(id: string): boolean {
    return this.shellIds.has(id);
  }

  hasUnfold(id: string): boolean {
    return this.unfoldIds.has(id);
  }

  hasNest(id: string): boolean {
    return this.nestIds.has(id);
  }

  recordSnapshot(snapshot: GeometrySnapshot): void {
    this.snapshots.set(snapshot.snapshotId, snapshot);
  }

  getSnapshot(snapshotId: string): GeometrySnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  /**
   * Applies the snapshot to restore the session's tracked ID sets.
   * Called after restoreSnapshot() completes in the NAPI layer.
   */
  applyRestore(snapshot: GeometrySnapshot): void {
    this.solidIds = new Set(snapshot.solidIds);
    this.shellIds = new Set(snapshot.shellIds);
    // Clear unfolds and nests created after the snapshot (rollback removes them)
    // For now, conservatively clear all unfolds/nests on rollback
    this.unfoldIds.clear();
    this.nestIds.clear();
  }

  reset(): void {
    this.solidIds.clear();
    this.shellIds.clear();
    this.unfoldIds.clear();
    this.nestIds.clear();
    this.snapshots.clear();
  }

  getSummary(): {
    solids: number;
    shells: number;
    unfolds: number;
    nests: number;
    snapshots: number;
  } {
    return {
      solids: this.solidIds.size,
      shells: this.shellIds.size,
      unfolds: this.unfoldIds.size,
      nests: this.nestIds.size,
      snapshots: this.snapshots.size,
    };
  }
}

// Singleton session for the process
export const session = new SessionState();

// ─── Semantic persistence singletons (Feature 005) ────────────────────────────

import type { PersistenceConfig } from '../config/loader';
import type { SemanticPersistencePort } from '../semantic/port';
import type { SemanticStore as SemanticStoreType } from '../semantic/semantic_store';

let _semanticPort: SemanticPersistencePort | null = null;
let _semanticStore: SemanticStoreType | null = null;

/**
 * Initialises the Dolt adapter and semantic store from config.
 * Called once at server startup when persistence is configured.
 * Throws PERSISTENCE_UNAVAILABLE if the Dolt server is unreachable.
 */
export async function initSemanticPersistence(
  persistence: PersistenceConfig,
): Promise<{ port: SemanticPersistencePort; store: SemanticStoreType }> {
  const { DoltAdapter } = await import('../semantic/dolt_adapter.js');
  const { SemanticStore } = await import('../semantic/semantic_store.js');
  const { applyMigrations } = await import('../semantic/migration_runner.js');
  const mysql = await import('mysql2/promise');

  const adapter = new DoltAdapter({
    host: persistence.host,
    port: persistence.port,
    user: 'root',
    password: '',
    database: persistence.database,
  });
  await adapter.connect();

  // Run migrations via a dedicated single connection.
  const migConn = await mysql.createConnection({
    host: persistence.host,
    port: persistence.port,
    user: 'root',
    password: '',
    database: persistence.database,
  });
  await applyMigrations(migConn);
  await migConn.end();

  const store = new SemanticStore(adapter);
  _semanticPort = adapter;
  _semanticStore = store;

  return { port: adapter, store };
}

export function getSemanticPort(): SemanticPersistencePort | null {
  return _semanticPort;
}

export function getSemanticStore(): SemanticStoreType | null {
  return _semanticStore;
}
