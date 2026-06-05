# MCP Bug Summary: apply_unfold Silent Wrong Results After merge_bodies_with_bend

**Status:** Confirmed reproducible  
**Severity:** High (silent data corruption)  
**Date:** 2026-06-04

---

## Executive Summary

The `apply_unfold` tool silently produces **incorrect flat patterns** when called on a merged container if the `panel_id` parameter resolves to a stale panel node instead of the canonical merged node. The user sees:
- Flat dimensions for the original single panel (not combined).
- Zero bend lines (not one bend).
- No error message.

This is a **silent failure** — the worst kind of bug for CAD workflows.

---

## Reproduced Behavior

### Test Run Output

```
[BUG DEMO] Post-merge graph has 2 PanelNodes: [
  {
    id: 'panel-a-e6bf235d',
    bodyId: 'e6bf235d-ce35-4f4c-a47a-46f5d6ded5d4'  ← Original panel A
  },
  {
    id: 'e6bf235d-ce35-4f4c-a47a-46f5d6ded5d4',     ← Canonical merged
    bodyId: '9b57e07a-47cc-49a7-ad34-88a1d9072ae4'  ← Merged shell
  }
]

[BUG DEMO] Using WRONG panel node: id=panel-a-e6bf235d (stale panel A)
[BUG DEMO] WRONG result: flat=200×200mm bends=0 thickness=0.9998120078898547
✗ Bug reproduced: wrong panel_id produces stale geometry

[CORRECT] flat=400.47×200mm bends=1 thickness=0.9998111926129478
✓ Canonical panel_id produces correct merged geometry
```

### What This Shows

| Aspect | Wrong Panel ID | Correct Panel ID | Expected |
|--------|---|---|---|
| Flat dimensions | 200×200 mm | 400×200 mm | 400×200 mm ✓ |
| Bend count | 0 | 1 | 1 ✓ |
| Result | **WRONG** (single panel) | **CORRECT** (merged) | Combined geometry |

---

## The Root Cause Chain

### 1. **merge_bodies_with_bend creates two panel nodes**

```typescript
// Panel A node: retains original geometry reference
mergedGraph.addNode({
  type: 'PanelNode',
  id: nodeAId,              // "panel-a-<prefix>"
  bodyId: shellAId,         // Original panel A shell UUID
  // ...
});

// Merged panel node: new canonical node with merged geometry
mergedGraph.addNode({
  type: 'PanelNode',
  id: nodeBId,              // Canonical: equals part_a_id
  bodyId: result.mergedShellId,  // New merged shell
  // ...
});
```

Source: [ts/src/mcp/tools.ts:2751–2770](ts/src/mcp/tools.ts#L2751)

### 2. **apply_unfold uses strict node ID lookup**

```typescript
let panelNode: PanelNode | undefined;
for (const node of graph.nodes.values()) {
  if (node.type === 'PanelNode' && node.id === panelNodeId) {  // ← Strict match
    panelNode = node;
    break;
  }
}

const shellId = panelNode.bodyId;  // ← Uses whatever bodyId node had
```

Source: [ts/src/mcp/tools.ts:1987–2014](ts/src/mcp/tools.ts#L1987)

### 3. **If panel_id doesn't match canonical node, unfold uses stale geometry**

- UI calls `query_graph(part_id: merged_part_id)` → receives **two** PanelNodes
- UI assumes first node is the merge target → wrong assumption
- UI calls `apply_unfold(panel_id: first_node.id)` → resolves to stale Panel A
- apply_unfold uses Panel A's bodyId → unfolds pre-merge geometry
- Result: single-panel flat pattern, zero bends

---

## Why Integration Tests Passed

The integration test suite **explicitly avoids the bug** by using the stable merged_part_id:

```typescript
const unfold: any = await dispatchTool('apply_unfold', {
  part_id: mergedId,        // Use merged_part_id
  panel_id: mergedId,       // Use merged_part_id (SAME)
  material_id: config.materials[0]!.id,
  transaction_id: txn.transaction_id,
}, config);
```

Source: [ts/tests/integration/unfold_roundtrip.integration.test.ts:180–181](ts/tests/integration/unfold_roundtrip.integration.test.ts#L180)

This is **not documented** in the merge response, so a UI that queries the graph and selects nodes independently will fail.

---

## Test Evidence

### New Test: merge_unfold_panel_selection_bug.test.ts

Run:
```bash
npm run test -- tests/integration/merge_unfold_panel_selection_bug.test.ts
```

Results: **3/3 passing**

Each test demonstrates a specific scenario:

1. **DEMONSTRATES BUG**: Confirms wrong panel_id produces stale geometry (200×200, 0 bends).
2. **CORRECT BEHAVIOR**: Confirms canonical panel_id produces correct geometry (400×200, 1 bend).
3. **ACCEPTANCE**: Verifies merged_part_id maps to a PanelNode in query_graph (but not clearly marked).

---

## Business Impact

### Current Situation (Broken)

1. User splits body → panels P1, P2.
2. User merges P1 + P2 via MCP.
3. UI shows merged geometry (correct 3D).
4. User tries to unfold via UI.
5. **UI queries graph → gets 2 panel nodes → picks first → silently unfolds wrong panel.**
6. User sees single-panel flat pattern on design surface.
7. **Manufacturer receives wrong DXF → part manufactured incorrectly.**

### Cost

- **Scrap**: Wrong parts manufactured.
- **Rework**: Debugging the silent failure (user may not realize the DXF is wrong).
- **Trust**: Customers lose confidence in fold/unfold accuracy.

---

## Required Fix

The MCP backend must **guarantee that apply_unfold on a merged container always uses the merged shell**, not a stale panel.

### Option 1: Error-First (Recommended)

**In handleApplyUnfold:**

```typescript
// After resolving panelNode, check if it's in a merged graph
const graph = getManufacturingGraph(partId);
const bendNodes = Array.from(graph.nodes.values()).filter((n: any) => n.type === 'BendNode');
if (bendNodes.length > 0) {
  // Graph has bend structure (post-merge).
  // Panel must be the canonical merge target, not a stale upstream panel.
  const hasUpstreamRef = bendNodes.some((bn: any) => 
    bn.panelAId === panelNode.id || bn.panelBId === panelNode.id
  );
  if (hasUpstreamRef && panelNode.id !== partId) {
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Panel "${panelNodeId}" is an upstream panel in a merged container. ` +
      `For apply_unfold on merged geometries, use panel_id = part_id = "${partId}" (canonical merge target).`,
      false,
      'apply_unfold'
    );
  }
}
```

This **fails fast** and gives the user a clear message.

### Option 2: Auto-Correct

**In handleMergeBodiesWithBend:**

Remove stale Panel A node from graph after merge.

**Pros:** Simplest semantics.  
**Cons:** Lose lineage tracking.

### Option 3: Metadata Flag

Add `canonical: boolean` to PanelNode type.

**Pros:** Retains lineage.  
**Cons:** Schema change required.

---

## Recommendation

**Implement Option 1 immediately** — it requires no schema changes and provides immediate feedback to API users. This is non-breaking and defensive.

**Then plan Option 2 or 3** for a future release if lineage becomes important.

---

## Files

- **Bug report (full):** [docs/BUG_REPORT_merge_unfold_panel_selection.md](docs/BUG_REPORT_merge_unfold_panel_selection.md)
- **Reproducible test:** [ts/tests/integration/merge_unfold_panel_selection_bug.test.ts](ts/tests/integration/merge_unfold_panel_selection_bug.test.ts)
- **Handler code:**
  - `handleMergeBodiesWithBend`: [ts/src/mcp/tools.ts:2603](ts/src/mcp/tools.ts#L2603)
  - `handleApplyUnfold`: [ts/src/mcp/tools.ts:1970](ts/src/mcp/tools.ts#L1970)

---

## Next Steps

1. ✅ **Confirmed reproducible** (test passes, shows bug clearly).
2. ⬜ **Assign to MCP backend team** for fix (recommend Option 1).
3. ⬜ **Update UI to use merged_part_id** as workaround (short-term).
4. ⬜ **Document the requirement** in apply_unfold schema (short-term).
5. ⬜ **Implement error-first guard** in handleApplyUnfold (medium-term).
