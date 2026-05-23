/**
 * Semantic ID validation and vocabulary checking.
 * All semantic entity URIs follow the scheme: semantic://<product>/<slug>
 */

import type { EntityType, RelationshipType } from './types';

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

export interface ParsedSemanticId {
  product: string;
  slug: string;
}

export interface ValidationError {
  code: 'SEMANTIC_ID_INVALID' | 'SEMANTIC_TYPE_NOT_SUPPORTED' | 'SEMANTIC_RELATIONSHIP_NOT_SUPPORTED';
  message: string;
}

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  'panel',
  'panel_group',
  'joint_interface',
  'functional_system',
  'spatial_region',
]);

const VALID_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set<RelationshipType>([
  'contains',
  'bounded_by',
  'connected_to',
  'manufactured_as',
  'joined_by',
  'bent_along',
]);

export function validateEntityId(uri: string): ParsedSemanticId | ValidationError {
  if (!uri.startsWith('semantic://')) {
    return { code: 'SEMANTIC_ID_INVALID', message: `URI must start with 'semantic://': ${uri}` };
  }

  const rest = uri.slice('semantic://'.length);
  const slash = rest.indexOf('/');

  if (slash === -1) {
    return { code: 'SEMANTIC_ID_INVALID', message: `URI must contain a product slug and entity slug: ${uri}` };
  }

  const product = rest.slice(0, slash);
  const slug = rest.slice(slash + 1);

  if (!SLUG_RE.test(product)) {
    return {
      code: 'SEMANTIC_ID_INVALID',
      message: `Product slug must match [a-z][a-z0-9_]*: got '${product}'`,
    };
  }

  if (!SLUG_RE.test(slug)) {
    return {
      code: 'SEMANTIC_ID_INVALID',
      message: `Entity slug must match [a-z][a-z0-9_]*: got '${slug}'`,
    };
  }

  return { product, slug };
}

export function isValidationError(v: unknown): v is ValidationError {
  return typeof v === 'object' && v !== null && 'code' in v;
}

export function validateEntityType(type: string): EntityType | ValidationError {
  if (VALID_ENTITY_TYPES.has(type)) return type as EntityType;
  return {
    code: 'SEMANTIC_TYPE_NOT_SUPPORTED',
    message: `Unknown entity type '${type}'. Valid types: ${[...VALID_ENTITY_TYPES].join(', ')}`,
  };
}

export function validateRelationshipType(rel: string): RelationshipType | ValidationError {
  if (VALID_RELATIONSHIP_TYPES.has(rel)) return rel as RelationshipType;
  return {
    code: 'SEMANTIC_RELATIONSHIP_NOT_SUPPORTED',
    message: `Unknown relationship '${rel}'. Valid: ${[...VALID_RELATIONSHIP_TYPES].join(', ')}`,
  };
}
