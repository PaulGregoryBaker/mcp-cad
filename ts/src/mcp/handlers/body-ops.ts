import { throwError, ErrorCodes } from '../errors.js';
import { getGeometryBinding } from '../state.js';
import { session } from '../../geometry/session.js';
import { transactionRegistry } from '../transactions.js';
import {
  requireString,
  requireStringArray,
  resolveTransactionContext,
  resolveTargetToShell,
  updatePanelBodyIdAfterTransform,
} from '../helpers.js';

export const bodyOpsDefinitions = [
  {
    name: 'clean_geometry',
    description: 'Load and validate a STEP file. Heals non-manifold geometry if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to STEP file' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'center_and_align_body',
    description:
      'Calculates the Center of Mass (centroid) of a 3D solid/shell, translates it to [0,0,0], and rotates it so its dominant planar face normal aligns with the Z-axis. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'ID of the shell body to re-orient' },
        transaction_id: { type: 'string', description: 'Active transaction ID' },
      },
      required: ['part_id', 'transaction_id'],
    },
  },
  {
    name: 'bounding_box',
    description: 'Returns the axis-aligned bounding box of a body, face, edge, or vertex. Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Entity ID (solid, shell, face, edge, or vertex)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'mass_properties',
    description:
      'Returns physical properties of a solid or shell: volume, surface area, centroid, and/or inertia tensor. Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Body ID' },
        properties: {
          type: 'array',
          items: { type: 'string', enum: ['volume', 'surface_area', 'centroid', 'inertia_tensor'] },
          minItems: 1,
          default: ['volume', 'surface_area', 'centroid', 'inertia_tensor'],
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'measure_distance',
    description:
      'Measures the minimum distance, maximum distance, or angle between two topological entities. Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        target_a: { type: 'string', description: 'First entity ID (face, edge, vertex, or body)' },
        target_b: { type: 'string', description: 'Second entity ID' },
        measurement_type: {
          type: 'string',
          enum: ['min_distance', 'max_distance', 'angle'],
          default: 'min_distance',
          description: 'angle is only supported between two planar faces',
        },
      },
      required: ['target_a', 'target_b'],
    },
  },
  {
    name: 'explore_topology',
    description:
      'Returns an ordered list of sub-entity IDs of the specified type within a body. Non-mutating. Order is deterministic for identical inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Body or shell ID to explore' },
        return_type: {
          type: 'string',
          enum: ['solid', 'shell', 'face', 'edge', 'vertex'],
          description: 'Sub-entity type to return',
        },
      },
      required: ['target', 'return_type'],
    },
  },
  {
    name: 'translate_body',
    description:
      'Moves one or more bodies along a 3D vector. Produces a new body id per target. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'IDs of bodies to translate',
        },
        vector: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[dx, dy, dz] translation vector in mm',
        },
        keep_original: { type: 'boolean', default: false, description: 'If true, keep the original body' },
        transaction_id: { type: 'string' },
      },
      required: ['targets', 'vector', 'transaction_id'],
    },
  },
  {
    name: 'rotate_body',
    description: 'Rotates one or more bodies around a defined axis. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'IDs of bodies to rotate',
        },
        axis_origin: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[x, y, z] of a point on the rotation axis (mm)',
        },
        axis_direction: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[dx, dy, dz] direction vector of the axis',
        },
        angle_degrees: { type: 'number', description: 'Rotation angle in degrees (right-hand rule)' },
        keep_original: { type: 'boolean', default: false, description: 'If true, keep the original body' },
        transaction_id: { type: 'string' },
      },
      required: ['targets', 'axis_origin', 'axis_direction', 'angle_degrees', 'transaction_id'],
    },
  },
  {
    name: 'mirror_body',
    description: 'Mirrors one or more bodies across a defined plane. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'IDs of bodies to mirror',
        },
        plane_origin: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[x, y, z] of a point on the mirror plane (mm)',
        },
        plane_normal: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[nx, ny, nz] plane normal',
        },
        keep_original: { type: 'boolean', default: false, description: 'If true, keep the original body' },
        transaction_id: { type: 'string' },
      },
      required: ['targets', 'plane_origin', 'plane_normal', 'transaction_id'],
    },
  },
  {
    name: 'scale_body',
    description:
      'Uniformly scales one or more bodies relative to a fixed origin. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'IDs of bodies to scale',
        },
        origin: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[x, y, z] scale origin (mm)',
        },
        scale_factor: { type: 'number', minimum: 0.0001, description: 'Uniform scale factor (> 0)' },
        keep_original: { type: 'boolean', default: false, description: 'If true, keep the original body' },
        transaction_id: { type: 'string' },
      },
      required: ['targets', 'origin', 'scale_factor', 'transaction_id'],
    },
  },
  {
    name: 'align_to_face',
    description:
      'Repositions the body containing source_face so that source_face is coincident with destination_face. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        source_face: { type: 'string', description: 'Face ID on the body to move' },
        destination_face: { type: 'string', description: 'Target face ID (this body does not move)' },
        flip_normal: {
          type: 'boolean',
          default: false,
          description: 'If true, source face normal is flipped before alignment',
        },
        keep_original: { type: 'boolean', default: false, description: 'If true, keep the original body' },
        transaction_id: { type: 'string' },
      },
      required: ['source_face', 'destination_face', 'transaction_id'],
    },
  },
  {
    name: 'fillet_edges',
    description:
      'Applies a circular fillet of the given radius to the specified edges. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body/shell containing the edges' },
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Edge IDs to fillet' },
        radius: { type: 'number', exclusiveMinimum: 0, description: 'Fillet radius in mm' },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'targets', 'radius', 'transaction_id'],
    },
  },
  {
    name: 'chamfer_edges',
    description:
      'Applies an angled chamfer of the given distance to the specified edges. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body/shell containing the edges' },
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Edge IDs to chamfer',
        },
        distance: { type: 'number', exclusiveMinimum: 0, description: 'Chamfer offset distance in mm' },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'targets', 'distance', 'transaction_id'],
    },
  },
  {
    name: 'simplify_body',
    description:
      'Merges co-planar adjacent faces and collinear edges into single entities (ShapeUpgrade_UnifySameDomain). Reduces face count without changing geometry. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body/shell to simplify' },
        unify_faces: { type: 'boolean', default: true, description: 'Merge co-planar adjacent faces' },
        unify_edges: { type: 'boolean', default: true, description: 'Merge collinear adjacent edges' },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'transaction_id'],
    },
  },
  {
    name: 'heal_geometry_ex',
    description:
      'Repairs B-Rep validity issues (gaps, bad tolerances, invalid wires) using ShapeFix_Shape. Returns heal_complete: true if BRepCheck_Analyzer passes on the result. Non-destructive but mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body/shell to heal' },
        fix_tolerances: { type: 'boolean', default: true, description: 'Repair loose tolerancing issues' },
        fix_wires: { type: 'boolean', default: true, description: 'Heal open or incorrect wires' },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'transaction_id'],
    },
  },
  {
    name: 'offset_shape',
    description:
      'Offsets the boundary of a solid outward (positive) or inward (negative) by the given distance. Distinct from offset_face (which offsets a single face in 2D). Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body/shell to offset' },
        offset_value: {
          type: 'number',
          description: 'Offset distance in mm. Positive = outward (thicken), negative = inward (shrink).',
        },
        tolerance: { type: 'number', default: 1e-4, description: 'Shape tolerance (mm)' },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'offset_value', 'transaction_id'],
    },
  },
  {
    name: 'delete_face',
    description:
      'Removes specified faces and attempts to heal the surrounding topology. May produce multiple bodies if removal disconnects the shape. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Body containing the faces' },
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Face IDs to delete' },
        heal_remaining: {
          type: 'boolean',
          default: true,
          description: 'If true, attempt to stitch/sew the remaining faces',
        },
        transaction_id: { type: 'string' },
      },
      required: ['part_id', 'targets', 'transaction_id'],
    },
  },
  {
    name: 'sew_faces',
    description:
      'Stitches adjacent open faces or shells together into a single shell or solid. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'Face or shell IDs to sew together',
        },
        tolerance: { type: 'number', default: 1e-3, description: 'Maximum sewing gap tolerance (mm)' },
        make_solid: {
          type: 'boolean',
          default: false,
          description: 'If true and result is a closed shell, convert to a solid body',
        },
        transaction_id: { type: 'string' },
      },
      required: ['targets', 'transaction_id'],
    },
  },
];

export function handleCleanGeometry(args: Record<string, unknown>): unknown {
  const filePath = requireString(args, 'file_path');

  const rollbackToken = getGeometryBinding().createSnapshot('before clean_geometry');
  const solidId = getGeometryBinding().loadStep(filePath);
  session.registerSolid(solidId);

  const manifoldResult = getGeometryBinding().checkManifold(solidId);
  let finalSolidId = solidId;
  let healed = false;

  if (!manifoldResult.isManifold) {
    finalSolidId = getGeometryBinding().healGeometry(solidId);
    session.registerSolid(finalSolidId);
    healed = true;
  }

  const topology = getGeometryBinding().getTopology(finalSolidId);
  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: finalSolidId,
    is_manifold: true,
    face_count: topology.faces.length,
    issues_found: manifoldResult.issues.length,
    healed,
    rollback_token: rollbackToken,
    mesh_url: `${meshBaseUrl}/mesh/${finalSolidId}.glb`,
  };
}

export function handleCenterAndAlignBody(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const ctx = resolveTransactionContext(args);
  if (ctx.mode !== 'join') {
    throwError(ErrorCodes.TRANSACTION_REQUIRED, 'center_and_align_body requires an active transaction', false);
  }

  const result = getGeometryBinding().centerAndAlignBody(partId, ctx.transactionId);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    centroid: result.centroid,
    rotation_matrix: result.rotation_matrix,
    rollback_token: ctx.transactionId,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleBoundingBox(args: Record<string, unknown>): unknown {
  const target = requireString(args, 'target');
  const result = getGeometryBinding().computeBoundingBox(target);
  return {
    x_min: result.x_min,
    y_min: result.y_min,
    z_min: result.z_min,
    x_max: result.x_max,
    y_max: result.y_max,
    z_max: result.z_max,
  };
}

export function handleMassProperties(args: Record<string, unknown>): unknown {
  const target = requireString(args, 'target');
  const properties = args['properties'] as string[] | undefined;
  const result = getGeometryBinding().computeMassProperties(target, properties);
  return {
    volume: result.volume,
    surface_area: result.surface_area,
    centroid: result.centroid,
    inertia_tensor: result.inertia_tensor,
  };
}

export function handleMeasureDistance(args: Record<string, unknown>): unknown {
  const targetA = requireString(args, 'target_a');
  const targetB = requireString(args, 'target_b');
  const mType = (args['measurement_type'] as string | undefined) ?? 'min_distance';
  const result = getGeometryBinding().measureDistance(targetA, targetB, mType);
  return {
    value: result.value,
    measurement_type: result.measurement_type,
  };
}

export function handleExploreTopology(args: Record<string, unknown>): unknown {
  const target = requireString(args, 'target');
  const returnType = requireString(args, 'return_type');
  const result = getGeometryBinding().exploreTopology(target, returnType);
  return { entity_ids: result.entity_ids };
}

export function handleTranslateBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const vec = args['vector'] as number[];
  if (!Array.isArray(vec) || vec.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'vector must be an array of 3 numbers', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const { shellId, partGraph } = resolveTargetToShell(target);
    const res = getGeometryBinding().translateBody(shellId, vec[0], vec[1], vec[2], keepOriginal);
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
    updatePanelBodyIdAfterTransform(shellId, res.solid_id, partGraph, keepOriginal);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map((r) => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map((r) => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap((r) => r.shape_history ?? []),
  };
}

export function handleRotateBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const axisOrigin = args['axis_origin'] as number[];
  const axisDirection = args['axis_direction'] as number[];
  const angleDeg = args['angle_degrees'] as number;
  if (!Array.isArray(axisOrigin) || axisOrigin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'axis_origin must be an array of 3 numbers', false);
  }
  if (!Array.isArray(axisDirection) || axisDirection.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'axis_direction must be an array of 3 numbers', false);
  }
  if (typeof angleDeg !== 'number') {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'angle_degrees must be a number', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const { shellId, partGraph } = resolveTargetToShell(target);
    const res = getGeometryBinding().rotateBody(
      shellId,
      axisOrigin[0],
      axisOrigin[1],
      axisOrigin[2],
      axisDirection[0],
      axisDirection[1],
      axisDirection[2],
      angleDeg,
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
    updatePanelBodyIdAfterTransform(shellId, res.solid_id, partGraph, keepOriginal);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map((r) => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map((r) => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap((r) => r.shape_history ?? []),
  };
}

export function handleMirrorBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const planeOrigin = args['plane_origin'] as number[];
  const planeNormal = args['plane_normal'] as number[];
  if (!Array.isArray(planeOrigin) || planeOrigin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'plane_origin must be an array of 3 numbers', false);
  }
  if (!Array.isArray(planeNormal) || planeNormal.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'plane_normal must be an array of 3 numbers', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const { shellId, partGraph } = resolveTargetToShell(target);
    const res = getGeometryBinding().mirrorBody(
      shellId,
      planeOrigin[0],
      planeOrigin[1],
      planeOrigin[2],
      planeNormal[0],
      planeNormal[1],
      planeNormal[2],
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
    updatePanelBodyIdAfterTransform(shellId, res.solid_id, partGraph, keepOriginal);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map((r) => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map((r) => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap((r) => r.shape_history ?? []),
  };
}

export function handleScaleBody(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const origin = args['origin'] as number[];
  const scaleFactor = args['scale_factor'] as number;
  if (!Array.isArray(origin) || origin.length < 3) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'origin must be an array of 3 numbers', false);
  }
  if (typeof scaleFactor !== 'number' || scaleFactor <= 0) {
    throwError(ErrorCodes.GE_SCALE_NON_UNIFORM, 'scale_factor must be a positive number', false);
  }
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const results = [];
  for (const target of targets) {
    const { shellId, partGraph } = resolveTargetToShell(target);
    const res = getGeometryBinding().scaleBody(
      shellId,
      origin[0],
      origin[1],
      origin[2],
      scaleFactor,
      keepOriginal,
    );
    results.push(res);
    session.registerShell(res.solid_id);
    if (ctx.mode === 'join') {
      transactionRegistry.appendHistory(ctx.transactionId, res.shape_history ?? []);
    }
    updatePanelBodyIdAfterTransform(shellId, res.solid_id, partGraph, keepOriginal);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: results.length === 1 ? results[0].solid_id : results[results.length - 1].solid_id,
    solid_ids: results.map((r) => r.solid_id),
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : results[0].rollback_token,
    mesh_urls: results.map((r) => `${meshBaseUrl}/mesh/${r.solid_id}.glb`),
    shape_history: results.flatMap((r) => r.shape_history ?? []),
  };
}

export function handleAlignToFace(args: Record<string, unknown>): unknown {
  const srcFace = requireString(args, 'source_face');
  const dstFace = requireString(args, 'destination_face');
  const flipNormal = (args['flip_normal'] as boolean | undefined) ?? false;
  const keepOriginal = (args['keep_original'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().alignToFace(srcFace, dstFace, flipNormal, keepOriginal);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleFilletEdges(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const radius = args['radius'] as number;
  if (typeof radius !== 'number' || radius <= 0) {
    throwError(ErrorCodes.GE_FILLET_TOO_LARGE, 'radius must be a positive number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().filletEdges(partId, targets, radius);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleChamferEdges(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const distance = args['distance'] as number;
  if (typeof distance !== 'number' || distance <= 0) {
    throwError(ErrorCodes.GE_CHAMFER_TOO_LARGE, 'distance must be a positive number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().chamferEdges(partId, targets, distance);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleSimplifyBody(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const unifyFaces = (args['unify_faces'] as boolean | undefined) ?? true;
  const unifyEdges = (args['unify_edges'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().simplifyBody(partId, unifyFaces, unifyEdges);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleHealGeometryEx(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const fixTolerances = (args['fix_tolerances'] as boolean | undefined) ?? true;
  const fixWires = (args['fix_wires'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().healGeometryEx(partId, fixTolerances, fixWires);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    heal_complete: result.heal_complete,
    remaining_issues: result.remaining_issues,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleOffsetShape(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const offsetValue = args['offset_value'] as number;
  const tolerance = (args['tolerance'] as number | undefined) ?? 1e-4;
  if (typeof offsetValue !== 'number') {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, 'offset_value must be a number', false);
  }
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().offsetShape(partId, offsetValue, tolerance);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleDeleteFace(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const targets = requireStringArray(args, 'targets');
  const healRemaining = (args['heal_remaining'] as boolean | undefined) ?? true;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().deleteFace(partId, targets, healRemaining);
  for (const solidId of result.solid_ids) {
    session.registerShell(solidId);
  }
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_ids: result.solid_ids,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_urls: result.solid_ids.map((id) => `${meshBaseUrl}/mesh/${id}.glb`),
    shape_history: result.shape_history ?? [],
  };
}

export function handleSewFaces(args: Record<string, unknown>): unknown {
  const targets = requireStringArray(args, 'targets');
  const tolerance = (args['tolerance'] as number | undefined) ?? 1e-3;
  const makeSolid = (args['make_solid'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().sewFaces(targets, tolerance, makeSolid);
  session.registerShell(result.solid_id);
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    shell_id: result.solid_id,
    sew_complete: result.sew_complete,
    free_edges: result.free_edges,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}
