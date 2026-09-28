import { defineConfig } from 'vitest/config';

// NOTE: Multi-project test layers (unit/contract/v2) are defined in
// vitest.workspace.ts via defineWorkspace(), not here. vitest@1.6.1 (the version
// pinned in package.json/installed in node_modules) has no `test.projects` config
// key — that API was added in a later Vitest major version. Each workspace entry
// `extends` this file for the shared settings below (coverage/reporters/globals/alias).
export default defineConfig({
  test: {
    // ─── Coverage configuration ────────────────────────────────────────────
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'dist/**'],
      thresholds: {
        global: {
          lines: 85,
          functions: 85,
          branches: 80,
          statements: 85,
        },
      },
    },

    // ─── Reporters ─────────────────────────────────────────────────────────
    reporters: ['verbose', 'junit'],
    outputFile: {
      junit: '../docs/test-reports/vitest_results.xml',
    },

    // ─── Global settings ───────────────────────────────────────────────────
    globals: true,
    environment: 'node',
    testTimeout: 30_000,

    // ─── Path aliases ──────────────────────────────────────────────────────
    alias: {
      '@': '/src',
    },
  },
});
