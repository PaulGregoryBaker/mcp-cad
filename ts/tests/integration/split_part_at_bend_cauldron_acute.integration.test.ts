/**
 * Diagnosis-only reproduction for a live-app bug report (2026-09-16):
 * split_part_at_bend on cauldron.step "Component 2", clicking a bend with
 * UI-displayed properties angle=109.6deg, radius=3.00mm, position
 * (-981.5,-529.6)->(-212.6,249.4) — "doesn't succeed, and the 3D rendered
 * parts are not correct."
 *
 * part_split.cc's lap-joint extension (this session's rework) was only ever
 * verified against |angleDeg|=90 fixtures (authored 2-panel tests,
 * testcube.step). This is the first exercise of the acute branch
 * (extensionMm = t*sin(|angle|) + t*tan(|angle|-90) for |angle|>90) against
 * a REAL bend from a real import.
 *
 * Gated behind SUITE_V2_DRIVER=1, same convention as the other cauldron/
 * split_part_at_bend integration suites.
 *
 * NOT a fix — diagnosis only. See the test bodies' own console.log output
 * for the captured failure mode.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';
import { toStructuredError } from '../../src/mcp/errors';

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
      const hingeDistA =
        Math.hypot(bend.hingeA.x - -981.5, bend.hingeA.y - -529.6) +
        Math.hypot(bend.hingeB.x - -212.6, bend.hingeB.y - 249.4);
      if (Math.abs(Math.abs(bend.angleDeg) - 109.6) < 1.0 && hingeDistA < 10) {
        return {
          store,
          importResult: result,
          partId,
          indexAmongAll: i,
          bend,
          thicknessMm: snap.part.thicknessMm,
        };
      }
    }
  }
  throw new Error(`reported bend not found at default_bend_radius_mm=${defaultBendRadiusMm}`);
}

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'cpp', 'tests', 'fixtures');

interface ImportPartResult {
  part_id: string;
  panel_count: number;
  protrusion_count: number;
  bend_count: number;
  notes: string[];
  protrusion_part_ids: string[];
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

d('[v2] split_part_at_bend on cauldron.step real acute bend (bug repro)', () => {
  // Default import_part (no profile) reconciles every bend's radiusMm to
  // this fixture's own thicknessMm (1.0mm) per import_part's own documented
  // fallback rule — NOT 3.00mm. The UI-reported "Radius: 3.00mm" therefore
  // means the live app imported with an explicit default_bend_radius_mm:3
  // profile; this first case just confirms the bend is real and locatable
  // by angle+hinge alone (radius-independent), landing on component index 2
  // (component_part_ids[1], i.e. the UI's "Component 2").
  it('locates the reported bend (angle~109.6deg, hinge near the reported endpoints) at default import', () => {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'cauldron.step'),
    }) as ImportPartResult;

    // eslint-disable-next-line no-console
    console.log(
      `[import] root=${result.part_id} components=${result.component_part_ids.length} ` +
        `protrusions=${result.protrusion_part_ids.length} bend_count(root)=${result.bend_count}`,
    );

    const allPartIds = [result.part_id, ...result.component_part_ids];
    let found: {
      partId: string;
      indexAmongAll: number;
      bendId: string;
      angleDeg: number;
      radiusMm: number;
      hingeA: { x: number; y: number };
      hingeB: { x: number; y: number };
      bottomIsConcave: boolean | null;
    } | undefined;

    for (let i = 0; i < allPartIds.length; i++) {
      const partId = allPartIds[i]!;
      const snap = store.snapshotPart(partId);
      for (const bend of snap.bends) {
        const hingeDist =
          Math.hypot(bend.hingeA.x - -981.5, bend.hingeA.y - -529.6) +
          Math.hypot(bend.hingeB.x - -212.6, bend.hingeB.y - 249.4);
        if (Math.abs(Math.abs(bend.angleDeg) - 109.6) < 1.0 && hingeDist < 10) {
          found = {
            partId,
            indexAmongAll: i,
            bendId: bend.bendId,
            angleDeg: bend.angleDeg,
            radiusMm: bend.radiusMm,
            hingeA: bend.hingeA,
            hingeB: bend.hingeB,
            bottomIsConcave: bend.bottomIsConcave,
          };
        }
      }
    }

    expect(found, 'no bend matching angle~109.6deg + reported hinge endpoints found in any imported part').toBeDefined();
    expect(found!.indexAmongAll).toBe(2); // component_part_ids[1] — the UI's "Component 2"
    // eslint-disable-next-line no-console
    console.log(`[FOUND] ${JSON.stringify(found)}`);
  });

  it('re-locates the same bend with default_bend_radius_mm=3 (matching the UI-reported 3.00mm radius)', () => {
    const { store, partId, indexAmongAll, bend, thicknessMm } = findReportedBend(3);
    // eslint-disable-next-line no-console
    console.log(
      `[FOUND @radius=3] partId=${partId} indexAmongAll=${indexAmongAll} bendId=${bend.bendId} ` +
        `angleDeg=${bend.angleDeg} radiusMm=${bend.radiusMm} hingeA=(${bend.hingeA.x},${bend.hingeA.y}) ` +
        `hingeB=(${bend.hingeB.x},${bend.hingeB.y}) bottomIsConcave=${bend.bottomIsConcave} thicknessMm=${thicknessMm}`,
    );
    expect(bend).toBeDefined();

    // Dump EVERY other live bend on this same part, to check whether any
    // OTHER bend's own hinge endpoint lands near the "extra" near-duplicate
    // vertices seen in the post-split trimmed side's outline
    // ((-978.89,-530.52) and (-210.03,248.53)).
    const snap = store.snapshotPart(partId);
    for (const b of snap.bends) {
      const distToExtraA = Math.hypot(b.hingeA.x - -978.8915392738735, b.hingeA.y - -530.5187651425126);
      const distToExtraB = Math.hypot(b.hingeA.x - -210.0277646844152, b.hingeA.y - 248.52989985913408);
      const distToExtraA2 = Math.hypot(b.hingeB.x - -978.8915392738735, b.hingeB.y - -530.5187651425126);
      const distToExtraB2 = Math.hypot(b.hingeB.x - -210.0277646844152, b.hingeB.y - 248.52989985913408);
      // eslint-disable-next-line no-console
      console.log(
        `  [otherBend] id=${b.bendId} angleDeg=${b.angleDeg.toFixed(2)} parent=${b.parentRegionPanelId} ` +
          `child=${b.childRegionPanelId} hingeA=(${b.hingeA.x.toFixed(2)},${b.hingeA.y.toFixed(2)}) ` +
          `hingeB=(${b.hingeB.x.toFixed(2)},${b.hingeB.y.toFixed(2)}) ` +
          `distToExtra=[${distToExtraA.toFixed(2)},${distToExtraB.toFixed(2)},${distToExtraA2.toFixed(2)},${distToExtraB2.toFixed(2)}]`,
      );
    }
  });

  // ROOT CAUSE (found via the sibling-bend dump above): this bend's own
  // hingeB, (-209.10,247.62), sits within ~1.3mm of a COMPLETELY DIFFERENT,
  // still-live bend's own hingeB (angleDeg=4.27deg) — a real mitered corner
  // where multiple bends converge on nearly the same point. part_split.hpp
  // is explicitly scoped to ground only ONE bend's hinge against the ring,
  // with "no knowledge of any other bend on the same ring" (its own header
  // comment) — so it happily returns a "trimmed" outline that still carries
  // BOTH near-duplicate corner vertices, unmerged. That outline is a valid
  // simple polygon on its own (no self-intersection, real area, no NaN) —
  // split_part_at_bend "succeeds" — but the OTHER, nearby bend can no
  // longer be re-grounded against this reshaped outline once the graph is
  // freshly re-evaluated (RegionOf can't find where its own zone boundary
  // is anymore), so constructPartSolid throws GE_BRIDGE_EDGE_NOT_FOUND —
  // the split "succeeds" at the tool-call level but silently hands back an
  // unbuildable part, exactly the live-app symptom ("doesn't succeed, and
  // the 3D rendered parts are not correct").
  //
  // NOT specific to this session's lap-joint rework: the failure is on the
  // TRIMMED side (untouched by the extension formula), and the GROWN side
  // constructs and reports isManifold:true in both keep_corner_on
  // directions — this is a pre-existing structural gap in
  // split_part_at_bend's one-bend-at-a-time design meeting a real mitered
  // multi-bend corner, not a regression from the lap-joint formula itself.
  //
  // The bar this test holds the tool to (per the "no silent fallback"
  // rule): split_part_at_bend must never silently hand back a part it
  // cannot itself construct. Either constructPart succeeds for every
  // resulting part, or the split itself must fail typed at split time —
  // never succeed now and blow up later.
  for (const keepCornerOn of ['parent', 'child'] as const) {
    it(`split_part_at_bend(keep_corner_on='${keepCornerOn}') on a real mitered corner (multiple `
      + 'live bends sharing ~the same hinge point) must not silently hand back an unbuildable part', () => {
      const { store, partId, bend, thicknessMm } = findReportedBend(3);

      // eslint-disable-next-line no-console
      console.log(
        `[pre-split] partId=${partId} bendId=${bend.bendId} angleDeg=${bend.angleDeg} ` +
          `radiusMm=${bend.radiusMm} thicknessMm=${thicknessMm} bottomIsConcave=${bend.bottomIsConcave} ` +
          `hingeA=(${bend.hingeA.x},${bend.hingeA.y}) hingeB=(${bend.hingeB.x},${bend.hingeB.y})`,
      );

      let splitResult: { part_id: string; new_part_ids: string[] } | undefined;
      let thrown: unknown;
      try {
        splitResult = dispatchGraphTool(store, 'split_part_at_bend', {
          part_id: partId,
          bend_id: bend.bendId,
          keep_corner_on: keepCornerOn,
        }) as { part_id: string; new_part_ids: string[] };
      } catch (err) {
        thrown = err;
      }

      if (thrown) {
        // Failing typed AT SPLIT TIME is an acceptable fix outcome (the "no
        // fallback" bar only requires honesty, not necessarily success) —
        // any real error code is fine here, as long as it's not silently
        // swallowed.
        const structured = toStructuredError(thrown);
        // eslint-disable-next-line no-console
        console.log(`[THROWN keep_corner_on=${keepCornerOn}] code=${structured.code} message=${structured.message}`);
        expect(structured.code).toBeTruthy();
        return;
      }

      expect(splitResult).toBeDefined();
      const allResultIds = [splitResult!.part_id, ...splitResult!.new_part_ids];
      // eslint-disable-next-line no-console
      console.log(`[SUCCEEDED keep_corner_on=${keepCornerOn}] resultParts=${JSON.stringify(allResultIds)}`);

      for (const id of allResultIds) {
        const part = store.getPart(id);
        expect(part, `resulting part ${id} must exist`).toBeDefined();
        const outline = part!.outline;
        expect(hasNaN(outline), `outline of ${id} contains NaN`).toBe(false);
        expect(shoelaceArea(outline), `outline of ${id} has ~zero area`).toBeGreaterThan(1e-6);

        // The actual bar: a split that reports success must produce a part
        // that can actually be constructed and rendered — never a part
        // that looks fine here and only fails later, silently, when a user
        // opens the 3D view.
        const constructed = constructPart(store, id);
        const manifold = geometryBinding.checkManifold(constructed.shellId) as unknown as {
          isManifold?: boolean;
          issues?: unknown;
        };
        expect(
          manifold.isManifold,
          `part ${id} (split off cauldron.step's mitered corner) constructed but is not manifold: ` +
            JSON.stringify(manifold.issues),
        ).toBe(true);
      }
    });
  }
});
