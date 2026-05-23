/**
 * DoltAdapter — mysql2/promise implementation of SemanticPersistencePort.
 *
 * JSON strategy (T015 decision): The `MEMBER OF` / `JSON_TABLE` predicates
 * from Dolt-MySQL were tested against Dolt v1.x. `MEMBER OF` is supported
 * (MySQL 8.0+ syntax), but `JSON_TABLE` cross-join rewrites produced plan
 * regressions on Prolly-tree storage. Strategy: use app-side joins for the
 * remap query at commit time (see MappingLayer.applyShapeHistoryToBindings).
 * Plain `JSON_CONTAINS` is used for face-ID membership checks inside single
 * rows where a full index-join is not needed.
 */

import mysql, { type Connection, type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise';
import type { SemanticPersistencePort, InsertEntityInput, InsertMappingInput, InsertTopologyRevisionInput } from './port';
import type {
  Binding,
  EntityType,
  RelationshipType,
  SemanticEntity,
  SemanticMapping,
  ShapeHistoryRecord,
  TopologyRevision,
  Transaction,
  TransactionState,
} from './types';

export interface DoltAdapterOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
}

// ─── Row shapes from mysql2 ───────────────────────────────────────────────────

interface EntityRow extends RowDataPacket {
  id: string;
  type: EntityType;
  purpose_json: string | null;
  state: string;
  created_in_transaction: string;
  created_at: Date;
}

interface MappingRow extends RowDataPacket {
  revision_id: number;
  semantic_id: string;
  binding_kind: string;
  binding_json: string;
  topology_revision: number;
  created_in_transaction: string;
  created_at: Date;
  remap_reason: string | null;
}

interface TopologyRevisionRow extends RowDataPacket {
  id: number;
  transaction_id: string;
  brep_file_path: string;
  brep_sha256: string;
  created_at: Date;
}

interface TransactionRow extends RowDataPacket {
  id: string;
  label: string;
  product: string;
  state: TransactionState;
  started_at: Date;
  ended_at: Date | null;
}

interface ShapeHistoryRow extends RowDataPacket {
  transaction_id: string;
  verdict: string;
  original_id: string;
  new_id: string | null;
  operation_label: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Dolt may return JSON columns either as raw strings or as already-parsed
// objects depending on driver / column metadata. Accept both.
function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rowToEntity(row: EntityRow): SemanticEntity {
  return {
    id: row.id,
    type: row.type,
    purpose: row.purpose_json ? parseJson<SemanticEntity['purpose']>(row.purpose_json) : undefined,
    state: row.state as SemanticEntity['state'],
    created_in_transaction: row.created_in_transaction,
    created_at: row.created_at,
  };
}

function rowToMapping(row: MappingRow): SemanticMapping {
  return {
    revision_id: row.revision_id,
    semantic_id: row.semantic_id,
    binding_kind: row.binding_kind as SemanticMapping['binding_kind'],
    binding: parseJson<Binding>(row.binding_json),
    topology_revision: row.topology_revision,
    created_in_transaction: row.created_in_transaction,
    created_at: row.created_at,
    remap_reason: row.remap_reason,
  };
}

function rowToTopologyRevision(row: TopologyRevisionRow): TopologyRevision {
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    brep_file_path: row.brep_file_path,
    brep_sha256: row.brep_sha256,
    created_at: row.created_at,
  };
}

function rowToTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    label: row.label,
    product: row.product,
    state: row.state,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class DoltAdapter implements SemanticPersistencePort {
  protected pool: Pool;
  protected _asOfRef: string | null = null;

  constructor(options: DoltAdapterOptions) {
    const poolOpts: PoolOptions = {
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit: options.connectionLimit ?? 5,
      timezone: '+00:00',
    };
    this.pool = mysql.createPool(poolOpts);
  }

  async connect(): Promise<void> {
    // Verify connectivity by acquiring and releasing one connection.
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  // ── Dolt branch operations ────────────────────────────────────────────────

  async checkoutBranch(branch: string, createIfAbsent = false): Promise<void> {
    const flag = createIfAbsent ? '-b' : '';
    const args = flag ? [flag, branch] : [branch];
    await this.pool.query(`CALL DOLT_CHECKOUT(${args.map(() => '?').join(',')})`, args);
  }

  async mergeBranch(branch: string): Promise<void> {
    await this.pool.query('CALL DOLT_MERGE(?, ?)', [branch, '--no-ff']);
    await this.pool.query("CALL DOLT_COMMIT('-m', ?)", [`merge ${branch}`]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    const flag = force ? '-D' : '-d';
    await this.pool.query('CALL DOLT_BRANCH(?, ?)', [flag, branch]);
  }

  // ── SQL transaction ───────────────────────────────────────────────────────

  async transaction<T>(callback: (port: SemanticPersistencePort) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    await conn.beginTransaction();
    const txPort = new ConnectionScopedAdapter(conn, this._asOfRef);
    try {
      const result = await callback(txPort);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  asOf(commitRef: string): SemanticPersistencePort {
    return new AsOfDoltAdapter(this.pool, commitRef);
  }

  // ── semantic_entity ───────────────────────────────────────────────────────

  async insertEntity(input: InsertEntityInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO semantic_entity (id, type, purpose_json, state, created_in_transaction, created_at)
       VALUES (?, ?, ?, 'confirmed', ?, NOW(3))`,
      [
        input.id,
        input.type,
        input.purpose ? JSON.stringify(input.purpose) : null,
        input.transaction_id,
      ],
    );
  }

  async findEntity(id: string): Promise<SemanticEntity | null> {
    const [rows] = await this.pool.query<EntityRow[]>(
      'SELECT * FROM semantic_entity WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as EntityRow[])[0];
    return row ? rowToEntity(row) : null;
  }

  // ── semantic_relationship ─────────────────────────────────────────────────

  async insertRelationship(
    sourceId: string,
    rel: RelationshipType,
    targetId: string,
    transactionId: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO semantic_relationship (source_id, relationship, target_id, created_in_transaction, created_at)
       VALUES (?, ?, ?, ?, NOW(3))`,
      [sourceId, rel, targetId, transactionId],
    );
  }

  // ── semantic_mapping ──────────────────────────────────────────────────────

  async insertMapping(input: InsertMappingInput): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO semantic_mapping (semantic_id, binding_kind, binding_json, topology_revision, created_in_transaction, created_at, remap_reason)
       VALUES (?, ?, ?, ?, ?, NOW(3), ?)`,
      [
        input.semantic_id,
        input.binding.kind,
        JSON.stringify(input.binding),
        input.topology_revision,
        input.transaction_id,
        input.remap_reason ?? null,
      ],
    );
    return (result as mysql.ResultSetHeader).insertId;
  }

  async getCurrentMappingsForEntity(semanticId: string): Promise<SemanticMapping | null> {
    const [rows] = await this.pool.query<MappingRow[]>(
      'SELECT * FROM semantic_mapping WHERE semantic_id = ? ORDER BY revision_id DESC LIMIT 1',
      [semanticId],
    );
    const row = (rows as MappingRow[])[0];
    return row ? rowToMapping(row) : null;
  }

  async getMappingHistory(semanticId: string): Promise<SemanticMapping[]> {
    const [rows] = await this.pool.query<MappingRow[]>(
      'SELECT * FROM semantic_mapping WHERE semantic_id = ? ORDER BY revision_id ASC',
      [semanticId],
    );
    return (rows as MappingRow[]).map(rowToMapping);
  }

  async getAllCurrentMappings(): Promise<SemanticMapping[]> {
    const [rows] = await this.pool.query<MappingRow[]>(
      `SELECT sm.*
       FROM semantic_mapping sm
       INNER JOIN (
         SELECT semantic_id, MAX(revision_id) AS max_rev
         FROM semantic_mapping
         GROUP BY semantic_id
       ) latest ON sm.semantic_id = latest.semantic_id AND sm.revision_id = latest.max_rev`,
    );
    return (rows as MappingRow[]).map(rowToMapping);
  }

  // ── shape_history ─────────────────────────────────────────────────────────

  async insertShapeHistory(records: ShapeHistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Dolt PK requires new_id NOT NULL; persist null as '' (deleted-row sentinel).
    const values = records.map((r) => [
      r.transaction_id,
      r.verdict,
      r.original_id,
      r.new_id ?? '',
      r.operation_label,
    ]);
    await this.pool.query(
      `INSERT IGNORE INTO shape_history (transaction_id, verdict, original_id, new_id, operation_label)
       VALUES ?`,
      [values],
    );
  }

  async getShapeHistoryForTransaction(transactionId: string): Promise<ShapeHistoryRecord[]> {
    const [rows] = await this.pool.query<ShapeHistoryRow[]>(
      'SELECT * FROM shape_history WHERE transaction_id = ?',
      [transactionId],
    );
    return (rows as ShapeHistoryRow[]).map((r) => ({
      transaction_id: r.transaction_id,
      verdict: r.verdict as ShapeHistoryRecord['verdict'],
      original_id: r.original_id,
      // '' sentinel maps back to null at the TS boundary.
      new_id: r.new_id === '' ? null : r.new_id,
      operation_label: r.operation_label,
    }));
  }

  // ── topology_revision ─────────────────────────────────────────────────────

  async insertTopologyRevision(input: InsertTopologyRevisionInput): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO topology_revision (transaction_id, brep_file_path, brep_sha256, created_at)
       VALUES (?, ?, ?, NOW(3))`,
      [input.transaction_id, input.brep_file_path, input.brep_sha256],
    );
    return (result as mysql.ResultSetHeader).insertId;
  }

  async getTopologyRevision(id: number): Promise<TopologyRevision | null> {
    const [rows] = await this.pool.query<TopologyRevisionRow[]>(
      'SELECT * FROM topology_revision WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as TopologyRevisionRow[])[0];
    return row ? rowToTopologyRevision(row) : null;
  }

  async getTopologyRevisionByTransaction(transactionId: string): Promise<TopologyRevision | null> {
    const [rows] = await this.pool.query<TopologyRevisionRow[]>(
      'SELECT * FROM topology_revision WHERE transaction_id = ? LIMIT 1',
      [transactionId],
    );
    const row = (rows as TopologyRevisionRow[])[0];
    return row ? rowToTopologyRevision(row) : null;
  }

  // ── transaction table ─────────────────────────────────────────────────────

  async insertTransaction(tx: Omit<Transaction, 'ended_at'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO \`transaction\` (id, label, product, state, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      [tx.id, tx.label, tx.product, tx.state, tx.started_at],
    );
  }

  async updateTransactionState(
    id: string,
    state: TransactionState,
    endedAt?: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE \`transaction\` SET state = ?, ended_at = ? WHERE id = ?`,
      [state, endedAt ?? null, id],
    );
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    const [rows] = await this.pool.query<TransactionRow[]>(
      'SELECT * FROM `transaction` WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as TransactionRow[])[0];
    return row ? rowToTransaction(row) : null;
  }

}

// ─── Connection-scoped adapter (for SQL transactions) ────────────────────────

class ConnectionScopedAdapter implements SemanticPersistencePort {
  constructor(
    private conn: Connection,
    private _asOfRef: string | null,
  ) {}

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async checkoutBranch(branch: string, createIfAbsent = false): Promise<void> {
    const flag = createIfAbsent ? '-b' : '';
    const args = flag ? [flag, branch] : [branch];
    await this.conn.query(`CALL DOLT_CHECKOUT(${args.map(() => '?').join(',')})`, args);
  }

  async mergeBranch(branch: string): Promise<void> {
    await this.conn.query('CALL DOLT_MERGE(?, ?)', [branch, '--no-ff']);
    await this.conn.query("CALL DOLT_COMMIT('-m', ?)", [`merge ${branch}`]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    const flag = force ? '-D' : '-d';
    await this.conn.query('CALL DOLT_BRANCH(?, ?)', [flag, branch]);
  }

  async transaction<T>(callback: (port: SemanticPersistencePort) => Promise<T>): Promise<T> {
    return callback(this);
  }

  asOf(commitRef: string): SemanticPersistencePort {
    return new ConnectionScopedAdapter(this.conn, commitRef);
  }

  async insertEntity(input: InsertEntityInput): Promise<void> {
    await this.conn.query(
      `INSERT INTO semantic_entity (id, type, purpose_json, state, created_in_transaction, created_at)
       VALUES (?, ?, ?, 'confirmed', ?, NOW(3))`,
      [input.id, input.type, input.purpose ? JSON.stringify(input.purpose) : null, input.transaction_id],
    );
  }

  async findEntity(id: string): Promise<SemanticEntity | null> {
    const [rows] = await this.conn.query<EntityRow[]>(
      'SELECT * FROM semantic_entity WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as EntityRow[])[0];
    return row ? rowToEntity(row) : null;
  }

  async insertRelationship(
    sourceId: string,
    rel: RelationshipType,
    targetId: string,
    transactionId: string,
  ): Promise<void> {
    await this.conn.query(
      `INSERT INTO semantic_relationship (source_id, relationship, target_id, created_in_transaction, created_at)
       VALUES (?, ?, ?, ?, NOW(3))`,
      [sourceId, rel, targetId, transactionId],
    );
  }

  async insertMapping(input: InsertMappingInput): Promise<number> {
    const [result] = await this.conn.query<mysql.ResultSetHeader>(
      `INSERT INTO semantic_mapping (semantic_id, binding_kind, binding_json, topology_revision, created_in_transaction, created_at, remap_reason)
       VALUES (?, ?, ?, ?, ?, NOW(3), ?)`,
      [
        input.semantic_id,
        input.binding.kind,
        JSON.stringify(input.binding),
        input.topology_revision,
        input.transaction_id,
        input.remap_reason ?? null,
      ],
    );
    return (result as mysql.ResultSetHeader).insertId;
  }

  async getCurrentMappingsForEntity(semanticId: string): Promise<SemanticMapping | null> {
    const ref = this._asOfRef;
    const sql = ref
      ? 'SELECT * FROM semantic_mapping AS OF ? WHERE semantic_id = ? ORDER BY revision_id DESC LIMIT 1'
      : 'SELECT * FROM semantic_mapping WHERE semantic_id = ? ORDER BY revision_id DESC LIMIT 1';
    const params = ref ? [ref, semanticId] : [semanticId];
    const [rows] = await this.conn.query<MappingRow[]>(sql, params);
    const row = (rows as MappingRow[])[0];
    return row ? rowToMapping(row) : null;
  }

  async getMappingHistory(semanticId: string): Promise<SemanticMapping[]> {
    const [rows] = await this.conn.query<MappingRow[]>(
      'SELECT * FROM semantic_mapping WHERE semantic_id = ? ORDER BY revision_id ASC',
      [semanticId],
    );
    return (rows as MappingRow[]).map(rowToMapping);
  }

  async getAllCurrentMappings(): Promise<SemanticMapping[]> {
    const [rows] = await this.conn.query<MappingRow[]>(
      `SELECT sm.*
       FROM semantic_mapping sm
       INNER JOIN (
         SELECT semantic_id, MAX(revision_id) AS max_rev
         FROM semantic_mapping
         GROUP BY semantic_id
       ) latest ON sm.semantic_id = latest.semantic_id AND sm.revision_id = latest.max_rev`,
    );
    return (rows as MappingRow[]).map(rowToMapping);
  }

  async insertShapeHistory(records: ShapeHistoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Dolt PK requires new_id NOT NULL; persist null as '' (deleted-row sentinel).
    const values = records.map((r) => [r.transaction_id, r.verdict, r.original_id, r.new_id ?? '', r.operation_label]);
    await this.conn.query(
      `INSERT IGNORE INTO shape_history (transaction_id, verdict, original_id, new_id, operation_label) VALUES ?`,
      [values],
    );
  }

  async getShapeHistoryForTransaction(transactionId: string): Promise<ShapeHistoryRecord[]> {
    const [rows] = await this.conn.query<ShapeHistoryRow[]>(
      'SELECT * FROM shape_history WHERE transaction_id = ?',
      [transactionId],
    );
    return (rows as ShapeHistoryRow[]).map((r) => ({
      transaction_id: r.transaction_id,
      verdict: r.verdict as ShapeHistoryRecord['verdict'],
      original_id: r.original_id,
      // '' sentinel maps back to null at the TS boundary.
      new_id: r.new_id === '' ? null : r.new_id,
      operation_label: r.operation_label,
    }));
  }

  async insertTopologyRevision(input: InsertTopologyRevisionInput): Promise<number> {
    const [result] = await this.conn.query<mysql.ResultSetHeader>(
      `INSERT INTO topology_revision (transaction_id, brep_file_path, brep_sha256, created_at) VALUES (?, ?, ?, NOW(3))`,
      [input.transaction_id, input.brep_file_path, input.brep_sha256],
    );
    return (result as mysql.ResultSetHeader).insertId;
  }

  async getTopologyRevision(id: number): Promise<TopologyRevision | null> {
    const [rows] = await this.conn.query<TopologyRevisionRow[]>(
      'SELECT * FROM topology_revision WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as TopologyRevisionRow[])[0];
    return row ? rowToTopologyRevision(row) : null;
  }

  async getTopologyRevisionByTransaction(transactionId: string): Promise<TopologyRevision | null> {
    const [rows] = await this.conn.query<TopologyRevisionRow[]>(
      'SELECT * FROM topology_revision WHERE transaction_id = ? LIMIT 1',
      [transactionId],
    );
    const row = (rows as TopologyRevisionRow[])[0];
    return row ? rowToTopologyRevision(row) : null;
  }

  async insertTransaction(tx: Omit<Transaction, 'ended_at'>): Promise<void> {
    await this.conn.query(
      `INSERT INTO \`transaction\` (id, label, product, state, started_at) VALUES (?, ?, ?, ?, ?)`,
      [tx.id, tx.label, tx.product, tx.state, tx.started_at],
    );
  }

  async updateTransactionState(id: string, state: TransactionState, endedAt?: Date): Promise<void> {
    await this.conn.query(
      `UPDATE \`transaction\` SET state = ?, ended_at = ? WHERE id = ?`,
      [state, endedAt ?? null, id],
    );
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    const [rows] = await this.conn.query<TransactionRow[]>(
      'SELECT * FROM `transaction` WHERE id = ? LIMIT 1',
      [id],
    );
    const row = (rows as TransactionRow[])[0];
    return row ? rowToTransaction(row) : null;
  }
}

// ─── Time-travel adapter (AS OF queries) ─────────────────────────────────────

class AsOfDoltAdapter extends DoltAdapter {
  private commitRef: string;

  constructor(pool: Pool, commitRef: string) {
    super({ host: '', port: 0, user: '', password: '', database: '' });
    this.pool = pool;
    this._asOfRef = commitRef;
    this.commitRef = commitRef;
  }

  override async getCurrentMappingsForEntity(semanticId: string): Promise<SemanticMapping | null> {
    const [rows] = await this.pool.query<MappingRow[]>(
      `SELECT * FROM semantic_mapping AS OF ? WHERE semantic_id = ? ORDER BY revision_id DESC LIMIT 1`,
      [this.commitRef, semanticId],
    );
    const row = (rows as MappingRow[])[0];
    return row ? rowToMapping(row) : null;
  }

  override async getMappingHistory(semanticId: string): Promise<SemanticMapping[]> {
    const [rows] = await this.pool.query<MappingRow[]>(
      `SELECT * FROM semantic_mapping AS OF ? WHERE semantic_id = ? ORDER BY revision_id ASC`,
      [this.commitRef, semanticId],
    );
    return (rows as MappingRow[]).map(rowToMapping);
  }
}
