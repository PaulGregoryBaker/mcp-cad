/**
 * Semantic Mapping Layer type definitions.
 * Locked vocabularies mirror spec.md FR-013/FR-014 and Persistence-Dolt.md §4.
 */

// ─── Vocabulary enumerations ──────────────────────────────────────────────────

export type EntityType =
  | 'panel'
  | 'panel_group'
  | 'joint_interface'
  | 'functional_system'
  | 'spatial_region';

export type EntityState = 'candidate' | 'confirmed' | 'deprecated';

export type RelationshipType =
  | 'contains'
  | 'bounded_by'
  | 'connected_to'
  | 'manufactured_as'
  | 'joined_by'
  | 'bent_along';

export type BindingKind = 'face_group' | 'body' | 'spatial_region';

export type ShapeVerdict = 'modified' | 'generated' | 'deleted';

export type TransactionState = 'active' | 'committed' | 'rolled_back';

// ─── Binding shapes ───────────────────────────────────────────────────────────

export interface FaceGroupBinding {
  kind: 'face_group';
  face_ids: string[];
}

export interface BodyBinding {
  kind: 'body';
  body_id: string;
}

export interface SpatialRegionBinding {
  kind: 'spatial_region';
  between: [string, string];
}

export type Binding = FaceGroupBinding | BodyBinding | SpatialRegionBinding;

// ─── Domain records ───────────────────────────────────────────────────────────

export interface SemanticRelationship {
  relationship: RelationshipType;
  target: string;
}

export interface SemanticEntity {
  id: string;
  type: EntityType;
  purpose?: string[];
  relationships?: SemanticRelationship[];
  state: EntityState;
  created_in_transaction: string;
  created_at: Date;
}

export interface SemanticMapping {
  revision_id: number;
  semantic_id: string;
  binding_kind: BindingKind;
  binding: Binding;
  topology_revision: number;
  created_in_transaction: string;
  created_at: Date;
  remap_reason: string | null;
}

export interface TopologyRevision {
  id: number;
  transaction_id: string;
  brep_file_path: string;
  brep_sha256: string;
  created_at: Date;
}

export interface ShapeHistoryRecord {
  transaction_id: string;
  verdict: ShapeVerdict;
  original_id: string;
  new_id: string | null;
  operation_label: string;
}

export interface Transaction {
  id: string;
  label: string;
  product: string;
  state: TransactionState;
  started_at: Date;
  ended_at: Date | null;
}
