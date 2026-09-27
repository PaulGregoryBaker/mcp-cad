/**
 * DoltPersistence — the GraphPersistence adapter (spec 010, T021).
 *
 * Connections: one dedicated WRITER connection per bound project (never a
 * pool — Dolt's checked-out branch is per SQL session, R-001 defect 4) whose
 * every statement runs under `USE \`<db>/<branch>\``, plus a READER
 * connection for `AS OF` reads (history/compare) that never disturbs the
 * writer. session_state is always addressed as \`<db>/main\`.session_state
 * (it exists only in main's working set; T004 finding).
 *
 * Commit model (R-015): applyChange() writes rows + one action_log row to the
 * working set in one SQL transaction — no DOLT_COMMIT. commit() is the only
 * way a revision is created.
 */

import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { ErrorCodes, throwError } from '../../mcp/errors';
import type { StorageAccount } from '../../config/storage-accounts';
import { connectionOptions, redactSecrets, storageErrorFrom } from './accounts';
import { appliedVersion, currentSchemaVersion, isDirty, migrateBranch, migrateForOpen, schemaVersionAt } from './migrate';
import {
  emptyRows,
  normaliseRows,
  PRIMARY_KEY,
  type GraphRows,
  type GraphTable,
  type RowDiff,
} from './row-mapper';
import type {
  ActionEntry,
  ActionRecord,
  ClientMetaRow,
  CommitAuthor,
  GraphPersistence,
  HistoryCommit,
  HistoryResult,
  ProjectSettingsRow,
  RawLoad,
  SideWrites,
} from './port';

const GRAPH_TABLES: GraphTable[] = ['part', 'part_ring', 'ring_vertex', 'feature', 'region_panel', 'bend'];
/** Phase A deletes (leaves nothing else references), then upserts parents-first, then phase B deletes. */
const DELETE_FIRST: GraphTable[] = ['bend', 'feature', 'ring_vertex'];
const UPSERT_ORDER: GraphTable[] = ['part', 'region_panel', 'part_ring', 'ring_vertex', 'feature', 'bend'];
const DELETE_LAST: GraphTable[] = ['part_ring', 'region_panel', 'part'];

const OPS_TRAILER = /\n\n\[formaition\] ops=(\d+) agent_ops=(\d+)\s*$/;
const BRANCH_LABEL = /^[A-Za-z0-9._-]{1,64}$/;

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_/.-]+$/.test(name)) throwError(ErrorCodes.PERSIST_WRITE_FAILED, `invalid identifier '${name}'`, false);
  return `\`${name}\``;
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return JSON.parse(v) as Record<string, unknown>;
  return v as Record<string, unknown>;
}

export class DoltPersistence implements GraphPersistence {
  private writer!: Connection;
  private reader!: Connection;
  private _branch = 'main';
  private _readOnlyRef: string | null = null;

  private constructor(
    private readonly account: StorageAccount,
    readonly database: string,
    readonly author: CommitAuthor,
  ) {}

  static async connect(account: StorageAccount, database: string, author: CommitAuthor): Promise<DoltPersistence> {
    const p = new DoltPersistence(account, database, author);
    try {
      p.writer = await mysql.createConnection(connectionOptions(account));
      p.reader = await mysql.createConnection(connectionOptions(account));
    } catch (e) {
      await p.close();
      storageErrorFrom(e, account, 'connect');
    }
    const exists = await p.q(p.writer, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    if (exists.length === 0) {
      await p.close();
      throwError(ErrorCodes.PROJECT_DATABASE_NOT_FOUND, `project database '${database}' does not exist on storage account '${account.id}'`, false);
    }
    return p;
  }

  get branch(): string {
    return this._branch;
  }

  get readOnlyRef(): string | null {
    return this._readOnlyRef;
  }

  private get authorString(): string {
    return `${this.author.name} <${this.author.email}>`;
  }

  private async q(conn: Connection, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
    try {
      const [r] = await conn.query<RowDataPacket[]>(sql, params);
      return r;
    } catch (e) {
      storageErrorFrom(e, this.account, 'write');
    }
  }

  private async useBranch(branch: string): Promise<void> {
    await this.q(this.writer, `USE ${quoteIdent(`${this.database}/${branch}`)}`);
    this._branch = branch;
  }

  private mainTable(table: string): string {
    return `${quoteIdent(`${this.database}/main`)}.${quoteIdent(table)}`;
  }

  // ─── Session branch (main's working set only) ─────────────────────────────

  private async readSessionBranch(): Promise<string> {
    const r = await this.q(this.writer, `SELECT current_branch FROM ${this.mainTable('session_state')} WHERE id = 1`);
    const b = r[0] ? String(r[0]['current_branch']) : 'main';
    const exists = await this.q(this.writer, `SELECT name FROM ${quoteIdent(`${this.database}/main`)}.dolt_branches WHERE name = ?`, [b]);
    return exists.length > 0 ? b : 'main';
  }

  private async writeSessionBranch(branch: string): Promise<void> {
    await this.q(
      this.writer,
      `INSERT INTO ${this.mainTable('session_state')} (id, current_branch) VALUES (1, ?) ON DUPLICATE KEY UPDATE current_branch = VALUES(current_branch)`,
      [branch],
    );
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  private async readTables(conn: Connection, asOf: string | null): Promise<RawLoad> {
    const from = (t: string): string =>
      asOf === null ? quoteIdent(t) : `${quoteIdent(this.database)}.${quoteIdent(t)} AS OF '${asOf.replace(/'/g, '')}'`;
    const raw = {} as Record<GraphTable, Record<string, unknown>[]>;
    for (const t of GRAPH_TABLES) raw[t] = await this.q(conn, `SELECT * FROM ${from(t)}`);
    const meta = await this.q(conn, `SELECT part_id, doc FROM ${from('client_meta')}`);
    const settings = await this.readSettingsFrom(conn, from('project_settings'));
    const clientMeta: ClientMetaRow[] = meta.map((m) => ({ part_id: String(m['part_id']), doc: parseJson(m['doc']) ?? {} }));
    const schemaVersion = asOf === null ? await appliedVersion(conn) : await schemaVersionAt(conn, this.database, asOf);
    return { rows: normaliseRows(raw), clientMeta, settings, schemaVersion };
  }

  async open(): Promise<{ raw: RawLoad; schemaMigrated: boolean }> {
    const session = await (async () => {
      try {
        return await this.readSessionBranch();
      } catch {
        return 'main'; // a brand-new database: main not migrated yet
      }
    })();
    const results = await migrateForOpen(this.writer, this.database, session);
    this._branch = session;
    this._readOnlyRef = null;
    await this.writeSessionBranch(session);
    return { raw: await this.readTables(this.writer, null), schemaMigrated: results.some((r) => r.mode !== 'none') };
  }

  private async readSettingsFrom(conn: Connection, table: string): Promise<ProjectSettingsRow> {
    const rows = await this.q(conn, `SELECT manufacturing_profile, manufacturing_defaults, nesting FROM ${table} WHERE id = 1`);
    const s = rows[0];
    return {
      manufacturing_profile: parseJson(s?.['manufacturing_profile']),
      manufacturing_defaults: parseJson(s?.['manufacturing_defaults']),
      nesting: parseJson(s?.['nesting']),
    };
  }

  async readSettings(): Promise<ProjectSettingsRow> {
    if (this._readOnlyRef !== null) {
      return this.readSettingsFrom(this.reader, `${quoteIdent(this.database)}.${quoteIdent('project_settings')} AS OF '${this._readOnlyRef.replace(/'/g, '')}'`);
    }
    await this.useBranch(this._branch);
    return this.readSettingsFrom(this.writer, quoteIdent('project_settings'));
  }

  async readCurrent(): Promise<RawLoad> {
    if (this._readOnlyRef !== null) return this.readAt(this._readOnlyRef);
    await this.useBranch(this._branch);
    return this.readTables(this.writer, null);
  }

  async readAt(ref: string): Promise<RawLoad> {
    const v = await schemaVersionAt(this.reader, this.database, ref);
    if (v !== currentSchemaVersion()) {
      throwError(
        ErrorCodes.PERSIST_SCHEMA_MISMATCH,
        `revision ${ref} is at schema ${v}; this server reads schema ${currentSchemaVersion()} — check it out to migrate it first`,
        false,
      );
    }
    return this.readTables(this.reader, ref);
  }

  private async committedSeq(): Promise<number> {
    const r = await this.q(this.writer, "SELECT meta_value FROM meta WHERE meta_key = 'committed_seq'");
    return Number(r[0]?.['meta_value'] ?? 0);
  }

  async status(): Promise<{ headCommit: string; dirty: boolean; uncommittedOps: number; unmergedCommits: number }> {
    if (this._readOnlyRef !== null) return { headCommit: this._readOnlyRef, dirty: false, uncommittedOps: 0, unmergedCommits: 0 };
    await this.useBranch(this._branch);
    const head = await this.q(this.writer, "SELECT HASHOF('HEAD') AS h");
    const dirty = await isDirty(this.writer);
    const cs = await this.committedSeq();
    const ops = await this.q(this.writer, 'SELECT COUNT(*) AS n FROM action_log WHERE undone = FALSE AND seq > ?', [cs]);
    const unmergedCommits = this._branch === 'main' ? 0 : await this.unmergedCommits(this._branch);
    return { headCommit: String(head[0]?.['h'] ?? ''), dirty, uncommittedOps: Number(ops[0]?.['n'] ?? 0), unmergedCommits };
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  private assertWritableBranch(): void {
    if (this._readOnlyRef !== null) {
      throwError(ErrorCodes.PERSIST_READ_ONLY_REF, `viewing read-only revision ${this._readOnlyRef.slice(0, 8)}; start a branch to edit`, true);
    }
    if (this._branch === 'main') {
      throwError(ErrorCodes.PERSIST_ON_MAIN, 'edits are never saved on main; open a working branch first (branch_begin)', true);
    }
  }

  private async upsertRows(table: GraphTable, rows: object[]): Promise<void> {
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => (row as Record<string, unknown>)[c]);
      const pk = PRIMARY_KEY[table];
      const updates = cols.filter((c) => c !== pk).map((c) => `${quoteIdent(c)} = VALUES(${quoteIdent(c)})`);
      await this.q(
        this.writer,
        `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})` +
          (updates.length > 0 ? ` ON DUPLICATE KEY UPDATE ${updates.join(', ')}` : ''),
        vals,
      );
    }
  }

  private async deleteKeys(table: GraphTable, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.q(this.writer, `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(PRIMARY_KEY[table])} IN (${keys.map(() => '?').join(', ')})`, keys);
  }

  /** Applies "set these rows" + "delete these keys" in FK-safe phases. */
  private async applyRowSet(upserts: GraphRows, deletes: Record<GraphTable, string[]>): Promise<void> {
    for (const t of DELETE_FIRST) await this.deleteKeys(t, deletes[t]);
    for (const t of UPSERT_ORDER) await this.upsertRows(t, upserts[t] as object[]);
    for (const t of DELETE_LAST) await this.deleteKeys(t, deletes[t]);
  }

  private async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.q(this.writer, 'START TRANSACTION');
    try {
      const out = await fn();
      await this.q(this.writer, 'COMMIT');
      return out;
    } catch (e) {
      try {
        await this.writer.query('ROLLBACK');
      } catch {
        // connection may be gone; the working set is untouched in that case
      }
      throw e;
    }
  }

  async applyChange(diff: RowDiff, side: SideWrites, action: ActionRecord): Promise<number> {
    this.assertWritableBranch();
    await this.useBranch(this._branch);
    return this.inTransaction(async () => {
      const cs = await this.committedSeq();
      // A new operation after undo discards the undone tail (linear history).
      await this.q(this.writer, 'DELETE FROM action_log WHERE undone = TRUE AND seq > ?', [cs]);

      await this.applyRowSet(diff.upserts, diff.deletes);

      const undo: Record<string, unknown> = { before: diff.before, inserted: diff.inserted };
      if (side.clientMetaUpserts?.length) {
        const ids = side.clientMetaUpserts.map((m) => m.part_id);
        const prev = await this.q(this.writer, `SELECT part_id, doc FROM client_meta WHERE part_id IN (${ids.map(() => '?').join(', ')})`, ids);
        const prevById = new Map(prev.map((r) => [String(r['part_id']), parseJson(r['doc'])]));
        undo['clientMetaBefore'] = ids.map((id) => ({ part_id: id, doc: prevById.get(id) ?? null }));
        for (const m of side.clientMetaUpserts) {
          await this.q(this.writer, 'INSERT INTO client_meta (part_id, doc) VALUES (?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc)', [
            m.part_id,
            JSON.stringify(m.doc),
          ]);
        }
      }
      if (side.settingsPatch && Object.keys(side.settingsPatch).length > 0) {
        const prev = await this.q(this.writer, 'SELECT manufacturing_profile, manufacturing_defaults, nesting FROM project_settings WHERE id = 1');
        undo['settingsBefore'] = Object.fromEntries(Object.keys(side.settingsPatch).map((k) => [k, parseJson(prev[0]?.[k])]));
        for (const [k, v] of Object.entries(side.settingsPatch)) {
          await this.q(this.writer, `UPDATE project_settings SET ${quoteIdent(k)} = ? WHERE id = 1`, [v === null ? null : JSON.stringify(v)]);
        }
      }
      if (side.importSource) {
        const s = side.importSource;
        await this.q(
          this.writer,
          'INSERT INTO import_source (import_source_id, file_path, file_sha256, config, measured_thickness_mm, imported_at) VALUES (?, ?, ?, ?, ?, NOW(3))',
          [s.import_source_id, s.file_path, s.file_sha256, JSON.stringify(s.config), s.measured_thickness_mm],
        );
        undo['importSourceInserted'] = s.import_source_id;
      }

      await this.q(
        this.writer,
        `INSERT INTO action_log (at, actor_kind, actor_id, tool, params, delta_summary, undo_delta, undone)
         VALUES (NOW(3), ?, ?, ?, ?, ?, ?, FALSE)`,
        [action.actorKind, action.actorId, action.tool, JSON.stringify(action.params), JSON.stringify(action.deltaSummary), JSON.stringify(undo)],
      );
      const id = await this.q(this.writer, 'SELECT LAST_INSERT_ID() AS id');
      return Number(id[0]?.['id']);
    });
  }

  async undoLast(): Promise<number> {
    this.assertWritableBranch();
    await this.useBranch(this._branch);
    return this.inTransaction(async () => {
      const cs = await this.committedSeq();
      const r = await this.q(
        this.writer,
        'SELECT seq, actor_kind, undo_delta FROM action_log WHERE undone = FALSE AND seq > ? ORDER BY seq DESC LIMIT 1',
        [cs],
      );
      if (r.length === 0) throwError(ErrorCodes.UNDO_NOTHING_UNCOMMITTED, 'nothing to undo since the last commit', true);
      const row = r[0]!;
      if (row['actor_kind'] === 'system') {
        throwError(ErrorCodes.UNDO_BLOCKED_BY_MIGRATION, 'the next operation to undo is a schema migration, which cannot be undone; commit or discard instead', true);
      }
      const undo = parseJson(row['undo_delta']) as {
        before: GraphRows;
        inserted: Record<GraphTable, string[]>;
        clientMetaBefore?: Array<{ part_id: string; doc: Record<string, unknown> | null }>;
        settingsBefore?: Record<string, unknown>;
        importSourceInserted?: string;
      };
      const before = { ...emptyRows(), ...undo.before };
      await this.applyRowSet(before, { ...emptyDeletes(), ...undo.inserted });
      for (const m of undo.clientMetaBefore ?? []) {
        if (m.doc === null) await this.q(this.writer, 'DELETE FROM client_meta WHERE part_id = ?', [m.part_id]);
        else await this.q(this.writer, 'INSERT INTO client_meta (part_id, doc) VALUES (?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc)', [m.part_id, JSON.stringify(m.doc)]);
      }
      for (const [k, v] of Object.entries(undo.settingsBefore ?? {})) {
        await this.q(this.writer, `UPDATE project_settings SET ${quoteIdent(k)} = ? WHERE id = 1`, [v === null ? null : JSON.stringify(v)]);
      }
      if (undo.importSourceInserted) {
        await this.q(this.writer, 'DELETE FROM import_source WHERE import_source_id = ?', [undo.importSourceInserted]);
      }
      const seq = Number(row['seq']);
      await this.q(this.writer, 'UPDATE action_log SET undone = TRUE WHERE seq = ?', [seq]);
      return seq;
    });
  }

  async commit(message: string): Promise<{ commitHash: string; ops: number }> {
    this.assertWritableBranch();
    await this.useBranch(this._branch);
    if (!(await isDirty(this.writer))) throwError(ErrorCodes.COMMIT_NOTHING_TO_COMMIT, 'there are no uncommitted changes', true);
    const cs = await this.committedSeq();
    // Undone operations are not part of the revision.
    await this.q(this.writer, 'DELETE FROM action_log WHERE undone = TRUE AND seq > ?', [cs]);
    const counts = await this.q(
      this.writer,
      "SELECT COUNT(*) AS n, COALESCE(SUM(actor_kind = 'agent'), 0) AS agent, COALESCE(MAX(seq), ?) AS max_seq FROM action_log WHERE seq > ?",
      [cs, cs],
    );
    const ops = Number(counts[0]?.['n'] ?? 0);
    const agentOps = Number(counts[0]?.['agent'] ?? 0);
    const maxSeq = Number(counts[0]?.['max_seq'] ?? cs);
    await this.q(this.writer, "UPDATE meta SET meta_value = ? WHERE meta_key = 'committed_seq'", [String(maxSeq)]);
    const full = `${message.trim()}\n\n[formaition] ops=${ops} agent_ops=${agentOps}`;
    await this.q(this.writer, "CALL DOLT_COMMIT('-A', '--author', ?, '-m', ?)", [this.authorString, full]);
    const head = await this.q(this.writer, "SELECT HASHOF('HEAD') AS h");
    return { commitHash: String(head[0]?.['h']), ops };
  }

  async discardChanges(): Promise<void> {
    this.assertWritableBranch();
    await this.useBranch(this._branch);
    // RESET --hard alone keeps new untracked tables (T018 finding).
    await this.q(this.writer, "CALL DOLT_RESET('--hard')");
    await this.q(this.writer, 'CALL DOLT_CLEAN()');
  }

  // ─── Branches ─────────────────────────────────────────────────────────────

  private async wipBranches(): Promise<string[]> {
    const r = await this.q(this.writer, `SELECT name FROM ${quoteIdent(`${this.database}/main`)}.dolt_branches WHERE name LIKE 'wip/%'`);
    return r.map((x) => String(x['name']));
  }

  private async branchDirty(branch: string): Promise<boolean> {
    const r = await this.q(this.writer, `SELECT COUNT(*) AS n FROM ${quoteIdent(`${this.database}/${branch}`)}.dolt_status`);
    return Number(r[0]?.['n'] ?? 0) > 0;
  }

  private async unmergedCommits(branch: string): Promise<number> {
    try {
      const r = await this.q(this.writer, 'SELECT COUNT(*) AS n FROM DOLT_LOG(?)', [`main..${branch}`]);
      return Number(r[0]?.['n'] ?? 0);
    } catch {
      return 0;
    }
  }

  async branchBegin(label: string, replaceExisting: boolean): Promise<{ branch: string; forkedFrom: string }> {
    if (!BRANCH_LABEL.test(label)) throwError(ErrorCodes.PERSIST_WRITE_FAILED, `invalid branch label '${label}'`, false);
    const existing = await this.wipBranches();
    if (existing.length > 0) {
      const b = existing[0]!;
      if (!replaceExisting) {
        throwError(ErrorCodes.BRANCH_ALREADY_OPEN, `working branch ${b} is already open`, true, undefined, {
          details: { branch: b, unmerged_commits: await this.unmergedCommits(b) },
        });
      }
      if (await this.branchDirty(b)) {
        throwError(ErrorCodes.COMMIT_UNCOMMITTED_CHANGES, `working branch ${b} has uncommitted changes; it is never replaced`, true);
      }
    }
    const forkedFrom = this._readOnlyRef ?? this._branch;
    if (this._readOnlyRef === null && (await this.branchDirty(this._branch))) {
      throwError(ErrorCodes.COMMIT_UNCOMMITTED_CHANGES, `branch ${this._branch} has uncommitted changes`, true);
    }
    await this.useBranch('main');
    // Resolve the fork point to a commit BEFORE deleting anything: when
    // replacing, the fork point may be the very branch being replaced.
    const forkHash = await this.q(this.writer, 'SELECT HASHOF(?) AS h', [forkedFrom]);
    const name = `wip/${label}`;
    await this.q(this.writer, 'CALL DOLT_BRANCH(?, ?)', [name, String(forkHash[0]?.['h'])]);
    for (const b of existing) if (b !== name) await this.q(this.writer, "CALL DOLT_BRANCH('-D', ?)", [b]);
    await this.useBranch(name);
    this._readOnlyRef = null;
    await this.writeSessionBranch(name);
    return { branch: name, forkedFrom };
  }

  async branchMerge(message: string): Promise<{ mergeCommit: string }> {
    if (!this._branch.startsWith('wip/') || this._readOnlyRef !== null) {
      throwError(ErrorCodes.BRANCH_NONE_OPEN, 'no working branch is checked out', true);
    }
    const wip = this._branch;
    if (await this.branchDirty(wip)) {
      throwError(ErrorCodes.COMMIT_UNCOMMITTED_CHANGES, 'commit or discard the uncommitted changes before merging', true);
    }
    await this.useBranch('main');
    const r = await this.q(this.writer, "CALL DOLT_MERGE('--no-ff', '--author', ?, '-m', ?, ?)", [this.authorString, message, wip]);
    const conflicts = Number(r[0]?.['conflicts'] ?? 0);
    if (conflicts > 0) {
      await this.writer.query("CALL DOLT_MERGE('--abort')").catch(() => undefined);
      await this.useBranch(wip);
      throwError(ErrorCodes.BRANCH_MERGE_CONFLICT, `merging ${wip} into main produced ${conflicts} conflicts; nothing was merged`, false);
    }
    await this.q(this.writer, "CALL DOLT_BRANCH('-D', ?)", [wip]);
    await this.writeSessionBranch('main');
    const head = await this.q(this.writer, "SELECT HASHOF('HEAD') AS h");
    return { mergeCommit: String(head[0]?.['h']) };
  }

  async branchDiscard(): Promise<void> {
    const existing = await this.wipBranches();
    if (existing.length === 0) throwError(ErrorCodes.BRANCH_NONE_OPEN, 'no working branch exists', true);
    await this.useBranch('main');
    for (const b of existing) await this.q(this.writer, "CALL DOLT_BRANCH('-D', ?)", [b]);
    this._readOnlyRef = null;
    await this.writeSessionBranch('main');
  }

  async checkout(ref: string): Promise<{ migrated: boolean }> {
    if (this._readOnlyRef === null && (await this.branchDirty(this._branch))) {
      throwError(ErrorCodes.COMMIT_UNCOMMITTED_CHANGES, `branch ${this._branch} has uncommitted changes; commit or discard first`, true);
    }
    const branches = await this.q(this.writer, `SELECT name FROM ${quoteIdent(`${this.database}/main`)}.dolt_branches WHERE name = ?`, [ref]);
    if (branches.length > 0) {
      const res = await migrateBranch(this.writer, this.database, ref);
      this._branch = ref;
      this._readOnlyRef = null;
      await this.writeSessionBranch(ref);
      return { migrated: res.mode !== 'none' };
    }
    // dolt_commits lists every commit in the database, on any branch.
    const exists = await this.q(this.writer, `SELECT commit_hash FROM ${quoteIdent(`${this.database}/main`)}.dolt_commits WHERE commit_hash = ?`, [ref]);
    if (exists.length === 0) throwError(ErrorCodes.REVISION_NOT_FOUND, `no branch or commit '${ref}'`, true);
    this._readOnlyRef = ref;
    return { migrated: false };
  }

  // ─── History ──────────────────────────────────────────────────────────────

  async history(limit: number): Promise<HistoryResult> {
    const st = await this.status();
    const branches = await this.q(this.writer, `SELECT name, hash FROM ${quoteIdent(`${this.database}/main`)}.dolt_branches`);
    const ref = this._readOnlyRef ?? this._branch;
    const log = await this.q(
      this.reader,
      `SELECT commit_hash, committer, email, date, message FROM DOLT_LOG(?) LIMIT ${Math.max(1, Math.min(limit, 500))}`,
      [ref],
    ).catch(async () =>
      this.q(this.writer, `SELECT commit_hash, committer, email, date, message FROM dolt_log LIMIT ${Math.max(1, Math.min(limit, 500))}`),
    );
    const hashes = log.map((r) => String(r['commit_hash']));
    const parents = new Map<string, string[]>();
    if (hashes.length > 0) {
      const anc = await this.q(
        this.writer,
        `SELECT commit_hash, parent_hash, parent_index FROM ${quoteIdent(`${this.database}/main`)}.dolt_commit_ancestors WHERE commit_hash IN (${hashes.map(() => '?').join(', ')}) ORDER BY parent_index`,
        hashes,
      ).catch(() => []);
      for (const a of anc) {
        const k = String(a['commit_hash']);
        const list = parents.get(k) ?? [];
        if (a['parent_hash']) list.push(String(a['parent_hash']));
        parents.set(k, list);
      }
    }
    const commits: HistoryCommit[] = log.map((r) => {
      const raw = String(r['message'] ?? '');
      const m = OPS_TRAILER.exec(raw);
      return {
        hash: String(r['commit_hash']),
        parents: parents.get(String(r['commit_hash'])) ?? [],
        date: new Date(r['date'] as string | Date).toISOString(),
        author_name: String(r['committer'] ?? ''),
        author_email: String(r['email'] ?? ''),
        message: m ? raw.slice(0, m.index) : raw,
        op_count: m ? Number(m[1]) : 0,
        agent_op_count: m ? Number(m[2]) : 0,
      };
    });
    return {
      current_branch: this._readOnlyRef ?? this._branch,
      head_commit: st.headCommit,
      dirty: st.dirty,
      uncommitted_ops: st.uncommittedOps,
      branches: branches.map((b) => ({ name: String(b['name']), head_commit: String(b['hash']) })),
      commits,
    };
  }

  async actionsAt(ref: string): Promise<ActionEntry[]> {
    let rows: RowDataPacket[];
    if (ref === 'WORKING') {
      if (this._readOnlyRef !== null) return [];
      await this.useBranch(this._branch);
      const cs = await this.committedSeq();
      rows = await this.q(this.writer, 'SELECT seq, at, actor_kind, actor_id, tool, delta_summary, undone FROM action_log WHERE seq > ? ORDER BY seq', [cs]);
    } else {
      // Operations introduced by `ref`: seq in (committed_seq at first parent, committed_seq at ref].
      const db = quoteIdent(this.database);
      const at = await this.q(this.reader, `SELECT meta_value FROM ${db}.meta AS OF ? WHERE meta_key = 'committed_seq'`, [ref]);
      const hi = Number(at[0]?.['meta_value'] ?? 0);
      // A raw commit hash (32 base32 chars) is used as is; a branch name is
      // resolved through dolt_branches. Failures are never swallowed: a wrong
      // lower bound would list older commits' operations as this one's.
      const hash = /^[0-9a-v]{32}$/.test(ref) ? ref : String((await this.q(this.reader, `SELECT hash FROM ${db}.dolt_branches WHERE name = ?`, [ref]))[0]?.['hash'] ?? '');
      const parent = await this.q(this.reader, `SELECT parent_hash FROM ${db}.dolt_commit_ancestors WHERE commit_hash = ? AND parent_index = 0`, [hash]);
      let lo = 0;
      if (parent[0]?.['parent_hash']) {
        const p = await this.q(this.reader, `SELECT meta_value FROM ${db}.meta AS OF ? WHERE meta_key = 'committed_seq'`, [String(parent[0]['parent_hash'])]);
        lo = Number(p[0]?.['meta_value'] ?? 0);
      }
      rows = await this.q(
        this.reader,
        `SELECT seq, at, actor_kind, actor_id, tool, delta_summary, undone FROM ${db}.action_log AS OF ? WHERE seq > ? AND seq <= ? ORDER BY seq`,
        [ref, lo, hi],
      );
    }
    return rows.map((r) => ({
      seq: Number(r['seq']),
      at: new Date(r['at'] as string | Date).toISOString(),
      actor_kind: String(r['actor_kind']) as ActionEntry['actor_kind'],
      actor_id: String(r['actor_id']),
      tool: String(r['tool']),
      delta_summary: parseJson(r['delta_summary']) ?? {},
      undone: Boolean(Number(r['undone'])),
    }));
  }

  async close(): Promise<void> {
    await this.writer?.end().catch(() => undefined);
    await this.reader?.end().catch(() => undefined);
  }
}

function emptyDeletes(): Record<GraphTable, string[]> {
  return { part: [], part_ring: [], ring_vertex: [], feature: [], region_panel: [], bend: [] };
}

// ─── Account-level project operations (no binding) ───────────────────────────

const DB_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function assertProjectDatabaseName(account: StorageAccount, database: string): void {
  if (!DB_NAME.test(database) || !database.startsWith(account.database_prefix)) {
    throwError(
      ErrorCodes.PROJECT_DATABASE_NAME_INVALID,
      `database name '${database}' must match ^[a-z][a-z0-9_]{0,63}$ and start with '${account.database_prefix}'`,
      false,
    );
  }
}

async function adminConnection(account: StorageAccount): Promise<Connection> {
  try {
    return await mysql.createConnection(connectionOptions(account));
  } catch (e) {
    storageErrorFrom(e, account, 'connect');
  }
}

export async function createProjectDatabase(account: StorageAccount, database: string, name: string): Promise<void> {
  assertProjectDatabaseName(account, database);
  const c = await adminConnection(account);
  try {
    const [exists] = await c.query<RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    if (exists.length > 0) throwError(ErrorCodes.PROJECT_DATABASE_EXISTS, `project database '${database}' already exists`, false);
    await c.query(`CREATE DATABASE ${quoteIdent(database)}`);
    await migrateForOpen(c, database, 'main');
    await c.query(`USE ${quoteIdent(`${database}/main`)}`);
    await c.query(
      "INSERT INTO meta (meta_key, meta_value) VALUES ('project_name', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)",
      [name],
    );
    await c.query("CALL DOLT_COMMIT('-A', '--author', ?, '-m', ?)", ['Form·AI·tion system <system@formaition.local>', `Create project ${name}`]);
    await c.query("INSERT INTO session_state (id, current_branch) VALUES (1, 'main')");
  } catch (e) {
    if ((e as { structured?: unknown }).structured) throw e;
    storageErrorFrom(e, account, 'write');
  } finally {
    await c.end().catch(() => undefined);
  }
}

export async function dropProjectDatabase(account: StorageAccount, database: string): Promise<void> {
  assertProjectDatabaseName(account, database);
  const c = await adminConnection(account);
  try {
    await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
  } catch (e) {
    storageErrorFrom(e, account, 'write');
  } finally {
    await c.end().catch(() => undefined);
  }
}

export async function listProjectDatabases(account: StorageAccount): Promise<Array<{ database: string; name: string }>> {
  const c = await adminConnection(account);
  try {
    const [dbs] = await c.query<RowDataPacket[]>('SELECT SCHEMA_NAME AS db FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?', [
      `${account.database_prefix}%`,
    ]);
    const out: Array<{ database: string; name: string }> = [];
    for (const d of dbs) {
      const db = String(d['db']);
      if (db.includes('/')) continue; // branch-qualified revision databases
      try {
        const [n] = await c.query<RowDataPacket[]>(`SELECT meta_value FROM ${quoteIdent(`${db}/main`)}.meta WHERE meta_key = 'project_name'`);
        out.push({ database: db, name: n[0] ? String(n[0]['meta_value']) : db });
      } catch {
        out.push({ database: db, name: db });
      }
    }
    return out;
  } catch (e) {
    storageErrorFrom(e, account, 'connect');
  } finally {
    await c.end().catch(() => undefined);
  }
}

export { redactSecrets };
