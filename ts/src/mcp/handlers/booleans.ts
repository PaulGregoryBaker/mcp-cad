import { throwError, ErrorCodes } from '../errors.js';
import {
  getGeometryBinding,
  getActivePartId,
  setActivePartIdInternal,
  getParts,
  createPart,
} from '../state.js';
import { requireString, requireStringArray, resolveTransactionContext, resolveTargetToShell } from '../helpers.js';
import { mergeInputDxfOutlines } from '../dxf-helpers.js';
import { session } from '../../geometry/session.js';
import { transactionRegistry } from '../transactions.js';
import { ManufacturingGraph } from '../../manufacturing/graph/graph.js';
import { toNodeId } from '../../manufacturing/graph/types.js';
import type { PanelNode, PanelFrame } from '../../manufacturing/graph/types.js';
import { computeDxfMergePlacement } from '../../manufacturing/dxf/orientation.js';
import { checkDxfUnionConnectivity } from '../../manufacturing/dxf/merge.js';

// ─── Tool schemas ─────────────────────────────────────────────────────────────

export const booleanDefinitions = [
  {
    name: 'fuse_bodies',
    description: 'Merges two or more solids/shells into a single continuous body using a Boolean union. If input bodies have Manufacturing Graphs, graphs are merged (all absorbed into first part) and target panel outline is expanded. Returns new body id and affected part_id. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'IDs of the bodies to fuse',
        },
        fuzzy_tolerance: {
          type: 'number',
          default: 1e-5,
          description: 'Fuzzy tolerance for near-coincident geometry (mm)',
        },
        transaction_id: { type: 'string' },
      },
      required: ['tools', 'transaction_id'],
    },
  },
  {
    name: 'cut_bodies',
    description: 'Subtracts tool bodies from a blank body (Boolean difference). Returns the modified blank as a new body id. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        blank: { type: 'string', description: 'Body to cut into' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Cutter body IDs',
        },
        keep_tools: {
          type: 'boolean',
          default: false,
          description: 'If false, tool bodies are removed from the session after the cut',
        },
        transaction_id: { type: 'string' },
      },
      required: ['blank', 'tools', 'transaction_id'],
    },
  },
  {
    name: 'intersect_bodies',
    description: 'Returns the shared volume between two overlapping bodies (Boolean intersection). Returns a new body id, or GE_BOOLEAN_EMPTY_RESULT if no overlap. Mutating — requires transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        target_a: { type: 'string', description: 'First body ID' },
        target_b: { type: 'string', description: 'Second body ID' },
        transaction_id: { type: 'string' },
      },
      required: ['target_a', 'target_b', 'transaction_id'],
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function handleFuseBodies(args: Record<string, unknown>): unknown {
  const tools = requireStringArray(args, 'tools');
  const fuzzyTolerance = (args['fuzzy_tolerance'] as number | undefined) ?? 1e-5;
  const ctx = resolveTransactionContext(args);

  const shellIds: string[] = [];
  for (const toolId of tools) {
    const { shellId } = resolveTargetToShell(toolId);
    shellIds.push(shellId);
  }

  // ── Pre-flight validation (FR-006: fail fast before any mutation) ────────────
  const FUSE_THICKNESS_TOLERANCE_MM = 0.1;
  const FUSE_COPLANARITY_THRESHOLD_DEG = 2;

  const fusePanels: Array<{ partId: string; node: PanelNode }> = [];
  for (const toolId of tools) {
    const graph = getParts().get(toolId);
    if (!graph) continue;
    for (const node of graph.nodes.values()) {
      if (node.type === 'PanelNode' && node.canonical !== false) {
        fusePanels.push({ partId: toolId, node: node as PanelNode });
        break;
      }
    }
  }

  if (fusePanels.length >= 2) {
    const pA = fusePanels[0]!.node;
    const pB = fusePanels[1]!.node;

    if (Math.abs(pA.nominalThickness - pB.nominalThickness) > FUSE_THICKNESS_TOLERANCE_MM) {
      throwError(
        ErrorCodes.GE_FUSE_THICKNESS_MISMATCH,
        `Cannot fuse panels with different nominal thicknesses (${pA.nominalThickness}mm vs ${pB.nominalThickness}mm). ` +
        `Thickness must match within ${FUSE_THICKNESS_TOLERANCE_MM}mm for a valid coplanar fuse.`,
        false,
      );
    }

    if (pA.panelFrame && pB.panelFrame) {
      const fA = pA.panelFrame;
      const fB = pB.panelFrame;
      const nA: [number, number, number] = [
        fA.u[1] * fA.v[2] - fA.u[2] * fA.v[1],
        fA.u[2] * fA.v[0] - fA.u[0] * fA.v[2],
        fA.u[0] * fA.v[1] - fA.u[1] * fA.v[0],
      ];
      const nB: [number, number, number] = [
        fB.u[1] * fB.v[2] - fB.u[2] * fB.v[1],
        fB.u[2] * fB.v[0] - fB.u[0] * fB.v[2],
        fB.u[0] * fB.v[1] - fB.u[1] * fB.v[0],
      ];
      const normA = Math.hypot(nA[0], nA[1], nA[2]);
      const normB = Math.hypot(nB[0], nB[1], nB[2]);
      if (normA > 1e-10 && normB > 1e-10) {
        const dot = (nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]) / (normA * normB);
        const angleDeg = Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
        if (angleDeg > FUSE_COPLANARITY_THRESHOLD_DEG) {
          throwError(
            ErrorCodes.GE_FUSE_NOT_COPLANAR,
            `Cannot fuse panels whose face normals differ by more than ${FUSE_COPLANARITY_THRESHOLD_DEG}°. ` +
            `These panels are at a bend angle — use merge_bodies_with_bend instead.`,
            false,
            'merge_bodies_with_bend',
          );
        }
      }

      if (pA.shapeDxf && pB.shapeDxf) {
        try {
          const contactToleranceMm = Math.max(pA.nominalThickness, pB.nominalThickness) * 2.5;
          const placement = computeDxfMergePlacement(fA, fB, { contactToleranceMm });
          const connected = checkDxfUnionConnectivity(pA.shapeDxf, pB.shapeDxf, {
            rotationMatrix: placement.rotationMatrix,
            translation: placement.translation,
          });
          if (!connected) {
            throwError(
              ErrorCodes.GE_FUSE_DISJOINT_RESULT,
              'Cannot fuse panels whose outlines do not touch or overlap. The resulting flat pattern would be disconnected.',
              false,
            );
          }
        } catch (err) {
          if (err instanceof Error && (err as { code?: string }).code === ErrorCodes.GE_FUSE_DISJOINT_RESULT) {
            throw err;
          }
          // DXF connectivity check failed for non-disjoint reason — don't block the fuse
        }
      }
    }
  }

  const preservedPartId = tools[0]!;

  const graphPartIds: string[] = [];
  for (const toolId of tools) {
    if (getParts().has(toolId)) graphPartIds.push(toolId);
  }

  if (graphPartIds.length > 0) {
    const sourcePartIds = graphPartIds.filter((id) => id !== preservedPartId);
    const preFusePartIds = [...new Set([preservedPartId, ...graphPartIds])];

    const snapshotId = getGeometryBinding().createSnapshot('fuse_bodies_preflight');

    const savedParts = new Map<string, ManufacturingGraph | undefined>();
    for (const pid of preFusePartIds) {
      savedParts.set(pid, getParts().get(pid));
    }
    const savedActivePartId = getActivePartId();

    for (const pid of preFusePartIds) {
      getParts().delete(pid);
    }
    if (getActivePartId() && preFusePartIds.includes(getActivePartId()!)) {
      setActivePartIdInternal(undefined);
    }

    const fusedGraph = createPart(preservedPartId);
    const toBodyIdLocal = (s: string): import('../../manufacturing/graph/types.js').BodyId =>
      s as import('../../manufacturing/graph/types.js').BodyId;

    const panelDxfs: (string | null)[] = [];
    const panelFrames: (PanelFrame | null)[] = [];
    let allInputsHaveDimensions = tools.length === graphPartIds.length;
    let combinedThickness = 0;

    const shellByTool = new Map<string, string>();
    tools.forEach((t, i) => { if (shellIds[i]) shellByTool.set(t, shellIds[i]!); });

    for (const pid of [preservedPartId, ...sourcePartIds]) {
      const g = savedParts.get(pid);
      if (!g) {
        allInputsHaveDimensions = false;
        continue;
      }
      for (const node of g.nodes.values()) {
        if (node.type === 'PanelNode' && node.canonical !== false) {
          const pn = node as PanelNode;
          panelDxfs.push(pn.shapeDxf ?? null);
          let frame: PanelFrame | null = pn.panelFrame ?? null;
          const shellId = shellByTool.get(pid);
          if (shellId && getGeometryBinding().hasGetPanelFrame()) {
            try {
              const pf = getGeometryBinding().getPanelFrame(shellId);
              frame = {
                origin: [pf.originX, pf.originY, pf.originZ],
                u: [pf.uX, pf.uY, pf.uZ],
                v: [pf.vX, pf.vY, pf.vZ],
              };
            } catch { /* keep stored frame */ }
          }
          panelFrames.push(frame);
          combinedThickness = Math.max(combinedThickness, pn.nominalThickness);
          if (!pn.shapeDxf) allInputsHaveDimensions = false;
          break;
        }
      }
    }

    const nominalThickness = combinedThickness > 0 ? combinedThickness : 1.0;
    let flatWidth: number | null = null;
    let flatHeight: number | null = null;
    let shapeDxf: string | null = null;

    if (allInputsHaveDimensions && panelDxfs.length > 0) {
      try {
        const merged = mergeInputDxfOutlines(panelDxfs, panelFrames, Math.max(nominalThickness * 2.5, 1));
        if (merged) {
          shapeDxf = merged.mergedDxf;
          flatWidth = merged.width;
          flatHeight = merged.height;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isDisconnected = msg.includes('disconnected') || msg.includes('2 regions');
        if (isDisconnected) {
          getParts().delete(preservedPartId);
          for (const pid of preFusePartIds) {
            const saved = savedParts.get(pid);
            if (saved) getParts().set(pid, saved);
          }
          setActivePartIdInternal(savedActivePartId);
          try { getGeometryBinding().restoreSnapshot(snapshotId); } catch { /* best effort */ }
          throwError(
            ErrorCodes.GE_FUSE_DISJOINT_RESULT,
            'Cannot fuse panels: the flat-pattern outlines do not touch or overlap. ' +
            'Check that the panels are physically adjacent before fusing. ' +
            `(${msg})`,
            false,
          );
        }
        console.warn(`[handleFuseBodies] DXF merge failed: ${msg}. Falling back to null dimensions.`);
      }
    }

    const isDirty = flatWidth === null || flatHeight === null;

    for (const pid of preFusePartIds) {
      getParts().set(pid, fusedGraph);
      fusedGraph.addNode({
        type: 'PanelNode',
        id: toNodeId(pid),
        bodyId: null,
        dirty: isDirty,
        materialType: 'default',
        nominalThickness,
        flatWidth,
        flatHeight,
        canonical: pid === preservedPartId,
        shapeDxf,
      });
    }

    const canonicalNode = fusedGraph.nodes.get(toNodeId(preservedPartId)) as PanelNode;

    let fusedSolidId: string | undefined;
    let disjointFlag = false;
    let rollbackToken: string | undefined;
    let shapeHistoryData: unknown[] = [];

    try {
      const gb = getGeometryBinding();
      if (shapeDxf !== null && gb.hasBuildShellFromFlatPattern()) {
        const res = gb.buildShellFromFlatPattern(shapeDxf, [], nominalThickness, shellIds[0]);
        fusedSolidId = res.shellId;
      } else if (shapeDxf !== null && gb.hasBuildSheetFromDxf() && gb.hasThickenSheet()) {
        const sheetResult = gb.buildSheetFromDxf!(shapeDxf);
        const thickenResult = gb.thickenSheet!(sheetResult.sheetId, nominalThickness);
        fusedSolidId = thickenResult.solidId;
      } else {
        const fuseResult = gb.fuseBodies(shellIds, fuzzyTolerance);
        fusedSolidId = fuseResult.solid_id;
        disjointFlag = fuseResult.disjoint;
        rollbackToken = fuseResult.rollback_token;
        shapeHistoryData = fuseResult.shape_history ?? [];
      }

      canonicalNode.bodyId = toBodyIdLocal(fusedSolidId);
      if (!preFusePartIds.includes(fusedSolidId)) {
        getParts().set(fusedSolidId, fusedGraph);
        fusedGraph.addNode({
          type: 'PanelNode',
          id: toNodeId(fusedSolidId),
          bodyId: null,
          dirty: isDirty,
          materialType: 'default',
          nominalThickness,
          flatWidth,
          flatHeight,
          canonical: false,
          shapeDxf,
        });
      }

      session.registerShell(fusedSolidId);
      if (ctx.mode === 'join') {
        transactionRegistry.appendHistory(
          ctx.transactionId,
          shapeHistoryData as import('../transactions.js').ShapeHistoryRecord[],
        );
      }
    } catch (err) {
      getGeometryBinding().restoreSnapshot(snapshotId);
      if (fusedSolidId !== undefined) getParts().delete(fusedSolidId);
      for (const pid of preFusePartIds) {
        getParts().delete(pid);
      }
      for (const [pid, savedGraph] of savedParts) {
        if (savedGraph !== undefined) getParts().set(pid, savedGraph);
      }
      setActivePartIdInternal(savedActivePartId);
      throw err;
    }

    const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
    return {
      solid_id: fusedSolidId,
      part_id: preservedPartId,
      preserved_part_id: preservedPartId,
      consumed_part_ids: sourcePartIds,
      disjoint: disjointFlag,
      graphs_fused: sourcePartIds.length > 0,
      visible_shell_id: fusedSolidId,
      hidden_shell_ids: shellIds,
      visibility_policy: 'show_only_recreated',
      rollback_token: ctx.mode === 'join' ? ctx.transactionId : (rollbackToken ?? fusedSolidId),
      mesh_url: `${meshBaseUrl}/mesh/${fusedSolidId}.glb`,
      shape_history: shapeHistoryData,
    };
  }

  // Fallback: no graphs involved; geometry-only fuse.
  const result = getGeometryBinding().fuseBodies(shellIds, fuzzyTolerance);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    part_id: preservedPartId,
    preserved_part_id: preservedPartId,
    consumed_part_ids: tools.slice(1),
    disjoint: result.disjoint,
    graphs_fused: false,
    visible_shell_id: result.solid_id,
    hidden_shell_ids: shellIds,
    visibility_policy: 'show_only_recreated',
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleCutBodies(args: Record<string, unknown>): unknown {
  const blank = requireString(args, 'blank');
  const tools = requireStringArray(args, 'tools');
  const keepTools = (args['keep_tools'] as boolean | undefined) ?? false;
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().cutBodies(blank, tools, keepTools);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}

export function handleIntersectBodies(args: Record<string, unknown>): unknown {
  const targetA = requireString(args, 'target_a');
  const targetB = requireString(args, 'target_b');
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().intersectBodies(targetA, targetB);
  session.registerShell(result.solid_id);

  if (ctx.mode === 'join') {
    transactionRegistry.appendHistory(ctx.transactionId, result.shape_history ?? []);
  }

  const meshBaseUrl = `http://localhost:${process.env['MESH_PORT'] ?? '3001'}`;
  return {
    solid_id: result.solid_id,
    rollback_token: ctx.mode === 'join' ? ctx.transactionId : result.rollback_token,
    mesh_url: `${meshBaseUrl}/mesh/${result.solid_id}.glb`,
    shape_history: result.shape_history ?? [],
  };
}
