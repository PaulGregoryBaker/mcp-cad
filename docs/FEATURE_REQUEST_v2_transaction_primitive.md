# Feature Request: v2 has no transaction/atomic-mutation primitive — the Flutter client's "feature branch" workflow currently stubs this client-side only

**Status:** Resolved (2026-08-06) — see note at the bottom
**Date:** 2026-08-06
**Component:** v2 MCP tool surface (`ts/src/v2/tools/graph.ts` and friends)
**Reported by:** Paul, via Form.AI.tion's v1→v2 alignment audit

---

## Summary

v1 had `begin_transaction` / `commit_transaction` / `rollback_transaction`: open a transaction, thread its `transaction_id` through a sequence of mutating tool calls, then either commit them together or roll all of them back atomically. v2 has no equivalent tool at all — confirmed by querying the live v2 server's own `tools/list` directly (not by reading source) and additionally by calling `begin_transaction` against it, which returns:

```json
{"code":"INTERNAL_ERROR","message":"Unknown v2 tool: begin_transaction","recoverable":false}
```

None of the 20 real v2 tools (`create_node`, `update_node`, `delete_node`, `merge_bodies_with_bend`, `cut_panel`, `add_flange`, `rip_edge`, `generate_reliefs`, `split_body_by_plane`, etc.) accept a `transaction_id` parameter in their schemas either — each mutation is presumably applied immediately and individually.

The two tools that look adjacent — `commit` and `restore` — are Dolt snapshot/checkout: `commit` records the *current* graph state as a named version; `restore` resets to a *prior* commit. Neither wraps a still-in-progress sequence of mutations, and neither takes anything resembling a `transaction_id`. They answer "save/reload a checkpoint," not "stage several changes, then all-or-nothing commit or discard them."

---

## Why this matters to the client

Form.AI.tion has a user-facing "feature branch" workflow (visible in the UI as `TransactionStatusBar`/`Rollback Timeline`): the user's edits get staged under a branch, and can be committed as a new revision or discarded entirely. This was built directly on top of v1's begin/commit/rollback trio.

Today, with no v2 equivalent, the client has stubbed the whole thing locally: `beginSessionTransaction()` mints a local pseudo-ID with no network call, `commitSessionTransaction()`/`rollbackSessionTransaction()` skip the server call and only touch client-side state (the local revision timeline / snapshot files). This keeps the client-visible UX working, but it means "roll back this branch" only ever discards what the *client* remembers — it has no way to undo the individual graph mutations already applied server-side (`create_node`, `merge_bodies_with_bend`, etc.) during that branch, since each one took effect immediately and permanently the moment it was called.

In practice: if a user stages five bend edits and then discards the branch, the client's own state reverts, but the server's `GraphStore` still has all five edits applied. The next read of that part's graph will disagree with what the UI shows until something re-syncs it.

---

## Possible directions (not proposing a specific design)

- Add an explicit v2 transaction primitive — `begin`/`commit`/`rollback` (or similar) that a sequence of mutating calls can be scoped under, mirroring v1's model but adapted to v2's graph-authoring tools.
- Or, if `commit`/`restore` are meant to be the *intended* replacement for this use case: some guidance on the intended flow would help — e.g. does "discard a branch" map to `restore`-ing to the commit taken just before the branch started? That would require the client to always `commit` before opening a branch, purely to have a restore point, which is a workable pattern but a different one than what's built today.
- Or, if atomic multi-mutation staging isn't a v2 goal at all (each mutation is meant to be its own immediately-durable unit), that's a legitimate design position too — it would just mean the client's "feature branch" UX needs to be rethought around individual-mutation undo (if any) rather than batch commit/rollback.

Flagging the gap and its concrete impact rather than picking a direction — this is a call for whoever owns the v2 graph-mutation/versioning model, not something to guess at from the client side.

---

## Links

- Confirmed via live introspection (`tools/list` + a direct `begin_transaction` call against `node ts/dist/v2/server.js`), not source reading.
- Client-side stub: `lib/core/providers/mcp_session_provider.dart`'s `beginSessionTransaction()` / `commitSessionTransaction()` / `rollbackSessionTransaction()` in the Form.AI.tion repo.
- Related: `docs/V1_DECOMMISSION_CHECKLIST.md`'s note that "the uncommitted working set IS the transaction" — this request is asking what that means operationally for discard/rollback.

---

## Resolution (2026-08-06)

`rebuild/02-requirements.md` B5d already decided this on 2026-07-19: no
separate transaction verbs — the uncommitted working set on a part *is* the
transaction, and `restore` absorbs `rollback`. That design was correct; the
**implementation** just didn't match it. `restore` was minting a brand-new
`part_id` from the historical snapshot instead of resetting the existing
part's live state in place, so there was no operation that actually did
"undo my edits on this part."

Fixed: `restore(part_id, commit_hash)` now resets that exact `part_id`'s
live working state to the given commit — no new part is created. `commit`
also now accepts an empty diff (`--allow-empty`), so a checkpoint commit
with nothing changed yet always succeeds.

**The client's feature-branch flow maps onto this directly** (this was
"possible direction #2" above, and it works once `restore` is correct):

1. `commit(part_id, "checkpoint before edits")` → `commit_hash` H, right
   before opening a branch (safe even if nothing changed since the last
   commit).
2. Stage edits as normal mutating tool calls (`create_node`,
   `merge_bodies_with_bend`, etc.) — each applies immediately, same as today.
3. Discard the branch: `restore(part_id, H)` — resets this `part_id` back to
   exactly how it looked at the checkpoint. Keep the branch: `commit(part_id,
   "describe the change")` instead.

No new MCP tools were added. See `ts/src/v2/tools/graph.ts` (`handleRestore`),
`ts/src/v2/graph/store.ts` (`GraphStore.restorePart`), and
`ts/src/v2/persistence/dolt-store.ts` (`loadPartAtCommit`) for the fix.

Known gap, not fixed here: `commit`/`restore` are scoped to one `part_id`,
not the whole graph, so restoring part A doesn't touch any other part that
references it (e.g. one fused into A after the checkpoint) — there's no
cross-part atomicity in v2 today.
