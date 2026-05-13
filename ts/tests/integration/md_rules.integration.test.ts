import { describe, expect, it } from 'vitest';
import type { FeatureSet } from '../../src/manufacturing/feature';
import { validateFeatureSet } from '../../src/manufacturing/rules_engine';
import { isJointTypeAllowed } from '../../src/manufacturing/rules';
import { loadConfig } from '../../src/config/loader';

describe('MD rules integration', () => {
  it('loads config and validates intentional violations', () => {
    const cfg = loadConfig('./config/config.yaml');

    const fs: FeatureSet = {
      shellId: 'shell-1',
      bends: [
        {
          featureId: 'b1',
          angleDeg: 90,
          radiusMm: 0.2,
          lengthMm: 100,
          kFactor: 0.33,
          bendAllowanceMm: 1,
          faceIds: ['f1', 'f2'],
        },
      ],
      holes: [
        {
          featureId: 'h1',
          centerX: 0,
          centerY: 0,
          diameterMm: 0.5,
          throughHole: true,
          faceId: 'f1',
        },
      ],
      flanges: [
        {
          featureId: 'fl1',
          widthMm: 1,
          lengthMm: 100,
          adjacentBendId: 'b1',
          faceId: 'f3',
        },
      ],
      reliefs: [],
    };

    const out = validateFeatureSet(fs, cfg.materials[0]!.id, cfg);
    expect(out.valid).toBe(false);
    expect(out.violations.length).toBeGreaterThan(0);
  });

  it('blocks adhesive in fire-rated context', () => {
    const out = isJointTypeAllowed('adhesive', {
      fireRated: true,
      marineGrade: false,
      highVibration: false,
    });
    expect(out.allowed).toBe(false);
  });
});
