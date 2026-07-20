# Case-file schema (v0.1)

**Reconciled against the approved v2 contract (15-mcp-contract.md), 2026-07-20.**
Case files are unchanged — they were always written as driver-agnostic abstractions
("ops use v2-contract concepts... a case that can't be expressed without naming v1
internals belongs in a driver, not a case," rule 1 below) — but the reconciliation
surfaced concrete, worth-recording facts about what those abstractions mean for a
real v2 driver (Phase 5). See "v1 vs v2 driver semantics" below each op group. Where
v1 needed an explicit step, v2 frequently needs none, because A4 (import
auto-bootstraps the *fully reconciled* graph in one pipeline) does in one call what
v1 spread across decompose-then-many-explicit-merges — a concrete, countable
validation of the redesign, not just an architectural claim.

One JSON file = one case. All geometry in mm; angles in degrees; coordinates are
**local to the frame of the first authored/imported panel** ("panel-0 frame") unless a
field says otherwise — this is what makes pose sweeps an invariance oracle instead of
needing per-pose expected values.

```jsonc
{
  "schemaVersion": "0.1",
  "id": "c22-n4-up-rot030-sharp",     // unique, stable; file name matches
  "title": "human-readable one-liner",
  "level": "A",                        // direction layer: A | B | C  (09 §1.5)
  "tier": "T2",                        // T0..T5 (09 §3)
  "inventory": ["C22"],                // 08-case-inventory case ids this covers
  "toleranceProfile": "default",       // key into profiles.json
  "expectation": "pass",               // "pass" | "known-fail-v1" (red cases)

  "fixture": {
    "kind": "authored",                // "authored" (Level A/B) | "step" (Level C)
    "path": null                       // for "step": repo-relative fixture path
  },

  "params": { /* free-form, generator/driver contract; documented per family */ },

  "ops": [
    // Ordered operations in v2-contract vocabulary. Drivers translate.
    // Level A closure family uses exactly these three:
    { "op": "author_strip",            // N region panels in closed-polygon pose
      "N": 4, "segmentLenMm": 60, "widthMm": 40, "thicknessMm": 1,
      "bendDir": "up",                 // "up" | "down"
      "pose": { "rotDeg": 30, "offsetMm": [0, 0] } },
    { "op": "construct" },             // build 3D + flat forms from the graph
    { "op": "map_strip_ends" }         // 2D→3D map both strip-end edges
  ],

  "oracles": [
    { "type": "closure",               // O1/O2: strip-end coincidence
      "budgetKey": "closureMm",        // key into the tolerance profile
      // Per-bend partial-loop checkpoints, panel-0 frame:
      // free strip end (both width corners) after k bends.
      "checkpoints": [
        { "afterBend": 1, "endCorners": [[x,y,z],[x,y,z]] }
      ],
      // Final closure: end edge coincides with start edge:
      "finalCoincidentWithStart": true },

    { "type": "probe",                 // O1: named 3D points within budget
      "budgetKey": "probeMm",
      "points": [ { "label": "…", "expected": [x,y,z] } ] },

    { "type": "polygon",               // O3: exact outline comparison
      "budgetKey": "outlineMm",
      "target": "flatPattern",         // which derived artifact
      "expectedVertices": [[x,y], …] },

    { "type": "structure",             // O4
      "solidCount": 1,
      "typedError": null },            // or the error code that MUST be raised (N5)

    { "type": "net_closure",           // O4/O1: every unglued edge pair coincides
      "budgetKey": "closureMm",
      "seams": [ ["faceA:edgeRef", "faceB:edgeRef"], … ] },

    { "type": "finding",               // O4: added 2026-07-20, reconciled against
                                        // 15's Finding schema (§1) and the standing
                                        // fix-application harness (AC-F.6/F.7, 09 §1)
      "expectCode": "…",               // the Finding.code expected on this graph state
      "anchors": ["…"],                // entity refs the finding must be anchored to
      "recommendedFixExists": true,    // Finding.recommendedFix must be non-null
      "applyFixAndExpectCleared": true // harness applies it verbatim, re-checks: the
                                        // finding must be gone, no new same-code
                                        // finding may appear, and AC-B.1's replay
                                        // harness must still pass post-fix
    }
  ]
}
```

## v2-driver op semantics (Level A) — concrete, per 15-mcp-contract.md

- `author_strip` / `author_net` → **one `create_part`** (15 §4.1) with the *root*
  region's outline, followed by **one `create_node(kind=bend, ...)` per fold**
  (15 §4.3) — each call is a split (14 §2.1.1), carving the next region off the
  growing remainder. `create_part` itself takes no bend list (15 §4.1's params are
  outline/material/anchor only), so the fold sequence is genuinely N−1 (or
  `folds.length`) separate CRUD calls, not one compound authoring call.
- `construct` → **no call at all in v2.** There is no "build" step to invoke — the
  `Layout` (regions, poses) is computed lazily on first read (14 §3), so this op is a
  no-op for a v2 driver, present only because v1 needed an explicit construction
  pass. A v2 driver can delete this step and proceed straight to reading resources.
- `map_strip_ends` → a **resource read**, `graph://part/{id}/map-2d-3d?point=x,y`
  (15 §4.4), not a tool call — `map_2d_to_3d` was reclassified from a v1 tool to a
  v2 resource (§4.4's "0 mutating tools" reclassification).

## v2-driver op semantics (Level C) — where v1's explicit steps become no-ops

`import_part` (15 §4.1) is **A4's full pipeline in one async job**: heal → decompose
→ classify adjacent regions → connect (bend or fuse) — everything v1 spread across a
separate `clean_geometry` + `split_body_by_bends` + N explicit
`merge_bodies_with_bend` calls. Concretely, for a v2 driver:

- `import` → `import_part`, **polled via `get_job`** (async, N9/N9a — expect granular
  `progress`, not a bare wait). Import alone already produces the *fully reconciled*
  graph.
- `decompose`, immediately following `import` on the same fixture → **no-op.**
  `import_part` already ran it internally. (`decompose` remains meaningful as its
  own op only when it is *not* preceded by `import` in the same case — e.g.
  re-decomposing with different thresholds, 15 §4.2's `split_body_by_bends` row.)
- `sweep_adjacent_pairs`/`sweep_adjacent_triples` with `merge_pair`/`merge_next` as
  `inner` → **the merge calls are no-ops too**, for pairs/triples that came from the
  same import: they are already connected by a bend once `import_part`'s job
  completes. The sweep collapses to *pure verification* — for each adjacent
  pair/triple already present in the graph, read `Pose(i)`/`Pose(j)` (via
  `graph://part/{id}/full` or the mapping resources) and check `position_preserved`
  directly. No merge orchestration is needed in a v2 driver for these red cases at
  all — **one `import_part` call, then N reads**, where v1 needed one import plus
  potentially hundreds of explicit merge calls (the actual sweep counts, per the
  v1-driver `SUITE_SWEEP_LIMIT` runs). This is the redesign's reconciliation-first
  architecture (A4) paying off concretely in the test harness, not just asserted.
- `merge_all_adjacent` → same collapse: a no-op read of the fully-connected graph
  `import_part` already produced, checked against `bounds_match_import`.
- **Caveat, stated for precision:** the *no-op* collapse holds specifically because
  these red cases' pairs/triples are adjacent panels from *one* import of *one*
  solid — exactly A4's scope. It does **not** generalize to `merge_bodies_with_bend`
  itself, which in 15/14 §2.1.2 is a genuinely different operation: joining **two
  independently-imported/authored parts**. That verb, and its own test cases, are
  unaffected by this reconciliation — it still does real work.

## Rules

1. **No implementation vocabulary.** Ops use v2-contract verbs/concepts only; a case
   that can't be expressed without naming v1 internals belongs in a driver, not a case.
2. **No hardcoded budgets.** Oracles carry `budgetKey`s; numbers live in
   `profiles.json` (N11). A case may pin a *stricter* profile by name, never a number.
3. **Local-frame expectations.** Expected coordinates are panel-0-frame; drivers map to
   world coordinates via the implementation's own reported frame — so a pose sweep
   changes nothing in the case's oracles (invariance by construction).
4. **Weak asserts forbidden** (L4/09 §1): no bbox/volume oracle types exist in this
   schema, deliberately.
5. **Red cases** carry `"expectation": "known-fail-v1"` — the v1 driver *requires*
   them to fail (suite self-validation); the v2 driver requires them to pass.

## Level C ops & sweep cases (red cases use these)

Additional op vocabulary for STEP-based cases:

- `{ "op": "import", "path": "repo-relative fixture" }` — import + heal.
- `{ "op": "record_import_reference" }` — capture the imported solid's bbox and ≥N
  reference vertices for later self-referential oracles.
- `{ "op": "decompose" }` — the single decomposition verb (v1: split_body_by_bends).
- `{ "op": "sweep_adjacent_pairs" | "sweep_adjacent_triples", "inner": […],
    "isolation": "rollback-between-iterations" }` — run `inner` for every adjacent
  pair/triple from the decomposed graph, restoring state between iterations. A sweep
  case FAILS if any iteration fails its oracles; the driver reports which.
- `{ "op": "merge_pair" }` / `{ "op": "merge_next" }` — merge the current sweep
  iteration's panels (chaining via the graph-carrying composite id).
- `{ "op": "merge_all_adjacent" }` — re-merge the full decomposition.

Additional oracle types (all self-referential — no stored constants):

- `position_preserved` — before each merge, record ≥3 non-collinear reference features
  per panel; after, the same features must be at the same world coordinates within
  `budgetKey`. (The oracle that killed v1's false-negative sweeps.)
- `bounds_match_import` — the final composite's 6 bbox bounds equal the *imported
  solid's own* bounds within budget. Admissible despite the bbox ban because the
  reference is exact and self-derived (an identity, not a spot-check).

## Net (fold-tree) fixture encoding — used by T3 authored cases

For `author_net` ops, faces are named squares on a unit grid with a fold tree:

```jsonc
{ "op": "author_net",
  "faceSizeMm": 50, "thicknessMm": 1,
  "faces":  { "F0": [0,0], "F1": [0,1], "F2": [0,2], "F3": [0,3],
              "L":  [-1,1], "R": [1,1] },          // grid coords in the flat
  "folds":  [ { "parent": "F0", "child": "F1", "angleDeg": 90 }, … ],
  "root": "F0" }
```

Seam references in `net_closure` oracles use `face:cardinal` edge naming (`F3:N` = the
north edge of F3 in flat-grid orientation before folding).
