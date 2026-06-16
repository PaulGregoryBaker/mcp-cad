/**
 * Shared handler utilities — argument validation, transaction context, geometry target
 * resolution, and post-transform graph bookkeeping.
 *
 * Import from here in handler modules instead of from tools.ts to avoid circular deps.
 */

import { throwError, ErrorCodes } from './errors.js';
import { transactionRegistry } from './transactions.js';
import { getParts } from './state.js';
import { ManufacturingGraph } from '../manufacturing/graph/graph.js';
import { session } from '../geometry/session.js';
import type { ShapeHistoryRecord } from '../geometry/types.js';

// ─── Argument helpers ─────────────────────────────────────────────────────────

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || val.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required parameter: ${key}`, false);
  }
  return val as string;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const val = args[key];
  if (!Array.isArray(val) || val.length === 0) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required array parameter: ${key}`, false);
  }
  return val as string[];
}

export function requireNumberArray(args: Record<string, unknown>, key: string, length: number): number[] {
  const val = args[key];
  if (!Array.isArray(val) || val.length < length) {
    throwError(ErrorCodes.GE_BOOLEAN_FAILURE, `${key} must be an array of ${length} numbers`, false);
  }
  return val as number[];
}

export function optBool(args: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  return (args[key] as boolean | undefined) ?? defaultValue;
}

export function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = args[key];
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throwError(ErrorCodes.INTERNAL_ERROR, `Missing required object parameter: ${key}`, false);
  }
  return val as Record<string, unknown>;
}

// ─── Transaction context ──────────────────────────────────────────────────────

export type TransactionContext = { mode: 'join'; transactionId: string } | { mode: 'implicit' };

export function resolveTransactionContext(args: Record<string, unknown>): TransactionContext {
  const specifiedId = typeof args['transaction_id'] === 'string' ? args['transaction_id'] : undefined;
  const active = transactionRegistry.getActive();

  if (specifiedId !== undefined) {
    if (!active || active.id !== specifiedId) {
      throwError(
        ErrorCodes.TRANSACTION_MISMATCH,
        active
          ? `Specified transaction_id ${specifiedId} does not match the active transaction ${active.id}.`
          : `No active transaction; cannot join transaction ${specifiedId}.`,
        true,
        'begin_transaction',
      );
    }
    return { mode: 'join', transactionId: specifiedId };
  }

  if (active) {
    return { mode: 'join', transactionId: active.id };
  }

  return { mode: 'implicit' };
}

// ─── Geometry target resolution ───────────────────────────────────────────────

// If target is a part_id, looks up the canonical panel's bodyId.
// Returns { shellId, partGraph } where partGraph is non-null only if target was a part_id.
export function resolveTargetToShell(target: string): { shellId: string; partGraph: ManufacturingGraph | undefined } {
  if (getParts().has(target)) {
    const graph = getParts().get(target)!;
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode') {
        const pn = node as import('../manufacturing/graph/types.js').PanelNode;
        if (pn.canonical !== false && pn.bodyId !== null) {
          return { shellId: pn.bodyId, partGraph: graph };
        }
      }
    }
    throwError(
      ErrorCodes.GRAPH_INTEGRITY_ERROR,
      `Part "${target}" has no valid canonical panel to transform.`,
      true,
      'solve_geometry',
    );
  }

  return { shellId: target, partGraph: undefined };
}

// ─── Post-transform graph bookkeeping ────────────────────────────────────────

// Updates a panel node's bodyId after a transform and registers the new shell ID
// as an alias in parts so apply_unfold can find it by either the original part_id
// or the new solid_id returned by the transform.
export function updatePanelBodyIdAfterTransform(
  oldShellId: string,
  newShellId: string,
  partGraph: ManufacturingGraph | undefined,
  keepOriginal: boolean,
): void {
  if (keepOriginal) return;
  if (newShellId === oldShellId) return;

  const toBodyId = (s: string) => s as import('../manufacturing/graph/types.js').BodyId;
  const oldBodyId = oldShellId as import('../manufacturing/graph/types.js').BodyId;
  const newBodyId = toBodyId(newShellId);

  if (partGraph) {
    for (const node of partGraph.nodes.values()) {
      if (node.type === 'PanelNode') {
        const pn = node as import('../manufacturing/graph/types.js').PanelNode;
        if (pn.bodyId === oldBodyId) {
          pn.bodyId = newBodyId;
          pn.panelFrame = null;
          break;
        }
      }
    }
    if (!getParts().has(newShellId)) {
      getParts().set(newShellId, partGraph);
    }
  } else {
    for (const [, graph] of getParts().entries()) {
      for (const node of graph.nodes.values()) {
        if (node.type === 'PanelNode') {
          const pn = node as import('../manufacturing/graph/types.js').PanelNode;
          if (pn.bodyId === oldBodyId) {
            pn.bodyId = newBodyId;
            pn.panelFrame = null;
            if (!getParts().has(newShellId)) {
              getParts().set(newShellId, graph);
            }
            return;
          }
        }
      }
    }
  }
}

// ─── Mutating-op response helpers ─────────────────────────────────────────────

export function buildMeshUrl(solidId: string): string {
  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return `${meshBaseUrl}/mesh/${solidId}.glb`;
}

export function buildMeshUrls(solidIds: string[]): string[] {
  return solidIds.map(buildMeshUrl);
}

export function resolveRollbackToken(ctx: TransactionContext, fallbackToken: string): string {
  return ctx.mode === 'join' ? ctx.transactionId : fallbackToken;
}

export function appendHistoryIfJoined(ctx: TransactionContext, history: ShapeHistoryRecord[] | undefined): void {
  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, history ?? []);
  }
}

// Applies a per-target mutating transform (translate/rotate/mirror/scale), handling
// shell registration, transaction history, and manufacturing-graph bodyId bookkeeping
// identically across all four callers.
export function applyPerTargetTransform<T extends { solid_id: string; shape_history?: ShapeHistoryRecord[] }>(
  targets: string[],
  ctx: TransactionContext,
  keepOriginal: boolean,
  transformFn: (shellId: string) => T,
): T[] {
  const results: T[] = [];
  for (const target of targets) {
    const { shellId, partGraph } = resolveTargetToShell(target);
    const res = transformFn(shellId);
    results.push(res);
    session.registerShell(res.solid_id);
    appendHistoryIfJoined(ctx, res.shape_history);
    updatePanelBodyIdAfterTransform(shellId, res.solid_id, partGraph, keepOriginal);
  }
  return results;
}
