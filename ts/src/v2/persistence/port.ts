/**
 * GraphPersistence — the storage port (spec 010, R-014/R-015, T021).
 *
 * One instance per bound project (per MCP session); no module-level state.
 * DoltPersistence is the only production adapter. Every method either
 * succeeds or throws a StructuredError (PERSIST_* / STORAGE_* / BRANCH_* /
 * COMMIT_* / UNDO_*); none returns partial results.
 */

import type { PartGraphSnapshot } from '../graph/store';
import type { GraphRows, RowDiff, ShadowStore } from './row-mapper';

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface ProjectSettingsRow {
  manufacturing_profile: Record<string, unknown> | null;
  manufacturing_defaults: Record<string, unknown> | null;
  nesting: Record<string, unknown> | null;
}

export interface ClientMetaRow {
  part_id: string;
  doc: Record<string, unknown>;
}

export interface ImportSourceRow {
  import_source_id: string;
  file_path: string;
  file_sha256: string;
  config: Record<string, unknown>;
  measured_thickness_mm: number | null;
}

/** Raw state read from a branch or ref (validation happens in load.ts). */
export interface RawLoad {
  rows: GraphRows;
  clientMeta: ClientMetaRow[];
  settings: ProjectSettingsRow;
  schemaVersion: number;
}

export interface LoadedState {
  branch: string;
  readOnlyRef: string | null;
  headCommit: string;
  dirty: boolean;
  uncommittedOps: number;
  snapshots: PartGraphSnapshot[];
  shadows: ShadowStore;
  clientMeta: ClientMetaRow[];
  settings: ProjectSettingsRow;
  schemaMigrated: boolean;
}

export type ActorKind = 'human' | 'agent' | 'system';

export interface ActionRecord {
  actorKind: Exclude<ActorKind, 'system'>;
  actorId: string;
  tool: string;
  params: Record<string, unknown>;
  deltaSummary: Record<string, unknown>;
}

/** Non-graph writes that ride along with a mutation (same SQL transaction, same action row). */
export interface SideWrites {
  clientMetaUpserts?: ClientMetaRow[];
  settingsPatch?: Partial<ProjectSettingsRow>;
  importSource?: ImportSourceRow;
}

export interface HistoryCommit {
  hash: string;
  parents: string[];
  date: string;
  author_name: string;
  author_email: string;
  message: string;
  op_count: number;
  agent_op_count: number;
}

export interface HistoryResult {
  current_branch: string;
  head_commit: string;
  dirty: boolean;
  uncommitted_ops: number;
  branches: Array<{ name: string; head_commit: string }>;
  commits: HistoryCommit[];
}

export interface ActionEntry {
  seq: number;
  at: string;
  actor_kind: ActorKind;
  actor_id: string;
  tool: string;
  delta_summary: Record<string, unknown>;
  undone: boolean;
}

export interface GraphPersistence {
  readonly database: string;
  readonly author: CommitAuthor;
  readonly branch: string;
  readonly readOnlyRef: string | null;

  /** Migrate (main, then session branch) and read the session branch. */
  open(): Promise<{ raw: RawLoad; schemaMigrated: boolean }>;
  /** Re-read the bound branch (working set) or read-only ref. */
  readCurrent(): Promise<RawLoad>;
  /** Read any ref without moving the writer. */
  readAt(ref: string): Promise<RawLoad>;
  /** Just the project settings of the bound branch/ref (cheap; no graph rows). */
  readSettings(): Promise<ProjectSettingsRow>;

  status(): Promise<{ headCommit: string; dirty: boolean; uncommittedOps: number; unmergedCommits: number }>;

  /** One mutation: row diff + side writes + one action_log row, atomically. Returns the action seq. */
  applyChange(diff: RowDiff, side: SideWrites, action: ActionRecord): Promise<number>;
  undoLast(): Promise<number>;
  commit(message: string): Promise<{ commitHash: string; ops: number }>;
  discardChanges(): Promise<void>;

  branchBegin(label: string, replaceExisting: boolean): Promise<{ branch: string; forkedFrom: string }>;
  branchMerge(message: string): Promise<{ mergeCommit: string }>;
  branchDiscard(): Promise<void>;
  checkout(ref: string): Promise<{ migrated: boolean }>;

  history(limit: number): Promise<HistoryResult>;
  actionsAt(ref: string): Promise<ActionEntry[]>;

  close(): Promise<void>;
}
