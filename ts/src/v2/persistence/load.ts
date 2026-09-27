/**
 * Shared load path (spec 010, R-005/R-013): raw rows → validated snapshots.
 * Used by open_project, refresh_project, checkout, undo, discard and the
 * graph://ref/{ref}/* reads. All-or-nothing: any problem throws, and callers
 * only touch the GraphStore after this returns.
 */

import { ErrorCodes, throwError } from '../../mcp/errors';
import { checkGraphInvariants, checkStoreInvariants } from '../graph/invariants';
import type { PartGraphSnapshot } from '../graph/store';
import { validatePersisted } from '../schemas/persistence';
import { rowsToSnapshots, type ShadowStore } from './row-mapper';
import type { RawLoad } from './port';

export interface ValidatedLoad {
  snapshots: PartGraphSnapshot[];
  shadows: ShadowStore;
}

export function validateRawLoad(raw: RawLoad, ref: string): ValidatedLoad {
  const assembled = rowsToSnapshots(raw.rows);
  if (assembled.problems.length > 0) {
    const p = assembled.problems[0]!;
    throwError(ErrorCodes.PERSIST_CORRUPT_ROW, `stored project data is corrupt at ${p.table} ${p.key}: ${p.issue}`, false, undefined, {
      details: { table: p.table, key: p.key, ref, issues: assembled.problems.map((x) => x.issue) },
    });
  }
  for (const s of assembled.snapshots) {
    const r = validatePersisted('part_graph_snapshot', s);
    if (!r.ok) {
      throwError(ErrorCodes.PERSIST_CORRUPT_ROW, `stored part ${s.part.partId} is malformed: ${r.issues[0]}`, false, undefined, {
        details: { table: 'part', key: s.part.partId, ref, issues: r.issues },
      });
    }
    const v = checkGraphInvariants(s);
    if (v.length > 0) {
      throwError(ErrorCodes.PERSIST_INVARIANT_VIOLATION, `stored part ${s.part.partId} violates ${v[0]!.code}: ${v[0]!.message}`, false, undefined, {
        details: { part_id: s.part.partId, ref, violations: v.map((x) => ({ code: x.code, message: x.message })) },
      });
    }
  }
  const cross = checkStoreInvariants(assembled.snapshots, raw.clientMeta.map((m) => m.part_id));
  if (cross.length > 0) {
    throwError(ErrorCodes.PERSIST_INVARIANT_VIOLATION, `stored project violates ${cross[0]!.code}: ${cross[0]!.message}`, false, undefined, {
      details: { part_id: cross[0]!.partId, ref, violations: cross.map((x) => ({ code: x.code, message: x.message })) },
    });
  }
  for (const [k, v] of Object.entries(raw.settings)) {
    if (v === null) continue;
    const check = validatePersisted('project_settings', { manufacturing_profile: null, manufacturing_defaults: null, nesting: null, [k]: v });
    if (!check.ok) {
      throwError(ErrorCodes.PERSIST_CORRUPT_ROW, `stored project settings '${k}' are malformed: ${check.issues[0]}`, false, undefined, {
        details: { table: 'project_settings', key: k, ref, issues: check.issues },
      });
    }
  }
  return { snapshots: assembled.snapshots, shadows: assembled.shadows };
}
