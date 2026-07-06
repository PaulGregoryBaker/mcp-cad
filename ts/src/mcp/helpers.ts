/**
 * Shared handler utilities — argument validation, transaction context, geometry target
 * resolution, and post-transform graph bookkeeping.
 *
 * Import from here in handler modules instead of from tools.ts to avoid circular deps.
 */

import { throwError, ErrorCodes } from './errors.js';
import { transactionRegistry } from './transactions.js';
import { getParts, getGeometryBinding } from './state.js';
import { ManufacturingGraph } from '../manufacturing/graph/graph.js';
import { session } from '../geometry/session.js';
import type { ShapeHistoryRecord } from '../geometry/types.js';

// ─── Panel midplane offset (manufacturing-graph placement data) ──────────────

// Measures a panel's true-material midplane offset along ITS OWN frame normal,
// once, at panel-creation time — stored on the PanelNode (midplaneOffsetMm) so
// later rebuilds (fuse_bodies, merge_bodies_with_bend) never need to re-measure
// the live shell. measurePanelThickness's own dominant-face normal is an
// arbitrary tie-break between a panel's two near-equal-area skins and may
// point opposite to the panel's OWN reported frame normal; re-expressing the
// offset along that frame normal (negating when they disagree) keeps the
// stored value consistent with how the rest of the graph uses panelFrame.
export function measurePanelMidplaneOffsetMm(
  shellId: string,
  frameNormal: [number, number, number],
): number | null {
  try {
    const pt = getGeometryBinding().measurePanelThickness(shellId);
    if (!pt.ok) return null;
    const dot =
      pt.dominant_normal_x * frameNormal[0] +
      pt.dominant_normal_y * frameNormal[1] +
      pt.dominant_normal_z * frameNormal[2];
    const sign = dot >= 0 ? 1 : -1;
    return sign * pt.midplane_offset_mm;
  } catch {
    return null;
  }
}

// Re-derives a panel's frame + midplane offset on its CURRENT shell — used
// immediately after a rigid transform (translate/rotate/mirror/scale) moves
// it, so the graph's stored placement data stays correct for that shell going
// forward. This is the one-time, at-the-moment-of-change discovery the
// manufacturing graph is built from; once stored, no downstream consumer
// (fuse_bodies, merge_bodies_with_bend) re-queries the shell.
//
// expectedFlatWidth/expectedFlatHeight (the panel's OWN flatWidth/flatHeight,
// set when its shapeDxf was created) correct a real desync: getPanelFrame's
// live query always picks U as the longer in-plane axis, independent of
// whichever axis was actually called U when shapeDxf was built (a
// hand-specified frame, or a DXF-aligned frame from an earlier merge/fuse
// don't necessarily follow that same convention). A transform that doesn't
// change the panel's shape at all can still see this fresh query swap U/V
// relative to the panel's previously-stored convention — and since shapeDxf
// is never regenerated on transform, that silently desyncs panelFrame from
// the DXF it's supposed to place, corrupting any later fuse/merge that reads
// both. Comparing the live query's own uExtentMm/vExtentMm against the
// panel's stored flat dimensions detects the swap and corrects it back.
export function refreshPanelFrame(
  shellId: string,
  expectedFlatWidth?: number | null,
  expectedFlatHeight?: number | null,
): { origin: [number, number, number]; u: [number, number, number]; v: [number, number, number]; vExtentMm: number; normal: [number, number, number]; midplaneOffsetMm: number | null } | null {
  try {
    const pf = getGeometryBinding().getPanelFrame(shellId);
    let u: [number, number, number] = [pf.uX, pf.uY, pf.uZ];
    let v: [number, number, number] = [pf.vX, pf.vY, pf.vZ];
    let vExtentMm = pf.vExtentMm;

    if (
      expectedFlatWidth != null && expectedFlatHeight != null &&
      Math.abs(expectedFlatWidth - expectedFlatHeight) > 1e-6
    ) {
      const asIsError = Math.abs(pf.uExtentMm - expectedFlatWidth) + Math.abs(pf.vExtentMm - expectedFlatHeight);
      const swappedError = Math.abs(pf.uExtentMm - expectedFlatHeight) + Math.abs(pf.vExtentMm - expectedFlatWidth);
      if (swappedError < asIsError) {
        [u, v] = [v, u];
        vExtentMm = pf.uExtentMm;
      }
    }

    const frame = {
      origin: [pf.originX, pf.originY, pf.originZ] as [number, number, number],
      u, v,
      vExtentMm,
      normal: [pf.normalX, pf.normalY, pf.normalZ] as [number, number, number],
    };
    const midplaneOffsetMm = measurePanelMidplaneOffsetMm(shellId, [pf.normalX, pf.normalY, pf.normalZ]);
    return { ...frame, midplaneOffsetMm };
  } catch {
    return null;
  }
}

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
// as an alias in parts so get_unfold can find it by either the original part_id
// or the new solid_id returned by the transform.
export function updatePanelBodyIdAfterTransform(
  oldShellId: string,
  newShellId: string,
  partGraph: ManufacturingGraph | undefined,
  keepOriginal: boolean,
): void {
  if (keepOriginal) return;
  if (newShellId === oldShellId) return;

  const oldBodyId = oldShellId as import('../manufacturing/graph/types.js').BodyId;
  const newBodyId = newShellId as import('../manufacturing/graph/types.js').BodyId;

  // The transform moved the shell, so the OLD panelFrame/midplaneOffsetMm are
  // stale. Re-derive them on the NEW shell right now — graph data must stay
  // correct for whoever's bodyId this becomes, since nothing downstream
  // (fuse_bodies, merge_bodies_with_bend) queries the live shell itself. Find
  // the matching node FIRST so its stored flatWidth/flatHeight (the
  // convention shapeDxf was actually built with) can be passed to
  // refreshPanelFrame to correct any U/V swap in the fresh query.
  const applyRefresh = (pn: import('../manufacturing/graph/types.js').PanelNode): void => {
    const refreshed = refreshPanelFrame(newShellId, pn.flatWidth, pn.flatHeight);
    pn.bodyId = newBodyId;
    pn.panelFrame = refreshed;
    pn.midplaneOffsetMm = refreshed?.midplaneOffsetMm ?? null;
  };

  if (partGraph) {
    for (const node of partGraph.nodes.values()) {
      if (node.type === 'PanelNode') {
        const pn = node as import('../manufacturing/graph/types.js').PanelNode;
        if (pn.bodyId === oldBodyId) {
          applyRefresh(pn);
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
            applyRefresh(pn);
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
