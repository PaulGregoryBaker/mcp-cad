# Persistence Model: What Persists, What Changes

## Executive Summary

Core Principle: once a part_id exists, that part_id is the stable UI identifier.

UI rule: the UI only needs part_id.

Ownership rule for combine operations:
- fuse_bodies: preserves the first item in tools as preserved_part_id.
- merge_bodies_with_bend: preserves part_a_id as preserved_part_id.

apply_unfold rule:
- pass part_id and panel_id as the same value (the preserved part_id).

---

## Identity Hierarchy

1. part_id (stable, UI-facing)
- definition: identifier for a manufacturing part in session scope.
- key property: stable across transforms, fuse, and merge ownership transitions.

2. geometry id (internal, volatile)
- definition: backend geometry identifier used by the geometry engine.
- key property: may change when geometry is transformed or regenerated.
- UI guidance: do not persist or key UI state by this value.

3. node id (graph-internal)
- definition: identifier for a graph node.
- key property: stable inside a graph but still backend-implementation detail.
- UI guidance: treat as internal unless explicitly needed for diagnostics.

---

## Persistence Across Operations

| Operation | Preserved part_id | Consumed part_ids |
|-----------|-------------------|-------------------|
| split_body_by_bends | each returned panel id | none |
| remove_protrusions | each returned protrusion id | none |
| translate/rotate/mirror/scale | same input part_id | none |
| fuse_bodies(tools=[A,B,...]) | A (first in list) | B,... |
| merge_bodies_with_bend(part_a_id=A, part_b_id=B) | A | B |

Consumed part_ids remain valid aliases and resolve to the preserved part graph.

---

## The _parts Map

### Structure
```typescript
_parts: Map<string, ManufacturingGraph> = new Map()
```

### Keys
- Primary key: part_id (stable identifier)
- Aliases: consumed part_ids continue to resolve to the preserved graph after fuse/merge

### Behavior After Transform
When `translate_body(part_id)` returns a new `solid_id`:
1. Original `part_id` still maps to the graph ✅
2. New `solid_id` is **also** registered as an alias pointing to the same graph ✅
3. Both can be used to look up the manufacturing graph

---

## Manufacturing Graph

### What it Contains
```typescript
{
  nodes: Map<NodeId, PanelNode | BendNode | JoinNode | CutNode>
  edges: Map<NodeId, Set<NodeId>>
  dirtyNodes: Set<NodeId>
  shapeDxf: string | null  // Flat pattern DXF
  bodyId: string           // Current shell UUID
  canonical: boolean       // Is this the unfold target?
}
```

### What Persists
- **Node structure**: Panel nodes, bend nodes, etc. persist
- **Node IDs**: Stable identifiers within the graph
- **shapeDxf**: DXF content persists (updated by unfold/merge operations)
- **canonical flag**: Indicates unfold targets (should only be true for one path in merged structures)

### What Changes
- **bodyId**: Points to current shell UUID (updated after each transform)
- **dirty flags**: Updated as geometry is modified
- **edges**: May change when operations affect topology

---

## apply_unfold Contract

Input contract:
- part_id: preserved part id
- panel_id: same value as part_id

No UI fallback behavior is expected or required.

### Why Two Match Criteria?
- **Stable node ID**: User passes the original panel_id from creation
- **Current bodyId**: User passes the solid_id returned by a transform operation
- **canonical check**: Prevents accidentally unfolding stale upstream panels

### Example Scenarios

**Scenario 1: Direct unfold (no transform)**
```
part_id: "740f6db6-..."
panel_id: "740f6db6-..." (original node ID)
Lookup: Matches node.id === panel_id ✅
Result: Unfold succeeds
```

**Scenario 2: Unfold after translate**
```
part_id: "740f6db6-..."
Initial shell: "abc-123"

translate_body(targets: ["740f6db6-..."]) 
→ returns solid_id: "abc-456"

apply_unfold(part_id: "740f6db6-...", panel_id: "abc-456")
Lookup: Matches node.bodyId === "abc-456" AND canonical === true ✅
Result: Unfold succeeds
```

**Scenario 3: Unfold after merge (should fail)**
```
merge_bodies_with_bend(part_a, part_b)
→ creates merged_part_id

panel_a was upstream in merge (canonical: false)
apply_unfold(merged_part_id, panel_a_id)
Lookup: Matches node.id === panel_a_id BUT canonical === false ❌
Result: Error - "non-canonical upstream panel"
Correct usage: apply_unfold(merged_part_id, merged_part_id)
```

---

## Recommendations for UI

### What to Display/Persist
1. **part_id** - Primary key for users (show in UI)
2. **Current mesh URL** - Display latest geometry (uses current solid_id)
3. **Part history** - Breadcrumb of operations applied
4. **Manufacturing graph** - Show panel structure, bends, cuts

### What NOT to Display as Stable IDs
- Do not show or store backend geometry ids as stable keys.
- Do not key UI state by returned solid_id values.
- Use part_id everywhere as the single durable reference.

### State Management Pattern
```typescript
// UI State: Use part_id as the stable key
interface PartRef {
  part_id: string;        // STABLE - persists
  label: string;          // User-friendly name
  created: Date;
  last_modified: Date;
  current_solid_id?: string;  // VOLATILE - may change
  mesh_url?: string;           // Regenerate from solid_id
}

// When user selects a part for unfold:
async function unfold(partRef: PartRef, panelNodeId: string) {
  // Always use part_id (stable), panel_id is from graph (stable)
  return applyUnfold({
    part_id: partRef.part_id,
    panel_id: panelNodeId,
    // NOT: panel_id: partRef.current_solid_id (wrong!)
  });
}
```

### Ownership Clarification (UI-facing)
- fuse_bodies response now includes preserved_part_id and consumed_part_ids.
- merge_bodies_with_bend response now includes preserved_part_id and consumed_part_ids.
- UI should always continue with preserved_part_id for subsequent operations.

---

## Summary: The Contract

**For end users and UI developers:**

Once you create a part, use part_id as the only persistent UI identifier. For combine operations, continue from preserved_part_id and treat consumed_part_ids as aliases.

---

## Open Questions / Future Clarifications

1. **Session persistence**: Do part_ids persist across sessions (in database)?
   - Currently: No (session-scoped)
   - Future: Depends on Dolt persistence layer

2. **Rollback semantics**: When rolling back a transaction, are part_ids stable?
   - Currently: Yes, but graph state reverts
   - Ensure: UI doesn't show stale mesh URLs after rollback

3. **Cloning/Versioning**: If user clones a part, new part_id or same?
   - Currently: Not implemented
   - Recommendation: New part_id for clones (they're independent parts)
