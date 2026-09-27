/**
 * persistMutation — write-through of one graph mutation (spec 010, R-015/R-016, T022).
 *
 *  1. guards: bound project, not main, not a read-only view
 *  2. before = store.snapshotAll()
 *  3. run the tool (in memory)
 *  4. diff changed parts → normalised row diff (identity-preserving via shadows)
 *  5. validate every changed part (Zod + structural invariants) and the store
 *  6. ONE SQL transaction: rows + side writes + one action_log row (undo_delta)
 *  7. only then return — with `action_seq`
 *
 * Any failure after step 2 restores the in-memory store to `before`, so memory
 * and storage never disagree (Principle VI). A validation failure here is
 * this server's own bug → INTERNAL_ERROR; a storage failure → PERSIST_WRITE_FAILED.
 */

import { ErrorCodes, McpToolError, throwError } from '../../mcp/errors';
import { checkGraphInvariants, checkStoreInvariants } from '../graph/invariants';
import type { PartGraphSnapshot } from '../graph/store';
import type { BendRow, PartRow, RegionPanelRow } from '../graph/types';
import { validatePersisted } from '../schemas/persistence';
import type { ActionRecord, ClientMetaRow, SideWrites } from './port';
import { diffRows, emptyRows, isEmptyDiff, mergeRows, snapshotToRows, type PartShadow } from './row-mapper';
import type { SessionContext } from './session';

export interface ActorArg {
  kind?: 'human' | 'agent';
  id?: string;
}

export interface PersistOptions<T> {
  /** Extra non-graph writes derived from the tool's result (e.g. import_source). */
  side?: (result: T) => SideWrites;
  /** Force an action row even when the graph did not change (settings/meta-only tools). */
  allowEmptyGraphDiff?: boolean;
}

type StoreImage = { parts: PartRow[]; regionPanels: RegionPanelRow[]; bends: BendRow[] };

function snapshotsFromImage(img: StoreImage): Map<string, PartGraphSnapshot> {
  const out = new Map<string, PartGraphSnapshot>();
  for (const part of img.parts) out.set(part.partId, { part, regionPanels: [], bends: [] });
  for (const p of img.regionPanels) out.get(p.partId)?.regionPanels.push(p);
  for (const b of img.bends) out.get(b.partId)?.bends.push(b);
  return out;
}

/** Default presentation doc for a part the server just created (client owns the schema). */
export function defaultClientMeta(part: PartRow): Record<string, unknown> {
  return { v: 1, displayName: part.name, hidden: false, excludedFromNesting: false };
}

export async function persistMutation<T>(
  ctx: SessionContext,
  toolName: string,
  args: Record<string, unknown>,
  fn: () => T | Promise<T>,
  opts: PersistOptions<T> = {},
): Promise<T & { action_seq: number | null }> {
  const bound = ctx.requireBound();
  const p = bound.persistence;
  if (p.readOnlyRef !== null) {
    throwError(ErrorCodes.PERSIST_READ_ONLY_REF, `viewing read-only revision ${p.readOnlyRef.slice(0, 8)}; start a branch to edit`, true);
  }
  if (p.branch === 'main') {
    throwError(ErrorCodes.PERSIST_ON_MAIN, 'edits are never saved on main; open a working branch first (branch_begin)', true, 'branch_begin');
  }

  const store = ctx.store;
  const before = store.snapshotAll();
  let result: T;
  try {
    result = await fn();
  } catch (e) {
    store.restoreAll(before);
    throw e;
  }

  try {
    const beforeByPart = snapshotsFromImage(before);
    const afterIds = store.partIds();
    const afterByPart = new Map(afterIds.map((id) => [id, store.snapshotPart(id)]));

    const changed: string[] = [];
    for (const id of new Set([...beforeByPart.keys(), ...afterIds])) {
      const b = beforeByPart.get(id);
      const a = afterByPart.get(id);
      if (!b || !a || JSON.stringify(b) !== JSON.stringify(a)) changed.push(id);
    }

    // Validate every changed part, then the store as a whole.
    for (const id of changed) {
      const snap = afterByPart.get(id);
      if (!snap) continue;
      const z = validatePersisted('part_graph_snapshot', snap);
      const inv = checkGraphInvariants(snap);
      if (!z.ok || inv.length > 0) {
        throwError(
          ErrorCodes.INTERNAL_ERROR,
          `${toolName} produced an invalid graph for part ${id}; nothing was saved`,
          false,
          undefined,
          { details: { tool: toolName, part_id: id, schema_issues: z.ok ? [] : z.issues, violations: inv } },
        );
      }
    }
    const storeViolations = checkStoreInvariants([...afterByPart.values()]);
    if (storeViolations.length > 0) {
      throwError(ErrorCodes.INTERNAL_ERROR, `${toolName} produced an inconsistent project; nothing was saved`, false, undefined, {
        details: { tool: toolName, violations: storeViolations },
      });
    }

    // Row diff over the changed parts only.
    const beforeRows = emptyRows();
    const afterRows = emptyRows();
    const newShadows = new Map<string, PartShadow | null>();
    for (const id of changed) {
      const shadow = bound.shadows.get(id);
      const b = beforeByPart.get(id);
      const a = afterByPart.get(id);
      if (b) mergeRows(beforeRows, snapshotToRows(b, shadow).rows);
      if (a) {
        const res = snapshotToRows(a, shadow);
        mergeRows(afterRows, res.rows);
        newShadows.set(id, res.shadow);
        if (res.fullRewriteRings.length > 0) {
          console.error(`[persist] ${toolName}: full vertex rewrite for ring(s) ${res.fullRewriteRings.join(', ')} (edit too large to align)`);
        }
      } else {
        newShadows.set(id, null);
      }
    }
    const diff = diffRows(beforeRows, afterRows);

    const side: SideWrites = opts.side ? opts.side(result) : {};
    const newParts = afterIds.filter((id) => !beforeByPart.has(id));
    if (newParts.length > 0) {
      const defaults: ClientMetaRow[] = newParts.map((id) => ({ part_id: id, doc: defaultClientMeta(afterByPart.get(id)!.part) }));
      const provided = new Set((side.clientMetaUpserts ?? []).map((m) => m.part_id));
      side.clientMetaUpserts = [...(side.clientMetaUpserts ?? []), ...defaults.filter((d) => !provided.has(d.part_id))];
    }

    const hasSide = Boolean(side.clientMetaUpserts?.length || (side.settingsPatch && Object.keys(side.settingsPatch).length) || side.importSource);
    if (isEmptyDiff(diff) && !hasSide && !opts.allowEmptyGraphDiff) {
      return { ...(result as object), action_seq: null } as T & { action_seq: number | null };
    }

    const actor = (args['actor'] ?? {}) as ActorArg;
    const params = { ...args };
    delete params['actor'];
    const action: ActionRecord = {
      actorKind: actor.kind === 'agent' ? 'agent' : 'human',
      actorId: actor.id ?? p.author.email,
      tool: toolName,
      params,
      deltaSummary: {
        parts: changed,
        created_parts: newParts,
        upserts: Object.fromEntries(Object.entries(diff.upserts).map(([k, v]) => [k, (v as unknown[]).length]).filter(([, n]) => n)),
        deletes: Object.fromEntries(Object.entries(diff.deletes).map(([k, v]) => [k, v.length]).filter(([, n]) => n)),
      },
    };

    const seq = await p.applyChange(diff, side, action);

    for (const [id, sh] of newShadows) {
      if (sh === null) bound.shadows.delete(id);
      else bound.shadows.set(id, sh);
    }
    return { ...(result as object), action_seq: seq } as T & { action_seq: number | null };
  } catch (e) {
    store.restoreAll(before);
    if (e instanceof McpToolError) throw e;
    throwError(ErrorCodes.PERSIST_WRITE_FAILED, `${toolName}: ${String((e as Error)?.message ?? e)}`, true);
  }
}
