# Implementation Plan: Explicit Transaction Primitive

**Branch**: `004-transaction-primitive` | **Date**: 2026-05-21 | **Spec**: [spec.md](spec.md)

---

## Summary

Wraps the existing [`SnapshotRegistry`](../../cpp/src/geometry/snapshot.hpp) in an explicit
**Transaction** lifecycle exposed via three new MCP tools (`begin_transaction`,
`commit_transaction`, `rollback_transaction`). Every existing mutating tool gains an
optional `transaction_id` input and, when a transaction is active, joins it instead of
creating its own snapshot. A new per-transaction `ShapeHistory` map captures OCCT
`Modified` / `Generated` / `IsDeleted` records that the Semantic Mapping Layer (Phase 1)
will consume. A read-only `get_transaction_history` tool exposes the records for testing
and for the agent to inspect what changed.

The MVP-scope semantic identifiers, Mapping Layer, and Dolt persistence are **not** in
this feature. See [SemanticCad/MVP.md §5](../../SemanticCad/MVP.md) for the Phase 0
boundary.

---

## Technical Context

**Language/Version**: C++ (Geometry Engine, OCCT facade), TypeScript (MCP Protocol Layer)

**Primary Dependencies**:
- C++: existing OCCT 7.8.x shape-history APIs — `BRepAlgoAPI_BuilderAlgo::Modified()`,
  `BRepAlgoAPI_BuilderAlgo::Generated()`, `BRepAlgoAPI_BuilderAlgo::IsDeleted()`,
  `BRepFilletAPI_LocalOperation::Modified/Generated`, `BRepPrimAPI_MakePrism::Generated`.
- TS: new dependency on `ulid` (npm), MIT-licensed, ~3 kB; used for transaction id
  generation.

**Constraints**:
- Constitution Principle IV (rollback-first) — preserved by reusing `SnapshotRegistry`.
- Constitution Principle VI (structured errors) — new error codes added.
- Constitution Principle VII (MVP scope) — single-session, no nested transactions, no
  persistence.

---

## Design

### Transaction model (single-session)

```text
                ┌─────────────────────────────────────────────────────┐
                │             Session (process-wide)                  │
                │                                                     │
                │   activeTransactionId : Option<TransactionId>       │
                │                                                     │
                │   ┌─────────────────────────────────────────────┐   │
                │   │   TransactionRegistry  (new, in TS layer)   │   │
                │   │                                             │   │
                │   │   txn ─► { id, label, snapshot_id,          │   │
                │   │            shape_history[], state,          │   │
                │   │            started_at }                     │   │
                │   └─────────────────────────────────────────────┘   │
                │                                                     │
                │   ┌─────────────────────────────────────────────┐   │
                │   │   SnapshotRegistry (existing, C++)          │   │
                │   │   - createSnapshot / restoreSnapshot        │   │
                │   └─────────────────────────────────────────────┘   │
                └─────────────────────────────────────────────────────┘
```

**Why TS owns the registry**: the transaction id is generated client-side (ULID) and the
shape-history records are a TS-shaped JSON structure consumed in Phase 1 by the Mapping
Layer (also TS). The C++ side stays focused on geometry.

**Why one active transaction**: single-session MVP. The session struct in
[ts/src/geometry/session.ts](../../ts/src/geometry/session.ts) tracks
`activeTransactionId`. A second `begin_transaction` while one is active is an error.

### Lifecycle mapping

| Tool / event             | Effect on TransactionRegistry                                   | Effect on SnapshotRegistry           |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------ |
| `begin_transaction`      | Insert new row; set `activeTransactionId`                       | `createSnapshot(label)`              |
| Mutating tool, txn active| Append `ShapeHistory` records from this op                      | No new snapshot                      |
| Mutating tool, no txn    | (No transaction registry write)                                 | `createSnapshot(toolName)` (today)   |
| `commit_transaction`     | Mark `state = committed`; clear `activeTransactionId`           | `clearSnapshots()` (drops the pre-snap) |
| `rollback_transaction`   | Delete row (history discarded); clear `activeTransactionId`     | `restoreSnapshot(snapshotId)`        |
| `rollback` (existing)    | If id matches active txn: same as `rollback_transaction`. Else: legacy single-op restore | `restoreSnapshot(snapshotId)`        |

### Shape-history capture (C++ side)

OCCT's history is per-algorithm-instance. Each mutating call already holds a
`BRepAlgoAPI_*` object (or equivalent) on its stack frame. We add a thin helper:

```cpp
// new file: cpp/src/geometry/shape_history.hpp
namespace mcp_cad {

struct ShapeHistoryRecord {
  std::string verdict;        // "modified" | "generated" | "deleted"
  std::string originalId;     // face/edge/shell id pre-op
  std::string newId;          // face/edge/shell id post-op (empty for deleted)
  std::string operationLabel; // e.g. "split_body_by_bends"
};

// Stateless helpers — caller passes the OCCT history object and the id resolver.
std::vector<ShapeHistoryRecord> captureHistory(
    BRepBuilderAPI_MakeShape& algo,
    const std::function<std::string(const TopoDS_Shape&)>& resolveId,
    const std::string& operationLabel);

}  // namespace mcp_cad
```

The `resolveId` function is provided by the calling site so the helper stays
geometry-implementation-agnostic. The result vector is returned to the C++ NAPI layer
and serialised to JS objects.

### N-API result shape

Mutating tools' NAPI return values gain one new optional field:

```typescript
{
  // existing fields...
  rollback_token: string,
  // new in Phase 0:
  shape_history?: Array<{
    verdict: 'modified' | 'generated' | 'deleted',
    original_id: string,
    new_id: string,        // empty string if verdict === 'deleted'
    operation_label: string,
  }>
}
```

The field is `optional` because non-OCCT tools (e.g. an MCP-level metadata tool) won't
populate it. Tools that *can* populate it MUST populate it; the TransactionRegistry
appends whatever it receives.

### Tool schemas

```jsonc
// begin_transaction
{
  "name": "begin_transaction",
  "description": "Open an explicit transaction. Subsequent mutating tools execute against working state without creating per-call snapshots. Commit to persist, or rollback to revert all operations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "label": { "type": "string", "description": "Human-readable label" },
      "product": { "type": "string", "description": "Product slug (single-product MVP — informational only)" }
    },
    "required": ["label"]
  }
}

// commit_transaction
{
  "name": "commit_transaction",
  "inputSchema": {
    "type": "object",
    "properties": {
      "transaction_id": { "type": "string" }
    },
    "required": ["transaction_id"]
  }
}

// rollback_transaction (mirrors commit_transaction schema)

// get_transaction_history
{
  "name": "get_transaction_history",
  "description": "Returns the OCCT shape-history records captured for a transaction. Read-only. Used by the Semantic Mapping Layer in Phase 1 and for test verification in Phase 0.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "transaction_id": { "type": "string" }
    },
    "required": ["transaction_id"]
  }
}
```

The four new tool schemas live alongside the existing tools in
[ts/src/mcp/tools.ts](../../ts/src/mcp/tools.ts).

---

## Constitution Check

| Principle                  | Status     | Notes                                                                                              |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| I. Deterministic geometry  | PASS       | No new geometric math; transaction state is pure bookkeeping.                                      |
| II. Bounded contexts       | PASS       | TransactionRegistry sits in the MCP Protocol Layer; C++ shape-history helper sits in Geometry Engine; the only crossing is a typed `ShapeHistoryRecord` vector through N-API. |
| III. Safety filter         | PASS       | No change to safety filter behaviour.                                                              |
| IV. Rollback-first         | STRENGTHENED | `rollback_transaction` is now the explicit primitive; `rollback` continues to work on `rollback_token`. |
| V. Kerf compensation       | PASS       | No change.                                                                                         |
| VI. Structured errors      | PASS       | New error codes added (see §New Error Codes).                                                      |
| VII. MVP scope             | PASS       | Single-session, single-active-transaction, in-memory. Persistence (Dolt) is Phase 1.               |
| VIII. Configuration        | PASS       | No new configuration in Phase 0.                                                                   |
| IX. Async export           | PASS       | Async export tools are not mutating in the transactional sense; unchanged.                         |

---

## New Error Codes

| Code                          | Meaning                                                            | Recoverable | Suggested tool         |
| ----------------------------- | ------------------------------------------------------------------ | ----------- | ---------------------- |
| `TRANSACTION_NOT_FOUND`       | The given `transaction_id` does not match any open or committed transaction in this session | true        | `begin_transaction`    |
| `TRANSACTION_NOT_ACTIVE`      | The transaction exists but is already committed or rolled back     | true        | `begin_transaction`    |
| `TRANSACTION_ALREADY_ACTIVE`  | `begin_transaction` called while another transaction is active     | true        | `commit_transaction` / `rollback_transaction` (passes back the active id) |
| `TRANSACTION_MISMATCH`        | A mutating tool was called with a `transaction_id` that doesn't equal the active transaction | true        | (none — fix caller)    |

---

## Project Files Changed

| File                                                                                  | Change                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cpp/src/geometry/shape_history.hpp`                                                  | **new**. `ShapeHistoryRecord` struct + `captureHistory` helper.                                              |
| `cpp/src/geometry/shape_history.cc`                                                   | **new**. Helper implementation.                                                                              |
| `cpp/src/geometry/geometry_service.cc`                                                | Update `splitBodyByBends` (and the other mutating ops listed in the spec assumptions) to call `captureHistory` and return the records as part of the result struct. |
| `cpp/src/geometry/geometry_service.hpp`                                               | Add `std::vector<ShapeHistoryRecord> shapeHistory` field to every mutating result struct.                    |
| `cpp/src/napi/geometry_binding.cc`                                                    | Serialise `shapeHistory` into the JS return object for each mutating tool's NAPI wrapper.                    |
| `ts/src/geometry/binding.ts`                                                          | Add `shape_history?` field to each mutating tool's return type.                                              |
| `ts/src/mcp/transactions.ts`                                                          | **new**. `TransactionRegistry` class — Map<TransactionId, Transaction>, `activeTransactionId` accessor, lifecycle methods. |
| `ts/src/geometry/session.ts`                                                          | Add `getTransactionRegistry(): TransactionRegistry` accessor.                                                |
| `ts/src/mcp/tools.ts`                                                                 | Add 4 new tool definitions (`begin_transaction`, `commit_transaction`, `rollback_transaction`, `get_transaction_history`); add `transaction_id?: string` to each mutating tool's input schema; update dispatch to honour the active transaction. |
| `ts/src/mcp/errors.ts`                                                                | Add 4 new error codes.                                                                                       |
| `package.json`                                                                        | Add `ulid` dependency.                                                                                       |
| `ts/tests/integration/transaction_primitive.integration.test.ts`                      | **new**. Covers all three User Stories.                                                                      |
| `cpp/tests/geometry_test.cc`                                                          | Add a test asserting `splitBodyByBends` returns a non-empty `shapeHistory` for a hollow cube.                |

---

## Implementation Order

Four phases, each independently testable.

1. **Phase 1** — TS-side `TransactionRegistry` + the 3 lifecycle tools, **without** any
   C++ changes. This is enough to demonstrate US1 using existing (per-op snapshot)
   tools — the registry transparently wraps them.
2. **Phase 2** — Wire `transaction_id` through every existing mutating tool's input
   schema and dispatch logic. Verifies US2: existing integration tests still pass
   unchanged, plus new opt-in tests for transactional dispatch.
3. **Phase 3** — C++ shape-history capture in `splitBodyByBends` (one tool, end-to-end).
   Verifies US3 for one op; proves the plumbing works.
4. **Phase 4** — Extend shape-history capture to the remaining mutating ops listed in
   the spec assumptions. Mostly mechanical.

Phases 1–3 are the MVP gate for "transaction primitive shipped." Phase 4 can ship
incrementally after, op-by-op, without blocking Phase 1 of Semantic CAD MCP from starting.
