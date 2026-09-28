# Bug Report: `import_part` refuses `testcube.step` with `GE_DISCONNECTED_PIECES`

> **✅ FIXED 2026-07-30, commit `4f89251` ("ReconcilePieces handles disconnected components
> gracefully").** Confirms hypothesis 2 below was the right read: piece 6/8 were a real,
> separate connected component (not a matching bug) — the fix now returns each disconnected
> component as its own standalone `PartGraphSpec` (`result.graphs`) instead of hard-failing.
> That fix introduced a follow-on regression in a downstream validation loop that wasn't
> updated to match — see
> [BUG_REPORT_import_part_evaluate_missing_disconnected_panel.md](./BUG_REPORT_import_part_evaluate_missing_disconnected_panel.md).

**Status:** Fixed (see follow-on report above)
**Date:** 2026-07-30
**Component:** v2 panel reconciliation (`cpp/src/geometry/translation/step_reconciliation.cc`,
`ReconcilePieces`)
**Severity:** High (blocks `import_part` — and therefore Form.AI.tion's "open project" flow —
entirely for this fixture)
**Reported during:** Form.AI.tion UI session, loading `testcube.step` via the newly-ported
`loadAssembly()` → `import_part` path.

---

## Summary

`import_part("testcube.step")` fails with `GE_DISCONNECTED_PIECES`:

```
piece 6 shares no measured edge with the rest (closest candidate: piece 8 edge 1 vs this
piece's edge 3, combined endpoint gap 0.000000mm)
```

This is a **pre-existing, already-known issue** — `rebuild/06-plan.md`'s Slice 6 note
(2026-07-25) explicitly flags that `testcube.step` "independently refuses `import_part`'s
main-panel reconciliation with `GE_DISCONNECTED_PIECES` for an unrelated, pre-existing reason,"
which is why that slice's `remove_protrusions`-extraction tests were written against
`splitBodyByBends` output directly instead of a full `import_part` call. This report is the
first full root-cause dig into *why*, since it now blocks a real UI flow (not just a test
fixture choice).

**The reported gap (0.000000mm) is suspicious on its face**: it's well inside the 2.0mm match
tolerance (`kPieceEdgeMatchToleranceMm`, line 25) used by the *same* distance formula the
matching pass itself uses. See "Analysis" below — this doesn't necessarily mean the matching
check itself is buggy (there's a coherent alternate explanation), but it does mean "piece 6 is
disconnected from *everything*" is not quite the right way to read the message.

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
  console.log(err.structured.code, err.structured.message);
}
```

Run from `ts/` via `npx ts-node <script>.ts`. Output (verified 2026-07-30):

```
GE_DISCONNECTED_PIECES
piece 6 shares no measured edge with the rest (closest candidate: piece 8 edge 1 vs this
piece's edge 3, combined endpoint gap 0.000000mm)
```

Also reproducible one level down, without `reconcilePieces`, using the standalone
`split_body_by_bends` tool + `geometryBinding.getPanelFrame` directly (useful for inspecting
the panel geometry without triggering the reconciliation failure):

```typescript
import { geometryBinding } from './src/geometry/binding';
const solidId = geometryBinding.loadStep(fixturePath);
geometryBinding.healGeometryEx(solidId, true, true);
const split = geometryBinding.splitBodyByBends(solidId, 35);
// split.panel_ids.length === 12, split.protrusion_ids.length === 4
const frame6 = geometryBinding.getPanelFrame(split.panel_ids[6]);
const frame8 = geometryBinding.getPanelFrame(split.panel_ids[8]);
```

---

## Geometry Data (from the standalone repro above)

`testcube.step` decomposes into **12 panels + 4 protrusions**.

**Piece 6** — simple rectangle, normal `(0, 1, 0)`, origin `(75, 75, 75)`:
```
ring: [(0,0), (150,0), (150,73.95), (0,73.95)]   // 4 vertices
```
Edge 3 (the reported edge) connects `(0,73.95) → (0,0)`, length 73.95mm.

**Piece 8** — complex 20-vertex polygon (small ~1.1mm notches at the four corners/edge
midpoints, consistent with protrusion-cutout carving), normal `(0, 0, 1)`, origin
`(75, 75, 75)`:
```
ring: [(0.05,73.95), (0,73.95), (0,0), (73.95,0), (73.95,0.05), (75.05,0.05), (75.05,0),
       (150,0), (150,73.95), (149.95,73.95), (149.95,75.05), (150,75.05), (150,150),
       (75.05,150), (75.05,149.95), (73.95,149.95), (73.95,150), (0,150), (0,75.05),
       (0.05,75.05)]   // 20 vertices
```
Edge 1 (the reported edge) connects `(0,73.95) → (0,0)`, length 73.95mm — same length, same
local coordinates as piece 6's edge 3.

Both pieces share the exact same frame origin `(75, 75, 75)` but perpendicular normals —
consistent with two adjacent faces of a cube meeting along a real physical edge.

---

## Analysis

`ReconcilePieces` builds pairwise adjacency (`step_reconciliation.cc:222-241`) using:
```cpp
double d = Length3(Sub3(a0, b1)) + Length3(Sub3(a1, b0));
// edge accepted iff NearlyEqual3(a0,b1,2.0) && NearlyEqual3(a1,b0,2.0)
// i.e. iff each term individually <= 2.0mm
```
then does a plain BFS spanning tree from a root piece (`:246-296`) over the accepted edges,
and reports `GE_DISCONNECTED_PIECES` for the first piece left unvisited (`:300-329`), using a
**second, independent** closest-pair scan (`:302-322`) that uses the *identical* distance
formula and is not restricted to already-visited pieces — that's what produces the "closest
candidate" hint in the error message.

Since the reported combined gap is ~0mm (both non-negative terms, sum≈0 ⇒ each term≈0), the
piece-6/piece-8 pair, at (edge 3, edge 1), numerically satisfies the 2.0mm acceptance threshold
using the exact same formula the acceptance check uses. Two ways to read that:

1. **A real bug in edge detection or the BFS reachability check** — piece 6 and piece 8 should
   have been linked in `edges`/`adjList` but weren't (or were, but something else prevents BFS
   from reaching them).
2. **No bug in the matching itself — piece 6 and piece 8 form their own valid, tightly-matched
   pair, but that {6, 8} pair is a genuinely separate connected component from the piece
   BFS started at (`rootIndex`)** — i.e. the *real* problem is elsewhere: whatever edge should
   connect {6, 8} to the rest of the cube's panel network is the one that's actually
   missing/failing to match, and the error message's "closest candidate" search (which isn't
   BFS-component-aware) reports the nearest neighbor it can find for piece 6 specifically
   (piece 8), which happens to be a real match to a piece that is *itself* also disconnected
   from the root — not the piece that piece 6 actually needs to connect to the main body.

**I did not distinguish between these two with certainty** — that requires either adding
temporary logging inside `ReconcilePieces` (print `edges.size()`, `adjList[6]`, `adjList[8]`,
and which pieces end up `visited` vs not) or re-implementing `BuildPieceFrame`'s exact 3D
transform outside the kernel to independently check every pairwise edge distance for all 12
panels. Given hypothesis 2 is geometrically coherent and the acceptance-formula math is
otherwise sound, **hypothesis 2 (real graph disconnect between two valid sub-components,
likely caused by the 4 protrusion cutouts altering panel 8's boundary near a *different* edge
that should bridge to the rest of the cube) is the more likely starting point** — but this
needs confirming with actual instrumentation, not further static reading.

---

## Suggested Next Step (diagnostic, not a fix)

Add temporary logging in `ReconcilePieces` (`step_reconciliation.cc`, right after the `edges`
loop, before BFS) printing `n`, `edges.size()`, and for every piece index its `adjList[i]`
size — then re-run the repro above. This will show directly whether piece 6/8 are isolated as a
pair (hypothesis 2 — look for which *other* edges, if any, piece 8's 20-vertex boundary should
be matching against, likely disrupted by the 4 nearby protrusion notches) or truly edgeless
(hypothesis 1 — a real matching/BFS bug).

---

## Impact

- `import_part` cannot ingest `testcube.step` at all — total failure, not a degraded result.
- Blocks Form.AI.tion's `loadAssembly` for this fixture (see
  `docs/V1_DECOMMISSION_CHECKLIST.md` on the Form.AI.tion side — `loadAssembly` was just ported
  to `import_part` and surfaces this error verbatim as a "Pipeline failed" card).
- Was already a known gap for the Slice 6 test suite (worked around there); now a live-app
  blocker.

---

## Links

- `ReconcilePieces`: `cpp/src/geometry/translation/step_reconciliation.cc:173` (function start),
  `:222-241` (edge detection), `:246-296` (BFS), `:300-329` (disconnected-piece error)
- Match tolerance: `step_reconciliation.cc:25` (`kPieceEdgeMatchToleranceMm = 2.0`)
- `NearlyEqual3`: `step_reconciliation.cc:51`
- Caller: `ts/src/v2/graph/evaluate-client.ts:477-580` (`importPart`)
- Prior acknowledgment: `rebuild/06-plan.md`, Slice 6 section (2026-07-25)
- Fixture: `cpp/tests/fixtures/testcube.step`
