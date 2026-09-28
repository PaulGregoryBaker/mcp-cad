/**
 * Live-app regression (2026-09-27): merge_bodies_with_bend commits a merge
 * whose resulting part can't be constructed — the client's graph_mesh then
 * fails with GE_BRIDGE_EDGE_NOT_FOUND ("no zone-boundary edge tagged for bend
 * X on region panel Y") and the merged part never appears in the 3D viewer.
 *
 * Invariant under test: a merge that COMMITS must yield a part that
 * constructPart accepts. A merge that can't produce one must be rejected with
 * a typed error instead (same discipline as split_part_at_bend's
 * GE_SPLIT_RESULT_NOT_CONSTRUCTIBLE safety net).
 *
 * Sweep: every ordered pair of cauldron.step's top-level components, every
 * contact seam merge_bodies_with_bend offers for that pair (its
 * GE_MERGE_AMBIGUOUS_CONTACT options, run verbatim). At the time of writing,
 * on C1+C2 / C2+C1, 19 of 20 committed merges fail to construct:
 *   - GE_BRIDGE_EDGE_NOT_FOUND (7) — often a PRE-EXISTING bend of A or B,
 *     not the new seam bend: the merge loses that bend's wallEdgeBendId tag.
 *   - GE_CONSTRUCTION_FAILED (12) — "validated contact fuse failed ...
 *     (invalid boolean topology)" / "union volume decreased".
 * Merges rejected up front (GE_MERGE_SELF_INTERSECTION etc.) are fine here.
 *
 * Fixed in the evaluator, not in the merge (both are pinned by C++
 * regressions in cpp/tests/part_solid_construction_test.cc):
 *   - BuildCutEdges wasn't root-invariant at a ring vertex shared by 3+
 *     bends, and merge reroots B at its contact panel.
 *   - Hinge endpoints within epsilon of a ring vertex were cut at the vertex
 *     but folded about the raw coordinate (cauldron C2's import is 1.86e-7mm
 *     off).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart } from '../../src/v2/graph/evaluate-client';
import { toStructuredError } from '../../src/mcp/errors';

const ENABLED = process.env.SUITE_V2_DRIVER === '1';
const d = ENABLED ? describe : describe.skip;

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'cpp', 'tests', 'fixtures');

interface Failure {
  pair: string;
  seam: number;
  code: string;
  message: string;
  args: Record<string, unknown>;
}

/** Every merge_bodies_with_bend call to try for (a, b): the single call when
 * there's one contact, else every option of the ambiguity error. Empty when
 * the pair doesn't touch or the merge is rejected outright. */
function mergeCallsFor(store: GraphStore, a: string, b: string): Record<string, unknown>[] {
  const base = store.snapshotAll();
  const args = { part_a_id: a, part_b_id: b, radius_mm: 3, k_factor: 0.42 };
  try {
    dispatchGraphTool(store, 'merge_bodies_with_bend', args);
    return [args];
  } catch (err) {
    const s = toStructuredError(err);
    return s.code === 'GE_MERGE_AMBIGUOUS_CONTACT' ? s.options.map((o) => o.call.arguments) : [];
  } finally {
    store.restoreAll(base);
  }
}

d('[v2] merge_bodies_with_bend never commits a non-constructible part (cauldron.step)', () => {
  it('every committed merge, along every offered seam, constructs', () => {
    const store = new GraphStore();
    const imported = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES, 'cauldron.step'),
      profile: { rules: { default_bend_radius_mm: 3 } },
    }) as { part_id: string; component_part_ids: string[] };
    const ids = [imported.part_id, ...imported.component_part_ids];
    const pristine = store.snapshotAll();

    const failures: Failure[] = [];
    let committed = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const calls = mergeCallsFor(store, ids[i]!, ids[j]!);
        for (const [seam, args] of calls.entries()) {
          store.restoreAll(pristine);
          try {
            dispatchGraphTool(store, 'merge_bodies_with_bend', args);
          } catch {
            continue; // rejected up front with a typed error — acceptable
          }
          committed++;
          try {
            constructPart(store, ids[i]!);
          } catch (err) {
            const s = toStructuredError(err);
            failures.push({ pair: `C${i}+C${j}`, seam, code: s.code, message: s.message, args });
          }
        }
      }
    }
    store.restoreAll(pristine);

    expect(committed, 'sweep should exercise at least one committed merge').toBeGreaterThan(0);
    const report = failures
      .map((f) => `${f.pair} seam ${f.seam}: ${f.code} — ${f.message}\n    args: ${JSON.stringify(f.args)}`)
      .join('\n');
    expect(failures, `${failures.length}/${committed} committed merges don't construct:\n${report}`).toEqual([]);
  }, 600_000);
});
