import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { ErrorCodes } from '../../src/mcp/errors';

describe('Topological Interrogation Integration Tests (Feature 006 US2)', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);
  const simpleBoxPath = getFixturePath('simple_box.stp');

  it('computes bounding box and mass properties on a loaded solid', async () => {
    // 1. clean_geometry to load the shape
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const solidId = clean.solid_id;
    expect(solidId).toBeDefined();

    // 2. bounding_box
    const bbox = await dispatchTool('bounding_box', { target: solidId }, config) as any;
    expect(bbox.x_min).toBeLessThan(bbox.x_max);
    expect(bbox.y_min).toBeLessThan(bbox.y_max);
    expect(bbox.z_min).toBeLessThan(bbox.z_max);

    // 3. mass_properties
    const mass = await dispatchTool('mass_properties', { target: solidId, properties: ['volume', 'centroid'] }, config) as any;
    expect(mass.volume).toBeGreaterThan(0);
    expect(mass.centroid).toBeDefined();
    expect(mass.centroid).toHaveLength(3);
  });

  it('measures distance and angles between faces', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const solidId = clean.solid_id;

    // Explore topology to get faces
    const faces = await dispatchTool('explore_topology', { target: solidId, return_type: 'face' }, config) as any;
    expect(faces.entity_ids.length).toBeGreaterThanOrEqual(6);

    const faceA = faces.entity_ids[0];
    const faceB = faces.entity_ids[1];

    // Measure distance
    const dist = await dispatchTool('measure_distance', { target_a: faceA, target_b: faceB, measurement_type: 'min_distance' }, config) as any;
    expect(dist.value).toBeGreaterThanOrEqual(0);
    expect(dist.measurement_type).toBe('min_distance');

    // Angle between planar faces
    const angle = await dispatchTool('measure_distance', { target_a: faceA, target_b: faceB, measurement_type: 'angle' }, config) as any;
    expect(angle.value).toBeGreaterThanOrEqual(0);
    expect(angle.value).toBeLessThanOrEqual(180);
    expect(angle.measurement_type).toBe('angle');
  });

  it('throws GE_ALIGN_UNSUPPORTED for angle measurement on non-planar input', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const solidId = clean.solid_id;

    // Get edges
    const edges = await dispatchTool('explore_topology', { target: solidId, return_type: 'edge' }, config) as any;
    expect(edges.entity_ids.length).toBeGreaterThanOrEqual(12);

    const edgeA = edges.entity_ids[0];
    const faces = await dispatchTool('explore_topology', { target: solidId, return_type: 'face' }, config) as any;
    const faceA = faces.entity_ids[0];

    // Angle between face and edge should throw GE_ALIGN_UNSUPPORTED
    await expect(
      dispatchTool('measure_distance', { target_a: faceA, target_b: edgeA, measurement_type: 'angle' }, config)
    ).rejects.toMatchObject({
      code: ErrorCodes.GE_ALIGN_UNSUPPORTED
    });
  });

  it('explores topology on identical input deterministically', async () => {
    const clean = await dispatchTool('clean_geometry', { file_path: simpleBoxPath }, config) as any;
    const solidId = clean.solid_id;

    const res1 = await dispatchTool('explore_topology', { target: solidId, return_type: 'face' }, config) as any;
    const res2 = await dispatchTool('explore_topology', { target: solidId, return_type: 'face' }, config) as any;

    expect(res1.entity_ids).toEqual(res2.entity_ids);
  });

  it('throws GE_SOLID_NOT_FOUND for unknown entity id', async () => {
    await expect(
      dispatchTool('bounding_box', { target: 'non-existent-id' }, config)
    ).rejects.toMatchObject({
      code: ErrorCodes.GE_SOLID_NOT_FOUND
    });
  });
});
