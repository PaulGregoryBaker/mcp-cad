/**
 * Session-scoped resources (spec 010): project history and the operations
 * each revision contains. They read the bound project's Dolt history, so
 * they need the SessionContext (unlike the per-part geometry resources).
 * Outputs are validated against their own schemas before leaving the server.
 */

import { ErrorCodes, throwError } from '../../mcp/errors';
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
    uriTemplate: 'graph://ref/{ref}/actions',
    name: 'revision-actions',
    description:
      'The operations (tool, actor human/agent/system, time, change summary) introduced by one revision. ref=WORKING lists the uncommitted operations on the working branch, including undone ones.',
    mimeType: 'application/json',
  },
];

const HISTORY = /^graph:\/\/history$/;
const ACTIONS = /^graph:\/\/ref\/([^/]+)\/actions$/;

export function matchesSessionResource(uri: string): boolean {
  return HISTORY.test(uri) || uri.startsWith('graph://ref/');
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
  const m = ACTIONS.exec(uri);
  if (m) {
    const ref = decodeURIComponent(m[1]!);
    const actions = await bound.persistence.actionsAt(ref);
    for (const a of actions) validated(ActionLogEntrySchema, a, 'graph://ref/{ref}/actions');
    return { actions };
  }
  throwError(ErrorCodes.INTERNAL_ERROR, `Unrecognized session resource: ${uri}`, false);
}
