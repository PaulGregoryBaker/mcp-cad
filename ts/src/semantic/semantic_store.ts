/**
 * SemanticStore — high-level operations over SemanticPersistencePort.
 * All mutations run inside port.transaction() for SQL-level atomicity.
 */

import type { SemanticPersistencePort } from './port';
import type { Binding, SemanticEntity, SemanticMapping } from './types';
import {
  validateEntityId,
  validateEntityType,
  validateRelationshipType,
  isValidationError,
} from './identifiers';

// ─── Input / output shapes ────────────────────────────────────────────────────

export interface DeclareEntityInput {
  id: string;
  type: string;
  purpose?: string[];
  relationships?: Array<{ relationship: string; target: string }>;
  transaction_id: string;
}

export interface BindEntityInput {
  semantic_id: string;
  binding: Binding;
  transaction_id: string;
  topology_revision?: number;
}

export interface ResolveCurrentInput {
  semantic_id: string;
}

// ─── Error codes ─────────────────────────────────────────────────────────────

export class SemanticStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SemanticStoreError';
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class SemanticStore {
  constructor(private port: SemanticPersistencePort) {}

  async declareEntity(input: DeclareEntityInput): Promise<SemanticEntity> {
    // Validate id
    const idResult = validateEntityId(input.id);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }

    // Validate type
    const typeResult = validateEntityType(input.type);
    if (isValidationError(typeResult)) {
      throw new SemanticStoreError(typeResult.code, typeResult.message);
    }

    // Validate relationships
    const relationships: Array<{ relationship: import('./types').RelationshipType; target: string }> = [];
    for (const rel of input.relationships ?? []) {
      const relTypeResult = validateRelationshipType(rel.relationship);
      if (isValidationError(relTypeResult)) {
        throw new SemanticStoreError(relTypeResult.code, relTypeResult.message);
      }
      const targetResult = validateEntityId(rel.target);
      if (isValidationError(targetResult)) {
        throw new SemanticStoreError(targetResult.code, `relationship target: ${targetResult.message}`);
      }
      relationships.push({ relationship: relTypeResult, target: rel.target });
    }

    return this.port.transaction(async (p) => {
      // Check for duplicate
      const existing = await p.findEntity(input.id);
      if (existing) {
        throw new SemanticStoreError('SEMANTIC_ID_EXISTS', `Entity already exists: ${input.id}`);
      }

      await p.insertEntity({
        id: input.id,
        type: typeResult,
        purpose: input.purpose,
        transaction_id: input.transaction_id,
      });

      for (const rel of relationships) {
        await p.insertRelationship(input.id, rel.relationship, rel.target, input.transaction_id);
      }

      const entity = await p.findEntity(input.id);
      if (!entity) throw new SemanticStoreError('PERSISTENCE_UNAVAILABLE', 'Entity insert did not persist');
      return entity;
    });
  }

  async bindEntity(input: BindEntityInput): Promise<SemanticMapping> {
    const idResult = validateEntityId(input.semantic_id);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }

    return this.port.transaction(async (p) => {
      const entity = await p.findEntity(input.semantic_id);
      if (!entity) {
        throw new SemanticStoreError('SEMANTIC_ID_NOT_FOUND', `Entity not found: ${input.semantic_id}`);
      }

      if (input.binding.kind === 'face_group' && input.binding.face_ids.length === 0) {
        throw new SemanticStoreError('BINDING_KIND_NOT_SUPPORTED', 'face_group binding requires at least one face_id');
      }

      // For spatial_region: validate constituents exist.
      if (input.binding.kind === 'spatial_region') {
        for (const constituentId of input.binding.between) {
          const constituent = await p.findEntity(constituentId);
          if (!constituent) {
            throw new SemanticStoreError(
              'SEMANTIC_CONSTITUENT_NOT_FOUND',
              `Spatial region constituent not found: ${constituentId}`,
            );
          }
        }
      }

      const revisionId = await p.insertMapping({
        semantic_id: input.semantic_id,
        binding: input.binding,
        topology_revision: input.topology_revision ?? 0,
        transaction_id: input.transaction_id,
      });

      const mapping = await p.getCurrentMappingsForEntity(input.semantic_id);
      if (!mapping || mapping.revision_id !== revisionId) {
        throw new SemanticStoreError('PERSISTENCE_UNAVAILABLE', 'Mapping insert did not persist');
      }
      return mapping;
    });
  }

  async resolveCurrent(input: ResolveCurrentInput): Promise<SemanticMapping & { materialised_face_ids?: string[] }> {
    const idResult = validateEntityId(input.semantic_id);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }

    const mapping = await this.port.getCurrentMappingsForEntity(input.semantic_id);
    if (!mapping) {
      throw new SemanticStoreError('SEMANTIC_ID_NOT_FOUND', `No binding found for: ${input.semantic_id}`);
    }

    // Materialise spatial_region bindings.
    if (mapping.binding_kind === 'spatial_region' && mapping.binding.kind === 'spatial_region') {
      const [idA, idB] = mapping.binding.between;
      const mappingA = await this.port.getCurrentMappingsForEntity(idA);
      const mappingB = await this.port.getCurrentMappingsForEntity(idB);

      const faceIds: string[] = [];
      if (mappingA?.binding.kind === 'face_group') faceIds.push(...mappingA.binding.face_ids);
      if (mappingB?.binding.kind === 'face_group') faceIds.push(...mappingB.binding.face_ids);

      return { ...mapping, materialised_face_ids: faceIds };
    }

    return mapping;
  }

  async getEntity(semanticId: string): Promise<SemanticEntity> {
    const idResult = validateEntityId(semanticId);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }

    const entity = await this.port.findEntity(semanticId);
    if (!entity) {
      throw new SemanticStoreError('SEMANTIC_ID_NOT_FOUND', `Entity not found: ${semanticId}`);
    }
    return entity;
  }

  /** Returns all historical mapping rows for a semantic entity in revision order. */
  async getMappingLineage(semanticId: string): Promise<SemanticMapping[]> {
    const idResult = validateEntityId(semanticId);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }
    return this.port.getMappingHistory(semanticId);
  }

  /**
   * Resolves the binding for a semantic entity at a specific topology revision
   * using Dolt's AS OF time-travel capability.
   * Throws REVISION_NOT_FOUND if the revision does not exist.
   */
  async resolveAtRevision(semanticId: string, atRevision: number): Promise<SemanticMapping> {
    const idResult = validateEntityId(semanticId);
    if (isValidationError(idResult)) {
      throw new SemanticStoreError(idResult.code, idResult.message);
    }

    // Look up the Dolt commit ref for the requested topology revision.
    const revRow = await this.port.getTopologyRevision(atRevision);
    if (!revRow) {
      throw new SemanticStoreError(
        'REVISION_NOT_FOUND',
        `Topology revision ${atRevision} does not exist`,
      );
    }

    // Use the transaction_id as the commit ref (the branch was merged at commit time).
    // In practice, Dolt AS OF accepts a branch, tag, or commit hash.
    // For MVP we use the transaction_id as a human-readable tag (needs to match
    // the DOLT_COMMIT message format used in DoltAdapter.mergeBranch).
    const asOfPort = this.port.asOf(`merge ${revRow.transaction_id}`);
    const mapping = await asOfPort.getCurrentMappingsForEntity(semanticId);
    if (!mapping) {
      throw new SemanticStoreError(
        'REVISION_NOT_FOUND',
        `No binding for ${semanticId} at revision ${atRevision}`,
      );
    }
    return mapping;
  }

  /** Returns the underlying port for direct adapter access (e.g. MappingLayer). */
  getPort(): SemanticPersistencePort {
    return this.port;
  }
}
