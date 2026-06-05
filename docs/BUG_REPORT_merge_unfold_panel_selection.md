# Bug Report: apply_unfold returns stale panel geometry after merge_bodies_with_bend

**Status:** Ready for MCP team triage  
**Date:** 2026-06-04  
**Component:** Manufacturing Graph + apply_unfold tool  
**Severity:** High (blocks merged-body workflow)

---

## Summary

When a UI flow merges two panels via `merge_bodies_with_bend` and then calls `apply_unfold`, the result unexpectedly shows the flat pattern of the original **panel A only** — without bend geometry or combined dimensions. The underlying manufacturing graph stores both a stale panel A node and a canonical merged node, and incorrect panel selection between them leads to unfolding pre-merge geometry.

---

## Observed Behavior

1. User runs `split_body_by_bends` → produces panels P1, P2.
2. User runs `merge_bodies_with_bend(part_a_id: P1, part_b_id: P2, ...)` → returns `merged_part_id: P1`, `merged_shell_id: <UUID>`.
3. User calls `query_graph(part_id: P1)` → returns graph with two PanelNode entries.
4. User (or UI) selects a panel node from the graph for unfold.
5. User runs `apply_unfold(part_id: P1, panel_id: <selected>)`.

**Result:**
- Flat dimensions match original panel P1 only (e.g., ~200×100 mm).
- No bend line appears in DXF.
- `nominal_thickness_mm` shows expected value.
- `bend_count` = 0 (incorrect; should be 1).

**Expected:**
- Flat dimensions reflect merged geometry (e.g., ~400×100 mm for combined length + bend allowance).
- One bend line marks the seam location in DXF.
- `bend_count` = 1.

---

## Root Cause

The merged manufacturing graph maintains **two PanelNode entries** for different semantic roles:

| Field | Panel A Node | Merged Node |
|-------|--------------|-------------|
| `id` | `panel-a-<prefix>` | `<part_a_id>` (canonical) |
| `bodyId` | Original P1 shell UUID | New merged shell UUID |
| `type` | `PanelNode` | `PanelNode` |

Source: [ts/src/mcp/tools.ts](ts/src/mcp/tools.ts#L2751-L2770)

**The Problem:**
- `apply_unfold` performs a strict node lookup: `if (node.id === panel_id)` — [line 1987](ts/src/mcp/tools.ts#L1987).
- If the UI's `panel_id` parameter matches the Panel A node ID instead of the canonical merged node ID, unfold will use the stale `bodyId`.
- The integration test suite avoids this by explicitly using `panel_id = merged_part_id` — [line 181](ts/tests/integration/unfold_roundtrip.integration.test.ts#L181), which is not discoverable from the merge response alone.

---

## Reproduction Steps

### Prerequisites
- A testcube.step fixture (in `tests/fixtures/`)
- Transaction API available

### Steps
```typescript
const txn = await dispatchTool('begin_transaction', { label: 'merge_unfold_bug' }, config);

// 1. Split cube into panels
const split = await dispatchTool('split_body_by_bends', {
  part_id: cleanedCubeId,
  angle_threshold_deg: 45,
  max_thickness_mm: 2.0,
  transaction_id: txn.transaction_id,
}, config);

const [panelA, panelB] = split.panel_ids;

// 2. Merge
const merged = await dispatchTool('merge_bodies_with_bend', {
  part_a_id: panelA,
  part_b_id: panelB,
  target_edges: ['all'],
  bend_radius: 0.3,
  transaction_id: txn.transaction_id,
}, config);

// 3. Query merged graph
const graphQuery = await dispatchTool('query_graph', {
  part_id: merged.merged_part_id,
}, config);

// 4. (BUG) If UI selects the first PanelNode (assuming it's the unfolded target):
const wrongPanelId = graphQuery.nodes[0]?.id;

// 5. Unfold with wrong panel ID
const unfoldWrong = await dispatchTool('apply_unfold', {
  part_id: merged.merged_part_id,
  panel_id: wrongPanelId,  // ← This is stale panel A, not merged body
  material_id: config.materials[0].id,
  transaction_id: txn.transaction_id,
}, config);

console.log(unfoldWrong.flat_width_mm);     // ~200 (panel A only, wrong)
console.log(unfoldWrong.bend_count);        // 0 (wrong, should be 1)

// 6. (CORRECT) Unfold with canonical merged panel ID:
const unfoldCorrect = await dispatchTool('apply_unfold', {
  part_id: merged.merged_part_id,
  panel_id: merged.merged_part_id,  // ← Same as part_id; resolves canonical node
  material_id: config.materials[0].id,
  transaction_id: txn.transaction_id,
}, config);

console.log(unfoldCorrect.flat_width_mm);   // ~400 (combined, correct)
console.log(unfoldCorrect.bend_count);      // 1 (correct)
```

### Expected vs. Actual
| Aspect | Wrong Panel ID | Correct Panel ID |
|--------|---|---|
| `flat_width_mm` | ~200 | ~400 |
| `bend_count` | 0 | 1 |
| `bend_lines` | (empty) | 1 line @ x≈200 |

---

## Evidence

### Backend Code References

**1. Merged graph construction retains both panels:**
- [ts/src/mcp/tools.ts:2751–2770](ts/src/mcp/tools.ts#L2751) — Panel A and merged panel both added to graph

**2. apply_unfold uses strict node ID matching:**
- [ts/src/mcp/tools.ts:1983–1990](ts/src/mcp/tools.ts#L1983) — Requires exact panel_id match

**3. merge response documents merged_part_id as stable:**
- [ts/src/mcp/tools.ts:2792](ts/src/mcp/tools.ts#L2792) — Comment: "Stable: equals part_a_id input"

**4. Integration tests work because they use the stable ID:**
- [ts/tests/integration/unfold_roundtrip.integration.test.ts:166](ts/tests/integration/unfold_roundtrip.integration.test.ts#L166) — `mergedId = m.merged_part_id`
- [ts/tests/integration/unfold_roundtrip.integration.test.ts:180–181](ts/tests/integration/unfold_roundtrip.integration.test.ts#L180) — Both `part_id` and `panel_id` set to `mergedId`

### Test Run Results

Command:
```bash
npm run test -- tests/integration/unfold_roundtrip.integration.test.ts
```

Result: **7 passed**  
Key cases:
- CASE 1: merge + unfold → `flat=400.47×200mm bends=1` ✓
- CASE 4: 6 paired-cube merges + unfolds → all correct dimensions ✓
- CASE 3: translate + merge + unfold → correct ✓

**Conclusion:** Backend unfold logic is correct when the canonical panel ID is used. The bug manifests when UI incorrectly selects a panel node from the post-merge graph.

---

## Impact

- **Workflow:** Merged body unfolding broken unless user knows to use `merged_part_id` as `panel_id`.
- **UX:** No clear error when wrong panel node is selected; silently produces wrong result.
- **Scope:** Any UI flow that:
  1. Merges bodies via MCP.
  2. Queries the manufacturing graph to populate a panel selector.
  3. Lets user pick a panel for unfold without strict validation.

---

## Proposed Fixes

### Option A: Document & Enforce API Contract (Low Risk)
- Add explicit error in `apply_unfold` to reject non-canonical panel nodes in merged containers.
- Return `canonical_panel_id` in `merge_bodies_with_bend` response.
- Update schema to make this requirement discoverable.

**Pros:** Minimal backend changes; fails fast.  
**Cons:** User must still know to use the canonical ID.

### Option B: Collapse Post-Merge Graph (Medium Risk)
- After merge, remove the stale Panel A node from the graph entirely.
- Retain only the merged node with id = `merged_part_id`.
- Update BendNode references accordingly.

**Pros:** Simpler graph semantics; only one valid unfold target.  
**Cons:** Lose lineage tracking (which panel was A vs. B).

### Option C: Mark Non-Canonical Nodes (Low-Medium Risk)
- Add a `canonical: boolean` flag to PanelNode.
- In `apply_unfold`, reject `canonical: false` nodes with a clear error message.

**Pros:** Retains lineage; fast-fails on wrong selection.  
**Cons:** Requires schema change.

### Recommendation
**Start with Option A** (document + validate). It requires minimal code changes and provides immediate feedback to API users. Escalate to Option B or C if UI integration remains error-prone.

---

## Acceptance Criteria

1. ✅ **Unfold roundtrip tests pass** with canonical merged panel ID (already passing).
2. ⬜ **New test case** that reproduces wrong-panel-id scenario and confirms it now fails with clear error.
3. ⬜ **API response** includes `canonical_panel_id` or similar, making correct choice discoverable.
4. ⬜ **Error handling** in `apply_unfold` rejects non-canonical panels in merged parts with reason.
5. ⬜ **Documentation** updated to call out the requirement (merge → unfold must use `merged_part_id`).

---

## Links

- **Integration tests:** [ts/tests/integration/unfold_roundtrip.integration.test.ts](ts/tests/integration/unfold_roundtrip.integration.test.ts)
- **merge_bodies_with_bend handler:** [ts/src/mcp/tools.ts:2603](ts/src/mcp/tools.ts#L2603)
- **apply_unfold handler:** [ts/src/mcp/tools.ts:1970](ts/src/mcp/tools.ts#L1970)
- **Manufacturing graph types:** [ts/src/manufacturing/graph/types.ts](ts/src/manufacturing/graph/types.ts)
