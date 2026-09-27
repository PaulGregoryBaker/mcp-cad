/**
 * Exports the persisted-data contract (spec 010, T026): JSON Schema generated
 * from the Zod schemas, plus deterministic valid/invalid sample documents.
 * The Form·AI·tion client copies this folder (scripts/sync_contract_fixtures.ps1)
 * and its tests parse the same samples, so a format change on one side without
 * the other fails a test (and the CI hash check).
 *
 *   npm run schemas:export
 *
 * Each invalid sample has a sidecar <name>.expect.json:
 *   { "layer": "shape" | "invariant", "code": "<zod path prefix | INV_* code>" }
 */

import * as fs from 'fs';
import * as path from 'path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PersistedSchemas, type PersistedKind } from '../src/v2/schemas/persistence';

const OUT = path.resolve(__dirname, '..', 'contract-fixtures', 'persistence');

type Json = Record<string, unknown>;
type Invalid = { name: string; doc: unknown; layer: 'shape' | 'invariant'; code: string };

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const snapshot = (): Json => ({
  part: {
    partId: ID(1),
    name: 'Bracket',
    rootRegionPanelId: ID(10),
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ],
    holes: [
      { kind: 'circle', holeId: ID(30), center: { x: 20, y: 20 }, radiusMm: 4 },
      { kind: 'polygon', holeId: ID(31), ring: [{ x: 50, y: 10 }, { x: 50, y: 20 }, { x: 60, y: 20 }] },
    ],
    anchor: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] },
    materialId: 'mildSteel',
    thicknessMm: 2,
    kFactor: 0.33,
    schemaVersion: '0.1',
    mergedIntoPartId: null,
  },
  regionPanels: [
    { regionPanelId: ID(10), partId: ID(1), label: 'root', kFactorOverride: null, mergedIntoRegionPanelId: null },
    { regionPanelId: ID(11), partId: ID(1), label: 'flange', kFactorOverride: 0.4, mergedIntoRegionPanelId: null },
  ],
  bends: [
    {
      bendId: ID(20),
      partId: ID(1),
      parentRegionPanelId: ID(10),
      childRegionPanelId: ID(11),
      hingeA: { x: 0, y: 40 },
      hingeB: { x: 100, y: 40 },
      angleDeg: 90,
      radiusMm: 2,
      kFactorOverride: null,
      bottomIsConcave: null,
      radiusMeasured: true,
      bendProcess: 'airBend',
    },
  ],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mutate = (f: (s: any) => void): Json => {
  const s = snapshot();
  f(s);
  return s;
};

const nesting = (): Json => ({
  sheets: [{ widthMm: 2440, heightMm: 1220, label: '8x4' }],
  safetyGapMm: 2,
  sheetMarginMm: 5,
  cuttingWidthMm: 0.2,
  rotationsDeg: [0, 90, 180, 270],
});

const defaults = (): Json => ({
  defaultMaterial: 'mildSteel',
  defaultThicknessMm: 3,
  unitSystem: 'metric',
  preferredBendProcesses: ['airBend'],
});

const profile = (): Json => ({
  minBendRadiusFactor: 1,
  maxBendAngleDeg: 180,
  defaultBendRadiusMm: 1,
  minHoleDiameterFactor: 1,
  minHoleToBendClearanceMm: 2,
  minHoleToEdgeClearanceMm: 2,
  minHoleToHoleDistanceMm: 2,
  minFlangeWidthFactor: 2,
});

const importConfig = (): Json => ({
  scale: { preset: 'in', factor: 25.4 },
  rotation: { xQuarterTurns: 1, yQuarterTurns: 0, zQuarterTurns: 0 },
  recenter: { xy: true, z: 'floor' },
  thicknessMm: 3,
  materialId: 'mildSteel',
});

const withoutKey = (o: Json, k: string): Json => {
  const c = { ...o };
  delete c[k];
  return c;
};

const samples: Record<PersistedKind, { valid: Record<string, unknown>; invalid: Invalid[] }> = {
  part_graph_snapshot: {
    valid: {
      bent_plate: snapshot(),
      kfactor_zero: mutate((s) => (s.part.kFactor = 0)),
      out_of_range_angle_is_storable: mutate((s) => (s.bends[0].angleDeg = -200)),
      merged_tombstone: mutate((s) => {
        s.part.mergedIntoPartId = ID(2);
        s.regionPanels = [];
        s.bends = [];
      }),
    },
    invalid: [
      { name: 'missing_outline', doc: mutate((s) => delete s.part.outline), layer: 'shape', code: 'part.outline' },
      { name: 'outline_two_points', doc: mutate((s) => (s.part.outline = s.part.outline.slice(0, 2))), layer: 'shape', code: 'part.outline' },
      { name: 'zero_thickness', doc: mutate((s) => (s.part.thicknessMm = 0)), layer: 'shape', code: 'part.thicknessMm' },
      { name: 'hole_without_id', doc: mutate((s) => delete s.part.holes[0].holeId), layer: 'shape', code: 'part.holes.0' },
      { name: 'unknown_key', doc: mutate((s) => (s.part.colour = 'red')), layer: 'shape', code: 'part' },
      { name: 'bend_negative_radius', doc: mutate((s) => (s.bends[0].radiusMm = -1)), layer: 'shape', code: 'bends.0.radiusMm' },
      { name: 'root_panel_missing', doc: mutate((s) => (s.part.rootRegionPanelId = ID(99))), layer: 'invariant', code: 'INV_ROOT_PANEL_MISSING' },
      { name: 'foreign_panel', doc: mutate((s) => (s.regionPanels[1].partId = ID(2))), layer: 'invariant', code: 'INV_FOREIGN_ROW' },
      { name: 'duplicate_hole_id', doc: mutate((s) => (s.part.holes[1].holeId = ID(30))), layer: 'invariant', code: 'INV_DUPLICATE_ID' },
      { name: 'dangling_bend', doc: mutate((s) => (s.bends[0].parentRegionPanelId = ID(98))), layer: 'invariant', code: 'INV_BEND_DANGLING' },
      { name: 'bend_cycle', doc: mutate((s) => (s.bends[0].childRegionPanelId = ID(10))), layer: 'invariant', code: 'INV_BEND_TOPOLOGY' },
      { name: 'orphan_panel', doc: mutate((s) => (s.bends = [])), layer: 'invariant', code: 'INV_BEND_TOPOLOGY' },
      { name: 'self_merge', doc: mutate((s) => (s.part.mergedIntoPartId = ID(1))), layer: 'invariant', code: 'INV_MERGE_SELF' },
    ],
  },
  project_settings: {
    valid: {
      all_null: { manufacturing_profile: null, manufacturing_defaults: null, nesting: null },
      all_set: { manufacturing_profile: profile(), manufacturing_defaults: defaults(), nesting: nesting() },
    },
    invalid: [
      {
        name: 'unknown_material',
        doc: { manufacturing_profile: null, manufacturing_defaults: { ...defaults(), defaultMaterial: 'unobtainium' }, nesting: null },
        layer: 'shape',
        code: 'manufacturing_defaults.defaultMaterial',
      },
      { name: 'missing_key', doc: { manufacturing_profile: null, nesting: null }, layer: 'shape', code: 'manufacturing_defaults' },
    ],
  },
  nesting_settings: {
    valid: { standard: nesting() },
    invalid: [
      { name: 'no_sheets', doc: { ...nesting(), sheets: [] }, layer: 'shape', code: 'sheets' },
      { name: 'rotation_45', doc: { ...nesting(), rotationsDeg: [0, 45] }, layer: 'shape', code: 'rotationsDeg' },
      { name: 'negative_gap', doc: { ...nesting(), safetyGapMm: -1 }, layer: 'shape', code: 'safetyGapMm' },
    ],
  },
  import_config: {
    valid: { inch_x90_floor: importConfig(), custom_scale: { ...importConfig(), scale: { preset: 'custom', factor: 2.5 } } },
    invalid: [
      { name: 'preset_factor_mismatch', doc: { ...importConfig(), scale: { preset: 'in', factor: 25 } }, layer: 'shape', code: 'scale' },
      {
        name: 'quarter_turns_4',
        doc: { ...importConfig(), rotation: { xQuarterTurns: 4, yQuarterTurns: 0, zQuarterTurns: 0 } },
        layer: 'shape',
        code: 'rotation.xQuarterTurns',
      },
      { name: 'mirror_not_allowed', doc: { ...importConfig(), mirror: { x: true } }, layer: 'shape', code: '(root)' },
      { name: 'missing_thickness', doc: withoutKey(importConfig(), 'thicknessMm'), layer: 'shape', code: 'thicknessMm' },
    ],
  },
  action_log_entry: {
    valid: {
      human: { seq: 3, at: '2026-09-27T12:00:00.000Z', actor_kind: 'human', actor_id: 'pat@example.test', tool: 'create_node', delta_summary: { parts: [ID(1)] }, undone: false },
      system_migration: { seq: 4, at: '2026-09-27T12:01:00.000Z', actor_kind: 'system', actor_id: 'system', tool: 'migrate', delta_summary: { from: 2, to: 3 }, undone: false },
    },
    invalid: [
      { name: 'bad_actor', doc: { seq: 1, at: 'x', actor_kind: 'robot', actor_id: '', tool: 't', delta_summary: {}, undone: false }, layer: 'shape', code: 'actor_kind' },
    ],
  },
  history_commit: {
    valid: {
      user_commit: {
        hash: 'k3j2h1',
        parents: ['a1b2c3'],
        date: '2026-09-27T12:05:00.000Z',
        author_name: 'Pat Tester',
        author_email: 'pat@example.test',
        message: 'Add flange',
        op_count: 3,
        agent_op_count: 1,
      },
    },
    invalid: [
      {
        name: 'negative_ops',
        doc: { hash: 'h', parents: [], date: 'd', author_name: '', author_email: '', message: '', op_count: -1, agent_op_count: 0 },
        layer: 'shape',
        code: 'op_count',
      },
    ],
  },
};

function write(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const kind of Object.keys(samples) as PersistedKind[]) {
  const dir = path.join(OUT, kind);
  write(path.join(dir, 'schema.json'), zodToJsonSchema(PersistedSchemas[kind], { name: kind, $refStrategy: 'none' }));
  for (const [name, doc] of Object.entries(samples[kind].valid)) write(path.join(dir, 'valid', `${name}.json`), doc);
  for (const inv of samples[kind].invalid) {
    write(path.join(dir, 'invalid', `${inv.name}.json`), inv.doc);
    write(path.join(dir, 'invalid', `${inv.name}.expect.json`), { layer: inv.layer, code: inv.code });
  }
}
console.log(`contract fixtures written to ${OUT}`);
