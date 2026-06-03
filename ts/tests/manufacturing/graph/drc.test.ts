/**
 * Unit tests for DrcChecker.
 * Tasks: T034
 */

import { describe, it, expect, vi } from 'vitest';
import { DrcChecker } from '../../../src/manufacturing/graph/drc';
import { ManufacturingGraph } from '../../../src/manufacturing/graph/graph';
import { toNodeId } from '../../../src/manufacturing/graph/types';
import type { PanelNode, BendNode } from '../../../src/manufacturing/graph/types';
import type { FoldabilityChecker } from '../../../src/manufacturing/graph/foldability';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePanel(id: string, flatWidth = 50.0): PanelNode {
  return {
    type: 'PanelNode',
    id: toNodeId(id),
    bodyId: null,
    dirty: false,
    materialType: 'mild_steel',
    nominalThickness: 1.5,
    flatWidth,
    flatHeight: 100,
  };
}

function makeBendNode(id: string, panelA: string, panelB: string, overrides: Partial<BendNode> = {}): BendNode {
  return {
    type: 'BendNode',
    id: toNodeId(id),
    dirty: false,
    panelAId: toNodeId(panelA),
    panelBId: toNodeId(panelB),
    innerRadius: 2.0,
    angle: 90,
    kFactor: 0.42,
    bendAllowance: null,
    ...overrides,
  };
}

function makeMockFoldabilityChecker(): FoldabilityChecker {
  return {
    check: vi.fn().mockReturnValue({ violations: [], panelAccessibility: [] }),
    checkWithProposed: vi.fn().mockReturnValue({ violations: [], panelAccessibility: [] }),
  } as unknown as FoldabilityChecker;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DrcChecker', () => {
  const config = {
    minBendRadiusMm: 1.5,
    minFlangeWidthMm: 10.0,
    thicknessMm: 1.5,
  };

  it('passes when bend radius and flange width are within tolerance', () => {
    const fc = makeMockFoldabilityChecker();
    const drc = new DrcChecker(fc);
    const graph = new ManufacturingGraph('s');
    const p1 = makePanel('p1', 50);
    const p2 = makePanel('p2', 50);
    graph.addNode(p1);
    graph.addNode(p2);
    const bend = makeBendNode('b1', 'p1', 'p2');
    graph.addNode(bend);

    const result = drc.check({ graph, candidateNode: bend, materialConfig: config });
    expect(result.violations).toHaveLength(0);
  });

  it('emits DRC_BEND_RADIUS_VIOLATION when radius is too small', () => {
    const fc = makeMockFoldabilityChecker();
    const drc = new DrcChecker(fc);
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1', 50));
    graph.addNode(makePanel('p2', 50));
    const bend = makeBendNode('b1', 'p1', 'p2', { innerRadius: 0.5 });
    graph.addNode(bend);

    const result = drc.check({ graph, candidateNode: bend, materialConfig: config });
    const codes = result.violations.map((v) => v.errorCode);
    expect(codes).toContain('DRC_BEND_RADIUS_VIOLATION');
  });

  it('emits DRC_MIN_FLANGE_WIDTH_VIOLATION when flange is too narrow', () => {
    const fc = makeMockFoldabilityChecker();
    const drc = new DrcChecker(fc);
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1', 50));
    graph.addNode(makePanel('p2', 5)); // flatWidth 5mm < minFlangeWidth 10mm
    const bend = makeBendNode('b1', 'p1', 'p2');
    graph.addNode(bend);

    const result = drc.check({ graph, candidateNode: bend, materialConfig: config });
    const codes = result.violations.map((v) => v.errorCode);
    expect(codes).toContain('DRC_MIN_FLANGE_WIDTH_VIOLATION');
  });

  it('promotes foldability violations from FoldabilityChecker', () => {
    const fc = {
      check: vi.fn(),
      checkWithProposed: vi.fn().mockReturnValue({
        violations: [{
          ruleId: 'DRC_FOLDABILITY_VIOLATION',
          errorCode: 'DRC_FOLDABILITY_VIOLATION',
          message: 'Panel p1 is inaccessible',
          severity: 'ERROR',
          affectedNodeId: toNodeId('p1'),
        }],
        panelAccessibility: [],
      }),
    } as unknown as FoldabilityChecker;

    const drc = new DrcChecker(fc);
    const graph = new ManufacturingGraph('s');
    graph.addNode(makePanel('p1', 50));
    graph.addNode(makePanel('p2', 50));
    const bend = makeBendNode('b1', 'p1', 'p2');
    graph.addNode(bend);

    const result = drc.check({ graph, candidateNode: bend, materialConfig: config });
    const codes = result.violations.map((v) => v.errorCode);
    expect(codes).toContain('DRC_FOLDABILITY_VIOLATION');
  });
});

// ─── validateProfile (T051) ───────────────────────────────────────────────────

import { validateProfile } from '../../../src/manufacturing/graph/types';
import type { CutProfile, FlatPanelBounds } from '../../../src/manufacturing/graph/types';

describe('validateProfile', () => {
  const bounds: FlatPanelBounds = { width: 200, height: 100 };

  it('passes a valid circle within bounds', () => {
    const profile: CutProfile = { type: 'CIRCLE', centreX: 50, centreY: 50, radius: 10 };
    expect(validateProfile(profile, bounds)).toHaveLength(0);
  });

  it('returns CUT_PROFILE_OUT_OF_BOUNDS when circle exceeds panel', () => {
    const profile: CutProfile = { type: 'CIRCLE', centreX: 195, centreY: 50, radius: 10 };
    const violations = validateProfile(profile, bounds);
    expect(violations.map((v) => v.errorCode)).toContain('CUT_PROFILE_OUT_OF_BOUNDS');
  });

  it('returns CUT_PROFILE_OUT_OF_BOUNDS when rectangle exceeds panel', () => {
    const profile: CutProfile = { type: 'RECTANGLE', originX: 180, originY: 10, width: 40, height: 20 };
    const violations = validateProfile(profile, bounds);
    expect(violations.map((v) => v.errorCode)).toContain('CUT_PROFILE_OUT_OF_BOUNDS');
  });

  it('returns CUT_INVALID_PROFILE when polygon has fewer than 3 vertices', () => {
    const profile: CutProfile = { type: 'POLYGON', vertices: [{ x: 10, y: 10 }, { x: 20, y: 10 }] };
    const violations = validateProfile(profile, bounds);
    expect(violations.map((v) => v.errorCode)).toContain('CUT_INVALID_PROFILE');
  });

  it('passes a valid convex polygon within bounds', () => {
    const profile: CutProfile = {
      type: 'POLYGON',
      vertices: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }],
    };
    expect(validateProfile(profile, bounds)).toHaveLength(0);
  });

  it('returns CUT_OVERLAP when two circles overlap', () => {
    const existing: CutProfile = { type: 'CIRCLE', centreX: 50, centreY: 50, radius: 10 };
    const profile: CutProfile = { type: 'CIRCLE', centreX: 55, centreY: 55, radius: 10 };
    const violations = validateProfile(profile, bounds, [existing]);
    expect(violations.map((v) => v.errorCode)).toContain('CUT_OVERLAP');
  });

  it('does not report overlap when circles do not overlap', () => {
    const existing: CutProfile = { type: 'CIRCLE', centreX: 50, centreY: 50, radius: 10 };
    const profile: CutProfile = { type: 'CIRCLE', centreX: 150, centreY: 50, radius: 5 };
    expect(validateProfile(profile, bounds, [existing])).toHaveLength(0);
  });

  it('returns DRC_CUT_IN_BEND_ZONE warning when profile overlaps a bend zone', () => {
    // Profile AABB: [45,45]–[55,55]; bend zone X: [48,58] → overlap
    const profile: CutProfile = { type: 'CIRCLE', centreX: 50, centreY: 50, radius: 5 };
    const bendZones = [{ offset: 48, width: 10, nodeId: toNodeId('b1') }];
    const violations = validateProfile(profile, bounds, [], bendZones);
    expect(violations.map((v) => v.errorCode)).toContain('DRC_CUT_IN_BEND_ZONE');
    const warning = violations.find((v) => v.errorCode === 'DRC_CUT_IN_BEND_ZONE')!;
    expect(warning.severity).toBe('WARNING');
    // Operation must not be blocked — no ERROR severity violations
    expect(violations.filter((v) => v.severity === 'ERROR')).toHaveLength(0);
  });

  it('does not report DRC_CUT_IN_BEND_ZONE when profile is clear of bend zones', () => {
    const profile: CutProfile = { type: 'CIRCLE', centreX: 20, centreY: 50, radius: 5 };
    const bendZones = [{ offset: 90, width: 10, nodeId: toNodeId('b1') }];
    expect(validateProfile(profile, bounds, [], bendZones)).toHaveLength(0);
  });
});
