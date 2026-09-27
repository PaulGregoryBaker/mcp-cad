# v2 persistence

Base commit: `7717022` (branch `011-graph-driven-geometry`), branched as
`010-dolt-graph-persistence`. Specification: Form.AI.tion
`specs/010-dolt-graph-persistence/` (plan, research R-014–R-016, data-model,
contracts/mcp-persistence-contract.md).

The manufacturing graph is the only persisted definition of a project. It lives
in **normalised Dolt tables** (one database per project), following
`rebuild/14-graph-schema.md` §2 (R-016).

**Who owns what** (R-014):
- The client application decides *where* a project lives: a storage account
  name plus a database name.
- This server owns everything else:
  - the **credentials**, held in its own account setup (`config.yaml`
    `storage_accounts` plus the OS keyring or env references; never received
    through tool calls);
  - the schema and migrations;
  - every read and write.

**Commit model** (R-015, B5d):
- Every mutation writes its changed rows, plus one `action_log` row, to the
  bound branch's **working set** in a single SQL transaction.
- **Revisions are created only by an explicit `commit`.**
- Undo applies the newest uncommitted `action_log.undo_delta`.
