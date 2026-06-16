# Deduplication Report (Phase 5: T048-T052)

## C++ findings (T048)

Audited all 10 domain `.cc` files under `cpp/src/geometry/` plus
`geometry_service_impl.hpp`/`geometry_service.hpp`.

| # | Pattern | Occurrences | Target | Status |
|---|---|---|---|---|
| 1 | `generateUUID()` | 10 files, verbatim | `geometry_service_utils.cc` | pending |
| 2 | `nowMs()` | 10 files, verbatim | `geometry_service_utils.cc` | pending |
| 3 | `shapeId(const TopoDS_Shape&)` | 10 files, verbatim | `geometry_service_utils.cc` | pending |
| 4 | `createSnapshotLocked(label)` | 9 files, verbatim ~14-line method | `GeometryState::createSnapshot()` (impl.hpp/core.cc) | pending |
| 5 | `lookupEntityLocked(id)` | 5 files, verbatim ~55-line method | `geometry_service_utils.cc` (free fn over `GeometryState&`) | pending |
| 6 | `findParentShellIdLocked(id)` | 3 files, verbatim ~25-line method | `geometry_service_core.cc` shared helper | pending |
| 7 | `applyTransformLocked(...)` | 2 files (core.cc has a stray leftover copy) | keep single impl in `geometry_service_transforms.cc`; remove stray core.cc copy if unused | pending |
| 8 | `faceOutwardNormal(face)` | 5 files, verbatim (+1 inline near-dup in sheet_metal.cc) | `geometry_service_utils.cc` | pending |
| 9 | `detectCycleDFS(...)` | 3 files, verbatim | `geometry_service_core.cc` shared helper | pending |
| 10 | `validateSheetMetalShapeLocked(shape)` | 2 files, ~390 lines wholesale duplicate (validation.cc + export.cc) | shared location (utils or core), both callers delegate | **pending — highest priority correctness risk** |
| 11 | `faceCenter` lambda | 3 copies within `geometry_service_export.cc` alone | promote to `geometry_service_utils.cc` static fn | pending |
| 12 | `minLocalDimension` lambda | 4 copies across export.cc (×2) and validation.cc (×2) | `geometry_service_utils.cc` | pending (folds in with #10) |
| 13 | shell-or-solid dual lookup w/ `isSolid` flag | 10 occurrences across 5 files (6 in modelling.cc alone) | `resolveShellOrSolidLocked()` helper in `geometry_service_utils.cc` | pending |

Full details (file:line citations, snippets) captured from the audit agent; see
consolidation commits for exact before/after diffs.

## TypeScript findings (T049)

Audited all files under `ts/src/mcp/handlers/`.

| # | Pattern | Occurrences | Target | Status |
|---|---|---|---|---|
| 1 | `generateDxfFromManufacturingGraph` exact duplicate function (117 lines) | `shape-ops.ts:496-612`, `unfold-export.ts:20-136` | move to `handlers/dxf-helpers.ts` | **pending — highest priority, zero-risk** |
| 2 | `meshBaseUrl` construction one-liner | 32 occurrences across booleans.ts, body-ops.ts, shape-ops.ts, manufacturing.ts, unfold-export.ts | `buildMeshUrl`/`buildMeshUrls` in `handlers/utils.ts` | pending |
| 3 | Rollback-token selection ternary | 29 occurrences, same files as #2 | fold into `finalizeMutatingResult` helper | pending |
| 4 | "Append history if joined" 3-line block | ~30 occurrences, same files as #2 | fold into `finalizeMutatingResult` helper | pending |
| 5 | Combined mutating-op response shape (register shell + append history + rollback token + mesh url) | booleans.ts, body-ops.ts, shape-ops.ts, manufacturing.ts (~8+ call sites) | single `finalizeMutatingResult(ctx, result, shellId, extraFields?)` helper in `handlers/utils.ts` | pending |
| 6 | `!Array.isArray(x) \|\| x.length < N` validation | 7 occurrences in `body-ops.ts` | `requireNumberArray(args, key, length)` in `helpers.ts` (sibling of existing `requireStringArray`) | pending |
| 7 | `keep_original` default-extraction | 5 occurrences in `body-ops.ts` | `optBool(args, key, default)` in `helpers.ts` | pending |
| 8 | Per-target transform loop (translate/rotate/mirror/scale) | `body-ops.ts:466-630`, 4 handlers | `applyPerTargetTransform(...)` helper (secondary priority, touches call-site-specific binding calls) | pending |

Not flagged (already correctly centralized / not real duplication): `requireString`/`requireStringArray`/`requireObject`/`resolveTransactionContext`/`resolveTargetToShell`/`updatePanelBodyIdAfterTransform` in `helpers.ts`; per-tool JSON-schema blocks (different domain semantics); `BendNode`/`CutNode`/`JoinNode` construction in `graph.ts` (differ enough to keep separate); `semantic.ts`'s local `mapSemanticStoreError` (single-file use, good prior art for the pattern).
