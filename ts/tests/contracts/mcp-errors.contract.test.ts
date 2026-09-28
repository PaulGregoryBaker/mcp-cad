/**
 * TypeScript contract test: MCP error model.
 * Asserts every error code in Engineering-Design §3.4 returns
 * {code, title, message, recoverable, options, suggestedTool?}.
 *
 * Task: T141
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCodes,
  makeError,
  toStructuredError,
  McpToolError,
  defaultErrorTitle,
  type ErrorOption,
} from '../../src/mcp/errors';
import { graphToolDefinitions } from '../../src/v2/tools/graph';

describe('MCP Error Model Contract', () => {
  describe('makeError: creates well-formed StructuredError', () => {
    it('has all required fields', () => {
      const err = makeError(ErrorCodes.GE_IMPORT_FAILED, 'test message', false);
      expect(err).toMatchObject({
        code: ErrorCodes.GE_IMPORT_FAILED,
        message: 'test message',
        recoverable: false,
      });
    });

    it('includes suggestedTool when provided', () => {
      const err = makeError(
        ErrorCodes.GE_BOOLEAN_FAILURE,
        'cut failed',
        true,
        'rollback',
      );
      expect(err.suggestedTool).toBe('rollback');
    });

    it('suggestedTool is undefined when not provided', () => {
      const err = makeError(ErrorCodes.GE_IMPORT_FAILED, 'failed', false);
      expect(err.suggestedTool).toBeUndefined();
    });
  });

  describe('ErrorCodes: all required codes are defined', () => {
    const requiredCodes = [
      'GE_IMPORT_FAILED',
      'GE_INVALID_SOLID',
      'GE_SOLID_NOT_FOUND',
      'GE_SHELL_NOT_FOUND',
      'GE_UNFOLD_NOT_FOUND',
      'GE_HEAL_FAILED',
      'GE_BOOLEAN_FAILURE',
      'GE_EMPTY_RESULT',
      'GE_TAB_SLOT_FAILED',
      'GE_UNFOLD_FAILED',
      'GE_RELIEF_FAILED',
      'GE_NEST_FAILED',
      'GE_SNAPSHOT_NOT_FOUND',
      'GE_RESTORE_FAILED',
      'MD_MATERIAL_NOT_FOUND',
      'MD_SAFETY_VIOLATION',
      'MD_RULE_VIOLATION',
      'ACL_EXTRACTION_FAILED',
      'EXPORT_JOB_NOT_FOUND',
      'EXPORT_JOB_NOT_COMPLETE',
      'CONFIG_INVALID',
      'INTERNAL_ERROR',
    ] as const;

    for (const code of requiredCodes) {
      it(`defines error code: ${code}`, () => {
        expect(ErrorCodes[code]).toBe(code);
      });
    }
  });

  describe('toStructuredError: converts any thrown value', () => {
    it('passes through McpToolError unchanged', () => {
      const structured = makeError(ErrorCodes.GE_IMPORT_FAILED, 'original', false);
      const err = new McpToolError(structured);
      const result = toStructuredError(err);
      expect(result).toEqual(structured);
    });

    it('parses JSON-format NAPI errors from Error.message', () => {
      const napiError = new Error(
        '{"code":"GE_SOLID_NOT_FOUND","message":"Solid not found","recoverable":false}',
      );
      const result = toStructuredError(napiError);
      expect(result.code).toBe('GE_SOLID_NOT_FOUND');
      expect(result.message).toBe('Solid not found');
      expect(result.recoverable).toBe(false);
    });

    it('handles plain Error with code property', () => {
      const err = new Error('some failure');
      (err as Error & { code: string }).code = 'GE_HEAL_FAILED';
      const result = toStructuredError(err);
      expect(result.code).toBe('GE_HEAL_FAILED');
    });

    it('wraps unknown throws as INTERNAL_ERROR', () => {
      const result = toStructuredError('unexpected string throw');
      expect(result.code).toBe(ErrorCodes.INTERNAL_ERROR);
    });

    it('never returns an object without code field', () => {
      const inputs = [null, undefined, 42, {}, new Error('plain')];
      for (const input of inputs) {
        const result = toStructuredError(input);
        expect(typeof result.code).toBe('string');
        expect(result.code.length).toBeGreaterThan(0);
      }
    });
  });

  describe('StructuredError shape compliance', () => {
    it('all required fields present in every error code', () => {
      for (const code of Object.values(ErrorCodes)) {
        const err = makeError(code, `${code} message`, false);
        expect(err).toHaveProperty('code');
        expect(err).toHaveProperty('message');
        expect(err).toHaveProperty('recoverable');
        expect(typeof err.code).toBe('string');
        expect(typeof err.message).toBe('string');
        expect(typeof err.recoverable).toBe('boolean');
      }
    });
  });

  describe('title and options: every error carries them', () => {
    it('defaults title from the code and options to []', () => {
      const err = makeError(ErrorCodes.GE_MERGE_AMBIGUOUS_CONTACT, 'm', true);
      expect(err.title).toBe('Merge ambiguous contact');
      expect(err.options).toEqual([]);
    });

    it('defaultErrorTitle never returns an empty string', () => {
      for (const code of Object.values(ErrorCodes)) {
        expect(defaultErrorTitle(code).length).toBeGreaterThan(0);
      }
    });

    it('keeps an explicit title and options', () => {
      const option: ErrorOption = {
        id: 'o1',
        display: { button_text: 'Fuse instead', description: 'd', style: 'primary' },
        call: { tool: 'fuse_bodies', arguments: { part_a_id: 'a', part_b_id: 'b' } },
      };
      const err = makeError(ErrorCodes.GE_MERGE_COPLANAR_SEAM, 'm', true, undefined, {
        title: 'Parts are coplanar',
        options: [option],
      });
      expect(err.title).toBe('Parts are coplanar');
      expect(err.options).toEqual([option]);
    });

    it('toStructuredError fills title/options on every path', () => {
      const inputs = [
        null,
        'x',
        new Error('plain'),
        new Error('{"code":"GE_SOLID_NOT_FOUND","message":"m","recoverable":false}'),
        { code: 'GE_HEAL_FAILED', message: 'm', recoverable: true },
      ];
      for (const input of inputs) {
        const result = toStructuredError(input);
        expect(result.title.length).toBeGreaterThan(0);
        expect(Array.isArray(result.options)).toBe(true);
      }
    });

    it('toStructuredError carries options through a POJO error', () => {
      const pojo = makeError(ErrorCodes.GE_MERGE_AMBIGUOUS_CONTACT, 'm', true, undefined, {
        title: 't',
        options: [
          {
            id: 'contact-0',
            display: { button_text: 'b', description: 'd', style: 'secondary' },
            call: { tool: 'merge_bodies_with_bend', arguments: { part_a_id: 'a', part_b_id: 'b' } },
          },
        ],
      });
      expect(toStructuredError({ ...pojo })).toEqual(pojo);
    });

    it('option tools named in source are all registered v2 tools', async () => {
      // Every `tool: '...'` inside an ErrorOption call must be callable.
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const src = readFileSync(join(__dirname, '../../src/v2/graph/evaluate-client.ts'), 'utf-8');
      const named = [...src.matchAll(/call: \{\s*tool: '([a-z_]+)'/g)].map((m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      const registered = new Set(graphToolDefinitions.map((t) => t.name));
      for (const tool of named) expect(registered.has(tool!)).toBe(true);
    });
  });
});
