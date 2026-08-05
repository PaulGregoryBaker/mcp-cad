import { defineWorkspace } from 'vitest/config';

// ─── Test Projects (maps to TESTING_STRATEGY.md test layers) ────────────────
// vitest@1.6.1 requires multi-project setups to live in a workspace file
// (defineWorkspace), not inline `test.projects` (that key is a later-Vitest
// addition). Each entry extends vitest.config.ts for shared settings
// (coverage/reporters/globals/alias) and overrides only what differs per layer.
export default defineWorkspace([
  {
    // Unit tests: validate deterministic local behaviour. Only shared-infra
    // survivors remain here post-v1-removal (v2's own units live under the
    // 'v2' project below).
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['tests/unit/merge_4point_mapping.test.ts', 'tests/unit/v2_blob_cache.unit.test.ts'],
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
    // v2 (Phase 5, rebuild/06-plan.md) integration tests: the graph-driven
    // GraphStore/evaluate-client/v2-tools path. v1 has been removed; this is
    // now the only integration-style test project.
    // SUITE_V2_DRIVER=1 injected here (rather than required on the command
    // line) so `npx vitest run --project v2` is self-contained.
    extends: './vitest.config.ts',
    test: {
      name: 'v2',
      include: [
        'tests/integration/suite_driver_v2.integration.test.ts',
        'tests/integration/suite_driver_v2_nets.integration.test.ts',
        'tests/integration/suite_driver_v2_import.integration.test.ts',
        'tests/integration/import_part_fixtures.integration.test.ts',
        'tests/integration/merge_bodies_with_bend.integration.test.ts',
        'tests/integration/point_mapping_roundtrip.integration.test.ts',
        'tests/integration/replay_invariant.integration.test.ts',
        'tests/integration/cauldron_adjacent_pairs.integration.test.ts',
        'tests/integration/fuse_bodies.integration.test.ts',
        'tests/integration/flat_pattern.integration.test.ts',
        'tests/integration/graph_crud.integration.test.ts',
        'tests/integration/cut_panel.integration.test.ts',
        'tests/integration/unequal_leg_bracket_merge_orientation.integration.test.ts',
        'tests/integration/fuse_bodies_onto_bend_merged_part.integration.test.ts',
        'tests/integration/merge_partial_seam_tab_bracket.integration.test.ts',
        'tests/integration/parts_list.integration.test.ts',
        'tests/integration/full_resource.integration.test.ts',
        'tests/integration/boundary_resource.integration.test.ts',
        'tests/integration/mesh_resource.integration.test.ts',
        'tests/integration/mesh_subscription.integration.test.ts',
        'tests/integration/findings_resource.integration.test.ts',
        'tests/integration/slice_9b_tools.integration.test.ts',
        'tests/integration/slice_10_dolt_persistence.integration.test.ts',
        'tests/integration/slice_11_async_jobs.integration.test.ts',
        'tests/integration/import_fixture_validation.integration.test.ts',
      ],
      env: { SUITE_V2_DRIVER: '1' },
      setupFiles: ['tests/setup/integration-reset.ts'],
      // Sequential, non-interleaved file execution: the C++ addon's
      // g_service singleton is process-scoped and accumulates state (shells,
      // snapshots) across calls, so concurrent files interleaving mid-test
      // produces spurious GE_SHELL_NOT_FOUND failures.
      //
      // pool:'forks' (not 'threads'): with 'threads', the full sequential
      // run's vitest/node process never exited on its own — it printed a
      // complete, correct pass/fail summary (confirmed via
      // why-is-node-running: zero JS-side handles, timers, or promises left
      // open at that point) but then hung indefinitely until force-killed.
      // Root cause not fully pinned down (native, not JS — most likely
      // geometry_binding.cc's static `g_service` singleton, holding a large
      // accumulated OCCT shape graph, running a very slow destructor during
      // worker-thread teardown, invisible to JS-level handle introspection),
      // but switching to 'forks' — where the OS reclaims the whole process's
      // memory unconditionally on exit rather than waiting on a graceful
      // native destructor — reproducibly fixes it.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
