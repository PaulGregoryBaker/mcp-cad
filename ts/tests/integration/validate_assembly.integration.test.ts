/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, no-console, @typescript-eslint/no-unsafe-call, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'node:path';
import mysql from 'mysql2/promise';
import { dispatchTool, setSemanticStore } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';
import { getFixturePath } from '../helpers/fixtures';
import { initSemanticPersistence, session } from '../../src/geometry/session';
import { transactionRegistry } from '../../src/mcp/transactions';
import { validationEngine } from '../../src/validation/validator';

const SKIP_DOLT = process.env.SKIP_DOLT === '1';
const HOST = process.env.DOLT_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const DATABASE = `validate_assembly_test_${Date.now()}`;

describe('Validate Assembly Integration Tests (Feature 009)', () => {
  const configPath = path.resolve(__dirname, '../../config/config.yaml');
  const config = loadConfig(configPath);
  const simpleBoxPath = getFixturePath('simple_box.stp');

  let adminConn: mysql.Connection | null = null;
  let activePort: any = null;

  beforeAll(async () => {
    if (SKIP_DOLT) return;

    try {
      adminConn = await mysql.createConnection({
        host: HOST,
        port: PORT,
        user: 'root',
        password: '',
      });
      await adminConn.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);

      const { port, store } = await initSemanticPersistence({
        driver: 'dolt',
        host: HOST,
        port: PORT,
        database: DATABASE,
        data_dir: './state/dolt',
      });

      activePort = port;
      setSemanticStore(store);
    } catch (err) {
      console.warn('Dolt database setup failed, running in fallback mode:', err);
    }
  }, 30_000);

  afterAll(async () => {
    if (activePort) {
      await activePort.disconnect();
    }
    if (adminConn) {
      await adminConn.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
      await adminConn.end();
    }
  });

  beforeEach(() => {
    transactionRegistry.reset();
    session.reset();
    validationEngine.reset();
  });

  it('runs validation on clean single-part assembly (passing sheet metal)', async () => {
    // Load box
    const clean = (await dispatchTool(
      'clean_geometry',
      { file_path: simpleBoxPath },
      config,
    )) as any;
    const partId = clean.solid_id;

    // Validate assembly with sheet_metal=false (since box is solid, not thin sheet metal)
    const report = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: [partId],
        sheet_metal_flags: {
          [partId]: false,
        },
      },
      config,
    )) as any;

    expect(report.valid).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.summary.total_parts_checked).toBe(1);
  });

  it('detects sheet metal unfold failure and recommends split_body_by_bends', async () => {
    // Load box (solid box fails sheet metal check)
    const clean = (await dispatchTool(
      'clean_geometry',
      { file_path: simpleBoxPath },
      config,
    )) as any;
    const partId = clean.solid_id;

    // Validate assembly with sheet_metal=true (default)
    const report = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: [partId],
      },
      config,
    )) as any;

    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);

    const unfoldErr = report.errors.find((e: any) => e.category === 'sheet_metal');
    expect(unfoldErr).toBeDefined();
    expect(unfoldErr.severity).toBe('error');
    expect(unfoldErr.autofix).toBeDefined();
    expect(unfoldErr.autofix.tool_name).toBe('split_body_by_bends');
    expect(unfoldErr.autofix.arguments.part_id).toBe(partId);
  });

  it('runs custom registered rules and appends them to the report', async () => {
    // Register mock rule
    const mockRule = {
      name: 'mock_nesting_rule',
      category: 'nesting' as any,
      async validate(context: any) {
        return [
          {
            id: 'err-mock-nesting',
            category: 'nesting' as any,
            severity: 'error' as any,
            message: 'Mock nesting error',
            affected_part_ids: [context.partIds[0] ?? 'part-1'],
          },
        ];
      },
    };

    validationEngine.registerRule(mockRule);

    const report = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: ['dummy-part'],
        sheet_metal_flags: { 'dummy-part': false },
      },
      config,
    )) as any;

    const nestingErrors = report.errors.filter((e: any) => e.category === 'nesting');
    expect(nestingErrors).toHaveLength(1);
    expect(nestingErrors[0].message).toBe('Mock nesting error');
  });

  it('detects clashes, recommends trim, and verifies the autofix resolves it', async () => {
    const tx = (await dispatchTool(
      'begin_transaction',
      { label: 'validation-clash-test' },
      config,
    )) as any;
    const txId = tx.transaction_id;

    // Load simple box
    const cleanA = (await dispatchTool(
      'clean_geometry',
      { file_path: simpleBoxPath },
      config,
    )) as any;
    const boxA = cleanA.solid_id;

    // Translate boxA slightly to create an overlapping boxB
    const trans = (await dispatchTool(
      'translate_body',
      {
        targets: [boxA],
        vector: [5.0, 5.0, 5.0],
        keep_original: true,
        transaction_id: txId,
      },
      config,
    )) as any;
    const boxB = trans.solid_id;

    // Run validation (ignore sheet metal checks since they are solid boxes)
    const reportBefore = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: [boxA, boxB],
        sheet_metal_flags: {
          [boxA]: false,
          [boxB]: false,
        },
      },
      config,
    )) as any;

    console.log('REPORT BEFORE:', JSON.stringify(reportBefore, null, 2));
    expect(reportBefore.valid).toBe(false);
    const clashErr = reportBefore.errors.find((e: any) => e.category === 'clash_detection');
    expect(clashErr).toBeDefined();
    expect(clashErr.autofix).toBeDefined();
    expect(clashErr.autofix.tool_name).toBe('trim_body_with_plane');
    expect(clashErr.autofix.arguments.part_id).toBe(boxB);
    expect(clashErr.autofix.arguments.plane).toBeDefined();

    // Apply the recommended autofix!
    await dispatchTool(
      'trim_body_with_plane',
      {
        part_id: clashErr.autofix.arguments.part_id,
        plane: clashErr.autofix.arguments.plane,
        keep_positive_side: clashErr.autofix.arguments.keep_positive_side,
        transaction_id: txId,
      },
      config,
    );

    // Get the new shell ID of boxB (which is updated/trimmed in-place or replaced)
    // In our engine, trimBodyWithPlane returns a new shell ID
    // Let's verify report is now valid
    const reportAfter = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: [boxA, boxB],
        sheet_metal_flags: {
          [boxA]: false,
          [boxB]: false,
        },
      },
      config,
    )) as any;

    // The clash should now be resolved!
    expect(reportAfter.valid).toBe(true);
    expect(reportAfter.errors.filter((e: any) => e.category === 'clash_detection')).toHaveLength(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });

  it('loads a multi-error assembly, asserts that all error categories are reported, applies recommended autofixes sequentially, and verifies assembly resolves to clean state (T021)', async () => {
    const tx = (await dispatchTool(
      'begin_transaction',
      { label: 'validation-multi-error-test' },
      config,
    )) as any;
    const txId = tx.transaction_id;

    // Load simple box (solid box fails sheet metal check)
    const cleanA = (await dispatchTool(
      'clean_geometry',
      { file_path: simpleBoxPath },
      config,
    )) as any;
    const boxA = cleanA.solid_id;

    // Translate boxA slightly to create an overlapping boxB
    const trans = (await dispatchTool(
      'translate_body',
      {
        targets: [boxA],
        vector: [45.0, 0.0, 0.0],
        keep_original: true,
        transaction_id: txId,
      },
      config,
    )) as any;
    const boxB = trans.solid_id;

    // Run validation (by default, both are flagged as sheet metal, so both unfold check and clash check run)
    const reportBefore = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: [boxA, boxB],
      },
      config,
    )) as any;

    expect(reportBefore.valid).toBe(false);

    // Verify both categories of errors are present
    const unfoldErrors = reportBefore.errors.filter((e: any) => e.category === 'sheet_metal');
    const clashErrors = reportBefore.errors.filter((e: any) => e.category === 'clash_detection');

    expect(unfoldErrors.length).toBeGreaterThanOrEqual(1);
    expect(clashErrors.length).toBeGreaterThanOrEqual(1);

    // Apply clash autofix: trim_body_with_plane
    const clashErr = clashErrors[0];
    expect(clashErr.autofix).toBeDefined();
    expect(clashErr.autofix.tool_name).toBe('trim_body_with_plane');

    await dispatchTool(
      'trim_body_with_plane',
      {
        part_id: clashErr.autofix.arguments.part_id,
        plane: clashErr.autofix.arguments.plane,
        keep_positive_side: clashErr.autofix.arguments.keep_positive_side,
        transaction_id: txId,
      },
      config,
    );

    // Now apply unfold autofixes: split_body_by_bends on all reported unfold errors
    const generatedPanels: string[] = [];
    for (const unfoldErr of unfoldErrors) {
      expect(unfoldErr.autofix).toBeDefined();
      expect(unfoldErr.autofix.tool_name).toBe('split_body_by_bends');

      const splitResult = (await dispatchTool(
        'split_body_by_bends',
        {
          part_id: unfoldErr.autofix.arguments.part_id,
          max_thickness_mm: unfoldErr.autofix.arguments.max_thickness_mm,
          default_thickness_mm: unfoldErr.autofix.arguments.default_thickness_mm,
          max_recursion_depth: unfoldErr.autofix.arguments.max_recursion_depth,
          transaction_id: txId,
        },
        config,
      )) as any;

      generatedPanels.push(...splitResult.panel_ids);
    }

    // Now validate the newly generated panels. They should be clean!
    expect(generatedPanels.length).toBeGreaterThan(0);

    const reportAfter = (await dispatchTool(
      'validate_assembly',
      {
        part_ids: generatedPanels,
      },
      config,
    )) as any;

    console.log('REPORT AFTER:', JSON.stringify(reportAfter, null, 2));
    expect(reportAfter.valid).toBe(true);
    expect(reportAfter.errors).toHaveLength(0);

    await dispatchTool('commit_transaction', { transaction_id: txId }, config);
  });
});
