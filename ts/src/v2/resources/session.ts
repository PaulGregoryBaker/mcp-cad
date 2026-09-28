/**
 * Session-scoped resources (spec 010): project history and the operations
 * each revision contains. They read the bound project's Dolt history, so
 * they need the SessionContext (unlike the per-part geometry resources).
 * Outputs are validated against their own schemas before leaving the server.
 */

import { createHash } from 'node:crypto';
import { geometryBinding } from '../../geometry/binding';
import { ErrorCodes, throwError } from '../../mcp/errors';
import { buildV2BlobUrl, v2BlobCache } from '../blob-cache';
import { constructPart } from '../graph/evaluate-client';
import { GraphStore } from '../graph/store';
import { validateRawLoad } from '../persistence/load';
import { diffRevisions } from '../persistence/ref-diff';
import type { SessionContext } from '../persistence/session';
import { ActionLogEntrySchema, HistoryCommitSchema } from '../schemas/persistence';

export const sessionResourceTemplates = [
  {
    uriTemplate: 'graph://history',
    name: 'project-history',
    description:
      "The bound project's revisions (user commits only — edits never commit by themselves), branches, and uncommitted-work status. Each commit reports how many operations it contains and how many were AI-authored.",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://ref/{ref}/parts',
    name: 'revision-parts',
    description:
      "Every part's manufacturing graph as it was at a revision (commit hash or branch name, URL-encoded), read without checking it out — the working branch is untouched. Validated like open_project. PERSIST_SCHEMA_MISMATCH when the revision uses another storage version (check it out to migrate it).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://ref/{ref}/part/{part_id}/mesh',
    name: 'revision-part-mesh',
    description: "A GLB of one part's 3D solid as it was at a revision, served as a Ref (stable per content).",
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://diff/{base}/{target}',
    name: 'revision-diff',
    description:
      'What changed from revision base to revision target, per part: added/removed/modified region panels, bends and holes (by id), outline vertex counts, and scalar field changes (material, thickness, K-factor, placement, name). Unchanged parts are omitted.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://import-sources',
    name: 'import-sources',
    description:
      'The STEP files imported into this project (on the current branch or viewed revision), with where they were read from and when. Use reference_mesh to overlay one on the manufacturing graph.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'graph://ref/{ref}/actions',
    name: 'revision-actions',
    description:
      'The operations (tool, actor human/agent/system, time, change summary) introduced by one revision. ref=WORKING lists the uncommitted operations on the working branch, including undone ones.',
    mimeType: 'application/json',
  },
];

const HISTORY = /^graph:\/\/history$/;
const IMPORT_SOURCES = /^graph:\/\/import-sources$/;
const ACTIONS = /^graph:\/\/ref\/([^/]+)\/actions$/;
const REF_PARTS = /^graph:\/\/ref\/([^/]+)\/parts$/;
const REF_MESH = /^graph:\/\/ref\/([^/]+)\/part\/([^/]+)\/mesh$/;
const DIFF = /^graph:\/\/diff\/([^/]+)\/([^/]+)$/;

export function matchesSessionResource(uri: string): boolean {
  return HISTORY.test(uri) || IMPORT_SOURCES.test(uri) || uri.startsWith('graph://ref/') || DIFF.test(uri);
}

function validated<T>(schema: { safeParse: (d: unknown) => { success: boolean; error?: { message: string } } }, data: T, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throwError(ErrorCodes.INTERNAL_ERROR, `${what} produced a response that doesn't match its own schema: ${r.error?.message}`, false);
  }
  return data;
}

export async function readSessionResource(ctx: SessionContext, uri: string): Promise<unknown> {
  const bound = ctx.requireBound();
  if (HISTORY.test(uri)) {
    const h = await bound.persistence.history(500);
    for (const c of h.commits) validated(HistoryCommitSchema, c, 'graph://history');
    return h;
  }
  if (IMPORT_SOURCES.test(uri)) {
    const sources = await bound.persistence.readImportSources();
    return {
      sources: sources.map((s) => ({ import_source_id: s.import_source_id, file_path: s.file_path, imported_at: s.imported_at })),
    };
  }
  const parts = REF_PARTS.exec(uri);
  if (parts) {
    const ref = decodeURIComponent(parts[1]!);
    const raw = await bound.persistence.readAt(ref);
    const { snapshots } = validateRawLoad(raw, ref);
    return {
      ref,
      parts: snapshots.map((s) => ({ part_id: s.part.partId, merged_into_part_id: s.part.mergedIntoPartId, snapshot: s })),
      client_meta: raw.clientMeta,
    };
  }
  const mesh = REF_MESH.exec(uri);
  if (mesh) {
    const ref = decodeURIComponent(mesh[1]!);
    const partId = decodeURIComponent(mesh[2]!);
    const { snapshots } = validateRawLoad(await bound.persistence.readAt(ref), ref);
    const snap = snapshots.find((s) => s.part.partId === partId);
    if (!snap) throwError(ErrorCodes.GRAPH_PART_NOT_FOUND, `no part ${partId} at revision ${ref}`, false);
    // Keyed by content: the same historical part is built once, whatever
    // ref names it; the live store is never touched.
    const hash = createHash('sha256').update(JSON.stringify(snap)).digest('hex');
    const key = `ref-mesh/${hash}`;
    const entry = v2BlobCache.getOrRebuild(key, 'model/gltf-binary', hash, () => {
      const store = new GraphStore();
      for (const s of snapshots) store.restorePart(s);
      const constructed = constructPart(store, partId);
      if (!constructed.ok) {
        throwError((constructed.errorCode || ErrorCodes.INTERNAL_ERROR) as never, constructed.message || `cannot build part ${partId} at ${ref}`, false);
      }
      return geometryBinding.exportGlb(constructed.shellId);
    });
    return {
      ref: { url: buildV2BlobUrl(key), contentType: entry.contentType, byteSize: entry.buffer.length, expiresAt: new Date(entry.expiresAt).toISOString() },
    };
  }
  const diff = DIFF.exec(uri);
  if (diff) {
    const base = decodeURIComponent(diff[1]!);
    const target = decodeURIComponent(diff[2]!);
    const [b, t] = [await bound.persistence.readAt(base), await bound.persistence.readAt(target)];
    validateRawLoad(b, base);
    validateRawLoad(t, target);
    return { base, target, parts: diffRevisions(b.rows, t.rows) };
  }
  const m = ACTIONS.exec(uri);
  if (m) {
    const ref = decodeURIComponent(m[1]!);
    const actions = await bound.persistence.actionsAt(ref);
    for (const a of actions) validated(ActionLogEntrySchema, a, 'graph://ref/{ref}/actions');
    return { actions };
  }
  throwError(ErrorCodes.INTERNAL_ERROR, `Unrecognized session resource: ${uri}`, false);
}
