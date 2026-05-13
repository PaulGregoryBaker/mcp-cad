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
