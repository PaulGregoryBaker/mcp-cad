import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/mcp/tools';
import type { ManufacturingConfig } from '../../src/config/loader';

const cfg: ManufacturingConfig = {
  materials: [
    {
      id: 'mild_steel_1.5mm',
      name: 'Mild Steel',
      thicknessMm: 1.5,
      kFactor: 0.33,
      yieldStrengthMpa: 250,
      grainDirection: 'any',
      inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8' }],
    },
  ],
  tooling: {
    pressBrake: { maxTonnage: 500, maxBendLengthMm: 2500, vDieWidthsMm: [6], punchRadiiMm: [0.5] },
    laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 23,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

describe('synthesize_joints contract', () => {
  it('rejects unsafe joints in fire-rated context with structured error', async () => {
    const fireCfg: ManufacturingConfig = {
      ...cfg,
      environmental: { ...cfg.environmental, fireRated: true },
    };

    await expect(
      dispatchTool(
        'synthesize_joints',
        { panel_ids: ['p1', 'p2'], joint_type: 'adhesive' },
        fireCfg,
      ),
    ).rejects.toMatchObject({ code: 'MD_SAFETY_VIOLATION' });
  });

  it('requires exactly two panel ids', async () => {
    await expect(
      dispatchTool(
        'synthesize_joints',
        { panel_ids: ['p1'], joint_type: 'tab_slot' },
        cfg,
      ),
    ).rejects.toMatchObject({ code: 'GE_TAB_SLOT_FAILED' });
  });
});
