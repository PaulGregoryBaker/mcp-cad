# Bug Report: `import_part` does not create one Part per decomposed panel (v1 parity gap)

> **⚠ REASSESSED 2026-07-30 — NOT A BUG. Closed.** The premise below (each decomposed panel
> should get its own top-level `part_id`) doesn't hold once you check whether the panels are
> actually independent: re-querying the same repro fixture confirms the two `region_panel`s are
> joined by a real `bend` (`820df01f... -> 8c875a49... @ -90deg`) — i.e. they are one
> continuous physical piece of folded sheet metal, not two separate objects. v1 also recorded
> this connection (its own BendNode graph), it just *additionally* gave each panel its own
> top-level Part id, which was the redundant/less-accurate modeling choice, not v2's single-part
> design. Representing a connected, foldable unit as one Part with derived `region_panel`s and a
> `bend` is the more physically correct model. No server-side change needed. The original
> report is left below unedited for reference — the investigation and code pointers are still
> accurate, only the "this is wrong" conclusion was wrong.
>
> Form.AI.tion's `loadAssembly` should build **one workspace Part per v2 `part_id`** (already
> implemented that way), not one per `region_panel`. Per-panel detail (region panels, bends,
> findings) belongs in the manufacturing-graph flat-panel view, not the top-level Part list —
> which is exactly what that feature already does.

**Status:** ~~Ready for triage~~ Closed — not a bug (see above)
**Date:** 2026-07-30
**Component:** v2 `import_part` (`ts/src/v2/graph/evaluate-client.ts`)
**Severity:** ~~High~~ N/A
**Reported during:** Form.AI.tion UI session porting `loadAssembly()` off v1's decommissioned
`clean_geometry`/`decompose_volume` chain onto v2's `import_part`.

---

## Summary

In v1, importing a STEP file produced **one top-level Part per decomposed panel** —
`decompose_volume` returned `parts: [{id, mesh_url}, ...]`, one entry per panel, each
independently selectable in the UI and each with its own mesh. The UI (Form.AI.tion) expects
v2's `import_part` to behave the same way: many `part_id`s, each corresponding to one
decomposed panel.

It does not. `import_part` internally runs the identical panel decomposition
(`splitBodyByBends`) v1's `decompose_volume` used, but then reconciles all resulting panels
into **one** `GraphPart`, exposing them only as `region_panel` rows nested one level down
inside that single part's graph. `graph://parts` shows exactly one entry after import,
regardless of `panel_count`.

---

## Observed Behavior (empirically verified)

Ran `import_part` directly (bypassing the MCP transport, calling `dispatchGraphTool` on a
fresh `GraphStore`) against `cpp/tests/fixtures/l_bracket_corner_90deg.stp` (a 2-panel, 1-bend
fixture):

```
import_part result: {
  "part_id": "3c434645-f7cb-4e2f-8fa9-f58dde54586c",
  "panel_count": 2,
  "protrusion_count": 0,
  "bend_count": 1,
  "notes": [],
  "protrusion_part_ids": []
}

graph://parts: {
  "parts": [
    { "partId": "3c434645-f7cb-4e2f-8fa9-f58dde54586c", ... }
  ]
}
```

Only **one** entry in `graph://parts`, despite `panel_count: 2`. Reading
`graph://part/3c434645.../full` confirms the second panel exists only as a `region_panel`:

```
"regionPanels": [
  { "regionPanelId": "bcf0aa01-...", "partId": "3c434645-...", "label": "root", ... },
  { "regionPanelId": "7dfec5f3-...", "partId": "3c434645-...", "label": "region-7dfec5f3", ... }
],
"bends": [
  { "bendId": "1e910d22-...", "parentRegionPanelId": "bcf0aa01-...", "childRegionPanelId": "7dfec5f3-...", ... }
]
```

Both `region_panel` rows carry the **same** `partId`. There is no second `part_id`, and no
per-panel mesh: `graph://part/{id}/mesh` is part-scoped only (confirmed in
`ts/src/v2/resources/graph.ts`'s `readMesh`, no `region_panel_id` parameter exists), and the
underlying glTF export (`cpp/src/geometry/geometry_service_export.cc:1526-1528`) emits a
single scene/node/mesh/primitive for the whole constructed solid — there is no per-panel
segmentation in the exported geometry either.

**Expected** (per v1 parity, Form.AI.tion's stated requirement): `import_part` on this same
2-panel fixture should result in **two** `part_id`s in `graph://parts`, each independently
resolvable via `graph://part/{id}/full`, `graph://part/{id}/mesh`, etc. — "the UI should look
exactly the same [as v1], while maintaining a single mesh per part."

---

## Root Cause

`importPart()` (`ts/src/v2/graph/evaluate-client.ts:477-580`) calls `splitBodyByBends` (same
panel/bend/protrusion detection v1's `decompose_volume` used), then walks the reconciled
`graph.bends` and calls `store.createBendNode(...)` for each — and per `14-graph-schema.md
§2.1.1`, `create_node(kind=bend)` **is** the split operation that mints a new `region_panel`
child, not a new `part`. Only `store.createPart(...)` mints a new top-level `part_id`, and that
happens exactly once per `import_part` call (plus once per detected protrusion — protrusions
*do* correctly become independent parts, per the comment at
`evaluate-client.ts:501-520`).

This is not an accidental slip in `importPart` specifically — it is a direct, faithful
implementation of the schema exactly as `14-graph-schema.md` and `15-mcp-contract.md`
describe it: **"one outline, one thickness, one material" per Part, with `region_panel`s as
derived, non-independent zones of that one outline** (`manufacturing_graph.dart`'s own header
comment on the Form.AI.tion side quotes this verbatim: *"GraphPart-centric single-outline
model... Replaces v1's flat PanelNode/BendNode/JoinNode/CutNode union entirely"*). That
single-outline-per-part design was a deliberate Phase 2 decision (reviewed & approved
2026-07-20, `06-plan.md` Phase 2 exit criteria), not an unreviewed default.

**In other words: this ticket is a request to reopen and reverse a reviewed architectural
decision, not a straightforward implementation bug.** Flagging that explicitly so triage
weighs it correctly — the fix isn't "make `import_part` do what it was supposed to already
do," it's "decide whether bend-created region panels should mint new parts instead of derived
zones, contradicting 14 §0/§2's core model."

---

## Reproduction Steps

```typescript
import { GraphStore } from './src/v2/graph/store';
import { dispatchGraphTool } from './src/v2/tools/graph';
import { readGraphResource } from './src/v2/resources/graph';

const store = new GraphStore();
const result = dispatchGraphTool(store, 'import_part', {
  file: 'cpp/tests/fixtures/l_bracket_corner_90deg.stp', // panel_count: 2, bend_count: 1
});
console.log(result); // one part_id, panel_count: 2

const parts = readGraphResource(store, 'graph://parts');
console.log(parts); // still only one entry — the bug
```

---

## Impact

- Form.AI.tion's workspace part tree / 3D viewport can no longer show or independently select
  individual panels after import — every panel of a multi-panel part collapses into one
  workspace `Part`, a UX regression from v1 (tracked as the blocking issue for porting
  `loadAssembly`, `docs/V1_DECOMMISSION_CHECKLIST.md` on the Form.AI.tion side).
- Any other v2 consumer expecting `decompose_volume`-style multi-part output for a folded
  sheet-metal part hits the same gap.

---

## Proposed Fixes

### Option A: `create_node(kind=bend)` mints a new Part, not a region_panel (High risk)
Change the split operation itself so each panel becomes its own `part_id`. Directly reverses
14 §2.1.1's "bend split = new region_panel" design — touches the schema, `create_node`,
`delete_node`(bend)'s merge-is-the-inverse guarantee, `move_edge`'s one-shared-ring invariant,
and every resource/mesh path that assumes one outline per part. Large blast radius; likely
needs its own design pass, not a quick patch.

### Option B: `import_part` post-processes region_panels into separate Parts (Medium risk)
After reconciliation, instead of (or in addition to) building one `GraphPart` with N
`region_panel`s, call `store.createPart(...)` once per detected panel — same treatment
protrusions already get. Keeps the bend-split-is-a-region_panel primitive intact for
direct graph authoring (`create_node(kind=bend)` called standalone still behaves per 14
§2.1.1), but `import_part` specifically would produce v1-shaped output. Needs a decision on
how bends between these new "sibling" parts are represented — v2 currently has no "bend
between two parts" concept (`merge_bodies_with_bend` is the closest existing primitive, but it
consumes two *already-separate* parts, it doesn't produce them).

### Option C: Keep one part_id, add per-region-panel mesh export (Low-medium risk, partial fix)
Leave the graph model as-is (matches the approved schema); instead give the UI enough to fake
v1's per-panel selection: extend `graph://part/{id}/mesh` (or add a new resource) to accept a
`region_panel_id` and export just that panel's geometry as its own GLB, using
`graph://part/{id}/boundary`'s already-existing per-region `bottomFace`/`topFace` data as the
source. Does **not** give Form.AI.tion separate `part_id`s (workspace tree grouping still needs
a client-side region-panel-as-pseudo-Part workaround), but does restore per-panel 3D
selectability without touching the schema.

### Recommendation
No strong recommendation from this side — Option A/B genuinely reopen an approved design
decision (14-graph-schema.md Phase 2), which only the team that reviewed that decision should
re-litigate. Option C is schema-safe but only partially satisfies the stated requirement (still
one `part_id`, UI-visible workspace-tree grouping would need its own workaround). Flagging for
your call.

---

## Links

- `import_part` implementation: `ts/src/v2/graph/evaluate-client.ts:477-580`
- Bend-split-mints-region_panel design: `rebuild/14-graph-schema.md §2.1.1`
- v2 contract for `import_part`/`create_node`: `rebuild/15-mcp-contract.md §4.1/§4.3`
- Mesh resource (part-scoped only, no per-region-panel param):
  `ts/src/v2/resources/graph.ts` `readMesh`/`ensureMeshBlobFresh`
- Single-primitive glTF export (no per-panel mesh segmentation):
  `cpp/src/geometry/geometry_service_export.cc:1526-1528`
- Form.AI.tion side context: `docs/V1_DECOMMISSION_CHECKLIST.md` (this repo's own
  `docs/UI_MANUFACTURING_GRAPH_IMPACT.md` predates this schema entirely — not a reliable
  reference for current v2 behavior)
