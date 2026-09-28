# TASK_SPEC: merge_bodies_with_bend — anchor-driven, single-path reconciliation

**Status:** IMPLEMENTED — core algorithm (§9), F1-F9, and AC1-AC5/AC7 built and passing (C++ unit tests, TS integration tests, and the full existing suite, incl. a 3321-pair real-fixture sweep on cauldron.step matching this project's own historical adjacency ground truth). AC6 (fuse_bodies internals shared with the new contact-detection subfunction, §8.2) not yet done — fuse_bodies' own contact logic is unchanged, still a separate implementation; only its public behavior/contract is unaffected. §8.3 phase 2 (contact_point_hint, rich disambiguation errors) remains deferred as planned.
**Branch:** 011-graph-driven-geometry
**Owner decision authority:** Paul (per CLAUDE.md Mental Model Alignment Protocol — placement,
algorithm, and pattern decisions below require explicit sign-off, not inference).

---

## 1. Problem Statement

`merge_bodies_with_bend` (v2) requires the caller to supply `edge_a`, `edge_b`
(`{region_panel_id, edge_index}`) and `angle_deg` explicitly. This is unusable from a UI:
edge indices carry no meaning to a human, the tool offers no way to know in advance which
index pairs will even pass validation, and the underlying splice
(`part_merge.cc::ReconcileOutlines`) additionally requires the two edges to match in length
to within 2mm — so a real asymmetric seam (a narrower panel welded onto part of a longer
edge) cannot be merged directly at all.

Both parts already carry a real 3D anchor (`PartRow.anchor`) that places their flat outline
in world space. The seam is not an arbitrary choice the tool needs from the caller — it is a
geometric fact already implied by how the two parts are positioned. This task replaces the
caller-supplied-edge-refs design with one that derives the seam, the fold angle, and the
resulting flat pattern directly from the parts' own anchors.

## 2. Background

### 2.1 What v1 already solved, and how

v1 had this exact capability. `handleMergeBodiesWithBend`
(`ts/src/mcp/handlers/shape-ops.ts`, deleted 2026-08-05 in commit `fc03563`, recoverable at
`fc03563^`) worked on real, already-anchored 3D shells. Read closely, it actually contained
**three** distinct derivation strategies selected by case detection:

1. **Perpendicular-fold composites** ("corner chains"): `getGeometryBinding().fuseBodies([shellAId, shellBId], 0.15)` — a live 3D boolean fuse on the two shells at their real, already-correct world positions, with a typed `GE_MERGE_DISCONNECTED` failure if they don't actually touch.
2. **The general case**: `buildShellFromFlatPattern` — construct a 2D flat pattern by hand (extensive anchor/frame/hinge-offset arithmetic: `frameADxf`, `bendDirPayload`, `foldNormalPayload`, `bHingeOffsetMm`, sign-convention reconciliation between two independently-authored frames), then reconstruct a 3D shell from that flat pattern.
3. **Legacy fallback**: a native `mergeBodiesWithBend(shellA, shellB, targetEdges, radius)` call operating directly on shell edge IDs when neither of the above applied.

Project memory documents an extended, multi-session debugging history against path (2) — sign
disagreements between two independently-chosen local frames, seam-offset corrections, a
"191mm hinge position" misdiagnosis, corner-chain misplacement found by a rigorous 3D probe
after an earlier "0 issues" sweep turned out to be a false negative. Path (1) — fuse the real
3D solids directly — is comparatively simple and remained correct throughout; it is also
exactly the model this codebase's own current constitution now argues for (§2.3).

**Correction (superseding an earlier draft of this section):** an earlier version of this spec
proposed starting from path (1) literally — fusing the two parts' real 3D solids with a boolean
operation, then reverse-deriving the flat pattern from the fused result via `unfoldShell`. That
was wrong: it discards v2's actual architecture, where the 2D manufacturing graph (outline +
`BendRow`s) is the single source of truth and 3D is *always* derived from it, never the other way
around — every other v2 tool (`create_part`, `cut_panel`, `split_part_at_bend`,
`createBendNode`) follows graph → `evaluatePart` → `constructPart`, in that direction only. Path
(1)'s real virtue is narrower than "do a 3D boolean fuse": it uses the parts' **real anchors** to
find the hinge geometrically instead of asking the caller — path (2)'s real vice is not "it's a
2D flat-pattern operation" (that part is exactly right and is what path (1) lacked) but that it
then hand-rolled its OWN 3D reconstruction (`buildShellFromFlatPattern`) instead of using a
generic graph→3D derivation, which is where the sign/frame/hinge-offset bugs actually came from —
v1 never had v2's clean `evaluatePart`/`constructPart` separation to reuse. §9 below combines path
(1)'s anchor-driven hinge detection with path (2)'s 2D-graph-native splice, and reuses v2's
already-correct, already-generic 3D-from-graph derivation for the final step — never
re-implementing 3D reconstruction, and never leaving the 2D outline as anything other than the
authoritative representation.

### 2.2 What v2 has today

- `PartRow.anchor` (`ts/src/v2/graph/types.ts:66-67`): every part already has a real 3D placement.
- `fuse_bodies` (`FuseCoplanarParts`, `cpp/src/geometry/translation/polygon_boolean.cc:388`): already anchor-driven, already requires no edge refs — but restricted to the coplanar (no-bend) case, and implemented as a 2D outline union rather than a 3D solid fuse.
- `merge_bodies_with_bend` (`part_merge.cc::ReconcileOutlines`): works purely in each part's local 2D frame, never reads either anchor, requires caller-supplied `edge_a`/`edge_b`/`angle_deg`, and rejects any edge-length mismatch beyond `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (2mm) outright — no partial-overlap support.
- `fuseBodies` (3D solid boolean, `geometry_service_booleans.cc` / `geometry_service.hpp`) and `unfoldShell` (3D→2D flat-pattern derivation, `geometry_service_export.cc:1748`) both still exist as generic, already-v2-integrated primitives (`part_solid_construction.cc` already calls into this layer for `constructPart`). Neither is v1-only or orphaned.
- `SplitBodyByBends` (`geometry_service_sheet_metal.cc`) is the existing, already-hardened pipeline that derives region panels + bend nodes + flat pattern from an arbitrary 3D solid — this is what `import_part`/`split_body_by_bends` already run on freshly-imported STEP geometry.

### 2.3 Conflicting precedent found during review — RESOLVED

`ts/tests/integration/merge_partial_seam_tab_bracket.integration.test.ts` is a **current, passing
v2 test** that already investigated the exact "asymmetric seam" scenario this task targets (v1's
`tab_bracket_90deg.stp` case: a 100mm flange welded onto part of a 200mm plate edge). Its
conclusion, on file: this is **not** a gap, provided the plate's outline is *authored* with the
seam pre-split into matching collinear sub-edges at creation time — then today's exact-length
edge match already handles it, invoking constitution principle III ("one geometric solution, no
implicit/derived matching") as the justification for keeping explicit edge indices over v1's
implicit `target_edges: ['all']` auto-detection.

**Decision: that conclusion was wrong, and is superseded by this task.** Requiring the caller to
pre-split an outline by hand to work around the merge tool's own inability to find a partial
overlap is exactly the kind of caller-side compensation the "one geometric solution" principle
argues against — the tool should derive the true contact interval itself. The task explicitly
includes readjusting `merge_partial_seam_tab_bracket.integration.test.ts` (§6, §7 AC5): the
plate's outline goes back to its real, unsplit form (a single edge the full length the flange
sits partway along), positioned against the flange via real anchors, and the merge is still
expected to succeed with the same T-shaped result — proving unequal-length edges merge directly,
not proving the pre-split workaround.

## 3. Goals

1. `merge_bodies_with_bend` takes no edge references and no `angle_deg` for the ordinary case — both are derived from `part_a`'s and `part_b`'s own anchors.
2. A seam that only partially covers one side's edge (asymmetric/T-shaped/off-center) merges directly, without requiring the caller to pre-author matching sub-edges.
3. Exactly one derivation path handles every relative geometry — flush, angled, perpendicular ("corner chain"), and N-panel chains — no per-case branching between strategies.
4. Every scenario v1's own merge-with-bend test suite covered (§6) is repurposed as a v2 acceptance case, using the same fixture files (still present under `cpp/tests/fixtures/`).

## 4. Non-Goals

- Changing `fuse_bodies`'s own behavior or its tool contract — it stays a separate function producing a single merged panel with no bend, never a `BendRow`. Only its internal contact-detection is refactored to share F2's new subfunction (§8.2) — its union logic (`PolygonUnion`) is untouched.
- A caller-facing way to disambiguate between multiple disjoint contact regions (an optional contact-point hint parameter, and error geometry rich enough for a client to render both options) — deferred, see §8.3. This task's F6 picks one deterministically instead.
- Changing `split_part_at_bend`, `update_node`, or any other tool's contract.
- UI/client work (the picker dialog itself) — this spec covers the MCP tool and geometry engine only.

## 5. Functional Requirements

| # | Requirement |
|---|---|
| F1 | `merge_bodies_with_bend` accepts `{part_a_id, part_b_id, radius_mm?, k_factor?, bottom_is_concave?}`. No `edge_a`, `edge_b`, or `angle_deg`. |
| F2 | The hinge (`hingeA`/`hingeB`) and fold angle are derived purely from `part_a.anchor`, `part_a.outline`, `part_b.anchor`, `part_b.outline` — a 2D geometric contact-detection computation (project B into A's local frame via `anchorA.Inverse().Compose(anchorB)`, find where the two outlines' boundaries actually coincide), never a 3D solid boolean and never caller-supplied. |
| F2a | Once the hinge is known, the combined 2D outline is produced by the existing closed-form splice (`part_merge.cc`'s transform-and-splice math), generalized to splice at an arbitrary contact interval rather than requiring a whole matching consecutive edge. The outline is the only thing that changes — no bend-allowance geometry is baked into it directly. |
| F2b | Bend-allowance/k-factor accounting is NOT reimplemented for this tool — the new bend is created via the existing `createBendNode` path exactly as today, and its flat-pattern allowance/setback is computed the one existing way every other bend already is (`ComputeBendGeometry`, `manufacturing_graph_evaluator.cc:82-87`), the next time the part is evaluated. |
| F2c | `merge_bodies_with_bend` and `fuse_bodies` remain two separate functions with two separate outcomes — a merge always produces a `BendRow` and two region panels; a fuse always produces one plain panel, never a bend. They are NOT unified into one tool. They DO share the same contact-detection subfunction (F2's anchor-projection-and-boundary-coincidence routine) as a common building block — `fuse_bodies` calls it and stops at the union step when angle≈0; `merge_bodies_with_bend` calls it and proceeds to the splice-and-bend steps for any other angle. |
| F3 | A seam that covers only part of one side's edge (asymmetric length) is a supported case: the contact-interval detection in F2 finds the true overlap (possibly a sub-segment of a longer edge, possibly crossing an existing vertex on either side), inserting new vertices at the interval's endpoints where needed — without requiring pre-split authoring. |
| F4 | Exactly one code path is used regardless of the relative fold angle (flush/coplanar is `fuse_bodies`'s job, not this tool's — see F7) — the contact-detection-and-splice in F2/F2a does not branch on angle magnitude; a 90° perpendicular chain and a 10° shallow fold go through the identical computation. |
| F4a | The final 3D shape is produced by the existing, unchanged `evaluatePart`/`constructPart` graph→3D derivation — never a bespoke reconstruction. Acceptance requires the regenerated 3D position of both original panels' material to match their real pre-merge anchored positions within tolerance (a replay-style check, consistent with the constitution's existing "execute → serialize → replay → assert equivalence" discipline). |
| F5 | Two parts with no real contact within the established import-noise tolerance (`MERGE_EDGE_ALIGNMENT_TOLERANCE_MM`-family, per `numerical-policy.ts`) fail with a typed, actionable error — not a guess. |
| F6 | Two parts that contact along more than one physically disjoint region: for this task, deterministically select ONE (the interval with the greatest contact length — the most physically substantial seam) and merge on it; this is a documented placeholder, not a permanent answer (§8.3) — a genuine caller-facing disambiguation mechanism is deferred, not built here. |
| F7 | Two parts that are coplanar (no real fold — angle ≈ 0) fail with a typed error directing the caller to `fuse_bodies` instead, rather than silently producing a zero-angle bend. |
| F8 | Chained merges (merging a third part onto an already-merged composite) work through the same single path, for both parallel and perpendicular fold chains — no separate "chain" case. |
| F9 | Existing rollback/typed-error discipline is preserved: a reconciliation failure leaves the graph store untouched (same convention as today's `evaluate-client.ts::mergePartsWithBend`). |

## 6. Test Plan — Repurposed V1 Scenario Inventory

All fixtures below are already present in `cpp/tests/fixtures/` — nothing needs to be
regenerated. v1's own test files (recoverable at `git show fc03563^:<path>`) are **source
material for the scenario and its pass/fail invariant**, not code to port verbatim — v1's
API surface (`shellId`, `PanelNode`/`BendNode`, `target_edges`) doesn't exist in v2; each
scenario is re-expressed against v2's `create_part`/`merge_bodies_with_bend`/`evaluatePart`/
`graph://part/{id}/boundary` surface.

| Scenario | Fixture | Invariant (from v1) | v1 source |
|---|---|---|---|
| Basic two-panel merge at an arbitrary angle | `angle_bracket_45deg.stp` | flat-pattern area within 15% of sum of panel areas; merged 3D bbox within ±5mm of pre-merge union bbox | `merge_asymmetric_flat.integration.test.ts` |
| Corner-flush **asymmetric** seam (unequal-length edges, no pre-split) | `l_bracket_corner_90deg.stp` | flat pattern is the correct L-shape (~300×200 bbox, 100×100 notch); 3D part matches original pre-split part ±5mm | `merge_asymmetric_flat.integration.test.ts` |
| T-shaped **asymmetric** seam (flange narrower than the edge it sits on) | `tab_bracket_90deg.stp` | ≥8 unique flat-pattern vertices, fill ratio <95%; area within 15% of sum; merged bbox covers both panel bboxes | `merge_tab_bracket.integration.test.ts`; supersedes the pre-split workaround in `merge_partial_seam_tab_bracket.integration.test.ts`, which is rewritten to use the plate's real unsplit edge (§8.1, AC5) |
| Non-rectangular (trapezoidal) panels | `cauldron.step` (adjacent facet pair) | merged 3D shape matches the union of the two panels' own bboxes | `cauldron_trapezoidal_panel_merge.integration.test.ts` |
| Geometric adjacency detection itself | `cauldron.step` (rejected pairs) | rejected pairs must NOT share a real 3D edge within material thickness — i.e. the new auto-detector's accept/reject boundary is independently checkable | `cauldron_verify_adjacency.integration.test.ts` |
| 3-panel chain, parallel folds (U-channel) | `testcube.step` | all 3 bends parallel; correct 3D shape | `testcube_three_panel_chain_merge_repro.integration.test.ts` |
| 3-panel chain, perpendicular folds ("corner"/"tray") | `testcube.step` | correct 3D result via the live-fuse path — this is the exact scenario §2.1's path (1) already solved correctly | `testcube_three_panel_chain_merge_repro.integration.test.ts` |
| 4-panel near-end chain | `testcube.step` or equivalent | flat has 2 bends; long side ≈ 3× panel width | `four_panel_near_end_chain.integration.test.ts` |
| Merge → then fuse a protrusion onto the merged composite | `testcube.step` (±75mm / minus-X protrusion variants) | volume conserved; panel shapes preserved at correct world coordinates; correct fold direction (no gap); exportable mesh | `testcube_minus75_protrusion_fuse_merge_repro.integration.test.ts` + 3 sibling `_bottom_repro`/`_minusx_` variants |
| Fuse a protrusion FIRST, then merge the composite | `testcube.step` | Panel A's own composite/notched shape recoverable at the exact same world position post-merge | `testcube_merge_bend_panelA_shape_preservation.integration.test.ts` |
| Merge two walls, then fuse a flange already sitting on one of them | `cube_with_flanges.stp` | correct rotation/orientation of the already-attached flange after the wall-merge | `chained_merge_protrusion_fuse_rotation.integration.test.ts` |
| Merge-then-fuse total volume conservation | `testcube.step` | total volume conserved through merge+fuse; `exportGlb` succeeds | `testcube_chained_merge_then_fuse_volume.integration.test.ts` |
| 3D orientation preserved (no spurious inversion/rotation) | `testcube.step` split panels | fold stays in the correct axis; Panel A does not move; merged Y-extent matches pre-merge union | `merge_orientation_preserved.integration.test.ts` |
| One panel translated before merging | `testcube.step` split panels | rotation/placement still correct regardless of the panels' pre-merge world position | `real_panel_translate_merge_bend_rotation.integration.test.ts` |
| Coordinate mapping across a multi-bend assembly | synthetic 2/3-panel fixture | 3D→2D→3D round-trip ≤0.1mm across every panel, including a point that falls inside a bend zone (must be a typed rejection, not a wrong panel pick) | `coordinate_mapping_multibend.integration.test.ts` |
| `split_body_by_bends` → `merge_bodies_with_bend` round trip, watertight | `cauldron.step`, `cube_with_flanges.stp` | split panels re-merge into a watertight fused solid | `split_by_bends.integration.test.ts` |
| Flat-pattern/unfold correctness after merge | merged composite part | `apply_unfold`/boundary resource resolves to the canonical merged part, not the stale absorbed one | `merge_unfold_dxf_content.test.ts`, `merge_unfold_panel_selection_bug.test.ts` (re-expressed against v2's `mergedIntoPartId` aliasing, not v1's `canonical`/stale-node model) |

Each row becomes a v2 integration test under `ts/tests/integration/`, gated the same way
`merge_partial_seam_tab_bracket.integration.test.ts` is today (`SUITE_V2_DRIVER=1` or the
project's current convention), using the real fixture STEP files via `import_part`/`create_part`
rather than v1's hand-rolled shell setup where the original test used one.

## 7. Acceptance Criteria

- AC1: All rows in §6 pass as v2 integration tests.
- AC2: F1–F9 (§5) hold, each with at least one dedicated test.
- AC3: **Single-path check** — a code review confirms there is no branch in the new
  implementation that selects between two different geometric derivations for the seam/fold/flat
  pattern based on case detection (e.g. "is this a corner chain vs a straight chain"). Any
  conditional in the new code must be a typed-failure boundary (F5–F7), never a second success
  path.
- AC4: Full existing suite (TS + C++ ctest) shows 0 regressions.
- AC5: `merge_partial_seam_tab_bracket.integration.test.ts` is rewritten per §8.1 — the plate
  authored with its real, unsplit edge, merge still succeeds, same T-shaped result asserted.
- AC6: `fuse_bodies`'s own integration tests still pass unchanged after its contact-detection
  internals are refactored to share F2c's subfunction (§8.2) — its tool contract and behavior
  are untouched.
- AC7: A dedicated test exercises F6's multi-contact placeholder (two parts touching in two
  separate places) and asserts the longer contact region is the one selected.

## 8. Decisions

### 8.1 The pre-split-outline precedent (§2.3) — RESOLVED

The new auto-detected partial-seam capability **replaces** the pre-split-outline workaround.
`merge_partial_seam_tab_bracket.integration.test.ts` is rewritten (not deleted, not kept
alongside as a second valid pattern) to author the plate with its real, unsplit edge and assert
the merge still succeeds — see §2.3, §6, AC5.

### 8.2 `fuse_bodies` vs. `merge_bodies_with_bend` — RESOLVED

Two separate functions, one shared subfunction — not a unification. `fuse_bodies` always produces
a single fused panel with no bend; `merge_bodies_with_bend` always produces a `BendRow` plus two
region panels. What they share is F2/F2c's contact-detection routine (project via
`anchorA.Inverse().Compose(anchorB)`, find where the boundaries coincide) — `fuse_bodies` calls it
and stops at the union when angle≈0 (today's `kNotCoplanar` check becomes this shared routine's
angle≈0 branch instead of a standalone coplanarity check); `merge_bodies_with_bend` calls it and
continues into the splice-and-bend steps for any other angle. This refactor of `fuse_bodies`'s
internals is in scope for this task (§4 non-goals updated accordingly); its external behavior and
tool contract do not change.

### 8.3 Multi-seam disjoint contact (F6) — RESOLVED for this task, phase 2 deferred

**Phase 1 (this task):** when contact is found in more than one physically disjoint region,
deterministically choose the interval with the greatest contact length and merge on it — F6.
This is a documented placeholder: it silently picks a seam the caller might not have meant, which
is an acceptable, explicit trade-off for now rather than a permanent answer.

**Phase 2 (deferred, separate task):** a real disambiguation mechanism —
1. `merge_bodies_with_bend` gains an optional `contact_point_hint` (a world-space point near the
   intended seam) to select among multiple candidates explicitly.
2. When contact is ambiguous and no hint is given, the typed error reports each candidate's real
   geometry (e.g. midpoint, length, angle, in world coordinates) — enough for a client to render
   the options and re-ask the user — plus the exact `contact_point_hint` value that would select
   each one.

Phase 2 needs its own spec (client rendering, exact error payload shape) — noted here so it isn't
lost, not scoped further in this document.

### 8.4 Tolerance reuse — RESOLVED

Reuse `MERGE_EDGE_ALIGNMENT_TOLERANCE_MM` (2mm, `numerical-policy.ts`) as the contact tolerance
for anchor-based seam detection, consistent with `FuseCoplanarParts`'s own
`kImportNoiseToleranceMm`.

## 9. Proposed Design (for reference — subject to the sign-offs above)

Single path. The 2D manufacturing graph remains the sole source of truth throughout — anchors
are consulted only to locate the hinge, never to perform the merge itself, and 3D is only ever
regenerated by the existing generic derivation, never hand-reconstructed.

1. **Locate the hinge from real anchors (2D geometry only, no solid boolean).** Compute `bToA = anchorA.Inverse().Compose(anchorB)` (the same transform `FuseCoplanarParts` already uses) and project `outlineB`'s vertices through it into A's local frame. Walk both outlines' boundaries to find the contact interval — the portion where a segment of (projected) B coincides with a segment of A, within the established tolerance (§8.4). This yields `hingeA`/`hingeB` (two points, in A's 2D frame) and `angleDeg` (the dihedral angle between A's plane and B's plane at that interval), generalizing today's `FindConsecutiveEdgeIndex` (exact caller-given points) into "found by contact," and today's exact-length-match requirement into "the true overlap interval, however long."
   - Zero contact found → F5's typed failure.
   - More than one physically disjoint contact interval → F6: select the longest one deterministically (phase-1 placeholder, §8.3) and proceed.
   - Contact found but angle ≈ 0 (genuinely coplanar) → F7's typed failure, directing to `fuse_bodies`.
2. **Splice the two outlines — a pure 2D operation.** Reuse `part_merge.cc`'s existing closed-form transform-and-splice (`T(edgeB0) = edgeA1`, `T(edgeB1) = edgeA0`), generalized to splice at the F2/F3 contact interval (inserting a new vertex into either outline where the interval's endpoint falls mid-edge) instead of requiring a whole pre-existing consecutive edge on each side. Output: `combinedOutlineA`, plus `hingeA`/`hingeB` for the next step. No bend-allowance arithmetic happens here (F2b) — same division of responsibility as today's `ReconcileOutlines`.
3. **Apply via the existing mutation, unchanged.** `GraphStore.mergePartsWithBend` (re-parent B's rows onto A, alias B, `createBendNode` with the derived `hingeA`/`hingeB`/`angleDeg`/`radiusMm`/`kFactor`) — this layer does not change at all from today's implementation; only what feeds it (step 1+2 instead of caller-supplied `edge_a`/`edge_b`/`angle_deg`) changes.
4. **Regenerate and verify 3D — reusing, not reimplementing.** The standard `evaluatePart`/`constructPart` path (already used by every other v2 tool) reconstructs the merged part's 3D shape from the now-updated graph. F4a's acceptance check: the regenerated position of A's and B's original material must match their real pre-merge anchored positions within tolerance — this is the test that would have caught v1's sign/frame bugs immediately, and it falls out for free from a design that never bypasses the standard derivation.

This is a plan for review, not yet approved for implementation.
