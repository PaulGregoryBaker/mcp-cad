# Bug Report: `get_job` with a missing/empty `job_id` crashes the whole v2 server process instead of returning a structured error

> **✅ RESOLVED 2026-08-08.** Root cause confirmed, and it's broader than
> this report knew: `ts/src/v2/server.ts`'s `CallToolRequestSchema` handler
> was not `async` and never `await`ed `dispatchGraphTool`'s result.
> `dispatchGraphTool` returns a real `Promise` for every tool whose handler
> is itself `async` — `commit`, `restore`, `branch`, `merge_branch`,
> `simulate_nesting`, `export_production_pack`, `get_job` (every `async
> function handleX` in `tools/graph.ts`) — and the handler was doing
> `JSON.stringify(result)` on that Promise object directly.
>
> Two confirmed, distinct symptoms from the same bug:
> 1. **Every one of those 7 tools has always silently returned `{}` to the
>    client on success**, discarding the real result (`job_id`,
>    `commit_hash`, etc.) — `JSON.stringify` of a Promise is always `"{}"`.
>    Live-verified: `simulate_nesting` returned `{"job_id":"..."}` only
>    after this fix; before it, `{}`. This is almost certainly why the
>    client saw `simulate_nesting` producing no `job_id` at all — not
>    because it's "still a stub" (it isn't), but because its real response
>    was never reaching the client in the first place.
> 2. **Any error thrown from inside one of those 7 handlers became an
>    unhandled promise rejection**, not a caught exception — fatal on
>    modern Node by default, killing the single shared server process (and
>    silently discarding the whole in-memory `GraphStore` with it) for one
>    bad call. The specific empty-`job_id` trigger in this report is
>    already blocked today by the unrelated Zod tool-args validation added
>    2026-08-07 (`get_job` requires a non-empty string, checked
>    synchronously before dispatch) — but any OTHER error from inside an
>    async handler (a valid-format-but-nonexistent `job_id`, `export_
>    production_pack`'s hard-coded stub failure, a Dolt failure in
>    `commit`/`restore`, etc.) still crashed the process the same way.
>    Live-reproduced with a nonexistent-but-valid `job_id` before the fix
>    (confirmed a rejected promise nothing ever caught), and confirmed
>    fixed after: a real MCP `Client`/`Server` round-trip now returns a
>    normal `isError: true` response, and the process handles a follow-up
>    call normally afterward.
>
> **Fix**: `CallToolRequestSchema`'s handler is now `async` and `await`s
> `dispatchGraphTool(...)` inside the same `try/catch` that already existed
> — the exact same error-handling path every other tool call goes through.
> Also added, as the defense-in-depth this report itself suggested: a
> top-level `unhandledRejection`/`uncaughtException` guard in `main()` that
> logs and keeps the process alive rather than the implicit default-exit
> behavior — a safety net for any *other* unawaited-promise class of bug,
> not a substitute for the real fix above.
>
> `ReadResourceRequestSchema`'s handler was checked too and does not have
> this bug — every `readX` function in `resources/graph.ts` is fully
> synchronous.

**Status:** Resolved — see above; original report kept unedited below
**Date:** 2026-08-08
**Component:** v2 tool dispatch (`ts/src/v2/tools/graph.ts`'s `get_job` handler / `requireString`) and/or the MCP SDK request pipeline (`@modelcontextprotocol/sdk/dist/cjs/shared/protocol.js`)
**Severity:** High — kills the single shared server process for the whole session, taking down every other in-flight MCP call (manufacturing graph loads, imports, everything) along with the one bad `get_job` call.
**Reported during:** Form.AI.tion UI session. Surfaced client-side as a status-bar/UI error: `Could not load Manufacturing Graph: MCP process exited unexpectedly with code 1`, unrelated on its face to jobs at all — the actual cause only showed up in the server's forwarded stderr.

---

## Summary

Every `import_part` call (i.e. every project load) triggers Form.AI.tion's client to automatically call `simulate_nesting` on the freshly-imported panels, then poll `get_job` for the result. `simulate_nesting` is (per its own tool description) an async job that returns `{job_id: "..."}` immediately. As of this writing it appears to be **still a stub** — it returns a response with no `job_id` field at all, which the client (defensively, but perhaps too defensively — see "Client-side contributing factor" below) turns into an empty string and polls `get_job` with anyway.

The server's stderr, forwarded into the client and captured there, showed:

```
McpToolError (or similar) with:
structured: {
  code: 'INTERNAL_ERROR',
  message: 'Missing required parameter: job_id',
  recoverable: false,
  suggestedTool: undefined
}
    at C:\Projects\mcp-cad\ts\node_modules\@modelcontextprotocol\sdk\dist\cjs\shared\protocol.js:371:25
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
```

Every other error path in `ts/src/v2/server.ts` (`CallToolRequestSchema`'s handler, `ReadResourceRequestSchema`'s handler) wraps its dispatch in `try/catch` and converts any thrown `McpToolError`/structured error into a normal, well-formed error *response* (`{content: [...], isError: true}` for tools; `{contents: [...]}` with the structured error as the JSON text for resources) — never a process crash. This one error instead appears to reach Node's default unhandled-rejection handler (the stack trace's `protocol.js:371` + `processTicksAndRejections` frames point at the SDK's own internal promise chain, not at `server.ts`'s handler body), which terminates the process with exit code 1.

**Net effect:** a single call with a bad (empty-but-present) `job_id` — itself arguably a client mistake, see below — kills the *entire* v2 server process, not just that one request. Since the server is a single shared stdio process for the whole session, this drops every other part currently loaded, every part's Manufacturing Graph, and any other in-flight call, with no way to distinguish "this one request failed" from "everything is now gone" until the client reconnects to a fresh, empty in-memory `GraphStore` (see the related persistence note below).

---

## Reproduction (as observed)

1. Client calls `import_part` for `testcube.step` — succeeds.
2. Client automatically calls `simulate_nesting` with the resulting panel ids.
3. `simulate_nesting`'s response has no `job_id` (still a stub) — client's `SimulateNestingTool.call()` reads `response['job_id'] ?? ''`, gets `''`.
4. Client polls `get_job` with `job_id: ''` (up to 20 times, 500ms apart, per its `pollJob` loop).
5. Server logs the stack trace above and exits with code 1.

We haven't yet isolated whether the crash happens on the *first* `get_job('')` call or requires the retry loop — worth checking server-side, since if it's the first call, this is trivially reproducible with a single malformed request.

## Suggested fix directions

- Whatever throws `Missing required parameter: job_id` (likely `requireString(args, 'job_id')` in `ts/src/v2/tools/graph.ts`'s `get_job` dispatch, per `schemas/tools.ts`'s `required: ['job_id']`) should end up going through the *same* try/catch every other tool dispatch goes through. If it's throwing from somewhere the `CallToolRequestSchema` handler's `try/catch` doesn't cover (e.g. genuinely inside the SDK's own request-dispatch promise chain rather than inside `dispatchGraphTool`), that's worth understanding — it would mean *any* tool with a required-param validation failure that fires at the wrong point in that chain could crash the process the same way, not just `get_job`.
- Regardless of root cause location: a missing/empty required parameter should never be able to take down the whole process. Consider a top-level `unhandledRejection`/`uncaughtException` handler in `ts/src/v2/server.ts`'s `main()` that logs and keeps the process alive (or degrades gracefully) rather than the current implicit default-exit behavior, as defense in depth even after the specific `get_job` path is fixed.
- Separately: should `simulate_nesting` actually be finished rather than a stub at this point? If it's meant to still be a stub, consider having it either omit the whole async-job shape (return a clear "not implemented" structured error instead of `{}`) so clients don't attempt to poll a job that was never created.

## Client-side contributing factor (already fixed in Form.AI.tion)

The client was polling `get_job` with an empty `job_id` string whenever `simulate_nesting`'s response had none — it now checks for an empty `job_id` before ever calling `get_job` and treats it as "job unavailable" locally instead. This stops the client from ever sending the request that triggers the crash, but doesn't address the underlying issue that the server *can* be crashed by a malformed `get_job` call at all (a well-behaved server should reject it with a normal structured error, not die).

## Related

- `docs/FEATURE_REQUEST_v2_transaction_primitive.md` and `ts/src/v2/graph/store.ts`'s own doc comment ("Dolt persistence... is explicitly deferred") — `GraphStore` is in-memory only, so any server crash (this one or otherwise) silently discards every part imported since the process started. Combined with a client that auto-reconnects transparently on process death, a crash like this one is easy to miss entirely: the UI just shows an empty-looking Manufacturing Graph for parts that "should" still exist, with no obvious signal that the whole store was wiped.
