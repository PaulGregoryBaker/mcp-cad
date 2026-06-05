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
          'tests/dxf_orientation.test.ts',
          'tests/dxf_merge.unit.test.ts',
          'tests/dxf_panel_frame_bbox.test.ts',
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
        // Integration tests: validate multi-component orchestration flows.
        // pool:'forks' + singleFork:true runs all integration files sequentially
        // in ONE forked child process. The C++ addon's g_service singleton is
        // process-scoped and accumulates state (shells, snapshots) across calls;
        // running files in parallel forks gives JS isolation but not native
        // isolation, which caused intermittent GE_SHELL_NOT_FOUND failures when
        // one test's clearSnapshots/restoreSnapshot wiped state mid-run for a
        // sibling. Sequential execution removes that interference at the cost
        // of run time — acceptable trade-off until we add a native reset API.
        // 4 GB heap: OCCT boolean ops on multi-shell STEP files accumulate native
        // memory across the full sequential run; without this the fork OOMs and
        // the C++ unordered_map for shells can be left in a partial-insert state,
        // causing GE_SHELL_NOT_FOUND on subsequently-allocated shell IDs.
        name: 'integration',
        include: ['tests/integration/**/*.integration.test.ts'],
        pool: 'forks',
        poolOptions: {
          forks: {
            singleFork: true,
            execArgv: ['--max-old-space-size=4096'],
          },
        },
      },
      {
        // E2E tests: validate MVP production path (INF-03 golden path)
        name: 'e2e',
        include: ['tests/e2e/integration_e2e.test.ts'],
        // Standard STEP flows remain aligned with SC-005 (30s)
        testTimeout: 30_000,
      },
      {
        // Post-MVP Tier 3 stress scenario (Braai STL)
        name: 'e2e-braai',
        include: ['tests/e2e/**/braai-assembly.e2e.test.ts'],
        testTimeout: 120_000,
      },
      {
        // Contract-gap regression: decompose_volume must return parts[].mesh_url.
        // These tests are expected to FAIL until handleDecomposeVolume is updated.
        // Run with: npx vitest run --project e2e-mesh-url-contract
        name: 'e2e-mesh-url-contract',
        include: ['tests/e2e/mesh-url-contract.e2e.test.ts'],
        testTimeout: 30_000,
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
