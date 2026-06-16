# Deduplication Report (Phase 5: T048-T052)

## C++ findings (T048)

Audited all 10 domain `.cc` files under `cpp/src/geometry/` plus
`geometry_service_impl.hpp`/`geometry_service.hpp`.

| # | Pattern | Occurrences | Target | Status |
|---|---|---|---|---|
| 1 | `generateUUID()` | 10 files, verbatim | `geometry_service_utils.cc` | done |
| 2 | `nowMs()` | 10 files, verbatim | `geometry_service_utils.cc` | done |
| 3 | `shapeId(const TopoDS_Shape&)` | 10 files, verbatim | `geometry_service_utils.cc` | done |
| 4 | `createSnapshotLocked(label)` | 9 files, verbatim ~14-line method | `GeometryState::createSnapshot()` (impl.hpp/core.cc) | done |
| 5 | `lookupEntityLocked(id)` | 5 files, verbatim ~55-line method | `geometry_service_utils.cc` (free fn over `GeometryState&`) | done |
| 6 | `findParentShellIdLocked(id)` | 3 files, verbatim ~25-line method | `geometry_service_core.cc` shared helper | done |
| 7 | `applyTransformLocked(...)` | 2 files (core.cc has a stray leftover copy) | keep single impl in `geometry_service_transforms.cc`; remove stray core.cc copy if unused | done |
| 8 | `faceOutwardNormal(face)` | 5 files, verbatim (+1 inline near-dup in sheet_metal.cc) | `geometry_service_utils.cc` | done |
| 9 | `detectCycleDFS(...)` | 3 files, verbatim | `geometry_service_core.cc` shared helper | done |
| 10 | `validateSheetMetalShapeLocked(shape)` | 2 files, ~390 lines wholesale duplicate (validation.cc + export.cc) | shared location (utils or core), both callers delegate | done |
| 11 | `faceCenter` lambda | 3 copies within `geometry_service_export.cc` alone | promote to `geometry_service_utils.cc` static fn | done |
| 12 | `minLocalDimension` lambda | 4 copies across export.cc (×2) and validation.cc (×2) | `geometry_service_utils.cc` | done (folded in with #10) |
| 13 | shell-or-solid dual lookup w/ `isSolid` flag | 9 occurrences across 4 files (6 in modelling.cc, 1 each in transforms.cc/validation.cc/sheet_metal.cc — original estimate of 10/5 files was off by one on recount) | `resolveShellOrSolidIn()` helper in `geometry_service_utils.cc` | done |

All 13 C++ findings consolidated and build/test verified (T050, zero regressions
against the pre-existing single Catch2 failure documented in `baseline-results.txt`).
Full details (file:line citations, snippets) captured from the audit agent; see
consolidation commits for exact before/after diffs.

## TypeScript findings (T049)

Audited all files under `ts/src/mcp/handlers/`.

| # | Pattern | Occurrences | Target | Status |
|---|---|---|---|---|
| 1 | `generateDxfFromManufacturingGraph` exact duplicate function (117 lines) | `shape-ops.ts:496-612`, `unfold-export.ts:20-136` | move to `handlers/dxf-helpers.ts` | done |
| 2 | `meshBaseUrl` construction one-liner | 32 occurrences across booleans.ts, body-ops.ts, shape-ops.ts, manufacturing.ts, unfold-export.ts | `buildMeshUrl`/`buildMeshUrls` in `helpers.ts` | done |
| 3 | Rollback-token selection ternary | 29 occurrences, same files as #2 | `resolveRollbackToken(ctx, fallback)` in `helpers.ts` | done |
| 4 | "Append history if joined" 3-line block | ~30 occurrences, same files as #2 | `appendHistoryIfJoined(ctx, history)` in `helpers.ts` | done |
| 5 | Combined mutating-op response shape (register shell + append history + rollback token + mesh url) | booleans.ts, body-ops.ts, shape-ops.ts, manufacturing.ts (~8+ call sites) | not unified into a single `finalizeMutatingResult` — response field names genuinely differ per handler (`solid_id` vs `modified_shell_id` vs `trimmed_shell_id` vs `shell_id`, plus handler-specific extra fields). Instead extracted the safe composable primitives from #2-#4, which each handler now assembles into its own response shape | done (via #2-#4) |
| 6 | `!Array.isArray(x) \|\| x.length < N` validation | 6 occurrences in `body-ops.ts` | `requireNumberArray(args, key, length)` in `helpers.ts` (sibling of existing `requireStringArray`) | done |
| 7 | `keep_original` default-extraction | 5 occurrences in `body-ops.ts`, extended to all boolean-default sites in that file (`flip_normal`, `unify_faces`, `unify_edges`, `fix_tolerances`, `fix_wires`, `heal_remaining`, `make_solid`) | `optBool(args, key, default)` in `helpers.ts` | done |
| 8 | Per-target transform loop (translate/rotate/mirror/scale) | `body-ops.ts:466-630`, 4 handlers | `applyPerTargetTransform(...)` helper in `helpers.ts` | done |

Not flagged (already correctly centralized / not real duplication): `requireString`/`requireStringArray`/`requireObject`/`resolveTransactionContext`/`resolveTargetToShell`/`updatePanelBodyIdAfterTransform` in `helpers.ts`; per-tool JSON-schema blocks (different domain semantics); `BendNode`/`CutNode`/`JoinNode` construction in `graph.ts` (differ enough to keep separate); `semantic.ts`'s local `mapSemanticStoreError` (single-file use, good prior art for the pattern). Also deliberately left untouched: `manufacturing.ts`'s `handleDecomposeVolume`/`handleGenerateReliefs` if/else snapshot-vs-join idiom for rollback tokens — the two branches have different *side effects* (`createSnapshot(...)` vs `appendHistory(...)`), not just different fallback values, so they don't fit the `resolveRollbackToken`/`appendHistoryIfJoined` shape; two isolated single-occurrence `(args[key] as boolean | undefined) ?? default` extractions in `graph.ts` and `assembly.ts` were left as-is since they are not repeated within their own files.

All 8 TS findings now closed. Verified via `npx tsc --noEmit` (zero errors) after each file's consolidation: `body-ops.ts`, `booleans.ts`, `manufacturing.ts`, `shape-ops.ts`, `unfold-export.ts`.

## Test verification (T052)

Full suite run via `run-tests-sequential.ps1` (64 files: 14 unit, 10 contract, 40
integration, each in its own isolated `vitest` process): **63 passed, 1 failed**.

The one failure (`tests/unit/fuse_preflight.unit.test.ts`, 2 of 8 tests:
`handleCutBodies: GRAPH_INTEGRITY_ERROR guard (FR-005)`) is a **pre-existing gap,
not a regression** — `handleCutBodies` in `booleans.ts` never had a
graph-tracked-shell guard, in either the pre-dedup or post-dedup version. Confirmed
by `git stash`-ing all dedup changes and re-running the same test file against the
committed baseline: identical 2/8 failure. This test belongs to feature
010-graph-driven-mutations (FR-005) and is tracked separately from this
decomposition refactor; out of scope to fix here.

Along the way, found and fixed an unrelated pre-existing infra bug blocking this
verification entirely: `vitest.config.ts` used a `test.projects` key that
`vitest@1.6.1` (the version pinned in `package.json` and installed) does not
support — that config key was added in a later Vitest major version. This caused
`--project <name>` to match zero tests for every project, 100% of the time, since
the very first commit (`git log -p` shows the `projects:` key was introduced in
the initial commit and never changed). Fixed by moving the per-layer project
definitions into a new `vitest.workspace.ts` using `defineWorkspace()`, which
`vitest@1.6.1` does support; `vitest.config.ts` now holds only the shared base
settings (coverage/reporters/globals/alias) that each workspace project extends.
