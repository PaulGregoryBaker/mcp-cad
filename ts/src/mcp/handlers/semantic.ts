import { throwError, ErrorCodes } from '../errors.js';
import { getSemanticStore } from '../state.js';
import { requireString } from '../helpers.js';
import { SemanticStoreError } from '../../semantic/semantic_store.js';

export const semanticDefinitions = [
  {
    name: 'declare_semantic_entity',
    description:
      'Declares a named semantic entity (panel, joint_interface, etc.) within a transaction. The entity is identified by a URI of the form semantic://<product>/<slug>.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'semantic://<product>/<slug>' },
        type: {
          type: 'string',
          enum: ['panel', 'panel_group', 'joint_interface', 'functional_system', 'spatial_region'],
        },
        purpose: { type: 'array', items: { type: 'string' } },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relationship: {
                type: 'string',
                enum: ['contains', 'bounded_by', 'connected_to', 'manufactured_as', 'joined_by', 'bent_along'],
              },
              target: { type: 'string' },
            },
            required: ['relationship', 'target'],
          },
        },
        transaction_id: { type: 'string' },
      },
      required: ['id', 'type', 'transaction_id'],
    },
  },
  {
    name: 'bind_semantic_entity',
    description:
      'Binds a semantic entity to geometry. Supports face_group (explicit face IDs), body (a shell body ID), or spatial_region (between two named entities — resolved at query time).',
    inputSchema: {
      type: 'object',
      properties: {
        semantic_id: { type: 'string' },
        binding: {
          oneOf: [
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['face_group'] },
                face_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
              },
              required: ['kind', 'face_ids'],
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['body'] },
                body_id: { type: 'string' },
              },
              required: ['kind', 'body_id'],
            },
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['spatial_region'] },
                between: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
              },
              required: ['kind', 'between'],
            },
          ],
        },
        transaction_id: { type: 'string' },
      },
      required: ['semantic_id', 'binding', 'transaction_id'],
    },
  },
  {
    name: 'resolve_geometry',
    description:
      'Returns the geometry binding for a semantic entity. Pass at_revision to query point-in-time state via Dolt AS OF.',
    inputSchema: {
      type: 'object',
      properties: {
        semantic_id: { type: 'string' },
        at_revision: { type: 'integer', description: 'Topology revision number for time-travel queries' },
      },
      required: ['semantic_id'],
    },
  },
  {
    name: 'semantic_lineage',
    description:
      'Returns the full history of geometry bindings for a semantic entity, in topology revision order. Each row shows which transaction caused the binding and the remap_reason (if remapped by the mapping layer).',
    inputSchema: {
      type: 'object',
      properties: { semantic_id: { type: 'string' } },
      required: ['semantic_id'],
    },
  },
];

function mapSemanticStoreError(err: unknown): never {
  if (err instanceof SemanticStoreError) {
    throwError(err.code as (typeof ErrorCodes)[keyof typeof ErrorCodes], err.message, true);
  }
  throw err;
}

export async function handleDeclareSemanticEntity(args: Record<string, unknown>): Promise<unknown> {
  const id = requireString(args, 'id');
  const type = requireString(args, 'type');
  const transactionId = requireString(args, 'transaction_id');
  const purpose = Array.isArray(args.purpose) ? (args.purpose as string[]) : undefined;
  const relationships = Array.isArray(args.relationships)
    ? (args.relationships as Array<{ relationship: string; target: string }>)
    : undefined;

  const store = getSemanticStore();
  try {
    const entity = await store.declareEntity({ id, type, purpose, relationships, transaction_id: transactionId });
    return {
      id: entity.id,
      type: entity.type,
      state: entity.state,
      created_in_transaction: entity.created_in_transaction,
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

export async function handleBindSemanticEntity(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');
  const transactionId = requireString(args, 'transaction_id');
  const bindingArg = args.binding;

  if (!bindingArg || typeof bindingArg !== 'object' || !('kind' in bindingArg)) {
    throwError(ErrorCodes.BINDING_KIND_NOT_SUPPORTED, 'binding must have a kind field', false);
  }

  const store = getSemanticStore();
  try {
    const mapping = await store.bindEntity({
      semantic_id: semanticId,
      binding: bindingArg as import('../../semantic/types.js').Binding,
      transaction_id: transactionId,
    });
    return {
      revision_id: mapping.revision_id,
      semantic_id: mapping.semantic_id,
      binding_kind: mapping.binding_kind,
      binding: mapping.binding,
      topology_revision: mapping.topology_revision,
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

export async function handleResolveGeometry(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');
  const atRevision = typeof args.at_revision === 'number' ? args.at_revision : undefined;

  const store = getSemanticStore();
  try {
    const mapping =
      atRevision !== undefined
        ? await store.resolveAtRevision(semanticId, atRevision)
        : await store.resolveCurrent({ semantic_id: semanticId });

    return {
      semantic_id: mapping.semantic_id,
      binding_kind: mapping.binding_kind,
      binding: mapping.binding,
      topology_revision: mapping.topology_revision,
      remap_reason: mapping.remap_reason,
      ...((mapping as { materialised_face_ids?: string[] }).materialised_face_ids !== undefined
        ? { materialised_face_ids: (mapping as { materialised_face_ids?: string[] }).materialised_face_ids }
        : {}),
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}

export async function handleSemanticLineage(args: Record<string, unknown>): Promise<unknown> {
  const semanticId = requireString(args, 'semantic_id');

  const store = getSemanticStore();
  try {
    const lineage = await store.getMappingLineage(semanticId);
    return {
      semantic_id: semanticId,
      lineage: lineage.map((m) => ({
        revision_id: m.revision_id,
        transaction_id: m.created_in_transaction,
        binding_kind: m.binding_kind,
        binding: m.binding,
        topology_revision: m.topology_revision,
        remap_reason: m.remap_reason,
        created_at: m.created_at,
      })),
    };
  } catch (err) {
    mapSemanticStoreError(err);
  }
}
