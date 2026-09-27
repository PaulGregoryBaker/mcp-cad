/**
 * Test-only GraphPersistence (spec 010). For server-level tests that exercise
 * something other than storage (e.g. mesh subscriptions) but must go through
 * the real persistent dispatch path. Records applied changes; never used in
 * production code (src/ has no reference to it).
 */
import type {
  ActionEntry,
  ActionRecord,
  CommitAuthor,
  GraphPersistence,
  HistoryResult,
  RawLoad,
  SideWrites,
} from '../../src/v2/persistence/port';
import type { RowDiff } from '../../src/v2/persistence/row-mapper';
import { emptyRows } from '../../src/v2/persistence/row-mapper';
import { SessionContext } from '../../src/v2/persistence/session';
import type { GraphStore } from '../../src/v2/graph/store';

export class MemoryPersistence implements GraphPersistence {
  readonly database = 'memory';
  readonly author: CommitAuthor = { name: 'Test', email: 'test@local' };
  branch = 'wip/test';
  readOnlyRef: string | null = null;
  readonly applied: Array<{ diff: RowDiff; side: SideWrites; action: ActionRecord }> = [];

  private raw(): RawLoad {
    return { rows: emptyRows(), clientMeta: [], settings: { manufacturing_profile: null, manufacturing_defaults: null, nesting: null }, schemaVersion: 0 };
  }
  async open() {
    return { raw: this.raw(), schemaMigrated: false };
  }
  async readCurrent() {
    return this.raw();
  }
  async readAt() {
    return this.raw();
  }
  async status() {
    return { headCommit: 'memory', dirty: this.applied.length > 0, uncommittedOps: this.applied.length, unmergedCommits: 0 };
  }
  async applyChange(diff: RowDiff, side: SideWrites, action: ActionRecord) {
    this.applied.push({ diff, side, action });
    return this.applied.length;
  }
  private unsupported(): never {
    throw new Error('MemoryPersistence: not supported in this test double');
  }
  async undoLast(): Promise<number> {
    return this.unsupported();
  }
  async commit(): Promise<{ commitHash: string; ops: number }> {
    return this.unsupported();
  }
  async discardChanges() {
    return this.unsupported();
  }
  async branchBegin(): Promise<{ branch: string; forkedFrom: string }> {
    return this.unsupported();
  }
  async branchMerge(): Promise<{ mergeCommit: string }> {
    return this.unsupported();
  }
  async branchDiscard() {
    return this.unsupported();
  }
  async checkout(): Promise<{ migrated: boolean }> {
    return this.unsupported();
  }
  async history(): Promise<HistoryResult> {
    return this.unsupported();
  }
  async actionsAt(): Promise<ActionEntry[]> {
    return [];
  }
  async close() {}
}

/** A SessionContext bound to a MemoryPersistence on a working branch. */
export function memoryBoundContext(store?: GraphStore): { ctx: SessionContext; persistence: MemoryPersistence } {
  const ctx = new SessionContext(store);
  const persistence = new MemoryPersistence();
  ctx.bound = { account: 'memory', database: 'memory', persistence, shadows: new Map() };
  return { ctx, persistence };
}
