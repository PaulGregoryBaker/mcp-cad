import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dispatchTool } from '../../src/mcp/tools';
import { loadConfig } from '../../src/config/loader';

describe('Error Model Compliance', () => {
    it('returns structured error output for invalid inputs', async () => {
        const configPath = path.resolve(__dirname, '../../config/config.yaml');
        const config = loadConfig(configPath);
        
        try {
            await dispatchTool('clean_geometry', { file_path: 'DOES_NOT_EXIST.step' }, config);
            expect.fail('Should have failed');
        } catch(err: any) {
            expect(err.code).toBeDefined();
            expect(err.message).toBeDefined();
            expect(typeof err.recoverable).toBe('boolean');
        }

        try {
            await dispatchTool('decompose_volume', { solid_id: 'FAKE_ID', strategy: 'Integrity' }, config);
            expect.fail('Should have failed');
        } catch(err: any) {
            expect(err.code).toBeDefined();
            expect(err.message).toBeDefined();
            expect(typeof err.recoverable).toBe('boolean');
            expect(err.code).toBe('GE_SOLID_NOT_FOUND');
        }
        
    });
});
