import { describe, expect, it } from 'vitest';
import { reconstructManufacturingPlan } from '../../../src/manufacturing/reconstruction/orchestrator';

describe('reconstructManufacturingPlan joint prioritization', () => {
  const mockConfig = {
    materials: [
      {
        id: 'mild_steel_1.5mm',
        thicknessMm: 1.5,
        kFactor: 0.33,
      },
    ],
  } as any;

  function createMockBinding(options: {
    panels: Record<string, { area: number; normal: [number, number, number] }>;
    splitPairs: [string, string][];
    onMerge?: (bodyA: string, bodyB: string) => void;
  }) {
    return {
      splitBodyByBends: () => ({
        panel_ids: Object.keys(options.panels),
        panel_bboxes: Object.keys(options.panels).map(() => ({ x_min: 0, y_min: 0, z_min: 0, x_max: 0, y_max: 0, z_max: 0 })),
        protrusion_ids: [],
        protrusion_bboxes: [],
        protrusion_parents: [],
        split_pairs: options.splitPairs,
      }),
      isPanelValid: () => ({ isValid: true }),
      getTopology: (id: string) => {
        const panel = options.panels[id];
        if (!panel) throw new Error(`Unknown panel ${id}`);
        return {
          faces: [
            {
              surfaceType: 'plane',
              areaMm2: panel.area,
              normalX: panel.normal[0],
              normalY: panel.normal[1],
              normalZ: panel.normal[2],
            },
          ],
        };
      },
      createSnapshot: () => 'snapshot-id',
      clearSnapshot: () => {},
      restoreSnapshot: () => {},
      fuseBodies: (bodies: string[]) => ({
        solid_id: bodies.join('_'),
        shape_history: [],
      }),
      mergeBodiesWithBend: (bodyA: string, bodyB: string) => {
        if (options.onMerge) {
          options.onMerge(bodyA, bodyB);
        }
        return {
          mergedShellId: `${bodyA}_${bodyB}`,
          shape_history: [],
        };
      },
    } as any;
  }

  it('Rule 1: prioritizes by dihedral angle priority score first', async () => {
    const mergeCalls: string[][] = [];
    const binding = createMockBinding({
      panels: {
        // Normal along Z and X for 90 degree bend
        panelA: { area: 100, normal: [0, 0, 1] },
        panelB: { area: 100, normal: [1, 0, 0] }, // Joint A-B is 90 deg (priority 100)
        // Normal along Z and slightly tilted for non-90 degree bend
        panelC: { area: 500, normal: [0.7071, 0, 0.7071] }, // Joint B-C is 45 deg (priority 50)
      },
      splitPairs: [
        ['panelB', 'panelC'], // Joint 2 (dihedral 45) - even with larger area (100+500 = 600)
        ['panelA', 'panelB'], // Joint 1 (dihedral 90) - smaller area (100+100 = 200)
      ],
      onMerge: (a, b) => mergeCalls.push([a, b]),
    });

    await reconstructManufacturingPlan('part-1', 45, 5, 1.5, mockConfig, binding);

    expect(mergeCalls).toHaveLength(2);
    // Should merge panelA and panelB (90 deg) first
    expect(mergeCalls[0]).toEqual(['panelA', 'panelB']);
  });

  it('Rule 2: prioritizes by combined area descending if priority scores are equal', async () => {
    const mergeCalls: string[][] = [];
    const binding = createMockBinding({
      panels: {
        panelA: { area: 100, normal: [0, 0, 1] },
        panelB: { area: 100, normal: [1, 0, 0] }, // Joint A-B has combined area 200
        panelC: { area: 300, normal: [0, 0, 1] }, // Joint B-C has combined area 400
      },
      splitPairs: [
        ['panelA', 'panelB'], // Combined area = 200
        ['panelB', 'panelC'], // Combined area = 400
      ],
      onMerge: (a, b) => mergeCalls.push([a, b]),
    });

    await reconstructManufacturingPlan('part-1', 45, 5, 1.5, mockConfig, binding);

    expect(mergeCalls).toHaveLength(2);
    // Should merge B-C first because its combined area (400) is larger than A-B (200)
    expect(mergeCalls[0]).toEqual(['panelB', 'panelC']);
  });

  it('Rule 3: prioritizes parallel axis to previous successful joins if area and priority are equal', async () => {
    const mergeCalls: string[][] = [];
    const binding = createMockBinding({
      panels: {
        panelA: { area: 100, normal: [0, 0, 1] },
        panelB: { area: 100, normal: [1, 0, 0] }, // Joint A-B axis: normalA x normalB = (0, 1, 0)
        panelC: { area: 100, normal: [0, 0, 1] }, // Joint B-C axis: normalB x normalC = (0, 1, 0)
        panelD: { area: 100, normal: [0, 1, 0] }, // Joint C-D axis: normalC x normalD = (-1, 0, 0)
      },
      splitPairs: [
        ['panelA', 'panelB'], // axis: Y-axis (0, 1, 0)
        ['panelC', 'panelD'], // axis: X-axis (-1, 0, 0)
        ['panelB', 'panelC'], // axis: Y-axis (0, 1, 0)
      ],
      onMerge: (a, b) => mergeCalls.push([a, b]),
    });

    await reconstructManufacturingPlan('part-1', 45, 5, 1.5, mockConfig, binding);

    // Let's analyze:
    // Initially, all joints have priority 100 and combined area 200.
    // The alignment score for all joints is initially 0.
    // We pick one joint. Because of original array order/sorting, let's say the first joint merged is A-B.
    // Axis of A-B is along Y-axis (0, 1, 0).
    // Now, mergedAxes has [(0, 1, 0)].
    // Next, the remaining joints are C-D (axis (-1, 0, 0), alignment score = 0)
    // and B-C (axis (0, 1, 0), alignment score = 1.0).
    // Because B-C is parallel to A-B, it has alignment score 1.0, which is higher than C-D's 0.
    // So B-C MUST be prioritized next!
    expect(mergeCalls).toHaveLength(3);
    expect(mergeCalls[0]).toEqual(['panelA', 'panelB']);
    expect(mergeCalls[1]).toEqual(['panelA_panelB', 'panelC']); // B-C was merged (since B was merged into panelA_panelB)
  });
});
