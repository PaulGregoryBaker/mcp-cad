/**
 * Assembly tool definitions and handlers.
 */

import { throwError, ErrorCodes } from '../errors.js';
import { getGeometryBinding } from '../state.js';
import { requireString, resolveTransactionContext } from '../helpers.js';
import { validationEngine } from '../../validation/validator.js';

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const assemblyDefinitions = [
  {
    name: 'create_assembly_document',
    description: 'Creates a new empty hierarchical assembly document inside an XCAF session. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string' }
      },
      required: ['transaction_id']
    }
  },
  {
    name: 'add_assembly_instance',
    description: 'Adds a solid or shell as a component instance in an assembly document at an optional location. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly_id: { type: 'string', description: 'Assembly document ID' },
        target: { type: 'string', description: 'Solid or shell ID of the component to instance' },
        location: {
          type: 'object',
          properties: {
            translation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] offset in mm' },
            orientation: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[qw, qx, qy, qz] quaternion' }
          },
          required: ['translation', 'orientation']
        },
        transaction_id: { type: 'string' }
      },
      required: ['assembly_id', 'target', 'transaction_id']
    }
  },
  {
    name: 'mate_rigid',
    description: 'Repositions the source component so its face mates flatly against the destination component\'s face. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly_id: { type: 'string', description: 'Assembly document ID' },
        source_face: { type: 'string', description: 'Face ID on the source component instance to move' },
        destination_face: { type: 'string', description: 'Target face ID on a static component instance' },
        flip_alignment: { type: 'boolean', default: false, description: 'If true, reverse the mate normal direction' },
        transaction_id: { type: 'string' }
      },
      required: ['assembly_id', 'source_face', 'destination_face', 'transaction_id']
    }
  },
  {
    name: 'list_assembly_tree',
    description: 'Returns the hierarchical tree of all component instances, their parts, and relative location matrices. Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly_id: { type: 'string', description: 'Assembly document ID' }
      },
      required: ['assembly_id']
    }
  },
  {
    name: 'validate_assembly',
    description: 'Performs comprehensive geometry and assembly verification, checking for sheet metal unfoldability and adjacent part overlaps, returning detailed errors and autofix tool recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        part_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of part IDs to check. If omitted, checks all parts in the workspace.'
        },
        sheet_metal_flags: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
          description: 'Optional overrides to flag parts as sheet metal (true) or non-sheet-metal (false). Default is true for all parts.'
        }
      },
      required: []
    }
  },
];

// ─── Handler implementations ──────────────────────────────────────────────────

export function handleCreateAssemblyDocument(args: Record<string, unknown>): unknown {
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'create_assembly_document requires an active transaction', false);
  }
  const result = getGeometryBinding().createAssemblyDocument();
  return {
    assembly_id: result.assembly_id,
    rollback_token: ctx.transactionId,
  };
}

export function handleAddAssemblyInstance(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const target = requireString(args, 'target');
  const location = args['location'] as { translation: number[]; orientation: number[] } | undefined;
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'add_assembly_instance requires an active transaction', false);
  }

  let tx = 0.0, ty = 0.0, tz = 0.0;
  let qw = 1.0, qx = 0.0, qy = 0.0, qz = 0.0;

  if (location) {
    const { translation, orientation } = location;
    if (Array.isArray(translation) && translation.length === 3) {
      [tx, ty, tz] = translation;
    }
    if (Array.isArray(orientation) && orientation.length === 4) {
      [qw, qx, qy, qz] = orientation;
    }
  }

  const result = getGeometryBinding().addAssemblyInstance(
    assemblyId,
    target,
    tx,
    ty,
    tz,
    qw,
    qx,
    qy,
    qz,
  );

  return {
    component_id: result.component_id,
    rollback_token: ctx.transactionId,
  };
}

export function handleMateRigid(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const srcFace = requireString(args, 'source_face');
  const dstFace = requireString(args, 'destination_face');
  const flipAlignment = (args['flip_alignment'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'mate_rigid requires an active transaction', false);
  }

  const result = getGeometryBinding().mateRigid(assemblyId, srcFace, dstFace, flipAlignment);

  return {
    component_id: result.component_id,
    location_matrix: result.location_matrix,
    rollback_token: ctx.transactionId,
  };
}

export function handleListAssemblyTree(args: Record<string, unknown>): unknown {
  const assemblyId = requireString(args, 'assembly_id');
  const result = getGeometryBinding().listAssemblyTree(assemblyId);
  return {
    assembly_id: result.assembly_id,
    root: result.root,
  };
}

export async function handleValidateAssembly(args: Record<string, unknown>): Promise<unknown> {
  const part_ids = args.part_ids as string[] | undefined;
  const sheet_metal_flags = args.sheet_metal_flags as Record<string, boolean> | undefined;

  const report = await validationEngine.validate({
    part_ids,
    sheet_metal_flags,
  });

  return report;
}
