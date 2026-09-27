/**
 * Persisted-data Zod schemas (spec 010, T014 — R-013 layer 2).
 */
import { describe, expect, it } from 'vitest';
import { validatePersisted } from '../../src/v2/schemas/persistence';
import { bentPlate, snapshotCopy } from '../helpers/v2-fixtures';

function issues(kind: Parameters<typeof validatePersisted>[0], data: unknown): string[] {
  const r = validatePersisted(kind, data);
  return r.ok ? [] : r.issues;
}

describe('[persist] PartGraphSnapshotSchema', () => {
  it('accepts every snapshot GraphStore produces (bends, both hole kinds)', () => {
    const f = bentPlate();
    expect(issues('part_graph_snapshot', f.store.snapshotPart(f.partId))).toEqual([]);
  });

  it('accepts kFactor 0 (a real K-factor, create_part default)', () => {
    const f = bentPlate();
    const s = snapshotCopy(f.store, f.partId);
    s.part.kFactor = 0;
    expect(issues('part_graph_snapshot', s)).toEqual([]);
  });

  it.each([
    ['missing outline', (s: any) => delete s.part.outline, 'part.outline'],
    ['outline < 3 vertices', (s: any) => (s.part.outline = s.part.outline.slice(0, 2)), 'part.outline'],
    ['thickness 0', (s: any) => (s.part.thicknessMm = 0), 'part.thicknessMm'],
    ['kFactor > 1', (s: any) => (s.part.kFactor = 1.2), 'part.kFactor'],
    ['hole without id', (s: any) => delete s.part.holes[0].holeId, 'part.holes.0'],
    ['unknown key', (s: any) => (s.part.extra = 1), 'part'],
    ['bend negative radius', (s: any) => (s.bends[0].radiusMm = -1), 'bends.0.radiusMm'],
    ['bend missing radiusMeasured', (s: any) => delete s.bends[0].radiusMeasured, 'bends.0.radiusMeasured'],
    ['anchor wrong arity', (s: any) => (s.part.anchor.t = [0, 0]), 'part.anchor.t'],
  ])('rejects %s', (_label, mutate, path) => {
    const f = bentPlate();
    const s = snapshotCopy(f.store, f.partId);
    mutate(s);
    const found = issues('part_graph_snapshot', s);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toContain(path);
  });
});

describe('[persist] settings and import config schemas', () => {
  const nesting = {
    sheets: [{ widthMm: 2440, heightMm: 1220, label: '8x4' }],
    safetyGapMm: 2,
    sheetMarginMm: 5,
    cuttingWidthMm: 0.2,
    rotationsDeg: [0, 90, 180, 270],
  };

  it('accepts valid nesting settings', () => {
    expect(issues('nesting_settings', nesting)).toEqual([]);
  });

  it.each([
    ['empty sheets', { ...nesting, sheets: [] }],
    ['rotation 45', { ...nesting, rotationsDeg: [0, 45] }],
    ['repeated rotation', { ...nesting, rotationsDeg: [0, 0] }],
    ['negative gap', { ...nesting, safetyGapMm: -1 }],
    ['zero cutting width', { ...nesting, cuttingWidthMm: 0 }],
  ])('rejects nesting with %s', (_l, bad) => {
    expect(issues('nesting_settings', bad).length).toBeGreaterThan(0);
  });

  it('accepts project settings with nulls, rejects an unknown material', () => {
    expect(issues('project_settings', { manufacturing_profile: null, manufacturing_defaults: null, nesting: null })).toEqual([]);
    expect(
      issues('project_settings', {
        manufacturing_profile: null,
        manufacturing_defaults: { defaultMaterial: 'unobtainium', unitSystem: 'metric', preferredBendProcesses: [] },
        nesting: null,
      }).length,
    ).toBeGreaterThan(0);
  });

  const cfg = {
    scale: { preset: 'in', factor: 25.4 },
    rotation: { xQuarterTurns: 1, yQuarterTurns: 0, zQuarterTurns: 0 },
    recenter: { xy: true, z: 'floor' },
    thicknessMm: 3,
    materialId: 'mildSteel',
  };

  it('accepts a stored import config', () => {
    expect(issues('import_config', cfg)).toEqual([]);
  });

  it.each([
    ['preset factor mismatch', { ...cfg, scale: { preset: 'in', factor: 25 } }],
    ['quarter turns 4', { ...cfg, rotation: { ...cfg.rotation, xQuarterTurns: 4 } }],
    ['free angle', { ...cfg, rotation: { ...cfg.rotation, xQuarterTurns: 0.5 } }],
    ['bad z mode', { ...cfg, recenter: { xy: true, z: 'top' } }],
    ['stored without thickness', { ...cfg, thicknessMm: undefined }],
    ['mirror key', { ...cfg, mirror: { x: true } }],
  ])('rejects import config with %s', (_l, bad) => {
    expect(issues('import_config', bad).length).toBeGreaterThan(0);
  });

  it('custom preset allows any positive factor', () => {
    expect(issues('import_config', { ...cfg, scale: { preset: 'custom', factor: 2.5 } })).toEqual([]);
  });
});
