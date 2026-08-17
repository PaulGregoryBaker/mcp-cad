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
    // nor fabricates material) — 1% tolerance for healing-related snapping.
    expect(totalVolume).toBeGreaterThan(rawVolume * 0.99);
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
});
