# v2 geometry resources — UI integration guide

Status: matches the actual implementation as of 2026-07-28 (not the aspirational
full contract). Everything described here is built, tested, and verified against
a real GLB fetch. See `rebuild/15-mcp-contract.md` for the longer-term contract
this is a subset of.

## What runs where

Starting the v2 MCP server (`ts/src/v2/server.ts`) starts **two** things in the
same process:
1. The stdio JSON-RPC MCP server itself (tools + resources).
2. An HTTP blob server, listening on **port 3101 by default** (override with
   `V2_BLOB_PORT`). You don't start this separately — it comes up automatically
   with the MCP server.

There's no separate deployment step for the UI team here: connect to the MCP
server as normal, and the blob endpoint is just available on that port for the
lifetime of the same process.

**No persistence yet.** Everything (parts, bends, cached blobs) lives in memory
for the process's lifetime. A server restart loses all state. Don't build
anything that assumes a part_id survives a restart.

## Listing and inspecting parts

```
Read resource: graph://parts
→ { "parts": [{ "partId": "...", "name": "...", "materialId": "...", "rootRegionPanelId": "..." }] }

Read resource: graph://part/{part_id}/full
→ { "partId": "...", "part": {...}, "regionPanels": [...], "bends": [...], "findings": [] }
```

`full` is the whole graph structure for one part — no geometry in it, just
what to render (which bends exist, what their angles are, etc.) if you're
building a graph/tree view rather than a 3D view. `findings` is always `[]`
today — no manufacturability rules engine exists in v2 yet, so there's nothing
to report there. Don't build a findings panel against this yet.

## Getting 3D geometry — the part that matters for the viewport

Two resources, both return a **Ref**, not the geometry itself:

```
Read resource: graph://part/{part_id}/mesh
→ {
    "partId": "...",
    "ref": {
      "url": "http://localhost:3101/v2-blob/mesh/{part_id}/default",
      "contentType": "model/gltf-binary",
      "byteSize": 7524,
      "expiresAt": "2026-07-28T10:02:57.229Z"
    }
  }
```

`ref.url` is a plain HTTP GET, outside the MCP JSON-RPC channel entirely —
fetch it directly with whatever HTTP client your viewport already uses
(`fetch`, `dio`, etc.). The response is a real, valid `.glb` file. Point
your GLTFLoader (or equivalent) straight at the bytes.

`graph://part/{part_id}/boundary` works identically but returns
`application/json` — the exact (non-tessellated) 3D boundary: per-region-panel
`bottomFace`/`topFace` point arrays plus per-bend pivot/radius/hinge data. Use
this if you need exact geometry (e.g. precise per-panel highlighting, picking,
measurement) rather than a rendered mesh — the mesh has no per-panel
breakdown, it's one flat tessellation of the whole part.

### The important part: the URL is stable, not re-minted per edit

`ref.url` for a given part **never changes** across edits. The same part
always resolves to the same URL for its whole lifetime in that server process
(mesh and boundary each get their own stable URL). This is deliberate — read
the resource once, hold onto `ref.url`, and you never need to re-read the MCP
resource again just to find out "what's the current URL." Feel free to cache
`ref.url` in your own part model, exactly like you'd cache any stable
identifier.

**What this means practically: fetching the same URL twice, without any edit
in between, gets you byte-identical content — but fetching it after an edit
gets you the new geometry, at the exact same URL.** The server rebuilds the
blob in place. There's no cache-busting or query-param trick needed or
expected on your side.

### Getting told when to re-fetch

Since the URL doesn't change, you need a signal for "go re-fetch now." Two
options, and you can use either or both:

**Option A — you already know.** If your own UI called the mutating tool
(`cut_panel`, `move_edge`, `merge_bodies_with_bend`, etc.), you already know a
part's geometry may have changed. Just re-fetch `ref.url` after your own tool
call resolves. No new protocol needed — this covers the overwhelming majority
of real cases, since almost every edit in a single-user session is your own.

**Option B — MCP's real push mechanism**, for cases where you want the server
to tell you (e.g. an edit came from somewhere else, or you don't want to
manually track "did I just mutate this part"):

```
1. Send: { method: "resources/subscribe", params: { uri: "graph://part/{part_id}/mesh" } }
2. Later, after ANY mutation to that part (yours or otherwise), you'll receive:
   { method: "notifications/resources/updated", params: { uri: "graph://part/{part_id}/mesh" } }
3. On that notification: just re-fetch the SAME ref.url you already have.
   No need to re-read the MCP resource — the URL hasn't changed.
```

This is the standard MCP resource-subscription mechanism (`resources/subscribe`
+ `notifications/resources/updated`), not something custom to this project —
any MCP client SDK that supports resource subscriptions should already have
this. Subscribe to `boundary` the same way if you're using that instead of/as
well as `mesh`.

Rebuilds run synchronously on the server (no background thread — a rebuild for
the part sizes we've tested is well under a second, but a very large/complex
part could theoretically make the whole server briefly unresponsive during
that rebuild; there's no progress reporting for it yet).

## Practical caveats

- **The GLB is a single mesh, single primitive** — one `POSITION`/`NORMAL`/
  `indices` triple for the whole part, no per-panel/per-material split inside
  the mesh itself. If you need per-panel identity (e.g. to highlight one bend
  region), use `boundary`'s `regionPanels` array instead, or match against it
  by position.
- **No resolution control on `mesh` yet.** `?resolution=` is accepted in the
  URI template for forward compatibility but currently ignored — tessellation
  is fixed (0.5mm chordal deviation). If you need a coarser/finer mesh for
  different zoom levels, that's not built yet — flag it if it's blocking you.
- **No `drawings` or `findings` resources yet.** Don't build UI against them.
- **Errors** on a resource read come back as the same structured shape as
  every other v2 error: `{code, message, recoverable, suggestedTool}` — e.g.
  `GRAPH_PART_NOT_FOUND` if you ask for a part_id that doesn't exist (or has
  been aliased away by a merge). Nothing new here versus tool-call errors.

## Minimal integration checklist

1. Connect to the v2 MCP server as normal (stdio).
2. To render a part: read `graph://part/{id}/mesh`, `fetch(ref.url)`, feed the
   bytes to your GLTFLoader.
3. To keep it current: either re-fetch `ref.url` after your own mutating tool
   calls, or `resources/subscribe` to the same URI and re-fetch on
   `notifications/resources/updated`.
4. To list what parts exist: `graph://parts`.
5. To render a graph/structure view (not 3D): `graph://part/{id}/full`.

That's the whole surface that's actually live today. Anything beyond this
(findings, drawings, persistence across restarts, resolution control) is not
built — ask before designing UI against it.
