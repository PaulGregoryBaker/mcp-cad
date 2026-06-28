import { throwError, ErrorCodes } from '../errors.js';
import {
  getGeometryBinding,
  getActivePartId,
  setActivePartIdInternal,
  getParts,
  createPart,
} from '../state.js';
import {
  requireString,
  requireStringArray,
  resolveTransactionContext,
  resolveTargetToShell,
  optBool,
  buildMeshUrl,
  resolveRollbackToken,
  appendHistoryIfJoined,
} from '../helpers.js';
import { mergeInputDxfOutlines, normalizePanelDxfOrientation } from '../dxf-helpers.js';
import { session } from '../../geometry/session.js';
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

  // A panel's STORED normal must always be used directly, never recomputed
  // via cross(u, v): getPanelFrame's U/V swap (to keep U the longer in-plane
  // axis) can flip the sign of u×v relative to the face's actual normal, and
  // a panel descended from a prior merge_bodies_with_bend (computeDxfAlignedFrame)
  // carries that same ambiguity forward.
  const panelNormal = (f: PanelFrame): [number, number, number] => f.normal ?? [
    f.u[1] * f.v[2] - f.u[2] * f.v[1],
    f.u[2] * f.v[0] - f.u[0] * f.v[2],
    f.u[0] * f.v[1] - f.u[1] * f.v[0],
  ];
  const angleBetweenDeg = (n1: [number, number, number], n2: [number, number, number]): number => {
    const len = Math.hypot(...n1) * Math.hypot(...n2);
    if (len < 1e-10) return 90;
    const dot = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / len;
    return Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
  };
  // A panel produced by merge_bodies_with_bend genuinely spans TWO different
  // planes (the un-rotated panel A's, and the rotated panel B's) but only
  // ONE is tracked as the canonical PanelNode's panelFrame — the OTHER
  // survives as a non-canonical sibling node ("panel-a-XXXXXXXX") left
  // behind specifically so it can still be found. If the canonical face
  // isn't coplanar with the other fuse input, check whether a sibling's own
  // face is instead, before concluding the fuse is invalid.
  const resolveCoplanarFace = (toolId: string, ownNode: PanelNode, otherNormal: [number, number, number]): PanelNode | null => {
    const graph = getParts().get(toolId);
    if (!graph) return null;
    for (const node of graph.nodes.values()) {
      if (node.type !== 'PanelNode' || node === ownNode || !node.panelFrame) continue;
      if (angleBetweenDeg(panelNormal(node.panelFrame), otherNormal) <= FUSE_COPLANARITY_THRESHOLD_DEG) {
        return node as PanelNode;
      }
    }
    return null;
  };

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

  // Set when the coplanarity check below has to fall back to a non-canonical
  // sibling face (a multi-face/bent panel from a prior merge_bodies_with_bend,
  // whose canonical shapeDxf describes its WHOLE combined flat pattern, not
  // just the one face the other input is actually touching). That sibling's
  // OWN shapeDxf only covers its own face — rebuilding the result from it via
  // the 2D-DXF-merge path below would silently DROP the rest of the bent
  // panel's material. Force the safe fallback (a true 3D boolean fuse of the
  // live shells, see the `else` branch further down) instead.
  let forceLiveBooleanFuse = false;

  if (fusePanels.length >= 2) {
    let pA = fusePanels[0]!.node;
    let pB = fusePanels[1]!.node;

    if (Math.abs(pA.nominalThickness - pB.nominalThickness) > FUSE_THICKNESS_TOLERANCE_MM) {
      throwError(
        ErrorCodes.GE_FUSE_THICKNESS_MISMATCH,
        `Cannot fuse panels with different nominal thicknesses (${pA.nominalThickness}mm vs ${pB.nominalThickness}mm). ` +
        `Thickness must match within ${FUSE_THICKNESS_TOLERANCE_MM}mm for a valid coplanar fuse.`,
        false,
      );
    }

    if (pA.panelFrame && pB.panelFrame) {
      let nA = panelNormal(pA.panelFrame);
      let nB = panelNormal(pB.panelFrame);
      let angleDeg = angleBetweenDeg(nA, nB);

      if (angleDeg > FUSE_COPLANARITY_THRESHOLD_DEG) {
        const altB = resolveCoplanarFace(fusePanels[1]!.partId, pB, nA);
        if (altB) {
          pB = altB; fusePanels[1]!.node = altB; forceLiveBooleanFuse = true;
        } else {
          const altA = resolveCoplanarFace(fusePanels[0]!.partId, pA, nB);
          if (altA) { pA = altA; fusePanels[0]!.node = altA; forceLiveBooleanFuse = true; }
        }
        nA = panelNormal(pA.panelFrame!);
        nB = panelNormal(pB.panelFrame!);
        angleDeg = angleBetweenDeg(nA, nB);
      }

      if (angleDeg > FUSE_COPLANARITY_THRESHOLD_DEG) {
        throwError(
          ErrorCodes.GE_FUSE_NOT_COPLANAR,
          `Cannot fuse panels whose face normals differ by more than ${FUSE_COPLANARITY_THRESHOLD_DEG}°. ` +
          `These panels are at a bend angle — use merge_bodies_with_bend instead.`,
          false,
          'merge_bodies_with_bend',
        );
      }

      const fA = pA.panelFrame!;
      const fB = pB.panelFrame!;
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

    // All placement data (frame, flat extents, midplane offset) comes straight
    // from each panel's STORED PanelNode — captured once when the panel was
    // created (split_body_by_bends / apply_unfold) — never from a live shell
    // query. The manufacturing graph is the source of truth.
    const panelDxfs: (string | null)[] = [];
    const panelFrames: (PanelFrame | null)[] = [];
    const panelMidplaneOffsets: (number | null)[] = [];
    const panelAreas: number[] = [];
    let allInputsHaveDimensions = tools.length === graphPartIds.length && !forceLiveBooleanFuse;
    let combinedThickness = 0;

    // Reuse whichever PanelNode the coplanarity check above settled on for
    // each part (it may be a non-canonical sibling face, not the canonical
    // node) — re-deriving independently here via "canonical only" would
    // silently discard that resolution and go right back to the wrong face.
    const resolvedNodeByPartId = new Map(fusePanels.map((p) => [p.partId, p.node]));

    for (const pid of [preservedPartId, ...sourcePartIds]) {
      const g = savedParts.get(pid);
      if (!g) {
        allInputsHaveDimensions = false;
        continue;
      }
      const preResolved = resolvedNodeByPartId.get(pid);
      for (const node of (preResolved ? [preResolved] : Array.from(g.nodes.values()))) {
        if (node.type === 'PanelNode' && (preResolved === node || node.canonical !== false)) {
          const pn = node as PanelNode;
          panelDxfs.push(pn.shapeDxf ?? null);
          panelFrames.push(pn.panelFrame ?? null);
          panelMidplaneOffsets.push(pn.midplaneOffsetMm ?? null);
          panelAreas.push((pn.flatWidth ?? 0) * (pn.flatHeight ?? 0));
          combinedThickness = Math.max(combinedThickness, pn.nominalThickness);
          if (!pn.shapeDxf) allInputsHaveDimensions = false;
          break;
        }
      }
    }

    // The 2D merge (below) and the 3D rebuild's placement both need ONE shared
    // reference panel — the merged DXF is expressed in that panel's stored
    // frame, and the rebuild positions the result using that same panel's
    // stored midplane offset. Always anchoring on panelDxfs[0]/tools[0]
    // (whichever the caller happened to list first) breaks when tools[0] is a
    // SMALL attached feature (e.g. a welded-on flange) rather than the
    // dominant base panel: the flange's own thickness midpoint sits at a
    // different offset along the shared normal than the base panel's true
    // material, so the whole fused result would get centred on the small
    // feature's depth instead of the base sheet's. Picking the LARGEST-area
    // panel as the reference (regardless of tools[] order) keeps the
    // placement anchored on the dominant base panel every time.
    let bestPanelIdx = 0;
    for (let i = 1; i < panelAreas.length; i++) {
      if (panelAreas[i]! > panelAreas[bestPanelIdx]!) bestPanelIdx = i;
    }
    if (bestPanelIdx !== 0) {
      const swap = <T,>(arr: T[]): void => { const tmp = arr[0]!; arr[0] = arr[bestPanelIdx]!; arr[bestPanelIdx] = tmp; };
      swap(panelDxfs);
      swap(panelFrames);
      swap(panelMidplaneOffsets);
      swap(panelAreas);
    }

    const nominalThickness = combinedThickness > 0 ? combinedThickness : 1.0;
    let flatWidth: number | null = null;
    let flatHeight: number | null = null;
    let shapeDxf: string | null = null;
    // Indices (into panelDxfs/panelFrames/panelMidplaneOffsets) of panels
    // whose footprint was fully contained within another panel's — a 2D
    // outline union can't represent their material at all, so they're
    // additionally 3D-fused onto the reconstruction below (see
    // mergeInputDxfOutlines's containedOriginalIndices for why).
    let stackedPanelIndices: number[] = [];

    if (allInputsHaveDimensions && panelDxfs.length > 0) {
      try {
        const merged = mergeInputDxfOutlines(panelDxfs, panelFrames, Math.max(nominalThickness * 2.5, 1));
        if (merged) {
          stackedPanelIndices = merged.containedOriginalIndices;
          // Simple split panels get their longer dimension placed on DXF X by
          // normalizePanelDxfOrientation (called during their own unfold). The
          // fused/merged DXF built above does NOT go through that step, so
          // without this, a fused panel's flatWidth/flatHeight can end up not
          // corresponding to DXF X/Y the way downstream code (e.g.
          // merge_bodies_with_bend's foldAlongU-driven 90° rotation) assumes —
          // applying the same normalization here keeps fused panels consistent
          // with split ones.
          const expectedWidth = Math.max(merged.width, merged.height);
          const expectedHeight = Math.min(merged.width, merged.height);
          shapeDxf = normalizePanelDxfOrientation(merged.mergedDxf, expectedWidth, expectedHeight);
          flatWidth = expectedWidth;
          flatHeight = expectedHeight;

          // normalizePanelDxfOrientation rotates the DXF content 90°
          // (DXF+X <-> DXF+Y, via rotationMatrix [[0,1],[-1,0]]: (x,y) -> (y,-x),
          // then re-anchored to its new min corner) whenever the merge made the
          // reference panel's V-axis extent (merged.height) longer than its
          // U-axis extent (merged.width) — i.e. exactly whenever the OTHER
          // input's footprint extended the reference's V axis rather than U.
          // panelFrames[0] (the reference frame explicitPlacementForIndex(0)
          // uses below to place this DXF back into 3D) is never told about
          // that rotation — left as-is, the rebuild maps the rotated content
          // onto the WRONG world axis: growth that physically extended the
          // panel along the reference's V direction gets placed along U
          // instead, a true 90° misplacement (not just an offset).
          //
          // Apply the identical transform to the reference frame. Deriving
          // the new origin must NOT assume the pre-rotation merged DXF's bbox
          // starts at (0, 0) — panel 0's own DXF is used as-is as the merge's
          // coordinate system, and the OTHER input can land at negative
          // coordinates relative to it (e.g. a protrusion attached on panel
          // 0's "low"/reverse-direction edge), shifting bboxMinX/bboxMinY off
          // zero. For OLD ring bbox [xMin,xMax]x[yMin,yMax], the rotation
          // (x,y)->(y,-x) then re-anchor-to-new-min-corner works out to
          // NEW(x,y) = (y - yMin, xMax - x); inverting and mapping through
          // oldOrigin + x*oldU + y*oldV gives:
          //   new origin = oldOrigin + xMax*oldU + yMin*oldV
          //   new u = oldV, new v = -oldU
          if (merged.height > merged.width) {
            const refFrame = panelFrames[0];
            if (refFrame) {
              const [ux, uy, uz] = refFrame.u;
              const [vx, vy, vz] = refFrame.v;
              const [ox, oy, oz] = refFrame.origin;
              const xMax = merged.bboxMinX + merged.width;
              const yMin = merged.bboxMinY;
              panelFrames[0] = {
                ...refFrame,
                origin: [
                  ox + xMax * ux + yMin * vx,
                  oy + xMax * uy + yMin * vy,
                  oz + xMax * uz + yMin * vz,
                ],
                u: [vx, vy, vz],
                v: [-ux, -uy, -uz],
                vExtentMm: merged.width,
              };
            }
          }
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

    // Explicit placement frame for a panel, built entirely from its STORED
    // graph data (panelFrames[idx] / panelMidplaneOffsets[idx]) — no live
    // shell query. Use the panel's STORED normal — never recompute via
    // cross(u, v). getPanelFrame swaps U/V to keep U the longer in-plane
    // axis, and that swap can flip the sign of u×v relative to the face's
    // actual normal (u×v = -normal exactly when the swap happened).
    // midplaneOffsetMm was measured against the STORED normal at
    // panel-creation time, so re-deriving a different-signed normal here
    // would silently place the panel on the wrong side.
    const explicitPlacementForIndex = (idx: number): import('../../geometry/types.js').FlatPanelPlacement | undefined => {
      const frame = panelFrames[idx];
      if (!frame) return undefined;
      const [ux, uy, uz] = frame.u;
      const [vx, vy, vz] = frame.v;
      let [nx, ny, nz] = frame.normal ?? [0, 0, 0];
      if (nx === 0 && ny === 0 && nz === 0) {
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
      }
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      return {
        hasFrame: true,
        originX: frame.origin[0], originY: frame.origin[1], originZ: frame.origin[2],
        uX: ux, uY: uy, uZ: uz,
        vX: vx, vY: vy, vZ: vz,
        normalX: nx / nLen, normalY: ny / nLen, normalZ: nz / nLen,
        nCentreMm: panelMidplaneOffsets[idx] ?? 0,
      };
    };

    try {
      const gb = getGeometryBinding();
      if (shapeDxf !== null && gb.hasBuildShellFromFlatPattern()) {
        const res = gb.buildShellFromFlatPattern(shapeDxf, [], nominalThickness, explicitPlacementForIndex(0));
        fusedSolidId = res.shellId;
        // Persist a frame for the fused PanelNode so a later caller's
        // ensurePanelFrame doesn't fall back to an independent LIVE
        // getPanelFrame query — that query picks the largest planar FACE,
        // which can legitimately differ from panelFrames[0] (the frame
        // actually used above to place this shell) along the normal
        // direction by a small, expected face-vs-midplane offset (~half the
        // material thickness) — but for a composite/fused shape, the live
        // query's own U/V tie-break can ALSO disagree on which IN-PLANE
        // corner is the origin, which (unlike the normal offset) is a real
        // mismatch: shapeDxf's local (0,0) is panelFrames[0].origin by
        // construction (mergeInputDxfOutlines uses panel 0's own DXF as-is
        // for the merge's coordinate system), not wherever the live query's
        // face-pick happens to land. Keep the live query's normal-direction
        // placement (the validated, consistently-calibrated convention used
        // elsewhere) but correct the in-plane position to panelFrames[0]'s.
        if (panelFrames[0]) {
          const ref = panelFrames[0];
          const normal = ref.normal ?? [
            ref.u[1] * ref.v[2] - ref.u[2] * ref.v[1],
            ref.u[2] * ref.v[0] - ref.u[0] * ref.v[2],
            ref.u[0] * ref.v[1] - ref.u[1] * ref.v[0],
          ];
          const live = gb.getPanelFrame(fusedSolidId);
          const delta: [number, number, number] = [
            live.originX - ref.origin[0], live.originY - ref.origin[1], live.originZ - ref.origin[2],
          ];
          const normalOffset = delta[0] * normal[0] + delta[1] * normal[1] + delta[2] * normal[2];
          canonicalNode.panelFrame = {
            ...ref,
            origin: [
              ref.origin[0] + normalOffset * normal[0],
              ref.origin[1] + normalOffset * normal[1],
              ref.origin[2] + normalOffset * normal[2],
            ],
          };
        }

        // Footprint-stacked panels (e.g. a doubler/reinforcement patch fully
        // inside the base panel's outline) are invisible to the 2D outline
        // union above — rebuild each one from ITS OWN graph data and 3D-fuse
        // it onto the base reconstruction, the only way to represent that
        // material at all.
        for (const idx of stackedPanelIndices) {
          const stackedDxf = panelDxfs[idx];
          if (!stackedDxf) continue;
          const stackedRes = gb.buildShellFromFlatPattern(stackedDxf, [], nominalThickness, explicitPlacementForIndex(idx));
          const stackFuse = gb.fuseBodies([fusedSolidId, stackedRes.shellId], fuzzyTolerance);
          fusedSolidId = stackFuse.solid_id;
        }
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
      appendHistoryIfJoined(ctx, shapeHistoryData as import('../transactions.js').ShapeHistoryRecord[]);
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
      rollback_token: resolveRollbackToken(ctx, rollbackToken ?? fusedSolidId),
      mesh_url: buildMeshUrl(fusedSolidId),
      shape_history: shapeHistoryData,
    };
  }

  // Fallback: no graphs involved; geometry-only fuse.
  const result = getGeometryBinding().fuseBodies(shellIds, fuzzyTolerance);
  session.registerShell(result.solid_id);
  appendHistoryIfJoined(ctx, result.shape_history);

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
    rollback_token: resolveRollbackToken(ctx, result.rollback_token),
    mesh_url: buildMeshUrl(result.solid_id),
    shape_history: result.shape_history ?? [],
  };
}

export function handleCutBodies(args: Record<string, unknown>): unknown {
  const blank = requireString(args, 'blank');
  const tools = requireStringArray(args, 'tools');
  const keepTools = optBool(args, 'keep_tools', false);
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().cutBodies(blank, tools, keepTools);
  session.registerShell(result.solid_id);
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    solid_id: result.solid_id,
    rollback_token: resolveRollbackToken(ctx, result.rollback_token),
    mesh_url: buildMeshUrl(result.solid_id),
    shape_history: result.shape_history ?? [],
  };
}

export function handleIntersectBodies(args: Record<string, unknown>): unknown {
  const targetA = requireString(args, 'target_a');
  const targetB = requireString(args, 'target_b');
  const ctx = resolveTransactionContext(args);

  const result = getGeometryBinding().intersectBodies(targetA, targetB);
  session.registerShell(result.solid_id);
  appendHistoryIfJoined(ctx, result.shape_history);

  return {
    solid_id: result.solid_id,
    rollback_token: resolveRollbackToken(ctx, result.rollback_token),
    mesh_url: buildMeshUrl(result.solid_id),
    shape_history: result.shape_history ?? [],
  };
}
