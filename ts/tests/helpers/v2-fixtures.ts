/**
 * Small, addon-free GraphStore fixtures for persistence tests (spec 010).
 * Built through GraphStore's own mutators so they are exactly the shapes the
 * real tools produce — no hand-written row literals to drift.
 */
import { randomUUID } from 'crypto';
import { GraphStore, type PartGraphSnapshot } from '../../src/v2/graph/store';

export interface BentPlate {
  store: GraphStore;
  partId: string;
  rootId: string;
  flangeId: string;
  tipId: string;
  bend1: string;
  bend2: string;
}

/**
 * A 100x60 plate, a flange bent up at y=40 and a tip bent at y=50, plus one
 * circle and one polygon hole on the root panel.
 */
export function bentPlate(store = new GraphStore(), name = 'plate'): BentPlate {
  const part = store.createPart({
    name,
    outline: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ],
    thicknessMm: 2,
    materialId: 'mildSteel',
    kFactor: 0.33,
  });
  const b1 = store.createBendNode({
    partId: part.partId,
    parentRegionPanelId: part.rootRegionPanelId,
    hingeA: { x: 0, y: 40 },
    hingeB: { x: 100, y: 40 },
    angleDeg: 90,
    radiusMm: 2,
  });
  const b2 = store.createBendNode({
    partId: part.partId,
    parentRegionPanelId: b1.childRegionPanel.regionPanelId,
    hingeA: { x: 0, y: 50 },
    hingeB: { x: 100, y: 50 },
    angleDeg: -45,
    radiusMm: 1,
  });
  store.addCutHole({
    partId: part.partId,
    regionPanelId: part.rootRegionPanelId,
    hole: { kind: 'circle', holeId: randomUUID(), center: { x: 20, y: 20 }, radiusMm: 4 },
  });
  store.addCutHole({
    partId: part.partId,
    regionPanelId: part.rootRegionPanelId,
    hole: {
      kind: 'polygon',
      holeId: randomUUID(),
      ring: [
        { x: 50, y: 10 },
        { x: 50, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 10 },
      ],
    },
  });
  return {
    store,
    partId: part.partId,
    rootId: part.rootRegionPanelId,
    flangeId: b1.childRegionPanel.regionPanelId,
    tipId: b2.childRegionPanel.regionPanelId,
    bend1: b1.bend.bendId,
    bend2: b2.bend.bendId,
  };
}

/** Deep, independent copy of a part's snapshot (safe to mutate in tests). */
export function snapshotCopy(store: GraphStore, partId: string): PartGraphSnapshot {
  return structuredClone(store.snapshotPart(partId));
}
