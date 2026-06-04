/**
 * SemanticPersistencePort — typed interface for all Dolt persistence operations.
 * The DoltAdapter implements this; tests can supply a mock.
 */

import type {
  Binding,
  EntityType,
  RelationshipType,
  SemanticEntity,
  SemanticMapping,
  SemanticRelationship,
  ShapeHistoryRecord,
  TopologyRevision,
  Transaction,
  TransactionState,
} from './types';

// ─── Input shapes ─────────────────────────────────────────────────────────────

export interface InsertEntityInput {
  id: string;
  type: EntityType;
  purpose?: string[];
  relationships?: SemanticRelationship[];
  transaction_id: string;
}

export interface InsertMappingInput {
  semantic_id: string;
  binding: Binding;
  topology_revision: number;
  transaction_id: string;
  remap_reason?: string;
}

export interface InsertTopologyRevisionInput {
  transaction_id: string;
  brep_file_path: string;
  brep_sha256: string;
}

// ─── Port interface ──────────────────────────────────────────────────────────

export interface SemanticPersistencePort {
  // Connection lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Dolt branch operations (map to CALL DOLT_CHECKOUT / DOLT_MERGE / DOLT_BRANCH)
  checkoutBranch(branch: string, createIfAbsent?: boolean): Promise<void>;
  mergeBranch(branch: string): Promise<void>;
  deleteBranch(branch: string, force?: boolean): Promise<void>;

  /**
   * Execute the callback inside a SQL transaction (BEGIN / COMMIT / ROLLBACK).
   * This is a SQL-level transaction, not the MCP transaction concept.
   */
  transaction<T>(callback: (port: SemanticPersistencePort) => Promise<T>): Promise<T>;

  /**
   * Returns a port scoped to `AS OF <commitRef>` queries.
   * Used for time-travel resolution in Phase 4.
   */
  asOf(commitRef: string): SemanticPersistencePort;

  // semantic_entity
  insertEntity(input: InsertEntityInput): Promise<void>;
  findEntity(id: string): Promise<SemanticEntity | null>;

  // semantic_relationship (inserted as part of insertEntity for convenience)
  insertRelationship(
    sourceId: string,
    rel: RelationshipType,
    targetId: string,
    transactionId: string,
  ): Promise<void>;
  getRelationshipsByKind(
    rel: RelationshipType,
  ): Promise<Array<{ sourceId: string; targetId: string }>>;

  // semantic_mapping
  insertMapping(input: InsertMappingInput): Promise<number>; // returns revision_id
  getCurrentMappingsForEntity(semanticId: string): Promise<SemanticMapping | null>;
  getMappingHistory(semanticId: string): Promise<SemanticMapping[]>;
  getAllCurrentMappings(): Promise<SemanticMapping[]>;

  // shape_history
  insertShapeHistory(records: ShapeHistoryRecord[]): Promise<void>;
  getShapeHistoryForTransaction(transactionId: string): Promise<ShapeHistoryRecord[]>;

  // topology_revision
  insertTopologyRevision(input: InsertTopologyRevisionInput): Promise<number>; // returns id
  getTopologyRevision(id: number): Promise<TopologyRevision | null>;
  getTopologyRevisionByTransaction(transactionId: string): Promise<TopologyRevision | null>;

  // transaction table
  insertTransaction(tx: Omit<Transaction, 'ended_at'>): Promise<void>;
  updateTransactionState(id: string, state: TransactionState, endedAt?: Date): Promise<void>;
  getTransaction(id: string): Promise<Transaction | null>;
}
