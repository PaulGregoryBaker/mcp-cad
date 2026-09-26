/**
 * Live-app regression (2026-09-16): split_part_at_bend on cauldron.step
 * "Component 2", clicking a bend with UI-displayed properties
 * angle=109.6deg, radius=3.00mm, position (-981.5,-529.6)->(-212.6,249.4) —
 * "doesn't succeed, and the 3D rendered parts are not correct."
 *
 * Root cause (part_split.hpp's own header comment has the full derivation):
 * chainABIsChild — which of this split's two candidate 2D chains is really
 * the child's own subtree — used to be decided by a single-neighboring-
 * vertex heuristic ("does the ring vertex right after the hinge sit on the
 * child side of nLeft"). On cauldron's real, complex geometry that
 * heuristic was wrong: a local notch immediately after the hinge sat on
 * the wrong side even though the whole chain it belonged to was really the
 * OTHER side's own material, silently swapping parentOutline and
 * childOutline outright — a 23-region-panel remainder got handed a
 * 6-vertex outline it could never actually contain, and a 1-panel leaf got
 * handed the other 48. That corrupted part then failed later, silently, at
 * constructPartSolid (GE_BRIDGE_EDGE_NOT_FOUND) — the split itself
 * reported success. Fixed by deciding chainABIsChild from a caller-
 * supplied childHintPoint (a point Evaluate() already knows, with
 * certainty, lies inside the child region panel's own true territory) via
 * point-in-polygon, never guessed from local ring geometry.
 *
 * Not specific to this session's lap-joint rework: the failure was on the
 * TRIMMED side (never touched by the extension formula) — a pre-existing
 * bug in code untouched by that work, only now exposed by a real,
 * complex, branching multi-bend outline.
 *
 * Gated behind SUITE_V2_DRIVER=1, same convention as the other cauldron/
 * split_part_at_bend integration suites.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart, evaluatePart } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'cpp', 'tests', 'fixtures');

interface ImportPartResult {
  part_id: string;
  component_part_ids: string[];
}

function shoelaceArea(poly: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

function hasNaN(poly: Array<{ x: number; y: number }>): boolean {
  return poly.some((p) => Number.isNaN(p.x) || Number.isNaN(p.y));
}

/** Locates the reported bend (angle~109.6deg, hinge endpoints near
 * (-981.5,-529.6)/(-212.6,249.4)) among cauldron.step's imported components,
 * importing with the given default_bend_radius_mm (the UI showed
 * Radius: 3.00mm, which is NOT this fixture's fallback-to-thickness default
 * of 1.0mm — the live app must have set a 3mm default at import time). */
function findReportedBend(defaultBendRadiusMm: number) {
  const store = new GraphStore();
  const result = dispatchGraphTool(store, 'import_part', {
    file: path.join(FIXTURES, 'cauldron.step'),
    profile: { rules: { default_bend_radius_mm: defaultBendRadiusMm } },
  }) as ImportPartResult;

  const allPartIds = [result.part_id, ...result.component_part_ids];
  for (let i = 0; i < allPartIds.length; i++) {
    const partId = allPartIds[i]!;
    const snap = store.snapshotPart(partId);
    for (const bend of snap.bends) {
      const hingeDist =
        Math.hypot(bend.hingeA.x - -981.5, bend.hingeA.y - -529.6) +
        Math.hypot(bend.hingeB.x - -212.6, bend.hingeB.y - 249.4);
      if (Math.abs(Math.abs(bend.angleDeg) - 109.6) < 1.0 && hingeDist < 10) {
        return { store, partId, indexAmongAll: i, bend };
      }
    }
  }
  throw new Error(`reported bend not found at default_bend_radius_mm=${defaultBendRadiusMm}`);
}

d('[v2] split_part_at_bend on cauldron.step real acute bend (live-app regression)', () => {
  it('locates the reported bend (angle~109.6deg, hinge near the reported endpoints) at '
    + 'default import, landing on component index 2 (the UI\'s "Component 2")', () => {
    const { indexAmongAll } = findReportedBend(1.0);
    expect(indexAmongAll).toBe(2); // component_part_ids[1]
  });

  for (const keepCornerOn of ['parent', 'child'] as const) {
    it(`split_part_at_bend(keep_corner_on='${keepCornerOn}') on the reported bend produces two `
      + 'real, constructible parts — not a silently-swapped outline that only fails later', () => {
      const { store, partId, bend } = findReportedBend(3);

      const splitResult = dispatchGraphTool(store, 'split_part_at_bend', {
        part_id: partId,
        bend_id: bend.bendId,
        keep_corner_on: keepCornerOn,
      }) as { part_id: string; new_part_ids: string[] };

      const allResultIds = [splitResult.part_id, ...splitResult.new_part_ids];
      expect(allResultIds).toHaveLength(2);

      for (const id of allResultIds) {
        const part = store.getPart(id);
        expect(part, `resulting part ${id} must exist`).toBeDefined();
        const outline = part!.outline;
        expect(hasNaN(outline), `outline of ${id} contains NaN`).toBe(false);
        expect(shoelaceArea(outline), `outline of ${id} has ~zero area`).toBeGreaterThan(1e-6);

        // The real bar: a split that reports success must produce a part
        // that can actually be constructed and rendered — never a part
        // that looks fine here and only fails later, silently, when a
        // user opens the 3D view.
        const constructed = constructPart(store, id);
        const manifold = geometryBinding.checkManifold(constructed.shellId) as unknown as {
          isManifold?: boolean;
          issues?: unknown;
        };
        expect(
          manifold.isManifold,
          `part ${id} (split off cauldron.step's real bend) constructed but is not manifold: ` +
            JSON.stringify(manifold.issues),
        ).toBe(true);
      }

      // The 23-region-panel remainder must never end up with a tiny,
      // few-vertex outline it couldn't possibly contain (the original
      // symptom: parentOutline and childOutline silently swapped).
      const outlineSizes = allResultIds.map((id) => store.getPart(id)!.outline.length).sort((a, b) => a - b);
      expect(outlineSizes[1]).toBeGreaterThan(10);
    });
  }

  // Live-app regression (2026-09-22): after splitting Component 2 at the
  // reported bend, merging the split-off child ("Component 2 Part 1") with a
  // sibling component ("Component 3") that visibly touches it in the 3D view
  // failed with GE_MERGE_NO_CONTACT. Root cause: every "component" cauldron.
  // step decomposes into is itself a real multi-bend body (8-32 bends each),
  // and merge_bodies_with_bend's detectContact used to only ever check a
  // part's ROOT panel (via its root anchor applied to the whole flat
  // pattern) — real contact on a NON-root panel of the sibling was invisible
  // to it. Fixed by testing every region panel of both parts, via each
  // panel's own true (pose-cascaded) world position, not the part's root
  // anchor. The real fixed geometry here also touches along THREE
  // simultaneous regions at once (a real multi-seam contact) — exercising
  // the companion fix (return every region, require an explicit pick when
  // more than one is found, GE_MERGE_AMBIGUOUS_CONTACT) in the same test.
  it('REGRESSION: merging the split-off child with the sibling component it really '
    + 'touches (on a non-root panel, along multiple simultaneous seams) succeeds', () => {
    const { store, partId: component2Id, bend } = findReportedBend(3);

    const splitResult = dispatchGraphTool(store, 'split_part_at_bend', {
      part_id: component2Id,
      bend_id: bend.bendId,
      keep_corner_on: 'parent',
    }) as { part_id: string; new_part_ids: string[] };
    const childPartId = splitResult.new_part_ids[0]!;
    const childOutlineLenBeforeMerge = store.getPart(childPartId)!.outline.length;

    // Find whichever OTHER live top-level part this split-off child actually,
    // physically touches — ground truth via detectContact itself, over every
    // region panel of each candidate, not a guess at which "Component N" the
    // UI would have labeled it.
    const everyLivePartId = store
      .snapshotAll()
      .parts.map((p) => p.partId)
      .filter((id) => id !== childPartId && id !== splitResult.part_id && store.getPart(id)!.mergedIntoPartId === null);

    const childLayout = evaluatePart(store, childPartId);
    expect(childLayout.ok).toBe(true);
    const childPanels = childLayout.panels.map((p) => ({
      outline: p.rawOuter,
      pose: p.pose,
      regionPanelId: p.regionPanelId,
    }));

    let touchingSiblingId: string | undefined;
    let firstRegion: { regionPanelIdA: string; regionPanelIdB: string } | undefined;
    for (const candidateId of everyLivePartId) {
      const candidateLayout = evaluatePart(store, candidateId);
      if (!candidateLayout.ok) continue;
      const candidatePanels = candidateLayout.panels.map((p) => ({
        outline: p.rawOuter,
        pose: p.pose,
        regionPanelId: p.regionPanelId,
      }));
      const contact = geometryBinding.detectContact(childPanels, candidatePanels);
      if (contact.ok && contact.regions.length > 0) {
        touchingSiblingId = candidateId;
        firstRegion = contact.regions[0]!;
        break;
      }
    }
    expect(
      touchingSiblingId,
      'the split-off child must have a real sibling it physically touches on some panel',
    ).toBeDefined();

    // The real geometry here touches along MORE than one region at once (a
    // genuine multi-seam contact, per the user's own report) — merge_bodies_
    // with_bend correctly refuses to guess which one and requires an explicit
    // selection (GE_MERGE_AMBIGUOUS_CONTACT); pick the first real candidate.
    const mergeResult = dispatchGraphTool(store, 'merge_bodies_with_bend', {
      part_a_id: childPartId,
      part_b_id: touchingSiblingId,
      region_panel_id_a: firstRegion!.regionPanelIdA,
      region_panel_id_b: firstRegion!.regionPanelIdB,
    }) as { part_id: string; bend_id: string; child_region_panel_id: string };

    expect(mergeResult.part_id).toBe(childPartId);
    expect(mergeResult.bend_id).toBeTruthy();

    // The merge must have actually happened, not just reported success.
    const mergedPart = store.getPart(childPartId)!;
    expect(mergedPart.outline.length).toBeGreaterThan(childOutlineLenBeforeMerge);
    expect(store.getPart(touchingSiblingId!)!.mergedIntoPartId).toBe(childPartId);
  });
});
