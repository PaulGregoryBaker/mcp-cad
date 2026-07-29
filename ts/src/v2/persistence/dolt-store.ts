/**
 * v2/persistence/dolt-store.ts — Dolt-backed persistence for v2 GraphStore.
 *
 * Slice 10 (rebuild/06-plan.md): commit, restore, branch, merge_branch.
 * One table per graph entity (matching 14-graph-schema.md §2 row-per-entity
 * model), stored as JSON for Dolt row-level diffability.
 *
 * Gated behind DOLT_HOST/DOLT_PORT env vars — when absent, the in-memory-only
 * GraphStore is used (no persistence), same as today.
 */

import mysql, { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise';
import type { PartGraphSnapshot } from '../graph/store';

// ─── Row shapes ───────────────────────────────────────────────────────────

interface V2PartRow extends RowDataPacket {
  part_id: string;
  graph_json: string;  // JSON-serialized PartGraphSnapshot
}

interface DoltLogRow extends RowDataPacket {
  commit_hash: string;
  committer: string;
  message: string;
  date: Date;
}

// ─── Options ──────────────────────────────────────────────────────────────

export interface V2DoltStoreOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// ─── Store ────────────────────────────────────────────────────────────────

export class V2DoltStore {
  private pool: Pool | null = null;
  private connected = false;

  constructor(private readonly options: V2DoltStoreOptions) {}

  async connect(): Promise<void> {
    const poolOpts: PoolOptions = {
      host: this.options.host,
      port: this.options.port,
      user: this.options.user,
      password: this.options.password,
      database: this.options.database,
      connectionLimit: 3,
    };
    this.pool = mysql.createPool(poolOpts);
    // Verify connectivity
    const conn = await this.pool.getConnection();
    conn.release();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private requirePool(): Pool {
    if (!this.pool) throw new Error('V2DoltStore not connected');
    return this.pool;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async savePart(partId: string, snapshot: PartGraphSnapshot): Promise<void> {
    const pool = this.requirePool();
    const json = JSON.stringify(snapshot);
    await pool.query(
      `INSERT INTO v2_part (part_id, graph_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE graph_json = VALUES(graph_json)`,
      [partId, json],
    );
  }

  async loadPart(partId: string): Promise<PartGraphSnapshot | null> {
    const pool = this.requirePool();
    const [rows] = await pool.query<V2PartRow[]>(
      'SELECT graph_json FROM v2_part WHERE part_id = ? LIMIT 1',
      [partId],
    );
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].graph_json) as PartGraphSnapshot;
  }

  async listPartIds(): Promise<string[]> {
    const pool = this.requirePool();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT part_id FROM v2_part WHERE merged_into_part_id IS NULL',
    );
    return rows.map((r) => r.part_id as string);
  }

  // ── Dolt version control ────────────────────────────────────────────────

  async doltCommit(message: string): Promise<string> {
    const pool = this.requirePool();
    await pool.query("CALL DOLT_COMMIT('-A', '-m', ?)", [message]);
    // Read back the commit hash
    const [rows] = await pool.query<DoltLogRow[]>(
      'SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1',
    );
    return rows[0]?.commit_hash ?? '';
  }

  async doltCheckout(ref: string): Promise<void> {
    const pool = this.requirePool();
    await pool.query('CALL DOLT_CHECKOUT(?)', [ref]);
  }

  async doltBranch(name: string, fromRef?: string): Promise<void> {
    const pool = this.requirePool();
    if (fromRef) {
      await pool.query('CALL DOLT_BRANCH(?, ?)', [name, fromRef]);
    } else {
      await pool.query('CALL DOLT_BRANCH(?)', [name]);
    }
  }

  async doltMerge(branch: string): Promise<void> {
    const pool = this.requirePool();
    await pool.query('CALL DOLT_MERGE(?)', [branch]);
  }

  async listCommits(): Promise<Array<{ hash: string; message: string; date: string }>> {
    const pool = this.requirePool();
    const [rows] = await pool.query<DoltLogRow[]>(
      'SELECT commit_hash, message, date FROM dolt_log ORDER BY date DESC LIMIT 50',
    );
    return rows.map((r) => ({
      hash: r.commit_hash,
      message: r.message,
      date: r.date instanceof Date ? r.date.toISOString() : String(r.date),
    }));
  }
}
