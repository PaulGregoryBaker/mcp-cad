/**
 * T065 (spec 010 US3): preview_import writes nothing; unit detection; scale,
 * quarter-turn rotation and recenter; preview_id reuse; TTL; and a configured
 * import_part is exactly one action_log operation with its import_source row
 * and client_meta docs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { dispatchSessionTool } from '../../src/v2/tools/graph';
import { SessionContext } from '../../src/v2/persistence/session';
import { resetStorageAccountsCache } from '../../src/config/storage-accounts';
import { detectStepUnits, setPreviewTtlForTests } from '../../src/v2/tools/import-preview';
import { startDolt, withTestAccount, type DoltHarness } from '../helpers/dolt-harness';

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');
const BRACKET = path.join(FIXTURES_DIR, 'l_bracket_corner_90deg.stp');
const AUTHOR = { name: 'Pat Tester', email: 'pat@example.test' };
const DEFAULTS = { defaultMaterial: 'mildSteel', defaultThicknessMm: 1.5, unitSystem: 'metric', preferredBendProcesses: ['airBend'] };

const MM = { preset: 'mm', factor: 1 };
const NO_TURN = { xQuarterTurns: 0, yQuarterTurns: 0, zQuarterTurns: 0 };
const NO_RECENTER = { xy: false, z: 'none' };

let h: DoltHarness;
let restoreEnv: () => void;
let tmp: string;
let n = 0;
const contexts: SessionContext[] = [];

type Bbox = { x_min: number; y_min: number; z_min: number; x_max: number; y_max: number; z_max: number };
type Preview = {
  preview_id: string;
  glb_url: string;
  detected_units: string;
  bbox_mm: Bbox;
  center_of_mass_mm: { x: number; y: number; z: number };
  measured_thickness_mm: number | null;
};

function call<T = Record<string, any>>(ctx: SessionContext, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return dispatchSessionTool(ctx, name, args) as Promise<T>;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { structured?: { code: string } }).structured?.code ?? String(e);
  }
}

async function bound(defaults: Record<string, unknown> | null = DEFAULTS): Promise<{ ctx: SessionContext; db: string }> {
  const ctx = new SessionContext();
  contexts.push(ctx);
  const db = `t_imp_${++n}`;
  await call(ctx, 'create_project', { account: 'test', database: db, name: `I${n}` });
  await call(ctx, 'open_project', { account: 'test', database: db, author: AUTHOR });
  await call(ctx, 'branch_begin', { label: 'work' });
  if (defaults) await call(ctx, 'update_project_settings', { manufacturing_defaults: defaults });
  return { ctx, db };
}

async function rows(db: string, sql: string): Promise<RowDataPacket[]> {
  const c = await h.connect();
  try {
    const [r] = await c.query<RowDataPacket[]>(sql.replace(/\$DB/g, `\`${db}/wip/work\``));
    return r;
  } finally {
    await c.end();
  }
}

const size = (b: Bbox) => [b.x_max - b.x_min, b.y_max - b.y_min, b.z_max - b.z_min];

/** The bracket, re-declared in inches (same numbers): OCCT loads it 25.4× larger. */
function inchCopy(): string {
  const src = fs.readFileSync(BRACKET, 'latin1');
  const out = src
    .replace(
      '#634 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
      "#634 = ( CONVERSION_BASED_UNIT('INCH',#640) LENGTH_UNIT() NAMED_UNIT(#641) );\n" +
        '#639 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n' +
        '#640 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#639);\n' +
        '#641 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);',
    );
  expect(out).not.toBe(src);
  const p = path.join(tmp, 'bracket_inch.stp');
  fs.writeFileSync(p, out, 'latin1');
  return p;
}

describe('detectStepUnits', () => {
  it('reads SI prefixes and conversion-based units; conversion wins over its SI base', () => {
    expect(detectStepUnits('#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );')).toBe('mm');
    expect(detectStepUnits('#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );')).toBe('m');
    expect(detectStepUnits('#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );')).toBe('cm');
    expect(
      detectStepUnits(
        "#9 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n#10 = ( CONVERSION_BASED_UNIT('INCH',#11) LENGTH_UNIT() NAMED_UNIT(#12) );",
      ),
    ).toBe('in');
    expect(detectStepUnits("#1 = ( CONVERSION_BASED_UNIT('FOOT',#2) LENGTH_UNIT() NAMED_UNIT(#3) );")).toBe('ft');
    expect(detectStepUnits('#1 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );')).toBe('unknown');
  });
});

describe('[persist] preview_import + configured import_part', () => {
  beforeAll(async () => {
    h = await startDolt();
    restoreEnv = withTestAccount(h);
    resetStorageAccountsCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcad-import-'));
  });
  afterEach(async () => {
    setPreviewTtlForTests(null);
    for (const c of contexts.splice(0)) await c.unbind();
  });
  afterAll(async () => {
    restoreEnv?.();
    await h?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes nothing and leaves the store untouched', async () => {
    const { ctx, db } = await bound();
    const before = (await rows(db, 'SELECT COUNT(*) AS n FROM $DB.action_log'))[0]!['n'];
    const p = await call<Preview>(ctx, 'preview_import', { file: BRACKET });
    expect(p.detected_units).toBe('mm');
    expect(p.glb_url).toMatch(/^http:\/\/localhost:\d+\/v2-blob\/preview\//);
    expect(p.measured_thickness_mm).toBeCloseTo(1.5, 3);
    expect(ctx.store.partIds()).toEqual([]);
    expect((await rows(db, 'SELECT COUNT(*) AS n FROM $DB.action_log'))[0]!['n']).toBe(before);
    expect((await rows(db, 'SELECT COUNT(*) AS n FROM $DB.import_source'))[0]!['n']).toBe(0);
  });

  it('works with no project bound (no store access)', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    const p = await call<Preview>(ctx, 'preview_import', { file: BRACKET });
    expect(p.preview_id).toBeTruthy();
  });

  it('detects inches; the detected preset is a no-op and mm undoes the conversion', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    const mmFile = await call<Preview>(ctx, 'preview_import', { file: BRACKET });
    const file = inchCopy();
    const asIn = await call<Preview>(ctx, 'preview_import', {
      file,
      config: { scale: { preset: 'in', factor: 25.4 }, rotation: NO_TURN, recenter: NO_RECENTER },
    });
    expect(asIn.detected_units).toBe('in');
    size(asIn.bbox_mm).forEach((v, i) => expect(v).toBeCloseTo(size(mmFile.bbox_mm)[i]! * 25.4, 3));
    // 38.1 mm is beyond the kernel's sheet-metal limit: no measurement at
    // this scale — never the kernel's substituted default (§IX)...
    expect(asIn.measured_thickness_mm).toBeNull();
    const asMm = await call<Preview>(ctx, 'preview_import', {
      preview_id: asIn.preview_id,
      config: { scale: MM, rotation: NO_TURN, recenter: NO_RECENTER },
    });
    size(asMm.bbox_mm).forEach((v, i) => expect(v).toBeCloseTo(size(mmFile.bbox_mm)[i]!, 3));
    // ...while at the scale that makes it sheet metal it is measured.
    expect(asMm.measured_thickness_mm).toBeCloseTo(1.5, 3);
  });

  it('scale 25.4 multiplies the bounding box; X+90° swaps Y and Z extents', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    const base = await call<Preview>(ctx, 'preview_import', { file: BRACKET, config: { scale: MM, rotation: NO_TURN, recenter: NO_RECENTER } });
    const scaled = await call<Preview>(ctx, 'preview_import', {
      preview_id: base.preview_id,
      config: { scale: { preset: 'in', factor: 25.4 }, rotation: NO_TURN, recenter: NO_RECENTER },
    });
    size(scaled.bbox_mm).forEach((v, i) => expect(v).toBeCloseTo(size(base.bbox_mm)[i]! * 25.4, 3));
    expect(base.measured_thickness_mm).toBeCloseTo(1.5, 3);

    const turned = await call<Preview>(ctx, 'preview_import', {
      preview_id: base.preview_id,
      config: { scale: MM, rotation: { xQuarterTurns: 1, yQuarterTurns: 0, zQuarterTurns: 0 }, recenter: NO_RECENTER },
    });
    const [bx, by, bz] = size(base.bbox_mm);
    const [tx, ty, tz] = size(turned.bbox_mm);
    expect(tx).toBeCloseTo(bx!, 3);
    expect(ty).toBeCloseTo(bz!, 3);
    expect(tz).toBeCloseTo(by!, 3);
  });

  it('recenter: floor puts min z at 0, xy puts the centre of mass over the origin; com puts it at z=0', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    const floor = await call<Preview>(ctx, 'preview_import', {
      file: BRACKET,
      config: { scale: MM, rotation: NO_TURN, recenter: { xy: true, z: 'floor' } },
    });
    expect(floor.bbox_mm.z_min).toBeCloseTo(0, 6);
    expect(floor.center_of_mass_mm.x).toBeCloseTo(0, 6);
    expect(floor.center_of_mass_mm.y).toBeCloseTo(0, 6);
    const com = await call<Preview>(ctx, 'preview_import', {
      preview_id: floor.preview_id,
      config: { scale: MM, rotation: NO_TURN, recenter: { xy: false, z: 'com' } },
    });
    expect(com.center_of_mass_mm.z).toBeCloseTo(0, 6);
  });

  it('a preview_id re-call is cheaper and identical', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    const cfg = { scale: MM, rotation: { xQuarterTurns: 0, yQuarterTurns: 1, zQuarterTurns: 0 }, recenter: { xy: true, z: 'floor' } };
    let t = Date.now();
    const first = await call<Preview>(ctx, 'preview_import', { file: BRACKET, config: cfg });
    const firstMs = Date.now() - t;
    t = Date.now();
    const again = await call<Preview>(ctx, 'preview_import', { preview_id: first.preview_id, config: cfg });
    const againMs = Date.now() - t;
    expect(again).toEqual(first);
    expect(againMs).toBeLessThan(firstMs);
  });

  it('an expired preview_id → PREVIEW_EXPIRED; a missing file → IMPORT_FILE_NOT_FOUND', async () => {
    const ctx = new SessionContext();
    contexts.push(ctx);
    setPreviewTtlForTests(1);
    const p = await call<Preview>(ctx, 'preview_import', { file: BRACKET });
    await new Promise((r) => setTimeout(r, 10));
    expect(await codeOf(call(ctx, 'preview_import', { preview_id: p.preview_id }))).toBe('PREVIEW_EXPIRED');
    expect(await codeOf(call(ctx, 'preview_import', { file: path.join(tmp, 'nope.stp') }))).toBe('IMPORT_FILE_NOT_FOUND');
  });

  it('import_part: one action_log row + the import_source row + grouped client_meta docs; material, thickness, K-factor applied', async () => {
    const { ctx, db } = await bound();
    const p = await call<Preview>(ctx, 'preview_import', { file: BRACKET });
    const opsBefore = Number((await rows(db, 'SELECT COUNT(*) AS n FROM $DB.action_log'))[0]!['n']);
    const config = { scale: MM, rotation: NO_TURN, recenter: { xy: true, z: 'floor' }, thicknessMm: 2.0, materialId: 'mildSteel' };
    const r = await call(ctx, 'import_part', { preview_id: p.preview_id, config });

    expect(r['import_source_id']).toBeTruthy();
    expect(r['action_seq']).toBeGreaterThan(0);
    expect(r['measured_thickness_mm']).toBeCloseTo(1.5, 3);
    const ops = await rows(db, 'SELECT tool FROM $DB.action_log ORDER BY seq');
    expect(ops.length).toBe(opsBefore + 1);
    expect(ops.at(-1)!['tool']).toBe('import_part');

    const src = await rows(db, 'SELECT * FROM $DB.import_source');
    expect(src.length).toBe(1);
    expect(src[0]!['import_source_id']).toBe(r['import_source_id']);
    expect(src[0]!['file_path']).toBe(BRACKET);
    expect(src[0]!['file_sha256']).toMatch(/^[0-9a-f]{64}$/);
    const storedCfg = typeof src[0]!['config'] === 'string' ? JSON.parse(src[0]!['config']) : src[0]!['config'];
    expect(storedCfg).toEqual(config);

    const partIds = ctx.store.partIds();
    expect(partIds).toContain(r['part_id']);
    for (const id of partIds) {
      const snap = ctx.store.snapshotPart(id);
      expect(snap.part.thicknessMm).toBe(2.0);
      expect(snap.part.materialId).toBe('mildSteel');
      expect(snap.part.kFactor).toBeCloseTo(0.39, 9);
      for (const b of snap.bends) expect(b.kFactorOverride).toBeNull();
    }
    const meta = await rows(db, 'SELECT part_id, doc FROM $DB.client_meta');
    expect(meta.length).toBe(partIds.length);
    const main = meta.find((m) => m['part_id'] === r['part_id'])!;
    const doc = typeof main['doc'] === 'string' ? JSON.parse(main['doc']) : main['doc'];
    expect(doc).toMatchObject({ v: 1, displayName: 'l_bracket_corner_90deg', groupId: r['import_source_id'], groupName: 'l_bracket_corner_90deg', importSourceId: r['import_source_id'] });

    // Undo removes the whole import in one step, import_source included.
    await call(ctx, 'undo');
    expect(ctx.store.partIds()).toEqual([]);
    expect((await rows(db, 'SELECT COUNT(*) AS n FROM $DB.import_source'))[0]!['n']).toBe(0);
  });

  it('the cached solid survives measuring and importing: identity config, two imports from one preview', async () => {
    const { ctx } = await bound();
    const identity = { scale: MM, rotation: NO_TURN, recenter: NO_RECENTER };
    const p = await call<Preview>(ctx, 'preview_import', { file: BRACKET, config: identity });
    expect(p.measured_thickness_mm).toBeCloseTo(1.5, 3);
    const config = { ...identity, thicknessMm: 1.5, materialId: 'mildSteel' };
    const a = await call(ctx, 'import_part', { preview_id: p.preview_id, config });
    const b = await call(ctx, 'import_part', { preview_id: p.preview_id, config });
    expect(a['bend_count']).toBe(b['bend_count']);
    expect(a['panel_count']).toBeGreaterThan(0);
    const again = await call<Preview>(ctx, 'preview_import', { preview_id: p.preview_id, config: identity });
    expect(again.measured_thickness_mm).toBeCloseTo(1.5, 3);
  });

  it('import_part refuses: no project defaults, a non-catalogue thickness, a missing config', async () => {
    const { ctx } = await bound(null);
    const config = { scale: MM, rotation: NO_TURN, recenter: NO_RECENTER, thicknessMm: 2.0, materialId: 'mildSteel' };
    expect(await codeOf(call(ctx, 'import_part', { file: BRACKET, config }))).toBe('IMPORT_DEFAULTS_MISSING');
    await call(ctx, 'update_project_settings', { manufacturing_defaults: DEFAULTS });
    expect(await codeOf(call(ctx, 'import_part', { file: BRACKET, config: { ...config, thicknessMm: 2.1 } }))).toBe(
      'IMPORT_THICKNESS_NOT_IN_CATALOGUE',
    );
    expect(await codeOf(call(ctx, 'import_part', { file: BRACKET }))).toBe('INVALID_TOOL_ARGS');
    expect(ctx.store.partIds()).toEqual([]);
  });
});
