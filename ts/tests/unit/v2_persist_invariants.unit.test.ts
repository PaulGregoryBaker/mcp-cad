/**
 * Structural graph invariants (spec 010, T014 — R-013 layer 3).
 * One failing fixture per invariant code.
 */
import { describe, expect, it } from 'vitest';
import { checkGraphInvariants, checkStoreInvariants, type InvariantCode } from '../../src/v2/graph/invariants';
import type { PartGraphSnapshot } from '../../src/v2/graph/store';
import { bentPlate, snapshotCopy } from '../helpers/v2-fixtures';

function codes(s: PartGraphSnapshot): InvariantCode[] {
  return checkGraphInvariants(s).map((v) => v.code);
}

function fresh(): PartGraphSnapshot {
  const f = bentPlate();
  return snapshotCopy(f.store, f.partId);
}

describe('[persist] checkGraphInvariants', () => {
  it('a GraphStore-built part has no violations', () => {
    expect(codes(fresh())).toEqual([]);
  });

  it('after delete_node(bend) the re-parented tree is still valid', () => {
    const f = bentPlate();
    f.store.deleteBendNode(f.bend1);
    expect(codes(f.store.snapshotPart(f.partId))).toEqual([]);
  });

  const cases: Array<[string, (s: PartGraphSnapshot) => void, InvariantCode]> = [
    ['root panel missing', (s) => (s.part.rootRegionPanelId = 'nope'), 'INV_ROOT_PANEL_MISSING'],
    ['root panel merged', (s) => (s.regionPanels.find((p) => p.regionPanelId === s.part.rootRegionPanelId)!.mergedIntoRegionPanelId = 'x'), 'INV_ROOT_PANEL_MISSING'],
    ['foreign region panel', (s) => (s.regionPanels[1]!.partId = 'other'), 'INV_FOREIGN_ROW'],
    ['foreign bend', (s) => (s.bends[0]!.partId = 'other'), 'INV_FOREIGN_ROW'],
    ['duplicate panel id', (s) => s.regionPanels.push({ ...s.regionPanels[0]! }), 'INV_DUPLICATE_ID'],
    ['duplicate hole id', (s) => (s.part.holes[1]!.holeId = s.part.holes[0]!.holeId), 'INV_DUPLICATE_ID'],
    ['dangling bend parent', (s) => (s.bends[0]!.parentRegionPanelId = 'ghost'), 'INV_BEND_DANGLING'],
    ['bend onto merged panel', (s) => (s.regionPanels.find((p) => p.regionPanelId === s.bends[1]!.childRegionPanelId)!.mergedIntoRegionPanelId = s.part.rootRegionPanelId), 'INV_BEND_DANGLING'],
    ['self-loop bend', (s) => (s.bends[0]!.childRegionPanelId = s.bends[0]!.parentRegionPanelId), 'INV_BEND_TOPOLOGY'],
    ['cycle back to root', (s) => (s.bends[1]!.childRegionPanelId = s.part.rootRegionPanelId), 'INV_BEND_TOPOLOGY'],
    ['orphaned live panel', (s) => s.bends.splice(1, 1), 'INV_BEND_TOPOLOGY'],
    ['thickness 0', (s) => (s.part.thicknessMm = 0), 'INV_PARAM_RANGE'],
    ['kFactor 1.5', (s) => (s.part.kFactor = 1.5), 'INV_PARAM_RANGE'],
    ['bend override -0.1', (s) => (s.bends[0]!.kFactorOverride = -0.1), 'INV_PARAM_RANGE'],
    ['angle NaN', (s) => (s.bends[0]!.angleDeg = Number.NaN), 'INV_BEND_PARAM'],
    ['negative radius', (s) => (s.bends[0]!.radiusMm = -2), 'INV_BEND_PARAM'],
    ['self merge', (s) => (s.part.mergedIntoPartId = s.part.partId), 'INV_MERGE_SELF'],
  ];

  it.each(cases)('%s → %s', (_label, mutate, expected) => {
    const s = fresh();
    mutate(s);
    expect(codes(s)).toContain(expected);
  });

  it('kFactor 0 and out-of-range angles are storable (angle range is a finding, not corruption)', () => {
    const s = fresh();
    s.part.kFactor = 0;
    s.bends[0]!.angleDeg = -200;
    s.bends[1]!.angleDeg = 0;
    expect(codes(s)).toEqual([]);
  });

  it('a merged-away tombstone skips tree checks (its panels live on the absorbing part)', () => {
    const s = fresh();
    s.part.mergedIntoPartId = 'absorber';
    s.regionPanels = [];
    s.bends = [];
    expect(codes(s)).toEqual([]);
  });

  it('never inspects geometry (principle IV): a self-intersecting outline is not an invariant violation', () => {
    const s = fresh();
    s.part.outline = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(codes(s)).toEqual([]);
  });
});

describe('[persist] checkStoreInvariants', () => {
  it('flags a missing merge target and an orphaned client_meta row', () => {
    const a = fresh();
    const b = fresh();
    b.part.mergedIntoPartId = 'does-not-exist';
    const v = checkStoreInvariants([a, b], [a.part.partId, 'ghost-part']);
    expect(v.map((x) => x.code).sort()).toEqual(['INV_MERGE_TARGET_MISSING', 'INV_META_ORPHAN']);
  });

  it('accepts a valid merge target', () => {
    const a = fresh();
    const b = fresh();
    b.part.mergedIntoPartId = a.part.partId;
    expect(checkStoreInvariants([a, b], [a.part.partId, b.part.partId])).toEqual([]);
  });
});
