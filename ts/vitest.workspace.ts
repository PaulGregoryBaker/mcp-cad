import { defineWorkspace } from 'vitest/config';

// ─── Test Projects (maps to TESTING_STRATEGY.md test layers) ────────────────
// vitest@1.6.1 requires multi-project setups to live in a workspace file
// (defineWorkspace), not inline `test.projects` (that key is a later-Vitest
// addition). Each entry extends vitest.config.ts for shared settings
// (coverage/reporters/globals/alias) and overrides only what differs per layer.
export default defineWorkspace([
  {
    // Unit tests: validate deterministic local behaviour
    extends: './vitest.config.ts',
    test: {
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
        'tests/unit/fuse_preflight.unit.test.ts',
        'tests/unit/flat-pattern-projection.test.ts',
        'tests/unit/merge_4point_mapping.test.ts',
        'tests/unit/coordinate-map.unit.test.ts',
        'tests/unit/dxf_validation.test.ts',
        'tests/manufacturing/graph/bootstrap.test.ts',
        'tests/manufacturing/graph/graph.test.ts',
        'tests/manufacturing/graph/solver.test.ts',
        'tests/manufacturing/graph/foldability.test.ts',
        'tests/manufacturing/graph/drc.test.ts',
      ],
    },
  },
  {
    // Contract tests: validate interface and error model compatibility
    extends: './vitest.config.ts',
    test: {
      name: 'contract',
      include: ['tests/contracts/**/*.contract.test.ts'],
    },
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
    // NOTE: glob covers ALL *.test.ts files in the integration folder so that
    // files with non-.integration. suffixes (e.g. .functional., -workflow, etc.)
    // also receive singleFork isolation and don't suffer C++ shared-state failures.
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      setupFiles: ['tests/setup/integration-reset.ts'],
      // Switched from pool:'forks' (singleFork) to pool:'threads' because
      // merge_asymmetric_flat causes a hard worker crash in forked processes.
      // The C++ addon's g_service singleton is process-scoped; threads share
      // the same main process, avoiding the fork crash. Some tests may fail
      // with GE_SHELL_NOT_FOUND due to shared state — the integration-reset
      // setup file calls clearState() between files to mitigate this.
      pool: 'threads',
    },
  },
  {
    // E2E tests: validate MVP production path (INF-03 golden path)
    extends: './vitest.config.ts',
    test: {
      name: 'e2e',
      include: ['tests/e2e/integration_e2e.test.ts'],
      setupFiles: ['tests/setup/integration-reset.ts'],
      // Standard STEP flows remain aligned with SC-005 (30s)
      testTimeout: 30_000,
    },
  },
  {
    // Post-MVP Tier 3 stress scenario (Braai STL)
    extends: './vitest.config.ts',
    test: {
      name: 'e2e-braai',
      include: ['tests/e2e/**/braai-assembly.e2e.test.ts'],
      setupFiles: ['tests/setup/integration-reset.ts'],
      testTimeout: 120_000,
    },
  },
  {
    // Contract-gap regression: decompose_volume must return parts[].mesh_url.
    // These tests are expected to FAIL until handleDecomposeVolume is updated.
    // Run with: npx vitest run --project e2e-mesh-url-contract
    extends: './vitest.config.ts',
    test: {
      name: 'e2e-mesh-url-contract',
      include: ['tests/e2e/mesh-url-contract.e2e.test.ts'],
      setupFiles: ['tests/setup/integration-reset.ts'],
      testTimeout: 30_000,
    },
  },
]);
