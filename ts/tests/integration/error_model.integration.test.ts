import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

describe('Error Model Compliance', () => {
    it('returns structured error output for invalid inputs', async () => {
        const configPath = path.resolve(__dirname, '../../config/config.yaml');
        const config = loadConfig(configPath);

        // Debug: Start test
        // eslint-disable-next-line no-console
//      console.log('[ErrorModelTest] Starting invalid input error checks');

        try {
            // eslint-disable-next-line no-console
   //       console.log('[ErrorModelTest] Testing clean_geometry with invalid file');
            await dispatchTool('clean_geometry', { file_path: 'DOES_NOT_EXIST.step' }, config);
            expect.fail('Should have failed');
        } catch(err: any) {
            // eslint-disable-next-line no-console
  //        console.log('[ErrorModelTest] clean_geometry error:', err);
            expect(err.code).toBeDefined();
            expect(err.message).toBeDefined();
            expect(typeof err.recoverable).toBe('boolean');
        }

        try {
            // eslint-disable-next-line no-console
    //      console.log('[ErrorModelTest] Testing decompose_volume with fake solid_id');
            await dispatchTool('decompose_volume', { solid_id: 'FAKE_ID', strategy: 'Integrity' }, config);
            expect.fail('Should have failed');
        } catch(err: any) {
            // eslint-disable-next-line no-console
  //          console.log('[ErrorModelTest] decompose_volume error:', err);
            expect(err.code).toBeDefined();
            expect(err.message).toBeDefined();
            expect(typeof err.recoverable).toBe('boolean');
            expect(err.code).toBe('GE_SOLID_NOT_FOUND');
        }

        // Debug: End test
        // eslint-disable-next-line no-console
 //     console.log('[ErrorModelTest] Completed error checks');
    }, 20000); // 20s timeout
});
