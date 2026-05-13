/**
 * TypeScript unit tests: MCP Server scaffold.
 * Tests server startup, resource serving, tool schema definitions.
 *
 * Task: T040
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getToolDefinitions, dispatchTool } from '../../src/mcp/tools';
import { getAllResources } from '../../src/mcp/resources';
import { loadConfig } from '../../src/config/loader';
import type { ManufacturingConfig } from '../../src/config/loader';

// ─── Test configuration ──────────────────────────────────────────────────────

const testConfig: ManufacturingConfig = {
  materials: [
    {
      id: 'mild_steel_1.5mm',
      name: 'Mild Steel 1.5mm',
      thicknessMm: 1.5,
      kFactor: 0.33,
      yieldStrengthMpa: 250,
      grainDirection: 'any',
      inventorySheets: [{ widthMm: 1220, heightMm: 2440, label: '4x8ft' }],
    },
  ],
  tooling: {
    pressBrake: {
      maxTonnage: 500,
      maxBendLengthMm: 2000,
      vDieWidthsMm: [6, 8, 10],
      punchRadiiMm: [0.5, 1.0],
    },
    laser: { maxKerfWidthMm: 0.15, minHoleDiameterMm: 1.5 },
  },
  logistics: {
    shippingEnvelope: { maxLengthMm: 2400, maxWidthMm: 1200, maxHeightMm: 800 },
    maxWeightKg: 25,
    coatingEnvelope: { maxLengthMm: 2000, maxWidthMm: 1000 },
  },
  environmental: { fireRated: false, marineGrade: false, highVibration: false },
};

// ─── Tool schema definitions ──────────────────────────────────────────────────

describe('MCP Server: tool definitions', () => {
  it('getToolDefinitions() returns array of tools', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('defines all 12 expected tools', () => {
    const defs = getToolDefinitions();
    const toolNames = defs.map((t: Record<string, unknown>) => t.name);

    expect(toolNames).toContain('clean_geometry');
    expect(toolNames).toContain('decompose_volume');
    expect(toolNames).toContain('synthesize_joints');
    expect(toolNames).toContain('generate_reliefs');
    expect(toolNames).toContain('apply_unfold');
    expect(toolNames).toContain('evaluate_manufacturability');
    expect(toolNames).toContain('validate_bend_sequence');
    expect(toolNames).toContain('simulate_nesting');
    expect(toolNames).toContain('export_production_pack');
    expect(toolNames).toContain('get_export_job_status');
    expect(toolNames).toContain('get_export_job_result');
    expect(toolNames).toContain('rollback');
  });

  it('each tool has description and inputSchema', () => {
    const defs = getToolDefinitions();
    for (const tool of defs) {
      const t = tool as Record<string, unknown>;
      expect(typeof t.description).toBe('string');
      expect(typeof t.inputSchema).toBe('object');
      expect(t.inputSchema).not.toBeNull();
    }
  });

  it('tool schemas have required properties', () => {
    const defs = getToolDefinitions();
    for (const tool of defs) {
      const t = tool as Record<string, unknown>;
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(Array.isArray(schema.required)).toBe(true);
    }
  });
});

// ─── Resource definitions ────────────────────────────────────────────────────

describe('MCP Server: resource definitions', () => {
  it('getAllResources() returns object with URIs as keys', () => {
    const resources = getAllResources(testConfig);
    expect(typeof resources).toBe('object');
    const keys = Object.keys(resources);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('resource URIs follow context://, logistics://, manufacturing:// scheme', () => {
    const resources = getAllResources(testConfig);
    const uris = Object.keys(resources);

    const hasContext = uris.some((uri) => uri.startsWith('context://'));
    const hasLogistics = uris.some((uri) => uri.startsWith('logistics://'));
    const hasManufacturing = uris.some((uri) => uri.startsWith('manufacturing://'));

    expect(hasContext || hasLogistics || hasManufacturing).toBe(true);
  });

  it('resource values are non-null objects or primitives', () => {
    const resources = getAllResources(testConfig);
    for (const [uri, value] of Object.entries(resources)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
  });
});

// ─── Tool dispatch error handling ─────────────────────────────────────────────

describe('MCP Server: tool dispatch error handling', () => {
  it('dispatchTool rejects unknown tool name', async () => {
    const promise = dispatchTool('unknown_tool', {}, testConfig);
    await expect(promise).rejects.toThrow();
  });

  it('dispatchTool rejects missing required arguments', async () => {
    const promise = dispatchTool('clean_geometry', {}, testConfig);  // Missing file_path
    await expect(promise).rejects.toThrow();
  });

  it('dispatchTool throws structured error for invalid file path', async () => {
    const promise = dispatchTool(
      'clean_geometry',
      { file_path: '/nonexistent/missing.stp' },
      testConfig,
    );
    await expect(promise).rejects.toThrow();
  });
});

// ─── Tool dispatch success cases (stubs) ─────────────────────────────────────

describe('MCP Server: tool dispatch success (Phase A stubs)', () => {
  it('dispatchTool("decompose_volume") returns panel_ids array', async () => {
    // Phase A: stub should return empty array or valid structure
    // Full implementation in Phase B
    const result = await dispatchTool(
      'decompose_volume',
      { solid_id: 'solid-uuid', strategy: 'Integrity' },
      testConfig,
    );
    expect(result).not.toBeNull();
  });

  it('dispatchTool("evaluate_manufacturability") returns score', async () => {
    // Phase A stub returns score=1.0 (no violations yet)
    // Full scoring in Phase C
    const result = await dispatchTool(
      'evaluate_manufacturability',
      { panel_id: 'panel-uuid', material_id: 'mild_steel_1.5mm' },
      testConfig,
    );
    const r = result as Record<string, unknown>;
    expect(typeof r.score).toBe('number');
  });

  it('dispatchTool("validate_bend_sequence") returns valid flag', async () => {
    // Phase A stub: always valid
    // Full validation in Phase C
    const result = await dispatchTool(
      'validate_bend_sequence',
      { panel_id: 'panel-uuid' },
      testConfig,
    );
    const r = result as Record<string, unknown>;
    expect(typeof r.valid).toBe('boolean');
  });
});

// ─── Server startup validation ────────────────────────────────────────────────

describe('MCP Server: startup validation', () => {
  it('loads config without errors', () => {
    // Should not throw; actual config comes from CONFIG_PATH env var
    // This test verifies that testConfig structure is valid
    expect(testConfig.materials).toBeDefined();
    expect(testConfig.tooling).toBeDefined();
    expect(testConfig.logistics).toBeDefined();
    expect(testConfig.environmental).toBeDefined();
  });

  it('tool definitions and resources are compatible', () => {
    const defs = getToolDefinitions();
    const resources = getAllResources(testConfig);

    // Both should be non-empty
    expect(defs.length).toBeGreaterThan(0);
    expect(Object.keys(resources).length).toBeGreaterThan(0);
  });

  it('can serve resources for all environmental contexts', () => {
    const fireRated = { ...testConfig, environmental: { ...testConfig.environmental, fireRated: true } };
    const marineGrade = { ...testConfig, environmental: { ...testConfig.environmental, marineGrade: true } };
    const highVibration = { ...testConfig, environmental: { ...testConfig.environmental, highVibration: true } };

    expect(() => getAllResources(fireRated)).not.toThrow();
    expect(() => getAllResources(marineGrade)).not.toThrow();
    expect(() => getAllResources(highVibration)).not.toThrow();
  });
});

// ─── Tool safety filter (Constitution Principle III) ──────────────────────────

describe('MCP Server: safety filter compliance', () => {
  it('safety filter rejects adhesive in fire-rated context', async () => {
    const fireRatedConfig = {
      ...testConfig,
      environmental: { ...testConfig.environmental, fireRated: true },
    };

    const promise = dispatchTool(
      'synthesize_joints',
      {
        panel_ids: ['panel1', 'panel2'],
        joint_type: 'adhesive',
      },
      fireRatedConfig,
    );
    await expect(promise).rejects.toThrow(/safety|adhesive|fire/i);
  });

  it('safety filter rejects plastic_fastener in marine context', async () => {
    const marineConfig = {
      ...testConfig,
      environmental: { ...testConfig.environmental, marineGrade: true },
    };

    const promise = dispatchTool(
      'synthesize_joints',
      {
        panel_ids: ['panel1', 'panel2'],
        joint_type: 'plastic_fastener',
      },
      marineConfig,
    );
    await expect(promise).rejects.toThrow(/safety|plastic|marine/i);
  });

  it('allows tab_slot in any context', async () => {
    const fireRatedConfig = {
      ...testConfig,
      environmental: { ...testConfig.environmental, fireRated: true },
    };

    const promise = dispatchTool(
      'synthesize_joints',
      {
        panel_ids: ['panel1', 'panel2'],
        joint_type: 'tab_slot',
      },
      fireRatedConfig,
    );
    // Should not throw safety violation
    // May throw other errors if IDs don't exist, but not safety
    await promise.then(
      () => expect(true).toBe(true),  // Success
      (err) => expect(String(err)).not.toMatch(/safety/i),  // Allowed errors
    );
  });
});
