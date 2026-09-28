/**
 * Invariant sweep (spec 010, T016). Opt-in with INVARIANT_SWEEP=1.
 *
 * Tracks every GraphStore the real v2 suites build (by hooking createPart /
 * restorePart / restoreAll on the prototype) and, after every test, runs
 * checkGraphInvariants over every part plus checkStoreInvariants over each
 * store. Any violation fails that test, naming the part and rule — so the
 * structural invariants are proven against every end state the real tools
 * produce, without duplicating the scenarios.
 *
 * Run:  npm run test:invariant-sweep
 */
import { afterEach } from 'vitest';
import { GraphStore } from '../../src/v2/graph/store';
import { checkGraphInvariants, checkStoreInvariants, INVARIANT_EXCEPTIONS } from '../../src/v2/graph/invariants';

if (process.env['INVARIANT_SWEEP'] === '1') {
  const live = new Set<GraphStore>();
  const proto = GraphStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const method of ['createPart', 'restorePart', 'restoreAll']) {
    const original = proto[method]!;
    proto[method] = function (this: GraphStore, ...args: unknown[]) {
      live.add(this);
      return original.apply(this, args);
    };
  }

  const excepted = new Set(INVARIANT_EXCEPTIONS.map((e) => e.code));

  afterEach((ctx) => {
    const problems: string[] = [];
    for (const store of live) {
      const snapshots = store.partIds().map((id) => store.snapshotPart(id));
      for (const s of snapshots) {
        for (const v of checkGraphInvariants(s)) {
          if (!excepted.has(v.code)) problems.push(`${v.code} part=${v.partId} (${s.part.name}): ${v.message}`);
        }
      }
      for (const v of checkStoreInvariants(snapshots)) {
        if (!excepted.has(v.code)) problems.push(`${v.code} part=${v.partId}: ${v.message}`);
      }
    }
    live.clear();
    if (problems.length > 0) {
      throw new Error(`[invariant-sweep] ${ctx.task.name}:\n  ${problems.join('\n  ')}`);
    }
  });
}
