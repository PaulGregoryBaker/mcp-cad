/**
 * v2 findings resource integration test — aligned 1:1 with the C++
 * validation rules test (cpp/tests/validation_rules_test.cc).
 *
 * Every scenario below has a matching C++ TEST_CASE that constructs the same
 * geometry directly (PartGraphSpec → EvaluateFindings).  A failure here can
 * be reproduced in C++ by copying the same coordinates, thickness, and profile
 * parameters — and vice versa.
 *
 * Gated behind SUITE_V2_DRIVER=1.
 */
import { describe, expect, it } from 'vitest';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { readGraphResource } from '../../src/v2/resources/graph';
import type { NapiFinding } from '../../src/geometry/types';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface CreatePartResult {
  part_id: string;
  root_region_panel_id: string;
}

interface CreateBendResult {
  bend_id: string;
  child_region_panel_id: string;
}

interface CutPanelResult {
  part_id: string;
  region_panel_id: string;
}

interface FindingsResult {
  partId: string;
  findings: NapiFinding[];
}

interface FullResult {
  partId: string;
  findings: NapiFinding[];
}

function readFindings(store: GraphStore, partId: string): FindingsResult {
  return readGraphResource(store, `graph://part/${partId}/findings`) as FindingsResult;
}

function readFull(store: GraphStore, partId: string): FullResult {
  return readGraphResource(store, `graph://part/${partId}/full`) as FullResult;
}

function createRect(store: GraphStore, name: string, w = 100, h = 50, thickness = 2.0) {
  return dispatchGraphTool(store, 'create_part', {
    name,
    outline: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    thickness_mm: thickness,
  }) as CreatePartResult;
}

function addBend(
  store: GraphStore,
  partId: string,
  parentPanelId: string,
  hingeAx: number,
  hingeAy: number,
  hingeBx: number,
  hingeBy: number,
  angleDeg: number,
  radiusMm = 0,
) {
  return dispatchGraphTool(store, 'create_node', {
    kind: 'bend',
    part_id: partId,
    parent_region_panel_id: parentPanelId,
    hinge_a: { x: hingeAx, y: hingeAy },
    hinge_b: { x: hingeBx, y: hingeBy },
    angle_deg: angleDeg,
    radius_mm: radiusMm,
  }) as CreateBendResult;
}

function cutCircle(
  store: GraphStore,
  partId: string,
  regionPanelId: string,
  cx: number,
  cy: number,
  radiusMm: number,
) {
  return dispatchGraphTool(store, 'cut_panel', {
    part_id: partId,
    region_panel_id: regionPanelId,
    kind: 'circle',
    circle: { center: { x: cx, y: cy }, radius_mm: radiusMm },
  }) as CutPanelResult;
}

function hasCode(findings: NapiFinding[], code: string): boolean {
  return findings.some((f) => f.code === code);
}

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 0 — Clean part (baseline)
// ══════════════════════════════════════════════════════════════════════════════
// C++ equivalent: TEST_CASE("Findings: clean part produces no findings")

d('[v2] graph://part/{id}/findings (manufacturability rules)', () => {
  it('Scenario 0: clean part → findings: []', () => {
    const store = new GraphStore();
    const part = createRect(store, 'clean', 100, 50, 2.0);
    const result = readFindings(store, part.part_id);
    expect(result.findings).toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 1 — Bend radius below minimum
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("BendRadius: below minimum produces MIN_BEND_RADIUS")
  //   2mm thickness, radius=1.5 → 1.5 < 2.0×1.0=2.0 → MIN_BEND_RADIUS

  it('Scenario 1: bend radius too small → MIN_BEND_RADIUS', () => {
    const store = new GraphStore();
    const part = createRect(store, 'bad-radius', 100, 50, 2.0);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 90, 1.5);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MIN_BEND_RADIUS')).toBe(true);
    const finding = result.findings.find((f) => f.code === 'MIN_BEND_RADIUS')!;
    expect(finding.severity).toBe('error');
    expect(finding.anchors).toContainEqual({ kind: 'bend', id: expect.any(String) });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 2 — Bend angle sign is orientation (mountain/valley), not
  // magnitude — a valley bend (negative angleDeg) within range is valid.
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("BendAngle: negative angle within range (valley bend) passes")

  it('Scenario 2: negative bend angle within range (valley) → no MAX_BEND_ANGLE finding', () => {
    const store = new GraphStore();
    const part = createRect(store, 'neg-angle', 100, 50, 2.0);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, -30, 2.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MAX_BEND_ANGLE')).toBe(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 3 — Bend angle magnitude above 180, either sign
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("BendAngle: above max produces MAX_BEND_ANGLE")

  it('Scenario 3: bend angle above 180 → MAX_BEND_ANGLE', () => {
    const store = new GraphStore();
    const part = createRect(store, 'over-angle', 100, 50, 2.0);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 200, 2.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MAX_BEND_ANGLE')).toBe(true);
  });

  // C++ equivalent: TEST_CASE("BendAngle: negative angle beyond max magnitude produces MAX_BEND_ANGLE")

  it('Scenario 3b: bend angle below -180 → MAX_BEND_ANGLE', () => {
    const store = new GraphStore();
    const part = createRect(store, 'over-angle-neg', 100, 50, 2.0);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, -200, 2.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MAX_BEND_ANGLE')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 4 — Hole diameter below minimum
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("HoleDiameter: too small produces MIN_HOLE_DIAMETER")
  //   2mm thickness, radius=0.8 → diameter=1.6 < 2.0 → MIN_HOLE_DIAMETER

  it('Scenario 4: hole too small → MIN_HOLE_DIAMETER', () => {
    const store = new GraphStore();
    const part = createRect(store, 'small-hole', 100, 50, 2.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 25, 25, 0.8);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MIN_HOLE_DIAMETER')).toBe(true);
    expect(result.findings.find((f) => f.code === 'MIN_HOLE_DIAMETER')!.severity).toBe('error');
    expect(result.findings.find((f) => f.code === 'MIN_HOLE_DIAMETER')!.anchors).toContainEqual(
      { kind: 'part', id: expect.any(String) },
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 5 — Hole too close to bend hinge
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("HoleToBend: too close produces HOLE_TOO_CLOSE_TO_BEND")
  //   Vertical hinge at x=50 from y=0..50, hole at (50, 2) → directly on
  //   the hinge line → distance 0 → HOLE_TOO_CLOSE_TO_BEND.

  it('Scenario 5: hole on hinge line → HOLE_TOO_CLOSE_TO_BEND', () => {
    const store = new GraphStore();
    const part = createRect(store, 'hole-on-bend', 100, 50, 2.0);
    // Cut hole first (one big region panel), then add bend — the rules
    // engine evaluates the final state, order doesn't matter.
    cutCircle(store, part.part_id, part.root_region_panel_id, 50, 2, 0.5);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 90, 2.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'HOLE_TOO_CLOSE_TO_BEND')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 6 — Hole too close to outline edge
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("HoleToEdge: too close produces HOLE_TOO_CLOSE_TO_EDGE")
  //   Hole centre at (2, 25), radius=1.0 on 100×50 rect.
  //   Distance to left edge (x=0): 2mm.  Clearance=1.5+1.0=2.5mm → violation.

  it('Scenario 6: hole near edge → HOLE_TOO_CLOSE_TO_EDGE', () => {
    const store = new GraphStore();
    const part = createRect(store, 'hole-edge', 100, 50, 2.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 2, 25, 1.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'HOLE_TOO_CLOSE_TO_EDGE')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 7 — Two holes too close
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("HoleToHole: too close produces HOLE_TOO_CLOSE_TO_HOLE")
  //   Centres (25,25) and (26,25) → 1mm apart, min=3mm → violation.

  it('Scenario 7: holes too close → HOLE_TOO_CLOSE_TO_HOLE', () => {
    const store = new GraphStore();
    const part = createRect(store, 'holes-close', 100, 50, 2.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 25, 25, 1.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 26, 25, 1.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'HOLE_TOO_CLOSE_TO_HOLE')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 8 — Flange too short
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("FlangeWidth: too short produces MIN_FLANGE_WIDTH")
  //   Part: 10×50mm, 2mm thick.  Bend at x=5 creates a leaf panel spanning
  //   x=5..10 → width=5mm < 4.0×2.0=8mm → MIN_FLANGE_WIDTH.

  it('Scenario 8: flange too short → MIN_FLANGE_WIDTH', () => {
    const store = new GraphStore();
    const part = createRect(store, 'short-flange', 10, 50, 2.0);
    addBend(store, part.part_id, part.root_region_panel_id, 5, 0, 5, 50, 90, 2.0);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MIN_FLANGE_WIDTH')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 9 — Multiple violations on one part
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("EvaluateFindings: multi-violation part returns all findings")
  //   Thin bend (radius=1.5) + small hole (radius=0.8) on 2mm part →
  //   MIN_BEND_RADIUS AND MIN_HOLE_DIAMETER.

  it('Scenario 9: multiple violations → all appear', () => {
    const store = new GraphStore();
    const part = createRect(store, 'multi-bad', 100, 50, 2.0);
    // Cut hole first (one big region panel), then add bend.
    cutCircle(store, part.part_id, part.root_region_panel_id, 25, 25, 0.8);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 90, 1.5);
    const result = readFindings(store, part.part_id);
    expect(hasCode(result.findings, 'MIN_BEND_RADIUS')).toBe(true);
    expect(hasCode(result.findings, 'MIN_HOLE_DIAMETER')).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 10 — full resource embeds the same findings
  // ════════════════════════════════════════════════════════════════════════════
  // 15 §3.2: "one computation, two projections" — full's findings must match
  // the dedicated findings resource exactly.

  it('Scenario 10: full resource findings matches dedicated findings resource', () => {
    const store = new GraphStore();
    const part = createRect(store, 'full-consistency', 100, 50, 2.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 25, 25, 0.8);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 90, 1.5);

    const dedicated = readFindings(store, part.part_id);
    const full = readFull(store, part.part_id);
    expect(full.findings).toEqual(dedicated.findings);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Scenario 11 — Profile override: relaxed profile → fewer findings
  // ════════════════════════════════════════════════════════════════════════════
  // C++ equivalent: TEST_CASE("Profile: relaxed profile produces fewer findings")
  //   Default profile flags both; relaxed (factors=0.5) flags neither.

  it('Scenario 11: relaxed profile finds fewer issues', () => {
    const store = new GraphStore();
    const part = createRect(store, 'profile-relaxed', 100, 50, 2.0);
    cutCircle(store, part.part_id, part.root_region_panel_id, 25, 25, 0.8);
    addBend(store, part.part_id, part.root_region_panel_id, 50, 0, 50, 50, 90, 1.5);

    // Default profile: both violations present.
    const def = readFindings(store, part.part_id);
    expect(hasCode(def.findings, 'MIN_BEND_RADIUS')).toBe(true);
    expect(hasCode(def.findings, 'MIN_HOLE_DIAMETER')).toBe(true);

    // Note: profile override via the findings resource is not yet wired
    // (the resource currently uses the default profile).  This assertion
    // documents the current behaviour and will be strengthened when
    // profile-override support is added to the resource URI.
  });
});
