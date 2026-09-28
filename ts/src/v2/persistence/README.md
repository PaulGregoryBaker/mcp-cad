# v2 persistence

Specification: Form·AI·tion `specs/010-dolt-graph-persistence/` (plan,
research R-014–R-016, data-model, contracts/mcp-persistence-contract.md).

The manufacturing graph is the only persisted definition of a project. It lives
in **normalised Dolt tables**, one database per project, following
`rebuild/14-graph-schema.md` §2 plus its §2.5 addendum (R-016).

## Who owns what (R-014)

- **The client application** decides *where* a project lives: a storage account
  id and a database name. It runs the local Dolt server behind the `local`
  account.
- **This server** owns everything else:
  - the **credentials**, held in its own account setup
    (`config/storage-accounts.yaml`; override the path with `MCPCAD_ACCOUNTS`).
    Secrets live in the OS keyring, or are referenced by env/file. They are never
    received or returned through tools.
  - the schema and migrations;
  - every read and write.

### Account setup

```
npm run account -- add local --host 127.0.0.1 --port 3316 --user root --prefix fa_ --no-secret
npm run account -- add workshop --host dolt.example --user formaition --prefix ws_ --secret-prompt --tls required
npm run account -- list          # ids, hosts and where each secret is kept, never the secret
npm run account -- test <id>     # connects; reports latency or a typed error
npm run account -- remove <id>
```

See `config/storage-accounts.example.yaml`. The Form·AI·tion app starts its own
Dolt on `127.0.0.1:3316`, which is the `local` account above. A legacy
`persistence:` block in `config.yaml` is refused with `STORAGE_CONFIG_INVALID`.

## Architecture

| Module | Role |
|---|---|
| `accounts.ts` | Account lookup; secret resolution (`keyring:`/`env:`/`file:`); connection options; `redactSecrets()`; typed storage errors |
| `port.ts` | `GraphPersistence`: the only interface the tools and session use |
| `dolt-persistence.ts` | The Dolt adapter: branch-qualified `` USE `db/branch` `` on a dedicated writer; `AS OF` reads on a separate reader |
| `migrate.ts` + `migrations/NNN_*.sql` | Schema versions: `main` first, then the session branch |
| `row-mapper.ts` | Snapshot ↔ normalised rows, with an identity-preserving row diff (vertex LCS shadows, fractional `order_key`s) |
| `persist-mutation.ts` | Write-through of one mutation (below) |
| `load.ts` | The shared load path: raw rows → validated snapshots, all-or-nothing |
| `session.ts` | `SessionContext`: the GraphStore plus the bound project |
| `ref-diff.ts` | `graph://diff`: a row-level compare of two revisions on primary key |

### A mutation (`persistMutation`)

1. **Guards**: a project is bound, and the session is neither on `main` (`PERSIST_ON_MAIN`) nor viewing a read-only revision (`PERSIST_READ_ONLY_REF`).
2. Snapshot the store and run the tool in memory.
3. Diff the changed parts into row upserts and deletes, preserving identities.
4. Validate every changed part (Zod + structural invariants), then the whole store.
5. Write, in **one SQL transaction**:
   - the changed rows;
   - the side writes (`client_meta`, `project_settings`, `import_source`);
   - one `action_log` row with its `undo_delta`.
6. Return `action_seq`.

Any failure after step 2 restores the in-memory store, so memory and storage
never disagree. A validation failure is this server's own bug →
`INTERNAL_ERROR`; a storage failure → `PERSIST_WRITE_FAILED`.

### Commit model (R-015)

- Edits go to the bound working branch's **working set**. They are never committed automatically.
- **Revisions are created only by an explicit `commit`**, with the user's message.
- `undo` applies the newest un-undone, uncommitted `action_log.undo_delta`.
- `discard_changes` runs `DOLT_RESET --hard` **and** `DOLT_CLEAN`.
- `branch_merge` does a `--no-ff` merge into `main`, then deletes the working branch.
- `checkout` of a commit opens it read-only. The first edit starts a new branch at that commit.
- `session_state` (the current branch) is `dolt_ignore`d and lives only in `main`'s working set.

## Adding a migration

1. **Add the file**: `migrations/NNN_description.sql`, numbered one above the last. The number is its version; `currentSchemaVersion()` is the highest.
2. **Write it** as plain DDL/DML, one statement per `;` at a line end. `--` comments are stripped.
3. **Build**: `npm run build` copies the migrations into `dist` (`scripts/copy-migrations.cjs`).
4. **What happens on open, refresh and checkout**:
   - `main` is migrated first, as a system commit.
   - A clean working branch also gets a system commit.
   - A **dirty** branch gets an uncommitted `system` action that can't be undone; `undo` stops there with `UNDO_BLOCKED_BY_MIGRATION`.
   - A database newer than this server fails with `PERSIST_SCHEMA_UNSUPPORTED`.
   - Revisions at other versions can't be read side by side (`PERSIST_SCHEMA_MISMATCH`); check them out to migrate them.
5. **Update the dependents**:
   - `schemas/persistence.ts` and `row-mapper.ts`.
   - Regenerate the contract fixtures (`npm run schemas:export`) and sync them into the client (`scripts/sync_contract_fixtures.ps1`). CI fails on stale fixtures.

## Invariants and the exception policy

`graph/invariants.ts` checks **structure only** (`INV_*` codes):
- the root panel is present;
- no foreign or duplicate rows;
- bends reference existing panels and form a tree;
- parameter ranges:
  - thickness > 0;
  - K-factor and overrides in [0, 1] (0 is a real value);
  - bend radius ≥ 0 and angles finite;
- merge targets exist and aren't self;
- no presentation doc belongs to a missing part.

The invariants run before every write (a failure → `INTERNAL_ERROR` plus
rollback) and after every read (`PERSIST_INVARIANT_VIOLATION`, and nothing is
loaded).

**Deliberately not checked here**: geometric validity (self-intersection,
developability, overlaps). Constitution principle IV keeps geometric
computation in the C++ kernel, which reports these as findings. Bend angles
beyond ±180° are likewise a finding, not a storage invariant.

A new invariant must:
- be structural;
- hold for every graph the tools can legitimately produce — the invariant sweep (`npm run test:invariant-sweep`) checks it after every v2 test;
- be recorded in research.md R-013.

## Secret handling (FR-031, SC-010)

- Tool arguments and results never carry credentials.
  - `open_project` takes an account **id**.
  - `list_storage_accounts` returns ids, hosts, ports, TLS and prefixes — no secret fields.
- `redactSecrets()` scrubs every resolved secret, longest first, from:
  - every tool result;
  - every resource body;
  - every error;
  - stderr (the server wraps `console.error`, whose output the client shows in its AI panel).

## Error codes

| Code | Meaning |
|---|---|
| `STORAGE_ACCOUNT_UNKNOWN`, `STORAGE_ACCOUNT_UNREACHABLE`, `STORAGE_AUTH_FAILED`, `STORAGE_SECRET_UNRESOLVED`, `STORAGE_CONFIG_INVALID` | Account setup problems; messages name the account id only |
| `PERSIST_NOT_BOUND`, `PERSIST_PROJECT_OPEN` | No project bound, or one already bound |
| `PERSIST_ON_MAIN`, `PERSIST_READ_ONLY_REF` | Edits need a working branch |
| `PERSIST_WRITE_FAILED` | The SQL transaction failed; memory was rolled back |
| `PERSIST_CORRUPT_ROW`, `PERSIST_INVARIANT_VIOLATION` | Stored data fails validation; nothing is loaded |
| `PERSIST_SCHEMA_UNSUPPORTED`, `PERSIST_SCHEMA_MISMATCH`, `PERSIST_MIGRATION_FAILED` | Schema version problems |
| `BRANCH_ALREADY_OPEN`, `BRANCH_NONE_OPEN`, `BRANCH_MERGE_CONFLICT` | Working-branch lifecycle |
| `COMMIT_NOTHING_TO_COMMIT`, `COMMIT_UNCOMMITTED_CHANGES` | Preconditions for commit, checkout and merge |
| `UNDO_NOTHING_UNCOMMITTED`, `UNDO_BLOCKED_BY_MIGRATION` | Undo limits |
| `SETTINGS_INVALID` | `update_project_settings` payload rejected |
| `IMPORT_FILE_NOT_FOUND`, `IMPORT_READ_FAILED`, `PREVIEW_EXPIRED` | Sources for `preview_import` and `import_part` |
| `IMPORT_DEFAULTS_MISSING`, `IMPORT_THICKNESS_NOT_IN_CATALOGUE` | Configured-import preconditions |
| `IMPORT_SOURCE_MISSING`, `IMPORT_SOURCE_NOT_FOUND` | `reference_mesh` |

## Tests

- **`npm run test:persist`** uses a real Dolt: each file gets its own throwaway `dolt sql-server` (`tests/helpers/dolt-harness.ts`). These tests are never skipped.
- **`v2_persist_latency`** records write latency: +17 ms p95 per edit, and 32 ms to undo on 20 parts.
