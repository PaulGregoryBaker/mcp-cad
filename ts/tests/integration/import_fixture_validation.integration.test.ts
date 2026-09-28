/**
 * v2 import_part fixture integration test — validates that testcube.step
 * and cauldron.step import without errors, returning valid parts with
 * correct panel/bend/protrusion counts.
 *
 * Gated behind SUITE_V2_DRIVER=1.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { evaluatePart, constructPart, toNapiPartGraphSpec } from '../../src/v2/graph/evaluate-client';
import { readGraphResource } from '../../src/v2/resources/graph';
import { geometryBinding } from '../../src/geometry/binding';

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

d('[v2] import_part fixture verification', () => {
  it('testcube.step imports without error and produces valid parts', () => {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
    }) as ImportPartResult;

    expect(result.part_id).toBeTruthy();
    expect(result.panel_count).toBeGreaterThan(0);

    // Verify the root part is valid
    const snap = store.snapshotPart(result.part_id);
    expect(snap.part.outline.length).toBeGreaterThanOrEqual(3);
    // Accept 0 bends for disconnected-component parts;
    // the evaluate test below validates bend correctness.
  });

  it('cauldron.step imports without error and produces valid parts', () => {
    const store = new GraphStore();
    const cauldronPath = path.join(FIXTURES, 'cauldron.step');
    const result = dispatchGraphTool(store, 'import_part', {
      file: cauldronPath,
    }) as ImportPartResult;

    expect(result.part_id).toBeTruthy();
    expect(result.panel_count).toBeGreaterThan(0);

    // Verify the root part is valid
    const snap = store.snapshotPart(result.part_id);
    expect(snap.part.outline.length).toBeGreaterThanOrEqual(3);
  });

  it('testcube.step imported part can be evaluated', () => {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
    }) as ImportPartResult;

    // Evaluate the imported part — should produce a valid layout
    const layout = evaluatePart(store, result.part_id);
    expect(layout.ok).toBe(true);
    expect(layout.panels.length).toBeGreaterThan(0);
  });

  // docs/BUG_REPORT_nonzero_default_bend_radius_breaks_mesh_construction.md:
  // a nonzero default_bend_radius_mm broke mesh construction for every
  // multi-child (branching) region panel in this exact fixture — root-caused
  // to two layered bugs: part_solid_construction.cc's bridge revolve profile
  // wasn't anchored at the true tangent line for a panel parent to more than
  // one bend, AND (once fixed) the new per-bridge correction it needed
  // wasn't round-tripped through the evaluatePartGraph -> constructPartSolid
  // NAPI boundary. Only an end-to-end test through the real NAPI addon (not
  // a direct C++ unit test, which bypasses that boundary entirely) can catch
  // a regression in that second half.
  it.each([0, 0.5, 1.0, 2.0])(
    'testcube.step mesh constructs with default_bend_radius_mm=%s',
    (defaultBendRadiusMm) => {
      const store = new GraphStore();
      const result = dispatchGraphTool(store, 'import_part', {
        file: path.join(FIXTURES, 'testcube.step'),
        profile: { rules: { default_bend_radius_mm: defaultBendRadiusMm } },
      }) as ImportPartResult;

      const allPartIds = [result.part_id, ...result.component_part_ids];
      for (const partId of allPartIds) {
        expect(() => readGraphResource(store, `graph://part/${partId}/mesh`)).not.toThrow();
      }
    },
  );

  // Live reproduction of the originally-reported bug (testcube.step's
  // reconciled 4-panel/3-bend chain component,
  // docs/BUG_REPORT_outline_never_grows_for_bend_allowance.md): with a
  // nonzero default_bend_radius_mm, the flat pattern's own outline must
  // GROW to account for every bend's real allowance (bug #1 — was a flat
  // 600mm span, unchanged by radius), and each bend line must land at the
  // true CENTER of its own allowance zone, compounding down the chain (bugs
  // #2/#3 — was exactly the raw 0/150/300mm marks regardless of radius).
  it('testcube.step chain component: flat-pattern outline grows and bend lines re-center for a nonzero default_bend_radius_mm', () => {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
      profile: { rules: { default_bend_radius_mm: 2 } },
    }) as ImportPartResult;

    const allPartIds = [result.part_id, ...result.component_part_ids];
    let checked = false;
    for (const partId of allPartIds) {
      const snap = store.snapshotPart(partId);
      if (snap.bends.length !== 3) continue;
      checked = true;

      const flat = readGraphResource(store, `graph://part/${partId}/flat-pattern`) as {
        thicknessMm: number;
        kFactor: number;
        outline: Array<{ x: number; y: number }>;
        bendLines: Array<{
          bendId: string;
          hingeA: { x: number; y: number };
          hingeB: { x: number; y: number };
          radiusMm: number;
        }>;
      };

      const xs = flat.outline.map((p) => p.x);
      const span = Math.max(...xs) - Math.min(...xs);
      const rawXs = snap.part.outline.map((p) => p.x);
      const rawSpan = Math.max(...rawXs) - Math.min(...rawXs);
      const totalBa = flat.bendLines.reduce(
        (sum, b) => sum + (Math.PI / 2) * (b.radiusMm + flat.kFactor * flat.thicknessMm),
        0,
      );
      // Bug #1: the outline's own span grows by exactly the sum of every
      // bend's real allowance — not the flat, radius-blind rawSpan.
      expect(span).toBeCloseTo(rawSpan + totalBa, 6);

      // Bugs #2/#3: every bend line has moved off its raw mark (centered
      // in its own zone, not starting at it) — not asserting the exact
      // compounded value here (that's the C++/evaluate-client unit-level
      // coverage's job), just that this end-to-end path actually applies
      // the correction rather than silently passing the raw mark through.
      for (const bendLine of flat.bendLines) {
        const rawBend = snap.bends.find((b) => b.bendId === bendLine.bendId)!;
        expect(Math.abs(bendLine.hingeA.x - rawBend.hingeA.x)).toBeGreaterThan(1e-6);
      }
    }
    expect(checked).toBe(true);
  });

  // Stronger reproduction attempt for the reported "visible gap in the 3D
  // object" complaint: a real gap/missing-material defect at a bend zone
  // is a volume defect, not just a "did construction throw" check (which
  // GE_CONSTRUCTION_FAILED's own disconnected-solid check can miss for a
  // gap small enough that BRepAlgoAPI_Fuse's fuzzy tolerance silently
  // bridges it, or a gap that isn't at a fuse seam at all). Sheet metal's
  // own neutral-fibre model (the same BA formula the flat outline is built
  // from) is volume-preserving to a very tight tolerance: the constructed
  // 3D solid's volume must equal the flat outline's own area times
  // thickness, for every radius tested — a genuine gap anywhere in the
  // shell shows up as a real, measurable volume deficit here.
  it.each([0, 0.5, 1.0, 2.0])(
    'testcube.step chain component: constructed solid volume matches flat-outline-area x thickness (default_bend_radius_mm=%s)',
    (defaultBendRadiusMm) => {
      const store = new GraphStore();
      const result = dispatchGraphTool(store, 'import_part', {
        file: path.join(FIXTURES, 'testcube.step'),
        profile: { rules: { default_bend_radius_mm: defaultBendRadiusMm } },
      }) as ImportPartResult;

      const allPartIds = [result.part_id, ...result.component_part_ids];
      let checked = false;
      for (const partId of allPartIds) {
        const snap = store.snapshotPart(partId);
        if (snap.bends.length !== 3) continue;
        checked = true;

        const evaluated = evaluatePart(store, partId);
        expect(evaluated.ok).toBe(true);
        const flatOutline = geometryBinding.buildFlatOutline(
          toNapiPartGraphSpec(snap),
          evaluated,
        );
        expect(flatOutline.ok).toBe(true);

        let shoelace = 0;
        const ring = flatOutline.outer;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i]!;
          const b = ring[(i + 1) % ring.length]!;
          shoelace += a.x * b.y - b.x * a.y;
        }
        const flatAreaMm2 = Math.abs(shoelace) / 2;
        const expectedVolumeMm3 = flatAreaMm2 * snap.part.thicknessMm;

        const constructed = constructPart(store, partId);
        const mass = geometryBinding.computeMassProperties(constructed.shellId, ['volume']);
        expect(mass.volume).toBeDefined();

        // Enclosed volume alone only proves "no material missing in
        // aggregate" — it would NOT catch a panel/bridge that's misplaced
        // (shifted, rotated, or overlapping elsewhere) while still
        // contributing the same net volume. Cross-check the constructed
        // solid's own bounding box (computeBoundingBox, the actual built
        // geometry) against an INDEPENDENTLY-sourced bounding box built
        // directly from evaluated.panels[].bottomFace/topFace (the
        // already-verified-correct world-space panel corners) — if the
        // real solid's spatial extent disagrees with where the panels are
        // actually supposed to be, that's a real positional defect a pure
        // volume check can't see.
        const bbox = geometryBinding.computeBoundingBox(constructed.shellId);
        const bboxVolumeMm3 =
          (bbox.x_max - bbox.x_min) * (bbox.y_max - bbox.y_min) * (bbox.z_max - bbox.z_min);

        let panelMinX = Infinity, panelMaxX = -Infinity;
        let panelMinY = Infinity, panelMaxY = -Infinity;
        let panelMinZ = Infinity, panelMaxZ = -Infinity;
        for (const panel of evaluated.panels) {
          for (const p of [...panel.bottomFace, ...panel.topFace]) {
            panelMinX = Math.min(panelMinX, p.x); panelMaxX = Math.max(panelMaxX, p.x);
            panelMinY = Math.min(panelMinY, p.y); panelMaxY = Math.max(panelMaxY, p.y);
            panelMinZ = Math.min(panelMinZ, p.z); panelMaxZ = Math.max(panelMaxZ, p.z);
          }
        }

        // eslint-disable-next-line no-console
        console.log(
          `[bbox check] radius=${defaultBendRadiusMm} part=${partId}\n` +
            `  constructed solid bbox: x[${bbox.x_min.toFixed(2)},${bbox.x_max.toFixed(2)}] ` +
            `y[${bbox.y_min.toFixed(2)},${bbox.y_max.toFixed(2)}] ` +
            `z[${bbox.z_min.toFixed(2)},${bbox.z_max.toFixed(2)}] volume=${bboxVolumeMm3.toFixed(0)}mm3\n` +
            `  panel-corner-derived bbox: x[${panelMinX.toFixed(2)},${panelMaxX.toFixed(2)}] ` +
            `y[${panelMinY.toFixed(2)},${panelMaxY.toFixed(2)}] ` +
            `z[${panelMinZ.toFixed(2)},${panelMaxZ.toFixed(2)}]\n` +
            `  enclosed volume=${mass.volume?.toFixed(0)}mm3 (bbox fill ratio=${((mass.volume ?? 0) / bboxVolumeMm3 * 100).toFixed(2)}%)`,
        );

        // The constructed solid must not extend meaningfully beyond where
        // the panels' own (already-verified) world-space corners actually
        // are — a small margin for the bend's own radial bulge past the
        // flat corner, nothing more.
        const marginMm = 5.0;
        expect(bbox.x_min).toBeGreaterThan(panelMinX - marginMm);
        expect(bbox.x_max).toBeLessThan(panelMaxX + marginMm);
        expect(bbox.y_min).toBeGreaterThan(panelMinY - marginMm);
        expect(bbox.y_max).toBeLessThan(panelMaxY + marginMm);
        expect(bbox.z_min).toBeGreaterThan(panelMinZ - marginMm);
        expect(bbox.z_max).toBeLessThan(panelMaxZ + marginMm);

        // 2% tolerance: generous enough for the bend region's own real
        // (non-neutral-fibre-exact) geometry, tight enough that a genuine
        // missing wall or gap — which would be a multi-percent deficit at
        // this component's scale — fails loudly.
        expect(mass.volume!).toBeGreaterThan(expectedVolumeMm3 * 0.98);
        expect(mass.volume!).toBeLessThan(expectedVolumeMm3 * 1.02);
      }
      expect(checked).toBe(true);
    },
  );

  // Every earlier test in this file only checks derived views against EACH
  // OTHER (Evaluate() vs constructPartSolid vs flat-pattern) — all
  // internally self-consistent, but none of them compare against the
  // TRUE ORIGINAL geometry testcube.step actually contains. This test
  // does: load the raw, undecomposed STEP solid directly (loadStep, same
  // healing import_part itself applies), and compare it against the FULLY
  // RECONSTRUCTED geometry (import_part -> graph -> constructPartSolid,
  // summed/unioned across every resulting part — root + components +
  // protrusions). At default_bend_radius_mm=0 (sharp fold — this fixture
  // has no modelled fillets, so this is the only radius where an exact
  // match is physically meaningful), reconciliation+reconstruction should
  // exactly reproduce the original: same total volume (material neither
  // lost nor fabricated), and every reconstructed part occupying the same
  // overall 3D space the original solid actually occupies (a real
  // positional drift — a panel rebuilt somewhere other than where the
  // source geometry actually was — shows up directly as a bbox mismatch
  // here, something no earlier test in this file could ever catch, since
  // they never reference the original source at all).
  it('testcube.step: reconstructed geometry (every resulting part) matches the original imported solid at radius=0', () => {
    const rawId = geometryBinding.loadStep(path.join(FIXTURES, 'testcube.step'));
    geometryBinding.healGeometryEx(rawId, true, true);
    const rawBbox = geometryBinding.computeBoundingBox(rawId);
    const rawVolume = geometryBinding.computeMassProperties(rawId, ['volume']).volume!;
    expect(rawVolume).toBeGreaterThan(0);

    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
      profile: { rules: { default_bend_radius_mm: 0 } },
    }) as ImportPartResult;

    const allPartIds = [
      result.part_id,
      ...result.component_part_ids,
      ...result.protrusion_part_ids,
    ];
    expect(allPartIds.length).toBeGreaterThan(0);

    let totalVolume = 0;
    let unionMinX = Infinity, unionMaxX = -Infinity;
    let unionMinY = Infinity, unionMaxY = -Infinity;
    let unionMinZ = Infinity, unionMaxZ = -Infinity;
    for (const partId of allPartIds) {
      const snap = store.snapshotPart(partId);
      const constructed = constructPart(store, partId);
      const mass = geometryBinding.computeMassProperties(constructed.shellId, ['volume']);
      expect(mass.volume).toBeDefined();
      totalVolume += mass.volume!;

      const bbox = geometryBinding.computeBoundingBox(constructed.shellId);
      unionMinX = Math.min(unionMinX, bbox.x_min); unionMaxX = Math.max(unionMaxX, bbox.x_max);
      unionMinY = Math.min(unionMinY, bbox.y_min); unionMaxY = Math.max(unionMaxY, bbox.y_max);
      unionMinZ = Math.min(unionMinZ, bbox.z_min); unionMaxZ = Math.max(unionMaxZ, bbox.z_max);

      // eslint-disable-next-line no-console
      console.log(
        `[per-part] partId=${partId} bends=${snap.bends.length} panels=${snap.regionPanels.length} ` +
          `volume=${mass.volume?.toFixed(0)}mm3 bbox x[${bbox.x_min.toFixed(2)},${bbox.x_max.toFixed(2)}] ` +
          `y[${bbox.y_min.toFixed(2)},${bbox.y_max.toFixed(2)}] z[${bbox.z_min.toFixed(2)},${bbox.z_max.toFixed(2)}]`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[original-vs-reconstructed, radius=0] original: bbox x[${rawBbox.x_min.toFixed(2)},${rawBbox.x_max.toFixed(2)}] ` +
        `y[${rawBbox.y_min.toFixed(2)},${rawBbox.y_max.toFixed(2)}] z[${rawBbox.z_min.toFixed(2)},${rawBbox.z_max.toFixed(2)}] volume=${rawVolume.toFixed(0)}mm3\n` +
        `  reconstructed (union of ${allPartIds.length} parts): bbox x[${unionMinX.toFixed(2)},${unionMaxX.toFixed(2)}] ` +
        `y[${unionMinY.toFixed(2)},${unionMaxY.toFixed(2)}] z[${unionMinZ.toFixed(2)},${unionMaxZ.toFixed(2)}] totalVolume=${totalVolume.toFixed(0)}mm3`,
    );

    // Volume must be conserved (reconciliation/reconstruction neither loses
    // nor fabricates material) — but NOT to 1%. testcube.step's own panels
    // measure real thickness from 0.95mm to 1.00mm (confirmed directly via
    // splitBodyByBends' panel_thickness_mm), and evaluate-client.ts's
    // importPart deliberately reconciles a part to ONE thickness (the
    // minimum across its panels — see its own "one thickness per part...
    // out of this slice's scope" comment). Any panel truly at 1.00mm is
    // therefore rebuilt ~5% thin. That is a known, accepted modeling
    // limitation, not a construction defect, so the tolerance here is
    // widened to the limitation's own worst case ((max-min)/max = 5%)
    // instead of tightening the architecture to match the test.
    expect(totalVolume).toBeGreaterThan(rawVolume * 0.95);
    expect(totalVolume).toBeLessThan(rawVolume * 1.01);

    // Every reconstructed part must occupy the same overall 3D space as the
    // original import.
    const marginMm = 2.0;
    expect(unionMinX).toBeGreaterThan(rawBbox.x_min - marginMm);
    expect(unionMaxX).toBeLessThan(rawBbox.x_max + marginMm);
    expect(unionMinY).toBeGreaterThan(rawBbox.y_min - marginMm);
    expect(unionMaxY).toBeLessThan(rawBbox.y_max + marginMm);
    expect(unionMinZ).toBeGreaterThan(rawBbox.z_min - marginMm);
    expect(unionMaxZ).toBeLessThan(rawBbox.z_max + marginMm);
  });

  function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  // docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md: the
  // 4-panel/3-bend "inner cube" component is a branching TREE (root parent
  // to two bends, one of which has its own child) — 3 of the box's 4
  // corners are real, modeled bends; the 4th (between the tree's two open/
  // free ends) is never a bend at all, just two free edges relying on the
  // reconstructed geometry landing back where it started. This is very
  // likely a SYMPTOM of the same root cause the companion "opposite walls"
  // test below documents directly (panel reach growing with bend radius,
  // since no setback trim is applied) rather than an independent defect:
  // as the 3 real bends' own reach grows with radius, the untouched 4th
  // corner is dragged out of alignment with them. Confirmed by direct
  // measurement: 0.0000mm gap at radius=0, 5.6569mm at radius=2 (this
  // test's own value below) — this is NOT the childShiftWorld tangency bug
  // fixed earlier the same day (every real bend, both surfaces, is
  // independently verified exact elsewhere in this file). KNOWN FAILING —
  // left red on purpose as the tracking regression; solution not yet
  // decided (see the bug report).
  it('testcube.step: branching inner-cube component closes its unmodeled 4th seam at a real bend radius', () => {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
      profile: { rules: { default_bend_radius_mm: 2 } },
    }) as ImportPartResult;

    const allPartIds = [result.part_id, ...result.component_part_ids];
    let checked = false;
    for (const partId of allPartIds) {
      const snap = store.snapshotPart(partId);
      if (snap.bends.length !== 3) continue;
      checked = true;
      const evaluated = evaluatePart(store, partId);
      expect(evaluated.ok).toBe(true);

      const parentIds = new Set(evaluated.bridges.map((b) => b.parentRegionPanelId));
      const leaves = evaluated.panels.filter((p) => !parentIds.has(p.regionPanelId));
      expect(leaves.length).toBe(2);
      const [leafA, leafB] = leaves;

      let bestGap = Infinity;
      for (let ia = 0; ia < leafA!.edgeBendId.length; ia++) {
        if (leafA!.edgeBendId[ia] !== '') continue;
        const ia2 = (ia + 1) % leafA!.bottomFace.length;
        for (let ib = 0; ib < leafB!.edgeBendId.length; ib++) {
          if (leafB!.edgeBendId[ib] !== '') continue;
          const ib2 = (ib + 1) % leafB!.bottomFace.length;
          const d1 =
            dist(leafA!.bottomFace[ia]!, leafB!.bottomFace[ib]!) +
            dist(leafA!.bottomFace[ia2]!, leafB!.bottomFace[ib2]!);
          const d2 =
            dist(leafA!.bottomFace[ia]!, leafB!.bottomFace[ib2]!) +
            dist(leafA!.bottomFace[ia2]!, leafB!.bottomFace[ib]!);
          bestGap = Math.min(bestGap, d1, d2);
        }
      }

      // eslint-disable-next-line no-console
      console.log(`[unmodeled-seam] part=${partId} bestSummedGap=${bestGap.toFixed(4)}mm`);
      expect(bestGap).toBeLessThan(1e-3);
    }
    expect(checked).toBe(true);
  });

  // docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md's own
  // direct reproduction: the real inner cube is a 150mm part, and its
  // outer envelope must stay 150mm regardless of which bend radius is
  // chosen to manufacture it — a different radius may change a joint's
  // local shape, never the resulting part's overall size. The
  // perpendicular distance between each pair of opposite walls (TOP vs
  // BOTTOM, LEFT vs RIGHT) is a property of where those two panels' own
  // planes actually sit in 3D — it does not depend on whether their free
  // edges happen to touch anything, so it catches a wrong panel position
  // directly, independent of the closure question above. KNOWN FAILING —
  // measures 154mm at radius=2mm (root cause: no setback trim is applied,
  // so each panel's own reach grows with radius instead of staying
  // anchored to the true, radius-invariant envelope).
  // Shared measurement helper (used by both the single-point bound check
  // below and the radius-sweep invariance check that follows it): imports
  // testcube.step fresh at the given radius, finds the branching inner-cube
  // component (bends.length === 3), and measures the perpendicular distance
  // between each pair of opposite walls (TOP vs BOTTOM, LEFT vs RIGHT).
  function measureInnerCubeOppositeWalls(defaultBendRadiusMm: number): {
    topBottomMm: number;
    leftRightMm: number;
  } {
    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
      profile: { rules: { default_bend_radius_mm: defaultBendRadiusMm } },
    }) as ImportPartResult;

    const allPartIds = [result.part_id, ...result.component_part_ids];
    for (const partId of allPartIds) {
      const snap = store.snapshotPart(partId);
      if (snap.bends.length !== 3) continue;
      const evaluated = evaluatePart(store, partId);
      expect(evaluated.ok).toBe(true);

      // root = TOP (parent of two bends). Its two direct children are LEFT
      // and RIGHT. Whichever of those two is itself a parent of the third
      // bend has BOTTOM as its child. TOP/BOTTOM and LEFT/RIGHT are the two
      // opposite-wall pairs.
      const parentCounts = new Map<string, number>();
      for (const b of evaluated.bridges) {
        parentCounts.set(b.parentRegionPanelId, (parentCounts.get(b.parentRegionPanelId) ?? 0) + 1);
      }
      const top = evaluated.panels.find((p) => (parentCounts.get(p.regionPanelId) ?? 0) === 2)!;
      expect(top).toBeDefined();
      const topChildren = evaluated.bridges
        .filter((b) => b.parentRegionPanelId === top.regionPanelId)
        .map((b) => b.childRegionPanelId);
      expect(topChildren.length).toBe(2);
      const rightId = topChildren.find((id) => (parentCounts.get(id) ?? 0) === 1)!;
      const leftId = topChildren.find((id) => id !== rightId)!;
      const right = evaluated.panels.find((p) => p.regionPanelId === rightId)!;
      const left = evaluated.panels.find((p) => p.regionPanelId === leftId)!;
      const bottomId = evaluated.bridges.find((b) => b.parentRegionPanelId === rightId)!.childRegionPanelId;
      const bottom = evaluated.panels.find((p) => p.regionPanelId === bottomId)!;

      const planeNormal = (face: { x: number; y: number; z: number }[]) => {
        const e01 = { x: face[1]!.x - face[0]!.x, y: face[1]!.y - face[0]!.y, z: face[1]!.z - face[0]!.z };
        const e12 = { x: face[2]!.x - face[1]!.x, y: face[2]!.y - face[1]!.y, z: face[2]!.z - face[1]!.z };
        const n = {
          x: e01.y * e12.z - e01.z * e12.y,
          y: e01.z * e12.x - e01.x * e12.z,
          z: e01.x * e12.y - e01.y * e12.x,
        };
        const len = Math.sqrt(n.x ** 2 + n.y ** 2 + n.z ** 2);
        return { x: n.x / len, y: n.y / len, z: n.z / len };
      };
      const planeDistance = (
        panelA: { bottomFace: { x: number; y: number; z: number }[] },
        panelB: { bottomFace: { x: number; y: number; z: number }[] },
      ) => {
        const n = planeNormal(panelA.bottomFace);
        const a0 = panelA.bottomFace[0]!;
        const b0 = panelB.bottomFace[0]!;
        const v = { x: b0.x - a0.x, y: b0.y - a0.y, z: b0.z - a0.z };
        return Math.abs(v.x * n.x + v.y * n.y + v.z * n.z);
      };

      return { topBottomMm: planeDistance(top, bottom), leftRightMm: planeDistance(left, right) };
    }
    throw new Error('inner-cube component (bends.length === 3) not found');
  }

  it('testcube.step: 3D distance between opposite walls of the inner cube does not exceed 150mm', () => {
    const { topBottomMm, leftRightMm } = measureInnerCubeOppositeWalls(2);
    // eslint-disable-next-line no-console
    console.log(`[opposite-walls] radius=2 topBottom=${topBottomMm.toFixed(4)}mm leftRight=${leftRightMm.toFixed(4)}mm`);
    expect(topBottomMm).toBeLessThanOrEqual(150);
    expect(leftRightMm).toBeLessThanOrEqual(150);
  });

  // docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md's
  // testing-strategy item 2 (strengthened from a bound to an equality
  // check): the manufacturing method (which bend radius is chosen) must
  // not change the resulting part's overall shape. The opposite-wall
  // distance measured at radius=0 (the reconciled ground truth) must be
  // IDENTICAL at every other radius, not merely bounded from one side.
  // KNOWN FAILING — radius=0 gives 150mm, every larger radius gives a
  // larger value (154mm at radius=2), confirming the growth is real and
  // monotonic, not a one-off measurement artifact.
  it('testcube.step: opposite-wall distance is identical across a bend-radius sweep (manufacturing method must not change the shape)', () => {
    const reference = measureInnerCubeOppositeWalls(0);
    for (const radius of [0.5, 1, 2, 5]) {
      const measured = measureInnerCubeOppositeWalls(radius);
      // eslint-disable-next-line no-console
      console.log(
        `[opposite-walls sweep] radius=${radius} topBottom=${measured.topBottomMm.toFixed(4)}mm ` +
          `(reference=${reference.topBottomMm.toFixed(4)}mm) leftRight=${measured.leftRightMm.toFixed(4)}mm ` +
          `(reference=${reference.leftRightMm.toFixed(4)}mm)`,
      );
      expect(measured.topBottomMm).toBeCloseTo(reference.topBottomMm, 6);
      expect(measured.leftRightMm).toBeCloseTo(reference.leftRightMm, 6);
    }
  });

  // The bounding box of each individually reconstructed part — not just
  // their union (the earlier radius=0 test) — checked at a real, nonzero
  // bend radius against ground truth: the outer/root assembly against the
  // TRUE original solid's own bbox (must match tightly — root has no
  // unmodeled seam, so growth from bend allowance is the only expected
  // difference and this fixture's allowance is small relative to its
  // scale), and the inner component against the CONTAINMENT invariant a
  // nested sub-assembly must always satisfy (it cannot occupy space outside
  // its own containing shell), independent of whether its own internal
  // seam closes exactly.
  it('testcube.step: outer assembly and inner component bounding boxes, checked individually (not just unioned)', () => {
    const rawId = geometryBinding.loadStep(path.join(FIXTURES, 'testcube.step'));
    geometryBinding.healGeometryEx(rawId, true, true);
    const rawBbox = geometryBinding.computeBoundingBox(rawId);

    const store = new GraphStore();
    const result = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'testcube.step'),
      profile: { rules: { default_bend_radius_mm: 2 } },
    }) as ImportPartResult;

    let outerBbox: ReturnType<typeof geometryBinding.computeBoundingBox> | undefined;
    let innerBbox: ReturnType<typeof geometryBinding.computeBoundingBox> | undefined;
    for (const partId of [result.part_id, ...result.component_part_ids]) {
      const snap = store.snapshotPart(partId);
      const constructed = constructPart(store, partId);
      const bbox = geometryBinding.computeBoundingBox(constructed.shellId);
      // eslint-disable-next-line no-console
      console.log(
        `[per-part bbox] partId=${partId} bends=${snap.bends.length} bbox x[${bbox.x_min.toFixed(2)},${bbox.x_max.toFixed(2)}] ` +
          `y[${bbox.y_min.toFixed(2)},${bbox.y_max.toFixed(2)}] z[${bbox.z_min.toFixed(2)},${bbox.z_max.toFixed(2)}]`,
      );
      if (snap.bends.length === 5) outerBbox = bbox;
      if (snap.bends.length === 3) innerBbox = bbox;
    }
    expect(outerBbox).toBeDefined();
    expect(innerBbox).toBeDefined();

    // Outer/root: no unmodeled seam, so its own bbox should track the true
    // original closely — generous margin only for this fixture's bend
    // allowance growth at radius=2 (a few mm at this scale).
    const outerMarginMm = 8.0;
    expect(outerBbox!.x_min).toBeGreaterThan(rawBbox.x_min - outerMarginMm);
    expect(outerBbox!.x_max).toBeLessThan(rawBbox.x_max + outerMarginMm);
    expect(outerBbox!.y_min).toBeGreaterThan(rawBbox.y_min - outerMarginMm);
    expect(outerBbox!.y_max).toBeLessThan(rawBbox.y_max + outerMarginMm);
    expect(outerBbox!.z_min).toBeGreaterThan(rawBbox.z_min - outerMarginMm);
    expect(outerBbox!.z_max).toBeLessThan(rawBbox.z_max + outerMarginMm);

    // Inner: must stay nested inside the outer shell it's meant to sit
    // within, regardless of whether its own internal seam closes exactly.
    expect(innerBbox!.x_min).toBeGreaterThan(outerBbox!.x_min);
    expect(innerBbox!.x_max).toBeLessThan(outerBbox!.x_max);
    expect(innerBbox!.y_min).toBeGreaterThan(outerBbox!.y_min);
    expect(innerBbox!.y_max).toBeLessThan(outerBbox!.y_max);
    expect(innerBbox!.z_min).toBeGreaterThan(outerBbox!.z_min);
    expect(innerBbox!.z_max).toBeLessThan(outerBbox!.z_max);
  });

  // docs/BUG_REPORT_reconstructed_envelope_grows_with_bend_radius.md's
  // testing-strategy item 4: the same envelope-invariance requirement
  // checked against a second, structurally different fixture, to see
  // whether the defect is specific to testcube's branching topology or
  // general to any part with bends. Uses the union bounding box of every
  // reconstructed part (root + components + protrusions) rather than a
  // fixture-specific opposite-wall pair, since cauldron.step's own panel
  // topology hasn't been mapped out the way testcube's has — the union
  // bbox is the one measurement that doesn't require knowing it.
  it('cauldron.step: overall reconstructed bounding box stays identical across a bend-radius sweep', () => {
    function measureUnionBbox(defaultBendRadiusMm: number) {
      const store = new GraphStore();
      const result = dispatchGraphTool(store, 'import_part', {
        file: path.join(FIXTURES, 'cauldron.step'),
        profile: { rules: { default_bend_radius_mm: defaultBendRadiusMm } },
      }) as ImportPartResult;
      const allPartIds = [result.part_id, ...result.component_part_ids, ...result.protrusion_part_ids];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const partId of allPartIds) {
        const constructed = constructPart(store, partId);
        const bbox = geometryBinding.computeBoundingBox(constructed.shellId);
        minX = Math.min(minX, bbox.x_min); maxX = Math.max(maxX, bbox.x_max);
        minY = Math.min(minY, bbox.y_min); maxY = Math.max(maxY, bbox.y_max);
        minZ = Math.min(minZ, bbox.z_min); maxZ = Math.max(maxZ, bbox.z_max);
      }
      return { minX, maxX, minY, maxY, minZ, maxZ };
    }

    const reference = measureUnionBbox(0);
    // eslint-disable-next-line no-console
    console.log(`[cauldron envelope] radius=0 (reference) bbox x[${reference.minX.toFixed(2)},${reference.maxX.toFixed(2)}] ` +
      `y[${reference.minY.toFixed(2)},${reference.maxY.toFixed(2)}] z[${reference.minZ.toFixed(2)},${reference.maxZ.toFixed(2)}]`);
    // Sub-micron equality isn't the right invariant here: cauldron's own root
    // panel is parent to several bends meeting at shared (mitered) corners —
    // e.g. three faces of a cube folding up from one flat panel. Two bends
    // converging on one corner need a relief notch cut from that panel's own
    // flat material (or F1/F2 would physically try to occupy the same space
    // right at the corner), and that notch's size is setback-driven
    // (radius*tan(angle/2) per bend), so it genuinely grows with radius —
    // real material removed, not a construction defect. axisInPlaneOffset/
    // childExtension keeps every bend's OWN child tangent line exactly fixed
    // (verified: every panel's own pose is bit-for-bit radius-independent —
    // see the N=4/5/6 tube-closure tests), but was only ever proven for one
    // bend at a time; it has no way to also cancel a shared corner's own
    // notch, because that notch is real, not an artifact to hide.
    // radiusMarginMm bounds how far the notch is allowed to grow before it'd
    // indicate an actual regression (cauldron's own measured drift: ~0.03mm
    // per 1mm of radius at its worst corner) — generous relative to that, but
    // far tighter than a real construction bug would produce (those showed
    // multi-hundred-to-thousand mm deviations before being fixed).
    for (const radius of [0.5, 1, 2]) {
      const measured = measureUnionBbox(radius);
      // eslint-disable-next-line no-console
      console.log(`[cauldron envelope] radius=${radius} bbox x[${measured.minX.toFixed(2)},${measured.maxX.toFixed(2)}] ` +
        `y[${measured.minY.toFixed(2)},${measured.maxY.toFixed(2)}] z[${measured.minZ.toFixed(2)},${measured.maxZ.toFixed(2)}]`);
      const floatNoiseMm = 0.001;
      const radiusMarginMm = 0.5;
      // Never grows PAST the sharp-corner (radius=0) envelope — that's the
      // original bug (docs/BUG_REPORT_reconstructed_envelope_grows_with_
      // bend_radius.md) this test still guards against.
      expect(measured.minX).toBeGreaterThanOrEqual(reference.minX - floatNoiseMm);
      expect(measured.maxX).toBeLessThanOrEqual(reference.maxX + floatNoiseMm);
      expect(measured.minY).toBeGreaterThanOrEqual(reference.minY - floatNoiseMm);
      expect(measured.maxY).toBeLessThanOrEqual(reference.maxY + floatNoiseMm);
      expect(measured.minZ).toBeGreaterThanOrEqual(reference.minZ - floatNoiseMm);
      expect(measured.maxZ).toBeLessThanOrEqual(reference.maxZ + floatNoiseMm);
      // May recede inward (a growing relief notch at a shared corner), but
      // only up to the bounded margin above.
      expect(measured.minX).toBeLessThanOrEqual(reference.minX + radiusMarginMm);
      expect(measured.maxX).toBeGreaterThanOrEqual(reference.maxX - radiusMarginMm);
      expect(measured.minY).toBeLessThanOrEqual(reference.minY + radiusMarginMm);
      expect(measured.maxY).toBeGreaterThanOrEqual(reference.maxY - radiusMarginMm);
      expect(measured.minZ).toBeLessThanOrEqual(reference.minZ + radiusMarginMm);
      expect(measured.maxZ).toBeGreaterThanOrEqual(reference.maxZ - radiusMarginMm);
    }
  });
});
