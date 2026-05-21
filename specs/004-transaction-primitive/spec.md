# Feature Specification: Explicit Transaction Primitive (Phase 0 of Semantic CAD MCP)

**Feature Branch**: `004-transaction-primitive`

**Created**: 2026-05-21

**Status**: Draft

---

## Background

Every mutating MCP tool today creates its own snapshot and returns a `rollback_token`
(see [cpp/src/geometry/snapshot.hpp](../../cpp/src/geometry/snapshot.hpp) and Constitution
Principle IV). This works for single-tool rollback but cannot group multiple operations
into one atomic unit, and it discards the OCCT shape-history records (`Modified`,
`Generated`, `IsDeleted`) that the upcoming Semantic Mapping Layer needs.

This feature introduces an **explicit transaction primitive** that wraps the existing
snapshot mechanism and captures OCCT shape history per transaction. It is Phase 0 of the
Semantic CAD MCP plan in [SemanticCad/MVP.md](../../SemanticCad/MVP.md) — the prerequisite
for Phase 1, which adds semantic identities and the Mapping Layer on top.

Nothing changes for callers that ignore the new tools — existing tools continue to work
unchanged when called without a `transaction_id`.

---

## User Scenarios & Testing

### User Story 1 — Multi-operation atomic transaction (Priority: P1)

An AI agent (or user) is composing a multi-step modification: decompose a body, synthesize
joints between the resulting panels, then apply unfolds. They want all three operations to
either succeed together or be reversed together — a single rollback that undoes the whole
sequence, not three separate rollback tokens.

**Why this priority**: This is the primary motivation. Without it, the agent must manually
chain rollback tokens, which leaks geometry implementation details into agent prompts and
makes failure recovery brittle.

**Independent Test**: Call `begin_transaction`, run two mutating operations in sequence,
then `rollback_transaction`. Verify the geometry registry is identical to its state before
`begin_transaction`.

**Acceptance Scenarios**:

1. **Given** an active session with one loaded solid, **When** `begin_transaction` is
   called, then `decompose_volume` runs, then `synthesize_joints` runs, then
   `rollback_transaction` is called, **Then** the session contains only the original solid
   — all panels and joint geometry are gone.

2. **Given** the same setup, **When** `commit_transaction` is called after the two
   operations instead of rollback, **Then** the panels and joints persist and the
   transaction can no longer be rolled back.

3. **Given** a transaction is active, **When** `commit_transaction` is called for a
   `transaction_id` that doesn't match the active one, **Then** the tool returns
   `TRANSACTION_NOT_FOUND` and the active transaction is unaffected.

---

### User Story 2 — Existing tools accept `transaction_id` without breaking (Priority: P2)

A caller using the existing tools today (single-op + per-call rollback_token) must keep
working without source changes. A caller that opts in by passing `transaction_id` gets the
new transactional behaviour.

**Why this priority**: Required by Constitution Principle VII (MVP scope discipline) —
no breaking changes during a phased rollout. Every existing integration test must continue
to pass without modification.

**Independent Test**: Call `split_body_by_bends` without a `transaction_id` (existing
contract). Verify the response still includes a `rollback_token` and the `rollback` tool
still restores state via that token.

**Acceptance Scenarios**:

1. **Given** no active transaction, **When** a mutating tool is called without
   `transaction_id`, **Then** it behaves identically to today: creates an implicit
   single-op snapshot and returns `rollback_token`.

2. **Given** an active transaction, **When** a mutating tool is called with the matching
   `transaction_id`, **Then** it executes against the working state without creating a new
   snapshot, and its `rollback_token` field in the response equals the `transaction_id`.

3. **Given** an active transaction, **When** a mutating tool is called with no
   `transaction_id` argument, **Then** it auto-joins the active transaction (the same
   behaviour as case 2). This keeps existing one-line scripts working when wrapped in a
   transaction.

4. **Given** an active transaction, **When** a mutating tool is called with a
   `transaction_id` that does not match the active transaction, **Then** the tool returns
   `TRANSACTION_MISMATCH` and the active transaction is unaffected.

---

### User Story 3 — OCCT shape history is captured per transaction (Priority: P3)

The upcoming Semantic Mapping Layer (Phase 1) must remap face-group bindings after every
mutation. To do that it needs the OCCT `Modified` / `Generated` / `IsDeleted` records that
the kernel produces during boolean cuts, prism builds, and fillets. Today these records
are produced inside `splitBodyByBends` (and similar tools) and then discarded.

**Why this priority**: This is infrastructure-only for Phase 0 — no caller consumes the
data yet. But shipping the transaction primitive without it would force re-instrumenting
every tool again in Phase 1.

**Independent Test**: Open a transaction, call `split_body_by_bends`, then call
`get_transaction_history` (new tool). Verify the response contains a non-empty list of
shape-history records, each with a `verdict` (`modified` / `generated` / `deleted`) and
an `original_id` / `new_id` pair.

**Acceptance Scenarios**:

1. **Given** an active transaction, **When** `split_body_by_bends` is called on a hollow
   cube, **Then** `get_transaction_history` returns at least one record per primary face
   in the original solid, all tagged with `operation_label: "split_body_by_bends"`.

2. **Given** a transaction with one operation, **When** `commit_transaction` is called,
   **Then** `get_transaction_history` on that transaction id still returns the captured
   records (commit retains history; only rollback discards it).

3. **Given** a transaction with one operation, **When** `rollback_transaction` is called,
   **Then** `get_transaction_history` on that transaction id returns
   `TRANSACTION_NOT_FOUND` (rollback discards history along with the snapshot).

---

### Edge Cases

- Calling `begin_transaction` while one is already active → return `TRANSACTION_ALREADY_ACTIVE`
  with the existing transaction_id in the error payload. MVP is single-session, so nested
  transactions are out of scope.
- Calling `commit_transaction` or `rollback_transaction` with no transaction ever opened →
  return `TRANSACTION_NOT_FOUND`.
- Calling a non-mutating tool (e.g. `compute_mass_properties` once it exists, or
  `evaluate_manufacturability`) within an active transaction → no-op for the transaction
  state; the tool reads working state and returns.
- Process exit while a transaction is active → no persistence in Phase 0; state is lost,
  matching today's session-scoped behaviour. Phase 1 introduces Dolt and durable state.

---

## Requirements

### Functional Requirements

- **FR-001**: The MCP server MUST expose `begin_transaction`, `commit_transaction`, and
  `rollback_transaction` tools matching the schemas in
  [SemanticCad/TransactionBCMCP.md §1](../../SemanticCad/TransactionBCMCP.md).
- **FR-002**: Every existing mutating tool listed in
  [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts) MUST accept an optional `transaction_id`
  input. When omitted, behaviour is identical to today.
- **FR-003**: When a transaction is active and a mutating tool is called (with or without
  matching `transaction_id`), the tool MUST NOT create a new snapshot. It MUST execute
  against the working state established by `begin_transaction`.
- **FR-004**: `commit_transaction` MUST discard the pre-snapshot for that transaction.
  After commit, the changes cannot be reverted via the existing `rollback` tool.
- **FR-005**: `rollback_transaction` MUST restore the snapshot taken by `begin_transaction`,
  reverting all geometry-registry changes made during the transaction. It MUST also discard
  the captured shape-history records.
- **FR-006**: Every mutating C++ entry point MUST capture OCCT
  `Modified(s) -> [s']` / `Generated(s) -> [s']` / `IsDeleted(s)` records into the active
  transaction's `ShapeHistory` map, tagged with an `operation_label`.
- **FR-007**: A new `get_transaction_history` MCP tool MUST return the captured shape
  history records for a transaction. The tool is read-only.
- **FR-008**: Constitution Principle IV is preserved: `rollback_token` in existing tool
  responses MUST equal the active transaction id when one is active, and the implicit
  per-call snapshot id when none is active. The existing `rollback` tool MUST continue to
  work in both cases.
- **FR-009**: All new error paths MUST return structured errors per Constitution
  Principle VI.

### Key Entities

- **Transaction**: An open lifecycle around one or more mutating operations. Identified by
  a ULID string of the form `transaction://<ulid>`. Wraps exactly one `SnapshotId` from
  [snapshot.hpp](../../cpp/src/geometry/snapshot.hpp).
- **ShapeHistory record**: One row capturing an OCCT shape-history verdict, the
  original shape ID, the new shape ID (NULL for `deleted`), and the operation label.
  Stored per-transaction in a TS-side map for Phase 0; persisted to Dolt in Phase 1.
- **Active transaction**: At most one transaction may be active per session at a time
  (Constitution Principle VII — single-session MVP).

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: A sequence of `begin_transaction` → `decompose_volume` → `synthesize_joints`
  → `rollback_transaction` leaves the session geometry registry byte-identical to its
  pre-transaction state (verified by comparing solid/shell ID counts and snapshot
  serialisation hash).
- **SC-002**: All existing integration tests in
  [ts/tests/integration/](../../ts/tests/integration/) pass without any source-code
  changes to the tests themselves.
- **SC-003**: After `split_body_by_bends` runs inside a transaction on a hollow cube,
  `get_transaction_history` returns at least 6 records (one `modified` or `generated`
  per original face of the cube).
- **SC-004**: Opening two transactions concurrently returns `TRANSACTION_ALREADY_ACTIVE`
  on the second `begin_transaction` call.
- **SC-005**: The new tools add no more than 5% overhead to a 10-operation test sequence
  vs. today's implicit-per-op snapshot model (measured in wall-clock time on the
  `INF-03` golden-path test).

---

## Assumptions

- Single-session, single-active-transaction. Multi-session and nested transactions are
  deferred (Constitution Principle VII).
- Phase 0 keeps all transaction state in memory. Dolt persistence is Phase 1
  ([SemanticCad/Persistence-Dolt.md](../../SemanticCad/Persistence-Dolt.md)).
- ULIDs are generated client-side in the TS layer using an existing dependency
  (`ulid` npm package — to be added).
- `get_transaction_history` is exposed as an MCP tool in Phase 0 because the Mapping
  Layer (Phase 1) does not yet exist to consume it. In Phase 1 it remains exposed but is
  superseded by `semantic_lineage` for most agent use cases.
- The list of "mutating tools" that need `transaction_id` support is the set already
  marked `mutating` in [ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts):
  `clean_geometry` (load only — not mutating in the transactional sense; excluded),
  `decompose_volume`, `synthesize_joints`, `generate_reliefs`, `apply_unfold`,
  `trim_body_with_plane`, `split_body_by_plane`, `merge_bodies_with_bend`,
  `extend_face_to_target`, `offset_face`, `add_flange`, `rip_edge`, `split_body_by_bends`.
- The existing `rollback` MCP tool continues to operate on `rollback_token` (which now
  equals `transaction_id` for transactional calls). It is not renamed in Phase 0.
