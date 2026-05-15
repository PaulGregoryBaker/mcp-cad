import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ─── Test Projects (maps to TESTING_STRATEGY.md test layers) ──────────
    projects: [
      {
        // Unit tests: validate deterministic local behaviour
        name: 'unit',
        include: [
          'tests/manufacturing.test.ts',
          'tests/mcp.test.ts',
          'tests/rules.test.ts',
          'tests/bom.test.ts',
          'tests/assembly.test.ts',
          'tests/bend_sequence.test.ts',
          'tests/manufacturability.test.ts',
          'tests/export.test.ts',
           'tests/session.test.ts',
           'tests/config-schema.test.ts',
        ],
      },
      {
        // Contract tests: validate interface and error model compatibility
        name: 'contract',
        include: ['tests/contracts/**/*.contract.test.ts'],
      },
      {
        // Integration tests: validate multi-component orchestration flows
        name: 'integration',
        include: ['tests/integration/**/*.integration.test.ts'],
      },
      {
        // E2E tests: validate MVP production path (INF-03 golden path)
        name: 'e2e',
        include: ['tests/e2e/**/*.test.ts'],
        // E2E tests have a longer timeout due to full-stack execution
        testTimeout: 60_000,
      },
    ],

    // ─── Coverage configuration ────────────────────────────────────────────
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'dist/**', 'src/index.ts'],
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
