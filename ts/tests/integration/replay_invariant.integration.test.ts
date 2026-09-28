/**
 * v2 replay-invariant suite (Phase 5 Slice 1, rebuild/14 §6) — runs every
 * registered ts/tests/harness/replay-invariant.ts scenario and asserts
 * replay(graph) === current geometry for each.
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_SCENARIOS, runReplayInvariantCheck } from '../harness/replay-invariant';

describe('v2 graph replay invariant', () => {
  for (const scenario of REPLAY_SCENARIOS) {
    it(`${scenario.name}: replay(graph) === current geometry`, () => {
      const result = runReplayInvariantCheck(scenario);
      expect(result.mismatches, result.mismatches.join('; ')).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
