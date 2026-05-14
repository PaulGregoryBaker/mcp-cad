import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import * as path from 'node:path';

describe('SYS-JTBD-02 Safety Integration', () => {
  it('rejects adhesive joint when fire_rated is true', async () => {
    // 1. Create a config indicating a fire_rated environment
    const config = Object.assign({}, loadConfig(path.resolve(__dirname, '../../config/config.yaml')));
    config.environmental = {
      ...config.environmental,
      fireRated: true,
      corrosive: false,
    };

    // 2. Call synthesize_joints with adhesive
    try {
      await dispatchTool(
        'synthesize_joints',
        {
          panel_ids: ['panel1', 'panel2'],
          joint_type: 'adhesive',
          clearance_mm: 0.15,
        },
        config,
      );
      expect.fail('Should have rejected adhesive joint');
    } catch (err: any) {
      expect(err).toBeDefined();
      // throwError throws MCP Model Error which contains message or code
      expect(err.code || err.message).toContain('MD_SAFETY_VIOLATION');
    }
  });

  it('rejects plastic_fastener joint when fire_rated is true', async () => {
    const config = Object.assign({}, loadConfig(path.resolve(__dirname, '../../config/config.yaml')));
    config.environmental = {
      ...config.environmental,
      fireRated: true,
      corrosive: false,
    };

    try {
      await dispatchTool(
        'synthesize_joints',
        {
          panel_ids: ['panel1', 'panel2'],
          joint_type: 'plastic_fastener',
          clearance_mm: 0.15,
        },
        config,
      );
      expect.fail('Should have rejected plastic_fastener joint');
    } catch (err: any) {
      expect(err).toBeDefined();
      expect(err.code || err.message).toContain('MD_SAFETY_VIOLATION');
    }
  });

  it('allows tab_slot joint when fire_rated is true (but fails with geometry error since panels are fake)', async () => {
    const config = Object.assign({}, loadConfig(path.resolve(__dirname, '../../config/config.yaml')));
    config.environmental = {
      ...config.environmental,
      fireRated: true,
      corrosive: false,
    };

    try {
      await dispatchTool(
        'synthesize_joints',
        {
          panel_ids: ['panel1', 'panel2'], // Not real in geometry engine
          joint_type: 'tab_slot',
          clearance_mm: 0.15,
        },
        config,
      );
      expect.fail('Should have thrown a geometry error since panel_ids are fake');
    } catch (err: any) {
      // It passed safety, but failed at GE because 'panel1' doesn't exist.
      // E.g., GE_SHELL_NOT_FOUND
      expect(err.message || err.code).not.toContain('MD_SAFETY_VIOLATION');
       // some geometry engine error
    }
  });
});
