import { throwError, ErrorCodes } from '../errors.js';
import { getParts } from '../state.js';
import { requireString } from '../helpers.js';
import { map3dTo2d, map2dTo3d } from '../../geometry/coordinate-map.js';

export const mappingDefinitions = [
  {
    name: 'map_3d_to_2d',
    description:
      'Maps a 3D world-space point to its 2D XY position in the DXF flat-pattern of a manufacturing-graph part. ' +
      'Returns the panel ID, the 2D coordinate, and the mapping error (distance from panel surface). ' +
      'Requires the part to have a manufacturing graph with populated panel frames (run split_body_by_bends first). ' +
      'Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Manufacturing Graph part ID' },
        point: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[x, y, z] world-space point in mm',
        },
      },
      required: ['part_id', 'point'],
    },
  },
  {
    name: 'map_2d_to_3d',
    description:
      'Maps a 2D DXF flat-pattern coordinate back to the corresponding 3D world-space point on the folded shell. ' +
      'When panel_id is omitted, the tool performs region lookup across all PanelNodes using dxfPlacement bounds. ' +
      'Non-mutating.',
    inputSchema: {
      type: 'object',
      properties: {
        part_id: { type: 'string', description: 'Manufacturing Graph part ID' },
        panel_id: {
          type: 'string',
          description:
            'Optional: node ID of the panel in the manufacturing graph. When omitted, region lookup selects the correct panel automatically.',
        },
        point: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[x, y] DXF flat-pattern coordinate in mm',
        },
      },
      required: ['part_id', 'point'],
    },
  },
];

export function handleMapTo2D(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const pointArg = args['point'];
  if (!Array.isArray(pointArg) || pointArg.length !== 3 || pointArg.some((v) => typeof v !== 'number')) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'map_3d_to_2d: point must be an array of exactly 3 numbers [x, y, z]', false);
  }
  const point3d = pointArg as [number, number, number];

  const graph = getParts().get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GE_NO_MANUFACTURING_GRAPH,
      `map_3d_to_2d: part "${partId}" has no manufacturing graph. Run split_body_by_bends or bootstrap_graph first.`,
      false,
    );
  }

  const result = map3dTo2d(point3d, graph);
  if ('code' in result) {
    throwError(
      result.code === 'GE_POINT_NOT_ON_PANEL' ? ErrorCodes.GE_POINT_NOT_ON_PANEL : ErrorCodes.INTERNAL_ERROR,
      result.message,
      false,
    );
  }
  return { panel_id: result.panelId, xy: result.xy, error_mm: result.errorMm };
}

export function handleMapTo3D(args: Record<string, unknown>): unknown {
  const partId = requireString(args, 'part_id');
  const panelId: string | undefined = typeof args['panel_id'] === 'string' ? args['panel_id'] : undefined;
  const pointArg = args['point'];
  if (!Array.isArray(pointArg) || pointArg.length !== 2 || pointArg.some((v) => typeof v !== 'number')) {
    throwError(ErrorCodes.INTERNAL_ERROR, 'map_2d_to_3d: point must be an array of exactly 2 numbers [x, y]', false);
  }
  const point2d = pointArg as [number, number];

  const graph = getParts().get(partId);
  if (!graph) {
    throwError(
      ErrorCodes.GE_NO_MANUFACTURING_GRAPH,
      `map_2d_to_3d: part "${partId}" has no manufacturing graph. Run split_body_by_bends or bootstrap_graph first.`,
      false,
    );
  }

  const result = map2dTo3d(panelId, point2d, graph);
  if ('code' in result) {
    throwError(
      result.code === 'GE_POINT_NOT_ON_PANEL' ? ErrorCodes.GE_POINT_NOT_ON_PANEL : ErrorCodes.INTERNAL_ERROR,
      result.message,
      false,
    );
  }
  return { point3d: result.point3d, error_mm: result.errorMm };
}
