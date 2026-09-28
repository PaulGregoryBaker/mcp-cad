# Bug Report: `ReconcilePieces`'s post-build validation loop wasn't updated for disconnected-component support

**Status:** Fixed — commit `09fb9fb` ("reconcilePieces — disconnected components +
largest-component root selection"), same day as this report. Verified still present and
correct as of 2026-08-05 (`step_reconciliation.cc`'s Evaluate()-replay validation loop guards
on `bfsOrder`, a component-local piece list, so unvisited/disconnected pieces are never
checked against the main graph's layout). Status line was never updated when the fix landed —
corrected retroactively.
**Date:** 2026-07-30
**Component:** `cpp/src/geometry/translation/step_reconciliation.cc`, `ReconcilePieces`
(the `Evaluate()`-replay validation loop, step 7)
**Severity:** High (blocks `import_part` for `testcube.step`, same user-visible impact as the
bug this follows on from)
**Follow-on to:** [BUG_REPORT_import_part_testcube_disconnected_pieces.md](./BUG_REPORT_import_part_testcube_disconnected_pieces.md)
(fixed by commit `4f89251`) — this is a regression introduced by that fix, not a new
independent issue.

---

## Summary

`import_part("testcube.step")` now fails one step later than before:

```
GE_DOWNSTREAM_POSE_MISMATCH
Evaluate() produced no region panel for piece 6
```

Commit `4f89251` correctly changed `ReconcilePieces` to divert disconnected pieces (piece 6, in
this fixture) out of the main `graph` and into their own standalone `PartGraphSpec` entries in
`result.graphs`, instead of hard-failing with `GE_DISCONNECTED_PIECES`. But the function's own
downstream self-check — replaying `graph` through `Evaluate()` and confirming every original
piece index appears in the result — was not updated to skip the pieces that are now
*deliberately* excluded from `graph`. It still iterates all `n` original pieces unconditionally,
so it "discovers" that piece 6 is missing from `graph`'s evaluated layout — which is now
expected and correct, not a defect — and reports it as a pose-mismatch failure.

---

## Root Cause (confirmed by reading, not hypothesis)

`step_reconciliation.cc`, two loops over the same `n` (total original piece count):

**Loop A — lines 300-317 (the `4f89251` fix, correct):**
```cpp
for (size_t i = 0; i < n; ++i) {
  if (!visited[i]) {
    // ... build soloGraph, push to result.graphs ...
    // piece i is now NOT part of `graph` — by design.
  }
}
```

**Loop B — lines 568-580 (unchanged since before the fix — the bug):**
```cpp
EvaluateResult layout = Evaluate(graph);
// ...
for (size_t i = 0; i < n; ++i) {
  const RegionPanelLayout* panel = nullptr;
  for (const auto& p : layout.panels) {
    if (p.regionPanelId == "piece" + std::to_string(i)) { panel = &p; break; }
  }
  if (panel == nullptr) {
    result.errorCode = ReconcileErrorCode::kDownstreamPoseMismatch;
    result.message = "Evaluate() produced no region panel for piece " + std::to_string(i);
    return result;   // ← fires for i=6, which Loop A correctly never added to `graph`
  }
  // ...
}
```

Loop B has no `visited[i]` guard, so for `i=6` (excluded from `graph` by Loop A) it can never
find `"piece6"` in `layout.panels` (`layout` is `Evaluate(graph)`, and `graph` never contained
piece 6) — this is now the *expected* state after `4f89251`, not an error condition.

---

## Reproduction

```typescript
import { GraphStore } from './src/v2/graph/store';
import { dispatchGraphTool } from './src/v2/tools/graph';
import * as path from 'node:path';

const store = new GraphStore();
const fixture = path.resolve(__dirname, '../cpp/tests/fixtures/testcube.step');
try {
  dispatchGraphTool(store, 'import_part', { file: fixture });
} catch (err: any) {
  console.log(err.structured.code, '-', err.structured.message);
}
```

Output (verified 2026-07-30, against the current build):
```
GE_DOWNSTREAM_POSE_MISMATCH - Evaluate() produced no region panel for piece 6
```

---

## Proposed Fix

Add the same guard Loop A uses, to the top of Loop B:

```cpp
for (size_t i = 0; i < n; ++i) {
  if (!visited[i]) continue;  // disconnected — already handled as its own solo graph above
  const RegionPanelLayout* panel = nullptr;
  // ... unchanged ...
}
```

This is a one-line, low-risk fix — it doesn't change behavior for any fully-connected fixture
(where every `i` is `visited`), only skips the now-intentionally-excluded pieces for fixtures
like `testcube.step` that have real disconnected components.

**Worth double-checking while in there:** the inner round-trip check (`flattenedRing[i]`,
lines 580-590) is reached only for visited pieces after this fix too, and `flattenedRing` is
sized `n` but (per Loop A) only populated for `visited` pieces during step 5 — so it should
already be safe, but confirm `flattenedRing[i]` isn't accessed anywhere else unguarded for
disconnected `i`.

---

## Impact

- Still fully blocks `import_part("testcube.step")` — same practical impact as the bug this
  follows on from, just one step further into the function.
- Blocks Form.AI.tion's `loadAssembly` for this fixture, same as before.

---

## Links

- Loop A (the `4f89251` fix): `step_reconciliation.cc:300-317`
- Loop B (needs the same guard): `step_reconciliation.cc:568-580`
- Prior report / fix commit: `4f89251` ("ReconcilePieces handles disconnected components
  gracefully")
- Fixture: `cpp/tests/fixtures/testcube.step`
