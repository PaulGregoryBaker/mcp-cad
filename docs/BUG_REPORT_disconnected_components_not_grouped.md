# Bug Report: disconnected import pieces are emitted as N independent singleton parts instead of grouping mutually-connected leftovers together

**Status:** Ready for triage — root cause pinpointed to an exact, already-computed-but-discarded
value
**Date:** 2026-07-31
**Component:** `cpp/src/geometry/translation/step_reconciliation.cc`, `ReconcilePieces` — the
disconnected-piece emission loop. **This is a C++-layer fix** — the grouping data already
exists inside `ReconcilePieces` itself; nothing here should be patched from the TS side
(`evaluate-client.ts`/`importPart`) post-hoc. Same principle already established for this
module: geometric/structural computation stays in C++ (see `fuseBodies`'s own doc comment,
"constitution v2.0.0 principle IV — no geometric computation in TypeScript").
**Severity:** Medium (not a correctness bug — every produced part is valid — but works against
the stated goal of minimizing part count after import; likely inflates part counts on most
non-trivial real imports)
**Reported by:** Paul — expected behavior is "as few disconnected parts as possible" after
import; pieces that can't join the main part but *can* join each other should still be combined.

---

## Summary

`ReconcilePieces` already computes full connected-component groupings among the pieces that
don't reach the root — it does this today specifically to decide whether a *different* single
component should become the main graph (commit `09fb9fb`, "largest-component root selection").
But once that swap decision is made, the grouping result is thrown away: the final emission
loop treats every remaining unvisited piece as its own independent one-piece part, instead of
emitting one part **per remaining connected component**.

Concretely: if pieces 6 and 8 share a real, measured edge with each other (they do — see
"Confirmed adjacency" below) but neither connects to the root component, today's code returns
**two** standalone one-piece parts (component piece 6, component piece 8) instead of **one**
two-piece part (6+8, joined by a bend) — exactly the "parts that could be combined stay
combined" behavior already applied to the root, just not applied a second time to the leftovers.

---

## Root Cause — exact location, already-computed value

`step_reconciliation.cc`, inside the post-BFS block added by commit `09fb9fb`:

```cpp
// Find connected components among unvisited pieces via BFS.
std::vector<bool> unvisitedSeen(n, false);
std::vector<std::vector<size_t>> unvisitedComponents;   // ← THIS is the grouping we need
for (size_t start = 0; start < n; ++start) {
  if (visited[start] || unvisitedSeen[start]) continue;
  std::vector<size_t> comp;
  // ... BFS over `adjList`/`edges` (the same real, measured pairwise adjacency
  //     used to build the root's own bend tree) ...
  unvisitedComponents.push_back(std::move(comp));
}

// ... unvisitedComponents is used ONLY to find the largest one, for the
// root-swap decision (largestCompIdx / largestCompSize) ...

// Emit solo graphs for all unvisited pieces.
for (size_t i = 0; i < n; ++i) {
  if (!visited[i]) {
    PartGraphSpec soloGraph;               // ← one singleton per PIECE, not per COMPONENT
    soloGraph.rootRegionPanelId = "piece" + std::to_string(i);
    soloGraph.outline.outer = simplifiedPieces[i].ringLocal;
    result.graphs.push_back(std::move(soloGraph));
  }
}
```

`unvisitedComponents` already contains exactly the grouping needed (each entry is a list of
piece indices that are mutually reachable via real matched edges) — it's computed, used once
for the root-swap size comparison, and then never consulted again. The final loop iterates
piece-by-piece instead of component-by-component.

---

## Confirmed Adjacency (from an earlier investigation on this same fixture)

While investigating a since-fixed bug on `testcube.step` (`BUG_REPORT_import_part_testcube_disconnected_pieces.md`,
now closed), piece 6 and piece 8 were directly measured and confirmed adjacent:

```
piece 6: 4-vertex rectangle, normal (0,1,0), origin (75,75,75)
piece 8: 20-vertex polygon, normal (0,0,1), origin (75,75,75)
piece 6 edge 3 vs piece 8 edge 1: combined endpoint gap 0.000000mm
```

Same origin, perpendicular normals, zero measured gap — a real, physical shared edge (two
adjacent faces of the cube). In the current build's live output, both still appear as separate
entries in `component_part_ids` rather than one combined two-piece part — direct evidence of
this exact gap, on the exact fixture Paul is testing with.

---

## Expected Behavior

After `import_part`, produce as few parts as possible: the root component as today, **plus one
part per remaining connected component** among the leftover pieces (each internally reconciled
through the same bend-tree-building machinery already used for the root — steps 5/6 of this
same function), rather than one singleton part per leftover piece.

---

## Proposed Fix Direction (C++ layer only)

For each entry in `unvisitedComponents` (size ≥ 2): run the same reconciliation steps 5/6
(parent-before-child pose accumulation + combined-outline tracing) already used for the root
component, scoped to just that component's pieces, picking a per-component root (e.g. same
"most edges" heuristic already used for the cross-component root swap) — producing a real
multi-piece `PartGraphSpec` with its own bend tree instead of a bare single-outline stub.
Components of size 1 keep today's solo-graph path unchanged (nothing to combine).

This effectively means step 5/6's logic needs to be reusable per-component rather than
hardcoded to run once against the single main `graph`/`bfsOrder` — worth checking how much of
that logic can be factored into a helper callable once per component (main + each
multi-piece leftover group) instead of duplicating it.

---

## Impact

- Every real import with more than one disconnected sub-group (i.e. most non-trivial
  multi-body or partially-reconcilable imports, per this exact `testcube.step` example: 9
  singleton components where at least one pair — 6 and 8 — should be 1 combined part) produces
  more top-level parts than necessary.
- Downstream: more parts to load/render/select in the UI, more findings/mesh/flat-pattern
  fetches than the true part count warrants, and a part tree that doesn't reflect the actual
  connectivity of the source geometry.

---

## Links

- Grouping computed then discarded: `cpp/src/geometry/translation/step_reconciliation.cc`,
  the `unvisitedComponents` block and the final "Emit solo graphs" loop, both added/modified in
  commit `09fb9fb` ("reconcilePieces — disconnected components + largest-component root
  selection")
- Reconciliation steps 5/6 (the per-component logic to reuse): same file, "For each non-root
  piece (BFS order = parent-before-child...)" section, immediately following the solo-graph
  emission loop
- Prior adjacency measurement: `docs/BUG_REPORT_import_part_testcube_disconnected_pieces.md`
  (closed/fixed, but its piece 6/8 measurement is the direct evidence for this report)
- Fixture: `cpp/tests/fixtures/testcube.step`
