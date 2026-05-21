import { describe, expect, it } from 'vitest';
import { getToolDefinitions } from '../../src/mcp/tools';

describe('decompose_volume contract', () => {
  console.log('decompose_volume contract tests starting...');

  it('defines required input schema fields', () => {
    const def = getToolDefinitions().find(
      (t) => (t as { name?: string }).name === 'decompose_volume',
    ) as { inputSchema?: { required?: string[]; properties?: Record<string, unknown> } };

    expect(def).toBeDefined();
    expect(def.inputSchema?.required).toEqual(['solid_id', 'strategy']);
    expect(def.inputSchema?.properties?.['max_panels']).toBeDefined();
  });
  console.log('decompose_volume contract tests completed...');
});
