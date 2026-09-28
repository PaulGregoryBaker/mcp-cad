# Core Correctness Suite (Phase 1.3 skeleton)

Implementation-agnostic acceptance cases for mcp-cad v2 — the executable definition of
rebuild success ([09-core-correctness-suite.md](../09-core-correctness-suite.md)).

## Layout

```
suite/
├── README.md            ← this file
├── schema.md            ← case-file schema definition
├── profiles.json        ← named tolerance profiles (N11); cases reference by name
├── generator/
│   └── closure_family.mjs   ← emits C22 polygon-closure cases (Level A, tier T2)
└── cases/
    ├── T2/              ← generated: c22-*.json (do not hand-edit; re-run generator)
    └── T3/              ← authored: net closure family (cube nets etc.)
```

## Running the generator

```
node rebuild/suite/generator/closure_family.mjs
```

Deterministic: same inputs → byte-identical case files (safe to re-run; diff-friendly).

## Drivers

A **driver** binds the case format to an implementation. Case files contain only
v2-contract vocabulary; drivers translate.

- **v1 driver** (`ts/tests/integration/suite_driver_v1.integration.test.ts`):
  runs cases against this repo. Gated behind `SUITE_V1_DRIVER=1` so normal test runs
  are unaffected. Purpose: **validate the suite itself** — the 🩹 rows of the case
  inventory must pass, the ❌ red rows (C05/C08/C13) must fail. A suite that cannot
  detect v1's known bugs is not a valid oracle set.
  v1 translation notes: Level A "authored strip" is emulated by importing
  `sheet_1panel.stp` N times, posing each panel via transaction-scoped
  translate/rotate, then chain-merging (v1 derives bend angles from actual dihedrals);
  closure is then asserted on `get_unfold` + `map_2d_to_3d` of the strip ends.
- **v2 driver**: written in Phase 5 slice 1 against the real v2 contract (native
  Level A: author the graph document directly — no import emulation).

## Status / next steps

- [x] Case schema (schema.md)
- [x] Tolerance profiles (profiles.json)
- [x] C22 generator + generated T2 cases (sharp variant; both bend directions; pose
      sweep; per-bend checkpoints)
- [x] T3 net-closure anchor case: cross → cube (authored)
- [x] v1 driver skeleton (env-gated)
- [~] v1 driver calibration — **in progress**; findings from the first probe runs
      (N=4 closure case), each now encoded in the driver:
      1. `rotate_body` requires `axis_origin`/`axis_direction`/`angle_degrees` and a
         `transaction_id`; results come back as `solid_id`/`solid_ids`.
      2. A flat sheet gets **no graph** from split (`detected_mode: thin_solid`), and
         v1's frame derivation rejects raw transformed solids ("no planar faces") —
         the merge pipeline wants **shell panels from split_body_by_bends**. Segment
         prototype is therefore the flat panel of a split `l_bracket_corner_90deg.stp`
         (measured 201.5×200×2 — driver scales case expectations linearly).
      3. `rotate_body` is right-handed (+X→−Z about +Y); polygon headings need the
         negated angle.
      4. Transforms never rebind graph membership — each posed shell needs
         `registerTestPart(posedId, [posedId], rectDxf(len, width))`.
      5. Chained merges must pass `merged_part_id` (the graph-carrying id) as the next
         `part_a_id`; `merged_shell_id` is only the geometry handle (pattern from
         testcube_three_panel test). Merges also want the `transaction_id`.
      With all five applied, the N=4 closure case poses a geometrically PERFECT square
      tube (verified by bbox) and the driver runs end-to-end. **Three genuine v1
      defects found on the authored-panel route** (none are driver bugs):
      1. **Multi-zone hinge-line splitting unimplemented** —
         `GE_BUILD_FROM_PATTERN_FAILED` at merge 2 of the chain
         (`geometry_service_shell.cc` hinge-line path is explicitly N==1-only; v1's
         own testcube chain passes because its panels come from one split part).
      2. **Merged-DXF global region lookup fails for panel B** — `map_2d_to_3d`
         without panel_id: "No panel region contains point [404.1, 100]" although the
         flat pattern is 405.1 wide (panel B's dxfPlacement region not found).
      3. **Panel↔frame association SWAPPED in merged-part mapping** — with explicit
         panel_id, panel A's flat coords map onto panel B's 3D plane and vice versa
         (measured: A(1,100)→(199.5,100,200.5) on B's wall; B(200.5,100)→
         (199.5,100,1.0) on A's floor). A plain 2-panel merge — the C05 class
         ("pair-dependent simple-merge failure"), now with a minimal authored repro.
      These are suite FINDINGS, not calibration debt: the closure family correctly
      fails on v1 (validating the oracles), and the C22 row in 08-case-inventory is
      updated — v1 cannot run this family. The minimal 2-panel swap repro is the most
      valuable artifact: it reproduces the C05 bug class without cauldron.step.
- [ ] Remaining cube nets (10) + tetrahedron/pyramid nets (generator preferred over
      hand-authoring)
- [ ] Allowance variant of C22 (AC-C.2) — needs the bend-allowance formula encoded
      with the neutral-axis convention pinned down in the domain notes (Phase 1.4)
- [x] Red cases C05/C08/C13 pinned as Level C sweep cases with self-referential
      oracles; Level C op/oracle vocabulary in schema.md; sweep runners implemented
      (pair sweep, triple sweep, full-reassembly — capped by SUITE_SWEEP_LIMIT,
      early-exit once red is confirmed).
- [x] T0/T1 harvested cases: t0-lbracket-mapping-roundtrip,
      t0-cauldron-panel-roundtrip (the C02 skew regression, suite-guarded),
      t1-bracket90/45-merge-position-preserved.
- [x] **Suite validation gate: MET.** Full v1 driver run `SUITE_V1_DRIVER=1`
      (+`SUITE_SWEEP_LIMIT`): **50/50 green as a consistent ledger** — v1 passes
      where it works (T0 roundtrips incl. cauldron skew; T1 merges), and the driver
      *asserts failure* where v1 is characterized-broken: the closure family
      (v1-known-red per C22 ❌) and the three red sweeps (C05 pair, C08 triple, C13
      full reassembly) each demonstrably fail on v1. A green run means "v1 behaves
      exactly as characterized"; any v1 change that fixes or breaks something flips
      an assert and alerts.
- [x] Net closure cases marked v2-only for the v1 driver (authored fold-tree route is
      not expressible through v1's tool surface).
- [x] **Reconciled against the approved v2 contract** (15-mcp-contract.md,
      2026-07-20) — schema.md now states, precisely, what every op means for a v2
      driver (Phase 5). Headline finding: `import_part`'s A4 auto-bootstrap means
      `decompose`, `construct`, and `merge_pair`/`merge_next`/`merge_all_adjacent`
      (when following an `import` of the same fixture) all collapse to **no-ops** for
      a v2 driver — one `import_part` call plus pure verification reads, where v1
      needed an explicit decompose plus potentially hundreds of merge calls. A new
      `finding` oracle type was added, aligned to 15 §1's exact `Finding` schema, to
      express the standing fix-application harness requirement (below) in case files
      directly rather than leaving it purely implicit.
- [ ] Harness middlewares (replay, fix-application) — still a v2-driver
      *implementation* concern (Phase 5); the case format now has an explicit
      `finding` oracle type (schema.md) to drive the fix-application harness, so
      nothing further is needed at the schema level.
- [ ] **Cross-pose equivalence assertions** (Paul, 2026-07-19; 13 §8 "DXF-pose
      equivariance"): the closure-family pose sweep currently checks each pose against
      its own (frame-local) oracle. Strengthen for the v2 driver: for each (N, dir,
      variant), the three poses must yield **identical world geometry and mappings**
      after compensating only the root transform (`R' = G⁻¹·R`) — byte-identical, not
      merely within budget. Generator already emits the pose axis; the assertion is a
      v2-driver addition.
